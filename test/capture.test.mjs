// 拍照速记：验证「现拍」和「从相册/文件上传」两条路都通。
// 关键点：input 上不能有 capture 属性，否则手机上只会拉起相机，相册里的照片传不进来。
import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8765';
const ROOT = path.resolve(import.meta.dirname, '..');
const IMG1 = path.join(ROOT, 'shots/m-today.jpg');
const IMG2 = path.join(ROOT, 'shots/m-schedule.jpg');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + '  [' + detail + ']'); }
}

const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('DOM.enable');
await cdp.send('Page.navigate', { url: BASE + '/app.html' });
await sleep(2200);

// 首次启动的三步引导先过掉
await evaluate(cdp, `(() => {
  const b = document.querySelector('#ob-save');
  if (b) b.click();
  return true;
})()`);
await sleep(500);

console.log('\n【1】速记视图入口');
await evaluate(cdp, `LZ.go('/inbox')`);
await sleep(400);
const ui = await evaluate(cdp, `(() => {
  const btn = document.querySelector('[data-act="capture-photo"]');
  return {
    hasBtn: !!btn,
    label: btn ? btn.textContent.trim() : '',
    emptyHint: (document.querySelector('.empty') || {}).textContent || ''
  };
})()`);
ok('速记页有「拍照」按钮', ui.hasBtn, ui.label);
ok('按钮文案点明可以用相册', /相册/.test(ui.label), ui.label);

console.log('\n【2】点按钮后弹出的文件输入框属性');
await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
cdp.events.length = 0;

// 用真实鼠标事件点，保证是可信的用户手势（否则 Chrome 不会打开选择框）
const rect = await evaluate(cdp, `(() => {
  const b = document.querySelector('[data-act="capture-photo"]');
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });

let chooser = null;
for (let i = 0; i < 30; i++) {
  await sleep(100);
  const ev = cdp.events.filter((e) => e.method === 'Page.fileChooserOpened').pop();
  if (ev) { chooser = ev.params; break; }
}
ok('点击后真的打开了文件选择器', !!chooser, chooser ? 'mode=' + chooser.mode : '没等到事件');

const attrs = await evaluate(cdp, `(() => {
  const inp = [...document.querySelectorAll('input[type=file]')].pop();
  if (!inp) return null;
  return {
    accept: inp.getAttribute('accept'),
    multiple: inp.multiple,
    capture: inp.getAttribute('capture'),
    hasCaptureAttr: inp.hasAttribute('capture')
  };
})()`);
ok('input 存在且 accept 为 image/*', attrs && attrs.accept === 'image/*', JSON.stringify(attrs));
ok('支持多选', attrs && attrs.multiple === true, String(attrs && attrs.multiple));
ok('没有 capture 属性（否则手机只能现拍）', attrs && attrs.hasCaptureAttr === false, 'capture=' + JSON.stringify(attrs && attrs.capture));

console.log('\n【3】塞一张相册照片进去，看它存不存得下来');
ok('测试图片存在', fs.existsSync(IMG1) && fs.existsSync(IMG2), IMG1);
const before = await evaluate(cdp, `({ notes: LZ.S.notes.length, assets: LZ.S.assets.length })`);

await cdp.send('DOM.setFileInputFiles', { files: [IMG1, IMG2], backendNodeId: chooser.backendNodeId });

let after = null;
for (let i = 0; i < 60; i++) {
  await sleep(200);
  after = await evaluate(cdp, `(() => {
    const caps = LZ.S.notes.filter(n => n.kind === 'capture');
    const last = caps[caps.length - 1];
    if (!last) return null;
    const assets = LZ.S.assets.filter(a => a.noteId === last.id && a.kind === 'image');
    return {
      noteId: last.id, n: assets.length,
      sizes: assets.map(a => ({ w: a.width, h: a.height, size: a.size })),
      route: location.hash
    };
  })()`);
  if (after && after.n >= 2) break;
}

ok('新建了一篇速记笔记', !!after, after ? after.noteId : 'null');
ok('两张图都存成了附件', after && after.n === 2, after ? String(after.n) : '-');
ok('图片被压缩到 1600 以内', after && after.sizes.every((s) => s.w <= 1600 && s.h <= 1600),
  after ? JSON.stringify(after.sizes) : '-');
ok('图片体积有实际压缩', after && after.sizes.every((s) => s.size > 0 && s.size < 200 * 1024),
  after ? after.sizes.map((s) => Math.round(s.size / 1024) + 'KB').join(' / ') : '-');
ok('存完自动跳到那篇笔记', after && /^\#\/note\//.test(after.route), after && after.route);
ok('笔记数 +1', after && (await evaluate(cdp, `LZ.S.notes.length`)) === before.notes + 1, before.notes + ' → ' + (before.notes + 1));

console.log('\n【4】附件真的能显示出来（不是只有一条记录）');
const view = await evaluate(cdp, `(async () => {
  const imgs = [...document.querySelectorAll('.attachment-grid .capture-item img, .attachment-grid img')];
  const box = document.querySelector('.attachment-grid');
  await new Promise(r => setTimeout(r, 400));
  return {
    count: imgs.length,
    decoded: imgs.filter(i => i.naturalWidth > 0).length,
    widths: imgs.map(i => Math.round(i.getBoundingClientRect().width)),
    gridW: box ? Math.round(box.getBoundingClientRect().width) : 0
  };
})()`);
ok('页面上渲染出 2 张缩略图', view.count === 2, String(view.count));
ok('图片都成功解码（naturalWidth > 0）', view.decoded === 2, view.decoded + '/' + view.count);
ok('缩略图有实际宽度', view.widths.every((w) => w > 100), JSON.stringify(view.widths));

console.log('\n【5】收件箱能看见这条速记');
const inbox = await evaluate(cdp, `(async () => {
  LZ.go('/inbox');
  await new Promise(r => setTimeout(r, 350));
  const rows = [...document.querySelectorAll('.list .row')];
  return { rows: rows.length, firstThumb: rows[0] ? !!rows[0].querySelector('img') : false };
})()`);
ok('收件箱列出了这条速记', inbox.rows >= 1, String(inbox.rows));
ok('列表缩略图显示的是图片本身', inbox.firstThumb, String(inbox.firstThumb));

console.log('\n【6】编辑器「插图」同样允许上传（不受影响）');
const ed = await evaluate(cdp, `(() => {
  const i = document.createElement('input');
  i.type = 'file'; i.accept = 'image/*';
  return true;
})()`);
const edCode = await evaluate(cdp, `String(LZ.capturePhoto).includes("capture") && !String(LZ.capturePhoto).includes("setAttribute('capture'")`);
ok('capturePhoto 源码里不再设置 capture 属性', edCode === true, String(edCode));

console.log('\n【7】无运行时异常');
const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
ok('整轮无未捕获异常', errs.length === 0, String(errs.length));

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
cdp.close();
proc.kill('SIGKILL');
process.exit(fail ? 1 : 0);

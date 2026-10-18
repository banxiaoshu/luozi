// 落字 · 安装后可用性端到端验证（真实 Chrome + CDP）
import { launch, newPage, connect, evaluate, screenshot, sleep } from './cdp.mjs';
import fs from 'node:fs';

const BASE = process.env.LUOZI_URL || 'http://127.0.0.1:8765/app.html';
const out = [];
function log(name, val) { out.push([name, val]); console.log('· ' + name + ' = ' + JSON.stringify(val)); }
function ok(label, cond, extra) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  if (!cond) process.exitCode = 2;
}

const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');
await cdp.send('Page.navigate', { url: BASE });
await sleep(2600);

async function reload(wait = 1800) {
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(wait);
}

// ---------- 1. 首屏与首次引导 ----------
await sleep(2200);
const boot = await evaluate(cdp, `(function(){
  return {
    stage: document.documentElement.getAttribute('data-stage'),
    err: document.documentElement.getAttribute('data-err'),
    hasLZ: !!window.LZ,
    views: document.querySelector('#view-wrap').children.length,
    listRows: document.querySelectorAll('#view-wrap .row').length,
    sheetOpen: document.querySelector('#sheet-mask')?.classList.contains('open') || false,
    sheetTitle: document.querySelector('#sheet h3')?.textContent || '',
    hasOnboardFields: !!document.querySelector('#ob-start') && !!document.querySelector('#ob-weeks')
  };
})()`);
log('首屏', boot);
ok('无运行时异常', !boot.err, boot.err || 'clean');
ok('应用已挂载（LZ 存在、视图已渲染）', boot.hasLZ && boot.views > 0);
ok('首次启动弹出三步引导', boot.hasOnboardFields, boot.sheetTitle);

// ---------- 2. 引导写开学日，检查周次 ----------
const wk = await evaluate(cdp, `(async function(){
  const d = new Date(); const iso = d.toISOString().slice(0,10);
  document.querySelector('#ob-start').value = iso;
  document.querySelector('#ob-weeks').value = '18';
  document.querySelector('#ob-save').click();
  await new Promise(r => setTimeout(r, 700));
  return {
    setting: await Settings.get('semesterStart'),
    weeks: await Settings.get('totalWeeks'),
    label: document.querySelector('.today-head .meta')?.textContent || '',
    sheetClosed: !document.querySelector('#sheet-mask').classList.contains('open')
  };
})()`);
log('引导保存', wk);
ok('开学日已写入 IndexedDB', wk.setting === new Date().toISOString().slice(0, 10), wk.setting);
ok('周次立刻反映到今日页', /第 1 周 \/ 共 18 周/.test(wk.label), wk.label);

// ---------- 3. 课表导入 -> 持久化 -> 刷新后仍在 ----------
const imp = await evaluate(cdp, `(async function(){
  LZ.openImport();
  await new Promise(r => setTimeout(r, 300));
  const t = document.querySelector('#import-text');
  t.value = '周一 08:30-10:00 高等数学 A301\\n周二 第3-4节 大学英语 语音室B2\\n周三 14:00-15:40 人工智能基础 C101\\n周四 10:15-12:00 经济法 A405\\n周五 第1-2节 近现代史纲要 D205';
  document.querySelector('#btn-parse').click();
  await new Promise(r => setTimeout(r, 200));
  const previewOk = !document.querySelector('#btn-import-ok').disabled;
  document.querySelector('#btn-import-ok').click();
  await new Promise(r => setTimeout(r, 1200));
  return {
    previewOk,
    events: await DB.count('events'),
    courses: await DB.count('courses'),
    route: location.hash
  };
})()`);
log('课表导入', imp);
ok('解析后「确认导入」可用', imp.previewOk);
ok('5 节课写进 IndexedDB', imp.events === 5, imp.events);
ok('生成 5 门课程', imp.courses === 5, imp.courses);
ok('导入后跳到课表页', imp.route.indexOf('/schedule') > -1, imp.route);

await reload();
const afterReload = await evaluate(cdp, `(async function(){
  return {
    events: await DB.count('events'),
    coursesInMemory: LZ.S.courses.length,
    gridCells: document.querySelectorAll('.tt-event').length,
    stage: document.documentElement.getAttribute('data-stage'),
    err: document.documentElement.getAttribute('data-err')
  };
})()`);
log('刷新后', afterReload);
ok('刷新后课程仍在（真持久化，不是内存假数据）', afterReload.events === 5, afterReload.events);
ok('课表格子已渲染', afterReload.gridCells > 0, afterReload.gridCells);

// ---------- 4. 附件缩略图尺寸 ----------
const thumb = await evaluate(cdp, `(async function(){
  // 造一张 1200x900 的 PNG 塞进笔记
  const c = document.createElement('canvas'); c.width = 1200; c.height = 900;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0,0,1200,900);
  grd.addColorStop(0,'#2c5f52'); grd.addColorStop(1,'#8fc7b4');
  g.fillStyle = grd; g.fillRect(0,0,1200,900);
  g.fillStyle = '#fff'; g.font = 'bold 90px sans-serif'; g.fillText('板书截图', 120, 470);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));

  const note = await LZ.createNote({ title: '附件尺寸测试', kind: 'note', body: '一张图' });
  await LZ.addAsset(note.id, blob, 'image', { name: '板书.png', mime: 'image/png' });
  LZ.go('/note/' + note.id);
  await new Promise(r => setTimeout(r, 900));

  const box = document.querySelector('.attachment-grid');
  const img = document.querySelector('.attachment-grid .capture-item img');
  const audioBound = !!box;
  return {
    gridFound: audioBound,
    boxRect: box ? { w: Math.round(box.getBoundingClientRect().width) } : null,
    itemRect: img ? { w: Math.round(img.getBoundingClientRect().width), h: Math.round(img.getBoundingClientRect().height) } : null,
    natural: img ? { w: img.naturalWidth, h: img.naturalHeight } : null,
    noteId: note.id
  };
})()`);
log('附件缩略图', thumb);
ok('附件区用新的 .attachment-grid', thumb.gridFound);
ok('缩略图不小于 150×110', !!thumb.itemRect && thumb.itemRect.w >= 150 && thumb.itemRect.h >= 110, thumb.itemRect);
ok('图片本身成功解码（naturalWidth>0）', !!thumb.natural && thumb.natural.w === 1200, thumb.natural);
await screenshot(cdp, '/tmp/v-attachment.png');

// ---------- 5. 分享链接 -> 接收页 -> 保存 ----------
const share = await evaluate(cdp, `(async function(){
  const notes = await DB.all('notes');
  const n = notes.filter(x => x.title === '附件尺寸测试')[0];
  n.body = '## 夹逼定理\\n\\n设 $a_n \\\\le b_n \\\\le c_n$，若 $\\\\lim a_n=\\\\lim c_n=L$，则 $\\\\lim b_n=L$。\\n\\n- 第一个要点\\n- 第二个要点';
  await LZ.saveNote(n);
  await LZ.shareNote(n);
  await new Promise(r => setTimeout(r, 500));
  const code = (await Core.Share.encode({ t: n.title, b: n.body, at: new Date().toISOString(), app: 'luozi' }));
  return { code: code, len: code.length, noteId: n.id };
})()`);
log('生成分享码', { len: share.len });
ok('分享码可生成', !!share.code && share.len > 20, share.len);

await evaluate(cdp, `(function(){ location.hash = '/import?d=' + encodeURIComponent(${JSON.stringify(share.code)}); return 1; })()`);
await sleep(1600);
const recv = await evaluate(cdp, `(function(){
  return {
    shareMode: document.body.classList.contains('share-mode'),
    sidebarHidden: getComputedStyle(document.querySelector('.sidebar')).display === 'none',
    title: document.querySelector('.share-card h1')?.textContent || '',
    bodyText: (document.querySelector('#share-body')?.textContent || '').slice(0, 60),
    hasKatex: document.querySelectorAll('#share-body .katex').length,
    buttons: document.querySelectorAll('.share-actions .btn').length
  };
})()`);
log('分享接收页', recv);
ok('进入分享模式（隐藏侧栏/底栏）', recv.shareMode && recv.sidebarHidden);
ok('标题正确渲染', recv.title === '附件尺寸测试', recv.title);
ok('正文 Markdown 已渲染', recv.bodyText.indexOf('夹逼定理') > -1, recv.bodyText);
ok('正文里的公式渲染成 KaTeX', recv.hasKatex >= 2, recv.hasKatex);
ok('有保存/只读两个按钮', recv.buttons === 2, recv.buttons);
await screenshot(cdp, '/tmp/v-share.png');

const saved = await evaluate(cdp, `(async function(){
  const before = await DB.count('notes');
  document.querySelector('#share-save').click();
  await new Promise(r => setTimeout(r, 1400));
  return {
    before,
    after: await DB.count('notes'),
    shareMode: document.body.classList.contains('share-mode'),
    route: location.hash
  };
})()`);
log('保存分享', saved);
ok('保存后笔记数 +1', saved.after === saved.before + 1, saved);
ok('保存后退出分享模式并进入笔记页', !saved.shareMode && saved.route.indexOf('/note/') > -1, saved.route);

// ---------- 6. 离线：断网后刷新还能用 ----------
const swInfo = await evaluate(cdp, `(async function(){
  const reg = await navigator.serviceWorker.getRegistration();
  const keys = await caches.keys();
  let cached = 0;
  for (const k of keys) { const c = await caches.open(k); cached += (await c.keys()).length; }
  return { reg: !!reg, active: !!(reg && reg.active), controlled: !!navigator.serviceWorker.controller, caches: keys, cached };
})()`);
log('Service Worker', swInfo);
ok('SW 已注册并激活', swInfo.reg && swInfo.active);
ok('预缓存条目 >= 30', swInfo.cached >= 30, swInfo.cached);

await evaluate(cdp, `(function(){ location.hash = '/notes'; return 1; })()`);
await sleep(900);
await cdp.send('Network.emulateNetworkConditions', {
  offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0
});
await reload(2600);
const offline = await evaluate(cdp, `(async function(){
  return {
    stage: document.documentElement.getAttribute('data-stage'),
    err: document.documentElement.getAttribute('data-err'),
    views: document.querySelector('#view-wrap').children.length,
    listRows: document.querySelectorAll('#view-wrap .row').length,
    events: await DB.count('events'),
    notes: await DB.count('notes'),
    notesLen: LZ.S.notes.length
  };
})()`);
log('离线刷新', offline);
ok('断网后页面仍渲染', offline.views > 0 && offline.listRows > 0 && !offline.err, { views: offline.views, rows: offline.listRows, err: offline.err || 'clean' });
ok('断网后课程数据仍可读', offline.events === 5, offline.events);
ok('断网后笔记数据仍可读', offline.notesLen === saved.after, offline.notesLen);
await screenshot(cdp, '/tmp/v-offline.png');
await cdp.send('Network.emulateNetworkConditions', {
  offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
});

// ---------- 7. manifest / 安装条件 ----------
await cdp.send('Page.navigate', { url: BASE });
await sleep(2000);
let manifest = null;
try {
  manifest = await cdp.send('Page.getAppManifest');
} catch (e) { manifest = { error: e.message }; }
log('manifest', {
  errors: manifest.errors ? manifest.errors.length : (manifest.error || 0),
  hasData: !!manifest.data
});

const install = await evaluate(cdp, `(async function(){
  const man = await fetch('manifest.webmanifest').then(r => r.json());
  return {
    name: man.name,
    short: man.short_name,
    display: man.display,
    icons: man.icons.length,
    maskable: man.icons.filter(i => (i.purpose||'').indexOf('maskable') > -1).length,
    shortcuts: (man.shortcuts || []).length,
    standaloneApi: ('standalone' in navigator) || ('getInstalledRelatedApps' in navigator),
    secure: isSecureContext
  };
})()`);
log('安装条件', install);
ok('manifest 名字保留「落字」', install.short === '落字', install.short);
ok('display 为 standalone', install.display === 'standalone');
ok('含 maskable 图标', install.maskable >= 1, install.maskable);
ok('安全上下文（可安装）', install.secure === true);

const errs = await evaluate(cdp, `(document.documentElement.getAttribute('data-err') || '')`);
ok('整轮结束仍无运行时异常', !errs, errs || 'clean');

fs.writeFileSync('/tmp/verify-result.json', JSON.stringify(out, null, 2));
console.log('\n========== 汇总 ==========');
console.log(JSON.stringify(Object.fromEntries(out), null, 2));
try { proc.kill(); } catch (e) {}

// 新功能端到端：PPT/PDF 导入 + 不懂标记（真实 Chrome）
import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';

const BASE = 'http://127.0.0.1:8765';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : ''))); };

const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
await cdp.send('Network.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });

await cdp.send('Page.navigate', { url: BASE + '/app.html' });
await sleep(2800);

// 关掉首次引导
await evaluate(cdp, `(function(){
  document.querySelectorAll('[data-act="close-sheet"]').forEach(b=>b.click());
  localStorage.setItem('lz_onboard','1');
  if (window.Settings) Settings.set('semesterStart','2026-09-02');
  return 1; })()`);
await sleep(400);

const clean = await evaluate(cdp, `(async function(){
  const notes = await DB.all('notes');
  for (const n of notes) { await LZ.deleteNote(n.id); }
  await LZ.refresh(); LZ.go('/notes');
  return (await DB.all('notes')).length;
})()`);
ok('起始状态已清空', clean === 0, String(clean));
await sleep(600);

/* ---------------- 1. PPTX ---------------- */
console.log('\n【1】导入 PPTX');
const ppt = await evaluate(cdp, `(async function(){
  const buf = await (await fetch('test/fixtures/sample.pptx' + '?t=' + Date.now())).arrayBuffer();
  const file = new File([buf], '第一章 极限与连续.pptx',
    { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
  await LZ.runDocImport(file);
  await new Promise(r => setTimeout(r, 600));
  const notes = await DB.all('notes');
  const n = notes.filter(x => x.title && x.title.indexOf('第一章') >= 0)[0];
  if (!n) return { ok: false, notes: notes.map(x => x.title) };
  const assets = (await DB.all('assets')).filter(a => a.noteId === n.id);
  return {
    ok: true, id: n.id, title: n.title, body: n.body,
    heads: (n.body.match(/^## .+$/gm) || []),
    hasCjk: n.body.includes('夹逼准则'),
    assetKinds: assets.map(a => a.kind),
    assetName: (assets[0] || {}).name || '',
    route: location.hash
  };
})()`);
ok('PPTX 生成了笔记', ppt.ok === true, JSON.stringify(ppt.notes));
ok('标题取自文件名', /第一章 极限与连续/.test(ppt.title || ''), ppt.title);
ok('每张幻灯片一个二级标题', (ppt.heads || []).length === 3, JSON.stringify(ppt.heads));
ok('幻灯片编号连续且有序',
  (ppt.heads || []).map(h => (h.match(/第 (\d+) 张/) || [])[1]).join(',') === '1,2,3',
  JSON.stringify(ppt.heads));
ok('中文内容正确解压出来', ppt.hasCjk === true);
ok('原文件作为附件存下来了', (ppt.assetKinds || []).join(',') === 'doc', JSON.stringify(ppt.assetKinds));
ok('导入后跳到那篇笔记', /^#\/note\//.test(ppt.route || ''), ppt.route);

const preview = await evaluate(cdp, `(function(){
  const box = document.querySelector('#ed-preview');
  return { h2: box ? box.querySelectorAll('h2').length : -1,
           text: box ? box.innerText.slice(0, 120) : '' };
})()`);
ok('预览区渲染出 3 个二级标题', preview.h2 === 3, JSON.stringify(preview));

const docCard = await evaluate(cdp, `(function(){
  const c = document.querySelector('.doc-card');
  return c ? { ico: c.querySelector('.doc-ico').textContent, name: c.querySelector('.doc-meta b').textContent } : null;
})()`);
ok('附件区显示课件卡片', docCard && docCard.ico === 'PPT', JSON.stringify(docCard));

/* ---------------- 2. PDF ---------------- */
console.log('\n【2】导入 PDF');
const pdf = await evaluate(cdp, `(async function(){
  const buf = await (await fetch('test/fixtures/sample.pdf' + '?t=' + Date.now())).arrayBuffer();
  const file = new File([buf], '高数讲义.pdf', { type: 'application/pdf' });
  await LZ.runDocImport(file);
  // pdf.js 首次要加载 worker，多等一会儿
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    const notes = await DB.all('notes');
    const n = notes.filter(x => x.title && x.title.indexOf('高数讲义') >= 0)[0];
    if (n) return { ok: true, title: n.title, body: n.body,
                    heads: (n.body.match(/^## .+$/gm) || []),
                    sheet: document.querySelector('#sheet') ? document.querySelector('#sheet').innerText.slice(0,80) : '' };
  }
  return { ok: false, sheet: document.querySelector('#sheet') ? document.querySelector('#sheet').innerText.slice(0,200) : '没有笔记' };
})()`);
ok('PDF 生成了笔记', pdf.ok === true, JSON.stringify(pdf).slice(0, 300));
if (pdf.ok) {
  ok('按页拆出二级标题', (pdf.heads || []).length >= 1, JSON.stringify(pdf.heads));
  const allText = (pdf.body || '').replace(/\s+/g, '');
  ok('抽到了中文（cmap 生效）', /高等数学|极限|夹逼/.test(allText), allText.slice(0, 80));
}

/* ---------------- 3. 不懂标记 ---------------- */
console.log('\n【3】不懂标记');
const marked = await evaluate(cdp, `(async function(){
  const notes = await DB.all('notes');
  const n = notes.filter(x => x.title && x.title.indexOf('第一章') >= 0)[0];
  LZ.go('/note/' + n.id);
  await new Promise(r => setTimeout(r, 700));

  // 选中正文里的一段，再点「标不懂」
  const ta = document.querySelector('#ed-body-input');
  const idx = ta.value.indexOf('夹逼准则');
  ta.focus();
  ta.setSelectionRange(idx, idx + 4);
  const btn = document.querySelector('[data-act="toggle-flag"]');
  const before = btn ? btn.textContent.trim() : '';
  btn.click();
  await new Promise(r => setTimeout(r, 700));

  const after = (await DB.all('notes')).filter(x => x.id === n.id)[0];
  const btn2 = document.querySelector('[data-act="toggle-flag"]');
  return { before, flag: after.flag, hasMark: after.body.indexOf('==夹逼准则==') >= 0,
           btnText: btn2 ? btn2.textContent.trim() : '', body: after.body.slice(0, 200) };
})()`);
ok('按钮初始文案是「标不懂」', marked.before === '标不懂', marked.before);
ok('笔记被标成 unknown', marked.flag === 'unknown', String(marked.flag));
ok('选中的那一段被高亮包起来了', marked.hasMark === true, marked.body);
ok('按钮变成「已标不懂」', marked.btnText === '已标不懂', marked.btnText);

const renderMark = await evaluate(cdp, `(function(){
  const box = document.querySelector('#ed-preview');
  const m = box ? box.querySelector('mark.md-mark') : null;
  return { has: !!m, text: m ? m.textContent : '', style: m ? getComputedStyle(m).backgroundColor : '' };
})()`);
ok('预览里渲染成 <mark>', renderMark.has === true, JSON.stringify(renderMark));
ok('高亮有可见底色', /rgba?\(/.test(renderMark.style || ''), renderMark.style);

const listView = await evaluate(cdp, `(async function(){
  LZ.go('/unknown');
  await new Promise(r => setTimeout(r, 600));
  const items = document.querySelectorAll('.unk-item');
  const badge = document.querySelector('#badge-unknown');
  return { count: items.length,
           text: items[0] ? items[0].innerText.replace(/\\s+/g, ' ').slice(0, 90) : '',
           badge: badge ? badge.textContent : '', badgeHidden: badge ? badge.hidden : true };
})()`);
ok('不懂清单里出现 1 条', listView.count === 1, JSON.stringify(listView));
ok('清单里能看到高亮片段', /夹逼准则/.test(listView.text), listView.text);
ok('侧栏徽标显示 1', listView.badge === '1' && listView.badgeHidden === false, JSON.stringify(listView));

const banner = await evaluate(cdp, `(async function(){
  LZ.go('/today');
  await new Promise(r => setTimeout(r, 600));
  const b = document.querySelector('.unknown-banner');
  return { has: !!b, text: b ? b.innerText.replace(/\\s+/g, ' ') : '' };
})()`);
ok('今日页出现「还没弄懂」提醒', banner.has === true, banner.text);

const cleared = await evaluate(cdp, `(async function(){
  LZ.go('/unknown');
  await new Promise(r => setTimeout(r, 600));
  const btn = document.querySelector('[data-act="flag-off"]');
  btn.click();
  await new Promise(r => setTimeout(r, 700));
  const notes = await DB.all('notes');
  const n = notes.filter(x => x.title && x.title.indexOf('第一章') >= 0)[0];
  return { flag: n.flag, items: document.querySelectorAll('.unk-item').length,
           empty: !!document.querySelector('.empty'),
           markStill: n.body.indexOf('==夹逼准则==') >= 0 };
})()`);
ok('点「弄懂了」后标记清掉', cleared.flag === '' || cleared.flag === undefined, String(cleared.flag));
ok('清单回到空状态', cleared.items === 0 && cleared.empty === true, JSON.stringify(cleared));
ok('正文里的高亮不会跟着消失', cleared.markStill === true);

/* ---------------- 4. 回归：老功能没坏 ---------------- */
console.log('\n【4】回归检查');
const regress = await evaluate(cdp, `(function(){
  return { err: document.documentElement.getAttribute('data-err'),
           nav: document.querySelectorAll('.nav-item').length,
           unknownNav: !!document.querySelector('[data-route="unknown"]') };
})()`);
ok('整轮没有运行时异常', !regress.err, regress.err || '');
ok('侧栏有「不懂清单」入口', regress.unknownNav === true);

const errs = cdp.events.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error');
ok('控制台没有报错', errs.length === 0, errs.map(e => e.params.entry.text).slice(0, 3).join(' | '));

cdp.close();
try { proc.kill('SIGKILL'); } catch (e) {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

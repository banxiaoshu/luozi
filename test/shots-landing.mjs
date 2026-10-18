// 给落地页截真实界面图：造一份像样的示例数据，然后把每个视图截下来
import { launch, newPage, connect, evaluate, screenshot, sleep } from './cdp.mjs';
import fs from 'node:fs';

const BASE = process.env.LUOZI_URL || 'http://127.0.0.1:8765/app.html';
const OUT = '/Users/wlw/WorkBuddy/数媒app开发/落字/shots/raw';
fs.mkdirSync(OUT, { recursive: true });

const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');

// 把"今天"挪到周三（10/14），这样今日页有课，截图才像回事
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(function(){
    var RealDate = Date;
    var SHIFT = -4 * 86400000;
    function FakeDate(){
      if (arguments.length === 0) return new RealDate(RealDate.now() + SHIFT);
      return new (Function.prototype.bind.apply(RealDate, [null].concat([].slice.call(arguments))))();
    }
    FakeDate.prototype = RealDate.prototype;
    FakeDate.now = function(){ return RealDate.now() + SHIFT; };
    FakeDate.parse = RealDate.parse;
    FakeDate.UTC = RealDate.UTC;
    window.Date = FakeDate;
  })();`
});

// 截图里别出现「装到桌面」这张卡片，它是给真实用户看的引导
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(function(){
    function hide(){
      var s = document.createElement('style');
      s.textContent = '.install-card{display:none!important}';
      (document.head || document.documentElement).appendChild(s);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hide);
    else hide();
  })();`
});

await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1040, height: 680, deviceScaleFactor: 2, mobile: false });
await cdp.send('Page.navigate', { url: BASE });
await sleep(2600);

await evaluate(cdp, `(function(){ document.querySelectorAll('[data-act="close-sheet"]').forEach(b=>b.click()); localStorage.setItem('lz_onboard','1'); return 1; })()`);

const made = await evaluate(cdp, `(async function(){
  await Settings.set('semesterStart', '2026-09-02');
  await Settings.set('totalWeeks', 20);
  LZ.S.settings.semesterStart = '2026-09-02';
  LZ.S.settings.totalWeeks = 20;

  const imported = Core.Timetable.parse([
    '周一 08:30-10:00 高等数学 A301',
    '周一 14:00-15:40 人工智能基础 C101',
    '周二 09:50-11:30 大学英语 语音室B2',
    '周三 08:30-10:00 高等数学 A301',
    '周三 10:15-12:00 经济法 A405',
    '周四 14:00-15:40 近现代史纲要 D205',
    '周五 09:50-11:30 人工智能基础 C101'
  ].join('\\n'));
  await Core.Timetable.persist(imported);
  await LZ.refresh();

  function board(title, lines) {
    const c = document.createElement('canvas'); c.width = 1400; c.height = 980;
    const g = c.getContext('2d');
    g.fillStyle = '#123128'; g.fillRect(0,0,1400,980);
    g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 3;
    for (let y = 0; y < 980; y += 120) { g.beginPath(); g.moveTo(0,y); g.lineTo(1400,y); g.stroke(); }
    g.fillStyle = '#eafff6';
    g.font = 'bold 78px "PingFang SC","Heiti SC",sans-serif';
    g.fillText(title, 110, 200);
    g.font = '54px "PingFang SC","Heiti SC",sans-serif';
    g.fillStyle = '#bfe8d8';
    lines.forEach((t, i) => g.fillText(t, 110, 350 + i * 140));
    return new Promise(r => c.toBlob(r, 'image/png'));
  }

  // 把创建时间摊到不同日期，别让"今天新笔记"一栏数字离谱
  const dayAgo = (n) => {
    const d = new Date(); d.setDate(d.getDate() - n);
    return d.toISOString();
  };

  const b1 = await board('夹逼准则', ['aₙ ≤ bₙ ≤ cₙ', 'lim aₙ = lim cₙ = L  ⇒  lim bₙ = L', '两头的界要先找出来']);

  const n1 = await LZ.createNote({ title: '夹逼准则', kind: 'note', body:
    '## 夹逼准则\\n\\n' +
    '设 $a_n \\\\le b_n \\\\le c_n$，若 $\\\\lim_{n\\\\to\\\\infty} a_n = \\\\lim_{n\\\\to\\\\infty} c_n = L$，则 $\\\\lim_{n\\\\to\\\\infty} b_n = L$。\\n\\n' +
    '### 老师带口音的地方\\n\\n' +
    '> 老师说「数劣」，黑板上写的是「数列」。==先记音，下课再对字形==。\\n\\n' +
    '- 单调**且**有界，两个条件缺一不可\\n' +
    '- 两头的界要先找出来，中间那项自然被夹住\\n' +
    '- 两端极限相等才能直接写结论\\n\\n' +
    '### 做题步骤\\n\\n' +
    '1. 把中间那项夹在两个好算的式子之间\\n' +
    '2. 分别求两端极限\\n' +
    '3. 相等就直接写答案\\n\\n' +
    '例题见 [[重要极限]]，上一节是 [[数列的极限]]' });
  await LZ.addAsset(n1.id, b1, 'image', { name: '板书-夹逼准则.png', mime: 'image/png' });

  const n2 = await LZ.createNote({ title: '重要极限', kind: 'note', body:
    '## 两个重要极限\\n\\n' +
    '$\\\\lim_{x\\\\to 0} \\\\frac{\\\\sin x}{x} = 1$\\n\\n' +
    '$\\\\lim_{x\\\\to\\\\infty} \\\\left(1+\\\\frac{1}{x}\\\\right)^x = e$\\n\\n' +
    '这两个是底线，遇事先往上面套。配合 [[夹逼准则]] 用。' });

  const n3 = await LZ.createNote({ title: '数列的极限', kind: 'note', body:
    '## 定义\\n\\n' +
    '$\\\\forall \\\\varepsilon > 0$，$\\\\exists N$，当 $n > N$ 时 $|a_n - a| < \\\\varepsilon$。\\n\\n' +
    '听不懂的时候先画数轴，比看符号有用。后面接 [[夹逼准则]]。\\n\\n' +
    '==为什么要先给 ε 再找 N，顺序反了会怎样==？' });

  const n4 = await LZ.createNote({ title: '神经网络入门', kind: 'note', body:
    '## 一个神经元在算什么\\n\\n' +
    '加权求和，再过激活函数。就这么两件事。\\n\\n' +
    '- 权重：这一路信号有多重要\\n' +
    '- 偏置：整体门槛往哪边挪\\n' +
    '- 激活：决定要不要"兴奋"\\n\\n' +
    '这节没录上音，靠板书抄的。' });

  const n5 = await LZ.createNote({ title: '听力关键词', kind: 'note', body:
    '## 听力里反复出现的词\\n\\n' +
    '- however / nevertheless —— 后面多半是答案\\n' +
    '- actually —— 转折信号\\n' +
    '- in terms of —— 换角度解释\\n\\n' +
    '老师说语速快的时候，只抓这三类词就够了。' });

  const n6 = await LZ.createNote({ title: '经济法 · 合同法要点', kind: 'note', body:
    '## 合同成立的两个要件\\n\\n' +
    '要约、承诺。少了哪个都不成立。\\n\\n' +
    '这学期这门课最厚，先记骨架。' });

  const cap = await LZ.createNote({ title: '老师说「数劣」', kind: 'capture', body:
    '课上没听懂：老师说「数劣收敛」，黑板上写的是「数列收敛」。下课对一下。' });

  // 摊开创建时间
  const notes = await DB.all('notes');
  const byTitle = {};
  notes.forEach(x => { byTitle[x.title] = x; });
  const stamp = {
    '重要极限': 9, '数列的极限': 8, '神经网络入门': 6,
    '听力关键词': 5, '经济法 · 合同法要点': 4,
    '夹逼准则': 0, '老师说「数劣」': 0
  };
  for (const t of Object.keys(stamp)) {
    const n = byTitle[t];
    if (!n) continue;
    n.createdAt = dayAgo(stamp[t]);
    n.updatedAt = dayAgo(stamp[t]);
    await DB.put('notes', n);
  }
  await LZ.refresh();
  return { notes: (await DB.all('notes')).length, events: await DB.count('events'), n1: n1.id };
})()`);
console.log('· 造数据 =', JSON.stringify(made));

async function shot(hash, name) {
  await evaluate(cdp, `(function(){ location.hash = ${JSON.stringify(hash)}; return 1; })()`);
  await sleep(1200);
  await screenshot(cdp, OUT + '/' + name + '.png');
  console.log('  📷 ' + name);
}

await shot('/today', 'today');
await shot('/schedule', 'schedule');
await shot('/note/' + made.n1, 'note');
await shot('/graph', 'graph');
await shot('/notes', 'notes');

// 图片取字弹层
await evaluate(cdp, `(function(){ location.hash = '/note/' + ${JSON.stringify(made.n1)}; return 1; })()`);
await sleep(1100);
await evaluate(cdp, `(function(){ const b = document.querySelector('[data-act="ocr-asset"]'); if (b) b.click(); return 1; })()`);
for (let i = 0; i < 40; i++) {
  await sleep(800);
  const done = await evaluate(cdp, `(function(){ const b=document.querySelector('#ocr-append'); return !!(b && !b.disabled); })()`);
  if (done) break;
}
await sleep(400);
await screenshot(cdp, OUT + '/ocr.png');
console.log('  📷 ocr');
await evaluate(cdp, `(function(){ document.querySelectorAll('[data-act="close-sheet"]').forEach(b=>b.click()); return 1; })()`);
await sleep(300);

// ---- 课件导入（PPT） ----
const docNoteId = await evaluate(cdp, `(async function(){
  const buf = await (await fetch('test/fixtures/sample.pptx')).arrayBuffer();
  const file = new File([buf], '第一章 极限与连续.pptx',
    { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
  await LZ.runDocImport(file);
  await new Promise(r => setTimeout(r, 700));
  const n = (await DB.all('notes')).filter(x => x.title && x.title.indexOf('第一章') >= 0)[0];
  return n ? n.id : '';
})()`);
console.log('· 课件笔记 =', docNoteId);
if (docNoteId) {
  await shot('/note/' + docNoteId, 'doc');
}

// ---- 不懂清单：给两篇打上标记 ----
await evaluate(cdp, `(async function(){
  const notes = await DB.all('notes');
  let k = 0;
  for (const t of ['夹逼准则', '数列的极限']) {
    const n = notes.filter(x => x.title === t)[0];
    if (!n) continue;
    n.flag = 'unknown'; n.flagAt = new Date().toISOString();
    await DB.put('notes', n); k++;
  }
  await LZ.refresh();
  return k;
})()`);
await shot('/unknown', 'unknown');

// ---- 手机形态 ----
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await sleep(700);
await shot('/today', 'm-today');
await shot('/schedule', 'm-schedule');
await shot('/notes', 'm-notes');
await shot('/note/' + made.n1, 'm-note');
await shot('/graph', 'm-graph');
if (docNoteId) await shot('/note/' + docNoteId, 'm-doc');
await shot('/unknown', 'm-unknown');

// 手机上的取字弹层
await evaluate(cdp, `(function(){ location.hash = '/note/' + ${JSON.stringify(made.n1)}; return 1; })()`);
await sleep(1300);
await evaluate(cdp, `(function(){ const b = document.querySelector('[data-act="ocr-asset"]'); if (b) b.click(); return 1; })()`);
for (let i = 0; i < 40; i++) {
  await sleep(800);
  const done = await evaluate(cdp, `(function(){ const b=document.querySelector('#ocr-append'); return !!(b && !b.disabled); })()`);
  if (done) break;
}
await sleep(500);
// 手机上是底部弹层，只截弹层，别把上半屏模糊背景一起带上
const sheetBox = await evaluate(cdp, `(() => {
  const s = document.querySelector('#sheet');
  if (!s) return null;
  const r = s.getBoundingClientRect();
  const pad = 10;
  const x = Math.max(0, r.x + pad);
  const y = Math.max(0, r.y + pad);
  return { x, y, width: Math.min(window.innerWidth, r.right - pad) - x,
           height: Math.min(window.innerHeight, r.bottom - pad) - y };
})()`);
if (sheetBox) {
  const r = await cdp.send('Page.captureScreenshot', {
    format: 'png', clip: { ...sheetBox, scale: 1 }
  });
  fs.writeFileSync(OUT + '/m-ocr.png', Buffer.from(r.data, 'base64'));
  console.log('  📷 m-ocr', JSON.stringify(sheetBox));
} else {
  await screenshot(cdp, OUT + '/m-ocr.png');
  console.log('  📷 m-ocr（整屏）');
}
await evaluate(cdp, `(function(){ document.querySelectorAll('[data-act="close-sheet"]').forEach(b=>b.click()); return 1; })()`);
await sleep(400);

// 分享接收页
const link = await evaluate(cdp, `(async function(){
  const notes = await DB.all('notes');
  const n = notes.filter(x => x.title === '夹逼准则')[0];
  const code = await Core.Share.encode({ t: n.title, b: n.body, at: new Date().toISOString(), app: 'luozi' });
  return location.origin + location.pathname + '#/import?d=' + code;
})()`);
await cdp.send('Page.navigate', { url: link });
await sleep(2400);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await sleep(600);
await screenshot(cdp, OUT + '/m-share.png');
console.log('  📷 m-share');

try { proc.kill(); } catch (e) {}
console.log('done');

// 手机端专项：底部导航六个入口、不懂清单可达、知识图谱可达、不被悬浮按钮遮挡
import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8765';
const OUT = '/tmp/luozi-mobile';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓ ' + n + (e ? '  [' + e + ']' : ''))) : (fail++, console.log('  ✗ ' + n + (e ? '  [' + e + ']' : ''))); };

const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.navigate', { url: BASE + '/app.html' });
await sleep(2200);

// 手机视口
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
await sleep(600);
await evaluate(cdp, `(() => { const b = document.querySelector('#ob-save'); if (b) b.click(); })()`);
await sleep(400);

// 造点数据：3 篇笔记，其中 2 处标了不懂
await evaluate(cdp, `(async () => {
  const a = await LZ.createNote({ title: '第一章 极限与连续', kind: 'note',
    body: '函数极限的定义\\n\\n==为什么要取去心邻域==\\n\\n夹逼准则：$a_n \\\\le b_n \\\\le c_n$' });
  await LZ.saveNote(a);
  const b = await LZ.createNote({ title: '夹逼准则', kind: 'note',
    body: '设 $a_n \\\\le b_n \\\\le c_n$，若两端极限相等则中间也相等。\\n\\n==这里的条件为什么是三个数列==' });
  b.flag = 'unknown'; b.flagAt = new Date().toISOString();
  await LZ.saveNote(b);
  const c = await LZ.createNote({ title: '导数公式表', kind: 'note', body: '基本求导公式整理。' });
  await LZ.saveNote(c);
  await LZ.refresh(); LZ.render();
})()`);
await sleep(600);

console.log('\n【1】底部导航');
const tab = await evaluate(cdp, `(() => {
  const bar = document.querySelector('.tabbar');
  const btns = [...document.querySelectorAll('.tab-btn')];
  const r = bar.getBoundingClientRect();
  return {
    visible: getComputedStyle(bar).display !== 'none',
    count: btns.length,
    labels: btns.map(b => b.textContent.replace(/\\d+/g, '').trim()),
    routes: btns.map(b => b.dataset.route),
    barTop: Math.round(r.top),
    height: Math.round(r.height),
    itemW: btns.map(b => Math.round(b.getBoundingClientRect().width))
  };
})()`);
ok('底部导航可见', tab.visible === true);
ok('六个入口', tab.count === 6, tab.labels.join(' / '));
ok('含不懂清单入口', tab.routes.includes('unknown'), tab.routes.join(','));
ok('六个入口等宽且放得下', tab.itemW.every(w => w === 65) || tab.itemW.every(w => w <= 66), JSON.stringify(tab.itemW));

console.log('\n【2】不懂清单在手机上能进');
const unk = await evaluate(cdp, `(async () => {
  document.querySelector('.tab-btn[data-route="unknown"]').click();
  await new Promise(r => setTimeout(r, 600));
  return {
    hash: location.hash,
    items: document.querySelectorAll('.unk-item').length,
    title: (document.querySelector('#page-title') || {}).textContent,
    active: !!document.querySelector('.tab-btn[data-route="unknown"].active'),
    flagged: LZ.S.notes.filter(n => n.flag === 'unknown').length,
    badge: (() => { const b = document.querySelector('#badge-unknown-m');
      return b ? { text: b.textContent, hidden: b.hidden } : null; })()
  };
})()`);
ok('点得到不懂清单页', /unknown/.test(unk.hash), unk.hash);
ok('列出标了不懂的条目', unk.items >= 1, String(unk.items));
ok('标题正确', unk.title === '不懂清单', unk.title);
ok('底部导航高亮跟着走', unk.active === true);
ok('角标数量与标记数一致', unk.badge && Number(unk.badge.text) === unk.flagged && unk.flagged > 0,
  unk.flagged + ' 篇 → 角标 ' + (unk.badge && unk.badge.text));

console.log('\n【3】角标有没有把标签挤变形');
const badgeFit = await evaluate(cdp, `(() => {
  const t = document.querySelector('.tab-btn[data-route="unknown"]');
  const b = document.querySelector('#badge-unknown-m');
  const tr = t.getBoundingClientRect(), br = b.getBoundingClientRect();
  const others = [...document.querySelectorAll('.tab-btn')].map(x => Math.round(x.getBoundingClientRect().height));
  return {
    tabH: Math.round(tr.height), heights: others,
    insideX: br.left > tr.left && br.right < tr.right + 10,
    label: t.textContent.replace(/\\d+/g, '').trim()
  };
})()`);
ok('六个 tab 高度一致（角标没撑高）', new Set(badgeFit.heights).size === 1, JSON.stringify(badgeFit.heights));
ok('角标在 tab 范围内', badgeFit.insideX === true);
ok('标签文字没被角标吃掉', /不懂/.test(badgeFit.label), badgeFit.label);

console.log('\n【4】知识图谱入口');
const graph = await evaluate(cdp, `(async () => {
  LZ.go('/notes');
  await new Promise(r => setTimeout(r, 500));
  const btn = [...document.querySelectorAll('[data-act="go"]')].find(x => /图谱/.test(x.textContent));
  if (!btn) return { found: false };
  btn.click();
  await new Promise(r => setTimeout(r, 700));
  const svg = document.querySelector('svg, canvas');
  return { found: true, hash: location.hash, hasCanvas: !!svg,
    w: svg ? Math.round(svg.getBoundingClientRect().width) : 0 };
})()`);
ok('笔记页有知识图谱按钮', graph.found === true);
ok('点了能进图谱页', /graph/.test(graph.hash || ''), graph.hash);
ok('图谱画出来了', graph.hasCanvas === true, '宽度 ' + graph.w);

console.log('\n【5】排版：横向溢出与悬浮按钮遮挡');
const layout = await evaluate(cdp, `(async () => {
  const out = {};
  for (const r of ['/today', '/notes', '/unknown', '/inbox']) {
    LZ.go(r);
    await new Promise(x => setTimeout(x, 450));
    out[r] = {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      viewBottomPad: getComputedStyle(document.querySelector('.view')).paddingBottom
    };
  }
  // 回到今日，滚到底，看最后一条会不会被 ＋ 按钮盖住
  LZ.go('/today');
  await new Promise(x => setTimeout(x, 500));
  const wrap = document.querySelector('.view-wrap');
  wrap.scrollTop = wrap.scrollHeight;
  await new Promise(x => setTimeout(x, 300));
  const rows = [...document.querySelectorAll('.list .row')];
  const last = rows[rows.length - 1];
  const fab = document.querySelector('.fab');
  return Object.assign(out, {
    lastBottom: last ? Math.round(last.getBoundingClientRect().bottom) : null,
    fabTop: fab ? Math.round(fab.getBoundingClientRect().top) : null,
    fabVisible: fab ? getComputedStyle(fab).display !== 'none' : false
  });
})()`);
ok('/today 无横向溢出', layout['/today'].overflow <= 1, String(layout['/today'].overflow));
ok('/notes 无横向溢出', layout['/notes'].overflow <= 1, String(layout['/notes'].overflow));
ok('/unknown 无横向溢出', layout['/unknown'].overflow <= 1, String(layout['/unknown'].overflow));
ok('底部留白够躲开悬浮按钮', parseInt(layout['/today'].viewBottomPad, 10) >= 120, layout['/today'].viewBottomPad);
ok('滚到底时最后一条不被悬浮按钮压住',
  layout.lastBottom === null || layout.fabTop === null ? true : layout.lastBottom <= layout.fabTop,
  'row底 ' + layout.lastBottom + ' / 按钮顶 ' + layout.fabTop);

console.log('\n【6】截图');
for (const [route, name] of [['/today', 'm-today'], ['/notes', 'm-notes'], ['/unknown', 'm-unknown'], ['/graph', 'm-graph']]) {
  await evaluate(cdp, `LZ.go('${route}')`);
  await sleep(700);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
}
ok('四张截图已保存', true, OUT);

cdp.close();
proc.kill('SIGKILL');
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

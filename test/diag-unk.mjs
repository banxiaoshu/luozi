import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';

const BASE = 'http://127.0.0.1:8765';
const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await cdp.send('Page.navigate', { url: BASE + '/app.html' });
await sleep(2600);

await evaluate(cdp, `(async function(){
  document.querySelectorAll('[data-act="close-sheet"]').forEach(b=>b.click());
  localStorage.setItem('lz_onboard','1');
  const notes = await DB.all('notes');
  for (const n of notes) await LZ.deleteNote(n.id);
  const a = await LZ.createNote({ title: '夹逼准则', kind: 'note', body: '正文 ==先记音，下课再对字形==。' });
  a.flag = 'unknown';
  await DB.put('notes', a);
  await LZ.refresh();
  LZ.go('/unknown');
  return 1;
})()`);
await sleep(900);

const info = await evaluate(cdp, `(function(){
  const out = [];
  const item = document.querySelector('.unk-item');
  if (!item) return { err: '没有 unk-item' };
  const walk = (el, depth) => {
    const r = el.getBoundingClientRect();
    out.push({
      d: depth, tag: el.tagName + (el.className ? '.' + String(el.className).split(' ').join('.') : ''),
      w: Math.round(r.width), right: Math.round(r.right),
      flex: getComputedStyle(el).flex, minW: getComputedStyle(el).minWidth,
      ws: getComputedStyle(el).whiteSpace, ovf: getComputedStyle(el).overflow
    });
    if (depth < 4) [...el.children].forEach((c) => walk(c, depth + 1));
  };
  walk(item, 0);
  return { vw: window.innerWidth, scrollW: document.documentElement.scrollWidth,
           viewW: Math.round(document.querySelector('.view').getBoundingClientRect().width), out };
})()`);
console.log(JSON.stringify(info, null, 1));

cdp.close(); proc.kill('SIGKILL');

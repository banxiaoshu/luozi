import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8765';
const OUT = '/tmp/luozi-diag';
fs.mkdirSync(OUT, { recursive: true });
const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.navigate', { url: BASE + '/' });
await sleep(2400);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1040, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(500);

// 新加的两块：第 2 个（课件）和第 6 个（标不懂）
const targets = [
  ['#how .feat:nth-of-type(2)', 'feat-doc'],
  ['#how .feat:nth-of-type(6)', 'feat-unknown'],
];

for (const [sel, name] of targets) {
  const box = await evaluate(cdp, `(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null; const r = el.getBoundingClientRect();
    return { x: 0, y: Math.max(0, r.y + window.scrollY), width: 1040, height: Math.min(1000, r.height + 30) }; })()`);
  if (!box) { console.log('找不到', sel); continue; }
  const r = await cdp.send('Page.captureScreenshot', {
    format: 'png', clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
    captureBeyondViewport: true,
  });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log(name, JSON.stringify(box));
}

// 顺带量一下新截图在桌面上的显示宽度 vs 原图
const info = await evaluate(cdp, `[...document.querySelectorAll('.feat-shot img')].map(i => ({
  src: i.getAttribute('src'), natural: i.naturalWidth,
  shown: Math.round(i.getBoundingClientRect().width),
  ratio: +(i.naturalWidth / i.getBoundingClientRect().width).toFixed(2)
}))`);
console.log('\n图片显示比例（ratio 越大越糊）：');
info.forEach((s) => console.log(`  ${s.src.padEnd(22)} 原图 ${String(s.natural).padStart(4)} → 显示 ${String(s.shown).padStart(4)}  压缩 ${s.ratio}×`));

// 手机端：新两块是否溢出、用的是不是竖版图
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
await sleep(700);
const mob = await evaluate(cdp, `(() => {
  const over = [];
  document.querySelectorAll('#how *').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > window.innerWidth + 2) over.push(el.tagName + '.' + el.className + ' right=' + Math.round(r.right));
  });
  const picks = [...document.querySelectorAll('#how .feat-shot img')].map(i => ({
    file: i.currentSrc.split('/').pop(), shown: Math.round(i.getBoundingClientRect().width)
  }));
  return { over, picks, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
})()`);
console.log('\n手机端 #how 溢出：', mob.over.length ? JSON.stringify(mob.over, null, 1) : '无');
console.log('手机端 scrollWidth/clientWidth：', mob.sw, '/', mob.cw);
mob.picks.forEach((p) => console.log(`  ${p.file.padEnd(20)} 显示 ${p.shown}px`));

cdp.close();
proc.kill('SIGKILL');

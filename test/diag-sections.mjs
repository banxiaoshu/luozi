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
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(500);

const targets = [['#pain', 'sec-pain'], ['#how .feat:first-of-type', 'sec-feat1'],
  ['#how .feat.flip', 'sec-feat2'], ['#local', 'sec-local'], ['#install', 'sec-install']];

for (const [sel, name] of targets) {
  const box = await evaluate(cdp, `(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null; const r = el.getBoundingClientRect();
    return { x: 0, y: Math.max(0, r.y + window.scrollY), width: 1440, height: Math.min(1100, r.height + 40) }; })()`);
  if (!box) { console.log('找不到', sel); continue; }
  const r = await cdp.send('Page.captureScreenshot', {
    format: 'png', clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
    captureBeyondViewport: true
  });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log(name, JSON.stringify(box));
}

// 量一下各张截图在页面上的实际显示宽度 vs 原图宽度
const sizes = await evaluate(cdp, `[...document.querySelectorAll('img')].map(i => ({
  src: i.getAttribute('src'), natural: i.naturalWidth, shown: Math.round(i.getBoundingClientRect().width),
  ratio: +(i.naturalWidth / i.getBoundingClientRect().width).toFixed(2)
}))`);
console.log('\n图片显示比例（ratio 越大越糊）：');
sizes.forEach(s => console.log(`  ${s.src.padEnd(22)} 原图 ${String(s.natural).padStart(4)} → 显示 ${String(s.shown).padStart(4)}  压缩 ${s.ratio}×`));

cdp.close(); proc.kill('SIGKILL');

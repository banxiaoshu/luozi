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
await sleep(2600);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(700);
const H = await evaluate(cdp, 'document.documentElement.scrollHeight');

// 整页三张，便于看节奏
const slice = Math.ceil(H / 3);
for (let i = 0; i < 3; i++) {
  const y = i * slice;
  const h = Math.min(slice, H - y);
  const r = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y, width: 1280, height: h, scale: 0.62 }
  });
  fs.writeFileSync(`${OUT}/d-page-${i}.png`, Buffer.from(r.data, 'base64'));
}
console.log('总高', H, '每段', slice);
cdp.close(); proc.kill('SIGKILL');

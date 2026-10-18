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
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await sleep(600);

const H = await evaluate(cdp, 'document.documentElement.scrollHeight');
const step = 760;
let i = 0;
for (let y = 0; y < H; y += step) {
  const r = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y, width: 390, height: step, scale: 1 }
  });
  fs.writeFileSync(`${OUT}/m-sec-${i}.png`, Buffer.from(r.data, 'base64'));
  i++;
}
console.log('共', i, '段，总高', H);
cdp.close(); proc.kill('SIGKILL');

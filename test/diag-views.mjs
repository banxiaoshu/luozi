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

async function grab(w, h, name, dsf = 1) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dsf, mobile: w < 600 });
  await sleep(700);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  const hs = await evaluate(cdp, 'document.documentElement.scrollHeight');
  console.log(name, w + 'x' + h, '页面总高', hs);
}

await cdp.send('Page.navigate', { url: BASE + '/' });
await sleep(2600);

await grab(1440, 1500, 'view-hero');
await grab(390, 844, 'view-mobile-top', 2);

// 手机全页
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(500);
const h = await evaluate(cdp, 'document.documentElement.scrollHeight');
const r = await cdp.send('Page.captureScreenshot', {
  format: 'png', captureBeyondViewport: true,
  clip: { x: 0, y: 0, width: 390, height: h, scale: 0.55 }
});
fs.writeFileSync(`${OUT}/view-mobile-full.png`, Buffer.from(r.data, 'base64'));
console.log('view-mobile-full 总高', h);

cdp.close(); proc.kill('SIGKILL');

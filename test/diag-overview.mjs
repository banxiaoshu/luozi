import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';
import fs from 'node:fs';

const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8765/' });
await sleep(2600);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1040, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(600);

const h = await evaluate(cdp, `document.documentElement.scrollHeight`);
console.log('页面总高', h);

// 整段功能区，缩到 0.34 看节奏
const sec = await evaluate(cdp, `(() => { const el = document.querySelector('#how');
  const r = el.getBoundingClientRect(); return { x: 0, y: r.y + window.scrollY, w: 1040, h: r.height }; })()`);
const r = await cdp.send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: 0, y: sec.y, width: 1040, height: sec.h, scale: 0.34 },
  captureBeyondViewport: true,
});
fs.mkdirSync('/tmp/luozi-diag', { recursive: true });
fs.writeFileSync('/tmp/luozi-diag/feat-overview.png', Buffer.from(r.data, 'base64'));
console.log('feat-overview.png', Math.round(sec.h), '→', Math.round(sec.h * 0.34));

cdp.close();
proc.kill('SIGKILL');

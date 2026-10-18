// 截图：桌面端速记页，看「＋ 拍照 / 相册」按钮与收件箱里的照片
import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const IMG = path.join(ROOT, 'shots/ocr.jpg');

const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('DOM.enable');
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8765/app.html' });
await sleep(2200);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1040, height: 760, deviceScaleFactor: 2, mobile: false });
await sleep(500);
await evaluate(cdp, `(() => { const b = document.querySelector('#ob-save'); if (b) b.click(); })()`);
await sleep(400);

// 通过文件选择器塞两张图，模拟「从相册上传」
await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
cdp.events.length = 0;
await evaluate(cdp, `LZ.go('/inbox')`);
await sleep(400);
const rect = await evaluate(cdp, `(() => { const b = document.querySelector('[data-act="capture-photo"]');
  const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
let chooser = null;
for (let i = 0; i < 30; i++) {
  await sleep(100);
  const ev = cdp.events.filter((e) => e.method === 'Page.fileChooserOpened').pop();
  if (ev) { chooser = ev.params; break; }
}
await cdp.send('DOM.setFileInputFiles', { files: [IMG], backendNodeId: chooser.backendNodeId });
await sleep(1500);
await evaluate(cdp, `LZ.go('/inbox')`);
await sleep(600);

fs.mkdirSync('/tmp/luozi-diag', { recursive: true });
const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/luozi-diag/inbox-upload.png', Buffer.from(r.data, 'base64'));
console.log('ok', await evaluate(cdp, `document.querySelectorAll('.list .row').length`));
cdp.close();
proc.kill('SIGKILL');

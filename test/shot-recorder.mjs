// 补一张「录音中」的界面图，落地页讲录音功能要用
import { launch, newPage, connect, evaluate, screenshot, sleep } from './cdp.mjs';
import fs from 'node:fs';

const BASE = process.env.LUOZI_URL || 'http://127.0.0.1:8765/app.html';
const OUT = '/Users/wlw/WorkBuddy/数媒app开发/落字/shots/raw';
fs.mkdirSync(OUT, { recursive: true });

const proc = await launch(['--use-file-for-fake-audio-capture=/tmp/speech.wav']);
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1040, height: 680, deviceScaleFactor: 2, mobile: false });
await cdp.send('Page.navigate', { url: BASE });
await sleep(2600);

await evaluate(cdp, `(async function(){
  document.querySelectorAll('[data-act="close-sheet"]').forEach(b=>b.click());
  localStorage.setItem('lz_onboard','1');
  // 建一门课 + 一篇笔记，让录音面板挂在真实笔记上
  const note = await LZ.createNote({ title: '第7周 高等数学 · 洛必达', kind: 'note', body: '这节前半段没跟上，先把老师说的记下来。' });
  LZ.go('/note/' + note.id);
  await new Promise(r => setTimeout(r, 900));
  return note.id;
})()`);
await sleep(700);

// 打开录音面板
await evaluate(cdp, `(function(){ LZ.openRecorder(); return 1; })()`);
await sleep(700);

// 开录，让它跑两秒采波形
const started = await evaluate(cdp, `(function(){
  const btns = Array.from(document.querySelectorAll('#sheet button'));
  const start = btns.filter(b => /开始|录音/.test(b.textContent))[0];
  if (start) { start.click(); return start.textContent.trim(); }
  return null;
})()`);
console.log('· 开始录音按钮 =', started);
await sleep(2600);
await screenshot(cdp, OUT + '/recorder.png');
console.log('  📷 recorder');

// 手机版录音面板：只截底部弹层
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await sleep(1200);
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
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...sheetBox, scale: 1 } });
  fs.writeFileSync(OUT + '/m-recorder.png', Buffer.from(r.data, 'base64'));
  console.log('  📷 m-recorder', JSON.stringify(sheetBox));
} else {
  await screenshot(cdp, OUT + '/m-recorder.png');
  console.log('  📷 m-recorder（整屏）');
}

// 停下来，别留残余
await evaluate(cdp, `(function(){
  const btns = Array.from(document.querySelectorAll('#sheet button'));
  const stop = btns.filter(b => /停止|结束|保存/.test(b.textContent))[0];
  if (stop) stop.click();
  return 1;
})()`);
await sleep(800);

try { proc.kill(); } catch (e) {}
console.log('done');

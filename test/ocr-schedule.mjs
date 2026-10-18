// 验证「传课表截图」路线：选图 → 本地 OCR → 填进文本框 → 解析 → 导入
import { launch, newPage, connect, evaluate, screenshot, sleep } from './cdp.mjs';
const BASE = process.env.LUOZI_URL || 'http://127.0.0.1:8765/app.html';
const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: BASE });
await sleep(2400);
await evaluate(cdp, `(function(){ document.querySelectorAll('[data-act="close-sheet"]').forEach(b=>b.click()); return 1; })()`);

// 打开导入弹层，塞一张带表格线的课表截图进去
await evaluate(cdp, `(async function(){
  LZ.openImport();
  await new Promise(r=>setTimeout(r,300));
  const c = document.createElement('canvas'); c.width = 1000; c.height = 700;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0,0,1000,700);
  g.fillStyle = '#000'; g.font = 'bold 40px "PingFang SC","Heiti SC",sans-serif';
  g.fillText('2026 秋季课表', 50, 70);
  const rows = [
    ['周一','08:30-10:00','高等数学','A301'],
    ['周二','09:50-11:30','大学英语','语音室B2'],
    ['周三','14:00-15:40','人工智能基础','C101'],
    ['周四','10:15-12:00','经济法','A405'],
    ['周五','15:50-17:30','近现代史纲要','D205']
  ];
  g.strokeStyle = '#000'; g.lineWidth = 2;
  const x0 = 40, w = 920, rh = 90, top = 110;
  for (let i = 0; i <= rows.length; i++) { g.beginPath(); g.moveTo(x0, top+i*rh); g.lineTo(x0+w, top+i*rh); g.stroke(); }
  [0,130,340,640,920].forEach(dx => { g.beginPath(); g.moveTo(x0+dx, top); g.lineTo(x0+dx, top+rows.length*rh); g.stroke(); });
  g.font = '32px "PingFang SC","Heiti SC",sans-serif'; g.fillStyle = '#000';
  rows.forEach((cells, i) => {
    const y = top + i*rh + rh/2 + 11;
    [x0+14, x0+144, x0+354, x0+654].forEach((x, j) => g.fillText(cells[j], x, y));
  });
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const file = new File([blob], '课表截图.png', { type: 'image/png' });
  const dt = new DataTransfer(); dt.items.add(file);
  const input = document.querySelector('#import-shot-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  return { fileSize: file.size };
})()`);

// 等 OCR 完成（最多 60 秒）
let st = null;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  st = await evaluate(cdp, `(async function(){
    return {
      preview: (document.querySelector('#import-preview')||{}).textContent || '',
      textarea: (document.querySelector('#import-text')||{}).value || ''
    };
  })()`);
  if (/识别完成|识别失败|没识别出/.test(st.preview)) break;
}
console.log('· 识别提示 =', JSON.stringify(st.preview));
console.log('· 填入文本 =', JSON.stringify(st.textarea));
await screenshot(cdp, '/tmp/s-tt-shot.png');

// 解析 + 导入
const fin = await evaluate(cdp, `(async function(){
  document.querySelector('#btn-parse').click();
  await new Promise(r=>setTimeout(r,300));
  const canImport = !document.querySelector('#btn-import-ok').disabled;
  const preview = document.querySelector('#import-preview').textContent;
  if (canImport) { document.querySelector('#btn-import-ok').click(); await new Promise(r=>setTimeout(r,1200)); }
  return { canImport, preview: preview.slice(0, 160), events: await DB.count('events'), route: location.hash };
})()`);
console.log('· 导入结果 =', JSON.stringify(fin));
try { proc.kill(); } catch (e) {}

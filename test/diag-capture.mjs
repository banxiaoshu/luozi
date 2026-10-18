// 手机端检查速记页工具栏：新按钮文案变长后会不会把「待整理」计数挤出屏幕
import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';
import fs from 'node:fs';

const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8765/app.html' });
await sleep(2200);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
await sleep(600);
await evaluate(cdp, `(() => { const b = document.querySelector('#ob-save'); if (b) b.click(); })()`);
await sleep(400);
await evaluate(cdp, `LZ.go('/inbox')`);
await sleep(500);

const info = await evaluate(cdp, `(() => {
  const tb = document.querySelector('.tt-toolbar');
  const over = [];
  document.querySelectorAll('.tt-toolbar *').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > window.innerWidth + 1) over.push(el.className + ' right=' + Math.round(r.right));
  });
  const btns = [...document.querySelectorAll('.tt-toolbar .btn')].map(b => ({
    t: b.textContent.trim(), w: Math.round(b.getBoundingClientRect().width), right: Math.round(b.getBoundingClientRect().right)
  }));
  return { over, btns, tbH: tb ? Math.round(tb.getBoundingClientRect().height) : 0,
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
})()`);
console.log('溢出：', info.over.length ? JSON.stringify(info.over) : '无');
console.log('scrollWidth/clientWidth：', info.sw, '/', info.cw);
console.log('工具栏高度：', info.tbH);
info.btns.forEach((b) => console.log(`  ${b.t.padEnd(14)} 宽 ${b.w}  right ${b.right}`));

// 记一笔弹层也看一眼
await evaluate(cdp, `(() => { document.querySelector('#btn-quick').click(); })()`);
await sleep(500);
const sheet = await evaluate(cdp, `(() => {
  const rows = [...document.querySelectorAll('#sheet .list .row')];
  const over = rows.filter(r => r.getBoundingClientRect().right > window.innerWidth + 1).length;
  return { rows: rows.map(r => r.querySelector('.title').textContent + ' | ' + r.querySelector('.sub').textContent), over };
})()`);
console.log('\n记一笔弹层：');
sheet.rows.forEach((r) => console.log('  ' + r));
console.log('  行溢出数：', sheet.over);

fs.mkdirSync('/tmp/luozi-diag', { recursive: true });
const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/luozi-diag/m-quick.png', Buffer.from(r.data, 'base64'));

cdp.close();
proc.kill('SIGKILL');

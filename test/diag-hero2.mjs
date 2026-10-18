import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8765';
const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

// 1) 直接打开原始 jpg，看浏览器自己解码出来是什么亮度
await cdp.send('Page.navigate', { url: BASE + '/shots/today.jpg' });
await sleep(1500);
let r = await cdp.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/raw-jpg.png', Buffer.from(r.data, 'base64'));

// 取图片中间某点的像素亮度（用 canvas 读原图）
await cdp.send('Page.navigate', { url: BASE + '/' });
await sleep(2200);
const px = await evaluate(cdp, `(async () => {
  const img = document.querySelector('.hero-shot .frame img');
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  // 采样：整图平均亮度
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 97) { sum += (d[i] + d[i+1] + d[i+2]) / 3; n++; }
  return { avg: +(sum / n).toFixed(1), w: c.width, h: c.height };
})()`);
console.log('canvas 读取原图平均亮度 =', JSON.stringify(px));

// 2) 用 CDP 截取该 img 元素区域，取中心像素
const box = await evaluate(cdp, `(() => { const r = document.querySelector('.hero-shot .frame img').getBoundingClientRect();
  return { x: Math.round(r.x + r.width/2) - 20, y: Math.round(r.y + 200), width: 40, height: 40 }; })()`);
r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 } });
fs.writeFileSync('/tmp/hero-px.png', Buffer.from(r.data, 'base64'));

// 3) 用 html2canvas 思路：读页面元素的计算后亮度不可能，改测父级链上的 opacity/filter
const chain = await evaluate(cdp, `(() => {
  const out = [];
  let el = document.querySelector('.hero-shot .frame img');
  while (el && el !== document.documentElement) {
    const cs = getComputedStyle(el);
    out.push({ tag: el.tagName, cls: el.className, opacity: cs.opacity, filter: cs.filter,
               mixBlend: cs.mixBlendMode, bg: cs.backgroundColor, isolation: cs.isolation });
    el = el.parentElement;
  }
  return out;
})()`);
console.log('父级链:', JSON.stringify(chain, null, 1));

cdp.close(); proc.kill('SIGKILL');

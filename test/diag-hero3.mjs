import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';

const BASE = 'http://127.0.0.1:8765';
const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.navigate', { url: BASE + '/' });
await sleep(2400);

// 页面渲染出来那一块的真实像素亮度
const box = await evaluate(cdp, `(() => { const r = document.querySelector('.hero-shot .frame img').getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
const shot = await cdp.send('Page.captureScreenshot', {
  format: 'png', clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 }
});
const b64 = shot.data;

// 在页面里把截图像素和原图像素都读出来比
const cmp = await evaluate(cdp, `(async () => {
  async function avg(src, w, h) {
    const bmp = await createImageBitmap(await (await fetch(src)).blob());
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.drawImage(bmp, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    let s = 0, n = 0, mx = 0;
    for (let i = 0; i < d.length; i += 4) { const v = (d[i]+d[i+1]+d[i+2])/3; s += v; n++; if (v > mx) mx = v; }
    return { avg: +(s/n).toFixed(2), max: Math.round(mx) };
  }
  const rendered = await avg('data:image/png;base64,${b64}', Math.round(${box.width}), Math.round(${box.height}));
  const original = await avg('/shots/today.jpg', Math.round(${box.width}), Math.round(${box.height}));
  return { rendered, original,
           renderSize: [Math.round(${box.width}), Math.round(${box.height})] };
})()`);
console.log(JSON.stringify(cmp, null, 1));

cdp.close(); proc.kill('SIGKILL');

import { launch, newPage, connect, evaluate, screenshot, sleep } from './cdp.mjs';

const BASE = 'http://127.0.0.1:8765';
const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.navigate', { url: BASE + '/' });
await sleep(2500);

const info = await evaluate(cdp, `(() => {
  const img = document.querySelector('.hero-shot .frame img');
  const cs = getComputedStyle(img);
  const box = img.getBoundingClientRect();
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  const stack = document.elementsFromPoint(cx, cy).map(el => el.tagName + '.' + (el.className || '') + '#' + (el.id || ''));
  return {
    src: img.getAttribute('src'),
    natural: img.naturalWidth + 'x' + img.naturalHeight,
    opacity: cs.opacity, filter: cs.filter, mixBlend: cs.mixBlendMode,
    brightness: cs.mixBlendMode, complete: img.complete,
    stack,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    cssVars: {
      ink: getComputedStyle(document.documentElement).getPropertyValue('--ink'),
      panel: getComputedStyle(document.documentElement).getPropertyValue('--panel')
    }
  };
})()`);
console.log(JSON.stringify(info, null, 2));

// 单独截 hero 图那块，排除整页缩放的干扰
const clip = await evaluate(cdp, `(() => { const r = document.querySelector('.hero-shot .frame').getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
const r = await cdp.send('Page.captureScreenshot', {
  format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: true
});
const fs = await import('node:fs');
fs.writeFileSync('/tmp/hero-clip.png', Buffer.from(r.data, 'base64'));
console.log('clip saved', JSON.stringify(clip));

cdp.close();
proc.kill('SIGKILL');

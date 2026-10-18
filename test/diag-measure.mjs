import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';

const BASE = 'http://127.0.0.1:8765';
const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.navigate', { url: BASE + '/' });
await sleep(2400);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(400);

const m = await evaluate(cdp, `(() => {
  const out = [];
  document.querySelectorAll('.feat, .hero-shot, .phones figure').forEach(w => {
    const img = w.querySelector('img');
    const f = w.querySelector('.frame');
    const ri = img.getBoundingClientRect();
    const rf = f ? f.getBoundingClientRect() : null;
    out.push({
      src: img.getAttribute('src'),
      natural: img.naturalWidth + 'x' + img.naturalHeight,
      naturalRatio: +(img.naturalWidth / img.naturalHeight).toFixed(3),
      imgBox: [Math.round(ri.width), Math.round(ri.height)],
      shownRatio: +(ri.width / ri.height).toFixed(3),
      frameBox: rf ? [Math.round(rf.width), Math.round(rf.height)] : null,
      cssH: getComputedStyle(img).height,
      cssObjFit: getComputedStyle(img).objectFit,
      parentH: getComputedStyle(f).height
    });
  });
  return out;
})()`);
console.log(JSON.stringify(m, null, 1));
cdp.close(); proc.kill('SIGKILL');

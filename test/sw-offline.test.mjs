// 验证：访问过落地页之后，断网打开「应用」仍然是应用，不是落地页
import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';

const BASE = 'http://127.0.0.1:8765';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : ''))); };

const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');

// 1. 先正常访问落地页和应用，让 SW 把两份都缓存下来
await cdp.send('Page.navigate', { url: BASE + '/' });
await sleep(2600);
await cdp.send('Page.navigate', { url: BASE + '/app.html' });
await sleep(2600);
const warm = await evaluate(cdp, `(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  const keys = await caches.keys();
  const c = await caches.open(keys[0]);
  const all = (await c.keys()).map(x => new URL(x.url).pathname);
  return { active: !!(r && r.active), keys, cached: all.filter(p => p.endsWith('.html') || p === '/') };
})()`);
console.log('缓存状态:', JSON.stringify(warm));
ok('SW 已激活', warm.active);
ok('两个页面各自入缓存', warm.cached.length >= 2, JSON.stringify(warm.cached));

// 1b. 根路径在线时是哪个页面（线上可能是落地页，本地 http.server 是应用）
await cdp.send('Page.navigate', { url: BASE + '/' });
await sleep(2400);
const rootOnline = await evaluate(cdp, `(() => ({
  isLanding: !!document.querySelector('.hero .eyebrow'),
  isApp: !!document.querySelector('#page-title, .sidebar, .nav-item'),
  path: location.pathname
}))()`);
console.log('根路径在线内容:', JSON.stringify(rootOnline));

// 2. 断网
await cdp.send('Network.emulateNetworkConditions', {
  offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0
});
await sleep(400);

// 2b. 断网打开根路径：必须和在线时是同一个页面，不能被 index.html 顶掉
await cdp.send('Page.navigate', { url: BASE + '/' });
await sleep(2600);
const rootOff = await evaluate(cdp, `(() => ({
  isLanding: !!document.querySelector('.hero .eyebrow'),
  isApp: !!document.querySelector('#page-title, .sidebar, .nav-item'),
  title: document.title
}))()`);
ok('断网打开根路径，内容与在线时一致',
  rootOff.isLanding === rootOnline.isLanding && rootOff.isApp === rootOnline.isApp,
  JSON.stringify(rootOff));

// 3. 断网打开应用
await cdp.send('Page.navigate', { url: BASE + '/app.html' });
await sleep(2600);
const offApp = await evaluate(cdp, `(() => ({
  title: document.title,
  body: document.body.innerText.trim().slice(0, 60),
  isLanding: !!document.querySelector('.hero .eyebrow'),
  isApp: !!document.querySelector('#page-title, .sidebar, .nav-item')
}))()`);
ok('断网打开 /app.html 不是落地页', offApp.isLanding === false, JSON.stringify(offApp));
ok('断网打开 /app.html 是应用', offApp.isApp === true, offApp.body);

// 4. 断网打开落地页
await cdp.send('Page.navigate', { url: BASE + '/' });
await sleep(2400);
const offWelcome = await evaluate(cdp, `(() => ({
  isLanding: !!document.querySelector('.hero .eyebrow'),
  h1: (document.querySelector('h1') || {}).innerText || ''
}))()`);
ok('断网也能打开落地页', offWelcome.isLanding === true, JSON.stringify(offWelcome));

cdp.close(); proc.kill('SIGKILL');
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

// 线上验收：直接打公网地址，用真 Chrome 确认「谁打开都能装/都能用」
import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';

const LIVE = process.env.LUOZI_URL || 'https://banxiaoshu.tech/';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓ ' + n + (e ? '  [' + e + ']' : ''))) : (fail++, console.log('  ✗ ' + n + (e ? '  [' + e + ']' : ''))); };

const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');
await cdp.send('Page.navigate', { url: LIVE });
await sleep(4000);

console.log('\n【1】根路径是对的页面');
const head = await evaluate(cdp, `({ title: document.title, url: location.href,
  isLanding: !!document.querySelector('.hero .eyebrow'),
  h1: (document.querySelector('h1')||{}).innerText || '',
  feats: document.querySelectorAll('.feat').length })`);
ok('打开就是落地页', head.isLanding === true, head.url);
ok('标题正确', /听不懂的那几分钟/.test(head.title), head.title);
ok('八个功能区块都在', head.feats === 8, String(head.feats));

console.log('\n【2】可安装性（HTTPS 线上环境）');
await sleep(1200);
const errs = await cdp.send('Page.getInstallabilityErrors');
ok('Chrome 认为可安装', (errs.installabilityErrors || []).length === 0, JSON.stringify(errs.installabilityErrors));
const man = await cdp.send('Page.getAppManifest');
ok('manifest 无解析错误', (man.errors || []).length === 0, JSON.stringify((man.errors || []).map((e) => e.message)));
ok('start_url 指向应用 app.html', /app\.html/.test(man.data || ''), (man.data || '').match(/"start_url":[^,]*/) || '');

console.log('\n【3】安装按钮');
const btn = await evaluate(cdp, `(() => {
  const b = document.querySelector('[data-install]');
  const r = b.getBoundingClientRect();
  return { text: b.textContent.trim(), visible: r.width > 40 && r.height > 16 };
})()`);
ok('首页就有「装到桌面」按钮', /装到桌面|打开落字/.test(btn.text), btn.text);
ok('按钮看得见', btn.visible === true, String(btn.visible));

console.log('\n【4】Service Worker');
const sw = await evaluate(cdp, `(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  await new Promise(res => setTimeout(res, 1200));
  return { has: !!r, active: !!(r && r.active), state: r && r.active && r.active.state,
    scope: r && r.scope, secure: window.isSecureContext };
})()`);
ok('安全上下文（HTTPS）', sw.secure === true, String(sw.secure));
ok('SW 已注册并激活', sw.has === true && sw.active === true, sw.state + ' @ ' + sw.scope);

console.log('\n【5】旧地址不会把人带到过期页面');
await cdp.send('Page.navigate', { url: LIVE + 'welcome.html' });
await sleep(2500);
const old = await evaluate(cdp, `({ path: location.pathname, title: document.title,
  isLanding: !!document.querySelector('.hero .eyebrow') })`);
ok('/welcome.html 自动跳回首页', old.path === '/', old.path);

console.log('\n【6】应用本体');
await cdp.send('Page.navigate', { url: LIVE + 'app.html' });
await sleep(3000);
const app = await evaluate(cdp, `({ hasLZ: typeof window.LZ !== 'undefined',
  shell: !!document.querySelector('.nav-item, #page-title, .sidebar'),
  err: document.documentElement.getAttribute('data-err') || '' })`);
ok('app.html 是应用', app.hasLZ === true, String(app.hasLZ));
ok('应用外壳渲染出来', app.shell === true, String(app.shell));
ok('没有运行时异常', app.err === '', app.err);

const bad = cdp.events.filter((e) => e.method === 'Network.loadingFailed' && e.params && !e.params.canceled);
ok('没有资源加载失败', bad.length === 0, String(bad.length));

cdp.close();
proc.kill('SIGKILL');
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

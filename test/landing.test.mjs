// 落地页 welcome.html 验收：可安装性、资源加载、排版、按钮行为
import fs from 'node:fs';
import { launch, newPage, connect, evaluate, screenshot, sleep } from './cdp.mjs';

const BASE = 'http://127.0.0.1:8765';
const OUT = '/tmp/luozi-diag';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const proc = await launch();
let cdp;

try {
  const page = await newPage('about:blank');
  cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');

  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(2600);

  console.log('\n【1】可安装性');
  const inst = await cdp.send('Page.getInstallabilityErrors');
  ok('getInstallabilityErrors 为空', inst.installabilityErrors.length === 0,
    JSON.stringify(inst.installabilityErrors));
  const man = await cdp.send('Page.getAppManifest');
  ok('manifest 已解析且无报错', !man.errors || man.errors.length === 0, JSON.stringify(man.errors));
  const m = JSON.parse(man.data);
  ok('start_url 指向应用而非落地页', m.start_url === './app.html', m.start_url);

  console.log('\n【2】资源加载');
  const imgs = await evaluate(cdp, `(() => {
    const list = [...document.images].map(i => ({
      src: i.getAttribute('src'), w: i.naturalWidth, h: i.naturalHeight, cur: i.currentSrc
    }));
    return { total: list.length, broken: list.filter(i => !i.w || !i.h) };
  })()`);
  ok('图片总数 >= 10', imgs.total >= 10, String(imgs.total));
  ok('没有加载失败的图片', imgs.broken.length === 0, JSON.stringify(imgs.broken));

  const netFail = await evaluate(cdp, `(() => {
    const r = performance.getEntriesByType('resource');
    return r.filter(e => e.responseStatus && e.responseStatus >= 400).map(e => e.name + ' ' + e.responseStatus);
  })()`);
  ok('无 4xx/5xx 资源', netFail.length === 0, JSON.stringify(netFail));

  const sw = await evaluate(cdp, `(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return { has: !!r, active: !!(r && r.active), state: r && r.active && r.active.state };
  })()`);
  ok('Service Worker 已激活', sw.active === true, JSON.stringify(sw));

  console.log('\n【3】内容完整性');
  const content = await evaluate(cdp, `(() => ({
    feats: document.querySelectorAll('.feat').length,
    pains: document.querySelectorAll('.pain .card, .pain-card, .pain > *').length,
    installBtns: document.querySelectorAll('[data-install]').length,
    h1: (document.querySelector('h1') || {}).innerText || '',
    title: document.title,
    links: [...document.querySelectorAll('a[href*="app.html"]')].length
  }))()`);
  ok('功能区块 8 个', content.feats === 8, String(content.feats));
  ok('安装按钮 >= 3 处', content.installBtns >= 3, String(content.installBtns));
  ok('标题含「落字」', /落字/.test(content.title) && content.h1.length > 0, content.title);
  ok('有通往应用的链接', content.links >= 1, String(content.links));

  console.log('\n【4】桌面排版 1440×900');
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const d = await evaluate(cdp, `(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    height: document.documentElement.scrollHeight
  }))()`);
  ok('无横向溢出', d.overflow <= 1, 'overflow=' + d.overflow);
  ok('页面高度合理(>2500)', d.height > 2500, String(d.height));
  await screenshot(cdp, OUT + '/landing-desktop.png');

  console.log('\n【5】手机排版 390×844');
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await sleep(600);
  const mob = await evaluate(cdp, `(() => {
    const over = [];
    document.querySelectorAll('body *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > window.innerWidth + 2) over.push(el.tagName + '.' + el.className + ' right=' + Math.round(r.right));
    });
    const shots = [...document.querySelectorAll('.feat-shot img')].map(i => ({
      file: i.currentSrc.split('/').pop(),
      shown: Math.round(i.getBoundingClientRect().width)
    }));
    return {
      scrollOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      offenders: over.slice(0, 6),
      copyCols: getComputedStyle(document.querySelector('.feat-copy')).gridTemplateColumns,
      shots
    };
  })()`);
  ok('手机无横向溢出', mob.scrollOverflow <= 1, 'overflow=' + mob.scrollOverflow);
  ok('文案区单列堆叠', !/\s/.test(mob.copyCols.trim()), mob.copyCols);
  const portraitUsed = mob.shots.filter(s => s.file.startsWith('m-')).length;
  ok('手机上换用了竖版截图', portraitUsed === mob.shots.length, JSON.stringify(mob.shots));
  await screenshot(cdp, OUT + '/landing-mobile.png');

  console.log('\n【6】安装按钮行为');
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const bip = await evaluate(cdp, `({ standalone: window.matchMedia('(display-mode: standalone)').matches, btnText: document.querySelector('[data-install]').textContent.trim() })`);
  ok('非独立窗口模式', bip.standalone === false);
  await evaluate(cdp, `document.querySelector('[data-install]').click()`);
  await sleep(900);
  const snack = await evaluate(cdp, `(() => {
    const s = document.getElementById('snack');
    return { on: s.classList.contains('on'), text: s.textContent.trim() };
  })()`);
  ok('点按钮后有用户可见反馈', snack.on === true && snack.text.length > 0, JSON.stringify(snack));
  console.log('    提示文案：' + snack.text);

  console.log('\n【7】跳转进应用');
  await evaluate(cdp, `location.href = './app.html'`);
  await sleep(2200);
  const app = await evaluate(cdp, `(() => ({
    title: document.title,
    hasShell: !!document.querySelector('.sidebar, #app, .app-shell, main'),
    bodyLen: document.body.innerText.trim().length
  }))()`);
  ok('能跳进应用首页', app.bodyLen > 40, JSON.stringify(app));
  ok('应用外壳已渲染', app.hasShell === true);

  // 控制台错误汇总
  const errs = cdp.events.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error');
  ok('无控制台错误', errs.length === 0, errs.map(e => e.params.entry.text).slice(0, 3).join(' | '));
} finally {
  if (cdp) cdp.close();
  try { proc.kill('SIGKILL'); } catch (e) {}
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

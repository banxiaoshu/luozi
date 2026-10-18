// 安装入口的兜底：保证不管什么浏览器/什么壳子，点了都有出路。
// 重点验证：
//   1) 安装区同时有「装到桌面」和「不装，直接开始用」两个入口
//   2) Chrome 里能拿到安装提示
//   3) 微信内置浏览器 → 提示「在浏览器中打开」
//   4) iPhone → 提示「添加到主屏幕」
//   5) 浏览器不给安装入口（Safari/Firefox）→ 提示换 Chrome，且旁边就是网页版入口
import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';

const BASE = 'http://127.0.0.1:8765';
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + '  [' + detail + ']'); }
}

const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_WECHAT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.44(0x18002c2b) NetType/WIFI Language/zh_CN';

const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

async function load({ ua, blockInstallPrompt } = {}) {
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: ua || '' }); // 空串 = 恢复默认
  if (blockInstallPrompt) {
    // 把 beforeinstallprompt 拦掉，模拟「浏览器压根不给安装入口」的 Safari / Firefox
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(function(){var o=window.addEventListener;window.addEventListener=function(t){if(t==='beforeinstallprompt')return;return o.apply(this,arguments);};})();`,
    });
  }
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(1500);
}

async function clickInstall() {
  await evaluate(cdp, `(() => {
    const b = document.querySelector('#install [data-install]');
    b.click();
    return true;
  })()`);
  await sleep(400);
  return evaluate(cdp, `(() => { const s = document.getElementById('snack');
    return { text: s.textContent, on: s.classList.contains('on') }; })()`);
}

console.log('\n【1】安装区有两个入口');
await load({});
const entry = await evaluate(cdp, `(() => {
  const sec = document.querySelector('#install');
  const btns = [...sec.querySelectorAll('button[data-install], a')].map(el => ({
    tag: el.tagName, text: el.textContent.trim(), href: el.getAttribute('href')
  }));
  const link = [...sec.querySelectorAll('a')].find(a => /直接开始用|不装/.test(a.textContent));
  const r = link ? link.getBoundingClientRect() : null;
  return { btns, hasDirect: !!link, href: link && link.getAttribute('href'),
    visible: r ? (r.width > 60 && r.height > 20) : false };
})()`);
ok('有「装到桌面」按钮', entry.btns.some((b) => b.tag === 'BUTTON' && /装到桌面/.test(b.text)), entry.btns.map((b) => b.tag + ':' + b.text).join(' | '));
ok('有「不装，直接开始用」入口', entry.hasDirect, entry.href);
ok('这个入口真的指向应用', entry.href === './app.html', entry.href);
ok('这个入口看得见（不是隐藏的）', entry.visible === true, String(entry.visible));

console.log('\n【2】Chrome 正常环境：给出安装提示');
const normal = await clickInstall();
ok('点按钮有可见反馈', normal.on === true, normal.text);

console.log('\n【3】微信内置浏览器');
await load({ ua: UA_WECHAT, blockInstallPrompt: true });
const wx = await clickInstall();
ok('提示里说明微信装不了', /微信/.test(wx.text), wx.text);
ok('给出「在浏览器中打开」的具体操作', /浏览器中打开/.test(wx.text), wx.text);

console.log('\n【4】iPhone Safari');
await load({ ua: UA_IPHONE, blockInstallPrompt: true });
const ios = await clickInstall();
ok('提示「添加到主屏幕」', /添加到主屏幕/.test(ios.text), ios.text);

console.log('\n【5】浏览器不给安装入口（Safari 桌面 / Firefox）');
await load({ blockInstallPrompt: true });
const plain = await clickInstall();
ok('给出换 Chrome / Edge 的提示', /Chrome/.test(plain.text), plain.text);
ok('同时提醒页面上还有网页版入口', /不装|直接开始用|已经装过/.test(plain.text), plain.text);

console.log('\n【6】「不装，直接开始用」真的能进应用');
await load({ blockInstallPrompt: true });
const startUrl = await evaluate(cdp, `location.pathname`);
const startedOnLanding = await evaluate(cdp, `!!document.querySelector('.hero .eyebrow')`);
await evaluate(cdp, `(() => {
  const a = [...document.querySelectorAll('#install a')].find(x => /直接开始用|不装/.test(x.textContent));
  a.click();
  return true;
})()`);
await sleep(1800);
const landed = await evaluate(cdp, `({
  url: location.pathname + location.hash,
  hasApp: typeof window.LZ !== 'undefined',
  shellRendered: !!document.querySelector('.sidebar, #app, .app, .shell, .view, .topbar'),
  hasWelcomeNav: !!document.querySelector('.feat')
})`);
ok('点了之后离开落地页', startedOnLanding === true && /app\.html/.test(landed.url), startUrl + ' → ' + landed.url);
ok('落在了应用页（app.html）', /app\.html/.test(landed.url), landed.url);
ok('应用外壳已渲染（不是空页）', landed.hasApp === true && landed.shellRendered === true, String(landed.hasApp));
ok('落地页的功能区块已经不在了', landed.hasWelcomeNav === false, String(landed.hasWelcomeNav));

console.log('\n【7】独立窗口（已装好的应用）打开根路径');
// CDP 的 setEmulatedMedia 改不动 display-mode，直接在页面加载前重写 matchMedia 来模拟
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(function(){
    var orig = window.matchMedia.bind(window);
    window.matchMedia = function (q) {
      if (/display-mode:\\s*standalone/.test(q)) {
        return { matches: true, media: q, onchange: null,
          addEventListener: function () {}, removeEventListener: function () {},
          addListener: function () {}, removeListener: function () {} };
      }
      return orig(q);
    };
  })();`,
});
await cdp.send('Page.navigate', { url: BASE + '/' });
await sleep(2000);
const standalone = await evaluate(cdp, `({
  path: location.pathname,
  isLanding: !!document.querySelector('.hero .eyebrow'),
  isApp: typeof window.LZ !== 'undefined'
})`);
ok('自动跳到 app.html，不拦在介绍页', /app\.html/.test(standalone.path), standalone.path);
ok('落地页内容不显示', standalone.isLanding === false, String(standalone.isLanding));
ok('应用已加载', standalone.isApp === true, String(standalone.isApp));

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
cdp.close();
proc.kill('SIGKILL');
process.exit(fail ? 1 : 0);

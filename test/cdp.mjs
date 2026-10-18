// 最小 CDP 驱动：用来在真实 Chrome 里加载页面、执行 JS、截图
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpJSON(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

export async function launch(extraArgs) {
  fs.rmSync('/tmp/cdp-profile', { recursive: true, force: true });
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-proxy-server',
    '--hide-scrollbars', '--mute-audio',
    '--window-size=1440,900',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=/tmp/cdp-profile',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--proxy-server=http://127.0.0.1:50685',
    '--proxy-bypass-list=127.0.0.1;localhost',
    'about:blank'
  ];
  if (Array.isArray(extraArgs)) args.unshift(...extraArgs);
  const proc = spawn(CHROME, args, { stdio: 'ignore', detached: false });

  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try { await httpJSON('/json/version'); return proc; } catch (e) {}
  }
  throw new Error('Chrome 未能启动');
}

export async function newPage(url) {
  // PUT /json/new
  const info = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/json/new?' + encodeURIComponent(url), method: 'PUT' },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject);
    req.end();
  });
  return info;
}

export function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const events = [];

    ws.addEventListener('open', () => {
      resolve({
        send(method, params) {
          const mid = ++id;
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
          return new Promise((res, rej) => pending.set(mid, { res, rej }));
        },
        events,
        close() { try { ws.close(); } catch (e) {} }
      });
    });
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
        else p.res(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    });
    ws.addEventListener('error', reject);
  });
}

export async function evaluate(cdp, expr, awaitPromise = true) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise, includeCommandLineAPI: true
  });
  if (r.exceptionDetails) {
    throw new Error('JS 异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

export async function screenshot(cdp, path) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path, Buffer.from(r.data, 'base64'));
  return path;
}

export { sleep };

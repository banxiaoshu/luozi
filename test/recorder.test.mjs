// 录音面板回归：暂停要真的停（计时和波形都不能再走），以及能传已有音频文件
import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';

const BASE = process.env.LUOZI_URL || 'http://127.0.0.1:8765/app.html';
const WAV = decodeURIComponent(new URL('./fixtures/tone.wav', import.meta.url).pathname);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('DOM.enable');
await cdp.send('Page.navigate', { url: BASE });
await sleep(2600);

await evaluate(cdp, `(function(){
  document.querySelectorAll('[data-act="close-sheet"]').forEach(b=>b.click());
  localStorage.setItem('lz_onboard','1'); return 1; })()`);
await sleep(400);

console.log('\n【1】录音、暂停、继续');
await evaluate(cdp, `(function(){ LZ.openRecorder(); return 1; })()`);
await sleep(500);

ok('面板打开了', await evaluate(cdp, `!!document.querySelector('#rec-pause')`));
ok('面板上有「传已有录音」入口', await evaluate(cdp, `!!document.querySelector('#rec-pick')`));

await evaluate(cdp, `window.__recT0 = Date.now(); document.querySelector('#rec-toggle').click()`);
// getUserMedia 起设备要一点时间，等计时真的开走再断言
let started = null;
for (let i = 0; i < 14; i++) {
  await sleep(400);
  started = await evaluate(cdp, `({
    time: document.querySelector('#rec-time').textContent,
    status: document.querySelector('#rec-status').textContent.trim(),
    state: (LZ && window.S && 0) || document.querySelector('#rec-toggle').textContent
  })`);
  if (/0*[1-9]/.test(started.time)) break;
}
ok('录起来了', /0*[1-9]/.test(started.time), started.time);
ok('状态显示录音中', /录音中/.test(started.status), started.status);

await evaluate(cdp, `document.querySelector('#rec-pause').click()`);
await sleep(300);

const paused1 = await evaluate(cdp, `({
  time: document.querySelector('#rec-time').textContent,
  status: document.querySelector('#rec-status').textContent.trim(),
  btn: document.querySelector('#rec-pause').textContent,
  wave: Array.from(document.querySelectorAll('#rec-wave i')).map(i=>i.style.height).join(',')
})`);
ok('按钮变成「继续」', paused1.btn === '继续', paused1.btn);
ok('状态显示已暂停', /已暂停/.test(paused1.status), paused1.status);

await sleep(2200);
const paused2 = await evaluate(cdp, `({
  time: document.querySelector('#rec-time').textContent,
  wave: Array.from(document.querySelectorAll('#rec-wave i')).map(i=>i.style.height).join(',')
})`);
ok('暂停后计时不再走', paused1.time === paused2.time, paused1.time + ' → ' + paused2.time);
ok('暂停后波形不再跳', paused1.wave === paused2.wave);

await evaluate(cdp, `document.querySelector('#rec-pause').click()`);
await sleep(1600);
const resumed = await evaluate(cdp, `({
  time: document.querySelector('#rec-time').textContent,
  status: document.querySelector('#rec-status').textContent.trim()
})`);
ok('继续后计时接着走', resumed.time !== paused2.time, paused2.time + ' → ' + resumed.time);
ok('继续后状态回到录音中', /录音中/.test(resumed.status), resumed.status);

console.log('\n【2】停止并保存');
await evaluate(cdp, `document.querySelector('#rec-toggle').click()`);
await sleep(2000);
const afterStop = await evaluate(cdp, `(async () => {
  const assets = await DB.all('assets');
  const aud = assets.filter(a => a.kind === 'audio');
  return { total: assets.length, audio: aud.length, name: aud[0] && aud[0].name,
           dur: aud[0] && aud[0].duration, wall: Math.round((Date.now() - window.__recT0) / 1000),
           sheetOpen: document.querySelector('#sheet-mask').classList.contains('open') };
})()`);
ok('存成了一条音频附件', afterStop.audio === 1, afterStop.name);
ok('时长不是 0', afterStop.dur > 0, afterStop.dur);
ok('暂停的 2 秒没算进时长', afterStop.dur <= afterStop.wall - 1,
   { dur: afterStop.dur, wall: afterStop.wall });

console.log('\n【3】上传已有的录音文件');
await evaluate(cdp, `(function(){ LZ.openRecorder(); return 1; })()`);
await sleep(500);
const { root } = await cdp.send('DOM.getDocument');
const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#rec-file' });
ok('找到文件输入框', nodeId > 0, nodeId);
await cdp.send('DOM.setFileInputFiles', { files: [WAV], nodeId });
await sleep(2500);

const afterUpload = await evaluate(cdp, `(async () => {
  const assets = await DB.all('assets');
  const aud = assets.filter(a => a.kind === 'audio');
  const last = aud[aud.length - 1];
  return { audio: aud.length, dur: last && last.duration, size: last && last.size,
           mime: last && last.mime, name: last && last.name, all: aud.map(a => ({ n: a.name, s: a.size, d: a.duration })),
           err: document.documentElement.getAttribute('data-err') || '' };
})()`);
ok('多了一条音频附件', afterUpload.audio === 2, afterUpload.audio);
ok('读到了时长（2 秒）', afterUpload.dur === 2, afterUpload.dur);
ok('体积和源文件一致', afterUpload.size === 32044, afterUpload.size);
ok('整轮没有运行时异常', afterUpload.err === '', afterUpload.err);

cdp.close();
proc.kill('SIGKILL');
console.log('\n通过 ' + pass + ' / ' + (pass + fail));
if (fail) process.exitCode = 2;

// 诊断：headless 下录音到底有没有电平
import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';

const BASE = process.env.LUOZI_URL || 'http://127.0.0.1:8765/app.html';
const proc = await launch(['--use-file-for-fake-audio-capture=/tmp/speech.wav']);
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.navigate', { url: BASE });
await sleep(2400);

const r = await evaluate(cdp, `(async function(){
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const before = ctx.state;
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch(e) {} }
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  src.connect(an);

  const bufF = new Uint8Array(an.frequencyBinCount);
  const bufT = new Uint8Array(an.fftSize);
  const samples = [];
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 150));
    an.getByteFrequencyData(bufF);
    an.getByteTimeDomainData(bufT);
    let sf = 0; for (let k = 0; k < bufF.length; k++) sf += bufF[k];
    let maxDev = 0; for (let k = 0; k < bufT.length; k++) maxDev = Math.max(maxDev, Math.abs(bufT[k] - 128));
    samples.push({ freq: +(sf / bufF.length / 255).toFixed(4), maxDev });
  }

  // 录 1.5 秒看有没有数据
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.start(500);
  await new Promise(r => setTimeout(r, 1600));
  const blob = await new Promise(res => { rec.onstop = () => res(new Blob(chunks, { type: rec.mimeType })); rec.stop(); });

  const track = stream.getAudioTracks()[0];
  return {
    stateBefore: before, stateAfter: ctx.state, sampleRate: ctx.sampleRate,
    trackLabel: track && track.label, trackEnabled: track && track.enabled,
    samples, blobSize: blob.size, mime: rec.mimeType
  };
})()`);
console.log(JSON.stringify(r, null, 2));
try { proc.kill(); } catch (e) {}

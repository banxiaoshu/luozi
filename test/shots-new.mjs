// 截新功能的界面：不懂清单、高亮、课件卡片、导入过程
import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8765';
const OUT = '/tmp/luozi-diag';
fs.mkdirSync(OUT, { recursive: true });

const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });
await cdp.send('Page.navigate', { url: BASE + '/app.html' });
await sleep(2800);

await evaluate(cdp, `(function(){
  document.querySelectorAll('[data-act="close-sheet"]').forEach(b=>b.click());
  localStorage.setItem('lz_onboard','1');
  return 1; })()`);

// 造点数据
await evaluate(cdp, `(async function(){
  const notes = await DB.all('notes');
  for (const n of notes) await LZ.deleteNote(n.id);

  await LZ.createNote({ title: '夹逼准则', kind: 'note', body:
    '## 夹逼准则\\n\\n' +
    '设 $a_n \\\\le b_n \\\\le c_n$，若两端极限相等，则中间的极限也等于它。\\n\\n' +
    '### 老师带口音的地方\\n\\n' +
    '老师说「数劣」，黑板上写的是「数列」。==先记音，下课再对字形==。\\n\\n' +
    '### 做题步骤\\n\\n' +
    '1. 把中间那项夹在两个好算的式子之间\\n' +
    '2. 分别求两端极限\\n' +
    '3. 相等就直接写答案\\n\\n' +
    '==两端极限不相等的时候该怎么办？== 这里没听懂。\\n\\n' +
    '例题见 [[重要极限]]' });

  await LZ.createNote({ title: '数列的极限', kind: 'note', body:
    '## 定义\\n\\n$\\\\forall \\\\varepsilon > 0$，$\\\\exists N$，当 $n > N$ 时 $|a_n - a| < \\\\varepsilon$。\\n\\n' +
    '==为什么要先给 ε 再找 N，顺序反了会怎样==？' });

  await LZ.createNote({ title: '重要极限', kind: 'note', body:
    '## 两个重要极限\\n\\n$\\\\lim_{x\\\\to 0} \\\\frac{\\\\sin x}{x} = 1$' });

  await LZ.refresh();
  return (await DB.all('notes')).length;
})()`);

// 标两篇不懂
await evaluate(cdp, `(async function(){
  const notes = await DB.all('notes');
  for (const t of ['夹逼准则', '数列的极限']) {
    const n = notes.filter(x => x.title === t)[0];
    n.flag = 'unknown'; n.flagAt = new Date().toISOString();
    await DB.put('notes', n);
  }
  await LZ.refresh();
  return 1;
})()`);

async function shot(hash, name, wait) {
  await evaluate(cdp, `(function(){ LZ.go(${JSON.stringify(hash)}); return 1; })()`);
  await sleep(wait || 800);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log('  📷', name);
}

await shot('/unknown', 'n-unknown');
const id = await evaluate(cdp, `(async function(){
  const n = (await DB.all('notes')).filter(x => x.title === '夹逼准则')[0]; return n.id; })()`);
await shot('/note/' + id, 'n-editor-mark');

// 导入 PPT 的过程
await evaluate(cdp, `(async function(){
  const buf = await (await fetch('test/fixtures/sample.pptx')).arrayBuffer();
  const file = new File([buf], '第一章 极限与连续.pptx', { type:'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
  LZ.runDocImport(file);
  return 1;
})()`);
await sleep(700);
{
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/n-importing.png`, Buffer.from(r.data, 'base64'));
  console.log('  📷 n-importing');
}
await sleep(2200);
{
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/n-doc-note.png`, Buffer.from(r.data, 'base64'));
  console.log('  📷 n-doc-note');
}

await shot('/today', 'n-today');

cdp.close(); proc.kill('SIGKILL');
console.log('done');

// 扫描版 PDF 的兜底路径：没文字层 → 渲染成图 → 本机 OCR
import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';

const BASE = 'http://127.0.0.1:8765';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : ''))); };

const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.navigate', { url: BASE + '/app.html' });
await sleep(2800);
await evaluate(cdp, `(function(){ document.querySelectorAll('[data-act="close-sheet"]').forEach(b=>b.click()); localStorage.setItem('lz_onboard','1'); return 1; })()`);

// 1. 先确认这份 PDF 确实没有文字层
const probe = await evaluate(cdp, `(async function(){
  const buf = await (await fetch('test/fixtures/scanned.pdf')).arrayBuffer();
  const file = new File([buf], '扫描讲义.pdf', { type: 'application/pdf' });
  const doc = await Docs.readPdf(file);
  return { pages: doc.count, chars: doc.chars };
})()`);
ok('扫描件抽出的字数接近 0', probe.chars < 20, JSON.stringify(probe));
ok('但页数是对的', probe.pages >= 1, String(probe.pages));

// 2. 走导入流程，应该弹出「这是扫描件」的提示而不是生成空笔记
const flow = await evaluate(cdp, `(async function(){
  const before = (await DB.all('notes')).length;
  const buf = await (await fetch('test/fixtures/scanned.pdf')).arrayBuffer();
  const file = new File([buf], '扫描讲义.pdf', { type: 'application/pdf' });
  await LZ.runDocImport(file);
  await new Promise(r => setTimeout(r, 800));
  const sheet = document.querySelector('#sheet');
  const after = (await DB.all('notes')).length;
  return { before, after, text: sheet ? sheet.innerText.replace(/\\s+/g, ' ') : '',
           hasOcrBtn: !!document.querySelector('#doc-ocr-run') };
})()`);
ok('没有直接生成一篇空笔记', flow.after === flow.before, JSON.stringify({ before: flow.before, after: flow.after }));
ok('弹出「这是扫描件」的提示', /扫描件/.test(flow.text), flow.text.slice(0, 80));
ok('给了 OCR 按钮', flow.hasOcrBtn === true);

// 3. 真跑一次 OCR（只 1 页，别等太久）
const ocr = await evaluate(cdp, `(async function(){
  const t0 = Date.now();
  const buf = await (await fetch('test/fixtures/scanned.pdf')).arrayBuffer();
  const file = new File([buf], '扫描讲义.pdf', { type: 'application/pdf' });
  const imgs = await Docs.pdfPagesToBlobs(file, 1);
  const render = Date.now() - t0;
  if (!imgs.length) return { err: '没有渲染出页面' };
  const text = await Media.OCR.recognize(imgs[0].blob);
  return { render, bytes: imgs[0].blob.size, text: String(text || '').slice(0, 120), len: (text || '').length };
})()`);
ok('能把 PDF 页渲染成图片', ocr.bytes > 20000, JSON.stringify({ bytes: ocr.bytes, render: ocr.render }));
ok('OCR 认出了文字', ocr.len > 5, JSON.stringify(ocr).slice(0, 200));
console.log('    OCR 结果片段：' + (ocr.text || '').replace(/\n/g, ' / '));

cdp.close();
try { proc.kill('SIGKILL'); } catch (e) {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

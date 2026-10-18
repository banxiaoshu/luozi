// 课件导入的单元测试：自己拼一个 zip（store + deflate 两种），再走 Docs 的解析
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Docs = require('../docs.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* ---------- 手搓一个 zip ---------- */
function buildZip(files, opts) {
  const o = opts || {};
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const raw = enc.encode(String(text));
    const method = o.deflate ? 8 : 0;
    const body = method === 8 ? new Uint8Array(zlib.deflateRawSync(Buffer.from(raw))) : raw;

    const lh = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, method, true);
    dv.setUint32(14, 0, true);
    dv.setUint32(18, body.length, true);
    dv.setUint32(22, raw.length, true);
    dv.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);
    locals.push(lh, body);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, 0, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    centrals.push(ch);

    offset += lh.length + body.length;
  }

  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const all = [...locals, ...centrals, eocd];
  const total = all.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out.buffer;
}

function fakeFile(name, buf) {
  return { name, size: buf.byteLength, arrayBuffer: async () => buf };
}

/* ---------- 造一份 pptx ---------- */
const slide = (title, body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<a:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p>` +
  body.map((b) => `<a:p><a:r><a:t>${b}</a:t></a:r></a:p>`).join('') +
  `</a:txBody></p:sld>`;

const files = {
  '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
  'ppt/presentation.xml': '<p:presentation/>',
  'ppt/slides/slide1.xml': slide('第一章 极限与连续', ['数列的极限', '夹逼准则', '单调有界必有极限']),
  'ppt/slides/slide2.xml': slide('夹逼准则', ['a<sub>n</sub> ≤ b<sub>n</sub> ≤ c<sub>n</sub>', '两头的界要先找出来']),
  'ppt/slides/slide10.xml': slide('第十张：特殊提到', ['排序要按数字，不是按字母'])
};

console.log('\n【1】zip 解包');
{
  const storeBuf = buildZip(files, { deflate: false });
  const defBuf = buildZip(files, { deflate: true });

  const a = await Docs.unzip(storeBuf);
  ok('store 模式能解开全部条目', Object.keys(a).length === 5, String(Object.keys(a).length));
  const b = await Docs.unzip(defBuf);
  ok('deflate 模式能解开全部条目', Object.keys(b).length === 5, String(Object.keys(b).length));

  const text = new TextDecoder().decode(b['ppt/slides/slide1.xml']);
  ok('解压后内容正确', text.includes('夹逼准则'), text.slice(0, 60));

  const only = await Docs.unzip(defBuf, (n) => /^ppt\/slides\//.test(n));
  ok('wanted 过滤只解要的条目', Object.keys(only).length === 3, JSON.stringify(Object.keys(only)));

  let threw = false;
  try { await Docs.unzip(new TextEncoder().encode('not a zip').buffer); } catch (e) { threw = true; }
  ok('非 zip 文件会报错', threw);
}

console.log('\n【2】pptx 解析');
{
  const f = fakeFile('第一章.pptx', buildZip(files, { deflate: true }));
  const doc = await Docs.readPptx(f);
  ok('识别出 3 张幻灯片', doc.count === 3, String(doc.count));
  ok('按幻灯片编号排序（不是字符串排序）',
    doc.slides.map((s) => s.no).join(',') === '1,2,10',
    doc.slides.map((s) => s.no).join(','));
  ok('第一张标题正确', doc.slides[0].title === '第一章 极限与连续', doc.slides[0].title);
  ok('正文按段落拆开', doc.slides[0].lines.length === 3, JSON.stringify(doc.slides[0].lines));

  const md = Docs.toMarkdown(doc, { fileName: '第一章.pptx', when: '2026-10-18' });
  ok('生成的 Markdown 有标题', md.startsWith('# 第一章'), md.slice(0, 20));
  ok('每张幻灯片是一个二级标题', (md.match(/^## 第 \d+ 张/gm) || []).length === 3, String((md.match(/^## /gm) || []).length));
  ok('短行排成列表', md.includes('- 数列的极限'), md.split('\n').slice(6, 10).join(' | '));
  ok('导出来源与张数', md.includes('从「第一章.pptx」导入') && md.includes('3 张幻灯片'));
}

console.log('\n【3】格式判断');
{
  ok('.pptx 支持', Docs.supported({ name: 'a.pptx' }));
  ok('.pdf 支持', Docs.supported({ name: 'a.PDF' }));
  ok('.ppt 不支持', !Docs.supported({ name: 'a.ppt' }));
  ok('.docx 不支持', !Docs.supported({ name: 'a.docx' }));

  let msg = '';
  try { await Docs.parse({ name: '旧格式.ppt', arrayBuffer: async () => new ArrayBuffer(0) }); }
  catch (e) { msg = e.message; }
  ok('旧格式给出明确提示', /另存为 \.pptx 或 \.pdf/.test(msg), msg);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

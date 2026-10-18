// 验证「图片取字」这条真实使用路径：挂图 → 点取字 → 文字并进笔记正文
import { launch, newPage, connect, evaluate, screenshot, sleep } from './cdp.mjs';
const BASE = process.env.LUOZI_URL || 'http://127.0.0.1:8765/app.html';
const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: BASE });
await sleep(2400);
await evaluate(cdp, `(function(){ document.querySelectorAll('[data-act="close-sheet"]').forEach(b=>b.click()); return 1; })()`);

const setup = await evaluate(cdp, `(async function(){
  // 造一张「板书」图：带公式的板书文字
  const c = document.createElement('canvas'); c.width = 1100; c.height = 700;
  const g = c.getContext('2d');
  g.fillStyle = '#123'; g.fillRect(0,0,1100,700);
  g.fillStyle = '#eafff6'; g.font = 'bold 52px "PingFang SC","Heiti SC",sans-serif';
  g.fillText('第三节 洛必达法则', 60, 110);
  g.font = '40px "PingFang SC","Heiti SC",sans-serif';
  g.fillText('适用条件', 60, 210);
  g.fillText('一是零比零型 二是无穷比无穷型', 60, 280);
  g.fillText('求导之后极限存在才能用', 60, 350);
  g.fillText('例 求极限 上下同时求导', 60, 420);
  g.fillText('答案等于三分之一', 60, 490);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));

  const note = await LZ.createNote({ title: '第7周 高等数学 · 洛必达', kind: 'note', body: '' });
  const asset = await LZ.addAsset(note.id, blob, 'image', { name: '板书-洛必达.png', mime: 'image/png' });
  LZ.go('/note/' + note.id);
  await new Promise(r => setTimeout(r, 900));
  return { noteId: note.id, assetId: asset.id, hasBtn: !!document.querySelector('[data-act="ocr-asset"]') };
})()`);
console.log('· 挂图 =', setup);

// 点「取字」
await evaluate(cdp, `(function(){ document.querySelector('[data-act="ocr-asset"]').click(); return 1; })()`);
await sleep(500);
await screenshot(cdp, '/tmp/s-ocr-running.png');

// 等识别完成（最多 60 秒）
let state = null;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  state = await evaluate(cdp, `(function(){
    const st = document.querySelector('#ocr-status');
    const btn = document.querySelector('#ocr-append');
    return {
      status: st ? st.textContent : null,
      text: (document.querySelector('#ocr-text')||{}).textContent || '',
      canAppend: btn ? !btn.disabled : false
    };
  })()`);
  if (state.canAppend) break;
}
console.log('· 识别状态 =', JSON.stringify({ status: state.status, canAppend: state.canAppend }));
console.log('· 识别文字 =', JSON.stringify(state.text));
await screenshot(cdp, '/tmp/s-ocr-done.png');

// 追加到笔记
const done = await evaluate(cdp, `(async function(){
  const btn = document.querySelector('#ocr-append');
  if (!btn || btn.disabled) return { ok:false };
  btn.click();
  await new Promise(r => setTimeout(r, 1200));
  const notes = await DB.all('notes');
  const n = notes.filter(x => x.title === '第7周 高等数学 · 洛必达')[0];
  return { ok:true, hasText: (n.body||'').indexOf('洛必达') > -1, bodyLen: (n.body||'').length, body: (n.body||'').slice(0,120) };
})()`);
console.log('· 追加结果 =', JSON.stringify(done));
await screenshot(cdp, '/tmp/s-ocr-note.png');
try { proc.kill(); } catch (e) {}

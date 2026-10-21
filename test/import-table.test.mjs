// 从教务系统复制课表表格 → 粘贴 → 解析 → 导入
import { launch, newPage, connect, evaluate, sleep } from './cdp.mjs';

const BASE = process.env.LUOZI_URL || 'http://127.0.0.1:8765/app.html';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

// 仿教务系统导出的表格：有表头、有 rowspan、单元格里课程名和节次连在一起
const TABLE = `<table border="1">
<tr><td>节次</td><td>星期一</td><td>星期二</td><td>星期三</td><td>星期四</td><td>星期五</td></tr>
<tr><td>1-2</td>
  <td rowspan="1">政治经济学★ (1-2节)4-12周/校区:临沂校区/场地:弘文楼北（N216）/教师:刘敏</td>
  <td>高等数学B上★ (1-2节)4-16周/校区:临沂校区/场地:知源楼西(W204)/教师:冯宝成</td>
  <td>经济法★ (1-2节)4-16周/场地:弘文楼北(N203)/教师:居珊</td>
  <td>大学英语I★ (1-2节)4-19周/场地:敏行楼北(N305)/教师:张艳艳</td>
  <td>大学生心理健康★ (1-2节)4-11周/场地:知源楼西(W102)/教师:荣华</td>
</tr>
<tr><td rowspan="2">3-4</td>
  <td>军事理论课★ (3-4节)4-12周/场地:知源楼西(W204)/教师:孙泽正</td>
  <td>中国近现代史纲要★ (3-4节)4-16周(双)/场地:知源楼西(W306)/教师:周小军</td>
  <td>人工智能基础与应用◇ (3-4节)4-11周/场地:知新楼北（N321）/教师:杨莉国</td>
  <td>形势与政策1 (3-4节)15-17周/场地:知源楼西(W308)</td>
  <td>经济法★ (3-4节)14-16周/场地:弘文楼北(N102)/教师:居珊</td>
</tr>
</table>`;

const proc = await launch();
const page = await newPage('about:blank');
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.navigate', { url: BASE });
await sleep(2600);

await evaluate(cdp, `(function(){
  document.querySelectorAll('[data-act="close-sheet"]').forEach(b=>b.click());
  localStorage.setItem('lz_onboard','1'); LZ.go('/schedule'); return 1; })()`);
await sleep(700);

console.log('\n【1】表格转坐标');
const layout = await evaluate(cdp, `(function(){
  const l = Docs.tableToLayout(${JSON.stringify(TABLE)});
  if (!l) return null;
  return { pages: l.pages.length, items: l.pages[0].items.length,
           heads: l.pages[0].items.filter(i => /^星期/.test(i.text)).map(i => i.text + '@' + i.x) };
})()`);
ok('识别出了表格', layout && layout.pages === 1, layout && layout.pages);
ok('找到 5 个星期列', layout && layout.heads.length === 5, layout && layout.heads.join(' '));

console.log('\n【2】解析成课程');
const parsed = await evaluate(cdp, `(function(){
  const l = Docs.tableToLayout(${JSON.stringify(TABLE)});
  const p = Core.Timetable.parseGrid(l.pages);
  return { n: p.events.length, errors: p.errors,
           list: p.events.map(e => Core.U.weekdayName(e.weekday) + ' ' + e.start + ' ' + e.name + ' @' + e.room + ' ' + e.weeksFrom + '-' + e.weeksTo) };
})()`);
ok('解析出 10 门课', parsed.n === 10, parsed.n);
ok('没有报错', parsed.errors.length === 0, parsed.errors);
ok('星期按列对上（周一是政治经济学）', /周一 08:00 政治经济学/.test(parsed.list.join('|')), parsed.list[0]);
ok('周二那门是高等数学', /周二 08:00 高等数学B上/.test(parsed.list.join('|')));
ok('带括号的教室没被截断', parsed.list.join('|').indexOf('弘文楼北(N216)') > -1);

console.log('\n【3】粘贴 → 预览 → 导入');
await evaluate(cdp, `(function(){
  const b = document.querySelector('[data-act="open-import"]'); if (b) b.click(); return 1; })()`);
await sleep(600);

const pasted = await evaluate(cdp, `(function(){
  const ta = document.querySelector('#import-text');
  const dt = new DataTransfer();
  dt.setData('text/html', ${JSON.stringify(TABLE)});
  dt.setData('text/plain', '节次 星期一 星期二 星期三 星期四 星期五');
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: dt });
  ta.dispatchEvent(ev);
  return {
    preview: (document.querySelector('#import-preview')||{}).textContent || '',
    okBtn: !document.querySelector('#btn-import-ok').disabled
  };
})()`);
ok('粘贴后面板直接给出预览', /解析出 10 节/.test(pasted.preview), pasted.preview.slice(0, 40));
ok('「确认导入」可用', pasted.okBtn);

// 再点一次「先解析看看」，不能把表格结果冲掉
await evaluate(cdp, `document.querySelector('#btn-parse').click()`);
await sleep(400);
const again = await evaluate(cdp, `(document.querySelector('#import-preview')||{}).textContent || ''`);
ok('点「先解析看看」不会把结果冲掉', /解析出 10 节/.test(again));

await evaluate(cdp, `document.querySelector('#btn-import-ok').click()`);
await sleep(1800);
const db = await evaluate(cdp, `(async () => {
  const evs = await DB.all('events');
  const cs = await DB.all('courses');
  return { events: evs.length, courses: cs.length,
           err: document.documentElement.getAttribute('data-err') || '' };
})()`);
ok('导入进库了（10 节课 / 9 门课，经济法出现两次）', db.events === 10 && db.courses === 9, db);
ok('没有运行时异常', db.err === '', db.err);

console.log('\n【4】普通文字粘贴不受影响');
const plain = await evaluate(cdp, `(function(){
  const ta = document.querySelector('#import-text');
  if (!document.querySelector('#import-text')) return 'closed';
  const dt = new DataTransfer();
  dt.setData('text/plain', '周一 第1-2节 高等数学 4-16周 知源楼W204');
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: dt });
  ta.dispatchEvent(ev);
  return ta.value;
})()`);
ok('没有表格时走原来的粘贴', plain === 'closed' || /高等数学/.test(plain), plain);

cdp.close();
proc.kill('SIGKILL');
console.log('\n通过 ' + pass + ' / ' + (pass + fail));
if (fail) process.exitCode = 2;

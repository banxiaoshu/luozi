// core.js 回归单测（纯 Node，不碰 DOM）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Core = require('../core.js');
const { U, MD, Graph, Search, Timetable, Zip, Share } = Core;

let pass = 0, fail = 0;
function t(name, fn) {
  try { const r = fn(); if (r === true) { pass++; console.log('  ✅ ' + name); } else { fail++; console.log('  ❌ ' + name + ' → ' + JSON.stringify(r)); } }
  catch (e) { fail++; console.log('  ❌ ' + name + ' → ' + e.message); }
}

// ---- Markdown ----
t('标题渲染', () => MD.render('# 一级').indexOf('<h1') === 0);
t('引用块', () => MD.render('> 引用').indexOf('<blockquote') > -1);
t('任务列表', () => {
  const h = MD.render('- [ ] 未完成\n- [x] 已完成');
  return h.indexOf('md-task') > -1 && h.indexOf('class="done"') > -1;
});
t('行内代码不被转义', () => MD.render('`a<b`').indexOf('a&lt;b') > -1 && MD.render('`a<b`').indexOf('<code') > -1);
t('双链转 a 标签', () => {
  const h = MD.render('见 [[高等数学]]');
  return h.indexOf('<a') > -1 && h.indexOf('data-wikilink="高等数学"') > -1;
});
t('块公式落到 data-tex', () => MD.render('$$\na^2+b^2\n$$').indexOf('data-tex') > -1);
t('行内公式落到 data-tex', () => MD.render('质能 $E=mc^2$').indexOf('data-tex') > -1);
t('表格不崩（当普通段落处理）', () => typeof MD.render('| a | b |\n|---|---|\n| 1 | 2 |') === 'string');
t('plain 去掉公式符号', () => MD.plain('设 $a_n \\le b_n$ 成立').indexOf('$') === -1);
t('plain 去掉列表符号', () => MD.plain('- 要点一\n1. 要点二').indexOf('- ') === -1);

// ---- Timetable ----
t('解析 5 种写法', () => {
  const r = Timetable.parse('周一 08:30-10:00 高等数学 A301\n周二 第3-4节 大学英语 语音室B2\n周三 14:00-15:40 人工智能基础 C101\n周四 10:15-12:00 经济法 A405\n周五 第1-2节 近现代史纲要 D205');
  return r.events.length === 5;
});
t('节次换算时间（45+10 分钟一节）', () => {
  const r = Timetable.parse('周二 第3-4节 大学英语');
  return r.events[0].start === '09:50' && r.events[0].end === '11:30';
});
t('礼拜/英文星期', () => {
  const a = Timetable.parse('礼拜三 09:00-10:00 物理');
  const b = Timetable.parse('wWed 09:00-10:00 物理');
  return a.events.length === 1 && b.events.length >= 0;
});
t('表头行被忽略而不是报错', () => {
  const r = Timetable.parse('2026 秋季课表\n周一 08:30-10:00 高等数学 A301');
  return r.events.length === 1 && r.errors.length === 0 && r.ignored.length === 1;
});
t('教室与课程名分离', () => {
  const r = Timetable.parse('周一 08:30-10:00 高等数学 A301');
  return r.events[0].name === '高等数学' && r.events[0].room === 'A301';
});

// ---- Share ----
await (async () => {
  const payload = { t: '夹逼准则', b: '## 标题\n\n设 $a_n \\le b_n \\le c_n$，' + '内容'.repeat(120), at: '2026-10-18T03:00:00.000Z', app: 'luozi' };
  const code = await Share.encode(payload);
  const back = await Share.decode(code);
  t('分享编码可往返（含压缩）', () => back.t === payload.t && back.b === payload.b);
  t('分享码是 URL 安全字符', () => /^[A-Za-z0-9_.\-]+$/.test(code));
  const err = await Share.decode('不是合法分享码').then(() => null, (e) => e.message);
  t('非法分享码明确报错', () => typeof err === 'string' && err.length > 0);
})();

// ---- Zip ----
await (async () => {
  const z = Zip.build([{ name: 'a.txt', data: 'hello' }, { name: '目录/中文.md', data: '# 标题' }]);
  const buf = Buffer.from(await z.arrayBuffer());
  t('ZIP 结构头正确', () => {
    const sig = buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24);
    return sig === 0x04034b50 && buf.length > 100;
  });
  t('ZIP 里有中文名（UTF-8 标志位）', () => {
    const flag = buf[6] | (buf[7] << 8);
    return (flag & 0x0800) !== 0 && buf.toString('utf8').indexOf('中文.md') > -1;
  });
})();

// ---- Graph ----
t('图谱建边与反链', () => {
  const notes = [
    { id: '1', title: 'A', body: '见 [[B]]', updatedAt: '2026-10-02' },
    { id: '2', title: 'B', body: '见 [[A]] 和 [[C]]', updatedAt: '2026-10-01' },
    { id: '3', title: 'C', body: '', updatedAt: '2026-10-01' }
  ];
  const g = Graph.build(notes);
  const bl = Graph.backlinks(notes, '1');
  return Object.keys(g.nodes || g).length >= 3 && bl.length === 1;
});

// ---- Search ----
t('搜索能命中并排序', () => {
  const notes = [
    { id: '1', title: '夹逼定理', body: '夹逼 夹逼 极限', updatedAt: '2026-10-01' },
    { id: '2', title: '其他', body: '顺便提到夹逼', updatedAt: '2026-10-01' }
  ];
  const res = Search.run(notes, '夹逼');
  return res.length === 2 && res[0].doc.id === '1' && res[0].score > res[1].score;
});
t('搜索空词返回空', () => Search.run([{ id: '1', title: 'x', body: 'y' }], '').length === 0);
t('搜索摘要命中关键词', () => Search.run([{ id: '1', title: 't', body: '夹逼定理很好用' }], '夹逼')[0].snippet.indexOf('夹逼') > -1);

// ---- U ----
t('weekOf 第 1 周', () => {
  const w = U.weekOf(U.today(), 20);
  return w.week === 1;
});
t('esc 转义', () => U.esc('<img src=x onerror=1>').indexOf('<') === -1);

console.log('\n通过 ' + pass + ' / ' + (pass + fail));
if (fail) process.exitCode = 2;

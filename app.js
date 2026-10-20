/* ============================================================
   落字 · 应用主逻辑
   路由 / 视图 / 数据流 / 交互
   ============================================================ */
(function () {
  'use strict';

  const U = Core.U;
  const MD = Core.MD;
  const Search = Core.Search;
  const Timetable = Core.Timetable;
  const Zip = Core.Zip;
  const Share = Core.Share;
  const Graph = Core.Graph;
  const MathRender = Core.MathRender;

  /* ================= 全局状态 ================= */
  const S = {
    route: 'today',
    params: {},
    notes: [],
    courses: [],
    events: [],
    assets: [],
    transcripts: [],
    settings: {},
    search: '',
    rec: null,
    asr: null,
    currentNote: null,
    dirty: false,
    saveTimer: null
  };

  const urlCache = new Map();
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  /* ================= 基础 UI ================= */
  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isErr ? 3600 : 2200);
  }

  function openSheet(html, wide) {
    const sheet = $('#sheet');
    sheet.className = 'sheet' + (wide ? ' wide' : '');
    sheet.innerHTML = html;
    $('#sheet-mask').classList.add('open');
  }
  function closeSheet() {
    $('#sheet-mask').classList.remove('open');
    $('#sheet').innerHTML = '';
  }

  function confirmSheet(title, desc, okText, onOk) {
    openSheet(
      '<div class="sheet-h"><h3>' + U.esc(title) + '</h3><div class="sp"></div>' +
      '<button class="x-btn" data-act="close-sheet">×</button></div>' +
      '<p class="sheet-sub">' + U.esc(desc) + '</p>' +
      '<div class="sheet-foot"><button class="btn" data-act="close-sheet">取消</button>' +
      '<button class="btn btn-danger" id="confirm-ok">' + U.esc(okText || '确定') + '</button></div>'
    );
    $('#confirm-ok').onclick = function () { closeSheet(); onOk(); };
  }

  /* ================= 资产 URL ================= */
  async function assetURL(id) {
    if (urlCache.has(id)) return urlCache.get(id);
    const row = await DB.get('blobs', id);
    if (!row || !row.data) return '';
    const url = URL.createObjectURL(row.data);
    urlCache.set(id, url);
    return url;
  }
  function revokeAll() {
    urlCache.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) {} });
    urlCache.clear();
  }

  /* ================= 数据加载 ================= */
  async function refresh() {
    const [notes, courses, events, assets, transcripts] = await Promise.all([
      DB.all('notes'), DB.all('courses'), DB.all('events'), DB.all('assets'), DB.all('transcripts')
    ]);
    S.notes = notes.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    S.courses = courses;
    S.events = events;
    S.assets = assets.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    S.transcripts = transcripts;
    updateBadges();
  }

  function updateBadges() {
    const inbox = S.notes.filter((n) => n.kind === 'capture').length;
    const bi = $('#badge-inbox');
    bi.textContent = inbox; bi.hidden = inbox === 0;

    const unknown = S.notes.filter((n) => n.flag === 'unknown').length;
    const bu = $('#badge-unknown');
    if (bu) { bu.textContent = unknown; bu.hidden = unknown === 0; }
    // 手机端底部导航也有一个不懂清单入口，角标要同步
    const bum = $('#badge-unknown-m');
    if (bum) { bum.textContent = unknown; bum.hidden = unknown === 0; }

    const today = Timetable.forDay(S.events, S.courses, U.weekdayNow());
    const bt = $('#badge-today');
    bt.textContent = today.length; bt.hidden = today.length === 0;
  }

  /* ================= 业务操作 ================= */
  async function createNote(fields) {
    const now = U.nowISO();
    const note = Object.assign({
      id: DB.uid(),
      title: '',
      body: '',
      kind: 'note',
      courseId: '',
      tags: [],
      flag: '',
      createdAt: now,
      updatedAt: now
    }, fields || {});
    await DB.put('notes', note);
    await refresh();
    return note;
  }

  async function saveNote(note) {
    note.updatedAt = U.nowISO();
    await DB.put('notes', note);
    const i = S.notes.findIndex((n) => n.id === note.id);
    if (i > -1) S.notes[i] = note; else S.notes.unshift(note);
    updateBadges();
  }

  async function deleteNote(id) {
    const assets = S.assets.filter((a) => a.noteId === id);
    for (const a of assets) {
      await DB.del('blobs', a.id);
      await DB.del('assets', a.id);
    }
    const ts = S.transcripts.filter((t) => t.noteId === id);
    for (const t of ts) await DB.del('transcripts', t.id);
    await DB.del('notes', id);
    await refresh();
  }

  async function addAsset(noteId, blob, kind, meta) {
    const id = DB.uid();
    await DB.put('blobs', { id: id, data: blob });
    const asset = Object.assign({
      id: id,
      noteId: noteId || '',
      kind: kind,
      name: 'asset',
      mime: blob.type || '',
      size: blob.size || 0,
      createdAt: U.nowISO()
    }, meta || {});
    await DB.put('assets', asset);
    // 同步进内存，调用方忘了 refresh 也不会漏
    if (!S.assets.some((x) => x.id === asset.id)) S.assets.unshift(asset);
    return asset;
  }

  async function assetsOf(noteId) {
    return S.assets.filter((a) => a.noteId === noteId);
  }

  /* ================= 课件导入（PPT / PDF） ================= */
  const DOC_MAX = 20 * 1024 * 1024;

  function fmtSize(n) {
    if (!n) return '0 KB';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function docProgressSheet(name) {
    openSheet(
      '<div class="sheet-h"><h3>正在读这份课件</h3><div class="sp"></div>' +
      '<button class="x-btn" data-act="close-sheet">×</button></div>' +
      '<p class="sheet-sub" style="word-break:break-all">' + U.esc(name) + '</p>' +
      '<p class="sheet-sub" id="doc-progress">准备中…</p>' +
      '<div class="doc-bar"><i id="doc-bar-fill" style="width:8%"></i></div>' +
      '<p class="sheet-sub" style="font-size:11.5px;opacity:.72">整份文件在本机解析，不会上传。</p>'
    );
  }

  function setDocProgress(label, done, total) {
    const el = $('#doc-progress');
    const bar = $('#doc-bar-fill');
    if (el) el.textContent = label + (total ? '（' + Math.max(0, done) + '/' + total + '）' : '');
    if (bar) {
      const pct = total ? Math.round((done / total) * 100) : 12;
      bar.style.width = Math.max(8, Math.min(100, pct)) + '%';
    }
  }

  function importDoc() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pptx,.pdf,application/pdf,' +
      'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = function () {
      const f = input.files && input.files[0];
      setTimeout(function () { input.remove(); }, 500);
      if (f) runDocImport(f);
    };
    input.click();
  }

  async function runDocImport(file) {
    if (typeof Docs === 'undefined') { toast('课件模块没加载起来，刷新一下再试', true); return; }

    if (file.size > DOC_MAX) {
      toast('「' + file.name + '」有 ' + fmtSize(file.size) + '，超过 20MB 上限', true);
      return;
    }
    if (!Docs.supported({ name: file.name })) {
      toast('只支持 .pptx 和 .pdf；旧版 .ppt / .doc 请先另存为 .pptx', true);
      return;
    }

    docProgressSheet(file.name);

    let doc;
    try {
      doc = await Docs.parse(file, function (done, total, label) {
        setDocProgress(label || '解析中', done, total);
      });
    } catch (e) {
      openSheet(
        '<div class="sheet-h"><h3>这份文件没读成</h3><div class="sp"></div>' +
        '<button class="x-btn" data-act="close-sheet">×</button></div>' +
        '<p class="sheet-sub">' + U.esc(e.message || String(e)) + '</p>' +
        '<div class="sheet-foot"><button class="btn btn-primary" data-act="close-sheet">知道了</button></div>'
      );
      return;
    }

    // 扫描版 PDF：一个字都没抽出来，别生成一篇空笔记糊弄人
    if (doc.kind === 'pdf' && doc.chars < 20) {
      const pages = Math.min(5, doc.count);
      openSheet(
        '<div class="sheet-h"><h3>这份 PDF 是扫描件</h3><div class="sp"></div>' +
        '<button class="x-btn" data-act="close-sheet">×</button></div>' +
        '<p class="sheet-sub">里面没有可复制的文字层，直接抽出来是空的。' +
        '可以渲染成图再用本机 OCR 认一遍——' + pages + ' 页大概要一两分钟。</p>' +
        '<div class="sheet-foot">' +
        '<button class="btn" data-act="close-sheet">算了</button>' +
        '<button class="btn btn-primary" id="doc-ocr-run">OCR 前 ' + pages + ' 页</button>' +
        '</div>'
      );
      const btn = $('#doc-ocr-run');
      if (btn) btn.onclick = function () { ocrPdf(file, pages); };
      return;
    }

    await saveDocNote(file, doc);
  }

  async function ocrPdf(file, maxPages) {
    docProgressSheet(file.name + ' · OCR');
    let doc;
    try {
      const imgs = await Docs.pdfPagesToBlobs(file, maxPages);
      const pages = [];
      for (let i = 0; i < imgs.length; i++) {
        const p = imgs[i];
        setDocProgress('识别第 ' + p.no + ' 页', i, imgs.length);
        const text = await Media.OCR.recognize(p.blob, function (label, prog) {
          setDocProgress('识别第 ' + p.no + ' 页 · ' + label, i + (prog || 0), imgs.length);
        });
        const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
        pages.push({ no: p.no, title: lines[0] || ('第 ' + p.no + ' 页'), lines: lines.slice(1) });
      }
      doc = { kind: 'pdf', pages: pages, count: pages.length, chars: 999 };
    } catch (e) {
      toast('OCR 没成功：' + (e.message || e), true);
      return;
    }
    await saveDocNote(file, doc, ' · OCR');
  }

  async function saveDocNote(file, doc, suffix) {
    const base = file.name.replace(/\.[^.]+$/, '');
    const title = base + (suffix || '');
    const body = Docs.toMarkdown(doc, { fileName: file.name, when: U.today(), title: title });
    const note = await createNote({ title: title, kind: 'note', body: body });
    try {
      await addAsset(note.id, file, 'doc', { name: file.name, size: file.size });
    } catch (e) { /* 原文件存不下不影响正文 */ }
    await refresh();
    closeSheet();
    go('/note/' + note.id);
    toast('已导入 ' + doc.count + (doc.kind === 'pptx' ? ' 张幻灯片' : ' 页') + '，正文已排好');
  }

  async function openDocAsset(id) {
    const a = S.assets.filter((x) => x.id === id)[0];
    if (!a) return;
    const url = await assetURL(id);
    if (!url) { toast('文件不见了', true); return; }
    if (Docs.extOf(a.name) === 'pdf') {
      window.open(url, '_blank');
      return;
    }
    const link = document.createElement('a');
    link.href = url;
    link.download = a.name || 'file.pptx';
    document.body.appendChild(link);
    link.click();
    setTimeout(function () { link.remove(); }, 800);
  }

  /* ================= 不懂标记 ================= */
  async function toggleFlag() {
    await flushSave();
    const n = S.currentNote;
    if (!n || !n.id) { toast('先写点内容，再标不懂', true); return; }

    const on = n.flag !== 'unknown';
    const input = $('#ed-body-input');
    let wrapped = false;

    if (on && input) {
      const s = input.selectionStart;
      const e = input.selectionEnd;
      if (e > s) {
        const sel = input.value.slice(s, e);
        if (!/^==[\s\S]*==$/.test(sel)) {
          const next = input.value.slice(0, s) + '==' + sel + '==' + input.value.slice(e);
          input.value = next;
          n.body = next;
          wrapped = true;
          const pos = e + 4;
          try { input.setSelectionRange(pos, pos); } catch (err) {}
        }
      }
    }

    n.flag = on ? 'unknown' : '';
    n.flagAt = on ? U.nowISO() : '';
    await saveNote(n);
    render();
    if (on) {
      toast(wrapped ? '已标不懂，选中的那段变成高亮了' : '整篇标成不懂；下次选中一段文字再点，就只标那一段');
    } else {
      toast('已从不懂清单里移除');
    }
  }

  async function clearFlag(id) {
    const n = S.notes.filter((x) => x.id === id)[0];
    if (!n) return;
    n.flag = '';
    n.flagAt = '';
    await saveNote(n);
    render();
    toast('弄懂了，从清单里划掉');
  }

  /* ================= 路由 ================= */
  const TITLES = {
    today: '今日', schedule: '课表', inbox: '收件箱', notes: '笔记',
    editor: '笔记', graph: '知识图谱', settings: '设置', search: '搜索',
    unknown: '不懂清单'
  };

  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [pathPart, queryPart] = raw.split('?');
    const seg = pathPart.split('/').filter(Boolean);
    const params = {};
    if (queryPart) {
      queryPart.split('&').forEach((kv) => {
        const [k, v] = kv.split('=');
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
      });
    }
    let route = seg[0] || 'today';
    if (route === 'note') { route = 'editor'; params.id = seg[1] || 'new'; }
    return { route: route, params: params };
  }

  /** 应用内的返回栈：安卓返回键 / 手势返回要用 */
  const backStack = [];

  function go(path) {
    if (location.hash === '#' + path) { render(); return; }
    backStack.push(location.hash || '#/today');
    location.hash = path;
  }

  /** 安卓返回键：先关弹层，再退一页，实在没得退才让系统退出（返回 false） */
  function back() {
    const mask = $('#sheet-mask');
    if (mask && mask.classList.contains('open')) { closeSheet(); return true; }
    if (backStack.length) {
      location.hash = backStack.pop();
      return true;
    }
    const r = parseHash();
    if (r.route !== 'today') { go('/today'); return true; }
    return false;
  }

  async function onRoute() {
    await flushSave();
    revokeAll();
    const r = parseHash();
    S.route = r.route;
    S.params = r.params;
    if (r.route === 'search') S.search = r.params.q || '';
    // 从聊天软件里粘链接进同一个标签页时，只是 hash 变了，不会重新加载，
    // 所以这里也要能接住分享链接
    if (r.route === 'import') { await handleImport(); return; }
    if (document.body.classList.contains('share-mode')) document.body.classList.remove('share-mode');
    render();
  }

  /* ================= 渲染 ================= */
  function setNav() {
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.route === S.route));
    $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.route === S.route));
    $('#page-title').textContent = TITLES[S.route] || '落字';
    const wrap = $('#view-wrap');
    const isEditor = S.route === 'editor';
    wrap.style.overflow = isEditor ? 'hidden' : 'auto';
    wrap.style.display = isEditor ? 'flex' : 'block';
    wrap.style.flexDirection = 'column';
    $('#global-search').value = S.search || '';
  }

  function render() {
    setNav();
    const wrap = $('#view-wrap');
    const fn = VIEWS[S.route] || VIEWS.today;
    const html = fn();
    wrap.innerHTML = html;
    hydrate(wrap);
    MathRender.apply(wrap);
    if (S.route === 'editor') mountEditor();
    if (S.route === 'graph') drawGraph();
  }

  /** 把 data-asset 元素填上真实 blob url */
  async function hydrate(root) {
    const els = $$('[data-asset]', root);
    for (const el of els) {
      const id = el.dataset.asset;
      const url = await assetURL(id);
      if (!url) continue;
      if (el.tagName === 'IMG') el.src = url;
      else if (el.tagName === 'AUDIO') { el.src = url; }
      else if (el.tagName === 'SOURCE') el.src = url;
      else el.style.backgroundImage = 'url("' + url + '")';
    }
  }

  /* ================= 视图：今日 ================= */
  const VIEWS = {};

  VIEWS.today = function () {
    const wd = U.weekdayNow();
    const week = U.weekOf(S.settings.semesterStart, S.settings.totalWeeks);
    const list = Timetable.forDay(S.events, S.courses, wd);
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const next = Timetable.nextClass(S.events, S.courses);
    const captures = S.notes.filter((n) => n.kind === 'capture');
    const todayNotes = S.notes.filter((n) => (n.createdAt || '').slice(0, 10) === U.today());
    const d = new Date();
    const dateStr = (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';

    let h = '<div class="view">';

    h += '<div class="today-head">' +
      '<div class="date">' + dateStr + '</div>' +
      '<div class="meta">' + U.weekdayName(wd) + ' · ' + U.esc(week.label) + '</div>' +
      '<div class="sp"></div>' +
      '<button class="btn btn-sm" data-act="quick-capture">＋ 记一笔</button>' +
      '</div>';

    h += '<div class="stat-row">' +
      '<div class="stat"><b>' + list.length + '</b><span>今天有课</span></div>' +
      '<div class="stat"><b>' + todayNotes.length + '</b><span>今天新笔记</span></div>' +
      '<div class="stat"><b>' + captures.length + '</b><span>待整理速记</span></div>' +
      '<div class="stat"><b>' + S.notes.filter((n) => n.kind !== 'capture').length + '</b><span>笔记总数</span></div>' +
      '</div>';

    const unknownCount = S.notes.filter((n) => n.flag === 'unknown' && n.kind !== 'capture').length;
    if (unknownCount) {
      h += '<button class="unknown-banner" data-act="go" data-path="/unknown">' +
        '<span class="q">?</span>' +
        '<span class="txt">还有 <b>' + unknownCount + '</b> 个知识点标着没弄懂</span>' +
        '<span class="go">去看 →</span></button>';
    }

    if (next) {
      h += '<div class="next-card">' +
        '<div class="ring">' + next.inMinutes + '<span style="font-size:9px">分</span></div>' +
        '<div><div class="t">' + U.esc(next.event.courseName) + '</div>' +
        '<div class="s">' + next.event.start + ' 开始 · ' + U.esc(next.event.room || '未填教室') + '</div></div>' +
        '<div class="sp"></div>' +
        '<button class="btn btn-primary btn-sm" data-act="note-from-event" data-id="' + next.event.id + '">去记笔记</button>' +
        '</div>';
    }

    h += '<div class="section-h"><h2>今天的课</h2><div class="sp"></div>' +
      '<button class="more" data-act="go" data-path="/schedule">看整周 →</button></div>';

    if (!list.length) {
      h += '<div class="card empty"><span class="big">▤</span>' +
        (S.events.length ? '今天没课，休息一下。' : '还没有课表。<br>导入一份，之后每天都会自动排好。') +
        (S.events.length ? '' : '<br><button class="btn btn-primary btn-sm" style="margin-top:14px" data-act="open-import">导入课表</button>') +
        '</div>';
    } else {
      h += '<div class="day-list">';
      list.forEach((e) => {
        const past = Timetable.toMin(e.end) < nowMin;
        h += '<button class="class-row' + (past ? ' past' : '') + '" style="--c:' +
          (e.course ? e.course.color : '#555') + '" data-act="note-from-event" data-id="' + e.id + '">' +
          '<div class="time"><b>' + e.start + '</b>' + e.end + '</div>' +
          '<div><div class="name">' + U.esc(e.courseName) + '</div>' +
          '<div class="room">' + U.esc(e.room || '未填教室') + '</div></div>' +
          '<div class="sp"></div>' +
          '<span style="font-size:11px;color:var(--faint)">记笔记 →</span>' +
          '</button>';
      });
      h += '</div>';
    }

    const recent = S.notes.slice(0, 5);
    if (recent.length) {
      h += '<div class="section-h"><h2>最近编辑</h2><div class="sp"></div>' +
        '<button class="more" data-act="go" data-path="/notes">全部 →</button></div>';
      h += '<div class="list">';
      recent.forEach((n) => { h += noteRow(n); });
      h += '</div>';
    }

    h += '</div>';
    return h;
  };

  function noteRow(n) {
    const isCap = n.kind === 'capture';
    const preview = MD.plain(n.body).slice(0, 70);
    const asset = S.assets.filter((a) => a.noteId === n.id)[0];
    let thumb = '<div class="thumb">' + (isCap ? '▣' : '✎') + '</div>';
    if (asset && asset.kind === 'image') {
      thumb = '<div class="thumb"><img data-asset="' + asset.id + '" alt=""></div>';
    } else if (asset && asset.kind === 'audio') {
      thumb = '<div class="thumb">🎙</div>';
    }
    return '<button class="row" data-act="open-note" data-id="' + n.id + '">' +
      thumb +
      '<div class="body"><div class="title">' + (n.title ? U.esc(n.title) : '（未命名）') + '</div>' +
      '<div class="sub">' + U.esc(preview || placeholderOf(n)) + '</div></div>' +
      '<span class="stamp">' + U.fmtDate(n.updatedAt) + '</span>' +
      '</button>';
  }

  /** 正文为空时，按附件类型给出人话摘要 */
  function placeholderOf(n) {
    const list = S.assets.filter((a) => a.noteId === n.id);
    if (!list.length) return '空笔记';
    const img = list.filter((a) => a.kind === 'image').length;
    const aud = list.filter((a) => a.kind === 'audio').length;
    const parts = [];
    if (img) parts.push(img + ' 张图片');
    if (aud) parts.push(aud + ' 段录音');
    return parts.join(' · ');
  }

  /* ================= 视图：课表 ================= */
  VIEWS.schedule = function () {
    const events = S.events;
    const courseMap = {};
    S.courses.forEach((c) => { courseMap[c.id] = c; });

    // 计算时间轴范围
    let minSlot = 8, maxSlot = 18;
    events.forEach((e) => {
      const s = Timetable.toMin(e.start) / 60;
      const t = Timetable.toMin(e.end) / 60;
      minSlot = Math.min(minSlot, Math.floor(s));
      maxSlot = Math.max(maxSlot, Math.ceil(t));
    });
    minSlot = Math.max(0, minSlot);
    maxSlot = Math.min(24, maxSlot);

    const hours = [];
    for (let hh = minSlot; hh <= maxSlot; hh++) hours.push(hh);

    const wd = U.weekdayNow();
    let h = '<div class="view">';

    h += '<div class="tt-toolbar">' +
      '<button class="btn btn-primary btn-sm" data-act="open-import">导入课表</button>' +
      '<button class="btn btn-sm" data-act="open-add-event">手动加课</button>' +
      '<div class="sp"></div>' +
      '<span style="font-size:12px;color:var(--muted)">' + events.length + ' 节课 · ' + S.courses.length + ' 门课</span>' +
      '</div>';

    if (!events.length) {
      h += '<div class="card empty"><span class="big">▤</span>' +
        '还没有课表。<br>可以粘贴一段文字课表，系统按行解析成课程。' +
        '<div style="margin-top:16px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">' +
        '<button class="btn btn-primary btn-sm" data-act="open-import">粘贴课表</button>' +
        '<button class="btn btn-sm" data-act="try-sample">看示例格式</button>' +
        '</div></div></div>';
      return h;
    }

    h += '<div class="tt-scroll"><div class="tt">';
    h += '<div class="tt-head"></div>';
    for (let i = 1; i <= 7; i++) {
      const d = new Date();
      const diff = i - wd;
      d.setDate(d.getDate() + diff);
      h += '<div class="tt-head' + (i === wd ? ' today' : '') + '">' + U.weekdayName(i).replace('周', '') +
        '<b>' + d.getDate() + '</b></div>';
    }

    hours.forEach((hh) => {
      h += '<div class="tt-hour">' + U.pad(hh) + ':00</div>';
      for (let i = 1; i <= 7; i++) {
        const cellEvents = events.filter((e) => {
          if (+e.weekday !== i) return false;
          const sh = Timetable.toMin(e.start) / 60;
          return sh >= hh && sh < hh + 1;
        });
        if (!cellEvents.length) {
          h += '<div class="tt-cell"></div>';
        } else {
          h += '<div class="tt-cell" style="background:transparent;display:flex;flex-direction:column;gap:3px">';
          cellEvents.forEach((e) => {
            const c = courseMap[e.courseId];
            h += '<button class="tt-event" style="background:' + (c ? c.color : '#444') +
              '" data-act="event-detail" data-id="' + e.id + '">' +
              '<b>' + U.esc(e.courseName) + '</b>' +
              '<span>' + e.start + '-' + e.end + (e.room ? ' · ' + U.esc(e.room) : '') + '</span></button>';
          });
          h += '</div>';
        }
      }
    });

    h += '</div></div>';

    h += '<div class="section-h"><h2>课程列表</h2></div><div class="list">';
    S.courses.forEach((c) => {
      const cnt = events.filter((e) => e.courseId === c.id).length;
      const notes = S.notes.filter((n) => n.courseId === c.id).length;
      h += '<div class="row" style="cursor:default">' +
        '<div class="thumb" style="background:' + c.color + '"></div>' +
        '<div class="body"><div class="title">' + U.esc(c.name) + '</div>' +
        '<div class="sub">每周 ' + cnt + ' 节 · ' + notes + ' 篇笔记</div></div>' +
        '<div class="sp"></div>' +
        '<button class="btn btn-sm btn-ghost" data-act="del-course" data-id="' + c.id + '">删除</button>' +
        '</div>';
    });
    h += '</div></div>';
    return h;
  };

  /* ================= 视图：收件箱 ================= */
  VIEWS.inbox = function () {
    const caps = S.notes.filter((n) => n.kind === 'capture');
    let h = '<div class="view">';
    h += '<div class="tt-toolbar">' +
      '<button class="btn btn-primary btn-sm" data-act="capture-photo">＋ 拍照 / 相册</button>' +
      '<button class="btn btn-sm" data-act="capture-text">＋ 文字</button>' +
      '<button class="btn btn-sm" data-act="capture-audio">🎙 录音</button>' +
      '<div class="sp"></div>' +
      '<span style="font-size:12px;color:var(--muted)">' + caps.length + ' 条待整理</span>' +
      '</div>';

    if (!caps.length) {
      h += '<div class="card empty"><span class="big">▣</span>' +
        '收件箱是空的。<br>上课听不清的那一句，先拍下来或打几个字，课后一起整理。' +
        '</div></div>';
      return h;
    }

    h += '<div class="list">';
    caps.forEach((n) => {
      const assets = S.assets.filter((a) => a.noteId === n.id);
      const img = assets.filter((a) => a.kind === 'image')[0];
      const aud = assets.filter((a) => a.kind === 'audio')[0];
      const preview = MD.plain(n.body).slice(0, 80);
      let thumb = '<div class="thumb">▣</div>';
      if (img) thumb = '<div class="thumb"><img data-asset="' + img.id + '" alt=""></div>';
      else if (aud) thumb = '<div class="thumb">🎙</div>';

      h += '<button class="row" data-act="open-note" data-id="' + n.id + '">' +
        thumb +
        '<div class="body"><div class="title">' + (n.title ? U.esc(n.title) : U.fmtDate(n.createdAt) + ' 的速记') + '</div>' +
        '<div class="sub">' + (preview ? U.esc(preview) : (img ? '一张图片' : aud ? '一段录音' : '空')) + '</div></div>' +
        '<span class="stamp">' + U.fmtDate(n.createdAt) + '</span>' +
        '</button>';
    });
    h += '</div></div>';
    return h;
  };

  /* ================= 视图：笔记列表 ================= */
  VIEWS.notes = function () {
    const q = S.search.trim();
    const all = S.notes.filter((n) => n.kind !== 'capture');
    const list = q ? Search.run(all, q, 100).map((r) => r.doc) : all;

    let h = '<div class="view">';
    h += '<div class="tt-toolbar">' +
      '<button class="btn btn-primary btn-sm" data-act="new-note">＋ 新建笔记</button>' +
      '<button class="btn btn-sm" data-act="import-doc">导入课件</button>' +
      '<button class="btn btn-sm" data-act="export-all">导出全部</button>' +
      '<button class="btn btn-sm" data-act="go" data-path="/graph">知识图谱</button>' +
      '<div class="sp"></div>' +
      '<span style="font-size:12px;color:var(--muted)">' + list.length + ' 篇' + (q ? ' · 搜索「' + U.esc(q) + '」' : '') + '</span>' +
      '</div>';

    if (!list.length) {
      h += '<div class="card empty"><span class="big">✎</span>' +
        (q ? '没有找到相关内容。' : '还没有笔记。<br>新建一篇，或者从收件箱整理速记。') +
        '</div></div>';
      return h;
    }

    h += '<div class="list">';
    list.forEach((n) => {
      const sub = q ? Search.snippet(n, Search.tokenize(q)) : MD.plain(n.body).slice(0, 80);
      const links = MD.wikiTargets(n.body).length;
      h += '<button class="row" data-act="open-note" data-id="' + n.id + '">' +
        '<div class="thumb">✎</div>' +
        '<div class="body"><div class="title">' + (q ? Search.highlight(n.title || '（未命名）', q) : (U.esc(n.title) || '（未命名）')) + '</div>' +
        '<div class="sub">' + (q ? Search.highlight(sub, q) : U.esc(sub || '空笔记')) + '</div></div>' +
        '<span class="stamp">' + (links ? links + ' 链 · ' : '') + U.fmtDate(n.updatedAt) + '</span>' +
        '</button>';
    });
    h += '</div></div>';
    return h;
  };

  /* ================= 视图：编辑器 ================= */
  /* ================= 视图：不懂清单 ================= */
  VIEWS.unknown = function () {
    const flagged = S.notes.filter((n) => n.flag === 'unknown' && n.kind !== 'capture');
    const totalMarks = flagged.reduce((s, n) => s + MD.markSnippets(n.body).length, 0);

    let h = '<div class="view">';
    h += '<div class="tt-toolbar">' +
      '<span style="font-size:12.5px;color:var(--muted)">' +
      flagged.length + ' 篇笔记 · ' + totalMarks + ' 处标了高亮' +
      '</span>' +
      '<div class="sp"></div>' +
      '<button class="btn btn-sm" data-act="import-doc">导入课件</button>' +
      '</div>';

    h += '<div class="card" style="margin-bottom:14px;padding:14px 16px">' +
      '<div style="font-size:12.5px;color:var(--muted);line-height:1.85">' +
      '在笔记里选中一段文字，点「标不懂」，那段会变成 <mark class="md-mark">这个样子</mark>，同时这里会多一条。' +
      '弄明白之后点「弄懂了」，它就从清单里消失。' +
      '</div></div>';

    if (!flagged.length) {
      h += '<div class="card empty"><span class="big">✓</span>' +
        '清单是空的。<br>没有标过的知识点就不会出现在这里——这是好事。' +
        '</div></div>';
      return h;
    }

    h += '<div class="unk-list">';
    flagged.forEach((n) => {
      const marks = MD.markSnippets(n.body);
      const sub = marks.length
        ? marks.slice(0, 3).map((m) => '「' + m.slice(0, 18) + (m.length > 18 ? '…' : '') + '」').join(' ')
        : '只标了整篇，正文里没有高亮片段';
      h += '<div class="unk-item">' +
        '<button class="row" data-act="open-note" data-id="' + n.id + '">' +
        '<div class="thumb unk">?</div>' +
        '<div class="body"><div class="title">' + (U.esc(n.title) || '（未命名）') + '</div>' +
        '<div class="sub">' + (marks.length ? marks.length + ' 处 · ' : '') + U.esc(sub) + '</div></div>' +
        '<span class="stamp">' + U.fmtDate(n.updatedAt || n.createdAt) + '</span>' +
        '</button>' +
        '<button class="btn btn-sm unk-done" data-act="flag-off" data-id="' + n.id + '">弄懂了</button>' +
        '</div>';
    });
    h += '</div></div>';
    return h;
  };

  function currentNote() {
    const id = S.params.id;
    if (id === 'new') {
      // 上一份草稿已经入库，开一篇全新的
      if (draft && draft.id) draft = null;
      return buildDraft();
    }
    const found = S.notes.filter((n) => n.id === id)[0];
    if (found) return found;
    draft = null;
    return buildDraft();
  }

  let draft = null;
  function buildDraft() {
    if (!draft) {
      const now = U.nowISO();
      draft = {
        id: '', title: '', body: '', kind: S.params.kind === 'capture' ? 'capture' : 'note',
        courseId: S.params.course || '', tags: [], flag: '',
        createdAt: now, updatedAt: now
      };
    }
    return draft;
  }

  VIEWS.editor = function () {
    const n = currentNote();
    S.currentNote = n;
    const backlinks = n.id ? Graph.backlinks(S.notes, n.id) : [];
    const outgoing = n.body ? MD.wikiTargets(n.body) : [];
    const titlesSet = {};
    S.notes.forEach((x) => { if (x.title) titlesSet[x.title.trim().toLowerCase()] = x.id; });

    let h = '<div class="editor-page" style="height:100%">';
    h += '<div class="editor-bar">' +
      '<button class="x-btn" data-act="go" data-path="/notes" title="返回">←</button>' +
      '<input class="title-input" id="ed-title" placeholder="笔记标题…" value="' + U.esc(n.title) + '">' +
      '<button class="btn btn-sm" id="ed-preview-toggle" data-act="toggle-preview">预览</button>' +
      '<button class="btn btn-sm" data-act="ed-insert-image" title="插入图片">图片</button>' +
      '<button class="btn btn-sm" data-act="ed-record" title="录音">录音</button>' +
      '<button class="btn btn-sm flag-btn' + (n.flag === 'unknown' ? ' on' : '') +
      '" data-act="toggle-flag" title="选中一段文字再点这里，会把它标成「还没弄懂」">' +
      (n.flag === 'unknown' ? '已标不懂' : '标不懂') + '</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="ed-export">导出</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="ed-share">分享</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="ed-delete" style="color:var(--danger)">删除</button>' +
      '</div>';

    h += '<div class="editor-body" id="ed-body">';
    h += '<div class="editor-pane write-pane">' +
      '<textarea class="md-input" id="ed-body-input" placeholder="正文…&#10;&#10;支持 Markdown、[[双链]]、$公式$&#10;快捷键 ⌘S 保存">' + U.esc(n.body) + '</textarea>' +
      '</div>';
    h += '<div class="editor-pane preview-pane"><div class="md-preview" id="ed-preview"></div></div>';
    h += '</div>';

    // 资产区
    const assets = n.id ? S.assets.filter((a) => a.noteId === n.id) : [];
    if (assets.length) {
      h += '<div style="padding:12px 24px;border-top:1px solid var(--line)">';
      h += '<div style="font-size:11.5px;color:var(--muted);margin-bottom:8px">附件 ' + assets.length + '</div>';
      h += '<div class="attachment-grid">';
      assets.forEach((a) => {
        if (a.kind === 'image') {
          h += '<div class="capture-item" data-act="view-image" data-asset="' + a.id + '">' +
            '<img data-asset="' + a.id + '" alt="">' +
            '<span class="tag">' + U.esc(a.name.slice(0, 14)) + '</span>' +
            '<button class="ocr" data-act="ocr-asset" data-id="' + a.id + '" title="把这张图里的文字提出来">取字</button>' +
            '<button class="del" data-act="del-asset" data-id="' + a.id + '">×</button></div>';
        } else if (a.kind === 'doc') {
          h += '<div class="card doc-card">' +
            '<div class="doc-ico">' + (Docs.extOf(a.name) === 'pdf' ? 'PDF' : 'PPT') + '</div>' +
            '<div class="doc-meta"><b>' + U.esc(a.name) + '</b>' +
            '<span>' + fmtSize(a.size) + ' · 原始文件</span></div>' +
            '<div class="doc-btns">' +
            '<button class="btn btn-sm" data-act="open-doc" data-id="' + a.id + '">打开</button>' +
            '<button class="btn btn-sm btn-ghost" data-act="del-asset" data-id="' + a.id + '">删除</button>' +
            '</div></div>';
        } else {
          h += '<div class="card" style="padding:12px">' +
            '<div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">🎙 ' + Media.fmtTime(a.duration || 0) + '</div>' +
            '<audio class="asset-audio" controls preload="metadata" data-asset="' + a.id + '"></audio>' +
            '<div style="display:flex;gap:6px;margin-top:8px">' +
            '<button class="btn btn-sm" data-act="transcribe" data-id="' + a.id + '">转文字</button>' +
            '<button class="btn btn-sm btn-ghost" data-act="del-asset" data-id="' + a.id + '">删除</button>' +
            '</div></div>';
        }
      });
      h += '</div></div>';
    }

    // 反向链接
    if (backlinks.length || outgoing.length) {
      h += '<div class="backlink-box">';
      if (backlinks.length) {
        h += '<h4>反向链接 · ' + backlinks.length + ' 篇提到了这里</h4><div class="backlink-list">';
        backlinks.forEach((b) => {
          h += '<button class="chip" data-act="open-note" data-id="' + (b.id || '') + '">' + U.esc(b.title) + '</button>';
        });
        h += '</div>';
      }
      if (outgoing.length) {
        h += '<h4 style="margin-top:14px">本篇链出 · ' + outgoing.length + '</h4><div class="backlink-list">';
        outgoing.forEach((t) => {
          const exists = titlesSet[t.toLowerCase()];
          h += '<button class="chip' + (exists ? ' on' : '') + '" data-act="goto-wiki" data-title="' + U.esc(t) + '">' +
            U.esc(t) + (exists ? '' : ' · 未创建') + '</button>';
        });
        h += '</div>';
      }
      h += '</div>';
    }

    h += '</div>';
    return h;
  };

  function mountEditor() {
    const n = S.currentNote;
    const input = $('#ed-body-input');
    const title = $('#ed-title');
    if (!input || !title) return;

    const refreshPreview = () => {
      const box = $('#ed-preview');
      if (!box) return;
      box.innerHTML = MD.render(input.value);
      MathRender.apply(box);
      // 标记未创建的链接
      const titles = {};
      S.notes.forEach((x) => { if (x.title) titles[x.title.trim().toLowerCase()] = true; });
      $$('.wikilink', box).forEach((a) => {
        const t = (a.dataset.wikilink || '').toLowerCase();
        if (!titles[t]) a.classList.add('missing');
      });
    };
    refreshPreview();

    const onChange = () => {
      S.dirty = true;
      refreshPreview();
      scheduleSave();
    };
    input.addEventListener('input', onChange);
    title.addEventListener('input', function () {
      S.dirty = true;
      scheduleSave();
    });

    input.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        flushSave().then(() => toast('已保存'));
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = input.selectionStart;
        input.value = input.value.slice(0, s) + '  ' + input.value.slice(input.selectionEnd);
        input.selectionStart = input.selectionEnd = s + 2;
        onChange();
      }
    });
  }

  function scheduleSave() {
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(() => { flushSave(); }, 800);
  }

  async function flushSave() {
    clearTimeout(S.saveTimer);
    if (!S.dirty || !S.currentNote) return;
    const n = S.currentNote;
    const input = $('#ed-body-input');
    const title = $('#ed-title');
    if (input) n.body = input.value;
    if (title) n.title = title.value.trim();

    if (!n.id) {
      if (!n.title && !n.body.trim()) { S.dirty = false; return; }
      n.kind = n.kind || 'note';
      await DB.put('notes', n);
      // 同步进内存，列表和搜索立刻能看到
      if (!S.notes.some((x) => x.id === n.id)) S.notes.unshift(n);
      S.params.id = n.id;
      updateBadges();
      history.replaceState(null, '', '#/note/' + n.id);
    } else {
      await saveNote(n);
    }
    S.dirty = false;
  }

  /* ================= 视图：图谱 ================= */
  let graphState = null;

  VIEWS.graph = function () {
    const nodes = Graph.build(S.notes);
    const keys = Object.keys(nodes);
    if (!keys.length) {
      return '<div class="view"><div class="card empty"><span class="big">◈</span>' +
        '图谱还是空的。<br>写几篇带 [[双链]] 的笔记，这里会长出连接。' +
        '</div></div>';
    }
    return '<div class="view" style="height:100%">' +
      '<div class="tt-toolbar"><div class="sp"></div>' +
      '<span style="font-size:12px;color:var(--muted)">' + keys.length + ' 个节点</span></div>' +
      '<div id="graph-box" style="border:1px solid var(--line);border-radius:18px;background:var(--panel);overflow:hidden;height:calc(100vh - 190px);min-height:380px"></div>' +
      '</div>';
  };

  function drawGraph() {
    const box = $('#graph-box');
    if (!box) return;
    const nodes = Graph.build(S.notes);
    const keys = Object.keys(nodes);
    if (!keys.length) return;

    const W = box.clientWidth || 600;
    const H = box.clientHeight || 420;
    const cx = W / 2, cy = H / 2;

    // 初始圆形布局
    const pos = {};
    keys.forEach((k, i) => {
      const ang = (i / keys.length) * Math.PI * 2 - Math.PI / 2;
      const rr = Math.min(W, H) * 0.28;
      pos[k] = { x: cx + Math.cos(ang) * rr, y: cy + Math.sin(ang) * rr, dx: 0, dy: 0 };
    });

    // 边：去重后按无向处理
    const edgeSet = {};
    const edges = [];
    keys.forEach((k) => {
      nodes[k].out.forEach((srcId) => {
        const src = S.notes.filter((n) => n.id === srcId)[0];
        if (!src || !src.title) return;
        const sk = src.title.trim().toLowerCase();
        if (pos[sk] && sk !== k) {
          const sig = [sk, k].sort().join('|');
          if (!edgeSet[sig]) { edgeSet[sig] = 1; edges.push([sk, k]); }
        }
      });
    });

    // Fruchterman-Reingold 力导向
    const area = W * H;
    const kDist = Math.sqrt(area / Math.max(keys.length, 1)) * 0.62;
    let temp = Math.min(W, H) / 5;

    for (let it = 0; it < 300; it++) {
      keys.forEach((a) => { pos[a].dx = 0; pos[a].dy = 0; });

      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const a = keys[i], b = keys[j];
          const dx = pos[a].x - pos[b].x, dy = pos[a].y - pos[b].y;
          const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const f = (kDist * kDist) / d;
          const ux = dx / d, uy = dy / d;
          pos[a].dx += ux * f; pos[a].dy += uy * f;
          pos[b].dx -= ux * f; pos[b].dy -= uy * f;
        }
      }

      edges.forEach(([a, b]) => {
        const dx = pos[a].x - pos[b].x, dy = pos[a].y - pos[b].y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d * d) / kDist;
        const ux = dx / d, uy = dy / d;
        pos[a].dx -= ux * f; pos[a].dy -= uy * f;
        pos[b].dx += ux * f; pos[b].dy += uy * f;
      });

      keys.forEach((k) => {
        const p = pos[k];
        p.dx += (cx - p.x) * 0.006;
        p.dy += (cy - p.y) * 0.006;
        const len = Math.sqrt(p.dx * p.dx + p.dy * p.dy) || 0.01;
        const step = Math.min(len, temp);
        p.x += (p.dx / len) * step;
        p.y += (p.dy / len) * step;
        p.x = Math.max(56, Math.min(W - 56, p.x));
        p.y = Math.max(34, Math.min(H - 26, p.y));
      });
      temp *= 0.97;
    }

    // 力导向算完的位置经常挤成一坨或被甩到角落。
    // 这里重排一次：互有链接的笔记聚在中间，还没连上的散点摆外圈。
    (function arrange() {
      const deg = {};
      keys.forEach((k) => { deg[k] = 0; });
      edges.forEach(([a, b]) => { deg[a]++; deg[b]++; });

      const linked = keys.filter((k) => deg[k] > 0);
      const lonely = keys.filter((k) => deg[k] === 0);
      const PAD = 84;

      // 中心框：按它们自己的包围盒等比缩放，保持力导向算出来的相对关系
      if (linked.length) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        linked.forEach((k) => {
          minX = Math.min(minX, pos[k].x); maxX = Math.max(maxX, pos[k].x);
          minY = Math.min(minY, pos[k].y); maxY = Math.max(maxY, pos[k].y);
        });
        const bw = Math.max(maxX - minX, 1);
        const bh = Math.max(maxY - minY, 1);
        const boxW = W - PAD * 2 - (lonely.length ? W * 0.16 : 0);
        const boxH = H - PAD * 2 - (lonely.length ? H * 0.10 : 0);
        const s = Math.min(boxW / bw, boxH / bh, 1.8);
        const offX = PAD + (boxW - bw * s) / 2;
        const offY = PAD + (boxH - bh * s) / 2;
        linked.forEach((k) => {
          pos[k].x = offX + (pos[k].x - minX) * s;
          pos[k].y = offY + (pos[k].y - minY) * s;
        });
      }

      // 外圈：均匀撒在椭圆上，避开中间那坨
      if (lonely.length) {
        const rx = W * 0.41;
        const ry = H * 0.37;
        lonely.forEach((k, i) => {
          const ang = (i / lonely.length) * Math.PI * 2 - Math.PI / 2 + 0.5;
          pos[k].x = cx + Math.cos(ang) * rx;
          pos[k].y = cy + Math.sin(ang) * ry;
        });
      }
    })();

    let svg = '<svg width="' + W + '" height="' + H + '" style="display:block">';
    edges.forEach(([a, b]) => {
      svg += '<line x1="' + pos[a].x.toFixed(1) + '" y1="' + pos[a].y.toFixed(1) +
        '" x2="' + pos[b].x.toFixed(1) + '" y2="' + pos[b].y.toFixed(1) +
        '" stroke="var(--line-strong)" stroke-width="1.2"/>';
    });
    keys.forEach((k) => {
      const p = pos[k];
      const deg = nodes[k].inn.length + nodes[k].out.length;
      const r = 9 + Math.min(12, deg * 2.4);
      const exists = !!nodes[k].id;
      svg += '<g style="cursor:pointer" data-act="open-note" data-id="' + (nodes[k].id || '') + '">' +
        '<title>' + U.esc(nodes[k].title) + (exists ? '' : '（还没写）') + '</title>' +
        '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + r +
        '" fill="' + (exists ? 'var(--mint)' : 'transparent') +
        '" stroke="var(--mint)" stroke-width="1.4" opacity="' + (exists ? 0.9 : 0.55) + '"/>' +
        '<text x="' + Math.max(62, Math.min(W - 62, p.x)).toFixed(1) + '" y="' + (p.y + r + 14).toFixed(1) +
        '" text-anchor="middle" font-size="10.5" fill="' + (exists ? 'var(--muted)' : 'var(--faint)') + '">' +
        U.esc(nodes[k].title.slice(0, 16)) + '</text></g>';
    });
    svg += '</svg>';
    box.innerHTML = svg;
    graphState = { W: W, H: H };
  }

  /* ================= 视图：设置 ================= */
  VIEWS.settings = function () {
    const st = S.settings;
    const noteCount = S.notes.length;
    const assetCount = S.assets.length;
    const totalBytes = S.assets.reduce((a, x) => a + (x.size || 0), 0);

    let h = '<div class="view">';

    h += '<div class="section-h"><h2>外观</h2></div>';
    h += '<div class="card"><div class="field"><label>主题色</label><div style="display:flex;gap:8px;flex-wrap:wrap">';
    [[168, '豆青'], [212, '海盐蓝'], [270, '暮光紫'], [26, '落日琥珀']].forEach(([hue, name]) => {
      h += '<button class="chip' + (st.hue === hue ? ' on' : '') + '" data-act="set-hue" data-hue="' + hue + '">' +
        '<span style="width:10px;height:10px;border-radius:50%;background:hsl(' + hue + ' 45% 60%);display:inline-block"></span>' +
        name + '</button>';
    });
    h += '</div></div></div>';

    h += '<div class="section-h"><h2>学期</h2></div>';
    h += '<div class="card">' +
      '<div class="field"><label>开学第一天（用于推算周次）</label>' +
      '<input class="input" type="date" id="set-semester" value="' + U.esc(st.semesterStart || '') + '"></div>' +
      '<div class="field"><label>总周数</label>' +
      '<input class="input" type="number" min="1" max="30" id="set-weeks" value="' + (st.totalWeeks || 20) + '"></div>' +
      '<button class="btn btn-primary btn-sm" data-act="save-semester">保存</button>' +
      '</div>';

    h += '<div class="section-h"><h2>转写</h2></div>';
    h += '<div class="card">' +
      '<div class="field"><label>引擎</label>' +
      '<select class="select" id="set-asr">' +
      '<option value="browser"' + (st.asrEngine === 'browser' ? ' selected' : '') + '>浏览器内置识别（免费，依赖浏览器厂商服务）</option>' +
      '<option value="custom"' + (st.asrEngine === 'custom' ? ' selected' : '') + '>自建 / 兼容 OpenAI Whisper 的接口</option>' +
      '</select>' +
      '<div class="hint">浏览器内置识别在 Chrome 上需要联网调用厂商服务，国内网络可能不可用。自建接口更稳。</div></div>' +
      '<div class="field"><label>接口地址（例如 https://api.openai.com/v1）</label>' +
      '<input class="input" id="set-base" placeholder="https://…/v1" value="' + U.esc(st.asrBaseUrl || '') + '"></div>' +
      '<div class="field"><label>API Key</label>' +
      '<input class="input" id="set-key" type="password" placeholder="sk-…" value="' + U.esc(st.asrApiKey || '') + '"></div>' +
      '<div class="field"><label>模型名</label>' +
      '<input class="input" id="set-model" placeholder="whisper-1" value="' + U.esc(st.asrModel || 'whisper-1') + '"></div>' +
      '<button class="btn btn-primary btn-sm" data-act="save-asr">保存转写配置</button>' +
      '<div class="hint">Key 只存在本机 IndexedDB，不会上传到除你填的接口以外的任何地方。</div>' +
      '</div>';

    h += '<div class="section-h"><h2>数据</h2></div>';
    h += '<div class="card">' +
      '<div style="font-size:12.5px;color:var(--muted);line-height:2;margin-bottom:12px">' +
      noteCount + ' 篇笔记 · ' + assetCount + ' 个附件 · 占用 ' + U.fmtSize(totalBytes) + '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn btn-sm" data-act="export-all">导出全部（ZIP）</button>' +
      '<button class="btn btn-sm" data-act="export-json">备份数据（JSON）</button>' +
      '<button class="btn btn-sm" data-act="import-json">恢复备份</button>' +
      '<button class="btn btn-sm btn-danger" data-act="wipe">清空数据</button>' +
      '</div></div>';

    h += '<div class="section-h"><h2>安装与离线</h2></div>';
    h += '<div class="card">' +
      '<div style="font-size:12.5px;line-height:2;color:var(--muted)">' +
      '安装状态：<b style="color:var(--ink)">' + (IS_DESKTOP ? '桌面版（双击图标直接打开）' : IS_NATIVE ? '安卓版（已安装）' : isStandalone() ? '已安装（独立窗口运行）' : '未安装（浏览器标签页运行）') + '</b><br>' +
      '离线缓存：<b style="color:var(--ink)">' + (IS_APP ? '不需要，资源都在本地' : navigator.serviceWorker && navigator.serviceWorker.controller ? '已接管，可离线打开' : '未就绪') + '</b><br>' +
      '应用版本：v1.4.0' +
      '</div>' +
      (IS_APP
        ? '<div class="hint">' + (IS_DESKTOP ? '桌面版' : '安卓版') + '已经包含全部资源，断网也能照常用。换设备时用下面的备份恢复。</div>'
        : '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
          '<button class="btn btn-primary btn-sm" data-act="install">安装到桌面</button>' +
          '<button class="btn btn-sm" data-act="check-update">检查更新</button>' +
          '</div>' +
          '<div class="hint">iPhone / iPad 用 Safari 打开，点分享按钮，选「添加到主屏幕」。安卓 Chrome 用菜单里的「安装应用」。</div>') +
      '</div>';

    h += '<div style="margin-top:26px;font-size:11.5px;color:var(--faint);line-height:1.9">' +
      '落字 v1.0.0 · 数据全部存在这台设备的 IndexedDB 里，不上传服务器。<br>' +
      '课表识别与公式识别需要独立的识别服务，当前版本手写课表文本解析与公式源码渲染。' +
      '</div>';

    h += '</div>';
    return h;
  };

  /* ================= 视图：搜索 ================= */
  VIEWS.search = function () {
    const q = S.search.trim();
    if (!q) return '<div class="view"><div class="card empty">输入关键词开始搜索。</div></div>';
    const res = Search.run(S.notes, q, 50);
    let h = '<div class="view">';
    h += '<div class="tt-toolbar"><span style="font-size:12px;color:var(--muted)">' + res.length + ' 条结果</span></div>';
    if (!res.length) { h += '<div class="card empty">没有找到「' + U.esc(q) + '」</div></div>'; return h; }
    h += '<div class="list">';
    res.forEach((r) => {
      const n = r.doc;
      h += '<button class="row" data-act="open-note" data-id="' + n.id + '">' +
        '<div class="thumb">' + (n.kind === 'capture' ? '▣' : '✎') + '</div>' +
        '<div class="body"><div class="title">' + Search.highlight(n.title || '（未命名）', q) + '</div>' +
        '<div class="sub">' + Search.highlight(r.snippet, q) + '</div></div>' +
        '<span class="stamp">' + U.fmtDate(n.updatedAt) + '</span></button>';
    });
    h += '</div></div>';
    return h;
  };

  /* ================= 动作：课表导入 ================= */
  const SAMPLE = '周一 08:30-10:00 高等数学 A301\n' +
    '周二 第3-4节 大学英语 语音室B2\n' +
    '周三 14:00-15:40 人工智能基础 C101\n' +
    '周四 10:15-12:00 经济法 A405\n' +
    '周五 第1-2节 近现代史纲要 D205';

  /** OCR 结果清洗：OCR 爱在汉字之间加空格、用竖线代替表格线，这里都清掉 */
  function normalizeOcrText(t) {
    return String(t || '')
      .replace(/\r/g, '')
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角数字转半角
      .replace(/：/g, ':')
      .replace(/[｜|]/g, ' ')          // 表格竖线当空白
      // 表格里的列间距是「一大段空格」，先拿占位符护住，等下还原成一个空格
      .replace(/[ \t\u3000]{2,}/g, '\u0001')
      // 汉字之间被 OCR 拆开的单个空格要合回去：「高 等 数学」→「高等数学」
      // 注意只吃空格，不能吃换行，否则整段会被糊成一行
      .replace(/([\u4e00-\u9fa5])[ \t\u3000]+(?=[\u4e00-\u9fa5])/g, '$1')
      .replace(/\u0001/g, ' ')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !/^[-_—=·~\s]+$/.test(s))
      .join('\n');
    }

  function openImport() {
    openSheet(
      '<div class="sheet-h"><h3>导入课表</h3><div class="sp"></div>' +
      '<button class="x-btn" data-act="close-sheet">×</button></div>' +
      '<p class="sheet-sub">教务系统导出的课表 PDF 最省事，直接传就行。也可以传一张课表截图，或者把文字贴进来改完再解析。</p>' +
      '<div class="field"><label>粘贴课表文本</label>' +
      '<textarea class="textarea" id="import-text" style="min-height:150px;font-family:var(--mono);font-size:12.5px" ' +
      'placeholder="' + SAMPLE.replace(/"/g, '&quot;').replace(/\n/g, '&#10;') + '"></textarea></div>' +
      '<div id="import-preview" style="font-size:12px;color:var(--muted);min-height:20px"></div>' +
      '<div class="sheet-foot">' +
      '<button class="btn" data-act="pick-import-pdf">传课表 PDF</button>' +
      '<button class="btn" data-act="pick-import-shot">传课表截图</button>' +
      '<button class="btn" id="btn-fill-sample">填入示例</button>' +
      '<button class="btn" id="btn-parse">先解析看看</button>' +
      '<button class="btn btn-primary" id="btn-import-ok" disabled>确认导入</button>' +
      '</div>' +
      '<input type="file" id="import-shot-input" accept="image/*" style="display:none">' +
      '<input type="file" id="import-pdf-input" accept="application/pdf,.pdf" style="display:none">', true
    );

    let parsed = null;
    const textEl = $('#import-text');
    const prevEl = $('#import-preview');
    const okBtn = $('#btn-import-ok');
    const shotBtn = document.querySelector('[data-act="pick-import-shot"]');
    const shotInput = $('#import-shot-input');
    const pdfBtn = document.querySelector('[data-act="pick-import-pdf"]');
    const pdfInput = $('#import-pdf-input');

    function renderPreview(p) {
      parsed = p;
      if (!p || !p.events.length) {
        prevEl.innerHTML = '<span style="color:var(--danger)">没有解析出课程。</span>' +
          (p && p.fromPdf ? '这份 PDF 里可能没有可提取的文字，换「传课表截图」试试。'
                          : '检查一下每行是否包含「周几」。') +
          (p && p.errors && p.errors.length ? '<br>' + U.esc(p.errors[0]) : '');
        okBtn.disabled = true;
        return;
      }
      let html = '<b style="color:var(--ink)">解析出 ' + p.events.length + ' 节课：</b><br>';
      p.events.slice(0, 10).forEach((e) => {
        const wk = (e.weeksFrom === 1 && e.weeksTo === 20) ? ''
          : ' <span style="color:var(--faint)">' + e.weeksFrom + '-' + e.weeksTo + '周</span>';
        html += '· ' + U.weekdayName(e.weekday) + ' ' + e.start + '-' + e.end + ' ' + U.esc(e.name) +
          (e.room ? ' @' + U.esc(e.room) : '') + wk + '<br>';
      });
      if (p.events.length > 10) html += '… 还有 ' + (p.events.length - 10) + ' 节';
      if (p.errors && p.errors.length) {
        html += '<br><span style="color:var(--warn)">' + p.errors.length + ' 处没识别出来：' + U.esc(p.errors[0]) + '</span>';
      }
      if (p.ignored && p.ignored.length) {
        html += '<br><span style="color:var(--faint)">另有 ' + p.ignored.length + ' 行是标题/表头，已自动忽略</span>';
      }
      prevEl.innerHTML = html;
      okBtn.disabled = false;
    }

    $('#btn-fill-sample').onclick = function () { textEl.value = SAMPLE; textEl.focus(); };

    shotBtn.onclick = function () { shotInput.click(); };

    /* ---------- 传课表 PDF ----------
       教务系统的课表把「星期几」编码成了列位置，纯文字里没有，
       所以走 Docs.pdfLayout 拿到每块的坐标，交给 Timetable.parseGrid 按列切。 */
    pdfBtn.onclick = function () { pdfInput.click(); };

    pdfInput.onchange = async function () {
      const file = pdfInput.files && pdfInput.files[0];
      if (!file) return;
      pdfBtn.disabled = true;
      okBtn.disabled = true;
      prevEl.textContent = '正在读 PDF…';
      try {
        const layout = await Docs.pdfLayout(file, function (done, total) {
          prevEl.textContent = '正在读 PDF：第 ' + done + '/' + total + ' 页';
        });

        let p = Timetable.parseGrid(layout.pages);
        let how = p.events.length ? 'pdf' : '';

        // 没有表格结构（比如导出成一整段文字），退回按行解析
        if (!how) {
          const doc = await Docs.readPdf(file);
          const txt = doc.pages.map(function (pg) {
            return (pg.title ? pg.title + '\n' : '') + pg.lines.join('\n');
          }).join('\n');
          const p2 = Timetable.parse(txt);
          if (p2.events.length) { p = p2; how = 'text'; }
        }

        // 还是不行：多半是扫描件，把前几页画成图走本地识别
        if (!how) {
          prevEl.innerHTML = '这份 PDF 里没有文字层（扫描件），正在转成图片识别…';
          const blobs = await Docs.pdfPagesToBlobs(file, 3);
          for (const b of blobs) {
            const t = await Media.OCR.recognize(b.blob, function (st, pr) {
              prevEl.textContent = '识别第 ' + b.no + ' 页：' + st + ' ' + Math.round((pr || 0) * 100) + '%';
            });
            const p3 = Timetable.parse(normalizeOcrText(t));
            if (p3.events.length) { p = p3; how = 'ocr'; break; }
          }
        }

        if (!how) {
          renderPreview({ events: [], errors: [], ignored: [], fromPdf: true });
          return;
        }

        p.fromPdf = (how === 'pdf');
        if (how === 'pdf') {
          prevEl.innerHTML = '<span style="color:var(--faint)">PDF 里的课表已按表格直接解析，不用再点「先解析看看」。</span>';
        }
        renderPreview(p);
      } catch (e) {
        prevEl.innerHTML = '<span style="color:var(--danger)">读不了这份 PDF：' + U.esc((e && e.message) || e) +
          '</span>。如果它是加密的，先在教务系统里重新导出一次。';
        okBtn.disabled = true;
      } finally {
        pdfBtn.disabled = false;
        pdfInput.value = '';
      }
    };

    shotInput.onchange = async function () {
      const file = shotInput.files && shotInput.files[0];
      if (!file) return;
      shotBtn.disabled = true;
      prevEl.innerHTML = '正在启动识别引擎…（首次要下载中文模型，约 10MB，之后走缓存）';
      try {
        const text = await Media.OCR.recognize(file, function (status, prog) {
          const pct = Math.round((prog || 0) * 100);
          prevEl.innerHTML = '识别中：' + U.esc(status) + ' ' + pct + '%';
        });
        const clean = normalizeOcrText(text);
        textEl.value = clean;
        prevEl.innerHTML = clean
          ? '<span style="color:var(--ok)">识别完成，' + clean.split('\n').filter(Boolean).length +
            ' 行文字已填进上方。先核对一下再点「先解析看看」。</span>'
          : '<span style="color:var(--warn)">没识别出文字。换一张更清楚的截图试试。</span>';
      } catch (e) {
        prevEl.innerHTML = '<span style="color:var(--danger)">识别失败：' + U.esc(e.message) +
          '。网络不稳定时会这样，可以改为手动粘贴文字。</span>';
      } finally {
        shotBtn.disabled = false;
        shotInput.value = '';
      }
    };

    $('#btn-parse').onclick = function () {
      // PDF 已经按表格解析过了，文本框是空的，别把好结果冲掉
      if (!textEl.value.trim() && parsed && parsed.fromPdf) {
        renderPreview(parsed);
        return;
      }
      renderPreview(Timetable.parse(textEl.value));
    };

    okBtn.onclick = async function () {
      if (!parsed) return;
      okBtn.disabled = true;
      okBtn.textContent = '导入中…';
      try {
        const r = await Timetable.persist(parsed);
        await refresh();
        closeSheet();
        toast('已导入 ' + r.added + ' 节课' + (r.skipped ? '，跳过重复 ' + r.skipped + ' 节' : ''));
        go('/schedule');
      } catch (e) {
        toast('导入失败：' + e.message, true);
        okBtn.disabled = false;
        okBtn.textContent = '确认导入';
      }
    };
  }

  /* ---------- 首次启动引导：让它从空壳变成能用的工具 ---------- */
  function maybeOnboard() {
    if (localStorage.getItem('lz_onboard')) return;
    if (S.events.length || S.notes.length) return;
    localStorage.setItem('lz_onboard', '1');

    openSheet(
      '<div class="sheet-h"><h3>三步开始用</h3><div class="sp"></div>' +
      '<button class="x-btn" data-act="close-sheet">×</button></div>' +
      '<p class="sheet-sub">落字不需要注册。所有东西都存在这台设备上，关掉浏览器也还在。</p>' +
      '<div class="field"><label>① 开学日（用来算现在是第几周）</label>' +
      '<input class="input" type="date" id="ob-start" value="' + U.today() + '"></div>' +
      '<div class="field"><label>学期总周数</label>' +
      '<input class="input" type="number" id="ob-weeks" min="1" max="30" value="20"></div>' +
      '<div class="field"><label>② 课表（可以贴文字，也可以传课表截图）</label>' +
      '<button class="btn" id="ob-import" style="width:100%">去导入课表</button></div>' +
      '<div class="field"><label>③ 上课时随手记</label>' +
      '<div style="font-size:12px;color:var(--muted);line-height:1.8">拍照只拍板书，录音只录听不懂的那段。' +
      '速记先扔进收件箱，课后有空的再整理成笔记。</div></div>' +
      '<div class="sheet-foot">' +
      '<button class="btn btn-ghost" data-act="close-sheet">先随便看看</button>' +
      '<button class="btn btn-primary" id="ob-save">保存并开始</button></div>'
    );

    $('#ob-save').onclick = async function () {
      const start = $('#ob-start').value || '';
      const weeks = Math.max(1, Math.min(30, parseInt($('#ob-weeks').value, 10) || 20));
      S.settings.semesterStart = start;
      S.settings.totalWeeks = weeks;
      await Settings.set('semesterStart', start);
      await Settings.set('totalWeeks', weeks);
      closeSheet();
      toast('已记下，第 ' + U.weekOf(start, weeks).week + ' 周');
      render();
    };
    $('#ob-import').onclick = function () { closeSheet(); openImport(); };
  }

  function openAddEvent() {
    const opts = S.courses.map((c) => '<option value="' + c.id + '">' + U.esc(c.name) + '</option>').join('');
    openSheet(
      '<div class="sheet-h"><h3>手动加一节课</h3><div class="sp"></div>' +
      '<button class="x-btn" data-act="close-sheet">×</button></div>' +
      '<div class="field"><label>课程名</label><input class="input" id="ae-name" placeholder="高等数学"></div>' +
      '<div class="field"><label>星期</label><select class="select" id="ae-wd">' +
      [1, 2, 3, 4, 5, 6, 7].map((i) => '<option value="' + i + '">' + U.weekdayName(i) + '</option>').join('') +
      '</select></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
      '<div class="field"><label>开始</label><input class="input" type="time" id="ae-start" value="08:00"></div>' +
      '<div class="field"><label>结束</label><input class="input" type="time" id="ae-end" value="09:40"></div>' +
      '</div>' +
      '<div class="field"><label>教室</label><input class="input" id="ae-room" placeholder="A301"></div>' +
      '<div class="sheet-foot"><button class="btn" data-act="close-sheet">取消</button>' +
      '<button class="btn btn-primary" id="ae-ok">添加</button></div>'
    );
    $('#ae-ok').onclick = async function () {
      const name = $('#ae-name').value.trim();
      if (!name) { toast('先填课程名', true); return; }
      let course = S.courses.filter((c) => c.name === name)[0];
      if (!course) {
        course = { id: DB.uid(), name: name, color: U.courseColor(name), room: $('#ae-room').value.trim(), createdAt: U.nowISO() };
        await DB.put('courses', course);
      }
      await DB.put('events', {
        id: DB.uid(),
        courseId: course.id,
        courseName: course.name,
        weekday: +$('#ae-wd').value,
        start: $('#ae-start').value || '08:00',
        end: $('#ae-end').value || '09:40',
        room: $('#ae-room').value.trim(),
        weeksFrom: 1,
        weeksTo: S.settings.totalWeeks || 20,
        createdAt: U.nowISO()
      });
      await refresh();
      closeSheet();
      toast('已添加');
      render();
    };
  }

  /* ================= 动作：速记 ================= */
  /**
   * 挑图片。
   * capture=true 时带 capture 属性，系统直接拉相机（现拍）；
   * capture=false 时走系统文件选择器（相册里已有的照片）。
   * 这两个入口在安卓上没法合成一个：带了 capture 就进不去相册，
   * 不带则安全选择器里根本没有相机，所以在手机上先让用户选一下。
   */
  function pickPhotos(useCamera) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (useCamera) input.setAttribute('capture', 'environment');
    else input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('blur', function () { setTimeout(function () { input.remove(); }, 1000); });
    input.onchange = async function () {
      if (!input.files || !input.files.length) return;
      toast('处理图片中…');
      const note = await createNote({ kind: 'capture', title: '' });
      let n = 0;
      for (const f of Array.from(input.files)) {
        try {
          const c = await Media.compressImage(f, 1600, 0.82);
          await addAsset(note.id, c.blob, 'image', { name: f.name || '图片', width: c.width, height: c.height });
          n++;
        } catch (e) { toast('有一张处理失败：' + e.message, true); }
      }
      await refresh();
      if (n) { toast('已存入 ' + n + ' 张图片'); go('/note/' + note.id); }
      else { await deleteNote(note.id); }
    };
    input.click();
  }

  /** 触摸屏（手机 / 平板 / 安卓壳）上先问一句：现拍还是从相册选 */
  function prefersSheetPicker() {
    if (IS_NATIVE) return true;
    return window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  }

  function base64ToBlob(b64, mime) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime || 'image/jpeg' });
  }

  /**
   * 现拍。
   * 安卓壳里叫原生相机（input[capture] 在 WebView 上不生效，实测点了还是弹相册）；
   * 浏览器里没这个插件，退回 capture 属性那条路。
   */
  async function takeShot() {
    const cap = window.Capacitor;
    const plugin = cap && cap.Plugins && cap.Plugins.LuoziCamera;
    if (!plugin) { pickPhotos(true); return; }

    let r;
    try {
      r = await plugin.takePhoto();
    } catch (e) {
      toast('打不开相机：' + ((e && e.message) || e), true);
      return;
    }
    if (!r || r.cancelled || !r.data) return;   // 用户取消了

    toast('处理图片中…');
    const note = await createNote({ kind: 'capture', title: '' });
    try {
      const c = await Media.compressImage(base64ToBlob(r.data, r.mime), 1600, 0.82);
      await addAsset(note.id, c.blob, 'image', { name: '拍照', width: c.width, height: c.height });
      await refresh();
      toast('已存入 1 张图片');
      go('/note/' + note.id);
    } catch (e) {
      await deleteNote(note.id);
      toast('这张没处理好：' + e.message, true);
    }
  }

  async function capturePhoto() {
    if (prefersSheetPicker()) {
      openSheet(
        '<div class="sheet-h"><h3>拍照速记</h3><div class="sp"></div>' +
        '<button class="x-btn" data-act="close-sheet">×</button></div>' +
        '<p class="sheet-sub">板书、PPT、课本都行，一次可以选好几张。</p>' +
        '<div class="rec-actions">' +
        '<button class="btn btn-primary" id="pick-camera">现拍一张</button>' +
        '<button class="btn" id="pick-gallery">从相册选</button>' +
        '</div>'
      );
      $('#pick-camera').onclick = function () { closeSheet(); takeShot(); };
      $('#pick-gallery').onclick = function () { closeSheet(); pickPhotos(false); };
      return;
    }
    // 桌面端无所谓，直接开文件选择框
    pickPhotos(false);
  }

  async function captureText() {
    const note = await createNote({ kind: 'capture', title: '' });
    go('/note/' + note.id);
    setTimeout(() => { const t = $('#ed-body-input'); if (t) t.focus(); }, 120);
  }

  function openRecorder(targetNoteId) {
    if (!Media.Recorder.supported()) {
      toast('这个浏览器不支持录音', true);
      return;
    }
    if (S.rec) { toast('已经在录音了'); return; }

    openSheet(
      '<div class="sheet-h"><h3>录音</h3><div class="sp"></div>' +
      '<button class="x-btn" data-act="close-sheet">×</button></div>' +
      '<p class="sheet-sub">录音前请获得老师或参与者同意。音频只存在这台设备上。</p>' +
      '<div class="rec-panel">' +
      '<div class="rec-time" id="rec-time">00:00</div>' +
      '<div class="wave" id="rec-wave"></div>' +
      '<div class="rec-actions">' +
      '<button class="btn btn-primary" id="rec-toggle">开始录音</button>' +
      '<button class="btn" id="rec-pause" disabled>暂停</button>' +
      '<button class="btn" id="rec-cancel" disabled>取消</button>' +
      '</div>' +
      '<div id="rec-status" style="font-size:12px;color:var(--muted)"></div>' +
      '</div>'
    );

    const waveEl = $('#rec-wave');
    const bars = 42;
    waveEl.innerHTML = new Array(bars).fill('<i></i>').join('');
    const barEls = $$('i', waveEl);

    const rec = new Media.Recorder(function (level, sec) {
      const t = $('#rec-time');
      if (t) t.textContent = Media.fmtTime(sec);
      const idx = Math.floor(Math.random() * bars);
      // 人说话的电平通常只有 0.05~0.3，直接线性映射出来几乎是条平线，
      // 这里先放大再开方，让小的起伏也能看出来
      const boosted = Math.min(1, level * 5);
      const h = 3 + Math.round(Math.pow(boosted, 0.65) * 52);
      if (barEls[idx]) barEls[idx].style.height = h + 'px';
      barEls.forEach((b, i) => {
        if (i === idx) return;                    // 刚抬起来那根别马上压回去
        const cur = parseFloat(b.style.height) || 3;
        b.style.height = Math.max(3, cur * 0.92) + 'px';
      });
    });
    S.rec = rec;

    $('#rec-toggle').onclick = async function () {
      const btn = this;
      if (rec.state === 'idle') {
        try {
          await rec.start();
          btn.textContent = '停止并保存';
          $('#rec-pause').disabled = false;
          $('#rec-cancel').disabled = false;
          $('#rec-status').innerHTML = '<span class="rec-dot" style="display:inline-block;vertical-align:middle"></span> 录音中';
        } catch (e) {
          toast('无法开始录音：' + e.message, true);
        }
      } else {
        btn.disabled = true;
        btn.textContent = '保存中…';
        try {
          const r = await rec.stop();
          S.rec = null;
          closeSheet();
          await afterRecord(r, targetNoteId);
        } catch (e) {
          toast('保存失败：' + e.message, true);
          S.rec = null;
        }
      }
    };

    $('#rec-pause').onclick = function () {
      if (rec.state === 'recording') { rec.pause(); this.textContent = '继续'; $('#rec-status').textContent = '已暂停'; }
      else if (rec.state === 'paused') { rec.resume(); this.textContent = '暂停'; $('#rec-status').textContent = '录音中'; }
    };

    $('#rec-cancel').onclick = function () {
      rec.cancel();
      S.rec = null;
      closeSheet();
      toast('已取消录音');
    };
  }

  async function afterRecord(result, targetNoteId) {
    let note = targetNoteId ? S.notes.filter((n) => n.id === targetNoteId)[0] : null;
    if (!note) note = await createNote({ kind: 'capture', title: '' });

    const asset = await addAsset(note.id, result.blob, 'audio', {
      name: '录音 ' + Media.fmtTime(result.duration),
      duration: result.duration
    });
    await refresh();
    toast('录音已保存 · ' + Media.fmtTime(result.duration));
    go('/note/' + note.id);
    setTimeout(() => { askTranscribe(asset.id); }, 400);
  }

  /* ================= 动作：转写 ================= */
  async function askTranscribe(assetId) {
    const asset = S.assets.filter((a) => a.id === assetId)[0];
    if (!asset) return;

    openSheet(
      '<div class="sheet-h"><h3>转成文字</h3><div class="sp"></div>' +
      '<button class="x-btn" data-act="close-sheet">×</button></div>' +
      '<p class="sheet-sub">选择一种方式。音频不会离开这台设备，除非你选了自建接口。</p>' +
      '<div class="list">' +
      '<button class="row" data-act="asr-browser" data-id="' + assetId + '">' +
      '<div class="thumb">⌨</div><div class="body"><div class="title">浏览器内置识别</div>' +
      '<div class="sub">免费，实时。依赖浏览器厂商的语音服务，Chrome 需要联网，国内可能不可用。</div></div></button>' +
      '<button class="row" data-act="asr-custom" data-id="' + assetId + '">' +
      '<div class="thumb">☁</div><div class="body"><div class="title">自建 / Whisper 接口</div>' +
      '<div class="sub">把音频传给设置里填的接口，返回文字。准确度高，需要先配置。</div></div></button>' +
      '</div>'
    );
  }

  async function transcribeBrowser(assetId) {
    if (!Media.BrowserASR.supported()) {
      toast('这个浏览器不支持内置语音识别，试试 Chrome 或 Edge', true);
      return;
    }
    openSheet(
      '<div class="sheet-h"><h3>听写中</h3><div class="sp"></div>' +
      '<button class="x-btn" data-act="close-sheet">×</button></div>' +
      '<p class="sheet-sub">用麦克风实时听写。想转写已录好的音频文件，请用自建接口。</p>' +
      '<div class="transcript-box" id="live-text">等待说话…</div>' +
      '<div class="sheet-foot"><button class="btn btn-primary" id="asr-stop">停止并保存</button></div>'
    );

    const box = $('#live-text');
    let finalText = '';
    let ctrl;
    try {
      ctrl = Media.BrowserASR.start({
        lang: 'zh-CN',
        onText: function (f, interim) {
          finalText = f;
          box.innerHTML = U.esc(f) + (interim ? '<span style="opacity:.5">' + U.esc(interim) + '</span>' : '');
          box.scrollTop = box.scrollHeight;
        },
        onError: function (err) {
          toast('识别出错：' + err + '（国内网络下 Chrome 的语音服务常不可用）', true);
        }
      });
    } catch (e) {
      toast(e.message, true);
      return;
    }

    $('#asr-stop').onclick = async function () {
      ctrl.stop();
      if (!finalText.trim()) { toast('没有识别到内容'); closeSheet(); return; }
      await saveTranscript(assetId, finalText.trim(), 'browser');
      closeSheet();
    };
  }

  async function transcribeCustom(assetId) {
    const st = S.settings;
    if (!st.asrBaseUrl) {
      toast('先到设置里填转写接口地址', true);
      go('/settings');
      return;
    }
    const asset = S.assets.filter((a) => a.id === assetId)[0];
    const blobRow = await DB.get('blobs', assetId);
    if (!blobRow || !blobRow.data) { toast('找不到音频文件', true); return; }

    openSheet(
      '<div class="sheet-h"><h3>上传转写</h3><div class="sp"></div></div>' +
      '<p class="sheet-sub" id="cs-status">准备中…</p>' +
      '<div class="transcript-box" id="cs-result" style="display:none"></div>'
    );

    try {
      const text = await Media.CustomASR.transcribe(blobRow.data, {
        baseUrl: st.asrBaseUrl,
        apiKey: st.asrApiKey,
        model: st.asrModel,
        language: 'zh'
      }, function (msg) { const el = $('#cs-status'); if (el) el.textContent = msg; });

      if (!text || !text.trim()) throw new Error('接口返回了空内容');
      await saveTranscript(assetId, text.trim(), 'custom');
      const box = $('#cs-result');
      if (box) { box.style.display = 'block'; box.textContent = text.trim(); }
      toast('转写完成');
      setTimeout(closeSheet, 900);
    } catch (e) {
      const el = $('#cs-status');
      if (el) el.innerHTML = '<span style="color:var(--danger)">转写失败：' + U.esc(e.message) + '</span>';
      toast('转写失败', true);
    }
  }

  async function saveTranscript(assetId, text, engine) {
    const asset = S.assets.filter((a) => a.id === assetId)[0];
    const noteId = asset ? asset.noteId : '';
    await DB.put('transcripts', {
      id: DB.uid(),
      assetId: assetId,
      noteId: noteId,
      text: text,
      engine: engine,
      createdAt: U.nowISO()
    });
    await refresh();

    // 把文字追加进笔记正文
    if (noteId) {
      const note = S.notes.filter((n) => n.id === noteId)[0];
      if (note) {
        const block = '\n\n### 转写 · ' + U.fmtDate(U.nowISO()) + '\n\n' + text + '\n';
        note.body = (note.body || '') + block;
        await saveNote(note);
        if (S.route === 'editor' && S.currentNote && S.currentNote.id === noteId) {
          const input = $('#ed-body-input');
          if (input) {
            input.value = note.body;
            $('#ed-preview').innerHTML = MD.render(note.body);
          }
        }
      }
    }
    toast('文字已并入笔记');
  }

  /* ================= 动作：OCR ================= */
  async function runOCR(assetId) {
    const asset = S.assets.filter((a) => a.id === assetId)[0];
    if (!asset) return;

    openSheet(
      '<div class="sheet-h"><h3>识别图片文字</h3><div class="sp"></div>' +
      '<button class="x-btn" data-act="close-sheet">×</button></div>' +
      '<p class="sheet-sub" id="ocr-status">加载本地识别引擎（首次约 10MB，之后走缓存，不再下载）…</p>' +
      '<div class="transcript-box" id="ocr-text" style="min-height:120px">—</div>' +
      '<div class="sheet-foot"><button class="btn" data-act="close-sheet">关闭</button>' +
      '<button class="btn btn-primary" id="ocr-append" disabled>追加到笔记</button></div>'
    );

    try {
      const blobRow = await DB.get('blobs', assetId);
      if (!blobRow || !blobRow.data) throw new Error('找不到图片');
      const raw = await Media.OCR.recognize(blobRow.data, function (status, prog) {
        const el = $('#ocr-status');
        if (el) el.textContent = (status === 'recognizing text' ? '正在识别' : status) + ' ' + Math.round((prog || 0) * 100) + '%';
      });
      const text = normalizeOcrText(raw);
      const el = $('#ocr-status');
      if (el) el.textContent = text ? '识别完成，共 ' + text.length + ' 字' : '没有识别到文字';
      $('#ocr-text').textContent = text || '（空）';
      if (text) {
        const btn = $('#ocr-append');
        btn.disabled = false;
        btn.onclick = async function () {
          const note = S.notes.filter((n) => n.id === asset.noteId)[0];
          if (!note) { toast('这张图还没挂在笔记上', true); return; }
          note.body = (note.body || '') + '\n\n### 图片识别\n\n' + text + '\n';
          await saveNote(note);
          closeSheet();
          toast('已追加');
          if (S.route === 'editor') render();
        };
      }
    } catch (e) {
      const el = $('#ocr-status');
      if (el) el.innerHTML = '<span style="color:var(--danger)">' + U.esc(e.message) + '</span>';
    }
  }

  /* ================= 动作：导出 ================= */
  function safeName(s) {
    return String(s || '未命名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  }

  async function exportNote(note) {
    const assets = S.assets.filter((a) => a.noteId === note.id);
    const transcripts = S.transcripts.filter((t) => t.noteId === note.id);
    let md = '# ' + (note.title || '未命名') + '\n\n';
    md += '> 创建于 ' + U.fmtDate(note.createdAt) + ' · 更新于 ' + U.fmtDate(note.updatedAt) + '\n\n';
    md += note.body || '';
    if (transcripts.length) {
      md += '\n\n---\n\n## 转写原文\n\n';
      transcripts.forEach((t) => { md += t.text + '\n\n'; });
    }
    if (assets.length) {
      md += '\n---\n\n## 附件\n\n';
      assets.forEach((a) => { md += '- ' + a.kind + ' · ' + a.name + '\n'; });
    }
    U.download(new Blob([md], { type: 'text/markdown;charset=utf-8' }), safeName(note.title) + '.md');
    toast('已导出 Markdown');
  }

  async function exportAll() {
    const notes = S.notes;
    if (!notes.length) { toast('还没有笔记'); return; }
    toast('打包中…');
    const enc = new TextEncoder();
    const files = [];
    const used = {};

    for (const n of notes) {
      let base = safeName(n.title || '未命名');
      if (used[base]) { used[base]++; base = base + '-' + used[base]; } else { used[base] = 1; }

      let md = '# ' + (n.title || '未命名') + '\n\n';
      md += '> 创建于 ' + U.fmtDate(n.createdAt) + ' · 更新于 ' + U.fmtDate(n.updatedAt) + '\n\n';
      md += n.body || '';
      if (n.kind === 'capture') md = '> 收件箱速记\n\n' + md;

      files.push({ name: base + '.md', data: enc.encode(md) });

      // 把图片附件一起打进去
      const imgs = S.assets.filter((a) => a.noteId === n.id && a.kind === 'image');
      for (let i = 0; i < imgs.length; i++) {
        const row = await DB.get('blobs', imgs[i].id);
        if (row && row.data) {
          const buf = new Uint8Array(await row.data.arrayBuffer());
          files.push({ name: 'attachments/' + base + '-' + (i + 1) + '.jpg', data: buf });
        }
      }
    }

    const manifest = {
      app: 'luozi',
      exportedAt: U.nowISO(),
      count: notes.length,
      note: '由落字 v1.0.0 导出。Markdown 可直接放进 Obsidian 库。'
    };
    files.push({ name: '落字导出说明.json', data: enc.encode(JSON.stringify(manifest, null, 2)) });

    const blob = Zip.build(files);
    U.download(blob, '落字导出-' + U.today() + '.zip');
    toast('已导出 ' + notes.length + ' 篇笔记');
  }

  async function exportJSON() {
    const data = await DB.dump();
    const blobRowCount = await DB.count('blobs');
    data.blobsCount = blobRowCount;
    U.download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      '落字备份-' + U.today() + '.json');
    toast('已导出 JSON 备份（不含音频与图片二进制）');
  }

  function importJSON() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = function () {
      const f = input.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = async function () {
        try {
          const data = JSON.parse(fr.result);
          const n = await DB.restore(data);
          await refresh();
          toast('已恢复 ' + n + ' 条记录');
          render();
        } catch (e) {
          toast('恢复失败：' + e.message, true);
        }
      };
      fr.readAsText(f);
    };
    input.click();
  }

  /* ================= 动作：分享 ================= */
  async function shareNote(note) {
    const code = await Share.encode({
      t: note.title || '未命名',
      b: note.body || '',
      at: U.nowISO(),
      app: 'luozi'
    });
    const url = location.origin + location.pathname + '#/import?d=' + code;
    try {
      await navigator.clipboard.writeText(url);
      toast('分享链接已复制（' + url.length + ' 字符）');
    } catch (e) {
      openSheet(
        '<div class="sheet-h"><h3>分享链接</h3><div class="sp"></div>' +
        '<button class="x-btn" data-act="close-sheet">×</button></div>' +
        '<p class="sheet-sub">复制下面这段。对方打开后会看到这篇笔记的内容。</p>' +
        '<textarea class="textarea" style="font-family:var(--mono);font-size:11px;min-height:120px" readonly>' +
        U.esc(url) + '</textarea>'
      );
    }
  }

  /** 正文第一行如果是和标题同名的小标题，就别在卡片上重复一遍 */
  function stripDupTitle(body, title) {
    const t = String(title || '').trim();
    if (!t) return body;
    return String(body || '').replace(/^\s*#{1,3}[ \t]+(.+?)[ \t]*\r?\n/, function (m, h) {
      return h.trim() === t ? '' : m;
    });
  }

  /** 分享接收页：先给一张只读卡片让人看清内容，愿意才存进自己的笔记 */
  async function handleImport() {
    const d = S.params.d;
    if (!d) { go('/notes'); return; }
    document.body.classList.add('share-mode');

    let payload;
    try {
      payload = await Share.decode(d);
    } catch (e) {
      renderShareError('分享内容解析失败：' + e.message + '。链接可能被聊天软件截断了，让对方重新复制完整的链接。');
      return;
    }

    const title = payload.t || '分享的笔记';
    const body = payload.b || '';
    const at = payload.at ? U.fmtDate(payload.at) : '';
    const chars = body.length;
    const wrap = $('#view-wrap');

    wrap.innerHTML =
      '<div class="share-page">' +
        '<div class="share-brand"><span class="brand-mark">落</span><span>落字 · 收到一篇分享笔记</span></div>' +
        '<article class="share-card">' +
          '<h1>' + U.esc(title) + '</h1>' +
          '<div class="share-meta">' + (at ? at + ' · ' : '') + chars + ' 字</div>' +
          '<div class="md-preview share-body" id="share-body"></div>' +
        '</article>' +
        '<div class="share-actions">' +
          '<button class="btn btn-primary" id="share-save">保存到我的笔记</button>' +
          '<button class="btn btn-ghost" id="share-cancel">只看不存，进我的落字</button>' +
        '</div>' +
        '<p class="share-tip">保存后会存进本机浏览器（IndexedDB），不会上传到任何服务器。</p>' +
      '</div>';

    $('#share-body').innerHTML = MD.render(stripDupTitle(body, title));
    try { MathRender.apply($('#share-body')); } catch (e) {}

    $('#share-save').onclick = async function () {
      this.disabled = true;
      this.textContent = '保存中…';
      try {
        const note = await createNote({
          title: title,
          body: body + '\n\n---\n\n> 他人分享 · ' + (payload.at || U.nowISO()),
          kind: 'note'
        });
        document.body.classList.remove('share-mode');
        toast('已保存到笔记');
        go('/note/' + note.id);
      } catch (e) {
        toast('保存失败：' + e.message, true);
        this.disabled = false;
        this.textContent = '保存到我的笔记';
      }
    };
    $('#share-cancel').onclick = function () {
      document.body.classList.remove('share-mode');
      history.replaceState(null, '', '#/notes');
      go('/notes');
    };
    stage('shared');
  }

  function renderShareError(msg) {
    document.body.classList.add('share-mode');
    $('#view-wrap').innerHTML =
      '<div class="share-page"><div class="share-brand"><span class="brand-mark">落</span><span>落字</span></div>' +
      '<div class="share-card"><h1>链接打不开</h1><p style="color:var(--muted);line-height:1.8">' +
      U.esc(msg) + '</p></div>' +
      '<div class="share-actions"><button class="btn btn-primary" data-act="leave-share">进我的落字</button></div></div>';
    const btn = $('[data-act="leave-share"]');
    if (btn) btn.onclick = function () {
      document.body.classList.remove('share-mode');
      history.replaceState(null, '', '#/notes');
      go('/notes');
    };
  }

  /* ================= PWA ================= */
  let deferredPrompt = null;

  /** 跑在 Electron 桌面壳里（exe / dmg）的时候，安装那条路就是多余的 */
  const IS_DESKTOP = /Electron\//.test(navigator.userAgent) ||
    (location.protocol === 'luozi:' && !/^https?:/.test(location.protocol));

  /** 跑在 Capacitor 原生壳里（安卓 apk / 以后的 iOS） */
  const IS_NATIVE = !!(window.Capacitor &&
    typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform());

  /** 已经是一个独立安装的应用（桌面壳 / 原生壳 / PWA 装好后） */
  const IS_APP = IS_DESKTOP || IS_NATIVE;

  function isStandalone() {
    return IS_APP ||
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
  }

  /** 127.0.0.1 也算安全上下文，别把它判成 http */
  function isSecureCtx() {
    return window.isSecureContext === true ||
      location.protocol === 'https:' ||
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1' ||
      location.hostname === '[::1]';
  }

  function setupInstall() {
    // 桌面版（exe / dmg）和安卓版本身就是装好的应用，安装卡片直接收起来
    if (IS_APP) {
      const card = $('#install-card');
      if (card) card.style.display = 'none';
      return;
    }
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      const card = $('#install-card');
      if (card) card.style.display = 'block';
    });

    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      toast('已安装到桌面');
      Settings.set('installedAt', U.nowISO());
      const card = $('#install-card');
      if (card) card.style.display = 'none';
    });

    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    if (isIOS) {
      $('#install-hint').textContent = '用 Safari 的分享按钮，选「添加到主屏幕」。';
      $('#btn-install').textContent = '看步骤';
    } else if (!deferredPrompt) {
      $('#install-hint').textContent = '用 Chrome / Edge 打开，地址栏右侧会出现安装图标。';
      $('#btn-install').textContent = '检查安装条件';
    }

    $('#btn-install').onclick = async function () {
      if (isStandalone()) { toast('已经在独立窗口里运行了'); return; }
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const r = await deferredPrompt.userChoice;
        if (r.outcome === 'accepted') toast('正在安装…');
        deferredPrompt = null;
        return;
      }
      if (isIOS) {
        openSheet(
          '<div class="sheet-h"><h3>在 iPhone 上安装</h3><div class="sp"></div>' +
          '<button class="x-btn" data-act="close-sheet">×</button></div>' +
          '<div class="list">' +
          '<div class="row" style="cursor:default"><div class="thumb">1</div><div class="body"><div class="title">用 Safari 打开这个页面</div></div></div>' +
          '<div class="row" style="cursor:default"><div class="thumb">2</div><div class="body"><div class="title">点底部的分享按钮</div><div class="sub">方框里一个向上的箭头</div></div></div>' +
          '<div class="row" style="cursor:default"><div class="thumb">3</div><div class="body"><div class="title">选「添加到主屏幕」</div></div></div>' +
          '</div>'
        );
        return;
      }
      const secure = isSecureCtx();
      openSheet(
        '<div class="sheet-h"><h3>安装条件</h3><div class="sp"></div>' +
        '<button class="x-btn" data-act="close-sheet">×</button></div>' +
        '<p class="sheet-sub">浏览器现在没给出安装入口，通常是下面某一条没满足。</p>' +
        '<div class="list">' +
        '<div class="row" style="cursor:default"><div class="thumb">' + (secure ? '✓' : '×') + '</div>' +
        '<div class="body"><div class="title">HTTPS 或本机地址</div><div class="sub">' +
        (secure
          ? '当前 ' + U.esc(location.protocol + '//' + location.host) + '，可以安装'
          : '当前是 http，除 localhost / 127.0.0.1 外的 http 地址不能安装') +
        '</div></div></div>' +
        '<div class="row" style="cursor:default"><div class="thumb">' + (navigator.serviceWorker ? '✓' : '×') + '</div>' +
        '<div class="body"><div class="title">浏览器支持 Service Worker</div></div></div>' +
        '<div class="row" style="cursor:default"><div class="thumb">i</div>' +
        '<div class="body"><div class="title">用 Chrome / Edge 打开</div><div class="sub">Safari 在 Mac 上不支持安装 PWA</div></div></div>' +
        '</div>'
      );
    };
  }

  function registerSW() {
    // 桌面版 / 安卓版资源就在安装包里，Service Worker 是多余的；
    // 而且 Capacitor 的 https://localhost 下注册 SW 只在个别版本可用，徒增噪音。
    if (IS_APP) return;
    if (!('serviceWorker' in navigator)) return;
    if (!isSecureCtx()) {
      console.warn('[落字] 非安全上下文，Service Worker 不可用，离线与安装会被跳过');
      return;
    }
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    }).catch(function (e) {
      console.warn('[落字] Service Worker 注册失败', e);
    });
  }

  /* ================= 全局事件 ================= */
  function bindGlobal() {
    document.addEventListener('click', async function (e) {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.dataset.act;

      // 通用
      if (act === 'close-sheet') { closeSheet(); return; }
      if (act === 'go') { go(el.dataset.path || '/today'); return; }

      switch (act) {
        case 'open-note': {
          const id = el.dataset.id;
          if (!id) { toast('这篇笔记还没创建'); return; }
          await flushSave();
          go('/note/' + id);
          break;
        }
        case 'new-note': {
          await flushSave();
          draft = null;
          go('/note/new');
          break;
        }
        case 'quick-capture': captureText(); break;
        case 'capture-photo': capturePhoto(); break;
        case 'capture-text': captureText(); break;
        case 'capture-audio': openRecorder(); break;
        case 'open-import': openImport(); break;
        case 'import-doc': importDoc(); break;
        case 'toggle-flag': await toggleFlag(); break;
        case 'flag-off': await clearFlag(el.dataset.id); break;
        case 'open-doc': await openDocAsset(el.dataset.id); break;
        case 'open-add-event': openAddEvent(); break;
        case 'try-sample': {
          openSheet(
            '<div class="sheet-h"><h3>课表文本示例</h3><div class="sp"></div>' +
            '<button class="x-btn" data-act="close-sheet">×</button></div>' +
            '<p class="sheet-sub">每行一节课。复制这段，改成你自己的课表。</p>' +
            '<pre class="transcript-box" style="font-size:12px">' + U.esc(SAMPLE) + '</pre>' +
            '<div class="sheet-foot"><button class="btn" data-act="copy-sample">复制</button>' +
            '<button class="btn btn-primary" data-act="open-import">去导入</button></div>'
          );
          break;
        }
        case 'copy-sample': {
          try { await navigator.clipboard.writeText(SAMPLE); toast('已复制'); }
          catch (err) { toast('复制失败，手动选中吧', true); }
          break;
        }
        case 'note-from-event': {
          const ev = S.events.filter((x) => x.id === el.dataset.id)[0];
          if (!ev) return;
          const existing = S.notes.filter((n) => n.courseId === ev.courseId &&
            (n.createdAt || '').slice(0, 10) === U.today() && n.kind !== 'capture')[0];
          if (existing) { go('/note/' + existing.id); return; }
          const note = await createNote({
            title: ev.courseName + ' · ' + U.today().slice(5).replace('-', '/'),
            courseId: ev.courseId,
            kind: 'note',
            body: '### ' + ev.courseName + '\n\n' + ev.start + '-' + ev.end + ' · ' + (ev.room || '') + '\n\n'
          });
          go('/note/' + note.id);
          break;
        }
        case 'event-detail': {
          const ev = S.events.filter((x) => x.id === el.dataset.id)[0];
          if (!ev) return;
          openSheet(
            '<div class="sheet-h"><h3>' + U.esc(ev.courseName) + '</h3><div class="sp"></div>' +
            '<button class="x-btn" data-act="close-sheet">×</button></div>' +
            '<p class="sheet-sub">' + U.weekdayName(ev.weekday) + ' ' + ev.start + '-' + ev.end +
            (ev.room ? ' · ' + U.esc(ev.room) : '') + '</p>' +
            '<div class="sheet-foot">' +
            '<button class="btn btn-danger" data-act="del-event" data-id="' + ev.id + '">删掉这节课</button>' +
            '<button class="btn btn-primary" data-act="note-from-event" data-id="' + ev.id + '">去记笔记</button>' +
            '</div>'
          );
          break;
        }
        case 'del-event': {
          await DB.del('events', el.dataset.id);
          await refresh();
          closeSheet();
          toast('已删除');
          render();
          break;
        }
        case 'del-course': {
          const cid = el.dataset.id;
          confirmSheet('删除这门课？', '课程下的课表条目会一起删掉，笔记会保留。', '删除', async function () {
            const evs = S.events.filter((x) => x.courseId === cid);
            for (const x of evs) await DB.del('events', x.id);
            await DB.del('courses', cid);
            await refresh();
            toast('已删除');
            render();
          });
          break;
        }
        case 'set-hue': {
          const hue = +el.dataset.hue;
          document.documentElement.style.setProperty('--hue', hue);
          S.settings.hue = hue;
          await Settings.set('hue', hue);
          render();
          break;
        }
        case 'save-semester': {
          const d = $('#set-semester').value;
          const w = +$('#set-weeks').value || 20;
          await Settings.set('semesterStart', d);
          await Settings.set('totalWeeks', w);
          S.settings.semesterStart = d;
          S.settings.totalWeeks = w;
          toast('已保存');
          render();
          break;
        }
        case 'save-asr': {
          const cfg = {
            asrEngine: $('#set-asr').value,
            asrBaseUrl: $('#set-base').value.trim(),
            asrApiKey: $('#set-key').value.trim(),
            asrModel: $('#set-model').value.trim() || 'whisper-1'
          };
          for (const k in cfg) { await Settings.set(k, cfg[k]); S.settings[k] = cfg[k]; }
          toast('转写配置已保存');
          break;
        }
        case 'export-all': exportAll(); break;
        case 'export-json': exportJSON(); break;
        case 'import-json': importJSON(); break;
        case 'wipe': {
          confirmSheet('清空全部数据？', '笔记、课表、录音、图片都会删除，无法恢复。建议先导出备份。', '确认清空', async function () {
            await DB.wipe();
            await refresh();
            toast('已清空');
            go('/today');
          });
          break;
        }
        case 'install': $('#btn-install').click(); break;
        case 'check-update': {
          if (navigator.serviceWorker && navigator.serviceWorker.controller) {
            navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update(); });
            toast('正在检查更新，稍后会刷新');
            setTimeout(function () { location.reload(); }, 1200);
          } else {
            toast('当前没有激活的离线缓存');
          }
          break;
        }
        case 'toggle-preview': {
          const body = $('#ed-body');
          body.classList.toggle('show-preview');
          el.textContent = body.classList.contains('show-preview') ? '编辑' : '预览';
          break;
        }
        case 'ed-insert-image': {
          await flushSave();
          if (!S.currentNote || !S.currentNote.id) await flushSave();
          const nid = S.currentNote && S.currentNote.id;
          if (!nid) { toast('先写点内容再插图', true); return; }
          const input = document.createElement('input');
          input.type = 'file'; input.accept = 'image/*';
          input.style.display = 'none';
          document.body.appendChild(input);
          input.onchange = async function () {
            const f = input.files[0];
            if (!f) return;
            toast('处理中…');
            const c = await Media.compressImage(f, 1600, 0.82);
            await addAsset(nid, c.blob, 'image', { name: f.name, width: c.width, height: c.height });
            await refresh();
            toast('已加入附件');
            render();
          };
          input.click();
          break;
        }
        case 'ed-record': {
          await flushSave();
          const nid = S.currentNote && S.currentNote.id;
          if (!nid) { toast('先写点内容再录音', true); return; }
          openRecorder(nid);
          break;
        }
        case 'ed-export': {
          await flushSave();
          if (S.currentNote) exportNote(S.currentNote);
          break;
        }
        case 'ed-share': {
          await flushSave();
          if (S.currentNote) shareNote(S.currentNote);
          break;
        }
        case 'ed-delete': {
          const id = S.currentNote && S.currentNote.id;
          if (!id) { draft = null; go('/notes'); return; }
          confirmSheet('删除这篇笔记？', '附件与转写会一起删除。', '删除', async function () {
            await deleteNote(id);
            draft = null;
            toast('已删除');
            go('/notes');
          });
          break;
        }
        case 'view-image': {
          const url = await assetURL(el.dataset.asset);
          if (!url) return;
          const lb = $('#lightbox');
          $('img', lb).src = url;
          lb.classList.add('open');
          lb.onclick = function () { lb.classList.remove('open'); };
          break;
        }
        case 'del-asset': {
          const id = el.dataset.id;
          confirmSheet('删除这个附件？', '删除后无法恢复。', '删除', async function () {
            await DB.del('blobs', id);
            await DB.del('assets', id);
            await refresh();
            toast('已删除');
            render();
          });
          break;
        }
        case 'transcribe': askTranscribe(el.dataset.id); break;
        case 'ocr-asset': runOCR(el.dataset.id); break;
        case 'asr-browser': closeSheet(); transcribeBrowser(el.dataset.id); break;
        case 'asr-custom': closeSheet(); transcribeCustom(el.dataset.id); break;
        case 'goto-wiki': {
          const t = (el.dataset.title || '').trim().toLowerCase();
          const target = S.notes.filter((n) => (n.title || '').trim().toLowerCase() === t)[0];
          await flushSave();
          if (target) { go('/note/' + target.id); }
          else {
            const note = await createNote({ title: el.dataset.title, kind: 'note', body: '' });
            go('/note/' + note.id);
          }
          break;
        }
        default: break;
      }
    });

    // 搜索
    const searchEl = $('#global-search');
    const doSearch = U.debounce(function () {
      const q = searchEl.value.trim();
      S.search = q;
      if (q) {
        if (S.route !== 'search') { location.hash = '/search?q=' + encodeURIComponent(q); }
        else { render(); }
      } else if (S.route === 'search') {
        go('/notes');
      } else {
        render();
      }
    }, 260);
    searchEl.addEventListener('input', doSearch);

    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchEl.focus();
        searchEl.select();
      }
      if (e.key === 'Escape') {
        closeSheet();
        $('#lightbox').classList.remove('open');
      }
    });

    $$('.nav-item, .tab-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        const r = b.dataset.route;
        if (!r) return;
        go('/' + r);
      });
    });

    $('#btn-quick').addEventListener('click', function () {
      openSheet(
        '<div class="sheet-h"><h3>记一笔</h3><div class="sp"></div>' +
        '<button class="x-btn" data-act="close-sheet">×</button></div>' +
        '<p class="sheet-sub">先存下来，课后整理。不用在课上想分类。</p>' +
        '<div class="list">' +
        '<button class="row" data-act="capture-photo"><div class="thumb">📷</div>' +
        '<div class="body"><div class="title">拍照 / 相册</div><div class="sub">板书、PPT、课本，可多选；相册里存好的也能传</div></div></button>' +
        '<button class="row" data-act="capture-text"><div class="thumb">⌨</div>' +
        '<div class="body"><div class="title">打字</div><div class="sub">记关键词、没听懂的位置</div></div></button>' +
        '<button class="row" data-act="capture-audio"><div class="thumb">🎙</div>' +
        '<div class="body"><div class="title">录音</div><div class="sub">录下来，可选转文字</div></div></button>' +
        '</div>'
      );
    });

    $('#fab').addEventListener('click', function () { $('#btn-quick').click(); });

    $('#sheet-mask').addEventListener('click', function (e) {
      if (e.target === this) closeSheet();
    });

    window.addEventListener('hashchange', onRoute);
    window.addEventListener('beforeunload', function (e) {
      if (S.dirty) { flushSave(); e.preventDefault(); e.returnValue = ''; }
    });
    window.addEventListener('resize', U.debounce(function () {
      if (S.route === 'graph') drawGraph();
    }, 240));
  }

  /* ================= 启动 ================= */
  function stage(s) {
    document.documentElement.setAttribute('data-stage', s);
  }

  async function boot() {
    stage('boot');
    await DB.ready();
    stage('db-ready');
    S.settings = await Settings.all();
    stage('settings');
    document.documentElement.style.setProperty('--hue', S.settings.hue || 168);

    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', '#cdd1d3');

    await refresh();
    stage('refreshed');
    bindGlobal();
    stage('bound');
    setupInstall();
    registerSW();
    stage('sw');

    // 原生壳里存文件是异步的，结果从 core.js 抛出来，这里统一提示
    document.addEventListener('luozi-saved', function (e) {
      const d = e.detail || {};
      if (d.ok) toast('已存到「' + (d.where || '下载') + '」：' + d.name);
      else toast('保存失败：' + (d.error || '未知错误'), true);
    });

    const r = parseHash();
    if (r.route === 'import') {
      S.params = r.params;
      await handleImport();
      return;
    }
    await onRoute();
    stage('routed');

    if (r.route === 'today') maybeOnboard();

    if (!S.settings.installedAt && !localStorage.getItem('lz_seen')) {
      localStorage.setItem('lz_seen', '1');
      if (!isStandalone() && deferredPrompt) {
        setTimeout(function () { toast('可以点左下角「安装落字」，装到桌面离线用'); }, 2600);
      }
    }
  }

  // 暴露给调试
  window.LZ = {
    S: S, go: go, render: render, refresh: refresh,
    createNote: createNote, saveNote: saveNote, deleteNote: deleteNote, addAsset: addAsset,
    assetsOf: assetsOf, openImport: openImport, openRecorder: openRecorder,
    exportAll: exportAll, exportNote: exportNote, shareNote: shareNote,
    saveTranscript: saveTranscript, flushSave: flushSave,
    // 课件导入与不懂标记，给自动化测试留个口子
    importDoc: importDoc, runDocImport: runDocImport, toggleFlag: toggleFlag, clearFlag: clearFlag,
    capturePhoto: capturePhoto, captureText: captureText,
    // 安卓返回键走这个，返回 true 表示已被应用消化掉
    back: back
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();

/* ============================================================
   落字 · 核心算法层（无 DOM 依赖，可单测）
   包含：Markdown 渲染 / 双链索引 / 全文搜索 / 课表解析 / ZIP 打包
   ============================================================ */
(function (global) {
  'use strict';

  /* ================= 工具 ================= */
  const U = {
    esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    uid() {
      return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    },
    pad(n) { return String(n).padStart(2, '0'); },
    today() {
      const d = new Date();
      return d.getFullYear() + '-' + U.pad(d.getMonth() + 1) + '-' + U.pad(d.getDate());
    },
    nowISO() { return new Date().toISOString(); },
    fmtDate(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d)) return '';
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + U.pad(d.getHours()) + ':' + U.pad(d.getMinutes());
    },
    fmtSize(n) {
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1048576).toFixed(1) + ' MB';
    },
    /** 学期周次：给定开学日与总周数 */
    weekOf(semesterStart, totalWeeks) {
      if (!semesterStart) return { week: 0, total: totalWeeks || 0, label: '未设置开学日' };
      const start = new Date(semesterStart + 'T00:00:00');
      if (isNaN(start)) return { week: 0, total: totalWeeks || 0, label: '日期无效' };
      const now = new Date();
      const diff = Math.floor((now - start) / 86400000);
      const week = Math.max(0, Math.floor(diff / 7) + 1);
      return { week: week, total: totalWeeks || 20, label: '第 ' + week + ' 周 / 共 ' + (totalWeeks || 20) + ' 周' };
    },
    /** 当前是周几，1=周一 7=周日 */
    weekdayNow() {
      const d = new Date().getDay();
      return d === 0 ? 7 : d;
    },
    weekdayName(n) {
      return ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'][n] || '';
    },
    /** 每门课一个稳定的颜色，取自 hue 体系 */
    courseColor(seed) {
      const palette = ['#2f6e66', '#3a6285', '#7a5636', '#5d4a78', '#566b34', '#8a4f55', '#356b4c', '#6d4560'];
      let h = 0;
      const s = String(seed || '');
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9973;
      return palette[h % palette.length];
    },
    debounce(fn, ms) {
      let t = null;
      return function () {
        const args = arguments, self = this;
        clearTimeout(t);
        t = setTimeout(function () { fn.apply(self, args); }, ms || 200);
      };
    },
    /**
     * 存文件。浏览器里用 blob + a[download]；
     * 安卓壳里 a[download] 是静默失效的（点了没反应也没提示），
     * 所以改走原生的 LuoziFiles 插件真正写进「下载」目录。
     * 结果通过 luozi-saved 事件抛出去，由 app.js 弹提示。
     */
    download(blob, name) {
      const cap = window.Capacitor;
      const native = !!(cap && typeof cap.isNativePlatform === 'function' &&
        cap.isNativePlatform() && cap.Plugins && cap.Plugins.LuoziFiles);

      if (native) {
        blob.arrayBuffer().then(function (buf) {
          const bytes = new Uint8Array(buf);
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          }
          return cap.Plugins.LuoziFiles.save({
            name: name,
            data: btoa(bin),
            mime: blob.type || 'application/octet-stream'
          });
        }).then(function (r) {
          document.dispatchEvent(new CustomEvent('luozi-saved', {
            detail: { ok: true, name: name, where: (r && r.where) || '下载' }
          }));
        }).catch(function (e) {
          document.dispatchEvent(new CustomEvent('luozi-saved', {
            detail: { ok: false, name: name, error: (e && e.message) || '未知错误' }
          }));
        });
        return;
      }

      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    }
  };

  /* ================= Markdown ================= */
  const MD = {
    /**
     * 渲染顺序：先整体转义，再做块级替换，最后做行内替换。
     * 支持：标题 #-######、引用 >、无序/有序列表、围栏代码 ```、
     *      分隔线 ---、任务列表 - [ ] / - [x]、粗体、斜体、行内代码、
     *      链接、[[双链]]、$行内公式$、$$块公式$$
     */
    render(src, opts) {
      const o = opts || {};
      const wikilink = o.wikilink !== false;
      let text = String(src || '').replace(/\r\n/g, '\n');

      /* 1. 围栏代码块先挖出来，避免内部被后续规则改写 */
      const codeBlocks = [];
      text = text.replace(/```([a-zA-Z0-9+#-]*)\n([\s\S]*?)```/g, function (_, lang, code) {
        codeBlocks.push('<pre class="md-code"><code data-lang="' + U.esc(lang) + '">' + U.esc(code.replace(/\n$/, '')) + '</code></pre>');
        return '\u0000CODE' + (codeBlocks.length - 1) + '\u0000';
      });

      /* 2. 块公式 $$...$$ */
      const formulas = [];
      text = text.replace(/\$\$([\s\S]+?)\$\$/g, function (_, tex) {
        formulas.push(tex.trim());
        return '\u0000MATH' + (formulas.length - 1) + '\u0000';
      });

      /* 3. 整体转义 */
      text = U.esc(text);

      /* 4. 行内代码不参与后续替换 */
      const inlines = [];
      text = text.replace(/`([^`\n]+)`/g, function (_, code) {
        inlines.push('<code class="md-inline">' + code + '</code>');
        return '\u0000IC' + (inlines.length - 1) + '\u0000';
      });

      /* 5. 行内公式 $...$ */
      const inlineMath = [];
      text = text.replace(/\$([^$\n]+?)\$/g, function (_, tex) {
        inlineMath.push(tex.trim());
        return '\u0000IM' + (inlineMath.length - 1) + '\u0000';
      });

      /* 6. 双链 [[标题]] 或 [[标题|别名]] */
      if (wikilink) {
        text = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, function (_, target, alias) {
          const t = target.trim();
          return '<a class="wikilink" data-wikilink="' + U.esc(t) + '">' + U.esc((alias || target).trim()) + '</a>';
        });
      }

      /* 7. 标准链接 [文字](url) */
      text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

      /* 8. 粗体、斜体、删除线、高亮 */
      text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
      text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
      // ==还没弄懂的地方== → 黄色高亮，同时会被「不懂清单」收进去
      text = text.replace(/==([^=\n]+)==/g, '<mark class="md-mark">$1</mark>');

      /* 9. 块级：逐行状态机 */
      const lines = text.split('\n');
      const out = [];
      let listType = null;   // ul | ol
      let inQuote = false;

      function closeList() {
        if (listType) { out.push('</' + listType + '>'); listType = null; }
      }
      function closeQuote() {
        if (inQuote) { out.push('</blockquote>'); inQuote = false; }
      }

      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = raw.trim();

        if (!line) { closeList(); closeQuote(); continue; }

        // 占位的代码/公式块
        let m = line.match(/^\u0000(CODE|MATH)(\d+)\u0000$/);
        if (m) {
          closeList(); closeQuote();
          if (m[1] === 'CODE') out.push(codeBlocks[+m[2]]);
          else out.push('<div class="md-math" data-tex="' + U.esc(formulas[+m[2]]) + '">' + U.esc(formulas[+m[2]]) + '</div>');
          continue;
        }

        // 分隔线
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { closeList(); closeQuote(); out.push('<hr>'); continue; }

        // 标题
        m = line.match(/^(#{1,6})\s+(.*)$/);
        if (m) {
          closeList(); closeQuote();
          const lv = m[1].length;
          out.push('<h' + lv + '>' + m[2] + '</h' + lv + '>');
          continue;
        }

        // 引用（转义后是 &gt;）
        if (/^(&gt;|>)\s?/.test(line)) {
          if (!inQuote) { closeList(); out.push('<blockquote>'); inQuote = true; }
          out.push('<p>' + line.replace(/^(&gt;|>)\s?/, '') + '</p>');
          continue;
        } else { closeQuote(); }

        // 任务列表
        m = line.match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/);
        if (m) {
          if (listType !== 'ul') { closeList(); out.push('<ul class="md-task">'); listType = 'ul'; }
          const checked = m[1].toLowerCase() === 'x';
          out.push('<li class="' + (checked ? 'done' : '') + '"><span class="box">' + (checked ? '✓' : '') + '</span>' + m[2] + '</li>');
          continue;
        }

        // 无序列表
        m = line.match(/^[-*+]\s+(.*)$/);
        if (m) {
          if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
          out.push('<li>' + m[1] + '</li>');
          continue;
        }

        // 有序列表
        m = line.match(/^\d+[.)]\s+(.*)$/);
        if (m) {
          if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
          out.push('<li>' + m[1] + '</li>');
          continue;
        }

        closeList();
        out.push('<p>' + line + '</p>');
      }
      closeList(); closeQuote();

      let html = out.join('\n');

      /* 10. 还原行内占位 */
      html = html.replace(/\u0000IC(\d+)\u0000/g, function (_, i) { return inlines[+i]; });
      html = html.replace(/\u0000IM(\d+)\u0000/g, function (_, i) {
        const tex = inlineMath[+i];
        return '<span class="md-math-inline" data-tex="' + U.esc(tex) + '">' + U.esc(tex) + '</span>';
      });
      html = html.replace(/\u0000CODE(\d+)\u0000/g, function (_, i) { return codeBlocks[+i]; });
      html = html.replace(/\u0000MATH(\d+)\u0000/g, function (_, i) {
        return '<div class="md-math" data-tex="' + U.esc(formulas[+i]) + '">' + U.esc(formulas[+i]) + '</div>';
      });

      return html;
    },

    /** 从 Markdown 抽纯文本，用于搜索与摘要 */
    plain(src) {
      return String(src || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^[ \t]*>+[ \t]?/gm, ' ')     // 引用标记：只清行首，别把公式里的 > 也吃了
        .replace(/^[ \t]*#{1,6}[ \t]+/gm, ' ')
        .replace(/^[ \t]*[-+][ \t]+/gm, ' ')
        .replace(/^[ \t]*\d+\.[ \t]+/gm, ' ')
        .replace(/\$\$[\s\S]*?\$\$/g, ' ')
        // 行内公式：不整段删掉，换成能读的符号，摘要有意义
        .replace(/\$([^$\n]+)\$/g, function (_, tex) { return MD.mathToText(tex); })
        .replace(/==([^=\n]+)==/g, '$1')     // 高亮标记不留在摘要里
        .replace(/[*_~`#\[\]()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    },

    /** 把 LaTeX 片段压成一句能读的中文式文本，供摘要/列表预览用 */
    mathToText(tex) {
      let s = String(tex || '');

      // 先处理结构性命令，避免「\le」把「\left」吃掉、「\in」把「\infty」吃掉
      s = s
        .replace(/\\left|\\right/g, '')
        .replace(/\\quad|\\,|\\;|\\!|\\ /g, ' ')
        .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)')
        .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)')
        .replace(/\\(sin|cos|tan|log|ln|lim|max|min|exp)\b/g, '$1')
        .replace(/\\lim_?\s*/g, 'lim ');

      const map = {
        'forall': '任意', 'exists': '存在',
        'le': '≤', 'leq': '≤', 'ge': '≥', 'geq': '≥', 'neq': '≠', 'approx': '≈',
        'times': '×', 'div': '÷', 'pm': '±', 'cdot': '·',
        'to': '→', 'rightarrow': '→', 'Rightarrow': '⇒', 'leftrightarrow': '↔',
        'infty': '∞', 'in': '∈', 'notin': '∉', 'subset': '⊂', 'supset': '⊃',
        'cup': '∪', 'cap': '∩', 'sum': 'Σ', 'prod': 'Π', 'int': '∫',
        'alpha': 'α', 'beta': 'β', 'gamma': 'γ', 'delta': 'δ', 'Delta': 'Δ',
        'theta': 'θ', 'lambda': 'λ', 'mu': 'μ', 'pi': 'π', 'sigma': 'σ',
        'phi': 'φ', 'omega': 'ω', 'varepsilon': 'ε', 'epsilon': 'ε'
      };
      Object.keys(map).forEach(function (k) {
        // (?![a-zA-Z]) 保证 \in 不会去啃 \infty 的前半截
        s = s.replace(new RegExp('\\\\' + k + '(?![a-zA-Z])', 'g'), map[k]);
      });

      s = s
        .replace(/\\[a-zA-Z]+/g, '')   // 剩下的没人认识的命令直接丢
        .replace(/[{}]/g, '')
        .replace(/[_^]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return s ? ' ' + s + ' ' : ' ';
    },

    /** 提取双链目标 */
    wikiTargets(src) {
      const out = [];
      const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
      let m;
      while ((m = re.exec(String(src || ''))) !== null) {
        const t = m[1].trim();
        if (t && out.indexOf(t) === -1) out.push(t);
      }
      return out;
    },

    /** 抽出正文里所有 ==高亮== 的片段，给「不懂清单」用 */
    markSnippets(src) {
      const out = [];
      const re = /==([^=\n]+)==/g;
      let m;
      while ((m = re.exec(String(src || ''))) !== null) {
        const t = m[1].trim();
        if (t && out.indexOf(t) === -1) out.push(t);
      }
      return out;
    }
  };

  /* ================= 双链图谱 ================= */
  const Graph = {
    /**
     * 根据全部笔记构建图谱
     * 返回 { key: { title, id, out:[], in:[] , mentions:[] } }
     * 节点 key 用标题（不区分大小写）；同标题多篇时取最近更新的那篇
     */
    build(notes) {
      const byTitle = {};
      const nodes = {};

      notes.forEach(function (n) {
        const k = (n.title || '').trim().toLowerCase();
        if (!k) return;
        if (!byTitle[k] || (n.updatedAt || '') > (byTitle[k].updatedAt || '')) byTitle[k] = n;
      });

      Object.keys(byTitle).forEach(function (k) {
        nodes[k] = {
          key: k,
          title: byTitle[k].title,
          id: byTitle[k].id,
          out: [],
          inn: [],
          mentions: []
        };
      });

      notes.forEach(function (n) {
        const outs = MD.wikiTargets(n.body);
        outs.forEach(function (t) {
          const k = t.toLowerCase();
          if (!nodes[k]) {
            nodes[k] = { key: k, title: t, id: null, out: [], inn: [], mentions: [] };
          }
          if (nodes[k].out.indexOf(n.id) === -1) nodes[k].out.push(n.id);
          // 反向链接挂在被指向的节点上
          const self = (n.title || '').trim().toLowerCase();
          if (self && nodes[self] && nodes[self].inn.indexOf(k) === -1) nodes[self].inn.push(k);
        });
      });

      // 未链接提及：正文出现标题但没加 [[]]
      Object.keys(nodes).forEach(function (k) {
        const title = nodes[k].title;
        if (!title || title.length < 2) return;
        notes.forEach(function (n) {
          if ((n.title || '').trim().toLowerCase() === k) return;
          const body = n.body || '';
          if (body.indexOf('[[' + title) !== -1) return;
          if (body.indexOf(title) !== -1) {
            if (nodes[k].mentions.indexOf(n.id) === -1) nodes[k].mentions.push(n.id);
          }
        });
      });

      return nodes;
    },

    /** 某篇笔记的反向链接（谁引用了我） */
    backlinks(notes, noteId) {
      const nodes = Graph.build(notes);
      const self = notes.filter(function (n) { return n.id === noteId; })[0];
      if (!self) return [];
      const k = (self.title || '').trim().toLowerCase();
      const node = nodes[k];
      if (!node) return [];
      return node.inn.map(function (srcKey) {
        const target = nodes[srcKey];
        return target ? { key: srcKey, title: target.title, id: target.id } : null;
      }).filter(Boolean);
    },

    /** 出链 */
    outgoing(note) {
      return MD.wikiTargets(note.body || '');
    }
  };

  /* ================= 全文搜索 ================= */
  const Search = {
    tokenize(q) {
      return String(q || '').toLowerCase().split(/[\s,，。；;]+/).filter(Boolean);
    },
    /** docs: [{id, title, body, kind, tags, updatedAt}] */
    run(docs, q, limit) {
      const terms = Search.tokenize(q);
      if (!terms.length) return [];
      const res = [];
      docs.forEach(function (d) {
        const title = (d.title || '').toLowerCase();
        const body = (d.body || '').toLowerCase();
        const tags = ((d.tags || []).join(' ')).toLowerCase();
        let score = 0;
        let hitAll = true;

        terms.forEach(function (t) {
          let s = 0;
          if (title.indexOf(t) !== -1) s += 12;
          if (tags.indexOf(t) !== -1) s += 6;
          if (body.indexOf(t) !== -1) {
            s += 3;
            const c = body.split(t).length - 1;
            s += Math.min(c, 5);
          }
          if (s === 0) hitAll = false;
          score += s;
        });

        if (hitAll && score > 0) {
          // 最近更新的略微加权
          const age = (Date.now() - new Date(d.updatedAt || d.createdAt || 0).getTime()) / 86400000;
          score += Math.max(0, 4 - age * 0.05);
          res.push({ doc: d, score: score, snippet: Search.snippet(d, terms) });
        }
      });
      res.sort(function (a, b) { return b.score - a.score; });
      return limit ? res.slice(0, limit) : res;
    },
    snippet(d, terms) {
      const body = MD.plain(d.body || '');
      if (!body) return '';
      const lower = body.toLowerCase();
      let idx = -1;
      for (let i = 0; i < terms.length; i++) {
        const p = lower.indexOf(terms[i]);
        if (p !== -1 && (idx === -1 || p < idx)) idx = p;
      }
      if (idx === -1) return body.slice(0, 80);
      const start = Math.max(0, idx - 30);
      let s = body.slice(start, start + 110);
      if (start > 0) s = '…' + s;
      return s;
    },
    highlight(text, q) {
      const terms = Search.tokenize(q);
      let out = U.esc(text);
      terms.forEach(function (t) {
        if (!t) return;
        const re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
        out = out.replace(re, '<mark>$1</mark>');
      });
      return out;
    }
  };

  /* ================= 课表文本解析 ================= */
  const Timetable = {
    /** 节次时间表，默认按 45 分钟一节 + 10 分钟课间，08:00 开始 */
    SLOT_START_MIN: 8 * 60,
    SLOT_LEN: 45,
    BREAK: 10,

    slotToTime(n) {
      const m = Timetable.SLOT_START_MIN + (n - 1) * (Timetable.SLOT_LEN + Timetable.BREAK);
      return U.pad(Math.floor(m / 60)) + ':' + U.pad(m % 60);
    },
    slotRangeToTime(a, b) {
      let start = Timetable.SLOT_START_MIN + (a - 1) * (Timetable.SLOT_LEN + Timetable.BREAK);
      let end = Timetable.SLOT_START_MIN + (b - 1) * (Timetable.SLOT_LEN + Timetable.BREAK) + Timetable.SLOT_LEN;
      return {
        start: U.pad(Math.floor(start / 60)) + ':' + U.pad(start % 60),
        end: U.pad(Math.floor(end / 60)) + ':' + U.pad(end % 60)
      };
    },

    WEEKDAY_MAP: {
      '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7,
      '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
      'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6, 'sun': 7,
      'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 'friday': 5, 'saturday': 6, 'sunday': 7
    },

    /**
     * 解析一段文本课表。返回 { events:[], errors:[] }
     * 每行一条，容错：缺地点、缺时间都能收，缺星期则跳过并记录原因。
     */
    parse(text) {
      const lines = String(text || '').split(/\n/);
      const events = [];
      const errors = [];
      const ignored = [];

      lines.forEach(function (raw, i) {
        let line = raw.trim();
        if (!line) return;
        if (/^(#|\/\/)/.test(line)) return;            // 注释
        if (/^(时间|课程|星期|周次)/.test(line) && i === 0) return; // 表头

        const origin = line;

        /* 星期 */
        let weekday = 0;
        const wdMatch = line.match(/(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/i) ||
                        line.match(/\b(mon|tue|wed|thu|fri|sat|sun)(?:day)?\b/i);
        if (wdMatch) {
          const key = wdMatch[1].toLowerCase();
          weekday = Timetable.WEEKDAY_MAP[key] || Timetable.WEEKDAY_MAP[wdMatch[1]] || 0;
          line = line.replace(wdMatch[0], ' ');
        } else {
          const bare = line.match(/^([一二三四五六日天])\s*[,，:：\s]/);
          if (bare) {
            weekday = Timetable.WEEKDAY_MAP[bare[1]] || 0;
            line = line.replace(bare[0], ' ');
          }
        }

        /* 时间：显式 HH:MM-HH:MM 优先 */
        let start = '', end = '';
        const tm = line.match(/(\d{1,2})[:：](\d{2})\s*[-~—到至]\s*(\d{1,2})[:：](\d{2})/);
        if (tm) {
          start = U.pad(+tm[1]) + ':' + tm[2];
          end = U.pad(+tm[3]) + ':' + tm[4];
          line = line.replace(tm[0], ' ');
        } else {
          const sm = line.match(/第\s*(\d{1,2})\s*[-~—到至]\s*(\d{1,2})\s*节/) ||
                     line.match(/第\s*(\d{1,2})\s*节/);
          if (sm) {
            const a = +sm[1];
            const b = sm[2] ? +sm[2] : a;
            const r = Timetable.slotRangeToTime(a, b);
            start = r.start; end = r.end;
            line = line.replace(sm[0], ' ');
          }
        }

        /* 周次范围：1-16周 */
        let weeksFrom = 1, weeksTo = 20;
        const wm = line.match(/(\d{1,2})\s*[-~—]\s*(\d{1,2})\s*周/);
        if (wm) {
          weeksFrom = +wm[1]; weeksTo = +wm[2];
          line = line.replace(wm[0], ' ');
        }

            /* 地点：从右往左找第一个「像个地点」的词，
           这样「大学英语语音室B2」不会被整串当成教室 */
        const tokens = line.split(/[\s,，;；|\/]+/).filter(Boolean);
        const ROOM_RE = new RegExp(
          '^(' +
            '[A-Za-z]{0,3}\\d{1,2}[-_]?\\d{2,4}' +          // A301 / C-101 / 301
            '|[\\u4e00-\\u9fa5]{1,4}(?:楼|室|馆|堂|苑|栋|区|教|场)' +
              '[A-Za-z0-9\\-]{0,6}' +                        // 语音室B2 / 实验楼 / 体育馆
          ')$'
        );
        let room = '';
        for (let k = tokens.length - 1; k >= 1; k--) {
          if (ROOM_RE.test(tokens[k])) { room = tokens[k]; tokens.splice(k, 1); break; }
        }

        /* 剩下最长的中文串当课程名 */
        let name = '';
        tokens.forEach(function (t) {
          const clean = t.replace(/[^\u4e00-\u9fa5A-Za-z0-9()（）·]/g, '');
          if (clean.length > name.length && /[\u4e00-\u9fa5A-Za-z]/.test(clean)) name = clean;
        });

        // 既没星期也没时间，多半是「2026 秋季课表」这种表头，忽略掉，不算错误
        if (!weekday && !start) {
          ignored.push('第 ' + (i + 1) + ' 行忽略（没有星期和时间）：' + origin);
          return;
        }
        if (!weekday) { errors.push('第 ' + (i + 1) + ' 行没有识别到星期：' + origin); return; }
        if (!name) { errors.push('第 ' + (i + 1) + ' 行没有识别到课程名：' + origin); return; }
        if (!start) {
          start = '08:00'; end = '09:40';
        }

        events.push({
          weekday: weekday,
          start: start,
          end: end,
          name: name.slice(0, 24),
          room: room,
          weeksFrom: weeksFrom,
          weeksTo: weeksTo,
          raw: origin
        });
      });

      return { events: events, errors: errors, ignored: ignored };
    },

    /** 把解析结果落库：同名课程合并，分配颜色 */
    async persist(parsed) {
      const existingCourses = await DB.all('courses');
      const byName = {};
      existingCourses.forEach(function (c) { byName[c.name] = c; });

      const courseIds = {};
      for (const ev of parsed.events) {
        let course = byName[ev.name];
        if (!course) {
          course = {
            id: DB.uid(),
            name: ev.name,
            color: U.courseColor(ev.name),
            room: ev.room || '',
            createdAt: U.nowISO()
          };
          await DB.put('courses', course);
          byName[ev.name] = course;
        }
        courseIds[ev.name] = course.id;
      }

      // 同一课程同一时段视为重复，跳过
      const old = await DB.all('events');
      const seen = {};
      old.forEach(function (e) {
        seen[e.courseId + '|' + e.weekday + '|' + e.start] = true;
      });

      const toAdd = [];
      parsed.events.forEach(function (ev) {
        const cid = courseIds[ev.name];
        const sig = cid + '|' + ev.weekday + '|' + ev.start;
        if (seen[sig]) return;
        seen[sig] = true;
        toAdd.push({
          id: DB.uid(),
          courseId: cid,
          courseName: ev.name,
          weekday: ev.weekday,
          start: ev.start,
          end: ev.end,
          room: ev.room,
          weeksFrom: ev.weeksFrom,
          weeksTo: ev.weeksTo,
          createdAt: U.nowISO()
        });
      });

      if (toAdd.length) await DB.putMany('events', toAdd);
      return { added: toAdd.length, skipped: parsed.events.length - toAdd.length };
    },

    /** 计算某周某天的课程，按时间排序 */
    forDay(events, courses, weekday) {
      const map = {};
      courses.forEach(function (c) { map[c.id] = c; });
      return events
        .filter(function (e) { return +e.weekday === +weekday; })
        .sort(function (a, b) { return a.start.localeCompare(b.start); })
        .map(function (e) {
          return Object.assign({}, e, { course: map[e.courseId] || null });
        });
    },

    /** 把 HH:MM 转成分钟 */
    toMin(t) {
      const p = String(t || '0:0').split(':');
      return (+p[0]) * 60 + (+p[1] || 0);
    },

    /** 距下一节课还有多久 */
    nextClass(events, courses) {
      const now = new Date();
      const wd = U.weekdayNow();
      const mins = now.getHours() * 60 + now.getMinutes();
      const today = Timetable.forDay(events, courses, wd);
      for (const e of today) {
        if (Timetable.toMin(e.start) > mins) {
          return { event: e, inMinutes: Timetable.toMin(e.start) - mins };
        }
      }
      return null;
    }
  };

  /* ================= ZIP（store 模式，无压缩） ================= */
  const Zip = {
    crcTable: (function () {
      const table = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c >>> 0;
      }
      return table;
    })(),

    crc32(bytes) {
      let c = 0xFFFFFFFF;
      for (let i = 0; i < bytes.length; i++) {
        c = Zip.crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
      }
      return (c ^ 0xFFFFFFFF) >>> 0;
    },

    dosTime(d) {
      const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31);
      const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
      return { time: time, date: date };
    },

    /** files: [{name, data: Uint8Array}] -> Blob */
    build(files) {
      const enc = new TextEncoder();
      const chunks = [];
      const central = [];
      let offset = 0;
      const now = new Date();
      const dt = Zip.dosTime(now);

      files.forEach(function (f) {
        const nameBytes = enc.encode(f.name);
        const data = f.data instanceof Uint8Array ? f.data : enc.encode(String(f.data));
        const crc = Zip.crc32(data);

        const local = new Uint8Array(30 + nameBytes.length);
        const dv = new DataView(local.buffer);
        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);
        dv.setUint16(6, 0x0800, true);      // UTF-8 文件名
        dv.setUint16(8, 0, true);           // store
        dv.setUint16(10, dt.time, true);
        dv.setUint16(12, dt.date, true);
        dv.setUint32(14, crc, true);
        dv.setUint32(18, data.length, true);
        dv.setUint32(22, data.length, true);
        dv.setUint16(26, nameBytes.length, true);
        dv.setUint16(28, 0, true);
        local.set(nameBytes, 30);

        chunks.push(local, data);

        const cen = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(cen.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, dt.time, true);
        cv.setUint16(14, dt.date, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        cv.setUint32(38, 0, true);
        cv.setUint32(42, offset, true);
        cen.set(nameBytes, 46);

        central.push(cen);
        offset += local.length + data.length;
      });

      const centralSize = central.reduce(function (a, b) { return a + b.length; }, 0);
      const end = new Uint8Array(22);
      const ev = new DataView(end.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, files.length, true);
      ev.setUint16(10, files.length, true);
      ev.setUint32(12, centralSize, true);
      ev.setUint32(16, offset, true);

      return new Blob(chunks.concat(central, [end]), { type: 'application/zip' });
    }
  };

  /* ================= 分享编码 ================= */
  const Share = {
    /** 把笔记压成 URL 片段 */
    async encode(payload) {
      const json = JSON.stringify(payload);
      const bytes = new TextEncoder().encode(json);
      if (typeof CompressionStream !== 'undefined') {
        try {
          const cs = new CompressionStream('deflate-raw');
          const stream = new Blob([bytes]).stream().pipeThrough(cs);
          const buf = await new Response(stream).arrayBuffer();
          return 'd1.' + Share.b64url(new Uint8Array(buf));
        } catch (e) { /* 落到明文 */ }
      }
      return 'r0.' + Share.b64url(bytes);
    },

    async decode(code) {
      const parts = String(code || '').split('.');
      const kind = parts[0];
      const bytes = Share.unb64url(parts.slice(1).join('.'));
      let raw = bytes;
      if (kind === 'd1' && typeof DecompressionStream !== 'undefined') {
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        raw = new Uint8Array(await new Response(stream).arrayBuffer());
      }
      return JSON.parse(new TextDecoder().decode(raw));
    },

    b64url(bytes) {
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },

    unb64url(str) {
      const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
      const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
      const bin = atob(s + pad);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
  };

  /* ================= 公式渲染（KaTeX，按需加载，失败降级为源码） ================= */
  const MathRender = {
    state: 'idle',       // idle | loading | ready | failed
    _p: null,
    _lastFail: 0,

    ensure() {
      if (MathRender.state === 'ready') return Promise.resolve(true);
      if (MathRender.state === 'loading') return MathRender._p;
      if (MathRender.state === 'failed' && Date.now() - MathRender._lastFail < 60000) {
        return Promise.resolve(false);
      }

      MathRender.state = 'loading';
      // 本地优先：离线也能排版公式；CDN 只作为本地文件缺失时的兜底
      const CSS = [
        'vendor/katex/katex.min.css',
        'https://unpkg.com/katex@0.16.9/dist/katex.min.css'
      ];
      const JS = [
        'vendor/katex/katex.min.js',
        'https://unpkg.com/katex@0.16.9/dist/katex.min.js'
      ];

      function loadCss(list) {
        return new Promise((resolve) => {
          let i = 0;
          const next = () => {
            if (i >= list.length) { resolve(false); return; }
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = list[i++];
            link.onload = () => resolve(true);
            link.onerror = next;
            document.head.appendChild(link);
          };
          next();
        });
      }

      function loadJs(list) {
        return new Promise((resolve) => {
          let i = 0;
          const next = () => {
            if (i >= list.length) { resolve(false); return; }
            const s = document.createElement('script');
            s.src = list[i++];
            s.async = true;
            s.onload = () => resolve(!!(window.katex));
            s.onerror = next;
            document.head.appendChild(s);
          };
          next();
        });
      }

      MathRender._p = Promise.all([loadCss(CSS), loadJs(JS)]).then(([cssOk, jsOk]) => {
        if (jsOk && window.katex) {
          MathRender.state = 'ready';
          return true;
        }
        MathRender.state = 'failed';
        MathRender._lastFail = Date.now();
        return false;
      });

      return MathRender._p;
    },

    /** 把容器里的 data-tex 节点替换成真正的排版公式 */
    apply(root) {
      if (!root) return;
      const nodes = root.querySelectorAll('[data-tex]');
      if (!nodes.length) return;

      const paint = () => {
        if (!window.katex) return;
        nodes.forEach((el) => {
          const tex = el.getAttribute('data-tex');
          if (!tex || el.dataset.rendered === '1') return;
          try {
            window.katex.render(tex, el, {
              throwOnError: false,
              displayMode: el.classList.contains('md-math'),
              output: 'html'
            });
            el.dataset.rendered = '1';
          } catch (e) {
            el.textContent = tex;
          }
        });
      };

      if (MathRender.state === 'ready') { paint(); return; }
      MathRender.ensure().then((ok) => { if (ok) paint(); });
    }
  };

  global.Core = {
    U: U, MD: MD, Graph: Graph, Search: Search, Timetable: Timetable,
    Zip: Zip, Share: Share, MathRender: MathRender
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.Core;
  }
})(typeof window !== 'undefined' ? window : globalThis);

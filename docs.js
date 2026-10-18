/* ============================================================
   落字 · 课件导入
   把 PPT(.pptx) 和 PDF 里的文字抽出来，整理成一篇 Markdown 笔记。
   全部在本机完成：不解压上传、不联网、不调用任何云服务。
   - .pptx 本质是 zip，自己读中央目录 + DecompressionStream 解压
   - PDF 用本地 vendor/pdfjs（含 GB 系字符映射，中文 PDF 才抽得出来）
   ============================================================ */
(function (global) {
  'use strict';

  const Docs = {};

  /* ---------------- 小工具 ---------------- */
  function decodeUTF8(u8) {
    return new TextDecoder('utf-8', { fatal: false }).decode(u8);
  }

  function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('这个浏览器不支持解压（缺少 DecompressionStream），换 Chrome / Edge 再试');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then((b) => new Uint8Array(b));
  }

  function xmlUnescape(s) {
    return String(s)
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /* ---------------- zip 解包 ---------------- */

  /**
   * 只读中央目录，支持 store(0) / deflate(8)。
   * @param {ArrayBuffer} buf
   * @param {(name:string)=>boolean} [wanted] 只解压需要的条目，省时间
   * @returns {Promise<Object<string, Uint8Array>>}
   */
  Docs.unzip = async function (buf, wanted) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

    // 从尾部找 EOCD（0x06054b50），注释最长 65535 字节
    let eocd = -1;
    const floor = Math.max(0, u8.length - 65557);
    for (let i = u8.length - 22; i >= floor; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到中央目录）');

    let total = dv.getUint16(eocd + 10, true);
    let cdOff = dv.getUint32(eocd + 16, true);

    // ZIP64：真值放在 Zip64 EOCD 里
    if (total === 0xffff || cdOff === 0xffffffff) {
      const loc = eocd - 20;
      if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
        const z64 = Number(dv.getBigUint64(loc + 8, true));
        if (dv.getUint32(z64, true) === 0x06064b50) {
          total = Number(dv.getBigUint64(z64 + 32, true));
          cdOff = Number(dv.getBigUint64(z64 + 48, true));
        }
      }
    }

    const out = {};
    let p = cdOff;
    for (let i = 0; i < total; i++) {
      if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      let compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      let localOff = dv.getUint32(p + 42, true);
      const name = decodeUTF8(u8.subarray(p + 46, p + 46 + nameLen));

      // ZIP64 扩展字段：解出真实的 compSize / localOff
      if (compSize === 0xffffffff || localOff === 0xffffffff) {
        let ep = p + 46 + nameLen;
        const end = ep + extraLen;
        while (ep + 4 <= end) {
          const tag = dv.getUint16(ep, true);
          const size = dv.getUint16(ep + 2, true);
          if (tag === 0x0001) {
            let q = ep + 4;
            if (dv.getUint32(p + 24, true) === 0xffffffff) q += 8;         // 跳过 uncompSize
            if (compSize === 0xffffffff) { compSize = Number(dv.getBigUint64(q, true)); q += 8; }
            if (localOff === 0xffffffff) { localOff = Number(dv.getBigUint64(q, true)); }
            break;
          }
          ep += 4 + size;
        }
      }

      if (!wanted || wanted(name)) {
        // 本地头：偏移 +30 才是文件名，再加上扩展区
        const lNameLen = dv.getUint16(localOff + 26, true);
        const lExtraLen = dv.getUint16(localOff + 28, true);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;
        const raw = u8.subarray(dataStart, dataStart + compSize);
        if (method === 0) out[name] = raw.slice();
        else if (method === 8) out[name] = await inflateRaw(raw);
        else throw new Error('不支持的压缩方式：' + method + '（' + name + '）');
      }

      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  };

  /* ---------------- pptx ---------------- */

  /** 从一个 XML 里按段落抽文字 */
  function paragraphsOf(xml) {
    const paras = [];
    const pRe = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g;
    let m;
    while ((m = pRe.exec(xml))) {
      const body = m[1];
      const tRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
      let t;
      let line = '';
      while ((t = tRe.exec(body))) line += xmlUnescape(t[1]);
      // 段落里只有换行没有文字时，留一个空行便于阅读
      line = line.replace(/\s+$/, '');
      paras.push(line);
    }
    return paras;
  }

  function slideNo(name) {
    const m = /(?:^|\/)(?:slide|notesSlide)(\d+)\.xml$/.exec(name);
    return m ? +m[1] : 0;
  }

  /**
   * @returns {Promise<{kind:'pptx', slides:Array<{no:number,title:string,lines:string[]}>, count:number}>}
   */
  Docs.readPptx = async function (file) {
    const buf = await file.arrayBuffer();
    const entries = await Docs.unzip(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    const names = Object.keys(entries).sort((a, b) => slideNo(a) - slideNo(b));
    if (!names.length) throw new Error('这个 .pptx 里没找到幻灯片，可能是旧版 .ppt，请先另存为 .pptx');

    const slides = [];
    for (const name of names) {
      const xml = decodeUTF8(entries[name]);
      const paras = paragraphsOf(xml).filter((s, i, arr) => s || (i > 0 && arr[i - 1]));
      const clean = [];
      for (const s of paras) {
        const t = s.trim();
        if (!t) continue;
        if (clean[clean.length - 1] === t) continue;
        clean.push(t);
      }
      slides.push({
        no: slideNo(name),
        title: clean[0] || ('第 ' + slideNo(name) + ' 张'),
        lines: clean.slice(1)
      });
    }
    return { kind: 'pptx', slides: slides, count: slides.length };
  };

  /* ---------------- pdf ---------------- */

  let pdfLibPromise = null;

  function loadPdfjs() {
    if (global.pdfjsLib) return Promise.resolve(global.pdfjsLib);
    if (pdfLibPromise) return pdfLibPromise;
    pdfLibPromise = new Promise(function (resolve, reject) {
      if (typeof document === 'undefined') { reject(new Error('PDF 解析只能在浏览器里跑')); return; }
      const s = document.createElement('script');
      s.src = 'vendor/pdfjs/pdf.min.js';
      s.onload = function () {
        const lib = global.pdfjsLib;
        if (!lib) { reject(new Error('PDF 引擎没有挂上')); return; }
        lib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
        resolve(lib);
      };
      s.onerror = function () { pdfLibPromise = null; reject(new Error('PDF 引擎加载失败')); };
      document.head.appendChild(s);
    });
    return pdfLibPromise;
  }

  /** 把某一页的文字按行拼起来 */
  function pageLines(content) {
    const items = content.items || [];
    const lines = [];
    let cur = '';
    let lastY = null;
    for (const it of items) {
      if (typeof it.str !== 'string') continue;
      const y = it.transform ? Math.round(it.transform[5]) : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && cur.trim()) {
        lines.push(cur.trim());
        cur = '';
      }
      cur += it.str;
      if (it.hasEOL) { lines.push(cur.trim()); cur = ''; lastY = null; }
      else lastY = y;
    }
    if (cur.trim()) lines.push(cur.trim());
    return lines.filter((s) => s);
  }

  /**
   * @param {File|Blob} file
   * @param {(done:number,total:number)=>void} [onProgress]
   */
  Docs.readPdf = async function (file, onProgress) {
    const lib = await loadPdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await lib.getDocument({
      data: data,
      cMapUrl: 'vendor/pdfjs/cmaps/',
      cMapPacked: true,
      // 不用额外字体包，够抽文字就行
      disableFontFace: true,
      isEvalSupported: false
    }).promise;

    const pages = [];
    let chars = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const lines = pageLines(content);
      lines.forEach((l) => { chars += l.length; });
      pages.push({ no: i, title: lines[0] || ('第 ' + i + ' 页'), lines: lines.slice(1) });
      if (onProgress) onProgress(i, doc.numPages);
    }
    await doc.destroy();
    return { kind: 'pdf', pages: pages, count: pages.length, chars: chars };
  };

  /** 扫描件兜底：把前 n 页画成图，交给本地 OCR */
  Docs.pdfPagesToBlobs = async function (file, maxPages) {
    const lib = await loadPdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await lib.getDocument({ data: data, cMapUrl: 'vendor/pdfjs/cmaps/', cMapPacked: true }).promise;
    const n = Math.min(maxPages || 5, doc.numPages);
    const out = [];
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      out.push({ no: i, blob: blob });
    }
    await doc.destroy();
    return out;
  };

  /* ---------------- 转成 Markdown ---------------- */

  function tidy(s) { return String(s || '').trim(); }

  Docs.toMarkdown = function (doc, meta) {
    const m = meta || {};
    const src = m.fileName || (doc.kind === 'pptx' ? '课件.pptx' : '课件.pdf');
    const when = m.when || '';
    const unit = doc.kind === 'pptx' ? '张幻灯片' : '页';
    const parts = [];
    parts.push('# ' + (m.title || src.replace(/\.[^.]+$/, '')));
    parts.push('');
    parts.push('> 从「' + src + '」导入 · ' + doc.count + ' ' + unit + (when ? ' · ' + when : ''));
    if (doc.kind === 'pdf' && !doc.chars) {
      parts.push('>');
      parts.push('> ⚠️ 这份 PDF 里没抽出文字，多半是扫描件。可以用「OCR 识别」把前几页转成文字。');
    }
    parts.push('');

    const list = doc.kind === 'pptx' ? doc.slides : doc.pages;
    list.forEach(function (p) {
      const head = doc.kind === 'pptx' ? '第 ' + p.no + ' 张' : '第 ' + p.no + ' 页';
      const t = tidy(p.title);
      parts.push('## ' + head + (t && t !== head ? ' · ' + t : ''));
      parts.push('');
      (p.lines || []).forEach(function (line) {
        const s = tidy(line);
        if (!s) return;
        // 太短的行按列表排，长句按段落排，出来的笔记更像笔记
        if (s.length <= 22 && !/[。！？.!?]$/.test(s)) parts.push('- ' + s);
        else parts.push(s);
      });
      parts.push('');
    });

    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  };

  /* ---------------- 统一入口 ---------------- */

  Docs.extOf = function (name) {
    const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  };

  Docs.supported = function (file) {
    const ext = Docs.extOf(file && file.name);
    return ext === 'pptx' || ext === 'pdf';
  };

  /**
   * @param {File} file
   * @param {(done:number,total:number,label:string)=>void} [onProgress]
   */
  Docs.parse = async function (file, onProgress) {
    const ext = Docs.extOf(file.name);
    if (ext === 'pptx') {
      if (onProgress) onProgress(0, 1, '解压幻灯片');
      const r = await Docs.readPptx(file);
      if (onProgress) onProgress(1, 1, '完成');
      return r;
    }
    if (ext === 'pdf') {
      return await Docs.readPdf(file, (d, t) => { if (onProgress) onProgress(d, t, '读第 ' + d + ' 页'); });
    }
    if (ext === 'ppt' || ext === 'doc' || ext === 'docx') {
      throw new Error('.' + ext + ' 是旧格式，先在 Office / WPS 里另存为 .pptx 或 .pdf 再传');
    }
    throw new Error('只支持 .pptx 和 .pdf');
  };

  global.Docs = Docs;
  if (typeof module !== 'undefined' && module.exports) module.exports = Docs;

})(typeof window !== 'undefined' ? window : globalThis);

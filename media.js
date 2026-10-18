/* ============================================================
   落字 · 媒体层
   录音（MediaRecorder + AnalyserNode 实时电平）
   转写（浏览器 SpeechRecognition / 自建 Whisper 兼容接口）
   OCR（Tesseract.js 按需加载）
   图片压缩（Canvas）
   ============================================================ */
(function (global) {
  'use strict';

  const U = global.Core.U;

  /* ================= 录音 ================= */
  function pickMime() {
    const cands = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus'
    ];
    if (typeof MediaRecorder === 'undefined') return '';
    for (const m of cands) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  class Recorder {
    constructor(onLevel) {
      this.onLevel = onLevel || function () {};
      this.stream = null;
      this.rec = null;
      this.chunks = [];
      this.levels = [];
      this.analyser = null;
      this.ctx = null;
      this.raf = null;
      this.startedAt = 0;
      this.mime = '';
      this.state = 'idle';    // idle | recording | paused
    }

    static supported() {
      return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined');
    }

    async start() {
      if (this.state !== 'idle') throw new Error('已经在录音中');
      if (!Recorder.supported()) throw new Error('当前浏览器不支持录音（需要 MediaRecorder）');

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        }
      });

      this.mime = pickMime();
      this.chunks = [];
      this.levels = [];
      this.rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 64000 } : undefined);

      this.rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.chunks.push(e.data);
      };

      // 实时电平
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        // 不少浏览器会把新建的 AudioContext 挂起，不 resume 的话分析器一直是静音
        if (this.ctx.state === 'suspended') {
          try { await this.ctx.resume(); } catch (e) {}
        }
        const src = this.ctx.createMediaStreamSource(this.stream);
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 512;
        this.analyser.smoothingTimeConstant = 0.72;
        src.connect(this.analyser);
        const buf = new Uint8Array(this.analyser.frequencyBinCount);
        const tick = () => {
          if (!this.analyser) return;
          this.analyser.getByteFrequencyData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i];
          const rms = sum / buf.length / 255;
          this.levels.push(rms);
          if (this.levels.length > 6000) this.levels.shift();
          this.onLevel(rms, this.elapsed());
          this.raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        // 没有 WebAudio 也能录，只是没有波形
      }

      this.rec.start(1000);
      this.startedAt = Date.now();
      this.state = 'recording';
      return true;
    }

    pause() {
      if (this.state === 'recording' && this.rec) {
        this.rec.pause();
        this.state = 'paused';
      }
    }

    resume() {
      if (this.state === 'paused' && this.rec) {
        this.rec.resume();
        this.state = 'recording';
      }
    }

    elapsed() {
      return this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
    }

    _teardown() {
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
      if (this.ctx) { try { this.ctx.close(); } catch (e) {} this.ctx = null; }
      this.analyser = null;
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
      }
    }

    /** 停止并返回录音结果 */
    stop() {
      return new Promise((resolve, reject) => {
        if (!this.rec || this.state === 'idle') { reject(new Error('没有正在进行的录音')); return; }
        const duration = this.elapsed();
        const mime = this.mime || 'audio/webm';
        this.rec.onstop = () => {
          const blob = new Blob(this.chunks, { type: mime });
          const levels = this.levels.slice();
          this._teardown();
          this.rec = null;
          this.state = 'idle';
          this.startedAt = 0;
          resolve({ blob: blob, mime: mime, duration: duration, levels: levels });
        };
        try { this.rec.stop(); } catch (e) { this._teardown(); this.state = 'idle'; reject(e); }
      });
    }

    cancel() {
      if (this.rec && this.state !== 'idle') {
        try { this.rec.stop(); } catch (e) {}
      }
      this._teardown();
      this.chunks = [];
      this.rec = null;
      this.state = 'idle';
      this.startedAt = 0;
    }
  }

  /* ================= 浏览器语音识别 ================= */
  const BrowserASR = {
    supported() {
      return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    },
    /**
     * 持续识别，回调 onText(最终文本, 临时文本)
     * 返回一个 { stop() } 控制器
     */
    start(opts) {
      const o = opts || {};
      const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Ctor) throw new Error('当前浏览器不支持语音识别');

      const rec = new Ctor();
      rec.lang = o.lang || 'zh-CN';
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      let finalText = '';
      let stopped = false;

      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        if (o.onText) o.onText(finalText, interim);
      };
      rec.onerror = (e) => {
        if (o.onError) o.onError(e.error || 'unknown');
      };
      rec.onend = () => {
        if (!stopped && o.continuous !== false) {
          // 浏览器会在静音后自动结束，自动续上
          try { rec.start(); } catch (err) { /* 已结束 */ }
        } else if (o.onEnd) {
          o.onEnd(finalText);
        }
      };

      rec.start();

      return {
        stop() {
          stopped = true;
          try { rec.stop(); } catch (e) {}
        },
        get text() { return finalText; }
      };
    }
  };

  /* ================= 自建 / 兼容 Whisper 接口 ================= */
  const CustomASR = {
    /**
     * 上传音频到 OpenAI 兼容的 /audio/transcriptions
     * cfg: { baseUrl, apiKey, model, language }
     */
    async transcribe(blob, cfg, onProgress) {
      if (!cfg || !cfg.baseUrl) throw new Error('还没有配置转写接口地址');
      const base = cfg.baseUrl.replace(/\/+$/, '');
      const url = /\/audio\/transcriptions$/.test(base) ? base : base + '/audio/transcriptions';

      const ext = (blob.type.indexOf('mp4') > -1) ? 'm4a' : 'webm';
      const fd = new FormData();
      fd.append('file', blob, 'recording.' + ext);
      fd.append('model', cfg.model || 'whisper-1');
      if (cfg.language) fd.append('language', cfg.language);
      fd.append('response_format', 'json');

      if (onProgress) onProgress('正在上传音频…');

      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {},
          body: fd
        });
      } catch (e) {
        throw new Error('请求失败，可能是跨域限制或网络问题：' + e.message);
      }

      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 300); } catch (e) {}
        throw new Error('接口返回 ' + res.status + ' ' + (detail || res.statusText));
      }

      if (onProgress) onProgress('正在解析结果…');
      const ct = res.headers.get('content-type') || '';
      if (ct.indexOf('application/json') > -1) {
        const data = await res.json();
        return data.text || data.transcript || '';
      }
      return await res.text();
    }
  };

  /* ================= OCR =================
     引擎、wasm、中文模型全部放在 vendor/tesseract/ 里，
     不依赖 jsdelivr 这类国内经常连不上的 CDN。
     只有第一次识别时才下载（约 10MB：核心 wasm + 中英文模型），之后走浏览器缓存。
     ======================================== */
  const OCR = {
    _loading: null,
    _worker: null,

    BASE: 'vendor/tesseract/',

    /** 载入 Tesseract.js：优先本地，本地缺文件才退回 CDN */
    async load() {
      if (window.Tesseract) return window.Tesseract;
      if (OCR._loading) return OCR._loading;

      OCR._loading = new Promise((resolve, reject) => {
        const srcs = [
          OCR.BASE + 'tesseract.min.js',
          'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js'
        ];
        let i = 0;
        let lastErr = null;
        const tryNext = () => {
          if (i >= srcs.length) {
            reject(new Error('识别引擎加载失败' + (lastErr ? '：' + lastErr : '，检查 vendor/tesseract 是否完整')));
            return;
          }
          const s = document.createElement('script');
          s.src = srcs[i++];
          s.async = true;
          s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : tryNext());
          s.onerror = () => { lastErr = '请求 ' + s.src + ' 失败'; tryNext(); };
          document.head.appendChild(s);
        };
        tryNext();
      }).catch((e) => { OCR._loading = null; throw e; });

      return OCR._loading;
    },

    async recognize(blobOrUrl, onProgress) {
      const T = await OCR.load();
      if (!OCR._worker) {
        if (onProgress) onProgress('加载识别模型', 0.02);
        OCR._worker = await T.createWorker('chi_sim+eng', 1, {
          // 关键：三条路径全指向本地，worker 与 wasm 不会去外网取
          workerPath: OCR.BASE + 'worker.min.js',
          corePath: OCR.BASE,
          langPath: OCR.BASE + 'lang',
          logger: (m) => {
            if (onProgress && m.status) {
              onProgress(m.status, typeof m.progress === 'number' ? m.progress : 0);
            }
          }
        });
        // 这两行是实测出来的，不能省：
        // 1) 新建 worker 后不显式指定 PSM 3，带表格线的课表截图会被识别成乱码；
        // 2) 打开 preserve_interword_spaces 后汉字不会被拆成「高 等 数学」。
        await OCR._worker.setParameters({
          tessedit_pageseg_mode: '3',
          preserve_interword_spaces: '1'
        });
      }
      const { data } = await OCR._worker.recognize(blobOrUrl);
      return (data && data.text ? data.text : '').trim();
    },

    async dispose() {
      if (OCR._worker) {
        try { await OCR._worker.terminate(); } catch (e) {}
        OCR._worker = null;
      }
    }
  };

  /* ================= 图片压缩 ================= */
  async function compressImage(file, maxSide, quality) {
    const max = maxSide || 1600;
    const q = quality || 0.82;
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(file);
    });

    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('图片解码失败'));
      im.src = dataUrl;
    });

    let w = img.naturalWidth, h = img.naturalHeight;
    if (Math.max(w, h) > max) {
      const ratio = max / Math.max(w, h);
      w = Math.round(w * ratio);
      h = Math.round(h * ratio);
    }

    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);

    const blob = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', q);
    });
    return {
      blob: blob,
      width: w,
      height: h,
      name: file.name || ('image-' + Date.now() + '.jpg')
    };
  }

  /* ================= 音频时长估算 ================= */
  function audioDuration(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const a = new Audio();
      a.preload = 'metadata';
      a.onloadedmetadata = () => {
        const d = isFinite(a.duration) ? a.duration : 0;
        URL.revokeObjectURL(url);
        resolve(d);
      };
      a.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
      a.src = url;
    });
  }

  global.Media = {
    Recorder: Recorder,
    BrowserASR: BrowserASR,
    CustomASR: CustomASR,
    OCR: OCR,
    compressImage: compressImage,
    audioDuration: audioDuration,
    fmtTime(sec) {
      sec = Math.max(0, Math.floor(sec || 0));
      return U.pad(Math.floor(sec / 60)) + ':' + U.pad(sec % 60);
    }
  };

})(window);

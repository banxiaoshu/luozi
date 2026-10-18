/* ============================================================
   落字 · 数据层
   IndexedDB 真实持久化。所有视图都通过这个文件读写。
   设计原则：单库、多对象仓、有索引、可导出、可重建。
   ============================================================ */
(function (global) {
  'use strict';

  const DB_NAME = 'luozi';
  const DB_VERSION = 1;
  let _db = null;

  /** 对象仓定义：keyPath + 索引 */
  const STORES = {
    courses: {
      keyPath: 'id',
      indexes: [{ name: 'createdAt', keyPath: 'createdAt' }]
    },
    events: {
      keyPath: 'id',
      indexes: [
        { name: 'weekday', keyPath: 'weekday' },
        { name: 'courseId', keyPath: 'courseId' }
      ]
    },
    notes: {
      keyPath: 'id',
      indexes: [
        { name: 'updatedAt', keyPath: 'updatedAt' },
        { name: 'createdAt', keyPath: 'createdAt' },
        { name: 'courseId', keyPath: 'courseId' },
        { name: 'kind', keyPath: 'kind' }
      ]
    },
    assets: {
      keyPath: 'id',
      indexes: [
        { name: 'noteId', keyPath: 'noteId' },
        { name: 'createdAt', keyPath: 'createdAt' }
      ]
    },
    blobs: { keyPath: 'id', indexes: [] },
    transcripts: {
      keyPath: 'id',
      indexes: [
        { name: 'assetId', keyPath: 'assetId' },
        { name: 'noteId', keyPath: 'noteId' }
      ]
    },
    meta: { keyPath: 'key', indexes: [] }
  };

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        Object.keys(STORES).forEach((name) => {
          const def = STORES[name];
          let os;
          if (!db.objectStoreNames.contains(name)) {
            os = db.createObjectStore(name, { keyPath: def.keyPath });
          } else {
            os = req.transaction.objectStore(name);
          }
          def.indexes.forEach((idx) => {
            if (!os.indexNames.contains(idx.name)) {
              os.createIndex(idx.name, idx.keyPath, { unique: false });
            }
          });
        });
      };
      req.onsuccess = () => {
        _db = req.result;
        _db.onversionchange = () => { _db.close(); _db = null; };
        resolve(_db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('数据库被其他标签页占用，请关闭后重试'));
    });
  }

  function tx(store, mode) {
    return open().then((db) => db.transaction(store, mode).objectStore(store));
  }

  function wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  const DB = {
    ready: open,

    get(store, key) { return tx(store, 'readonly').then((os) => wrap(os.get(key))); },

    all(store) { return tx(store, 'readonly').then((os) => wrap(os.getAll())); },

    byIndex(store, index, value) {
      return tx(store, 'readonly').then((os) => wrap(os.index(index).getAll(value)));
    },

    put(store, value) {
      return tx(store, 'readwrite').then((os) => {
        if (!value.id) value.id = DB.uid();
        return wrap(os.put(value)).then(() => value);
      });
    },

    putMany(store, list) {
      return tx(store, 'readwrite').then((os) => {
        list.forEach((v) => { if (!v.id) v.id = DB.uid(); os.put(v); });
        return new Promise((resolve, reject) => {
          os.transaction.oncomplete = () => resolve(list);
          os.transaction.onerror = () => reject(os.transaction.error);
        });
      });
    },

    del(store, key) { return tx(store, 'readwrite').then((os) => wrap(os.delete(key))); },

    count(store) { return tx(store, 'readonly').then((os) => wrap(os.count())); },

    clear(store) { return tx(store, 'readwrite').then((os) => wrap(os.clear())); },

    uid() {
      const t = Date.now().toString(36);
      const r = Math.random().toString(36).slice(2, 8);
      return t + '-' + r;
    },

    /** 导出全部数据为纯 JSON（不含 Blob，Blob 单独处理） */
    async dump() {
      const out = { app: 'luozi', schema: DB_VERSION, exportedAt: new Date().toISOString() };
      for (const name of Object.keys(STORES)) {
        out[name] = await DB.all(name);
      }
      return out;
    },

    /** 从 JSON 恢复（合并写，不删已有） */
    async restore(data) {
      if (!data || data.app !== 'luozi') throw new Error('不是落字的备份文件');
      let n = 0;
      for (const name of Object.keys(STORES)) {
        const list = data[name];
        if (Array.isArray(list) && list.length) {
          await DB.putMany(name, list);
          n += list.length;
        }
      }
      return n;
    },

    /** 清空所有业务数据，保留 meta 里的设置 */
    async wipe() {
      for (const name of Object.keys(STORES)) {
        if (name === 'meta') continue;
        await DB.clear(name);
      }
    }
  };

  global.DB = DB;

  /* ---------- 设置项（meta 仓的糖） ---------- */
  const DEFAULTS = {
    hue: 159,
    theme: 'auto',
    asrEngine: 'browser',      // browser | custom
    asrBaseUrl: '',
    asrApiKey: '',
    asrModel: 'whisper-1',
    semesterStart: '',
    totalWeeks: 20,
    installedAt: null
  };

  const Settings = {
    async all() {
      const rows = await DB.all('meta');
      const map = Object.assign({}, DEFAULTS);
      rows.forEach((r) => { if (r.key in DEFAULTS) map[r.key] = r.value; });
      return map;
    },
    async get(key) {
      const row = await DB.get('meta', key);
      return row ? row.value : DEFAULTS[key];
    },
    set(key, value) { return DB.put('meta', { key: key, value: value }); },
    defaults: DEFAULTS
  };

  global.Settings = Settings;

})(window);

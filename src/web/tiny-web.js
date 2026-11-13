// The tinyjs bridge, rebuilt on browser APIs, so the same frontend runs as a
// web page (GitHub Pages). Photos are File objects that stay in this tab:
// nothing is uploaded. tools/build-web.js loads this before app.js.
//
// The app passes file "paths" around; here a path is a made-up name that maps
// to a File ("web:3/IMG_0001.JPG") or to a picked folder ("web:4/DCIM").
window.tiny = (() => {
  const files = new Map();     // path -> File
  const dirs = new Map();      // path -> [paths of the images directly inside]
  const urls = new Map();      // path -> object URL
  const saves = new Map();     // save id -> { name, handle, parts }
  const handles = new Map();   // save path -> FileSystemFileHandle (Chromium's save dialog)
  const IMAGE_EXT = /\.(jpe?g|png|arw)$/i;
  let seq = 0, nextSave = 1;

  const addFile = (file, dirPath) => {
    const path = (dirPath || `web:${++seq}`) + '/' + file.name;
    files.set(path, file);
    return path;
  };
  const addDir = (name, list) => {
    const path = `web:${++seq}/${name}`;
    dirs.set(path, list.filter((f) => IMAGE_EXT.test(f.name)).map((f) => addFile(f, path)));
    return path;
  };
  const fileOf = (path) => {
    const f = files.get(path);
    if (!f) throw new Error('This photo is no longer available; add it again.');
    return f;
  };

  const toBase64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromBase64 = (b64) => {
    const s = atob(b64), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  };
  const readRange = async (path, offset, length) =>
    toBase64(new Uint8Array(await fileOf(path).slice(offset, offset + length).arrayBuffer()));

  // A hidden <input type=file>; resolves with its files, or null on cancel.
  const pick = (setup) => new Promise((ok) => {
    const input = document.createElement('input');
    input.type = 'file';
    setup(input);
    input.style.display = 'none';
    let done = false;
    const finish = (v) => { if (!done) { done = true; input.remove(); ok(v); } };
    input.addEventListener('change', () => finish(input.files.length ? [...input.files] : null));
    input.addEventListener('cancel', () => finish(null));
    document.body.append(input);
    input.click();
  });

  // Dropped items: files, plus the images directly inside dropped folders.
  const readEntries = (dir) => new Promise((ok, bad) => {
    const reader = dir.createReader(), all = [];
    const more = () => reader.readEntries((batch) => (batch.length ? (all.push(...batch), more()) : ok(all)), bad);
    more();
  });
  const entryFile = (entry) => new Promise((ok, bad) => entry.file(ok, bad));
  async function dropped(dt) {
    const entries = [...(dt.items || [])].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) return [...dt.files].map((f) => addFile(f));
    const out = [];
    for (const e of entries) {
      if (e.isDirectory) {
        const inside = (await readEntries(e)).filter((x) => x.isFile && IMAGE_EXT.test(x.name));
        out.push(addDir(e.name, await Promise.all(inside.map(entryFile))));
      } else if (e.isFile) out.push(addFile(await entryFile(e)));
    }
    return out;
  }

  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  const api = {
    selftestConfig: () => null,
    listImages({ paths }) {
      const out = [];
      for (const p of paths) {
        if (dirs.has(p)) out.push(...dirs.get(p));
        else if (files.has(p) && IMAGE_EXT.test(p)) out.push(p);
      }
      return out.sort();
    },
    readHead: ({ path, bytes = 70000 }) => readRange(path, 0, Math.min(bytes, 1 << 20)),
    readRange: ({ path, offset, length }) => readRange(path, offset, Math.min(length, 8 << 20)),
    saveBegin({ path }) {
      const id = nextSave++;
      saves.set(id, { name: path.split('/').pop(), handle: handles.get(path), parts: [] });
      return id;
    },
    saveChunk({ id, b64 }) {
      const s = saves.get(id);
      if (!s) throw new Error('Unknown save id ' + id);
      s.parts.push(fromBase64(b64));
      return true;
    },
    async saveEnd({ id }) {
      const s = saves.get(id);
      if (!s) throw new Error('Unknown save id ' + id);
      saves.delete(id);
      const blob = new Blob(s.parts, { type: /\.png$/i.test(s.name) ? 'image/png' : 'image/jpeg' });
      if (s.handle) {
        const w = await s.handle.createWritable();
        await w.write(blob);
        await w.close();
      } else download(s.name, blob);
      return blob.size;
    },
    saveAbort({ id }) { return saves.delete(id); },
  };

  const menuItems = [];
  let menuHandler = () => {};
  // Native menu shortcuts (Ctrl/Cmd + key) still work; there is no menu bar.
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const item = menuItems.find((m) => m.key && m.key.toLowerCase() === e.key.toLowerCase());
    if (item) { e.preventDefault(); menuHandler(item.id); }
  });

  return {
    web: true,
    // File objects from the page itself (the sample burst): paths the app can use
    addFiles: (list) => list.map((f) => addFile(f)),
    fileURL(path) {
      if (!urls.has(path)) urls.set(path, URL.createObjectURL(fileOf(path)));
      return urls.get(path);
    },
    api: {
      async call(method, params = {}) {
        if (!api[method]) throw new Error('Not available in the web version: ' + method);
        return api[method](params);
      },
      on: () => () => {},
    },
    dialog: {
      async openFiles() {
        const list = await pick((i) => { i.multiple = true; i.accept = '.jpg,.jpeg,.png,.arw,image/jpeg,image/png'; });
        return list && list.map((f) => addFile(f));
      },
      async pickFolder() {
        const list = await pick((i) => { i.webkitdirectory = true; });
        if (!list) return null;
        // webkitdirectory lists every subfolder too; keep the top level, like the desktop app
        const top = list.filter((f) => (f.webkitRelativePath || f.name).split('/').length <= 2);
        const name = (list[0].webkitRelativePath || 'folder').split('/')[0];
        return addDir(name, top);
      },
      async saveFile({ types = ['jpg'] } = {}) {
        const ext = types[0], name = `burst-superres.${ext}`;
        if (!window.showSaveFilePicker) return `web-save/${name}`;
        try {
          const handle = await window.showSaveFilePicker({ suggestedName: name,
            types: [{ description: ext.toUpperCase(), accept: { [ext === 'png' ? 'image/png' : 'image/jpeg']: ['.' + ext] } }] });
          // the app adds the extension when the name has none; key the handle the same way
          const path = `web-save:${++seq}/${handle.name}` + (/\.(jpe?g|png)$/i.test(handle.name) ? '' : '.' + ext);
          handles.set(path, handle);
          return path;
        } catch (e) {
          if (e && e.name === 'AbortError') return null;
          return `web-save/${name}`;   // picker blocked (e.g. cross-origin frame): fall back to a download
        }
      },
      alert: async (title, message) => window.alert(title + '\n\n' + message),
      confirm: async (title, message) => window.confirm(title + '\n\n' + message),
    },
    menu: {
      set: async (menus) => { menuItems.length = 0; for (const m of menus) menuItems.push(...(m.items || [])); },
      on: (fn) => { menuHandler = fn; },
    },
    win: {
      onDrop(fn) {
        document.addEventListener('drop', async (e) => {
          e.preventDefault();
          fn(await dropped(e.dataTransfer));
        });
      },
      setFullscreen: (on) => (on ? document.documentElement.requestFullscreen() : document.exitFullscreen()).catch(() => {}),
    },
    store: {
      set: async (k, v) => { try { localStorage.setItem('tiny:' + k, JSON.stringify(v)); } catch { /* not persisted */ } },
      get: async (k) => { try { return JSON.parse(localStorage.getItem('tiny:' + k)); } catch { return null; } },
    },
    app: { shell: { open: (url) => window.open(url, '_blank', 'noopener'), reveal: () => {} } },
    quit: () => {},
  };
})();

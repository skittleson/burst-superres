// Backend (txiki.js). It only touches the disk: all pixel work runs in the
// page, which has a JIT. The bridge is text, so the page sends the encoded
// output in base64 chunks and we append them to the file.

const IMAGE_EXT = /\.(jpe?g|png)$/i;
const open = new Map();
let nextId = 1;

export const api = {
  // Smoke-test hook (see app.js); null unless BURST_SELFTEST is set.
  selftestConfig() {
    const raw = tjs.env.BURST_SELFTEST;
    return raw ? JSON.parse(raw) : null;
  },

  // Dropped or picked paths -> image files. Folders are expanded one level.
  async listImages({ paths }) {
    const out = [];
    for (const p of paths) {
      let st;
      try { st = await tjs.stat(p); } catch { continue; }
      if (st.isDirectory) {
        const dir = p.replace(/[\\/]+$/, '');
        for await (const e of await tjs.readDir(dir)) {
          if (!IMAGE_EXT.test(e.name)) continue;
          const path = dir + '/' + e.name;
          // symlinks report isFile false: follow them
          if (e.isFile || (e.isSymbolicLink && (await tjs.stat(path).catch(() => ({}))).isFile)) out.push(path);
        }
      } else if (IMAGE_EXT.test(p)) out.push(p);
    }
    return out.sort();
  },

  // First `bytes` of a file as base64: enough for the JPEG's EXIF block.
  async readHead({ path, bytes = 70000 }) {
    const h = await tjs.open(path, 'r');
    try {
      const buf = new Uint8Array(bytes);
      const n = await h.read(buf, 0);
      return buf.subarray(0, n ?? 0).toBase64();
    } finally {
      await h.close();
    }
  },

  async saveBegin({ path }) {
    const id = nextId++;
    open.set(id, { path, file: await tjs.open(path, 'w') });
    return id;
  },

  async saveChunk({ id, b64 }) {
    const entry = open.get(id);
    if (!entry) throw new Error('Unknown save id ' + id);
    await entry.file.write(Uint8Array.fromBase64(b64));
    return true;
  },

  async saveEnd({ id }) {
    const entry = open.get(id);
    if (!entry) throw new Error('Unknown save id ' + id);
    open.delete(id);
    await entry.file.close();
    return (await tjs.stat(entry.path)).size;
  },

  // Close and delete a partly written file after a failed save.
  async saveAbort({ id }) {
    const entry = open.get(id);
    if (!entry) return false;
    open.delete(id);
    await entry.file.close();
    await tjs.remove(entry.path).catch(() => {});
    return true;
  },
};

export function init() {}

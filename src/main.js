// Backend (txiki.js). It only touches the disk: all pixel work runs in the
// page, which has a JIT. The bridge is text, so the page sends the encoded
// output in base64 chunks and we append them to the file.

const open = new Map();
let nextId = 1;

export const api = {
  // Smoke-test hook (see app.js); null unless BURST_SELFTEST is set.
  selftestConfig() {
    const raw = tjs.env.BURST_SELFTEST;
    return raw ? JSON.parse(raw) : null;
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

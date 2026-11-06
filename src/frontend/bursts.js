/* bursts.js: split a folder of photos into bursts. Page script and node
 * module, like sr-core.js.
 *
 * Names like 20231228_122526.JPG, 20231228_122526_2.JPG … share a base name
 * and are one burst, ordered by the number. Camera names like DSC01234.JPG
 * have no shared base, so neighbouring groups are joined when their capture
 * times (EXIF, seconds) are at most `gap` seconds apart.
 */
function createBursts() {
  'use strict';
  const NAME = /^(.*?)(?:_(\d{1,3}))?\.(jpe?g|png)$/i;
  const base = (p) => p.split(/[\\/]/).pop();

  // files: [{ path, time }] (time in seconds or null). Returns [{ name, paths }].
  function groupBursts(files, { gap = 2 } = {}) {
    const byStem = new Map();
    for (const f of files) {
      const m = base(f.path).match(NAME);
      if (!m) continue;
      const stem = m[1], n = m[2] ? +m[2] : 1;
      if (!byStem.has(stem)) byStem.set(stem, []);
      byStem.get(stem).push({ ...f, n });
    }
    const groups = [...byStem.entries()].map(([stem, list]) => {
      list.sort((a, b) => a.n - b.n);
      const times = list.map((f) => f.time).filter((t) => t != null);
      return { name: stem, items: list, first: times.length ? Math.min(...times) : null, last: times.length ? Math.max(...times) : null };
    }).sort((a, b) => (a.first ?? Infinity) - (b.first ?? Infinity) || (a.name < b.name ? -1 : 1));

    const out = [];
    for (const g of groups) {
      const prev = out[out.length - 1];
      if (prev && prev.last != null && g.first != null && g.first - prev.last <= gap) {
        prev.items.push(...g.items); prev.last = Math.max(prev.last, g.last);
      } else out.push({ ...g, items: [...g.items] });
    }
    return out.map((g) => ({ name: base(g.items[0].path).replace(/\.[^.]+$/, ''), paths: g.items.map((f) => f.path) }));
  }

  return { groupBursts };
}

if (typeof module === 'object' && module.exports) module.exports = createBursts();

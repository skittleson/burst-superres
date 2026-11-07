/* global createSRCore, createExif, createBursts, createRaw, tiny */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const SR = createSRCore();
const EXIF = createExif();
const BURSTS = createBursts();
const RAWF = createRaw();

const VERSION = '0.3.0';
const GUIDE_URL = 'https://dctmlab.taila665d5.ts.net/';
const SITE_URL = 'https://docodethatmatters.com/';
const IMAGE_EXT = /\.(jpe?g|png|arw)$/i;
const RAW_DIRECT_MIN = 4;          // raw bursts this size or larger merge straight from the sensor samples
const MAX_PHOTOS = 8;
const MAX_OUTPUT_PIXELS = 268e6;   // WebKit/Chromium canvas area limit
const CHUNK = 3 * 1024 * 1024;     // bytes per bridge message when saving
const GOOD_PX = 0.3;               // alignment error that counts as "good"
const VERDICT_LABEL = { good: 'Good', soft: 'Soft', bad: 'Too far off' };
const MODE_LABEL = { mean: 'Mean', median: 'Median', pairwise: 'Pairwise' };

const state = {
  photos: [],        // { path, name, width, height, thumb, include, detail }
  busy: false,
  aligned: null,     // { key, refIndex } once the worker holds aligned frames for this photo list
  results: null,     // { mode: { canvas, diff } }, plus mainMode, key, inputW, inputH, refIndex
  focus: null,       // centre of the compare crop, output pixels
  beforeReq: 0,
  holdBefore: false,
};

// ---------- worker: all pixel work happens here ----------

// Runs inside the worker; SR is createSRCore() and RAW is createRaw(),
// instantiated there. It keeps the decoded photos and their alignment, so
// ticking photos or changing the method only re-merges.
function workerMain(SR, RAW) {
  let frames = null, raws = null, reg = null, orientation = 1, exposure = 1, refOriented = null, finish = null;
  const step = (phase) => (p, label) => postMessage({ type: 'progress', phase, p, label });
  const summary = (d, i, w, h) => {
    const W = d.warp, F = W.field, cx = (w - 1) / 2, cy = (h - 1) / 2;
    const [u, v] = SR.mapPoint(W, F, cx, cy);
    let move = 0;
    for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1], [cx, cy]]) {
      const [a, b] = SR.mapPoint(W, F, x, y);
      move = Math.max(move, Math.hypot(a - x, b - y));
    }
    return { dx: u - cx, dy: v - cy, rot: Math.atan2(W.d, W.a) * 180 / Math.PI, move,
      err: d.err, verdict: d.verdict, mode: d.mode, badFraction: d.badFraction, fitRms: d.fitRms || 0, gain: d.gain };
  };
  const oriented = (img) => (orientation === 1 ? img : RAW.orient(img, orientation));
  self.onmessage = (e) => {
    const msg = e.data;
    try {
      if (msg.type === 'align') {
        raws = null; orientation = 1; exposure = 1; finish = null;
        if (msg.frames[0].kind === 'raw') {
          raws = []; frames = [];
          msg.frames.forEach((f, i) => {
            step('decode')(i / msg.frames.length, `Decoding raw photo ${i + 1} of ${msg.frames.length}`);
            const bytes = new Uint8Array(f.buffer), info = RAW.parse(bytes), raw = RAW.decode(bytes, info);
            if (i === 0) { exposure = RAW.autoExposure(raw, info, f.targetMean || 110); orientation = info.orientation; finish = RAW.finisher(info, exposure); }
            raws.push({ raw, info, levels: RAW.levels(info) });
            frames.push(RAW.render(raw, info, { exposure, orient: false }));
          });
        } else {
          frames = msg.frames.map((f) => ({ width: f.width, height: f.height, data: new Uint8ClampedArray(f.buffer) }));
        }
        reg = SR.registerBurst(frames, step('align'));
        refOriented = oriented(frames[reg.refIndex]);
        const { width: w, height: h } = frames[0];
        postMessage({ type: 'aligned', refIndex: reg.refIndex, raw: !!raws, exposure, details: reg.details.map((d, i) => summary(d, i, w, h)) });
      } else if (msg.type === 'merge') {
        const idx = msg.selection.map((on, i) => (on || i === reg.refIndex ? i : -1)).filter((i) => i >= 0);
        const refK = idx.indexOf(reg.refIndex);
        const direct = !!raws && idx.length >= msg.rawDirectMin;
        const cfa = (k) => ({ width: raws[k].info.width, height: raws[k].info.height, stride: raws[k].info.rawWidth, data: raws[k].raw,
          cfa: raws[k].info.cfa, black: raws[k].levels.black, gain: raws[k].levels.gain });
        // brightness gains were measured on sRGB renders; in linear light they are about g^2.2
        const wl = (k) => ({ ...reg.warps[k], gainLinear: (reg.warps[k].gain || [1, 1, 1]).map((g) => Math.pow(g, 2.2)) });
        const mergeDirect = (keep, region) => SR.mergeCFA(keep.map(cfa), keep.map(wl), { region, refIndex: keep.indexOf(reg.refIndex), toRGBA: finish, onProgress: region ? undefined : step('merge') });
        const outs = {};
        const rest = msg.modes.filter((m) => !(direct && m === 'mean'));
        if (direct && msg.modes.includes('mean')) outs.mean = mergeDirect(idx);
        if (rest.length) Object.assign(outs, SR.merge(idx.map((i) => frames[i]), idx.map((i) => reg.warps[i]),
          { modes: rest, refIndex: refK, onProgress: step('merge') }));
        // sharpening after the merge (deblur): fixed amount, or chosen from the burst itself
        let amount = typeof msg.sharpen === 'number' ? msg.sharpen : 0, picked = null;
        if (msg.sharpen === 'auto') {
          step('sharpen')(0, 'Choosing the sharpening');
          const pick = SR.chooseDeblur(idx.map((i) => frames[i]), idx.map((i) => reg.warps[i]), idx.map((i) => reg.details[i]), refK,
            direct ? { mergeRegion: (keep, R) => mergeDirect(keep.map((k) => idx[k]), R) } : {});
          amount = pick.amount; picked = pick;
        }
        postMessage({ type: 'progress', phase: 'merge', p: 1, label: 'Comparing with one photo' });
        for (const mode of msg.modes) {
          let out = oriented(outs[mode]);
          if (amount > 0) out = SR.deblur(out, { amount, onProgress: step('sharpen') });
          const diff = SR.compareToSingle(out, refOriented);
          postMessage({ type: 'result', mode, width: out.width, height: out.height, diff, direct: direct && mode === 'mean', buffer: out.data.buffer }, [out.data.buffer]);
        }
        postMessage({ type: 'merged', count: idx.length, sharpen: amount, auto: msg.sharpen === 'auto', pickNote: picked && picked.reason });
      } else if (msg.type === 'before' && reg) {
        const r = SR.resampleRegion(refOriented, { scale: 2, x: msg.x, y: msg.y, width: msg.width, height: msg.height });
        postMessage({ type: 'before', id: msg.id, width: r.width, height: r.height, buffer: r.data.buffer }, [r.data.buffer]);
      }
    } catch (err) {
      postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
  };
}

// Built from function source: Chromium (WebView2) refuses file:// workers.
const WORKER_URL = URL.createObjectURL(new Blob(
  [`const SR = (${createSRCore.toString()})();\nconst RAW = (${createRaw.toString()})();\n(${workerMain.toString()})(SR, RAW);`],
  { type: 'text/javascript' }));
let worker = null, onWorker = () => {};
function startWorker() {
  if (worker) worker.terminate();
  worker = new Worker(WORKER_URL);
  worker.onmessage = (e) => {
    try { (e.data.type === 'before' ? showBefore : onWorker)(e.data); } catch (err) { onStage('error ' + err); fail(String((err && err.message) || err)); }
  };
  worker.onerror = (e) => fail('Worker error: ' + (e.message || e));
}
startWorker();

// ---------- photos ----------

function loadImage(path) {
  const img = new Image();
  img.src = tiny.fileURL(path);
  return img.decode().then(() => img);
}

const fileName = (p) => p.split(/[\\/]/).pop();
const photoKey = () => state.photos.map((p) => p.path).join('\n');

const b64bytes = (b64) => (Uint8Array.fromBase64 ? Uint8Array.fromBase64(b64) : fromBase64(b64));

// Thumbnail data URL and mean luma (0..255) of an image element.
function thumbOf(img) {
  const c = document.createElement('canvas');
  c.width = 100; c.height = Math.max(1, Math.round(100 * img.naturalHeight / img.naturalWidth));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return { thumb: c.toDataURL('image/jpeg', 0.8), mean: s / (d.length / 4) };
}

// An ARW: size and metadata from the header, thumbnail from the embedded preview.
async function rawEntry(path) {
  const head = b64bytes(await tiny.api.call('readHead', { path, bytes: 200000 }));
  const info = RAWF.parse(head), meta = RAWF.headerInfo(head);
  const turned = info.orientation === 6 || info.orientation === 8;
  const entry = { path, name: fileName(path), raw: true, meta, width: turned ? info.height : info.width, height: turned ? info.width : info.height };
  if (meta.preview) {
    const jpg = b64bytes(await tiny.api.call('readRange', { path, offset: meta.preview.offset, length: meta.preview.length }));
    const url = URL.createObjectURL(new Blob([jpg], { type: 'image/jpeg' }));
    try {
      const img = new Image(); img.src = url; await img.decode();
      Object.assign(entry, thumbOf(img));
    } finally { URL.revokeObjectURL(url); }
  }
  return entry;
}

async function addPaths(paths) {
  const fresh = paths.filter((p) => IMAGE_EXT.test(p) && !state.photos.some((x) => x.path === p));
  if (paths.length && !fresh.length) setStatus('Those photos are already in the list, or are not JPEG, PNG or Sony ARW.', true);
  let skipped = 0;
  for (const path of fresh) {
    if (state.photos.length >= MAX_PHOTOS) { skipped++; continue; }
    try {
      if (RAWF.isRawName(path)) {
        state.photos.push({ ...(await rawEntry(path)), include: true, detail: null });
      } else {
        const img = await loadImage(path);
        state.photos.push({ path, name: fileName(path), width: img.naturalWidth, height: img.naturalHeight,
          ...thumbOf(img), include: true, detail: null });
        img.src = '';
      }
    } catch (e) {
      setStatus(`Could not read ${fileName(path)}: ${(e && e.message) || e}`, true);
    }
  }
  if (state.photos.length) applySharpenDefault();
  if (skipped) setStatus(`Up to ${MAX_PHOTOS} photos. ${skipped} more were not added.`);
  photosChanged();
}

// Dropped or picked files and folders: expand folders, and when they hold
// several bursts, let the user pick one.
async function addDropped(paths) {
  const files = await tiny.api.call('listImages', { paths });
  if (!files.length) return setStatus('No JPEG, PNG or Sony ARW photos there.', true);
  if (files.length <= MAX_PHOTOS && !paths.some((p) => !IMAGE_EXT.test(p))) return addPaths(files);
  setStatus(`Reading ${files.length} photos to find the bursts…`);
  const withTimes = [];
  for (const path of files) {
    let time = null;
    if (files.length <= 400) {
      try {
        if (/\.jpe?g$/i.test(path)) time = EXIF.captureTime(EXIF.extractApp1(b64bytes(await tiny.api.call('readHead', { path }))));
        else if (RAWF.isRawName(path)) time = RAWF.headerInfo(b64bytes(await tiny.api.call('readHead', { path, bytes: 4096 }))).time;
      } catch { /* no EXIF */ }
    }
    withTimes.push({ path, time });
  }
  const groups = BURSTS.groupBursts(withTimes).filter((g) => g.paths.length >= 2);
  setStatus('');
  if (!groups.length) return addPaths(files.slice(0, MAX_PHOTOS));
  if (groups.length === 1) return addBurst(groups[0]);
  showBurstChooser(groups);
}

function addBurst(g) {
  $('bursts').hidden = true;
  state.photos = [];
  return (state.adding = addPaths(g.paths.slice(0, MAX_PHOTOS)).then(() => {
    if (g.paths.length > MAX_PHOTOS) setStatus(`${g.name} has ${g.paths.length} photos; the first ${MAX_PHOTOS} were added.`);
  }));
}

function showBurstChooser(groups) {
  $('burstsTitle').textContent = `Found ${groups.length} bursts. Pick one:`;
  $('burstList').innerHTML = groups.map((g, i) =>
    `<li><button data-g="${i}">${esc(g.name)} <span class="muted">· ${g.paths.length} photos</span></button></li>`).join('');
  $('burstList').onclick = (e) => { const b = e.target.closest('button[data-g]'); if (b) addBurst(groups[+b.dataset.g]); };
  $('bursts').hidden = false;
}

function fromBase64(b64) {
  const s = atob(b64), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function photosChanged() {
  if (state.aligned && state.aligned.key !== photoKey()) state.aligned = null;
  renderList();
  updateStale();
  updateEstimate();
}

function badgeFor(p, i) {
  const d = p.detail;
  if (!d) return '';
  if (state.aligned && i === state.aligned.refIndex) return '<span class="badge ref" title="The sharpest photo. The others are aligned to it.">Reference</span>';
  const tip = `moved ${d.dx.toFixed(2)}, ${d.dy.toFixed(2)} px` +
    (Math.abs(d.rot) >= 0.005 ? ` · turned ${d.rot.toFixed(2)}°` : '') +
    ` · alignment error ${d.err.toFixed(2)} px` +
    (d.mode === 'local' ? ` · handheld correction on${d.badFraction > 0.005 ? `, ${(d.badFraction * 100).toFixed(0)}% of the picture left out where it did not match` : ''}` : '');
  return `<span class="badge ${d.verdict}" title="${esc(tip)}">${VERDICT_LABEL[d.verdict]}</span>`;
}

function renderList() {
  $('list').innerHTML = state.photos.map((p, i) => {
    const isRef = state.aligned && i === state.aligned.refIndex;
    return `<li class="${p.include || isRef ? '' : 'off'}">
      <input type="checkbox" data-inc="${i}" ${p.include || isRef ? 'checked' : ''} ${isRef || state.busy ? 'disabled' : ''}
        title="${isRef ? 'The reference is always used' : 'Use this photo in the merge'}" aria-label="Use ${esc(p.name)}">
      <img src="${p.thumb}" alt="">
      <div><div class="name" title="${esc(p.path)}">${esc(p.name)}</div>
        <div class="meta${isRef ? ' ref' : ''}">${p.width} × ${p.height}${p.raw ? ' · RAW' : ''}</div></div>
      ${badgeFor(p, i)}
      <button class="remove" data-rm="${i}" title="Remove" ${state.busy ? 'disabled' : ''}>×</button>
    </li>`;
  }).join('');
  const using = state.photos.filter((p, i) => p.include || (state.aligned && i === state.aligned.refIndex)).length;
  const offBadly = state.photos.filter((p) => !p.include && p.detail && p.detail.err > GOOD_PX).length;
  $('using').textContent = state.aligned && state.photos.length
    ? `Merging ${using} of ${state.photos.length} photos.` +
      (offBadly ? ` ${offBadly} did not line up well enough; tick ${offBadly > 1 ? 'them' : 'it'} to use ${offBadly > 1 ? 'them' : 'it'} anyway.` : '')
    : '';
  $('merge').disabled = state.busy || state.photos.length < 2;
  $('merge').textContent = state.results ? 'Merge again' : 'Merge';
  for (const id of ['pick', 'pickFolder', 'mode', 'compareMethods', 'sharpen']) $(id).disabled = state.busy;
}

$('list').addEventListener('click', (e) => {
  if (state.busy) return;
  const rm = e.target.closest('[data-rm]');
  if (rm) { state.photos.splice(+rm.dataset.rm, 1); state.aligned = null; photosChanged(); return; }
  const inc = e.target.closest('[data-inc]');
  if (inc) { state.photos[+inc.dataset.inc].include = inc.checked; renderList(); updateStale(); }
});

async function pickPhotos() {
  if (state.busy) return;
  const paths = await tiny.dialog.openFiles({ types: ['jpg', 'jpeg', 'JPG', 'JPEG', 'png', 'PNG', 'arw', 'ARW'] });
  if (paths) await addDropped(paths);
}
async function pickFolder() {
  if (state.busy) return;
  const dir = await tiny.dialog.pickFolder();
  if (dir) await addDropped([dir]);
}

// ---------- status, progress, estimate ----------

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('err', isError);
}
function setProgress(p) {
  $('progress').hidden = p == null;
  $('progress').firstElementChild.style.width = `${Math.round((p || 0) * 100)}%`;
}
function setBusy(b) {
  state.busy = b;
  $('cancel').hidden = !b;
  $('saveJpg').disabled = $('savePng').disabled = $('remerge').disabled = b;
  renderList();
}
function fail(message) {
  setBusy(false); setProgress(null); setStatus(message, true);
  window.dispatchEvent(new CustomEvent('merge-end', { detail: { ok: false, message } }));
}

// Seconds per photo-megapixel for align + merge, from the last run on this
// computer (falls back to a figure measured on a 2024 laptop).
const stored = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* not persisted */ } },
};
function rate() { return +(stored.get('secPerPhotoMP') || 0.35); }
function updateEstimate() {
  const n = state.photos.length;
  if (n < 2 || state.busy) { $('estimate').textContent = ''; return; }
  const mp = state.photos[0].width * state.photos[0].height / 1e6, s = n * mp * rate();
  $('estimate').textContent = `About ${s < 90 ? Math.round(s) + ' s' : Math.round(s / 60) + ' min'} for ${n} photos of ${mp.toFixed(0)} MP` +
    (stored.get('secPerPhotoMP') ? ', based on your last merge.' : ' (rough; handheld bursts take longer).');
}

function etaText(phase) {
  if (!phase.p || phase.p < 0.05) return '';
  const left = (performance.now() - phase.t0) / 1000 * (1 - phase.p) / phase.p;
  return left < 2 ? '' : ` About ${left < 90 ? Math.round(left) + ' s' : Math.round(left / 60) + ' min'} left.`;
}

// ---------- align + merge ----------

let onStage = () => {};   // self-test progress hook (see the end of this file)
async function decodeAll() {
  const frames = [], c = document.createElement('canvas');
  const g = c.getContext('2d', { willReadFrequently: true });
  for (let i = 0; i < state.photos.length; i++) {
    setStatus(`Reading photo ${i + 1} of ${state.photos.length}…`);
    if (state.photos[i].raw) {
      frames.push({ kind: 'raw', buffer: await readBytes(state.photos[i].path), targetMean: state.photos[0].mean });
      await onStage('read ' + i);
      continue;
    }
    const img = await loadImage(state.photos[i].path);
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    g.drawImage(img, 0, 0);
    frames.push({ kind: 'rgba', width: c.width, height: c.height, buffer: g.getImageData(0, 0, c.width, c.height).data.buffer });
    img.src = '';
    await onStage('decoded ' + i);
  }
  c.width = c.height = 0;
  return frames;
}

// Whole file as an ArrayBuffer. XHR, because fetch() of file:// URLs reports
// status 0 / not ok in WebKitGTK even when it returns the bytes.
function readBytes(path) {
  return new Promise((ok, bad) => {
    const x = new XMLHttpRequest();
    x.open('GET', tiny.fileURL(path));
    x.responseType = 'arraybuffer';
    x.onload = () => (x.response && x.response.byteLength ? ok(x.response) : bad(new Error('empty read')));
    x.onerror = () => bad(new Error('could not read ' + fileName(path)));
    x.send();
  });
}

// Sharpening after the merge: RAW photos default to Auto (measured to help or
// stay neutral), camera JPEGs to Off (they are sharpened in camera; Auto and
// strong settings measured worse on simulated sharpened JPEGs).
let sharpenTouched = false;
function applySharpenDefault() {
  if (sharpenTouched || !state.photos.length) return;
  $('sharpen').value = state.photos.every((p) => p.raw) ? 'auto' : 'off';
}
const sharpenWanted = () => { const v = $('sharpen').value; return v === 'off' ? 0 : v === 'auto' ? 'auto' : +v; };

const modesWanted = () => {
  const main = $('mode').value;
  return $('compareMethods').checked ? [main, main === 'median' ? 'mean' : 'median'] : [main];
};
const mergeKey = () => photoKey() + '|' + state.photos.map((p) => +p.include).join('') + '|' + modesWanted().join(',') + '|' + $('sharpen').value;

function summaryText(details, refIndex) {
  let move = 0, worst = 0;
  details.forEach((d, i) => { if (i !== refIndex) { move = Math.max(move, d.move); worst = Math.max(worst, d.err); } });
  const local = details.some((d) => d.mode === 'local');
  return `Camera moved up to ${move.toFixed(1)} px between shots` + (local ? ' (handheld correction used)' : '') +
    `. Worst alignment error: ${worst.toFixed(2)} px.`;
}

function warningsFor(details, refIndex, sel) {
  const out = [];
  const why = 'Something moved, or the camera moved enough that near and far things shifted differently (parallax). ' +
    `Photos with an alignment error above ${GOOD_PX} px soften or ghost the result.`;
  const off = details.filter((d, i) => i !== refIndex && !sel[i]).length;
  const softUsed = details.filter((d, i) => i !== refIndex && sel[i] && d.err > GOOD_PX).length;
  if (off) out.push([`${off} photo${off > 1 ? 's' : ''} did not line up well enough and ${off > 1 ? 'are' : 'is'} unticked.`,
    why + ' Tick them to use them anyway, or try Median.']);
  if (softUsed) out.push([`${softUsed} soft photo${softUsed > 1 ? 's are' : ' is'} used, because no photo lined up better. Expect some softness.`,
    why + ` Untick ${softUsed > 1 ? 'them' : 'it'} to get just the sharpest photo upscaled, or reshoot with the camera braced.`]);
  const masked = details.filter((d) => d.badFraction > 0.02).length;
  if (masked) out.push([masked > 1 ? `Parts of ${masked} photos were left out where they did not match.` : 'Part of 1 photo was left out where it did not match.',
    'Those areas (for example leaves in the wind, people, or the edge of a near object) come from the other photos only.']);
  if (details.every((d, i) => i === refIndex || d.move < 0.1)) out.push(['The photos did not move at all between shots.',
    'Merging still cuts noise, but a tiny shift between shots is what adds detail.']);
  return out;
}

async function runMerge() {
  if (state.busy || state.photos.length < 2) return;
  const { width: w, height: h } = state.photos[0];
  if (state.photos.some((p) => p.width !== w || p.height !== h)) return fail('All photos must be the same size.');
  if (state.photos.some((p) => !!p.raw !== !!state.photos[0].raw)) return fail('Use either RAW files or JPEG/PNG files in one merge, not both.');
  if (4 * w * h > MAX_OUTPUT_PIXELS) return fail(`Photos up to ${Math.floor(MAX_OUTPUT_PIXELS / 4e6)} MP are supported (the 2× result must fit in one canvas).`);

  setBusy(true);
  $('estimate').textContent = '';
  setProgress(0);
  const started = performance.now();
  const phase = { t0: started, p: 0 };
  const needAlign = !state.aligned;

  onWorker = (msg) => {
    if (msg.type === 'progress') {
      const span = { decode: [0, 0.15], align: [0.15, 0.45], merge: [0.45, 0.85], sharpen: [0.85, 1] }[msg.phase] || [0, 1];
      const lo = needAlign ? span[0] : Math.max(0, (span[0] - 0.45) / 0.55), hi = needAlign ? span[1] : Math.max(0, (span[1] - 0.45) / 0.55);
      const p = lo + msg.p * (hi - lo);
      if (msg.phase !== phase.name) { phase.name = msg.phase; phase.t0 = performance.now(); }
      phase.p = msg.p;
      setProgress(p);
      setStatus(msg.label + '…' + etaText(phase));
      onStage(msg.label + ' ' + msg.p.toFixed(2));
    } else if (msg.type === 'aligned') {
      state.aligned = { key: photoKey(), refIndex: msg.refIndex, raw: msg.raw, exposure: msg.exposure };
      const sel = SR.defaultSelection(msg.details, msg.refIndex, GOOD_PX);
      msg.details.forEach((d, i) => { state.photos[i].detail = d; state.photos[i].include = sel[i]; });
      $('summary').textContent = summaryText(msg.details, msg.refIndex);
      $('warnings').innerHTML = warningsFor(msg.details, msg.refIndex, sel)
        .map(([t, more]) => `<details><summary>${esc(t)}</summary><p>${esc(more)}</p></details>`).join('');
      renderList();
      if (sel.filter(Boolean).length < 2) {
        return fail('No other photo lined up closely enough with the sharpest one. Tick photos to merge them anyway, or reshoot with the camera braced.');
      }
      requestMerge();
    } else if (msg.type === 'result') {
      pending[msg.mode] = msg;
    } else if (msg.type === 'merged') {
      state.mergeInfo = { sharpen: msg.sharpen, auto: msg.auto, direct: Object.values(pending).some((m) => m.direct) };
      showResults(pending, w, h, msg.count);
      setBusy(false); setProgress(null);
      const secs = (performance.now() - started) / 1000;
      if (needAlign) stored.set('secPerPhotoMP', String(secs / (state.photos.length * w * h / 1e6)));
      setStatus(`Merged ${msg.count} photos in ${secs.toFixed(1)} s.`);
      $('expect').open = false;
      window.dispatchEvent(new CustomEvent('merge-end', { detail: { ok: true } }));
    } else if (msg.type === 'error') fail(msg.message);
  };

  let pending = {};
  const requestMerge = () => {
    pending = {};
    worker.postMessage({ type: 'merge', selection: state.photos.map((p) => p.include), modes: modesWanted(), sharpen: sharpenWanted(), rawDirectMin: RAW_DIRECT_MIN });
  };

  if (!needAlign) return requestMerge();
  $('warnings').innerHTML = $('summary').textContent = '';
  state.photos.forEach((p) => { p.detail = null; p.include = true; });
  let frames;
  try { frames = await decodeAll(); } catch (e) { return fail('Could not read the photos: ' + e); }
  worker.postMessage({ type: 'align', frames }, frames.map((f) => f.buffer));
}

function cancelMerge() {
  if (!state.busy) return;
  startWorker();               // the only way to stop a busy worker; it loses the frames
  state.aligned = null;
  fail('Cancelled.');
  renderList(); updateStale(); updateEstimate();
}

// ---------- result + before/after ----------

function showResults(msgs, inputW, inputH, count) {
  const results = {};
  for (const [mode, m] of Object.entries(msgs)) {
    const canvas = document.createElement('canvas');
    canvas.width = m.width; canvas.height = m.height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.buffer), m.width, m.height), 0, 0);
    results[mode] = { canvas, diff: m.diff, width: m.width, height: m.height };
  }
  const mainMode = modesWanted()[0], main = results[mainMode];
  state.results = { ...results, mainMode, modes: Object.keys(results), key: mergeKey(), width: main.width, height: main.height,
    refIndex: state.aligned.refIndex, count };
  if (!state.focus || state.focus.x >= main.width || state.focus.y >= main.height) state.focus = { x: main.width / 2, y: main.height / 2 };

  const ov = $('overview'), s = Math.min(440 / main.width, 300 / main.height);
  ov.width = Math.round(main.width * s); ov.height = Math.round(main.height * s);
  const mi = state.mergeInfo || {};
  const how = [state.aligned.raw ? (mi.direct && mainMode === 'mean' ? 'RAW, merged from the sensor samples' : 'RAW, demosaiced then merged') : null,
    mi.sharpen > 0 ? `sharpened ${mi.sharpen}${mi.auto ? ' (auto)' : ''}` : mi.auto ? 'no sharpening needed (auto)' : null].filter(Boolean).join(' · ');
  $('dims').textContent = `${main.width} × ${main.height} px, from ${count} photos of ${inputW} × ${inputH}` + (how ? ` · ${how}` : '');
  $('diff').textContent = `${MODE_LABEL[mainMode]} vs one photo upscaled 2×: ${main.diff.meanAbs.toFixed(1)} levels different on average (of 255); ` +
    `${main.diff.pctOver.toFixed(0)}% of pixels changed by more than ${main.diff.threshold} levels.`;
  $('compareWrap').hidden = state.results.modes.length < 2;
  const other = state.results.modes[1];
  if (other) $('compareSel').options[1].textContent = `${MODE_LABEL[mainMode]} vs ${MODE_LABEL[other]}`;
  $('empty').hidden = true;
  $('view').hidden = false;
  renderList(); updateStale();
  renderCompare();
}

function updateStale() {
  if (!state.results) { $('stale').hidden = true; return; }
  const photosSame = state.aligned && state.aligned.key === photoKey();
  $('stale').hidden = state.busy || (photosSame && state.results.key === mergeKey());
  $('staleText').textContent = photosSame ? 'Settings changed since this merge.' : 'The photo list changed since this merge.';
}

const isSide = () => $('layout').value === 'side';
const compareMethods = () => state.results && state.results.modes.length > 1 && $('compareSel').value === 'methods';

// Crop rectangle (output pixels) for one pane at the chosen zoom.
function cropRect() {
  const r = state.results, box = $('compare').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1, z = +$('zoom').value;
  const paneW = isSide() ? (box.width - 8) / 2 : box.width;
  const w = Math.min(r.width, Math.floor(paneW * dpr / z)), h = Math.min(r.height, Math.floor(box.height * dpr / z));
  const x = Math.round(clamp(state.focus.x - w / 2, 0, r.width - w)), y = Math.round(clamp(state.focus.y - h / 2, 0, r.height - h));
  return { x, y, w, h, css: z / dpr, paneW };
}

function renderCompare() {
  const r = state.results;
  if (!r) return;
  const c = cropRect();
  if (c.w < 1 || c.h < 1) return;   // compare box not laid out yet
  $('compare').classList.toggle('side', isSide());
  for (const id of ['before', 'after']) {
    const el = $(id);
    el.width = c.w; el.height = c.h;
    el.style.width = `${c.w * c.css}px`; el.style.height = `${c.h * c.css}px`;
  }
  $('after').style.left = isSide() ? `${c.w * c.css + 8}px` : '0';
  if (isSide()) $('after').style.clipPath = 'none';   // setSplit's inline clip would hide the right pane
  const main = r[r.mainMode], other = r.modes[1] && r[r.modes[1]];
  $('after').getContext('2d').drawImage(main.canvas, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
  $('tagAfter').textContent = `After: ${MODE_LABEL[r.mainMode]} of ${r.count} photos`;
  if (compareMethods()) {
    $('before').getContext('2d').drawImage(other.canvas, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
    $('tagBefore').textContent = `${MODE_LABEL[r.modes[1]]} of ${r.count} photos`;
    window.dispatchEvent(new CustomEvent('before-shown'));
  } else {
    $('before').getContext('2d').clearRect(0, 0, c.w, c.h);
    $('tagBefore').textContent = state.aligned && state.aligned.raw ? 'Before: one RAW photo, demosaiced, Lanczos 2×' : 'Before: one photo, Lanczos 2×';
    worker.postMessage({ type: 'before', id: ++state.beforeReq, x: c.x, y: c.y, width: c.w, height: c.h });
  }
  $('tagAfter').style.left = isSide() ? `${c.w * c.css + 16}px` : '';
  $('tagAfter').style.right = isSide() ? 'auto' : '';
  drawNavigator(c);
  setSplit(+$('slider').value);
}

function drawNavigator(c) {
  const r = state.results, ov = $('overview'), g = ov.getContext('2d'), s = ov.width / r.width;
  g.drawImage(r[r.mainMode].canvas, 0, 0, ov.width, ov.height);
  const box = [c.x * s, c.y * s, Math.max(4, c.w * s), Math.max(4, c.h * s)];
  g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,.8)'; g.strokeRect(...box);
  g.lineWidth = 2; g.strokeStyle = '#e8a23a'; g.strokeRect(...box);
}

function showBefore(msg) {
  if (msg.id !== state.beforeReq || compareMethods()) return;   // a newer crop was requested meanwhile
  $('before').getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height), 0, 0);
  window.dispatchEvent(new CustomEvent('before-shown'));
}

function setSplit(pct) {
  if (isSide()) return;
  const shown = state.holdBefore ? 100 : pct;
  $('after').style.clipPath = `inset(0 0 0 ${shown}%)`;
  $('handle').style.left = `${$('after').getBoundingClientRect().width * shown / 100}px`;
}

function moveFocusTo(e) {
  const rr = $('overview').getBoundingClientRect();
  state.focus = { x: clamp((e.clientX - rr.left) / rr.width, 0, 1) * state.results.width,
    y: clamp((e.clientY - rr.top) / rr.height, 0, 1) * state.results.height };
  renderCompare();
}

$('slider').addEventListener('input', (e) => setSplit(+e.target.value));
$('zoom').addEventListener('change', renderCompare);
$('layout').addEventListener('change', renderCompare);
$('compareSel').addEventListener('change', renderCompare);
$('overview').addEventListener('pointerdown', (e) => { e.stopPropagation(); $('overview').setPointerCapture(e.pointerId); moveFocusTo(e); });
$('overview').addEventListener('pointermove', (e) => { if (e.buttons & 1) { e.stopPropagation(); moveFocusTo(e); } });
$('compare').addEventListener('pointermove', (e) => {
  if (!(e.buttons & 1) || isSide() || e.target === $('overview')) return;
  const r = $('after').getBoundingClientRect();
  const pct = clamp((e.clientX - r.left) / r.width * 100, 0, 100);
  $('slider').value = pct; setSplit(pct);
});
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderCompare, 150); });

// Lightroom-style keys: hold \ for the single photo, Y toggles side by side,
// arrows move the split. Ignored while typing in a form control.
document.addEventListener('keydown', (e) => {
  if (!state.results || e.ctrlKey || e.metaKey || e.altKey || /^(SELECT|INPUT|TEXTAREA)$/.test(e.target.tagName) && e.target.id !== 'slider') return;
  if (e.key === '\\') { if (!state.holdBefore) { state.holdBefore = true; setSplit(+$('slider').value); } e.preventDefault(); }
  else if (e.key === 'y' || e.key === 'Y') { $('layout').value = isSide() ? 'split' : 'side'; renderCompare(); }
  else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target.id !== 'slider') {
    const v = clamp(+$('slider').value + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 5), 0, 100);
    $('slider').value = v; setSplit(v); e.preventDefault();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === '\\' && state.holdBefore) { state.holdBefore = false; setSplit(+$('slider').value); }
});

// ---------- save ----------

function toBase64(bytes) {
  if (bytes.toBase64) return bytes.toBase64();
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function writeFile(path, bytes) {
  const id = await tiny.api.call('saveBegin', { path });
  try {
    for (let o = 0; o < bytes.length; o += CHUNK) {
      setProgress(o / bytes.length);
      await tiny.api.call('saveChunk', { id, b64: toBase64(bytes.subarray(o, o + CHUNK)) });
    }
    return await tiny.api.call('saveEnd', { id });
  } catch (e) {
    await tiny.api.call('saveAbort', { id });
    throw e;
  }
}

// EXIF (camera, lens, date, exposure) from the reference photo, for JPEG output.
async function withExif(bytes) {
  const ref = state.photos[state.results.refIndex];
  if (ref && ref.raw && ref.meta) {
    return EXIF.insertApp1(bytes, EXIF.buildApp1({ ...ref.meta, software: `Burst Super-Res ${VERSION}`, width: state.results.width, height: state.results.height }));
  }
  if (!ref || !/\.jpe?g$/i.test(ref.path)) return bytes;
  try {
    const b64 = await tiny.api.call('readHead', { path: ref.path });
    const head = Uint8Array.fromBase64 ? Uint8Array.fromBase64(b64) : fromBase64(b64);
    return EXIF.copyExif(head, bytes, { width: state.results.width, height: state.results.height });
  } catch {
    return bytes;   // saving matters more than the metadata
  }
}

async function save(kind, path) {
  if (!state.results || state.busy) return;
  const ext = kind === 'png' ? 'png' : 'jpg';
  path = path || await tiny.dialog.saveFile({ types: [ext] });
  if (!path) return;
  if (!/\.(jpe?g|png)$/i.test(path)) path += '.' + ext;
  setBusy(true); setProgress(0);
  setStatus(`Encoding ${ext.toUpperCase()}…`);
  try {
    const canvas = state.results[state.results.mainMode].canvas;
    const blob = await new Promise((ok, bad) => canvas.toBlob(
      (b) => (b ? ok(b) : bad(new Error('the encoder returned nothing'))), kind === 'png' ? 'image/png' : 'image/jpeg', 0.95));
    let bytes = new Uint8Array(await blob.arrayBuffer());
    if (kind !== 'png') bytes = await withExif(bytes);
    setStatus('Writing file…');
    const size = await writeFile(path, bytes);
    setBusy(false); setProgress(null);
    $('status').innerHTML = `Saved ${(size / 1048576).toFixed(1)} MB to ${esc(path)}. <a href="#" id="reveal">Show in folder</a>`;
    $('reveal').onclick = (e) => { e.preventDefault(); tiny.app.shell.reveal(path); };
    return path;
  } catch (e) {
    fail('Save failed: ' + ((e && e.message) || e));
  }
}

// ---------- wiring ----------

$('pick').addEventListener('click', pickPhotos);
$('pickFolder').addEventListener('click', pickFolder);
$('merge').addEventListener('click', runMerge);
$('remerge').addEventListener('click', runMerge);
$('cancel').addEventListener('click', cancelMerge);
$('mode').addEventListener('change', () => { renderList(); updateStale(); });
$('compareMethods').addEventListener('change', updateStale);
$('sharpen').addEventListener('change', () => { sharpenTouched = true; updateStale(); });
$('saveJpg').addEventListener('click', () => save('jpg'));
$('savePng').addEventListener('click', () => save('png'));
document.querySelectorAll('a[data-url]').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault(); tiny.app.shell.open(a.dataset.url);
}));

const drop = $('drop');
tiny.win.onDrop((paths) => { drop.classList.remove('over'); if (!state.busy) addDropped(paths); });
document.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });

function about() {
  tiny.dialog.alert(`Burst Super-Res ${VERSION}`,
    'Merges a burst of photos of a still scene into one image with twice the width and height.\n\n' +
    'Free tool from the Sony A6000/A6400 Hacking Guide (chapter 7, "Super-resolution from a burst") by Do Code That Matters.');
}

tiny.menu.set([
  { title: 'File', items: [
    { id: 'open', label: 'Add Photos…', key: 'o' },
    { id: 'openFolder', label: 'Add Folder…' },
    { id: 'saveJpg', label: 'Save as JPEG…', key: 's' },
    { id: 'savePng', label: 'Save as PNG…' },
  ] },
  { title: 'Help', items: [
    { id: 'about', label: 'About Burst Super-Res' },
    { id: 'guide', label: 'Sony A6000/A6400 Hacking Guide' },
    { id: 'site', label: 'docodethatmatters.com' },
  ] },
]);
tiny.menu.on((id) => {
  if (id === 'open') pickPhotos();
  else if (id === 'openFolder') pickFolder();
  else if (id === 'saveJpg') save('jpg');
  else if (id === 'savePng') save('png');
  else if (id === 'about') about();
  else if (id === 'guide') tiny.app.shell.open(GUIDE_URL);
  else if (id === 'site') tiny.app.shell.open(SITE_URL);
});

renderList();

// Smoke test: BURST_SELFTEST='{"photos":[...],"mode":"mean","compare":true,"out":"/tmp/x.jpg","focus":[x,y],
// "split":50,"layout":"side","compareSel":"methods","untick":[2],"fullscreen":true,"holdMs":8000}'
// drives the real UI end to end, stores timings, and quits. Off unless the env var is set.
tiny.api.call('selftestConfig').then(async (cfg) => {
  if (!cfg) return;
  const report = { ok: false, ua: navigator.userAgent, dpr: window.devicePixelRatio };
  const when = (ev) => new Promise((ok) => window.addEventListener(ev, ok, { once: true }));
  const stage = (name) => tiny.store.set('selftest-stage', { name, at: Date.now() });   // last step reached, for hangs
  await stage('start');
  try {
    if (cfg.fullscreen) { tiny.win.setFullscreen(true); await new Promise((ok) => setTimeout(ok, 800)); }
    let t = performance.now();
    await (cfg.drop ? addDropped(cfg.drop) : addPaths(cfg.photos));
    if (cfg.pickBurst != null) { $('burstList').querySelectorAll('button')[cfg.pickBurst].click(); await state.adding; }
    report.addMs = Math.round(performance.now() - t);
    report.added = state.photos.map((p) => p.name);
    report.estimate = $('estimate').textContent;
    await stage('added ' + state.photos.length);
    if (cfg.stopAfterAdd) { report.ok = true; report.bursts = $('burstsTitle').textContent; throw null; }
    $('mode').value = cfg.mode || 'mean';
    $('compareMethods').checked = !!cfg.compare;
    if (cfg.sharpen != null) { $('sharpen').value = String(cfg.sharpen); sharpenTouched = true; }
    report.sharpenSetting = $('sharpen').value;
    t = performance.now();
    let ended = when('merge-end');
    onStage = stage;
    runMerge();
    let end = await ended;
    if (!end.detail.ok) throw new Error(end.detail.message);
    if (cfg.untick) {
      for (const i of cfg.untick) state.photos[i].include = false;
      renderList(); updateStale();
      report.staleShown = !$('stale').hidden;
      ended = when('merge-end'); runMerge(); end = await ended;
      if (!end.detail.ok) throw new Error(end.detail.message);
    }
    report.mergeMs = Math.round(performance.now() - t);
    report.status = $('status').textContent;
    report.dims = $('dims').textContent;
    report.exposure = state.aligned && state.aligned.exposure;
    report.added = state.photos.map((p) => `${p.name} ${p.width}x${p.height}${p.raw ? ' RAW' : ''}`);
    report.using = $('using').textContent;
    report.summary = $('summary').textContent;
    report.diff = $('diff').textContent;
    report.photos = state.photos.map((p, i) => `${p.name}: ${i === state.aligned.refIndex ? 'reference' : `${p.detail.verdict} ${p.detail.err.toFixed(2)} px ${p.detail.mode}`}${p.include ? '' : ' (unticked)'}`);
    report.warnings = [...document.querySelectorAll('#warnings summary')].map((p) => p.textContent);
    report.staleAfter = !$('stale').hidden;
    await stage('merge ok');
    if (cfg.layout) $('layout').value = cfg.layout;
    if (cfg.compareSel) $('compareSel').value = cfg.compareSel;
    if (cfg.focus || cfg.layout || cfg.compareSel) {
      const shown = when('before-shown');
      if (cfg.focus) state.focus = { x: cfg.focus[0], y: cfg.focus[1] };
      renderCompare();
      await shown;
      await stage('before shown');
    }
    if (cfg.split != null) { $('slider').value = cfg.split; setSplit(cfg.split); }
    t = performance.now();
    if (cfg.out) report.saved = await save(/\.png$/i.test(cfg.out) ? 'png' : 'jpg', cfg.out);
    report.saveMs = Math.round(performance.now() - t);
    report.ok = !!report.saved || !cfg.out;
  } catch (e) {
    if (e !== null) report.error = String(e);   // null = stopped on purpose
  }
  await tiny.store.set('selftest', report);
  if (cfg.holdMs) await new Promise((ok) => setTimeout(ok, cfg.holdMs));
  if (cfg.quit !== false) tiny.quit();
});

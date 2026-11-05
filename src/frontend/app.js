/* global createSRCore, tiny */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const GUIDE_URL = 'https://dctmlab.taila665d5.ts.net/';
const SITE_URL = 'https://docodethatmatters.com/';
const IMAGE_EXT = /\.(jpe?g|png)$/i;
const MAX_PHOTOS = 8;
const MAX_OUTPUT_PIXELS = 268e6;   // WebKit/Chromium canvas area limit
const CHUNK = 3 * 1024 * 1024;     // bytes per bridge message when saving

const state = {
  photos: [],        // { path, name, width, height, thumb, meta, bad }
  busy: false,
  result: null,      // { canvas, width, height, inputW, inputH }
  focus: null,       // centre of the compare crop, output pixels
  beforeReq: 0,
};

// ---------- worker: all pixel work happens here ----------

// Runs inside the worker; SR is createSRCore() instantiated there.
function workerMain(SR) {
  let ref = null;   // reference photo, kept for "before" crops
  self.onmessage = (e) => {
    const msg = e.data;
    try {
      if (msg.type === 'merge') {
        ref = null;
        const frames = msg.frames.map((f) => ({ width: f.width, height: f.height, data: new Uint8ClampedArray(f.buffer) }));
        const step = (base, span) => (p, label) => postMessage({ type: 'progress', p: base + span * p, label });
        const reg = SR.registerBurst(frames, step(0, 0.35));
        postMessage({
          type: 'aligned', refIndex: reg.refIndex,
          details: reg.details.map((d) => ({ warp: d.warp, fitRms: d.fitRms, inliers: d.inliers })),
        });
        const out = SR.merge(frames, reg.warps, { mode: msg.mode, refIndex: reg.refIndex, onProgress: step(0.35, 0.62) });
        ref = frames[reg.refIndex];
        postMessage({ type: 'progress', p: 0.98, label: 'Comparing with one photo' });
        const diff = SR.compareToSingle(out, ref);
        postMessage({ type: 'done', width: out.width, height: out.height, diff, buffer: out.data.buffer }, [out.data.buffer]);
      } else if (msg.type === 'before' && ref) {
        const r = SR.resampleRegion(ref, { scale: 2, x: msg.x, y: msg.y, width: msg.width, height: msg.height });
        postMessage({ type: 'before', id: msg.id, width: r.width, height: r.height, buffer: r.data.buffer }, [r.data.buffer]);
      }
    } catch (err) {
      postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
  };
}

// Built from function source: Chromium (WebView2) refuses file:// workers.
const worker = new Worker(URL.createObjectURL(new Blob(
  [`const SR = (${createSRCore.toString()})();\n(${workerMain.toString()})(SR);`],
  { type: 'text/javascript' })));
let onWorker = () => {};
worker.onmessage = (e) => {
  try { (e.data.type === 'before' ? showBefore : onWorker)(e.data); } catch (err) { onStage('error ' + err); fail(String((err && err.message) || err)); }
};
worker.onerror = (e) => fail('Worker error: ' + (e.message || e));

// ---------- photos ----------

function loadImage(path) {
  const img = new Image();
  img.src = tiny.fileURL(path);
  return img.decode().then(() => img);
}

async function addPaths(paths) {
  const fresh = paths.filter((p) => IMAGE_EXT.test(p) && !state.photos.some((x) => x.path === p));
  const skipped = paths.length - fresh.length;
  for (const path of fresh) {
    if (state.photos.length >= MAX_PHOTOS) { setStatus(`Up to ${MAX_PHOTOS} photos. Extra ones were skipped.`); break; }
    try {
      const img = await loadImage(path);
      const c = document.createElement('canvas');
      c.width = 108; c.height = Math.round(108 * img.naturalHeight / img.naturalWidth);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      state.photos.push({
        path, name: path.split(/[\\/]/).pop(), width: img.naturalWidth, height: img.naturalHeight,
        thumb: c.toDataURL('image/jpeg', 0.8), meta: `${img.naturalWidth} × ${img.naturalHeight}`,
      });
      img.src = '';
    } catch (e) {
      setStatus(`Could not read ${path.split(/[\\/]/).pop()}.`, true);
    }
  }
  if (skipped && !fresh.length) setStatus('Only JPEG and PNG photos are supported.', true);
  renderList();
}

function renderList() {
  $('list').innerHTML = state.photos.map((p, i) => `
    <li>
      <img src="${p.thumb}" alt="">
      <div><div class="name" title="${esc(p.path)}">${esc(p.name)}</div>
        <div class="meta${p.bad ? ' bad' : ''}${p.isRef ? ' ref' : ''}">${esc(p.meta)}</div></div>
      <button data-i="${i}" title="Remove" ${state.busy ? 'disabled' : ''}>×</button>
    </li>`).join('');
  $('merge').disabled = state.busy || state.photos.length < 2;
  $('pick').disabled = state.busy;
  $('mode').disabled = state.busy;
}

$('list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (!b || state.busy) return;
  state.photos.splice(+b.dataset.i, 1);
  renderList();
});

async function pickPhotos() {
  if (state.busy) return;
  const paths = await tiny.dialog.openFiles({ types: ['jpg', 'jpeg', 'JPG', 'JPEG', 'png', 'PNG'] });
  if (paths) await addPaths(paths);
}

// ---------- merge ----------

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('err', isError);
}
function setProgress(p) {
  $('progress').hidden = p == null;
  $('progress').firstElementChild.style.width = `${Math.round((p || 0) * 100)}%`;
}
function setBusy(b) { state.busy = b; renderList(); $('saveJpg').disabled = b; $('savePng').disabled = b; }
function fail(message) {
  setBusy(false); setProgress(null); setStatus(message, true);
  window.dispatchEvent(new CustomEvent('merge-end', { detail: { ok: false, message } }));
}

let onStage = () => {};   // self-test progress hook (see the end of this file)
async function decodeAll() {
  const frames = [], c = document.createElement('canvas');
  const g = c.getContext('2d', { willReadFrequently: true });
  for (let i = 0; i < state.photos.length; i++) {
    const p = state.photos[i];
    setStatus(`Reading photo ${i + 1} of ${state.photos.length}…`);
    const img = await loadImage(p.path);
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, c.width, c.height).data;
    frames.push({ width: c.width, height: c.height, buffer: data.buffer });
    img.src = '';
    await onStage('decoded ' + i);
  }
  c.width = c.height = 0;
  return frames;
}

// Displacement of the photo's centre and its rotation, for the photo list.
function describeWarp(d, w, h, isRef) {
  if (isRef) return 'reference (sharpest)';
  const cx = (w - 1) / 2, cy = (h - 1) / 2, W = d.warp;
  const dx = W.a * cx + W.b * cy + W.c - cx, dy = W.d * cx + W.e * cy + W.f - cy;
  const rot = Math.atan2(W.d, W.a) * 180 / Math.PI;
  let s = `moved ${dx.toFixed(2)}, ${dy.toFixed(2)} px`;
  if (Math.abs(rot) >= 0.005) s += ` · turned ${rot.toFixed(2)}°`;
  if (d.inliers) s += ` · fit ${d.fitRms.toFixed(2)} px`;
  return s;
}

// One line on how much the camera moved and how well the photos lined up.
function alignmentSummary(msg, w, h) {
  let move = 0, fit = 0;
  msg.details.forEach((d, i) => {
    if (i === msg.refIndex) return;
    const W = d.warp;
    for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
      move = Math.max(move, Math.hypot(W.a * x + W.b * y + W.c - x, W.d * x + W.e * y + W.f - y));
    }
    fit = Math.max(fit, d.fitRms || 0);
  });
  const verdict = fit <= 0.3 ? 'good for merging' : fit <= 1 ? 'usable, expect some softness; below 0.3 px is good' : 'too much movement for a clean merge';
  return `Camera moved up to ${move.toFixed(1)} px between shots. Worst alignment error: ${fit.toFixed(2)} px (${verdict}).`;
}

function alignmentWarnings(msg, w, h) {
  const out = [];
  let maxMove = 0;
  msg.details.forEach((d, i) => {
    if (i === msg.refIndex) return;
    const W = d.warp;
    for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
      maxMove = Math.max(maxMove, Math.hypot(W.a * x + W.b * y + W.c - x, W.d * x + W.e * y + W.f - y));
    }
    if (d.inliers && d.fitRms > 0.3) {
      out.push(`${state.photos[i].name} did not line up cleanly (fit error ${d.fitRms.toFixed(2)} px). Something moved, or the camera moved enough to cause parallax. Expect softness or ghosting there; Median handles moving things better.`);
    }
  });
  if (maxMove < 0.1) out.push('These photos did not move relative to each other at all, so merging only reduces noise. A tiny shift between shots is what adds detail.');
  return out;
}

async function runMerge() {
  if (state.busy || state.photos.length < 2) return;
  const { width: w, height: h } = state.photos[0];
  if (state.photos.some((p) => p.width !== w || p.height !== h)) return fail('All photos must be the same size.');
  if (4 * w * h > MAX_OUTPUT_PIXELS) return fail(`Photos up to ${Math.floor(MAX_OUTPUT_PIXELS / 4e6)} MP are supported (the 2× result must fit in one canvas).`);

  setBusy(true);
  $('warnings').innerHTML = '';
  $('summary').textContent = '';
  state.photos.forEach((p) => { p.meta = `${p.width} × ${p.height}`; p.bad = p.isRef = false; });
  setProgress(0);
  const started = performance.now();
  let frames;
  try { frames = await decodeAll(); } catch (e) { return fail('Could not read the photos: ' + e); }

  onWorker = (msg) => {
    if (msg.type === 'progress') { setProgress(msg.p); setStatus(msg.label + '…'); onStage(msg.label + ' ' + msg.p.toFixed(2)); }
    else if (msg.type === 'aligned') {
      msg.details.forEach((d, i) => {
        const p = state.photos[i];
        p.isRef = i === msg.refIndex;
        p.meta = describeWarp(d, w, h, p.isRef);
        p.bad = !p.isRef && d.inliers > 0 && d.fitRms > 0.3;
      });
      renderList();
      $('summary').textContent = alignmentSummary(msg, w, h);
      $('warnings').innerHTML = alignmentWarnings(msg, w, h).map((t) => `<p>${esc(t)}</p>`).join('');
    } else if (msg.type === 'done') {
      showResult(msg, w, h);
      setBusy(false); setProgress(null);
      setStatus(`Merged ${state.photos.length} photos in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
      window.dispatchEvent(new CustomEvent('merge-end', { detail: { ok: true } }));
    } else if (msg.type === 'error') fail(msg.message);
  };
  worker.postMessage({ type: 'merge', mode: $('mode').value, frames }, frames.map((f) => f.buffer));
}

// ---------- result + before/after ----------

function showResult(msg, inputW, inputH) {
  const canvas = document.createElement('canvas');
  canvas.width = msg.width; canvas.height = msg.height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height), 0, 0);
  state.result = { canvas, width: msg.width, height: msg.height, inputW, inputH };

  const ov = $('overview'), s = Math.min(520 / msg.width, 300 / msg.height);
  ov.width = Math.round(msg.width * s); ov.height = Math.round(msg.height * s);
  state.focus = state.focus && state.focus.x < msg.width && state.focus.y < msg.height ? state.focus : { x: msg.width / 2, y: msg.height / 2 };

  $('dims').textContent = `${msg.width} × ${msg.height} px, from ${state.photos.length} photos of ${inputW} × ${inputH}`;
  $('diff').textContent = `Difference from one photo upscaled 2×: ${msg.diff.meanAbs.toFixed(1)} levels on average (of 255); ` +
    `${msg.diff.pctOver.toFixed(0)}% of pixels changed by more than ${msg.diff.threshold} levels. Sampled on 96 rows.`;
  $('empty').hidden = true;
  $('view').hidden = false;
  renderCompare();
}

// Crop rectangle (output pixels) that fills the compare box at the chosen zoom.
function cropRect() {
  const r = state.result, box = $('compare').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1, z = +$('zoom').value;
  const w = Math.min(r.width, Math.floor(box.width * dpr / z)), h = Math.min(r.height, Math.floor(box.height * dpr / z));
  const x = Math.round(clamp(state.focus.x - w / 2, 0, r.width - w)), y = Math.round(clamp(state.focus.y - h / 2, 0, r.height - h));
  return { x, y, w, h, css: z / dpr };
}

function renderCompare() {
  const r = state.result;
  if (!r) return;
  const c = cropRect();
  if (c.w < 1 || c.h < 1) return;   // compare box not laid out yet
  for (const id of ['before', 'after']) {
    const el = $(id);
    el.width = c.w; el.height = c.h;
    el.style.width = `${c.w * c.css}px`; el.style.height = `${c.h * c.css}px`;
  }
  $('after').getContext('2d').drawImage(r.canvas, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
  $('before').getContext('2d').clearRect(0, 0, c.w, c.h);
  worker.postMessage({ type: 'before', id: ++state.beforeReq, x: c.x, y: c.y, width: c.w, height: c.h });

  const ov = $('overview'), g = ov.getContext('2d'), s = ov.width / r.width;
  g.drawImage(r.canvas, 0, 0, ov.width, ov.height);
  g.strokeStyle = '#e8a23a'; g.lineWidth = 2;
  g.strokeRect(c.x * s, c.y * s, Math.max(3, c.w * s), Math.max(3, c.h * s));
  setSplit(+$('slider').value);
}

function showBefore(msg) {
  if (msg.id !== state.beforeReq) return;   // a newer crop was requested meanwhile
  $('before').getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height), 0, 0);
  window.dispatchEvent(new CustomEvent('before-shown'));
}

function setSplit(pct) {
  $('after').style.clipPath = `inset(0 0 0 ${pct}%)`;
  $('handle').style.left = `${$('after').getBoundingClientRect().width * pct / 100}px`;
}

$('slider').addEventListener('input', (e) => setSplit(+e.target.value));
$('zoom').addEventListener('change', renderCompare);
$('compare').addEventListener('pointermove', (e) => {
  if (!(e.buttons & 1)) return;
  const r = $('after').getBoundingClientRect();
  const pct = clamp((e.clientX - r.left) / r.width * 100, 0, 100);
  $('slider').value = pct; setSplit(pct);
});
$('overview').addEventListener('click', (e) => {
  const r = $('overview').getBoundingClientRect();
  state.focus = { x: (e.clientX - r.left) / r.width * state.result.width, y: (e.clientY - r.top) / r.height * state.result.height };
  renderCompare();
});
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderCompare, 150); });

// ---------- save ----------

function toBase64(bytes) {
  if (bytes.toBase64) return bytes.toBase64();
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function writeFile(path, blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
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

async function save(kind, path) {
  if (!state.result || state.busy) return;
  const ext = kind === 'png' ? 'png' : 'jpg';
  path = path || await tiny.dialog.saveFile({ types: [ext] });
  if (!path) return;
  if (!/\.(jpe?g|png)$/i.test(path)) path += '.' + ext;
  setBusy(true); setProgress(0);
  setStatus(`Encoding ${ext.toUpperCase()}…`);
  try {
    const blob = await new Promise((ok, bad) => state.result.canvas.toBlob(
      (b) => (b ? ok(b) : bad(new Error('the encoder returned nothing'))), kind === 'png' ? 'image/png' : 'image/jpeg', 0.95));
    setStatus('Writing file…');
    const size = await writeFile(path, blob);
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
$('merge').addEventListener('click', runMerge);
$('saveJpg').addEventListener('click', () => save('jpg'));
$('savePng').addEventListener('click', () => save('png'));
document.querySelectorAll('a[data-url]').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault(); tiny.app.shell.open(a.dataset.url);
}));

const drop = $('drop');
tiny.win.onDrop((paths) => { drop.classList.remove('over'); if (!state.busy) addPaths(paths); });
document.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });

function about() {
  tiny.dialog.alert('Burst Super-Res 0.1.1',
    'Merges a burst of photos of a static scene into one image with twice the width and height.\n\n' +
    'Free tool from the Sony A6000/A6400 Hacking Guide (chapter 7, "Super-resolution from a burst") by Do Code That Matters.');
}

tiny.menu.set([
  { title: 'File', items: [
    { id: 'open', label: 'Add Photos…', key: 'o' },
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
  else if (id === 'saveJpg') save('jpg');
  else if (id === 'savePng') save('png');
  else if (id === 'about') about();
  else if (id === 'guide') tiny.app.shell.open(GUIDE_URL);
  else if (id === 'site') tiny.app.shell.open(SITE_URL);
});

renderList();

// Smoke test: BURST_SELFTEST='{"photos":[...],"mode":"mean","out":"/tmp/x.jpg","focus":[x,y],"split":50,"fullscreen":true,"holdMs":8000}'
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
    await addPaths(cfg.photos);
    report.addMs = Math.round(performance.now() - t);
    await stage('added ' + state.photos.length);
    $('mode').value = cfg.mode || 'mean';
    t = performance.now();
    const ended = when('merge-end');
    onStage = stage;
    runMerge();
    const end = await ended;
    if (!end.detail.ok) throw new Error(end.detail.message);
    report.mergeMs = Math.round(performance.now() - t);
    report.status = $('status').textContent;
    report.dims = $('dims').textContent;
    report.summary = $('summary').textContent;
    report.diff = $('diff').textContent;
    report.photos = state.photos.map((p) => p.meta);
    report.warnings = [...document.querySelectorAll('#warnings p')].map((p) => p.textContent);
    await stage('merge ok');
    if (cfg.focus) {
      const shown = when('before-shown');
      state.focus = { x: cfg.focus[0], y: cfg.focus[1] };
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
    report.error = String(e);
  }
  await tiny.store.set('selftest', report);
  if (cfg.holdMs) await new Promise((ok) => setTimeout(ok, cfg.holdMs));
  if (cfg.quit !== false) tiny.quit();
});

const test = require('node:test');
const assert = require('node:assert/strict');
const SR = require('../src/frontend/sr-core.js');

function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Gray random-direction waves up to `fmax` rad/px (π = Nyquist of the ground truth),
// plus two bright bars so there are hard edges too.
function waves(w, h, seed = 1, fmax = 1.5) {
  const r = rng(seed), ws = [];
  for (let i = 0; i < 60; i++) { const a = r() * 6.28, f = 0.05 + r() * fmax; ws.push([f * Math.cos(a), f * Math.sin(a), r() * 6.28, 10 + r() * 20]); }
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 128;
    for (const [fx, fy, ph, a] of ws) v += a * Math.sin(fx * x + fy * y + ph) / 5;
    if ((x > w * 0.3 && x < w * 0.35) || (y > h * 0.6 && y < h * 0.64)) v += 40;
    const o = (y * w + x) * 4;
    data[o] = v; data[o + 1] = v * 0.9 + 10; data[o + 2] = 255 - v; data[o + 3] = 255;
  }
  return { width: w, height: h, data };
}

// Ground truth G seen through an HR warp (rotation `deg` about the centre, then
// shift sx, sy in G pixels), box-downsampled 2×: a synthetic burst frame.
function hrWarp(G, sx, sy, deg = 0) {
  const th = deg * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
  const cx = (G.width - 1) / 2, cy = (G.height - 1) / 2;
  return { a: cs, b: -sn, c: cx - cs * cx + sn * cy + sx, d: sn, e: cs, f: cy - sn * cx - cs * cy + sy };
}
function synthFrame(G, sx, sy, deg = 0) {
  return SR.downsampleBox(SR.resampleRegion(G, { scale: 1, warp: hrWarp(G, sx, sy, deg), width: G.width, height: G.height }), 2);
}
// True ref→frame mapping in half-resolution coordinates: u = (A⁻¹(2x + .5 − t) − .5) / 2.
function trueUV(G, sx, sy, deg, x, y) {
  const W = hrWarp(G, sx, sy, deg), det = W.a * W.e - W.b * W.d;
  const X = 2 * x + 0.5 - W.c, Y = 2 * y + 0.5 - W.f;
  return [((W.e * X - W.b * Y) / det - 0.5) / 2, ((-W.d * X + W.a * Y) / det - 0.5) / 2];
}

test('lanczos3 kernel: 1 at 0, 0 at other integers, 0 outside support', () => {
  assert.equal(SR.lanczos3(0), 1);
  for (const t of [-2, -1, 1, 2, 3, -3, 3.5]) assert.ok(Math.abs(SR.lanczos3(t)) < 1e-12, `t=${t}`);
});

test('resampleRegion at scale 1 with the identity warp is the identity', () => {
  const img = waves(64, 48);
  const out = SR.resampleRegion(img, { scale: 1, width: 64, height: 48 });
  assert.deepEqual(out.data, img.data);
});

test('resampleRegion integer translation moves pixels exactly', () => {
  const img = waves(64, 48);
  const out = SR.resampleRegion(img, { scale: 1, warp: SR.translation(-3, 2), width: 64, height: 48 });
  for (const [x, y] of [[10, 10], [30, 20], [50, 40]]) {
    const o = (y * 64 + x) * 4, i = ((y + 2) * 64 + (x - 3)) * 4;   // out(x) = img(x + t)
    assert.equal(out.data[o], img.data[i]);
  }
});

test('resampleRegion of a region equals the same region of the full render', () => {
  const img = waves(80, 60, 4);
  const warp = { a: 0.999, b: -0.02, c: 1.3, d: 0.02, e: 0.999, f: -0.7 };
  const full = SR.resampleRegion(img, { scale: 2, warp, width: 160, height: 120 });
  const part = SR.resampleRegion(img, { scale: 2, warp, x: 37, y: 51, width: 40, height: 30 });
  for (let r = 0; r < 30; r++) for (let c = 0; c < 40; c++) for (let ch = 0; ch < 3; ch++) {
    assert.ok(Math.abs(part.data[(r * 40 + c) * 4 + ch] - full.data[((r + 51) * 160 + c + 37) * 4 + ch]) <= 1);
  }
});

test('register recovers sub-pixel translations (small image, translation path)', () => {
  const G = waves(480, 360, 7, 0.8);
  const ref = synthFrame(G, 0, 0);
  for (const [sx, sy] of [[0.7, -1.3], [3.25, 2.5], [-5.6, 0.9], [41.4, -27.8]]) {
    const { warp } = SR.register(ref, synthFrame(G, sx, sy));
    assert.ok(Math.abs(warp.c + sx / 2) < 0.02, `c ${warp.c} vs ${-sx / 2}`);
    assert.ok(Math.abs(warp.f + sy / 2) < 0.02, `f ${warp.f} vs ${-sy / 2}`);
  }
});

test('register recovers rotation + shift across the whole frame (affine path)', () => {
  const G = waves(1600, 1200, 21, 0.8);
  const ref = synthFrame(G, 0, 0);
  for (const [sx, sy, deg] of [[13.4, -7.9, 0.4], [-60.2, 31.7, -1.0], [1.1, 0.6, 0]]) {
    const r = SR.register(ref, synthFrame(G, sx, sy, deg));
    assert.ok(r.inliers >= 5, `inliers ${r.inliers}`);
    for (const [x, y] of [[40, 40], [760, 40], [400, 300], [40, 560], [760, 560]]) {
      const [u, v] = SR.applyWarp(r.warp, x, y), [tu, tv] = trueUV(G, sx, sy, deg, x, y);
      assert.ok(Math.hypot(u - tu, v - tv) < 0.05, `${deg}° at (${x},${y}): err ${Math.hypot(u - tu, v - tv).toFixed(3)} px`);
    }
  }
});

test('registerBurst picks the sharpest frame as reference', () => {
  const G = waves(240, 180, 3);
  const sharp = synthFrame(G, 0, 0);
  const blurry = SR.resampleRegion(SR.downsampleBox(G, 4), { scale: 2, width: 120, height: 90 });
  const res = SR.registerBurst([blurry, sharp]);
  assert.equal(res.refIndex, 1);
  assert.deepEqual(res.warps[1], SR.IDENTITY);
});

test('every merge mode of identical, unwarped frames equals the single-frame upscale', () => {
  const f = waves(60, 40, 5);
  const single = SR.resampleRegion(f, { scale: 2, width: 120, height: 80 });
  const warps = [SR.IDENTITY, SR.IDENTITY, SR.IDENTITY];
  for (const mode of SR.MODES) {
    const m = SR.merge([f, f, f], warps, { mode });
    assert.equal(m.width, 120); assert.equal(m.height, 80);
    let maxDiff = 0;
    for (let i = 0; i < m.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(m.data[i] - single.data[i]));
    assert.ok(maxDiff <= 1, `${mode} maxDiff ${maxDiff}`);
  }
});

test('median ignores one corrupted frame; mean does not', () => {
  const f = waves(40, 30, 9);
  const bad = { width: 40, height: 30, data: new Uint8ClampedArray(f.data.length).fill(255) };
  const truth = SR.resampleRegion(f, { scale: 2, width: 80, height: 60 });
  const warps = [SR.IDENTITY, SR.IDENTITY, SR.IDENTITY];
  assert.ok(SR.psnr(SR.merge([f, f, bad], warps, { mode: 'median' }), truth, 4) > 45);
  assert.ok(SR.psnr(SR.merge([f, f, bad], warps, { mode: 'mean' }), truth, 4) < 25);
});

test('pairwise of 4 frames ≈ mean (it is a mean with 8-bit rounding between stages)', () => {
  const G = waves(240, 180, 13);
  const shifts = [[0, 0], [1.2, -0.4], [-0.6, 0.9], [0.3, 1.5]];
  const frames = shifts.map(([x, y]) => synthFrame(G, x, y));
  const warps = shifts.map(([x, y]) => SR.translation(-x / 2, -y / 2));
  const mean = SR.merge(frames, warps, { mode: 'mean' }), pw = SR.merge(frames, warps, { mode: 'pairwise' });
  assert.ok(SR.psnr(mean, pw, 8) > 48);
});

function burstPsnr(G, shots, mode) {
  const frames = shots.map(([sx, sy, deg]) => synthFrame(G, sx, sy, deg));
  if (mode === 'single') return SR.psnr(SR.resampleRegion(frames[0], { scale: 2, width: G.width, height: G.height }), G, 12);
  const reg = SR.registerBurst(frames, () => {}, { refIndex: 0 });
  return SR.psnr(SR.merge(frames, reg.warps, { mode }), G, 12);
}

test('registered mean of 4 shifted + rotated frames beats a single upscaled frame', () => {
  const G = waves(1200, 900, 11, 1.5);
  const shots = [[0, 0, 0], [1.2, -0.6, 0.3], [-1.6, 2.2, -0.2], [2.6, 0.8, 0.15]];
  const single = burstPsnr(G, shots, 'single'), mean = burstPsnr(G, shots, 'mean');
  assert.ok(mean > single + 0.3, `mean ${mean.toFixed(2)} dB vs single ${single.toFixed(2)} dB`);
});

test('compareToSingle: zero for identical frames, non-zero once frames differ', () => {
  const f = waves(80, 60, 5);
  const same = SR.compareToSingle(SR.merge([f, f], [SR.IDENTITY, SR.IDENTITY]), f);
  assert.ok(same.meanAbs < 0.5 && same.pctOver === 0, JSON.stringify(same));
  const bad = { width: 80, height: 60, data: new Uint8ClampedArray(f.data.length).fill(255) };
  const diff = SR.compareToSingle(SR.merge([f, bad], [SR.IDENTITY, SR.IDENTITY]), f);
  assert.ok(diff.meanAbs > 20 && diff.pctOver > 50, JSON.stringify(diff));
});

// ---- local alignment (handheld) ----

// Smooth non-affine displacement D (px) and a field object that renders it.
const wobbleD = (x, y, A) => [A * Math.sin(x / 190) * Math.cos(y / 230), A * Math.cos(x / 170 + 1) * Math.sin(y / 210)];
function wobbleField(w, h, A, T = 16) {
  const nx = Math.ceil(w / T) + 1, ny = Math.ceil(h / T) + 1, n = nx * ny;
  const F = { T, nx, ny, x0: 0, y0: 0, dx: new Float32Array(n), dy: new Float32Array(n), ok: new Uint8Array(n).fill(1) };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) [F.dx[j * nx + i], F.dy[j * nx + i]] = wobbleD(i * T, j * T, A);
  return F;
}
// frame(y) = G(y + D(y)); the reference point x appears in the frame at y = x - D(y).
const trueFramePoint = (x, y, A) => { let p = [x, y]; for (let k = 0; k < 10; k++) { const d = wobbleD(p[0], p[1], A); p = [x - d[0], y - d[1]]; } return p; };

test('local alignment follows a non-affine wobble that one affine warp cannot', () => {
  const G = waves(1200, 900, 21, 0.8), A = 3;
  const frame = SR.resampleRegion(G, { scale: 1, warp: { ...SR.IDENTITY, field: wobbleField(1200, 900, A) }, width: 1200, height: 900 });
  const local = SR.register(G, frame), affine = SR.register(G, frame, { local: false });
  assert.equal(local.mode, 'local');
  let sse = 0, n = 0;
  for (let y = 100; y < 800; y += 50) for (let x = 100; x < 1100; x += 50) {
    const [u, v] = SR.mapPoint(local.warp, local.warp.field, x, y), [tu, tv] = trueFramePoint(x, y, A);
    sse += (u - tu) ** 2 + (v - tv) ** 2; n++;
  }
  assert.ok(Math.sqrt(sse / n) < 0.15, `true rms ${Math.sqrt(sse / n).toFixed(3)} px`);
  assert.ok(local.err < affine.err, `estimated ${local.err} vs affine ${affine.err}`);
  const pl = SR.psnr(SR.merge([G, frame], [SR.IDENTITY, local.warp], { scale: 1 }), G, 40);
  const pa = SR.psnr(SR.merge([G, frame], [SR.IDENTITY, affine.warp], { scale: 1 }), G, 40);
  assert.ok(pl > pa + 5, `local ${pl.toFixed(2)} dB vs affine ${pa.toFixed(2)} dB`);
});

test('a plain shifted frame keeps the exact affine path (no local field)', () => {
  const G = waves(1600, 1200, 21, 0.8);
  const r = SR.register(synthFrame(G, 0, 0), synthFrame(G, 1.3, -0.7, 0.2));
  assert.equal(r.mode, 'affine');
  assert.equal(r.warp.field, undefined);
  assert.equal(r.verdict, 'good');
});

test('a field with constant displacement renders like the same translation', () => {
  const img = waves(300, 200, 4), T = 16, nx = 21, ny = 15;
  const F = { T, nx, ny, x0: 0, y0: 0, dx: new Float32Array(nx * ny).fill(2.25), dy: new Float32Array(nx * ny).fill(-1.5), ok: new Uint8Array(nx * ny).fill(1) };
  const a = SR.resampleRegion(img, { scale: 2, warp: { ...SR.IDENTITY, field: F }, width: 600, height: 400 });
  const b = SR.resampleRegion(img, { scale: 2, warp: SR.translation(2.25, -1.5), width: 600, height: 400 });
  let maxDiff = 0;
  for (let i = 0; i < a.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a.data[i] - b.data[i]));
  assert.ok(maxDiff <= 1, `maxDiff ${maxDiff}`);
});

test('cells where something moved are left out of the merge (deghosting)', () => {
  const G = waves(1200, 900, 21, 0.8);
  const frame = SR.resampleRegion(G, { scale: 1, warp: { ...SR.IDENTITY, field: wobbleField(1200, 900, 1) }, width: 1200, height: 900 });
  const r = rng(5);
  for (let y = 400; y < 560; y++) for (let x = 500; x < 660; x++) { const o = (y * 1200 + x) * 4; frame.data[o] = frame.data[o + 1] = frame.data[o + 2] = 255 * r(); }
  const reg = SR.register(G, frame);
  assert.equal(reg.mode, 'local');
  assert.ok(reg.badFraction > 0, 'some cells flagged');
  const m = SR.merge([G, frame], [SR.IDENTITY, reg.warp], { scale: 1 });
  const patch = (img) => ({ width: 100, height: 100, data: (() => { const d = new Uint8ClampedArray(100 * 100 * 4); for (let y = 0; y < 100; y++) d.set(img.data.subarray(((430 + y) * 1200 + 530) * 4, ((430 + y) * 1200 + 630) * 4), y * 400); return d; })() });
  assert.ok(SR.psnr(patch(m), patch(G)) > 35, `patch PSNR ${SR.psnr(patch(m), patch(G)).toFixed(1)} dB`);
});

test('verdict thresholds: good <= 0.3 px, soft <= 1 px, bad above', () => {
  assert.deepEqual([0, 0.3, 0.31, 1, 1.01].map(SR.verdictFor), ['good', 'good', 'soft', 'soft', 'bad']);
});

test('defaultSelection keeps the reference and photos within 0.3 px', () => {
  const d = [{ err: 0.05 }, { err: 2 }, { err: 0.31 }, { err: 9 }];
  assert.deepEqual(SR.defaultSelection(d, 3), [true, false, false, true]);
  // only the reference is good: fall back to photos within 1 px
  assert.deepEqual(SR.defaultSelection([{ err: 0 }, { err: 0.6 }, { err: 3 }], 0), [true, true, false]);
});

test('merge with several modes in one pass matches separate merges', () => {
  const G = waves(240, 180, 13);
  const shifts = [[0, 0], [1.2, -0.4], [-0.6, 0.9], [0.3, 1.5]];
  const frames = shifts.map(([x, y]) => synthFrame(G, x, y));
  const warps = shifts.map(([x, y]) => SR.translation(-x / 2, -y / 2));
  const both = SR.merge(frames, warps, { modes: ['mean', 'median'] });
  assert.deepEqual(both.mean.data, SR.merge(frames, warps, { mode: 'mean' }).data);
  assert.deepEqual(both.median.data, SR.merge(frames, warps, { mode: 'median' }).data);
});

// ---- brightness matching ----

test('registerBurst matches a 5% brighter photo per channel, and the merge uses it', () => {
  const G = waves(1200, 900, 21, 0.8);
  const ref = synthFrame(G, 0, 0), f = synthFrame(G, 1.3, -0.7);
  const bright = { width: f.width, height: f.height, data: f.data.map((v, i) => ((i & 3) === 3 ? v : v * 1.05)) };
  const reg = SR.registerBurst([ref, bright], () => {}, { refIndex: 0 });
  for (const g of reg.details[1].gain) assert.ok(Math.abs(g - 1 / 1.05) < 0.003, `gain ${g}`);
  const off = SR.registerBurst([ref, bright], () => {}, { refIndex: 0, matchBrightness: false });
  const truth = SR.resampleRegion(G, { scale: 1, width: 1200, height: 900 });
  const pOn = SR.psnr(SR.merge([ref, bright], reg.warps), truth, 24), pOff = SR.psnr(SR.merge([ref, bright], off.warps), truth, 24);
  assert.ok(pOn > pOff + 1, `matched ${pOn.toFixed(2)} dB vs not ${pOff.toFixed(2)} dB`);
});

// ---- deblur ----

test('deblur recovers detail from a [1/4 1/2 1/4] blur and leaves flat areas alone', () => {
  const G = waves(240, 180, 9, 1.2);
  const k = [0.25, 0.5, 0.25];
  const blurred = { width: 240, height: 180, data: new Uint8ClampedArray(G.data.length) };
  for (let y = 0; y < 180; y++) for (let x = 0; x < 240; x++) for (let c = 0; c < 4; c++) {
    let v = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) v += k[j + 1] * k[i + 1] * G.data[((Math.min(179, Math.max(0, y + j))) * 240 + Math.min(239, Math.max(0, x + i))) * 4 + c];
    blurred.data[(y * 240 + x) * 4 + c] = c === 3 ? 255 : v;
  }
  const d = SR.deblur(blurred, { amount: 1, noise: 0.5 });
  assert.ok(SR.psnr(d, G, 8) > SR.psnr(blurred, G, 8) + 2, `${SR.psnr(d, G, 8).toFixed(2)} vs ${SR.psnr(blurred, G, 8).toFixed(2)} dB`);
  assert.deepEqual(SR.deblur(blurred, { amount: 0 }).data, blurred.data);
  const flat = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(120) };
  const r = rng(3); for (let i = 0; i < flat.data.length; i++) flat.data[i] = (i & 3) === 3 ? 255 : 120 + (r() - 0.5) * 4;
  let maxChange = 0; const fd = SR.deblur(flat, { amount: 1 });
  for (let i = 0; i < flat.data.length; i++) maxChange = Math.max(maxChange, Math.abs(fd.data[i] - flat.data[i]));
  assert.ok(maxChange <= 2, `flat noise changed by up to ${maxChange} levels`);
});

test('deblur in strips equals deblur in one piece', () => {
  const G = waves(200, 150, 5, 1.0);
  const a = SR.deblur(G, { amount: 1, noise: 1 }), b = SR.deblur(G, { amount: 1, noise: 1, stripRows: 17 });
  let maxDiff = 0; for (let i = 0; i < a.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a.data[i] - b.data[i]));
  assert.ok(maxDiff <= 1, `maxDiff ${maxDiff}`);
});

test('chooseDeblur picks some deblur for box-sampled aliased bursts, and needs 3 photos', () => {
  const G = waves(1200, 900, 31, 1.6);
  const shots = [[0, 0], [1.1, -0.6], [-0.7, 1.3], [0.4, 0.9]];
  const frames = shots.map(([x, y]) => synthFrame(G, x, y));
  const reg = SR.registerBurst(frames, () => {}, { refIndex: 0 });
  const pick = SR.chooseDeblur(frames, reg.warps, reg.details, 0);
  assert.ok(pick.amount > 0, JSON.stringify(pick.errors));
  assert.equal(SR.chooseDeblur(frames.slice(0, 2), reg.warps, reg.details, 0, { fallback: 0.5 }).amount, 0.5);
});

test('merge of a region equals the same region of the full merge', () => {
  const G = waves(240, 180, 13);
  const frames = [[0, 0], [1.2, -0.4], [-0.6, 0.9]].map(([x, y]) => synthFrame(G, x, y));
  const warps = [SR.IDENTITY, SR.translation(-0.6, 0.2), SR.translation(0.3, -0.45)];
  const full = SR.merge(frames, warps), R = { x: 37, y: 51, width: 60, height: 40 };
  const part = SR.merge(frames, warps, { region: R });
  for (let r = 0; r < R.height; r++) for (let c = 0; c < R.width; c++) for (let ch = 0; ch < 3; ch++) {
    assert.ok(Math.abs(part.data[(r * R.width + c) * 4 + ch] - full.data[((r + R.y) * full.width + c + R.x) * 4 + ch]) <= 1);
  }
});

test('merge rejects unknown modes', () => {
  const f = waves(8, 8);
  assert.throws(() => SR.merge([f], [SR.IDENTITY], { mode: 'ai' }), /Unknown merge mode/);
});

test('psnr/ssim of identical images', () => {
  const f = waves(50, 40);
  assert.equal(SR.psnr(f, f), Infinity);
  assert.ok(Math.abs(SR.ssim(f, f) - 1) < 1e-6);
});

test('registerFrame per photo gives the same result as registerBurst', () => {
  const G = waves(160, 120, 7), frames = [synthFrame(G, 0, 0), synthFrame(G, 1.3, -0.7, 0.4), synthFrame(G, -0.8, 1.1)].map((f) => ({ ...f }));
  const whole = SR.registerBurst(frames);
  const prep = SR.prepareReference(frames[whole.refIndex]);
  const parts = frames.map((f, i) => (i === whole.refIndex ? SR.referenceResult() : SR.registerFrame(prep, f)));
  assert.deepEqual(parts.map((r) => r.warp), whole.warps);
  assert.deepEqual(parts, whole.details);
  assert.equal(SR.pickReference(frames.map(SR.sharpness)), whole.refIndex);
});

test('merge and mergeCFA in bands of whole strips match a single pass (with a local field)', () => {
  const w = 96, h = 160, scale = 2, W = w * scale, H = h * scale;
  const G = waves(w, h, 3);
  const nx = 4, ny = 6, T = 32, field = { x0: 0, y0: 0, T, nx, ny, ok: new Uint8Array(nx * ny).fill(1), dx: new Float32Array(nx * ny), dy: new Float32Array(nx * ny) };
  for (let i = 0; i < nx * ny; i++) { field.dx[i] = 0.6 * Math.sin(i); field.dy[i] = 0.5 * Math.cos(i * 1.7); }
  field.ok[5] = 0;
  const warps = [SR.IDENTITY, { ...SR.translation(-0.3, 0.4), field }, { ...SR.translation(0.6, -0.2), gain: [1.02, 0.98, 1], field }];
  const frames = [G, waves(w, h, 4), waves(w, h, 5)];
  const bands = [[0, 64], [64, 192], [192, H]];                      // multiples of the 32-row strips
  const whole = SR.merge(frames, warps, { modes: ['mean', 'median'] });
  const parts = bands.map(([y, y1]) => SR.merge(frames, warps, { modes: ['mean', 'median'], region: { x: 0, y, width: W, height: y1 - y } }));
  for (const m of ['mean', 'median']) {
    const joined = new Uint8ClampedArray(W * H * 4);
    parts.forEach((p, i) => joined.set(p[m].data, bands[i][0] * W * 4));
    assert.deepEqual(joined, whole[m].data, m);
  }
  const cfa = [0, 1, 1, 2], raw = (s) => { const d = new Float32Array(w * h), r = rng(s); for (let i = 0; i < d.length; i++) d[i] = 200 * r(); return { width: w, height: h, data: d, cfa, black: [0, 0, 0, 0], gain: [1, 1, 1] }; };
  const raws = [raw(1), raw(2), raw(3)], wholeCfa = SR.mergeCFA(raws, warps);
  const joined = new Uint8ClampedArray(W * H * 4);
  for (const [y, y1] of bands) joined.set(SR.mergeCFA(raws, warps, { region: { x: 0, y, width: W, height: y1 - y } }).data, y * W * 4);
  assert.deepEqual(joined, wholeCfa.data);
});

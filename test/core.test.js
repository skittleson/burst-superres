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

test('merge rejects unknown modes', () => {
  const f = waves(8, 8);
  assert.throws(() => SR.merge([f], [SR.IDENTITY], { mode: 'ai' }), /Unknown merge mode/);
});

test('psnr/ssim of identical images', () => {
  const f = waves(50, 40);
  assert.equal(SR.psnr(f, f), Infinity);
  assert.ok(Math.abs(SR.ssim(f, f) - 1) < 1e-6);
});

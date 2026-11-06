#!/usr/bin/env node
// Objective benchmark: synthesize a burst from one real full-size JPEG
// (random sub-pixel shift → 2×2 box downsample → noise → JPEG), merge it with
// every mode, and score each 2× result against the original JPEG.
//
//   node tools/bench.js --gt photo.jpg --seed 2 --crop x,y,w,h [--frames 4]  (--gt is required)
//                       [--noise 2] [--quality 92] [--rot 0.5] [--out bench-out/name]
// --rot gives each non-reference frame a random rotation of up to ±N degrees.
// --wobble A bends each non-reference frame by a smooth non-affine displacement
// of up to A ground-truth px (handheld parallax/distortion stand-in); it also
// scores the merge with local alignment turned off, for comparison.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');
const SR = require('../src/frontend/sr-core.js');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? a.concat([[v.slice(2), all[i + 1]]]) : a), []));
const gtPath = args.gt;
if (!gtPath) { console.error('usage: node tools/bench.js --gt photo.jpg [--seed N] [--crop x,y,w,h] ...'); process.exit(2); }
const seed = +(args.seed || 1), nFrames = +(args.frames || 4), noise = +(args.noise ?? 2), quality = +(args.quality || 92);
const crop = (args.crop || '2900,1800,600,500').split(',').map(Number);
const maxRot = +(args.rot || 0), wobble = +(args.wobble || 0);
const outDir = args.out || path.join('bench-out', path.basename(gtPath, path.extname(gtPath)) + '-seed' + seed);
fs.mkdirSync(outDir, { recursive: true });

function rng(s) { return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(seed);
const gauss = () => { let u = 0, v = 0; while (!u) u = rand(); v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const t = () => performance.now();
// JPEG via libjpeg-turbo's djpeg/cjpeg (PPM pipes). jpeg-js truncates instead of
// rounding on decode (−0.53 levels per round trip, measured), which skews PSNR.
function decode(file) {
  const ppm = execFileSync('djpeg', ['-pnm', file], { maxBuffer: 1 << 30 });
  const head = ppm.subarray(0, 64).toString('latin1').match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
  const width = +head[1], height = +head[2], off = head[0].length;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = off; i < data.length; i += 4, j += 3) { data[i] = ppm[j]; data[i + 1] = ppm[j + 1]; data[i + 2] = ppm[j + 2]; data[i + 3] = 255; }
  return { width, height, data };
}
function encode(img, q) {
  const head = Buffer.from(`P6\n${img.width} ${img.height}\n255\n`, 'latin1');
  const rgb = Buffer.alloc(img.width * img.height * 3);
  for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) { rgb[j] = img.data[i]; rgb[j + 1] = img.data[i + 1]; rgb[j + 2] = img.data[i + 2]; }
  return execFileSync('cjpeg', ['-quality', String(q)], { input: Buffer.concat([head, rgb]), maxBuffer: 1 << 30 });
}

function cropImg(img, [x, y, w, h]) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) out.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
  return { width: w, height: h, data: out };
}

function savePng(img, file) {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  fs.writeFileSync(file, PNG.sync.write(png));
}

// ---- 1. ground truth (even dimensions so 2× of the 1/2 frames matches exactly)
let G = decode(gtPath);
G = cropImg(G, [0, 0, G.width & ~1, G.height & ~1]);
console.log(`ground truth ${path.basename(gtPath)} ${G.width}×${G.height}, seed ${seed}, ${nFrames} frames, noise σ=${noise}, JPEG q${quality}`);

// ---- 2. synthetic burst. Frame 0 is unwarped and is the reference.
// Frame k shows G through an HR warp: rotation `deg` about the centre, then a shift.
function hrWarp(sx, sy, deg) {
  const th = deg * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th), cx = (G.width - 1) / 2, cy = (G.height - 1) / 2;
  return { a: cs, b: -sn, c: cx - cs * cx + sn * cy + sx, d: sn, e: cs, f: cy - sn * cx - cs * cy + sy };
}
// True reference→frame mapping at half resolution: u = (A⁻¹(2x + .5 − t) − .5) / 2.
function trueUV([sx, sy, deg], x, y) {
  const W = hrWarp(sx, sy, deg), det = W.a * W.e - W.b * W.d, X = 2 * x + 0.5 - W.c, Y = 2 * y + 0.5 - W.f;
  return [((W.e * X - W.b * Y) / det - 0.5) / 2, ((-W.d * X + W.a * Y) / det - 0.5) / 2];
}
// Smooth displacement (GT px) on a 32 px grid, different per frame.
function wobbleField(k) {
  const T = 32, nx = Math.ceil(G.width / T) + 1, ny = Math.ceil(G.height / T) + 1, n = nx * ny;
  const F = { T, nx, ny, x0: 0, y0: 0, dx: new Float32Array(n), dy: new Float32Array(n), ok: new Uint8Array(n).fill(1) };
  const p = [rand() * 6, rand() * 6, 300 + rand() * 300, 300 + rand() * 300];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    F.dx[j * nx + i] = wobble * Math.sin(i * T / p[2] + p[0]) * Math.cos(j * T / p[3]);
    F.dy[j * nx + i] = wobble * Math.cos(i * T / p[3]) * Math.sin(j * T / p[2] + p[1]);
  }
  return F;
}
const shifts = [[0, 0, 0]];
for (let k = 1; k < nFrames; k++) shifts.push([(rand() * 2 - 1) * 3, (rand() * 2 - 1) * 3, (rand() * 2 - 1) * maxRot]); // ±3 GT px = ±1.5 input px
const frames = shifts.map(([sx, sy, deg], k) => {
  const warp = hrWarp(sx, sy, deg);
  if (k && wobble) warp.field = wobbleField(k);
  const sh = k ? SR.resampleRegion(G, { scale: 1, warp, width: G.width, height: G.height }) : G;
  const lo = SR.downsampleBox(sh, 2);
  for (let i = 0; i < lo.data.length; i++) if ((i & 3) !== 3) lo.data[i] = lo.data[i] + noise * gauss();
  const enc = encode(lo, quality);
  const file = path.join(outDir, `frame_${k}.jpg`);
  fs.writeFileSync(file, enc);
  return decode(file);
});

// ---- 3. registration accuracy
let t0 = t();
const reg = SR.registerBurst(frames, () => {}, { refIndex: 0 });
const regMs = t() - t0;
// worst error over a 5×5 grid of points spanning the frame, in input pixels
const fw = frames[0].width, fh = frames[0].height;
const regErr = wobble ? reg.details.map((d) => d.err) : reg.warps.map((W, k) => {
  let m = 0;
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) {
    const x = (fw - 1) * i / 4, y = (fh - 1) * j / 4, [u, v] = SR.applyWarp(W, x, y), [tu, tv] = trueUV(shifts[k], x, y);
    m = Math.max(m, Math.hypot(u - tu, v - tv));
  }
  return m;
});
console.log(`registration ${regMs.toFixed(0)} ms; ${wobble ? 'estimated' : 'max true'} |error| per frame (input px): ${regErr.map((e) => e.toFixed(4)).join(', ')}; modes ${reg.details.map((d) => d.mode).join(', ')}`);

// ---- 4. merge + score
const results = [];
function score(name, img, ms) {
  const c = cropImg(img, crop), gc = cropImg(G, crop);
  const r = {
    method: name, ms: Math.round(ms),
    psnr: +SR.psnr(img, G, 16).toFixed(3), ssim: +SR.ssim(img, G, 16).toFixed(4),
    cropPsnr: +SR.psnr(c, gc, 0).toFixed(3), cropSsim: +SR.ssim(c, gc, 0).toFixed(4),
  };
  results.push(r);
  console.log(JSON.stringify(r));
  savePng(c, path.join(outDir, `crop_${name}.png`));
}
savePng(cropImg(G, crop), path.join(outDir, 'crop_ground-truth.png'));
savePng(cropImg(frames[0], crop.map((v) => v >> 1)), path.join(outDir, 'crop_input-frame0-1x.png'));

t0 = t(); score('single-lanczos', SR.resampleRegion(frames[0], { scale: 2, width: G.width, height: G.height }), t() - t0);
for (const mode of SR.MODES) { t0 = t(); const m = SR.merge(frames, reg.warps, { mode }); score(mode, m, t() - t0); }
if (wobble) {
  const affineOnly = SR.registerBurst(frames, () => {}, { refIndex: 0, local: false });
  t0 = t(); score('mean-affine-only', SR.merge(frames, affineOnly.warps, { mode: 'mean' }), t() - t0);
}

fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({
  groundTruth: path.basename(gtPath), size: [G.width, G.height], seed, frames: nFrames, noise, quality, maxRot, crop,
  wobble, shiftsAndRotations: shifts, estimated: reg.warps, fitRms: reg.details.map((d) => d.fitRms), inliers: reg.details.map((d) => d.inliers), registrationErrorPx: regErr, registrationMs: Math.round(regMs), results,
}, null, 2));
console.log('wrote', outDir);

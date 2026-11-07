#!/usr/bin/env node
// Does merging RAW beat merging camera JPEGs? A simulated sensor, so there
// is a ground truth:
//   scene    = a real photo (sRGB -> linear light), the "true" 2x image
//   frame k  = scene shifted by a random sub-pixel amount, 2x2 sensor box,
//              Bayer RGGB mosaic, shot + read noise
//   RAW      = those mosaics (what an ARW holds, minus black level)
//   JPEG     = the same mosaic as a camera would ship it: demosaic,
//              sRGB, sharpening, JPEG quality 92
// Every path is scored against the scene (luma PSNR, sRGB, 16 px border).
//
//   node tools/bench-raw.js --gt photo.jpg [--seed 1] [--frames 4] [--crop x,y,w,h]
//        [--iso 1] (noise scale) [--sharpen 0.6] (camera sharpening amount)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const SR = require('../src/frontend/sr-core.js');
const RAW = require('../src/frontend/raw.js');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? a.concat([[v.slice(2), all[i + 1]]]) : a), []));
const seed = +(args.seed || 1), nFrames = +(args.frames || 4), iso = +(args.iso ?? 1), sharpen = +(args.sharpen ?? 0.6);
const crop = args.crop ? args.crop.split(',').map(Number) : null;
const tmp = fs.mkdtempSync('/tmp/bench-raw-');

function rng(s) { return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(seed);
const gauss = () => { let u = 0; while (!u) u = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()); };
function decode(file) {
  const ppm = execFileSync('djpeg', ['-pnm', file], { maxBuffer: 1 << 30 });
  const m = ppm.subarray(0, 64).toString('latin1').match(/^P6\s+(\d+)\s+(\d+)\s+255\s/), w = +m[1], h = +m[2], off = m[0].length;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = off; i < data.length; i += 4, j += 3) { data[i] = ppm[j]; data[i + 1] = ppm[j + 1]; data[i + 2] = ppm[j + 2]; data[i + 3] = 255; }
  return { width: w, height: h, data };
}
function encode(img, q) {
  const head = Buffer.from(`P6\n${img.width} ${img.height}\n255\n`), rgb = Buffer.alloc(img.width * img.height * 3);
  for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) { rgb[j] = img.data[i]; rgb[j + 1] = img.data[i + 1]; rgb[j + 2] = img.data[i + 2]; }
  return execFileSync('cjpeg', ['-quality', String(q)], { input: Buffer.concat([head, rgb]), maxBuffer: 1 << 30 });
}
const toLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const toS = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const LIN = new Float32Array(256); for (let i = 0; i < 256; i++) LIN[i] = toLin(i);

// ---- scene
let G = decode(args.gt);
if (crop) { const [x, y, w, h] = crop, d = new Uint8ClampedArray(w * h * 4); for (let r = 0; r < h; r++) d.set(G.data.subarray(((y + r) * G.width + x) * 4, ((y + r) * G.width + x + w) * 4), r * w * 4); G = { width: w, height: h, data: d }; }
G = { width: G.width & ~3, height: G.height & ~3, data: (() => { const w = G.width & ~3, h = G.height & ~3, d = new Uint8ClampedArray(w * h * 4); for (let r = 0; r < h; r++) d.set(G.data.subarray(r * G.width * 4, (r * G.width + w) * 4), r * w * 4); return d; })() };
const W = G.width, H = G.height, w = W / 2, h = H / 2;
console.log(`scene ${path.basename(args.gt)} ${W}x${H}${crop ? ' (crop)' : ''}, ${nFrames} frames, seed ${seed}, noise x${iso}, camera sharpening ${sharpen}`);

// ---- frames: shift (in sRGB via Lanczos, then to linear), 2x2 box, mosaic, noise
const CFA = [0, 1, 1, 2];
const shifts = [[0, 0]];
for (let k = 1; k < nFrames; k++) shifts.push([(rand() * 2 - 1) * 3, (rand() * 2 - 1) * 3]);
const mosaics = shifts.map(([sx, sy]) => {
  const s = sx || sy ? SR.resampleRegion(G, { scale: 1, warp: SR.translation(sx, sy), width: W, height: H }) : G;
  const m = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = CFA[(y & 1) * 2 + (x & 1)];
    let v = 0;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) v += LIN[s.data[((2 * y + j) * W + 2 * x + i) * 4 + c]];
    v /= 4;
    const sigma = iso * Math.sqrt(0.0015 * 0.0015 + 0.0002 * v);   // read + shot noise, linear 0..1
    m[y * w + x] = v + sigma * gauss();
  }
  return m;
});
const truth = shifts.map(([sx, sy]) => ({ dx: -sx / 2, dy: -sy / 2 }));

// ---- helpers
const rgbaFromLinear = (rgb, n) => { const d = new Uint8ClampedArray(n * 4); for (let i = 0; i < n; i++) { d[i * 4] = toS(Math.max(0, Math.min(1, rgb[i * 3]))); d[i * 4 + 1] = toS(Math.max(0, Math.min(1, rgb[i * 3 + 1]))); d[i * 4 + 2] = toS(Math.max(0, Math.min(1, rgb[i * 3 + 2]))); d[i * 4 + 3] = 255; } return d; };
const demosaiced = mosaics.map((m) => ({ width: w, height: h, data: rgbaFromLinear(RAW.demosaic(m, w, h, CFA), w * h) }));
function unsharp(img, amount, sigma = 1) {
  if (!amount) return img;
  const r = Math.ceil(3 * sigma), k = []; let s = 0; for (let i = -r; i <= r; i++) { k.push(Math.exp(-i * i / (2 * sigma * sigma))); s += k[k.length - 1]; } for (let i = 0; i < k.length; i++) k[i] /= s;
  const { width: W2, height: H2 } = img, out = new Uint8ClampedArray(img.data.length), t1 = new Float32Array(W2 * H2), b = new Float32Array(W2 * H2);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) { let v = 0; for (let i = -r; i <= r; i++) v += k[i + r] * img.data[(y * W2 + Math.min(W2 - 1, Math.max(0, x + i))) * 4 + c]; t1[y * W2 + x] = v; }
    for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) { let v = 0; for (let i = -r; i <= r; i++) v += k[i + r] * t1[Math.min(H2 - 1, Math.max(0, y + i)) * W2 + x]; b[y * W2 + x] = v; }
    for (let i = 0; i < W2 * H2; i++) out[i * 4 + c] = img.data[i * 4 + c] + amount * (img.data[i * 4 + c] - b[i]);
  }
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return { width: W2, height: H2, data: out };
}
const jpegs = demosaiced.map((d, k) => { const f = path.join(tmp, `f${k}.jpg`); fs.writeFileSync(f, encode(unsharp(d, sharpen), 92)); return decode(f); });

const P = (img) => SR.psnr(img, G, 16);
const rows = [];
const t = () => performance.now();
function score(name, img, ms) { const r = { method: name, psnr: +P(img).toFixed(3), ms: Math.round(ms) }; rows.push(r); console.log(JSON.stringify(r)); return r.psnr; }

// registration from the demosaiced RAW frames (the app does the same)
let t0 = t();
const reg = SR.registerBurst(demosaiced, () => {}, { refIndex: 0 });
const regJ = SR.registerBurst(jpegs, () => {}, { refIndex: 0 });
const err = (r) => Math.max(...r.warps.map((W2, k) => Math.hypot(W2.c - truth[k].dx, W2.f - truth[k].dy))).toFixed(4);
console.log(`registration error (px): raw-demosaic ${err(reg)}, jpeg ${err(regJ)}  (${Math.round(t() - t0)} ms)`);

score('jpeg single 2x', SR.resampleRegion(jpegs[0], { scale: 2, width: W, height: H }), 0);
t0 = t(); const mJ = SR.merge(jpegs, regJ.warps); score('jpeg mean', mJ, t() - t0);
score('jpeg mean + deblur(auto)', (() => { const p = SR.chooseDeblur(jpegs, regJ.warps, regJ.details, 0); console.log('  jpeg auto amount', p.amount); return p.amount ? SR.deblur(mJ, { amount: p.amount }) : mJ; })(), 0);
score('raw single (demosaic) 2x', SR.resampleRegion(demosaiced[0], { scale: 2, width: W, height: H }), 0);
t0 = t(); const mD = SR.merge(demosaiced, reg.warps); score('raw demosaic-then-mean', mD, t() - t0);
score('raw demosaic-then-mean + deblur(auto)', (() => { const p = SR.chooseDeblur(demosaiced, reg.warps, reg.details, 0); console.log('  raw auto amount', p.amount); return p.amount ? SR.deblur(mD, { amount: p.amount }) : mD; })(), 0);
const cf = mosaics.map((m) => ({ width: w, height: h, data: m, cfa: CFA }));
const toRGBA = (r, g, b, o, i) => { o[i] = toS(Math.max(0, Math.min(1, r))); o[i + 1] = toS(Math.max(0, Math.min(1, g))); o[i + 2] = toS(Math.max(0, Math.min(1, b))); o[i + 3] = 255; };
for (const sigma of (args.sigmas || "0.3,0.45").split(",").map(Number)) {
  t0 = t(); const m = SR.mergeCFA(cf, reg.warps, { sigma, toRGBA }); score(`raw direct (mergeCFA s=${sigma})`, m, t() - t0);
  for (const amount of (args.cfaDeblur || '').split(',').filter(Boolean).map(Number)) score(`raw direct s=${sigma} + deblur ${amount}`, SR.deblur(m, { amount }), 0);
  const pick = SR.chooseDeblur(demosaiced, reg.warps, reg.details, 0, { mergeRegion: (keep, R) => SR.mergeCFA(keep.map((k) => cf[k]), keep.map((k) => reg.warps[k]), { region: R, refIndex: keep.indexOf(0), sigma, toRGBA }) });
  console.log(`  raw direct auto amount ${pick.amount}`);
  score(`raw direct s=${sigma} + deblur(auto)`, pick.amount ? SR.deblur(m, { amount: pick.amount }) : m, 0);
}
fs.rmSync(tmp, { recursive: true, force: true });
if (args.out) fs.writeFileSync(args.out, JSON.stringify({ scene: path.basename(args.gt), size: [W, H], crop, seed, frames: nFrames, iso, sharpen, shifts, rows }, null, 2));

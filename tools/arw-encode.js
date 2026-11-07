// Sony ARW2 compressed encoder and a synthetic-burst generator, for tests only.
//
//   node tools/arw-encode.js --src real.ARW --out dir [--frames 6] [--seed 1] [--crop x,y,w,h]
//        [--scene photo.jpg]   use a JPEG/PNG as the scene instead of the ARW's own data
//
// From one real ARW: demosaic its raw data (linear light) into a "scene",
// then write N new ARWs, each the scene shifted by a random sub-pixel amount,
// averaged over 2x2 (the sensor pixel), re-mosaicked (RGGB), noised, and
// coded with Sony's own 8-bits-per-pixel block code. Metadata (SR2 white
// balance, levels, colour matrix, EXIF, preview) is copied from the source;
// only the raw strip and its size change. The scene is saved as scene.png
// (rendered with the app's own finisher) so the merge can be scored.
const fs = require('fs');
const path = require('path');
const RAW = require('../src/frontend/raw.js');
const SR = require('../src/frontend/sr-core.js');

// ---- the codec (inverse of RAW.decode for Compression 32767) ----
function encodeSonyARW2(values, W, H, toneCurve) {
  const curve = RAW.sonyCurve(toneCurve);
  const inv = new Uint16Array(16384);                       // value -> nearest 11-bit code
  let code = 0;
  for (let v = 0; v < 16384; v++) {
    while (code < 2047 && Math.abs(curve[(code + 1) << 1] - v) <= Math.abs(curve[code << 1] - v)) code++;
    inv[v] = code;
  }
  const out = new Uint8Array(W * H), pix = new Int32Array(16);
  for (let row = 0; row < H; row++) {
    let dp = row * W;
    for (let col0 = 0; col0 + 32 <= W; col0 += 32) {
      for (const start of [col0, col0 + 1]) {
        for (let i = 0; i < 16; i++) pix[i] = inv[Math.min(16383, Math.max(0, values[row * W + start + 2 * i]))];
        let imax = 0, imin = 0;
        for (let i = 1; i < 16; i++) { if (pix[i] > pix[imax]) imax = i; if (pix[i] < pix[imin]) imin = i; }
        if (imin === imax) imin = (imax + 1) & 15;
        const max = pix[imax], min = pix[imin];
        let sh = 0;
        while (sh < 4 && (0x80 << sh) <= max - min) sh++;
        // 128 bits: max(11) min(11) imax(4) imin(4), then 14 x 7-bit deltas
        const bits = new Uint8Array(16);
        const put = (val, n, at) => { for (let b = 0; b < n; b++) if ((val >> b) & 1) bits[(at + b) >> 3] |= 1 << ((at + b) & 7); };
        put(max, 11, 0); put(min, 11, 11); put(imax, 4, 22); put(imin, 4, 26);
        for (let i = 0, bit = 30; i < 16; i++) {
          if (i === imax || i === imin) continue;
          put(Math.min(127, Math.max(0, Math.round((pix[i] - min) / (1 << sh)))), 7, bit); bit += 7;
        }
        out.set(bits, dp); dp += 16;
      }
    }
  }
  return out;
}

module.exports = { encodeSonyARW2 };

if (require.main !== module) return;

// ---- burst generator ----
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? a.concat([[v.slice(2), all[i + 1]]]) : a), []));
const src = new Uint8Array(fs.readFileSync(args.src)), info = RAW.parse(src), raw = RAW.decode(src, info);
const N = +(args.frames || 6), outDir = args.out;
fs.mkdirSync(outDir, { recursive: true });
let seed = +(args.seed || 1);
const rand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gauss = () => { let u = 0; while (!u) u = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()); };

// scene = demosaiced linear camera RGB (white balance not applied: raw domain)
const [cx, cy, cw, ch] = (args.crop || `0,0,${info.width},${info.height}`).split(',').map(Number);
const W = cw & ~63, H = ch & ~3;                           // scene size; frames are W/2 x H/2, W/2 a multiple of 32
const L = RAW.levels(info), lin = new Float32Array(info.width * info.height);
for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) lin[y * info.width + x] = Math.max(0, raw[y * info.rawWidth + x] - L.black[(y & 1) * 2 + (x & 1)]);
const full = RAW.demosaic(lin, info.width, info.height, info.cfa);
const scene = { width: W, height: H, data: new Float32Array(W * H * 3) };
if (args.scene) {
  // sRGB photo -> linear -> camera space (inverse of the file's matrix) -> raw units (inverse WB/levels), 85% of full scale
  const ppm = require('child_process').execFileSync('djpeg', ['-pnm', args.scene], { maxBuffer: 1 << 30 }), m = ppm.subarray(0, 64).toString('latin1').match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
  const pw = +m[1], off = m[0].length;
  const M = info.colorMatrix, det = M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
  const Mi = [(M[4] * M[8] - M[5] * M[7]) / det, (M[2] * M[7] - M[1] * M[8]) / det, (M[1] * M[5] - M[2] * M[4]) / det,
    (M[5] * M[6] - M[3] * M[8]) / det, (M[0] * M[8] - M[2] * M[6]) / det, (M[2] * M[3] - M[0] * M[5]) / det,
    (M[3] * M[7] - M[4] * M[6]) / det, (M[1] * M[6] - M[0] * M[7]) / det, (M[0] * M[4] - M[1] * M[3]) / det];
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = off + ((y + cy) * pw + x + cx) * 3, r = lin(ppm[o]), g = lin(ppm[o + 1]), b = lin(ppm[o + 2]);
    const cam = [Mi[0] * r + Mi[1] * g + Mi[2] * b, Mi[3] * r + Mi[4] * g + Mi[5] * b, Mi[6] * r + Mi[7] * g + Mi[8] * b];
    for (let c = 0; c < 3; c++) scene.data[(y * W + x) * 3 + c] = Math.max(0, 0.85 * cam[c] / L.gain[c]);
  }
} else {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) scene.data[(y * W + x) * 3 + c] = full[((y + cy) * info.width + x + cx) * 3 + c];
}

// bilinear sample of the float scene
const at = (x, y, c) => {
  x = Math.min(W - 1.001, Math.max(0, x)); y = Math.min(H - 1.001, Math.max(0, y));
  const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy, d = scene.data, o = (iy * W + ix) * 3 + c;
  return (1 - fy) * ((1 - fx) * d[o] + fx * d[o + 3]) + fy * ((1 - fx) * d[o + W * 3] + fx * d[o + W * 3 + 3]);
};
const fw = W / 2, fh = H / 2, cfa = info.cfa, range = info.white - info.black[0];
const { execFileSync } = require('child_process');
let previewExposure = null;
const shifts = [[0, 0]];
for (let k = 1; k < N; k++) shifts.push([(rand() * 2 - 1) * 3, (rand() * 2 - 1) * 3]);

// patch helpers: SubIFD entries for width, height, strip offset, strip bytes
const le = src[0] === 0x49, u16 = (b, o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
const u32 = (b, o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
const w32 = (b, o, v) => { for (let i = 0; i < 4; i++) b[o + (le ? i : 3 - i)] = (v >>> (8 * i)) & 255; };
const w16 = (b, o, v) => { b[o + (le ? 0 : 1)] = v & 255; b[o + (le ? 1 : 0)] = v >> 8; };
function entries(b, off) { const n = u16(b, off), m = new Map(); for (let i = 0; i < n; i++) m.set(u16(b, off + 2 + i * 12), off + 2 + i * 12); return m; }
const ifd0 = entries(src, u32(src, 4)), subOff = u32(src, ifd0.get(0x014a) + 8), sub = entries(src, subOff);
const setVal = (b, e, v) => (u16(b, e + 2) === 3 ? w16(b, e + 8, v) : w32(b, e + 8, v));

for (let k = 0; k < N; k++) {
  const [sx, sy] = shifts[k], vals = new Uint16Array(fw * fh);
  for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
    const c = cfa[(y & 1) * 2 + (x & 1)];
    let v = 0;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) v += at(2 * x + i + sx, 2 * y + j + sy, c);
    v /= 4;
    v += Math.sqrt(4 + 0.6 * v) * gauss();                      // read + shot noise, raw units
    vals[y * fw + x] = Math.min(16383, Math.max(0, Math.round(v + info.black[(y & 1) * 2 + (x & 1)])));
  }
  const strip = encodeSonyARW2(vals, fw, fh, info.toneCurve);
  // new embedded preview (like the camera's): this frame rendered, 1/2 size, JPEG
  const tmpInfo = { ...info, rawWidth: fw, rawHeight: fh, width: fw, height: fh };
  const pv = RAW.render(vals, tmpInfo, { exposure: previewExposure ?? (previewExposure = RAW.autoExposure(vals, tmpInfo, 110)) });
  const half = SR.resampleRegion(pv, { scale: 0.5, width: fw >> 1, height: fh >> 1 });
  const head = Buffer.from(`P6\n${half.width} ${half.height}\n255\n`), rgb = Buffer.alloc(half.width * half.height * 3);
  for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) { rgb[j] = half.data[i]; rgb[j + 1] = half.data[i + 1]; rgb[j + 2] = half.data[i + 2]; }
  const jpg = execFileSync('cjpeg', ['-quality', '85'], { input: Buffer.concat([head, rgb]), maxBuffer: 1 << 30 });
  const file = new Uint8Array(src.length + strip.length + jpg.length);
  file.set(src); file.set(strip, src.length); file.set(jpg, src.length + strip.length);
  setVal(file, sub.get(0x0100), fw); setVal(file, sub.get(0x0101), fh);
  setVal(file, sub.get(0x0111), src.length); setVal(file, sub.get(0x0117), strip.length);
  setVal(file, ifd0.get(0x0201), src.length + strip.length); setVal(file, ifd0.get(0x0202), jpg.length);
  const name = path.join(outDir, `SYN_burst${k ? '_' + (k + 1) : ''}.ARW`);
  fs.writeFileSync(name, file);
  console.log(name, `shift ${sx.toFixed(3)}, ${sy.toFixed(3)} scene px`);
}

// scene.png rendered the way the app renders RAW (white balance, matrix, exposure from the frame-0 render)
const f0 = new Uint8Array(fs.readFileSync(path.join(outDir, 'SYN_burst.ARW'))), i0 = RAW.parse(f0), r0 = RAW.decode(f0, i0);
const exposure = RAW.autoExposure(r0, i0, +(args.target || 110)), fin = RAW.finisher(i0, exposure), sg = L.gain;
const png = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
for (let i = 0; i < W * H; i++) fin(scene.data[i * 3] * sg[0], scene.data[i * 3 + 1] * sg[1], scene.data[i * 3 + 2] * sg[2], png.data, i * 4);
const { PNG } = require('pngjs'); const p = new PNG({ width: W, height: H }); p.data = Buffer.from(png.data.buffer);
fs.writeFileSync(path.join(outDir, 'scene.png'), PNG.sync.write(p));
fs.writeFileSync(path.join(outDir, 'scene.f32'), Buffer.from(scene.data.buffer));   // raw-domain linear RGB, W*H*3
fs.writeFileSync(path.join(outDir, 'burst.json'), JSON.stringify({ src: path.basename(args.src), scene: [W, H], crop: [cx, cy], frames: [fw, fh], shifts, exposure, range }, null, 1));
console.log(`scene ${W}x${H}, frames ${fw}x${fh}, exposure ${exposure.toFixed(3)}`);

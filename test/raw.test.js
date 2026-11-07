const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const RAW = require('../src/frontend/raw.js');
const SR = require('../src/frontend/sr-core.js');

// Real ARW for the decoder check. Not in the repo (24 MB, personal photo):
// set ARW_SAMPLE=/path/to/ILCE-6000.ARW to run it. Reference values below
// come from LibRaw 0.21 via rawpy (raw_image, visible 6024 columns).
const SAMPLE = process.env.ARW_SAMPLE || '/tmp/immich/raw/DSC00001.ARW';
const have = fs.existsSync(SAMPLE);

test('ARW decode matches LibRaw exactly (ILCE-6000 compressed)', { skip: !have && 'set ARW_SAMPLE to an ILCE-6000 ARW' }, () => {
  const bytes = new Uint8Array(fs.readFileSync(SAMPLE));
  const info = RAW.parse(bytes);
  assert.equal(info.model, 'ILCE-6000');
  assert.equal(info.compression, 32767);
  assert.deepEqual([info.rawWidth, info.rawHeight, info.width, info.height], [6048, 4024, 6024, 4024]);
  assert.deepEqual(info.black, [512, 512, 512, 512]);
  assert.equal(info.white, 15360);
  assert.deepEqual(info.wbRGGB, [1920, 1024, 1024, 3264]);           // same as LibRaw camera_whitebalance (R G B G)
  const raw = RAW.decode(bytes, info);
  let sum = 0, h = 2166136261;
  for (let y = 0; y < 4024; y++) for (let x = 0; x < 6024; x++) sum += raw[y * 6048 + x];
  for (let y = 0; y < 4024; y += 97) for (let x = 0; x < 6024; x += 89) { h ^= raw[y * 6048 + x]; h = Math.imul(h, 16777619) >>> 0; }
  assert.equal(sum, 28292703644);
  assert.equal(h, 1783531373);
});

test('sonyCurve: identity below the first knot, then steps of 2, 4, 8, 16', () => {
  const c = RAW.sonyCurve([8000, 10400, 12900, 14100]);
  assert.equal(c[100], 100);
  assert.equal(c[2000], 2000);
  assert.equal(c[2001] - c[2000], 2);
  assert.equal(c[4095] - c[4094], 16);
});

test('sonyDecrypt is its own inverse', () => {
  const data = Uint8Array.from({ length: 4096 }, (_, i) => (i * 37) & 255), copy = data.slice();
  RAW.sonyDecrypt(data, 0, 4096, 0x4433b711);
  assert.notDeepEqual(data, copy);
  RAW.sonyDecrypt(data, 0, 4096, 0x4433b711);
  assert.deepEqual(data, copy);
});

test('demosaic of a flat colour returns that colour everywhere', () => {
  const w = 16, h = 12, cfa = [0, 1, 1, 2], col = [0.2, 0.5, 0.8], m = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = col[cfa[(y & 1) * 2 + (x & 1)]];
  const rgb = RAW.demosaic(m, w, h, cfa);
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) assert.ok(Math.abs(rgb[i * 3 + c] - col[c]) < 1e-5);
});

test('demosaic of a linear ramp is exact away from the border', () => {
  const w = 20, h = 20, cfa = [0, 1, 1, 2], m = new Float32Array(w * h);
  const f = (x, y, c) => 0.01 * x + 0.02 * y + 0.1 * c;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = f(x, y, cfa[(y & 1) * 2 + (x & 1)]);
  const rgb = RAW.demosaic(m, w, h, cfa);
  for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(rgb[(y * w + x) * 3 + c] - f(x, y, c)) < 1e-4, `(${x},${y},${c})`);
  }
});

test('orient rotates 90 degrees clockwise for orientation 6', () => {
  const img = { width: 3, height: 2, data: new Uint8ClampedArray(24) };
  for (let i = 0; i < 6; i++) img.data[i * 4] = i;                   // row 0: 0 1 2, row 1: 3 4 5
  const r = RAW.orient(img, 6);
  assert.deepEqual([r.width, r.height], [2, 3]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => r.data[i * 4]), [3, 0, 4, 1, 5, 2]);
});

test('parse rejects non-Sony and non-TIFF input with a clear message', () => {
  assert.throws(() => RAW.parse(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), /Not a TIFF/);
  const tiff = Uint8Array.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.throws(() => RAW.parse(tiff), /Only Sony ARW/);
});

test('mergeCFA: 8 shifted mosaics resolve detail one demosaiced photo cannot, and apply black/gain', () => {
  // scene: smooth colour waves on a 2x grid; each photo = shift, 2x2 box, RGGB mosaic
  const W = 480, H = 360, w = W / 2, h = H / 2, cfa = [0, 1, 1, 2];
  // fine detail above one photo's Nyquist limit (1.57 rad/px on this 2x grid): only a burst can resolve it
  const scene = (x, y, c) => 120 + 45 * Math.sin(1.9 * x + 0.4 * y + c) + 35 * Math.cos(0.3 * x - 1.7 * y + 2 * c);
  const shifts = [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 1.5], [1.5, 0.5], [0.25, 0.75], [1.75, 1.25]];
  const frames = shifts.map(([sx, sy]) => {
    const d = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = cfa[(y & 1) * 2 + (x & 1)];
      let v = 0;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) v += scene(2 * x + i + sx, 2 * y + j + sy, c);
      d[y * w + x] = v / 4 / 2 + 64;                                   // raw = value/2 + black 64
    }
    return { width: w, height: h, data: d, cfa, black: [64, 64, 64, 64], gain: [2, 2, 2] };
  });
  const warps = shifts.map(([sx, sy]) => SR.translation(-sx / 2, -sy / 2));   // frame(x) = ref(x + d), d = -s/2
  const truth = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 4; c++) truth.data[(y * W + x) * 4 + c] = c === 3 ? 255 : scene(x + 0.5, y + 0.5, c);
  const merged = SR.mergeCFA(frames, warps, { sigma: 0.25 });
  const m0 = frames[0], lin = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lin[i] = (m0.data[i] - 64) * 2;
  const rgb = RAW.demosaic(lin, w, h, cfa), one = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let i = 0; i < w * h; i++) { one.data[i * 4] = rgb[i * 3]; one.data[i * 4 + 1] = rgb[i * 3 + 1]; one.data[i * 4 + 2] = rgb[i * 3 + 2]; one.data[i * 4 + 3] = 255; }
  const single = SR.resampleRegion(one, { scale: 2, width: W, height: H });
  const pm = SR.psnr(merged, truth, 12), ps = SR.psnr(single, truth, 12);
  assert.ok(pm > ps + 1, `mergeCFA ${pm.toFixed(2)} dB vs single ${ps.toFixed(2)} dB`);
  // black level and gain applied: the mean of each channel matches the scene
  for (let c = 0; c < 3; c++) {
    let a = 0, b = 0;
    for (let i = 0; i < W * H; i++) { a += merged.data[i * 4 + c]; b += truth.data[i * 4 + c]; }
    assert.ok(Math.abs(a - b) / (W * H) < 2, `channel ${c}: ${(a / W / H).toFixed(1)} vs ${(b / W / H).toFixed(1)}`);
  }
});

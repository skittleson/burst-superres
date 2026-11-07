/* raw.js: Sony ARW decoding and a neutral render, no dependencies.
 * Page script and node module, like sr-core.js.
 *
 * Supported: ARW 2.x "compressed" (Compression 32767, 8 bits per pixel on
 * disk: Sony's 11-bit block code plus a tone curve) and uncompressed
 * (Compression 1, 14 bits in 16-bit words). Not supported: Sony lossless
 * compressed (LJPEG tiles, newer bodies). The decode follows dcraw/LibRaw's
 * sony_arw2_load_raw and sony_decrypt; the result was checked value-for-value
 * against LibRaw (see test/raw.test.js).
 */
function createRaw() {
  'use strict';

  // ---------- TIFF ----------

  function reader(bytes) {
    const le = bytes[0] === 0x49;
    if (!le && bytes[0] !== 0x4d) throw new Error('Not a TIFF/ARW file.');
    const u16 = (o) => (le ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
    const u32 = (o) => (le ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
      : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
    const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
    // One IFD -> Map(tag -> { type, count, values() , offset })
    function ifd(off) {
      const tags = new Map();
      if (off + 2 > bytes.length) return { tags, next: 0 };
      const n = u16(off);
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        if (e + 12 > bytes.length) break;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4), size = (SIZE[type] || 1) * count;
        const at = size <= 4 ? e + 8 : u32(e + 8);
        tags.set(tag, { type, count, at, values() {
          const out = [];
          for (let k = 0; k < Math.min(count, 4096); k++) {
            if (type === 3) out.push(u16(at + 2 * k));
            else if (type === 8) { const v = u16(at + 2 * k); out.push(v > 32767 ? v - 65536 : v); }
            else if (type === 4 || type === 13) out.push(u32(at + 4 * k));
            else if (type === 9) out.push(u32(at + 4 * k) | 0);
            else if (type === 5 || type === 10) { const a = u32(at + 8 * k), b = u32(at + 8 * k + 4); out.push(type === 10 ? (a | 0) / (b | 0) : a / b); }
            else out.push(bytes[at + k]);
          }
          return out;
        }, ascii() { let s = ''; for (let k = 0; k < count && bytes[at + k]; k++) s += String.fromCharCode(bytes[at + k]); return s; } });
      }
      const nextAt = off + 2 + n * 12;
      return { tags, next: nextAt + 4 <= bytes.length ? u32(nextAt) : 0 };
    }
    return { le, u16, u32, ifd, first: () => u32(4) };
  }

  const v1 = (t, tag, d) => (t.tags.has(tag) ? t.tags.get(tag).values()[0] : d);
  // A 32-bit value that some writers store as 4 BYTE/UNDEFINED (SR2Private, SR2 key).
  const u32Tag = (R, t, tag, d) => {
    if (!t.tags.has(tag)) return d;
    const e = t.tags.get(tag);
    return (e.type === 1 || e.type === 7) && e.count === 4 ? R.u32(e.at) : e.values()[0];
  };

  // ---------- Sony SR2 decryption (dcraw sony_decrypt) ----------

  function sonyDecrypt(bytes, start, length, key) {
    const pad = new Uint32Array(128);
    for (let p = 0; p < 4; p++) { key = (Math.imul(key, 48828125) + 1) >>> 0; pad[p] = key; }
    pad[3] = ((pad[3] << 1) | ((pad[0] ^ pad[2]) >>> 31)) >>> 0;
    for (let p = 4; p < 127; p++) pad[p] = (((pad[p - 4] ^ pad[p - 2]) << 1) | ((pad[p - 3] ^ pad[p - 1]) >>> 31)) >>> 0;
    let p = 127;
    for (let o = start; o + 4 <= start + length; o += 4) {
      p++;
      const w = (pad[(p - 1) & 127] = (pad[p & 127] ^ pad[(p + 64) & 127]) >>> 0);
      bytes[o] ^= w >>> 24; bytes[o + 1] ^= (w >>> 16) & 255; bytes[o + 2] ^= (w >>> 8) & 255; bytes[o + 3] ^= w & 255;
    }
  }

  // ---------- metadata ----------

  /**
   * Parse an ARW. `bytes` is the whole file (Uint8Array); the SR2 block is
   * decrypted in a copy of just that range. Returns everything decode() and
   * render() need, plus the embedded preview's location.
   */
  function parse(bytes) {
    const R = reader(bytes), ifd0 = R.ifd(R.first());
    const make = ifd0.tags.has(0x010f) ? ifd0.tags.get(0x010f).ascii() : '';
    const model = ifd0.tags.has(0x0110) ? ifd0.tags.get(0x0110).ascii() : '';
    if (!/sony/i.test(make)) throw new Error(`Only Sony ARW files are supported (this one is from "${make || 'unknown'}").`);
    const info = { make, model, orientation: v1(ifd0, 0x0112, 1) };
    // embedded preview JPEG (IFD0 JPEGInterchangeFormat)
    if (ifd0.tags.has(0x0201)) info.preview = { offset: v1(ifd0, 0x0201), length: v1(ifd0, 0x0202) };
    // EXIF sub-IFD, for the capture time
    if (ifd0.tags.has(0x8769)) {
      const ex = R.ifd(v1(ifd0, 0x8769));
      if (ex.tags.has(0x9003)) info.dateTimeOriginal = ex.tags.get(0x9003).ascii();
    }
    // raw image: the SubIFD (0x014a) whose compression is 32767 or 1
    const subs = ifd0.tags.has(0x014a) ? ifd0.tags.get(0x014a).values() : [];
    let raw = null;
    for (const off of subs) {
      const s = R.ifd(off), c = v1(s, 0x0103, 0);
      if (c === 32767 || c === 1) { raw = s; info.compression = c; break; }
    }
    if (!raw) throw new Error('This ARW uses a raw format the app cannot read yet (for example lossless compressed).');
    info.rawWidth = v1(raw, 0x0100); info.rawHeight = v1(raw, 0x0101);
    info.bits = v1(raw, 0x0102, 12);
    info.stripOffset = v1(raw, 0x0111); info.stripBytes = v1(raw, 0x0117);
    const cfa = raw.tags.has(0x828e) ? raw.tags.get(0x828e).values() : [0, 1, 1, 2];
    info.cfa = cfa.slice(0, 4);                                // 0 R, 1 G, 2 B for (0,0) (1,0) (0,1) (1,1)
    info.toneCurve = raw.tags.has(0x7010) ? raw.tags.get(0x7010).values() : null;
    // SR2: black level, white balance, white level, Sony's camera-to-sRGB matrix
    if (ifd0.tags.has(0xc634)) {
      const sr2 = R.ifd(u32Tag(R, ifd0, 0xc634, 0));
      const off = u32Tag(R, sr2, 0x7200, 0), len = u32Tag(R, sr2, 0x7201, 0), key = u32Tag(R, sr2, 0x7221, 0);
      if (off && len && off + len <= bytes.length) {
        const dec = bytes.slice(0, off + len);                   // decrypt a copy; offsets stay absolute
        sonyDecrypt(dec, off, len & ~3, key);
        const s = reader(dec).ifd(off);
        if (s.tags.has(0x7310)) info.black = s.tags.get(0x7310).values().slice(0, 4);
        if (s.tags.has(0x7313)) info.wbRGGB = s.tags.get(0x7313).values().slice(0, 4);
        else if (s.tags.has(0x7303)) { const g = s.tags.get(0x7303).values(); info.wbRGGB = [g[1], g[0], g[3], g[2]]; } // GRBG
        if (s.tags.has(0x787f)) info.white = s.tags.get(0x787f).values()[0];
        if (s.tags.has(0x7800)) info.colorMatrix = s.tags.get(0x7800).values().slice(0, 9).map((v) => v / 1024);
      }
    }
    info.black = info.black || [512, 512, 512, 512];
    info.white = info.white || 16383;
    info.wbRGGB = info.wbRGGB || [1, 1, 1, 1];
    // dcraw: Sony bodies with a 6048-wide raw carry 24 unused columns on the right
    info.width = info.rawWidth === 6048 ? 6024 : info.rawWidth;
    info.height = info.rawHeight;
    return info;
  }

  // ---------- raw decode ----------

  // dcraw: curve from SonyToneCurve (0x7010), applied to the 11-bit codes.
  function sonyCurve(points) {
    const knots = [0, 0, 0, 0, 0, 4095];
    for (let c = 0; c < 4; c++) knots[c + 1] = (points[c] >> 2) & 0xfff;
    const curve = new Uint16Array(0x10000);
    for (let i = 0; i < 0x10000; i++) curve[i] = i;
    for (let i = 0; i < 5; i++) for (let j = knots[i] + 1; j <= knots[i + 1]; j++) curve[j] = curve[j - 1] + (1 << i);
    return curve;
  }

  /** Bayer data, Uint16Array rawWidth*rawHeight, in the 14-bit domain (black ~512). */
  function decode(bytes, info) {
    const W = info.rawWidth, H = info.rawHeight, out = new Uint16Array(W * H);
    let o = info.stripOffset;
    if (info.compression === 1) {
      const le = bytes[0] === 0x49;
      for (let i = 0; i < W * H; i++, o += 2) out[i] = le ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1];
      return out;
    }
    if (info.stripBytes !== W * H) throw new Error('Unexpected compressed ARW size; this camera variant is not supported.');
    const curve = sonyCurve(info.toneCurve || [8000, 10400, 12900, 14100]);
    const pix = new Uint16Array(16);
    const g2 = (p) => bytes[p] | (bytes[p + 1] << 8);
    for (let row = 0; row < H; row++) {
      const base = row * W;
      let dp = o + row * W;
      for (let col = 0; col < W - 30; dp += 16) {
        const val = (bytes[dp] | (bytes[dp + 1] << 8) | (bytes[dp + 2] << 16) | (bytes[dp + 3] << 24)) >>> 0;
        const max = 0x7ff & val, min = 0x7ff & (val >>> 11), imax = 0x0f & (val >>> 22), imin = 0x0f & (val >>> 26);
        let sh = 0;
        while (sh < 4 && (0x80 << sh) <= max - min) sh++;
        for (let bit = 30, i = 0; i < 16; i++) {
          if (i === imax) pix[i] = max;
          else if (i === imin) pix[i] = min;
          else {
            const v = (((g2(dp + (bit >> 3)) >> (bit & 7)) & 0x7f) << sh) + min;
            pix[i] = v > 0x7ff ? 0x7ff : v;
            bit += 7;
          }
        }
        for (let i = 0; i < 16; i++, col += 2) out[base + col] = curve[pix[i] << 1];
        col -= col & 1 ? 1 : 31;
      }
    }
    return out;
  }

  // ---------- render: demosaic + white balance + color + sRGB ----------

  // Malvar, He & Cutler (2004) 5x5 linear demosaic. Kernels /8.
  const K_G_AT_RB = [[0, 0, -1, 0, 0], [0, 0, 2, 0, 0], [-1, 2, 4, 2, -1], [0, 0, 2, 0, 0], [0, 0, -1, 0, 0]];
  const K_RB_AT_G_ROW = [[0, 0, 0.5, 0, 0], [0, -1, 0, -1, 0], [-1, 4, 5, 4, -1], [0, -1, 0, -1, 0], [0, 0, 0.5, 0, 0]];   // same-row neighbours
  const K_RB_AT_G_COL = K_RB_AT_G_ROW[0].map((_, i) => K_RB_AT_G_ROW.map((r) => r[i]));                                   // transpose
  const K_RB_AT_BR = [[0, 0, -1.5, 0, 0], [0, 2, 0, 2, 0], [-1.5, 0, 6, 0, -1.5], [0, 2, 0, 2, 0], [0, 0, -1.5, 0, 0]];

  /**
   * Malvar–He–Cutler demosaic of a float mosaic (any value domain).
   * mosaic: Float32Array w*h, cfa: [c(0,0), c(1,0), c(0,1), c(1,1)] with 0 R 1 G 2 B.
   * Returns Float32Array w*h*3.
   */
  function demosaic(mosaic, w, h, cfa) {
    const cfaAt = (x, y) => cfa[(y & 1) * 2 + (x & 1)];
    const P = 2, pw = w + 2 * P, B = new Float32Array(pw * (h + 2 * P));
    for (let y = -P; y < h + P; y++) {
      // mirror by an even amount so the CFA colour stays the same
      let my = y < 0 ? -y : y >= h ? 2 * h - 2 - y : y;
      if ((my & 1) !== (y & 1)) my += y < 0 ? 1 : -1;
      for (let x = -P; x < w + P; x++) {
        let mx = x < 0 ? -x : x >= w ? 2 * w - 2 - x : x;
        if ((mx & 1) !== (x & 1)) mx += x < 0 ? 1 : -1;
        B[(y + P) * pw + x + P] = mosaic[my * w + mx];
      }
    }
    const conv = (K, i) => {
      let s = 0;
      for (let j = 0; j < 5; j++) for (let k = 0; k < 5; k++) { const kv = K[j][k]; if (kv) s += kv * B[i + (j - 2) * pw + (k - 2)]; }
      return s / 8;
    };
    const out = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y + P) * pw + x + P, c = cfaAt(x, y), o = (y * w + x) * 3;
      if (c === 1) {
        const a = conv(K_RB_AT_G_ROW, i), b = conv(K_RB_AT_G_COL, i);
        const redInRow = cfaAt(x + 1, y) === 0;
        out[o] = redInRow ? a : b; out[o + 1] = B[i]; out[o + 2] = redInRow ? b : a;
      } else {
        const g = conv(K_G_AT_RB, i), other = conv(K_RB_AT_BR, i);
        out[o + 1] = g;
        if (c === 0) { out[o] = B[i]; out[o + 2] = other; } else { out[o + 2] = B[i]; out[o] = other; }
      }
    }
    return out;
  }

  const toSRGB = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  const SRGB_LUT = new Uint8Array(4097);
  for (let i = 0; i <= 4096; i++) SRGB_LUT[i] = Math.round(255 * toSRGB(i / 4096));
  // soft shoulder above 0.75 so bright areas roll off instead of clipping hard
  const shoulder = (v) => (v <= 0.75 ? v : 0.75 + 0.25 * (1 - Math.exp(-(v - 0.75) / 0.25)));
  const enc = (v) => SRGB_LUT[Math.round(4096 * Math.min(1, Math.max(0, shoulder(v))))];

  /**
   * (r, g, b) white-balanced linear camera values -> 8-bit sRGB into out[i..i+3].
   * Used by render() and by the raw merge, so both look the same.
   */
  function finisher(info, exposure = 1) {
    const M = info.colorMatrix || [1, 0, 0, 0, 1, 0, 0, 0, 1];
    return (r, g, b, out, i) => {
      out[i] = enc(exposure * (M[0] * r + M[1] * g + M[2] * b));
      out[i + 1] = enc(exposure * (M[3] * r + M[4] * g + M[5] * b));
      out[i + 2] = enc(exposure * (M[6] * r + M[7] * g + M[8] * b));
      out[i + 3] = 255;
    };
  }

  // Per-photo levels: (raw - black) * gain[c] gives white-balanced linear 0..1.
  function levels(info) {
    const wb = info.wbRGGB, gN = (wb[1] + wb[2]) / 2, s = 1 / (info.white - info.black[0]);
    return { black: info.black.slice(0, 4), gain: [s * wb[0] / gN, s, s * wb[3] / gN] };
  }

  /**
   * Exposure that makes the rendered photo about as bright as `targetMean`
   * (mean sRGB luma 0..255, for example from the camera's own preview JPEG).
   * Uses every 8th Bayer quad; clamped to 0.5..16.
   */
  function autoExposure(raw, info, targetMean) {
    const W = info.rawWidth, L = levels(info), cfa = info.cfa, M = info.colorMatrix || [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const samples = [];
    for (let y = 0; y + 1 < info.height; y += 16) for (let x = 0; x + 1 < info.width; x += 16) {
      const v = [0, 0, 0], n = [0, 0, 0];
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const c = cfa[j * 2 + i];
        v[c] += Math.max(0, raw[(y + j) * W + x + i] - L.black[j * 2 + i]) * L.gain[c]; n[c]++;
      }
      const r = v[0] / n[0], g = v[1] / n[1], b = v[2] / n[2];
      samples.push([M[0] * r + M[1] * g + M[2] * b, M[3] * r + M[4] * g + M[5] * b, M[6] * r + M[7] * g + M[8] * b]);
    }
    const meanAt = (e) => {
      let s = 0;
      for (const [r, g, b] of samples) s += 0.299 * enc(e * r) + 0.587 * enc(e * g) + 0.114 * enc(e * b);
      return s / samples.length;
    };
    let lo = 0.5, hi = 16;
    if (meanAt(hi) <= targetMean) return hi;
    if (meanAt(lo) >= targetMean) return lo;
    for (let i = 0; i < 24; i++) { const m = Math.sqrt(lo * hi); if (meanAt(m) < targetMean) lo = m; else hi = m; }
    return Math.sqrt(lo * hi);
  }

  /**
   * Render the visible area to 8-bit sRGB RGBA. opts.exposure multiplies the
   * linear result (1 = raw white maps to white); opts.orient = false keeps
   * sensor orientation. Returns { width, height, data, linearMedian }.
   * The default matrix is Sony's own camera-to-sRGB matrix from the file
   * (rows sum to 1, applied after white balance).
   */
  function render(raw, info, opts = {}) {
    const W = info.rawWidth, w = info.width, h = info.height, exposure = opts.exposure || 1;
    const cfaAt = (x, y) => info.cfa[(y & 1) * 2 + (x & 1)];
    const wb = info.wbRGGB, gN = (wb[1] + wb[2]) / 2;
    const mul = [wb[0] / gN, 1, wb[3] / gN];                          // per colour 0 R, 1 G, 2 B
    const M = info.colorMatrix || [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const black = info.black, scale = 1 / (info.white - black[0]);
    // normalised linear Bayer, white balanced, with a 2px mirrored border
    const P = 2, pw = w + 2 * P, ph = h + 2 * P, B = new Float32Array(pw * ph);
    for (let y = -P; y < h + P; y++) {
      const sy = y < 0 ? -y : y >= h ? 2 * h - 2 - y : y;
      for (let x = -P; x < w + P; x++) {
        const sx = x < 0 ? -x : x >= w ? 2 * w - 2 - x : x;
        // mirror by an even amount so the CFA colour stays the same
        const mx = (sx & 1) === (x & 1) ? sx : sx + (x < 0 ? 1 : -1), my = (sy & 1) === (y & 1) ? sy : sy + (y < 0 ? 1 : -1);
        const c = cfaAt(mx, my);
        B[(y + P) * pw + x + P] = Math.max(0, raw[my * W + mx] - black[(my & 1) * 2 + (mx & 1)]) * scale * mul[c];
      }
    }
    const conv = (K, i) => {
      let s = 0;
      for (let j = 0; j < 5; j++) for (let k = 0; k < 5; k++) { const kv = K[j][k]; if (kv) s += kv * B[i + (j - 2) * pw + (k - 2)]; }
      return s / 8;
    };
    const out = new Uint8ClampedArray(w * h * 4), fin = finisher(info, exposure);
    const lumSamples = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y + P) * pw + x + P, c = cfaAt(x, y);
        let r, g, b;
        if (c === 1) {
          g = B[i];
          const redInRow = cfaAt(x + 1, y) === 0;
          const a = conv(K_RB_AT_G_ROW, i), bb = conv(K_RB_AT_G_COL, i);
          if (redInRow) { r = a; b = bb; } else { r = bb; b = a; }
        } else {
          g = conv(K_G_AT_RB, i);
          const other = conv(K_RB_AT_BR, i);
          if (c === 0) { r = B[i]; b = other; } else { b = B[i]; r = other; }
        }
        if ((x & 7) === 0 && (y & 7) === 0) lumSamples.push(0.2126 * (M[0] * r + M[1] * g + M[2] * b) + 0.7152 * (M[3] * r + M[4] * g + M[5] * b) + 0.0722 * (M[6] * r + M[7] * g + M[8] * b));
        fin(r, g, b, out, (y * w + x) * 4);
      }
    }
    lumSamples.sort((a, b) => a - b);
    let img = { width: w, height: h, data: out };
    if (opts.orient !== false) img = orient(img, info.orientation);
    img.linearMedian = lumSamples[lumSamples.length >> 1] || 0;
    return img;
  }

  // EXIF orientation 3 (180), 6 (90 cw), 8 (90 ccw).
  function orient(img, o) {
    if (o !== 3 && o !== 6 && o !== 8) return img;
    const { width: w, height: h, data } = img, W = o === 3 ? w : h, H = o === 3 ? h : w, out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [X, Y] = o === 3 ? [w - 1 - x, h - 1 - y] : o === 6 ? [h - 1 - y, x] : [y, w - 1 - x];
      out.set(data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (Y * W + X) * 4);
    }
    return { width: W, height: H, data: out };
  }

  const isRawName = (p) => /\.arw$/i.test(p);

  /** Make, model, orientation, capture time and preview location from the first ~200 KB. */
  function headerInfo(bytes) {
    const R = reader(bytes), ifd0 = R.ifd(R.first());
    const out = { make: ifd0.tags.has(0x010f) ? ifd0.tags.get(0x010f).ascii() : '', orientation: v1(ifd0, 0x0112, 1) };
    if (ifd0.tags.has(0x0201)) out.preview = { offset: v1(ifd0, 0x0201), length: v1(ifd0, 0x0202) };
    if (ifd0.tags.has(0x8769)) { const ex = R.ifd(v1(ifd0, 0x8769)); if (ex.tags.has(0x9003)) out.dateTimeOriginal = ex.tags.get(0x9003).ascii(); }
    const m = out.dateTimeOriginal && out.dateTimeOriginal.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
    out.time = m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : null;
    return out;
  }

  return { parse, decode, render, demosaic, finisher, levels, autoExposure, orient, headerInfo, sonyDecrypt, sonyCurve, isRawName };
}

if (typeof module === 'object' && module.exports) module.exports = createRaw();

/* exif.js: carry the reference photo's EXIF (camera, lens, date, exposure)
 * into the saved JPEG. Byte-level, no dependencies. Page script and node
 * module, like sr-core.js.
 *
 * Only values already in the block are edited in place, so no offsets move:
 *   Orientation -> 1 (the webview already rotated the pixels)
 *   PixelXDimension / PixelYDimension, ImageWidth / ImageLength -> output size
 */
function createExif() {
  'use strict';

  // Payload ("Exif\0\0" + TIFF) of the first EXIF APP1 segment, or null.
  function extractApp1(bytes) {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let o = 2;
    while (o + 4 <= bytes.length && bytes[o] === 0xff) {
      const marker = bytes[o + 1];
      if (marker === 0xda || marker === 0xd9) break;          // start of scan / end
      const len = (bytes[o + 2] << 8) | bytes[o + 3];
      if (marker === 0xe1 && len > 8 && bytes[o + 4] === 0x45 && bytes[o + 5] === 0x78 &&
          bytes[o + 6] === 0x69 && bytes[o + 7] === 0x66 && bytes[o + 8] === 0 && bytes[o + 9] === 0) {
        if (o + 2 + len > bytes.length) return null;           // truncated read
        return bytes.slice(o + 4, o + 2 + len);
      }
      o += 2 + len;
    }
    return null;
  }

  // Copy of the APP1 payload with orientation and dimensions updated.
  function patchApp1(payload, { width, height }) {
    const p = payload.slice(), t = 6;                          // TIFF header after "Exif\0\0"
    const le = p[t] === 0x49;                                  // "II" little endian, "MM" big
    if (!le && p[t] !== 0x4d) return p;
    const u16 = (o) => (le ? p[o] | (p[o + 1] << 8) : (p[o] << 8) | p[o + 1]);
    const u32 = (o) => (le ? (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)) >>> 0
      : ((p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]) >>> 0);
    const w16 = (o, v) => { if (le) { p[o] = v & 255; p[o + 1] = v >> 8; } else { p[o] = v >> 8; p[o + 1] = v & 255; } };
    const w32 = (o, v) => { for (let i = 0; i < 4; i++) p[o + (le ? i : 3 - i)] = (v >>> (8 * i)) & 255; };
    const setValue = (entry, v) => {                           // SHORT or LONG, count 1, stored inline
      const type = u16(entry + 2);
      if (type === 3 && v <= 0xffff) w16(entry + 8, v);
      else if (type === 4) w32(entry + 8, v);
    };
    const walk = (ifd, fn) => {
      const base = t + ifd;
      if (base + 2 > p.length) return;
      const n = u16(base);
      for (let i = 0; i < n; i++) {
        const e = base + 2 + i * 12;
        if (e + 12 > p.length) return;
        fn(u16(e), e);
      }
    };
    walk(u32(t + 4), (tag, e) => {
      if (tag === 0x0112) setValue(e, 1);                      // Orientation
      else if (tag === 0x0100) setValue(e, width);             // ImageWidth
      else if (tag === 0x0101) setValue(e, height);            // ImageLength
      else if (tag === 0x8769) walk(u32(e + 8), (tag2, e2) => {  // Exif sub-IFD
        if (tag2 === 0xa002) setValue(e2, width);
        else if (tag2 === 0xa003) setValue(e2, height);
      });
    });
    return p;
  }

  // New JPEG bytes with the APP1 payload inserted right after SOI.
  function insertApp1(jpeg, payload) {
    if (!payload || payload.length + 2 > 0xffff || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
    const out = new Uint8Array(jpeg.length + payload.length + 4);
    out.set(jpeg.subarray(0, 2), 0);
    out[2] = 0xff; out[3] = 0xe1; out[4] = (payload.length + 2) >> 8; out[5] = (payload.length + 2) & 255;
    out.set(payload, 6);
    out.set(jpeg.subarray(2), 6 + payload.length);
    return out;
  }

  // DateTimeOriginal (or DateTime) from an APP1 payload, as seconds, or null.
  function captureTime(payload) {
    if (!payload || payload.length < 14) return null;
    const p = payload, t = 6, le = p[t] === 0x49;
    const u16 = (o) => (le ? p[o] | (p[o + 1] << 8) : (p[o] << 8) | p[o + 1]);
    const u32 = (o) => (le ? (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)) >>> 0
      : ((p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]) >>> 0);
    const ascii = (e) => { const off = t + u32(e + 8); return String.fromCharCode(...p.slice(off, off + 19)); };
    let found = null;
    const walk = (ifd, fn) => {
      const base = t + ifd;
      if (base + 2 > p.length) return;
      for (let i = 0, n = u16(base); i < n; i++) { const e = base + 2 + i * 12; if (e + 12 > p.length) return; fn(u16(e), e); }
    };
    walk(u32(t + 4), (tag, e) => {
      if (tag === 0x0132 && !found) found = ascii(e);                         // DateTime
      else if (tag === 0x8769) walk(u32(e + 8), (t2, e2) => { if (t2 === 0x9003) found = ascii(e2); });
    });
    const m = found && found.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
    return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : null;
  }

  /**
   * A minimal little-endian EXIF APP1 payload from plain fields (used for
   * RAW input, whose EXIF is not a JPEG APP1 block). Fields, all optional:
   * make, model, software, dateTimeOriginal ("YYYY:MM:DD HH:MM:SS"),
   * exposureTime [num, den], fNumber [num, den], iso, focalLength [num, den],
   * lensModel, width, height. Orientation is always 1.
   */
  function buildApp1(f) {
    const ifd0 = [], exif = [];
    const ascii = (tag, v) => v && { tag, type: 2, ascii: v };
    const rat = (tag, v) => v && v[1] && { tag, type: 5, rats: [v] };
    const short = (tag, v) => v != null && { tag, type: 3, value: v };
    const long = (tag, v) => v != null && { tag, type: 4, value: v };
    ifd0.push(ascii(0x010f, f.make), ascii(0x0110, f.model), short(0x0112, 1), ascii(0x0131, f.software), ascii(0x0132, f.dateTimeOriginal));
    exif.push(rat(0x829a, f.exposureTime), rat(0x829d, f.fNumber), short(0x8827, f.iso), ascii(0x9003, f.dateTimeOriginal),
      rat(0x920a, f.focalLength), long(0xa002, f.width), long(0xa003, f.height), ascii(0xa434, f.lensModel));
    const e0 = ifd0.filter(Boolean), e1 = exif.filter(Boolean);
    e0.push({ tag: 0x8769, type: 4, value: 0 });                 // ExifIFD pointer, patched below
    e0.sort((a, b) => a.tag - b.tag); e1.sort((a, b) => a.tag - b.tag);
    const bytes = [];
    const u16 = (v) => bytes.push(v & 255, (v >> 8) & 255);
    const u32 = (v) => bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24);
    // layout: header 8, IFD0, ExifIFD, then values
    const ifdSize = (n) => 2 + n * 12 + 4;
    const at0 = 8, at1 = at0 + ifdSize(e0.length);
    let dataAt = at1 + ifdSize(e1.length);
    const data = [];
    const place = (e) => {
      if (e.ascii != null) {
        const b = [...e.ascii].map((c) => c.charCodeAt(0) & 255); b.push(0);
        e.count = b.length;
        if (b.length <= 4) { e.inline = b; return; }
        e.offset = dataAt; data.push(...b); dataAt += b.length;
        if (dataAt & 1) { data.push(0); dataAt++; }
      } else if (e.rats) {
        e.count = 1; e.offset = dataAt;
        for (const [n, d] of e.rats) { for (const v of [n, d]) data.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24); dataAt += 8; }
      } else e.count = 1;
    };
    e0.forEach(place); e1.forEach(place);
    e0.find((e) => e.tag === 0x8769).value = at1;
    const writeIfd = (es) => {
      u16(es.length);
      for (const e of es) {
        u16(e.tag); u16(e.type); u32(e.count);
        if (e.inline) { const b = e.inline.concat([0, 0, 0, 0]).slice(0, 4); bytes.push(...b); }
        else if (e.offset != null) u32(e.offset);
        else if (e.type === 3) { u16(e.value); u16(0); }
        else u32(e.value);
      }
      u32(0);
    };
    bytes.push(0x49, 0x49, 42, 0); u32(8);
    writeIfd(e0); writeIfd(e1);
    return Uint8Array.from([0x45, 0x78, 0x69, 0x66, 0, 0, ...bytes, ...data]);
  }

  // Convenience: EXIF from `source` JPEG bytes into `target` JPEG bytes.
  function copyExif(source, target, size) {
    const app1 = extractApp1(source);
    return app1 ? insertApp1(target, patchApp1(app1, size)) : target;
  }

  return { extractApp1, patchApp1, insertApp1, copyExif, captureTime, buildApp1 };
}

if (typeof module === 'object' && module.exports) module.exports = createExif();

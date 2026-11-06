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

  // Convenience: EXIF from `source` JPEG bytes into `target` JPEG bytes.
  function copyExif(source, target, size) {
    const app1 = extractApp1(source);
    return app1 ? insertApp1(target, patchApp1(app1, size)) : target;
  }

  return { extractApp1, patchApp1, insertApp1, copyExif };
}

if (typeof module === 'object' && module.exports) module.exports = createExif();

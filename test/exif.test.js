const test = require('node:test');
const assert = require('node:assert/strict');
const EXIF = require('../src/frontend/exif.js');

// Minimal EXIF APP1 payload: IFD0 { Make, Orientation=6, ExifIFD -> { PixelX=6000 (LONG), PixelY=4000 (SHORT) } }.
function makeApp1(le) {
  const b = [];
  const u16 = (v) => (le ? b.push(v & 255, v >> 8) : b.push(v >> 8, v & 255));
  const u32 = (v) => { for (let i = 0; i < 4; i++) b.push((v >>> (8 * (le ? i : 3 - i))) & 255); };
  b.push(0x45, 0x78, 0x69, 0x66, 0, 0);                 // "Exif\0\0"
  b.push(...(le ? [0x49, 0x49] : [0x4d, 0x4d])); u16(42); u32(8);
  // IFD0 at 8: 3 entries
  u16(3);
  u16(0x010f); u16(2); u32(4); b.push(0x53, 0x4f, 0x4e, 0x00);   // Make "SON\0" inline
  u16(0x0112); u16(3); u32(1); u16(6); u16(0);                    // Orientation = 6
  u16(0x8769); u16(4); u32(1); u32(8 + 2 + 3 * 12 + 4);           // ExifIFD offset
  u32(0);                                                          // next IFD
  // Exif IFD
  u16(2);
  u16(0xa002); u16(4); u32(1); u32(6000);
  u16(0xa003); u16(3); u32(1); u16(4000); u16(0);
  u32(0);
  return Uint8Array.from(b);
}

function jpegWith(app1) {
  const seg = app1 ? [0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255, ...app1] : [];
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, ...seg, 0xff, 0xda, 0, 2, 9, 9, 0xff, 0xd9]);
}

function readBack(payload, le) {
  const u16 = (o) => (le ? payload[o] | (payload[o + 1] << 8) : (payload[o] << 8) | payload[o + 1]);
  const u32 = (o) => (le ? (payload[o] | (payload[o + 1] << 8) | (payload[o + 2] << 16) | (payload[o + 3] << 24)) >>> 0
    : ((payload[o] << 24) | (payload[o + 1] << 16) | (payload[o + 2] << 8) | payload[o + 3]) >>> 0);
  const t = 6, ifd0 = t + 8, exif = t + 8 + 2 + 3 * 12 + 4;
  return { orientation: u16(ifd0 + 2 + 12 + 8), make: String.fromCharCode(...payload.slice(ifd0 + 2 + 8, ifd0 + 2 + 11)),
    px: u32(exif + 2 + 8), py: u16(exif + 2 + 12 + 8) };
}

for (const le of [true, false]) {
  test(`extract, patch and insert EXIF (${le ? 'little' : 'big'} endian)`, () => {
    const app1 = makeApp1(le);
    const found = EXIF.extractApp1(jpegWith(app1));
    assert.deepEqual(found, app1);
    const patched = EXIF.patchApp1(found, { width: 12000, height: 8000 });
    assert.deepEqual(readBack(patched, le), { orientation: 1, make: 'SON', px: 12000, py: 8000 });
    assert.deepEqual(readBack(app1, le).orientation, 6, 'source untouched');
    const out = EXIF.copyExif(jpegWith(app1), jpegWith(null), { width: 12000, height: 8000 });
    assert.deepEqual([...out.slice(0, 4)], [0xff, 0xd8, 0xff, 0xe1]);
    assert.deepEqual(readBack(EXIF.extractApp1(out), le), { orientation: 1, make: 'SON', px: 12000, py: 8000 });
  });
}

test('copyExif leaves the target alone when the source has no EXIF', () => {
  const target = jpegWith(null);
  assert.equal(EXIF.copyExif(jpegWith(null), target, { width: 1, height: 1 }), target);
});

test('extractApp1 returns null for truncated input and non-JPEG bytes', () => {
  const full = jpegWith(makeApp1(true));
  assert.equal(EXIF.extractApp1(full.slice(0, 20)), null);
  assert.equal(EXIF.extractApp1(Uint8Array.from([1, 2, 3])), null);
});

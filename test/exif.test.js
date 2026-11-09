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

test('captureTime reads DateTimeOriginal from a real-shaped block', () => {
  // IFD0 with ExifIFD -> DateTimeOriginal "2023:12:28 12:25:26"
  const b = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 42, 0, 8, 0, 0, 0];
  const push16 = (v) => b.push(v & 255, v >> 8), push32 = (v) => b.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24);
  push16(1); push16(0x8769); push16(4); push32(1); push32(26); push32(0);              // IFD0 at 8, ExifIFD at 26
  push16(1); push16(0x9003); push16(2); push32(20); push32(44); push32(0);             // ExifIFD, value at 44
  b.push(...Buffer.from('2023:12:28 12:25:26\0'));
  assert.equal(EXIF.captureTime(Uint8Array.from(b)), Date.UTC(2023, 11, 28, 12, 25, 26) / 1000);
  assert.equal(EXIF.captureTime(null), null);
});

test('buildApp1 writes fields that a reader can parse back', () => {
  const app1 = EXIF.buildApp1({ make: 'SONY', model: 'ILCE-6000', dateTimeOriginal: '2023:03:20 23:30:49', exposureTime: [1, 60], fNumber: [35, 10], iso: 3200, focalLength: [160, 10], lensModel: 'E PZ 16-50mm F3.5-5.6 OSS', width: 12048, height: 8048 });
  assert.equal(EXIF.captureTime(app1), Date.UTC(2023, 2, 20, 23, 30, 49) / 1000);
  // a JPEG with it inserted round-trips through extractApp1 unchanged
  const jpeg = EXIF.insertApp1(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), app1);
  assert.deepEqual(EXIF.extractApp1(jpeg), app1);
});

test('insertPngExif puts a valid eXIf chunk after IHDR, before IDAT, and reads back', () => {
  const zlib = require('node:zlib');
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); Buffer.from(data).copy(b, 8);
    b.writeUInt32BE(EXIF.crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 1, 2, 3]))), chunk('IEND', [])]);
  assert.equal(EXIF.crc32(Buffer.from('123456789')), 0xcbf43926);
  const app1 = EXIF.buildApp1({ make: 'SONY', dateTimeOriginal: '2023:03:20 23:30:49', width: 10, height: 8 });
  const out = Buffer.from(EXIF.insertPngExif(png, app1));
  // walk the chunks: order, lengths and CRCs
  const types = [];
  let exifData = null;
  for (let o = 8; o < out.length;) {
    const len = out.readUInt32BE(o), type = out.toString('latin1', o + 4, o + 8);
    assert.equal(out.readUInt32BE(o + 8 + len), EXIF.crc32(out.subarray(o + 4, o + 8 + len)), type + ' crc');
    if (type === 'eXIf') exifData = out.subarray(o + 8, o + 8 + len);
    types.push(type); o += 12 + len;
  }
  assert.deepEqual(types, ['IHDR', 'eXIf', 'IDAT', 'IEND']);
  assert.deepEqual(Uint8Array.from(exifData), Uint8Array.from(app1.subarray(6)));
  assert.equal(EXIF.captureTime(Uint8Array.from([...app1.subarray(0, 6), ...exifData])), Date.UTC(2023, 2, 20, 23, 30, 49) / 1000);
  assert.equal(EXIF.insertPngExif(out, app1).length, out.length, 'no second eXIf');
  assert.equal(EXIF.insertPngExif(Uint8Array.from([1, 2, 3]), app1).length, 3, 'not a PNG: unchanged');
});

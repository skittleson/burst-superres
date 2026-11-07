#!/usr/bin/env node
// Score an app-saved merge of a synthetic ARW burst (tools/arw-encode.js)
// against its scene, rendered with the exposure the app used.
//   node tools/score-raw.js <burst dir> <merged.png|jpg> <exposure> [border 32]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const RAW = require('../src/frontend/raw.js');
const SR = require('../src/frontend/sr-core.js');
const [dir, file, exposure, border = 32] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'burst.json')));
const [W, H] = meta.scene;
const f0 = new Uint8Array(fs.readFileSync(path.join(dir, 'SYN_burst.ARW'))), info = RAW.parse(f0);
const fin = RAW.finisher(info, +exposure), g = RAW.levels(info).gain;
const sc = new Float32Array(fs.readFileSync(path.join(dir, 'scene.f32')).buffer.slice(0));
const scene = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
for (let i = 0; i < W * H; i++) fin(sc[i * 3] * g[0], sc[i * 3 + 1] * g[1], sc[i * 3 + 2] * g[2], scene.data, i * 4);
let img;
if (/\.png$/i.test(file)) { const { PNG } = require('pngjs'); const p = PNG.sync.read(fs.readFileSync(file)); img = { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) }; }
else {
  const ppm = execFileSync('djpeg', ['-pnm', file], { maxBuffer: 1 << 30 }), m = ppm.subarray(0, 64).toString('latin1').match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
  const w = +m[1], h = +m[2], off = m[0].length; img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let i = 0, j = off; i < img.data.length; i += 4, j += 3) { img.data[i] = ppm[j]; img.data[i + 1] = ppm[j + 1]; img.data[i + 2] = ppm[j + 2]; img.data[i + 3] = 255; }
}
if (img.width !== W || img.height !== H) throw new Error(`size ${img.width}x${img.height} vs scene ${W}x${H}`);
console.log(JSON.stringify({ file: path.basename(file), psnr: +SR.psnr(img, scene, +border).toFixed(3), ssim: +SR.ssim(img, scene, +border).toFixed(4) }));

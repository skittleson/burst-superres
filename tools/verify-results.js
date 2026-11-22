#!/usr/bin/env node
// Verify README.md result tables against docs/results JSONs.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const strip = s => s.replace(/\*/g, '').trim();
const num = s => parseFloat(strip(s));

function getTable(marker) {
  const lines = readme.split('\n');
  const idx = lines.findIndex(l => l.startsWith(marker));
  if (idx < 0) throw new Error('marker not found: ' + marker);
  const out = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l.startsWith('|')) { if (out.length) break; continue; }
    if (/^\|[\s:|-]+\|$/.test(l)) continue;
    if (/^\|\s*Run\s*\|/i.test(l)) continue; // header repeated? no, skip
    const cells = l.replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim());
    if (cells.every(c => /^-+$/.test(c) || /^:?-+:?$/.test(c))) continue;
    out.push(cells);
  }
  return out;
}

let checked = 0, failed = 0;
const ok = n => { checked++; console.log('ok ' + n); };
const fail = (n, field, expected, got) => { failed++; checked++; console.log(`FAIL ${n} ${field} expected ${expected} got ${got}`); };

// Main table
for (const row of getTable('| Run | Ground truth |')) {
  const name = row[0];
  const file = path.join(root, 'docs/results', name + '.json');
  if (!fs.existsSync(file)) { fail(name, 'file', 'exists', 'missing'); continue; }
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  let bad = false;
  const maxAlign = Math.max(...d.registrationErrorPx);
  const alignExp = parseFloat(strip(row[5]).replace(/px/g, ''));
  const alignGot = Math.round(maxAlign * 1000) / 1000;
  if (Math.abs(alignGot - alignExp) > 0.001) {
    console.log(`FAIL ${name} alignment expected ${alignExp.toFixed(3)} px got ${alignGot.toFixed(3)} px`); failed++; bad = true;
  }
  const methods = ['single-lanczos', 'mean', 'median', 'pairwise'];
  for (let i = 0; i < 4; i++) {
    const r = d.results.find(x => x.method === methods[i]);
    const cell = strip(row[6 + i]);
    const [pStr, sStr] = cell.split('/').map(s => s.trim());
    const pExp = parseFloat(pStr), sExp = parseFloat(sStr);
    if (!r) { console.log(`FAIL ${name} ${methods[i]} missing from JSON`); failed++; bad = true; continue; }
    if (Math.abs(r.psnr - pExp) > 0.01) { console.log(`FAIL ${name} ${methods[i]} psnr expected ${pExp.toFixed(2)} got ${r.psnr.toFixed(2)}`); failed++; bad = true; }
    if (Math.abs(r.ssim - sExp) > 0.0001) { console.log(`FAIL ${name} ${methods[i]} ssim expected ${sExp.toFixed(4)} got ${r.ssim.toFixed(4)}`); failed++; bad = true; }
  }
  const gainExp = num(row[10]);
  const mean = d.results.find(x => x.method === 'mean');
  const single = d.results.find(x => x.method === 'single-lanczos');
  const gainGot = mean.psnr - single.psnr;
  if (Math.abs(gainGot - gainExp) > 0.01) {
    console.log(`FAIL ${name} gain expected ${gainExp.toFixed(2)} got ${gainGot.toFixed(2)}`); failed++; bad = true;
  }
  checked++;
  if (!bad) console.log(`ok ${name}`);
}

// Raw table
for (const row of getTable('| Run | Frames | One JPEG 2x |')) {
  const name = row[0].split(' ')[0];
  const file = path.join(root, 'docs/results/raw', name + '.json');
  if (!fs.existsSync(file)) { fail(name, 'file', 'exists', 'missing'); continue; }
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byMethod = {};
  for (const r of d.rows) byMethod[r.method] = r;
  let bad = false;
  const check = (m, idx) => {
    const exp = num(row[idx]);
    const got = byMethod[m] && byMethod[m].psnr;
    if (got === undefined || Math.abs(got - exp) > 0.01) {
      console.log(`FAIL ${name} ${m} expected ${exp.toFixed(2)} got ${got === undefined ? 'missing' : got.toFixed(2)}`); failed++; bad = true;
    }
  };
  check('jpeg single 2x', 2);
  check('jpeg mean', 3);
  check('raw demosaic-then-mean + deblur(auto)', 4);
  check('raw direct (mergeCFA s=0.22)', 5);
  const c5 = byMethod['raw demosaic-then-mean + deblur(auto)'].psnr;
  const c6 = byMethod['raw direct (mergeCFA s=0.22)'].psnr;
  const c4 = byMethod['jpeg mean'].psnr;
  const cell7 = num(row[6]);
  const delta = Math.max(c5, c6) - c4;
  if (Math.abs(delta - cell7) > 0.01) {
    console.log(`FAIL ${name} delta expected ${cell7.toFixed(2)} got ${delta.toFixed(2)}`); failed++; bad = true;
  }
  checked++;
  if (!bad) console.log(`ok ${name}`);
}
console.log(`${checked} checked, ${failed} failed`);
process.exit(failed ? 1 : 0);

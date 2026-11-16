#!/usr/bin/env node
// Rebuilds the app icon from the header's aperture mark: renders the SVG with
// headless Chrome (crisp anti-aliasing) and derives every size the desktop
// app and PWA need. The mark is the same SVG the app header uses, so the icon
// and the UI never drift.
//
//   node tools/make-icons.js [chromePath]
//
// Outputs: icon.png (1024, desktop + web root), src/web/icons/{pwa-192,
// pwa-512,maskable-512,apple-touch-icon}.png.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const CHROME = process.argv[2] || '/usr/bin/google-chrome';
const BG = '#101216';            // the app's darkroom background
const MARK = '#e8a23a';          // --accent, the amber aperture
// The aperture from index.html, on a 24x24 grid.
const APERTURE = '<circle cx="12" cy="12" r="9" fill="none" stroke="' + MARK + '" stroke-width="1.7"/>' +
  '<path d="M12 3v7.2M20.8 8.6l-6.9 2.5M18 19.4l-4.4-6M6 19.4l4.4-6M3.2 8.6l6.9 2.5" ' +
  'fill="none" stroke="' + MARK + '" stroke-width="1.7" stroke-linecap="round"/>';

// Rounded-square tile (normal icons) or full-bleed (maskable). `pad` widens the
// viewBox around the 24-unit mark; bigger pad = smaller mark.
function svg({ size, rounded, pad }) {
  const v = 24 + pad * 2;
  const bg = rounded
    ? `<rect x="${-pad}" y="${-pad}" width="${v}" height="${v}" rx="${v * 0.22}" fill="${BG}"/>`
    : `<rect x="${-pad}" y="${-pad}" width="${v}" height="${v}" fill="${BG}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="${-pad} ${-pad} ${v} ${v}">${bg}${APERTURE}</svg>`;
}

function render(svgStr, outPng, size) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-'));
  const html = path.join(dir, 'i.html');
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>html,body{background:transparent;` +
    `margin:0;overflow:hidden;display:grid;place-items:center;height:${size}px;width:${size}px}</style>${svgStr}`);
  execFileSync(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--default-background-color=00000000',
    `--window-size=${size},${size}`, `--screenshot=${outPng}`, `file://${html}`], { stdio: 'ignore' });
  fs.rmSync(dir, { recursive: true, force: true });
}

for (const [out, size, rounded, pad] of [
  ['icon.png', 1024, true, 3],
  ['src/web/icons/pwa-512.png', 512, true, 3],
  ['src/web/icons/pwa-192.png', 192, true, 3],
  ['src/web/icons/apple-touch-icon.png', 180, true, 3],
  ['src/web/icons/maskable-512.png', 512, false, 6],   // full-bleed, mark in the safe zone
]) render(svg({ size, rounded, pad }), path.join(root, out), size);
console.log('icons rebuilt');

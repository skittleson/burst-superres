#!/usr/bin/env node
// Builds the web version (GitHub Pages) from the desktop frontend:
// src/frontend plus the browser stand-in for the tinyjs bridge (src/web).
//
//   node tools/build-web.js [outDir]     # default dist/web
//
// The app code is copied as is; only index.html gets the web additions.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'dist/web'));
const RELEASES = 'https://github.com/skittleson/burst-superres/releases/latest';

// Each edit must match exactly once, so a changed index.html fails the build
// instead of silently shipping a page without the web parts.
function replaceOnce(text, find, replace) {
  const at = text.indexOf(find);
  if (at < 0 || text.indexOf(find, at + 1) >= 0) throw new Error(`build-web: expected exactly one match for ${JSON.stringify(find)}`);
  return text.slice(0, at) + replace + text.slice(at + find.length);
}

function webIndex(html) {
  html = replaceOnce(html, '<meta charset="utf-8">',
    '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="description" content="Merge a burst of photos of the same scene into one image with twice the width and height. Runs in your browser; photos are never uploaded.">\n' +
    '<link rel="icon" href="icon.png">');
  html = replaceOnce(html, '<link rel="stylesheet" href="style.css">',
    '<link rel="stylesheet" href="style.css">\n<link rel="stylesheet" href="web.css">');
  html = replaceOnce(html, '</h1>',
    `</h1>\n  <a class="get-app" href="${RELEASES}" target="_blank" rel="noopener">Get the desktop app</a>`);
  html = replaceOnce(html, '<span class="muted">Runs offline. Your photos never leave this computer.</span>',
    '<span class="muted">Runs in your browser. Your photos are never uploaded. ' +
    '<a href="#" id="statsToggle" title="Google Analytics counts visits and merges: numbers and settings only, never photos or file names">Usage stats</a></span>');
  html = replaceOnce(html, '<p id="estimate" class="muted small"></p>',
    '<p id="estimate" class="muted small"></p>\n    <p class="web-note">Full-size merges need a few GB of memory: use desktop Chrome, Edge or Firefox. ' +
    `Phones and tablets may run out. The <a href="${RELEASES}" target="_blank" rel="noopener">desktop app</a> does the same merge.</p>`);
  // plain links in the page instead of the desktop's "open in browser" bridge call
  html = html.replace(/<a href="#" data-url="([^"]+)">/g, '<a href="$1" target="_blank" rel="noopener">');
  html = replaceOnce(html, '<script src="sr-core.js"></script>', '<script src="tiny-web.js"></script>\n<script src="sr-core.js"></script>');
  html = replaceOnce(html, '<script src="app.js"></script>', '<script src="app.js"></script>\n<script src="analytics.js"></script>');
  return html;
}

function build() {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const front = path.join(root, 'src/frontend');
  for (const name of fs.readdirSync(front)) {
    if (name === 'index.html') continue;
    fs.copyFileSync(path.join(front, name), path.join(out, name));
  }
  for (const name of fs.readdirSync(path.join(root, 'src/web'))) fs.copyFileSync(path.join(root, 'src/web', name), path.join(out, name));
  fs.copyFileSync(path.join(root, 'icon.png'), path.join(out, 'icon.png'));
  fs.writeFileSync(path.join(out, 'index.html'), webIndex(fs.readFileSync(path.join(front, 'index.html'), 'utf8')));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  return out;
}

if (require.main === module) console.log('web build in ' + build());
module.exports = { build, webIndex };

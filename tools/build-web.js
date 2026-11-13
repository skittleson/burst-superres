#!/usr/bin/env node
// Builds the web version (GitHub Pages) from the desktop frontend:
// src/frontend plus the browser stand-in for the tinyjs bridge (src/web).
//
//   node tools/build-web.js [outDir] [--samples dir]   # default dist/web
//
// --samples copies the JPEGs in dir into samples/ with a samples.json, which
// turns on the "Try a sample burst" button. CI downloads them from the
// sample-photos release, so the photos are not in git.
//
// The app code is copied as is; only index.html gets the web additions.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = args.indexOf('--samples');
const samplesDir = flag >= 0 ? args.splice(flag, 2)[1] : null;
const defaultOut = path.resolve(args[0] || path.join(root, 'dist/web'));
const RELEASES = 'https://github.com/skittleson/burst-superres/releases/latest';

// Each edit must match exactly once, so a changed index.html fails the build
// instead of silently shipping a page without the web parts.
function replaceOnce(text, find, replace) {
  const at = text.indexOf(find);
  if (at < 0 || text.indexOf(find, at + 1) >= 0) throw new Error(`build-web: expected exactly one match for ${JSON.stringify(find)}`);
  return text.slice(0, at) + replace + text.slice(at + find.length);
}

function webIndex(html, withSamples = false) {
  html = replaceOnce(html, '<meta charset="utf-8">',
    '<meta charset="utf-8">\n' +
    '<meta name="description" content="Merge a burst of photos of the same scene into one image with twice the width and height. Runs in your browser; photos are never uploaded.">\n' +
    '<meta name="theme-color" content="#101216">\n' +
    '<link rel="manifest" href="manifest.webmanifest">\n' +
    '<link rel="icon" href="icon.png">\n' +
    '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">');
  html = replaceOnce(html, '<link rel="stylesheet" href="style.css">',
    '<link rel="stylesheet" href="style.css">\n<link rel="stylesheet" href="web.css">');
  html = replaceOnce(html, '</h1>',
    `</h1>\n  <a class="get-app" href="${RELEASES}" target="_blank" rel="noopener">Get the desktop app</a>`);
  html = replaceOnce(html, '<span class="muted">Runs offline. Your photos never leave this computer.</span>',
    '<span class="muted">Runs in your browser. Your photos are never uploaded. ' +
    '<a href="#" id="statsToggle" title="Google Analytics counts visits and merges: numbers and settings only, never photos or file names">Usage stats</a></span>');
  html = replaceOnce(html, '<button id="pickFolder">Choose folder…</button>\n      </div>',
    '<button id="pickFolder">Choose folder…</button>\n      </div>\n      <button id="sample" class="sample" hidden></button>');
  html = replaceOnce(html, '<p id="estimate" class="muted small"></p>',
    '<p id="estimate" class="muted small"></p>\n    <p class="web-note">Full-size merges need a few GB of memory: use desktop Chrome, Edge or Firefox. ' +
    `Phones and tablets may run out. The <a href="${RELEASES}" target="_blank" rel="noopener">desktop app</a> does the same merge.</p>`);
  // plain links in the page instead of the desktop's "open in browser" bridge call
  html = html.replace(/<a href="#" data-url="([^"]+)">/g, '<a href="$1" target="_blank" rel="noopener">');
  html = replaceOnce(html, '<script src="sr-core.js"></script>', '<script src="tiny-web.js"></script>\n<script src="sr-core.js"></script>');
  if (withSamples) html = replaceOnce(html, '<meta name="theme-color" content="#101216">',
    '<meta name="theme-color" content="#101216">\n<meta name="burst-samples" content="1">');
  html = replaceOnce(html, '<script src="app.js"></script>',
    '<script src="app.js"></script>\n<script src="samples.js"></script>\n<script src="analytics.js"></script>\n<script src="pwa.js"></script>');
  return html;
}

const SAMPLE_NOTE = 'Sample: 8 shots of a canyon, Sony A6000, 20 mm, f/11, ISO 100, camera braced. Click Merge.';

// Stamps the service worker with the build id and the list of shell files to
// precache, so an installed app can open offline. samples/ is intentionally
// not precached: the "Try a sample burst" button fetches it and the worker
// caches it on first use.
function stampServiceWorker(out) {
  const sw = path.join(out, 'sw.js');
  let text = fs.readFileSync(sw, 'utf8');
  const shell = fs.readdirSync(out)
    .filter((n) => !n.startsWith('.') && n !== 'sw.js' && n !== 'samples' && fs.statSync(path.join(out, n)).isFile())
    .map((n) => JSON.stringify('./' + n));
  text = text.replace("'__BUILD__'", JSON.stringify(process.env.GITHUB_SHA || require('crypto')
    .createHash('sha1').update(shell.join('|')).digest('hex').slice(0, 12)));
  text = text.replace(/\/\*__SHELL__\*\/\s*\[[\s\S]*?\]\s*\/\*__SHELL__\*\//, () => '/*__SHELL__*/[' + shell.join(', ') + ']/*__SHELL__*/');
  if (text.includes('__BUILD__') || (text.match(/__SHELL__/g) || []).length !== 2) throw new Error('build-web: could not stamp sw.js');
  fs.writeFileSync(sw, text);
}

function addSamples(dir, out) {
  const files = fs.readdirSync(dir).filter((n) => /\.jpe?g$/i.test(n)).sort();
  if (!files.length) throw new Error('build-web: no JPEGs in ' + dir);
  fs.mkdirSync(path.join(out, 'samples'));
  for (const n of files) fs.copyFileSync(path.join(dir, n), path.join(out, 'samples', n));
  fs.writeFileSync(path.join(out, 'samples/samples.json'), JSON.stringify({
    title: 'Real photos from the README example, downloaded into this tab',
    note: SAMPLE_NOTE,
    files: files.map((n) => ({ name: n, size: fs.statSync(path.join(dir, n)).size })),
  }, null, 1));
}

function build(out = defaultOut, samples = samplesDir) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const front = path.join(root, 'src/frontend');
  for (const name of fs.readdirSync(front)) {
    if (name === 'index.html') continue;
    fs.copyFileSync(path.join(front, name), path.join(out, name));
  }
  for (const name of fs.readdirSync(path.join(root, 'src/web'))) {
    const from = path.join(root, 'src/web', name);
    if (fs.statSync(from).isDirectory()) fs.cpSync(from, path.join(out, name), { recursive: true });
    else fs.copyFileSync(from, path.join(out, name));
  }
  fs.copyFileSync(path.join(root, 'icon.png'), path.join(out, 'icon.png'));
  fs.writeFileSync(path.join(out, 'index.html'), webIndex(fs.readFileSync(path.join(front, 'index.html'), 'utf8'), !!samples));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  if (samples) addSamples(samples, out);
  stampServiceWorker(out);
  return out;
}

if (require.main === module) console.log('web build in ' + build());
module.exports = { build, webIndex };

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build, webIndex } = require('../tools/build-web.js');

test('web build: the desktop page plus the web parts', () => {
  const html = webIndex(fs.readFileSync(path.join(__dirname, '../src/frontend/index.html'), 'utf8'));
  assert.ok(html.indexOf('<script src="tiny-web.js">') < html.indexOf('<script src="app.js">'), 'bridge stand-in loads before the app');
  assert.match(html, /web\.css/);
  assert.ok(html.indexOf('<script src="analytics.js">') > html.indexOf('<script src="app.js">'), 'analytics loads after the app');
  assert.match(html, /Get the desktop app/);
  assert.match(html, /Your photos are never uploaded/);
  assert.doesNotMatch(html, /never leave this computer/);
  assert.doesNotMatch(html, /data-url=/);
  assert.match(html, /<link rel="manifest" href="manifest.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon"/);
});

test('web build: writes every file the page loads', () => {
  const dir = build(fs.mkdtempSync(path.join(os.tmpdir(), 'burst-web-')));
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 8);
  for (const ref of refs) assert.ok(fs.existsSync(path.join(dir, ref)), `missing ${ref}`);
  assert.ok(fs.existsSync(path.join(dir, '.nojekyll')));

  // PWA parts: a valid manifest, the icons it lists, a stamped service worker.
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.webmanifest'), 'utf8'));
  assert.ok(manifest.name && manifest.start_url === './' && manifest.icons.length >= 3);
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(dir, icon.src)), `missing icon ${icon.src}`);
  const sw = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8');
  const shellMatch = sw.match(/\/\*__SHELL__\*\/(\[[^\]]*\])\/\*__SHELL__\*\//);
  assert.ok(shellMatch, 'sw.js carries the shell list');
  const shell = JSON.parse(shellMatch[1]);
  for (const f of ['./index.html', './app.js', './sr-core.js', './style.css', './manifest.webmanifest']) {
    assert.ok(shell.includes(f), `sw.js precaches ${f}`);
  }
  assert.ok(!shell.some((f) => f.startsWith('./samples/')), 'the sample burst is not precached');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('web build: fails loudly when index.html no longer matches', () => {
  assert.throws(() => webIndex('<html></html>'), /expected exactly one match/);
});

test('web build: --samples adds the photos and the list the button reads', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-samples-'));
  fs.writeFileSync(path.join(src, 'b.JPG'), 'xx');
  fs.writeFileSync(path.join(src, 'a.jpg'), 'xxxx');
  fs.writeFileSync(path.join(src, 'notes.txt'), 'skip');
  const dir = build(fs.mkdtempSync(path.join(os.tmpdir(), 'burst-web-')), src);
  const list = JSON.parse(fs.readFileSync(path.join(dir, 'samples/samples.json'), 'utf8'));
  assert.deepStrictEqual(list.files, [{ name: 'a.jpg', size: 4 }, { name: 'b.JPG', size: 2 }]);
  assert.ok(fs.existsSync(path.join(dir, 'samples/b.JPG')));
  assert.ok(!fs.existsSync(path.join(dir, 'samples/notes.txt')));
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /<button id="sample" class="sample" hidden>/);
  for (const d of [src, dir]) fs.rmSync(d, { recursive: true, force: true });
});

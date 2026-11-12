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
  assert.match(html, /Get the desktop app/);
  assert.match(html, /Your photos are never uploaded/);
  assert.doesNotMatch(html, /never leave this computer/);
  assert.doesNotMatch(html, /data-url=/);
});

test('web build: writes every file the page loads', () => {
  const dir = build(fs.mkdtempSync(path.join(os.tmpdir(), 'burst-web-')));
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 8);
  for (const ref of refs) assert.ok(fs.existsSync(path.join(dir, ref)), `missing ${ref}`);
  assert.ok(fs.existsSync(path.join(dir, '.nojekyll')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('web build: fails loudly when index.html no longer matches', () => {
  assert.throws(() => webIndex('<html></html>'), /expected exactly one match/);
});

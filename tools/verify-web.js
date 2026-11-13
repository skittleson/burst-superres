#!/usr/bin/env node
// Verification harness (dev only): serves dist/web, drives headless Chrome.
// Checks: no console errors, service worker registers, manifest parses, the
// merge pipeline works end to end through the real web UI (real canyon photos
// uploaded through the file picker), and screenshots at desktop + phone sizes.
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('/home/spencerkittleson/.nvm/versions/node/v25.5.0/lib/node_modules/lighthouse/node_modules/puppeteer-core');

const ROOT = path.join(__dirname, '..', 'dist', 'web');
const PHOTOS = fs.readdirSync('/home/spencerkittleson/Downloads/burst-canyon')
  .filter((n) => /\.jpe?g$/i.test(n)).sort().slice(0, 4)
  .map((n) => path.join('/home/spencerkittleson/Downloads/burst-canyon', n));
const SHOT = (n) => path.join('/tmp/opencode', n);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (e, d) => (e ? (res.writeHead(404), res.end()) : (res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }), res.end(d))));
});

const log = (...a) => console.log(...a);

(async () => {
  await new Promise((ok) => server.listen(8917, '127.0.0.1', ok));
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files'],
  });
  const problems = [];
  const IGNORE = /analytics\.google\.com|googletagmanager|google-analytics|samples\/samples\.json|ERR_INTERNET_DISCONNECTED/;

  // ---- pass 1: visual + PWA checks ----
  let page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text() + ' ' + (m.location().url || ''))) problems.push('console: ' + m.text() + ' @ ' + (m.location().url || '')); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.status() === 404 && !IGNORE.test(r.url())) problems.push('404: ' + r.url()); });

  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:8917/', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: SHOT('shot-desktop-empty.png') });

  const manifest = await (await page.evaluate(() => fetch('manifest.webmanifest').then((r) => r.json())));
  log('manifest:', manifest.name, '| icons:', manifest.icons.length, '| display:', manifest.display);

  await page.waitForFunction(() => navigator.serviceWorker.ready, { timeout: 15000 });
  const reg = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    return { scope: r.scope, caches: keys };
  });
  log('service worker:', reg.scope, '| caches:', reg.caches.join(', '));

  // offline check: reload with the network down, page must still render
  await page.evaluate(() => window.__sw = true);
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'networkidle0' }).catch(() => {});
  const offlineOk = await page.evaluate(() => !!document.getElementById('drop'));
  log('offline reload renders:', offlineOk);
  await page.screenshot({ path: SHOT('shot-offline.png') });
  await page.setOfflineMode(false);

  // merge through the file picker (real 24 MP canyon photos)
  await page.reload({ waitUntil: 'networkidle0' });
  page.on('requestfailed', (r) => { if (!IGNORE.test(r.url())) problems.push('request failed: ' + r.url()); });
  const fc1 = page.waitForFileChooser();
  await page.click('#pick');
  (await fc1).accept(PHOTOS);
  try {
    await page.waitForFunction((n) => document.querySelectorAll('#list li').length === n, { timeout: 60000 }, PHOTOS.length);
  } catch (e) {
    console.log('status after add timeout:', await page.$eval('#status', (el) => el.textContent));
    console.log('dump:', await page.evaluate(() => ({
      photos: typeof state === 'undefined' ? 'no state' : state.photos.length,
      busy: typeof state !== 'undefined' && state.busy,
      adding: typeof state !== 'undefined' && !!state.adding,
      liCount: document.querySelectorAll('#list li').length,
    })).catch((e) => 'eval error: ' + e.message));
    throw e;
  }
  await page.screenshot({ path: SHOT('shot-desktop-list.png') });
  const estimate = await page.$eval('#estimate', (e) => e.textContent);
  const hints = await page.evaluate(() => [document.getElementById('modeHint').textContent, document.getElementById('sharpenHint').textContent]);
  log('estimate:', estimate);
  log('hints:', JSON.stringify(hints));

  const t0 = Date.now();
  await page.click('#merge');
  await page.waitForFunction(() => !document.getElementById('view').hidden, { timeout: 300000 });
  log(`merge done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.waitForFunction(() => /Saved|never uploaded|photos/i.test(document.getElementById('status').textContent) ||
    document.getElementById('before').width > 0, { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));
  const resultInfo = await page.evaluate(() => ({
    dims: document.getElementById('dims').textContent,
    exif: document.getElementById('exifLine').hidden ? null : document.getElementById('exifLine').textContent,
    summary: document.getElementById('summary').textContent,
    diff: document.getElementById('diff').textContent,
    beforePainted: (() => { const c = document.getElementById('before'); const g = c.getContext('2d');
      const d = g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data; return d[0] + d[1] + d[2] > 0; })(),
  }));
  log('result dims:', resultInfo.dims);
  log('exif line:', resultInfo.exif);
  log('summary:', resultInfo.summary);
  log('diff:', resultInfo.diff);
  log('before pane painted:', resultInfo.beforePainted);
  await page.screenshot({ path: SHOT('shot-desktop-result.png') });

  // ---- pass 2: phone viewport ----
  const phone = await browser.newPage();
  phone.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text() + ' ' + (m.location().url || ''))) problems.push('phone console: ' + m.text() + ' @ ' + (m.location().url || '')); });
  phone.on('pageerror', (e) => problems.push('phone pageerror: ' + e.message));
  await phone.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await phone.goto('http://127.0.0.1:8917/', { waitUntil: 'networkidle0' });
  await phone.screenshot({ path: SHOT('shot-phone-empty.png'), fullPage: true });
  const fc2 = phone.waitForFileChooser();
  await phone.click('#pick');
  (await fc2).accept(PHOTOS.slice(0, 2));
  await phone.waitForFunction(() => !document.getElementById('merge').disabled, { timeout: 60000 });
  await phone.screenshot({ path: SHOT('shot-phone-list.png'), fullPage: true });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  log('phone horizontal overflow:', overflow);
  const tapTarget = await phone.evaluate(() => {
    const b = document.getElementById('merge').getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height) };
  });
  log('merge button on phone:', JSON.stringify(tapTarget));

  await browser.close();
  server.close();
  if (problems.length) { console.error('\nPROBLEMS:\n' + problems.join('\n')); process.exit(1); }
  console.log('\nall checks passed');
})().catch((e) => { console.error('HARNESS FAIL:', e); process.exit(1); });

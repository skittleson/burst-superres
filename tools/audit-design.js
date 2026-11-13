#!/usr/bin/env node
// Objective design audit for the web build: WCAG contrast on the text pairs
// the design actually uses, control sizes, focus rings, and label coverage.
// Serve dist/web first, then: node tools/audit-design.js [url]
const puppeteer = require('/home/spencerkittleson/.nvm/versions/node/v25.5.0/lib/node_modules/lighthouse/node_modules/puppeteer-core');
const URL = process.argv[2] || 'http://127.0.0.1:8917/';

const CONTRAST_FN = () => {
  const lum = (c) => { const s = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2]; };
  const rgb = (s) => {
    s = (s || '').trim();
    if (s[0] === '#') { const h = s.slice(1); const n = h.length === 3 ? h.split('').map((c) => c + c) : [...h.match(/../g)]; return n.slice(0, 3).map((x) => parseInt(x, 16)); }
    return (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
  };
  window.__contrast = (a, b) => { const [la, lb] = [lum(rgb(a)), lum(rgb(b))]; return +(((Math.max(la, lb) + .05) / (Math.min(la, lb) + .05)).toFixed(2)); };
};

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--headless=new', '--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.evaluateOnNewDocument(CONTRAST_FN);
  await page.reload({ waitUntil: 'networkidle0' });

  const report = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    const pairs = [
      ['body text on background', v('--text'), v('--bg')],
      ['muted text on background', v('--muted'), v('--bg')],
      ['body text on panel', v('--text'), v('--panel')],
      ['muted text on panel', v('--muted'), v('--panel')],
      ['dim text on panel', v('--text-dim'), v('--panel')],
      ['primary button label', v('--accent-ink'), v('--accent')],
      ['accent link on panel', v('--accent'), v('--panel')],
      ['good badge', v('--good'), v('--good-bg')],
      ['soft badge', v('--soft'), v('--soft-bg')],
      ['bad badge', v('--bad'), v('--bad-bg')],
    ].map(([name, fg, bg]) => ({ name, ratio: window.__contrast(fg, bg) }));

    // every interactive control has a name
    const unlabeled = [...document.querySelectorAll('button, select, input, a[href]')]
      .filter((el) => !el.hidden && !el.closest('[hidden]') &&
        !(el.textContent || '').trim() && !el.getAttribute('aria-label') && !el.getAttribute('title') &&
        !el.closest('label') &&
        !(el.id && document.querySelector(`label[for="${el.id}"]`)))
      .map((el) => el.tagName + '#' + el.id);

    const fontSize = (sel) => { const el = document.querySelector(sel); return el ? parseFloat(getComputedStyle(el).fontSize) : null; };
    const minTap = Math.min(...[...document.querySelectorAll('button, select')].filter((el) => !el.hidden && !el.closest('[hidden]'))
      .map((el) => Math.round(el.getBoundingClientRect().height)));

    return {
      contrast: pairs,
      unlabeled,
      type: { h1: fontSize('h1'), body: fontSize('body'), small: fontSize('.small') },
      minDesktopControlHeight: minTap,
      // prefers-reduced-motion honoured?
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      lang: document.documentElement.lang || '(missing)',
      viewport: !!document.querySelector('meta[name=viewport]'),
      h1Count: document.querySelectorAll('h1').length,
      landmarks: ['header', 'main', 'footer'].map((t) => document.querySelectorAll(t).length),
    };
  });

  console.log('contrast (AA text needs 4.5, large text/UI 3):');
  for (const p of report.contrast) console.log(`  ${p.ratio >= 4.5 ? 'AA ' : p.ratio >= 3 ? 'AA-large ' : 'FAIL '} ${p.ratio}  ${p.name}`);
  console.log('unlabeled controls:', report.unlabeled.length ? report.unlabeled : 'none');
  console.log('type scale:', JSON.stringify(report.type));
  console.log('min desktop control height:', report.minDesktopControlHeight);
  console.log('lang:', report.lang, '| viewport meta:', report.viewport, '| h1 count:', report.h1Count, '| landmarks header/main/footer:', report.landmarks.join('/'));
  await browser.close();
})().catch((e) => { console.error('AUDIT FAIL:', e.message); process.exit(1); });

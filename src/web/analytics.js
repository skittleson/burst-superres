// Usage stats for the web version only (tools/build-web.js adds this file;
// the desktop app never loads it). Sends counts and settings: photo count,
// size, JPEG or RAW, method, time, alignment verdicts, saves. Never file
// names, EXIF or pixels. In European time zones it asks first.
(() => {
  const ID = 'G-3TW4YP50BZ';
  const KEY = 'analytics-consent';
  const EUROPE = /^(Europe\/|Atlantic\/(Reykjavik|Canary|Madeira|Azores|Faroe))/;
  let on = false;

  const choice = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const remember = (v) => { try { localStorage.setItem(KEY, v); } catch { /* not persisted */ } };

  function load() {
    if (on) return;
    on = true;
    const t = document.getElementById('statsToggle');
    if (t) t.textContent = 'Usage stats: on';
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', ID, { linker: { domains: ['docodethatmatters.com', 'dctmlab.taila665d5.ts.net'] } });
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ID);
    document.head.append(s);
  }
  const send = (name, params) => { if (on) window.gtag('event', name, params); };

  function ask() {
    const bar = document.createElement('div');
    bar.className = 'consent';
    bar.innerHTML = '<span>Count visits and merges with Google Analytics? Only numbers and settings are sent, never your photos or file names.</span>' +
      '<button data-a="yes">Allow</button><button data-a="no">No thanks</button>';
    bar.addEventListener('click', (e) => {
      const a = e.target.closest('button[data-a]');
      if (!a) return;
      remember(a.dataset.a);
      bar.remove();
      if (a.dataset.a === 'yes') load();
    });
    document.body.append(bar);
  }

  const c = choice();
  let zone = '';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* unknown */ }
  if (c === 'yes' || (!c && !EUROPE.test(zone))) load();
  else if (!c) ask();

  // footer switch: anyone can turn the stats off (or back on)
  const toggle = document.getElementById('statsToggle');
  if (toggle) {
    toggle.textContent = on ? 'Usage stats: on' : 'Usage stats: off';
    toggle.addEventListener('click', (e) => { e.preventDefault(); remember(on ? 'no' : 'yes'); location.reload(); });
  }

  // ---------- events (reads the app's top-level state; app.js is unchanged) ----------
  /* global state */
  const photoInfo = () => {
    const p = state.photos;
    return {
      photo_count: p.length,
      megapixels: p.length ? Math.round(p[0].width * p[0].height / 1e5) / 10 : 0,
      input_type: p.length && p[0].raw ? 'raw' : 'jpeg_png',
    };
  };
  let started = 0;
  const startMerge = () => {
    if (state.busy || state.photos.length < 2) return;
    started = performance.now();
    send('merge_start', { ...photoInfo(), realign: !state.aligned });
  };
  document.getElementById('merge').addEventListener('click', startMerge, true);
  document.getElementById('remerge').addEventListener('click', startMerge, true);

  // fixed reason codes, so no file name or other text from the page is sent
  const REASONS = [[/same size/, 'mixed_sizes'], [/RAW files or JPEG/, 'mixed_types'], [/MP are supported/, 'too_large'],
    [/lined up closely/, 'no_alignment'], [/Cancelled/, 'cancelled'], [/Could not read/, 'read_error'], [/Worker error/, 'worker_error']];
  window.addEventListener('merge-end', (e) => {
    const seconds = started ? Math.round((performance.now() - started) / 100) / 10 : 0;
    if (!e.detail.ok) {
      const r = REASONS.find(([re]) => re.test(e.detail.message || ''));
      send('merge_failed', { ...photoInfo(), reason: r ? r[1] : 'other', seconds });
      return;
    }
    const verdicts = { good: 0, soft: 0, bad: 0 };
    state.photos.forEach((p, i) => { if (p.detail && i !== state.aligned.refIndex) verdicts[p.detail.verdict]++; });
    send('merge_done', {
      ...photoInfo(),
      photos_used: state.results ? state.results.count : 0,
      method: document.getElementById('mode').value,
      sharpen: document.getElementById('sharpen').value,
      handheld: state.photos.some((p) => p.detail && p.detail.mode === 'local'),
      good: verdicts.good, soft: verdicts.soft, too_far_off: verdicts.bad,
      seconds,
    });
  });

  document.getElementById('saveJpg').addEventListener('click', () => send('save_image', { format: 'jpeg', ...photoInfo() }), true);
  document.getElementById('savePng').addEventListener('click', () => send('save_image', { format: 'png', ...photoInfo() }), true);
  document.getElementById('pick').addEventListener('click', () => send('add_photos', { via: 'files' }), true);
  document.getElementById('pickFolder').addEventListener('click', () => send('add_photos', { via: 'folder' }), true);
  document.addEventListener('drop', () => send('add_photos', { via: 'drop' }), true);
})();

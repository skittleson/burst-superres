/* camera.js: shoot a burst with the phone camera in the PWA (web version
 * only; tools/build-web.js loads it after app.js). The core is a pure
 * sequencer over injectable deps so it runs under node:test with a mocked
 * camera; the DOM overlay below only exists in a browser that supports
 * ImageCapture and reports a coarse pointer (a phone or tablet).
 */
function createCameraBurst(deps = {}) {
  const media = deps.media || globalThis.navigator?.mediaDevices;
  const ImageCaptureCtor = deps.ImageCaptureCtor || globalThis.ImageCapture;
  const delay = deps.delay || ((ms) => new Promise((ok) => setTimeout(ok, ms)));

  const timeout = deps.timeout || ((ms = 4000) => new Promise((ok) => setTimeout(ok, ms)));
  let stream = null, capture = null, aborted = false;

  async function open() {
    // Some Android builds hang or reject facingMode; retry without it after
    // a short timeout, and stop the late stream's tracks so no camera stays
    // open if the hung request ever resolves.
    const env = media.getUserMedia({ video: { facingMode: 'environment' } });
    try {
      stream = await Promise.race([env, timeout().then(() => { throw new Error('timeout'); })]);
    } catch {
      env.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
      stream = await media.getUserMedia({ video: true });
    }
    capture = new ImageCaptureCtor(stream.getVideoTracks()[0]);
    return stream;
  }

  // Freeze exposure at what the preview settled on, so 6 frames share one
  // exposure. Platforms without manual exposure (iOS Safari) just keep
  // continuous auto-exposure: brightness matching in the merge evens it.
  // Each lock is its own try: a platform that supports focus but not manual
  // exposure (or neither) still keeps whatever it can. Continuous auto keeps
  // the rest, and brightness matching in the merge evens any flicker.
  async function lockExposure() {
    const track = stream.getVideoTracks()[0];
    const s = track.getSettings();
    try {
      await track.applyConstraints({
        advanced: [{ exposureMode: 'manual', exposureTime: s.exposureTime, iso: s.iso }],
      });
    } catch { /* no manual exposure here */ }
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'manual' }] });
    } catch { /* no manual focus here */ }
  }

  async function shootBurst({ count, onShot }) {
    const total = Math.max(4, Math.min(8, count));
    aborted = false;
    const files = [];
    let failed = 0;
    for (let i = 1; i <= total; i++) {
      if (aborted) { close(); const e = new Error('Cancelled'); e.name = 'AbortError'; throw e; }
      try {
        const blob = await capture.takePhoto();
        files.push(new File([blob], `burst-${i}.jpg`, { type: 'image/jpeg' }));
        onShot(i, total);
      } catch { failed++; }
      await delay(150);
    }
    // Cancel may land during the last shot or its pause: honour it.
    if (aborted) { close(); const e = new Error('Cancelled'); e.name = 'AbortError'; throw e; }
    if (files.length < 2) {
      close();
      const e = new Error('Too few shots came out');
      e.min = true; e.shots = files.length; e.failed = failed;
      throw e;
    }
    return { files, shots: files.length, failed };
  }

  function abort() { aborted = true; }

  function close() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; capture = null; }
  }

  return { open, close, shootBurst, lockExposure, abort };
}
// 4..8 integers pass; anything else (99, 2, 5.5, junk) falls back to 6.
createCameraBurst.sanitizeCount = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 4 && n <= 8 ? n : 6;
};
if (typeof module === 'object' && module.exports) module.exports = createCameraBurst;

// ---------- browser overlay ----------
// Phones only: needs ImageCapture and a coarse pointer, and the app's
// pipeline globals (addPaths, runMerge, setStatus, tiny), which only exist
// once app.js has run. Desktop never gets past this guard.
if (typeof module === 'undefined' && globalThis.ImageCapture &&
    matchMedia('(pointer: coarse)').matches && typeof addPaths === 'function') {
  (() => {
    const readCount = () => {
      let v = null;
      try { v = localStorage.getItem('burstCount'); } catch { /* not persisted */ }
      return createCameraBurst.sanitizeCount(v ?? 6);
    };
    let cam = null, burstCount = readCount(), cancelRequested = false, shortfall = 0;

    const overlay = document.createElement('div');
    overlay.id = 'camOverlay';
    overlay.hidden = true;
    overlay.innerHTML =
      '<video id="camVideo" autoplay playsinline muted></video>' +
      '<p id="camStatus" aria-live="polite"></p>' +
      '<div id="camCounts"></div>' +
      '<div class="cam-actions"><button id="camCancel">Cancel</button>' +
      '<button id="camShutter" aria-label="Shoot burst"></button></div>';
    document.body.append(overlay);
    const $ = (id) => document.getElementById(id);

    function renderCounts() {
      $('camCounts').innerHTML = [4, 5, 6, 7, 8].map((n) =>
        `<button class="cam-count${n === burstCount ? ' on' : ''}" data-n="${n}">${n}</button>`).join('');
    }
    const setStatus = (t) => { $('camStatus').textContent = t; };

    // Entry points: a button in the drop zone, and the Night guide's.
    const openBtn = document.createElement('button');
    openBtn.id = 'camOpen';
    openBtn.textContent = 'Shoot a burst with the camera';
    document.getElementById('drop')?.append(openBtn);

    async function start() {
      if (cam || state.busy) return;   // no double permission prompt, no opening mid-merge
      try {
        cam = createCameraBurst();
        const stream = await cam.open();
        $('camVideo').srcObject = stream;
        renderCounts();
        setStatus('Hold steady. Pick the frame count, then tap the shutter.');
        overlay.hidden = false;
      } catch (e) {
        if (cam) { cam.close(); cam = null; }
        const denied = e && (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError');
        window.dispatchEvent(new CustomEvent('camera-end', { detail: { ok: false, code: denied ? 'denied' : 'unsupported', shots: 0, failed: 0, ms: 0 } }));
        window.setStatus(denied ? 'Camera blocked — allow camera access and try again.' : 'Could not use the camera on this device.', true);
      }
    }

    async function shoot() {
      const c = cam;   // the local handle: Cancel clears the shared one
      $('camShutter').disabled = true;
      const t0 = performance.now();
      cancelRequested = false;
      window.dispatchEvent(new CustomEvent('camera-shoot', { detail: { count: burstCount } }));
      try {
        await c.lockExposure();
        for (let n = 3; n >= 1 && !cancelRequested; n--) { setStatus(n + '…'); await new Promise((ok) => setTimeout(ok, 500)); }
        if (cancelRequested) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        const r = await c.shootBurst({ count: burstCount, onShot: (i, total) => setStatus(`Shot ${i} of ${total}`) });
        c.close();
        overlay.hidden = true;
        window.dispatchEvent(new CustomEvent('camera-end', { detail: { ok: true, code: 'ok', shots: r.shots, failed: r.failed, ms: Math.round(performance.now() - t0) } }));
        $('mode').value = 'mean'; updateHints();
        shortfall = r.failed;
        state.photos = [];   // a fresh burst merges alone, never on top of old photos
        await addPaths(tiny.addFiles(r.files));
        $('merge').click();   // the real button, so merge timing and analytics match a user merge
      } catch (e) {
        const cancelled = e && e.name === 'AbortError';   // the Cancel button owns that event
        c.close();
        overlay.hidden = true;
        if (!cancelled) {
          const shots = e && e.shots != null ? e.shots : 0;
          window.dispatchEvent(new CustomEvent('camera-end', { detail: { ok: false, code: 'shot_error', shots, failed: burstCount - shots, ms: Math.round(performance.now() - t0) } }));
          window.setStatus(shots === 1 ? 'Only one shot came out. Try again, holding steadier.' : 'No shots came out. Try again, holding steadier.', true);
        }
      } finally {
        if (cam === c) cam = null;
        $('camShutter').disabled = false;
      }
    }

    // A shortfall during the burst is erased by the merge status within
    // milliseconds, so say it on the merge's own line, where it stays.
    window.addEventListener('merge-end', () => {
      if (!shortfall) return;
      $('summary').textContent += ` (only ${burstCount - shortfall} of ${burstCount} shots came out)`;
      shortfall = 0;
    });

    overlay.addEventListener('click', (e) => {
      const c = e.target.closest('[data-n]');
      if (c) {
        burstCount = +c.dataset.n;
        try { localStorage.setItem('burstCount', burstCount); } catch { /* not persisted */ }
        renderCounts(); return;
      }
      if (e.target === $('camShutter')) shoot();
      else if (e.target === $('camCancel')) {
        cancelRequested = true;
        if (cam) { cam.abort(); cam.close(); cam = null; }
        overlay.hidden = true;
        window.dispatchEvent(new CustomEvent('camera-end', { detail: { ok: false, code: 'cancelled', shots: 0, failed: 0, ms: 0 } }));
      }
    });
    // leaving the page with the overlay open must release the camera
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden || !cam) return;
      cam.abort(); cam.close(); cam = null;
      overlay.hidden = true;
    });
    openBtn.addEventListener('click', start);
    document.addEventListener('click', (e) => { if (e.target.closest('.scene-shoot')) start(); });
    document.body.classList.add('has-camera');   // CSS reveals .scene-shoot only with this
  })();
}

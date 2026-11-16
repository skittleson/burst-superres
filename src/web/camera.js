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

  let stream = null, capture = null, aborted = false;

  async function open() {
    // Some Android builds hang or reject facingMode; retry without it.
    try {
      stream = await media.getUserMedia({ video: { facingMode: 'environment' } });
    } catch {
      stream = await media.getUserMedia({ video: true });
    }
    capture = new ImageCaptureCtor(stream.getVideoTracks()[0]);
    return stream;
  }

  // Freeze exposure at what the preview settled on, so 6 frames share one
  // exposure. Platforms without manual exposure (iOS Safari) just keep
  // continuous auto-exposure: brightness matching in the merge evens it.
  async function lockExposure() {
    try {
      const s = stream.getVideoTracks()[0].getSettings();
      await stream.getVideoTracks()[0].applyConstraints({
        advanced: [{ exposureMode: 'manual', exposureTime: s.exposureTime, iso: s.iso }],
      });
    } catch { /* no manual control here: shoot as-is */ }
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
    if (files.length < 2) { close(); const e = new Error('Too few shots came out'); e.min = true; throw e; }
    return { files, shots: files.length, failed };
  }

  function abort() { aborted = true; }

  function close() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; capture = null; }
  }

  return { open, close, shootBurst, lockExposure, abort };
}
if (typeof module === 'object' && module.exports) module.exports = createCameraBurst;

// ---------- browser overlay ----------
// Phones only: needs ImageCapture and a coarse pointer, and the app's
// pipeline globals (addPaths, runMerge, setStatus, tiny), which only exist
// once app.js has run. Desktop never gets past this guard.
if (typeof module === 'undefined' && globalThis.ImageCapture &&
    matchMedia('(pointer: coarse)').matches && typeof addPaths === 'function') {
  (() => {
    const COUNT_KEY = '***';
    const count0 = Math.max(4, Math.min(8, +(localStorage.getItem(COUNT_KEY) || 6) || 6));
    let cam = null, burstCount = count0, cancelRequested = false;

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
      cam = createCameraBurst();
      try {
        const stream = await cam.open();
        $('camVideo').srcObject = stream;
        renderCounts();
        setStatus('Hold steady. Pick the frame count, then tap the shutter.');
        overlay.hidden = false;
      } catch (e) {
        cam.close(); cam = null;
        window.dispatchEvent(new CustomEvent('camera-end', { detail: { ok: false, code: 'denied', shots: 0, failed: 0, ms: 0 } }));
        window.setStatus(e && e.name === 'NotAllowedError' ? 'Camera blocked — allow camera access and try again.' : 'Could not use the camera on this device.', true);
      }
    }

    async function shoot() {
      $('camShutter').disabled = true;
      const t0 = performance.now();
      cancelRequested = false;
      window.dispatchEvent(new CustomEvent('camera-shoot', { detail: { count: burstCount } }));
      try {
        await cam.lockExposure();
        for (let n = 3; n >= 1 && !cancelRequested; n--) { setStatus(n + '…'); await new Promise((ok) => setTimeout(ok, 500)); }
        if (cancelRequested) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        const r = await cam.shootBurst({ count: burstCount, onShot: (i, total) => setStatus(`Shot ${i} of ${total}`) });
        cam.close(); cam = null;
        overlay.hidden = true;
        window.dispatchEvent(new CustomEvent('camera-end', { detail: { ok: true, code: 'ok', shots: r.shots, failed: r.failed, ms: Math.round(performance.now() - t0) } }));
        if (r.failed) window.setStatus(`Only ${r.shots} of ${burstCount} shots came out.`, true);
        await addPaths(tiny.addFiles(r.files));
        runMerge();
      } catch (e) {
        const cancelled = e && e.name === 'AbortError';   // the Cancel button owns that event
        if (cam) { cam.close(); cam = null; }
        overlay.hidden = true;
        if (!cancelled) {
          window.dispatchEvent(new CustomEvent('camera-end', { detail: { ok: false, code: 'shot_error', shots: 0, failed: burstCount, ms: Math.round(performance.now() - t0) } }));
          window.setStatus('Only ' + (e && e.min ? 'one' : 'no') + ' shot came out. Try again, holding steadier.', true);
        }
      } finally {
        $('camShutter').disabled = false;
      }
    }

    overlay.addEventListener('click', (e) => {
      const c = e.target.closest('[data-n]');
      if (c) { burstCount = +c.dataset.n; try { localStorage.setItem(COUNT_KEY, burstCount); } catch { /* not persisted */ } renderCounts(); return; }
      if (e.target === $('camShutter')) shoot();
      else if (e.target === $('camCancel')) {
        cancelRequested = true;
        if (cam) { cam.abort(); cam.close(); cam = null; }
        overlay.hidden = true;
        window.dispatchEvent(new CustomEvent('camera-end', { detail: { ok: false, code: 'cancelled', shots: 0, failed: 0, ms: 0 } }));
      }
    });
    openBtn.addEventListener('click', start);
    document.addEventListener('click', (e) => { if (e.target.closest('.scene-shoot')) start(); });
    document.body.classList.add('has-camera');   // CSS reveals .scene-shoot only with this
  })();
}

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

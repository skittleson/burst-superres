const test = require('node:test');
const assert = require('node:assert/strict');
const createCameraBurst = require('../src/web/camera.js');

// Fake camera: getUserMedia resolves a stream whose track carries the
// settings applyConstraints records; ImageCaptureCtor replays takePhoto
// results in order (an Error means that shot fails).
function makeDeps(takePhotoResults = []) {
  const calls = { applyConstraints: [], stopped: 0, gum: [] };
  const track = {
    settings: { exposureTime: 30000, iso: 800 },
    getSettings() { return this.settings; },
    applyConstraints(c) { calls.applyConstraints.push(c); },
    stop() { calls.stopped++; },
  };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const media = { getUserMedia: (c) => { calls.gum.push(c); return calls.gumResult(c); } };
  let n = 0;
  const ImageCaptureCtor = function () {
    this.takePhoto = () => {
      const r = takePhotoResults[n++];
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r === undefined ? new Blob(['jpg'], { type: 'image/jpeg' }) : r);
    };
  };
  const deps = {
    media,
    ImageCaptureCtor,
    delay: () => Promise.resolve(),
    calls,
  };
  calls.gumResult = () => Promise.resolve(stream);
  return deps;
}

test('count clamps to 4..8', async () => {
  let taken = 0;
  const deps = makeDeps();
  deps.ImageCaptureCtor = function () { this.takePhoto = () => { taken++; return Promise.resolve(new Blob(['x'])); }; };
  const cam = createCameraBurst(deps);
  await cam.open();
  await cam.shootBurst({ count: 99, onShot: () => {} });
  assert.equal(taken, 8);
  taken = 0;
  await cam.shootBurst({ count: 1, onShot: () => {} });
  assert.equal(taken, 4);
});

test('all shots land as named files', async () => {
  const deps = makeDeps();
  const cam = createCameraBurst(deps);
  await cam.open();
  const ticks = [];
  const r = await cam.shootBurst({ count: 6, onShot: (i, total) => ticks.push([i, total]) });
  assert.equal(r.files.length, 6);
  assert.deepEqual(r.files.map((f) => f.name), ['burst-1.jpg', 'burst-2.jpg', 'burst-3.jpg', 'burst-4.jpg', 'burst-5.jpg', 'burst-6.jpg']);
  assert.deepEqual(r, { files: r.files, shots: 6, failed: 0 });
  assert.deepEqual(ticks, [[1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6]]);
});

test('one failed shot is kept out but the burst survives', async () => {
  const deps = makeDeps([undefined, undefined, new Error('camera busy'), undefined, undefined, undefined]);
  const cam = createCameraBurst(deps);
  await cam.open();
  const r = await cam.shootBurst({ count: 6, onShot: () => {} });
  assert.equal(r.files.length, 5);
  assert.equal(r.failed, 1);
});

test('fewer than 2 frames rejects with min and closes the camera', async () => {
  const deps = makeDeps([undefined, ...Array(5).fill(new Error('gone'))]);
  const cam = createCameraBurst(deps);
  await cam.open();
  await assert.rejects(cam.shootBurst({ count: 6, onShot: () => {} }), (e) => e.min === true);
  assert.equal(deps.calls.stopped, 1);
});

test('abort stops the burst without resolving', async () => {
  let taken = 0;
  const deps = makeDeps();
  deps.ImageCaptureCtor = function () {
    this.takePhoto = () => new Promise((ok) => setTimeout(() => { taken++; ok(new Blob(['x'])); }, 5));
  };
  const cam = createCameraBurst(deps);
  await cam.open();
  const p = cam.shootBurst({ count: 6, onShot: () => {} });
  setTimeout(() => cam.abort(), 12);
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.ok(taken <= 3);
  assert.equal(deps.calls.stopped, 1);
});

test('lockExposure applies manual settings', async () => {
  const deps = makeDeps();
  const cam = createCameraBurst(deps);
  await cam.open();
  await cam.lockExposure();
  assert.deepEqual(deps.calls.applyConstraints[0],
    { advanced: [{ exposureMode: 'manual', exposureTime: 30000, iso: 800 }] });
});

test('lockExposure never rejects when the platform refuses', async () => {
  const deps = makeDeps();
  const bad = {
    getSettings: () => ({ exposureTime: 1, iso: 1 }),
    applyConstraints: () => Promise.reject(new Error('unsupported')),
    stop() {},
  };
  deps.media.getUserMedia = () => Promise.resolve({ getVideoTracks: () => [bad], getTracks: () => [bad] });
  const cam = createCameraBurst(deps);
  await cam.open();
  await cam.lockExposure();  // applyConstraints rejects: still resolves
});

test('environment constraint falls back to a generic request', async () => {
  const deps = makeDeps();
  deps.calls.gumResult = (c) =>
    c.video.facingMode ? Promise.reject(new Error('NotSupportedError')) : Promise.resolve({ getVideoTracks: () => [{ getSettings: () => ({}), applyConstraints() {}, stop() {} }] });
  const cam = createCameraBurst(deps);
  await cam.open();
  assert.equal(deps.calls.gum.length, 2);
  assert.deepEqual(deps.calls.gum[1], { video: true });
});

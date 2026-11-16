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

test('a hanging environment request falls back after a timeout', async () => {
  const deps = makeDeps();
  let stopped = 0;
  const lateTrack = { getSettings: () => ({}), applyConstraints() {}, stop() { stopped++; } };
  let resolveLate;
  deps.calls.gumResult = (c) =>
    c.video.facingMode ? new Promise((ok) => { resolveLate = ok; })
      : Promise.resolve({ getVideoTracks: () => [{ getSettings: () => ({}), applyConstraints() {}, stop() {} }] });
  const cam = createCameraBurst({ ...deps, timeout: () => new Promise((ok) => setTimeout(ok, 20)) });
  await cam.open();
  assert.equal(deps.calls.gum.length, 2);
  resolveLate({ getTracks: () => [lateTrack], getVideoTracks: () => [lateTrack] });
  await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(stopped, 1);   // the late stream's tracks are stopped: no camera left open
});

test('open with a deviceId uses an exact device constraint', async () => {
  const deps = makeDeps();
  const cam = createCameraBurst(deps);
  await cam.open({ deviceId: 'abc' });
  assert.deepEqual(deps.calls.gum[0], { video: { deviceId: { exact: 'abc' } } });
});

test('maxRes sets the largest still size; applyMax(false) restores', async () => {
  const deps = makeDeps();
  const opts = [];
  deps.ImageCaptureCtor = function () {
    this.takePhoto = () => Promise.resolve(new Blob(['x']));
    this.getPhotoSettings = () => Promise.resolve({ imageWidth: 4000, imageHeight: 3000 });
    this.getPhotoCapabilities = () => Promise.resolve({ imageWidth: { max: 8000 }, imageHeight: { max: 6000 } });
    this.setOptions = (o) => { opts.push(o); return Promise.resolve(); };
  };
  const cam = createCameraBurst(deps);
  await cam.open({ maxRes: true });
  assert.deepEqual(opts[0], { imageWidth: 8000, imageHeight: 6000 });
  await cam.applyMax(false);
  assert.deepEqual(opts[1], { imageWidth: 4000, imageHeight: 3000 });
});

test('maxRes failure (no capabilities exposed) does not break open', async () => {
  const deps = makeDeps();
  deps.ImageCaptureCtor = function () {
    this.takePhoto = () => Promise.resolve(new Blob(['x']));
    this.getPhotoSettings = () => Promise.reject(new Error('nope'));
    this.getPhotoCapabilities = () => Promise.reject(new Error('nope'));
  };
  const cam = createCameraBurst(deps);
  await cam.open({ maxRes: true });   // resolves anyway
});

test('listRearCameras keeps video inputs only', () => {
  const cams = createCameraBurst.listRearCameras([
    { kind: 'videoinput', deviceId: '1' }, { kind: 'audioinput', deviceId: '2' }, { kind: 'videoinput', deviceId: '3' },
  ]);
  assert.deepEqual(cams.map((c) => c.deviceId), ['1', '3']);
});

test('capCount allows up to 8 normally, 4 at full resolution', () => {
  assert.equal(createCameraBurst.capCount(6, false), 6);
  assert.equal(createCameraBurst.capCount(8, true), 4);
  assert.equal(createCameraBurst.capCount(4, true), 4);
});

test('sanitizeCount keeps 4..8 integers, 6 otherwise', () => {
  const { sanitizeCount } = createCameraBurst;
  assert.equal(sanitizeCount(4), 4);
  assert.equal(sanitizeCount(8), 8);
  assert.equal(sanitizeCount(99), 6);
  assert.equal(sanitizeCount(2), 6);
  assert.equal(sanitizeCount(5.5), 6);
  assert.equal(sanitizeCount('7'), 7);
  assert.equal(sanitizeCount(null), 6);
  assert.equal(sanitizeCount('abc'), 6);
});

test('cancel after the last shot still reports AbortError', async () => {
  const deps = makeDeps();
  const cam = createCameraBurst(deps);
  await cam.open();
  const p = cam.shootBurst({ count: 4, onShot: () => {} });
  cam.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
});

test('too-few error carries the shot counts', async () => {
  const deps = makeDeps([undefined, ...Array(5).fill(new Error('gone'))]);
  const cam = createCameraBurst(deps);
  await cam.open();
  await assert.rejects(cam.shootBurst({ count: 6, onShot: () => {} }), (e) => e.min === true && e.shots === 1 && e.failed === 5);
});

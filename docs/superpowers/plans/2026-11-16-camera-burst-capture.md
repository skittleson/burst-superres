# Camera burst capture (PWA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On phones, the PWA shoots a 4–8 frame burst with the rear camera (exposure locked where supported) and auto-merges it through the existing pipeline.

**Architecture:** A web-only module `src/web/camera.js` with a pure, injectable sequencer core (unit-testable with a mocked ImageCapture) and a DOM overlay that feeds captured blobs into `tiny.addFiles()` → `addPaths()` → `runMerge()`, exactly how `samples.js` injects sample photos. Desktop never loads camera.js; the Night scene guide carries a "Shoot" button that camera.js un-hides when supported.

**Tech Stack:** Vanilla JS, getUserMedia + ImageCapture, existing zero-dep build (`tools/build-web.js`), node:test.

**Spec:** `docs/superpowers/specs/2026-11-16-camera-burst-capture-design.md`

## Global Constraints

- Zero dependencies; app code copied as-is into the web build — camera.js lives in `src/web/`, loaded only by `tools/build-web.js`.
- No camera permission prompt before the user taps a Shoot button.
- Pixels never leave the tab; analytics sends counts/timings/error codes only.
- Burst count 4–8, default 6, persisted at localStorage key `burstCount`.
- Manual exposure lock via `track.applyConstraints({ advanced: [{ exposureMode: 'manual', exposureTime, iso }] })` from current `track.getSettings()`; on any throw, continue with continuous AE silently.
- Partial capture: keep the burst with ≥2 frames and an honest status; below 2, discard with the error.
- `facingMode: 'environment'` may hang on some Android devices: try it, on failure/timeout retry `getUserMedia({ video: true })` once.
- Copy voice: plain, short, honest (see existing UI strings).

## Review Focus

- Permission denied / no camera → Shoot button fails with a plain message, app fully usable, stream never left open.
- takePhoto fails mid-count (frame 3 of 6) → ≥2 frames still merge with "shot 2 of 6" status; <2 discards.
- iOS Safari (no manual exposure support) → burst shoots and merges anyway, no visible error about exposure.
- User cancels mid-count → stream released immediately, nothing enters the photo list.
- Count chooser state (4–8) survives reload; an out-of-range persisted value falls back to 6.

---

### Task 1: Sequencer core in `src/web/camera.js`

**Files:**
- Create: `src/web/camera.js`
- Test: `test/camera.test.js`

**Interfaces:**
- Consumes: nothing (pure module; DOM wiring comes in Task 2).
- Produces: `createCameraBurst(deps)` returning `{ open, close, shootBurst, lockExposure }` where
  - `deps = { media, ImageCaptureCtor, delay }` — injectable; default `window`/`ImageCapture`/`setTimeout`-based `delay(ms)`.
  - `open() -> Promise<stream>` (rear camera with environment→generic fallback per constraints; also creates the track's ImageCapture).
  - `lockExposure() -> Promise<void>` (never rejects).
  - `shootBurst({ count, onShot }) -> Promise<{ files: File[], shots, failed }>` — `count` clamped 4–8; `onShot(i, total)` after each; `files` are `File` objects named `burst-<i>.jpg`; resolves with ≥2 files or rejects with `{ min: true }` when fewer than 2 survived.
  - `close()` — stops tracks, idempotent.

- [x] **Step 1: Write failing tests** in `test/camera.test.js` (mock `media.getUserMedia` resolving a fake stream with a `getVideoTracks()[0]` stub; mock `ImageCaptureCtor` whose `takePhoto()` resolves blobs on a scripted sequence):
  - count clamps: `shootBurst({ count: 99 })` takes 8; `{ count: 1 }` takes 4.
  - all shots ok: 6 resolves `{ files.length: 6, shots: 6, failed: 0 }`, names `burst-1.jpg`…`burst-6.jpg`.
  - mid-burst failure at shot 3 of 6 → `{ files.length: 5, failed: 1 }`.
  - 5 of 6 fail → rejects with `err.min === true`, `close()` called.
  - cancel: an `abort()` mid-burst rejects without resolving.
  - lockExposure: throws inside applyConstraints → promise still resolves; supported → applyConstraints called with `exposureMode:'manual'` + current settings values.
  - environment fallback: first getUserMedia rejects → called again with `{ video: true }`.

- [x] **Step 2: Run, verify fail** — `node --test test/camera.test.js` → "createCameraBurst is not defined".

- [x] **Step 3: Implement** `createCameraBurst(deps = {})` in `src/web/camera.js` with the exact interface above. Page-script + node module like bursts.js: `if (typeof module === 'object' && module.exports) module.exports = createCameraBurst;` Pacing: await each `takePhoto()` resolve, then `delay(150)`; a shot whose takePhoto rejects increments `failed` and continues.

- [x] **Step 4: Run, verify pass** — `node --test test/camera.test.js` all green; `npm test` still green.

- [x] **Step 5: Commit** — `git add src/web/camera.js test/camera.test.js && git commit -m "camera burst: injectable sequencer core"`

### Task 2: Overlay UI, pipeline wiring, build integration

**Files:**
- Modify: `src/web/camera.js` (append DOM layer)
- Modify: `src/frontend/scenes.js` (Night guide gets a Shoot button)
- Modify: `test/scenes.test.js` (assert button on Night only)
- Modify: `src/web/web.css` (overlay styles)
- Modify: `tools/build-web.js` (`webIndex`: load camera.js after app.js)
- Modify: `test/web-build.test.js` (webIndex emits camera.js; anchor uniqueness)

**Interfaces:**
- Consumes: Task 1's `createCameraBurst`; globals from app.js (page scripts share scope): `addPaths(paths)`, `runMerge()`, `setStatus(text, isError)`; `tiny.addFiles(list) -> paths`.
- Produces: DOM ids `camOverlay`, `camVideo`, `camShutter`, `camCount` (chips 4–8), `camCancel`, `camStatus`; a `.scene-shoot` button inside the Night guide; drop-zone button `camOpen` injected by webIndex.

- [x] **Step 1: Failing build test** — extend `test/web-build.test.js`: `webIndex(baseHtml)` output contains `camera.js` exactly once and keeps every existing anchor assertion passing. Run `node --test test/web-build.test.js` → FAIL.

- [x] **Step 2: Failing scene test** — in `test/scenes.test.js`: `guideHtml('night')` contains `scene-shoot`; `guideHtml('landscape')` does not. Run → FAIL.

- [x] **Step 3: Implement** —
  - `scenes.js` night scene: append `<button class="scene-shoot" hidden>Shoot a night burst</button>` to its `expect` text (HTML string, matches existing renderer).
  - `style.css`: `.scene-shoot { display: none; }` (desktop-safe default).
  - `camera.js` DOM layer (runs only when `window.ImageCapture` and `matchMedia('(pointer: coarse)')`): un-hide `.scene-shoot` buttons and inject `camOpen` button into `#drop`; click → `open()` (permission now), overlay with live `<video>`, count chips (read/write `localStorage.burstCount`, clamp 4–8, default 6), shutter → `lockExposure()` → count-in (3…2…1 text in `camStatus`) → `shootBurst` with `onShot` ticking `camStatus` → `close()` → `const paths = tiny.addFiles(files); await addPaths(paths); runMerge();`. Any error path: `close()`, `setStatus(msg, true)` with plain copy ("Camera blocked — allow camera access and try again." / "Only N of M shots came out." / "Could not use the camera: <name>"). Cancel button → `abort()` + `close()`, nothing added.
  - `webIndex`: `replaceOnce` adding `<script src="camera.js"></script>` after `<script src="app.js"></script>` (same pattern as samples.js line).
  - `web.css`: darkroom overlay — `#camOverlay` fixed inset 0, black 95%, video object-fit contain, round shutter, pill count chips, `camStatus` centered text; hide `#camOpen`/`.scene-shoot`-unhide rules inside web.css (`.scene-shoot { display: inline-block; }` override + coarse-pointer media query is fine but camera.js already gates by support — CSS just styles, never shows, on desktop because camera.js absent means no un-hide class; keep `.scene-shoot[hidden]{display:none}`).

- [x] **Step 4: Verify** — `node --test test/web-build.test.js test/scenes.test.js` PASS; `node tools/build-web.js /tmp/opencode/wb && grep -c camera.js /tmp/opencode/wb/index.html` → 1; `npm test` green.

- [x] **Step 5: Commit** — `git commit -am "camera burst: capture overlay wired into the merge pipeline"`

### Task 3: Analytics, README, final verification

**Files:**
- Modify: `src/web/analytics.js`
- Modify: `README.md` ("What is left")
- Modify: `docs/superpowers/plans/2026-11-16-camera-burst-capture.md` (tick steps)

**Interfaces:**
- Consumes: window events dispatched by camera.js: `camera-shoot` `{ detail: { count } }` at start, `camera-end` `{ detail: { ok, shots, failed, ms, code } }` at close (`code` one of `denied|unsupported|shot_error|cancelled|ok`).
- Produces: GA events `capture_start` / `capture_end` with those params only.

- [x] **Step 1:** camera.js dispatches the two events (add to DOM layer); analytics.js subscribes in the same style as `scene_select`. No new test (analytics has none); verify by grep in built page.

- [x] **Step 2:** `npm test` green; `node tools/build-web.js` then puppeteer check on `http://127.0.0.1:<port>/` at 412×892: page loads with no console errors, `camOpen` present in DOM but hidden without coarse pointer, scene guide unaffected; desktop viewport unchanged.

- [x] **Step 3:** README "What is left": replace the scene-guides line's "Next" note to mention camera capture shipped, pending real-S25 manual verification.

- [x] **Step 4: Commit** — `git commit -am "camera burst: capture analytics + README note"`

**Manual verification (after merge, before release):** Spencer's S25, Chrome, deployed URL — shoot a 6-frame burst of a night scene end-to-end; confirm exposure lock holds (no flicker between shots) and merge completes or fails with an honest message. This is the spec's stated acceptance and cannot be automated here.

# Camera burst capture (PWA) — design

## Intent and why

Spencer uses Burst Super-Res in the field for night shots; merging is what
makes phone night photos usable. Today the PWA needs photos to already
exist: shoot in the camera app, come back, pick files. This feature closes
that loop: stand somewhere, open the PWA, shoot the burst with the rear
camera, merge, see the result — one tab, no camera app, no transfer.

## Goals

- A "Shoot" path in the web version on phones: live rear-camera preview,
  one tap, an automatic burst of stills, then straight into the existing
  merge pipeline.
- Exposure/focus locked before the burst where the platform allows
  (Android Chrome honors manual exposureMode on takePhoto; iOS Safari
  generally does not — degrade gracefully, brightness matching already
  evens flicker).
- Counted, paced capture (visible countdown or per-shot tick) so the user
  can hold still; shots spaced enough for takePhoto() to finish (~0.5–1 s
  each).
- Works with the scene guides: Night guide gets a prominent "Shoot a night
  burst" affordance; any scene's picker can start capture.
- Stills at full camera resolution via ImageCapture.takePhoto() (JPEG
  blobs), never canvas grabs of the video stream.

## Non-goals

- Desktop capture (webcam) — phones only.
- RAW capture — browsers give JPEG; the raw-sample merge stays a
  desktop/camera-ARW feature.
- Video, HDR bracketing, or per-frame manual tweaks during the burst.
- Native app or Camera Capabilities API (Chrome-only, still stabilizing)
  as a requirement.
- Replacing file drop: drop/pick stays the primary desktop flow.

## Anti-goals

- A capture path that silently produces an unusable burst (rolling AE,
  half the shots failed, preview-only resolution) and lets the merge fail
  confusingly later.
- Prompting for camera permission before the user has asked for it.
- Anything that uploads pixels. All blobs stay in the tab.

## Constraints

- Web only (src/web/), no desktop changes; app.js shared, so capture code
  must no-op cleanly on desktop (guard on ImageCapture support + small
  viewport, like the scene chips' CSS split, but functional gating in JS).
- Phone memory: burst count selectable 4–8 on the capture overlay, default
  6 (user's call: take the risk; honest failure beats downscaling). On a
  merge that dies from memory, the existing error path reports it; we
  surface "try fewer frames" only if the existing message does not already
  cover it.
- After the last shot the app merges automatically (Mean), then lands on
  the normal result view; the photo list stays one tap away so a blurred
  frame can be unticked or Median chosen and re-merged.
- getUserMedia needs a secure context — already HTTPS (GitHub Pages).
- iOS Safari: takePhoto() works; exposureMode/ISO constraints report
  unsupported → just shoot with continuous AE.
- Some Android devices hang on facingMode:'environment' constraints →
  fall back to enumerateDevices + first videoinput after permission, as
  documented in the wild.
- No dependencies; app has zero deps, keep it that way.

## The how, decided in conversation

- Trigger: from the scene picker / Night guide, a "Shoot" button; plus a
  button next to the drop zone on small screens when ImageCapture exists.
- Capture UI: fullscreen-ish overlay — live preview, burst-count chooser
  (4–8, default 6, remembered), big shutter button, shot counter (3…2…1
  then ticks 1/N…N/N), exposure locked at the preview's current settings
  before the count starts (via track.applyConstraints with manual
  exposureMode/ISO where supported; skip silently where not), Cancel exits.
  After the last shot: overlay closes, Mean merge runs automatically.
- Frames flow into the same addDropped/reader path as picked files (File
  objects from blobs, synthetic names like burst-1.jpg… so bursts.js and
  EXIF-free photos behave as they already do for PNGs).
- Analytics: capture_start / capture_end (frame count, ms, error code) —
  same rules as existing events, no pixels or names.

## Left to the builder

- Exact pacing (fixed ~700 ms vs adaptive on takePhoto resolve), overlay
  layout within the darkroom theme, whether the count-in is text or ring,
- how capture entry points are wired to scene guides (Night shows it
  inline; others via a small link),
- tests: unit-test the pure parts (burst sequencer state machine,
  capability decisions) with a mocked ImageCapture; real-camera
  verification is manual on Spencer's S25 (staging URL or --host).

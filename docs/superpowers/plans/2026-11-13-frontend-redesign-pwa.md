# Frontend redesign + PWA (hobbyists & professionals)

## Steps

- [x] Design system + visual redesign: tokens, hierarchy, spacing, states, a11y (style.css rewrite, all ids/selectors kept)
- [x] Markup: semantic app shell, guided empty state, settings groups with plain-language hints, drag overlay (index.html; build anchors kept)
- [x] Pro touch: EXIF line for the reference photo (exif.js cameraInfo + test; app.js render)
- [x] app.js UX glue: drag overlay, per-setting hints, progressbar aria, merge button tooltip
- [x] PWA: manifest, service worker (precached shell, offline), icons (192/512/maskable/apple), install prompt (src/web only)
- [x] build-web.js: copy icons, inject manifest/apple links, stamp sw.js version; web.css updates
- [x] Tests: web-build anchors + exif cameraInfo; npm test green
- [x] Verify in headless Chrome: web build desktop + mobile screenshots, SW + manifest load, no console errors; ui-preview selftest on the real canyon burst

## Constraints

- Same shared frontend: desktop tinyjs app keeps working unchanged (no web-only code in src/frontend).
- Every element id and the build-web replace anchors stay; tests keep passing.
- No runtime dependencies. Honest copy (no invented claims).

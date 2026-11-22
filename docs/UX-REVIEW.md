# Web UX review and improvement plan (Nov 21 2026)

Two-agent review: code/copy/a11y audit + live CDP screenshots (desktop, mobile,
sample-merge flow). No console errors or exceptions in any session. Honest
claims verified intact (no AI / no megapixel inflation). Mobile: no horizontal
overflow.

## Findings by severity

### Critical (a11y)
- Compare view (index.html:126, app.js renderCompare): screen-reader void — two
  canvases, Before/After tags visual-only, slider position unannounced. The
  product's core interaction has no text path.
- progressbar (index.html:70, app.js setProgress): role set, no initial
  aria-valuenow; duplicates #status live text. Pick one channel.

### High
- "Try a sample burst" is a 13px text link with a scary "(8 photos, 82 MB)"
  note; the zero-friction first-run path is the least prominent element
  (index.html, samples.js:9 stays hidden on fetch failure — add a disabled
  "Sample unavailable" fallback).
- Merge button reads disabled: dark-olive fill, ~3:1 label contrast.
- Desktop empty state: right pane is ~60% blank; the one thing to read (How to
  shoot a burst) floats in a void while everything actionable is cramped in a
  scrolling left column.
- Mobile tap targets 38px (<44 min): Choose/sample/chips/footer links.
- Mobile auto-expands the Landscape guide (wall of prose above Merge); desktop
  does not — inconsistent first impression. Default-collapse guides on small
  screens.
- iOS: camera button silently absent (camera.js:119); show a Chrome-only note
  instead of nothing.
- No pre-merge memory warning on the camera->8-frame path (camera.js:216),
  the most likely phone OOM.
- All badge numbers are hover-only title tooltips (style.css:167) — unusable on
  touch, the primary capture platform.
- Camera overlay: no role=dialog, no focus mgmt, no Escape (camera.js:134).
- remove-photo "x" has title but no aria-label (app.js:463).

### Medium (copy)
- "Before: one photo, Lanczos 2x" permanent on-canvas tag = jargon
  (index.html:130). -> "enlarged 2x".
- Quality verdict "2.2 levels different on average (of 255); 25% of pixels..."
  (app.js:732) not interpretable, no good/bad signal.
- "0.7-1.3 dB PSNR" (index.html) needs a plain gloss.
- "Pairwise (the guide's original)" unresolvable in-app -> "the original
  method".
- Scene guide says "split view at 200%" but the zoom control reads "2x".
- Post-save journey dead-ends ("Saved X MB."); no next step.
- Keyboard shortcuts (\\, Y, arrows) hidden below 960px, not in Help menu.
- Two install affordances (Install app + Get the desktop app) compete.

### Guidance (scenes.js)
- README promises city + astro guides; only landscape/night/handheld/General
  exist. Build them or drop the promise.
- Each guide's takeaway line is the least prominent; promote it.
- scenes.js vs README prose drift (no shared source).

## Plan (ticket-ready; build-web.js string-matches index.html and fails on
drift, so HTML copy edits must update build-web.js expectations in the same
ticket)

A. style.css + web.css: >=44px touch targets; default-collapse guides under
   960px; bump muted text to >=4.5:1; footer link touch sizing; Merge button
   readable primary fill; style "Try a sample burst" as a secondary button.
B. index.html + build-web.js: progressbar aria-valuenow (or drop role);
   #summary/#warnings aria-live; Lanczos->"enlarged 2x"; PSNR gloss; mode label
   ->"the original method"; keep build-web anchors matching.
C. app.js: compare aria-describedby summary + split-position label; badge tap
   fallback on coarse pointer; plain-language verdict (drop "levels of 255");
   post-save next-step hint; Help > Keyboard shortcuts; remove-button aria-label;
   sharpen amount label mapping.
D. scenes.js: "200%"->"2x zoom"; promote takeaway; add City and Astro guides
   (honest, matching README's measured limits).
E. camera.js: iOS Chrome-only note; role=dialog + focus + Escape; lens labels
   from enumerateDevices; pre-merge memory guard on high frame counts; fix
   misleading "hold very steady" wording (stills freeze motion; alignment, not
   blur, is the reason to hold still).

## Verification
- npm test (74) + npm run verify must stay green; build-web.js build must pass
  after B; BURST_SELFTEST / headless screenshot for A/D visual states; axe-core
  pass on the live page for B/C a11y.

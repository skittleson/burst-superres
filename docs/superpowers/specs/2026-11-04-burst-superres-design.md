# Burst Super-Res: design + plan (MVP)

Source of intent: Spencer's project brief (kept out of the public repo). It
is complete enough to act as the approved description; everything below marked **(my call)** is a builder
decision, not something Spencer signed off on.

## Steps

- [x] Core math in one plain-JS file (`src/frontend/sr-core.js`): luma pyramid,
      sub-pixel translation registration, Lanczos-3 resampling, merge modes,
      PSNR/SSIM. Unit tests with `node --test`.
- [x] Measurement harness (`tools/`): synthesize a burst from the real
      ILCE-6400 JPEG, run every merge mode, report PSNR/SSIM vs. the original.
- [x] tinyjs app: pick/drop JPEGs → worker merge → before/after compare →
      native save (JPEG/PNG). Guide link in footer/About.
- [x] Smoke-test with `tinyjs dev` (self-driving page), `tinyjs build` for Linux.
- [x] README with measured numbers and honest limits. Local commits only.

## Outcome (what changed during the build)

- **Registration is affine, not translation-only.** Spencer's real sample
  bursts are handheld with visible rotation, so translation-only alignment
  was not enough. Tiles + robust affine fit + two refinement passes now give
  ≤0.03 px worst-case error on simulated bursts with up to 0.5° rotation.
- **shift-add was dropped.** It measured no better than the Lanczos mean on
  real photos (worse on detailed crops and with 8 frames). Mean is the
  default; median and the guide's pairwise blend remain as options. The
  measurements are in the README and `docs/results/`.
- Real handheld bursts with parallax (fit error 4.4 px and 21.9 px) are out
  of scope; the app detects them and warns.

## Intent

A free, genuinely useful tool that markets Spencer's Sony A6000/A6400 hacking
guide. It must stand on its own, make only claims we measured, and never nag.

## Architecture (my call, driven by tinyjs constraints)

- **Pixels run in the page, in a Web Worker.** The tinyjs backend is QuickJS
  (interpreter, no JIT); the webview has a JIT. The worker keeps the UI
  responsive. The worker is created from a Blob URL built from function
  source, because `new Worker('file://…')` is refused by Chromium (WebView2).
  Spike on WebKitGTK 2.52 confirmed: Blob worker works, a 6000×3376 JPEG
  decodes in ~0.16 s, a 12000×8000 canvas encodes to JPEG in ~0.9 s.
- **Backend only touches the disk.** Inputs load in the page through
  `tiny.fileURL(path)` (`readAccess: true`). Output bytes go page → backend in
  3 MB base64 chunks (the bridge is text); backend writes with `tjs.open`.
  Spike: 16 MB saved in ~1.3 s.
- **Memory:** frames stay `Uint8ClampedArray` RGBA (~96 MB per 24 MP frame).
  The merge runs in horizontal strips of output rows, so per-frame float
  buffers are never full-size. Output is one RGBA buffer (~384 MB at
  12000×8000). Expect ~1–1.5 GB peak for four 24 MP frames.

## Algorithm

1. Decode frames; pick the sharpest (Laplacian variance) as reference
   (as Spencer's `image_utils.py` does).
2. **Registration (my call: translation only).** Luma pyramid (2×2 box);
   exhaustive integer search at the coarsest level; inverse-compositional
   Lucas–Kanade translation refinement down to full resolution → sub-pixel
   (dx, dy) per frame plus a residual so the UI can flag a bad alignment.
   Rotation / perspective (handheld) is out of scope; the README says so.
3. **Merge onto a 2× grid**, strip by strip. Modes:
   - `shift-add`: each input pixel is splatted to its true sub-pixel position
     on the 2× grid with a small Gaussian kernel, normalized; holes fall back
     to the Lanczos mean. This is the "real" super-resolution path.
   - `mean` / `median`: Lanczos-3 resample each registered frame straight to
     the 2× grid (one interpolation, not resize-then-warp), per-pixel
     mean or median.
   - `pairwise`: Spencer's guide method: Lanczos 2×, align, 50 % blend,
     pairwise tree, 8-bit between stages. Kept for comparison.
   The default is whichever measures best on the synthetic benchmark.
4. Output dimensions are exactly 2× the input. The UI shows pixel
   dimensions, never a "MP" claim.

## Measurement

Ground truth = the real 24 MP ILCE-6400 JPEG. Synthetic burst: random
sub-pixel shifts (applied with Lanczos at full res), 2×2 box downsample
(sensor-like integration), Gaussian noise, JPEG q92. Metrics: luma PSNR and
SSIM vs. the original (16 px border excluded), plus registration error vs.
the known shifts. Tuning (kernel width) is done on one shift set and the
reported numbers come from a different seed, to avoid fitting the test.
Baseline: the reference frame alone, Lanczos 2×.

## Non-goals

RAW, handheld/rotation correction, moving subjects, "AI", EXIF copy (MVP).

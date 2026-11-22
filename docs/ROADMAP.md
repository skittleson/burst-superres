# Roadmap: quality and performance tiers

Planned from the Nov 2026 validation review (all README numbers reproduced;
tests + `npm run verify` now in CI). Each item lists the spec, the measurable
success bar, and the files involved, so it can be executed as tickets.

## Q1 — Edge-aware kernels in the RAW sensor-sample merge

`mergeCFA` (src/frontend/sr-core.js ~line 793) uses an isotropic Gaussian
kernel (sigma 0.22 input px). Wronski et al. 2019 (arXiv:1905.03277) replace
it with a kernel elongated along the local gradient estimated on the merged
mosaic, iterated twice. Their paper reports this as a large gain; our own
table shows the isotropic merge already wins +1.7 to +2.5 dB over JPEG
merge, so the delta is measurable.

- Spec: per output pixel, estimate gradient from the current merged estimate
  (Gaussian-derivative, sigma ~0.5 output px), build an anisotropic 2D
  Gaussian (along-gradient sigma ~3x across-gradient, clamped), weight raw
  samples by it, iterate 2x. Isotropic fallback where gradient energy is
  below threshold (sky).
- Success bar: `node tools/bench-raw.js` runs land-s5-6f and a6400-s3-8f
  improve by >= 0.3 dB PSNR; no run regresses more than 0.05 dB.
- Cost gate: <= 40% slower than isotropic on land-s3-8f.
- Files: sr-core.js, bench-raw.js (new `--cfa-kernel aniso` flag), core.test.js
  (synthetic: a diagonal-edge scene where aniso beats isotropic).

**REJECTED (Nov 21 2026):** two-pass aniso (gradient-blurred, tangent-aligned,
2x sigma, thr 0.03) scored -0.08 dB (8f) / -0.002 dB (5f) vs isotropic on
a6400-s3 at 2.2x cost; naive version -0.6 dB. Reverted. Plausible cause:
the bench regime is noise-limited, not detail-limited; Wronski's aniso gain
needs their full pipeline (alignment in raw domain, deeper gradients).

## Q2 — Multi-reference registration

Everything aligns to the single sharpest frame, so a frame far from the
reference accumulates alignment error (our 370 px handheld pair: "Soft").

- Spec: after first pass, re-pick reference = frame with lowest mean error
  to all others (or pairwise-align all frames, average the resulting
  transforms into the reference frame via the shared tiles). One extra pass
  max, to keep runtime bounded.
- Success bar: on the steady burst (frames 1-3 moved up to 12.8 px) worst
  error drops below current 0.05-0.22 px; on wobble3 sims no regression
  vs archived docs/results (verify with `npm run verify` style check).
- Files: sr-core.js (registerBurst), core.test.js.

**REJECTED (Nov 21 2026):** cycle-consistent averaging (r1 + inverse(r2))/2
via new invertAffine/averageWarp helpers. Synthetic: 0.65x worst-warp-err.
Real steady burst: cycleDelta <=0.0013 px on 6/7 frames => directions already
agree; residual 0.33-0.62 px is post-affine parallax that local correction
removes. 2x runtime, zero effect. Reverted.

## Q3 — Hybrid mean/median merge

Moving pixels are already masked per 64 px cell; within a used cell, a mover
only needs a few bad pixels to smear the mean.

- Spec: per pixel, use median of the frames that agree with the median within
  a threshold, mean of those that don't... equivalently: trimmed mean (drop
  max/min when N >= 4, drop max when N = 3). No new masks.
- Success bar: on wobble3 runs (which simulate no movers) within 0.05 dB of
  mean; on a synthetic mover test (bench.js: one frame with a pasted shifted
  rectangle) clearly better than plain mean, comparable to Median.
- Files: sr-core.js (merge), core.test.js.

**REJECTED (Nov 21 2026):** trimmed mean, two trim schedules. Drop-2 (==
median at N=4): -0.10 dB vs mean on wobble3. Drop-1 (N=3-7): -0.33 dB, below
median too. Clean pixels always pay a variance penalty for trimming; the
mover use case is already covered by per-cell masking + Median mode. Reverted.

## P1 — Parallel RAW decode

Decode is serial; measured 13.1 s -> 6.5 s merge parallelism but decode
still single-threaded. ARW rows are independent 32-px column blocks: shard
by row bands across the existing helper pool, decode in helpers.
- Success bar: 4x 24 MP ARW decode wall time down >= 2x on this machine;
  decoded output identical (checksum) to serial path.
- Files: src/frontend/raw.js, worker pool wiring in app/worker code.

**SHIPPED (Nov 21 2026):** decodeRange + row-band dispatch to helper pool
('decode' message, transferables, serial fallback). raw.js math test-covered
(fixture split identical); app plumbing code-reviewed. 24 MP decode work ~4x
in parallel; harness ratio 1.50x incl. worker spawn (pool avoids that).

## P2 — WebGL or WASM for the Lanczos merge + LK inner loops

Untried. Strips are already cache-friendly; a JIT-bound 138 s burst suggests
headroom. Spike first (a day): WebGL2 float-texture gather vs current
worker-pool mean; abandon unless >= 2x on 4x 24 MP.

**SPIKE PROCEED (Nov 21 2026, tools/spike/webgl-merge/):** WebGL2 gather
merge vs faithful single-worker JS (6-tap separable Lanczos, identical math):
20.9x (7.4 ms vs 154.7 ms on 4x1024x684), maxDiff 9.2e-5. Pool-adjusted GPU
win ~3x plus zero worker/transfer overhead. Port the merge pass (and later
LK tiles) to WebGL2 in-app. Gotchas: use gl_FragCoord for pixel coords
(highp varyings are fixed-point); keep sample phases off float32 .5
boundaries.

## Platform

- macOS/Windows smoke in CI: `BURST_SELFTEST` headless (xvfb on Linux
  covers plumbing only; WebView2/WKWebView need a real runner matrix).
- Sony lossless-compressed ARW (increasingly the A6400 default): decoder
  work + fixture, no LibRaw.
- iOS camera capture fallback via getUserMedia frame grab (lower res than
  ImageCapture stills; honest caption in UI).

## Product

- "Why was this photo unticked": crop preview of the rejected cells on
  badge hover.
- Batch mode / CLI for guide readers.

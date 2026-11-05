# Burst Super-Res

A small desktop app for macOS, Windows and Linux. It merges a burst of photos of the same static scene into one image with twice the width and height.

It is a free tool from the [Sony A6000/A6400 Hacking Guide](https://dctmlab.taila665d5.ts.net/) by [Do Code That Matters](https://docodethatmatters.com/). Chapter 7 of the guide, "Super-resolution from a burst", is where the method started.

![One photo upscaled 2x next to 4 photos merged](docs/media/before-after-landscape.png)

## What it does

1. You drop 2 to 8 JPEG or PNG photos of the same scene into the window.
2. The app picks the sharpest photo as the reference.
3. It aligns every other photo to the reference to a fraction of a pixel. It corrects small shifts and slight rotation.
4. It resamples every photo onto a grid with 2x the width and height (Lanczos-3), then takes the per-pixel mean.
5. You compare a crop of "one photo upscaled 2x" against "merged" with a slider, then save as JPEG or PNG.

The output is exactly 2x per side. Four 6000 x 4000 photos give one 12000 x 8000 image. The app shows the real pixel dimensions. It does not claim a megapixel number, because the extra pixels do not hold 4x the detail.

Everything runs on your computer. The app makes no network requests except when you click a link to the guide.

## What it does not do

- **It needs a static scene.** Landscapes, architecture and product shots work. People, water, leaves in wind and traffic do not. The Median mode reduces ghosting from small moving things, but it does not remove it.
- **It needs a tripod or a very steady hand.** The alignment model is one shift plus a slight rotation for the whole frame (affine). When the camera moves between shots, near and far objects move by different amounts (parallax). One model cannot align both. The app measures this and shows a warning when a photo does not fit (fit error above 0.3 px).
- **It does not remove camera shake blur.** A blurry photo stays blurry. It adds blur to the merge.
- **It needs a small movement between shots.** If the photos are pixel-identical in position, merging only reduces noise. The app tells you when this happens.
- **The gain is modest.** Expect less noise and cleaner fine edges. Do not expect 4x the detail. See the numbers below.
- RAW files are not supported. Export JPEG or PNG first.
- EXIF data is not copied to the output yet.

## Measured results

### Method

I have no real tripod burst with a known "true" high-resolution image. So I made simulated bursts from real camera JPEGs and measured against the original:

1. Take a real 24 MP JPEG as the ground truth: the ILCE-6400 test photo, and a detailed A6000 landscape (`20231228_122222.JPG` from my `dslrCameraPowerRename` samples).
2. Make N frames. Frame 0 is the original. Every other frame gets a random shift of up to 1.5 px (at frame resolution), and optionally a random rotation of up to 0.5 degrees.
3. Downsample every frame 2x with a 2x2 box filter. This models how a sensor pixel integrates light.
4. Add Gaussian noise (sigma 2 levels) and save as JPEG quality 92 with libjpeg-turbo.
5. Merge the frames back to the original size with every method. Measure luma PSNR and SSIM against the original. A 16 px border is excluded.

The baseline is the reference frame alone, upscaled 2x with the same Lanczos-3 resampler. That is the honest comparison: the same output size, with and without the burst.

Run it yourself: `npm run bench -- --seed 2` (see `tools/bench.js`). The raw numbers are in `docs/results/`.

### Numbers

PSNR in dB / SSIM, whole image. "Gain" is mean minus single photo.

| Run | Ground truth | Frames | Noise | Max rotation | Worst alignment error | Single photo 2x | Mean | Median | Pairwise 50% | Gain (mean) | Mean time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| a6400-s2-noise2 | A6400 test photo | 4 | 2 | 0 | 0.015 px | 38.59 / 0.8941 | **39.84 / 0.9164** | 39.73 / 0.9144 | 39.82 / 0.9159 | **+1.25** | 3.9 s |
| a6400-s2-noise0 | A6400 test photo | 4 | 0 | 0 | 0.014 px | 39.09 / 0.9018 | **39.77 / 0.9139** | 39.69 / 0.9123 | 39.76 / 0.9136 | **+0.69** | 4.1 s |
| a6400-s3-rot0.5 | A6400 test photo | 4 | 2 | 0.5 deg | 0.015 px | 38.60 / 0.8942 | **39.88 / 0.9171** | 39.76 / 0.9150 | 39.86 / 0.9166 | **+1.28** | 5.2 s |
| a6000land-s2-noise2 | A6000 landscape | 4 | 2 | 0 | 0.014 px | 33.51 / 0.9274 | **34.58 / 0.9459** | 34.47 / 0.9445 | 34.57 / 0.9456 | **+1.07** | 4.7 s |
| a6000land-s2-noise0 | A6000 landscape | 4 | 0 | 0 | 0.014 px | 33.68 / 0.9335 | **34.61 / 0.9467** | 34.51 / 0.9455 | 34.60 / 0.9464 | **+0.93** | 5.2 s |
| a6000land-s3-rot0.5 | A6000 landscape | 4 | 2 | 0.5 deg | 0.029 px | 33.51 / 0.9274 | **34.55 / 0.9459** | 34.44 / 0.9444 | 34.54 / 0.9455 | **+1.04** | 5.5 s |
| a6000land-s4-8frames | A6000 landscape | 8 | 2 | 0 | 0.020 px | 33.51 / 0.9274 | **34.80 / 0.9495** | 34.63 / 0.9475 | 34.79 / 0.9491 | **+1.30** | 10.6 s |

Times are node 25 (V8) on this machine (24 threads), with 3000 x 1688 or 3000 x 2000 inputs.

What the numbers say:

- The gain over one upscaled photo is **+0.7 to +1.3 dB**. That is real but modest.
- Without added noise the gain is still +0.7 to +0.9 dB. So part of the gain is real detail (less aliasing), not only noise reduction.
- 8 frames are a little better than 4 (+1.30 vs +1.07 dB on the same scene).
- Alignment error stayed at or below 0.03 px in every run, including the rotated bursts.
- Mean is the best method in every run, so it is the default. Median is 0.1 dB lower but resists moving objects. Pairwise is 0.01 to 0.02 dB lower than mean.

These are simulated bursts. A real camera adds demosaicing, an anti-aliasing filter and lens blur. I expect the gain on real tripod bursts to be the same or smaller. I did not measure it, because I do not have a tripod burst with a ground truth.

### My real bursts

The two real bursts in `dslrCameraPowerRename` (`samples/` and `sample1/`) are handheld. Between shots the camera moved 52 px and 250 px. The affine fit error was 4.4 px and 21.9 px. I also tested a perspective (homography) fit on the same tile measurements: 0.6 px and 6.3 px RMS. Both are far above the sub-pixel accuracy that a merge needs. The cause is parallax between near bushes and far hills. The app merges these photos, but it shows the "did not line up cleanly" warning, and the result is soft. This is the measured reason for the "tripod or very steady hand" rule.

### A method that did not help: shift-and-add

I also tried true shift-and-add: put every input pixel at its exact sub-pixel position on the 2x grid with a small Gaussian kernel, then normalize. On test patterns with strong aliasing it beat the mean by 1.0 to 1.7 dB. On the real photos it was equal to the mean on the whole image. On the detailed landscape crop it was 0.2 dB worse with 4 frames and 0.5 dB worse with 8 frames. I removed it from the app. The numbers are in `docs/results/v1-translation-only/`, from an earlier translation-only build.

## How it works

The code is in one file, `src/frontend/sr-core.js`, with no dependencies.

**Registration.**
1. Convert each photo to luma and build an image pyramid (2x2 box downsampling). The finest level gets a light Gaussian blur (sigma 1). This reduces aliasing and the bias that bilinear interpolation gives Lucas-Kanade towards whole pixels.
2. Find the global shift: exhaustive integer search at the coarsest level, then inverse-compositional Lucas-Kanade (translation) at each finer level.
3. Measure a grid of up to 8 x 6 tiles (512 px) inside the overlap. Each tile gets its own coarse-to-fine sub-pixel shift. The tile position is the gradient-energy centroid, not the tile centre, because that is where the shift is measured under rotation.
4. Fit an affine warp through the tile vectors with least squares. Remove featureless tiles (sky) and tiles that disagree (moving objects).
5. Repeat steps 3 and 4 twice more. Each time, pre-warp the frame tiles with the current fit, so the rotation inside a tile does not bias the shift. On a 1 degree test rotation this pass took the worst error from 0.040 px to 0.014 px.

**Merge.** For each output strip, render every photo through its warp onto the 2x grid with Lanczos-3. The affine resampling uses two separable passes (Catmull-Smith), so it is exact for affine warps and costs 12 taps per pixel, not 36. Then take the per-pixel mean (or median) of the photos that cover the pixel.

**Why the guide's pairwise blend is an option, not the default.** The guide upscales two photos, aligns them, blends them 50/50, and repeats in pairs. For 4 photos that is a mean, with rounding to 8 bits after each stage. For 3 photos it weights them 25/25/50, which is worse. The mean does the same work with exact weights for any count. The pairwise mode stays in the app so you can compare against the original method. It rounds half to even, like OpenCV.

**Reference frame.** The sharpest photo (highest variance of the Laplacian) is the reference, as in `image_utils.py`.

## Where the pixel work runs, and why

tinyjs apps have two halves: a txiki.js backend (QuickJS, no JIT) and the OS webview (WebKitGTK, WKWebView or WebView2, all with a JIT). So:

- **All pixel work runs in the page, in a Web Worker.** A tight numeric loop is much faster in a JIT, and the worker keeps the window responsive. The worker is built from function source as a Blob URL, because Chromium, which WebView2 uses, blocks workers loaded from `file://` URLs by default.
- **The backend only writes the output file.** The page encodes the result with `canvas.toBlob()` and sends it to the backend in 3 MB base64 chunks, because the bridge is text. A spike measured 16 MB in 1.3 s.
- **Inputs load in the page** with `tiny.fileURL(path)` (`readAccess: true` in `tinyjs.json`). The webview decodes the JPEG and applies EXIF orientation.
- **Memory.** Photos stay as 8-bit RGBA (96 MB per 24 MP photo). The merge works in strips of 32 output rows, so it never allocates a full-size float buffer. The output is one RGBA buffer (384 MB at 12000 x 8000). Measured peak for 2 x 24 MP photos: 1.9 GB in the WebKit web process. Plan for 2 to 3 GB of free RAM for 4 x 24 MP. The limit is about 67 MP inputs, because the 2x result must fit in one canvas (268 million pixels).

Measured in the app on this Linux machine (WebKitGTK 2.52):

| Input | Output | Merge time | Save JPEG |
|---|---|---|---|
| 4 x 3000 x 2000 | 6000 x 4000 | 6.9 s | 0.7 s |
| 4 x 6000 x 4000 (24 MP) | 12000 x 8000 | 31.3 s | 2.5 s |
| 2 x 6000 x 4000, real handheld pair | 12000 x 8000 | 18.6 s | 2.3 s |

The app output and the node output agree to 50.6 dB PSNR. The difference is the JPEG quality 95 encoding of the saved file.

## Build and run

You need the tinyjs CLI (0.51.1 or newer): https://tinyjs.app/

```sh
tinyjs dev      # run with hot reload
tinyjs build    # build dist/burst-superres for this OS
```

The app has no runtime dependencies. Node is only for the tests and the benchmark:

```sh
npm install     # dev tools only: pngjs for the benchmark crops
npm test        # unit tests for alignment and merge math (node --test)
npm run bench -- --seed 2                                  # A6400 test photo
npm run bench -- --gt path/to/photo.jpg --crop 400,1400,800,500 --rot 0.5
```

The benchmark needs `djpeg` and `cjpeg` (libjpeg-turbo) on the PATH. I do not use jpeg-js, because its decoder truncates instead of rounding. That shifts every pixel by -0.53 levels per round trip and skews PSNR.

`tools/before-after.py` (needs Pillow) makes the labelled comparison image from a benchmark run.

### End-to-end smoke test

The app has a self-test that drives the real UI in the real webview. It is off unless you set `BURST_SELFTEST`:

```sh
BURST_SELFTEST='{"photos":["/abs/a.jpg","/abs/b.jpg"],"mode":"mean","out":"/tmp/merged.jpg","focus":[2000,1500]}' tinyjs dev
```

It adds the photos, merges, renders the compare view, saves, writes a report to the app store (`~/.local/share/com.docodethatmatters.burstsuperres/store.json` on Linux) and quits. Add `"fullscreen":true,"holdMs":8000,"quit":false` to keep the window up for a screenshot.

## Platform status

| Platform | Status |
|---|---|
| Linux (Pop!_OS 24.04, WebKitGTK 2.52, Wayland) | Tested: `tinyjs dev`, `tinyjs build`, and the built binary with the smoke test. The binaries need glibc 2.35 or newer (Ubuntu 22.04 and later). |
| macOS | **Not tested.** Build on a Mac with `tinyjs build` (gives `dist/Burst Super-Res.app`). Sign and notarize before you share it. |
| Windows | **Not tested.** Build on Windows with `tinyjs.cmd build`/`publish`. Check the Blob-URL worker and the save path in WebView2 first. |

The code uses no platform-only APIs. `Uint8Array.prototype.toBase64` has a fallback for older webviews.

## What is left

- Test on macOS and Windows.
- Shoot a real tripod burst on an A6400 for the marketing images and a real-world check.
- Take an app screenshot (the screen was locked when I tried).
- Local (per-tile) alignment for handheld bursts with parallax. The tile measurements already exist; the merge would need a smooth warp field.
- Copy EXIF from the reference photo to the output.
- Speed: the merge is single-threaded JS. Several workers (one per strip range) or WebGL would make it faster.

## Credit

The method and the original Python/OpenCV code come from chapter 7 of the Sony A6000/A6400 Hacking Guide and `image_utils.py` in [dslrCameraPowerRename](https://github.com/skittleson/dslrCameraPowerRename).

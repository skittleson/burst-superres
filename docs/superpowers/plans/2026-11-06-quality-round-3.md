# Quality round 3: deblur, brightness matching, RAW input

## Steps

- [x] Brightness matching: per-photo gain (block means, robust) before registration and before merge; bench `--gain`; tests
- [x] Deblur after merge: strip-wise Richardson–Lucy, detail-adaptive (Wiener-style blend), measured on every bench run; tests
- [x] RAW decoder: TIFF/ARW parse, Sony ARW2 decompression + tone curve, SR2 decrypt (WB, black, color matrix), crop, orientation; verified against LibRaw (rawpy)
- [x] RAW render: Malvar–He–Cutler demosaic, WB, camera matrix, sRGB; compare with LibRaw's render
- [x] RAW in the app: .ARW load/thumbnail (embedded preview), capture time for burst grouping, worker decode
- [x] Measure RAW vs camera-JPEG in a simulated burst (mosaic + noise; JPEG path = demosaic + in-camera sharpen + JPEG)
- [x] UI: deblur control, RAW labels; README with measured numbers; screenshots; release v0.3.0

## Constraints

- Honest claims only; every number measured. Simulated results labelled as simulated.
- Deblur and brightness matching must not make any existing bench run worse beyond noise (±0.01 dB), or they are off by default.
- No new runtime dependencies (rawpy is a test-time reference only).

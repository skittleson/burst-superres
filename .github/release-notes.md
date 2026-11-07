Merge a burst of photos of the same static scene into one image with twice the width and height. Free tool from the [Sony A6000/A6400 Hacking Guide](https://dctmlab.taila665d5.ts.net/).

## New in 0.3.1

- Release files are signed: GPG signature on the checksums, embedded GPG signatures in the AppImages, and GitHub build attestations for every file. No app changes.

## New in 0.3.0

- **Sony RAW (ARW).** Decoded in the app (checked against LibRaw on a real A6000 file). With 6 or more RAW photos the merge is built from the raw sensor samples of every photo. In simulations, RAW scored 0.9 to 2.5 dB better than the same burst as camera JPEGs. Only one real ARW was available for testing, so these RAW numbers are from simulated bursts.
- **Sharpen after merging** (deconvolution): Off by default for camera JPEGs, Auto for RAW. Gentle, Medium and Strong are there to try.
- **Brightness matching.** Exposure flicker between shots is evened out per photo and colour.
- EXIF is kept for RAW input too.

## New in 0.2.0

- **Handheld bursts.** A local correction aligns each 64 px area when one shift and rotation is not enough. A real handheld pair went from 4.36 px to 0.06 px of alignment error. Tripod bursts are unchanged.
- **Bad photos are left out for you.** Good / Soft / Too far off badges, automatic unticking above 0.3 px, and areas where something moved are left out of that photo.
- **Folders.** Drop a folder; several bursts get a chooser.
- **Compare like a photo editor.** Split or side by side, a small map to move around, Mean vs Median, hold `\` for the single photo, `Y`, arrow keys.
- **Cancel** and a time estimate. **Merge again** reuses the aligned photos.
- **EXIF** from the reference photo is kept in saved JPEGs.

## Download

| Your computer | File |
|---|---|
| macOS 15 or newer (Apple Silicon and Intel) | `burst-superres-*-macos-universal.zip` |
| Windows 10 or 11 (x64) | `burst-superres-*-windows-x86_64.zip` |
| Linux x86_64 (Ubuntu 22.04, Debian 12 or newer) | `burst-superres-*-linux-x86_64.AppImage` or `.tar.gz` |
| Linux ARM64 | `burst-superres-*-linux-arm64.AppImage` or `.tar.gz` |

**macOS:** unzip, then move "Burst Super-Res" to Applications. The app is not notarized. The first time, right-click it and pick **Open**. On macOS 15, if that does not work, open **System Settings > Privacy & Security** and click **Open Anyway**.

**Windows:** unzip the folder and run `burst-superres.exe`. The app is not code-signed. If SmartScreen shows "Windows protected your PC", click **More info > Run anyway**. It needs the WebView2 runtime (included in Windows 11).

**Linux:** the AppImage is one file: `chmod +x burst-superres-*.AppImage` and run it. On first run it adds itself to your app menu. Or use the tarball: `tar xzf burst-superres-*-linux-*.tar.gz` and run `burst-superres/burst-superres`. Both need `libwebkit2gtk-4.1-0` (`sudo apt install libwebkit2gtk-4.1-0` on Debian/Ubuntu); the AppImage does not bundle WebKitGTK.

## Status

- Linux x86_64: tested end to end (merge, compare, save) on Pop!_OS 24.04, as tarball and AppImage.
- macOS, Windows and Linux ARM64: built by GitHub Actions, **not tested yet**. Please open an issue if something does not work.

## Honest limits

It needs a static scene and a tripod or a very steady hand. The gain over upscaling one photo was +0.7 to +1.3 dB PSNR in my tests: less noise and cleaner edges, not 4x the detail. See the README for the measurements.

## Verify

`SHA256SUMS.txt` lists the checksum of every file and is GPG-signed (`SHA256SUMS.txt.asc`, key in the repository at `docs/signing-key.asc`, fingerprint `47FA AD5F 8499 2200 15C8  F5EA 019D FCD0 B211 3CAB`). The AppImages also carry an embedded signature. Every file has a GitHub build attestation:

    gh attestation verify <file> -R skittleson/burst-superres

Merge a burst of photos of the same static scene into one image with twice the width and height. Free tool from the [Sony A6000/A6400 Hacking Guide](https://dctmlab.taila665d5.ts.net/).

## Download

| Your computer | File |
|---|---|
| macOS 15 or newer (Apple Silicon and Intel) | `burst-superres-*-macos-universal.zip` |
| Windows 10 or 11 (x64) | `burst-superres-*-windows-x86_64.zip` |
| Linux x86_64 (Ubuntu 22.04, Debian 12 or newer) | `burst-superres-*-linux-x86_64.tar.gz` |
| Linux ARM64 | `burst-superres-*-linux-arm64.tar.gz` |

**macOS:** unzip, then move "Burst Super-Res" to Applications. The app is not notarized. The first time, right-click it and pick **Open**. On macOS 15, if that does not work, open **System Settings > Privacy & Security** and click **Open Anyway**.

**Windows:** unzip the folder and run `burst-superres.exe`. The app is not code-signed. If SmartScreen shows "Windows protected your PC", click **More info > Run anyway**. It needs the WebView2 runtime (included in Windows 11).

**Linux:** `tar xzf burst-superres-*-linux-*.tar.gz` and run `burst-superres/burst-superres`. It needs `libwebkit2gtk-4.1-0` (`sudo apt install libwebkit2gtk-4.1-0` on Debian/Ubuntu).

## Status

- Linux x86_64: tested end to end (merge, compare, save) on Pop!_OS 24.04.
- macOS, Windows and Linux ARM64: built by GitHub Actions, **not tested yet**. Please open an issue if something does not work.

## Honest limits

It needs a static scene and a tripod or a very steady hand. The gain over upscaling one photo was +0.7 to +1.3 dB PSNR in my tests: less noise and cleaner edges, not 4x the detail. See the README for the measurements.

`SHA256SUMS.txt` lists the checksum of every file.

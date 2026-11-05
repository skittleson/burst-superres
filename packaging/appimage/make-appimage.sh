#!/bin/sh
# Build an AppImage from a tinyjs Linux release tarball.
#
#   packaging/appimage/make-appimage.sh <tarball> <x86_64|aarch64> <out.AppImage>
#
# Needs appimagetool on PATH (or APPIMAGETOOL=/path/to/appimagetool).
# WebKitGTK is NOT bundled: like the tarball, the AppImage uses the system's
# libwebkit2gtk-4.1 (Ubuntu 22.04 / Debian 12 and newer).
set -eu
TARBALL="$1"; ARCH="$2"; OUT="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
TOOL="${APPIMAGETOOL:-appimagetool}"

APPDIR="$(mktemp -d)/BurstSuperRes.AppDir"
mkdir -p "$APPDIR"
tar xzf "$TARBALL" -C "$APPDIR"            # -> $APPDIR/burst-superres/{burst-superres,launcher,icon.png}
test -x "$APPDIR/burst-superres/burst-superres"

cp "$HERE/AppRun" "$APPDIR/AppRun"
chmod +x "$APPDIR/AppRun"
cp "$HERE/burst-superres.desktop" "$APPDIR/burst-superres.desktop"
cp "$APPDIR/burst-superres/icon.png" "$APPDIR/burst-superres.png"
ln -s burst-superres.png "$APPDIR/.DirIcon"

ARCH="$ARCH" "$TOOL" --no-appstream "$APPDIR" "$OUT"
rm -rf "$(dirname "$APPDIR")"
ls -la "$OUT"

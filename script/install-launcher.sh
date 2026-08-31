#!/bin/bash
# Put transvibe in ~/Applications without packaging it.
#
# `npm run dist` makes a real .app, but that is a build to redo after every
# edit, and the helper binaries in bin/ still need unpacking out of the asar
# before the hotkey and the paste work. While the source is still moving,
# what is wanted is an icon that launches *this checkout*.
#
# So: a copy of Electron's own bundle, renamed, with Resources/app symlinked
# back to the repo. Finder, Spotlight, Dock and Login Items treat it as an
# app; the code it runs is whatever is in the working tree when you click it.
#
# A shell script that exec'd Electron would have been smaller, and was the
# first attempt — but then the *process* belongs to node_modules/Electron.app,
# and that is the bundle macOS relaunches after a permission prompt and the
# identity it files the permission under. Reopening got you Electron's welcome
# screen, because nothing passed it an app path. The bundle has to be its own.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:-$HOME/Applications/Transvibe.app}"
DIST="$REPO/node_modules/electron/dist/Electron.app"

[ -d "$DIST" ] || { echo "no electron in $REPO/node_modules — run npm install" >&2; exit 1; }

[ -f "$REPO/build/icon.icns" ] || {
  python3 "$REPO/script/make-icon.py"
  iconutil -c icns "$REPO/build/icon.iconset" -o "$REPO/build/icon.icns"
}

echo "copying Electron…"
rm -rf "$APP"
mkdir -p "$(dirname "$APP")"
cp -R "$DIST" "$APP"

mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/Transvibe"
rm -f "$APP/Contents/Resources/electron.icns"
cp "$REPO/build/icon.icns" "$APP/Contents/Resources/transvibe.icns"

# The one thing that makes this a live checkout rather than a build: Electron
# loads Resources/app, and Resources/app is the repo.
ln -sfn "$REPO" "$APP/Contents/Resources/app"

# PlistBuddy has no upsert: Set fails on a key Electron does not ship, Add
# fails on one it does. Try each in turn.
plist="$APP/Contents/Info.plist"
put () {
  /usr/libexec/PlistBuddy -c "Set :$1 $2" "$plist" >/dev/null 2>&1 ||
  /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$plist" >/dev/null
}
put CFBundleExecutable Transvibe
put CFBundleName Transvibe
put CFBundleDisplayName Transvibe
put CFBundleIdentifier com.sirkitree.transvibe
put CFBundleIconFile transvibe
put CFBundleShortVersionString 0.1.0
# Electron ships a placeholder here; this is the sentence the mic prompt shows.
put NSMicrophoneUsageDescription "transvibe transcribes your speech to text entirely on this Mac. Audio never leaves the device."

# The Swift helpers — right-Opt to arm command mode, sendkeys to paste — live
# in the repo, so they are built here rather than at launch.
[ -x "$REPO/bin/rightopt" ] && [ -x "$REPO/bin/sendkeys" ] || (cd "$REPO" && npm run --silent build:native)

# Every edit above invalidates Electron's signature, and an unsigned Electron
# gets killed on launch. Ad-hoc re-sign, inside-out.
echo "signing…"
codesign --force --deep --sign - "$APP" 2>/dev/null

touch "$APP"   # Finder caches the old icon otherwise
echo "installed $APP"

#!/bin/bash
# app/build.sh — build SlateWiper.app, the permissions container (see README → "The app").
# Bakes in this checkout's path and the config's `id` as the bundle identifier, ad-hoc signs,
# and copies it to ~/Applications. macOS ties permission grants to the signature, so after a
# rebuild re-grant Screen Recording / Automation. You should only ever need to build it once.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ID=$(node "$REPO/config.mjs" get id); ID=${ID:-local.slatewiper}
APP="$REPO/app/SlateWiper.app"; C="$APP/Contents"
rm -rf "$APP"; mkdir -p "$C/MacOS" "$C/Resources"
cc -O2 -DSLATE_REPO="\"$REPO\"" -o "$C/MacOS/SlateWiper" "$REPO/app/launcher.c"
iconutil -c icns -o "$C/Resources/SlateWiper.icns" "$REPO/app/icon/SlateWiper.iconset"
cat > "$C/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key><string>SlateWiper</string>
	<key>CFBundleExecutable</key><string>SlateWiper</string>
	<key>CFBundleIconFile</key><string>SlateWiper</string>
	<key>CFBundleIdentifier</key><string>$ID</string>
	<key>CFBundleName</key><string>SlateWiper</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>0.1</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSMinimumSystemVersion</key><string>12.0</string>
	<key>LSUIElement</key><true/>
	<key>NSAppleEventsUsageDescription</key><string>SlateWiper closes Terminal windows and Chrome tabs after archiving them.</string>
	<key>NSSystemAdministrationUsageDescription</key><string>SlateWiper takes screenshots of windows before closing them.</string>
</dict>
</plist>
PLIST
codesign --force --sign - --identifier "$ID" "$APP"
mkdir -p "$HOME/Applications"; rm -rf "$HOME/Applications/SlateWiper.app"; cp -R "$APP" "$HOME/Applications/"
echo "built and installed ~/Applications/SlateWiper.app ($ID → $REPO/app-main.sh)"

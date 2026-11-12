#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
pnpm -C app build
bundle="$PWD/app/dist/Superego Native.app"
rm -rf "$bundle"
mkdir -p "$bundle/Contents/"{MacOS,Resources}
cp -R app/out/renderer "$bundle/Contents/Resources/"
cp app/native/smoke.js "$bundle/Contents/Resources/"
bun build app/native/daemon.ts --compile --minify --outfile "$bundle/Contents/MacOS/superego-daemon"
swiftc -O app/native/Shell.swift -o "$bundle/Contents/MacOS/SuperegoNative" -framework AppKit -framework WebKit
cp app/native/Info.plist "$bundle/Contents/Info.plist"
codesign --force --sign - "$bundle/Contents/MacOS/superego-daemon"
codesign --force --sign - "$bundle"
ditto -c -k --keepParent "$bundle" app/dist/Superego-Native.zip
du -sk "$bundle" "$bundle/Contents/MacOS/"* "$bundle/Contents/Resources" app/dist/Superego-Native.zip

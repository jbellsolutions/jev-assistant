#!/bin/sh
# Builds native/jev-keys, the talk-key watcher. Separate from build-native.sh on purpose: rebuilding
# jev-speech resets its Speech Recognition grant, and nothing here should ever do that by accident.
# Rebuilding jev-keys itself asks for Input Monitoring again (the grant is tied to this binary).
set -e
cd "$(dirname "$0")/.."
echo "building native/jev-keys/jev-keys"
swiftc -O -framework CoreGraphics \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker native/jev-keys/Info.plist \
  -o native/jev-keys/jev-keys native/jev-keys/main.swift 2>&1 | grep "error:" && exit 1
codesign -f -s - -i com.jev.keys native/jev-keys/jev-keys 2>/dev/null
echo "ok"

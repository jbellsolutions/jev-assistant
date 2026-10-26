#!/bin/sh
# Builds native/jev-audio-out, which names the Mac's default output device for the panel's voice pill.
# Needs no permission, so rebuilding it is free (unlike jev-speech and jev-keys).
set -e
cd "$(dirname "$0")/.."
echo "building native/jev-audio-out/jev-audio-out"
swiftc -O -framework CoreAudio -o native/jev-audio-out/jev-audio-out native/jev-audio-out/main.swift 2>&1 | grep "error:" && exit 1
codesign -f -s - -i com.jev.audio-out native/jev-audio-out/jev-audio-out 2>/dev/null
echo "ok"

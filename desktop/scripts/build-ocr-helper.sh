#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DESKTOP_DIR=$(dirname "$SCRIPT_DIR")
OUTPUT_DIR="$DESKTOP_DIR/bin"
SOURCE="$DESKTOP_DIR/native/manga-sub-ocr.swift"

mkdir -p "$OUTPUT_DIR"

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

xcrun swiftc -O -target arm64-apple-macos13.0 "$SOURCE" -o "$TEMP_DIR/manga-sub-ocr-arm64"
xcrun swiftc -O -target x86_64-apple-macos13.0 "$SOURCE" -o "$TEMP_DIR/manga-sub-ocr-x86_64"
lipo -create "$TEMP_DIR/manga-sub-ocr-arm64" "$TEMP_DIR/manga-sub-ocr-x86_64" -output "$OUTPUT_DIR/manga-sub-ocr"
chmod 755 "$OUTPUT_DIR/manga-sub-ocr"

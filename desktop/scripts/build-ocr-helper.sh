#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DESKTOP_DIR=$(dirname "$SCRIPT_DIR")
OUTPUT_DIR="$DESKTOP_DIR/bin"
SOURCE="$DESKTOP_DIR/native/manga-sub-ocr.swift"
CREDENTIAL_SOURCE="$DESKTOP_DIR/native/manga-sub-credentials.swift"
TRANSLATION_SOURCE="$DESKTOP_DIR/native/manga-sub-translation.swift"

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

xcrun swiftc -O -target arm64-apple-macos13.0 "$CREDENTIAL_SOURCE" -framework Security -o "$TEMP_DIR/manga-sub-credentials-arm64"
xcrun swiftc -O -target x86_64-apple-macos13.0 "$CREDENTIAL_SOURCE" -framework Security -o "$TEMP_DIR/manga-sub-credentials-x86_64"
lipo -create "$TEMP_DIR/manga-sub-credentials-arm64" "$TEMP_DIR/manga-sub-credentials-x86_64" -output "$OUTPUT_DIR/manga-sub-credentials"
chmod 755 "$OUTPUT_DIR/manga-sub-credentials"

xcrun swiftc -O -parse-as-library -target arm64-apple-macos26.0 "$TRANSLATION_SOURCE" -framework NaturalLanguage -framework Translation -o "$TEMP_DIR/manga-sub-translation-arm64"
xcrun swiftc -O -parse-as-library -target x86_64-apple-macos26.0 "$TRANSLATION_SOURCE" -framework NaturalLanguage -framework Translation -o "$TEMP_DIR/manga-sub-translation-x86_64"
lipo -create "$TEMP_DIR/manga-sub-translation-arm64" "$TEMP_DIR/manga-sub-translation-x86_64" -output "$OUTPUT_DIR/manga-sub-translation"
chmod 755 "$OUTPUT_DIR/manga-sub-translation"

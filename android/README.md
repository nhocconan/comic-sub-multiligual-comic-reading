# Manga Sub Reader for Android

Native Android embedded reader with a hardened `WebView`, per-device target
language, current/snapshot translation, immutable broker jobs, history/resume,
private-session cleanup, research consent, and an optional ML Kit on-device text
translation stage.

Copyright © 2026 [nhocconan](https://x.com/nhocconan). Android testing access is
invitation-only; contact the author to be added to the testing track.

## Build

```bash
cd android
./gradlew test assembleDebug
```

The debug APK is emitted at
`app/build/outputs/apk/debug/app-debug.apk`.

The default broker endpoint is `http://10.0.2.2:4100` for the Android emulator.
On a physical phone, open **Settings → Translation route** and use an HTTPS
endpoint or a private-LAN address. The app refuses public cleartext endpoints.

OCR runs locally with bundled ML Kit Text Recognition v2 for Chinese. The
on-device route also translates locally; the private-server and Manga Sub Cloud
routes send only recognized text plus source-image coordinates. Comic pixels,
chapter URLs, cookies, and reading history stay on the device. ML Kit downloads
the selected translation language model on Wi-Fi before first use.

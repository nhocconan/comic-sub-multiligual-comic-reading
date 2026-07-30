# Comic Sub Reader for Android

Native Android embedded reader with a hardened `WebView`, per-device target
language, current/snapshot translation, immutable broker jobs, history/resume,
private-session cleanup, research consent, and an optional ML Kit on-device text
translation stage.

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

“On device” is deliberately labelled **translation on device · OCR on server**:
the app never implies that the whole image pipeline is local when only ML Kit
translation runs locally. ML Kit downloads the selected language model on Wi-Fi
before first use.

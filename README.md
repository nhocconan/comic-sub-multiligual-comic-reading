# Manga Sub

Manga Sub is a translation-native comic reader. It keeps the original chapter
inside an embedded browser, translates the pages you choose, and puts the
translated text back over the artwork without downloading or republishing the
chapter.

Copyright © 2026 [nhocconan](https://x.com/nhocconan).

## Download the latest desktop build

- [macOS universal DMG](https://github.com/nhocconan/comic-sub-multiligual-comic-reading/releases/latest/download/Manga-Sub-mac-universal.dmg)
- [Windows x64 installer](https://github.com/nhocconan/comic-sub-multiligual-comic-reading/releases/latest/download/Manga-Sub-win-x64.exe)
- [All releases and checksums](https://github.com/nhocconan/comic-sub-multiligual-comic-reading/releases/latest)

The Windows installer is built in GitHub Actions and is published only when the
repository's Windows signing certificate secrets are present. The macOS build
is built and signed with the maintainer's local Developer ID certificate before
its release asset is uploaded.

Android and iOS builds are not public downloads yet. Contact
[nhocconan](https://x.com/nhocconan) to be added to the Android or TestFlight
iOS testing invitation.

## What you get

### Embedded reader

- Open any HTTP(S) comic chapter in the desktop reader.
- Translate the current viewport or all discovered comic images.
- Keep reading on the original site while Manga Sub processes the queue.
- Use the licensed sample chapter to try the interface without sending data.

### Three explicit translation routes

- **On this Mac:** local OCR and Apple Translation; comic images stay on the
  device.
- **Manga Sub Cloud:** local OCR, then recognized text and coordinates go to the
  managed broker over HTTPS.
- **Your API key:** local OCR and a provider you configure. Keys stay in the
  operating system credential store.

The app shows the route and resolved model in a job receipt. It never silently
switches from a route you approved to cloud processing.

### Reading continuity

- Library history stores a local resume anchor so you can continue a chapter.
- Private sessions clear cookies, cache, and progress when you leave.
- Local Continuity Memory keeps approved names and glossary terms consistent.
- Translation text and OCR positions can be cached; comic images are not saved.

### Companion surfaces

- Chrome/Chromium extension for the original compatibility workflow.
- iOS/iPadOS Safari Web Extension using the same extension sources.
- Native Android reader with ML Kit OCR and optional on-device translation.
- Local Node.js broker for desktop, iOS, and Android clients.

## Install and run locally

Requirements: Node.js 22+, a configured Koharu instance for real translation,
and Xcode/Android Studio only when building the mobile targets.

```bash
git clone https://github.com/nhocconan/comic-sub-multiligual-comic-reading.git
cd comic-sub-multiligual-comic-reading
npm install
```

Start the local services with `start.command` or run the pieces separately:

```bash
npm start --prefix desktop
npm start --prefix services/broker
```

The desktop app defaults to a local broker at `http://127.0.0.1:4100`. For a
remote deployment, use an HTTPS endpoint and an optional Bearer token. See
[`docs/REMOTE_SERVER.md`](docs/REMOTE_SERVER.md).

Open a chapter URL, choose a translation route, then press **Translate current
view** or **Translate all loaded images**. The app keeps the original page
visible while translated regions are attached to the matching image.

## Build the apps

```bash
# Full JavaScript, protocol, broker, and desktop test suites
npm run verify

# Installable desktop package for the current host
npm run dist:mac --prefix desktop   # macOS, signed by the local keychain
npm run dist:win --prefix desktop   # Windows, signed in GitHub Actions

# Android debug build
(cd android && ./gradlew test assembleDebug)

# iOS Simulator build
xcodebuild \
  -project "apple/Manga Sub/Manga Sub.xcodeproj" \
  -scheme "Manga Sub" \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination "platform=iOS Simulator,name=iPhone 17 Pro,OS=26.4" \
  CODE_SIGNING_ALLOWED=NO build
```

The Windows release workflow is
[`.github/workflows/release-desktop.yml`](.github/workflows/release-desktop.yml).
Set `WINDOWS_CSC_LINK` to a base64-encoded `.p12` certificate and
`WINDOWS_CSC_KEY_PASSWORD` in GitHub Actions secrets. The workflow refuses to
publish an unsigned installer.

## Project map

| Surface | Location | Purpose |
| --- | --- | --- |
| Desktop reader | `desktop/` | Electron embedded reader and installable macOS/Windows builds |
| Browser extension | `extension/` | Click-activated Chrome/Chromium translation workflow |
| Apple app | `apple/` | iOS/iPadOS container and Safari Web Extension |
| Android app | `android/` | Hardened WebView reader with local OCR |
| Broker | `services/broker/` | Immutable jobs, receipts, and Koharu adapter |
| Shared logic | `packages/` | Domain and protocol contracts |

## Privacy, copyright, and scope

Manga Sub is designed for personal, ephemeral reading overlays. It does not
crawl links, download chapters, export translated pages, or republish comics.
Detection and OCR run on the selected Koharu host. With a remote host, comic
page images are uploaded there over HTTPS. A cloud provider receives OCR text,
not the comic image. Check the source site's terms and copyright rules before
using any translation route.

The included sample is licensed for interface testing only. It is not a grant
to copy or redistribute a chapter.

## Documentation

- [Product and architecture plan](docs/EMBEDDED_READER_PRODUCT_PLAN.md)
- [Architecture decisions](docs/ARCHITECTURE.md)
- [PRD and release gates](docs/PRD.md)
- [Remote server guide](docs/REMOTE_SERVER.md)
- [iOS/Safari build and TestFlight guide](docs/IOS_SAFARI.md)
- [Verification record](docs/VERIFICATION.md)
- [Research notes](docs/RESEARCH.md)

## Credits

Manga Sub is copyrighted by [nhocconan](https://x.com/nhocconan). The project
uses Koharu, Playwright, ML Kit, Electron, and the other open-source components
listed in the linked documentation. Their licenses remain with their authors.

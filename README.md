# Comic Sub

Comic Sub is a cross-platform comic browser with translation built into the
reader. Paste a chapter URL into the macOS, iOS, or Android app, browse normally,
then translate the visible page or every discovered page. The original site
remains inside a hardened web view; translated regions are attached as
accessible overlays.

The browser extension remains available as a compatibility surface. The native
apps are the primary product: they own server/model settings, target-language
selection, private sessions, reading history/resume, job receipts, and automatic
per-series terminology continuity.

Baozimh is one verification fixture, not a hard-coded supported-site list.

This repository is a functional engineering baseline, not an unsupported “SOTA”
claim. The quality benchmark required for that claim is in
[`docs/PRD.md`](docs/PRD.md).

## Design

- Generic runtime discovery covers normal, lazy-loaded, and AMP-style images.
- Work begins only after a click on the extension for the current tab.
- The fast reading path uses comic text detection, PaddleOCR-VL, and an LLM.
- The visible page is processed first, followed by the pages ahead of it.
- Detection, Chinese OCR, and translation run locally through
  [Koharu](https://github.com/mayocream/koharu).
- Provider API keys remain in Koharu's OS credential store.
- Region results are cached by source-byte hash and quality settings.

## Apps

- **macOS:** packaged Electron reader under `desktop/`, with embedded browser,
  current/all translation, settings, history, private sessions, and an OS
  credential-store token.
- **iOS/iPadOS:** native `WKWebView` reader under `apple/`. It defaults to
  `https://comic-be.dep.app`, discovers a Mac broker over Bonjour, and can use
  Apple Translation for the text stage when a language pack is installed.
- **Android:** native hardened `WebView` reader under `android/`. It defaults to
  the production broker and can use on-device ML Kit translation.
- **Broker:** immutable snapshot/job service under `services/broker/`. It pins
  Gemini 3.6 Flash by default, verifies the actual model receipt, and keeps
  Koharu's process-global model setting behind a serialized server boundary.

Public terminology research is opt-in per series. After the first successful
page, Comic Sub keeps local continuity and can research public names via
Wikidata, target-language Wikipedia, and AniList. A researched character name
becomes active only after it literally appears in local OCR; other results stay
quarantined.

## Install

### 1. Start everything

Copy `.env.example` to `.env`, add a Gemini or DeepSeek key, and leave
`RUNTIME_MODE=auto` unless you want to force a backend. Then double-click:

```text
start.command
```

`auto` selects native Koharu on Apple Silicon for Metal acceleration and Docker
Compose elsewhere. `native` and `docker` force either mode. The runtime exposes:

```text
http://127.0.0.1:4000/api/v1
http://127.0.0.1:4100
```

The first clean-render run downloads detector, OCR, segmentation, font,
inpainting, and renderer assets. Docker uses the official Koharu 0.61.2 image
pinned by digest and persistent model/credential volumes. That image is
`linux/amd64` and was verified to exit with illegal-instruction status 132 under
Apple Silicon emulation, so the start script rejects Docker mode on ARM instead
of entering a restart loop. Use native mode with Metal on M-series Macs.

`start.command` starts Koharu and the real Broker adapter. It refuses to report
ready if port 4100 contains the explicit test adapter. Double-click
`stop.command` to stop both. Docker model and credential volumes are preserved.

Security note: Koharu exposes a permissive unauthenticated loopback API. The
Compose port is bound to `127.0.0.1` only. Stop it when not translating.

### 2. Run an app

```bash
npm start --prefix desktop
cd android && ./gradlew assembleDebug
```

Open `apple/Manga Sub/Manga Sub.xcodeproj` for iOS. Signed internal builds use
the existing project team and bundle identifier.

### 3. Load the optional extension

#### Chrome on desktop

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select
   `/Users/Shared/TienLe-Data/Workspace/AI-Dev/Online-comic-translation/extension`.
5. Pin **Comic Sub**.

#### Safari on iPhone and iPad

Open the Xcode project under `apple/Manga Sub/`. The containing iOS app and
Safari Web Extension share the exact desktop WebExtension sources; only the
native wrapper is Apple-specific. See
[`docs/IOS_SAFARI.md`](docs/IOS_SAFARI.md) for simulator, device signing,
TestFlight, enabling, and permission steps.

### 4. Read

1. Paste any HTTP(S) chapter URL into Comic Sub.
2. Choose a target language and processing route.
3. Press **Dịch phần đang đọc** or **Dịch tất cả**.
4. Keep scrolling; history stores a resilient resume anchor outside Private
   Session.
5. Inspect the job receipt to verify route, provider, and resolved model.

No chapter download/export is offered. Image bytes are fetched only for local
processing of registered candidates in the activated tab.

## Settings

- **Koharu API:** local HTTP(S), or a remote HTTPS endpoint.
- **Auth key:** optional Bearer token for a remote reverse proxy. Provider API
  keys remain stored only on the Koharu host.
- **Target:** Vietnamese by default.
- **Provider/model:** read dynamically from the running Koharu catalog; the
  selected provider must already have its API key configured in Koharu.
- **Look-ahead:** number of likely comic pages below the viewport to queue.
- **Glossary:** names and terminology to preserve consistently.

Changing a quality-affecting setting creates a new cache key.

### Remote Koharu

The extension accepts a remote endpoint such as:

```text
https://comic-be.dep.app/api/v1
```

Native apps use the Broker root instead:

```text
https://comic-be.dep.app
```

The gateway routes `/v1/*` to Comic Sub Broker and keeps `/api/v1/*` for the
legacy extension/Koharu API.

Enter an optional auth key in the popup. Comic Sub sends it as:

```text
Authorization: Bearer YOUR_KEY
```

Remote plain HTTP is rejected. Keep Koharu itself bound to `127.0.0.1` on the
server and expose it only through a TLS reverse proxy. See
[`docs/REMOTE_SERVER.md`](docs/REMOTE_SERVER.md) for a Caddy example and key
generation.

### Choosing a translation provider

The cloud provider receives OCR text, not the comic image.

- **Gemini:** best zero-cost starting point. Google offers a free API tier for
  selected models, subject to account, model, region, and changing rate limits.
  Free-tier content may be used to improve Google products. Start with Flash;
  try Flash Lite when cost and quota matter most.
- **DeepSeek:** strongest budget paid option in the current Koharu catalog.
  Start with **DeepSeek V4 Flash** for ordinary dialogue translation; use V4 Pro
  only when a quality comparison justifies its extra cost. Comic Sub does not
  claim that the DeepSeek API is free.
- **OpenAI / Claude:** retained as quality bake-off choices, not required for
  the default reading path.

Pricing and quota change frequently; check the
[official Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing),
[Gemini rate-limit page](https://ai.google.dev/gemini-api/docs/rate-limits), and
[official DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing)
before a long reading session.

## Development

```bash
cd /Users/Shared/TienLe-Data/Workspace/AI-Dev/Online-comic-translation
npm install
npm run verify
```

The test suite uses a synthetic comic reader and a local mock Koharu API. It does
not consume a provider key. A real quality run additionally requires configured
Koharu models and a provider.

## Privacy and copyright

Comic Sub is designed for personal, ephemeral reading overlays. It does not
crawl links, download chapters, export translated pages, or republish comics.
Detection and OCR run on the selected Koharu host. With a remote Koharu, comic
page images are uploaded to that server over HTTPS. When a cloud translator is
selected, Koharu also sends OCR text to that provider.

## Research

- [Koharu](https://github.com/mayocream/koharu)
- [comic-translate](https://github.com/ogkalu2/comic-translate)
- [manga-image-translator](https://github.com/zyddnys/manga-image-translator)
- [Context-Informed Machine Translation of Manga (COLING 2025)](https://aclanthology.org/2025.coling-main.232/)
- [Chrome optional permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Chrome cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [Playwright extension testing](https://playwright.dev/docs/chrome-extensions)

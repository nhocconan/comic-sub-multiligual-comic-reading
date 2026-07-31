# Verification record

Date: 2026-07-29  
Platform: Apple M1 Pro, macOS arm64  
Extension: Manga Sub 0.1.0
Companion contract: Koharu 0.61.2

## Automated checks

| Check | Result |
| --- | --- |
| Node unit tests | 27/27 pass |
| Manifest/security static checks | Pass |
| Runtime shell/Compose static checks | Pass |
| JavaScript syntax checks | Pass |
| Playwright unpacked-extension E2E | Pass |
| Apple Safari Web Extension converter | Pass, no API/icon warnings |
| iPhone 17 Pro simulator build/launch | Pass |
| iPad Pro 13-inch simulator build/launch | Pass |
| Generic iOS ARM64 Release build | Pass |
| Remote Caddy Compose/static shell checks | Pass |
| Live Baozimh smoke with mock translator | Pass |
| npm audit | 0 known vulnerabilities |

The synthetic E2E uses a normal image, a `<picture>`, an AMP-like custom host, a
lazy inserted page, and logo/banner/recommendation negatives. It verifies:

- 4 comic candidates in DOM order;
- one in-flight translation pipeline;
- responsive clean rendered-page layers at desktop and 375 px;
- zero `.bb-region` translucent cards;
- rendered-layer opacity `1`, filter `none`, and transparent root;
- zero changed sampled pixel channels when the mock rendered page equals source;
- unchanged source `src`/`data-src` attributes;
- source reveal;
- cache hit after reload with zero additional successful provider pipelines;
- deterministic pipeline failure leaves the fifth image untouched;
- retry produces the missing rendered page;
- the live Koharu-style catalog exposes both Gemini and DeepSeek, switching to
  DeepSeek V4 Flash updates the model guidance, and switching back preserves the
  default Gemini selection.

The live smoke uses the requested Baozimh chapter and a deterministic mock
translator. A temporary test-only manifest copy grants the two fixture origins;
the production manifest remains click-scoped and optional-permission based.

Verified live:

- exactly 9 comic candidates;
- exactly 9 rendered-page layers;
- no source attribute mutation;
- alignment at 1280 px desktop and 375 px mobile;
- desktop and mobile screenshots visually inspected.

Screenshots:

- `test-results/live-baozimh-desktop.png`
- `test-results/live-baozimh-mobile.png`
- `test-results/real-koharu-source.jpg`
- `test-results/real-koharu-clean-render.png`
- `test-results/ios-container-iphone.png`
- `test-results/ios-container-ipad.png`

## Apple platform check

Xcode 26.4 converted the shared `extension/` package to an iOS-only Safari Web
Extension project. The Xcode target keeps direct references to the desktop
JavaScript, CSS, manifest, icons, and core library, so mobile is not a fork.

- App bundle ID: `com.tienle.comicsub`
- Extension bundle ID: `com.tienle.comicsub.Extension`
- The embedded extension passed Xcode binary validation.
- `pluginkit` registered the Safari extension on both iPhone and iPad
  simulators.
- The containing app launched and its Vietnamese enable/configuration guide was
  visually inspected at phone and tablet sizes.
- The production device target built for ARM64 in Release mode with signing
  disabled; real-device/TestFlight installation now needs only the owner's
  Apple team and provisioning.
- Safari-specific internal sender URLs are accepted while ordinary web URLs
  remain rejected, covered by unit tests.

## Real Koharu check

The official arm64 Koharu 0.61.2 binary was started on loopback and its live API
was inspected:

- `/meta` returned version `0.61.2`;
- `/engines` included `comic-text-bubble-detector`,
  `paddle-ocr-vl-1.6`, and `llm`;
- `/llm/catalog` included Gemini, OpenAI, Claude, and DeepSeek; the pinned
  DeepSeek catalog contains V4 Flash, V4 Pro, Chat, and Reasoner;
- project creation, multipart page upload, and wrapped `/scene.json` response
  matched the adapter after a wrapper bug found by E2E was fixed;
- detector + PaddleOCR-VL 1.6 ran on page 1 of the requested chapter and produced
  7 Chinese text regions with confidences from approximately 0.935 to 0.965.
- the full clean-render pipeline ran on the same 800 × 1133 source page:
  `comic-text-bubble-detector`, `comic-text-detector-seg`,
  `speech-bubble-segmentation`, `yuzumarker-font-detection`,
  `paddle-ocr-vl-1.6`, `llm`, `lama-manga`, and `koharu-renderer`;
- a local deterministic OpenAI-compatible test translator returned seven tagged
  Vietnamese strings without using a cloud key;
- the operation completed and exported a valid 800 × 1133 RGBA PNG;
- visual inspection confirmed Chinese dialogue glyphs were removed from speech
  bubbles, Vietnamese was typeset into those bubbles, and panel artwork/SFX
  remained visible without bounding-box cards.

The temporary verification project was deleted, the provider config was restored
to an empty list, and both local test servers were stopped.

## Runtime lifecycle

- The official Docker image was pinned by version and digest and its Compose
  configuration validated.
- The image pulled successfully but repeatedly exited with status 132 under
  `linux/amd64` emulation on Apple M1. The start script now rejects Docker mode
  on ARM instead of allowing a restart loop.
- The same one-click workflow was exercised in native mode against Koharu 0.61.2:
  start, `/meta` readiness, and stop all succeeded. `auto` selects this Metal
  path on Apple Silicon.

Both temporary Koharu projects were deleted and the test server was stopped.
Downloaded detector/OCR model files remain in Koharu's normal model cache so a
future real run does not need to fetch them again.

## Not yet verified

- Real cloud-provider Chinese-to-Vietnamese output: no provider API key was
  available. The full visual pipeline was verified with deterministic local
  Vietnamese strings, not used as a linguistic-quality claim.
- The 30-page blind translation-quality bake-off required for a “SOTA” claim.
- Full-reload/same-origin automatic activation on every next chapter.
- Native Chrome optional-permission denial prompt and a real companion-offline
  walkthrough. Mock failure/retry is covered.
- CSS-background, canvas, or WebGL comic readers; v1 intentionally handles DOM
  image sources only.

## Checklist scope

The corrected project root did not contain an `AGENTS.md` or `CHECKLIST.md`. The
LMS checklist from the mistakenly selected original workspace is not applicable;
no LMS files remain changed. Manga Sub's own PRD gates and `docs/TEST_PLAN.md`
were used instead.

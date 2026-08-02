# Progress

Copyright © 2026 [nhocconan](https://x.com/nhocconan)

## Research and product

- [x] Inspect a real Baozimh chapter DOM, lazy loading, CORS, CSP, and navigation.
- [x] Compare MangaLens, Comic Translate, manga-image-translator, and Koharu.
- [x] Run independent architecture and product-risk reviews.
- [x] Write the initial PRD, acceptance gates, and quality rubric.
- [x] Correct the workspace and record the implementation handoff.
- [x] Revise the product to generic, click-activated image discovery.
- [x] Prototype translucent region overlays, visually reject them, and replace
  them with clean rendered pages.

## Extension

- [x] Create a least-privilege, website-agnostic Manifest V3 package.
- [x] Package the shared WebExtension as an iOS/iPadOS Safari Web Extension.
- [x] Build and launch the containing app on iPhone and iPad simulators.
- [x] Validate an unsigned Release ARM64 device build for later signing.
- [x] Implement deterministic generic discovery and progressive queueing.
- [x] Implement per-tab candidate registration and exact-origin validation.
- [x] Implement Koharu health, project, upload, pipeline, polling, and scene
  parsing.
- [x] Implement SHA-256 versioned region cache and bounded LRU eviction.
- [x] Implement responsive clean rendered-page layers, source reveal, retry,
  exclusion, pause, and status UI.
- [x] Implement restrained popup settings, language, glossary, and provider/model
  selection.
- [x] Promote Gemini and DeepSeek to first-class text-only translation options.
- [x] Populate provider/model choices from Koharu's live catalog, with offline
  budget presets and no API-key storage in the extension.

## Verification

- [x] Unit-test discovery scores, deduplication, URL/origin validation, cache keys,
  clean-render pipeline payloads, scene parsing, and geometry.
- [x] Run manifest/security static checks.
- [x] Run Playwright extension E2E against a mock Koharu API.
- [x] Exercise dynamic Gemini/DeepSeek catalog switching in extension E2E.
- [x] Verify Baozimh plus a structurally different synthetic fixture.
- [x] Walk through desktop, 375 px mobile, cache-hit, failure, and retry states.
- [x] Verify the pinned Koharu binary and run real detector + Chinese OCR on one
  Baozimh page.
- [ ] Verify full navigation lifecycle, permission denial, and companion-offline
  states in real Chrome UI.
- [x] Record verification results and non-applicable checklist items.
- [x] Validate Apple conversion, app/extension bundle IDs, embedded resources,
  plugin registration, and responsive iPhone/iPad containing-app layouts.
- [x] Build and upload a public unsigned Windows installer from GitHub Actions,
  with a SHA-256 sidecar and first-launch SmartScreen guidance.
- [ ] If a trusted Windows signature becomes necessary later, evaluate a
  qualifying signing service without changing the unsigned-source build path.

## Quality work after functional v1

- [x] Replace the rejected translucent-card renderer with Koharu segmentation,
  LaMa Manga inpainting, and comic-aware rendered-page typesetting.
- [x] Add pixel-integrity assertions proving there is no full-page tint or card.
- [x] Package pinned Koharu in Docker Compose with one-click start/stop scripts
  and a native Metal option for Apple Silicon.
- [x] Add remote HTTPS Caddy deployment, generated Bearer auth, and shared
  desktop/mobile endpoint configuration.
- [ ] Build the 30-page Chinese-to-Vietnamese golden set.
- [ ] A/B at least three translation models on identical OCR input.
- [ ] Add optional page-image context with explicit privacy consent.
- [ ] Add low-confidence OCR review and chapter glossary memory.
- [ ] Benchmark optional text removal/inpainting and comic-aware typesetting.
- [ ] Put an authenticated proxy in front of Koharu before store publication.

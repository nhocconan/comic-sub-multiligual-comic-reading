# Handoff — Online Comic Translation

Copyright © 2026 [nhocconan](https://x.com/nhocconan)

## Product direction

Build a website-agnostic Chromium extension for reading comics online:

- discover comic-like images that are already present or progressively loaded
  in the browser;
- translate Chinese to Vietnamese by default, with selectable languages;
- never require the reader to download a chapter;
- process pages on demand as the reader scrolls;
- preserve the original page and artwork;
- remove Chinese lettering inside segmentation masks and typeset Vietnamese into
  bubble-safe regions as the required reading mode;
- never use translucent bounding-box cards as a production fallback;
- use page/chapter context, glossary, image hashing, and cache to improve
  consistency and avoid repeated work;
- never store provider API keys in the extension; use a local companion such as
  Koharu or a narrowly authenticated local service.

Baozimh is a real-world verification fixture, not a hard-coded site adapter.
The extension must also support generic pages through runtime image discovery
and an explicit user action/permission model.

## Research completed

- MangaLens is convenient but closed and credit/subscription based.
- `ogkalu2/comic-translate` has a comic-specific detection/OCR pipeline,
  but its browser extension is a separate paid product.
- `zyddnys/manga-image-translator` is broad and capable but operationally heavy.
- Koharu is the local-first companion selected for this project because it has:
  comic detectors, PaddleOCR-VL, translation, inpainting, rendering, Metal
  support, and a local HTTP API.
- Current manga-MT research supports translating with page-level text and image
  context rather than isolated text bubbles.
- No independent Chinese-to-Vietnamese benchmark ranks the candidates. A
  benchmark corpus and human quality rubric are required before publishing a
  quality comparison.

## Implementation status

Completed:

- generic click-activated image discovery and progressive queueing;
- Koharu detector, PaddleOCR-VL, and text-only LLM pipeline integration;
- clean rendered-page layers, reveal, pause, retry, exclusion, cache, language,
  and glossary controls;
- Koharu text/bubble segmentation, LaMa Manga cleanup, and comic-aware
  Vietnamese typesetting;
- one-click `start.command` / `stop.command` with native Metal and pinned Docker
  Compose runtime modes;
- dynamic Koharu provider/model catalog with Gemini and DeepSeek options
  budget guidance;
- Node, manifest/security, Playwright extension, and live Baozimh smoke tests;
- a real Koharu 0.61.2 detector/OCR run on one Baozimh page.

Still required before publishing a linguistic quality comparison:

- a 30-page Chinese-to-Vietnamese golden set;
- blind human comparison of at least three provider/model choices;
- a real provider-backed run (no provider API key was available during the
  implementation session);
- the remaining native Chrome permission-denial/offline/navigation walkthroughs
  listed in `TASKS.md`.

## Next quality order

1. Configure Gemini and DeepSeek keys in Koharu without copying them into the
   extension.
2. Build and annotate the golden set.
3. Benchmark Flash/Lite, DeepSeek V4 Flash/Pro, and one additional paid model on
   identical OCR input.
4. Add optional image context only if the text-only benchmark proves it is
   needed and the reader explicitly accepts the privacy tradeoff.
5. Tune cleanup masks, font choice, and typesetting only against the golden-set
   visual rubric; keep the rendered layer instantly reversible.

## Windows release

The Windows workflow builds on GitHub-hosted Windows, verifies the installer is
unsigned, writes a SHA-256 sidecar, and uploads both assets to the matching
GitHub release. Users are given checksum and SmartScreen/Unblock guidance in
the README and `docs/WINDOWS_SIGNING.md`. Trusted signing is optional; this
public source repository remains buildable without it.

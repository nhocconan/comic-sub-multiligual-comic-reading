# PRD — Manga Sub

Copyright © 2026 [nhocconan](https://x.com/nhocconan).

Status: implementation baseline  
Date: 2026-07-29

## Problem

Online comic readers often publish incomplete or badly ordered translations. A
reader should be able to stay on the original website and see Vietnamese text
over the comic pages already loaded in the browser. They should not need to
download, export, or republish a chapter.

## Product promise

Open a comic page on any ordinary Chromium-accessible website, click Manga Sub,
and keep scrolling. The extension finds likely comic images as they load, sends
only those image bytes to a local processing companion, removes the detected
Chinese lettering, and typesets Vietnamese back into the corresponding bubbles.
Artwork outside the cleanup mask remains visible and the source image element is
never mutated.

Baozimh is a required real-world fixture, not a hard-coded product boundary.

## Primary user flow

1. The user starts the local companion and configures a translation provider
   there. Provider secrets stay outside the extension.
2. The user opens a comic chapter and clicks Manga Sub.
3. The popup reports the candidate image count and asks for access only to the
   image origins required by that page.
4. Manga Sub translates the visible page and a small look-ahead window.
5. The reader scrolls normally, can reveal the original instantly, exclude a
   false-positive image, retry failures, or pause automatic work.

## Must have

- Activate only after an explicit click on the current tab.
- Discover standard images, lazy-loaded images, and common image custom elements
  at runtime. Do not depend on a website-specific selector.
- Rank conservative comic candidates using rendered/intrinsic size, aspect,
  centrality, repeated dimensions, and DOM order.
- Observe newly inserted or lazy-loaded candidates without crawling links or
  predicting chapter URLs.
- Preserve every source element and its URL. The default result is a rendered
  page layer produced from text segmentation, bubble segmentation, inpainting,
  and comic-aware Vietnamese typesetting.
- Translate progressively with one in-flight page and a configurable look-ahead.
- Detect comic text, OCR Chinese, translate with page-level context, and preserve
  one output region per detected source region.
- Cache the rendered page plus structured regions by source-byte hash and all
  quality-affecting settings. A cache hit must not call the provider.
- A failed or cancelled page must remain readable in its untouched source form.
- Default to Vietnamese while allowing another target language and a glossary.
- Never store a provider API key in extension storage, page DOM, logs, or cache.
- Never offer chapter download/export in the product UI. An internal single-page
  rendered-image response may be used to display the result in place.

## First release rendering mode

The first release uses Koharu's clean-render pipeline:

1. detect text boxes and OCR them;
2. segment text pixels and speech-bubble interiors;
3. translate all page text in reading order;
4. remove source lettering with LaMa Manga inside the expanded text mask;
5. typeset translated text with Koharu's comic renderer;
6. place the rendered bitmap exactly above the untouched source image.

The previous translucent bounding-box prototype is rejected as a production
mode. A bounding box often includes faces, artwork, or most of a panel; covering
it with an opaque or translucent card fails the basic reading goal.

## Non-goals for v1

- Crawling, downloading, exporting, or republishing chapters.
- Fixing missing or misordered pages on the source website.
- Translating navigation, advertisements, recommendations, or site chrome.
- CSS-background and canvas/WebGL comic readers whose source pixels cannot be
  acquired safely.
- Automatically granting access to every website or image origin.
- Claiming translation-quality leadership without a Chinese-to-Vietnamese
  benchmark.

## Generic image eligibility

A candidate must be a rendered image-like element with a resolvable HTTP(S)
source and a substantial reading area. The initial scoring model considers:

- minimum rendered and intrinsic dimensions;
- portrait/page-like aspect ratio, while allowing long webtoon strips;
- proximity to the horizontal reading column;
- repeated width or shared parent with other large images;
- exclusion signals such as tiny icons, avatars, logos, and hidden elements.

The UI shows the candidate count and permits manual exclusion. Heuristics may
miss unusual readers; a later region-picker can cover canvas and background-image
sites without weakening the default permission boundary.

## Release gates

### Integration

- The Baozimh fixture discovers its 9 ordered pages and no recommendations.
- A structurally different synthetic fixture discovers only its intended comic
  images, including one lazy-loaded image.
- DOM insertion and same-tab navigation rebuild the queue without duplicate work.
- Every image is processed at most once for a cache key.
- Refreshing a completed page performs zero provider translation calls.

### Visual integrity

- The rendered page remains pixel-aligned at desktop and 375 px mobile widths.
- Original image attributes and decoded pixels remain unchanged.
- Original reveal responds in under 100 ms.
- Chinese glyph pixels are absent inside successfully processed cleanup masks.
- Vietnamese text stays inside the detected bubble safe area unless the source
  itself has text over artwork.
- Pixels outside the cleanup/rendered-text regions have no visible full-page
  tint, card, blur, or opacity change.

### Reliability and performance

- 99% completion without an extension crash in a 100-run mock test.
- Warm-model first-render targets: under 60 seconds on accelerated hardware and
  under 180 seconds on CPU. First-run model downloads are reported separately.
- At least 90% of next pages are ready before entering the viewport with default
  look-ahead.
- Pausing, navigating, or closing a tab stops further queue work.

### Quality benchmark

Before using “SOTA” as a release claim, evaluate at least 30 annotated
Chinese-comic pages, expanding to 100 for public release. Include normal dialogue,
narration, small text, vertical text, stylized SFX, colored bubbles, and text over
artwork.

Score:

- Meaning/adequacy: 25
- Natural Vietnamese: 15
- OCR completeness: 15
- OCR fidelity: 10
- Context, speaker, and tone: 10
- Terminology/name consistency: 7.5
- Reading order and region mapping: 5
- Cleanup and typesetting readability: 7.5
- Non-text preservation: 5

Pass is at least 90/100 with zero critical errors: omitted/swapped dialogue,
invented plot facts, meaning-changing speaker errors, artwork mutation, key
leakage, or wrong page order.

## Current evidence

- The Baozimh fixture exposes 9 ordered comic images and supports independent
  cross-origin byte fetches.
- Chromium extension APIs support click-scoped page injection and origin-scoped
  optional permissions; broad permanent website access is unnecessary.
- Koharu exposes comic detection, text/bubble segmentation, PaddleOCR-VL, LLM
  translation, LaMa Manga inpainting, comic typesetting, rendered PNG export,
  and structured scene data through a local HTTP API.
- COLING 2025 reports that page OCR plus page-image context improves manga
  translation over isolated-bubble translation. This informs the pipeline, but a
  provider bake-off is still required for Chinese-to-Vietnamese.

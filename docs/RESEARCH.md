# Research and architecture debate

Date: 2026-07-29

## User need distilled

- Read on the original website while scrolling.
- Chinese to Vietnamese by default.
- No chapter download/export workflow.
- Preserve layout and artwork; change only readable text presentation.
- Bring-your-own provider is acceptable.
- Website-specific selectors are not an acceptable product boundary.

## Candidate comparison

Scores are engineering judgments for this product, not independent quality
benchmarks. Five is strongest.

| Candidate | In-browser UX | Comic OCR/geometry | Local/privacy | Generic sites | Maintainable base |
| --- | ---: | ---: | ---: | ---: | ---: |
| MangaLens | 5 | 3 | 2 | 4 | 1 |
| comic-translate desktop | 1 | 5 | 4 | 1 | 4 |
| manga-image-translator | 2 | 4 | 4 | 3 | 3 |
| Koharu + thin extension | 5 | 5 | 5 | 5 | 4 |
| Vision API directly in extension | 5 | 2 | 1 | 5 | 3 |

### MangaLens

Closest off-the-shelf reading experience: in-page overlays and little setup. It
is closed, account/credit based, and does not provide the control or independent
Chinese-to-Vietnamese benchmark required here.

### ogkalu2/comic-translate

Strong comic-specialized desktop pipeline: joint comic text/bubble detection,
Chinese OCR, contextual translation, inpainting, and rendering. Its browser
extension is a separate commercial product, while the open repository is a
desktop application rather than a generic reading overlay.

### manga-image-translator

Broad language/provider support and a server/API mode. It is capable, but heavier
to operate and its full rendered-image path is more than the overlay-first release
needs.

### Koharu

Best foundation found for a local companion: native Apple acceleration,
comic-specific detection, PaddleOCR-VL, provider management, and a structured
scene graph exposed over HTTP. Crucially, Comic Sub can stop after detection,
OCR, and translation and render its own reversible text regions.

### Direct multimodal provider

Excellent installation simplicity, but it sends full copyrighted page images to
a cloud service and asks a general model to perform small-text OCR and exact
geometry. It is useful as an opt-in comparison mode, not the default quality and
privacy path.

## Architecture debate

### Position A — build the smallest overlay immediately

Intercept images while scrolling, OCR them, translate all regions on a page, and
draw translucent boxes. Do not spend the first release on inpainting or a perfect
renderer.

This position wins for the initial reading experience. It minimizes ways to
damage artwork and makes failures obvious and reversible.

### Position B — use a full rendered translation pipeline

Detection, OCR, contextual translation, inpainting, and typesetting produce a
more polished comic page and are closer to the strongest desktop tools.

This remains a later optional mode. It costs more compute, introduces artwork
mutation risk, and is unnecessary to prove the online-reading loop.

### Position C — specialize for Baozimh first

An exact selector produces high precision quickly.

Rejected as the core architecture. Baozimh remains a high-value fixture, but the
extension uses click-scoped generic image discovery. A site quirk may receive a
narrow fallback only after the capability-based path fails.

### Position D — run everything inside the extension

This avoids installing a companion but requires shipping large OCR/detector
models through MV3 constraints or sending images and keys to a cloud endpoint.

Rejected for the quality baseline. A local companion cleanly separates browser
UX from fast-moving ML inference.

## Decision

Ship the generic extension on top of Koharu's full clean-render API. The initial
overlay-first prototype was useful for validating discovery and queueing, but
visual QA showed that translucent detector rectangles can obscure entire panels.
It is therefore retired, not retained as a fallback.

Measure the clean-render path:

1. prove conservative discovery on multiple DOM structures;
2. prove scroll-driven rendered-page replacement and cache behavior;
3. prove segmentation/inpainting preserves pixels outside lettering masks;
4. benchmark OCR, translation, cleanup, and typography quality;
5. only then compare optional image context or alternative inpainters.

## Text-only provider strategy

The detector and PaddleOCR-VL run through the local companion. The provider sees
the resulting text, target language, and bounded glossary; it does not need
vision capability. This materially changes the model choice:

| Provider | Best role | Cost conclusion | Product treatment |
| --- | --- | --- | --- |
| Gemini | Zero-cost entry and fast translation | Official free tier exists for selected models; quota, availability, and region vary | First-class, with Flash and Flash Lite choices |
| DeepSeek | Low-cost paid translation | Current V4 Flash token pricing is very low, but the API is not represented as free | First-class, V4 Flash before V4 Pro/reasoning |
| OpenAI | Quality comparison | Paid; exact cost depends on the chosen catalog model | Available for benchmark and preference |
| Claude | Quality comparison | Paid; exact cost depends on the chosen catalog model | Available for benchmark and preference |

DeepSeek Reasoner is not the budget default because long reasoning is usually
unnecessary after comic-specific OCR has already produced ordered dialogue.
Provider and model lists are read from Koharu's live `/llm/catalog`, so a Koharu
upgrade can expose new models without an extension release. Curated presets are
only an offline fallback and annotate the likely budget choices.

Privacy caveat: Google's official pricing page states that free-tier content may
be used to improve its products, while paid-tier content is not. Readers who do
not accept that tradeoff should use a paid tier or another provider.

## What “state of the art” can honestly mean

The architecture combines current strong components, but “SOTA
Chinese-to-Vietnamese comic translation” is a benchmark result, not a design
adjective. Public release language must wait for the annotated corpus and model
bake-off in the PRD. Until then, the defensible claim is “local-first,
comic-specialized, context-aware, and non-destructive.”

## Primary references

- [Koharu](https://github.com/mayocream/koharu)
- [comic-translate](https://github.com/ogkalu2/comic-translate)
- [manga-image-translator](https://github.com/zyddnys/manga-image-translator)
- [Context-Informed Machine Translation of Manga (COLING 2025)](https://aclanthology.org/2025.coling-main.232/)
- [Gemini API pricing and free tier](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing)
- [Chrome extension optional permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Chrome cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [Chrome extension security guidance](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)

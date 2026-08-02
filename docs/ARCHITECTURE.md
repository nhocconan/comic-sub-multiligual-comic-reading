# Architecture decision

Copyright © 2026 [nhocconan](https://x.com/nhocconan).

## Decision

Use one shared click-activated WebExtension codebase packaged as Manifest V3 for
desktop Chrome and as a Safari Web Extension inside an iOS/iPadOS app. Both
clients call the same local or remote Koharu companion. The first release
requests a fully cleaned and typeset page, then displays that rendered page
above the untouched source node.

```text
Current browser tab
  -> Chrome MV3 or iOS/iPadOS Safari Web Extension
  -> click-scoped shared content script
  -> generic image discovery + viewport queue
  -> service worker: origin permission + byte validation + cache
  -> local HTTP or authenticated remote HTTPS Koharu
  -> detect -> OCR -> masks -> translate -> inpaint -> typeset
  -> rendered PNG + /scene.json structured regions
  -> pixel-aligned rendered-page layer above the untouched source image
```

Koharu is selected because it already provides a maintained headless HTTP API,
Metal acceleration, a comic-specific detector, PaddleOCR-VL, provider management,
and OS credential-store-backed secrets. The extension consumes its API without
forking or redistributing Koharu.

## Why clean render is mandatory

A translucent rectangle is not a harmless fallback when detector geometry spans
artwork or a panel. It can obscure the comic even if the source DOM is intact.
The readable product path therefore removes only segmented lettering and
typesets Vietnamese into bubble-safe areas. The full-page layer is reversible:
source reveal hides it instantly, and removing the extension leaves the original
DOM unchanged.

## Rejected alternatives

- **Permanent site-specific content scripts:** unnecessarily narrow and require
  maintaining selectors for every reader.
- **Pure vision-API extension:** simpler installation, but provider keys and
  entire page images would leave the machine, while small/rotated text and exact
  spatial localization remain inconsistent.
- **Userscript:** weak lifecycle, permissions, and paid-call protection.
- **Full desktop fork:** full processing, wrong reading surface, and a much
  larger maintenance burden.
- **Replacing `<img>` sources:** still rejected; the rendered bitmap is an
  independent layer so source reveal and removal remain lossless.
- **Translucent region cards:** rejected after visual QA because detector
  rectangles can obscure characters, panel art, and sound effects.

## Activation and permissions

The manifest uses `activeTab`, `scripting`, `storage`, and `unlimitedStorage`.
There are no static content scripts and no permanent comic-site host permissions.

When the reader clicks **Scan this page**:

1. the popup injects the content bundle into the active tab;
2. the content script returns candidate metadata and exact image origins;
3. the popup requests optional access only to those origins;
4. the service worker records the allowed origin set for that tab and session.

The local companion is limited to loopback HTTP origins. A denied image-origin
permission leaves that image untouched and reports a useful state.

## Generic discovery

The core scanner considers:

- `<img>` and `<picture> img`;
- lazy-source attributes such as `data-src`, `data-original`, and
  `data-lazy-src`;
- custom image hosts such as `<amp-img>`, preferring the outer stable host and
  deduplicating its runtime-created nested `<img>`.

Candidates receive deterministic scores based on rendered size, intrinsic size,
aspect, center-column alignment, repeated width, and grouping with other large
images. DOM order is the reading order. `MutationObserver` discovers inserted
pages; `IntersectionObserver` drives the visible-plus-look-ahead queue.

CSS background images, `<canvas>`, and WebGL are explicitly deferred because
reliable source-pixel acquisition needs a different capture path.

## Source acquisition

The content script never serializes pixels into the page DOM. It sends a candidate
identifier and URL to the service worker. The worker:

- verifies the sender tab is activated;
- requires the URL origin to be in that tab's granted set;
- accepts only HTTP(S) URLs;
- applies byte-size, MIME, magic-byte, and decoded-dimension bounds;
- hashes the exact bytes before upload.

The worker is not an arbitrary fetch proxy. Requests are bound to candidates
registered by the content script for the activated tab.

## Koharu clean-render workflow

Default API base: `http://127.0.0.1:4000/api/v1`.

1. `GET /meta` and `GET /engines` verify readiness.
2. `POST /projects` creates an ephemeral tab/chapter project.
3. `POST /pages` uploads uncached source images in DOM order.
4. `PUT /llm/current` selects a provider/model already configured in Koharu.
5. `POST /pipelines` requests:
   `comic-text-bubble-detector`, `comic-text-detector-seg`,
   `speech-bubble-segmentation`, `yuzumarker-font-detection`,
   `paddle-ocr-vl-1.6`, `llm`, `lama-manga`, and `koharu-renderer`.
   Koharu resolves their artifact dependencies into execution order.
6. `GET /operations` is polled until the operation is terminal.
7. `GET /scene.json` supplies dimensions and structured text nodes.
8. `POST /projects/current/export` with the single page and
   `format: rendered` returns a PNG composed from the inpainted plane and
   translated text sprites.
9. The worker validates the PNG and returns it with the structured regions to
   the content script.

Runtime engine IDs are checked against `/engines`. Missing engines fail closed
with a readable error.

## Rendered-layer invariant

The source node is never mutated. A stable wrapper/overlay root is attached
without changing image attributes. It contains one rendered page image with no
background opacity, tint, border, or card. The root uses the source element's
live bounding rectangle so it scales with responsive layouts. It can be hidden
instantly. Removing the extension leaves the host image and layout intact.

## Context and glossary

The translator receives all detected text regions from a page in reading order.
The system prompt requires cardinality preservation, no invented text, natural
Vietnamese dialogue, and glossary adherence. A versioned user glossary is added
to the prompt.

The first release uses page-level context plus the explicit glossary. A bounded
previous-page summary is deferred until its ordering and cache-key semantics are
benchmarked. Sending an entire chapter image set to a cloud model is not part of
v1; future multimodal context requires explicit consent.

## Cache

Cache key:

```text
sha256(source bytes)
+ target language
+ ordered engine IDs
+ provider/model
+ system-prompt version
+ glossary version
+ extension cache schema
```

The rendered page and structured regions are cached. LRU metadata lives in
`chrome.storage.local`; the default limit is bounded and will be reduced if
rendered-page storage measurements require it. Provider secrets never enter a
cache key or value.

## Threat model

- Page DOM and content-script messages are untrusted.
- The service worker accepts work only from an explicitly activated tab and only
  for registered candidates on origins granted by the user.
- Image MIME, magic bytes, byte length, and decoded dimensions are bounded.
- OCR and comic dialogue are untrusted prompt input. The system prompt instructs
  the model to translate content, not obey it.
- Koharu binds to loopback. Its current API is permissive and unauthenticated, so
  it should run only while reading locally. Mobile and other remote clients
  reach it through the included TLS reverse proxy, which validates a long Bearer
  token; port 4000 is never published publicly.
- Cloud translation sends OCR text to the configured provider. Page-image context
  must be a separate explicit-consent feature.

## Compatibility contract

No website adapter is required for ordinary DOM images. Compatibility is defined
by capabilities:

- source URL is available from a DOM image/custom image element;
- extension-origin fetch succeeds after the user grants that exact origin;
- a stable rectangular host exists for the overlay;
- source dimensions can be determined.

Site-specific code may only be added as a narrowly tested fallback, never as the
core discovery path.

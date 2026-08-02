<!-- /autoplan restore point: /Users/tienle/.gstack/projects/nhocconan-comic-sub-multiligual-comic-reading/autoplan-restores/main-20260730-085144.md -->

# Manga Sub Reader — Product and Architecture Plan

Copyright © 2026 [nhocconan](https://x.com/nhocconan).

Status: final decision artifact and Phase 0 execution contract
Date: 2026-07-30
Decision owner: product owner
Review mode: auto-decide, as explicitly requested

## Executive decision

Build Manga Sub as a translation-native reader with an embedded browser, not as
a generic browser with a translation button.

- Desktop: Electron with an isolated Chromium reader and a managed local Koharu
  sidecar.
- iOS/iPadOS: native Swift/SwiftUI with WKWebView. Keep the Safari extension as
  a compatibility escape hatch, not the primary product.
- Android: native Kotlin/Compose with Android WebView.
- Share schemas, discovery rules, queue semantics, history semantics, and the
  inference protocol. Do not force one UI/WebView framework across platforms.
- Alpha uses one reader session, not a generic multi-tab browser.
- Default translation scope: current viewport plus look-ahead. “Translate all”
  means one explicit candidate snapshot from the loaded document, never
  automatic crawling or silently adding later lazy-loaded images.
- History and exact resume are core product features, not later analytics.
- The durable advantage is private compute portability, exact reading memory,
  series terminology intelligence, reversible rendering, and compatibility
  recovery. An embedded browser alone is already table stakes.

## Premise corrections

1. An embedded browser removes extension-install friction. It does not remove
   privacy risk. The app now holds cookies, browsing state, image bytes, and
   reading history.
2. Shipping native apps does not avoid App Store or Play review.
3. “Translate all” must not become a crawler, downloader, or republisher.
4. Local translation on Apple means the text-translation stage can run on the
   device when the language pair is installed and supported. It does not prove
   that comic OCR, cleanup, and rendering are all local or high quality.
5. A user-authored glossary cannot be an onboarding requirement. The app must
   bootstrap series terminology automatically.

## Product promise

Paste a comic URL, read normally, and tap Translate. Manga Sub remembers the
series, the exact place, the chosen language, the privacy path, and the names
used in previous chapters.

The 30-second 10-star moment is:

> Share or paste a chapter, get the first translated viewport in under ten
> seconds on the target route, then reopen at the exact panel with the same
> names and translation style.

## Initial ICP and quality corridor

V1 is for Vietnamese readers of Chinese-language long-scroll manhua/webcomics
who currently open raw chapter URLs. This corridor matches the existing
Baozimh fixture, Chinese OCR work, Vietnamese glossary, and benchmark direction.

- Primary source: Simplified/Traditional Chinese, auto-detected with override.
- Primary target: Vietnamese, selectable per device.
- Primary format: long-scroll image chapters.
- Paged manga and Korean/Japanese corridors are compatibility targets, not V1
  quality claims. They graduate only after their own golden sets.
- Support for other target languages is availability, not a marketed quality
  promise.

Before implementation, validate this choice with 20 target-user interviews and
10 owned, licensed, or otherwise authorized fixture sites. If a different format
dominates actual use, change the primary fixture set before Phase 1 rather than
building two readers at once.

## Market benchmark and unmet pain

| Product | Current benchmark | Gap Manga Sub should beat |
|---|---|---|
| Mangra | Built-in browser, scroll/whole-chapter translation, background resume/retry, edit bubbles, history/bookmarks/tabs, offline/import/Komga | Exact cross-device resume, clearer cost/data-path receipt, private paired compute, no reader ads |
| Madomi | Browser/mobile reader plus archive/Komga support | Focused comic reading instead of unrelated browser AI feature sprawl |
| EasyComix | Whole-chapter flow, fast/offline on-device path, cloud policy says recognized text rather than images; iOS only and Android planned | Embedded reader continuity, exact history/resume, private server pairing, transparent mixed-stage locality |
| IchigoReader | Mobile comic translation | Store feedback reports long-webtoon stalls, flicker, OCR/Safari failures; beat with visible-first backpressure and original-always-readable recovery |
| MangaTranslate | Tall-webtoon support, per-bubble edit, context, translation memory, terminology and style modes | Make these capabilities portable across reader, privacy routes, and devices |
| Screen overlay translators | Work across apps and have broad Android reach | Eliminate black boxes, ads, flicker, and opaque latency with registered comic candidates and reversible rendering |

Embedded browsing is already table stakes. The product gap is a reliable reading
session that survives long chapters, site failures, model changes, and device
switches without losing position, names, artwork, privacy choice, or money.

## What the current repo gives us

Reuse:

- generic image discovery and stable DOM order in `extension/lib/core.js`;
- viewport/look-ahead queue, lazy mutation handling, current/all scope, overlays,
  reveal, pause, retry, and exclusion in `extension/content.js`;
- registered candidates, exact origin/URL validation, bounded image decoding,
  source hashing, cache keys, LRU, Koharu protocol, glossary prompt, and provider
  selection in `extension/background.js`;
- live provider tests, security/manifest tests, and a generic Playwright fixture.

Correct before calling the product SOTA:

- the Apple container is onboarding plus Safari extension, not an in-app reader;
- Android/desktop apps and reading history do not exist;
- extension auth token storage is not acceptable for native apps;
- raw remote deployment exposes one shared Koharu instance behind bearer
  authentication, with global mutable project/model state;
- docs describe a full cleanup/render path, while the current runtime returns the
  source image with overlay boxes after OCR/translation;
- Koharu 0.61.2’s static Gemini catalog predates 3.6 even though its provider
  passes custom model IDs through.

## V1 experience

### Home

- Continue Reading
- Recent
- Saved Series
- Paste URL / use a confirmed clipboard URL
- Private Session

In a normal session, create local history after ten seconds of active reading or
after the user advances one viewport/panel, even if no translation runs. A
translation is additional state, not the condition for remembering progress.
Private Session remains zero-write. Users can delete one item, one domain, or
all history and configure retention.

### Reader

- Small browser chrome: back, forward, reload, address field, share, open in
  system browser
- Floating action: `Dịch phần đang đọc`
- Menu actions: visible/current, all images in this page, pause, stop after
  current, retry, reveal original
- Visible-first queue with one or two concurrent jobs
- Preflight for Translate All: image count, estimated time, estimated cost, and
  exact data path
- Alpha safety ceiling: 200 discovered candidates. Managed-cloud jobs default to
  a USD 0.50 upper-bound budget; if the estimate exceeds it, split into batches
  of up to 50 and ask before continuing. Local/BYO routes have no monetary cap
  but retain the 200-candidate memory/safety ceiling.
- Newly discovered images after confirmation enter a paused “next batch” state.
  They never consume provider spend without another confirmation.
- Charge/consume managed allowance only for fully rendered successful images;
  failed or cancelled work is automatically returned.

Canonical copy:

```text
Translate 42 images currently loaded on this page
Images that appear as you scroll will wait for the next batch and will not be
charged automatically.

About 8–14 minutes · maximum USD 0.50 · Managed Cloud
[ Translate while reading ] [ Translate 42 images ]
```

During the job:

```text
Translating 12/42 · 3 new images waiting
[ Stop after this image ] [ View queue ]
```

The action label is `Translate all currently loaded images`, never an ambiguous
`Translate all chapter`. Over 200 candidates, offer the first 50 or the current
reading section.
- Capability state for difficult sites: readable, login required, inaccessible
  image, canvas reader, system-browser fallback

### Settings

- Target language per device
- Source language: auto-detect with manual override
- Translation location: Ask Each Time, On This Device, My Computer, Manga Sub
  Cloud
- Translation profile: Fast, Balanced, Quality
- Named paired-computer health and revocation
- History, cache quota, private mode, and deletion
- Per-series glossary and translation style
- Privacy & Data Paths

Provider/model pinning, custom server URL, credential references, and broker
details live under `Advanced for power users`. A fresh reader never lands in a
Koharu, reverse-proxy, token, or model-ID screen.

First real-chapter route sheet:

```text
Where should this chapter be translated?

On this computer
Private. Download size, free-space need, expected time, and quality are shown.

My computer
Scan a QR code from a ready Manga Sub desktop on the same Wi-Fi.

Manga Sub cloud
Fastest trial. Exact image/OCR destinations are shown. Ten successful images
free, no account or API key required.

[ See exactly what each option shares ] [ Remember for this device ]
```

`Ask Each Time` is the clean-install default. Later Auto may select only
previously approved local/paired routes. A new external provider or data locus
always asks.

Routing precedence:

```text
Private Session override
→ one-job choice
→ per-series language/style
→ device default
→ global default
```

The active reader chip always shows target language and actual processing route.
Changing one device never overwrites another device’s language, rendered cache,
or glossary variant.

## Series Intelligence Bootstrap

On the first translated chapter of a series:

1. Detect canonical series identity from page metadata, structured data, title,
   URL, and early OCR. Never trust one field alone.
2. Immediately create local Continuity Memory from OCR, prior translated
   chapters, and user corrections.
3. After the first viewport renders, show one non-blocking consent card. If the
   user accepts, automatically run a narrow research job for this and future
   series. If declined, persist `local continuity only`. Private Session disables
   external lookup and never shows the card. The query contains only normalized
   series title, current chapter/volume boundary when known, and target language.
4. Prefer official/localized publisher data, then structured databases and
   reputable fan references. Preserve source URLs and retrieval time.
5. Normalize aliases and assign confidence:
   - verified: official source or agreement across independent sources;
   - likely: one strong source plus OCR/context agreement;
   - provisional: inferred from OCR or a single weak source.
6. Apply verified and likely terms to the series glossary. Provisional terms do
   not silently become permanent.
7. Continue research in the background while the first visible images translate
   with safe provisional behavior. Research must not block first reading.
8. Version the glossary. Include `seriesId`, `targetLanguage`,
   `translationStyle`, `glossaryVersion`, and translation
   style in cache keys and job telemetry.
9. Show a compact “Names used in this series” editor. The user can override, but
   never has to create the glossary from scratch.

The research layer must query names and terminology, not fetch or archive whole
chapters. Store citation URL, retrieval time, atomic term/alias, locale, and
confidence, not copied source prose.

Precedence is:

```text
user override
→ official cited target-locale name
→ validated local continuity
→ likely external candidate
→ provisional OCR inference
```

Research is chapter/volume-bounded where possible. It never proactively shows
future characters or plot facts. An ambiguous work identity requires a compact
confirmation before external query, persistent merge, or sync. Success gates include series
identity precision, wrong-name rate, contradiction rate, citation usefulness,
and time added to first translated viewport.

Consent copy:

```text
Use familiar character names?
Manga Sub can look up this series title and your chosen language in reviewed
sources. It does not send page images, OCR text, chapter URL, or reading history.

[ Use lookup sources ] [ Keep everything on this device ]
```

Settings show the exact allowed source classes, stored citations, and delete
controls. Each series can disable lookup or report a wrong identity/name.

Core records:

- `SeriesIdentity`: unconfirmed/confirmed/ambiguous plus evidence.
- `ResearchConsent`: series, policy version, allowed source classes,
  granted/declined/revoked.
- `TermAssertion`: locale pair, atomic source/target term, entity type,
  chapter range, confidence, quarantined/active/rejected/superseded, provenance.
- `GlossarySnapshot`: immutable parent/version chain keyed by series, target
  language, style, and entry hash.

External results start quarantined and activate only after the source alias
appears in current/local OCR context. Research fetches only allowlisted HTTPS
APIs/domains. Revocation removes stored assertions, citations, and research
cache. User corrections never mutate shared knowledge.

## Device language and local translation

Treat the pipeline as separate capabilities:

```text
Acquire image → OCR/layout → terminology research → translate text → render
```

Each stage reports `device`, `paired server`, or `managed cloud`.

User-facing route labels must be literal:

- `Fully local`: acquire, OCR/layout, translate, and render all run locally.
- `On-device text translation`: only the text translation stage is guaranteed
  local.
- `My computer — fully private`: every declared stage stays on the named node.
- `My computer + external AI`: image/OCR stages use the named node, while
  translated text goes to the explicitly named external provider using the
  user’s key.
- `Managed cloud`: Manga Sub’s service handles declared stages.

`Auto` means fully local when eligible, then paired private server when healthy,
then ask before managed cloud. It never silently escalates from local/private to
managed cloud.

On Apple devices:

- Query `LanguageAvailability.supportedLanguages` and the source-target pairing
  status at runtime.
- Use `TranslationSession` batch translation when the pair is installed.
- Offer the system download flow when the pair is supported but not installed.
- If the pair is unsupported, explain that only the translation stage needs a
  private server/cloud path.
- Never claim fully local processing if OCR or rendering is still remote.
- Keep target language selectable even when the processing mode changes.
- Prepare language downloads ahead of offline reading only with user approval,
  available space, and platform-supported pairs. Test on real devices; Apple’s
  Translation framework does not provide a valid simulator proof.
- Model capability includes `availability`, `supportsBatch`,
  `supportsGlossary`, `supportsStyle`, and `contentLocus`. Apple Translation is
  eligible for Fast only until proper-name and style benchmarks prove more.
- Split batches by detected source language and preserve cardinality with client
  identifiers. Cancel on navigation/background job cancellation.
- Job receipts say `Apple Translation · exact engine not exposed`; never invent
  a resolved model name. Disclose that Apple may collect bundle/language-pair
  usage/performance metadata even though translation content stays on device.

Android follows the same product contract with an on-device translation adapter
only when a measured, downloadable language pack supports the pair. It must not
silently fall back to cloud. Caches, glossary variants, and rendered assets are
keyed by device target language and translation style; progress sync does not
overwrite them.

## Backend model audit: Gemini 3.5 versus 3.6

### Observed evidence

- The supplied Google dashboard showed six successful calls, all reported as
  `Gemini 3.5 Flash`.
- The local Koharu 0.61.2 instance currently reports
  `gemini-3.5-flash`.
- The production remote Koharu instance currently reports
  `gemini-3.6-flash`.
- The current popup code defaults new settings to `gemini-3.6-flash`.
- Legacy migration only changes `gemini-3.1-flash-lite` to 3.6. A persisted
  `gemini-3.5-flash` selection remains unchanged.
- Desktop defaults to local Koharu. Both local and remote can use the same Google
  API key, so the Google dashboard cannot identify which Manga Sub client or
  Koharu instance issued a request.
- Manga Sub sends the selected target to global `PUT /llm/current`, then starts a
  pipeline whose payload contains no immutable model field.
- Koharu 0.61.2 passes the target model string directly to Gemini, so it does not
  internally remap 3.6 to 3.5. Its static catalog is stale and omits 3.6, but its
  provider path accepts a custom model ID.

### Root-cause conclusion

The strongest direct explanation for the six 3.5 calls is a legacy/persisted
client selection driving the local Koharu instance. The current system cannot
prove attribution after the fact because it has no per-job model telemetry.

There is also a structural backend defect: model and project selection are global
mutable Koharu state. Multiple devices or clients can race between
`PUT /llm/current` and `POST /pipelines`, so the model selected at request time is
not immutably bound to the job.

### Required fix

- Default Balanced to stable `gemini-3.6-flash` now, as requested and supported
  by current Google pricing. Keep it only while recurring blind
  Chinese-to-Vietnamese quality, latency, and cost evaluation passes. Users see
  Fast/Balanced/Quality; provider SKU stays in Advanced and diagnostics.
- Introduce settings schema version and selection provenance:
  `auto-recommended` versus `user-pinned`.
- Migrate a known former default to `auto/balanced` whose current recommendation
  is 3.6. An ambiguous persisted 3.5 selection gets one explicit choice instead
  of silently overwriting possible user intent. A later manual choice remains
  pinned.
- Add a Manga Sub job broker. Every job includes immutable requested and resolved
  execution fingerprints:
  - tenant/device/project and idempotency key;
  - provider, exact model, credential reference, and allowed fallback policy;
  - source/target language, translation style, prompt/template, and glossary
    versions;
  - OCR/layout/render pipeline versions and requested data path;
  - candidate snapshot, upper-bound budget, cancellation, and refund state.
- Until Koharu supports per-job targets, the broker owns a server-wide queue and
  holds the target/project lock through operation completion. This is a Phase 0
  containment only, not a shippable concurrent architecture. Phase 1 requires
  per-job Koharu configuration or isolated workers keyed by immutable execution
  fingerprint.
- Never expose raw global Koharu state directly to mobile/desktop clients.
- Log safe metadata only:
  `requestId`, pseudonymous device ID, job ID, requested model, resolved model,
  fallback reason, provider-reported model, token counts, latency, cache hit, and
  estimated cost. Never log URL, image, OCR text, glossary content, or secrets.
- Return the resolved model in every job response and show it in diagnostics.
- Alert when requested and resolved models differ.
- Never silently change processing locus or provider. A fallback route must be
  declared before the job, stay within budget/privacy policy, and appear on the
  job receipt.
- Maintain a signed/canary model capability registry with rollout and rollback
  rules for provider deprecations and aliases.

### Broker API and isolation contract

```http
POST /v1/job-batches
Idempotency-Key: <device-generated UUID>
```

The request contains snapshot/candidate IDs, requested locus/profile/provider/
model, credential reference, allowed fallbacks, pipeline versions, languages,
glossary snapshot/hash, privacy-policy version, and upper-bound budget. Tenant,
device authorization, and credential ownership come only from the authenticated
principal; the server never trusts client-supplied ownership fields.

The response freezes `batchId`, `executionFingerprint`, resolved locus/provider/
model and registry version, plus reserved budget. The execution fingerprint
covers every quality, privacy, and isolation input.

```text
CREATED → VALIDATED → BUDGET_RESERVED → WAITING_ASSET → QUEUED
→ CLAIMED → ACQUIRING → OCR → TRANSLATING → RENDERING → VERIFYING
→ SUCCEEDED → SETTLED

Terminal: REJECTED | FAILED | CANCELLED | EXPIRED
```

Phase 1 containment uses one Koharu worker process/container per active job.
Each worker has a separate project/data directory, port, credential context, and
immutable execution fingerprint. A mismatch quarantines the worker and stops the
queue; it never causes provider fallback. Clients cannot call raw
`PUT /llm/current`.

Accounting uses an exactly-once allowance ledger:

```text
RESERVE(job) → CAPTURE(job after verified asset commit)
             → RELEASE(job on failure/cancel/expiry)
```

Unique constraints and compare-and-swap state transitions resolve cancel versus
late-provider-success races. A late result never attaches after navigation or
acknowledged cancellation. User charge stays zero; internal provider cost is
still recorded for abuse and unit economics.

### Shared implementation boundaries

```text
packages/protocol
  JSON Schema plus generated Swift/Kotlin/TypeScript DTOs and version negotiation
packages/comic-discovery
  DOM-only candidate discovery with no chrome/native API
packages/comic-agent
  navigation epoch, observers, overlay and typed transport adapter
packages/domain
  job fingerprints, history identity, glossary precedence and cache keys
```

Minimum messages: `HELLO`, `NAVIGATION_STARTED`,
`CANDIDATE_SNAPSHOT_CREATED`, `CANDIDATE_DELTA_WAITING`,
`ASSET_TRANSFER_BEGIN/CHUNK/END/ABORT`, `TRANSLATE_BATCH_REQUESTED`,
`JOB_EVENT`, `OVERLAY_ATTACH/REJECT`, and `CLEAR_SITE_DATA`.

Electron discovery runs in an isolated preload/world, not the page main world.
The broker validates WebContents/frame, top-frame policy, origin, navigation
epoch, protocol version, message size/rate, and candidate registration.

Google lists 3.6 Flash at the same standard input price as 3.5 Flash and a lower
standard output price. Model pricing remains configuration, not hard-coded
marketing copy.

### User-facing job receipt

The reader shows semantic state only, for example
`VI · Balanced · My Server`. Model/provider jargon stays under a tap:

```text
This image
Route: My computer + external AI
Image: this device → Tien’s Mac
OCR/layout: Tien’s Mac
Translated text: Google Gemini through your API key
Translation model: Gemini 3.6 Flash
Requested/resolved route: matched
No page URL, cookies, or reading history were sent.
Cache: generated now
[ Copy safe diagnostic ID ]
```

Recent Jobs provides safe request IDs, timing, route, cache, fallback, and cost.
Diagnostic export redacts URL, image, OCR, glossary, cookies, and secrets by
construction. A requested/resolved mismatch stops the queue and requires
`View details`, `Choose again`, or `Stop`.

`Report a problem` attaches only the safe diagnostic ID. Including a chapter URL
is a separate unchecked consent. Support copy never exposes a raw provider error
or credential.

## Canonical reader states

| State | User copy | Primary exit |
|---|---|---|
| Empty | Paste a chapter link to start reading. | Paste URL |
| Opening | Opening the page safely… | Cancel |
| Discovering | Finding comic images. No data has been sent. | Stop |
| Ready | 18 comic images are ready. | Translate current view |
| Rendering | Translating image 4/18. Keep reading while it works. | Pause |
| Cache hit | Ready from the copy stored on this device. | Reveal original |
| Paused | Paused. Seven images are waiting. | Continue |
| Partial failure | Two images could not be translated; originals remain visible. | Retry failed |
| Unsupported | This page draws the comic on a canvas; safe image access is unavailable. | Extension fallback / report |
| Route offline | Cannot connect to the named private server. | Retry / change route |

No indefinite spinner may cover artwork. Original content stays readable in
every slow/error state. At ten seconds without a translated viewport, show
elapsed state and allow cancel or route change.

Reader state and per-image job state are separate. Production sub-states include
route/managed-consent required, language-pack download, auth required, acquiring,
image inaccessible, budget reserve/exceeded, waiting worker, stopping,
navigation invalidated, disk full, thermal throttling, worker quarantined, model
unavailable, ambiguous research identity, sync key unavailable, and WebView
crashed. One failed image never collapses the whole reader into an error page.

### Failure invariants

| Failure | Required behavior | User charge |
|---|---|---:|
| Navigation changes after snapshot | Invalidate snapshot; never attach late result | zero unless verified commit already won CAS |
| Image inaccessible or malformed | Try declared acquisition ladder; keep original | zero |
| Forged frame/candidate | Reject sender/frame/navigation; rate-limit | zero |
| WebView crash | Recreate reader and offer committed resume | zero for uncommitted |
| Worker crash/fingerprint mismatch | Quarantine worker; stop queue | zero |
| Provider deprecated/unavailable | Ask for another allowed route; no silent reroute | zero |
| Provider succeeds after cancel | Discard UI attachment; settle internal cost only | zero |
| Budget reserve fails | Start no upload/provider work | zero |
| Cache/render hash or dimension mismatch | Delete/quarantine result; keep original | zero |
| Disk/thermal pressure | Pause with literal reason; never escalate route | zero |
| Research timeout/poisoned result | Use local continuity; quarantine assertion | unaffected |
| Refund service unavailable | Keep allowance unconsumed and alert operations | zero |

## Reading history and exact resume

Persist after ten seconds of active reading, one viewport/panel advance, a
translation, or an explicit save:

- canonical origin and sanitized URL
- work and chapter identity
- title, cover/favicon, and editable label
- last source hash, candidate index, intra-image ratio, fallback scroll ratio
- translation profile, model family, glossary version, and cache version
- completion state and last-opened time

Resume by source hash first, then sanitized image URL and index, then nearest
stable anchor. Never silently scroll to a wrong position after a site mutation.

Resume confidence:

- `STRONG`: acquired source SHA-256 plus neighboring candidate hashes.
- `MEDIUM`: HMAC of sanitized source URL plus dimensions, ordinal, and neighbor
  fingerprints.
- `WEAK`: stable DOM anchor, ordinal, intra-image ratio, and document fallback.

Do not fetch or upload an image only to hash reading progress. Near-match UI uses
metadata/context and does not persist screenshots by default.

On reopen, ask:

```text
Continue Chapter 48?
You stopped at image 18/43 two days ago.
[ Continue ] [ Start over ]
```

- Exact match: resume after the user chooses Continue.
- Near match: show `The page changed. Continue near image 18?` with a small
  context preview.
- No safe match: open from the top and say the exact position could not be found.
- Restore after image decode, then revalidate source hash and intra-image offset.
- Mark complete only after the final stable candidate plus a bottom threshold,
  or an explicit user action. Never use global scroll ratio alone.
- Private Session keeps a persistent, subtle `Private · progress not saved`
  indicator.

Private Session uses a non-persistent WebView partition; disables app history,
favicon/thumbnail, glossary, research, durable cache, and content-linked
telemetry; keeps encrypted temp assets only until navigation/session close; and
allows a remote route only when it declares ephemeral retention. Cross-device
sync is opt-in and end-to-end encrypted. Never sync cookies, passwords, provider
keys, or backend tokens.

Because an OS may swap memory or produce a platform crash log, user copy is:
`Manga Sub does not intentionally keep reading data after this private session`,
not an unverifiable absolute “zero-write” claim.

Sync envelopes contain record type, schema/key versions, device ID, hybrid
logical clock, nonce, and ciphertext. A per-account master key is wrapped by
approved device keys. Progress uses last-writer-wins by logical clock, not
“furthest position wins”, because rereading is intentional. Deletion uses
versioned tombstones. Key recovery/revocation is a Phase 3 go/no-go decision.

## Responsive and accessibility contract

Desktop keeps native browser controls and route status outside remote content.
Mobile collapses to a native domain bar, safe-area-aware floating Translate
button, and a bottom sheet. The button relocates when it overlaps a detected
reading column or site control and never conflicts with system gestures or the
keyboard.

Release gates:

- minimum 44×44 pt touch targets;
- predictable keyboard focus entering and leaving the WebView;
- `Cmd/Ctrl+L`, back/forward, translate current, translate loaded snapshot,
  pause, and original reveal shortcuts;
- Dynamic Type through the largest accessibility sizes without truncated
  actions; scrollable sheets and discoverable address bar;
- native semantic reader mode exposing ordered source then translation regions,
  not an unlabeled raster overlay;
- non-gesture alternative for hold-to-peek original;
- no color-only progress, privacy, route, or error status;
- Reduce Motion support;
- VoiceOver on iPhone/iPad, TalkBack on Android, macOS keyboard/Voice Control,
  and Windows high-contrast/keyboard tests.

## Architecture

```text
Trusted app chrome
├── Home, tabs, settings, history, glossary
├── Translation orchestrator
└── isolated remote-content WebView
    └── injected Comic Agent
        ├── discovery and candidate order
        ├── viewport anchor
        ├── overlay/reveal
        └── typed, bounded messages
              ↓
Trusted native broker
├── navigation/candidate validation
├── bounded image/blob intake from the isolated WebView
├── encrypted SQLite + bounded asset cache
├── platform credential store
├── series research and glossary service
└── immutable translation job router
    ├── on-device adapters
    ├── local Koharu sidecar
    ├── paired desktop node
    └── managed cloud
```

Remote pages get no filesystem, shell, generic IPC, secret, or arbitrary network
capability.

The WebView performs authenticated image fetch/render capture inside its own
cookie store after user intent where platform capability allows. Native code
never logs or syncs the cookie jar. No DRM, paywall, CAPTCHA, or anti-bot bypass
is attempted. Add clear-site-data controls and require an independent
bridge/security review before beta.

### Cross-platform image acquisition ladder

No single WebView API can acquire every image safely. Freeze metadata only, then
acquire at worker pace with at most two decoded assets:

1. `SOURCE_BLOB`: same-origin or CORS-enabled fetch inside the isolated WebView.
2. `BROKER_FETCH`: exact registered URL with a narrowly projected,
   domain-bound cookie context. This is an explicit platform/security exception;
   cookies are never enumerated to app UI, exported, logged, or synced.
3. `ELEMENT_CAPTURE`: rendered element/viewport capture. The receipt records
   `degradedResolution=true`.
4. `MANUAL_REGION`: user-assisted region capture.
5. `UNSUPPORTED`: no safe path for the current canvas/DRM/auth/CORS state.

```ts
type CandidateSnapshot = {
  snapshotId: UUID
  navigationId: UUID
  topFrameOrigin: string
  createdAt: ISODate
  candidates: Array<{
    candidateId: UUID
    frameId: string
    domOrdinal: number
    sourceUrl: string
    sourceOrigin: string
    renderedRect: Rect
    intrinsicWidth?: number
    intrinsicHeight?: number
    acquisitionCapabilities: AcquisitionMode[]
  }>
}
```

Reject transfer or overlay attachment when navigation ID, frame, exact
registered URL, origin, protocol version, or candidate identity changes. Chunked
binary transfer is mandatory; JSON/base64 is not the general asset transport.

## Activation and distribution

- Mobile Share Sheet: `Open in Manga Sub`.
- Desktop share target/custom URL handoff for a user-selected chapter URL.
- One-tap owned/licensed sample chapter for clean-install and store review.
- No account, API key, or extension required for the first local/demo success.
- Normal site login and passkeys run inside the embedded reader WebView so its
  isolated cookie store can continue the session.
- If the site login/reader is incompatible, offer
  `Open in Safari/Chrome + Manga Sub Extension`. Explain that the system browser
  has a separate session and progress in the app stops at the handoff. Never
  imply that logging in externally signs in the app, and never import cookies.
- Measure install → share/paste → candidate discovery → first rendered viewport.

First-run flow:

```text
Home
→ Paste copied chapter URL / Share into Manga Sub / Open owned sample
→ Opening
→ Candidate discovery
→ Reader with original artwork immediately visible
→ First Translate tap
→ Choose an available route only when needed
```

If `Auto` cannot use a local or paired private route, ask before managed cloud.
Show download size/time for a local route, the named private server and health,
or the exact managed-cloud data path.

## Business model and abuse controls

- Reader, local processing, paired private server, and BYO provider are free and
  not throttled for monetization; only device-safety limits apply.
- Managed cloud launches in closed beta with a small free trial, then prepaid
  successful-image packs. Move to subscription plus included allowance only
  after real session distribution is known.
- No ads in the reader.
- All managed jobs have user, device, and tenant budgets; an absolute monthly
  service spend cap; idempotency; rate limits; and automatic failed-job refund.
- Before public beta, validate willingness to pay, App Store/Play billing rules,
  provider cost hedge, gross margin per activated reader, and abuse scenarios.

## Consumer private-compute journeys

### Pair a phone with My Computer

V1 pairing is LAN-only. Internet exposure/reverse-proxy setup is an expert,
separately reviewed feature.

1. Desktop: `Use this computer for private translation`.
2. Preflight engine version, signed package, disk/RAM/GPU, language/model
   availability, and LAN reachability.
3. Show a one-time QR valid for ten minutes plus a six-word verification phrase.
4. Phone shows computer name, the same phrase, capabilities, and exact data path.
   Confirm on both screens.
5. Use proof-of-possession and a per-device least-privilege key. QR contains no
   reusable bearer token.
6. Paired state shows last seen, latency, engine capability, Pause, Disconnect,
   and Forget Device with deletion/revocation effects.
7. Expiry/network/version recovery uses `Show new code`, `Use the same Wi-Fi`,
   or `Update private engine`; never asks a normal user for URL, token, or proxy.

### Local Engine lifecycle

- Consumer UI calls it `Private translation on this computer`; “Koharu” appears
  only in Advanced diagnostics and license notices.
- Before download: support reason, signed engine/model size, free space,
  RAM/GPU/power/network needs, time estimate, and quality tier.
- Download supports pause/resume/delete.
- Runtime starts on demand, has CPU/GPU/RAM caps, exposes Ready/Starting/
  Updating/Needs Attention, and stops after a configurable idle timeout. No
  login autostart without consent.
- Signed manifests, compatibility checks, atomic update, defer-while-busy, and
  last-known-good rollback are required.
- Repair actions: Restart, Check Compatibility, Free Space, Remove Engine,
  Remove Models, Remove Cache, and Remove Keys, each with distinct effects.

### BYO provider

- Add key copy states the platform credential store and `never synced`.
- Display provider and key prefix/last four only.
- Validate with a minimal capability call, then test on owned sample content.
- Map invalid/revoked, quota/billing, model unavailable, TLS/network, and rate
  limit failures to safe recovery actions.
- Support rotate, remove, and pause use; explain effects on queued jobs and
  existing fingerprinted cache.
- Mobile never copies a provider key to a QR or paired desktop. Credentials are
  added on the node that uses them.

### Gemini 3.5 to 3.6 customer migration

Before the first affected new job:

```text
A newer Balanced translation engine is available
Your previous setting used Gemini 3.5 Flash. Balanced now recommends Gemini 3.6
Flash after Vietnamese-comic checks. Saved pages will not change; new
translations may read differently.

[ Use recommended Balanced ] [ Keep Gemini 3.5 ] [ Decide later ]
```

`Decide later` preserves the current choice for that job/session. A paired node
without 3.6 offers Update Private Engine or Keep Current Engine. Cache entries
retain their execution fingerprint and are never silently retranslated/mixed.

## Delivery order

### Discovery — two weeks

- Interview 20 target users and choose the primary long-scroll/paged fixture
  based on evidence.
- Validate the no-catalog, user-supplied URL positioning with store, ToS, and
  monetization counsel.
- Establish baselines for first viewport, correction rate, exact resume, cost,
  and site compatibility.

### Phase 0 — Correctness and feasibility go/no-go

- Fix per-job model attribution and global Koharu state races.
- Restore a real cleanup/render baseline or explicitly rename the existing
  source-image-plus-overlay path.
- Prove image acquisition and isolated bridge behavior on ten site fixtures.
- Audit Koharu GPL distribution and all bundled model licenses.
- Prototype series research and Apple on-device translation availability.

Do not enter Phase 1 unless all are true:

1. Koharu and bundled model distribution has a written green light.
2. Two simultaneous devices cannot change one another’s immutable route,
   project, glossary, or result.
3. Ten representative authorized fixtures pass capture and bridge tests without
   cookie/auth leakage.
4. First-viewport p95, memory, cost, and failure-refund targets meet the measured
   baseline budget.
5. No unresolved critical App Store, Play, copyright, or ToS blocker exists.
6. The current source-image-plus-overlay behavior is named truthfully or the
   full cleanup/render path is restored and verified.
7. Acquisition ladder pass rates and route-specific p50/p95/memory budgets are
   recorded per platform.
8. Bridge review has zero unresolved critical/high findings.
9. Concurrency, ledger exactly-once, cancellation, privacy retention/deletion,
   and real Gemini 3.6 attribution canaries pass.
10. Signed installer/update, SBOM, rollback-compatible broker protocol, and
    outage/refund/credential-compromise runbooks exist.

### Phase 1 — Desktop alpha

- Electron reader on macOS and Windows
- managed Koharu sidecar and secure broker
- current/all translation and reversible rendering
- local history, exact resume, private mode
- Gemini 3.6 default with resolved-model diagnostics
- automatic series glossary bootstrap
- one reader window, share/paste, owned sample, no sync, no generic tabs

### Phase 2 — Mobile internal beta

- native iOS/iPadOS and Android readers
- remote/private server plus Apple on-device text translation where available
- target-language selection and language-pack state
- local history/resume and system-browser fallback
- keep Safari extension as compatibility insurance

Mobile begins after desktop proves the activation/reliability loop. It does not
block the desktop alpha.

### Phase 3 — Cross-device beta

- QR pairing to desktop inference
- per-device credentials and revocation
- E2EE progress/glossary sync
- compatibility classifier and assisted region capture

### Phase 4 — Quality release

- 100-page Chinese/Japanese-to-Vietnamese golden set
- blind human comparison of at least three translation routes
- terminology-consistency and research-accuracy benchmarks
- published performance, privacy, and resume gates before using “SOTA”

External glossary research graduates from a narrow allowlisted V1 lookup to a
broader cited service only after identity precision, spoiler safety, wrong-name
rate, privacy consent, and activation latency gates pass.

## Performance and resource budgets

- Original artwork interactive p95 within one second after navigation response.
- Candidate discovery p95 within one second after DOM stability for 200 metadata
  candidates.
- First translated viewport has separate measured SLOs for managed warm,
  paired, local accelerated, local CPU, and full-clean-render routes. The
  under-ten-second target is a Phase 0 hypothesis, not a cross-route promise.
- At most two assets acquiring/decoded concurrently; never retain 200 decoded
  bitmaps.
- Enforce encoded-byte, pixel, decoded-memory, and chunk limits per platform;
  tile oversized webtoons before full RGBA decode.
- No comic-agent main-thread task over 50 ms; discovery is incremental.
- Queue backpressure follows RAM/VRAM, provider rate limit, disk quota, thermal,
  battery, and foreground/background state.
- Define stage and total timeouts, circuit breakers per provider/model/worker,
  maximum backlog, queue p95, refund latency, deletion latency, and bounded
  telemetry loss.
- Private mode has no durable cache quota because it has no durable cache.

### Time-to-help targets

- Managed trial clean install: app launch to first successful viewport p50 ≤90
  seconds and p95 ≤3 minutes; after Translate tap on a warm intended service,
  p95 ≤10 seconds.
- Fresh local desktop: reach an understandable download decision within 45
  seconds; after the disclosed download completes, first local viewport p50 ≤5
  minutes and p95 ≤10 minutes on the supported hardware matrix.
- Phone paired to a ready desktop on the same Wi-Fi: scan/phrase confirmation to
  successful private viewport p50 ≤90 seconds and p95 ≤3 minutes, with no token,
  URL, or proxy entry.
- Expert self-host: install to `doctor` green and QR-ready within 15 minutes on a
  reference host.
- At least 90% of scripted offline, expired-QR, low-disk, invalid-key, and
  update-needed recoveries reach success or a clear safe stop within two minutes
  without support.

## Documentation and operator tooling deliverables

- Vietnamese-first Reader Guide: first chapter, route/data-path table, private
  mode, history/delete, original reveal, incompatibility.
- Private Engine Guide: one-click LAN pairing, health, update, rollback, delete.
- Self-host Guide: supported OS/hardware/topology, signed install/container,
  secret storage, LAN/public warning, backup/revoke.
- BYO Guide: provider/key lifecycle, billing/rate limits, privacy matrix.
- Screenshot-based troubleshooting with exact recovery and no secret/raw-log
  exposure.
- Versioned OpenAPI/JSON schemas, capability manifest, state/event/error catalog,
  idempotency/cancellation/accounting, retention declaration, pairing/security
  spec, compatibility policy, and safe diagnostic schema.
- Read-only `comic-sub-node doctor` with redacted report for version,
  capabilities, disk/RAM/accelerator, bound interface, pairing readiness,
  provider reachability, fixture verification, and update/rollback status.
- Operational runbooks for provider outage, GPU exhaustion, refund backlog,
  credential compromise, data deletion, bad model registry, and bad update.

### Setup/recovery copy contract

| Situation | Copy and safe action |
|---|---|
| Local engine missing | `Set up private translation on this computer (size shown)` → Download or choose route |
| On-device pair unsupported | `This device cannot translate this language pair on-device` → My Computer, Cloud, or original |
| Low disk/download paused | State exact free-space need → Free space, Resume, Cancel |
| Paired node offline | `My computer is not reachable` → Retry, pair again, change route |
| QR expired/phrase mismatch | `Code expired or does not match` → show new QR and verify phrase |
| Node lacks 3.6 | `Private engine update available for Balanced` → Update or keep current |
| BYO key invalid/quota | `Your provider key cannot run this job` → reconnect/change key or route |
| Fingerprint mismatch | `Private engine settings did not match. Nothing was rerouted` → repair/update/stop |
| Site image inaccessible | `This site will not safely provide this image` → manual region/extension/report |
| Managed budget exceeded | State cap → reduce batch, buy explicitly, or change route |
| Cancel/late result | `Stopped. Original stays visible; no credit used` → resume/retry |

## Verification strategy

1. Generated Swift/Kotlin/TypeScript protocol compatibility and version
   negotiation tests.
2. Malicious Electron/WebView page suite: forged origin/frame, navigation race,
   popup/scheme/permission/download attacks, message size/rate abuse.
3. Acquisition matrix on Electron, real iOS/iPadOS, and Android: same-origin,
   CORS/no-CORS CDN, HttpOnly/SameSite cookies, signed URL, redirect, referrer
   protection, canvas/WebGL, and URL mutation mid-transfer.
4. Chunk-transfer fuzzing: truncation, reorder, duplicate, abort, oversized and
   decompression-bomb inputs.
5. 10,000 randomized concurrent jobs proving zero tenant, project, credential,
   model, glossary, or cache bleed; worker kill/restart and stale lease tests.
6. Ledger property tests proving reserve/capture/release exactly once under
   crash, retry, cancellation, late provider success, and refund outage.
7. Registry/model alias, deprecation, canary attribution, rollback, and
   requested/resolved mismatch tests.
8. Apple real-device language-pair availability/download denial, mixed-language
   batch, cancellation/backgrounding, terminology and style fidelity tests.
9. Resume mutation corpus: reordered/inserted images, changed CDN URLs, ads,
   lazy replacements, responsive dimensions, and lost anchors.
10. Private-session forensic checks across DB/WAL, caches, temp files, logs,
    crash reports, telemetry, and server retention.
11. Series identity merge/split, homonymous titles, consent/revocation, poisoned
    citations, spoiler quarantine, and precedence tests.
12. Disk full, cache corruption, memory warning, thermal throttling, offline/
    flaky network, provider outage, GPU exhaustion, and WebView crash tests.
13. Signed installer/update, SBOM, GPL/model license evidence, cross-tenant
    security tests, and external bridge penetration review.
14. Automated plus manual VoiceOver/TalkBack/keyboard/high-contrast tests.

The current extension baseline remains required. On 2026-07-30,
`npm run verify` passed 31 unit/regression tests, manifest/security checks,
runtime configuration checks, and the Playwright extension E2E.

## Success metrics

North Star: weekly completed translated reading sessions, defined as at least ten
translated images or ten minutes of reading, followed by a return to the same
series within seven days.

Guardrails:

- install → share/paste activation
- URL → candidate discovery success
- discovery → first rendered viewport p50/p95
- first-session completion and D1/D7 Continue Reading
- exact-resume success and false-resume rate
- glossary identity precision, correction, contradiction, and wrong-name rates
- requested/resolved model mismatch rate, target zero
- unexpected remote transfer rate, target zero
- inaccessible-site rate
- cost, gross margin, and failed-job refund rate per activated reader
- crash-free sessions and scroll smoothness

Initial service objectives, subject to Phase 0 baseline validation:

- first translated viewport p95 under ten seconds on the intended warm route;
- false exact-resume under one percent on the fixture set;
- requested/resolved execution mismatch zero;
- unexpected managed-cloud escalation zero;
- failed managed jobs charged zero.

## Decision audit trail

| Decision | Resolution | Evidence/voice |
|---|---|---|
| Product surface | Translation-native embedded reader, not generic browser | User request + CEO/design consensus |
| Prior desktop rejection | Superseded: install/permission friction now outweighs the previous “wrong reading surface” concern | Explicit user reversal + current market |
| Initial corridor | Chinese-language long-scroll manhua → Vietnamese | Existing fixtures/OCR/glossary + CEO focus review |
| Platform stack | Electron desktop; native Swift/WKWebView and Kotlin/WebView mobile | Engineering review + Chromium reuse |
| Extension | Compatibility escape hatch only | Product/design/engineering consensus |
| Bulk scope | Frozen currently-loaded snapshot with cap, budget, and later lazy batch | User intent + trust/cost review |
| History | Local progress after actual reading, even without translation; private session non-persistent by intent | User requirement + CEO/design review |
| Series terminology | Local continuity immediately; automatic allowlisted lookup after one non-blocking consent; versioned/cited/quarantined | User requirement + privacy/design/engineering review |
| Device language | Target language per device; route/stage locality shown literally | User requirement + Apple capability review |
| Apple fallback | On-device text translation only for supported/installed pairs that pass quality gates | Official Apple API + engineering review |
| Gemini default | 3.6 Flash for Balanced new defaults; ambiguous legacy 3.5 asks once; no silent fallback | User requirement + live BE audit + Google pricing |
| Backend | Immutable batch/job fingerprint, isolated worker, exactly-once ledger; raw global Koharu state hidden | Confirmed race + engineering review |
| Monetization | Local/BYO free; managed successful-image trial/packs; no reader ads | CEO/DX review |
| V1 exclusions | No crawler/download/export/catalog/social/generic tabs/anti-bot bypass | Store, security, product focus |

## Explicitly not in V1

- DRM, paywall, CAPTCHA, anti-bot, or access-control circumvention
- third-party chapter extraction, archive, export, or pirate-source directory
- generic multi-tab browser, general web translator, or system-wide screen
  overlay
- social/community features, scanlation publishing, or creator export suite
- public/shared glossary or automatic mutation from another user’s correction
- fully offline mobile quality claims before every pipeline stage passes real
  device quality, thermal, storage, and battery gates
- feature parity with the legacy extension

## Primary evidence

- [Gemini 3.6 migration guidance and price comparison](https://ai.google.dev/gemini-api/docs/generate-content/latest-model)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Apple TranslationSession](https://developer.apple.com/documentation/translation/translationsession)
- [Apple LanguageAvailability](https://developer.apple.com/documentation/translation/languageavailability)
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Google Play User Data policy](https://support.google.com/googleplay/android-developer/answer/10144311)
- [Google Play Data Safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
- [Koharu 0.61.2 release](https://github.com/mayocream/koharu/releases/tag/0.61.2)
- [Mangra](https://manga-translate.app/)
- [Madomi](https://pawakalabs.com/products/madomi/)
- [EasyComix and privacy model](https://easycomix.app/)
- [IchigoReader Android listing](https://play.google.com/store/apps/details?id=com.ichigoreadermobile)
- [MangaTranslate extension](https://chromewebstore.google.com/detail/mangatranslate/mlncaoeomijlolmfphgpcbghjgifdnki)

## GSTACK REVIEW REPORT

Review sequence: CEO → Design → Engineering → DX.

- CEO review started at 5.4/10 and rejected an unfocused four-product scope.
  Incorporated: one ICP/corridor, single-reader alpha, activation and business
  model, history-before-translation, snapshot budget contract, privacy boundary,
  commercial kill gates, and funnel metrics.
- Design review rated strategy 8.5/10 but blocked implementation on login
  handoff, research consent, bulk copy, reader states, resume recovery,
  responsive/accessibility, and diagnostic disclosure. All eight contracts are
  now explicit.
- Engineering review rated readiness 5.8/10 and approved Phase 0 only.
  Incorporated: acquisition ladder, candidate snapshot, typed protocol packages,
  immutable broker API/state machine, isolated worker, exactly-once ledger,
  private-session limits, resume confidence, Apple adapter contract, failure
  invariants, performance budgets, and adversarial tests.
- DX review rated setup readiness 5.0/10. Incorporated: zero-jargon route sheet,
  truthful data-path names, LAN QR flow, sidecar lifecycle, BYO credential
  recovery, 3.5→3.6 migration copy, time-to-help targets, Vietnamese-first docs,
  doctor tool, and setup recovery matrix.
- Current repository verification: `npm run verify` passed on 2026-07-30.
- Final status: READY as the decision artifact and Phase 0 execution contract.
  NOT AUTHORIZED to skip Phase 0 gates and begin public/Phase 1 shipping.

NO UNRESOLVED DECISIONS

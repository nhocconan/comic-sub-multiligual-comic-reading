# Local translation broker

Runnable Node.js broker for desktop, iOS, and Android embedded readers. It has no
runtime dependencies outside Node 22+.

The public API never exposes or accepts Koharu's mutable `/llm/current` route.
Every job records immutable requested and resolved execution values plus an
execution fingerprint. The default resolution is `gemini/gemini-3.6-flash`.

## Run

Start Koharu locally, then:

```sh
KOHARU_ENDPOINT=http://127.0.0.1:4000/api/v1 \
BROKER_DATA_DIR=.broker-data \
npm start --prefix services/broker
```

`KOHARU_AUTH_KEY` is optional. The broker defaults to `127.0.0.1:4100`.

The included fake adapter is deliberately unavailable by default. It can only be
enabled explicitly for client integration tests:

```sh
BROKER_TEST_MODE=1 npm start --prefix services/broker
```

Never use that mode as a translation service: its result is a labeled safe mock.

## Desktop/mobile API contract

All requests may send `x-tenant-id` and `x-device-id`; local clients default to
`local` and `local-device`.

1. `POST /v1/snapshots` freezes a navigation's candidate list (maximum 200).
2. `POST /v1/job-batches` with `Idempotency-Key` returns the batch and every
   `jobId`. Managed Translate All is capped at 50 candidates and USD 0.50.
3. `PUT /v1/jobs/{jobId}/asset` uploads one JPEG/PNG/WebP (maximum 32 MiB).
   `Content-Type` and lowercase `x-content-sha256` are mandatory and are checked
   against sniffed bytes and the complete body.
4. Poll `GET /v1/jobs/{jobId}`, or incrementally read
   `GET /v1/jobs/{jobId}/events?after={sequence}`.
5. Read `GET /v1/jobs/{jobId}/result` after `SETTLED`. It returns normalized
   `overlayRegions`, page dimensions, a rendered-asset descriptor/URL, and the
   model receipt. Download bytes from
   `GET /v1/jobs/{jobId}/rendered-asset`.
6. `POST /v1/jobs/{jobId}/cancel` is idempotent.

Minimal batch payload (candidate metadata is registered in the preceding
snapshot request):

```json
{
  "snapshotId": "snapshot-123",
  "candidateIds": ["candidate-001", "candidate-002"],
  "requestedExecution": {
    "locus": "managed",
    "profile": "balanced",
    "allowedFallbacks": []
  },
  "language": { "source": "zh-Hans", "target": "vi" },
  "budget": { "currency": "USD", "maxMicros": 500000 }
}
```

Successful result shape:

```json
{
  "jobId": "job:...",
  "candidateId": "candidate-001",
  "page": { "width": 1600, "height": 2400 },
  "overlayRegions": [
    {
      "id": "region-id",
      "x": 10,
      "y": 20,
      "width": 300,
      "height": 100,
      "rotation": 0,
      "source": "原文",
      "translation": "Bản dịch",
      "confidence": 0.98
    }
  ],
  "renderedAsset": {
    "contentType": "image/png",
    "byteLength": 12345,
    "sha256": "...",
    "url": "/v1/jobs/job%3A.../rendered-asset"
  },
  "modelReceipt": {
    "resolvedProvider": "gemini",
    "resolvedModel": "gemini-3.6-flash",
    "providerReportedModel": "gemini-3.6-flash",
    "executionFingerprint": "...",
    "modelMatched": true
  }
}
```

The real Koharu adapter creates a project, uploads the exact job asset, runs the
comic detector + PaddleOCR-VL + LLM pipeline, and parses `/scene.json`. Koharu
0.61.2 still has a process-global model target, so the adapter serializes all
Koharu work, pins the job's resolved provider/model immediately before the run,
and verifies it became ready. This compatibility behavior is entirely behind the
broker; clients cannot mutate it. Replace `KoharuAdapter` when Koharu offers a
native per-job target.

The durable JSON repository writes state atomically and keeps binary assets in a
private data directory. On restart, in-flight jobs fail safely and their budget
reservations are released; provider calls are not blindly replayed.

## Series Intelligence

`POST /v1/series/bootstrap` persists local continuity and user corrections
before returning. The response always includes a content-addressed
`glossarySnapshot` with `id`, monotonically increasing `version`, `hash`, and
entries. If research is consented, it runs asynchronously and never delays the
translation queue.

```json
{
  "seriesId": "series-123",
  "title": "魔尊",
  "seriesStatus": "confirmed",
  "chapterBoundary": "chapter-12",
  "targetLanguage": "vi",
  "privateMode": false,
  "localContinuity": [
    { "sourceTerm": "师父", "targetTerm": "Sư phụ", "confidence": 0.9 }
  ],
  "userCorrections": [],
  "locallyObservedAliases": ["魔尊"],
  "researchConsent": {
    "seriesId": "series-123",
    "policyVersion": "series-research-v1",
    "state": "granted",
    "allowedSourceClasses": ["wikidata", "mediawiki", "anilist"],
    "grantedAt": "2026-07-30T00:00:00.000Z"
  }
}
```

Poll `GET /v1/series/{seriesId}/glossary` for `research.state`. It returns the
latest snapshot, per-entry provenance/confidence, deduplicated citations, and
`quarantinedTerms`. External assertions are quarantined unless their normalized
source name literally appears inside a locally observed OCR region. Use
`DELETE /v1/series/{seriesId}/glossary` to delete the device-scoped record.

Jobs resolve the exact `id`/`version`/`hash` snapshot supplied by the client.
Only active entries are copied into the immutable job and injected into the
Koharu LLM system prompt. The mappings are serialized as bounded JSON and
explicitly labeled untrusted reference data; quarantined entries never reach
the prompt. A bounded snapshot history prevents asynchronous research from
invalidating an already-issued job contract.

Private mode always disables outbound research, even with consent. Otherwise,
only consented providers are called. Endpoints are intentionally hardcoded to
Wikidata, the target-language `wikipedia.org` MediaWiki API, and AniList GraphQL;
there is no configurable URL and no arbitrary-URL fetch path. Outbound search
context is limited to normalized title and target language. Chapter boundary is
accepted as bounded context but retained locally because these providers expose
no corresponding search field. Local terms, observed aliases, URLs, cookies,
OCR, and reading history are never sent.

Research configuration:

- `SERIES_RESEARCH_ENABLED=0` disables all public research.
- `SERIES_RESEARCH_PROVIDERS=wikidata,mediawiki,anilist` selects a subset of the
  three compiled-in providers.
- `SERIES_RESEARCH_TIMEOUT_MS=5000` sets each request timeout, clamped to
  500–30000 ms.
- `SERIES_RESEARCH_USER_AGENT=...` sets a bounded, newline-stripped User-Agent.

Provider outages produce `complete-with-errors` or `unavailable`; the persisted
local glossary remains usable. The integrations follow the official
[Wikidata search API](https://www.wikidata.org/wiki/Help:Linked_Data_Interface),
[MediaWiki OpenSearch API](https://www.mediawiki.org/wiki/API:Opensearch), and
[AniList GraphQL API](https://anilist.gitbook.io/anilist-apiv2-docs).

Run the contract and persistence tests:

```sh
npm test --prefix services/broker
```

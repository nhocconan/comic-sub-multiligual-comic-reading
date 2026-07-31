# Manga Sub shared protocol

Runtime-validated, dependency-free messages shared by the embedded reader
clients and the local translation broker.

The protocol deliberately contains no Chrome, Electron, Swift, Kotlin, Koharu,
or provider APIs. Platform adapters translate their native events into these
messages.

## Invariants

- A candidate snapshot is immutable and belongs to one navigation.
- A snapshot contains at most 200 metadata candidates.
- A batch can only reference candidates already present in its snapshot.
- Managed batches contain at most 50 candidates and reserve no more than
  USD 0.50 by default.
- Requested and resolved execution are returned separately.
- Provider/model fallback is explicit; the default policy allows none.
- Job receipts and telemetry contain no page URL, OCR text, glossary text,
  cookies, or secrets.

## Test

```bash
cd packages/protocol
npm test
```

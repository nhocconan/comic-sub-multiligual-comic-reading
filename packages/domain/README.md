# Domain package

Pure Node.js domain logic shared by desktop, mobile, and the broker.

- A job stores separate immutable `requestedExecution` and `resolvedExecution`
  values. Resolution defaults to `gemini/gemini-3.6-flash`.
- The execution fingerprint covers provider/model/credential reference, pipeline,
  language, rendering, glossary snapshot, locus, and privacy-policy version.
- The job state machine rejects skipped or backwards transitions.
- History helpers produce device-keyed URL fingerprints and strong/medium/weak
  resume anchors without storing authentication fragments.
- Glossary bootstrap gives user corrections precedence, requires explicit consent
  and a confirmed series identity for research, allowlists sources, records
  provenance, and quarantines external assertions until their source term appears
  in locally observed text.
- Series bootstrap validation bounds all local continuity, correction, chapter,
  language, title, and observed-alias inputs. Glossary snapshots are
  deterministically sorted and SHA-256 content-addressed for use in immutable
  translation jobs.

Run:

```sh
npm test --prefix packages/domain
```

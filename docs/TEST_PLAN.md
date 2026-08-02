# Verification plan

Copyright © 2026 [nhocconan](https://x.com/nhocconan).

## Static and unit

- Manifest V3, no static site matches, no `tabs`, no permanent remote host access.
- No `eval`, dynamic function construction, inline popup handlers, or unsafe HTML
  assignment.
- Image source resolution and AMP nested-image deduplication.
- Candidate scoring boundaries, DOM order, and false-positive rejection.
- URL/origin validation and per-tab candidate registration.
- Image magic-byte and size validation.
- Cache key stability and quality-setting invalidation.
- Full Koharu pipeline request, rendered-image validation, and scene text-node
  parsing.
- Source-relative rendered-page geometry.

## End-to-end fixtures

### Generic reader

A local reader contains:

- three large comic images from a second origin;
- one image inserted after initial load;
- one AMP-like outer host with a nested runtime image;
- logo, avatar, banner, and recommendation thumbnails as negative controls.

Expected: only the four comic pages are registered in DOM order, permission is
requested for the image origin, rendered pages align, and no source attribute
changes.

### Mock Koharu

The local mock implements the exact API subset used by the extension and records
calls. It returns deterministic translated regions and a valid rendered PNG for
each requested page.

Expected:

- visible and look-ahead pages translate progressively;
- no `.bb-region` translucent cards are created;
- refreshing/reinjecting uses cached rendered pages;
- offline and failed operations preserve the source;
- retry succeeds without duplicating completed work;
- pause prevents new pipeline calls.

### Live Baozimh

Expected on the selected chapter:

- 9 page candidates and no unrelated site images;
- rendered-page alignment at desktop and 375 px viewport;
- scroll insertion/lazy behavior does not duplicate candidates;
- source reveal is immediate;
- same-tab next-chapter navigation resets lifecycle.

The live walkthrough may use a mock translator to verify browser integration
without spending a provider key. Linguistic quality requires a separate real
Koharu/provider run.

## Quality benchmark

Thirty manually annotated Chinese pages form the first gate. The same detected
regions and source text are translated by at least three provider/model
configurations. Reviewers score blind using the PRD rubric and record latency,
cost, omissions, hallucinations, name consistency, and overflow.

Do not publish a model preference until this bake-off is complete.

## Completion record

At handoff, record:

- command and exit status for every automated check;
- browser/extension versions;
- fixtures exercised;
- screenshots for desktop and mobile;
- untested real-provider/model behavior;
- all checklist items that are not applicable and why.

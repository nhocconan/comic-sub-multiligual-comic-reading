import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_MANAGED_BATCH_CANDIDATES,
  ProtocolValidationError,
  validateCandidateSnapshot,
  validateJobBatchRequest,
  validateSafeTelemetryEvent,
} from '../src/index.js'

function snapshot(count = 2) {
  return {
    snapshotId: 'snapshot-1',
    navigationId: 'navigation-1',
    topFrameOrigin: 'https://reader.example/',
    createdAt: '2026-07-30T00:00:00.000Z',
    candidates: Array.from({ length: count }, (_, index) => ({
      candidateId: `candidate-${index}`,
      frameId: 'top',
      domOrdinal: index,
      sourceUrl: `https://cdn.example/page-${index}.jpg`,
      sourceOrigin: 'https://cdn.example/',
      renderedRect: { x: 0, y: index * 1000, width: 800, height: 1000 },
      intrinsicWidth: 1600,
      intrinsicHeight: 2000,
      acquisitionCapabilities: ['source-blob', 'element-capture'],
    })),
  }
}

test('normalizes an immutable candidate snapshot contract', () => {
  const value = validateCandidateSnapshot(snapshot())
  assert.equal(value.candidates.length, 2)
  assert.equal(value.topFrameOrigin, 'https://reader.example')
  assert.equal(value.candidates[0].sourceOrigin, 'https://cdn.example')
})

test('rejects a candidate not present in the frozen snapshot', () => {
  assert.throws(
    () =>
      validateJobBatchRequest(
        {
          snapshotId: 'snapshot-1',
          candidateIds: ['candidate-missing'],
          requestedExecution: {},
        },
        snapshot(),
      ),
    (error) =>
      error instanceof ProtocolValidationError &&
      error.code === 'CANDIDATE_NOT_IN_SNAPSHOT',
  )
})

test('enforces the managed Translate All batch ceiling', () => {
  const value = snapshot(MAX_MANAGED_BATCH_CANDIDATES + 1)
  assert.throws(
    () =>
      validateJobBatchRequest(
        {
          snapshotId: value.snapshotId,
          candidateIds: value.candidates.map((candidate) => candidate.candidateId),
          requestedExecution: { locus: 'managed' },
        },
        value,
      ),
    (error) =>
      error instanceof ProtocolValidationError &&
      error.code === 'MANAGED_BATCH_LIMIT_EXCEEDED',
  )
})

test('safe telemetry rejects URL and OCR content by construction', () => {
  assert.throws(
    () =>
      validateSafeTelemetryEvent({
        eventId: 'event-123',
        requestId: 'request-123',
        jobId: 'job-12345',
        timestamp: new Date().toISOString(),
        stage: 'OCR',
        sourceUrl: 'https://private.example/chapter',
      }),
    (error) =>
      error instanceof ProtocolValidationError &&
      error.code === 'UNSAFE_TELEMETRY_FIELD',
  )
})

test('accepts bounded client OCR geometry only for selected snapshot candidates', () => {
  const value = validateJobBatchRequest(
    {
      snapshotId: 'snapshot-1',
      candidateIds: ['candidate-0'],
      requestedExecution: { locus: 'managed' },
      pipeline: { translationMode: 'client-ocr' },
      clientOcr: {
        'candidate-0': {
          page: { width: 1600, height: 2000 },
          regions: [{
            id: 'vision-region-1',
            x: 100,
            y: 120,
            width: 400,
            height: 180,
            source: '时空之力',
            confidence: 0.94,
          }],
        },
      },
    },
    snapshot(),
  )
  assert.equal(value.pipeline.translationMode, 'client-ocr')
  assert.equal(value.clientOcr['candidate-0'].regions[0].source, '时空之力')
  assert.equal(value.clientOcr['candidate-0'].regions[0].rotation, 0)
})

test('rejects client OCR geometry outside its declared page', () => {
  assert.throws(
    () => validateJobBatchRequest(
      {
        snapshotId: 'snapshot-1',
        candidateIds: ['candidate-0'],
        requestedExecution: {},
        pipeline: { translationMode: 'client-ocr' },
        clientOcr: {
          'candidate-0': {
            page: { width: 100, height: 100 },
            regions: [{
              id: 'vision-region-1',
              x: 80,
              y: 0,
              width: 30,
              height: 10,
              source: '越界',
            }],
          },
        },
      },
      snapshot(),
    ),
    (error) =>
      error instanceof ProtocolValidationError &&
      error.code === 'CLIENT_OCR_REGION_OUT_OF_BOUNDS',
  )
})

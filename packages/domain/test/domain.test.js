import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_MODEL,
  GlossaryBootstrapService,
  createHistoryRecord,
  createGlossarySnapshot,
  createModelReceipt,
  createResumeAnchor,
  resolveExecution,
  resolveResume,
  transitionJob,
  validateSeriesBootstrapRequest,
} from '../src/index.js'

const contract = {
  pipeline: { ocrVersion: 'ocr', layoutVersion: 'layout', renderVersion: 'render', promptVersion: 'prompt' },
  language: { source: 'zh-Hans', target: 'vi' },
  translationStyle: 'natural',
  glossarySnapshot: { id: 'empty', version: 0, hash: '0'.repeat(64) },
  privacyPolicyVersion: 'local-v1',
}

test('resolves Gemini 3.6 Flash once and emits a verifiable receipt', () => {
  const execution = resolveExecution({}, contract)
  assert.equal(execution.resolvedExecution.model, DEFAULT_MODEL)
  assert.equal(execution.executionFingerprint.length, 64)
  assert.throws(() => { execution.resolvedExecution.model = 'changed' }, TypeError)
  const receipt = createModelReceipt(execution, { providerReportedModel: DEFAULT_MODEL })
  assert.equal(receipt.modelMatched, true)
})

test('job transitions are explicit and immutable', () => {
  const job = Object.freeze({ state: 'CREATED', events: [] })
  const next = transitionJob(job, 'VALIDATED', { timestamp: '2026-07-30T00:00:00.000Z' })
  assert.equal(next.state, 'VALIDATED')
  assert.throws(() => transitionJob(next, 'OCR'), /cannot transition/)
})

test('history resume prioritizes content hash then URL fingerprint', () => {
  const secret = 'device-only-secret-value'
  const sourceHash = 'a'.repeat(64)
  const anchor = createResumeAnchor({
    sourceHash,
    sourceUrl: 'https://reader.example/page.jpg?utm_source=x',
    domOrdinal: 8,
    intraItemProgress: 0.4,
  }, secret)
  const strong = resolveResume(anchor, [{ candidateId: 'x', sourceHash, domOrdinal: 2 }], secret)
  assert.equal(strong.confidence, 'strong')
  const mediumAnchor = createResumeAnchor({
    sourceUrl: 'https://reader.example/page.jpg?utm_source=x',
    domOrdinal: 8,
  }, secret)
  const medium = resolveResume(
    mediumAnchor,
    [{ candidateId: 'y', sourceUrl: 'https://reader.example/page.jpg', domOrdinal: 7 }],
    secret,
  )
  assert.equal(medium.confidence, 'medium')
  const record = createHistoryRecord({
    workId: 'work-12345',
    title: 'Example',
    url: 'https://reader.example/chapter?token=secret&utm_source=ad',
  }, secret)
  assert.equal(record.canonicalOrigin, 'https://reader.example')
  assert.equal(JSON.stringify(record).includes('secret'), false)
})

test('external glossary assertions remain quarantined until observed locally', async () => {
  const service = new GlossaryBootstrapService({
    allowedSourceClasses: ['official-wiki'],
    allowedOrigins: ['https://official.example'],
  })
  const local = service.bootstrapLocal({
    series: { id: 'series-123', status: 'confirmed' },
    continuity: [{ sourceTerm: '师父', targetTerm: 'Sư phụ' }],
    userCorrections: [{ sourceTerm: '师父', targetTerm: 'Sư tôn' }],
  })
  assert.equal(local.assertions[0].targetTerm, 'Sư tôn')
  const external = await service.research({
    series: { id: 'series-123', status: 'confirmed' },
    consent: {
      seriesId: 'series-123',
      policyVersion: 'research-v1',
      state: 'granted',
      allowedSourceClasses: ['official-wiki'],
      grantedAt: new Date().toISOString(),
    },
    provider: async () => [{
      sourceTerm: '魔尊',
      targetTerm: 'Ma Tôn',
      sourceClass: 'official-wiki',
      sourceUrl: 'https://official.example/terms',
    }],
  })
  assert.equal(external[0].status, 'quarantined')
  assert.equal(service.activateObserved(external, ['那个魔尊已经来了'])[0].status, 'active')
})

test('series bootstrap normalization and glossary snapshots are deterministic', () => {
  const request = validateSeriesBootstrapRequest({
    seriesId: 'series-123',
    title: '  魔尊  ',
    chapterBoundary: 'chapter-12',
    targetLanguage: 'vi',
    privateMode: true,
    locallyObservedAliases: ['魔尊'],
  })
  assert.equal(request.normalizedTitle, '魔尊')
  assert.equal(request.privateMode, true)
  const first = createGlossarySnapshot('series-123', 1, [
    { assertionId: 'b', sourceTerm: 'B', targetTerm: 'B', status: 'active' },
    { assertionId: 'a', sourceTerm: 'A', targetTerm: 'A', status: 'active' },
  ])
  const second = createGlossarySnapshot('series-123', 1, [...first.entries].reverse())
  assert.equal(first.hash, second.hash)
})

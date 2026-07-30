const test = require('node:test')
const assert = require('node:assert/strict')
const { estimateBatch, migrateSettings, receiptFor, safeAssetReferrer, safeUrl } = require('../lib/domain.cjs')

test('sanitizes browser URLs and rejects unsafe protocols', () => {
  assert.equal(safeUrl('https://user:pass@example.com/chapter#panel').startsWith('https://example.com/chapter'), true)
  assert.throws(() => safeUrl('file:///etc/passwd'))
})

test('uses an origin-only asset referrer accepted by Chromium cross-origin fetches', () => {
  assert.equal(
    safeAssetReferrer('https://www.baozimh.com/comic/chapter/title/0_807.html?from=reader#panel'),
    'https://www.baozimh.com/',
  )
  assert.throws(() => safeAssetReferrer('file:///etc/passwd'))
})

test('managed all snapshot has a capped transparent estimate', () => {
  assert.deepEqual(estimateBatch(42, 'managed'), { count: 42, upperBoundUsd: 0.5, batches: 1 })
  assert.equal(estimateBatch(250, 'local').count, 200)
})

test('legacy automatic model selection asks rather than overwrites', () => {
  assert.equal(migrateSettings({ model: 'gemini-3.5-flash' }).needsModelChoice, true)
  assert.equal(migrateSettings({ model: 'gemini-3.5-flash', modelProvenance: 'user-pinned' }).needsModelChoice, false)
})

test('production broker is the zero-config default', () => {
  assert.equal(migrateSettings({}).settings.brokerEndpoint, 'https://comic-be.dep.app')
  assert.equal(
    migrateSettings({ brokerEndpoint: 'http://127.0.0.1:4100' }).settings.brokerEndpoint,
    'https://comic-be.dep.app',
  )
})

test('receipt makes an external AI text destination explicit', () => {
  const receipt = receiptFor({ route: 'byo', serverUrl: 'https://reader.example.test' })
  assert.equal(receipt.imageDestination, 'This computer')
  assert.match(receipt.textDestination, /External AI/)
  assert.equal(receipt.server, 'reader.example.test')
})

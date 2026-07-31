'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  MAX_CACHE_BYTES,
  cacheLimit,
  cachedResults,
  recordTranslation,
} = require('../lib/translation-cache.cjs')

const result = (text) => ({
  page: { width: 900, height: 1_200 },
  overlayRegions: [{
    id: 'r1',
    x: 100,
    y: 200,
    width: 240,
    height: 90,
    source: '成功',
    translation: text,
  }],
})

test('translation cache defaults to ten chapters and accepts 0/5/10 only', () => {
  assert.equal(cacheLimit(undefined), 10)
  assert.equal(cacheLimit(0), 0)
  assert.equal(cacheLimit(5), 5)
  assert.equal(cacheLimit(10), 10)
  assert.equal(cacheLimit(99), 10)
})

test('cache keeps text geometry, replaces a newer engine result, and restores by source URL', () => {
  let cache = recordTranslation([], {
    pageUrl: 'https://reader.test/chapter/1',
    targetLanguage: 'vi-VN',
    sourceUrl: 'https://cdn.test/1.jpg',
    result: result('Thành công.'),
    receipt: { resolvedProvider: 'apple-translation', resolvedModel: 'on-device', modelMatched: true },
    route: 'local',
  }, 10)
  cache = recordTranslation(cache, {
    pageUrl: 'https://reader.test/chapter/1',
    targetLanguage: 'vi-VN',
    sourceUrl: 'https://cdn.test/1.jpg',
    result: result('Đã thành công!'),
    receipt: { resolvedProvider: 'gemini', resolvedModel: 'gemini-current', modelMatched: true },
    route: 'byo',
  }, 10)
  const restored = cachedResults(cache, {
    pageUrl: 'https://reader.test/chapter/1',
    candidates: [{ candidateId: 'new-id', sourceUrl: 'https://cdn.test/1.jpg' }],
  }, 'vi-VN')
  assert.equal(restored.length, 1)
  assert.equal(restored[0].candidateId, 'new-id')
  assert.equal(restored[0].result.overlayRegions[0].translation, 'Đã thành công!')
  assert.equal(restored[0].receipt.route, 'byo')
})

test('cache is disabled at zero and stays inside a hard two MiB budget', () => {
  assert.deepEqual(recordTranslation([], {
    pageUrl: 'https://reader.test/chapter/1',
    targetLanguage: 'vi-VN',
    sourceUrl: 'https://cdn.test/1.jpg',
    result: result('Text'),
  }, 0), [])
  let cache = []
  for (let chapter = 0; chapter < 10; chapter += 1) {
    for (let image = 0; image < 200; image += 1) {
      cache = recordTranslation(cache, {
        pageUrl: `https://reader.test/chapter/${chapter}`,
        targetLanguage: 'vi-VN',
        sourceUrl: `https://cdn.test/${chapter}/${image}.jpg`,
        result: result('x'.repeat(2_000)),
      }, 10)
    }
  }
  assert.ok(Buffer.byteLength(JSON.stringify(cache), 'utf8') <= MAX_CACHE_BYTES)
})

test('cache never restores an unchanged Chinese result as translated Vietnamese', () => {
  const bad = [{
    pageUrl: 'https://reader.test/chapter/1',
    targetLanguage: 'vi-VN',
    items: [{
      sourceUrl: 'https://cdn.test/1.jpg',
      result: result('成功'),
      receipt: { route: 'byo' },
    }],
  }]
  assert.deepEqual(cachedResults(bad, {
    pageUrl: 'https://reader.test/chapter/1',
    candidates: [{ candidateId: 'candidate-1', sourceUrl: 'https://cdn.test/1.jpg' }],
  }, 'vi-VN'), [])
})

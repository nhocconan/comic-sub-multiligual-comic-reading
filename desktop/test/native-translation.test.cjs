'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  attachNativeTranslations,
  languageIdentifier,
  nativeTranslationInput,
} = require('../lib/native-translation.cjs')

test('maps app locales to Apple Translation language identifiers', () => {
  assert.equal(languageIdentifier('vi-VN'), 'vi')
  assert.equal(languageIdentifier('zh-CN'), 'zh-Hans')
  assert.equal(languageIdentifier('auto', 'zh-Hans'), 'zh-Hans')
})

test('batches OCR text only and reattaches local geometry', () => {
  const pages = [{
    candidateId: 'page-1',
    ocr: {
      page: { width: 900, height: 1200 },
      regions: [{
        id: 'bubble-1',
        x: 100,
        y: 200,
        width: 300,
        height: 100,
        source: '成功。',
      }],
    },
  }]
  const input = nativeTranslationInput(pages, { targetLanguage: 'vi-VN' })
  assert.equal(input.sourceLanguage, 'zh-Hans')
  assert.deepEqual(input.requests, [{ id: 'page-1::bubble-1', text: '成功。' }])
  assert.equal(JSON.stringify(input).includes('sourceUrl'), false)
  const results = attachNativeTranslations(pages, {
    availability: 'installed',
    translations: [{ id: 'page-1::bubble-1', text: 'Thành công.' }],
  })
  assert.deepEqual(results[0].overlayRegions[0], {
    id: 'bubble-1',
    x: 100,
    y: 200,
    width: 300,
    height: 100,
    source: '成功。',
    translation: 'Thành công.',
  })
})

test('keeps automatic source detection for the native helper', () => {
  const input = nativeTranslationInput([], {
    sourceLanguage: 'auto',
    targetLanguage: 'vi-VN',
  })
  assert.equal(input.sourceLanguage, 'auto')
})

test('rejects incomplete Apple Translation batches', () => {
  const pages = [{
    candidateId: 'p',
    ocr: {
      page: { width: 1, height: 1 },
      regions: [{ id: 'a', source: '甲' }, { id: 'b', source: '乙' }],
    },
  }]
  assert.throws(
    () => attachNativeTranslations(pages, {
      availability: 'installed',
      translations: [{ id: 'p::a', text: 'A' }],
    }),
    /1\/2/,
  )
})

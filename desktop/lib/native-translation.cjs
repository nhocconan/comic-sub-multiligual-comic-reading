'use strict'

const { BrokerClientError } = require('./broker-client.cjs')

function languageIdentifier(value, fallback = '') {
  const normalized = String(value || '').trim()
  return {
    auto: fallback,
    'vi-VN': 'vi',
    'en-US': 'en',
    'fr-FR': 'fr',
    'zh-CN': 'zh-Hans',
    'zh-TW': 'zh-Hant',
    'zh-Hans': 'zh-Hans',
    'zh-Hant': 'zh-Hant',
    'ja-JP': 'ja',
    'ko-KR': 'ko',
  }[normalized] || normalized.split('-')[0] || fallback
}

function nativeTranslationInput(pages, {
  sourceLanguage = 'zh-Hans',
  targetLanguage = 'vi-VN',
} = {}) {
  const requests = []
  for (const page of pages) {
    for (const [index, region] of (page.ocr?.regions || []).entries()) {
      const text = String(region?.source || '').trim()
      if (!text) continue
      requests.push({
        id: `${page.candidateId}::${region.id || index}`,
        text,
      })
    }
  }
  return {
    sourceLanguage: sourceLanguage === 'auto'
      ? 'auto'
      : languageIdentifier(sourceLanguage, 'zh-Hans'),
    targetLanguage: languageIdentifier(targetLanguage, 'vi'),
    requests,
  }
}

function attachNativeTranslations(pages, value) {
  if (value?.availability !== 'installed' || !Array.isArray(value?.translations)) {
    throw new BrokerClientError(
      'LOCAL_TRANSLATION_INVALID',
      'Apple Translation trả payload không hợp lệ.',
    )
  }
  const expected = new Set()
  for (const page of pages) {
    for (const [index, region] of (page.ocr?.regions || []).entries()) {
      if (String(region?.source || '').trim()) {
        expected.add(`${page.candidateId}::${region.id || index}`)
      }
    }
  }
  const translations = new Map()
  for (const item of value.translations) {
    const id = String(item?.id || '')
    const text = String(item?.text || '').trim()
    if (!expected.has(id) || !text || translations.has(id)) {
      throw new BrokerClientError(
        'LOCAL_TRANSLATION_INVALID',
        'Apple Translation trả ID vùng chữ không hợp lệ hoặc bị trùng.',
      )
    }
    translations.set(id, text)
  }
  if (translations.size !== expected.size) {
    throw new BrokerClientError(
      'LOCAL_TRANSLATION_INCOMPLETE',
      `Apple Translation chỉ trả ${translations.size}/${expected.size} vùng chữ.`,
    )
  }
  return pages.map((page) => ({
    candidateId: page.candidateId,
    page: page.ocr.page,
    overlayRegions: (page.ocr.regions || []).map((region, index) => ({
      ...region,
      translation: translations.get(`${page.candidateId}::${region.id || index}`) || '',
    })).filter((region) => region.translation),
  }))
}

module.exports = {
  attachNativeTranslations,
  languageIdentifier,
  nativeTranslationInput,
}

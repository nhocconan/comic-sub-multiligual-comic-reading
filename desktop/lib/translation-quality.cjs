'use strict'

function comparableText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '')
}

function hanCount(value) {
  return (String(value || '').match(/\p{Script=Han}/gu) || []).length
}

function targetMayUseHan(targetLanguage) {
  return /(chinese|中文|简体|繁體|繁体|japanese|日本語|zh(?:-|$)|ja(?:-|$))/i
    .test(String(targetLanguage || '').trim())
}

function isUntranslatedRegion(source, translation, targetLanguage) {
  const sourceText = String(source || '').trim()
  const translatedText = String(translation || '').trim()
  if (!sourceText || !translatedText || !hanCount(sourceText) || targetMayUseHan(targetLanguage)) {
    return false
  }
  const sourceComparable = comparableText(sourceText)
  const translationComparable = comparableText(translatedText)
  if (sourceComparable && sourceComparable === translationComparable) return true

  const translatedHan = hanCount(translatedText)
  const translatedLetters = (translatedText.match(/[\p{L}\p{N}]/gu) || []).length
  return translatedHan > 0 && translatedHan / Math.max(1, translatedLetters) >= 0.45
}

function untranslatedRegionIds(translations, sources, targetLanguage) {
  const failed = []
  for (const [id, source] of sources) {
    if (isUntranslatedRegion(source, translations.get(id), targetLanguage)) failed.push(id)
  }
  return failed
}

function resultHasUntranslatedRegions(result, targetLanguage) {
  return (result?.overlayRegions || []).some((region) =>
    isUntranslatedRegion(region?.source, region?.translation, targetLanguage))
}

module.exports = {
  isUntranslatedRegion,
  resultHasUntranslatedRegions,
  untranslatedRegionIds,
}

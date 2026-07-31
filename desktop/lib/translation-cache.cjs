'use strict'

const MAX_CACHE_BYTES = 2 * 1024 * 1024

function cacheLimit(value) {
  const number = Number(value)
  return number === 0 || number === 5 || number === 10 ? number : 10
}

function boundedText(value, maximum = 2_000) {
  return String(value || '').trim().slice(0, maximum)
}

function sanitizeResult(value) {
  const page = {
    width: Number(value?.page?.width),
    height: Number(value?.page?.height),
  }
  if (![page.width, page.height].every(Number.isFinite)
    || page.width <= 1 || page.height <= 1) return null
  const overlayRegions = (value?.overlayRegions || []).slice(0, 200).flatMap((region, index) => {
    const clean = {
      id: boundedText(region?.id || `region-${index}`, 256),
      x: Number(region?.x),
      y: Number(region?.y),
      width: Number(region?.width),
      height: Number(region?.height),
      rotation: Number(region?.rotation) || 0,
      source: boundedText(region?.source),
      translation: boundedText(region?.translation),
    }
    if (![clean.x, clean.y, clean.width, clean.height].every(Number.isFinite)
      || clean.width <= 1 || clean.height <= 1 || !clean.translation) return []
    return [clean]
  })
  return overlayRegions.length ? { page, overlayRegions } : null
}

function sanitizeReceipt(value, route) {
  return {
    route: boundedText(route || value?.route, 32),
    requestedProvider: boundedText(value?.requestedProvider, 128),
    requestedModel: boundedText(value?.requestedModel, 256),
    resolvedProvider: boundedText(value?.resolvedProvider, 128),
    resolvedModel: boundedText(value?.resolvedModel, 256),
    providerReportedModel: boundedText(value?.providerReportedModel, 256),
    modelMatched: value?.modelMatched === true,
    completedAt: boundedText(value?.completedAt, 64) || new Date().toISOString(),
  }
}

function fitByteBudget(entries) {
  const next = entries
  while (next.length && Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_CACHE_BYTES) {
    const oldest = next.at(-1)
    if (oldest?.items?.length > 1) oldest.items.pop()
    else next.pop()
  }
  return next
}

function recordTranslation(cache, {
  pageUrl,
  targetLanguage,
  sourceUrl,
  result,
  receipt,
  route,
  updatedAt = new Date().toISOString(),
}, limitValue = 10) {
  const limit = cacheLimit(limitValue)
  if (!limit) return []
  const cleanResult = sanitizeResult(result)
  const cleanPageUrl = boundedText(pageUrl, 4_096)
  const cleanSourceUrl = boundedText(sourceUrl, 4_096)
  const cleanTarget = boundedText(targetLanguage, 32)
  if (!cleanResult || !cleanPageUrl || !cleanSourceUrl || !cleanTarget) {
    return pruneTranslationCache(cache, limit)
  }
  const previous = (Array.isArray(cache) ? cache : []).find(
    (entry) => entry?.pageUrl === cleanPageUrl && entry?.targetLanguage === cleanTarget,
  )
  const item = {
    sourceUrl: cleanSourceUrl,
    result: cleanResult,
    receipt: sanitizeReceipt(receipt, route),
  }
  const chapter = {
    pageUrl: cleanPageUrl,
    targetLanguage: cleanTarget,
    updatedAt: boundedText(updatedAt, 64),
    items: [
      item,
      ...(previous?.items || []).filter((entry) => entry?.sourceUrl !== cleanSourceUrl),
    ].slice(0, 200),
  }
  const entries = [
    chapter,
    ...(Array.isArray(cache) ? cache : []).filter(
      (entry) => entry?.pageUrl !== cleanPageUrl || entry?.targetLanguage !== cleanTarget,
    ),
  ].slice(0, limit)
  return fitByteBudget(entries)
}

function pruneTranslationCache(cache, limitValue = 10) {
  const limit = cacheLimit(limitValue)
  if (!limit) return []
  const entries = (Array.isArray(cache) ? cache : [])
    .filter((entry) => entry?.pageUrl && entry?.targetLanguage && Array.isArray(entry?.items))
    .slice(0, limit)
  return fitByteBudget(entries)
}

function cachedResults(cache, snapshot, targetLanguage) {
  const chapter = (Array.isArray(cache) ? cache : []).find(
    (entry) => entry?.pageUrl === snapshot?.pageUrl
      && entry?.targetLanguage === targetLanguage,
  )
  if (!chapter) return []
  const bySource = new Map((chapter.items || []).map((item) => [item.sourceUrl, item]))
  return (snapshot?.candidates || []).flatMap((candidate) => {
    const cached = bySource.get(candidate?.sourceUrl)
    return cached ? [{
      candidateId: candidate.candidateId,
      sourceUrl: candidate.sourceUrl,
      result: cached.result,
      receipt: cached.receipt,
    }] : []
  })
}

module.exports = {
  MAX_CACHE_BYTES,
  cacheLimit,
  cachedResults,
  pruneTranslationCache,
  recordTranslation,
}

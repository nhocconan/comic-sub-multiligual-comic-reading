import { randomUUID } from 'node:crypto'

import { validateResearchConsent } from '../../protocol/src/index.js'
import { deepFreeze, sha256, stableStringify } from './stable.js'
import { DomainError } from './execution.js'

export function normalizeGlossaryTerm(value) {
  return String(value ?? '').normalize('NFKC').trim()
}

function allowedOrigin(url, origins) {
  try {
    return origins.includes(new URL(url).origin)
  } catch {
    return false
  }
}

function confidence(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : fallback
}

export class GlossaryBootstrapService {
  constructor({ allowedSourceClasses = [], allowedOrigins = [] } = {}) {
    this.allowedSourceClasses = new Set(allowedSourceClasses)
    this.allowedOrigins = [...allowedOrigins]
  }

  bootstrapLocal({ series, continuity = [], userCorrections = [] }) {
    if (!series?.id) throw new DomainError('SERIES_REQUIRED', 'A series identity is required')
    const bySource = new Map()
    for (const item of continuity) {
      const sourceTerm = normalizeGlossaryTerm(item.sourceTerm)
      const targetTerm = normalizeGlossaryTerm(item.targetTerm)
      if (!sourceTerm || !targetTerm) continue
      bySource.set(sourceTerm, {
        assertionId: item.assertionId ?? randomUUID(),
        sourceTerm,
        targetTerm,
        origin: 'local-continuity',
        status: 'active',
        confidence: confidence(item.confidence, 0.75),
        provenance: [{ kind: 'local-history', reference: item.reference ?? null }],
      })
    }
    for (const item of userCorrections) {
      const sourceTerm = normalizeGlossaryTerm(item.sourceTerm)
      const targetTerm = normalizeGlossaryTerm(item.targetTerm)
      if (!sourceTerm || !targetTerm) continue
      bySource.set(sourceTerm, {
        assertionId: item.assertionId ?? randomUUID(),
        sourceTerm,
        targetTerm,
        origin: 'user-override',
        status: 'active',
        confidence: 1,
        provenance: [{ kind: 'user-correction', reference: item.reference ?? null }],
      })
    }
    return deepFreeze({
      series: structuredClone(series),
      assertions: [...bySource.values()],
      createdAt: new Date().toISOString(),
    })
  }

  async research({ series, consent, provider }) {
    if (series?.status !== 'confirmed') {
      throw new DomainError('AMBIGUOUS_SERIES', 'External research requires a confirmed series identity')
    }
    const normalizedConsent = validateResearchConsent(consent)
    if (normalizedConsent.seriesId !== series.id || normalizedConsent.state !== 'granted') {
      throw new DomainError('RESEARCH_NOT_CONSENTED', 'External glossary research was not granted')
    }
    if (typeof provider !== 'function') {
      throw new DomainError('RESEARCH_PROVIDER_REQUIRED', 'A research provider is required')
    }
    const results = await provider({ series: structuredClone(series), consent: normalizedConsent })
    const quarantined = []
    for (const item of results ?? []) {
      if (
        !normalizedConsent.allowedSourceClasses.includes(item.sourceClass) ||
        !this.allowedSourceClasses.has(item.sourceClass) ||
        !allowedOrigin(item.sourceUrl, this.allowedOrigins)
      ) {
        continue
      }
      const sourceTerm = normalizeGlossaryTerm(item.sourceTerm)
      const targetTerm = normalizeGlossaryTerm(item.targetTerm)
      if (!sourceTerm || !targetTerm) continue
      quarantined.push({
        assertionId: item.assertionId ?? randomUUID(),
        sourceTerm,
        targetTerm,
        origin: 'external-research',
        status: 'quarantined',
        confidence: confidence(item.confidence, 0.5),
        provenance: [{
          kind: item.sourceClass,
          sourceUrl: item.sourceUrl,
          retrievedAt: item.retrievedAt ?? new Date().toISOString(),
        }],
      })
    }
    return deepFreeze(quarantined)
  }

  activateObserved(assertions, observedSourceTerms) {
    const observed = observedSourceTerms
      .map(normalizeGlossaryTerm)
      .filter(Boolean)
    return deepFreeze(assertions.map((assertion) => ({
      ...structuredClone(assertion),
      status:
        assertion.status === 'quarantined' &&
        observed.some((text) => {
          const source = normalizeGlossaryTerm(assertion.sourceTerm)
          // A researched name is considered locally observed when OCR contains
          // it inside a dialogue region. Avoid activating one-character noise.
          return source.length >= 2 && text.includes(source)
        })
          ? 'active'
          : assertion.status,
    })))
  }
}

function boundedText(value, name, max = 512) {
  const normalized = normalizeGlossaryTerm(value)
  if (!normalized || normalized.length > max) {
    throw new DomainError('INVALID_SERIES_INPUT', `${name} must contain between 1 and ${max} characters`)
  }
  return normalized
}

export function validateSeriesBootstrapRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('INVALID_SERIES_INPUT', 'Series bootstrap input must be an object')
  }
  const seriesId = boundedText(value.seriesId, 'seriesId', 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(seriesId)) {
    throw new DomainError('INVALID_SERIES_INPUT', 'seriesId has an invalid format')
  }
  const targetLanguage = boundedText(value.targetLanguage ?? 'vi', 'targetLanguage', 64)
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(targetLanguage)) {
    throw new DomainError('INVALID_SERIES_INPUT', 'targetLanguage must be a BCP-47 language tag')
  }
  const list = (input, name, limit = 500) => {
    if (input === undefined) return []
    if (!Array.isArray(input) || input.length > limit) {
      throw new DomainError('INVALID_SERIES_INPUT', `${name} must be an array of at most ${limit} entries`)
    }
    return input
  }
  const termPairs = (input, name) =>
    list(input, name).map((entry) => ({
      sourceTerm: boundedText(entry?.sourceTerm, `${name}.sourceTerm`),
      targetTerm: boundedText(entry?.targetTerm, `${name}.targetTerm`),
      confidence:
        entry?.confidence === undefined
          ? undefined
          : confidence(entry.confidence, 0.5),
      reference:
        entry?.reference === undefined
          ? undefined
          : boundedText(entry.reference, `${name}.reference`, 256),
    }))
  const chapterBoundary =
    value.chapterBoundary === undefined || value.chapterBoundary === null
      ? null
      : boundedText(value.chapterBoundary, 'chapterBoundary', 128)
  return {
    seriesId,
    normalizedTitle: boundedText(value.title, 'title'),
    chapterBoundary,
    targetLanguage,
    privateMode: value.privateMode === true,
    seriesStatus: ['confirmed', 'ambiguous'].includes(value.seriesStatus)
      ? value.seriesStatus
      : 'confirmed',
    localContinuity: termPairs(value.localContinuity, 'localContinuity'),
    userCorrections: termPairs(value.userCorrections, 'userCorrections'),
    locallyObservedAliases: list(value.locallyObservedAliases, 'locallyObservedAliases', 1_000)
      .map((entry) => boundedText(entry, 'locallyObservedAliases')),
    researchConsent: value.researchConsent ?? null,
  }
}

export function createGlossarySnapshot(seriesId, version, entries) {
  const canonicalEntries = [...entries]
    .map((entry) => structuredClone(entry))
    .sort((left, right) =>
      `${left.sourceTerm}\u0000${left.targetTerm}\u0000${left.assertionId}`.localeCompare(
        `${right.sourceTerm}\u0000${right.targetTerm}\u0000${right.assertionId}`,
      ))
  const hash = sha256(stableStringify(canonicalEntries))
  return deepFreeze({
    id: `series-glossary:${seriesId}`,
    version,
    hash,
    entries: canonicalEntries,
  })
}

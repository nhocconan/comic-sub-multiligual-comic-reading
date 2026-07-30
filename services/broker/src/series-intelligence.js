import { randomUUID } from 'node:crypto'

import {
  GlossaryBootstrapService,
  createGlossarySnapshot,
  normalizeGlossaryTerm,
  stableStringify,
  validateSeriesBootstrapRequest,
} from '../../../packages/domain/src/index.js'
import { validateResearchConsent } from '../../../packages/protocol/src/index.js'
import { BrokerError } from './broker.js'

function keyFor(principal, seriesId) {
  return `${principal.tenantId}:${principal.deviceId}:${seriesId}`
}

function mergeEntries(localEntries, externalEntries) {
  const entries = new Map()
  for (const entry of [...localEntries, ...externalEntries]) {
    const key = [
      normalizeGlossaryTerm(entry.sourceTerm),
      normalizeGlossaryTerm(entry.targetTerm),
      entry.origin,
      entry.provenance?.[0]?.sourceUrl ?? '',
    ].join('\u0000')
    entries.set(key, structuredClone(entry))
  }
  return [...entries.values()].sort((left, right) => {
    const priority = { 'user-override': 0, 'local-continuity': 1, 'external-research': 2 }
    return (priority[left.origin] ?? 9) - (priority[right.origin] ?? 9)
  })
}

function snapshotHistory(existing, next) {
  const candidates = [
    ...(existing?.snapshotHistory ?? (existing?.snapshot ? [existing.snapshot] : [])),
    next,
  ]
  const unique = new Map(candidates.map((snapshot) => [
    `${snapshot.id}:${snapshot.version}:${snapshot.hash}`,
    structuredClone(snapshot),
  ]))
  return [...unique.values()].slice(-16)
}

function publicRecord(record) {
  const entries = record.snapshot.entries
  const citations = []
  const seen = new Set()
  for (const entry of entries) {
    for (const provenance of entry.provenance ?? []) {
      if (!provenance.sourceUrl || seen.has(provenance.sourceUrl)) continue
      seen.add(provenance.sourceUrl)
      citations.push({
        sourceClass: provenance.kind,
        sourceUrl: provenance.sourceUrl,
        retrievedAt: provenance.retrievedAt,
      })
    }
  }
  return {
    series: record.series,
    glossarySnapshot: record.snapshot,
    citations,
    quarantinedTerms: entries.filter((entry) => entry.status === 'quarantined'),
    research: record.research,
    updatedAt: record.updatedAt,
  }
}

export class SeriesIntelligenceService {
  constructor({ repository, research }) {
    this.repository = repository
    this.research = research
  }

  async bootstrap(principal, input) {
    const request = validateSeriesBootstrapRequest(input)
    let consent = null
    if (request.researchConsent) {
      consent = validateResearchConsent(request.researchConsent)
      if (consent.seriesId !== request.seriesId) {
        throw new BrokerError(400, 'CONSENT_SERIES_MISMATCH', 'Research consent belongs to another series')
      }
    }
    const researchAllowed =
      !request.privateMode &&
      request.seriesStatus === 'confirmed' &&
      consent?.state === 'granted' &&
      this.research?.enabled === true
    const researchRequestId = researchAllowed ? `research:${randomUUID()}` : null
    const saved = await this.repository.mutate((state) => {
      state.seriesGlossaries ??= {}
      const key = keyFor(principal, request.seriesId)
      const existing = state.seriesGlossaries[key]
      const existingEntries = existing?.snapshot?.entries ?? []
      const localService = new GlossaryBootstrapService()
      const local = localService.bootstrapLocal({
        series: { id: request.seriesId, status: request.seriesStatus },
        continuity: [
          ...existingEntries
            .filter((entry) => entry.origin === 'local-continuity')
            .map((entry) => ({
              sourceTerm: entry.sourceTerm,
              targetTerm: entry.targetTerm,
              confidence: entry.confidence,
              reference: entry.provenance?.[0]?.reference,
            })),
          ...request.localContinuity,
        ],
        userCorrections: [
          ...existingEntries
            .filter((entry) => entry.origin === 'user-override')
            .map((entry) => ({
              sourceTerm: entry.sourceTerm,
              targetTerm: entry.targetTerm,
              reference: entry.provenance?.[0]?.reference,
            })),
          ...request.userCorrections,
        ],
      })
      const existingExternal = localService.activateObserved(
        existingEntries.filter((entry) => entry.origin === 'external-research'),
        request.locallyObservedAliases,
      )
      const entries = mergeEntries(local.assertions, existingExternal)
      const version = (existing?.snapshot?.version ?? 0) + 1
      const now = new Date().toISOString()
      const snapshot = createGlossarySnapshot(request.seriesId, version, entries)
      const record = {
        principal,
        series: {
          id: request.seriesId,
          status: request.seriesStatus,
          normalizedTitle: request.normalizedTitle,
          chapterBoundary: request.chapterBoundary,
          targetLanguage: request.targetLanguage,
          privateMode: request.privateMode,
        },
        snapshot,
        snapshotHistory: snapshotHistory(existing, snapshot),
        research: {
          state: researchAllowed
            ? 'queued'
            : request.privateMode
              ? 'disabled-private'
              : consent?.state === 'granted'
                ? 'disabled'
                : 'not-consented',
          requestId: researchRequestId,
          providers: [],
        },
        updatedAt: now,
      }
      state.seriesGlossaries[key] = record
      return publicRecord(record)
    })
    if (researchAllowed) {
      queueMicrotask(() => {
        this.#research(principal, request, consent, researchRequestId).catch(() =>
          this.#markUnavailable(principal, request.seriesId, researchRequestId).catch(
            () => undefined,
          ))
      })
    }
    return saved
  }

  get(principal, seriesId) {
    return this.repository.read((state) => {
      const record = state.seriesGlossaries?.[keyFor(principal, seriesId)]
      if (!record) throw new BrokerError(404, 'SERIES_GLOSSARY_NOT_FOUND', 'Series glossary not found')
      return publicRecord(record)
    })
  }

  delete(principal, seriesId) {
    return this.repository.mutate((state) => {
      const key = keyFor(principal, seriesId)
      if (!state.seriesGlossaries?.[key]) {
        throw new BrokerError(404, 'SERIES_GLOSSARY_NOT_FOUND', 'Series glossary not found')
      }
      delete state.seriesGlossaries[key]
      return { deleted: true, seriesId }
    })
  }

  async #research(principal, request, consent, researchRequestId) {
    const providerResults = await this.research.research({
      normalizedTitle: request.normalizedTitle,
      chapterBoundary: request.chapterBoundary,
      targetLanguage: request.targetLanguage,
      allowedSourceClasses: consent.allowedSourceClasses,
    })
    const glossaryService = new GlossaryBootstrapService({
      allowedSourceClasses: this.research.allowedSourceClasses(),
      allowedOrigins: this.research.allowedOriginsFor(request.targetLanguage),
    })
    const researched = []
    for (const result of providerResults) {
      if (result.state !== 'complete') continue
      const assertions = await glossaryService.research({
        series: { id: request.seriesId, status: request.seriesStatus },
        consent,
        provider: async () => result.assertions,
      })
      researched.push(...assertions)
    }
    const activated = glossaryService.activateObserved(
      researched,
      request.locallyObservedAliases,
    )
    await this.repository.mutate((state) => {
      const key = keyFor(principal, request.seriesId)
      const record = state.seriesGlossaries?.[key]
      if (!record || record.research.requestId !== researchRequestId) return null
      const before = record.snapshot.entries
      const entries = mergeEntries(before, activated)
      const changed = stableStringify(before) !== stableStringify(entries)
      if (changed) {
        record.snapshot = createGlossarySnapshot(
          request.seriesId,
          record.snapshot.version + 1,
          entries,
        )
        record.snapshotHistory = snapshotHistory(record, record.snapshot)
      }
      record.research = {
        state: providerResults.every((result) => result.state === 'complete')
          ? 'complete'
          : providerResults.some((result) => result.state === 'complete')
            ? 'complete-with-errors'
            : 'unavailable',
        requestId: researchRequestId,
        providers: providerResults.map((result) => ({
          provider: result.provider,
          state: result.state,
          termCount: result.assertions.length,
          error: result.error,
        })),
      }
      record.updatedAt = new Date().toISOString()
      return publicRecord(record)
    })
  }

  async #markUnavailable(principal, seriesId, researchRequestId) {
    return this.repository.mutate((state) => {
      const record = state.seriesGlossaries?.[keyFor(principal, seriesId)]
      if (!record || record.research.requestId !== researchRequestId) return null
      record.research = {
        state: 'unavailable',
        requestId: researchRequestId,
        providers: [],
      }
      record.updatedAt = new Date().toISOString()
      return publicRecord(record)
    })
  }
}

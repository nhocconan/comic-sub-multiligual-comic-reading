import { isDeepStrictEqual } from 'node:util'

export const PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 0 })
export const MAX_SNAPSHOT_CANDIDATES = 200
export const MAX_MANAGED_BATCH_CANDIDATES = 50
export const DEFAULT_MANAGED_BUDGET_MICROS = 500_000

export const PROCESSING_LOCI = Object.freeze([
  'local',
  'on-device',
  'paired',
  'private-server',
  'managed',
])
export const TRANSLATION_PROFILES = Object.freeze(['fast', 'balanced', 'quality'])
export const TRANSLATION_MODES = Object.freeze(['server', 'client-device', 'client-ocr'])
export const MAX_CLIENT_OCR_REGIONS_PER_PAGE = 200
export const ACQUISITION_MODES = Object.freeze([
  'source-blob',
  'broker-fetch',
  'element-capture',
  'manual-region',
  'unsupported',
])

export const JOB_STATES = Object.freeze([
  'CREATED',
  'VALIDATED',
  'BUDGET_RESERVED',
  'WAITING_ASSET',
  'QUEUED',
  'CLAIMED',
  'ACQUIRING',
  'OCR',
  'TRANSLATING',
  'RENDERING',
  'VERIFYING',
  'SUCCEEDED',
  'SETTLED',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'FAILED',
  'EXPIRED',
  'REJECTED',
])

export const TERMINAL_JOB_STATES = Object.freeze([
  'SETTLED',
  'CANCELLED',
  'FAILED',
  'EXPIRED',
  'REJECTED',
])

export class ProtocolValidationError extends Error {
  constructor(code, message, path = '$') {
    super(message)
    this.name = 'ProtocolValidationError'
    this.code = code
    this.path = path
  }
}

function fail(code, message, path) {
  throw new ProtocolValidationError(code, message, path)
}

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_OBJECT', `${path} must be an object`, path)
  }
  return value
}

function string(value, path, { min = 1, max = 1024, pattern } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail('INVALID_STRING', `${path} must be a string between ${min} and ${max} characters`, path)
  }
  if (pattern && !pattern.test(value)) {
    fail('INVALID_STRING_FORMAT', `${path} has an invalid format`, path)
  }
  return value
}

function optionalString(value, path, options) {
  return value === undefined || value === null ? undefined : string(value, path, options)
}

function integer(value, path, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_INTEGER', `${path} must be an integer between ${min} and ${max}`, path)
  }
  return value
}

function number(value, path, { min = -Infinity, max = Infinity } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) {
    fail('INVALID_NUMBER', `${path} must be a number between ${min} and ${max}`, path)
  }
  return value
}

function enumeration(value, values, path) {
  if (!values.includes(value)) {
    fail('INVALID_ENUM', `${path} must be one of: ${values.join(', ')}`, path)
  }
  return value
}

function uuidLike(value, path) {
  return string(value, path, {
    min: 8,
    max: 128,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  })
}

function httpUrl(value, path) {
  string(value, path, { max: 8192 })
  let url
  try {
    url = new URL(value)
  } catch {
    fail('INVALID_URL', `${path} must be a valid URL`, path)
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    fail('INVALID_URL', `${path} must be an HTTP(S) URL without embedded credentials`, path)
  }
  url.hash = ''
  return url.href
}

function exactOrigin(value, path) {
  const normalized = httpUrl(value, path)
  const url = new URL(normalized)
  if (normalized !== `${url.origin}/`) {
    fail('INVALID_ORIGIN', `${path} must contain only scheme, host, and port`, path)
  }
  return url.origin
}

function unique(values, path) {
  if (new Set(values).size !== values.length) {
    fail('DUPLICATE_VALUE', `${path} contains duplicate values`, path)
  }
}

export function validateCandidateSnapshot(value) {
  const input = object(value, '$')
  const candidates = input.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) {
    fail('EMPTY_SNAPSHOT', '$.candidates must contain at least one candidate', '$.candidates')
  }
  if (candidates.length > MAX_SNAPSHOT_CANDIDATES) {
    fail(
      'SNAPSHOT_LIMIT_EXCEEDED',
      `A snapshot may contain at most ${MAX_SNAPSHOT_CANDIDATES} candidates`,
      '$.candidates',
    )
  }

  const normalized = {
    protocolVersion: {
      major: integer(input.protocolVersion?.major ?? PROTOCOL_VERSION.major, '$.protocolVersion.major', {
        min: 1,
        max: PROTOCOL_VERSION.major,
      }),
      minor: integer(input.protocolVersion?.minor ?? PROTOCOL_VERSION.minor, '$.protocolVersion.minor', {
        min: 0,
        max: 10_000,
      }),
    },
    snapshotId: uuidLike(input.snapshotId, '$.snapshotId'),
    navigationId: uuidLike(input.navigationId, '$.navigationId'),
    topFrameOrigin: exactOrigin(input.topFrameOrigin, '$.topFrameOrigin'),
    createdAt: string(input.createdAt, '$.createdAt', { max: 64 }),
    candidates: candidates.map((candidate, index) => {
      const path = `$.candidates[${index}]`
      const item = object(candidate, path)
      const sourceUrl = httpUrl(item.sourceUrl, `${path}.sourceUrl`)
      const sourceOrigin = exactOrigin(item.sourceOrigin, `${path}.sourceOrigin`)
      if (new URL(sourceUrl).origin !== sourceOrigin) {
        fail('SOURCE_ORIGIN_MISMATCH', `${path}.sourceOrigin does not match sourceUrl`, path)
      }
      const acquisitionCapabilities = item.acquisitionCapabilities
      if (!Array.isArray(acquisitionCapabilities) || acquisitionCapabilities.length === 0) {
        fail(
          'MISSING_ACQUISITION_CAPABILITY',
          `${path}.acquisitionCapabilities must not be empty`,
          `${path}.acquisitionCapabilities`,
        )
      }
      const capabilities = acquisitionCapabilities.map((mode, modeIndex) =>
        enumeration(mode, ACQUISITION_MODES, `${path}.acquisitionCapabilities[${modeIndex}]`),
      )
      unique(capabilities, `${path}.acquisitionCapabilities`)

      const rect = object(item.renderedRect, `${path}.renderedRect`)
      return {
        candidateId: uuidLike(item.candidateId, `${path}.candidateId`),
        frameId: string(item.frameId, `${path}.frameId`, { max: 256 }),
        domOrdinal: integer(item.domOrdinal, `${path}.domOrdinal`, { min: 0, max: 1_000_000 }),
        sourceUrl,
        sourceOrigin,
        renderedRect: {
          x: number(rect.x, `${path}.renderedRect.x`, { min: -1_000_000, max: 1_000_000 }),
          y: number(rect.y, `${path}.renderedRect.y`, { min: -1_000_000, max: 10_000_000 }),
          width: number(rect.width, `${path}.renderedRect.width`, { min: 1, max: 100_000 }),
          height: number(rect.height, `${path}.renderedRect.height`, { min: 1, max: 1_000_000 }),
        },
        intrinsicWidth:
          item.intrinsicWidth === undefined
            ? undefined
            : integer(item.intrinsicWidth, `${path}.intrinsicWidth`, { min: 1, max: 100_000 }),
        intrinsicHeight:
          item.intrinsicHeight === undefined
            ? undefined
            : integer(item.intrinsicHeight, `${path}.intrinsicHeight`, {
                min: 1,
                max: 1_000_000,
              }),
        acquisitionCapabilities: capabilities,
      }
    }),
  }

  unique(
    normalized.candidates.map((candidate) => candidate.candidateId),
    '$.candidates.candidateId',
  )
  unique(
    normalized.candidates.map((candidate) => candidate.domOrdinal),
    '$.candidates.domOrdinal',
  )
  if (Number.isNaN(Date.parse(normalized.createdAt))) {
    fail('INVALID_DATE', '$.createdAt must be an ISO date', '$.createdAt')
  }
  return normalized
}

export function validateRequestedExecution(value = {}) {
  const input = object(value, '$.requestedExecution')
  const locus = enumeration(
    input.locus ?? 'managed',
    PROCESSING_LOCI,
    '$.requestedExecution.locus',
  )
  const allowedFallbacks = input.allowedFallbacks ?? []
  if (!Array.isArray(allowedFallbacks)) {
    fail(
      'INVALID_FALLBACKS',
      '$.requestedExecution.allowedFallbacks must be an array',
      '$.requestedExecution.allowedFallbacks',
    )
  }
  const normalizedFallbacks = allowedFallbacks.map((fallback, index) =>
    enumeration(fallback, PROCESSING_LOCI, `$.requestedExecution.allowedFallbacks[${index}]`),
  )
  unique(normalizedFallbacks, '$.requestedExecution.allowedFallbacks')
  if (normalizedFallbacks.includes(locus)) {
    fail(
      'REDUNDANT_FALLBACK',
      'The requested locus cannot also be a fallback',
      '$.requestedExecution.allowedFallbacks',
    )
  }

  return {
    locus,
    profile: enumeration(
      input.profile ?? 'balanced',
      TRANSLATION_PROFILES,
      '$.requestedExecution.profile',
    ),
    provider: optionalString(input.provider, '$.requestedExecution.provider', {
      max: 128,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    }),
    model: optionalString(input.model, '$.requestedExecution.model', {
      max: 256,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
    }),
    credentialRef: optionalString(input.credentialRef, '$.requestedExecution.credentialRef', {
      max: 256,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    }),
    allowedFallbacks: normalizedFallbacks,
  }
}

export function validateJobBatchRequest(value, snapshot) {
  const input = object(value, '$')
  const normalizedSnapshot = validateCandidateSnapshot(snapshot)
  const candidateIds = input.candidateIds
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
    fail('EMPTY_BATCH', '$.candidateIds must not be empty', '$.candidateIds')
  }
  unique(candidateIds, '$.candidateIds')
  const registered = new Set(normalizedSnapshot.candidates.map((candidate) => candidate.candidateId))
  for (const [index, candidateId] of candidateIds.entries()) {
    uuidLike(candidateId, `$.candidateIds[${index}]`)
    if (!registered.has(candidateId)) {
      fail(
        'CANDIDATE_NOT_IN_SNAPSHOT',
        `Candidate ${candidateId} is not part of snapshot ${normalizedSnapshot.snapshotId}`,
        `$.candidateIds[${index}]`,
      )
    }
  }

  const requestedExecution = validateRequestedExecution(input.requestedExecution ?? {})
  if (
    requestedExecution.locus === 'managed' &&
    candidateIds.length > MAX_MANAGED_BATCH_CANDIDATES
  ) {
    fail(
      'MANAGED_BATCH_LIMIT_EXCEEDED',
      `Managed batches may contain at most ${MAX_MANAGED_BATCH_CANDIDATES} candidates`,
      '$.candidateIds',
    )
  }

  const pipeline = object(input.pipeline ?? {}, '$.pipeline')
  const translationMode = enumeration(
    pipeline.translationMode ?? 'server',
    TRANSLATION_MODES,
    '$.pipeline.translationMode',
  )
  let clientOcr
  if (translationMode === 'client-ocr') {
    const pages = object(input.clientOcr, '$.clientOcr')
    const unexpected = Object.keys(pages).filter((candidateId) => !candidateIds.includes(candidateId))
    if (unexpected.length > 0) {
      fail(
        'UNEXPECTED_CLIENT_OCR_PAGE',
        `Client OCR contains an unselected candidate: ${unexpected[0]}`,
        `$.clientOcr.${unexpected[0]}`,
      )
    }
    clientOcr = Object.fromEntries(candidateIds.map((candidateId) => {
      const path = `$.clientOcr.${candidateId}`
      const pageInput = object(pages[candidateId], path)
      const page = object(pageInput.page, `${path}.page`)
      const width = number(page.width, `${path}.page.width`, { min: 1, max: 100_000 })
      const height = number(page.height, `${path}.page.height`, { min: 1, max: 100_000 })
      if (!Array.isArray(pageInput.regions)) {
        fail('INVALID_CLIENT_OCR_REGIONS', `${path}.regions must be an array`, `${path}.regions`)
      }
      if (pageInput.regions.length > MAX_CLIENT_OCR_REGIONS_PER_PAGE) {
        fail(
          'CLIENT_OCR_REGION_LIMIT_EXCEEDED',
          `Client OCR pages may contain at most ${MAX_CLIENT_OCR_REGIONS_PER_PAGE} regions`,
          `${path}.regions`,
        )
      }
      const normalizedRegions = pageInput.regions.map((regionInput, index) => {
        const regionPath = `${path}.regions[${index}]`
        const region = object(regionInput, regionPath)
        const x = number(region.x, `${regionPath}.x`, { min: 0, max: width })
        const y = number(region.y, `${regionPath}.y`, { min: 0, max: height })
        const regionWidth = number(region.width, `${regionPath}.width`, { min: 0.5, max: width })
        const regionHeight = number(region.height, `${regionPath}.height`, { min: 0.5, max: height })
        if (x + regionWidth > width + 1 || y + regionHeight > height + 1) {
          fail(
            'CLIENT_OCR_REGION_OUT_OF_BOUNDS',
            `${regionPath} must fit within its page`,
            regionPath,
          )
        }
        return {
          id: uuidLike(region.id, `${regionPath}.id`),
          x,
          y,
          width: regionWidth,
          height: regionHeight,
          rotation: number(region.rotation ?? 0, `${regionPath}.rotation`, { min: -360, max: 360 }),
          source: string(region.source, `${regionPath}.source`, { max: 2_000 }),
          confidence: number(region.confidence ?? 0, `${regionPath}.confidence`, { min: 0, max: 1 }),
        }
      })
      unique(normalizedRegions.map((region) => region.id), `${path}.regions[].id`)
      return [candidateId, { page: { width, height }, regions: normalizedRegions }]
    }))
  } else if (input.clientOcr !== undefined) {
    fail(
      'UNEXPECTED_CLIENT_OCR',
      '$.clientOcr requires pipeline.translationMode client-ocr',
      '$.clientOcr',
    )
  }
  const language = object(input.language ?? {}, '$.language')
  const glossary = object(input.glossarySnapshot ?? {}, '$.glossarySnapshot')
  const budget = object(input.budget ?? {}, '$.budget')
  const maxMicros = integer(
    budget.maxMicros ?? DEFAULT_MANAGED_BUDGET_MICROS,
    '$.budget.maxMicros',
    { min: 0, max: 100_000_000 },
  )
  if (
    requestedExecution.locus === 'managed' &&
    maxMicros > DEFAULT_MANAGED_BUDGET_MICROS
  ) {
    fail(
      'MANAGED_BUDGET_LIMIT_EXCEEDED',
      `Managed batches require explicit server policy above ${DEFAULT_MANAGED_BUDGET_MICROS} micros`,
      '$.budget.maxMicros',
    )
  }

  return {
    snapshotId: string(input.snapshotId, '$.snapshotId', { max: 128 }),
    candidateIds: [...candidateIds],
    requestedExecution,
    pipeline: {
      translationMode,
      ocrVersion: string(pipeline.ocrVersion ?? 'paddle-ocr-vl-1.6', '$.pipeline.ocrVersion', {
        max: 128,
      }),
      layoutVersion: string(
        pipeline.layoutVersion ?? 'comic-text-bubble-detector',
        '$.pipeline.layoutVersion',
        { max: 128 },
      ),
      renderVersion: string(
        pipeline.renderVersion ?? 'source-overlay-v1',
        '$.pipeline.renderVersion',
        { max: 128 },
      ),
      promptVersion: string(
        pipeline.promptVersion ?? 'zh-comic-vi-v1',
        '$.pipeline.promptVersion',
        { max: 128 },
      ),
    },
    clientOcr,
    language: {
      source: string(language.source ?? 'zh-Hans', '$.language.source', {
        max: 64,
        pattern: /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/,
      }),
      target: string(language.target ?? 'vi', '$.language.target', {
        max: 64,
        pattern: /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/,
      }),
    },
    translationStyle: string(input.translationStyle ?? 'natural-dialogue', '$.translationStyle', {
      max: 128,
    }),
    glossarySnapshot: {
      id: string(glossary.id ?? 'empty', '$.glossarySnapshot.id', { max: 128 }),
      version: integer(glossary.version ?? 0, '$.glossarySnapshot.version', {
        min: 0,
        max: 1_000_000,
      }),
      hash: string(
        glossary.hash ?? '0'.repeat(64),
        '$.glossarySnapshot.hash',
        { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ },
      ),
    },
    privacyPolicyVersion: string(
      input.privacyPolicyVersion ?? 'local-v1',
      '$.privacyPolicyVersion',
      { max: 128 },
    ),
    budget: {
      currency: enumeration(budget.currency ?? 'USD', ['USD'], '$.budget.currency'),
      maxMicros,
    },
    allowNewCandidates: false,
  }
}

export function validateIdempotencyKey(value) {
  return string(value, '$.idempotencyKey', {
    min: 8,
    max: 128,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  })
}

export function validateResearchConsent(value) {
  const input = object(value, '$')
  const sourceClasses = input.allowedSourceClasses ?? []
  if (!Array.isArray(sourceClasses) || sourceClasses.length === 0) {
    fail(
      'RESEARCH_SOURCE_CLASS_REQUIRED',
      '$.allowedSourceClasses must not be empty',
      '$.allowedSourceClasses',
    )
  }
  const normalizedClasses = sourceClasses.map((entry, index) =>
    string(entry, `$.allowedSourceClasses[${index}]`, {
      max: 64,
      pattern: /^[a-z][a-z0-9-]*$/,
    }),
  )
  unique(normalizedClasses, '$.allowedSourceClasses')
  return {
    seriesId: uuidLike(input.seriesId, '$.seriesId'),
    policyVersion: string(input.policyVersion, '$.policyVersion', { max: 128 }),
    state: enumeration(input.state, ['granted', 'declined', 'revoked'], '$.state'),
    allowedSourceClasses: normalizedClasses,
    grantedAt:
      input.state === 'granted'
        ? string(input.grantedAt, '$.grantedAt', { max: 64 })
        : optionalString(input.grantedAt, '$.grantedAt', { max: 64 }),
  }
}

export function validateSafeTelemetryEvent(value) {
  const input = object(value, '$')
  const forbidden = [
    'url',
    'sourceUrl',
    'image',
    'imageBytes',
    'ocr',
    'ocrText',
    'glossary',
    'cookies',
    'auth',
    'secret',
  ]
  for (const key of forbidden) {
    if (Object.hasOwn(input, key)) {
      fail('UNSAFE_TELEMETRY_FIELD', `Telemetry must not contain ${key}`, `$.${key}`)
    }
  }
  return {
    eventId: uuidLike(input.eventId, '$.eventId'),
    requestId: uuidLike(input.requestId, '$.requestId'),
    jobId: uuidLike(input.jobId, '$.jobId'),
    timestamp: string(input.timestamp, '$.timestamp', { max: 64 }),
    stage: enumeration(input.stage, JOB_STATES, '$.stage'),
    requestedModel: optionalString(input.requestedModel, '$.requestedModel', { max: 256 }),
    resolvedModel: optionalString(input.resolvedModel, '$.resolvedModel', { max: 256 }),
    providerReportedModel: optionalString(
      input.providerReportedModel,
      '$.providerReportedModel',
      { max: 256 },
    ),
    fallbackReason: optionalString(input.fallbackReason, '$.fallbackReason', { max: 256 }),
    tokenCounts:
      input.tokenCounts === undefined
        ? undefined
        : {
            input: integer(input.tokenCounts.input ?? 0, '$.tokenCounts.input', {
              min: 0,
              max: 1_000_000_000,
            }),
            output: integer(input.tokenCounts.output ?? 0, '$.tokenCounts.output', {
              min: 0,
              max: 1_000_000_000,
            }),
          },
    latencyMs:
      input.latencyMs === undefined
        ? undefined
        : integer(input.latencyMs, '$.latencyMs', { min: 0, max: 86_400_000 }),
    cacheHit: Boolean(input.cacheHit),
    estimatedCostMicros:
      input.estimatedCostMicros === undefined
        ? undefined
        : integer(input.estimatedCostMicros, '$.estimatedCostMicros', {
            min: 0,
            max: 100_000_000,
          }),
  }
}

export function assertProtocolCompatible(peerVersion) {
  const peer = object(peerVersion, '$.protocolVersion')
  const major = integer(peer.major, '$.protocolVersion.major', { min: 1, max: 10_000 })
  const minor = integer(peer.minor, '$.protocolVersion.minor', { min: 0, max: 10_000 })
  if (major !== PROTOCOL_VERSION.major) {
    fail(
      'PROTOCOL_MAJOR_MISMATCH',
      `Unsupported protocol major ${major}; expected ${PROTOCOL_VERSION.major}`,
      '$.protocolVersion.major',
    )
  }
  return { major, minor, compatible: true }
}

export function sameProtocolValue(left, right) {
  return isDeepStrictEqual(left, right)
}

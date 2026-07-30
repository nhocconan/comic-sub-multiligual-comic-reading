import { hmacSha256, sha256, stableStringify } from './stable.js'

const TRACKING_KEY = /^(utm_.+|fbclid|gclid|mc_.+|ref)$/i
const SECRET_KEY = /^(token|access_token|auth|authorization|signature|sig|key|expires)$/i

export const HISTORY_SCHEMA_SQL = `
CREATE TABLE reading_work (
  work_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT,
  canonical_origin TEXT NOT NULL, last_opened_at TEXT NOT NULL
);
CREATE TABLE document_snapshot (
  snapshot_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, navigation_id TEXT NOT NULL,
  created_at TEXT NOT NULL, candidate_count INTEGER NOT NULL
);
CREATE TABLE resume_anchor (
  work_id TEXT PRIMARY KEY, snapshot_id TEXT, source_hash TEXT,
  source_url_fingerprint TEXT, dom_ordinal INTEGER NOT NULL,
  intra_item_progress REAL NOT NULL, confidence TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`.trim()

export function sanitizeHistoryUrl(rawUrl) {
  const url = new URL(rawUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('History URL must be HTTP(S) without embedded credentials')
  }
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_KEY.test(key) || SECRET_KEY.test(key)) url.searchParams.delete(key)
  }
  url.searchParams.sort()
  return url.href
}

export function fingerprintHistoryUrl(rawUrl, localSecret) {
  if (typeof localSecret !== 'string' || localSecret.length < 16) {
    throw new TypeError('A device-local history secret of at least 16 characters is required')
  }
  return hmacSha256(localSecret, sanitizeHistoryUrl(rawUrl))
}

export function createHistoryRecord(input, localSecret) {
  if (typeof input.workId !== 'string' || input.workId.length < 8 || input.workId.length > 128) {
    throw new TypeError('workId must contain between 8 and 128 characters')
  }
  const url = new URL(sanitizeHistoryUrl(input.url))
  const lastOpenedAt = input.lastOpenedAt ?? new Date().toISOString()
  if (Number.isNaN(Date.parse(lastOpenedAt))) throw new TypeError('lastOpenedAt must be an ISO date')
  return {
    schemaVersion: 1,
    workId: input.workId,
    title: String(input.title ?? '').normalize('NFKC').trim().slice(0, 512),
    canonicalOrigin: url.origin,
    locationFingerprint: fingerprintHistoryUrl(url.href, localSecret),
    lastOpenedAt,
    resumeAnchor: input.resumeAnchor ? structuredClone(input.resumeAnchor) : null,
  }
}

export function createResumeAnchor(input, localSecret) {
  const ordinal = Number.isSafeInteger(input.domOrdinal) && input.domOrdinal >= 0
    ? input.domOrdinal
    : 0
  const sourceHash = input.sourceHash
  if (sourceHash !== undefined && !/^[a-f0-9]{64}$/.test(sourceHash)) {
    throw new TypeError('sourceHash must be a SHA-256 hex digest')
  }
  const sourceUrlFingerprint = input.sourceUrl
    ? fingerprintHistoryUrl(input.sourceUrl, localSecret)
    : undefined
  const confidence = sourceHash ? 'strong' : sourceUrlFingerprint ? 'medium' : 'weak'
  return {
    version: 1,
    sourceHash,
    sourceUrlFingerprint,
    domOrdinal: ordinal,
    dimensions:
      input.width && input.height ? { width: input.width, height: input.height } : undefined,
    intraItemProgress: Math.min(1, Math.max(0, Number(input.intraItemProgress ?? 0))),
    confidence,
    fingerprint: sha256(stableStringify({ sourceHash, sourceUrlFingerprint, ordinal })),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  }
}

export function resolveResume(anchor, candidates, localSecret) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { match: 'none', confidence: 'none', candidate: null }
  }
  if (anchor.sourceHash) {
    const exact = candidates.find((candidate) => candidate.sourceHash === anchor.sourceHash)
    if (exact) return { match: 'exact', confidence: 'strong', candidate: exact }
  }
  if (anchor.sourceUrlFingerprint) {
    const matching = candidates.filter((candidate) => {
      if (!candidate.sourceUrl) return false
      return fingerprintHistoryUrl(candidate.sourceUrl, localSecret) === anchor.sourceUrlFingerprint
    })
    if (matching.length) {
      const candidate = matching.sort(
        (left, right) =>
          Math.abs(left.domOrdinal - anchor.domOrdinal) - Math.abs(right.domOrdinal - anchor.domOrdinal),
      )[0]
      return { match: 'near', confidence: 'medium', candidate }
    }
  }
  const candidate = [...candidates].sort(
    (left, right) =>
      Math.abs(left.domOrdinal - anchor.domOrdinal) - Math.abs(right.domOrdinal - anchor.domOrdinal),
  )[0]
  return { match: 'ordinal', confidence: 'weak', candidate }
}

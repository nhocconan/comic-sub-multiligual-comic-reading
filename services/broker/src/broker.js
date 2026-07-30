import { createHash, randomUUID } from 'node:crypto'

import {
  validateCandidateSnapshot,
  validateIdempotencyKey,
  validateJobBatchRequest,
  validateSafeTelemetryEvent,
} from '../../../packages/protocol/src/index.js'
import {
  createModelReceipt,
  isTerminalJobState,
  resolveExecution,
  sha256,
  stableStringify,
  transitionJob,
} from '../../../packages/domain/src/index.js'
import { ALLOWED_IMAGE_TYPES, MAX_SOURCE_BYTES, sniffImageType } from './image.js'

export class BrokerError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'BrokerError'
    this.status = status
    this.code = code
  }
}

function publicJob(job) {
  return {
    jobId: job.jobId,
    batchId: job.batchId,
    candidateId: job.candidate.candidateId,
    state: job.state,
    requestedExecution: job.execution.requestedExecution,
    resolvedExecution: job.execution.resolvedExecution,
    executionFingerprint: job.execution.executionFingerprint,
    asset: job.asset,
    ledger: job.ledger,
    resultReady: job.state === 'SETTLED',
    error: job.error ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

function deriveBatch(batch, jobs) {
  const states = jobs.map((job) => job.state)
  const settled = states.filter((state) => state === 'SETTLED').length
  const terminal = states.filter(isTerminalJobState).length
  let state = 'WAITING_ASSETS'
  if (terminal === states.length) {
    if (settled === states.length) state = 'SETTLED'
    else if (settled > 0) state = 'PARTIAL'
    else if (states.every((value) => value === 'CANCELLED')) state = 'CANCELLED'
    else state = 'FAILED'
  } else if (states.some((value) => ['CLAIMED', 'ACQUIRING', 'OCR', 'TRANSLATING', 'RENDERING', 'VERIFYING'].includes(value))) {
    state = 'RUNNING'
  } else if (states.some((value) => value === 'QUEUED')) {
    state = 'QUEUED'
  }
  return {
    batchId: batch.batchId,
    snapshotId: batch.snapshotId,
    state,
    jobIds: batch.jobIds,
    jobs: jobs.map(publicJob),
    counts: { total: states.length, terminal, settled },
    createdAt: batch.createdAt,
    updatedAt: jobs.reduce((latest, job) => job.updatedAt > latest ? job.updatedAt : latest, batch.createdAt),
  }
}

function glossaryEntriesFor(state, principal, reference) {
  if (reference.version === 0 && reference.hash === '0'.repeat(64)) return []
  const records = Object.values(state.seriesGlossaries ?? {}).filter((record) =>
    record.principal?.tenantId === principal.tenantId &&
    record.principal?.deviceId === principal.deviceId &&
    (record.snapshot?.id === reference.id ||
      record.snapshotHistory?.some((snapshot) => snapshot.id === reference.id)))
  const matchingSnapshot = records
    .flatMap((record) => record.snapshotHistory ?? [record.snapshot])
    .find((snapshot) =>
      snapshot.id === reference.id &&
      snapshot.version === reference.version &&
      snapshot.hash === reference.hash)
  if (!matchingSnapshot) {
    if (reference.id.startsWith('series-glossary:')) {
      throw new BrokerError(
        409,
        'GLOSSARY_SNAPSHOT_STALE',
        'Fetch the latest series glossary snapshot before creating the batch',
      )
    }
    return []
  }
  return matchingSnapshot.entries
    .filter((entry) => entry.status === 'active')
    .slice(0, 500)
    .map((entry) => ({
      sourceTerm: entry.sourceTerm,
      targetTerm: entry.targetTerm,
      confidence: entry.confidence,
    }))
}

export class TranslationBroker {
  constructor({ repository, adapter, seriesIntelligence = null }) {
    this.repository = repository
    this.adapter = adapter
    this.seriesIntelligence = seriesIntelligence
    this.controllers = new Map()
    this.processing = new Set()
    this.batchTimers = new Map()
  }

  async initialize() {
    await this.repository.initialize()
    await this.repository.mutate((state) => {
      for (const job of Object.values(state.jobs)) {
        if (!isTerminalJobState(job.state)) {
          const timestamp = new Date().toISOString()
          job.state = 'FAILED'
          job.updatedAt = timestamp
          job.error = { code: 'BROKER_RESTARTED', message: 'Job interrupted by broker restart' }
          job.ledger.state = 'RELEASED'
          job.events.push({
            sequence: job.events.at(-1).sequence + 1,
            state: 'FAILED',
            timestamp,
            code: 'BROKER_RESTARTED',
          })
        }
      }
    })
    return this
  }

  registerSnapshot(principal, input) {
    const snapshot = validateCandidateSnapshot(input)
    const key = `${principal.tenantId}:${principal.deviceId}:${snapshot.snapshotId}`
    return this.repository.mutate((state) => {
      const existing = state.snapshots[key]
      if (existing && stableStringify(existing.snapshot) !== stableStringify(snapshot)) {
        throw new BrokerError(409, 'SNAPSHOT_CONFLICT', 'Snapshot id already has different content')
      }
      if (!existing) state.snapshots[key] = { principal, snapshot }
      return snapshot
    })
  }

  async createBatch(principal, input, idempotencyKey) {
    const normalizedKey = validateIdempotencyKey(idempotencyKey)
    const snapshotKey = `${principal.tenantId}:${principal.deviceId}:${input.snapshotId}`
    const snapshotEntry = this.repository.read((state) => state.snapshots[snapshotKey])
    if (!snapshotEntry) throw new BrokerError(404, 'SNAPSHOT_NOT_FOUND', 'Register the snapshot first')
    const request = validateJobBatchRequest(input, snapshotEntry.snapshot)
    if (request.snapshotId !== snapshotEntry.snapshot.snapshotId) {
      throw new BrokerError(409, 'SNAPSHOT_ID_MISMATCH', 'Request snapshot id does not match snapshot')
    }
    const scope = `${principal.tenantId}:${principal.deviceId}:${normalizedKey}`
    const requestHash = sha256(stableStringify(request))
    const result = await this.repository.mutate((state) => {
      const existing = state.idempotency[scope]
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new BrokerError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was reused for another request')
        }
        const batch = state.batches[existing.batchId]
        return deriveBatch(batch, batch.jobIds.map((jobId) => state.jobs[jobId]))
      }
      const batchId = `batch:${randomUUID()}`
      const now = new Date().toISOString()
      const glossaryEntries = glossaryEntriesFor(
        state,
        principal,
        request.glossarySnapshot,
      )
      const selected = new Set(request.candidateIds)
      const candidates = snapshotEntry.snapshot.candidates.filter((candidate) => selected.has(candidate.candidateId))
      const baseBudget = Math.floor(request.budget.maxMicros / candidates.length)
      let remainder = request.budget.maxMicros % candidates.length
      const jobIds = []
      for (const candidate of candidates) {
        const jobId = `job:${randomUUID()}`
        const execution = resolveExecution(request.requestedExecution, request)
        const budget = baseBudget + (remainder-- > 0 ? 1 : 0)
        const created = {
          jobId,
          batchId,
          principal,
          state: 'CREATED',
          candidate,
          pipeline: request.pipeline,
          language: request.language,
          translationStyle: request.translationStyle,
          glossarySnapshot: request.glossarySnapshot,
          glossaryEntries,
          privacyPolicyVersion: request.privacyPolicyVersion,
          execution,
          asset: null,
          result: null,
          receipt: null,
          ledger: { state: 'RESERVED', reservedMicros: budget, capturedMicros: 0 },
          createdAt: now,
          updatedAt: now,
          events: [{ sequence: 1, state: 'CREATED', timestamp: now }],
        }
        let job = transitionJob(created, 'VALIDATED', { timestamp: now })
        job = transitionJob(job, 'BUDGET_RESERVED', { timestamp: now })
        job = transitionJob(job, 'WAITING_ASSET', { timestamp: now })
        state.jobs[jobId] = structuredClone(job)
        jobIds.push(jobId)
      }
      state.batches[batchId] = {
        batchId,
        snapshotId: request.snapshotId,
        principal,
        requestHash,
        jobIds,
        createdAt: now,
      }
      state.idempotency[scope] = { requestHash, batchId }
      return deriveBatch(state.batches[batchId], jobIds.map((jobId) => state.jobs[jobId]))
    })
    return result
  }

  getBatch(principal, batchId) {
    return this.repository.read((state) => {
      const batch = state.batches[batchId]
      if (!batch || !this.#owns(principal, batch)) throw new BrokerError(404, 'BATCH_NOT_FOUND', 'Batch not found')
      return deriveBatch(batch, batch.jobIds.map((jobId) => state.jobs[jobId]))
    })
  }

  getJob(principal, jobId) {
    return this.repository.read((state) => {
      const job = state.jobs[jobId]
      if (!job || !this.#owns(principal, job)) throw new BrokerError(404, 'JOB_NOT_FOUND', 'Job not found')
      return publicJob(job)
    })
  }

  getEvents(principal, jobId, after = 0) {
    return this.repository.read((state) => {
      const job = state.jobs[jobId]
      if (!job || !this.#owns(principal, job)) throw new BrokerError(404, 'JOB_NOT_FOUND', 'Job not found')
      return { jobId, events: job.events.filter((event) => event.sequence > after) }
    })
  }

  getResult(principal, jobId) {
    return this.repository.read((state) => {
      const job = state.jobs[jobId]
      if (!job || !this.#owns(principal, job)) throw new BrokerError(404, 'JOB_NOT_FOUND', 'Job not found')
      if (job.state !== 'SETTLED') throw new BrokerError(409, 'RESULT_NOT_READY', 'Job result is not ready')
      return {
        jobId,
        candidateId: job.candidate.candidateId,
        page: job.result.page,
        overlayRegions: job.result.overlayRegions,
        renderedAsset: {
          ...job.result.renderedAsset,
          url: `/v1/jobs/${encodeURIComponent(jobId)}/rendered-asset`,
        },
        modelReceipt: job.receipt,
      }
    })
  }

  async getRenderedAsset(principal, jobId) {
    const metadata = this.repository.read((state) => {
      const job = state.jobs[jobId]
      if (!job || !this.#owns(principal, job)) throw new BrokerError(404, 'JOB_NOT_FOUND', 'Job not found')
      if (job.state !== 'SETTLED') throw new BrokerError(409, 'RESULT_NOT_READY', 'Job result is not ready')
      return job.result.renderedAsset
    })
    return { metadata, bytes: await this.repository.readAsset(jobId, 'rendered') }
  }

  async uploadAsset(principal, jobId, bytes, { contentType, declaredHash }) {
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      throw new BrokerError(415, 'UNSUPPORTED_ASSET_TYPE', 'Only JPEG, PNG, and WebP are accepted')
    }
    if (bytes.length > MAX_SOURCE_BYTES) throw new BrokerError(413, 'ASSET_TOO_LARGE', 'Asset is too large')
    const detected = sniffImageType(bytes)
    if (detected !== contentType) {
      throw new BrokerError(415, 'ASSET_TYPE_MISMATCH', 'Declared and detected image types differ')
    }
    const actualHash = createHash('sha256').update(bytes).digest('hex')
    if (!/^[a-f0-9]{64}$/.test(declaredHash ?? '') || declaredHash !== actualHash) {
      throw new BrokerError(422, 'ASSET_HASH_MISMATCH', 'x-content-sha256 must exactly match the body')
    }
    const accepted = await this.repository.mutate((state) => {
      const job = state.jobs[jobId]
      if (!job || !this.#owns(principal, job)) throw new BrokerError(404, 'JOB_NOT_FOUND', 'Job not found')
      if (job.state !== 'WAITING_ASSET') {
        if (job.asset?.sha256 === actualHash) return { duplicate: true, job: publicJob(job) }
        throw new BrokerError(409, 'JOB_NOT_WAITING_FOR_ASSET', `Job is ${job.state}`)
      }
      job.asset = { sha256: actualHash, contentType, byteLength: bytes.length }
      Object.assign(job, structuredClone(transitionJob(job, 'QUEUED')))
      return { duplicate: false, job: publicJob(job) }
    })
    if (!accepted.duplicate) {
      await this.repository.writeAsset(jobId, bytes, 'source')
      this.#scheduleBatch(accepted.job.batchId)
    }
    return accepted.job
  }

  async cancel(principal, jobId) {
    const result = await this.repository.mutate((state) => {
      const job = state.jobs[jobId]
      if (!job || !this.#owns(principal, job)) throw new BrokerError(404, 'JOB_NOT_FOUND', 'Job not found')
      if (isTerminalJobState(job.state)) return publicJob(job)
      if (job.state !== 'CANCEL_REQUESTED') Object.assign(job, structuredClone(transitionJob(job, 'CANCEL_REQUESTED')))
      return publicJob(job)
    })
    this.controllers.get(jobId)?.abort(new Error('Cancelled'))
    if (!this.processing.has(jobId)) await this.#finishCancelled(jobId)
    return result
  }

  telemetry(principal) {
    return this.repository.read((state) =>
      state.telemetry.filter((event) => event.principalKey === `${principal.tenantId}:${principal.deviceId}`)
        .map(({ principalKey, ...event }) => event),
    )
  }

  bootstrapSeries(principal, input) {
    if (!this.seriesIntelligence) {
      throw new BrokerError(503, 'SERIES_INTELLIGENCE_DISABLED', 'Series intelligence is disabled')
    }
    return this.seriesIntelligence.bootstrap(principal, input)
  }

  getSeriesGlossary(principal, seriesId) {
    if (!this.seriesIntelligence) {
      throw new BrokerError(503, 'SERIES_INTELLIGENCE_DISABLED', 'Series intelligence is disabled')
    }
    return this.seriesIntelligence.get(principal, seriesId)
  }

  deleteSeriesGlossary(principal, seriesId) {
    if (!this.seriesIntelligence) {
      throw new BrokerError(503, 'SERIES_INTELLIGENCE_DISABLED', 'Series intelligence is disabled')
    }
    return this.seriesIntelligence.delete(principal, seriesId)
  }

  #owns(principal, value) {
    return value.principal.tenantId === principal.tenantId && value.principal.deviceId === principal.deviceId
  }

  async #transition(jobId, stateName, code) {
    return this.repository.mutate((state) => {
      const job = state.jobs[jobId]
      if (job.state === 'CANCEL_REQUESTED' && stateName !== 'CANCELLED') return publicJob(job)
      Object.assign(job, structuredClone(transitionJob(job, stateName, { code })))
      return publicJob(job)
    })
  }

  #scheduleBatch(batchId) {
    const existing = this.batchTimers.get(batchId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.batchTimers.delete(batchId)
      void this.#processReadyBatch(batchId)
    }, 75)
    timer.unref?.()
    this.batchTimers.set(batchId, timer)
  }

  async #processReadyBatch(batchId) {
    const jobIds = this.repository.read((state) => {
      const batch = state.batches[batchId]
      if (!batch) return []
      return batch.jobIds.filter((jobId) =>
        state.jobs[jobId]?.state === 'QUEUED' && !this.processing.has(jobId))
    })
    if (jobIds.length) await this.#processJobs(jobIds)
  }

  async #processJobs(jobIds) {
    const pending = jobIds.filter((jobId) => !this.processing.has(jobId))
    if (!pending.length) return
    for (const jobId of pending) this.processing.add(jobId)
    const controller = new AbortController()
    if (pending.length === 1) this.controllers.set(pending[0], controller)
    const started = Date.now()
    try {
      for (const jobId of pending) {
        await this.#transition(jobId, 'CLAIMED')
        await this.#transition(jobId, 'ACQUIRING')
      }
      const contexts = await Promise.all(pending.map(async (jobId) => {
        const job = this.repository.read((state) => structuredClone(state.jobs[jobId]))
        if (job.state === 'CANCEL_REQUESTED') {
          await this.#finishCancelled(jobId)
          return null
        }
        return {
          job,
          sourceBytes: await this.repository.readAsset(jobId, 'source'),
          sourceContentType: job.asset.contentType,
          signal: controller.signal,
        }
      }))
      const activeContexts = contexts.filter(Boolean)
      if (!activeContexts.length) return
      for (const context of activeContexts) await this.#transition(context.job.jobId, 'OCR')
      const work = typeof this.adapter.translateBatch === 'function'
        ? this.adapter.translateBatch(activeContexts)
        : Promise.all(activeContexts.map((context) => this.adapter.translate(context)))
      for (const context of activeContexts) await this.#transition(context.job.jobId, 'TRANSLATING')
      const results = await work
      controller.signal.throwIfAborted()
      if (!Array.isArray(results) || results.length !== activeContexts.length) {
        throw Object.assign(new Error('Adapter returned an incomplete batch'), {
          code: 'INVALID_ADAPTER_BATCH_RESULT',
        })
      }
      await Promise.all(activeContexts.map(async (context, index) => {
        const state = this.repository.read((value) => value.jobs[context.job.jobId]?.state)
        if (state === 'CANCEL_REQUESTED') return this.#finishCancelled(context.job.jobId)
        return this.#settleResult(context.job.jobId, results[index], started)
      }))
    } catch (error) {
      await Promise.all(pending.map(async (jobId) => {
        const cancelled = controller.signal.aborted ||
          this.repository.read((state) => state.jobs[jobId]?.state === 'CANCEL_REQUESTED')
        if (cancelled) return this.#finishCancelled(jobId)
        return this.#failJob(jobId, error)
      }))
    } finally {
      for (const jobId of pending) {
        this.controllers.delete(jobId)
        this.processing.delete(jobId)
      }
    }
  }

  async #settleResult(jobId, result, started) {
    await this.#transition(jobId, 'RENDERING')
    if (!result.renderedBytes || !ALLOWED_IMAGE_TYPES.has(result.renderedContentType)) {
      throw Object.assign(new Error('Adapter did not return a valid rendered asset'), {
        code: 'INVALID_ADAPTER_RESULT',
      })
    }
    await this.repository.writeAsset(jobId, result.renderedBytes, 'rendered')
    await this.#transition(jobId, 'VERIFYING')
    const renderedHash = createHash('sha256').update(result.renderedBytes).digest('hex')
    await this.repository.mutate((state) => {
      const mutable = state.jobs[jobId]
      mutable.result = {
        page: result.page,
        overlayRegions: result.overlayRegions,
        adapter: result.adapter,
        renderedAsset: {
          contentType: result.renderedContentType,
          byteLength: result.renderedBytes.length,
          sha256: renderedHash,
        },
      }
      mutable.receipt = createModelReceipt(mutable.execution, result)
      Object.assign(mutable, structuredClone(transitionJob(mutable, 'SUCCEEDED')))
      Object.assign(mutable, structuredClone(transitionJob(mutable, 'SETTLED')))
      mutable.ledger = {
        ...mutable.ledger,
        state: 'CAPTURED',
        capturedMicros: Math.min(
          mutable.ledger.reservedMicros,
          result.estimatedCostMicros ?? mutable.ledger.reservedMicros,
        ),
      }
      state.telemetry.push({
        ...validateSafeTelemetryEvent({
          eventId: `event:${randomUUID()}`,
          requestId: mutable.batchId,
          jobId,
          timestamp: new Date().toISOString(),
          stage: 'SETTLED',
          requestedModel: mutable.execution.requestedExecution.model,
          resolvedModel: mutable.execution.resolvedExecution.model,
          providerReportedModel: result.providerReportedModel,
          tokenCounts: result.tokenCounts,
          latencyMs: Date.now() - started,
          estimatedCostMicros: result.estimatedCostMicros,
        }),
        principalKey: `${mutable.principal.tenantId}:${mutable.principal.deviceId}`,
      })
    })
  }

  #failJob(jobId, error) {
    return this.repository.mutate((state) => {
      const job = state.jobs[jobId]
      if (!isTerminalJobState(job.state)) {
        Object.assign(job, structuredClone(transitionJob(job, 'FAILED', {
          code: error.code ?? 'ADAPTER_FAILED',
        })))
        job.error = {
          code: error.code ?? 'ADAPTER_FAILED',
          message: String(error.message ?? 'Translation failed').slice(0, 512),
        }
        job.ledger = { ...job.ledger, state: 'RELEASED', capturedMicros: 0 }
      }
    })
  }

  async #finishCancelled(jobId) {
    return this.repository.mutate((state) => {
      const job = state.jobs[jobId]
      if (job.state === 'CANCEL_REQUESTED') {
        Object.assign(job, structuredClone(transitionJob(job, 'CANCELLED')))
        job.ledger = { ...job.ledger, state: 'RELEASED', capturedMicros: 0 }
      }
      return publicJob(job)
    })
  }
}

import {
  JOB_STATES,
  TERMINAL_JOB_STATES,
  validateRequestedExecution,
} from '../../protocol/src/index.js'
import { deepFreeze, sha256, stableStringify } from './stable.js'

export const DEFAULT_PROVIDER = 'gemini'
export const DEFAULT_MODEL = 'gemini-3.6-flash'

export const MODEL_REGISTRY = deepFreeze({
  version: '2026-07-30',
  defaults: {
    fast: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
    balanced: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
    quality: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
  },
  providers: {
    gemini: {
      models: [DEFAULT_MODEL],
      supportedLoci: ['managed', 'private-server', 'local', 'paired', 'on-device'],
    },
    apple: {
      models: ['apple-translation'],
      supportedLoci: ['on-device'],
    },
    mlkit: {
      models: ['mlkit-translation'],
      supportedLoci: ['on-device'],
    },
  },
})

const TRANSITIONS = Object.freeze({
  CREATED: ['VALIDATED', 'REJECTED'],
  VALIDATED: ['BUDGET_RESERVED', 'REJECTED'],
  BUDGET_RESERVED: ['WAITING_ASSET', 'QUEUED', 'CANCEL_REQUESTED'],
  WAITING_ASSET: ['QUEUED', 'CANCEL_REQUESTED', 'FAILED', 'EXPIRED'],
  QUEUED: ['CLAIMED', 'CANCEL_REQUESTED', 'FAILED', 'EXPIRED'],
  CLAIMED: ['ACQUIRING', 'CANCEL_REQUESTED', 'FAILED'],
  ACQUIRING: ['OCR', 'CANCEL_REQUESTED', 'FAILED'],
  OCR: ['TRANSLATING', 'CANCEL_REQUESTED', 'FAILED'],
  TRANSLATING: ['RENDERING', 'CANCEL_REQUESTED', 'FAILED'],
  RENDERING: ['VERIFYING', 'CANCEL_REQUESTED', 'FAILED'],
  VERIFYING: ['SUCCEEDED', 'CANCEL_REQUESTED', 'FAILED'],
  SUCCEEDED: ['SETTLED'],
  CANCEL_REQUESTED: ['CANCELLED', 'FAILED'],
})

export class DomainError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DomainError'
    this.code = code
  }
}

export function resolveExecution(requestedValue, jobContract, registry = MODEL_REGISTRY) {
  const requested = validateRequestedExecution(requestedValue)
  const profileDefault = registry.defaults[requested.profile]
  if (!profileDefault) throw new DomainError('UNKNOWN_PROFILE', `Unknown profile ${requested.profile}`)
  const provider = requested.provider ?? profileDefault.provider
  const model = requested.model ?? profileDefault.model
  const providerEntry = registry.providers[provider]
  if (!providerEntry || !providerEntry.models.includes(model)) {
    throw new DomainError('MODEL_NOT_ALLOWED', `${provider}/${model} is not in the model registry`)
  }
  if (!providerEntry.supportedLoci.includes(requested.locus)) {
    throw new DomainError('LOCUS_NOT_SUPPORTED', `${provider}/${model} does not support ${requested.locus}`)
  }
  const requestedExecution = deepFreeze(structuredClone(requested))
  const resolvedExecution = deepFreeze({
    locus: requested.locus,
    provider,
    model,
    credentialRef: requested.credentialRef ?? `${requested.locus}:default`,
    profile: requested.profile,
    registryVersion: registry.version,
    resolvedAt: new Date().toISOString(),
  })
  const fingerprintInput = {
    resolvedExecution: {
      locus: resolvedExecution.locus,
      provider: resolvedExecution.provider,
      model: resolvedExecution.model,
      credentialRef: resolvedExecution.credentialRef,
      registryVersion: resolvedExecution.registryVersion,
    },
    pipeline: jobContract.pipeline,
    language: jobContract.language,
    translationStyle: jobContract.translationStyle,
    glossarySnapshot: jobContract.glossarySnapshot,
    privacyPolicyVersion: jobContract.privacyPolicyVersion,
  }
  return deepFreeze({
    requestedExecution,
    resolvedExecution,
    executionFingerprint: sha256(stableStringify(fingerprintInput)),
  })
}

export function createModelReceipt(execution, workerReport = {}) {
  const reported = workerReport.providerReportedModel ?? execution.resolvedExecution.model
  return deepFreeze({
    requestedProvider: execution.requestedExecution.provider ?? null,
    requestedModel: execution.requestedExecution.model ?? null,
    resolvedProvider: execution.resolvedExecution.provider,
    resolvedModel: execution.resolvedExecution.model,
    providerReportedModel: reported,
    executionFingerprint: execution.executionFingerprint,
    modelMatched: reported === execution.resolvedExecution.model,
    tokenCounts: {
      input: workerReport.tokenCounts?.input ?? 0,
      output: workerReport.tokenCounts?.output ?? 0,
    },
    estimatedCostMicros: workerReport.estimatedCostMicros ?? 0,
    completedAt: new Date().toISOString(),
  })
}

export function canTransition(from, to) {
  return JOB_STATES.includes(from) && JOB_STATES.includes(to) && (TRANSITIONS[from] ?? []).includes(to)
}

export function transitionJob(job, nextState, details = {}) {
  if (!canTransition(job.state, nextState)) {
    throw new DomainError('INVALID_JOB_TRANSITION', `${job.state} cannot transition to ${nextState}`)
  }
  const timestamp = details.timestamp ?? new Date().toISOString()
  const event = {
    sequence: (job.events?.at(-1)?.sequence ?? 0) + 1,
    state: nextState,
    timestamp,
    code: details.code,
  }
  return deepFreeze({
    ...structuredClone(job),
    state: nextState,
    updatedAt: timestamp,
    events: [...(job.events ?? []), event],
  })
}

export function isTerminalJobState(state) {
  return TERMINAL_JOB_STATES.includes(state)
}

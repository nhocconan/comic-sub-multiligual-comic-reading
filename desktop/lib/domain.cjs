'use strict'

const DEFAULT_SETTINGS = Object.freeze({
  targetLanguage: 'vi-VN',
  sourceLanguage: 'auto',
  route: 'ask',
  profile: 'balanced',
  brokerEndpoint: 'https://comic-be.dep.app',
  serverUrl: '',
  model: 'gemini-3.6-flash',
  privateMode: false,
})

function safeUrl(value) {
  const url = new URL(String(value || '').trim())
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Chỉ hỗ trợ URL HTTP hoặc HTTPS.')
  url.username = ''
  url.password = ''
  url.hash = ''
  return url.toString()
}

function estimateBatch(count, route) {
  const safeCount = Math.max(0, Math.min(200, Number(count) || 0))
  return {
    count: safeCount,
    upperBoundUsd: route === 'managed' ? Math.min(0.5, Number((safeCount * 0.0119).toFixed(2))) : 0,
    batches: Math.max(1, Math.ceil(safeCount / 50)),
  }
}

function migrateSettings(saved = {}) {
  const next = { ...DEFAULT_SETTINGS, ...saved }
  if (!saved.brokerEndpoint || saved.brokerEndpoint === 'http://127.0.0.1:4100') {
    next.brokerEndpoint = DEFAULT_SETTINGS.brokerEndpoint
  }
  const provenance = saved.modelProvenance || 'auto-recommended'
  const needsChoice = saved.model === 'gemini-3.5-flash' && provenance !== 'user-pinned'
  if (saved.model === 'gemini-3.1-flash-lite' && provenance !== 'user-pinned') {
    next.model = 'gemini-3.6-flash'
  }
  return { settings: next, needsModelChoice: needsChoice }
}

function receiptFor({ route = 'managed', profile = 'balanced', model = 'gemini-3.6-flash', serverUrl = '', language = 'vi-VN' } = {}) {
  const routeLabel = {
    managed: 'Comic Sub cloud',
    local: 'This computer',
    paired: 'My computer',
    byo: 'My computer + external AI',
    ask: 'Route not chosen',
  }[route] || 'Route not chosen'
  const imageDestination = route === 'managed' ? 'Comic Sub cloud' : route === 'paired' || route === 'byo' ? 'My computer' : 'This device'
  const textDestination = route === 'managed' ? 'Comic Sub cloud' : route === 'byo' ? 'Google Gemini through your API key' : imageDestination
  return {
    id: `cs_${Math.random().toString(36).slice(2, 10)}`,
    routeLabel,
    language,
    profile,
    model,
    server: serverUrl ? new URL(serverUrl).host : null,
    imageDestination,
    textDestination,
    requestedResolved: 'matched',
    createdAt: new Date().toISOString(),
  }
}

module.exports = { DEFAULT_SETTINGS, estimateBatch, migrateSettings, receiptFor, safeUrl }

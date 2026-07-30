'use strict'

const { createHash, randomUUID } = require('node:crypto')

const MAX_ASSET_BYTES = 32 * 1024 * 1024
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

class BrokerClientError extends Error {
  constructor(code, message, status = 0) { super(message); this.name = 'BrokerClientError'; this.code = code; this.status = status }
}

function normalizeEndpoint(value) {
  const url = new URL(String(value || '').trim())
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback)) {
    throw new BrokerClientError('INVALID_BROKER_ENDPOINT', 'Broker từ xa phải dùng HTTPS; HTTP chỉ dùng cho localhost.')
  }
  url.pathname = url.pathname.replace(/\/$/, '')
  url.search = ''; url.hash = ''; url.username = ''; url.password = ''
  return url.toString().replace(/\/$/, '')
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

function sniffImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WEBP'))) return 'image/webp'
  return null
}

async function readBounded(response, limit = MAX_ASSET_BYTES) {
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > limit) throw new BrokerClientError('ASSET_TOO_LARGE', 'Ảnh vượt giới hạn 32 MiB.')
  const reader = response.body?.getReader?.()
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > limit) throw new BrokerClientError('ASSET_TOO_LARGE', 'Ảnh vượt giới hạn 32 MiB.')
    return bytes
  }
  const chunks = []; let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) { await reader.cancel(); throw new BrokerClientError('ASSET_TOO_LARGE', 'Ảnh vượt giới hạn 32 MiB.') }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total)
}

function createBrokerClient({ endpoint, token = '', deviceId = 'local-device', tenantId = 'local', fetchImpl = globalThis.fetch }) {
  const base = normalizeEndpoint(endpoint)
  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {})
    headers.set('x-tenant-id', tenantId); headers.set('x-device-id', deviceId)
    if (token) headers.set('authorization', `Bearer ${token}`)
    if (options.json !== undefined) headers.set('content-type', 'application/json')
    const response = await fetchImpl(`${base}${path}`, {
      method: options.method || 'GET', headers,
      body: options.json === undefined ? options.body : JSON.stringify(options.json),
      signal: options.signal,
      redirect: 'error',
    })
    const body = response.status === 204 ? null : await response.json().catch(() => null)
    if (!response.ok) throw new BrokerClientError(body?.error?.code || 'BROKER_REQUEST_FAILED', body?.error?.message || `Broker returned ${response.status}`, response.status)
    return body
  }
  return {
    registerSnapshot: (snapshot, signal) => request('/v1/snapshots', { method: 'POST', json: snapshot, signal }),
    createBatch: (input, signal) => request('/v1/job-batches', { method: 'POST', headers: { 'idempotency-key': `desktop:${randomUUID()}` }, json: input, signal }),
    uploadAsset: (jobId, asset, signal) => request(`/v1/jobs/${encodeURIComponent(jobId)}/asset`, { method: 'PUT', headers: { 'content-type': asset.contentType, 'x-content-sha256': asset.sha256 }, body: asset.bytes, signal }),
    getJob: (jobId, signal) => request(`/v1/jobs/${encodeURIComponent(jobId)}`, { signal }),
    getEvents: (jobId, after, signal) => request(`/v1/jobs/${encodeURIComponent(jobId)}/events?after=${after}`, { signal }),
    getResult: (jobId, signal) => request(`/v1/jobs/${encodeURIComponent(jobId)}/result`, { signal }),
    cancel: (jobId, signal) => request(`/v1/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', json: {}, signal }),
    bootstrapSeries: (payload, signal) => request('/v1/series/bootstrap', { method: 'POST', json: payload, signal }),
    getSeriesGlossary: (seriesId, signal) => request(`/v1/series/${encodeURIComponent(seriesId)}/glossary`, { signal }),
  }
}

module.exports = { ALLOWED_TYPES, BrokerClientError, MAX_ASSET_BYTES, createBrokerClient, normalizeEndpoint, readBounded, sha256, sniffImageType }

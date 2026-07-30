import { createServer } from 'node:http'

import { MODEL_REGISTRY } from '../../../packages/domain/src/index.js'
import { ProtocolValidationError } from '../../../packages/protocol/src/index.js'
import { BrokerError } from './broker.js'
import { MAX_SOURCE_BYTES, readBoundedBody } from './image.js'

function principal(request) {
  const tenantId = request.headers['x-tenant-id'] ?? 'local'
  const deviceId = request.headers['x-device-id'] ?? 'local-device'
  if (
    typeof tenantId !== 'string' ||
    typeof deviceId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(tenantId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(deviceId)
  ) {
    throw new BrokerError(400, 'INVALID_PRINCIPAL', 'Invalid tenant or device id')
  }
  return { tenantId, deviceId }
}

async function jsonBody(request, maxBytes = 1024 * 1024) {
  const bytes = await readBoundedBody(request, maxBytes)
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new BrokerError(400, 'INVALID_JSON', 'Request body is not valid JSON')
  }
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  response.end(body)
}

export function createBrokerServer(broker) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://broker.invalid')
      const actor = principal(request)
      let match
      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, { ok: true, adapter: broker.adapter.name })
      }
      if (request.method === 'GET' && url.pathname === '/v1/model-registry') {
        return sendJson(response, 200, MODEL_REGISTRY)
      }
      if (request.method === 'POST' && url.pathname === '/v1/snapshots') {
        return sendJson(response, 201, await broker.registerSnapshot(actor, await jsonBody(request)))
      }
      if (request.method === 'POST' && url.pathname === '/v1/job-batches') {
        const value = await broker.createBatch(
          actor,
          await jsonBody(request),
          request.headers['idempotency-key'],
        )
        return sendJson(response, 202, value)
      }
      if (
        request.method === 'POST' &&
        (match = url.pathname.match(/^\/v1\/job-batches\/([^/]+)\/flush$/))
      ) {
        return sendJson(
          response,
          202,
          broker.flushBatch(actor, decodeURIComponent(match[1])),
        )
      }
      if (request.method === 'POST' && url.pathname === '/v1/series/bootstrap') {
        const value = await broker.bootstrapSeries(actor, await jsonBody(request))
        return sendJson(response, 202, value)
      }
      if (
        request.method === 'GET' &&
        (match = url.pathname.match(/^\/v1\/series\/([^/]+)\/glossary$/))
      ) {
        return sendJson(
          response,
          200,
          broker.getSeriesGlossary(actor, decodeURIComponent(match[1])),
        )
      }
      if (
        request.method === 'DELETE' &&
        (match = url.pathname.match(/^\/v1\/series\/([^/]+)\/glossary$/))
      ) {
        return sendJson(
          response,
          200,
          await broker.deleteSeriesGlossary(actor, decodeURIComponent(match[1])),
        )
      }
      if (request.method === 'GET' && (match = url.pathname.match(/^\/v1\/job-batches\/([^/]+)$/))) {
        return sendJson(response, 200, broker.getBatch(actor, decodeURIComponent(match[1])))
      }
      if (request.method === 'GET' && (match = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/))) {
        return sendJson(response, 200, broker.getJob(actor, decodeURIComponent(match[1])))
      }
      if (request.method === 'GET' && (match = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/events$/))) {
        const after = Math.max(0, Number(url.searchParams.get('after') ?? 0))
        return sendJson(response, 200, broker.getEvents(actor, decodeURIComponent(match[1]), after))
      }
      if (request.method === 'GET' && (match = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/result$/))) {
        return sendJson(response, 200, broker.getResult(actor, decodeURIComponent(match[1])))
      }
      if (request.method === 'GET' && (match = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/rendered-asset$/))) {
        const { metadata, bytes } = await broker.getRenderedAsset(actor, decodeURIComponent(match[1]))
        response.writeHead(200, {
          'content-type': metadata.contentType,
          'content-length': bytes.length,
          etag: `"sha256:${metadata.sha256}"`,
          'cache-control': 'private, max-age=31536000, immutable',
        })
        return response.end(bytes)
      }
      if (
        ['PUT', 'POST'].includes(request.method) &&
        (match = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/asset$/))
      ) {
        const bytes = await readBoundedBody(request, MAX_SOURCE_BYTES)
        const value = await broker.uploadAsset(actor, decodeURIComponent(match[1]), bytes, {
          contentType: String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(),
          declaredHash: request.headers['x-content-sha256'],
        })
        return sendJson(response, 202, value)
      }
      if (request.method === 'POST' && (match = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/cancel$/))) {
        return sendJson(response, 202, await broker.cancel(actor, decodeURIComponent(match[1])))
      }
      if (request.method === 'GET' && url.pathname === '/v1/telemetry') {
        return sendJson(response, 200, { events: broker.telemetry(actor) })
      }
      throw new BrokerError(404, 'ROUTE_NOT_FOUND', 'Route not found')
    } catch (error) {
      const status =
        error instanceof BrokerError
          ? error.status
          : error instanceof ProtocolValidationError
            ? 400
            : error.code === 'ASSET_TOO_LARGE'
              ? 413
              : 500
      sendJson(response, status, {
        error: {
          code: error.code ?? 'INTERNAL_ERROR',
          message: status === 500 ? 'Internal broker error' : error.message,
          path: error.path,
        },
      })
    }
  })
}

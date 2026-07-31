'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  compatibleBaseUrl,
  listProviderModels,
  normalizeProviderConfig,
  parseTranslations,
  recommendModel,
  translateOcrPages,
} = require('../lib/byo-provider.cjs')

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('compatible endpoints require HTTPS except on loopback', () => {
  assert.equal(compatibleBaseUrl('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434/v1')
  assert.equal(compatibleBaseUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1')
  assert.throws(() => compatibleBaseUrl('http://reader.example/v1'), /HTTPS/)
  assert.throws(() => compatibleBaseUrl('file:///tmp/models'), /HTTPS/)
})

test('Gemini catalog is fetched live and limited to text generation models', async () => {
  const calls = []
  const models = await listProviderModels({ provider: 'gemini' }, 'secret', {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), key: options.headers['x-goog-api-key'] })
      return response({
        models: [
          { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent'] },
        ],
      })
    },
  })
  assert.deepEqual(models.map((model) => model.id), ['gemini-3.6-flash'])
  assert.equal(calls[0].key, 'secret')
  assert.match(calls[0].url, /\/v1beta\/models\?pageSize=1000/)
})

test('OpenAI, Anthropic, and compatible catalogs use provider-native model endpoints', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), headers: options.headers })
    return response({ data: [{ id: 'text-model-new', created: 20 }, { id: 'image-model', created: 30 }] })
  }
  for (const config of [
    { provider: 'openai' },
    { provider: 'anthropic' },
    { provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1' },
  ]) {
    const models = await listProviderModels(config, 'key', { fetchImpl })
    assert.deepEqual(models.map((model) => model.id), ['text-model-new'])
  }
  assert.equal(calls[0].url, 'https://api.openai.com/v1/models')
  assert.equal(calls[1].url, 'https://api.anthropic.com/v1/models?limit=1000')
  assert.equal(calls[2].url, 'https://api.deepseek.com/v1/models')
})

test('loopback OpenAI-compatible servers may omit an API key', async () => {
  const calls = []
  const models = await listProviderModels({
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
  }, '', {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), headers: options.headers })
      return response({ data: [{ id: 'local-text-model' }] })
    },
  })
  assert.deepEqual(models.map((model) => model.id), ['local-text-model'])
  assert.equal(calls[0].headers.authorization, undefined)
})

test('recommendation follows live catalog families without pinning a version', () => {
  const gemini = [
    { id: 'gemini-3.5-flash' },
    { id: 'gemini-3.6-flash' },
    { id: 'gemini-3.7-pro-preview' },
  ]
  assert.equal(recommendModel(gemini, 'gemini', 'balanced'), 'gemini-3.6-flash')
  assert.equal(recommendModel([
    { id: 'claude-haiku-5', created: 30 },
    { id: 'claude-sonnet-5', created: 20 },
  ], 'anthropic', 'balanced'), 'claude-sonnet-5')
})

test('provider output rejects duplicate and incomplete region ids', () => {
  const ids = new Set(['a', 'b'])
  assert.throws(
    () => parseTranslations('{"translations":[{"id":"a","text":"A"},{"id":"a","text":"B"}]}', ids),
    /trùng ID/,
  )
  assert.throws(
    () => parseTranslations('{"translations":[{"id":"a","text":"A"}]}', ids),
    /1\/2/,
  )
})

test('one BYO request translates all OCR regions while preserving local geometry', async () => {
  const calls = []
  const pages = [{
    candidateId: 'candidate:1',
    ocr: {
      page: { width: 1000, height: 1600 },
      regions: [
        { id: 'r1', x: 10, y: 20, width: 100, height: 50, source: '你好' },
        { id: 'r2', x: 20, y: 90, width: 120, height: 55, source: '世界' },
      ],
    },
  }]
  const result = await translateOcrPages({
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-new',
  }, 'secret', pages, {
    targetLanguage: 'Vietnamese',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      return response({
        choices: [{
          message: {
            content: JSON.stringify({
              translations: [
                { id: 'candidate:1::r1', text: 'Xin chào' },
                { id: 'candidate:1::r2', text: 'Thế giới' },
              ],
            }),
          },
        }],
      })
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions')
  assert.deepEqual(result[0].overlayRegions.map(({ x, y, width, height, translation }) =>
    ({ x, y, width, height, translation })), [
    { x: 10, y: 20, width: 100, height: 50, translation: 'Xin chào' },
    { x: 20, y: 90, width: 120, height: 55, translation: 'Thế giới' },
  ])
})

test('DeepSeek translation disables default high-effort thinking and requests bounded JSON', async () => {
  let body
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body)
    const ids = JSON.parse(body.messages[1].content).regions.map((region) => region.id)
    return response({
      choices: [{
        message: {
          content: JSON.stringify({
            translations: ids.map((id) => ({ id, text: 'Bản dịch' })),
          }),
        },
      }],
    })
  }
  await translateOcrPages({
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
  }, 'secret', [{
    candidateId: 'page-1',
    ocr: {
      page: { width: 900, height: 1_200 },
      regions: [{ id: 'r1', source: '成功', x: 1, y: 1, width: 10, height: 10 }],
    },
  }], { fetchImpl })
  assert.deepEqual(body.thinking, { type: 'disabled' })
  assert.deepEqual(body.response_format, { type: 'json_object' })
  assert.equal(body.max_tokens, 1_024)
})

test('generic OpenAI-compatible translation does not inject DeepSeek-only controls', async () => {
  let body
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body)
    return response({
      choices: [{
        message: {
          content: JSON.stringify({
            translations: [{ id: 'page-1::r1', text: 'Translated' }],
          }),
        },
      }],
    })
  }
  await translateOcrPages({
    provider: 'openai-compatible',
    baseUrl: 'https://llm.example.test/v1',
    model: 'fast-model',
  }, 'secret', [{
    candidateId: 'page-1',
    ocr: {
      page: { width: 900, height: 1_200 },
      regions: [{ id: 'r1', source: '成功', x: 1, y: 1, width: 10, height: 10 }],
    },
  }], { fetchImpl })
  assert.equal(body.thinking, undefined)
  assert.equal(body.response_format, undefined)
  assert.equal(body.max_tokens, 1_024)
})

test('provider configuration never accepts an empty or oversized model id', () => {
  assert.equal(normalizeProviderConfig({ provider: 'openai' }).model, '')
  assert.throws(
    () => normalizeProviderConfig({ provider: 'openai', model: 'x'.repeat(257) }),
    /Model ID/,
  )
})

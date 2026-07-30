import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright'
import sharp from 'sharp'

const root = resolve(import.meta.dirname, '..')
const sourceExtensionPath = resolve(root, 'extension')
let readerPort = 0
let imagePort = 0
let koharuPort = 0

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function solidPng(red, green, blue, width = 800, height = 1200) {
  const row = Buffer.alloc(1 + width * 3)
  for (let offset = 1; offset < row.length; offset += 3) {
    row[offset] = red
    row[offset + 1] = green
    row[offset + 2] = blue
  }
  const raw = Buffer.alloc(row.length * height)
  for (let y = 0; y < height; y += 1) row.copy(raw, y * row.length)

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolveListen(server.address().port))
  })
}

function close(server) {
  return new Promise((resolveClose) => server.close(() => resolveClose()))
}

function json(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  response.end(JSON.stringify(value))
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

async function readMultipartFile(request) {
  const contentType = request.headers['content-type'] || ''
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.slice(1).find(Boolean)
  assert.ok(boundary, 'multipart boundary is required')
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'))
  const fileEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`), headerEnd + 4)
  assert.ok(headerEnd >= 0 && fileEnd > headerEnd, 'multipart file body is required')
  return body.subarray(headerEnd + 4, fileEnd)
}

function readerHtml() {
  const imageBase = `http://127.0.0.1:${imagePort}`
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Synthetic generic comic reader</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #202020; color: white; font-family: sans-serif; }
    header { height: 72px; display: flex; align-items: center; gap: 20px; padding: 12px; }
    .logo { width: 120px; height: 40px; }
    .banner { display: block; width: min(800px, 100%); height: 100px; margin: 0 auto 16px; }
    .reader { width: min(800px, 100%); margin: auto; }
    .comic-page, amp-img { display: block; width: 100%; height: auto; aspect-ratio: 2 / 3; }
    amp-img > img { display: block; width: 100%; height: 100%; }
    .recommendations { display: flex; gap: 12px; padding: 24px; }
    .recommend-thumb { width: 180px; height: 240px; }
  </style>
</head>
<body>
  <header><img class="logo" src="${imageBase}/logo.png" alt="logo"></header>
  <img class="banner" src="${imageBase}/banner.png" alt="banner">
  <main class="reader" id="reader">
    <img class="comic-page" src="${imageBase}/page-1.png" alt="第一頁">
    <picture><img class="comic-page" src="${imageBase}/page-2.png" alt="第二頁"></picture>
    <amp-img class="comic-page" data-src="${imageBase}/page-3.png" width="800" height="1200">
      <img src="${imageBase}/page-3.png" alt="第三頁">
    </amp-img>
  </main>
  <section class="recommendations">
    <img class="recommend-thumb" src="${imageBase}/thumb.png" alt="recommend thumbnail">
  </section>
  <script>
    setTimeout(() => {
      const image = document.createElement('img')
      image.className = 'comic-page'
      image.alt = '第四頁'
      image.dataset.src = '${imageBase}/page-4.png'
      document.querySelector('#reader').append(image)
      requestAnimationFrame(() => { image.src = image.dataset.src })
    }, 350)
  </script>
</body>
</html>`
}

const images = new Map([
  ['/page-1.png', solidPng(246, 232, 210)],
  ['/page-2.png', solidPng(218, 235, 247)],
  ['/page-3.png', solidPng(232, 220, 246)],
  ['/page-4.png', solidPng(220, 242, 224)],
  ['/page-5.png', solidPng(244, 226, 218)],
  ['/logo.png', solidPng(230, 170, 45, 120, 40)],
  ['/banner.png', solidPng(80, 80, 80, 800, 100)],
  ['/thumb.png', solidPng(120, 120, 120, 180, 240)],
])

const state = {
  pipelineCalls: 0,
  uploadCalls: 0,
  operations: [],
  pages: new Map(),
  pageImages: new Map(),
  currentTarget: {
    kind: 'provider',
    modelId: 'gemini-3.1-flash-lite',
    providerId: 'gemini',
  },
  expectedAuth: null,
  failNext: false,
  liveStartIndex: null,
}

const readerServer = createServer((request, response) => {
  if (request.url === '/chapter') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(readerHtml())
    return
  }
  response.writeHead(404)
  response.end()
})

const imageServer = createServer((request, response) => {
  const image = images.get(request.url)
  if (!image) {
    response.writeHead(404)
    response.end()
    return
  }
  response.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': image.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=3600',
  })
  response.end(image)
})

const koharuServer = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${koharuPort}`)
  if (state.expectedAuth) {
    assert.equal(request.headers.authorization, state.expectedAuth)
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/meta') {
    json(response, 200, { version: '0.61.2-e2e', mlDevice: 'mock' })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/engines') {
    json(response, 200, {
      detectors: [{ id: 'comic-text-bubble-detector', name: 'Detector' }],
      fontDetectors: [{ id: 'yuzumarker-font-detection', name: 'Font detector' }],
      segmenters: [{ id: 'comic-text-detector-seg', name: 'Text segmenter' }],
      bubbleSegmenters: [{
        id: 'speech-bubble-segmentation',
        name: 'Bubble segmenter',
      }],
      ocr: [{ id: 'paddle-ocr-vl-1.6', name: 'OCR' }],
      translators: [{ id: 'llm', name: 'LLM' }],
      inpainters: [{ id: 'lama-manga', name: 'LaMa Manga' }],
      renderers: [{ id: 'koharu-renderer', name: 'Koharu Renderer' }],
    })
    return
  }
  if (url.pathname === '/api/v1/llm/current' && request.method === 'GET') {
    json(response, 200, {
      status: 'ready',
      target: state.currentTarget,
      error: null,
    })
    return
  }
  if (url.pathname === '/api/v1/llm/current' && request.method === 'PUT') {
    const body = await readJson(request)
    state.currentTarget = body.target
    response.writeHead(204)
    response.end()
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/llm/catalog') {
    json(response, 200, {
      localModels: [],
      providers: [
        {
          id: 'gemini',
          name: 'Gemini',
          requiresApiKey: true,
          requiresBaseUrl: false,
          hasApiKey: true,
          status: 'ready',
          models: [{
            name: 'Gemini 3.1 Flash Lite',
            languages: ['zh-CN', 'vi-VN'],
            target: {
              kind: 'provider',
              modelId: 'gemini-3.1-flash-lite',
              providerId: 'gemini',
            },
          }],
        },
        {
          id: 'deepseek',
          name: 'DeepSeek',
          requiresApiKey: true,
          requiresBaseUrl: false,
          hasApiKey: true,
          status: 'ready',
          models: [
            {
              name: 'DeepSeek V4 Flash',
              languages: ['zh-CN', 'vi-VN'],
              target: {
                kind: 'provider',
                modelId: 'deepseek-v4-flash',
                providerId: 'deepseek',
              },
            },
            {
              name: 'DeepSeek V4 Pro',
              languages: ['zh-CN', 'vi-VN'],
              target: {
                kind: 'provider',
                modelId: 'deepseek-v4-pro',
                providerId: 'deepseek',
              },
            },
          ],
        },
      ],
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/projects') {
    json(response, 200, { id: 'e2e-project', name: 'E2E', path: '/tmp/e2e' })
    return
  }
  if (request.method === 'PUT' && url.pathname === '/api/v1/projects/current') {
    json(response, 200, { id: 'e2e-project', name: 'E2E', path: '/tmp/e2e' })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/pages') {
    const image = await readMultipartFile(request)
    state.uploadCalls += 1
    const pageId = `page-${state.uploadCalls}`
    state.pages.set(pageId, state.uploadCalls)
    state.pageImages.set(pageId, image)
    json(response, 200, { pages: [pageId] })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/pipelines') {
    const body = await readJson(request)
    assert.deepEqual(body.steps, [
      'comic-text-bubble-detector',
      'paddle-ocr-vl-1.6',
      'llm',
    ])
    assert.equal(body.targetLanguage, 'vi-VN')
    state.pipelineCalls += 1
    const operationId = `operation-${state.pipelineCalls}`
    const status = state.failNext ? 'failed' : 'completed'
    state.failNext = false
    state.operations.push({
      id: operationId,
      kind: 'pipeline',
      status,
      ...(status === 'failed' ? { error: 'Deterministic E2E failure' } : {}),
    })
    json(response, 200, { operationId })
    return
  }
  if (
    request.method === 'POST' &&
    url.pathname === '/api/v1/projects/current/export'
  ) {
    const body = await readJson(request)
    assert.equal(body.format, 'rendered')
    assert.equal(body.pages.length, 1)
    const source = state.pageImages.get(body.pages[0])
    assert.ok(source, 'rendered page source must exist')
    const rendered = await sharp(source).png().toBuffer()
    response.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': rendered.length,
      'Access-Control-Allow-Origin': '*',
    })
    response.end(rendered)
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/operations') {
    json(response, 200, {
      operations: state.operations,
    })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/scene.json') {
    const pages = {}
    for (const [pageId, index] of state.pages) {
      const liveHeights = [1133, 1333, 1133, 1133, 1133, 1133, 1133, 1133, 1333]
      const liveOffset =
        state.liveStartIndex === null ? -1 : index - state.liveStartIndex
      const pageHeight =
        liveOffset >= 0 ? liveHeights[liveOffset] : 1200
      pages[pageId] = {
        id: pageId,
        name: `${pageId}.png`,
        width: 800,
        height: pageHeight,
        nodes: {
          [`text-${index}`]: {
            id: `text-${index}`,
            transform: { x: 90, y: 100, width: 330, height: 140, rotationDeg: 0 },
            visible: true,
            kind: {
              text: {
                text: `你好 ${index}`,
                translation: `Trang ${index}: Xin chào, đây là một câu tiếng Việt dài.`,
                confidence: 0.98,
              },
            },
          },
        },
      }
    }
    json(response, 200, {
      epoch: state.pipelineCalls,
      scene: { project: { id: 'e2e-project', name: 'E2E' }, pages },
    })
    return
  }
  response.writeHead(404, { 'Content-Type': 'text/plain' })
  response.end(`Unhandled ${request.method} ${url.pathname}`)
})

let context
let profile

try {
  ;[readerPort, imagePort, koharuPort] = await Promise.all([
    listen(readerServer, readerPort),
    listen(imageServer, imagePort),
    listen(koharuServer, koharuPort),
  ])
  profile = await mkdtemp(join(tmpdir(), 'bong-bong-e2e-'))
  let extensionPath = sourceExtensionPath
  if (process.env.BONG_BONG_LIVE_URL) {
    extensionPath = join(profile, 'extension-under-test')
    await cp(sourceExtensionPath, extensionPath, { recursive: true })
    const manifestPath = join(extensionPath, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.host_permissions.push(
      'https://www.baozimh.com/*',
      'https://*.baozimh.com/*',
      'https://*.bzcdn.net/*',
    )
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  })

  let worker = context.serviceWorkers()[0]
  if (!worker) worker = await context.waitForEvent('serviceworker')
  const extensionId = new URL(worker.url()).host
  await worker.evaluate(
    (endpoint) => chrome.storage.local.set({
      bongBongSettings: { endpoint },
    }),
    `http://127.0.0.1:${koharuPort}/api/v1`,
  )

  const reader = await context.newPage()
  await reader.goto(`http://127.0.0.1:${readerPort}/chapter`)
  const originalSources = await reader.locator('img').evaluateAll((nodes) =>
    Object.fromEntries(nodes.map((node) => [
      node.getAttribute('alt') || node.className,
      {
        src: node.getAttribute('src'),
        dataSrc: node.getAttribute('data-src'),
      },
    ])),
  )

  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await popup.waitForSelector('#health-dot[data-tone="ready"]')
  await popup.locator('#settings').evaluate((details) => {
    details.open = true
  })
  await popup.locator('#auth-key').fill('e2e-remote-secret')
  await popup.locator('#auth-key').dispatchEvent('change')
  await popup.waitForFunction(
    () => document.querySelector('#save-state')?.textContent?.trim() === 'Đã lưu',
  )
  state.expectedAuth = 'Bearer e2e-remote-secret'
  await popup.locator('#refresh-button').click()
  await popup.waitForSelector('#health-dot[data-tone="ready"]')
  await popup.waitForFunction(
    () => [...document.querySelectorAll('#provider option')]
      .some((option) => option.value === 'deepseek'),
  )
  await popup.selectOption('#provider', 'deepseek')
  await popup.waitForFunction(
    () => [...document.querySelectorAll('#model option')]
      .some((option) => option.value === 'deepseek-v4-flash'),
  )
  assert.match(await popup.locator('#model-note').textContent(), /text OCR/)
  await popup.selectOption('#provider', 'gemini')
  await popup.waitForFunction(
    () => document.querySelector('#model')?.value === 'gemini-3.6-flash',
  )
  await reader.bringToFront()
  await popup.locator('#scan-button').click()
  try {
    await popup.waitForFunction(
      () => document.querySelector('#candidate-count')?.textContent?.trim() === '4',
      undefined,
      { timeout: 10_000 },
    )
  } catch (error) {
    console.error('Popup diagnostic', await popup.evaluate(() => ({
      count: document.querySelector('#candidate-count')?.textContent,
      status: document.querySelector('#page-status')?.textContent,
      toast: document.querySelector('#toast')?.textContent,
    })))
    console.error('Reader diagnostic', await reader.evaluate(() => ({
      control: document.querySelector('.bb-control__status')?.textContent,
      candidateCount: globalThis.__BONG_BONG_CONTENT__?.getStatus?.().counts?.total,
    })))
    throw error
  }
  await popup.locator('#translate-all-button').click()

  try {
    await reader.locator('.bb-overlay').nth(3).waitFor({ timeout: 20_000 })
  } catch (error) {
    console.error('Translation diagnostic', {
      pipelineCalls: state.pipelineCalls,
      uploadCalls: state.uploadCalls,
      content: await reader.evaluate(() => globalThis.__BONG_BONG_CONTENT__?.getStatus?.()),
    })
    throw error
  }
  assert.equal(await reader.locator('.bb-overlay').count(), 4)
  assert.equal(await reader.locator('.bb-rendered-page').count(), 4)
  assert.equal(await reader.locator('.bb-region').count(), 0)
  await reader.waitForFunction(
    () => [...document.querySelectorAll('.bb-rendered-page')]
      .every((image) => image.complete && image.naturalWidth > 0),
  )
  const renderedLayerIntegrity = await reader.evaluate(async () => {
    const source = document.querySelector('img[alt="第一頁"]')
    const rendered = document.querySelector('.bb-rendered-page')
    const root = rendered.closest('.bb-overlay')
    const renderedStyle = getComputedStyle(rendered)
    const rootStyle = getComputedStyle(root)
    const canvas = document.createElement('canvas')
    canvas.width = 20
    canvas.height = 30
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const sourceResponse = await fetch(source.currentSrc || source.src)
    const sourceBitmap = await createImageBitmap(await sourceResponse.blob())
    context.drawImage(sourceBitmap, 0, 0, canvas.width, canvas.height)
    const sourcePixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    sourceBitmap.close()
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(rendered, 0, 0, canvas.width, canvas.height)
    const renderedPixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let changedChannels = 0
    for (let index = 0; index < sourcePixels.length; index += 1) {
      if (sourcePixels[index] !== renderedPixels[index]) changedChannels += 1
    }
    return {
      changedChannels,
      imageOpacity: renderedStyle.opacity,
      imageFilter: renderedStyle.filter,
      rootBackground: rootStyle.backgroundColor,
    }
  })
  assert.deepEqual(renderedLayerIntegrity, {
    changedChannels: 0,
    imageOpacity: '1',
    imageFilter: 'none',
    rootBackground: 'rgba(0, 0, 0, 0)',
  })
  assert.equal(state.pipelineCalls, 4)
  assert.equal(state.uploadCalls, 4)

  const afterSources = await reader.locator('img').evaluateAll((nodes, originalKeys) =>
    Object.fromEntries(
      nodes
        .filter((node) => originalKeys.includes(node.getAttribute('alt') || node.className))
        .map((node) => [
          node.getAttribute('alt') || node.className,
          {
            src: node.getAttribute('src'),
            dataSrc: node.getAttribute('data-src'),
          },
        ]),
    ),
    Object.keys(originalSources),
  )
  assert.deepEqual(afterSources, originalSources)

  await reader.setViewportSize({ width: 375, height: 800 })
  await reader.reload()
  await reader.waitForFunction(
    () => document.querySelectorAll('.comic-page').length === 4,
  )
  await popup.bringToFront()
  await reader.bringToFront()
  await popup.locator('#scan-button').click()
  await popup.waitForFunction(() => {
    const button = document.querySelector('#scan-button')
    return (
      button &&
      !button.disabled &&
      button.textContent.trim() === 'Dịch trang này' &&
      document.querySelector('#candidate-count')?.textContent?.trim() === '4'
    )
  })
  await popup.locator('#translate-all-button').click()
  await reader.locator('.bb-overlay').nth(3).waitFor({ timeout: 20_000 })
  assert.equal(state.pipelineCalls, 4, 'cache hit must avoid new translation pipelines')

  await reader.locator('.comic-page').first().scrollIntoViewIfNeeded()
  await reader.waitForTimeout(500)
  const alignment = await reader.evaluate(() => {
    const host = document.querySelector('.comic-page')
    const overlay = document.querySelector('[aria-label="Bản dịch trang 1"]')
    const hostRect = host.getBoundingClientRect()
    const overlayRect = overlay.getBoundingClientRect()
    return {
      widthDelta: Math.abs(hostRect.width - overlayRect.width),
      leftDelta: Math.abs(hostRect.left - overlayRect.left),
      viewportOverflow: Math.max(0, overlayRect.right - innerWidth),
    }
  })
  assert.ok(alignment.widthDelta < 1.5, JSON.stringify(alignment))
  assert.ok(alignment.leftDelta < 1.5, JSON.stringify(alignment))
  assert.equal(alignment.viewportOverflow, 0)

  await reader.locator('.bb-control__reveal').click()
  assert.equal(await reader.locator('.bb-overlay:not([hidden])').count(), 0)
  await reader.locator('.bb-control__reveal').click()
  assert.equal(await reader.locator('.bb-overlay:not([hidden])').count(), 4)

  await reader.locator('.bb-control__pause').click()
  await reader.evaluate((url) => {
    const image = document.createElement('img')
    image.className = 'comic-page'
    image.alt = '第五頁'
    image.src = url
    document.querySelector('#reader').append(image)
  }, `http://127.0.0.1:${imagePort}/page-5.png`)
  state.failNext = true
  await popup.bringToFront()
  await reader.bringToFront()
  await popup.locator('#scan-button').click()
  await popup.waitForFunction(() => {
    const button = document.querySelector('#scan-button')
    return (
      button &&
      !button.disabled &&
      document.querySelector('#candidate-count')?.textContent?.trim() === '5'
    )
  })
  await reader.locator('.bb-control__pause').click()
  await reader.locator('[aria-label="Bản dịch trang 5"]').waitFor({ timeout: 20_000 })
  assert.equal(await reader.locator('.bb-overlay').count(), 5)
  assert.equal(
    await reader.locator('img[alt="第五頁"]').getAttribute('src'),
    `http://127.0.0.1:${imagePort}/page-5.png`,
  )
  assert.equal(
    state.pipelineCalls,
    6,
    'one failed Gemini pipeline plus one successful DeepSeek fallback expected',
  )
  assert.deepEqual(state.currentTarget, {
    kind: 'provider',
    modelId: 'deepseek-v4-flash',
    providerId: 'deepseek',
  })

  if (process.env.BONG_BONG_LIVE_URL) {
    state.liveStartIndex = state.uploadCalls + 1
    await reader.setViewportSize({ width: 375, height: 800 })
    await reader.goto(process.env.BONG_BONG_LIVE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    const originalLiveSources = await reader
      .locator('ul.comic-contain amp-img.comic-contain__item')
      .evaluateAll((nodes) => nodes.map((node) => ({
        src: node.getAttribute('src'),
        dataSrc: node.getAttribute('data-src'),
      })))
    assert.equal(originalLiveSources.length, 9)
    await reader.waitForFunction(() => {
      const nodes = [
        ...document.querySelectorAll('ul.comic-contain amp-img.comic-contain__item'),
      ]
      return nodes.length === 9 && nodes.every((node) => {
        const rect = node.getBoundingClientRect()
        return rect.width >= 300 && rect.height >= 400
      })
    })

    await popup.bringToFront()
    await reader.bringToFront()
    await popup.locator('#scan-button').click()
    try {
      await popup.waitForFunction(
        () => document.querySelector('#candidate-count')?.textContent?.trim() === '9',
        undefined,
        { timeout: 15_000 },
      )
    } catch (error) {
      console.error('Live scan diagnostic', await popup.evaluate(() => ({
        count: document.querySelector('#candidate-count')?.textContent,
        status: document.querySelector('#page-status')?.textContent,
        toast: document.querySelector('#toast')?.textContent,
      })))
      throw error
    }
    await popup.locator('#translate-all-button').click()
    try {
      await reader.locator('.bb-overlay').nth(8).waitFor({ timeout: 30_000 })
    } catch (error) {
      console.error('Live translation diagnostic', {
        pipelineCalls: state.pipelineCalls,
        uploadCalls: state.uploadCalls,
        overlays: await reader.locator('.bb-overlay').count(),
        control: await reader.locator('.bb-control__status').textContent().catch(() => null),
        popupStatus: await popup.locator('#progress-status').textContent().catch(() => null),
      })
      throw error
    }
    assert.equal(await reader.locator('.bb-overlay').count(), 9)

    const afterLiveSources = await reader
      .locator('ul.comic-contain amp-img.comic-contain__item')
      .evaluateAll((nodes) => nodes.map((node) => ({
        src: node.getAttribute('src'),
        dataSrc: node.getAttribute('data-src'),
      })))
    assert.deepEqual(afterLiveSources, originalLiveSources)

    await reader.locator('ul.comic-contain amp-img.comic-contain__item').first()
      .scrollIntoViewIfNeeded()
    await reader.waitForTimeout(500)
    const liveAlignment = await reader.evaluate(() => {
      const host = document.querySelector('ul.comic-contain amp-img.comic-contain__item')
      const overlay = document.querySelector('[aria-label="Bản dịch trang 1"]')
      const hostRect = host.getBoundingClientRect()
      const overlayRect = overlay.getBoundingClientRect()
      return {
        hostWidth: hostRect.width,
        overlayWidth: overlayRect.width,
        hostLeft: hostRect.left,
        overlayLeft: overlayRect.left,
        inlineWidth: overlay.style.width,
        inlineTransform: overlay.style.transform,
        widthDelta: Math.abs(hostRect.width - overlayRect.width),
        leftDelta: Math.abs(hostRect.left - overlayRect.left),
      }
    })
    assert.ok(liveAlignment.widthDelta < 1.5, JSON.stringify(liveAlignment))
    assert.ok(liveAlignment.leftDelta < 1.5, JSON.stringify(liveAlignment))

    const resultDirectory = resolve(root, 'test-results')
    await mkdir(resultDirectory, { recursive: true })
    await reader.screenshot({
      path: join(resultDirectory, 'live-baozimh-mobile.png'),
      fullPage: false,
    })

    await reader.setViewportSize({ width: 1280, height: 900 })
    await reader.reload({ waitUntil: 'domcontentloaded' })
    await reader.waitForFunction(
      () => document.querySelectorAll(
        'ul.comic-contain amp-img.comic-contain__item',
      ).length === 9,
    )
    await popup.bringToFront()
    await reader.bringToFront()
    await popup.locator('#scan-button').click()
    await popup.waitForFunction(() => {
      const button = document.querySelector('#scan-button')
      return (
        button &&
        !button.disabled &&
        button.textContent.trim() === 'Dịch trang này' &&
        document.querySelector('#candidate-count')?.textContent?.trim() === '9'
      )
    })
    await popup.locator('#translate-all-button').click()
    await reader.locator('.bb-overlay').nth(8).waitFor({ timeout: 30_000 })
    const desktopAlignment = await reader.evaluate(() => {
      const host = document.querySelector('ul.comic-contain amp-img.comic-contain__item')
      const overlay = document.querySelector('[aria-label="Bản dịch trang 1"]')
      const hostRect = host.getBoundingClientRect()
      const overlayRect = overlay.getBoundingClientRect()
      return {
        widthDelta: Math.abs(hostRect.width - overlayRect.width),
        leftDelta: Math.abs(hostRect.left - overlayRect.left),
      }
    })
    assert.ok(desktopAlignment.widthDelta < 1.5, JSON.stringify(desktopAlignment))
    assert.ok(desktopAlignment.leftDelta < 1.5, JSON.stringify(desktopAlignment))
    await reader.screenshot({
      path: join(resultDirectory, 'live-baozimh-desktop.png'),
      fullPage: false,
    })

    console.log(
      'Live Baozimh smoke passed: 9 candidates, desktop/mobile overlays aligned, sources intact.',
    )
  }

  console.log(
    `Extension E2E passed: 4 generic candidates, clean rendered layers, source intact, cache pipelineCalls=${state.pipelineCalls}.`,
  )
} finally {
  await context?.close().catch(() => undefined)
  await Promise.all([
    close(readerServer).catch(() => undefined),
    close(imageServer).catch(() => undefined),
    close(koharuServer).catch(() => undefined),
  ])
  if (profile) await rm(profile, { recursive: true, force: true })
}

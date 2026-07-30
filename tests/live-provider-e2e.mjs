import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const sourceExtensionPath = resolve(root, 'extension')
const targetUrl =
  process.env.BONG_BONG_LIVE_URL ||
  'https://www.baozimh.com/comic/chapter/yaoshenji-taxuedongman/0_765.html'
const apiEndpoint =
  process.env.BONG_BONG_API_ENDPOINT ||
  'http://127.0.0.1:4000/api/v1'
const authKey = process.env.BONG_BONG_AUTH_KEY || ''
const provider = process.env.BONG_BONG_PROVIDER || 'gemini'
const model =
  process.env.BONG_BONG_MODEL ||
  (provider === 'deepseek' ? 'deepseek-v4-flash' : 'gemini-3.6-flash')
const timeoutMs = Number(process.env.BONG_BONG_LIVE_TIMEOUT_MS || 30 * 60 * 1000)
const startPage = Math.max(1, Number(process.env.BONG_BONG_START_PAGE || 1))
const startedAt = Date.now()
const profile = await mkdtemp(join(tmpdir(), `bong-bong-${provider}-`))
const extensionPath = join(profile, 'extension-under-test')
const resultDirectory = resolve(root, 'test-results', provider)
let context
let progressTimer

async function main() {
  await cp(sourceExtensionPath, extensionPath, { recursive: true })
  const manifestPath = join(extensionPath, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.host_permissions.push(
    'https://www.baozimh.com/*',
    'https://*.baozimh.com/*',
    'https://*.bzcdn.net/*',
  )
  const apiUrl = new URL(apiEndpoint)
  manifest.host_permissions.push(
    `${apiUrl.protocol}//${apiUrl.hostname}/*`,
  )
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

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
    ({ endpoint, key }) => chrome.storage.local.set({
      bongBongSettings: {
        endpoint,
        authKey: key,
      },
    }),
    { endpoint: apiEndpoint, key: authKey },
  )
  const reader = await context.newPage()
  await reader.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const pageLocator = reader.locator('ul.comic-contain amp-img.comic-contain__item')
  await reader.waitForFunction(() => {
    const pages = [
      ...document.querySelectorAll('ul.comic-contain amp-img.comic-contain__item'),
    ]
    return pages.length === 9 && pages.every((page) => {
      const rect = page.getBoundingClientRect()
      return rect.width >= 500 && rect.height >= 700
    })
  }, undefined, { timeout: 30_000 })
  assert.equal(await pageLocator.count(), 9)
  assert.ok(startPage <= 9, 'BONG_BONG_START_PAGE must be between 1 and 9')

  await pageLocator.nth(startPage - 1).evaluate((page) => {
    page.scrollIntoView({ block: 'center' })
  })
  await reader.waitForTimeout(500)
  await reader.evaluate(() => {
    globalThis.__bbOverlayOrder = []
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          const overlays = node.matches('.bb-overlay')
            ? [node]
            : [...node.querySelectorAll('.bb-overlay')]
          for (const overlay of overlays) {
            const match = (overlay.getAttribute('aria-label') || '').match(/(\d+)$/)
            if (match) globalThis.__bbOverlayOrder.push(Number(match[1]))
          }
        }
      }
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
    globalThis.__bbOverlayObserver = observer
  })

  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await popup.waitForFunction(
    () => !document.querySelector('#refresh-button')?.disabled,
    undefined,
    { timeout: 30_000 },
  )
  await popup.locator('#refresh-button').click()
  try {
    await popup.waitForSelector('#health-dot[data-tone="ready"]', { timeout: 30_000 })
  } catch (error) {
    console.error('Remote health diagnostic', await popup.evaluate(async (endpoint) => {
      const url = new URL(endpoint)
      const originPattern = `${url.protocol}//${url.hostname}/*`
      return {
        tone: document.querySelector('#health-dot')?.dataset?.tone,
        health: document.querySelector('#health-state')?.textContent?.trim(),
        toast: document.querySelector('#toast')?.textContent?.trim(),
        endpointPermission: await chrome.permissions.contains({
          origins: [originPattern],
        }),
      }
    }, apiEndpoint))
    throw error
  }
  await popup.locator('#settings').evaluate((details) => {
    details.open = true
  })
  await popup.waitForFunction(
    (wantedProvider) =>
      [...document.querySelectorAll('#provider option')]
        .some((option) => option.value === wantedProvider),
    provider,
  )
  await popup.selectOption('#provider', provider)
  await popup.waitForFunction(
    (wantedModel) =>
      [...document.querySelectorAll('#model option')]
        .some((option) => option.value === wantedModel),
    model,
  )
  await popup.selectOption('#model', model)
  await popup.waitForFunction(
    () => document.querySelector('#save-state')?.textContent?.trim() === 'Đã lưu',
    undefined,
    { timeout: 15_000 },
  )

  await reader.bringToFront()
  await popup.locator('#scan-button').click()
  await popup.waitForFunction(
    () => document.querySelector('#candidate-count')?.textContent?.trim() === '9',
    undefined,
    { timeout: 30_000 },
  )
  await popup.locator('#translate-all-button').click()
  const translateStartedAt = Date.now()
  const firstOverlayPromise = reader
    .waitForSelector('.bb-overlay', { timeout: timeoutMs })
    .then(async (overlay) => ({
      page: Number((await overlay.getAttribute('aria-label'))?.match(/(\d+)$/)?.[1]),
      elapsedMs: Date.now() - translateStartedAt,
    }))

  progressTimer = setInterval(async () => {
    try {
      const status = await popup.evaluate(() => ({
        progress: document.querySelector('#progress-count')?.textContent?.trim(),
        state: document.querySelector('#progress-status')?.textContent?.trim(),
        failures: document.querySelector('#failure-count')?.textContent?.trim(),
        detail: document.querySelector('#page-status')?.textContent?.trim(),
      }))
      const overlays = await reader.locator('.bb-overlay').count()
      const boxes = await reader.locator('.bb-translation-box').count()
      process.stdout.write(
        `PROGRESS ${provider}/${model}: ${JSON.stringify({ ...status, overlays, boxes })}\n`,
      )
    } catch {
      // The final close can race this diagnostics timer.
    }
  }, 10_000)

  await reader.waitForFunction(() => {
    const overlays = document.querySelectorAll('.bb-overlay').length
    const state = document.querySelector('.bb-control__status')?.textContent?.trim()
    return overlays === 9 && (/^Đã xử lý 9\/9\b/.test(state || '') || /lỗi/.test(state || ''))
  }, undefined, { timeout: timeoutMs })
  clearInterval(progressTimer)
  progressTimer = undefined

  const status = await popup.evaluate(() => ({
    progress: document.querySelector('#progress-count')?.textContent?.trim(),
    state: document.querySelector('#progress-status')?.textContent?.trim(),
    failures: document.querySelector('#failure-count')?.textContent?.trim(),
    failureHidden: document.querySelector('#failure-count')?.hidden,
  }))
  assert.equal(status.failureHidden, true, JSON.stringify(status))

  const overlayCount = await reader.locator('.bb-overlay').count()
  const boxCount = await reader.locator('.bb-translation-box').count()
  const firstOverlay = await firstOverlayPromise
  const overlayOrder = await reader.evaluate(() => {
    globalThis.__bbOverlayObserver?.disconnect()
    return [...(globalThis.__bbOverlayOrder || [])]
  })
  assert.equal(overlayCount, 9)
  assert.ok(boxCount >= 1, 'translated metadata must render as readable boxes')

  const boxAudit = await reader.locator('.bb-translation-box').evaluateAll((boxes) => ({
    count: boxes.length,
    overflowCount: boxes.filter(
      (box) =>
        box.scrollHeight > box.clientHeight + 1 ||
        box.scrollWidth > box.clientWidth + 1,
    ).length,
    blankCount: boxes.filter((box) => !box.textContent?.trim()).length,
    samples: boxes.slice(0, 12).map((box) => box.textContent?.trim()),
  }))
  assert.equal(boxAudit.overflowCount, 0, JSON.stringify(boxAudit))
  assert.equal(boxAudit.blankCount, 0, JSON.stringify(boxAudit))

  await pageLocator.nth(4).scrollIntoViewIfNeeded()
  await reader.waitForTimeout(400)
  await mkdir(resultDirectory, { recursive: true })
  const screenshotPath = join(resultDirectory, 'chapter-765-page-5.png')
  await reader.screenshot({ path: screenshotPath, fullPage: false })

  const sceneResponse = await fetch(`${apiEndpoint}/scene.json`, {
    headers: authKey
      ? { Authorization: `Bearer ${authKey}` }
      : {},
  })
  assert.equal(sceneResponse.ok, true)
  const scenePayload = await sceneResponse.json()
  const scene = scenePayload.scene || scenePayload
  const pages = Object.values(scene.pages || {}).sort((left, right) =>
    String(left.name || '').localeCompare(String(right.name || '')))
  const pageCoverage = pages.map((page, index) => {
    const nodes = Object.values(page.nodes || {}).filter((node) => node?.kind?.text)
    const translated = nodes.filter((node) =>
      String(node.kind.text.translation || '').trim(),
    )
    return {
      page: index + 1,
      detected: nodes.length,
      translated: translated.length,
    }
  })
  const elapsedMs = Date.now() - startedAt
  const result = {
    targetUrl,
    provider,
    model,
    startPage,
    elapsedMs,
    elapsedSeconds: Math.round(elapsedMs / 100) / 10,
    firstOverlay,
    overlayOrder,
    status,
    overlayCount,
    boxAudit,
    pageCoverage,
    screenshotPath,
  }
  await writeFile(
    join(resultDirectory, 'result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  )
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`)
}

try {
  await main()
} finally {
  if (progressTimer) clearInterval(progressTimer)
  if (context) await context.close()
  await rm(profile, { recursive: true, force: true })
}

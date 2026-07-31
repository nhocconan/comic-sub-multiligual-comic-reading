'use strict'

const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, safeStorage, clipboard, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const { DEFAULT_SETTINGS, migrateSettings, safeAssetReferrer, safeUrl } = require('./lib/domain.cjs')
const { ALLOWED_TYPES, BrokerClientError, createBrokerClient, normalizeEndpoint, readBounded, sha256, sniffImageType } = require('./lib/broker-client.cjs')
const { isLoopbackCompatible, listProviderModels, normalizeProviderConfig, recommendModel, translateOcrPages } = require('./lib/byo-provider.cjs')
const { attachNativeTranslations, nativeTranslationInput } = require('./lib/native-translation.cjs')
const { cachedResults, pruneTranslationCache, recordTranslation } = require('./lib/translation-cache.cjs')

function prepareUserDataPath() {
  const isolatedPath = String(process.env.MANGA_SUB_USER_DATA_DIR || '').trim()
  if (isolatedPath) {
    const resolved = path.resolve(isolatedPath)
    fs.mkdirSync(resolved, { recursive: true })
    app.setPath('userData', resolved)
    return
  }
  const appData = app.getPath('appData')
  const nextPath = path.join(appData, 'Manga Sub')
  const legacyPaths = [
    path.join(appData, 'comic-sub-desktop'),
    path.join(appData, 'Comic Sub'),
  ]
  fs.mkdirSync(nextPath, { recursive: true })
  for (const name of ['reader-state.json', 'provider-token.bin']) {
    const destination = path.join(nextPath, name)
    if (fs.existsSync(destination)) continue
    const source = legacyPaths.map((directory) => path.join(directory, name)).find((candidate) => fs.existsSync(candidate))
    if (source) fs.copyFileSync(source, destination)
  }
  app.setPath('userData', nextPath)
}

prepareUserDataPath()

let windowRef
let readerView
let readerVisible = true
let privateSession = false
let activeReaderUrl = null
let historyPersistTimer
let pendingHistory
let activeSnapshot = null
let restoredCacheNavigationId = null
let restoredCacheSources = new Set()
let activeJobs = new Map()
let tokenConfiguredCache = false
const providerKeyConfiguredCache = new Map()
const readerBounds = { x: 296, y: 84, width: 820, height: 740 }
const appIconPath = path.join(__dirname, 'build', 'icon.png')

function installApplicationIcon() {
  const icon = nativeImage.createFromPath(appIconPath)
  if (icon.isEmpty()) return null
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(icon)
  return icon
}

function dataPath(name) { return path.join(app.getPath('userData'), name) }

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(dataPath('reader-state.json'), 'utf8'))
    const migrated = migrateSettings(saved.settings)
    return {
      settings: migrated.settings,
      history: Array.isArray(saved.history) ? saved.history.slice(0, 100) : [],
      translationCache: pruneTranslationCache(saved.translationCache, migrated.settings.translationCacheLimit),
      glossaryConsent: saved.glossaryConsent || null,
      glossary: Array.isArray(saved.glossary) ? saved.glossary : [],
      seriesGlossary: saved.seriesGlossary || null,
      needsModelChoice: migrated.needsModelChoice,
      deviceId: saved.deviceId || `desktop:${randomUUID()}`,
    }
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, history: [], translationCache: [], glossaryConsent: null, glossary: [], seriesGlossary: null, needsModelChoice: false, deviceId: `desktop:${randomUUID()}` }
  }
}

let state = loadState()

function saveState() {
  state.translationCache = pruneTranslationCache(
    state.translationCache,
    state.settings.translationCacheLimit,
  )
  const safe = { ...state, settings: { ...state.settings, tokenConfigured: undefined } }
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(dataPath('reader-state.json'), JSON.stringify(safe, null, 2), { mode: 0o600 })
}

function nativeCredentialExecutable() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'manga-sub-credentials')
    : path.join(__dirname, 'bin', 'manga-sub-credentials')
}

function runCredentialHelper(command, input = null, service = 'com.tienle.comicsub.broker-token') {
  if (!/^com\.tienle\.mangasub\.[a-z0-9.-]+$/.test(service)
    && service !== 'com.tienle.comicsub.broker-token') {
    return Promise.reject(new BrokerClientError('CREDENTIAL_SERVICE_INVALID', 'Credential service không hợp lệ.'))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(nativeCredentialExecutable(), [command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MANGA_SUB_CREDENTIAL_SERVICE: service },
    })
    const output = []
    const errors = []
    let outputBytes = 0
    let errorBytes = 0
    let settled = false
    const finish = (error, value = '') => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve(value)
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      const error = new BrokerClientError(
        'CREDENTIAL_TIMEOUT',
        'Credential store phản hồi quá chậm. Manga Sub đã dừng yêu cầu thay vì khóa giao diện.',
      )
      finish(error)
    }, 5_000)
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length
      if (outputBytes > 8_192) child.kill('SIGKILL')
      else output.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      errorBytes += chunk.length
      if (errorBytes <= 4_096) errors.push(chunk)
    })
    child.on('error', (cause) => {
      finish(new BrokerClientError('CREDENTIAL_HELPER_FAILED', cause.message))
    })
    child.on('close', (code) => {
      if (settled) return
      if (code === 0) {
        finish(null, Buffer.concat(output).toString('utf8'))
        return
      }
      const detail = Buffer.concat(errors).toString('utf8').trim()
      const error = new BrokerClientError(
        detail === 'not-found' ? 'CREDENTIAL_MISSING' : 'CREDENTIAL_STORE_FAILED',
        detail === 'not-found'
          ? 'Chưa có broker token trong credential store.'
          : 'Không thể đọc credential store của hệ điều hành.',
      )
      finish(error)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input === null ? undefined : Buffer.from(input, 'utf8'))
  })
}

function tokenStatus() {
  return tokenConfiguredCache
}

async function refreshTokenStatus() {
  if (process.platform !== 'darwin') {
    try { tokenConfiguredCache = fs.existsSync(dataPath('provider-token.bin')) } catch { tokenConfiguredCache = false }
    return tokenConfiguredCache
  }
  try {
    await runCredentialHelper('status')
    tokenConfiguredCache = true
  } catch {
    tokenConfiguredCache = false
  }
  return tokenConfiguredCache
}

async function readToken() {
  if (process.platform === 'darwin') {
    try {
      const value = await runCredentialHelper('read')
      tokenConfiguredCache = Boolean(value)
      return value
    } catch (error) {
      if (error.code === 'CREDENTIAL_MISSING') {
        tokenConfiguredCache = false
        return ''
      }
      throw error
    }
  }
  try {
    const value = fs.readFileSync(dataPath('provider-token.bin'))
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(value) : value.toString('utf8')
  } catch { return '' }
}

async function writeToken(token) {
  const value = String(token || '').trim()
  if (!value) {
    if (process.platform === 'darwin') {
      await runCredentialHelper('delete')
      tokenConfiguredCache = false
      return false
    }
    fs.rmSync(dataPath('provider-token.bin'), { force: true })
    tokenConfiguredCache = false
    return false
  }
  if (value.length > 4096 || /[\r\n]/.test(value)) throw new Error('Token không hợp lệ.')
  if (process.platform === 'darwin') {
    await runCredentialHelper('write', value)
    tokenConfiguredCache = true
    return true
  }
  const encoded = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(value)
    : Buffer.from(value, 'utf8')
  fs.writeFileSync(dataPath('provider-token.bin'), encoded, { mode: 0o600 })
  tokenConfiguredCache = true
  return true
}

function providerCredentialId(providerValue) {
  const provider = String(providerValue || '').trim().toLowerCase()
  if (!['gemini', 'openai', 'anthropic', 'openai-compatible'].includes(provider)) {
    throw new BrokerClientError('BYO_PROVIDER_INVALID', 'Provider không được hỗ trợ.')
  }
  return provider
}

function providerCredentialService(providerValue) {
  return `com.tienle.mangasub.provider.${providerCredentialId(providerValue)}`
}

function providerCredentialPath(providerValue) {
  return dataPath(`provider-key-${providerCredentialId(providerValue)}.bin`)
}

async function refreshProviderKeyStatus(providerValue) {
  const provider = providerCredentialId(providerValue)
  try {
    if (process.platform === 'darwin') {
      await runCredentialHelper('status', null, providerCredentialService(provider))
    } else {
      fs.accessSync(providerCredentialPath(provider), fs.constants.R_OK)
    }
    providerKeyConfiguredCache.set(provider, true)
  } catch {
    providerKeyConfiguredCache.set(provider, false)
  }
  return providerKeyConfiguredCache.get(provider)
}

async function readProviderKey(providerValue) {
  const provider = providerCredentialId(providerValue)
  try {
    const value = process.platform === 'darwin'
      ? await runCredentialHelper('read', null, providerCredentialService(provider))
      : safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(fs.readFileSync(providerCredentialPath(provider)))
        : fs.readFileSync(providerCredentialPath(provider), 'utf8')
    providerKeyConfiguredCache.set(provider, Boolean(value))
    return value
  } catch (error) {
    if (error.code === 'CREDENTIAL_MISSING' || error.code === 'ENOENT') {
      providerKeyConfiguredCache.set(provider, false)
      return ''
    }
    throw error
  }
}

async function writeProviderKey(providerValue, keyValue) {
  const provider = providerCredentialId(providerValue)
  const key = String(keyValue || '').trim()
  if (key.length > 4096 || /[\r\n]/.test(key)) {
    throw new BrokerClientError('BYO_KEY_INVALID', 'API key không hợp lệ.')
  }
  if (!key) {
    if (process.platform === 'darwin') {
      await runCredentialHelper('delete', null, providerCredentialService(provider))
    } else {
      fs.rmSync(providerCredentialPath(provider), { force: true })
    }
    providerKeyConfiguredCache.set(provider, false)
    return false
  }
  if (process.platform === 'darwin') {
    await runCredentialHelper('write', key, providerCredentialService(provider))
  } else {
    const value = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(key)
      : Buffer.from(key, 'utf8')
    fs.writeFileSync(providerCredentialPath(provider), value, { mode: 0o600 })
  }
  providerKeyConfiguredCache.set(provider, true)
  return true
}

function publicState() {
  const provider = providerCredentialId(state.settings.byoProvider || 'gemini')
  return {
    settings: {
      ...state.settings,
      tokenConfigured: tokenStatus(),
      byoKeyConfigured: providerKeyConfiguredCache.get(provider) || false,
    },
    history: state.history,
    glossaryConsent: state.glossaryConsent,
    glossary: state.glossary,
    privateSession,
    readerUrl: activeReaderUrl,
    needsModelChoice: state.needsModelChoice,
  }
}

function emit(channel, payload) {
  if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send(channel, payload)
}

function configureSession(partition) {
  const target = session.fromPartition(partition)
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  target.setPermissionCheckHandler(() => false)
  target.setDisplayMediaRequestHandler((_request, callback) => callback({ video: null, audio: null }))
  return target
}

function isSafeExternalUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}

function destroyReader() {
  cancelActiveJobs().catch(() => {})
  activeSnapshot = null
  restoredCacheNavigationId = null
  restoredCacheSources = new Set()
  if (!readerView) return
  try { windowRef.contentView.removeChildView(readerView) } catch {}
  try { readerView.webContents.close() } catch {}
  readerView = null
}

function applyReaderBounds() {
  if (!readerView) return
  readerView.setBounds(readerBounds)
  readerView.setVisible(readerVisible)
}

function recordHistory(url, reader = {}) {
  if (privateSession || !isSafeExternalUrl(url)) return
  const parsed = new URL(url)
  const sanitized = safeUrl(url)
  const existing = state.history.find((entry) => entry.url === sanitized)
  const item = {
    id: existing?.id || `h_${Date.now().toString(36)}`,
    url: sanitized,
    origin: parsed.origin,
    title: reader.title || existing?.title || parsed.hostname,
    candidateIndex: Number.isInteger(reader.candidateIndex) ? reader.candidateIndex : existing?.candidateIndex || 0,
    candidateCount: Number.isInteger(reader.candidateCount) ? reader.candidateCount : existing?.candidateCount || 0,
    translated: Boolean(reader.translated || existing?.translated),
    language: state.settings.targetLanguage,
    updatedAt: new Date().toISOString(),
  }
  state.history = [item, ...state.history.filter((entry) => entry.id !== item.id)].slice(0, 100)
  saveState()
  emit('app:history', state.history)
}

function scheduleHistory(url, reader) {
  pendingHistory = { url, reader }
  clearTimeout(historyPersistTimer)
  historyPersistTimer = setTimeout(() => {
    if (pendingHistory) recordHistory(pendingHistory.url, pendingHistory.reader)
    pendingHistory = null
  }, 800)
}

function rememberTranslation(snapshot, candidateId, result, receipt, route) {
  if (privateSession || !snapshot?.pageUrl) return
  const candidate = snapshot.candidates?.find((item) => item.candidateId === candidateId)
  if (!candidate?.sourceUrl) return
  state.translationCache = recordTranslation(state.translationCache, {
    pageUrl: snapshot.pageUrl,
    targetLanguage: state.settings.targetLanguage,
    sourceUrl: candidate.sourceUrl,
    result,
    receipt,
    route,
  }, state.settings.translationCacheLimit)
  saveState()
}

function restoreCachedTranslations(snapshot) {
  if (privateSession || !snapshot?.navigationId) return
  if (restoredCacheNavigationId !== snapshot.navigationId) {
    restoredCacheNavigationId = snapshot.navigationId
    restoredCacheSources = new Set()
  }
  for (const cached of cachedResults(
    state.translationCache,
    snapshot,
    state.settings.targetLanguage,
  )) {
    if (restoredCacheSources.has(cached.sourceUrl)) continue
    restoredCacheSources.add(cached.sourceUrl)
    const jobId = `cache:${randomUUID()}`
    readerStatus({
      type: 'attach-result',
      jobId,
      candidateId: cached.candidateId,
      result: cached.result,
      receipt: cached.receipt,
      restored: true,
    })
    emit('app:broker-receipt', {
      ...cached.receipt,
      jobId,
      route: cached.receipt?.route || 'local',
      restored: true,
    })
  }
}

function createReader({ url, isPrivate = privateSession } = {}) {
  destroyReader()
  const partition = isPrivate ? `temp:comic-sub-${Date.now()}` : 'persist:comic-sub-reader'
  configureSession(partition)
  readerView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'reader-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      partition,
    },
  })
  windowRef.contentView.addChildView(readerView)
  applyReaderBounds()
  readerView.webContents.setWindowOpenHandler(({ url: requested }) => {
    if (isSafeExternalUrl(requested)) shell.openExternal(requested)
    return { action: 'deny' }
  })
  readerView.webContents.on('will-navigate', (event, nextUrl) => {
    if (!isSafeExternalUrl(nextUrl)) event.preventDefault()
  })
  readerView.webContents.on('will-redirect', (event, nextUrl) => {
    if (!isSafeExternalUrl(nextUrl)) event.preventDefault()
  })
  readerView.webContents.on('did-navigate', (_event, nextUrl) => {
    activeSnapshot = null
    cancelActiveJobs().catch(() => {})
    activeReaderUrl = nextUrl
    recordHistory(nextUrl)
    emit('app:navigation', { url: nextUrl, privateSession })
  })
  readerView.webContents.on('render-process-gone', () => emit('app:reader-crashed'))
  readerView.webContents.on('dom-ready', () => {
    readerView?.webContents.send('reader:command', {
      type: 'ui-language',
      language: state.settings.uiLanguage,
    })
    readerView?.webContents.send('reader:command', { type: 'scan' })
  })
  const target = url || `file://${path.join(__dirname, 'app', 'sample.html')}`
  if (target.startsWith('file:')) readerView.webContents.loadFile(path.join(__dirname, 'app', 'sample.html'))
  else readerView.webContents.loadURL(target)
}

function commandReader(command) {
  if (command?.type === 'back' && readerView?.webContents.canGoBack()) {
    readerView.webContents.goBack()
    return
  }
  if (readerView && !readerView.webContents.isDestroyed()) readerView.webContents.send('reader:command', command)
}

async function brokerClient() {
  return createBrokerClient({
    endpoint: state.settings.brokerEndpoint || 'https://comic-be.dep.app',
    token: await readToken(),
    deviceId: state.deviceId,
  })
}

function processingLocus() {
  return { local: 'local', managed: 'managed', byo: 'private-server' }[state.settings.route] || 'managed'
}

function readerStatus(payload) { emit('reader:status', payload); commandReader(payload) }

function assertCurrentNavigation(snapshot) {
  // A lazy-loading reader may publish a fresher snapshot while an existing
  // batch is running. Only a true document navigation invalidates that batch.
  if (!activeSnapshot || activeSnapshot.navigationId !== snapshot.navigationId) {
    throw new BrokerClientError('NAVIGATION_CHANGED', 'Trang đã thay đổi; vui lòng chụp snapshot lại.')
  }
}

async function fetchRegisteredAsset(candidate, snapshot, signal) {
  assertCurrentNavigation(snapshot)
  if (!readerView || readerView.webContents.isDestroyed()) throw new BrokerClientError('READER_UNAVAILABLE', 'Reader không còn hoạt động.')
  if (!candidate.sourceUrl.startsWith('http://') && !candidate.sourceUrl.startsWith('https://')) {
    throw new BrokerClientError('SAMPLE_MODE_ONLY', 'Chương mẫu không gửi ảnh đến broker. Hãy mở một URL HTTP(S).')
  }
  const response = await readerView.webContents.session.fetch(candidate.sourceUrl, {
    method: 'GET',
    redirect: 'manual',
    // Electron's session.fetch uses Chromium's strict-origin-when-cross-origin
    // policy. Supplying both a full cross-origin referrer and Referer header
    // makes Chromium reject cross-origin comic CDN requests as
    // ERR_BLOCKED_BY_CLIENT.
    headers: { Referer: safeAssetReferrer(snapshot.pageUrl) },
    signal,
  })
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new BrokerClientError('IMAGE_REDIRECT_DENIED', 'Ảnh chuyển hướng nên không được gửi đến broker.')
  }
  if (!response.ok) throw new BrokerClientError('IMAGE_FETCH_FAILED', `Không thể lấy ảnh đã đăng ký (${response.status}).`)
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (!ALLOWED_TYPES.has(contentType)) throw new BrokerClientError('UNSUPPORTED_ASSET_TYPE', 'Chỉ JPEG, PNG hoặc WebP mới được gửi đến broker.')
  const bytes = await readBounded(response)
  const detected = sniffImageType(bytes)
  if (detected !== contentType) throw new BrokerClientError('ASSET_TYPE_MISMATCH', 'MIME và bytes của ảnh không khớp.')
  return { bytes, contentType, sha256: sha256(bytes), candidateId: candidate.candidateId }
}

function batchPayload(snapshot, candidateIds, clientOcr = {}) {
  const managed = processingLocus() === 'managed'
  const glossary = state.seriesGlossary || { id: 'local-continuity', version: state.glossary.length, hash: '0'.repeat(64) }
  return {
    snapshotId: snapshot.snapshotId,
    candidateIds,
    requestedExecution: {
      locus: processingLocus(),
      profile: state.settings.profile,
      allowedFallbacks: [],
    },
    pipeline: { translationMode: 'client-ocr', ocrVersion: 'native-vision', layoutVersion: 'client-geometry', renderVersion: 'source-overlay-v1', promptVersion: 'zh-comic-vi-v1' },
    clientOcr,
    language: {
      source: state.settings.sourceLanguage || 'auto',
      target: state.settings.targetLanguage.split('-')[0],
    },
    translationStyle: 'natural-dialogue',
    glossarySnapshot: { id: glossary.id, version: glossary.version, hash: glossary.hash },
    privacyPolicyVersion: 'desktop-v1',
    budget: { currency: 'USD', maxMicros: managed ? 500000 : 0 },
  }
}

function nativeOcrExecutable() {
  if (process.platform !== 'darwin') {
    throw new BrokerClientError(
      'LOCAL_OCR_UNAVAILABLE',
      'Bản này chưa đóng gói OCR local cho hệ điều hành hiện tại.',
    )
  }
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'manga-sub-ocr')
    : path.join(__dirname, 'bin', 'manga-sub-ocr')
}

function nativeTranslationExecutable() {
  if (process.platform !== 'darwin') {
    throw new BrokerClientError(
      'LOCAL_TRANSLATION_UNAVAILABLE',
      'On-device translation is not yet packaged for this operating system.',
    )
  }
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'manga-sub-translation')
    : path.join(__dirname, 'bin', 'manga-sub-translation')
}

function isPublisherWatermark(text) {
  const compact = String(text || '').replace(/\s+/g, '').toLowerCase()
  if (!compact) return true
  return /(baozimh|包子漫[画畫]|最新免费漫画|最新免費漫畫|免费漫画|免費漫畫|www\.[a-z0-9-]+\.(?:com|net|org)|https?:\/\/)/i.test(compact)
}

function mergeLocalOcrRegions(value) {
  const pageWidth = Number(value?.page?.width) || 0
  const pageHeight = Number(value?.page?.height) || 0
  const regions = (value?.regions || [])
    .filter((region) => !isPublisherWatermark(region?.source))
    .filter((region) => {
      const y = Number(region?.y)
      const width = Number(region?.width)
      const height = Number(region?.height)
      // Chapter headings are page chrome rather than dialogue. Keeping them
      // out prevents a long translated title from becoming a card across the
      // first panel, while ordinary top-edge speech remains eligible.
      return !(y < pageHeight * 0.07
        && width > pageWidth * 0.25
        && height < pageHeight * 0.05)
    })
    .map((region) => ({
      ...region,
      x: Number(region.x),
      y: Number(region.y),
      width: Number(region.width),
      height: Number(region.height),
      confidence: Number(region.confidence) || 0,
      source: String(region.source || '').trim(),
    }))
    .filter((region) => region.source && [region.x, region.y, region.width, region.height].every(Number.isFinite))
    .sort((left, right) => left.y - right.y || left.x - right.x)

  const merged = []
  for (const region of regions) {
    const regionRight = region.x + region.width
    const regionBottom = region.y + region.height
    const match = [...merged].reverse().find((candidate) => {
      const candidateRight = candidate.x + candidate.width
      const candidateBottom = candidate.y + candidate.height
      const overlap = Math.max(0, Math.min(regionRight, candidateRight) - Math.max(region.x, candidate.x))
      const overlapRatio = overlap / Math.max(1, Math.min(region.width, candidate.width))
      const verticalGap = region.y - candidateBottom
      const centerDelta = Math.abs(
        (region.x + region.width / 2) - (candidate.x + candidate.width / 2),
      )
      return overlapRatio >= 0.38
        && verticalGap >= -Math.min(region.height, candidate.height) * 0.3
        && verticalGap <= Math.max(region.height, candidate.height) * 0.95
        && centerDelta <= Math.max(region.width, candidate.width) * 0.62
    })
    if (!match) {
      merged.push({ ...region })
      continue
    }
    const left = Math.min(match.x, region.x)
    const top = Math.min(match.y, region.y)
    const right = Math.max(match.x + match.width, regionRight)
    const bottom = Math.max(match.y + match.height, regionBottom)
    const firstIsAbove = match.y <= region.y
    match.source = firstIsAbove
      ? `${match.source}\n${region.source}`
      : `${region.source}\n${match.source}`
    match.x = left
    match.y = top
    match.width = right - left
    match.height = bottom - top
    match.confidence = Math.min(match.confidence, region.confidence)
  }
  return {
    page: { width: pageWidth, height: pageHeight },
    regions: merged.slice(0, 200).map((region) => ({
      ...region,
      id: region.id || `vision-${randomUUID()}`,
    })),
  }
}

function recognizeLocalText(asset, language, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(nativeOcrExecutable(), [language], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const output = []
    const errors = []
    let outputBytes = 0
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000)
    const abort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length
      if (outputBytes > 4 * 1024 * 1024) child.kill('SIGKILL')
      else output.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (errors.reduce((sum, value) => sum + value.length, 0) < 16_384) errors.push(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) {
        reject(new BrokerClientError('CANCELLED', 'OCR local đã được hủy.'))
        return
      }
      if (code !== 0) {
        reject(new BrokerClientError(
          'LOCAL_OCR_FAILED',
          Buffer.concat(errors).toString('utf8').trim() || `OCR local dừng với mã ${code}.`,
        ))
        return
      }
      try {
        const value = JSON.parse(Buffer.concat(output).toString('utf8'))
        if (!(value?.page?.width > 0) || !(value?.page?.height > 0) || !Array.isArray(value?.regions)) {
          throw new Error('OCR local trả payload không hợp lệ.')
        }
        resolve(mergeLocalOcrRegions(value))
      } catch (error) {
        reject(new BrokerClientError('LOCAL_OCR_INVALID', error.message))
      }
    })
    child.stdin.end(asset.bytes)
  })
}

function translateLocalTextPages(pages, signal) {
  const input = nativeTranslationInput(pages, {
    sourceLanguage: state.settings.sourceLanguage === 'auto'
      ? 'zh-Hans'
      : state.settings.sourceLanguage,
    targetLanguage: state.settings.targetLanguage,
  })
  if (!input.requests.length) {
    return Promise.resolve(pages.map((page) => ({
      candidateId: page.candidateId,
      page: page.ocr.page,
      overlayRegions: [],
    })))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(nativeTranslationExecutable(), [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const output = []
    const errors = []
    let outputBytes = 0
    let errorBytes = 0
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(value)
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new BrokerClientError(
        'LOCAL_TRANSLATION_TIMEOUT',
        'Apple Translation took too long, so Manga Sub stopped the batch.',
      ))
    }, 90_000)
    const abort = () => {
      child.kill('SIGKILL')
      finish(new BrokerClientError('CANCELLED', 'On-device translation was cancelled.'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length
      if (outputBytes > 4 * 1024 * 1024) child.kill('SIGKILL')
      else output.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      errorBytes += chunk.length
      if (errorBytes <= 16_384) errors.push(chunk)
    })
    child.on('error', (error) => finish(new BrokerClientError(
      'LOCAL_TRANSLATION_UNAVAILABLE',
      error.message,
    )))
    child.on('close', (code) => {
      if (settled) return
      if (code !== 0) {
        const message = Buffer.concat(errors).toString('utf8').trim()
        const errorCode = /not installed|language pack/i.test(message)
          ? 'LOCAL_LANGUAGE_PACK_REQUIRED'
          : 'LOCAL_TRANSLATION_FAILED'
        finish(new BrokerClientError(
          errorCode,
          message || `Apple Translation stopped with code ${code}.`,
        ))
        return
      }
      try {
        const value = JSON.parse(Buffer.concat(output).toString('utf8'))
        finish(null, attachNativeTranslations(pages, value))
      } catch (error) {
        finish(error instanceof BrokerClientError
          ? error
          : new BrokerClientError('LOCAL_TRANSLATION_INVALID', error.message))
      }
    })
    child.stdin.end(JSON.stringify(input))
  })
}

function seriesBootstrapPayload(snapshot, observedRegions = []) {
  const title = String(snapshot.title || 'Untitled series').trim().slice(0, 512) || 'Untitled series'
  const seriesId = `series:${sha256(`${snapshot.topFrameOrigin || ''}\n${title}`).slice(0, 48)}`
  const researchConsent = state.glossaryConsent === 'allowed' && !privateSession
    ? {
        seriesId,
        policyVersion: 'series-research-v1',
        state: 'granted',
        allowedSourceClasses: ['wikidata', 'mediawiki', 'anilist'],
        grantedAt: new Date().toISOString(),
      }
    : null
  return {
    seriesId,
    title,
    seriesStatus: 'confirmed',
    chapterBoundary: null,
    targetLanguage: state.settings.targetLanguage,
    privateMode: privateSession,
    localContinuity: observedRegions
      .filter((region) => region?.source && region?.translation)
      .slice(0, 500)
      .map((region) => ({
        sourceTerm: String(region.source).slice(0, 512),
        targetTerm: String(region.translation).slice(0, 512),
        confidence: Number.isFinite(region.confidence) ? region.confidence : 0.8,
      })),
    userCorrections: [],
    locallyObservedAliases: [
      title,
      ...observedRegions.map((region) => String(region?.source || '').slice(0, 512)),
    ].filter(Boolean).slice(0, 1_000),
    researchConsent,
  }
}

async function bootstrapSeriesGlossary(client, snapshot, signal) {
  if (privateSession || state.glossaryConsent !== 'allowed') return
  const input = seriesBootstrapPayload(snapshot)
  const initial = await client.bootstrapSeries(input, signal)
  const latest = await client.getSeriesGlossary(input.seriesId, signal)
  const record = latest?.glossarySnapshot ? latest : initial
  if (!record?.glossarySnapshot) return
  state.seriesGlossary = record.glossarySnapshot
  saveState()
}

async function recordSeriesContinuity(client, snapshot, result, signal) {
  if (privateSession || state.glossaryConsent !== 'allowed') return
  const input = seriesBootstrapPayload(snapshot, result.overlayRegions || [])
  const updated = await client.bootstrapSeries(input, signal)
  if (updated?.glossarySnapshot) {
    state.seriesGlossary = updated.glossarySnapshot
    saveState()
  }
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function pollJob(client, jobId, candidateId, controller) {
  let after = 0
  while (!controller.signal.aborted) {
    const eventBatch = await client.getEvents(jobId, after, controller.signal)
    for (const event of eventBatch.events || []) {
      after = Math.max(after, event.sequence || 0)
      readerStatus({ type: 'broker-progress', jobId, candidateId, state: event.state, code: event.code })
    }
    const job = await client.getJob(jobId, controller.signal)
    if (job.state === 'SETTLED') return client.getResult(jobId, controller.signal)
    if (['CANCELLED', 'FAILED', 'EXPIRED', 'REJECTED'].includes(job.state)) throw new BrokerClientError(job.error?.code || `JOB_${job.state}`, job.error?.message || `Broker job ${job.state}.`)
    await wait(550)
  }
  throw new BrokerClientError('CANCELLED', 'Job đã được hủy.')
}

async function runBrokerJob(client, snapshot, job, candidate, controller) {
  try {
    readerStatus({ type: 'broker-progress', jobId: job.jobId, candidateId: candidate.candidateId, state: 'TRANSLATING' })
    const result = await pollJob(client, job.jobId, candidate.candidateId, controller)
    const receipt = result.modelReceipt || {}
    if (!receipt.modelMatched) {
      throw new BrokerClientError('MODEL_MISMATCH', 'Broker không xác minh được model đã resolve. Queue đã dừng.')
    }
    assertCurrentNavigation(snapshot)
    await recordSeriesContinuity(client, snapshot, result, controller.signal).catch(() => {})
    rememberTranslation(snapshot, candidate.candidateId, result, receipt, 'managed')
    readerStatus({ type: 'attach-result', jobId: job.jobId, candidateId: candidate.candidateId, result, receipt })
    emit('app:broker-receipt', { ...receipt, jobId: job.jobId, route: processingLocus() })
  } catch (error) {
    readerStatus({ type: 'broker-failure', jobId: job.jobId, candidateId: candidate.candidateId, code: error.code || 'BROKER_FAILURE', message: error.message })
    if (error.code === 'MODEL_MISMATCH') await cancelActiveJobs()
  } finally { activeJobs.delete(job.jobId) }
}

async function runBrokerBatch(snapshot, selectedIds) {
  if (snapshot.isTestMode) throw new BrokerClientError('SAMPLE_MODE_ONLY', 'Chương mẫu chỉ để kiểm tra UI; hãy mở URL HTTP(S) để dịch qua broker.')
  const client = await brokerClient()
  // This is best-effort metadata enrichment. Series intelligence is never a
  // prerequisite for translating a page, and is deliberately skipped in a
  // private session.
  void bootstrapSeriesGlossary(client, snapshot).catch(() => {})
  await client.registerSnapshot(snapshot)
  const candidateMap = new Map(snapshot.candidates.map((candidate) => [candidate.candidateId, candidate]))
  for (let offset = 0; offset < selectedIds.length; offset += 50) {
    assertCurrentNavigation(snapshot)
    const group = selectedIds.slice(offset, offset + 50)
    const controller = new AbortController()
    const clientOcr = {}
    let cursor = 0
    const recognizeWorker = async () => {
      while (cursor < group.length && !controller.signal.aborted) {
        const candidateId = group[cursor++]
        const candidate = candidateMap.get(candidateId)
        readerStatus({ type: 'broker-progress', candidateId, state: 'OCR' })
        const asset = await fetchRegisteredAsset(candidate, snapshot, controller.signal)
        clientOcr[candidateId] = await recognizeLocalText(
          asset,
          state.settings.sourceLanguage || 'auto',
          controller.signal,
        )
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, group.length) }, recognizeWorker))
    const batch = await client.createBatch(batchPayload(snapshot, group, clientOcr))
    for (const job of batch.jobs) activeJobs.set(job.jobId, { controller, client })
    cursor = 0
    const worker = async () => {
      while (cursor < batch.jobs.length && !controller.signal.aborted) {
        const job = batch.jobs[cursor++]
        await runBrokerJob(client, snapshot, job, candidateMap.get(job.candidateId), controller)
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, batch.jobs.length) }, worker))
  }
}

function targetLanguageName(value) {
  return {
    'vi-VN': 'Vietnamese',
    'en-US': 'English',
    'fr-FR': 'French',
    'es-ES': 'Spanish',
    'de-DE': 'German',
    'pt-BR': 'Portuguese',
    'id-ID': 'Indonesian',
    'ja-JP': 'Japanese',
    'ko-KR': 'Korean',
    'zh-CN': 'Simplified Chinese',
    'zh-TW': 'Traditional Chinese',
  }[value] || value
}

function byoTranslationGroups(pages) {
  const groups = []
  let current = []
  let regionCount = 0
  let sourceCharacters = 0
  for (const page of pages) {
    const regions = page.ocr?.regions || []
    const pageCharacters = regions.reduce(
      (total, region) => total + String(region?.source || '').length,
      0,
    )
    if (current.length && (
      current.length >= 3
      || regionCount + regions.length > 180
      || sourceCharacters + pageCharacters > 20_000
    )) {
      groups.push(current)
      current = []
      regionCount = 0
      sourceCharacters = 0
    }
    current.push(page)
    regionCount += regions.length
    sourceCharacters += pageCharacters
  }
  if (current.length) groups.push(current)
  return groups
}

async function runLocalBatch(snapshot, selectedIds) {
  if (snapshot.isTestMode) {
    throw new BrokerClientError(
      'SAMPLE_MODE_ONLY',
      'The sample chapter only tests the UI. Open an HTTP(S) comic page to translate it.',
    )
  }
  const candidateMap = new Map(snapshot.candidates.map((candidate) => [candidate.candidateId, candidate]))
  for (let offset = 0; offset < selectedIds.length; offset += 50) {
    assertCurrentNavigation(snapshot)
    const group = selectedIds.slice(offset, offset + 50)
    const controller = new AbortController()
    const operationId = `local:${randomUUID()}`
    activeJobs.set(operationId, { controller })
    try {
      const pages = new Array(group.length)
      let cursor = 0
      const recognizeWorker = async () => {
        while (cursor < group.length && !controller.signal.aborted) {
          const index = cursor++
          const candidateId = group[index]
          const candidate = candidateMap.get(candidateId)
          readerStatus({ type: 'broker-progress', candidateId, state: 'OCR' })
          const asset = await fetchRegisteredAsset(candidate, snapshot, controller.signal)
          pages[index] = {
            candidateId,
            ocr: await recognizeLocalText(
              asset,
              state.settings.sourceLanguage || 'auto',
              controller.signal,
            ),
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(2, group.length) }, recognizeWorker))
      assertCurrentNavigation(snapshot)
      readerStatus({ type: 'broker-progress', jobId: operationId, state: 'TRANSLATING_LOCAL' })
      const results = await translateLocalTextPages(pages, controller.signal)
      assertCurrentNavigation(snapshot)
      for (const result of results) {
        const jobId = `${operationId}:${result.candidateId}`
        const receipt = {
          requestedProvider: 'apple-translation',
          requestedModel: 'on-device',
          resolvedProvider: 'apple-translation',
          resolvedModel: 'on-device',
          providerReportedModel: 'on-device',
          modelMatched: true,
          tokenCounts: { input: 0, output: 0 },
          estimatedCostMicros: 0,
          completedAt: new Date().toISOString(),
        }
        rememberTranslation(snapshot, result.candidateId, result, receipt, 'local')
        readerStatus({
          type: 'attach-result',
          jobId,
          candidateId: result.candidateId,
          result,
          receipt,
        })
        emit('app:broker-receipt', {
          ...receipt,
          jobId,
          route: 'local',
        })
      }
    } finally {
      activeJobs.delete(operationId)
    }
  }
}

async function runByoBatch(snapshot, selectedIds) {
  if (snapshot.isTestMode) {
    throw new BrokerClientError('SAMPLE_MODE_ONLY', 'Chương mẫu chỉ để kiểm tra UI; hãy mở URL HTTP(S) để dịch.')
  }
  const config = normalizeProviderConfig({
    provider: state.settings.byoProvider,
    baseUrl: state.settings.byoBaseUrl,
    model: state.settings.byoModel,
  })
  const key = await readProviderKey(config.provider)
  if (!key && !isLoopbackCompatible(config)) {
    throw new BrokerClientError('BYO_KEY_REQUIRED', 'Hãy lưu API key của provider trước khi dịch.')
  }
  if (!config.model) throw new BrokerClientError('BYO_MODEL_REQUIRED', 'Hãy refresh và chọn model trước khi dịch.')
  const candidateMap = new Map(snapshot.candidates.map((candidate) => [candidate.candidateId, candidate]))
  for (let offset = 0; offset < selectedIds.length; offset += 50) {
    assertCurrentNavigation(snapshot)
    const group = selectedIds.slice(offset, offset + 50)
    const controller = new AbortController()
    const operationId = `byo:${randomUUID()}`
    activeJobs.set(operationId, { controller })
    try {
      const clientOcr = {}
      let cursor = 0
      const recognizeWorker = async () => {
        while (cursor < group.length && !controller.signal.aborted) {
          const candidateId = group[cursor++]
          const candidate = candidateMap.get(candidateId)
          readerStatus({ type: 'broker-progress', candidateId, state: 'OCR' })
          const asset = await fetchRegisteredAsset(candidate, snapshot, controller.signal)
          clientOcr[candidateId] = await recognizeLocalText(
            asset,
            state.settings.sourceLanguage || 'auto',
            controller.signal,
          )
        }
      }
      await Promise.all(Array.from({ length: Math.min(2, group.length) }, recognizeWorker))
      assertCurrentNavigation(snapshot)
      const pages = group.map((candidateId) => ({
        candidateId,
        ocr: clientOcr[candidateId],
      }))
      // Adaptive micro-batches avoid both one provider round-trip per page and
      // one enormous response for an entire long-scroll chapter. Up to three
      // bounded groups run in parallel and render as soon as each group lands.
      const translationGroups = byoTranslationGroups(pages)
      cursor = 0
      const translateWorker = async () => {
        while (cursor < translationGroups.length && !controller.signal.aborted) {
          const pageGroup = translationGroups[cursor++]
          readerStatus({
            type: 'broker-progress',
            jobId: operationId,
            candidateId: pageGroup[0]?.candidateId,
            state: 'TRANSLATING',
          })
          const results = await translateOcrPages(config, key, pageGroup, {
            targetLanguage: targetLanguageName(state.settings.targetLanguage),
            glossary: state.glossary,
            signal: controller.signal,
          })
          assertCurrentNavigation(snapshot)
          for (const result of results) {
            const jobId = `${operationId}:${result.candidateId}`
            const receipt = {
              requestedProvider: config.provider,
              requestedModel: config.model,
              resolvedProvider: config.provider,
              resolvedModel: config.model,
              providerReportedModel: config.model,
              modelMatched: true,
              tokenCounts: { input: 0, output: 0 },
              estimatedCostMicros: 0,
              completedAt: new Date().toISOString(),
            }
            rememberTranslation(snapshot, result.candidateId, result, receipt, 'byo')
            readerStatus({
              type: 'attach-result',
              jobId,
              candidateId: result.candidateId,
              result,
              receipt,
            })
            emit('app:broker-receipt', {
              ...receipt,
              jobId,
              route: 'byo',
            })
          }
        }
      }
      await Promise.all(Array.from({
        length: Math.min(3, translationGroups.length),
      }, translateWorker))
    } finally {
      activeJobs.delete(operationId)
    }
  }
}

async function cancelActiveJobs() {
  const work = [...activeJobs.entries()]
  for (const [jobId, entry] of work) {
    entry.controller.abort()
    entry.client?.cancel?.(jobId).catch(() => {})
  }
  activeJobs.clear()
  readerStatus({ type: 'broker-cancelled' })
}

function createWindow() {
  const icon = installApplicationIcon()
  windowRef = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 620,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#111316',
    ...(process.platform === 'darwin' || !icon ? {} : { icon }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  windowRef.loadFile(path.join(__dirname, 'app', 'index.html'))
  windowRef.on('closed', () => { destroyReader(); windowRef = null })
  createReader()
}

ipcMain.handle('app:get-state', () => publicState())
ipcMain.handle('app:navigate', (_event, rawUrl) => {
  const url = safeUrl(rawUrl)
  activeReaderUrl = url
  if (!readerView) createReader({ url })
  else readerView.webContents.loadURL(url)
  return { url }
})
ipcMain.handle('app:set-reader-bounds', (_event, bounds) => {
  for (const key of ['x', 'y', 'width', 'height']) if (Number.isFinite(bounds?.[key])) readerBounds[key] = Math.round(bounds[key])
  applyReaderBounds()
})
ipcMain.handle('app:set-reader-visible', (_event, visible) => { readerVisible = Boolean(visible); applyReaderBounds() })
ipcMain.handle('app:reader-command', (_event, command) => commandReader(command))
ipcMain.handle('app:open-sample', () => {
  activeReaderUrl = null
  readerView.webContents.loadFile(path.join(__dirname, 'app', 'sample.html'))
  return true
})
ipcMain.handle('app:save-settings', async (_event, patch) => {
  const allowedRoutes = new Set(['ask', 'local', 'managed', 'byo'])
  const previousProvider = state.settings.byoProvider
  const next = { ...state.settings, ...patch }
  if (!['en', 'vi'].includes(next.uiLanguage)) next.uiLanguage = 'en'
  if (!['auto', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'en'].includes(next.sourceLanguage)) {
    next.sourceLanguage = 'auto'
  }
  if (!['vi-VN', 'en-US', 'fr-FR', 'es-ES', 'de-DE', 'pt-BR', 'id-ID', 'ja-JP', 'ko-KR', 'zh-CN', 'zh-TW'].includes(next.targetLanguage)) {
    next.targetLanguage = 'vi-VN'
  }
  if (!allowedRoutes.has(next.route)) next.route = 'ask'
  if (!['fast', 'balanced', 'quality'].includes(next.profile)) next.profile = 'balanced'
  if (![0, 5, 10].includes(Number(next.translationCacheLimit))) next.translationCacheLimit = 10
  else next.translationCacheLimit = Number(next.translationCacheLimit)
  next.byoProvider = providerCredentialId(next.byoProvider || 'gemini')
  next.byoModel = String(next.byoModel || '').trim().slice(0, 256)
  if (next.byoProvider === 'openai-compatible') {
    next.byoBaseUrl = normalizeProviderConfig({
      provider: next.byoProvider,
      baseUrl: next.byoBaseUrl,
    }).baseUrl
  }
  if (typeof next.brokerEndpoint === 'string') next.brokerEndpoint = normalizeEndpoint(next.brokerEndpoint || 'https://comic-be.dep.app')
  if (typeof next.serverUrl === 'string' && next.serverUrl.trim()) next.serverUrl = safeUrl(next.serverUrl)
  state.settings = next
  state.translationCache = pruneTranslationCache(state.translationCache, next.translationCacheLimit)
  saveState()
  if (Object.hasOwn(patch || {}, 'uiLanguage')) {
    commandReader({ type: 'ui-language', language: next.uiLanguage })
  }
  if (next.byoProvider !== previousProvider) {
    await refreshProviderKeyStatus(next.byoProvider)
  }
  emit('app:settings', publicState().settings)
  return publicState().settings
})
ipcMain.handle('app:set-token', async (_event, token) => ({ tokenConfigured: await writeToken(token) }))
ipcMain.handle('app:set-provider-key', async (_event, provider, key) => ({
  provider: providerCredentialId(provider),
  keyConfigured: await writeProviderKey(provider, key),
}))
ipcMain.handle('app:list-provider-models', async (_event, configValue) => {
  const config = normalizeProviderConfig(configValue)
  const key = await readProviderKey(config.provider)
  if (!key && !isLoopbackCompatible(config)) {
    throw new BrokerClientError('BYO_KEY_REQUIRED', 'Hãy lưu API key trước khi refresh model.')
  }
  const models = await listProviderModels(config, key)
  return {
    models,
    recommended: recommendModel(models, config.provider, state.settings.profile),
    fetchedAt: new Date().toISOString(),
  }
})
ipcMain.handle('app:set-private', (_event, enabled) => {
  privateSession = Boolean(enabled)
  createReader({ url: activeReaderUrl, isPrivate: privateSession })
  emit('app:private', { privateSession })
  return publicState()
})
ipcMain.handle('app:history-clear', (_event, id) => {
  state.history = id ? state.history.filter((entry) => entry.id !== id) : []
  saveState(); emit('app:history', state.history); return state.history
})
ipcMain.handle('app:resume', (_event, item) => {
  if (!item?.url) return false
  activeReaderUrl = item.url
  readerVisible = true
  applyReaderBounds()
  readerView.webContents.loadURL(item.url)
  readerView.webContents.once('dom-ready', () => setTimeout(() => commandReader({ type: 'resume', candidateIndex: item.candidateIndex || 0 }), 350))
  return true
})
ipcMain.handle('app:glossary-consent', (_event, value) => { state.glossaryConsent = value; saveState(); return value })
ipcMain.handle('app:add-term', (_event, term) => {
  const clean = String(term || '').trim().slice(0, 160)
  if (!clean) return state.glossary
  state.glossary = [...state.glossary, { id: `t_${Date.now()}`, value: clean, source: 'user' }]
  saveState(); return state.glossary
})
ipcMain.handle('app:copy-diagnostic', (_event, receipt) => { clipboard.writeText(`Manga Sub diagnostic: ${receipt?.id || 'unknown'}`); return true })
ipcMain.handle('app:model-choice', (_event, choice) => {
  if (choice === 'recommended') { state.settings.model = 'gemini-3.6-flash'; state.settings.modelProvenance = 'auto-recommended' }
  if (choice === 'keep') state.settings.modelProvenance = 'user-pinned'
  state.needsModelChoice = false; saveState(); return publicState()
})

ipcMain.on('reader:status', (event, payload) => {
  if (!readerView || event.sender.id !== readerView.webContents.id) return
  emit('reader:status', payload)
  if (payload?.type === 'snapshot') {
    activeSnapshot = payload.snapshot || null
    restoreCachedTranslations(activeSnapshot)
  }
  if (payload?.type === 'translate-request') {
    if (state.settings.route === 'ask') {
      emit('reader:status', {
        type: 'route-required',
        command: payload.scope === 'all' ? 'translate-all-now' : 'translate-current',
      })
      return
    }
    const snapshot = activeSnapshot
    if (!snapshot) {
      readerStatus({ type: 'broker-failure', code: 'SNAPSHOT_MISSING', message: 'Không có snapshot hợp lệ. Hãy quét lại trang.' })
      return
    }
    const run = {
      local: runLocalBatch,
      managed: runBrokerBatch,
      byo: runByoBatch,
    }[state.settings.route]
    if (!run) {
      readerStatus({
        type: 'broker-failure',
        code: 'ROUTE_UNAVAILABLE',
        message: 'This translation route is not available in this build. Choose On this Mac, Manga Sub Cloud, or Your API key.',
      })
      return
    }
    run(snapshot, payload.candidateIds || []).catch((error) => {
      readerStatus({ type: 'broker-failure', code: error.code || 'BROKER_FAILURE', message: error.message })
    })
  }
  if (payload?.type === 'translate-cancel') cancelActiveJobs()
  if (payload?.type === 'progress-anchor' && activeReaderUrl) scheduleHistory(activeReaderUrl, payload)
  if (payload?.type === 'job-complete' && activeReaderUrl) recordHistory(activeReaderUrl, { ...payload, translated: true })
})

app.whenReady().then(() => {
  createWindow()
  void refreshTokenStatus().then(() => emit('app:settings', publicState().settings))
  void refreshProviderKeyStatus(state.settings.byoProvider || 'gemini')
    .then(() => emit('app:settings', publicState().settings))
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

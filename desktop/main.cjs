'use strict'

const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, safeStorage, clipboard, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { DEFAULT_SETTINGS, migrateSettings, safeAssetReferrer, safeUrl } = require('./lib/domain.cjs')
const { ALLOWED_TYPES, BrokerClientError, createBrokerClient, normalizeEndpoint, readBounded, sha256, sniffImageType } = require('./lib/broker-client.cjs')

function prepareUserDataPath() {
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
let activeJobs = new Map()
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
      glossaryConsent: saved.glossaryConsent || null,
      glossary: Array.isArray(saved.glossary) ? saved.glossary : [],
      seriesGlossary: saved.seriesGlossary || null,
      needsModelChoice: migrated.needsModelChoice,
      deviceId: saved.deviceId || `desktop:${randomUUID()}`,
    }
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, history: [], glossaryConsent: null, glossary: [], seriesGlossary: null, needsModelChoice: false, deviceId: `desktop:${randomUUID()}` }
  }
}

let state = loadState()

function saveState() {
  const safe = { ...state, settings: { ...state.settings, tokenConfigured: undefined } }
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(dataPath('reader-state.json'), JSON.stringify(safe, null, 2), { mode: 0o600 })
}

function tokenStatus() {
  try { return fs.existsSync(dataPath('provider-token.bin')) } catch { return false }
}

function readToken() {
  try {
    const value = fs.readFileSync(dataPath('provider-token.bin'))
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(value) : value.toString('utf8')
  } catch { return '' }
}

function writeToken(token) {
  const value = String(token || '').trim()
  if (!value) {
    fs.rmSync(dataPath('provider-token.bin'), { force: true })
    return false
  }
  if (value.length > 4096 || /[\r\n]/.test(value)) throw new Error('Token không hợp lệ.')
  const encoded = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(value)
    : Buffer.from(value, 'utf8')
  fs.writeFileSync(dataPath('provider-token.bin'), encoded, { mode: 0o600 })
  return true
}

function publicState() {
  return {
    settings: { ...state.settings, tokenConfigured: tokenStatus() },
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
  readerView.webContents.on('dom-ready', () => readerView?.webContents.send('reader:command', { type: 'scan' }))
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

function brokerClient() {
  return createBrokerClient({
    endpoint: state.settings.brokerEndpoint || 'https://comic-be.dep.app',
    token: readToken(),
    deviceId: state.deviceId,
  })
}

function processingLocus() {
  return { local: 'local', paired: 'paired', managed: 'managed', byo: 'private-server' }[state.settings.route] || 'managed'
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

function batchPayload(snapshot, candidateIds) {
  const managed = processingLocus() === 'managed'
  const glossary = state.seriesGlossary || { id: 'local-continuity', version: state.glossary.length, hash: '0'.repeat(64) }
  return {
    snapshotId: snapshot.snapshotId,
    candidateIds,
    requestedExecution: {
      locus: processingLocus(),
      profile: state.settings.profile,
      provider: 'gemini',
      model: state.settings.model || 'gemini-3.6-flash',
      credentialRef: state.settings.route === 'byo' ? 'desktop:byo' : undefined,
      allowedFallbacks: [],
    },
    pipeline: { translationMode: 'server', ocrVersion: 'paddle-ocr-vl-1.6', layoutVersion: 'comic-text-bubble-detector', renderVersion: 'source-overlay-v1', promptVersion: 'zh-comic-vi-v1' },
    language: { source: 'zh-Hans', target: state.settings.targetLanguage.startsWith('vi') ? 'vi' : state.settings.targetLanguage.split('-')[0] },
    translationStyle: 'natural-dialogue',
    glossarySnapshot: { id: glossary.id, version: glossary.version, hash: glossary.hash },
    privacyPolicyVersion: 'desktop-v1',
    budget: { currency: 'USD', maxMicros: managed ? 500000 : 0 },
  }
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
    readerStatus({ type: 'broker-progress', jobId: job.jobId, candidateId: candidate.candidateId, state: 'ACQUIRING' })
    const asset = await fetchRegisteredAsset(candidate, snapshot, controller.signal)
    assertCurrentNavigation(snapshot)
    await client.uploadAsset(job.jobId, asset, controller.signal)
    const result = await pollJob(client, job.jobId, candidate.candidateId, controller)
    const receipt = result.modelReceipt || {}
    if (!receipt.modelMatched || receipt.resolvedModel !== (state.settings.model || 'gemini-3.6-flash')) {
      throw new BrokerClientError('MODEL_MISMATCH', 'Broker không trả về đúng model bạn đã chọn. Queue đã dừng.')
    }
    assertCurrentNavigation(snapshot)
    await recordSeriesContinuity(client, snapshot, result, controller.signal).catch(() => {})
    readerStatus({ type: 'attach-result', jobId: job.jobId, candidateId: candidate.candidateId, result, receipt })
    emit('app:broker-receipt', { ...receipt, jobId: job.jobId, route: processingLocus() })
  } catch (error) {
    readerStatus({ type: 'broker-failure', jobId: job.jobId, candidateId: candidate.candidateId, code: error.code || 'BROKER_FAILURE', message: error.message })
    if (error.code === 'MODEL_MISMATCH') await cancelActiveJobs()
  } finally { activeJobs.delete(job.jobId) }
}

async function runBrokerBatch(snapshot, selectedIds) {
  if (snapshot.isTestMode) throw new BrokerClientError('SAMPLE_MODE_ONLY', 'Chương mẫu chỉ để kiểm tra UI; hãy mở URL HTTP(S) để dịch qua broker.')
  const client = brokerClient()
  // This is best-effort metadata enrichment. Series intelligence is never a
  // prerequisite for translating a page, and is deliberately skipped in a
  // private session.
  await bootstrapSeriesGlossary(client, snapshot).catch(() => {})
  await client.registerSnapshot(snapshot)
  const candidateMap = new Map(snapshot.candidates.map((candidate) => [candidate.candidateId, candidate]))
  for (let offset = 0; offset < selectedIds.length; offset += 50) {
    assertCurrentNavigation(snapshot)
    const group = selectedIds.slice(offset, offset + 50)
    const batch = await client.createBatch(batchPayload(snapshot, group))
    const controller = new AbortController()
    for (const job of batch.jobs) activeJobs.set(job.jobId, { controller, client })
    let cursor = 0
    const worker = async () => {
      while (cursor < batch.jobs.length && !controller.signal.aborted) {
        const job = batch.jobs[cursor++]
        await runBrokerJob(client, snapshot, job, candidateMap.get(job.candidateId), controller)
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, batch.jobs.length) }, worker))
  }
}

async function cancelActiveJobs() {
  const work = [...activeJobs.entries()]
  for (const [jobId, entry] of work) {
    entry.controller.abort()
    entry.client.cancel(jobId).catch(() => {})
  }
  activeJobs.clear()
  readerStatus({ type: 'broker-cancelled' })
}

function createWindow() {
  const icon = installApplicationIcon()
  windowRef = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
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
ipcMain.handle('app:save-settings', (_event, patch) => {
  const allowedRoutes = new Set(['ask', 'local', 'paired', 'managed', 'byo'])
  const next = { ...state.settings, ...patch }
  if (!allowedRoutes.has(next.route)) next.route = 'ask'
  if (!['fast', 'balanced', 'quality'].includes(next.profile)) next.profile = 'balanced'
  if (typeof next.brokerEndpoint === 'string') next.brokerEndpoint = normalizeEndpoint(next.brokerEndpoint || 'https://comic-be.dep.app')
  if (typeof next.serverUrl === 'string' && next.serverUrl.trim()) next.serverUrl = safeUrl(next.serverUrl)
  state.settings = next
  saveState()
  emit('app:settings', publicState().settings)
  return publicState().settings
})
ipcMain.handle('app:set-token', (_event, token) => ({ tokenConfigured: writeToken(token) }))
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
  if (payload?.type === 'snapshot') activeSnapshot = payload.snapshot || null
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
    runBrokerBatch(snapshot, payload.candidateIds || []).catch((error) => {
      readerStatus({ type: 'broker-failure', code: error.code || 'BROKER_FAILURE', message: error.message })
    })
  }
  if (payload?.type === 'translate-cancel') cancelActiveJobs()
  if (payload?.type === 'progress-anchor' && activeReaderUrl) scheduleHistory(activeReaderUrl, payload)
  if (payload?.type === 'job-complete' && activeReaderUrl) recordHistory(activeReaderUrl, { ...payload, translated: true })
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

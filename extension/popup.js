const SETTINGS_KEY = 'bongBongSettings'
const LOCAL_API_ENDPOINT = 'http://127.0.0.1:4000/api/v1'
const REMOTE_API_ENDPOINT = 'https://comic-be.dep.app/api/v1'
const DEFAULT_API_ENDPOINT =
  globalThis.location?.protocol === 'safari-web-extension:'
    ? REMOTE_API_ENDPOINT
    : LOCAL_API_ENDPOINT
const YAOSHENJI_GLOSSARY = [
  '聂离 = Nhiếp Ly',
  '聂宗主 = Nhiếp tông chủ',
  '凤羽 = Phượng Vũ',
  '凤羽长老 = Phượng Vũ trưởng lão',
  '妖神宗 = Yêu Thần Tông',
  '无相神宗 = Vô Tướng Thần Tông',
].join('\n')

const DEFAULT_SETTINGS = Object.freeze({
  endpoint: DEFAULT_API_ENDPOINT,
  targetLanguage: 'vi-VN',
  provider: 'gemini',
  model: 'gemini-3.6-flash',
  pipeline: 'quality',
  lookAhead: 2,
  autoTranslate: true,
  glossary: YAOSHENJI_GLOSSARY,
  authKey: '',
})

const MODEL_PRESETS = Object.freeze({
  gemini: [
    {
      value: 'gemini-3.6-flash',
      label: 'Gemini 3.6 Flash · paid, cân bằng',
      note: 'Model paid cân bằng chất lượng và chi phí; Koharu chấp nhận model ID này dù catalog 0.61.2 chưa liệt kê.',
    },
    {
      value: 'gemini-3.5-flash',
      label: 'Gemini 3.5 Flash',
      note: 'Model cũ hơn và đắt hơn 3.6 Flash theo cấu hình tài khoản hiện tại.',
    },
    {
      value: 'gemini-3.1-flash-lite',
      label: 'Gemini 3.1 Flash Lite · nhanh/rẻ',
      note: 'Mặc định cho dịch hội thoại đã OCR: latency thấp, chi phí thấp.',
    },
    {
      value: 'gemini-flash-lite-latest',
      label: 'Gemini Flash Lite latest · tiết kiệm',
      note: 'Alias tiết kiệm do Koharu cung cấp; model đích có thể thay đổi theo thời gian.',
    },
    {
      value: 'gemini-3.1-pro-preview',
      label: 'Gemini 3.1 Pro Preview',
      note: 'Preset chất lượng cao để đối chiếu.',
    },
  ],
  openai: [
    {
      value: 'gpt-5.5',
      label: 'GPT-5.5',
      note: 'Preset để đối chiếu; chi phí và độ trễ phụ thuộc Koharu.',
    },
  ],
  claude: [
    {
      value: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      note: 'Preset để đối chiếu; chi phí và độ trễ phụ thuộc Koharu.',
    },
  ],
  deepseek: [
    {
      value: 'deepseek-v4-flash',
      label: 'DeepSeek V4 Flash · giá thấp',
      note: 'Đề xuất cho dịch text OCR: nhanh, rẻ và không cần reasoning dài.',
    },
    {
      value: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro · chất lượng',
      note: 'Dùng để đối chiếu chất lượng khi V4 Flash chưa đủ tốt.',
    },
    {
      value: 'deepseek-chat',
      label: 'DeepSeek Chat · alias tương thích',
      note: 'Alias tương thích của DeepSeek; phiên bản model phía sau có thể thay đổi.',
    },
    {
      value: 'deepseek-reasoner',
      label: 'DeepSeek Reasoner',
      note: 'Thường chậm và tốn hơn mức cần thiết cho dịch hội thoại đã OCR.',
    },
  ],
})

const PROVIDER_METADATA = Object.freeze({
  gemini: { label: 'Google Gemini · có free tier', order: 0 },
  deepseek: { label: 'DeepSeek · giá thấp', order: 1 },
  openai: { label: 'OpenAI', order: 2 },
  claude: { label: 'Anthropic Claude', order: 3 },
})

const elements = {
  authKey: document.querySelector('#auth-key'),
  autoTranslate: document.querySelector('#auto-translate'),
  candidateCount: document.querySelector('#candidate-count'),
  clearCacheButton: document.querySelector('#clear-cache-button'),
  customModel: document.querySelector('#custom-model'),
  customModelField: document.querySelector('#custom-model-field'),
  endpoint: document.querySelector('#endpoint'),
  endpointError: document.querySelector('#endpoint-error'),
  failureCount: document.querySelector('#failure-count'),
  glossary: document.querySelector('#glossary'),
  healthDot: document.querySelector('#health-dot'),
  healthState: document.querySelector('#health-state'),
  lookAhead: document.querySelector('#look-ahead'),
  model: document.querySelector('#model'),
  modelNote: document.querySelector('#model-note'),
  pageStatus: document.querySelector('#page-status'),
  pauseButton: document.querySelector('#pause-button'),
  permissionButton: document.querySelector('#permission-button'),
  permissionDetail: document.querySelector('#permission-detail'),
  permissionPanel: document.querySelector('#permission-panel'),
  permissionStatus: document.querySelector('#permission-status'),
  permissionTitle: document.querySelector('#permission-title'),
  pipeline: document.querySelector('#pipeline'),
  progressBar: document.querySelector('#progress-bar'),
  progressCount: document.querySelector('#progress-count'),
  progressSection: document.querySelector('#progress-section'),
  progressStatus: document.querySelector('#progress-status'),
  provider: document.querySelector('#provider'),
  refreshButton: document.querySelector('#refresh-button'),
  retryButton: document.querySelector('#retry-button'),
  revealButton: document.querySelector('#reveal-button'),
  saveState: document.querySelector('#save-state'),
  scanButton: document.querySelector('#scan-button'),
  targetLanguage: document.querySelector('#target-language'),
  toast: document.querySelector('#toast'),
  translateAllButton: document.querySelector('#translate-all-button'),
  translateVisibleButton: document.querySelector('#translate-visible-button'),
}

let activeTabId = null
let currentOrigins = []
let pendingPermissionPatterns = []
let saveTimer = null
let toastTimer = null
let clearCacheArmed = false
let providerCatalog = new Map()

function setBusy(button, busy, busyLabel) {
  if (busy) {
    button.dataset.label = button.textContent
    button.textContent = busyLabel
    button.disabled = true
    return
  }

  if (button.dataset.label) {
    button.textContent = button.dataset.label
    delete button.dataset.label
  }
  button.disabled = false
}

function showToast(message) {
  window.clearTimeout(toastTimer)
  elements.toast.textContent = message
  elements.toast.hidden = false
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true
  }, 3200)
}

function errorMessage(error, fallback) {
  if (typeof error?.message === 'string' && error.message) {
    return error.message
  }
  if (typeof error?.error?.message === 'string' && error.error.message) {
    return error.error.message
  }
  return fallback
}

function normalizeEndpoint(value) {
  const url = new URL(value.trim())
  const loopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1'
  const allowedProtocol =
    (loopback && (url.protocol === 'http:' || url.protocol === 'https:')) ||
    (!loopback && url.protocol === 'https:')
  if (!allowedProtocol || url.username || url.password || url.hash) {
    throw new Error('Local dùng HTTP(S); server từ xa bắt buộc HTTPS và không nhúng mật khẩu vào URL.')
  }

  return url.toString().replace(/\/$/, '')
}

function normalizeAuthKey(value) {
  const key = String(value || '').trim()
  if (key.length > 4096 || /[\r\n]/.test(key)) {
    throw new Error('Auth key không hợp lệ.')
  }
  return key
}

function contentSettings(settings) {
  return {
    targetLanguage: settings.targetLanguage,
    lookAhead: settings.lookAhead,
    autoTranslate: settings.autoTranslate,
  }
}

function readSettings() {
  const chosenModel =
    elements.model.value === '__custom__'
      ? elements.customModel.value.trim()
      : elements.model.value
  if (!chosenModel) {
    const error = new Error('Nhập ID model đã cấu hình trong Koharu.')
    error.field = 'model'
    throw error
  }

  return {
    endpoint: normalizeEndpoint(elements.endpoint.value),
    targetLanguage: elements.targetLanguage.value,
    provider: elements.provider.value,
    model: chosenModel,
    pipeline: elements.pipeline.value,
    lookAhead: Number(elements.lookAhead.value),
    autoTranslate: elements.autoTranslate.checked,
    glossary: elements.glossary.value.trim(),
    authKey: normalizeAuthKey(elements.authKey.value),
  }
}

function fallbackProviders() {
  return Object.keys(MODEL_PRESETS).map((id) => ({
    id,
    name: PROVIDER_METADATA[id]?.label || id,
    models: [],
  }))
}

function providerLabel(provider) {
  return PROVIDER_METADATA[provider.id]?.label || provider.name || provider.id
}

function populateProviders(providers, selectedProvider) {
  const entries = (Array.isArray(providers) && providers.length > 0
    ? providers
    : fallbackProviders())
    .filter((provider) => provider && typeof provider.id === 'string' && provider.id)
    .sort((left, right) => {
      const leftOrder = PROVIDER_METADATA[left.id]?.order ?? 99
      const rightOrder = PROVIDER_METADATA[right.id]?.order ?? 99
      return leftOrder - rightOrder || providerLabel(left).localeCompare(providerLabel(right))
    })

  elements.provider.replaceChildren()
  for (const provider of entries) {
    const option = document.createElement('option')
    option.value = provider.id
    option.textContent = providerLabel(provider)
    elements.provider.append(option)
  }

  if (selectedProvider && !entries.some((provider) => provider.id === selectedProvider)) {
    const option = document.createElement('option')
    option.value = selectedProvider
    option.textContent = selectedProvider
    elements.provider.append(option)
  }
  elements.provider.value = selectedProvider || entries[0]?.id || ''
}

function modelsForProvider(provider) {
  const presets = MODEL_PRESETS[provider] || []
  const presetById = new Map(presets.map((preset) => [preset.value, preset]))
  const catalogModels = providerCatalog.get(provider)?.models
  if (!Array.isArray(catalogModels) || catalogModels.length === 0) return presets

  const catalogEntries = catalogModels
    .map((model) => {
      const value = model?.target?.modelId
      if (typeof value !== 'string' || !value) return null
      const preset = presetById.get(value)
      return {
        value,
        label: preset?.label || model.name || value,
        note: preset?.note || 'Model được đọc trực tiếp từ catalog Koharu.',
      }
    })
    .filter(Boolean)
  const presetIds = new Set(presets.map((preset) => preset.value))
  return [
    ...presets,
    ...catalogEntries.filter((model) => !presetIds.has(model.value)),
  ]
}

function selectedModelValue() {
  return elements.model.value === '__custom__'
    ? elements.customModel.value.trim()
    : elements.model.value
}

function populateModels(provider, selectedModel) {
  const models = modelsForProvider(provider)
  elements.model.replaceChildren()

  for (const model of models) {
    const option = document.createElement('option')
    option.value = model.value
    option.textContent = model.label
    elements.model.append(option)
  }

  const customOption = document.createElement('option')
  customOption.value = '__custom__'
  customOption.textContent = 'Model khác…'
  elements.model.append(customOption)

  const isListed = models.some((model) => model.value === selectedModel)
  elements.model.value = isListed ? selectedModel : '__custom__'
  elements.customModel.value = isListed ? '' : selectedModel
  updateModelField()
}

function updateModelField() {
  const custom = elements.model.value === '__custom__'
  elements.customModelField.hidden = !custom

  const preset = modelsForProvider(elements.provider.value).find(
    (item) => item.value === elements.model.value,
  )
  elements.modelNote.textContent =
    preset?.note || 'Nhập đúng ID model đã cấu hình trong Koharu.'
}

function applySettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings }
  elements.endpoint.value = merged.endpoint
  elements.authKey.value = merged.authKey || ''
  elements.targetLanguage.value = merged.targetLanguage
  populateProviders([], merged.provider)
  elements.pipeline.value = merged.pipeline
  elements.lookAhead.value = String(merged.lookAhead)
  elements.autoTranslate.checked = Boolean(merged.autoTranslate)
  elements.glossary.value = merged.glossary || ''
  populateModels(merged.provider, merged.model)
}

function migrateSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings
  const migrated = { ...settings }
  let changed = false

  if (
    migrated.provider === 'gemini' &&
    migrated.model === 'gemini-3.1-flash-lite'
  ) {
    migrated.model = 'gemini-3.6-flash'
    changed = true
  }
  if (!String(migrated.glossary || '').trim()) {
    migrated.glossary = YAOSHENJI_GLOSSARY
    changed = true
  }

  return changed ? migrated : settings
}

function applyProviderCatalog(providers) {
  if (!Array.isArray(providers) || providers.length === 0) return

  const selectedProvider = elements.provider.value
  const selectedModel = selectedModelValue()
  providerCatalog = new Map(
    providers
      .filter((provider) => provider && typeof provider.id === 'string')
      .map((provider) => [provider.id, provider]),
  )
  populateProviders(providers, selectedProvider)
  populateModels(elements.provider.value, selectedModel)
}

async function persistSettings() {
  try {
    const settings = readSettings()
    elements.customModel.removeAttribute('aria-invalid')
    updateModelField()
    elements.endpointError.hidden = true
    elements.endpoint.removeAttribute('aria-invalid')
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings })
    elements.saveState.textContent = 'Đã lưu'

    if (activeTabId !== null) {
      await sendToTab({
        type: 'SETTINGS_UPDATED',
        settings: contentSettings(settings),
      }).catch(() => null)
    }
    return settings
  } catch (error) {
    const message = errorMessage(error, 'Cài đặt chưa hợp lệ.')
    if (error.field === 'model') {
      elements.customModel.setAttribute('aria-invalid', 'true')
      elements.modelNote.textContent = message
    } else {
      elements.endpointError.textContent = message
      elements.endpointError.hidden = false
      elements.endpoint.setAttribute('aria-invalid', 'true')
    }
    elements.saveState.textContent = 'Chưa lưu'
    return null
  }
}

function scheduleSave() {
  window.clearTimeout(saveTimer)
  elements.saveState.textContent = 'Đang lưu…'
  saveTimer = window.setTimeout(persistSettings, 260)
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) {
    throw new Error('Không tìm thấy tab đang mở.')
  }
  if (!/^https?:/i.test(tab.url || '')) {
    throw new Error('Trang này không cho phép extension chạy.')
  }
  activeTabId = tab.id
  return tab
}

async function sendToTab(message) {
  if (activeTabId === null) {
    await getActiveTab()
  }
  return chrome.tabs.sendMessage(activeTabId, message)
}

async function injectContent(tabId) {
  let alreadyInjected = false
  try {
    const status = await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CONTENT_STATUS',
    })
    alreadyInjected = Boolean(status && status.ok !== false)
  } catch {
    alreadyInjected = false
  }

  if (!alreadyInjected) {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content.css'],
    })
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/core.js'],
    })
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    })
  }
}

function originPattern(origin) {
  const url = new URL(origin)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Nguồn ảnh không dùng HTTP(S).')
  }
  return `${url.protocol}//${url.hostname}/*`
}

function endpointPattern(endpoint) {
  const url = new URL(normalizeEndpoint(endpoint))
  return `${url.protocol}//${url.hostname}/*`
}

async function ensureEndpointPermission(endpoint, requestPermission = false) {
  const origins = [endpointPattern(endpoint)]
  const granted = requestPermission
    ? await chrome.permissions.request({ origins })
    : await chrome.permissions.contains({ origins })
  if (!granted) {
    throw new Error('Cần cấp quyền cho domain Koharu remote rồi bấm Kết nối lại.')
  }
}

async function inspectPermissions(origins) {
  const uniqueOrigins = [...new Set(origins)]
  const checks = await Promise.all(
    uniqueOrigins.map(async (origin) => {
      const granted = await chrome.permissions.contains({
        origins: [originPattern(origin)],
      })
      return { origin, granted }
    }),
  )
  return checks
}

function getCounts(status) {
  const counts = status?.counts || {}
  const total = Number(counts.total ?? status?.candidates?.length ?? status?.total ?? 0)
  const done = Number(counts.done ?? counts.complete ?? status?.complete ?? 0)
  const failed = Number(counts.failed ?? status?.failed ?? 0)
  const processing = Number(
    counts.processing ?? counts.translating ?? status?.translating ?? 0,
  )
  const blocked = Number(counts.blocked ?? 0)
  const excluded = Number(counts.excluded ?? 0)
  const translatedRegions = Number(counts.translatedRegions ?? 0)
  const pagesWithoutText = Number(counts.pagesWithoutText ?? 0)
  return {
    total,
    done,
    failed,
    processing,
    blocked,
    excluded,
    translatedRegions,
    pagesWithoutText,
  }
}

function renderContentStatus(status) {
  const counts = getCounts(status)
  const active =
    status?.ok !== false && counts.total - counts.blocked - counts.excluded > 0
  const paused = Boolean(status?.paused)
  const revealed = Boolean(status?.sourceRevealed ?? status?.revealed)

  elements.candidateCount.textContent = String(counts.total)
  elements.pageStatus.textContent =
    status?.detail ||
    (counts.total
      ? `${counts.total} ảnh phù hợp đã được xếp theo thứ tự trang.`
      : 'Không thấy ảnh comic đủ lớn trên trang này.')

  elements.progressSection.hidden = counts.total === 0
  elements.progressCount.textContent =
    `${counts.done} / ${counts.total} ảnh · ${counts.translatedRegions} ô chữ`
  elements.progressBar.style.width = counts.total
    ? `${Math.min(100, Math.round((counts.done / counts.total) * 100))}%`
    : '0%'

  if (counts.processing > 0) {
    elements.progressStatus.textContent = `Đang dịch ${counts.processing} ảnh…`
  } else if (paused) {
    elements.progressStatus.textContent = 'Hàng đợi đang tạm dừng.'
  } else if (counts.done === counts.total && counts.total > 0) {
    elements.progressStatus.textContent = counts.pagesWithoutText
      ? `Đã xử lý xong; ${counts.pagesWithoutText} ảnh không phát hiện thoại.`
      : 'Đã render toàn bộ ô chữ đã phát hiện.'
  } else {
    elements.progressStatus.textContent = 'Sẵn sàng dịch.'
  }

  elements.failureCount.hidden = counts.failed === 0 && counts.blocked === 0
  elements.failureCount.textContent = [
    counts.failed ? `${counts.failed} ảnh lỗi` : '',
    counts.blocked ? `${counts.blocked} ảnh thiếu quyền` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  elements.translateVisibleButton.disabled = !active
  elements.translateAllButton.disabled = !active
  elements.pauseButton.disabled = !active
  elements.revealButton.disabled = counts.done === 0
  elements.retryButton.disabled = counts.failed === 0

  elements.pauseButton.setAttribute('aria-pressed', String(paused))
  elements.pauseButton.textContent = paused ? 'Tiếp tục' : 'Tạm dừng'
  elements.revealButton.setAttribute('aria-pressed', String(revealed))
  elements.revealButton.textContent = revealed ? 'Hiện bản dịch' : 'Hiện ảnh gốc'
}

async function refreshContentStatus() {
  if (activeTabId === null) {
    await getActiveTab()
  }
  try {
    const status = await sendToTab({ type: 'GET_CONTENT_STATUS' })
    if (status) {
      currentOrigins = status.origins || currentOrigins
      renderContentStatus(status)
    }
  } catch {
    elements.candidateCount.textContent = '—'
    elements.pageStatus.textContent = 'Bấm Dịch trang này để bắt đầu.'
  }
}

function renderHealth(response) {
  const state = response?.state || (response?.ok ? 'ready' : 'offline')
  const descriptions = {
    ready: response?.version
      ? `Sẵn sàng · Koharu ${response.version}`
      : 'Sẵn sàng nhận ảnh.',
    booting: 'Đang khởi động hoặc tải model…',
    provider_not_configured: 'Chưa cấu hình nhà cung cấp trong Koharu.',
    incompatible: 'Phiên bản Koharu chưa tương thích.',
    offline: 'Không kết nối được Koharu.',
  }

  elements.healthState.textContent =
    response?.error?.message || response?.detail || descriptions[state] || 'Chưa sẵn sàng.'
  elements.healthDot.dataset.tone =
    state === 'ready'
      ? 'ready'
      : state === 'booting'
        ? 'busy'
        : response?.ok
          ? 'ready'
          : 'error'
}

async function checkHealth(requestPermission = false) {
  setBusy(elements.refreshButton, true, 'Đang kiểm tra…')
  elements.healthDot.dataset.tone = 'busy'
  try {
    if (requestPermission) {
      await ensureEndpointPermission(readSettings().endpoint, true)
    }
    const settings = await persistSettings()
    if (!settings) {
      throw new Error('Sửa cài đặt chưa hợp lệ trước khi kiểm tra.')
    }
    if (!requestPermission) {
      await ensureEndpointPermission(settings.endpoint)
    }
    const response = await chrome.runtime.sendMessage({ type: 'HEALTH_CHECK' })
    applyProviderCatalog(response?.providers)
    renderHealth(response)
  } catch (error) {
    renderHealth({
      ok: false,
      state: 'offline',
      detail: errorMessage(error, 'Không kết nối được Koharu.'),
    })
  } finally {
    setBusy(elements.refreshButton, false)
  }
}

async function scanPage() {
  setBusy(elements.scanButton, true, 'Đang bắt đầu…')
  elements.pageStatus.textContent = 'Đang tìm ảnh comic trên trang…'

  try {
    await ensureEndpointPermission(readSettings().endpoint, true)
    const tab = await getActiveTab()
    const activation = await chrome.runtime.sendMessage({
      type: 'ACTIVATE_TAB',
      tabId: tab.id,
    })
    if (activation?.ok === false) {
      throw new Error(errorMessage(activation, 'Không thể kích hoạt tab này.'))
    }
    await injectContent(tab.id)
    const settings = await persistSettings()
    if (!settings) {
      throw new Error('Sửa địa chỉ Koharu trước khi quét.')
    }

    const response = await sendToTab({
      type: 'SCAN_PAGE',
      scope: 'all',
      settings: contentSettings(settings),
    })
    if (!response || response.ok === false) {
      throw new Error(errorMessage(response, 'Không thể quét trang này.'))
    }

    currentOrigins = response.origins || []
    renderContentStatus(response)

    const permissions = await inspectPermissions(currentOrigins)
    const missing = permissions.filter((item) => !item.granted)
    pendingPermissionPatterns = missing.map((item) => originPattern(item.origin))
    elements.permissionPanel.hidden = missing.length === 0
    elements.permissionStatus.hidden = currentOrigins.length === 0
    elements.permissionStatus.textContent =
      `Quyền nguồn ảnh: ${permissions.length - missing.length}/${permissions.length} đã cấp`

    if (currentOrigins.length === 0) {
      elements.permissionPanel.hidden = true
    } else if (missing.length > 0) {
      elements.permissionTitle.textContent = `Cần quyền với ${missing.length} nguồn ảnh`
      elements.permissionDetail.textContent =
        'Chỉ các origin ảnh vừa tìm thấy; không cấp quyền toàn bộ website.'
    } else {
      await sendToTab({
        type: 'PERMISSIONS_UPDATED',
        grantedOrigins: permissions.map((item) => item.origin),
      })
      await sendToTab({ type: 'TRANSLATE_SCOPE', scope: 'all' })
    }
  } catch (error) {
    elements.pageStatus.textContent = errorMessage(error, 'Không thể quét trang này.')
    elements.candidateCount.textContent = '0'
    elements.permissionPanel.hidden = true
    elements.permissionStatus.hidden = true
    pendingPermissionPatterns = []
    showToast(elements.pageStatus.textContent)
  } finally {
    setBusy(elements.scanButton, false)
  }
}

async function requestImagePermissions() {
  setBusy(elements.permissionButton, true, 'Đang chờ…')
  try {
    if (pendingPermissionPatterns.length > 0) {
      await chrome.permissions.request({ origins: pendingPermissionPatterns })
    }

    const updated = await inspectPermissions(currentOrigins)
    const grantedOrigins = updated
      .filter((item) => item.granted)
      .map((item) => item.origin)
    const missingCount = updated.length - grantedOrigins.length
    pendingPermissionPatterns = updated
      .filter((item) => !item.granted)
      .map((item) => originPattern(item.origin))

    await sendToTab({
      type: 'PERMISSIONS_UPDATED',
      grantedOrigins,
    })
    if (grantedOrigins.length > 0) {
      await sendToTab({ type: 'TRANSLATE_SCOPE', scope: 'all' })
    }

    elements.permissionPanel.hidden = missingCount === 0
    elements.permissionStatus.textContent =
      `Quyền nguồn ảnh: ${grantedOrigins.length}/${updated.length} đã cấp`
    if (missingCount > 0) {
      elements.permissionTitle.textContent = `Còn ${missingCount} nguồn chưa được phép`
      elements.permissionDetail.textContent =
        'Ảnh từ nguồn bị từ chối sẽ luôn giữ nguyên bản gốc.'
      showToast('Quyền bị từ chối; các ảnh đó sẽ không được xử lý.')
    } else {
      showToast('Đã cấp đúng quyền nguồn ảnh cho trang này.')
    }
    await refreshContentStatus()
  } catch (error) {
    showToast(errorMessage(error, 'Không thể cập nhật quyền ảnh.'))
  } finally {
    setBusy(elements.permissionButton, false)
  }
}

async function sendControl(message, successMessage) {
  try {
    const response = await sendToTab(message)
    if (response?.ok === false) {
      throw new Error(errorMessage(response, 'Thao tác không hoàn tất.'))
    }
    if (successMessage) {
      showToast(successMessage)
    }
    await refreshContentStatus()
  } catch (error) {
    showToast(errorMessage(error, 'Hãy quét lại trang rồi thử tiếp.'))
  }
}

async function clearCache() {
  if (!clearCacheArmed) {
    clearCacheArmed = true
    elements.clearCacheButton.textContent = 'Bấm lại để xoá'
    window.setTimeout(() => {
      clearCacheArmed = false
      elements.clearCacheButton.textContent = 'Xoá cache'
    }, 3500)
    return
  }

  clearCacheArmed = false
  elements.clearCacheButton.textContent = 'Đang xoá…'
  elements.clearCacheButton.disabled = true
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' })
    if (response?.ok === false) {
      throw new Error(errorMessage(response, 'Không thể xoá cache.'))
    }
    showToast('Đã xoá cache bản dịch. Ảnh gốc không bị thay đổi.')
  } catch (error) {
    showToast(errorMessage(error, 'Không thể xoá cache.'))
  } finally {
    elements.clearCacheButton.disabled = false
    elements.clearCacheButton.textContent = 'Xoá cache'
  }
}

function bindEvents() {
  elements.scanButton.addEventListener('click', scanPage)
  elements.permissionButton.addEventListener('click', requestImagePermissions)
  elements.refreshButton.addEventListener('click', () => checkHealth(true))
  elements.clearCacheButton.addEventListener('click', clearCache)

  elements.translateVisibleButton.addEventListener('click', () =>
    sendControl(
      { type: 'TRANSLATE_SCOPE', scope: 'visible' },
      'Đã đưa ảnh đang thấy vào hàng đợi.',
    ),
  )
  elements.translateAllButton.addEventListener('click', () =>
    sendControl(
      { type: 'TRANSLATE_SCOPE', scope: 'all' },
      'Đã đưa toàn bộ ảnh phù hợp vào hàng đợi.',
    ),
  )
  elements.pauseButton.addEventListener('click', () => {
    const paused = elements.pauseButton.getAttribute('aria-pressed') !== 'true'
    return sendControl({ type: 'SET_PAUSED', paused })
  })
  elements.revealButton.addEventListener('click', () => {
    const revealed = elements.revealButton.getAttribute('aria-pressed') !== 'true'
    return sendControl({ type: 'SET_SOURCE_REVEALED', revealed })
  })
  elements.retryButton.addEventListener('click', () =>
    sendControl({ type: 'RETRY_FAILED' }, 'Đã thử lại các ảnh lỗi.'),
  )

  elements.provider.addEventListener('change', () => {
    const firstModel = modelsForProvider(elements.provider.value)[0]?.value || ''
    populateModels(elements.provider.value, firstModel)
    scheduleSave()
  })
  elements.model.addEventListener('change', () => {
    updateModelField()
    scheduleSave()
  })

  for (const control of [
    elements.targetLanguage,
    elements.pipeline,
    elements.lookAhead,
    elements.autoTranslate,
    elements.customModel,
    elements.endpoint,
    elements.authKey,
  ]) {
    control.addEventListener('change', scheduleSave)
  }
  elements.glossary.addEventListener('input', scheduleSave)

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'CONTENT_STATUS' && message.status) {
      renderContentStatus(message.status)
    }
  })
}

async function initialize() {
  bindEvents()
  const stored = await chrome.storage.local.get(SETTINGS_KEY)
  const migrated = migrateSettings(stored[SETTINGS_KEY])
  if (migrated && migrated !== stored[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: migrated })
  }
  applySettings(migrated)

  await Promise.allSettled([checkHealth(false), refreshContentStatus()])
}

initialize().catch((error) => {
  showToast(errorMessage(error, 'Popup không thể khởi động.'))
})

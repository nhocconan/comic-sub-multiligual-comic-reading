'use strict'

const $ = (selector) => document.querySelector(selector)
const $$ = (selector) => [...document.querySelectorAll(selector)]
let state
let activeTab = 'reader'
let latestReceipt = null
let toastTimer
let pendingTranslationCommand = null
let providerModels = []
const panelPreferences = {
  sidebar: localStorage.getItem('mangaSub.panel.sidebar') || 'auto',
  inspector: localStorage.getItem('mangaSub.panel.inspector') || 'hidden',
}

const routeNames = { ask: 'Chưa chọn route', local: 'On this Mac', managed: 'Manga Sub Cloud', byo: 'Your API key' }
const languages = {
  'vi-VN': 'Vietnamese',
  'en-US': 'English',
  'fr-FR': 'French',
  'es-ES': 'Spanish',
  'de-DE': 'German',
  'pt-BR': 'Portuguese',
  'id-ID': 'Indonesian',
  'ja-JP': 'Japanese',
  'ko-KR': 'Korean',
  'zh-CN': 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
}
const sourceLanguages = {
  auto: 'Automatic',
  'zh-Hans': 'Chinese',
  'zh-Hant': 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  en: 'English',
}
const escapeHtml = (value) => String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show')
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 3400)
}

function routeNeedsChoice() { return !state.settings.route || state.settings.route === 'ask' }
function readerRouteText() { return `${state.settings.targetLanguage.startsWith('vi') ? 'VI' : state.settings.targetLanguage.slice(0, 2).toUpperCase()} · ${routeNames[state.settings.route] || routeNames.ask}` }

function panelIsHidden(name) {
  const preference = panelPreferences[name]
  if (preference === 'hidden') return true
  if (preference === 'shown') return false
  return name === 'sidebar' ? window.innerWidth < 1060 : window.innerWidth < 1400
}

function applyPanelLayout() {
  const sidebarHidden = panelIsHidden('sidebar')
  const inspectorHidden = panelIsHidden('inspector')
  document.body.classList.toggle('sidebar-collapsed', sidebarHidden)
  document.body.classList.toggle('inspector-collapsed', inspectorHidden)
  $('#toggle-sidebar').setAttribute('aria-pressed', String(!sidebarHidden))
  $('#toggle-sidebar').setAttribute('aria-label', sidebarHidden ? 'Hiện thanh công cụ' : 'Ẩn thanh công cụ')
  $('#toggle-inspector').setAttribute('aria-pressed', String(!inspectorHidden))
  $('#toggle-inspector').setAttribute('aria-label', inspectorHidden ? 'Hiện thông tin phiên' : 'Ẩn thông tin phiên')
  requestAnimationFrame(syncReaderBounds)
}

function togglePanel(name) {
  panelPreferences[name] = panelIsHidden(name) ? 'shown' : 'hidden'
  localStorage.setItem(`mangaSub.panel.${name}`, panelPreferences[name])
  applyPanelLayout()
}

function renderState() {
  $('#private-toggle').classList.toggle('enabled', state.privateSession)
  $('#private-toggle').innerHTML = `<span class="private-dot"></span>${state.privateSession ? 'Private · progress not saved' : 'Private session'}`
  $('#language-label').textContent = `${sourceLanguages[state.settings.sourceLanguage] || state.settings.sourceLanguage} → ${languages[state.settings.targetLanguage] || state.settings.targetLanguage}`
  $('#route-summary').textContent = routeNames[state.settings.route] || routeNames.ask
  $('#route-chip').textContent = readerRouteText()
  $('#history-value').textContent = state.privateSession ? 'Ephemeral' : 'Local'
  $('#target-language').value = state.settings.targetLanguage
  $('#source-language').value = state.settings.sourceLanguage || 'auto'
  $('#profile').value = state.settings.profile
  $('#default-route').value = state.settings.route
  $('#broker-endpoint').value = state.settings.brokerEndpoint || 'http://127.0.0.1:4100'
  $('#token-status').textContent = state.settings.tokenConfigured ? 'Token đã được mã hóa trong credential store của hệ điều hành.' : 'Token không được đồng bộ giữa thiết bị.'
  $('#byo-provider').value = state.settings.byoProvider || 'gemini'
  $('#byo-base-url').value = state.settings.byoBaseUrl || 'https://api.deepseek.com/v1'
  $('#byo-base-row').hidden = state.settings.byoProvider !== 'openai-compatible'
  $('#byo-model').value = state.settings.byoModel || ''
  $('#byo-key-status').textContent = state.settings.byoKeyConfigured
    ? 'Key đã được mã hóa trong credential store của hệ điều hành.'
    : 'Key không được đồng bộ giữa thiết bị.'
  $('#byo-model-options').innerHTML = providerModels
    .map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name || model.id)}</option>`)
    .join('')
  $('#migration-banner').hidden = !state.needsModelChoice
  renderLibrary(); renderGlossary()
}

function renderLibrary() {
  const list = $('#library-list')
  if (!state.history.length) { list.innerHTML = '<div class="empty-list">Chưa có lịch sử. Một chương sẽ được lưu sau khi bạn đọc hoặc dịch.</div>'; return }
  list.innerHTML = state.history.map((item) => `<article class="history-row"><div><p class="eyebrow">${escapeHtml(item.origin)}</p><h2>${escapeHtml(item.title)}</h2><p>Ảnh ${Number(item.candidateIndex || 0) + 1}/${item.candidateCount || '—'} · ${item.translated ? 'Đã dịch' : 'Bản gốc'} · ${new Date(item.updatedAt).toLocaleDateString('vi-VN')}</p></div><div class="history-actions"><button data-resume="${escapeHtml(item.id)}">Tiếp tục</button><button data-delete="${escapeHtml(item.id)}" class="danger">×</button></div></article>`).join('')
}

function renderGlossary() {
  $('#glossary-list').innerHTML = state.glossary.length ? state.glossary.map((term) => `<span>${escapeHtml(term.value)} <em>${term.source === 'user' ? 'manual' : 'local'}</em></span>`).join('') : '<p class="hint">Chưa có thuật ngữ. Local Continuity Memory sẽ bổ sung sau bản dịch đầu tiên.</p>'
}

function setTab(tab) {
  activeTab = tab
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab))
  $('#reader-workspace').hidden = tab !== 'reader'
  $('#library-workspace').hidden = tab !== 'library'
  $('#settings-workspace').hidden = tab !== 'settings'
  $('#reader-controls').hidden = tab !== 'reader'
  window.comicSub.setReaderVisible(tab === 'reader')
  if (tab === 'reader') requestAnimationFrame(syncReaderBounds)
}

function syncReaderBounds() {
  if (activeTab !== 'reader') return
  const rect = $('#reader-frame').getBoundingClientRect()
  window.comicSub.setReaderBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
}

async function saveSettings(patch) {
  state.settings = await window.comicSub.saveSettings(patch)
  renderState()
}

function ensureRoute(command) {
  if (routeNeedsChoice()) {
    pendingTranslationCommand = command
    $('#route-chooser').hidden = false
    $('#route-chooser').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    return
  }
  $('#queue-status').innerHTML = '<span class="pulse"></span><span>Đang chuẩn bị trang đã xác nhận…</span>'
  window.comicSub.readerCommand({ type: command })
  if (state.glossaryConsent === null && !state.privateSession) $('#continuity-card').hidden = false
}

function renderReceipt() {
  if (!latestReceipt) return
  $('#copy-diagnostic').disabled = false
  $('#receipt-card').innerHTML = `<div class="receipt-title"><span>JOB RECEIPT</span><button id="copy-diagnostic">Copy ID</button></div><dl><div><dt>Image</dt><dd>${escapeHtml(latestReceipt.image)}</dd></div><div><dt>Translated text</dt><dd>${escapeHtml(latestReceipt.text)}</dd></div><div><dt>Model</dt><dd>${escapeHtml(latestReceipt.model)}</dd></div><div><dt>Route</dt><dd>Requested / resolved: matched</dd></div></dl><p class="receipt-id">${latestReceipt.id}</p>`
  $('#copy-diagnostic').addEventListener('click', async () => { await window.comicSub.copyDiagnostic(latestReceipt); toast('Đã copy safe diagnostic ID.') })
}

async function chooseRoute(route) {
  await saveSettings({ route })
  $('#route-chooser').hidden = true
  toast(`${routeNames[route]} đã được chọn. Bạn luôn có thể đổi trước khi dịch.`)
  const command = pendingTranslationCommand
  pendingTranslationCommand = null
  if (command) ensureRoute(command)
}

function updateReaderStatus(payload) {
  if (!payload) return
  if (payload.type === 'snapshot') {
    $('#candidate-count').textContent = payload.candidateCount || '—'
    $('#snapshot-value').textContent = `${payload.candidateCount || 0} images`
    $('#session-title').textContent = payload.title || 'Chương đang đọc'
    $('#session-detail').textContent = payload.candidateCount ? 'Ảnh đã được chụp snapshot. Dịch chỉ chạy khi bạn bấm.' : 'Không thấy ảnh truyện đủ lớn trên trang này.'
  }
  if (payload.type === 'route-required') {
    ensureRoute(payload.command || 'translate-current')
  }
  if (payload.type === 'queue') {
    $('#queue-status').innerHTML = `<span class="pulse"></span><span>Đang dịch ${payload.done + 1}/${payload.total} · ${payload.queued} đang chờ</span>`
    $('#queue-value').textContent = `${payload.done}/${payload.total}`
  }
  if (payload.type === 'broker-progress') {
    const labels = {
      OCR: 'Đang đọc chữ trên máy · ảnh không được tải lên cloud',
      QUEUED: 'Đã đọc chữ · đang xếp hàng dịch',
      TRANSLATING: 'Đang dịch text theo lô',
      TRANSLATING_LOCAL: 'Apple Translation đang dịch cả lô ngay trên máy',
      PROCESSING: 'Đang dịch text theo lô',
      RENDERING: 'Đang chuẩn bị lớp chữ trên máy',
    }
    const label = labels[payload.state] || `Đang xử lý · ${payload.state || 'working'}`
    $('#queue-status').innerHTML = `<span class="pulse"></span><span>${label}</span>`
    $('#queue-value').textContent = payload.state === 'OCR' ? 'Local OCR' : 'Text only'
  }
  if (payload.type === 'job-complete') {
    $('#queue-status').innerHTML = '<span class="pulse done"></span><span>Bản dịch đã sẵn sàng · chạm Original để so sánh</span>'
    $('#queue-value').textContent = 'Complete'
  }
  if (payload.type === 'broker-failure') {
    $('#queue-status').innerHTML = `<span class="pulse"></span><span>${escapeHtml(payload.message || 'Dịch thất bại; ảnh gốc vẫn giữ nguyên.')}</span>`
    $('#queue-value').textContent = 'Failed'
  }
  if (payload.type === 'broker-cancelled') {
    $('#queue-status').innerHTML = '<span class="pulse"></span><span>Đã dừng queue; ảnh gốc vẫn giữ nguyên.</span>'
    $('#queue-value').textContent = 'Stopped'
  }
}

function bind() {
  $('#address-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const raw = $('#address-input').value.trim(); if (!raw) return
    try { await window.comicSub.navigate(raw); setTab('reader'); toast('Đang mở trang trong Manga Sub…') } catch (error) { toast(error.message || 'URL không hợp lệ.') }
  })
  $('#back-button').addEventListener('click', () => window.comicSub.readerCommand({ type: 'back' }))
  $('#toggle-sidebar').addEventListener('click', () => togglePanel('sidebar'))
  $('#toggle-inspector').addEventListener('click', () => togglePanel('inspector'))
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.tab)))
  $('#translate-current').addEventListener('click', () => ensureRoute('translate-current'))
  $('#translate-all').addEventListener('click', () => ensureRoute('open-all-confirm'))
  $('#cancel-translation').addEventListener('click', () => window.comicSub.readerCommand({ type: 'pause' }))
  $('#change-route').addEventListener('click', () => { $('#route-chooser').hidden = !$('#route-chooser').hidden })
  $$('#route-chooser [data-route]').forEach((button) => button.addEventListener('click', () => chooseRoute(button.dataset.route)))
  $('#open-sample').addEventListener('click', async () => { $('#address-input').value = ''; await window.comicSub.openSample(); toast('Đang dùng chapter mẫu được cấp phép.') })
  $('#private-toggle').addEventListener('click', async () => { state = await window.comicSub.setPrivate(!state.privateSession); renderState(); toast(state.privateSession ? 'Private session đang bật. Progress sẽ không được lưu.' : 'Đã quay về phiên bình thường.') })
  $('#lookup-accept').addEventListener('click', async () => { state.glossaryConsent = await window.comicSub.setGlossaryConsent('allowed'); $('#continuity-card').hidden = true; toast('Chỉ title chuẩn hóa và ngôn ngữ đích được dùng để tra cứu.') })
  $('#lookup-decline').addEventListener('click', async () => { state.glossaryConsent = await window.comicSub.setGlossaryConsent('local-only'); $('#continuity-card').hidden = true; toast('Series này chỉ dùng Local Continuity Memory.') })
  $('#target-language').addEventListener('change', (event) => saveSettings({ targetLanguage: event.target.value }))
  $('#source-language').addEventListener('change', (event) => saveSettings({ sourceLanguage: event.target.value }))
  $('#profile').addEventListener('change', (event) => saveSettings({ profile: event.target.value }))
  $('#default-route').addEventListener('change', (event) => saveSettings({ route: event.target.value }))
  $('#broker-endpoint').addEventListener('change', (event) => saveSettings({ brokerEndpoint: event.target.value }))
  $('#save-token').addEventListener('click', async () => { try { const result = await window.comicSub.setToken($('#provider-token').value); $('#provider-token').value = ''; state.settings.tokenConfigured = result.tokenConfigured; renderState(); toast('Token đã được lưu trong credential store.') } catch (error) { toast(error.message) } })
  $('#byo-provider').addEventListener('change', async (event) => {
    providerModels = []
    await saveSettings({ byoProvider: event.target.value, byoModel: '' })
  })
  $('#byo-base-url').addEventListener('change', (event) => saveSettings({ byoBaseUrl: event.target.value, byoModel: '' }))
  $('#byo-model').addEventListener('change', (event) => saveSettings({ byoModel: event.target.value }))
  $('#save-byo-key').addEventListener('click', async () => {
    try {
      const provider = $('#byo-provider').value
      const result = await window.comicSub.setProviderKey(provider, $('#byo-api-key').value)
      $('#byo-api-key').value = ''
      state.settings.byoKeyConfigured = result.keyConfigured
      renderState()
      toast(result.keyConfigured ? 'API key đã được lưu trong credential store.' : 'API key đã được xóa.')
    } catch (error) { toast(error.message) }
  })
  $('#refresh-models').addEventListener('click', async () => {
    const button = $('#refresh-models')
    button.disabled = true
    $('#byo-model-status').textContent = 'Đang lấy catalog trực tiếp từ provider…'
    try {
      const catalog = await window.comicSub.listProviderModels({
        provider: $('#byo-provider').value,
        baseUrl: $('#byo-base-url').value,
      })
      providerModels = catalog.models || []
      if (!state.settings.byoModel && catalog.recommended) {
        await saveSettings({ byoModel: catalog.recommended })
      } else {
        renderState()
      }
      $('#byo-model-status').textContent = `${providerModels.length} text model · cập nhật ${new Date(catalog.fetchedAt).toLocaleTimeString()}`
      toast(catalog.recommended ? `Balanced đề xuất ${catalog.recommended}` : 'Catalog đã cập nhật.')
    } catch (error) {
      $('#byo-model-status').textContent = error.message
      toast(error.message)
    } finally {
      button.disabled = false
    }
  })
  $('#add-term-form').addEventListener('submit', async (event) => { event.preventDefault(); state.glossary = await window.comicSub.addTerm($('#term-input').value); $('#term-input').value = ''; renderGlossary() })
  $('#library-list').addEventListener('click', async (event) => { const resumeId = event.target.dataset.resume; const deleteId = event.target.dataset.delete; if (resumeId) { const item = state.history.find((entry) => entry.id === resumeId); await window.comicSub.resume(item); setTab('reader') } if (deleteId) { state.history = await window.comicSub.clearHistory(deleteId); renderLibrary() } })
  $$('#migration-banner [data-choice]').forEach((button) => button.addEventListener('click', async () => { state = await window.comicSub.chooseModelMigration(button.dataset.choice); renderState(); toast('Thiết lập model đã được cập nhật.') }))
  window.addEventListener('resize', applyPanelLayout)
  document.querySelectorAll('.sidebar,.inspector,.reader-frame').forEach((element) => {
    element.addEventListener('transitionend', syncReaderBounds)
  })
  new ResizeObserver(() => syncReaderBounds()).observe($('#reader-frame'))
}

async function init() {
  state = await window.comicSub.getState()
  bind(); renderState(); applyPanelLayout(); setTab('reader'); requestAnimationFrame(syncReaderBounds)
  window.comicSub.on('reader:status', updateReaderStatus)
  window.comicSub.on('app:navigation', ({ url }) => { $('#address-input').value = url })
  window.comicSub.on('app:history', (history) => { state.history = history; renderLibrary() })
  window.comicSub.on('app:reader-crashed', () => toast('Reader đã dừng. Bạn có thể thử mở lại chương này.'))
  window.comicSub.on('app:broker-receipt', (receipt) => {
    const local = receipt.route === 'local'
    latestReceipt = {
      id: receipt.jobId,
      route: receipt.route,
      language: state.settings.targetLanguage,
      model: receipt.resolvedModel,
      image: receipt.route === 'managed' ? 'Manga Sub Cloud' : 'This Mac',
      text: local
        ? 'Apple Translation · on device'
        : receipt.resolvedProvider === 'gemini'
          ? `Google Gemini · ${receipt.resolvedModel}`
          : receipt.resolvedProvider,
    }
    renderReceipt()
  })
}

init()

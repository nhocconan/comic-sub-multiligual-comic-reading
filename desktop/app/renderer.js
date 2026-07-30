'use strict'

const $ = (selector) => document.querySelector(selector)
const $$ = (selector) => [...document.querySelectorAll(selector)]
let state
let activeTab = 'reader'
let latestReceipt = null
let toastTimer

const routeNames = { ask: 'Chưa chọn route', local: 'Trên máy này', paired: 'Máy tính của tôi', managed: 'Comic Sub cloud', byo: 'Máy tính + external AI' }
const languages = { 'vi-VN': 'Vietnamese', 'en-US': 'English', 'fr-FR': 'French' }
const escapeHtml = (value) => String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show')
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 3400)
}

function routeNeedsChoice() { return !state.settings.route || state.settings.route === 'ask' }
function readerRouteText() { return `${state.settings.targetLanguage.startsWith('vi') ? 'VI' : state.settings.targetLanguage.slice(0, 2).toUpperCase()} · ${routeNames[state.settings.route] || routeNames.ask}` }

function renderState() {
  $('#private-toggle').classList.toggle('enabled', state.privateSession)
  $('#private-toggle').innerHTML = `<span class="private-dot"></span>${state.privateSession ? 'Private · progress not saved' : 'Private session'}`
  $('#language-label').textContent = `Chinese → ${languages[state.settings.targetLanguage] || state.settings.targetLanguage}`
  $('#route-summary').textContent = routeNames[state.settings.route] || routeNames.ask
  $('#route-chip').textContent = readerRouteText()
  $('#history-value').textContent = state.privateSession ? 'Ephemeral' : 'Local'
  $('#target-language').value = state.settings.targetLanguage
  $('#profile').value = state.settings.profile
  $('#default-route').value = state.settings.route
  $('#broker-endpoint').value = state.settings.brokerEndpoint || 'http://127.0.0.1:4100'
  $('#model-id').value = state.settings.model || 'gemini-3.6-flash'
  $('#token-status').textContent = state.settings.tokenConfigured ? 'Token đã được mã hóa trong credential store của hệ điều hành.' : 'Token không được đồng bộ giữa thiết bị.'
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
  if (routeNeedsChoice()) { $('#route-chooser').hidden = false; $('#route-chooser').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return }
  $('#queue-status').innerHTML = '<span class="pulse"></span><span>Đang gửi snapshot đã xác nhận đến broker…</span>'
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
  ensureRoute('translate-current')
}

function updateReaderStatus(payload) {
  if (!payload) return
  if (payload.type === 'snapshot') {
    $('#candidate-count').textContent = payload.candidateCount || '—'
    $('#snapshot-value').textContent = `${payload.candidateCount || 0} images`
    $('#session-title').textContent = payload.title || 'Chương đang đọc'
    $('#session-detail').textContent = payload.candidateCount ? 'Ảnh đã được chụp snapshot. Dịch chỉ chạy khi bạn bấm.' : 'Không thấy ảnh truyện đủ lớn trên trang này.'
  }
  if (payload.type === 'queue') {
    $('#queue-status').innerHTML = `<span class="pulse"></span><span>Đang dịch ${payload.done + 1}/${payload.total} · ${payload.queued} đang chờ</span>`
    $('#queue-value').textContent = `${payload.done}/${payload.total}`
  }
  if (payload.type === 'job-complete') {
    $('#queue-status').innerHTML = '<span class="pulse done"></span><span>Bản dịch đã sẵn sàng · chạm Original để so sánh</span>'
    $('#queue-value').textContent = 'Complete'
  }
}

function bind() {
  $('#address-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const raw = $('#address-input').value.trim(); if (!raw) return
    try { await window.comicSub.navigate(raw); setTab('reader'); toast('Đang mở trang trong Comic Sub…') } catch (error) { toast(error.message || 'URL không hợp lệ.') }
  })
  $('#back-button').addEventListener('click', () => window.comicSub.readerCommand({ type: 'back' }))
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
  $('#profile').addEventListener('change', (event) => saveSettings({ profile: event.target.value }))
  $('#default-route').addEventListener('change', (event) => saveSettings({ route: event.target.value }))
  $('#broker-endpoint').addEventListener('change', (event) => saveSettings({ brokerEndpoint: event.target.value }))
  $('#model-id').addEventListener('change', (event) => saveSettings({ model: event.target.value, modelProvenance: 'user-pinned' }))
  $('#save-token').addEventListener('click', async () => { try { const result = await window.comicSub.setToken($('#provider-token').value); $('#provider-token').value = ''; state.settings.tokenConfigured = result.tokenConfigured; renderState(); toast('Token đã được lưu trong credential store.') } catch (error) { toast(error.message) } })
  $('#add-term-form').addEventListener('submit', async (event) => { event.preventDefault(); state.glossary = await window.comicSub.addTerm($('#term-input').value); $('#term-input').value = ''; renderGlossary() })
  $('#library-list').addEventListener('click', async (event) => { const resumeId = event.target.dataset.resume; const deleteId = event.target.dataset.delete; if (resumeId) { const item = state.history.find((entry) => entry.id === resumeId); await window.comicSub.resume(item); setTab('reader') } if (deleteId) { state.history = await window.comicSub.clearHistory(deleteId); renderLibrary() } })
  $$('#migration-banner [data-choice]').forEach((button) => button.addEventListener('click', async () => { state = await window.comicSub.chooseModelMigration(button.dataset.choice); renderState(); toast('Thiết lập model đã được cập nhật.') }))
  window.addEventListener('resize', syncReaderBounds)
}

async function init() {
  state = await window.comicSub.getState()
  bind(); renderState(); setTab('reader'); requestAnimationFrame(syncReaderBounds)
  window.comicSub.on('reader:status', updateReaderStatus)
  window.comicSub.on('app:navigation', ({ url }) => { $('#address-input').value = url })
  window.comicSub.on('app:history', (history) => { state.history = history; renderLibrary() })
  window.comicSub.on('app:reader-crashed', () => toast('Reader đã dừng. Bạn có thể thử mở lại chương này.'))
  window.comicSub.on('app:broker-receipt', (receipt) => { latestReceipt = { id: receipt.jobId, route: receipt.route, language: state.settings.targetLanguage, model: receipt.resolvedModel, image: receipt.route === 'managed' ? 'Comic Sub cloud' : 'My computer', text: receipt.resolvedProvider === 'gemini' ? `Google Gemini · ${receipt.resolvedModel}` : receipt.resolvedProvider }; renderReceipt() })
}

init()

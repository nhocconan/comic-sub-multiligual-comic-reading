'use strict'

const $ = (selector) => document.querySelector(selector)
const $$ = (selector) => [...document.querySelectorAll(selector)]
let state
let activeTab = 'reader'
let latestReceipt = null
let toastTimer
let pendingTranslationCommand = null
let pendingRetranslation = false
let providerModels = []
let lastSnapshotStatus = null
let lastActivityStatus = null
const panelPreferences = {
  sidebar: localStorage.getItem('mangaSub.panel.sidebar') || 'auto',
  inspector: localStorage.getItem('mangaSub.panel.inspector') || 'hidden',
}

const messages = {
  en: {
    addressFormAria: 'Open a comic chapter', back: 'Back', addressPlaceholder: 'Paste a chapter URL…', open: 'Open',
    navigation: 'Navigation', read: 'Read', library: 'Library', settings: 'Settings', privateSession: 'Private session',
    change: 'Change', translateCurrent: 'Translate current view', translateAllLoaded: 'Translate all loaded images',
    retranslateWithAnother: 'Translate all again with Cloud / API',
    stopQueue: 'Stop current queue', waitingForPage: 'Waiting for a comic page…',
    whereTranslate: 'Where should this chapter be translated?', onThisMac: 'On this Mac',
    localRouteDetail: 'Private · Apple Vision + Translation', cloudRouteDetail: 'Fastest · try it without an account',
    yourApiKey: 'Your API key', byoRouteDetail: 'Local OCR · only recognized text leaves this Mac',
    routeTransparency: 'See exactly where your data goes before translation starts.',
    familiarNames: 'Use familiar character names?',
    continuityDetail: 'Manga Sub can look up the series title and selected language from approved sources. Images, OCR text, chapter URLs, and reading history are never sent.',
    useResearch: 'Use research sources', localOnly: 'Keep it on this Mac', embeddedReader: 'Embedded comic reader',
    sessionTitle: 'One page at a time.', sessionDetail: 'Paste a URL or open the sample chapter to begin.',
    noReceipt: 'No jobs yet. Each translation receipt shows the route used and where data was processed.',
    openSample: 'Open the licensed sample chapter →', libraryTitle: 'Continue exactly where you stopped.',
    libraryDetail: 'Reading history stays on this device. Private sessions are never saved.',
    preferencesTitle: 'Quality, language, and privacy.', preferencesDetail: 'Model and token controls only appear in advanced settings.',
    appLanguage: 'App language', sourceLanguage: 'Source language', targetLanguage: 'Target language',
    translationProfile: 'Translation profile', translationLocation: 'Translation location', defaultRoute: 'Default route',
    savedTranslations: 'Saved translated chapters', saveNone: 'None', saveFive: 'Latest 5', saveTen: 'Latest 10',
    savedTranslationsHint: 'Only translated text and OCR positions are saved, never comic images. Storage is capped at 2 MiB.',
    askEachTime: 'Ask each time', routeHint: 'Automatic mode only uses routes you approved. The app never silently switches to cloud.',
    detectAutomatically: 'Detect automatically', automatic: 'Automatic', english: 'English', vietnamese: 'Vietnamese',
    chinese: 'Chinese', chineseSimplified: 'Chinese (Simplified)', chineseTraditional: 'Chinese (Traditional)',
    japanese: 'Japanese', korean: 'Korean', french: 'French', spanish: 'Spanish', german: 'German',
    portuguese: 'Portuguese', indonesian: 'Indonesian',
    tokenPlaceholder: 'Paste a token to update it', saveToken: 'Save token to credential store',
    keyPlaceholder: 'Paste a key to update it', saveKey: 'Save key to credential store',
    modelPlaceholder: 'Refresh the catalog or enter a model ID',
    catalogHint: 'The catalog comes directly from the provider; Manga Sub does not pin a model list.',
    seriesNames: 'Names used in this series', termPlaceholder: 'Original name = Preferred name', add: 'Add',
    newEngine: 'A newer Balanced engine is available',
    engineDetail: 'Your previous setting used Gemini 3.5 Flash. Saved pages stay unchanged; new translations may read differently.',
    useNewBalanced: 'Use the new Balanced engine', keepGemini: 'Keep Gemini 3.5', later: 'Later',
    showControls: 'Show controls', hideControls: 'Hide controls', controlsTitle: 'Show or hide controls',
    showInspector: 'Show session details', hideInspector: 'Hide session details', inspectorTitle: 'Show or hide session details',
    routeNotSelected: 'Route not selected', privateProgress: 'Private · progress not saved', ephemeral: 'Ephemeral', local: 'Local',
    tokenStored: 'Token is encrypted in the operating system credential store.', tokenNotSynced: 'Tokens are not synced between devices.',
    keyStored: 'The key is encrypted in the operating system credential store.', keyNotSynced: 'Keys are not synced between devices.',
    noHistory: 'No reading history yet. Chapters are saved after you read or translate them.',
    imageProgress: 'Image {current}/{total}', translated: 'Translated', original: 'Original', continue: 'Continue',
    noGlossary: 'No glossary yet. Local Continuity Memory adds terms after the first translation.',
    preparing: 'Preparing the confirmed page…', jobReceipt: 'JOB RECEIPT', copyId: 'Copy ID',
    image: 'Image', translatedText: 'Translated text', model: 'Model', route: 'Route',
    routeMatched: 'Requested / resolved: matched', diagnosticCopied: 'Safe diagnostic ID copied.',
    routeChosen: '{route} selected. You can always change it before translating.',
    currentChapter: 'Current chapter', snapshotReady: 'Comic images are ready. Translation starts only when you click.',
    noComicImages: 'No sufficiently large comic images were found on this page.',
    images: '{count} images', translatingQueue: 'Translated {done}/{total} · {queued} remaining',
    ocr: 'Reading text on this Mac · images are not uploaded to cloud',
    queued: 'Text detected · waiting for translation', translating: 'Translating recognized text in one batch',
    translatingLocal: 'Apple Translation is processing the batch on this Mac',
    rendering: 'Preparing the text layer on this Mac', processing: 'Processing · {state}',
    ready: 'Translation ready · select Original to compare', complete: 'Complete',
    failed: 'Translation failed; original images remain visible.', stopped: 'Stopped',
    queueStopped: 'Queue stopped; original images remain visible.', opening: 'Opening the page in Manga Sub…',
    invalidUrl: 'Invalid URL.', openingSample: 'Opening the licensed sample chapter.',
    privateOn: 'Private session is on. Progress will not be saved.', privateOff: 'Returned to a regular session.',
    researchAllowed: 'Only the normalized title and target language are used for research.',
    continuityLocal: 'This series will only use Local Continuity Memory.',
    tokenSaved: 'Token saved to the credential store.', keySaved: 'API key saved to the credential store.',
    keyRemoved: 'API key removed.', fetchingCatalog: 'Fetching the catalog directly from the provider…',
    modelCount: '{count} text models · updated {time}', balancedSuggested: 'Balanced recommends {model}',
    catalogUpdated: 'Catalog updated.', modelUpdated: 'Model setting updated.',
    readerStopped: 'The reader stopped. You can reopen this chapter.',
    thisMac: 'This Mac', appleOnDevice: 'Apple Translation · on device',
    brokerConnection: 'Broker connection', provider: 'Provider', apiBaseUrl: 'API base URL', apiKey: 'API key',
    refreshCatalog: 'Refresh model catalog', reader: 'Reader', yourLibrary: 'YOUR LIBRARY', preferences: 'PREFERENCES',
    translation: 'TRANSLATION', whereItRuns: 'WHERE IT RUNS', seriesMemory: 'SERIES MEMORY', thisSession: 'THIS SESSION',
    snapshot: 'SNAPSHOT', queue: 'QUEUE', history: 'HISTORY', idle: 'Idle', engineUpdate: 'ENGINE UPDATE',
    brokerEndpoint: 'Broker endpoint', brokerToken: 'Broker token',
    failedLabel: 'Failed',
  },
  vi: {
    addressFormAria: 'Mở một chương truyện', back: 'Quay lại', addressPlaceholder: 'Dán link chương truyện…', open: 'Mở',
    navigation: 'Điều hướng', read: 'Đọc', library: 'Thư viện', settings: 'Cài đặt', privateSession: 'Phiên riêng tư',
    change: 'Đổi', translateCurrent: 'Dịch phần đang đọc', translateAllLoaded: 'Dịch tất cả ảnh đã tải',
    retranslateWithAnother: 'Dịch lại tất cả bằng Cloud / API',
    stopQueue: 'Dừng hàng đợi hiện tại', waitingForPage: 'Đang chờ trang truyện…',
    whereTranslate: 'Dịch chương này ở đâu?', onThisMac: 'Trên máy Mac này',
    localRouteDetail: 'Riêng tư · Apple Vision + Translation', cloudRouteDetail: 'Nhanh nhất · dùng thử không cần tài khoản',
    yourApiKey: 'API key của bạn', byoRouteDetail: 'OCR tại máy · chỉ văn bản đã nhận diện rời khỏi máy',
    routeTransparency: 'Luôn xem chính xác dữ liệu đi đâu trước khi dịch.',
    familiarNames: 'Dùng tên nhân vật quen thuộc?',
    continuityDetail: 'Manga Sub có thể tra tên series và ngôn ngữ đã chọn từ nguồn được duyệt. Ảnh, OCR, URL chương và lịch sử đọc không được gửi đi.',
    useResearch: 'Dùng nguồn tra cứu', localOnly: 'Chỉ dùng trên máy', embeddedReader: 'Trình đọc truyện nhúng',
    sessionTitle: 'Một trang, một nhịp đọc.', sessionDetail: 'Dán link hoặc mở chương mẫu để bắt đầu.',
    noReceipt: 'Chưa có job nào. Mỗi biên nhận dịch cho biết route thực tế và nơi dữ liệu được xử lý.',
    openSample: 'Mở chương mẫu được cấp phép →', libraryTitle: 'Đọc tiếp, đúng nơi bạn dừng lại.',
    libraryDetail: 'Lịch sử nằm trên thiết bị này. Phiên riêng tư không được lưu.',
    preferencesTitle: 'Chất lượng, ngôn ngữ và quyền riêng tư.', preferencesDetail: 'Model và token chỉ hiện trong phần nâng cao.',
    appLanguage: 'Ngôn ngữ ứng dụng', sourceLanguage: 'Ngôn ngữ nguồn', targetLanguage: 'Ngôn ngữ đích',
    translationProfile: 'Chế độ dịch', translationLocation: 'Nơi xử lý bản dịch', defaultRoute: 'Route mặc định',
    savedTranslations: 'Lưu chương đã dịch', saveNone: 'Không lưu', saveFive: '5 chương gần nhất', saveTen: '10 chương gần nhất',
    savedTranslationsHint: 'Chỉ lưu chữ dịch và vị trí OCR, không lưu ảnh truyện. Dung lượng bị giới hạn ở 2 MiB.',
    askEachTime: 'Hỏi mỗi lần', routeHint: 'Chế độ tự động chỉ dùng route bạn đã duyệt. Ứng dụng không tự chuyển sang cloud.',
    detectAutomatically: 'Tự nhận diện', automatic: 'Tự động', english: 'Tiếng Anh', vietnamese: 'Tiếng Việt',
    chinese: 'Tiếng Trung', chineseSimplified: 'Tiếng Trung (Giản thể)', chineseTraditional: 'Tiếng Trung (Phồn thể)',
    japanese: 'Tiếng Nhật', korean: 'Tiếng Hàn', french: 'Tiếng Pháp', spanish: 'Tiếng Tây Ban Nha',
    german: 'Tiếng Đức', portuguese: 'Tiếng Bồ Đào Nha', indonesian: 'Tiếng Indonesia',
    tokenPlaceholder: 'Dán token để cập nhật', saveToken: 'Lưu token vào kho bảo mật',
    keyPlaceholder: 'Dán key để cập nhật', saveKey: 'Lưu key vào kho bảo mật',
    modelPlaceholder: 'Làm mới catalog hoặc nhập model ID',
    catalogHint: 'Catalog được lấy trực tiếp từ provider; Manga Sub không ghim cứng danh sách model.',
    seriesNames: 'Tên dùng trong series này', termPlaceholder: 'Tên gốc = Tên ưu tiên', add: 'Thêm',
    newEngine: 'Đã có Balanced engine mới hơn',
    engineDetail: 'Thiết lập cũ dùng Gemini 3.5 Flash. Trang đã lưu không đổi; bản dịch mới có thể khác.',
    useNewBalanced: 'Dùng Balanced mới', keepGemini: 'Giữ Gemini 3.5', later: 'Để sau',
    showControls: 'Hiện thanh công cụ', hideControls: 'Ẩn thanh công cụ', controlsTitle: 'Ẩn hoặc hiện thanh công cụ',
    showInspector: 'Hiện thông tin phiên', hideInspector: 'Ẩn thông tin phiên', inspectorTitle: 'Ẩn hoặc hiện thông tin phiên',
    routeNotSelected: 'Chưa chọn route', privateProgress: 'Riêng tư · không lưu tiến độ', ephemeral: 'Tạm thời', local: 'Cục bộ',
    tokenStored: 'Token đã được mã hóa trong kho bảo mật của hệ điều hành.', tokenNotSynced: 'Token không được đồng bộ giữa thiết bị.',
    keyStored: 'Key đã được mã hóa trong kho bảo mật của hệ điều hành.', keyNotSynced: 'Key không được đồng bộ giữa thiết bị.',
    noHistory: 'Chưa có lịch sử. Chương sẽ được lưu sau khi bạn đọc hoặc dịch.',
    imageProgress: 'Ảnh {current}/{total}', translated: 'Đã dịch', original: 'Bản gốc', continue: 'Tiếp tục',
    noGlossary: 'Chưa có thuật ngữ. Local Continuity Memory sẽ bổ sung sau bản dịch đầu tiên.',
    preparing: 'Đang chuẩn bị trang đã xác nhận…', jobReceipt: 'BIÊN NHẬN JOB', copyId: 'Copy ID',
    image: 'Ảnh', translatedText: 'Văn bản dịch', model: 'Model', route: 'Route',
    routeMatched: 'Yêu cầu / thực tế: khớp', diagnosticCopied: 'Đã copy safe diagnostic ID.',
    routeChosen: 'Đã chọn {route}. Bạn luôn có thể đổi trước khi dịch.',
    currentChapter: 'Chương đang đọc', snapshotReady: 'Ảnh truyện đã sẵn sàng. Dịch chỉ chạy khi bạn bấm.',
    noComicImages: 'Không thấy ảnh truyện đủ lớn trên trang này.',
    images: '{count} ảnh', translatingQueue: 'Đã dịch {done}/{total} · còn {queued} ảnh',
    ocr: 'Đang đọc chữ trên máy · ảnh không được tải lên cloud',
    queued: 'Đã đọc chữ · đang xếp hàng dịch', translating: 'Đang dịch văn bản theo một lô',
    translatingLocal: 'Apple Translation đang dịch cả lô ngay trên máy',
    rendering: 'Đang chuẩn bị lớp chữ trên máy', processing: 'Đang xử lý · {state}',
    ready: 'Bản dịch đã sẵn sàng · chọn Bản gốc để so sánh', complete: 'Hoàn tất',
    failed: 'Dịch thất bại; ảnh gốc vẫn giữ nguyên.', stopped: 'Đã dừng',
    queueStopped: 'Đã dừng hàng đợi; ảnh gốc vẫn giữ nguyên.', opening: 'Đang mở trang trong Manga Sub…',
    invalidUrl: 'URL không hợp lệ.', openingSample: 'Đang mở chương mẫu được cấp phép.',
    privateOn: 'Phiên riêng tư đang bật. Tiến độ sẽ không được lưu.', privateOff: 'Đã quay về phiên bình thường.',
    researchAllowed: 'Chỉ title chuẩn hóa và ngôn ngữ đích được dùng để tra cứu.',
    continuityLocal: 'Series này chỉ dùng Local Continuity Memory.',
    tokenSaved: 'Token đã được lưu trong kho bảo mật.', keySaved: 'API key đã được lưu trong kho bảo mật.',
    keyRemoved: 'API key đã được xóa.', fetchingCatalog: 'Đang lấy catalog trực tiếp từ provider…',
    modelCount: '{count} model văn bản · cập nhật {time}', balancedSuggested: 'Balanced đề xuất {model}',
    catalogUpdated: 'Catalog đã cập nhật.', modelUpdated: 'Thiết lập model đã được cập nhật.',
    readerStopped: 'Reader đã dừng. Bạn có thể mở lại chương này.',
    thisMac: 'Máy Mac này', appleOnDevice: 'Apple Translation · trên thiết bị',
    brokerConnection: 'Kết nối broker', provider: 'Nhà cung cấp', apiBaseUrl: 'API base URL', apiKey: 'API key',
    refreshCatalog: 'Làm mới catalog model', reader: 'Trình đọc', yourLibrary: 'THƯ VIỆN', preferences: 'TÙY CHỌN',
    translation: 'BẢN DỊCH', whereItRuns: 'NƠI XỬ LÝ', seriesMemory: 'BỘ NHỚ SERIES', thisSession: 'PHIÊN NÀY',
    snapshot: 'ẢNH ĐÃ TẢI', queue: 'HÀNG ĐỢI', history: 'LỊCH SỬ', idle: 'Rảnh', engineUpdate: 'CẬP NHẬT ENGINE',
    brokerEndpoint: 'Địa chỉ broker', brokerToken: 'Token broker',
    failedLabel: 'Thất bại',
  },
}

function uiLanguage() {
  return state?.settings?.uiLanguage === 'vi' ? 'vi' : 'en'
}

function t(key, values = {}) {
  const template = messages[uiLanguage()][key] || messages.en[key] || key
  return Object.entries(values).reduce((result, [name, value]) => result.replaceAll(`{${name}}`, String(value)), template)
}

function applyLocalization() {
  document.documentElement.lang = uiLanguage()
  $$('[data-i18n]').forEach((node) => { node.textContent = t(node.dataset.i18n) })
  $$('[data-i18n-placeholder]').forEach((node) => { node.placeholder = t(node.dataset.i18nPlaceholder) })
  $$('[data-i18n-title]').forEach((node) => { node.title = t(node.dataset.i18nTitle) })
  $$('[data-i18n-aria-label]').forEach((node) => { node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel)) })
}

function routeName(route) {
  return { ask: t('routeNotSelected'), local: t('onThisMac'), managed: 'Manga Sub Cloud', byo: t('yourApiKey') }[route] || t('routeNotSelected')
}

function targetLanguageName(code) {
  return t({
    'vi-VN': 'vietnamese', 'en-US': 'english', 'fr-FR': 'french', 'es-ES': 'spanish',
    'de-DE': 'german', 'pt-BR': 'portuguese', 'id-ID': 'indonesian', 'ja-JP': 'japanese',
    'ko-KR': 'korean', 'zh-CN': 'chineseSimplified', 'zh-TW': 'chineseTraditional',
  }[code] || code)
}

function sourceLanguageName(code) {
  return t({ auto: 'automatic', 'zh-Hans': 'chinese', 'zh-Hant': 'chinese', ja: 'japanese', ko: 'korean', en: 'english' }[code] || code)
}

function failureMessage(payload = {}) {
  const raw = String(payload.message || '').trim()
  if (uiLanguage() === 'vi') return raw || t('failed')
  const englishByCode = {
    INVALID_BROKER_ENDPOINT: 'Remote brokers must use HTTPS. HTTP is only allowed on localhost.',
    ASSET_TOO_LARGE: 'This image exceeds the 32 MiB limit.',
    NAVIGATION_CHANGED: 'The page changed while translating. Scan the current page and try again.',
    READER_UNAVAILABLE: 'The embedded reader is no longer available. Reopen the chapter.',
    SAMPLE_MODE_ONLY: 'The sample chapter is for UI testing. Open an HTTP(S) chapter to translate.',
    IMAGE_REDIRECT_DENIED: 'The image redirected to an unapproved URL.',
    IMAGE_FETCH_FAILED: 'Manga Sub could not fetch the registered image.',
    UNSUPPORTED_ASSET_TYPE: 'Only JPEG, PNG, and WebP comic images are supported.',
    ASSET_TYPE_MISMATCH: 'The image bytes do not match its declared format.',
    NATIVE_OCR_UNAVAILABLE: 'Local OCR is not available in this build.',
    SNAPSHOT_MISSING: 'The current page snapshot is no longer valid. Scan the page and try again.',
    BYO_KEY_REQUIRED: 'Save an API key for this provider before translating.',
    BYO_MODEL_REQUIRED: 'Refresh the provider catalog and choose a model before translating.',
    BYO_KEY_INVALID: 'The provider rejected this API key.',
    BYO_TIMEOUT: 'The provider took too long to respond.',
    BYO_NETWORK_ERROR: 'Manga Sub could not connect to the provider.',
    BYO_OUTPUT_INVALID: 'The provider returned an incomplete translation batch.',
    MODEL_MISMATCH: 'The broker could not verify the resolved model, so the queue stopped.',
    CANCELLED: 'Translation was cancelled.',
  }
  if (englishByCode[payload.code]) return englishByCode[payload.code]
  if (raw && !/[À-ỹ]/u.test(raw)) return raw
  return `${t('failed')}${payload.code ? ` (${payload.code})` : ''}`
}
const escapeHtml = (value) => String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show')
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 3400)
}

function routeNeedsChoice() { return !state.settings.route || state.settings.route === 'ask' }
function readerRouteText() { return `${state.settings.targetLanguage.slice(0, 2).toUpperCase()} · ${routeName(state.settings.route)}` }

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
  $('#toggle-sidebar').setAttribute('aria-label', sidebarHidden ? t('showControls') : t('hideControls'))
  $('#toggle-sidebar').title = t('controlsTitle')
  $('#toggle-inspector').setAttribute('aria-pressed', String(!inspectorHidden))
  $('#toggle-inspector').setAttribute('aria-label', inspectorHidden ? t('showInspector') : t('hideInspector'))
  $('#toggle-inspector').title = t('inspectorTitle')
  requestAnimationFrame(syncReaderBounds)
}

function togglePanel(name) {
  panelPreferences[name] = panelIsHidden(name) ? 'shown' : 'hidden'
  localStorage.setItem(`mangaSub.panel.${name}`, panelPreferences[name])
  applyPanelLayout()
}

function renderState() {
  applyLocalization()
  $('#private-toggle').classList.toggle('enabled', state.privateSession)
  $('#private-toggle').innerHTML = `<span class="private-dot"></span>${state.privateSession ? t('privateProgress') : t('privateSession')}`
  $('#language-label').textContent = `${sourceLanguageName(state.settings.sourceLanguage)} → ${targetLanguageName(state.settings.targetLanguage)}`
  $('#route-summary').textContent = routeName(state.settings.route)
  $('#route-chip').textContent = readerRouteText()
  $('#history-value').textContent = state.privateSession ? t('ephemeral') : t('local')
  $('#ui-language').value = uiLanguage()
  $('#target-language').value = state.settings.targetLanguage
  $('#source-language').value = state.settings.sourceLanguage || 'auto'
  $('#profile').value = state.settings.profile
  $('#translation-cache-limit').value = String(state.settings.translationCacheLimit ?? 10)
  $('#default-route').value = state.settings.route
  $('#broker-endpoint').value = state.settings.brokerEndpoint || 'http://127.0.0.1:4100'
  $('#token-status').textContent = state.settings.tokenConfigured ? t('tokenStored') : t('tokenNotSynced')
  $('#byo-provider').value = state.settings.byoProvider || 'gemini'
  $('#byo-base-url').value = state.settings.byoBaseUrl || 'https://api.deepseek.com/v1'
  $('#byo-base-row').hidden = state.settings.byoProvider !== 'openai-compatible'
  $('#byo-model').value = state.settings.byoModel || ''
  $('#byo-key-status').textContent = state.settings.byoKeyConfigured
    ? t('keyStored')
    : t('keyNotSynced')
  $('#byo-model-options').innerHTML = providerModels
    .map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name || model.id)}</option>`)
    .join('')
  $('#migration-banner').hidden = !state.needsModelChoice
  renderLibrary(); renderGlossary(); renderReceipt()
  if (lastSnapshotStatus) updateReaderStatus(lastSnapshotStatus, false)
  if (lastActivityStatus) updateReaderStatus(lastActivityStatus, false)
  applyPanelLayout()
}

function renderLibrary() {
  const list = $('#library-list')
  if (!state.history.length) { list.innerHTML = `<div class="empty-list">${t('noHistory')}</div>`; return }
  list.innerHTML = state.history.map((item) => `<article class="history-row"><div><p class="eyebrow">${escapeHtml(item.origin)}</p><h2>${escapeHtml(item.title)}</h2><p>${t('imageProgress', { current: Number(item.candidateIndex || 0) + 1, total: item.candidateCount || '—' })} · ${item.translated ? t('translated') : t('original')} · ${new Date(item.updatedAt).toLocaleDateString(uiLanguage() === 'vi' ? 'vi-VN' : 'en-US')}</p></div><div class="history-actions"><button data-resume="${escapeHtml(item.id)}">${t('continue')}</button><button data-delete="${escapeHtml(item.id)}" class="danger">×</button></div></article>`).join('')
}

function renderGlossary() {
  $('#glossary-list').innerHTML = state.glossary.length ? state.glossary.map((term) => `<span>${escapeHtml(term.value)} <em>${term.source === 'user' ? 'manual' : 'local'}</em></span>`).join('') : `<p class="hint">${t('noGlossary')}</p>`
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
  $('#queue-status').innerHTML = `<span class="pulse"></span><span>${t('preparing')}</span>`
  window.comicSub.readerCommand({ type: command })
  if (state.glossaryConsent === null && !state.privateSession) $('#continuity-card').hidden = false
}

function renderReceipt() {
  if (!latestReceipt) return
  $('#retranslate-current').hidden = false
  const imageLocation = latestReceipt.route === 'managed' ? 'Manga Sub Cloud' : t('thisMac')
  const translatedBy = latestReceipt.local
    ? t('appleOnDevice')
    : latestReceipt.provider === 'gemini'
      ? `Google Gemini · ${latestReceipt.model}`
      : latestReceipt.provider
  $('#copy-diagnostic').disabled = false
  $('#receipt-card').innerHTML = `<div class="receipt-title"><span>${t('jobReceipt')}</span><button id="copy-diagnostic">${t('copyId')}</button></div><dl><div><dt>${t('image')}</dt><dd>${escapeHtml(imageLocation)}</dd></div><div><dt>${t('translatedText')}</dt><dd>${escapeHtml(translatedBy)}</dd></div><div><dt>${t('model')}</dt><dd>${escapeHtml(latestReceipt.model)}</dd></div><div><dt>${t('route')}</dt><dd>${t('routeMatched')}</dd></div></dl><p class="receipt-id">${latestReceipt.id}</p>`
  $('#copy-diagnostic').addEventListener('click', async () => { await window.comicSub.copyDiagnostic(latestReceipt); toast(t('diagnosticCopied')) })
}

async function chooseRoute(route) {
  await saveSettings({ route })
  $('#route-chooser').hidden = true
  toast(t('routeChosen', { route: routeName(route) }))
  const command = pendingTranslationCommand
  const shouldRetranslate = pendingRetranslation
  pendingTranslationCommand = null
  pendingRetranslation = false
  if (shouldRetranslate) {
    await window.comicSub.readerCommand({ type: 'reset-translations' })
  }
  if (command) ensureRoute(command)
}

function updateReaderStatus(payload, remember = true) {
  if (!payload) return
  if (remember) {
    if (payload.type === 'snapshot') lastSnapshotStatus = payload
    else if (['queue', 'broker-progress', 'job-complete', 'broker-failure', 'broker-cancelled'].includes(payload.type)) lastActivityStatus = payload
  }
  if (payload.type === 'snapshot') {
    $('#candidate-count').textContent = payload.candidateCount || '—'
    $('#snapshot-value').textContent = t('images', { count: payload.candidateCount || 0 })
    $('#session-title').textContent = payload.title || t('currentChapter')
    $('#session-detail').textContent = payload.candidateCount ? t('snapshotReady') : t('noComicImages')
  }
  if (payload.type === 'route-required') {
    ensureRoute(payload.command || 'translate-current')
  }
  if (payload.type === 'queue') {
    $('#queue-status').innerHTML = `<span class="pulse"></span><span>${t('translatingQueue', { done: payload.done, total: payload.total, queued: payload.queued })}</span>`
    $('#queue-value').textContent = `${payload.done}/${payload.total}`
  }
  if (payload.type === 'broker-progress') {
    const labels = {
      OCR: t('ocr'),
      QUEUED: t('queued'),
      TRANSLATING: t('translating'),
      TRANSLATING_LOCAL: t('translatingLocal'),
      PROCESSING: t('translating'),
      RENDERING: t('rendering'),
    }
    const label = labels[payload.state] || t('processing', { state: payload.state || 'working' })
    $('#queue-status').innerHTML = `<span class="pulse"></span><span>${label}</span>`
    $('#queue-value').textContent = payload.state === 'OCR' ? 'Local OCR' : 'Text only'
  }
  if (payload.type === 'job-complete') {
    $('#queue-status').innerHTML = `<span class="pulse done"></span><span>${t('ready')}</span>`
    $('#queue-value').textContent = t('complete')
  }
  if (payload.type === 'broker-failure') {
    $('#queue-status').innerHTML = `<span class="pulse"></span><span>${escapeHtml(failureMessage(payload))}</span>`
    $('#queue-value').textContent = t('failedLabel')
  }
  if (payload.type === 'broker-cancelled') {
    $('#queue-status').innerHTML = `<span class="pulse"></span><span>${t('queueStopped')}</span>`
    $('#queue-value').textContent = t('stopped')
  }
}

function bind() {
  $('#address-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const raw = $('#address-input').value.trim(); if (!raw) return
    try { await window.comicSub.navigate(raw); setTab('reader'); toast(t('opening')) } catch (error) { toast(error.message || t('invalidUrl')) }
  })
  $('#back-button').addEventListener('click', () => window.comicSub.readerCommand({ type: 'back' }))
  $('#toggle-sidebar').addEventListener('click', () => togglePanel('sidebar'))
  $('#toggle-inspector').addEventListener('click', () => togglePanel('inspector'))
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.tab)))
  $('#translate-current').addEventListener('click', () => ensureRoute('translate-current'))
  $('#translate-all').addEventListener('click', () => ensureRoute('open-all-confirm'))
  $('#retranslate-current').addEventListener('click', () => {
    pendingTranslationCommand = 'translate-all-now'
    pendingRetranslation = true
    $('#route-chooser').hidden = false
    $('#route-chooser').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  })
  $('#cancel-translation').addEventListener('click', () => window.comicSub.readerCommand({ type: 'pause' }))
  $('#change-route').addEventListener('click', () => { $('#route-chooser').hidden = !$('#route-chooser').hidden })
  $$('#route-chooser [data-route]').forEach((button) => button.addEventListener('click', () => chooseRoute(button.dataset.route)))
  $('#open-sample').addEventListener('click', async () => { $('#address-input').value = ''; await window.comicSub.openSample(); toast(t('openingSample')) })
  $('#private-toggle').addEventListener('click', async () => { state = await window.comicSub.setPrivate(!state.privateSession); renderState(); toast(state.privateSession ? t('privateOn') : t('privateOff')) })
  $('#lookup-accept').addEventListener('click', async () => { state.glossaryConsent = await window.comicSub.setGlossaryConsent('allowed'); $('#continuity-card').hidden = true; toast(t('researchAllowed')) })
  $('#lookup-decline').addEventListener('click', async () => { state.glossaryConsent = await window.comicSub.setGlossaryConsent('local-only'); $('#continuity-card').hidden = true; toast(t('continuityLocal')) })
  $('#ui-language').addEventListener('change', (event) => saveSettings({ uiLanguage: event.target.value }))
  $('#target-language').addEventListener('change', (event) => saveSettings({ targetLanguage: event.target.value }))
  $('#source-language').addEventListener('change', (event) => saveSettings({ sourceLanguage: event.target.value }))
  $('#profile').addEventListener('change', (event) => saveSettings({ profile: event.target.value }))
  $('#translation-cache-limit').addEventListener('change', (event) => saveSettings({ translationCacheLimit: Number(event.target.value) }))
  $('#default-route').addEventListener('change', (event) => saveSettings({ route: event.target.value }))
  $('#broker-endpoint').addEventListener('change', (event) => saveSettings({ brokerEndpoint: event.target.value }))
  $('#save-token').addEventListener('click', async () => { try { const result = await window.comicSub.setToken($('#provider-token').value); $('#provider-token').value = ''; state.settings.tokenConfigured = result.tokenConfigured; renderState(); toast(t('tokenSaved')) } catch (error) { toast(error.message) } })
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
      toast(result.keyConfigured ? t('keySaved') : t('keyRemoved'))
    } catch (error) { toast(error.message) }
  })
  $('#refresh-models').addEventListener('click', async () => {
    const button = $('#refresh-models')
    button.disabled = true
    $('#byo-model-status').textContent = t('fetchingCatalog')
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
      $('#byo-model-status').textContent = t('modelCount', { count: providerModels.length, time: new Date(catalog.fetchedAt).toLocaleTimeString(uiLanguage() === 'vi' ? 'vi-VN' : 'en-US') })
      toast(catalog.recommended ? t('balancedSuggested', { model: catalog.recommended }) : t('catalogUpdated'))
    } catch (error) {
      $('#byo-model-status').textContent = error.message
      toast(error.message)
    } finally {
      button.disabled = false
    }
  })
  $('#add-term-form').addEventListener('submit', async (event) => { event.preventDefault(); state.glossary = await window.comicSub.addTerm($('#term-input').value); $('#term-input').value = ''; renderGlossary() })
  $('#library-list').addEventListener('click', async (event) => { const resumeId = event.target.dataset.resume; const deleteId = event.target.dataset.delete; if (resumeId) { const item = state.history.find((entry) => entry.id === resumeId); await window.comicSub.resume(item); setTab('reader') } if (deleteId) { state.history = await window.comicSub.clearHistory(deleteId); renderLibrary() } })
  $$('#migration-banner [data-choice]').forEach((button) => button.addEventListener('click', async () => { state = await window.comicSub.chooseModelMigration(button.dataset.choice); renderState(); toast(t('modelUpdated')) }))
  window.addEventListener('resize', applyPanelLayout)
  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault()
      $('#address-input').focus()
      $('#address-input').select()
    }
  })
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
  window.comicSub.on('app:reader-crashed', () => toast(t('readerStopped')))
  window.comicSub.on('app:broker-receipt', (receipt) => {
    const local = receipt.route === 'local'
    latestReceipt = {
      id: receipt.jobId,
      route: receipt.route,
      language: state.settings.targetLanguage,
      model: receipt.resolvedModel,
      local,
      provider: receipt.resolvedProvider,
    }
    renderReceipt()
  })
}

init()

'use strict'

const { ipcRenderer } = require('electron')

let candidates = []
let activeIndex = 0
let sourceVisible = false
let ui
let openedAt = Date.now()
let hasAdvanced = false
let readerUiLanguage = 'en'
const navigationId = `nav:${crypto.randomUUID()}`
let snapshotId = `snapshot:${crypto.randomUUID()}`
const liveOverlays = new Set()
const overlayLayers = new Map()
let overlayRelayoutFrame = 0

const readerMessages = {
  en: {
    finding: 'Finding comic images…',
    original: 'Original',
    translated: 'Translated',
    all: 'All',
    translate: 'Translate',
    sample: 'Sample mode · broker disabled',
    imagesReady: '{count} images ready',
    noImages: 'No comic images found',
    confirmTitle: 'Translate {count} loaded images?',
    confirmDetail: 'New images that appear while you read will wait. Managed cloud jobs are capped at USD 0.50.',
    keepReading: 'Keep reading',
    confirmTranslate: 'Translate {count}',
    alreadyTranslated: 'Current images are already translated',
    preparing: 'Preparing {count} translation jobs…',
    stopping: 'Stopping jobs…',
    progress: '{state} · {count} images',
    translatedCount: 'Translated {done}/{total}',
    jobFailed: 'Translation failed',
    cancelled: 'Jobs cancelled · original remains visible',
  },
  vi: {
    finding: 'Đang tìm ảnh truyện…',
    original: 'Bản gốc',
    translated: 'Bản dịch',
    all: 'Tất cả',
    translate: 'Dịch',
    sample: 'Chế độ mẫu · broker bị tắt',
    imagesReady: '{count} ảnh sẵn sàng',
    noImages: 'Không tìm thấy ảnh truyện',
    confirmTitle: 'Dịch {count} ảnh đã tải?',
    confirmDetail: 'Ảnh mới xuất hiện khi đọc sẽ chờ lượt sau. Job Manga Sub Cloud được giới hạn ở 0,50 USD.',
    keepReading: 'Đọc tiếp',
    confirmTranslate: 'Dịch {count} ảnh',
    alreadyTranslated: 'Các ảnh hiện tại đã được dịch',
    preparing: 'Đang chuẩn bị {count} job dịch…',
    stopping: 'Đang dừng job…',
    progress: '{state} · {count} ảnh',
    translatedCount: 'Đã dịch {done}/{total}',
    jobFailed: 'Dịch thất bại',
    cancelled: 'Đã hủy job · ảnh gốc vẫn hiển thị',
  },
}

function readerText(key, values = {}) {
  const template = readerMessages[readerUiLanguage][key] || readerMessages.en[key] || key
  return Object.entries(values).reduce(
    (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
    template,
  )
}

function refreshReaderUi() {
  if (!ui?.root?.isConnected) return
  ui.current.textContent = readerText('translate')
  ui.all.textContent = readerText('all')
  ui.reveal.textContent = sourceVisible ? readerText('translated') : readerText('original')
}

function idFor(index) { return `cs-candidate-${index}` }
function safeText(value) { return String(value || '').replace(/[<>]/g, '').slice(0, 120) }
function safeOverlayText(value) { return String(value || '').replace(/[<>]/g, '').slice(0, 2_000) }
function imageSource(image) {
  const direct = image.currentSrc
    || image.src
    || image.getAttribute?.('src')
    || image.getAttribute?.('data-src')
    || image.getAttribute?.('data-original')
    || image.getAttribute?.('data-lazy-src')
  if (direct) return direct
  const background = getComputedStyle(image).backgroundImage
  const match = /^url\((['"]?)(.*?)\1\)$/.exec(background || '')
  return match?.[2] || ''
}
function ensureAmpImage(ampImage) {
  if (ampImage.tagName !== 'AMP-IMG' || ampImage.querySelector(':scope > img.comic-sub-amp-fallback')) return
  const source = imageSource(ampImage)
  if (!source) return
  // Some AMP pages leave only the sized host in Electron and never attach the
  // internal image. Preserve the site's layout while rendering its declared
  // source through a normal browser image element.
  const fallback = document.createElement('img')
  fallback.className = 'comic-sub-amp-fallback'
  fallback.src = source
  fallback.alt = ampImage.getAttribute('alt') || ''
  fallback.referrerPolicy = 'strict-origin-when-cross-origin'
  fallback.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block'
  ampImage.append(fallback)
}
function imageElements() {
  // Keep discovery adapter-based rather than site-specific: native responsive
  // images, AMP hosts, common lazy-load attributes, and CSS-backed page art.
  const ampImages = [...document.querySelectorAll('amp-img')]
  for (const ampImage of ampImages) ensureAmpImage(ampImage)
  const nativeImages = [...document.images].filter((image) => !image.closest('amp-img'))
  const lazyImages = [...document.querySelectorAll('[data-src],[data-original],[data-lazy-src]')]
  const backgroundImages = [...document.querySelectorAll('[style*="background-image"]')]
  return [...new Set([...nativeImages, ...ampImages, ...lazyImages, ...backgroundImages])]
}

function createUi() {
  if (ui?.root?.isConnected) return ui
  const style = document.createElement('style')
  style.textContent = `
    #comic-sub-float{position:fixed;right:20px;bottom:22px;z-index:2147483647;display:flex;align-items:center;gap:6px;padding:7px;border:1px solid rgba(255,255,255,.16);border-radius:15px;background:rgba(14,16,19,.82);box-shadow:0 14px 44px rgba(0,0,0,.45);backdrop-filter:blur(18px);font:12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f4f1e9}
    #comic-sub-float .mark{display:grid;place-items:center;width:25px;height:25px;border-radius:9px;background:#d6ff4e;color:#10140a;font-weight:900}#comic-sub-float button{border:0;border-radius:9px;padding:8px 10px;background:transparent;color:#f4f1e9;cursor:pointer;font:inherit;font-weight:700}#comic-sub-float button:hover{background:rgba(255,255,255,.11)}#comic-sub-float .primary{background:#d6ff4e;color:#11150a}#comic-sub-float .primary:hover{background:#ecff9a}#comic-sub-float .status{max-width:130px;color:#b8c0ba;padding:0 4px}#comic-sub-confirm{position:fixed;right:20px;bottom:78px;z-index:2147483647;width:300px;padding:16px;border:1px solid rgba(255,255,255,.16);border-radius:16px;background:#171a1e;color:#f4f1e9;box-shadow:0 20px 60px rgba(0,0,0,.6);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}#comic-sub-confirm h3{margin:0 0 8px;font-size:15px}#comic-sub-confirm p{margin:0 0 12px;color:#b8c0ba}.cs-actions{display:flex;gap:8px}.cs-actions button{border:0;border-radius:9px;padding:8px 10px;font:inherit;font-weight:700;cursor:pointer}.cs-actions .go{background:#d6ff4e;color:#11150a}.cs-actions .cancel{background:#2a2e34;color:#f4f1e9}.comic-sub-overlay-layer{position:absolute;z-index:2;overflow:hidden;pointer-events:none;contain:strict}.comic-sub-overlay{position:absolute;display:grid;place-items:center;box-sizing:border-box;padding:3px;border:0;border-radius:6px;background:rgba(255,253,245,.96);color:#141812;text-align:center;font:700 17px/1.12 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:none;pointer-events:auto;cursor:help;overflow:hidden;overflow-wrap:anywhere;word-break:normal;text-wrap:balance}.comic-sub-source{opacity:.15!important}
  `
  document.documentElement.append(style)
  const root = document.createElement('aside')
  root.id = 'comic-sub-float'
  root.innerHTML = `<span class="mark">M</span><span class="status">${readerText('finding')}</span><button class="reveal">${readerText('original')}</button><button class="all">${readerText('all')}</button><button class="primary current">${readerText('translate')}</button>`
  ;(document.body || document.documentElement).append(root)
  const result = {
    root,
    status: root.querySelector('.status'),
    current: root.querySelector('.current'),
    all: root.querySelector('.all'),
    reveal: root.querySelector('.reveal'),
  }
  result.current.addEventListener('click', () => startVisible())
  result.all.addEventListener('click', () => openAllConfirm())
  result.reveal.addEventListener('click', () => toggleSource())
  ui = result
  return result
}

function isComicImage(image) {
  const rect = image.getBoundingClientRect()
  const text = `${image.className} ${image.id} ${image.alt || ''}`
  return rect.width >= 220 && rect.height >= 260 && !/(avatar|logo|icon|banner|thumb|recommend)/i.test(text)
}

function scan() {
  const previousBySource = new Map(candidates.map((candidate) => [candidate.sourceUrl, candidate]))
  const seenSources = new Set()
  const found = imageElements()
    .filter(isComicImage)
    .filter((image) => {
      // Local sample pages intentionally use file: assets. Real pages may only
      // contribute http(s) assets: the broker must never be handed data:, blob:
      // or extension-owned URLs that it cannot safely retrieve and validate.
      if (location.protocol === 'file:') return true
      try {
        const protocol = new URL(imageSource(image), location.href).protocol
        return protocol === 'http:' || protocol === 'https:'
      } catch {
        return false
      }
    })
    .filter((image) => {
      try {
        const sourceUrl = new URL(imageSource(image), location.href).href
        return seenSources.has(sourceUrl) ? false : Boolean(seenSources.add(sourceUrl))
      } catch {
        return false
      }
    })
    .slice(0, 200)
  candidates = found.map((image, index) => {
    const rect = image.getBoundingClientRect()
    const sourceUrl = new URL(imageSource(image), location.href).href
    const previous = previousBySource.get(sourceUrl)
    const declaredWidth = Number(image.getAttribute?.('width')) || 0
    const declaredHeight = Number(image.getAttribute?.('height')) || 0
    return {
      id: idFor(index), candidateId: `candidate:${navigationId}:${index}`, index, image, sourceUrl,
      status: previous?.status ?? 'ready', translated: previous?.translated ?? false,
      renderedRect: { x: Math.round(rect.left), y: Math.round(rect.top + window.scrollY), width: Math.round(rect.width), height: Math.round(rect.height) },
      intrinsicWidth: image.naturalWidth || declaredWidth || Math.round(rect.width),
      intrinsicHeight: image.naturalHeight || declaredHeight || Math.round(rect.height),
    }
  })
  const activeCandidateIds = new Set(candidates.map((candidate) => candidate.candidateId))
  for (const [candidateId, layer] of overlayLayers) {
    if (!activeCandidateIds.has(candidateId)) {
      layer.remove()
      overlayLayers.delete(candidateId)
    }
  }
  snapshotId = `snapshot:${crypto.randomUUID()}`
  const isTestMode = location.protocol === 'file:'
  createUi().status.textContent = isTestMode
    ? readerText('sample')
    : candidates.length
      ? readerText('imagesReady', { count: candidates.length })
      : readerText('noImages')
  const snapshot = {
    protocolVersion: { major: 1, minor: 0 }, snapshotId, navigationId,
    topFrameOrigin: location.protocol === 'file:' ? 'https://sample.invalid' : location.origin,
    pageUrl: location.href, createdAt: new Date().toISOString(), title: document.title, isTestMode,
    candidates: candidates.map((item) => ({
      candidateId: item.candidateId, frameId: 'top', domOrdinal: item.index, sourceUrl: item.sourceUrl,
      sourceOrigin: new URL(item.sourceUrl).origin, renderedRect: item.renderedRect,
      intrinsicWidth: item.intrinsicWidth, intrinsicHeight: item.intrinsicHeight,
      acquisitionCapabilities: ['source-blob'],
    })),
  }
  ipcRenderer.send('reader:status', { type: 'snapshot', snapshot, candidateCount: candidates.length, title: document.title, candidateIndex: activeIndex })
  observeReading()
  return candidates
}

function observeReading() {
  window.removeEventListener('scroll', reportAnchor)
  window.addEventListener('scroll', reportAnchor, { passive: true })
  setTimeout(() => reportAnchor(true), 10_000)
}

function reportAnchor(afterActiveThreshold = false) {
  if (!candidates.length) return
  if (Math.abs(window.scrollY) > 120) hasAdvanced = true
  if (!hasAdvanced && !afterActiveThreshold && Date.now() - openedAt < 10_000) return
  const middle = window.innerHeight * .46
  const closest = candidates.reduce((best, item) => Math.abs(item.image.getBoundingClientRect().top - middle) < Math.abs(best.image.getBoundingClientRect().top - middle) ? item : best, candidates[0])
  activeIndex = closest.index
  ipcRenderer.send('reader:status', { type: 'progress-anchor', candidateIndex: activeIndex, candidateCount: candidates.length, title: document.title })
}

function openAllConfirm() {
  scan()
  const old = document.querySelector('#comic-sub-confirm')
  if (old) old.remove()
  const count = candidates.length
  const panel = document.createElement('section')
  panel.id = 'comic-sub-confirm'
  panel.innerHTML = `<h3>${readerText('confirmTitle', { count })}</h3><p>${readerText('confirmDetail')}</p><div class="cs-actions"><button class="cancel">${readerText('keepReading')}</button><button class="go">${readerText('confirmTranslate', { count })}</button></div>`
  document.body.append(panel)
  panel.querySelector('.cancel').addEventListener('click', () => panel.remove())
  panel.querySelector('.go').addEventListener('click', () => { panel.remove(); startAll() })
}

function startVisible() {
  scan()
  const visible = candidates.filter((item) => {
    const rect = item.image.getBoundingClientRect()
    return rect.bottom > 0 && rect.top < window.innerHeight
  })
  requestBroker('visible', (visible.length ? visible : candidates.slice(activeIndex, activeIndex + 2)).filter((item) => !item.translated))
}

function startAll() { scan(); requestBroker('all', candidates.filter((item) => !item.translated)) }

function requestBroker(scope, items) {
  if (!items.length) {
    createUi().status.textContent = readerText('alreadyTranslated')
    ipcRenderer.send('reader:status', {
      type: 'job-complete',
      alreadyTranslated: true,
      candidateIndex: activeIndex,
      candidateCount: candidates.length,
      title: document.title,
    })
    return
  }
  createUi().status.textContent = readerText('preparing', { count: items.length })
  ipcRenderer.send('reader:status', { type: 'translate-request', scope, snapshotId, navigationId, candidateIds: items.map((item) => item.candidateId) })
}

function currentOverlayItem(descriptor) {
  return candidates.find((candidate) => candidate.candidateId === descriptor.candidateId)
    || candidates.find((candidate) => candidate.index === descriptor.index && candidate.sourceUrl === descriptor.sourceUrl)
    || descriptor.item
}

function normalizedRegion(region) {
  const x = Number(region?.x)
  const y = Number(region?.y)
  const width = Number(region?.width)
  const height = Number(region?.height)
  const translation = safeOverlayText(region?.translation).trim()
  if (![x, y, width, height].every(Number.isFinite) || width <= 1 || height <= 1 || !translation) return null
  return { ...region, x, y, width, height, translation }
}

function regionIou(left, right) {
  const x1 = Math.max(left.x, right.x)
  const y1 = Math.max(left.y, right.y)
  const x2 = Math.min(left.x + left.width, right.x + right.width)
  const y2 = Math.min(left.y + left.height, right.y + right.height)
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  if (!intersection) return 0
  return intersection / (left.width * left.height + right.width * right.height - intersection)
}

function canonicalRegions(regions) {
  const accepted = []
  for (const region of (regions || []).map(normalizedRegion).filter(Boolean)) {
    const duplicate = accepted.some((other) => {
      const sameText = other.translation.toLocaleLowerCase() === region.translation.toLocaleLowerCase()
      const nearSameBox = regionIou(other, region) >= .72
      return nearSameBox && (sameText || regionIou(other, region) >= .9)
    })
    if (!duplicate) accepted.push(region)
  }
  return accepted
}

function fitOverlayText(overlay, maximumFontSize) {
  let low = 7
  let high = Math.max(low, maximumFontSize)
  let fitted = low
  while (high - low > .45) {
    const next = (low + high) / 2
    overlay.style.fontSize = `${next}px`
    if (overlay.scrollWidth <= overlay.clientWidth + 1 && overlay.scrollHeight <= overlay.clientHeight + 1) {
      fitted = next
      low = next
    } else {
      high = next
    }
  }
  overlay.style.fontSize = `${Math.max(7, fitted)}px`
}

function overlayLayer(item) {
  let layer = overlayLayers.get(item.candidateId)
  if (layer?.isConnected) return layer
  layer = document.createElement('div')
  layer.className = 'comic-sub-overlay-layer'
  layer.dataset.comicSubCandidate = item.candidateId
  document.documentElement.append(layer)
  overlayLayers.set(item.candidateId, layer)
  return layer
}

function layoutOverlay(overlay, descriptor) {
  const item = currentOverlayItem(descriptor)
  const image = item.image
  if (!image?.isConnected) return
  const imageRect = image.getBoundingClientRect()
  if (imageRect.width <= 1 || imageRect.height <= 1) return
  const layer = overlayLayer(item)
  layer.style.left = `${imageRect.left + window.scrollX}px`
  layer.style.top = `${imageRect.top + window.scrollY}px`
  layer.style.width = `${imageRect.width}px`
  layer.style.height = `${imageRect.height}px`
  layer.hidden = imageRect.bottom <= 0 || imageRect.top >= window.innerHeight
  if (overlay.parentElement !== layer) layer.append(overlay)
  const { region, page } = descriptor
  const pageWidth = Number(page?.width) || image.naturalWidth || Number(image.getAttribute?.('width')) || image.clientWidth
  const pageHeight = Number(page?.height) || image.naturalHeight || Number(image.getAttribute?.('height')) || image.clientHeight
  const scaleX = imageRect.width / pageWidth
  const scaleY = imageRect.height / pageHeight
  const rawWidth = Math.max(24, Number(region.width) * scaleX)
  const rawHeight = Math.max(18, Number(region.height) * scaleY)
  // Keep desktop dialogue comfortably readable without letting a long line
  // dominate the panel at narrow side-by-side window sizes.
  const maximumFontSize = Math.max(11, Math.min(21, rawHeight * .72, imageRect.width / 34))
  // Geometry belongs to the source bubble. It may grow only by a small,
  // bounded margin. The dedicated layer clips every pixel at the image edge,
  // independent of the source site's DOM nesting.
  const width = Math.min(imageRect.width, rawWidth * 1.18)
  const centerX = (Number(region.x) + Number(region.width) / 2) * scaleX
  const left = Math.max(0, Math.min(imageRect.width - width, centerX - width / 2))
  const height = Math.min(imageRect.height, rawHeight * 1.28)
  const centerY = (Number(region.y) + Number(region.height) / 2) * scaleY
  const top = Math.max(0, Math.min(imageRect.height - height, centerY - height / 2))
  overlay.style.left = `${left}px`
  overlay.style.top = `${top}px`
  overlay.style.width = `${width}px`
  overlay.style.height = `${height}px`
  overlay.style.fontSize = `${maximumFontSize}px`
  overlay.style.lineHeight = '1.12'
  overlay.style.padding = `${Math.max(3, maximumFontSize * .16)}px`
  overlay.style.transform = `rotate(${Number(region.rotation) || 0}deg)`
  fitOverlayText(overlay, maximumFontSize)
}

function scheduleOverlayRelayout() {
  if (overlayRelayoutFrame) return
  overlayRelayoutFrame = requestAnimationFrame(() => {
    overlayRelayoutFrame = 0
    for (const overlay of liveOverlays) {
      if (!overlay.isConnected) { liveOverlays.delete(overlay); continue }
      layoutOverlay(overlay, overlay.__comicSubDescriptor)
    }
  })
}

function renderOverlay(item, region, page) {
  const overlay = document.createElement('span')
  overlay.className = 'comic-sub-overlay'
  overlay.textContent = safeOverlayText(region.translation)
  overlay.title = safeOverlayText(region.translation)
  overlay.__comicSubDescriptor = {
    item,
    candidateId: item.candidateId,
    index: item.index,
    sourceUrl: item.sourceUrl,
    region,
    page,
  }
  liveOverlays.add(overlay)
  layoutOverlay(overlay, overlay.__comicSubDescriptor)
  return overlay
}

function toggleSource() {
  sourceVisible = !sourceVisible
  for (const overlay of document.querySelectorAll('.comic-sub-overlay')) overlay.hidden = sourceVisible
  createUi().reveal.textContent = sourceVisible ? readerText('translated') : readerText('original')
}

ipcRenderer.on('reader:command', (_event, command = {}) => {
  if (command.type === 'ui-language') {
    readerUiLanguage = command.language === 'vi' ? 'vi' : 'en'
    refreshReaderUi()
  }
  if (command.type === 'scan') scan()
  if (command.type === 'translate-current') startVisible()
  if (command.type === 'translate-all-now') startAll()
  if (command.type === 'translate-all' || command.type === 'open-all-confirm') openAllConfirm()
  if (command.type === 'pause') { ipcRenderer.send('reader:status', { type: 'translate-cancel' }); createUi().status.textContent = readerText('stopping') }
  if (command.type === 'reveal-original') toggleSource()
  if (command.type === 'broker-progress' && command.state) createUi().status.textContent = readerText('progress', { state: command.state, count: candidates.length })
  if (command.type === 'attach-result') {
    const item = candidates.find((candidate) => candidate.candidateId === command.candidateId)
    if (!item) return
    const layer = overlayLayers.get(item.candidateId)
    for (const overlay of layer?.querySelectorAll?.(`[data-comic-sub-job="${command.jobId}"]`) || []) {
      liveOverlays.delete(overlay)
      overlay.remove()
    }
    for (const region of canonicalRegions(command.result?.overlayRegions)) {
      const overlay = renderOverlay(item, region, command.result.page)
      overlay.dataset.comicSubJob = command.jobId
    }
    item.translated = true; item.status = 'done'
    createUi().status.textContent = readerText('translatedCount', {
      done: candidates.filter((candidate) => candidate.translated).length,
      total: candidates.length,
    })
    ipcRenderer.send('reader:status', { type: 'job-complete', candidateIndex: activeIndex, candidateCount: candidates.length, title: document.title })
  }
  if (command.type === 'broker-failure') createUi().status.textContent = command.message || readerText('jobFailed')
  if (command.type === 'broker-cancelled') createUi().status.textContent = readerText('cancelled')
  if (command.type === 'resume') {
    scan(); const item = candidates[Number(command.candidateIndex) || 0]
    item?.image.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
})

window.addEventListener('DOMContentLoaded', () => setTimeout(scan, 120))
window.addEventListener('resize', scheduleOverlayRelayout, { passive: true })
window.addEventListener('scroll', scheduleOverlayRelayout, { passive: true, capture: true })
window.addEventListener('load', scheduleOverlayRelayout, true)
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(scheduleOverlayRelayout).observe(document.documentElement)
}

'use strict'

const { ipcRenderer } = require('electron')

let candidates = []
let activeIndex = 0
let sourceVisible = false
let ui
let openedAt = Date.now()
let hasAdvanced = false
const navigationId = `nav:${crypto.randomUUID()}`
let snapshotId = `snapshot:${crypto.randomUUID()}`

function idFor(index) { return `cs-candidate-${index}` }
function safeText(value) { return String(value || '').replace(/[<>]/g, '').slice(0, 120) }
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
    #comic-sub-float .mark{display:grid;place-items:center;width:25px;height:25px;border-radius:9px;background:#d6ff4e;color:#10140a;font-weight:900}#comic-sub-float button{border:0;border-radius:9px;padding:8px 10px;background:transparent;color:#f4f1e9;cursor:pointer;font:inherit;font-weight:700}#comic-sub-float button:hover{background:rgba(255,255,255,.11)}#comic-sub-float .primary{background:#d6ff4e;color:#11150a}#comic-sub-float .primary:hover{background:#ecff9a}#comic-sub-float .status{max-width:130px;color:#b8c0ba;padding:0 4px}#comic-sub-confirm{position:fixed;right:20px;bottom:78px;z-index:2147483647;width:300px;padding:16px;border:1px solid rgba(255,255,255,.16);border-radius:16px;background:#171a1e;color:#f4f1e9;box-shadow:0 20px 60px rgba(0,0,0,.6);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}#comic-sub-confirm h3{margin:0 0 8px;font-size:15px}#comic-sub-confirm p{margin:0 0 12px;color:#b8c0ba}.cs-actions{display:flex;gap:8px}.cs-actions button{border:0;border-radius:9px;padding:8px 10px;font:inherit;font-weight:700;cursor:pointer}.cs-actions .go{background:#d6ff4e;color:#11150a}.cs-actions .cancel{background:#2a2e34;color:#f4f1e9}.comic-sub-overlay{position:absolute;z-index:2147483000;display:grid;place-items:center;box-sizing:border-box;padding:7px;border:1px solid rgba(13,18,11,.14);border-radius:10px;background:rgba(250,250,238,.96);color:#141812;text-align:center;font:700 17px/1.18 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 1px 8px rgba(0,0,0,.15);pointer-events:none;overflow-wrap:anywhere}.comic-sub-host{position:relative!important}.comic-sub-source{opacity:.19!important;filter:blur(1px)!important}
  `
  document.documentElement.append(style)
  const root = document.createElement('aside')
  root.id = 'comic-sub-float'
  root.innerHTML = '<span class="mark">C</span><span class="status">Finding comic images…</span><button class="reveal">Original</button><button class="all">All</button><button class="primary current">Translate</button>'
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
    .slice(0, 200)
  candidates = found.map((image, index) => {
    const rect = image.getBoundingClientRect()
    const sourceUrl = new URL(imageSource(image), location.href).href
    const declaredWidth = Number(image.getAttribute?.('width')) || 0
    const declaredHeight = Number(image.getAttribute?.('height')) || 0
    return {
      id: idFor(index), candidateId: `candidate:${navigationId}:${index}`, index, image, sourceUrl,
      status: 'ready', translated: false,
      renderedRect: { x: Math.round(rect.left), y: Math.round(rect.top + window.scrollY), width: Math.round(rect.width), height: Math.round(rect.height) },
      intrinsicWidth: image.naturalWidth || declaredWidth || Math.round(rect.width),
      intrinsicHeight: image.naturalHeight || declaredHeight || Math.round(rect.height),
    }
  })
  snapshotId = `snapshot:${crypto.randomUUID()}`
  const isTestMode = location.protocol === 'file:'
  createUi().status.textContent = isTestMode ? 'Sample mode · broker disabled' : candidates.length ? `${candidates.length} images ready` : 'No comic images found'
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
  panel.innerHTML = `<h3>Translate ${count} loaded images?</h3><p>New images that appear while you read will wait. Managed cloud jobs are capped at USD 0.50.</p><div class="cs-actions"><button class="cancel">Keep reading</button><button class="go">Translate ${count}</button></div>`
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
  if (!items.length) { createUi().status.textContent = 'No images waiting'; return }
  createUi().status.textContent = `Preparing ${items.length} broker jobs…`
  ipcRenderer.send('reader:status', { type: 'translate-request', scope, snapshotId, navigationId, candidateIds: items.map((item) => item.candidateId) })
}

function renderOverlay(item, region, page) {
  const image = item.image
  const host = image.parentElement || image
  host.classList.add('comic-sub-host')
  const overlay = document.createElement('span')
  overlay.className = 'comic-sub-overlay'
  overlay.textContent = safeText(region.translation)
  // The host may contain a full long-scroll chapter, so position against this
  // image rather than assuming the image is the only child of its parent.
  const pageWidth = Number(page?.width) || image.naturalWidth || Number(image.getAttribute?.('width')) || image.clientWidth
  const pageHeight = Number(page?.height) || image.naturalHeight || Number(image.getAttribute?.('height')) || image.clientHeight
  const scaleX = image.clientWidth / pageWidth
  const scaleY = image.clientHeight / pageHeight
  const rawWidth = Math.max(40, Number(region.width) * scaleX)
  const rawHeight = Math.max(30, Number(region.height) * scaleY)
  const textLength = Math.max(1, overlay.textContent.length)
  const imageFont = Math.max(17, Math.min(32, image.clientWidth / 36))
  const lengthFactor = Math.min(1, Math.sqrt(54 / textLength))
  const fontSize = Math.max(17, imageFont * lengthFactor)
  // OCR boxes tightly wrap source glyphs. Give translated prose breathing room
  // around the same center, while clamping it to the source image.
  const desiredWidth = Math.max(rawWidth * 1.2, Math.min(image.clientWidth * .46, fontSize * Math.max(7, Math.sqrt(textLength) * 2.25)))
  const width = Math.min(image.clientWidth, desiredWidth)
  const centerX = image.offsetLeft + (Number(region.x) + Number(region.width) / 2) * scaleX
  const left = Math.max(image.offsetLeft, Math.min(image.offsetLeft + image.clientWidth - width, centerX - width / 2))
  const estimatedLines = Math.max(1, Math.ceil((textLength * fontSize * .54) / Math.max(1, width - fontSize)))
  const height = Math.max(rawHeight * 1.12, estimatedLines * fontSize * 1.18 + fontSize * .65)
  const centerY = image.offsetTop + (Number(region.y) + Number(region.height) / 2) * scaleY
  const top = Math.max(image.offsetTop, Math.min(image.offsetTop + image.clientHeight - height, centerY - height / 2))
  overlay.style.left = `${left}px`
  overlay.style.top = `${top}px`
  overlay.style.width = `${width}px`
  overlay.style.minHeight = `${height}px`
  overlay.style.fontSize = `${fontSize}px`
  overlay.style.lineHeight = '1.18'
  overlay.style.padding = `${Math.max(7, fontSize * .28)}px`
  overlay.style.transform = `rotate(${Number(region.rotation) || 0}deg)`
  host.append(overlay)
}

function toggleSource() {
  sourceVisible = !sourceVisible
  for (const overlay of document.querySelectorAll('.comic-sub-overlay')) overlay.hidden = sourceVisible
  createUi().reveal.textContent = sourceVisible ? 'Translated' : 'Original'
}

ipcRenderer.on('reader:command', (_event, command = {}) => {
  if (command.type === 'scan') scan()
  if (command.type === 'translate-current') startVisible()
  if (command.type === 'translate-all-now') startAll()
  if (command.type === 'translate-all' || command.type === 'open-all-confirm') openAllConfirm()
  if (command.type === 'pause') { ipcRenderer.send('reader:status', { type: 'translate-cancel' }); createUi().status.textContent = 'Stopping jobs…' }
  if (command.type === 'reveal-original') toggleSource()
  if (command.type === 'broker-progress' && command.state) createUi().status.textContent = `${command.state} · ${candidates.length} images`
  if (command.type === 'attach-result') {
    const item = candidates.find((candidate) => candidate.candidateId === command.candidateId)
    if (!item) return
    for (const overlay of item.image.parentElement?.querySelectorAll?.(`[data-comic-sub-job="${command.jobId}"]`) || []) overlay.remove()
    for (const region of command.result?.overlayRegions || []) {
      renderOverlay(item, region, command.result.page)
      const overlay = item.image.parentElement?.lastElementChild
      if (overlay) overlay.dataset.comicSubJob = command.jobId
    }
    item.translated = true; item.status = 'done'
    createUi().status.textContent = `Translated ${candidates.filter((candidate) => candidate.translated).length}/${candidates.length}`
    ipcRenderer.send('reader:status', { type: 'job-complete', candidateIndex: activeIndex, candidateCount: candidates.length, title: document.title })
  }
  if (command.type === 'broker-failure') createUi().status.textContent = command.message || 'Broker job failed'
  if (command.type === 'broker-cancelled') createUi().status.textContent = 'Jobs cancelled · original remains visible'
  if (command.type === 'resume') {
    scan(); const item = candidates[Number(command.candidateIndex) || 0]
    item?.image.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
})

window.addEventListener('DOMContentLoaded', () => setTimeout(scan, 120))

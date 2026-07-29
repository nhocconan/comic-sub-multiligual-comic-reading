(function startBongBongContent() {
  'use strict'

  if (globalThis.__BONG_BONG_CONTENT__) {
    globalThis.__BONG_BONG_CONTENT__.scan()
    return
  }

  const core = globalThis.BongBongCore
  if (!core || !globalThis.chrome || !chrome.runtime) return

  const DEFAULT_SETTINGS = Object.freeze({
    targetLanguage: 'vi-VN',
    lookAhead: 2,
    autoTranslate: true,
  })
  const OWNED_SELECTOR = '.bb-overlay, .bb-control'
  const hostIds = new WeakMap()
  const candidates = new Map()
  const visibleIds = new Set()
  const queuedIds = new Set()
  const registeredIds = new Set()
  const grantedOrigins = new Set()
  const queue = []
  let nextId = 1
  let settings = { ...DEFAULT_SETTINGS }
  let pageUrl = location.href
  let paused = false
  let sourceRevealed = false
  let transientReveal = false
  let translationScope = 'visible'
  let activeCandidateId = null
  let activeTranslationRequest = null
  let cancellationPending = null
  let runToken = 0
  let scanScheduled = false
  let layoutScheduled = false
  let lastDetail = ''
  let intersectionObserver = null
  let mutationObserver = null
  let resizeObserver = null
  let control = null

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error: {
              code: 'RUNTIME_MESSAGE_FAILED',
              message: chrome.runtime.lastError.message,
              state: 'extension-error',
              retryable: true,
            },
          })
          return
        }
        resolve(response || { ok: false, error: { message: 'Không có phản hồi.' } })
      })
    })
  }

  function candidateCounts() {
    const counts = {
      total: candidates.size,
      ready: 0,
      processing: 0,
      done: 0,
      failed: 0,
      blocked: 0,
      excluded: 0,
      translatedRegions: 0,
      pagesWithoutText: 0,
    }

    for (const candidate of candidates.values()) {
      if (candidate.status === 'done') {
        counts.done += 1
        const translatedRegions = Array.isArray(candidate.regions)
          ? candidate.regions.filter(core.shouldRenderTranslationBox).length
          : 0
        counts.translatedRegions += translatedRegions
        if (translatedRegions === 0) counts.pagesWithoutText += 1
      }
      else if (candidate.status === 'processing') counts.processing += 1
      else if (candidate.status === 'failed') counts.failed += 1
      else if (candidate.status === 'blocked') counts.blocked += 1
      else if (candidate.status === 'excluded') counts.excluded += 1
      else counts.ready += 1
    }

    return counts
  }

  function publicCandidates() {
    return [...candidates.values()]
      .sort((left, right) => left.index - right.index)
      .map(core.publicCandidate)
  }

  function statusPayload() {
    const counts = candidateCounts()
    return {
      ok: true,
      candidates: publicCandidates(),
      origins: [...new Set([...candidates.values()].map((candidate) => candidate.origin))],
      counts,
      paused,
      sourceRevealed: sourceRevealed || transientReveal,
      detail: lastDetail,
    }
  }

  function createButton(className, label, text) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = className
    button.setAttribute('aria-label', label)
    button.textContent = text
    return button
  }

  function ensureControl() {
    if (control && control.root.isConnected) return control

    const root = document.createElement('aside')
    root.className = 'bb-control'
    root.setAttribute('aria-label', 'Điều khiển Comic Sub')

    const mark = document.createElement('span')
    mark.className = 'bb-control__mark'
    mark.setAttribute('aria-hidden', 'true')
    mark.textContent = 'B'

    const status = document.createElement('span')
    status.className = 'bb-control__status'
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    status.textContent = 'Đang quét ảnh…'

    const reveal = createButton(
      'bb-control__button bb-control__reveal',
      'Giữ hoặc bấm để xem ảnh gốc',
      'Gốc',
    )
    const pause = createButton(
      'bb-control__button bb-control__pause',
      'Tạm dừng dịch tự động',
      'Dừng',
    )
    const retry = createButton(
      'bb-control__button bb-control__retry',
      'Thử lại các trang bị lỗi',
      'Thử lại',
    )

    root.append(mark, status, reveal, pause, retry)
    ;(document.body || document.documentElement).append(root)
    control = { root, status, reveal, pause, retry }

    let revealStartedAt = 0
    let ignoreNextRevealClick = false
    const beginTemporaryReveal = (event) => {
      if (event.type === 'keydown' && event.key !== ' ' && event.key !== 'Enter') return
      if (event.type === 'keydown' && event.repeat) return
      if (event.type === 'keydown') event.preventDefault()
      if (event.type === 'pointerdown' && reveal.setPointerCapture) {
        reveal.setPointerCapture(event.pointerId)
      }
      revealStartedAt = performance.now()
      transientReveal = true
      applyReveal()
    }
    const finishTemporaryReveal = (event) => {
      if (event.type === 'keyup' && event.key !== ' ' && event.key !== 'Enter') return
      if (event.type === 'keyup') event.preventDefault()
      const held = performance.now() - revealStartedAt >= 260
      transientReveal = false
      if (!held && (event.type === 'pointerup' || event.type === 'keyup')) {
        sourceRevealed = !sourceRevealed
      }
      ignoreNextRevealClick = event.type === 'pointerup'
      applyReveal()
    }

    reveal.addEventListener('pointerdown', beginTemporaryReveal)
    reveal.addEventListener('pointerup', finishTemporaryReveal)
    reveal.addEventListener('pointercancel', () => {
      transientReveal = false
      applyReveal()
    })
    reveal.addEventListener('keydown', beginTemporaryReveal)
    reveal.addEventListener('keyup', finishTemporaryReveal)
    reveal.addEventListener('click', () => {
      if (ignoreNextRevealClick) {
        ignoreNextRevealClick = false
        return
      }
      sourceRevealed = !sourceRevealed
      transientReveal = false
      applyReveal()
    })
    addEventListener('blur', () => {
      transientReveal = false
      applyReveal()
    })
    pause.addEventListener('click', () => setPaused(!paused))
    retry.addEventListener('click', retryFailed)
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && (sourceRevealed || transientReveal)) {
        sourceRevealed = false
        transientReveal = false
        applyReveal()
      }
    })

    updateControl()
    return control
  }

  function updateControl() {
    const ui = ensureControl()
    const counts = candidateCounts()
    let text = 'Sẵn sàng'

    if (counts.total === 0) text = 'Không thấy trang truyện'
    else if (paused) text = `Đã dừng · ${counts.done}/${counts.total}`
    else if (counts.processing > 0) {
      const active = candidates.get(activeCandidateId)
      const progress = active && active.progress ? ` · ${active.progress}%` : ''
      text = `Đang dịch ${counts.done + 1}/${counts.total}${progress}`
    } else if (counts.failed > 0) {
      text = `${counts.done}/${counts.total} · lỗi ${counts.failed}`
    } else if (counts.blocked > 0 && counts.done === 0) {
      text = `Cần quyền ảnh · ${counts.blocked}`
    } else if (counts.done + counts.excluded === counts.total && counts.total > 0) {
      text = `Đã xử lý ${counts.done}/${counts.total} · ${counts.translatedRegions} ô chữ`
    } else {
      text = `${counts.total} ảnh · ${counts.done} xong · ${counts.translatedRegions} ô chữ`
    }

    ui.status.textContent = text
    ui.root.dataset.state =
      counts.failed > 0
        ? 'error'
        : counts.processing > 0
          ? 'working'
          : counts.done > 0
            ? 'success'
            : 'idle'
    ui.pause.textContent = paused ? 'Tiếp tục' : 'Dừng'
    ui.pause.setAttribute(
      'aria-label',
      paused ? 'Tiếp tục dịch tự động' : 'Tạm dừng dịch tự động',
    )
    ui.pause.setAttribute('aria-pressed', String(paused))
    ui.reveal.setAttribute(
      'aria-pressed',
      String(sourceRevealed || transientReveal),
    )
    ui.retry.hidden = counts.failed === 0
    chrome.runtime
      .sendMessage({ type: 'CONTENT_STATUS', status: statusPayload() })
      .catch(() => undefined)
  }

  function applyReveal() {
    const revealed = sourceRevealed || transientReveal
    for (const candidate of candidates.values()) {
      if (candidate.overlay) candidate.overlay.hidden = revealed
    }
    updateControl()
  }

  function removeOverlay(candidate) {
    if (!candidate || !candidate.overlay) return
    candidate.overlay.remove()
    candidate.overlay = null
    candidate.regionElements = []
  }

  function resetForNavigation() {
    runToken += 1
    if (activeCandidateId) {
      void sendRuntimeMessage({
        type: 'CANCEL_TRANSLATION',
        candidateId: activeCandidateId,
      })
    }
    void sendRuntimeMessage({ type: 'DEACTIVATE_TAB' })

    for (const candidate of candidates.values()) {
      intersectionObserver?.unobserve(candidate.host)
      resizeObserver?.unobserve(candidate.host)
      removeOverlay(candidate)
    }

    candidates.clear()
    visibleIds.clear()
    queuedIds.clear()
    registeredIds.clear()
    queue.length = 0
    activeCandidateId = null
    pageUrl = location.href
    lastDetail = ''
  }

  function mergeDiscovery(discovered) {
    const seen = new Set()

    for (const found of discovered) {
      let id = hostIds.get(found.host)
      if (!id) {
        id = `bb-${nextId}`
        nextId += 1
        hostIds.set(found.host, id)
      }
      seen.add(id)

      const existing = candidates.get(id)
      if (existing && existing.url !== found.url) {
        if (existing.status === 'processing') {
          void sendRuntimeMessage({ type: 'CANCEL_TRANSLATION', candidateId: id })
        }
        removeOverlay(existing)
        registeredIds.delete(id)
        queuedIds.delete(id)
      }

      let candidate
      if (existing && existing.url === found.url) {
        // Preserve object identity while a translation request is in flight.
        // Lazy readers can mutate src/data-src during processing; replacing the
        // object here leaves pumpQueue updating a detached stale candidate.
        Object.assign(existing, found, { id, index: found.index })
        candidate = existing
      } else {
        candidate = {
          ...found,
          id,
          index: found.index,
          status: 'detected',
          overlay: null,
          regionElements: [],
          page: null,
          regions: [],
          progress: null,
          error: null,
        }
      }
      candidates.set(id, candidate)
      intersectionObserver?.observe(found.host)
      resizeObserver?.observe(found.host)
    }

    for (const [id, candidate] of candidates) {
      if (seen.has(id) || candidate.host.isConnected) continue
      intersectionObserver?.unobserve(candidate.host)
      resizeObserver?.unobserve(candidate.host)
      removeOverlay(candidate)
      candidates.delete(id)
      visibleIds.delete(id)
      queuedIds.delete(id)
      registeredIds.delete(id)
    }
  }

  async function registerCandidates() {
    if (candidates.size === 0) return

    const response = await sendRuntimeMessage({
      type: 'REGISTER_CANDIDATES',
      candidates: [...candidates.values()]
        .sort((left, right) => left.index - right.index)
        .map(({ id, url, index }) => ({ id, url, index })),
    })

    if (!response.ok) {
      lastDetail = response.error?.message || 'Không thể đăng ký ảnh với tiện ích.'
      for (const candidate of candidates.values()) {
        if (candidate.status === 'detected') candidate.status = 'blocked'
      }
      updateControl()
      return
    }

    const deniedIds = new Set(
      Array.isArray(response.denied) ? response.denied.map((item) => item.id) : [],
    )
    const registeredResponseIds = new Set(
      Array.isArray(response.registered) ? response.registered : [],
    )
    const allowedCount = registeredResponseIds.size
    registeredIds.clear()

    for (const candidate of candidates.values()) {
      const explicitlyGranted =
        grantedOrigins.size === 0 || grantedOrigins.has(candidate.origin)
      if (
        registeredResponseIds.has(candidate.id) &&
        !deniedIds.has(candidate.id) &&
        explicitlyGranted
      ) {
        registeredIds.add(candidate.id)
        if (candidate.status === 'blocked' || candidate.status === 'detected') {
          candidate.status = 'ready'
        }
      } else if (!['done', 'processing', 'failed', 'excluded'].includes(candidate.status)) {
        candidate.status = 'blocked'
      }
    }

    if (allowedCount === 0 && candidates.size > 0) {
      lastDetail = 'Cấp quyền cho nguồn ảnh để bắt đầu dịch.'
    } else {
      lastDetail = ''
    }

    enqueueForCurrentScope()
    updateControl()
  }

  async function scan() {
    if (location.href !== pageUrl) resetForNavigation()

    const discovered = core.discoverCandidates(document, {
      baseUrl: document.baseURI,
      viewportWidth: innerWidth,
    })
    mergeDiscovery(discovered)
    layoutAllNow()
    updateControl()
    await registerCandidates()
    return statusPayload()
  }

  function scheduleScan() {
    if (scanScheduled) return
    scanScheduled = true
    requestAnimationFrame(() => {
      scanScheduled = false
      void scan()
    })
  }

  function enqueueCandidate(candidate) {
    if (
      paused ||
      !candidate ||
      !registeredIds.has(candidate.id) ||
      ['queued', 'processing', 'done', 'excluded'].includes(candidate.status)
    ) {
      return
    }

    candidate.status = 'queued'
    candidate.error = null
    if (!queuedIds.has(candidate.id)) {
      queue.push(candidate.id)
      queuedIds.add(candidate.id)
      sortQueueForReadingPosition()
    }
    void pumpQueue()
  }

  function readingAnchorIndex() {
    const visibleIndexes = [...visibleIds]
      .map((id) => candidates.get(id)?.index)
      .filter(Number.isFinite)
    return visibleIndexes.length > 0 ? Math.min(...visibleIndexes) : 0
  }

  function sortQueueForReadingPosition() {
    const anchor = readingAnchorIndex()
    const total = Math.max(1, candidates.size)
    queue.sort((leftId, rightId) => {
      const left = candidates.get(leftId)
      const right = candidates.get(rightId)
      const leftPriority = left
        ? core.readingPriorityIndex(left.index, total, anchor)
        : Infinity
      const rightPriority = right
        ? core.readingPriorityIndex(right.index, total, anchor)
        : Infinity
      return leftPriority - rightPriority
    })
  }

  function enqueueWindow(candidate) {
    const ordered = [...candidates.values()].sort((left, right) => left.index - right.index)
    const position = ordered.findIndex((item) => item.id === candidate.id)
    if (position < 0) return

    for (const index of core.orderedLookAheadIndexes(
      position,
      ordered.length,
      settings.lookAhead,
    )) {
      enqueueCandidate(ordered[index])
    }
  }

  function enqueueForCurrentScope(force = false) {
    if (paused || (!force && !settings.autoTranslate)) return
    const ordered = [...candidates.values()].sort((left, right) => left.index - right.index)

    if (translationScope === 'all') {
      for (const candidate of ordered) enqueueCandidate(candidate)
      return
    }

    for (const id of visibleIds) {
      const candidate = candidates.get(id)
      if (candidate) enqueueWindow(candidate)
    }
  }

  async function pumpQueue() {
    if (paused || activeCandidateId || cancellationPending) return

    // The reader may scroll while a page is processing. Re-rank immediately
    // before each job so the currently visible page wins over page 1.
    sortQueueForReadingPosition()
    let candidate = null
    while (queue.length > 0 && !candidate) {
      const id = queue.shift()
      queuedIds.delete(id)
      const possible = candidates.get(id)
      if (
        possible &&
        possible.status === 'queued' &&
        registeredIds.has(possible.id)
      ) {
        candidate = possible
      }
    }
    if (!candidate) {
      updateControl()
      return
    }

    const token = runToken
    activeCandidateId = candidate.id
    candidate.status = 'processing'
    candidate.progress = null
    updateControl()

    const request = sendRuntimeMessage({
      type: 'TRANSLATE_PAGE',
      candidateId: candidate.id,
      url: candidate.url,
      index: candidate.index,
      targetLanguage: settings.targetLanguage,
    })
    activeTranslationRequest = request
    const response = await request
    if (activeTranslationRequest === request) activeTranslationRequest = null

    if (token !== runToken || !candidates.has(candidate.id)) return

    activeCandidateId = null
    candidate.progress = null

    if (response.ok) {
      try {
        renderOverlay(
          candidate,
          response.page,
          response.regions,
          response.renderedDataUrl,
        )
        candidate.status = 'done'
        candidate.error = null
        lastDetail = response.providerFallback
          ? 'Gemini hết quota; đã tự chuyển sang DeepSeek V4 Flash.'
          : response.cacheHit
            ? 'Đã dùng bản dịch trong bộ nhớ đệm.'
            : ''
      } catch (error) {
        candidate.status = 'failed'
        candidate.error = {
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        }
        lastDetail = candidate.error.message
      }
    } else {
      candidate.status = 'failed'
      candidate.error = response.error || {
        message: 'Không thể dịch ảnh này.',
        retryable: true,
      }
      lastDetail = candidate.error.message
    }

    updateControl()
    void pumpQueue()
  }

  function renderOverlay(candidate, page, regions, renderedDataUrl) {
    const pageWidth = Number(page && page.width)
    const pageHeight = Number(page && page.height)
    if (!Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || pageWidth <= 0 || pageHeight <= 0) {
      throw new Error('Kích thước trang dịch không hợp lệ.')
    }

    const safeRegions = (Array.isArray(regions) ? regions : [])
      .slice(0, 300)
      .map((region) => core.normalizeRegion(region, page))
      .filter(Boolean)
    if (
      typeof renderedDataUrl !== 'string' ||
      !/^data:image\/(?:png|jpeg|webp);base64,/.test(renderedDataUrl)
    ) {
      throw new Error('Không thể dựng lớp ảnh nguồn an toàn.')
    }

    removeOverlay(candidate)
    const root = document.createElement('div')
    root.className = 'bb-overlay'
    root.setAttribute('aria-label', `Bản dịch trang ${candidate.index + 1}`)
    root.setAttribute('lang', settings.targetLanguage)

    const renderedPage = document.createElement('img')
    renderedPage.className = 'bb-rendered-page'
    renderedPage.alt = ''
    renderedPage.draggable = false
    renderedPage.decoding = 'async'
    renderedPage.src = renderedDataUrl
    root.append(renderedPage)

    const exclude = createButton(
      'bb-overlay__exclude',
      `Bỏ qua ảnh ${candidate.index + 1}`,
      'Bỏ qua',
    )
    exclude.addEventListener('click', () => excludeCandidate(candidate.id))
    root.append(exclude)
    ;(document.body || document.documentElement).append(root)

    candidate.overlay = root
    candidate.page = { width: pageWidth, height: pageHeight }
    candidate.regions = safeRegions
    candidate.regionElements = safeRegions
      .filter(core.shouldRenderTranslationBox)
      .map((region) => {
        const style = core.regionToPercentStyle(region, candidate.page)
        const box = document.createElement('div')
        box.className = 'bb-translation-box'
        box.setAttribute('role', 'note')
        box.setAttribute('aria-label', `Bản dịch: ${region.translation}`)
        box.textContent = region.translation
        box.style.left = style.left
        box.style.top = style.top
        box.style.width = style.width
        box.style.height = style.height
        box.style.transform = `rotate(${style.rotation}deg)`
        root.append(box)
        return { box, region }
      })
    applyReveal()
    layoutCandidate(candidate)
  }

  function fitTranslationBoxes(candidate, renderedHeight) {
    if (!candidate.page || !Array.isArray(candidate.regionElements)) return
    for (const entry of candidate.regionElements) {
      const box = entry && entry.box
      if (!box || !box.isConnected) continue
      let fontSize = core.fontSizeForRegion(
        entry.region,
        candidate.page,
        renderedHeight,
      )
      box.style.fontSize = `${fontSize}px`
      let attempts = 0
      while (
        fontSize > 6 &&
        attempts < 24 &&
        (box.scrollHeight > box.clientHeight + 1 ||
          box.scrollWidth > box.clientWidth + 1)
      ) {
        fontSize = Math.max(6, fontSize - 0.75)
        box.style.fontSize = `${fontSize}px`
        attempts += 1
      }
    }
  }

  function layoutCandidate(candidate) {
    if (!candidate.overlay || !candidate.host.isConnected) return
    const rect = candidate.host.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      candidate.overlay.style.display = 'none'
      return
    }

    candidate.overlay.style.display = ''
    candidate.overlay.style.transform = `translate3d(${Math.round(
      rect.left + scrollX,
    )}px, ${Math.round(rect.top + scrollY)}px, 0)`
    candidate.overlay.style.width = `${rect.width}px`
    candidate.overlay.style.height = `${rect.height}px`
    if (candidate.fittedHeight !== rect.height) {
      candidate.fittedHeight = rect.height
      fitTranslationBoxes(candidate, rect.height)
    }
  }

  function scheduleLayout() {
    if (layoutScheduled) return
    layoutScheduled = true
    let completed = false
    const run = () => {
      if (completed) return
      completed = true
      layoutScheduled = false
      layoutAllNow()
    }
    requestAnimationFrame(run)
    // requestAnimationFrame can be suspended when the extension popup is the
    // active surface. Keep overlays aligned while settings are changed there.
    setTimeout(run, 50)
  }

  function layoutAllNow() {
    for (const candidate of candidates.values()) layoutCandidate(candidate)
  }

  function scheduleResponsiveLayout() {
    layoutAllNow()
    scheduleLayout()
    // AMP and other responsive readers can settle their image column one or
    // two frames after the viewport event. Recheck without polling forever.
    setTimeout(scheduleLayout, 120)
    setTimeout(scheduleLayout, 360)
  }

  function setPaused(nextPaused) {
    paused = Boolean(nextPaused)
    if (paused) {
      runToken += 1
      if (activeCandidateId) {
        const candidate = candidates.get(activeCandidateId)
        if (candidate) candidate.status = registeredIds.has(candidate.id) ? 'ready' : 'blocked'
        const cancelRequest = sendRuntimeMessage({
          type: 'CANCEL_TRANSLATION',
          candidateId: activeCandidateId,
        })
        const pending = Promise.allSettled(
          [cancelRequest, activeTranslationRequest].filter(Boolean),
        )
        cancellationPending = pending
        void pending.finally(() => {
          if (cancellationPending !== pending) return
          cancellationPending = null
          if (!paused) void pumpQueue()
        })
      }
      activeCandidateId = null
      for (const id of queue.splice(0)) {
        queuedIds.delete(id)
        const candidate = candidates.get(id)
        if (candidate && candidate.status === 'queued') {
          candidate.status = registeredIds.has(id) ? 'ready' : 'blocked'
        }
      }
    } else {
      enqueueForCurrentScope()
    }
    updateControl()
    return statusPayload()
  }

  function retryFailed() {
    for (const candidate of candidates.values()) {
      if (candidate.status !== 'failed') continue
      candidate.status = registeredIds.has(candidate.id) ? 'ready' : 'blocked'
      candidate.error = null
      if (registeredIds.has(candidate.id)) enqueueCandidate(candidate)
    }
    lastDetail = ''
    updateControl()
    return statusPayload()
  }

  function retryCandidate(id) {
    const candidate = candidates.get(String(id || ''))
    if (!candidate || candidate.status !== 'failed') return statusPayload()
    candidate.status = registeredIds.has(candidate.id) ? 'ready' : 'blocked'
    candidate.error = null
    if (registeredIds.has(candidate.id)) enqueueCandidate(candidate)
    updateControl()
    return statusPayload()
  }

  function excludeCandidate(id) {
    const candidate = candidates.get(String(id || ''))
    if (!candidate) return statusPayload()
    if (candidate.status === 'processing') {
      runToken += 1
      activeCandidateId = null
      const cancelRequest = sendRuntimeMessage({
        type: 'CANCEL_TRANSLATION',
        candidateId: candidate.id,
      })
      const pending = Promise.allSettled(
        [cancelRequest, activeTranslationRequest].filter(Boolean),
      )
      cancellationPending = pending
      void pending.finally(() => {
        if (cancellationPending !== pending) return
        cancellationPending = null
        if (!paused) void pumpQueue()
      })
    }
    candidate.status = 'excluded'
    queuedIds.delete(candidate.id)
    removeOverlay(candidate)
    intersectionObserver?.unobserve(candidate.host)
    updateControl()
    void pumpQueue()
    return statusPayload()
  }

  function applySettings(nextSettings) {
    if (!nextSettings || typeof nextSettings !== 'object') return
    const language = String(
      nextSettings.targetLanguage || nextSettings.language || settings.targetLanguage,
    ).trim()
    const lookAhead = Number(nextSettings.lookAhead)
    settings = {
      ...settings,
      ...nextSettings,
      targetLanguage: language || DEFAULT_SETTINGS.targetLanguage,
      lookAhead: Number.isFinite(lookAhead)
        ? core.clamp(Math.trunc(lookAhead), 0, 8)
        : settings.lookAhead,
      autoTranslate:
        typeof nextSettings.autoTranslate === 'boolean'
          ? nextSettings.autoTranslate
          : settings.autoTranslate,
    }
    enqueueForCurrentScope()
  }

  function installObservers() {
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = hostIds.get(entry.target)
          if (!id) continue
          if (entry.isIntersecting) {
            visibleIds.add(id)
            const candidate = candidates.get(id)
            if (candidate && settings.autoTranslate) enqueueWindow(candidate)
          } else {
            visibleIds.delete(id)
          }
        }
      },
      {
        root: null,
        rootMargin: '20% 0px 35% 0px',
        threshold: 0.01,
      },
    )

    mutationObserver = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        if (record.type === 'attributes') {
          return !record.target.closest?.(OWNED_SELECTOR)
        }
        return [...record.addedNodes].some(
          (node) =>
            node.nodeType === Node.ELEMENT_NODE &&
            !node.matches?.(OWNED_SELECTOR) &&
            !node.closest?.(OWNED_SELECTOR),
        )
      })
      if (relevant) scheduleScan()
    })
    mutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'src',
        'srcset',
        'data-src',
        'data-srcset',
        'data-lazy-srcset',
        'data-original',
        'data-lazy-src',
        'data-url',
        'data-image',
        'data-cfsrc',
        'data-echo',
        'data-lazy',
        'data-lazyload',
        'data-ks-lazyload',
      ],
    })

    if ('ResizeObserver' in globalThis) {
      resizeObserver = new ResizeObserver(scheduleLayout)
    }

    addEventListener('scroll', scheduleLayout, { capture: true, passive: true })
    addEventListener('resize', scheduleResponsiveLayout, { passive: true })
    globalThis.visualViewport?.addEventListener('resize', scheduleResponsiveLayout, {
      passive: true,
    })
    addEventListener('popstate', scheduleScan)
    addEventListener('hashchange', scheduleScan)
    addEventListener(
      'pagehide',
      () => {
        runToken += 1
        if (activeCandidateId) {
          void sendRuntimeMessage({
            type: 'CANCEL_TRANSLATION',
            candidateId: activeCandidateId,
          })
        }
        mutationObserver?.disconnect()
        intersectionObserver?.disconnect()
        resizeObserver?.disconnect()
      },
      { once: true },
    )
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false

    if (message.type === 'TRANSLATION_PROGRESS') {
      const candidate = candidates.get(message.candidateId)
      if (candidate && candidate.status === 'processing') {
        const percent = Number(message.progress && message.progress.percent)
        candidate.progress = Number.isFinite(percent)
          ? core.clamp(Math.round(percent), 0, 100)
          : null
        lastDetail = message.progress?.state || ''
        updateControl()
      }
      return false
    }

    if (message.type === 'SCAN_PAGE') {
      applySettings(message.settings)
      void scan().then(sendResponse)
      return true
    }
    if (message.type === 'GET_CONTENT_STATUS') {
      sendResponse(statusPayload())
      return false
    }
    if (message.type === 'SET_PAUSED') {
      sendResponse(setPaused(message.paused))
      return false
    }
    if (message.type === 'SET_SOURCE_REVEALED') {
      sourceRevealed = Boolean(message.revealed)
      transientReveal = false
      applyReveal()
      sendResponse(statusPayload())
      return false
    }
    if (message.type === 'TRANSLATE_SCOPE') {
      translationScope = message.scope === 'all' ? 'all' : 'visible'
      enqueueForCurrentScope(true)
      sendResponse(statusPayload())
      return false
    }
    if (message.type === 'RETRY_FAILED') {
      sendResponse(retryFailed())
      return false
    }
    if (message.type === 'RETRY_CANDIDATE') {
      sendResponse(retryCandidate(message.candidateId))
      return false
    }
    if (message.type === 'EXCLUDE_CANDIDATE') {
      sendResponse(excludeCandidate(message.candidateId))
      return false
    }
    if (message.type === 'SETTINGS_UPDATED') {
      applySettings(message.settings)
      sendResponse(statusPayload())
      return false
    }
    if (message.type === 'PERMISSIONS_UPDATED') {
      grantedOrigins.clear()
      for (const origin of Array.isArray(message.grantedOrigins)
        ? message.grantedOrigins
        : []) {
        grantedOrigins.add(origin)
      }
      void registerCandidates().then(() => sendResponse(statusPayload()))
      return true
    }

    return false
  })

  globalThis.__BONG_BONG_CONTENT__ = Object.freeze({
    scan,
    getStatus: statusPayload,
  })

  ensureControl()
  installObservers()
  chrome.storage.local.get('bongBongSettings', (result) => {
    if (!chrome.runtime.lastError) applySettings(result.bongBongSettings)
    void scan()
  })
})()

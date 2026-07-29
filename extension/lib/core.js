(function exposeBongBongCore(root, factory) {
  const api = factory()

  if (typeof module === 'object' && module.exports) {
    module.exports = api
  }

  if (root) {
    root.BongBongCore = api
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createBongBongCore() {
  'use strict'

  const CANDIDATE_SELECTOR = 'amp-img, picture img, img'
  const LAZY_SOURCE_ATTRIBUTES = [
    'data-src',
    'data-original',
    'data-lazy-src',
    'data-url',
    'data-image',
    'data-cfsrc',
    'data-echo',
    'data-lazy',
    'data-lazyload',
    'data-ks-lazyload',
  ]
  const SOURCE_ATTRIBUTES = [...LAZY_SOURCE_ATTRIBUTES, 'src']
  const LAZY_SRCSET_ATTRIBUTES = ['data-srcset', 'data-lazy-srcset']
  const SRCSET_ATTRIBUTES = [...LAZY_SRCSET_ATTRIBUTES, 'srcset']
  const EXCLUSION_PATTERN =
    /(?:^|[\s_-])(avatar|badge|banner|emoji|favicon|icon|logo|recommend|share|sprite|thumb|thumbnail)(?:$|[\s_-])/i
  const DEFAULT_SCORE_THRESHOLD = 55

  function asFiniteNumber(value, fallback = 0) {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value))
  }

  function readAttribute(element, name) {
    if (!element || typeof element.getAttribute !== 'function') return ''
    return String(element.getAttribute(name) || '').trim()
  }

  function firstSrcsetUrl(srcset) {
    if (typeof srcset !== 'string') return ''
    const first = srcset
      .split(',')
      .map((entry) => entry.trim())
      .find(Boolean)
    return first ? first.split(/\s+/)[0] : ''
  }

  function resolveHttpUrl(value, baseUrl) {
    if (!value || typeof value !== 'string') return null

    try {
      const url = new URL(value.trim(), baseUrl)
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
    } catch {
      return null
    }
  }

  function sourceValues(element) {
    const values = []

    for (const name of LAZY_SOURCE_ATTRIBUTES) {
      values.push(readAttribute(element, name))
    }

    for (const name of LAZY_SRCSET_ATTRIBUTES) {
      values.push(firstSrcsetUrl(readAttribute(element, name)))
    }

    if (element && typeof element.currentSrc === 'string') {
      values.push(element.currentSrc)
    }

    values.push(readAttribute(element, 'src'))
    values.push(firstSrcsetUrl(readAttribute(element, 'srcset')))

    return values
  }

  function stableImageHost(element) {
    if (!element) return null
    const tagName = String(element.tagName || '').toLowerCase()

    if (tagName === 'amp-img') return element
    if (tagName === 'img' && typeof element.closest === 'function') {
      return element.closest('amp-img') || element
    }

    return element
  }

  function imageNodeForHost(host) {
    if (!host) return null
    if (String(host.tagName || '').toLowerCase() === 'img') return host
    return typeof host.querySelector === 'function' ? host.querySelector('img') : null
  }

  function resolveImageSource(host, baseUrl) {
    if (!host) return null
    const image = imageNodeForHost(host)
    const elements = image && image !== host ? [host, image] : [host]

    for (const element of elements) {
      for (const value of sourceValues(element)) {
        const resolved = resolveHttpUrl(value, baseUrl)
        if (resolved) return resolved
      }
    }

    return null
  }

  function exclusionText(host, image) {
    return [
      readAttribute(host, 'class'),
      readAttribute(host, 'id'),
      readAttribute(host, 'role'),
      readAttribute(image, 'class'),
      readAttribute(image, 'id'),
      readAttribute(image, 'alt'),
    ]
      .filter(Boolean)
      .join(' ')
  }

  function widthBucket(width) {
    return Math.round(asFiniteNumber(width) / 24)
  }

  function scoreCandidateMetrics(metrics, context = {}) {
    const renderedWidth = asFiniteNumber(metrics.renderedWidth)
    const renderedHeight = asFiniteNumber(metrics.renderedHeight)
    const intrinsicWidth = asFiniteNumber(metrics.intrinsicWidth)
    const intrinsicHeight = asFiniteNumber(metrics.intrinsicHeight)
    const viewportWidth = Math.max(1, asFiniteNumber(metrics.viewportWidth, 1))
    const centerX = asFiniteNumber(metrics.left) + renderedWidth / 2
    const centerDistance = Math.abs(centerX - viewportWidth / 2) / viewportWidth
    const renderedArea = renderedWidth * renderedHeight
    const intrinsicArea = intrinsicWidth * intrinsicHeight
    const aspect = renderedWidth > 0 ? renderedHeight / renderedWidth : 0
    const repeatedWidthCount = Math.max(1, asFiniteNumber(context.repeatedWidthCount, 1))
    const siblingCount = Math.max(1, asFiniteNumber(context.siblingCount, 1))
    const reasons = []
    let score = 0

    if (
      metrics.visible === false ||
      renderedWidth < 220 ||
      renderedHeight < 260 ||
      renderedArea < 75_000
    ) {
      return { eligible: false, score: 0, reasons: ['too-small-or-hidden'] }
    }

    if (renderedArea >= 300_000) {
      score += 24
      reasons.push('large-rendered-area')
    } else if (renderedArea >= 150_000) {
      score += 18
      reasons.push('substantial-rendered-area')
    } else {
      score += 10
      reasons.push('minimum-rendered-area')
    }

    if (intrinsicArea >= 700_000 && intrinsicWidth >= 500 && intrinsicHeight >= 600) {
      score += 17
      reasons.push('large-intrinsic-image')
    } else if (intrinsicArea >= 300_000) {
      score += 9
      reasons.push('substantial-intrinsic-image')
    }

    if (aspect >= 0.9 && aspect <= 2.3) {
      score += 18
      reasons.push('page-like-aspect')
    } else if (aspect > 2.3) {
      score += 20
      reasons.push('long-strip-aspect')
    } else if (aspect >= 0.65) {
      score += 7
      reasons.push('wide-page-aspect')
    } else {
      score -= 24
      reasons.push('banner-like-aspect')
    }

    if (centerDistance <= 0.16) {
      score += 15
      reasons.push('center-column')
    } else if (centerDistance <= 0.32) {
      score += 8
      reasons.push('near-center-column')
    } else {
      score -= 8
      reasons.push('outside-reading-column')
    }

    if (repeatedWidthCount >= 3) {
      score += 16
      reasons.push('repeated-page-width')
    } else if (repeatedWidthCount === 2) {
      score += 9
      reasons.push('paired-page-width')
    }

    if (siblingCount >= 3) {
      score += 12
      reasons.push('grouped-pages')
    } else if (siblingCount === 2) {
      score += 7
      reasons.push('paired-pages')
    }

    if (metrics.exclusionSignal) {
      score -= 32
      reasons.push('non-comic-signal')
    }

    const threshold = asFiniteNumber(context.threshold, DEFAULT_SCORE_THRESHOLD)
    return {
      eligible: score >= threshold,
      score,
      reasons,
    }
  }

  function collectRawCandidates(root, options = {}) {
    if (!root || typeof root.querySelectorAll !== 'function') return []

    const baseUrl =
      options.baseUrl ||
      (root.ownerDocument && root.ownerDocument.baseURI) ||
      root.baseURI ||
      'https://invalid.local/'
    const viewportWidth = Math.max(
      1,
      asFiniteNumber(
        options.viewportWidth,
        root.defaultView && root.defaultView.innerWidth
          ? root.defaultView.innerWidth
          : root.ownerDocument && root.ownerDocument.defaultView
            ? root.ownerDocument.defaultView.innerWidth
            : 1,
      ),
    )
    const getStyle =
      options.getComputedStyle ||
      (root.defaultView && root.defaultView.getComputedStyle
        ? root.defaultView.getComputedStyle.bind(root.defaultView)
        : root.ownerDocument &&
            root.ownerDocument.defaultView &&
            root.ownerDocument.defaultView.getComputedStyle
          ? root.ownerDocument.defaultView.getComputedStyle.bind(
              root.ownerDocument.defaultView,
            )
          : null)
    const seenHosts = new Set()
    const raw = []

    for (const element of root.querySelectorAll(CANDIDATE_SELECTOR)) {
      const host = stableImageHost(element)
      if (!host || seenHosts.has(host)) continue
      seenHosts.add(host)

      const image = imageNodeForHost(host)
      const url = resolveImageSource(host, baseUrl)
      if (!url || typeof host.getBoundingClientRect !== 'function') continue

      const rect = host.getBoundingClientRect()
      const style = getStyle ? getStyle(host) : null
      const visible =
        host.hidden !== true &&
        (!style ||
          (style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || 1) !== 0)) &&
        rect.width > 0 &&
        rect.height > 0
      const intrinsicWidth =
        asFiniteNumber(image && image.naturalWidth) ||
        asFiniteNumber(readAttribute(host, 'width')) ||
        asFiniteNumber(rect.width)
      const intrinsicHeight =
        asFiniteNumber(image && image.naturalHeight) ||
        asFiniteNumber(readAttribute(host, 'height')) ||
        asFiniteNumber(rect.height)

      raw.push({
        host,
        image,
        url,
        origin: new URL(url).origin,
        parent: host.parentElement || null,
        renderedWidth: rect.width,
        renderedHeight: rect.height,
        intrinsicWidth,
        intrinsicHeight,
        left: rect.left,
        top: rect.top,
        viewportWidth,
        visible,
        exclusionSignal: EXCLUSION_PATTERN.test(exclusionText(host, image)),
      })
    }

    return raw
  }

  function discoverCandidates(root, options = {}) {
    const raw = collectRawCandidates(root, options)
    const widths = new Map()
    const parents = new Map()

    for (const item of raw) {
      const bucket = widthBucket(item.renderedWidth)
      widths.set(bucket, (widths.get(bucket) || 0) + 1)
      if (item.parent) parents.set(item.parent, (parents.get(item.parent) || 0) + 1)
    }

    const candidates = []
    for (const item of raw) {
      const result = scoreCandidateMetrics(item, {
        repeatedWidthCount: widths.get(widthBucket(item.renderedWidth)) || 1,
        siblingCount: item.parent ? parents.get(item.parent) || 1 : 1,
        threshold: options.threshold,
      })

      if (!result.eligible) continue

      candidates.push({
        host: item.host,
        url: item.url,
        origin: item.origin,
        renderedWidth: Math.round(item.renderedWidth),
        renderedHeight: Math.round(item.renderedHeight),
        intrinsicWidth: Math.round(item.intrinsicWidth),
        intrinsicHeight: Math.round(item.intrinsicHeight),
        score: result.score,
        reasons: result.reasons,
      })
    }

    return candidates.map((candidate, index) => ({
      ...candidate,
      index,
    }))
  }

  function normalizeRegion(region, page) {
    const pageWidth = asFiniteNumber(page && page.width)
    const pageHeight = asFiniteNumber(page && page.height)
    if (pageWidth <= 0 || pageHeight <= 0 || !region) return null

    const rawX = asFiniteNumber(region.x)
    const rawY = asFiniteNumber(region.y)
    const rawWidth = asFiniteNumber(region.width)
    const rawHeight = asFiniteNumber(region.height)
    if (rawWidth <= 0 || rawHeight <= 0) return null

    const x = clamp(rawX, 0, pageWidth)
    const y = clamp(rawY, 0, pageHeight)
    const width = clamp(rawWidth, 0, pageWidth - x)
    const height = clamp(rawHeight, 0, pageHeight - y)
    if (width <= 0 || height <= 0) return null

    const translation = String(region.translation || '').trim().slice(0, 4_000)
    if (!translation) return null

    return {
      id: String(region.id || ''),
      x,
      y,
      width,
      height,
      rotation: clamp(asFiniteNumber(region.rotation), -180, 180),
      source: String(region.source || '').slice(0, 4_000),
      translation,
      confidence: clamp(asFiniteNumber(region.confidence, 1), 0, 1),
    }
  }

  function regionToPercentStyle(region, page) {
    const normalized = normalizeRegion(region, page)
    if (!normalized) return null

    return {
      left: `${(normalized.x / page.width) * 100}%`,
      top: `${(normalized.y / page.height) * 100}%`,
      width: `${(normalized.width / page.width) * 100}%`,
      height: `${(normalized.height / page.height) * 100}%`,
      minHeight: `${(normalized.height / page.height) * 100}%`,
      rotation: normalized.rotation,
    }
  }

  function shouldRenderTranslationBox(region) {
    const source = String(region && region.source ? region.source : '').trim()
    const translation = String(
      region && region.translation ? region.translation : '',
    ).trim()
    if (!translation) return false
    if (translation !== source) return true
    return /[\u3400-\u9fff\uf900-\ufaff]/u.test(source)
  }

  function fontSizeForRegion(region, page, renderedHeight) {
    const normalized = normalizeRegion(region, page)
    if (!normalized) return 12
    const safeRenderedHeight = asFiniteNumber(renderedHeight)
    const renderedWidth = safeRenderedHeight * (page.width / page.height)
    const boxWidth = (normalized.width / page.width) * renderedWidth
    const boxHeight = (normalized.height / page.height) * safeRenderedHeight
    const characters = Math.max(
      1,
      normalized.translation.replace(/\s+/g, '').length,
    )
    const heightLimit = boxHeight * 0.42
    const areaLimit = Math.sqrt(
      (boxWidth * boxHeight) / (characters * 0.78 * 1.12),
    )
    return Math.round(clamp(Math.min(heightLimit, areaLimit), 8, 26) * 10) / 10
  }

  function publicCandidate(candidate) {
    return {
      id: candidate.id,
      index: candidate.index,
      url: candidate.url,
      origin: candidate.origin,
      renderedWidth: candidate.renderedWidth,
      renderedHeight: candidate.renderedHeight,
      intrinsicWidth: candidate.intrinsicWidth,
      intrinsicHeight: candidate.intrinsicHeight,
      score: candidate.score,
      reasons: Array.isArray(candidate.reasons) ? [...candidate.reasons] : [],
      status: candidate.status || 'detected',
    }
  }

  function orderedLookAheadIndexes(index, total, lookAhead = 2) {
    const start = clamp(Math.trunc(asFiniteNumber(index)), 0, Math.max(0, total - 1))
    const end = Math.min(total, start + Math.max(0, Math.trunc(asFiniteNumber(lookAhead))) + 1)
    const indexes = []
    for (let current = start; current < end; current += 1) indexes.push(current)
    return indexes
  }

  function readingPriorityIndex(index, total, anchorIndex = 0) {
    const safeTotal = Math.max(1, Math.trunc(asFiniteNumber(total, 1)))
    const safeIndex = clamp(
      Math.trunc(asFiniteNumber(index)),
      0,
      safeTotal - 1,
    )
    const safeAnchor = clamp(
      Math.trunc(asFiniteNumber(anchorIndex)),
      0,
      safeTotal - 1,
    )
    return (safeIndex - safeAnchor + safeTotal) % safeTotal
  }

  return Object.freeze({
    CANDIDATE_SELECTOR,
    DEFAULT_SCORE_THRESHOLD,
    LAZY_SOURCE_ATTRIBUTES: Object.freeze([...LAZY_SOURCE_ATTRIBUTES]),
    SOURCE_ATTRIBUTES: Object.freeze([...SOURCE_ATTRIBUTES]),
    SRCSET_ATTRIBUTES: Object.freeze([...SRCSET_ATTRIBUTES]),
    clamp,
    collectRawCandidates,
    discoverCandidates,
    firstSrcsetUrl,
    fontSizeForRegion,
    normalizeRegion,
    orderedLookAheadIndexes,
    publicCandidate,
    readingPriorityIndex,
    resolveHttpUrl,
    resolveImageSource,
    scoreCandidateMetrics,
    shouldRenderTranslationBox,
    stableImageHost,
    regionToPercentStyle,
    widthBucket,
  })
})

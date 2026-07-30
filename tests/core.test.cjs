const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

function loadCommonJs(relativePath) {
  const filename = resolve(__dirname, '..', relativePath)
  const module = { exports: {} }
  const context = {
    module,
    exports: module.exports,
    URL,
    console,
  }
  vm.runInNewContext(readFileSync(filename, 'utf8'), context, { filename })
  return module.exports
}

const core = loadCommonJs('extension/lib/core.js')

function element(tagName, attributes = {}, options = {}) {
  return {
    tagName: tagName.toUpperCase(),
    currentSrc: options.currentSrc || '',
    getAttribute(name) {
      return attributes[name] || ''
    },
    querySelector(selector) {
      return selector === 'img' ? options.image || null : null
    },
    closest(selector) {
      return selector === 'amp-img' ? options.ampHost || null : null
    },
  }
}

test('URL helpers accept HTTP(S), resolve relatives, and reject executable schemes', () => {
  assert.equal(
    core.resolveHttpUrl('../page.webp#frame', 'https://reader.example/chapter/12/'),
    'https://reader.example/chapter/page.webp#frame',
  )
  assert.equal(core.resolveHttpUrl('http://cdn.example/p.png', 'https://reader.example'), 'http://cdn.example/p.png')
  assert.equal(core.resolveHttpUrl('javascript:alert(1)', 'https://reader.example'), null)
  assert.equal(core.resolveHttpUrl('data:image/png;base64,AA==', 'https://reader.example'), null)
  assert.equal(core.resolveHttpUrl('not a url', undefined), null)
  assert.equal(core.firstSrcsetUrl(' one.jpg 1x, two.jpg 2x '), 'one.jpg')
  assert.equal(core.firstSrcsetUrl(''), '')
})

test('reading priority starts at the visible page and wraps to earlier pages last', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].sort(
      (left, right) =>
        core.readingPriorityIndex(left, 6, 3) -
        core.readingPriorityIndex(right, 6, 3),
    ),
    [3, 4, 5, 0, 1, 2],
  )
  assert.equal(core.readingPriorityIndex(-4, 6, 3), 3)
  assert.equal(core.readingPriorityIndex(99, 6, 3), 2)
})

test('translate-all priority stays in DOM order even when the viewport moves', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].sort(
      (left, right) =>
        core.translationPriorityIndex(left, 6, 3, 'all') -
        core.translationPriorityIndex(right, 6, 3, 'all'),
    ),
    [0, 1, 2, 3, 4, 5],
  )
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].sort(
      (left, right) =>
        core.translationPriorityIndex(left, 6, 3, 'visible') -
        core.translationPriorityIndex(right, 6, 3, 'visible'),
    ),
    [3, 4, 5, 0, 1, 2],
  )
})

test('source resolution prioritizes the stable outer lazy host over AMP runtime images', () => {
  const runtimeImage = element('img', { src: 'https://runtime.example/generated.jpg' }, {
    currentSrc: 'https://runtime.example/current.jpg',
  })
  const ampHost = element(
    'amp-img',
    {
      'data-src': '/comic/page-07.webp',
      src: '/comic/fallback.webp',
    },
    { image: runtimeImage },
  )
  runtimeImage.closest = (selector) => (selector === 'amp-img' ? ampHost : null)

  assert.equal(core.stableImageHost(runtimeImage), ampHost)
  assert.equal(
    core.resolveImageSource(ampHost, 'https://reader.example/chapter/1'),
    'https://reader.example/comic/page-07.webp',
  )

  const ordinary = element('img', { srcset: 'https://cdn.example/a.jpg 1x, https://cdn.example/b.jpg 2x' })
  assert.equal(core.resolveImageSource(ordinary, 'https://reader.example'), 'https://cdn.example/a.jpg')
})

test('candidate scoring fails closed at size and score boundaries', () => {
  const strongPage = {
    renderedWidth: 600,
    renderedHeight: 900,
    intrinsicWidth: 1200,
    intrinsicHeight: 1800,
    viewportWidth: 1200,
    left: 300,
    visible: true,
    exclusionSignal: false,
  }
  const scored = core.scoreCandidateMetrics(strongPage)

  assert.equal(scored.score, 74)
  assert.equal(scored.eligible, true)
  assert.equal(
    core.scoreCandidateMetrics(strongPage, { threshold: scored.score }).eligible,
    true,
  )
  assert.equal(
    core.scoreCandidateMetrics(strongPage, { threshold: scored.score + 1 }).eligible,
    false,
  )
  assert.deepEqual(
    [...core.scoreCandidateMetrics({ ...strongPage, renderedWidth: 219 }).reasons],
    ['too-small-or-hidden'],
  )
  assert.equal(
    core.scoreCandidateMetrics({ ...strongPage, visible: false }).eligible,
    false,
  )
  assert.equal(
    core.scoreCandidateMetrics({ ...strongPage, exclusionSignal: true }).eligible,
    false,
  )
})

test('repeated dimensions and grouping can promote otherwise marginal comic pages', () => {
  const marginal = {
    renderedWidth: 300,
    renderedHeight: 360,
    intrinsicWidth: 600,
    intrinsicHeight: 600,
    viewportWidth: 1200,
    left: 450,
    visible: true,
    exclusionSignal: false,
  }

  assert.equal(core.scoreCandidateMetrics(marginal).eligible, false)
  const grouped = core.scoreCandidateMetrics(marginal, {
    repeatedWidthCount: 3,
    siblingCount: 3,
  })
  assert.equal(grouped.eligible, true)
  assert.ok(grouped.reasons.includes('repeated-page-width'))
  assert.ok(grouped.reasons.includes('grouped-pages'))
})

test('look-ahead indexes clamp input and never pass the chapter boundary', () => {
  assert.deepEqual([...core.orderedLookAheadIndexes(2, 8, 2)], [2, 3, 4])
  assert.deepEqual([...core.orderedLookAheadIndexes(-5, 3, 2)], [0, 1, 2])
  assert.deepEqual([...core.orderedLookAheadIndexes(4, 5, 9)], [4])
  assert.deepEqual([...core.orderedLookAheadIndexes(1.9, 5, 1.9)], [1, 2])
  assert.deepEqual([...core.orderedLookAheadIndexes(0, 0, 2)], [])
})

test('region normalization clamps geometry, text, rotation, and confidence', () => {
  const normalized = core.normalizeRegion(
    {
      id: 'bubble-1',
      x: -25,
      y: 1900,
      width: 1200,
      height: 400,
      rotation: 270,
      source: '你好',
      translation: '  Xin chào  ',
      confidence: -0.4,
    },
    { width: 1000, height: 2000 },
  )

  assert.deepEqual(
    {
      id: normalized.id,
      x: normalized.x,
      y: normalized.y,
      width: normalized.width,
      height: normalized.height,
      rotation: normalized.rotation,
      source: normalized.source,
      translation: normalized.translation,
      confidence: normalized.confidence,
    },
    {
      id: 'bubble-1',
      x: 0,
      y: 1900,
      width: 1000,
      height: 100,
      rotation: 180,
      source: '你好',
      translation: 'Xin chào',
      confidence: 0,
    },
  )
  assert.equal(
    core.normalizeRegion(
      { x: 1000, y: 0, width: 20, height: 20, translation: 'X' },
      { width: 1000, height: 2000 },
    ),
    null,
  )
  assert.equal(
    core.normalizeRegion(
      { x: 0, y: 0, width: 20, height: 20, translation: '   ' },
      { width: 1000, height: 2000 },
    ),
    null,
  )
})

test('region CSS geometry and font sizing stay proportional and bounded', () => {
  const page = { width: 1000, height: 2000 }
  const region = {
    x: 100,
    y: 400,
    width: 250,
    height: 200,
    rotation: -12,
    translation: 'Bản dịch',
  }
  const style = core.regionToPercentStyle(region, page)

  assert.deepEqual(
    {
      left: style.left,
      top: style.top,
      width: style.width,
      minHeight: style.minHeight,
      rotation: style.rotation,
    },
    {
      left: '10%',
      top: '20%',
      width: '25%',
      minHeight: '10%',
      rotation: -12,
    },
  )
  assert.equal(core.fontSizeForRegion(region, page, 1000), 26)
  assert.equal(
    core.fontSizeForRegion({ ...region, height: 10 }, page, 500),
    8,
  )
})

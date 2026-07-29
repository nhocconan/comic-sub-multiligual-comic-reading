const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

function loadCore() {
  const filename = resolve(__dirname, '..', 'extension/lib/core.js')
  const module = { exports: {} }
  vm.runInNewContext(
    readFileSync(filename, 'utf8'),
    { module, exports: module.exports, URL, console },
    { filename },
  )
  return module.exports
}

const core = loadCore()

// Regression: ISSUE-001 — completed pages could still display untranslated Chinese
// Found by /qa on 2026-07-29
// Report: .gstack/qa-reports/qa-report-baozimh-com-2026-07-29.md
test('translation boxes stay inside the page and cover untranslated CJK regions', () => {
  const page = { width: 800, height: 1133 }
  const region = core.normalizeRegion({
    id: 'dialogue',
    x: -12,
    y: 1000,
    width: 900,
    height: 200,
    source: '他的魔气无孔不入',
    translation: 'Ma khí của hắn len lỏi khắp nơi.',
    rotation: 0,
  }, page)
  const style = core.regionToPercentStyle(region, page)

  assert.equal(core.shouldRenderTranslationBox(region), true)
  assert.equal(style.left, '0%')
  assert.equal(style.top, `${(1000 / 1133) * 100}%`)
  assert.equal(style.width, '100%')
  assert.equal(style.height, `${(133 / 1133) * 100}%`)
})

test('unchanged ASCII watermarks are not covered but unchanged Chinese remains visible', () => {
  assert.equal(core.shouldRenderTranslationBox({
    source: 'baozimh.com',
    translation: 'baozimh.com',
  }), false)
  assert.equal(core.shouldRenderTranslationBox({
    source: '妖烈',
    translation: '妖烈',
  }), true)
  assert.equal(core.shouldRenderTranslationBox({
    source: '你好',
    translation: '',
  }), false)
})

test('translation boxes use a plain background without border or shadow', () => {
  const css = readFileSync(
    resolve(__dirname, '..', 'extension/content.css'),
    'utf8',
  )
  const rule = css.match(/\.bb-translation-box\s*\{([\s\S]*?)\}/)?.[1] || ''
  assert.match(rule, /border:\s*0;/)
  assert.match(rule, /border-radius:\s*0;/)
  assert.match(rule, /box-shadow:\s*none;/)
})

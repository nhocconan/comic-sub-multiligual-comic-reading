'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('reader scans AMP comic image hosts used by Baozimh', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'reader-preload.cjs'), 'utf8')
  assert.match(source, /querySelectorAll\('amp-img'\)/)
  assert.match(source, /function imageSource\(image\)/)
  assert.match(source, /function ensureAmpImage\(ampImage\)/)
  assert.match(source, /comic-sub-amp-fallback/)
  assert.match(source, /data-original/)
  assert.match(source, /data-lazy-src/)
  assert.match(source, /backgroundImage/)
  assert.match(source, /const imageFont = Math\.max\(17, Math\.min\(32, image\.clientWidth \/ 36\)\)/)
  assert.match(source, /const desiredWidth = Math\.max\(rawWidth \* 1\.2/)
  assert.doesNotMatch(source, /const found = \[\.\.\.document\.images\]/)
  assert.doesNotMatch(source, /clamp\(11px,1\.4vw,18px\)/)
})

test('main process does not cancel a job for a same-navigation lazy rescan', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8')
  const guard = source.match(/function assertCurrentNavigation\(snapshot\) \{([\s\S]*?)\n\}/)?.[1] || ''
  assert.match(guard, /activeSnapshot\.navigationId !== snapshot\.navigationId/)
  assert.doesNotMatch(guard, /activeSnapshot\.snapshotId !== snapshot\.snapshotId/)
})

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

const source = readFileSync(
  resolve(__dirname, '..', 'apple', 'Bong Bóng', 'Bong Bóng', 'ViewController.swift'),
  'utf8',
)

// Regression: the primary button opens a scope menu, so its label must not
// promise that the current image is the action that will run.
test('iOS translation menu button uses a compact generic label and recognizable icon', () => {
  assert.match(source, /UIImage\(systemName: "character\.bubble\.fill"\)/)
  assert.match(source, /configuration\?\.title = uiText\("Translate", "Dịch"\)/)
  assert.doesNotMatch(source, /configuration\?\.title = uiText\("Translate Current"/)
  assert.match(source, /"Translate Current Section", "Dịch phần đang đọc"/)
  assert.match(source, /"Translate All Loaded Images", "Dịch toàn bộ ảnh hiện có"/)
})

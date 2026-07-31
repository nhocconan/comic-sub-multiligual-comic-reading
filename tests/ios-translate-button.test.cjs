const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

const source = readFileSync(
  resolve(__dirname, '..', 'apple', 'Manga Sub', 'Manga Sub', 'ViewController.swift'),
  'utf8',
)

// Regression: the primary button opens a scope menu, so its label must not
// promise that the current image is the action that will run.
test('iOS translation menu button uses a compact generic label and recognizable icon', () => {
  assert.match(source, /UIImage\(systemName: "character\.bubble\.fill"\)/)
  assert.match(source, /configuration\?\.title = uiText\("Translate", "Dịch"\)/)
  assert.doesNotMatch(source, /configuration\?\.title = uiText\("Translate Current"/)
  assert.ok(source.includes('"Translate This Chapter", "Dịch chương này"'))
  assert.match(source, /"Translate Visible Image Only", "Chỉ dịch ảnh đang nhìn"/)
  assert.match(source, /prepareAllCandidates\(navigationID:/)
})

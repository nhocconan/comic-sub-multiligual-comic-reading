const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

const source = readFileSync(
  resolve(__dirname, '..', 'apple', 'Manga Sub', 'Manga Sub', 'ViewController.swift'),
  'utf8',
)

// Regression: ISSUE-IOS-SFX-001 — large stylized effects became opaque cards
// Found by /qa on 2026-07-31
// Report: simulator screenshot /tmp/manga-sub-build11-complete.png
test('iOS keeps large short SFX as artwork instead of translating them as dialogue', () => {
  assert.match(source, /guard !isLikelyStylizedEffect\(/)
  assert.match(source, /guard characterCount <= 6 else \{ return false \}/)
  assert.match(source, /widthRatio >= 0\.10 && heightRatio >= 0\.06/)
  assert.match(source, /areaRatioPerCharacter >= 0\.004/)
})

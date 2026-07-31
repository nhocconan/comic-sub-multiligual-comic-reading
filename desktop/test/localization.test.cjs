const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const desktopRoot = path.join(__dirname, '..')
const index = fs.readFileSync(path.join(desktopRoot, 'app', 'index.html'), 'utf8')
const renderer = fs.readFileSync(path.join(desktopRoot, 'app', 'renderer.js'), 'utf8')
const readerPreload = fs.readFileSync(path.join(desktopRoot, 'reader-preload.cjs'), 'utf8')

test('visible desktop shell is Manga Sub with English as its static default', () => {
  assert.match(index, /<html lang="en">/)
  assert.match(index, />Manga Sub</)
  assert.match(index, /id="ui-language"/)
  assert.doesNotMatch(`${index}\n${renderer}\n${readerPreload}`, /Comic Sub|Bong Bong|Bóng Bóng|Koharu/)
})

test('desktop shell includes complete English and Vietnamese localization paths', () => {
  assert.match(renderer, /const messages = \{/)
  assert.match(renderer, /\ben: \{/)
  assert.match(renderer, /\bvi: \{/)
  assert.match(renderer, /saveSettings\(\{ uiLanguage: event\.target\.value \}\)/)
  assert.match(readerPreload, /<span class="mark">M<\/span>/)
  assert.match(readerPreload, /const readerMessages = \{/)
  assert.match(readerPreload, /command\.type === 'ui-language'/)
  assert.match(readerPreload, /alreadyTranslated: 'Current images are already translated'/)
  assert.match(renderer, /function failureMessage\(payload = \{\}\)/)
})

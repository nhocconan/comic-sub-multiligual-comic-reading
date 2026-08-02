const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const desktopRoot = path.join(__dirname, '..')
const index = fs.readFileSync(path.join(desktopRoot, 'app', 'index.html'), 'utf8')
const renderer = fs.readFileSync(path.join(desktopRoot, 'app', 'renderer.js'), 'utf8')
const readerPreload = fs.readFileSync(path.join(desktopRoot, 'reader-preload.cjs'), 'utf8')
const styles = fs.readFileSync(path.join(desktopRoot, 'app', 'styles.css'), 'utf8')

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

test('desktop address bar remains clickable inside the draggable title bar', () => {
  assert.match(styles, /\.address[\s\S]*-webkit-app-region: no-drag/)
  assert.match(styles, /\.address input[\s\S]*-webkit-app-region: no-drag/)
  assert.match(renderer, /event\.key\.toLowerCase\(\) === 'l'/)
  assert.match(renderer, /\$\('#address-input'\)\.select\(\)/)
})

test('desktop can explicitly replace a completed translation with another route', () => {
  assert.match(index, /id="retranslate-current"/)
  assert.match(renderer, /pendingRetranslation = true/)
  assert.match(renderer, /type: 'reset-translations'/)
})

test('desktop exposes a bounded translated chapter cache setting', () => {
  assert.match(index, /id="translation-cache-limit"/)
  assert.match(renderer, /translationCacheLimit: Number\(event\.target\.value\)/)
  assert.match(renderer, /Storage is capped at 2 MiB/)
})

test('desktop keeps Library heading readable and attribution outside the reader', () => {
  assert.match(index, /class="library-workspace panel-workspace"|id="library-workspace" class="panel-workspace"/)
  assert.match(styles, /#library-workspace \.panel-heading h1[\s\S]*white-space: nowrap/)
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*#library-workspace \.panel-heading h1[\s\S]*white-space: normal/)
  assert.match(index, /Copyright © 2026 <a href="https:\/\/x\.com\/nhocconan"/)
  assert.match(index, /class="side-footer"[\s\S]*class="copyright-link"/)
})

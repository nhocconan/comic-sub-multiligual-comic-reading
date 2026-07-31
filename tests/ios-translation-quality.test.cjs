'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const source = fs.readFileSync(path.join(
  __dirname,
  '../apple/Manga Sub/Manga Sub/ViewController.swift',
), 'utf8')

test('iOS retries unchanged Han output and fails closed before attaching an overlay', () => {
  assert.match(source, /mangaSubIsUntranslated/)
  assert.match(source, /makeRepairPrompt/)
  assert.match(source, /try validateTranslationQuality\(result\)/)
  assert.match(source, /The image was not marked complete/)
})

test('iOS DeepSeek requests bounded JSON without default high-effort thinking', () => {
  assert.match(source, /payload\["thinking"\] = \["type": "disabled"\]/)
  assert.match(source, /payload\["response_format"\] = \["type": "json_object"\]/)
  assert.match(source, /"max_tokens": min\(8_192, max\(1_024, regionCount \* 192\)\)/)
})

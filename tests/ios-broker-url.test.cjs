const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

const source = readFileSync(
  resolve(__dirname, '..', 'apple', 'Bong Bóng', 'Bong Bóng', 'ViewController.swift'),
  'utf8',
)

test('iOS broker appends raw route segments exactly once', () => {
  assert.match(
    source,
    /path\.split\(separator: "\/", omittingEmptySubsequences: true\)\.reduce\(baseURL\)/,
  )
  assert.match(
    source,
    /\.appendingPathComponent\(String\(\$1\), isDirectory: false\)/,
  )
  assert.doesNotMatch(
    source,
    /addingPercentEncoding\(withAllowedCharacters: \.urlPathAllowed\)/,
  )
  assert.doesNotMatch(source, /encoded\((?:jobID|id|seriesID|result\.jobId)\)/)
})

test('iOS broker preserves server error bodies for upload and rendered assets', () => {
  assert.match(
    source,
    /func upload[\s\S]*?let \(body, response\)[\s\S]*?validate\(response, body: body\)/,
  )
  assert.match(
    source,
    /func renderedAsset[\s\S]*?let \(data, response\)[\s\S]*?validate\(response, body: data\)/,
  )
})

test('iOS app language is independent and defaults to English', () => {
  assert.match(source, /private let key = "ComicSubAppLanguage\.v1"/)
  assert.match(source, /return \.english/)
  assert.match(source, /text\("App Language", "Ngôn ngữ ứng dụng"\)/)
  assert.doesNotMatch(source, /var appLanguage.+ReaderSettings/)
})

test('iOS automatic mode prefers an installed language pack and pins remote Gemini 3.6 Flash', () => {
  assert.match(
    source,
    /case \.automatic:[\s\S]*?state == \.installed[\s\S]*?return true[\s\S]*?!settingsStore\.loadToken\(\)\.isEmpty[\s\S]*?return false/,
  )
  assert.match(
    source,
    /"provider": "gemini", "model": "gemini-3\.6-flash", "allowedFallbacks": \[\]/,
  )
})

test('iOS overlay bridge creates its layer before layout and rendering', () => {
  assert.match(
    source,
    /const targetFor = id => \{[\s\S]*?ensureLayer\(id\);[\s\S]*?return layout\(id\);[\s\S]*?\};/,
  )
  assert.match(source, /const applyRendered = [\s\S]*?const target = targetFor\(id\)/)
  assert.match(source, /const applyRegions = [\s\S]*?const target = targetFor\(id\)/)
})

test('iOS reader renders broker regions directly and ignores its own overlay mutations', () => {
  const remoteFlow = source.match(
    /private func translate\(_ selected:[\s\S]*?private func translateFullyOnDevice/,
  )?.[0] ?? ''
  assert.match(remoteFlow, /attachRegions\(result, to: selected\[offset\]\)/)
  assert.doesNotMatch(remoteFlow, /client\.renderedAsset/)
  assert.match(source, /const belongsToReaderLayer =/)
  assert.match(source, /mutations\.some\(mutation => !isReaderMutation\(mutation\)\)/)
})

test('Translate Current defaults to one image and on-device OCR starts with the fast Vision path', () => {
  assert.match(source, /var lookAhead = 0/)
  assert.match(
    source,
    /case \.visible:\s+selected = candidates\.first\(where: \{ \$0\.index >= currentAnchor\.index \}\)\.map \{ \[\$0\] \}/,
  )
  assert.match(source, /level: \.fast/)
  assert.match(source, /usesLanguageCorrection: false/)
  assert.match(source, /request\.recognitionLevel = level/)
  assert.match(source, /session\.translations\(from: requests\)/)
})

test('CJK on-device OCR refines suspicious fast results and rejects Latin garbage', () => {
  assert.match(source, /if needsAccuratePass\(fast, sourceLanguage: sourceLanguage\)/)
  assert.match(source, /level: \.accurate/)
  assert.match(source, /usesLanguageCorrection: true/)
  assert.match(source, /return cjkCount > 0/)
  assert.match(source, /mergeDialogueLines\(/)
  assert.match(source, /source: previous\.source \+ region\.source/)
  assert.match(source, /const fitText = node =>/)
  assert.match(source, /if \(!semanticOnly\) fitText\(node\)/)
})

test('Safe Automatic prefers an installed Apple language pack before broker credentials', () => {
  const automatic = source.indexOf('case .automatic:')
  const installed = source.indexOf('if state == .installed', automatic)
  const token = source.indexOf('if !settingsStore.loadToken().isEmpty', automatic)
  assert.ok(automatic >= 0 && installed > automatic && token > installed)
  assert.match(source, /Uses Apple Vision \+ Translation on device first/)
})

test('iOS remote route uploads adaptive page windows before waiting for results', () => {
  assert.match(source, /stride\(from: 0, to: indexedJobs\.count, by: 4\)/)
  assert.match(source, /withThrowingTaskGroup\(of: Void\.self\)/)
  const upload = source.indexOf('client.upload(jobID: job.jobId, image: image)')
  const flush = source.indexOf('client.flushBatch(batch.batchId)', upload)
  const settle = source.indexOf('pollSettled(client: client, jobID: job.jobId)', upload)
  assert.ok(upload >= 0 && flush > upload && settle > flush)
  assert.match(source, /v1\/job-batches\/\\\(batchID\)\/flush/)
})

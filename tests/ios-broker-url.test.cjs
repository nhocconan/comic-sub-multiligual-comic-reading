const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

const source = readFileSync(
  resolve(__dirname, '..', 'apple', 'Manga Sub', 'Manga Sub', 'ViewController.swift'),
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

test('iOS automatic mode prefers configured cloud quality and pins remote Gemini 3.6 Flash', () => {
  assert.match(
    source,
    /case \.automatic:[\s\S]*?!settingsStore\.loadToken\(\)\.isEmpty[\s\S]*?return false[\s\S]*?state == \.installed[\s\S]*?return true/,
  )
  assert.match(
    source,
    /"provider": "gemini", "model": "gemini-3\.6-flash", "allowedFallbacks": \[\]/,
  )
})

test('iOS overlay bridge creates its layer before layout and rendering', () => {
  assert.match(
    source,
    /const targetFor = \(id, index, sourceURL\) => \{[\s\S]*?ensureLayer\(id\);[\s\S]*?return layout\(id, index, sourceURL\);[\s\S]*?\};/,
  )
  assert.match(source, /const applyRendered = [\s\S]*?const target = targetFor\(id, index, sourceURL\)/)
  assert.match(source, /const applyRegions = [\s\S]*?const target = targetFor\(id, index, sourceURL\)/)
  assert.match(source, /normalizedURL\(candidateURL\(item\)\) === expectedURL/)
  assert.match(source, /image = images\[index\]/)
  assert.match(source, /image\.__comicSubCandidateId = id/)
  assert.match(source, /position:absolute/)
  assert.match(source, /rect\.left \+ scrollX/)
  assert.match(source, /rect\.top \+ scrollY/)
  assert.match(source, /document\.documentElement\.append\(layer\)/)
  assert.match(source, /const anchors = new Map\(\)/)
  assert.match(source, /const alignmentReport = \(\) =>/)
  assert.match(source, /COMIC_SUB_QA_POST_SCROLL_FRAGMENT/)
  assert.match(source, /requestAnimationFrame\(\(\) => \{ relayoutFrame = 0; relayout\(\); \}\)/)
  assert.match(source, /addEventListener\('scroll', announceAnchor/)
  assert.match(source, /try await attachRegions\(result, to: candidate\)/)
  assert.match(source, /let result = try await webView\.evaluateJavaScript\(script\)/)
  assert.match(source, /guard \(result as\? Bool\) == true/)
  assert.match(source, /translatedCandidateIDs\.insert\(candidate\.id\)/)
  assert.match(source, /translations visible/)
})

test('iOS reader renders broker regions directly and ignores its own overlay mutations', () => {
  const remoteFlow = source.match(
    /private func translate\(_ selected:[\s\S]*?private func translateFullyOnDevice/,
  )?.[0] ?? ''
  assert.match(remoteFlow, /try await attachRegions\(result, to: selected\[offset\]\)/)
  assert.doesNotMatch(remoteFlow, /client\.renderedAsset/)
  assert.match(source, /const belongsToReaderLayer =/)
  assert.match(source, /mutations\.some\(mutation => !isReaderMutation\(mutation\)\)/)
  assert.match(source, /result\.overlayRegions\.removeAll\(where: isLikelyPublisherWatermark\)/)
  assert.match(source, /private func isLikelyPublisherWatermark/)
  assert.match(source, /content\.contains\("www\."\)/)
})

test('Translate Current selects the image most visible at click time and OCR starts fast', () => {
  assert.match(source, /var lookAhead = 0/)
  assert.match(source, /const currentCandidateId = \(\) =>/)
  assert.match(source, /visibleWidth \* visibleHeight/)
  assert.match(source, /currentCandidateId\(\)"/)
  assert.match(source, /self\.startTranslation\(candidate\.map \{ \[\$0\] \} \?\? \[\]\)/)
  assert.match(source, /level: \.fast/)
  assert.match(source, /usesLanguageCorrection: false/)
  assert.match(source, /request\.recognitionLevel = level/)
  assert.match(source, /session\.translations\(from: requests\)/)
})

test('CJK on-device OCR refines suspicious fast results and rejects Latin garbage', () => {
  assert.match(source, /if isCJK\(sourceLanguage\)/)
  assert.match(source, /One accurate pass is both faster than the old fast\+accurate union/)
  assert.doesNotMatch(source, /regions = \(fast \+ accurate\)/)
  assert.match(source, /level: \.accurate/)
  assert.match(source, /usesLanguageCorrection: true/)
  assert.match(source, /return cjkCount > 0/)
  assert.match(source, /mergeDialogueLines\(/)
  assert.match(source, /shouldMergeDialogue\(/)
  assert.match(source, /overlap \/ smallerArea >= 0\.48/)
  assert.match(source, /let bubbleSized = unionWidth <= pageWidth \* 0\.38/)
  assert.match(source, /const fitText = node =>/)
  assert.match(source, /if \(!semanticOnly\) fitText\(node\)/)
  assert.match(source, /const lengthRatio = targetLength \/ sourceLength/)
  assert.match(source, /Math\.min\(2, 1 \+ Math\.max\(0, lengthRatio - 1\) \* \.25\)/)
  assert.match(source, /while \(size > 8/)
  assert.match(source, /const coalesceRegions = \(regions, page\) =>/)
  assert.match(source, /overlapRatio < \.55/)
  assert.match(source, /const displayRegions = coalesceRegions\(regions, page\)/)
  assert.match(source, /!isSiteWatermark\(text\)/)
  assert.match(source, /"包子漫画", "包子漫畫"/)
})

test('iOS 26 translates every local page contextually in one direct batch without a modal', () => {
  assert.match(source, /var preparedPages: \[OnDevicePreparedPage\] = \[\]/)
  assert.match(source, /let contextualPayloads = pagePlans\.map/)
  assert.match(source, /let translatedPages = try await translateOnDevice\(contextualPayloads\)/)
  assert.match(source, /parseContextualTranslations\(/)
  assert.ok(source.includes('"【\\(offset + 1)】\\(source)"'))
  assert.match(source, /if #available\(iOS 26\.0, \*\)/)
  assert.match(source, /TranslationSession\(\s*installedSource:/)
  const localPipeline = source.match(
    /private func translateFullyOnDevice[\s\S]*?private func routeContract/,
  )?.[0] ?? ''
  assert.equal((localPipeline.match(/translateOnDevice\(contextualPayloads\)/g) ?? []).length, 1)
  assert.match(source, /resolvedLocalTranslation\(source: source, translated:/)
  assert.match(source, /"啊": "A"/)
})

test('Safe Automatic prefers configured broker quality before installed Apple fallback', () => {
  const automatic = source.indexOf('case .automatic:')
  const installed = source.indexOf('if state == .installed', automatic)
  const token = source.indexOf('if !settingsStore.loadToken().isEmpty', automatic)
  assert.ok(automatic >= 0 && token > automatic && installed > token)
  assert.match(source, /Uses Manga Sub Cloud when configured/)
})

test('iOS QA can exercise real on-device Translation separately from the deterministic stub', () => {
  assert.match(source, /case "local", "local-stub": settings\.route = \.onDevice/)
  assert.match(source, /COMIC_SUB_QA_ROUTE"\] == "local-stub"/)
})

test('iOS remote route keeps pixels local and sends OCR page windows before waiting for results', () => {
  const remotePipeline = source.match(
    /private func translate\(_ selected:[\s\S]*?private func translateFullyOnDevice/,
  )?.[0] ?? ''
  assert.match(remotePipeline, /var recognizedPages: \[String: OnDeviceOCRPage\] = \[:\]/)
  assert.match(remotePipeline, /OnDeviceComicOCR\(\)\.recognize/)
  assert.match(remotePipeline, /clientOcr: recognizedPages/)
  assert.doesNotMatch(remotePipeline, /client\.upload\(/)
  assert.match(source, /stride\(from: 0, to: indexedJobs\.count, by: 4\)/)
  const flush = remotePipeline.indexOf('client.flushBatch(batch.batchId)')
  const settle = remotePipeline.indexOf('pollSettled(client: client, jobID: job.jobId)')
  assert.ok(flush >= 0 && settle > flush)
  assert.match(source, /v1\/job-batches\/\\\(batchID\)\/flush/)
  assert.match(source, /http\.statusCode == 404/)
  assert.match(source, /error\["code"\] as\? String == "ROUTE_NOT_FOUND"/)
  assert.match(source, /Broker builds before the explicit flush endpoint/)
})

test('iOS canonicalizes comic candidates before snapshot and batch creation', () => {
  assert.match(source, /private func canonicalCandidates\(_ values: \[WebCandidate\]\)/)
  assert.match(source, /seenIDs\.insert\(candidate\.id\)\.inserted/)
  assert.match(source, /seenURLs\.insert\(normalizedURL\)\.inserted/)
  assert.match(source, /private func makeSnapshot[\s\S]*?let candidates = canonicalCandidates\(candidates\)/)
  assert.match(source, /private func makeBatchRequest[\s\S]*?let candidates = canonicalCandidates\(candidates\)/)
  assert.match(source, /let uniqueCandidates = canonicalCandidates\(decoded\)[\s\S]*?candidates = uniqueCandidates/)
})

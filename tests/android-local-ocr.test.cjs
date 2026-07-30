const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

const androidRoot = resolve(
  __dirname,
  '..',
  'android',
  'app',
  'src',
  'main',
  'java',
  'com',
  'tienle',
  'comicsub',
  'reader',
)
const mainActivity = readFileSync(resolve(androidRoot, 'MainActivity.kt'), 'utf8')
const broker = readFileSync(resolve(androidRoot, 'BrokerClient.kt'), 'utf8')
const ocr = readFileSync(resolve(androidRoot, 'OnDeviceOcr.kt'), 'utf8')
const translator = readFileSync(resolve(androidRoot, 'OnDeviceTranslator.kt'), 'utf8')
const overlays = readFileSync(resolve(androidRoot, 'ReaderScripts.kt'), 'utf8')
const readerPolicy = readFileSync(resolve(androidRoot, 'ReaderPolicy.kt'), 'utf8')
const gradle = readFileSync(
  resolve(__dirname, '..', 'android', 'app', 'build.gradle.kts'),
  'utf8',
)

test('Android bundles Chinese OCR and never exposes an image-upload route', () => {
  assert.match(gradle, /com\.google\.mlkit:text-recognition-chinese:16\.0\.1/)
  assert.match(gradle, /com\.google\.mlkit:text-recognition-japanese:16\.0\.1/)
  assert.match(ocr, /ChineseTextRecognizerOptions\.Builder\(\)\.build\(\)/)
  assert.match(ocr, /JapaneseTextRecognizerOptions\.Builder\(\)\.build\(\)/)
  assert.match(ocr, /recognizer\.process\(InputImage\.fromBitmap\(bitmap, 0\)\)/)
  assert.match(mainActivity, /deviceOcr\.recognizeBlocking\(asset\)/)
  assert.doesNotMatch(mainActivity, /\.uploadAsset\(/)
  assert.doesNotMatch(broker, /\/asset/)
  assert.doesNotMatch(broker, /x-content-sha256/)
  assert.match(broker, /\.put\("translationMode", "client-ocr"\)/)
  assert.match(broker, /\.put\("clientOcr"/)
})

test('Android sends OCR text and stable source geometry to remote translation', () => {
  assert.match(broker, /\.put\("source", region\.source\)/)
  assert.match(broker, /\.put\("x", region\.x\)/)
  assert.match(broker, /\.put\("y", region\.y\)/)
  assert.match(broker, /\.put\("width", region\.width\)/)
  assert.match(broker, /\.put\("height", region\.height\)/)
  assert.match(broker, /\.put\("ocrVersion", "mlkit-text-recognition-v2-chinese"\)/)
  assert.match(ocr, /mergeDialogueBlocks\(contextual/)
  assert.match(ocr, /highContrastGrayscale\(bitmap\)/)
  assert.match(ocr, /Tasks\.whenAllSuccess<Text>\(passes\)/)
  assert.match(ocr, /recognitionScore\(candidate\.source\)/)
  assert.match(ocr, /\.filter\(::isSuspiciousRecognition\)/)
  assert.match(ocr, /retryCrop\(bitmap, it, scaleX, scaleY\)/)
  assert.match(ocr, /mapRetryText\(recognized, retryCrops\[index\]/)
  assert.match(ocr, /hanCount > 0 && hanCount \* 2 >= latinCount/)
  assert.match(ocr, /normalizeWithPageContext\(rawRegions\)/)
  assert.match(ocr, /editDistance\(current, candidate\)/)
  assert.match(ocr, /value\.replace\('カ', '力'\)/)
  assert.match(ocr, /overlapRatio >= 0\.35/)
  assert.match(ocr, /normalized\.contains\("baozimh"\)/)
})

test('Android translates every OCR region concurrently instead of serially', () => {
  assert.match(translator, /val tasks = regions\.map \{ translator\.translate\(it\.source\) \}/)
  assert.match(translator, /Tasks\.whenAllSuccess<String>\(tasks\)/)
  assert.doesNotMatch(translator, /translateAt\(/)
})

test('Android overlays recompute boxes and fitted text after scroll or resize', () => {
  assert.match(overlays, /window\.__comicSubRenderLayer =/)
  assert.match(overlays, /item\.__comicSubRegions \|\| \[\]/)
  assert.match(overlays, /requestAnimationFrame/)
  assert.match(overlays, /box\.style\.width/)
  assert.match(overlays, /box\.style\.height/)
  assert.match(overlays, /box\.scrollWidth > box\.clientWidth/)
  assert.match(overlays, /box\.scrollHeight > box\.clientHeight/)
  assert.match(overlays, /const extraLines = Math\.min/)
  assert.match(overlays, /sourceRegionHeight \* extraLines/)
  assert.match(overlays, /box\.__comicSubMaxFont/)
  assert.match(overlays, /const measuredHeight = box\.scrollHeight/)
  assert.doesNotMatch(overlays, /Math\.max\(32,region\.width/)
  assert.doesNotMatch(overlays, /Math\.max\(24,region\.height/)
})

test('Translate Current ranks images by visible area, not center proximity', () => {
  assert.match(overlays, /visibleHeight: Math\.max\(0, Math\.min\(rect\.bottom, innerHeight\)/)
  assert.match(readerPolicy, /filter \{ it\.visibleHeight > 0 \}/)
  assert.match(readerPolicy, /compareBy<ComicCandidate> \{ it\.visibleHeight \}/)
  assert.match(readerPolicy, /maxWithOrNull/)
  assert.match(mainActivity, /ReaderPolicy\.currentCandidate\(candidates\)/)
})

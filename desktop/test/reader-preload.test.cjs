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
  assert.match(source, /function overlayLayer\(item\)/)
  assert.match(source, /comic-sub-overlay-layer/)
  assert.match(source, /\.comic-sub-overlay-layer\{position:absolute;/)
  assert.match(source, /\.comic-sub-overlay-layer\{position:absolute;z-index:2;/)
  assert.doesNotMatch(source, /\.comic-sub-overlay-layer\{position:fixed;/)
  assert.match(source, /document\.documentElement\.append\(layer\)/)
  assert.match(source, /layer\.style\.left = `\$\{imageRect\.left \+ window\.scrollX\}px`/)
  assert.match(source, /layer\.style\.top = `\$\{imageRect\.top \+ window\.scrollY\}px`/)
  assert.match(source, /layer\.style\.width = `\$\{imageRect\.width\}px`/)
  assert.match(source, /layer\.style\.height = `\$\{imageRect\.height\}px`/)
  assert.match(source, /const width = Math\.min\(imageRect\.width, rawWidth \* 1\.18\)/)
  assert.match(source, /const height = Math\.min\(imageRect\.height, rawHeight \* 1\.28\)/)
  assert.match(source, /window\.addEventListener\('scroll', scheduleOverlayRelayout/)
  assert.match(source, /safeOverlayText\(region\.translation\)/)
  assert.match(source, /function fitOverlayText\(overlay, maximumFontSize\)/)
  assert.match(source, /Math\.min\(21, rawHeight \* \.72, imageRect\.width \/ 34\)/)
  assert.match(source, /function canonicalRegions\(regions\)/)
  assert.match(source, /function scheduleOverlayRelayout\(\)/)
  assert.match(source, /new ResizeObserver\(scheduleOverlayRelayout\)/)
  assert.match(source, /currentOverlayItem\(descriptor\)/)
  assert.match(source, /command\.type === 'reset-translations'/)
  assert.match(source, /item\.translated = false/)
  assert.match(source, /querySelectorAll\?\.\('\.comic-sub-overlay'\)/)
  assert.match(source, /const seenSources = new Set\(\)/)
  assert.match(source, /previousBySource\.get\(sourceUrl\)/)
  assert.doesNotMatch(source, /const found = \[\.\.\.document\.images\]/)
  assert.doesNotMatch(source, /comic-sub-host/)
})

test('main process does not cancel a job for a same-navigation lazy rescan', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8')
  const guard = source.match(/function assertCurrentNavigation\(snapshot\) \{([\s\S]*?)\n\}/)?.[1] || ''
  assert.match(guard, /activeSnapshot\.navigationId !== snapshot\.navigationId/)
  assert.doesNotMatch(guard, /activeSnapshot\.snapshotId !== snapshot\.snapshotId/)
})

test('desktop cloud path OCRs locally and sends text geometry without uploading images', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8')
  const batch = source.match(/async function runBrokerBatch\(snapshot, selectedIds\) \{([\s\S]*?)\n\}/)?.[1] || ''
  const job = source.match(/async function runBrokerJob\(client, snapshot, job, candidate, controller\) \{([\s\S]*?)\n\}/)?.[1] || ''
  assert.match(source, /function recognizeLocalText\(asset, language, signal\)/)
  assert.match(source, /function mergeLocalOcrRegions\(value\)/)
  assert.match(source, /function isPublisherWatermark\(text\)/)
  assert.match(batch, /clientOcr\[candidateId\] = await recognizeLocalText/)
  assert.match(batch, /client\.createBatch\(batchPayload\(snapshot, group, clientOcr\)\)/)
  assert.doesNotMatch(batch, /client\.upload/)
  assert.doesNotMatch(job, /fetchRegisteredAsset/)
  assert.doesNotMatch(job, /client\.upload/)
})

test('desktop local route uses native Apple Translation without invoking the broker', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8')
  assert.match(source, /local:\s*runLocalBatch/)
  assert.match(source, /translateLocalTextPages\(pages,\s*controller\.signal\)/)
  const localBatch = source.slice(
    source.indexOf('async function runLocalBatch'),
    source.indexOf('async function runByoBatch'),
  )
  assert.doesNotMatch(localBatch, /brokerClient|createBatch|registerSnapshot/)
  assert.match(localBatch, /recognizeLocalText/)
})

test('desktop BYO route uses bounded three-page micro-batches with bounded concurrency', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8')
  const byoBatch = source.slice(
    source.indexOf('async function runByoBatch'),
    source.indexOf('async function cancelActiveJobs'),
  )
  assert.match(source, /function byoTranslationGroups\(pages\)/)
  assert.match(source, /current\.length >= 3/)
  assert.match(source, /regionCount \+ regions\.length > 180/)
  assert.match(source, /sourceCharacters \+ pageCharacters > 20_000/)
  assert.match(byoBatch, /translateOcrPages\(config, key, pageGroup/)
  assert.match(byoBatch, /Math\.min\(3, translationGroups\.length\)/)
  assert.doesNotMatch(byoBatch, /translateOcrPages\(config, key, group\.map/)
})

test('macOS credential access runs out of process with a bounded timeout', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8')
  assert.match(source, /function runCredentialHelper\(command, input = null, service = /)
  assert.match(source, /spawn\(nativeCredentialExecutable\(\), \[command\]/)
  assert.match(source, /MANGA_SUB_CREDENTIAL_SERVICE: service/)
  assert.match(source, /'CREDENTIAL_TIMEOUT'/)
  assert.match(source, /}, 5_000\)/)
  assert.match(source, /token: await readToken\(\)/)
  assert.match(source, /const client = await brokerClient\(\)/)
})

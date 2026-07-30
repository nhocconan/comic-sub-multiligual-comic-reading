import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const extension = resolve(root, 'extension')
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'))

assert.equal(manifest.manifest_version, 3)
assert.equal(manifest.background.service_worker, 'background.js')
assert.ok(!manifest.host_permissions.includes('<all_urls>'))
assert.ok(!manifest.permissions.includes('tabs'))
assert.ok(manifest.permissions.includes('activeTab'))
assert.ok(manifest.permissions.includes('scripting'))
assert.equal(manifest.content_scripts, undefined, 'content scripts must be click-injected')
assert.deepEqual(
  manifest.host_permissions.sort(),
  ['http://127.0.0.1/*', 'http://localhost/*'].sort(),
  'permanent network access must be loopback-only',
)
assert.deepEqual(
  manifest.optional_host_permissions.sort(),
  ['http://*/*', 'https://*/*'].sort(),
  'comic image access must be optional',
)

for (const file of ['background.js', 'content.js', 'popup.js', 'lib/core.js']) {
  const source = await readFile(resolve(extension, file), 'utf8')
  assert.doesNotMatch(source, /\beval\s*\(/, `${file} must not use eval`)
  assert.doesNotMatch(source, /new\s+Function\s*\(/, `${file} must not use new Function`)
  assert.doesNotMatch(source, /innerHTML\s*=/, `${file} must not assign untrusted innerHTML`)
}

const popup = await readFile(resolve(extension, 'popup.html'), 'utf8')
assert.doesNotMatch(popup, /<script(?![^>]*\bsrc=)/i, 'popup scripts must be external')
assert.doesNotMatch(popup, /\son[a-z]+\s*=/i, 'popup must not use inline event handlers')
assert.match(popup, /id="auth-key"[\s\S]*type="password"/, 'remote auth must use a password field')

const popupSource = await readFile(resolve(extension, 'popup.js'), 'utf8')
const contentSource = await readFile(resolve(extension, 'content.js'), 'utf8')
const contentSettingsBody =
  popupSource.match(/function contentSettings\(settings\)\s*\{([\s\S]*?)\n\}/)?.[1] || ''
assert.ok(contentSettingsBody, 'popup must explicitly sanitize settings sent to content scripts')
assert.doesNotMatch(contentSettingsBody, /authKey/, 'auth key must never enter content scripts')
assert.match(
  popupSource,
  /type:\s*'SCAN_PAGE',\s*scope:\s*'all'/,
  'Dịch trang này must select stable translate-all ordering before scanning',
)
const pageHideHandler =
  contentSource.match(/addEventListener\(\s*'pagehide',[\s\S]*?\{ once: true \},\s*\)/)?.[0] || ''
assert.ok(pageHideHandler, 'content script must handle pagehide cleanup')
assert.doesNotMatch(
  pageHideHandler,
  /CANCEL_TRANSLATION/,
  'temporary Safari page hiding must not cancel an in-flight translation',
)

const backgroundSource = await readFile(resolve(extension, 'background.js'), 'utf8')
assert.match(
  backgroundSource,
  /headers\.set\('Authorization', `Bearer \$\{normalizedKey\}`\)/,
  'background must attach the optional bearer key',
)

console.log('Manifest and extension security checks passed.')

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const popupPath = resolve(__dirname, '..', 'extension', 'popup.js')
const popupSource = readFileSync(popupPath, 'utf8')

function popupFunction(name) {
  const match = popupSource.match(
    new RegExp(`async function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm'),
  )
  assert.ok(match, `Missing popup function ${name}`)
  return match[0]
}

function safariPermissionContext() {
  let userGesture = true
  const calls = []
  const settings = { endpoint: 'https://comic-be.dep.app/api/v1' }
  const elements = {
    candidateCount: { textContent: '' },
    healthDot: { dataset: {} },
    pageStatus: { textContent: '' },
    permissionDetail: { textContent: '' },
    permissionPanel: { hidden: true },
    permissionStatus: { hidden: true, textContent: '' },
    permissionTitle: { textContent: '' },
    refreshButton: { disabled: false, dataset: {}, textContent: 'Kiểm tra' },
    scanButton: { disabled: false, dataset: {}, textContent: 'Dịch trang này' },
  }

  const context = {
    Promise,
    URL,
    applyProviderCatalog() {},
    chrome: {
      permissions: {
        async contains() {
          calls.push(`contains:${userGesture}`)
          return false
        },
        async request() {
          calls.push(`request:${userGesture}`)
          if (!userGesture) {
            throw new Error(
              'Invalid call to permissions.request(). Must be called during a user gesture.',
            )
          }
          return true
        },
      },
      runtime: {
        async sendMessage(message) {
          calls.push(`runtime:${message.type}`)
          return message.type === 'ACTIVATE_TAB'
            ? { ok: true }
            : { ok: true, state: 'ready' }
        },
      },
    },
    currentOrigins: [],
    elements,
    endpointPattern() {
      return 'https://comic-be.dep.app/*'
    },
    errorMessage(error, fallback) {
      return error?.message || fallback
    },
    async getActiveTab() {
      calls.push('getActiveTab')
      return { id: 7 }
    },
    async injectContent() {
      calls.push('injectContent')
    },
    async inspectPermissions() {
      return []
    },
    pendingPermissionPatterns: [],
    async persistSettings() {
      calls.push('persistSettings')
      return settings
    },
    readSettings() {
      calls.push('readSettings')
      return settings
    },
    renderContentStatus() {},
    renderHealth() {},
    async sendToTab(message) {
      calls.push(`tab:${message.type}`)
      return message.type === 'SCAN_PAGE'
        ? { ok: true, origins: [] }
        : { ok: true }
    },
    setBusy() {},
    showToast() {},
  }

  vm.createContext(context)
  vm.runInContext(
    [
      popupFunction('ensureEndpointPermission'),
      popupFunction('checkHealth'),
      popupFunction('scanPage'),
      'globalThis.ensureEndpointPermission = ensureEndpointPermission',
      'globalThis.checkHealth = checkHealth',
      'globalThis.scanPage = scanPage',
    ].join('\n'),
    context,
    { filename: popupPath },
  )

  return {
    calls,
    context,
    endUserGesture() {
      userGesture = false
    },
  }
}

test('Koharu permission request stays inside the Kiểm tra click gesture', async () => {
  const harness = safariPermissionContext()

  const pending = harness.context.checkHealth(true)
  harness.endUserGesture()
  await pending

  assert.ok(
    harness.calls.includes('request:true'),
    `Permission request escaped the click gesture: ${harness.calls.join(' -> ')}`,
  )
  assert.ok(!harness.calls.includes('request:false'))
})

test('Koharu permission request stays inside the Dịch trang này click gesture', async () => {
  const harness = safariPermissionContext()

  const pending = harness.context.scanPage()
  harness.endUserGesture()
  await pending

  assert.ok(
    harness.calls.includes('request:true'),
    `Permission request escaped the click gesture: ${harness.calls.join(' -> ')}`,
  )
  assert.ok(!harness.calls.includes('request:false'))
})

test('content script is injected when Safari returns no status response', async () => {
  const calls = []
  const context = {
    chrome: {
      tabs: {
        async sendMessage(_tabId, message) {
          calls.push(`tab:${message.type}`)
          return undefined
        },
      },
      scripting: {
        async insertCSS(details) {
          calls.push(`css:${details.files.join(',')}`)
        },
        async executeScript(details) {
          calls.push(`script:${details.files.join(',')}`)
        },
      },
    },
  }

  vm.createContext(context)
  vm.runInContext(
    [
      popupFunction('injectContent'),
      'globalThis.injectContent = injectContent',
    ].join('\n'),
    context,
    { filename: popupPath },
  )

  await context.injectContent(7)

  assert.deepEqual(calls, [
    'tab:GET_CONTENT_STATUS',
    'css:content.css',
    'script:lib/core.js',
    'script:content.js',
  ])
})

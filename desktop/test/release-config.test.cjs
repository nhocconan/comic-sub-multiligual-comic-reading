const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..', '..')
const desktopPackage = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'))
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-desktop.yml'), 'utf8')

test('desktop release assets have stable latest-download names', () => {
  assert.equal(desktopPackage.version, '0.2.5')
  assert.equal(desktopPackage.build.mac.artifactName, 'Manga-Sub-mac-${arch}.${ext}')
  assert.equal(desktopPackage.build.win.artifactName, 'Manga-Sub-win-${arch}.${ext}')
  assert.deepEqual(desktopPackage.build.mac.target, [
    { target: 'dmg', arch: ['universal'] },
    { target: 'zip', arch: ['universal'] },
  ])
})

test('Windows release verifies the unsigned installer and uploads stable assets', () => {
  assert.match(workflow, /CSC_IDENTITY_AUTO_DISCOVERY: 'false'/)
  assert.match(workflow, /Get-AuthenticodeSignature/)
  assert.match(workflow, /Status -ne 'NotSigned'/)
  assert.match(workflow, /Manga-Sub-win-x64\.exe/)
  assert.match(workflow, /Manga-Sub-win-x64\.exe\.sha256/)
  assert.match(workflow, /gh release upload \"\$RELEASE_TAG\"/)
  assert.doesNotMatch(workflow, /WINDOWS_CSC_LINK|SIGNPATH_API_TOKEN/)
})

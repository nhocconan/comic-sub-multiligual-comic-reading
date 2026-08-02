const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..', '..')
const desktopPackage = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'))
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-desktop.yml'), 'utf8')

test('desktop release assets have stable latest-download names', () => {
  assert.equal(desktopPackage.version, '0.2.4')
  assert.equal(desktopPackage.build.mac.artifactName, 'Manga-Sub-mac-${arch}.${ext}')
  assert.equal(desktopPackage.build.win.artifactName, 'Manga-Sub-win-${arch}.${ext}')
  assert.deepEqual(desktopPackage.build.mac.target, [
    { target: 'dmg', arch: ['universal'] },
    { target: 'zip', arch: ['universal'] },
  ])
})

test('Windows release refuses unsigned publication and uploads to the tag release', () => {
  assert.match(workflow, /WINDOWS_CSC_LINK/)
  assert.match(workflow, /WINDOWS_CSC_KEY_PASSWORD/)
  assert.match(workflow, /Refusing to publish an unsigned Windows installer/)
  assert.match(workflow, /gh release upload \"\$RELEASE_TAG\" desktop\/dist\/\* --clobber/)
})

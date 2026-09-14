import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const PUBLIC_ASSETS = join(ROOT, 'public', 'assets')
const MANIFEST_FILE = join(PUBLIC_ASSETS, 'models', 'manifest.json')
const RIGHTS_FILE = join(ROOT, 'data', 'asset-rights.json')
const RELEASE_ID = 'equipment-bases-40520897dfea4af085180fc82b0083baa'
const MALE_URL = `/assets/models/quaternius/${RELEASE_ID}/human-male.glb`
const FEMALE_URL = `/assets/models/quaternius/${RELEASE_ID}/human-female.glb`
const SKELETON_URL = '/assets/models/quaternius/actors-b892de8fd4f015796032/skeleton.glb'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const relativeAssetPath = (url) => url.replace(/^\/assets\//u, '')

test('actor manifest equipmentUrl и immutable gear bases совпадают с rights registry', async () => {
  const manifest = JSON.parse(await readFile(MANIFEST_FILE, 'utf8'))
  const rights = JSON.parse(await readFile(RIGHTS_FILE, 'utf8'))
  const byPath = new Map(rights.assets.map((entry) => [entry[0], entry]))
  const byKey = new Map(manifest.models.map((entry) => [entry.key, entry]))

  assert.equal(manifest.version, 1)
  assert.equal(byKey.size, manifest.models.length)
  assert.deepEqual(byKey.get('hooded-mage')?.equipmentUrl, MALE_URL)
  assert.deepEqual(byKey.get('traveler')?.equipmentUrl, MALE_URL)
  assert.deepEqual(byKey.get('ranger')?.equipmentUrl, MALE_URL)
  assert.deepEqual(byKey.get('warrior')?.equipmentUrl, MALE_URL)
  assert.deepEqual(byKey.get('mage')?.equipmentUrl, MALE_URL)
  assert.deepEqual(byKey.get('rogue')?.equipmentUrl, MALE_URL)
  assert.deepEqual(byKey.get('skeleton')?.equipmentUrl, SKELETON_URL)
  assert.equal(byKey.get('human-female')?.profile, 'warrior')
  assert.deepEqual(byKey.get('human-female')?.archetypes, [])
  assert.deepEqual(byKey.get('human-female')?.equipmentUrl, FEMALE_URL)
  for (const key of ['wolf', 'goblin-quaternius', 'skeleton-quaternius', 'goblin', 'beast']) assert.equal(Object.hasOwn(byKey.get(key) ?? {}, 'equipmentUrl'), false, `${key}: не должен получать human gear base`)

  const releaseDir = join(PUBLIC_ASSETS, 'models', 'quaternius', RELEASE_ID)
  assert.deepEqual((await readdir(releaseDir)).sort(), ['LICENSE.txt', 'NOTICE.json', 'human-female.glb', 'human-male.glb'])
  const notice = JSON.parse(await readFile(join(releaseDir, 'NOTICE.json'), 'utf8'))
  assert.equal(notice.immutableRelease.id, RELEASE_ID)
  assert.equal(notice.immutableRelease.glbConcatSha256, '40520897dfea4af085180fc82b0083baa9e15ba3dcd1160b140f5eb42fa1d879')

  const referencedUrls = new Set([MALE_URL, FEMALE_URL, SKELETON_URL])
  for (const url of referencedUrls) {
    const assetPath = relativeAssetPath(url)
    assert.match(assetPath, /^models\/.*\.glb$/u)
    const file = join(PUBLIC_ASSETS, assetPath)
    assert.equal((await stat(file)).isFile(), true, `${url}: файл не найден`)
    const bytes = await readFile(file)
    const registered = byPath.get(assetPath)
    assert.ok(registered, `${assetPath}: отсутствует rights registry`)
    assert.equal(registered[1], digest(bytes), `${assetPath}: SHA-256 drift`)
    assert.equal(registered[2], bytes.length, `${assetPath}: размер drift`)
  }

  const releaseFiles = ['human-female.glb', 'human-male.glb', 'LICENSE.txt', 'NOTICE.json']
  for (const name of releaseFiles) {
    const assetPath = `models/quaternius/${RELEASE_ID}/${name}`
    const bytes = await readFile(join(PUBLIC_ASSETS, assetPath))
    const registered = byPath.get(assetPath)
    assert.ok(registered, `${assetPath}: отсутствует rights registry`)
    assert.equal(registered[1], digest(bytes), `${assetPath}: SHA-256 drift`)
    assert.equal(registered[2], bytes.length, `${assetPath}: размер drift`)
  }
})

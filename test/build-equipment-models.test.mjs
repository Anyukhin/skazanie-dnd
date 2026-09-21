import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename, join } from 'node:path'
import test from 'node:test'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { ITEM_CATALOG } from '../server/item-catalog.mjs'
import { EQUIPMENT_ITEM_VISUALS } from '../server/equipment-visuals.mjs'
import { buildEquipmentModels, publishEquipmentCandidate } from '../tools/build-equipment-models.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const TMP_ROOT = join(ROOT, 'tmp')

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseWithLoader(bytes) {
  const previousSelf = globalThis.self
  const previousProgressEvent = globalThis.ProgressEvent
  const previousCreateImageBitmap = globalThis.createImageBitmap
  globalThis.self = globalThis
  globalThis.ProgressEvent ??= class { constructor(type, values) { this.type = type; Object.assign(this, values) } }
  globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} })
  const restore = () => {
    if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf
    if (previousProgressEvent === undefined) delete globalThis.ProgressEvent; else globalThis.ProgressEvent = previousProgressEvent
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previousCreateImageBitmap
  }
  return new Promise((resolve, reject) => new GLTFLoader().parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '',
    (gltf) => { restore(); resolve(gltf) },
    (error) => { restore(); reject(error) },
  ))
}

function dispose(scene) {
  const geometries = new Set()
  const materials = new Set()
  const textures = new Set()
  scene.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry)
    const values = Array.isArray(object.material) ? object.material : object.material ? [object.material] : []
    for (const material of values) {
      materials.add(material)
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value)
    }
  })
  for (const texture of textures) texture.dispose()
  for (const material of materials) material.dispose()
  for (const geometry of geometries) geometry.dispose()
}

test('кандидат содержит все модели слотов и ровно 83 каталожных id', async (t) => {
  const firstDir = await mkdtemp(join(TMP_ROOT, 'equipment-model-test-'))
  const secondDir = await mkdtemp(join(TMP_ROOT, 'equipment-model-test-'))
  t.after(async () => Promise.all([
    rm(firstDir, { recursive: true, force: true }),
    rm(secondDir, { recursive: true, force: true }),
  ]))

  const first = await buildEquipmentModels({ out: firstDir })
  const second = await buildEquipmentModels({ out: secondDir })
  const manifest = JSON.parse(await readFile(join(firstDir, 'manifest.json'), 'utf8'))
  const twinManifest = JSON.parse(await readFile(join(secondDir, 'manifest.json'), 'utf8'))

  assert.equal(manifest.schema, 'skazanie-equipment-model-candidate/v1')
  assert.equal(manifest.version, 1)
  assert.equal(manifest.build.canonicalHumanHeight, 1.4)
  assert.equal(manifest.build.catalogEquippableCount, 83)
  assert.equal(manifest.models.length, 76)
  assert.deepEqual(Object.fromEntries(manifest.models.reduce((map, model) => map.set(model.category, (map.get(model.category) ?? 0) + 1), new Map())), {
    weapon: 39,
    armor: 12,
    shield: 1,
    accessory: 24,
  })
  const equippableIds = Object.values(ITEM_CATALOG)
    .filter((entry) => entry.lifecycle?.equippable === true)
    .map((entry) => entry.catalog_id)
  const manifestIds = manifest.models.flatMap((model) => model.catalogIds)
  assert.equal(manifestIds.length, 83)
  assert.deepEqual([...new Set(manifestIds)].sort(), [...equippableIds].sort())
  assert.deepEqual([...first.manifest.models].map((model) => ({ ...model, bytes: undefined, sha256: undefined })),
    [...second.manifest.models].map((model) => ({ ...model, bytes: undefined, sha256: undefined })))
  assert.deepEqual(manifest.models.map((model) => model.sha256), twinManifest.models.map((model) => model.sha256))
  assert.ok(manifest.build.sourceInputs.every((input) => input.bytes > 0 && /^[a-f0-9]{64}$/u.test(input.sha256)))
  assert.match(await readFile(join(firstDir, 'NOTICE.txt'), 'utf8'), /каталожных id: 83/u)
  assert.ok(existsSync(join(firstDir, 'LICENSE.txt')))

  const shield = manifest.models.find((model) => model.key === 'shield')
  assert.ok(shield)
  assert.equal(Object.hasOwn(shield, 'coverage'), false, 'щит не должен становиться body coverage')
  for (const model of manifest.models.filter((value) => value.category === 'armor')) {
    assert.ok(Array.isArray(model.coverage) && model.coverage.length > 0, `${model.key}: нет coverage`)
    assert.equal(model.coverage.includes('chest') || model.coverage.includes('waist'), true)
  }
  assert.equal(manifest.models.find((model) => model.key === 'net').catalogIds.length, 0)
  const wands = manifest.models.filter((model) => model.key === 'wand')
  assert.deepEqual(wands.map((model) => model.variant), ['default', 'enchanted'])
  assert.deepEqual(wands[0].catalogIds, ['srd_5_2_1:arcane-focus-wand', 'srd_5_2_1:druidic-focus-yew-wand'])
  assert.deepEqual(wands[1].catalogIds, ['srd_5_2_1:wand-of-magic-missiles'])
  assert.notEqual(wands[0].sha256, wands[1].sha256)
})

test('все GLB проходят загрузку обратно, имеют конечные границы и точки крепления', async (t) => {
  const directory = await mkdtemp(join(TMP_ROOT, 'equipment-model-roundtrip-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { manifest } = await buildEquipmentModels({ out: directory })
  const ranged = new Set(['bow', 'crossbow', 'sling', 'net', 'dart', 'blowgun', 'firearm'])
  for (const spec of manifest.models) {
    const file = join(directory, basename(spec.url))
    const bytes = await readFile(file)
    assert.equal(bytes.length, spec.bytes, `${spec.key}: размер в manifest`)
    assert.equal(digest(bytes), spec.sha256, `${spec.key}: SHA в manifest`)
    const gltf = await parseWithLoader(bytes)
    gltf.scene.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(gltf.scene)
    const size = bounds.getSize(new THREE.Vector3())
    assert.equal(bounds.isEmpty(), false, `${spec.key}: пустая сцена`)
    assert.ok([...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite), `${spec.key}: нечисловые bounds`)
    assert.ok(size.x > 0 && size.y > 0 && size.z > 0, `${spec.key}: вырожденный bounds`)
    for (const part of spec.parts) assert.ok(gltf.scene.getObjectByName(part), `${spec.key}: отсутствует exported part ${part}`)
    if (spec.category === 'weapon' && (spec.handedness === 'two-handed' || spec.handedness === 'variable')) {
      assert.ok(gltf.scene.getObjectByName('off-hand-grip'), `${spec.key}: нет off-hand-grip`)
    }
    if (spec.category === 'weapon' && ranged.has(spec.kind)) assert.ok(gltf.scene.getObjectByName('muzzle'), `${spec.key}: нет muzzle`)
    dispose(gltf.scene)
  }
})

test('манифест не оставляет неизвестных ключей геометрии', async (t) => {
  const directory = await mkdtemp(join(TMP_ROOT, 'equipment-model-manifest-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { manifest } = await buildEquipmentModels({ out: directory })
  const catalogIds = new Set(Object.keys(EQUIPMENT_ITEM_VISUALS))
  for (const model of manifest.models) {
    assert.match(model.key, /^[a-z][a-z0-9-]*$/u)
    assert.match(model.url, /^\/assets\/models\/equipment\/[a-z][a-z0-9-]*\.glb$/u)
    assert.ok(model.parts.length > 0, `${model.key}: нет parts`)
    for (const catalogId of model.catalogIds) assert.equal(catalogIds.has(catalogId), true, `${model.key}: неизвестный catalog id`)
  }
  assert.deepEqual([...new Set(manifest.models.flatMap((model) => model.catalogIds))].sort(), [...catalogIds].sort())
})

test('публикация создаёт новый неизменяемый выпуск и регистрирует только его файлы', async (t) => {
  const candidate = await mkdtemp(join(TMP_ROOT, 'equipment-publish-candidate-'))
  const root = await mkdtemp(join(TMP_ROOT, 'equipment-publish-root-'))
  t.after(async () => Promise.all([
    rm(candidate, { recursive: true, force: true }),
    rm(root, { recursive: true, force: true }),
  ]))
  await buildEquipmentModels({ out: candidate })
  await mkdir(join(root, 'public', 'assets'), { recursive: true })
  await mkdir(join(root, 'data'), { recursive: true })
  await writeFile(join(root, 'data', 'asset-rights.json'), await readFile(join(ROOT, 'data', 'asset-rights.json')))

  const published = await publishEquipmentCandidate(candidate, { rootDir: root })
  const releaseRoot = join(root, 'public', 'assets', 'models', 'equipment', published.releaseId)
  const active = JSON.parse(await readFile(join(root, 'public', 'assets', 'models', 'equipment', 'manifest.json'), 'utf8'))
  const release = JSON.parse(await readFile(join(releaseRoot, 'manifest.json'), 'utf8'))
  assert.equal(active.release.id, published.releaseId)
  assert.equal(release.release.fingerprint, published.fingerprint)
  assert.equal(active.models.length, 76)
  assert.deepEqual(active.models, release.models)
  for (const model of active.models) {
    const file = join(releaseRoot, basename(model.url))
    const bytes = await readFile(file)
    assert.equal(bytes.length, model.bytes, `${model.key}: опубликованный размер`)
    assert.equal(digest(bytes), model.sha256, `${model.key}: опубликованный SHA`)
  }
  const rights = JSON.parse(await readFile(join(root, 'data', 'asset-rights.json'), 'utf8'))
  const byPath = new Map(rights.assets.map((entry) => [entry[0], entry]))
  for (const name of ['manifest.json', 'NOTICE.txt', 'LICENSE.txt', ...new Set(active.models.map((model) => basename(model.url)))]) {
    const path = `models/equipment/${published.releaseId}/${name}`
    const bytes = await readFile(join(releaseRoot, name))
    assert.deepEqual(byPath.get(path)?.slice(1), [digest(bytes), bytes.length], `${path}: запись прав`)
  }
  const activePath = 'models/equipment/manifest.json'
  assert.deepEqual(byPath.get(activePath)?.slice(1), [digest(await readFile(join(root, 'public', 'assets', activePath))), (await readFile(join(root, 'public', 'assets', activePath))).length])

  const second = await publishEquipmentCandidate(candidate, { rootDir: root })
  assert.equal(second.releaseId, published.releaseId)
  assert.deepEqual(JSON.parse(await readFile(join(root, 'public', 'assets', 'models', 'equipment', 'manifest.json'), 'utf8')), active)
})

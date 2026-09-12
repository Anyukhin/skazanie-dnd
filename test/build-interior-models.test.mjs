import assert from 'node:assert/strict'
import { link, lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { inspectModelFile } from '../tools/import-environment-models.mjs'
import { decodePng } from '../tools/png-codec.mjs'
import {
  addInteriorModelsToCandidate,
  AUTHORED_MODELS,
  createInteriorModel,
  createAuthoredModel,
  disposeInteriorModel,
  exportInteriorModel,
  GENERATOR_SHA256,
  GENERATOR_VERSION,
  HOUSEHOLD_GENERATOR_SHA256,
  INTERIOR_MODELS,
  mergeStaticInteriorMeshes,
  SETTLEMENT_GENERATOR_SHA256,
} from '../tools/build-interior-models.mjs'

const URL_ROOT = '/assets/models/environment/'

function findNode(root, name) {
  let result = null
  root.traverse((child) => { if (child.name === name) result = child })
  return result
}

function namesOf(root) {
  const names = []
  root.traverse((child) => { if (child.name) names.push(child.name) })
  return names
}

function glbParts(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67)
  assert.equal(bytes.readUInt32LE(4), 2)
  const length = bytes.readUInt32LE(8)
  assert.equal(length, bytes.length)
  let offset = 12
  let json = null
  let binary = null
  while (offset + 8 <= length) {
    const chunkLength = bytes.readUInt32LE(offset)
    const chunkType = bytes.readUInt32LE(offset + 4)
    if (chunkType === 0x4e4f534a) json = JSON.parse(bytes.toString('utf8', offset + 8, offset + 8 + chunkLength).trim())
    if (chunkType === 0x004e4942) binary = bytes.subarray(offset + 8, offset + 8 + chunkLength)
    offset += 8 + chunkLength
  }
  if (!json || !binary) throw new Error('GLB должен иметь JSON и BIN chunk')
  return { json, binary }
}

function glbJson(bytes) {
  return glbParts(bytes).json
}

async function candidateFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'skazanie-interior-candidate-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'quaternius'))
  await writeFile(join(directory, 'quaternius', 'existing.glb'), 'kept')
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({
    version: 1,
    sources: [{ url: 'https://example.test/source', license: 'CC0-1.0', author: 'Fixture' }],
    models: [{ key: 'existing', label: 'Существующая модель', category: 'Тест', url: `${URL_ROOT}quaternius/existing.glb`, assetIds: ['chair'], yaw: 0 }],
    build: { schema: 'environment-candidate/v1', importerVersion: 2, normalizationVersion: 1, selectionVersion: 1, sourceInputs: [] },
  }, null, 2)}\n`)
  return directory
}

const REQUIRED_DETAILS = new Map([
  ['bar_counter', ['counter-panel-divider', 'counter-foot-rail', 'surface-top', 'counter-tray']],
  ['bar_shelf', ['shelf-board', 'shelf-bottle-1-body']],
  ['fireplace', ['fireplace-pier', 'fireplace-arch', 'fireplace-opening', 'fireplace-coal']],
  ['hearth_fire', ['hearth-stone', 'hearth-log-a', 'hearth-flame']],
  ['table_round', ['table-round-top', 'table-round-pedestal', 'table-round-plank-seam', 'surface-top']],
  ['table_small', ['table-small-top', 'table-small-leg', 'table-small-plank-seam', 'surface-top']],
  ['altar', ['altar-base', 'altar-front-recess', 'altar-carving-vertical', 'surface-top']],
  ['pillar', ['pillar-shaft', 'pillar-flute', 'pillar-capital']],
  ['sarcophagus', ['sarcophagus-interior', 'sarcophagus-wall-front', 'sarcophagus-foot-front', 'hinge-lid', 'lid-carving-cross']],
  ['crypt_niche', ['niche-back', 'niche-pilaster', 'niche-arch']],
  ['brazier', ['brazier-bowl', 'brazier-rim', 'brazier-ember']],
  ['reliquary', ['reliquary-body', 'reliquary-window', 'reliquary-lock']],
])

test('12 интерьерных рецептов имеют детали, натуральный габарит и опорные узлы', () => {
  assert.equal(INTERIOR_MODELS.length, 12)
  for (const item of INTERIOR_MODELS) {
    const model = createInteriorModel(item.assetId)
    model.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(model)
    assert.ok(!bounds.isEmpty(), `${item.assetId}: GLB-рецепт не пуст`)
    assert.ok(bounds.min.y >= -0.001, `${item.assetId}: геометрия провалилась под пол`)
    assert.ok(bounds.min.x >= -item.footprint.w / 2 - 0.06 && bounds.max.x <= item.footprint.w / 2 + 0.06, `${item.assetId}: ширина вышла за footprint`)
    assert.ok(bounds.min.z >= -item.footprint.h / 2 - 0.06 && bounds.max.z <= item.footprint.h / 2 + 0.06, `${item.assetId}: глубина вышла за footprint`)
    const names = new Set(namesOf(model))
    for (const name of REQUIRED_DETAILS.get(item.assetId)) assert.ok(names.has(name), `${item.assetId}: отсутствует деталь ${name}`)
    if (['bar_counter', 'table_small', 'altar'].includes(item.assetId)) {
      const topName = item.assetId === 'bar_counter' ? 'counter-top' : item.assetId === 'table_small' ? 'table-small-top' : 'altar-top'
      assert.equal(findNode(model, topName).geometry.type, 'RoundedBoxGeometry', `${item.assetId}: столешница должна иметь фаску`)
    }
    if (['fireplace', 'crypt_niche'].includes(item.assetId)) {
      const arch = findNode(model, item.assetId === 'fireplace' ? 'fireplace-arch' : 'niche-arch')
      assert.equal(arch.geometry.type, 'ExtrudeGeometry', `${item.assetId}: арка должна быть непрерывной`)
      assert.ok(arch.geometry.getAttribute('position').count > 30, `${item.assetId}: арка слишком грубая`)
    }
    if (['bar_counter', 'table_round', 'table_small', 'altar'].includes(item.assetId)) {
      const top = findNode(model, 'surface-top')
      assert.ok(top, `${item.assetId}: отсутствует surface-top`)
      assert.equal(top.children.length, 0, `${item.assetId}: surface-top должен оставаться свободным узлом`)
      assert.ok(top.position.y > 0.5, `${item.assetId}: surface-top не на рабочей высоте`)
    }
    if (item.assetId === 'sarcophagus') {
      const lid = findNode(model, 'hinge-lid')
      assert.ok(lid)
      assert.equal(lid.userData.animated, true)
      assert.ok(lid.children.length >= 2, 'крышка сохраняет дочерние детали для анимации')
      assert.ok(lid.children.some((child) => child.name === 'sarcophagus-lid'))
    }
    disposeInteriorModel(model)
  }
})

test('42 авторские рецепта имеют объединённый каталог и отдельные фабрики extras', () => {
  assert.equal(AUTHORED_MODELS.length, 42)
  assert.equal(new Set(AUTHORED_MODELS.map((item) => item.assetId)).size, 42)
  for (const item of AUTHORED_MODELS) {
    const model = createAuthoredModel(item.assetId)
    assert.ok(model, `${item.assetId}: авторская фабрика вернула пустой результат`)
    model.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(model)
    assert.ok(!bounds.isEmpty(), `${item.assetId}: авторская модель пустая`)
    assert.ok(bounds.min.y >= -0.001, `${item.assetId}: авторская модель ниже пола`)
    assert.ok(bounds.max.x - bounds.min.x <= item.footprint.w + 0.02, `${item.assetId}: ширина вышла за footprint`)
    assert.ok(bounds.max.z - bounds.min.z <= item.footprint.h + 0.02, `${item.assetId}: глубина вышла за footprint`)
    disposeInteriorModel(model)
  }
})

test('экспорт GLB детерминирован и сохраняет extras/иерархию узлов', async () => {
  const first = await exportInteriorModel('bar_counter')
  const second = await exportInteriorModel('bar_counter')
  assert.deepEqual(second, first)
  assert.ok(first.length > 1_000)
  const counterJson = glbJson(first)
  assert.ok(counterJson.meshes?.length >= 1)
  assert.ok(counterJson.nodes.some((node) => node.name === 'surface-top' && node.mesh === undefined))
  assert.ok(counterJson.nodes.some((node) => node.name.includes('-static-')))
  assert.equal(counterJson.images?.length, 1)
  assert.equal(counterJson.images[0].mimeType, 'image/png')
  assert.equal(counterJson.images[0].uri, undefined)
  assert.equal(counterJson.textures?.length, 1)
  assert.ok(counterJson.materials.some((material) => material.pbrMetallicRoughness?.baseColorTexture?.index === 0))
  const counterImageView = counterJson.bufferViews[counterJson.images[0].bufferView]
  const counterImage = decodePng(glbParts(first).binary.subarray(counterImageView.byteOffset, counterImageView.byteOffset + counterImageView.byteLength))
  assert.deepEqual([counterImage.width, counterImage.height], [128, 128])
  assert.equal(counterImage.data[0], counterImage.data[1])
  assert.equal(counterImage.data[1], counterImage.data[2])

  const sarcophagusBytes = await exportInteriorModel('sarcophagus')
  const sarcophagusJson = glbJson(sarcophagusBytes)
  const hinge = sarcophagusJson.nodes.find((node) => node.name === 'hinge-lid')
  assert.deepEqual(hinge?.extras, { animated: true, pivotRole: 'rear-hinge' })
  assert.ok(Array.isArray(hinge?.children) && hinge.children.length >= 2)
  assert.ok(sarcophagusJson.nodes.some((node) => node.name === 'lid-carving-cross'))
  assert.equal(sarcophagusJson.images?.length, 1)
  assert.equal(sarcophagusJson.images[0].uri, undefined)
})

test('extras получают текстуры по имени материала без древесного fallback', async () => {
  const bowlBytes = await exportInteriorModel('bowl_stew')
  const bowlParts = glbParts(bowlBytes)
  const bowl = bowlParts.json
  const bowlMaterials = new Set(bowl.materials.map((material) => material.name))
  assert.ok(bowlMaterials.has('food'))
  assert.equal(bowlMaterials.has('wood'), false)
  const foodIndex = bowl.materials.find((material) => material.name === 'food')?.pbrMetallicRoughness?.baseColorTexture?.index
  assert.equal(bowl.textures[foodIndex]?.name, 'skazanie-food-grain-v4')
  const foodImage = bowl.images[bowl.textures[foodIndex].source]
  const foodView = bowl.bufferViews[foodImage.bufferView]
  const foodTexture = decodePng(bowlParts.binary.subarray(foodView.byteOffset, foodView.byteOffset + foodView.byteLength))
  for (let index = 0; index < foodTexture.data.length; index += 4) {
    assert.equal(foodTexture.data[index], foodTexture.data[index + 1])
    assert.equal(foodTexture.data[index + 1], foodTexture.data[index + 2])
  }
  assert.ok(bowl.materials.filter((material) => material.name === 'stone').every((material) => material.pbrMetallicRoughness?.baseColorTexture?.index === bowl.textures.findIndex((texture) => texture.name === 'skazanie-stone-grain-v4')))

  const trough = glbJson(await exportInteriorModel('water_trough'))
  const water = trough.materials.find((material) => material.name === 'water')
  assert.equal(water?.pbrMetallicRoughness?.baseColorTexture, undefined)
  assert.equal(trough.textures?.some((texture) => texture.name === 'skazanie-water-grain-v4'), false)

  const lamp = glbJson(await exportInteriorModel('lamp_post'))
  const glass = lamp.materials.find((material) => material.name === 'glass')
  assert.equal(glass?.pbrMetallicRoughness?.baseColorTexture, undefined)
  assert.equal(lamp.textures?.some((texture) => texture.name === 'skazanie-glass-grain-v4'), false)
})

test('экспортный merge оставляет узлы опор и подвижной крышки отдельными', () => {
  const counter = createInteriorModel('bar_counter')
  const before = namesOf(counter).filter((name) => name !== 'surface-top').length
  mergeStaticInteriorMeshes(counter)
  const after = namesOf(counter).filter((name) => name !== 'surface-top').length
  assert.ok(after < before, 'статические детали должны быть сведены')
  assert.equal(findNode(counter, 'surface-top').children.length, 0)
  disposeInteriorModel(counter)

  const sarcophagus = createInteriorModel('sarcophagus')
  const lid = findNode(sarcophagus, 'hinge-lid')
  const childNames = lid.children.map((child) => child.name)
  mergeStaticInteriorMeshes(sarcophagus)
  assert.deepEqual(lid.children.map((child) => child.name), childNames)
  assert.equal(lid.userData.animated, true)
  disposeInteriorModel(sarcophagus)
})

test('экспортированный GLB проходит GLTFLoader round-trip с конечными матрицами у всех моделей', async () => {
  const loader = new GLTFLoader()
  const previousSelf = globalThis.self
  const previousCreateImageBitmap = globalThis.createImageBitmap
  globalThis.self = globalThis
  globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} })
  try {
    for (const item of INTERIOR_MODELS) {
      const bytes = await exportInteriorModel(item.assetId)
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      const parsed = await loader.parseAsync(arrayBuffer, '')
      parsed.scene.updateMatrixWorld(true)
      const bounds = new THREE.Box3().setFromObject(parsed.scene)
      assert.ok(!bounds.isEmpty(), `${item.assetId}: GLTFLoader получил пустую сцену`)
      assert.ok([...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite), `${item.assetId}: Box3 содержит NaN/Infinity`)
      parsed.scene.traverse((object) => {
        assert.ok(object.matrixWorld.elements.every(Number.isFinite), `${item.assetId}/${object.name}: матрица содержит NaN/Infinity`)
      })
      disposeInteriorModel(parsed.scene)
    }
  } finally {
    if (previousSelf === undefined) delete globalThis.self
    else globalThis.self = previousSelf
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap
    else globalThis.createImageBitmap = previousCreateImageBitmap
  }
})

test('добавление в candidate пишет все 42 GLB, provenance фабрик и hash идемпотентно', async (t) => {
  const directory = await candidateFixture(t)
  const first = await addInteriorModelsToCandidate(directory)
  assert.equal(first.added.length, 42)
  assert.equal(first.receiptStale, false)
  assert.equal(first.manifest.models.length, 43)
  assert.match(await readFile(join(directory, 'skazanie', 'LICENSE.txt'), 'utf8'), /Оригинальные/u)
  assert.match(await readFile(join(directory, 'skazanie', 'NOTICE.txt'), 'utf8'), /GLTFExporter/u)
  assert.equal(first.manifest.build.interiorBuilderVersion, GENERATOR_VERSION)
  assert.equal(first.manifest.build.interiorGeneratorSha256, GENERATOR_SHA256)
  assert.equal(first.manifest.build.interiorModels.length, 42)
  assert.ok(first.manifest.sources.some((source) => source.url === 'internal://skazanie/interior-models'))
  const sourceInput = first.manifest.build.sourceInputs.find((source) => source.path === 'skazanie/build-interior-models.mjs')
  assert.deepEqual(sourceInput, { path: 'skazanie/build-interior-models.mjs', sha256: GENERATOR_SHA256, bytes: expectPositiveInteger(sourceInput?.bytes) })
  assert.deepEqual(first.manifest.build.sourceInputs.find((source) => source.path === 'skazanie/household-prop-models.mjs'), {
    path: 'skazanie/household-prop-models.mjs', sha256: HOUSEHOLD_GENERATOR_SHA256, bytes: expectPositiveInteger(first.manifest.build.sourceInputs.find((source) => source.path === 'skazanie/household-prop-models.mjs')?.bytes),
  })
  assert.deepEqual(first.manifest.build.sourceInputs.find((source) => source.path === 'skazanie/settlement-prop-models.mjs'), {
    path: 'skazanie/settlement-prop-models.mjs', sha256: SETTLEMENT_GENERATOR_SHA256, bytes: expectPositiveInteger(first.manifest.build.sourceInputs.find((source) => source.path === 'skazanie/settlement-prop-models.mjs')?.bytes),
  })

  const before = new Map()
  for (const item of AUTHORED_MODELS) {
    const entry = first.manifest.models.find((model) => model.key === item.key)
    assert.deepEqual(entry?.assetIds, [item.assetId])
    assert.equal(entry?.yaw, item.yaw)
    assert.equal(entry?.url, `${URL_ROOT}skazanie/${item.file}`)
    const path = join(directory, 'skazanie', item.file)
    const inspected = await inspectModelFile(path)
    assert.ok(inspected.json.meshes.length > 0, `${item.assetId}: GLB содержит mesh`)
    before.set(path, await readFile(path))
  }
  const second = await addInteriorModelsToCandidate(directory)
  assert.deepEqual(second.added, [])
  assert.equal(second.manifest.models.length, 43)
  for (const [path, bytes] of before) assert.deepEqual(await readFile(path), bytes, path)
})

test('manifest-hardlink отклоняется до записи моделей и не меняет внешний файл', async (t) => {
  const directory = await candidateFixture(t)
  const manifestPath = join(directory, 'manifest.json')
  const externalPath = join(directory, 'external-manifest.json')
  const before = await readFile(manifestPath)
  await writeFile(externalPath, before)
  await unlink(manifestPath)
  await link(externalPath, manifestPath)

  await assert.rejects(addInteriorModelsToCandidate(directory), /hardlink|жёстк/u)
  assert.deepEqual(await readFile(externalPath), before)
  assert.equal((await lstat(manifestPath)).nlink, 2)
  await assert.rejects(lstat(join(directory, 'skazanie')), { code: 'ENOENT' })
})

test('writeIfAbsent отклоняет hardlink модели до записи LICENSE/NOTICE', async (t) => {
  const directory = await candidateFixture(t)
  const family = join(directory, 'skazanie')
  await mkdir(family)
  const externalPath = join(directory, 'external-model.glb')
  const modelPath = join(family, INTERIOR_MODELS[0].file)
  await writeFile(externalPath, 'внешний файл')
  await link(externalPath, modelPath)

  await assert.rejects(addInteriorModelsToCandidate(directory), /hardlink|жёстк/u)
  assert.equal(await readFile(externalPath, 'utf8'), 'внешний файл')
  await assert.rejects(lstat(join(family, 'LICENSE.txt')), { code: 'ENOENT' })
  await assert.rejects(lstat(join(family, 'NOTICE.txt')), { code: 'ENOENT' })
})

function expectPositiveInteger(value) {
  assert.ok(Number.isSafeInteger(value) && value > 0)
  return value
}

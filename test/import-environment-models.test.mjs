import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'

import {
  MATERIAL_SRGB,
  REDUCED_BASE_COLOR_MODELS,
  REDUCED_BASE_COLOR_SIDE,
  TEXTURE_POLICY,
  DUNGEON_SELECTION,
  DUNGEON_SOURCE,
  KENNEY_SELECTION,
  SOURCES,
  convert,
  importEnvironmentModels,
  inspectModelFile,
  normalizeKenneyMaterials,
  normalizeKenneyOutput,
  validateCandidateOutputDir,
  verifySourceArchive,
} from '../tools/import-environment-models.mjs'
import { decodePng } from '../tools/png-codec.mjs'

const work = await mkdtemp(join(tmpdir(), 'dnd-environment-import-'))
after(() => rm(work, { recursive: true, force: true }))

function fixtureGlb(json) {
  const jsonBytes = Buffer.from(JSON.stringify(json))
  const paddedJson = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)])
  const binary = Buffer.alloc(0)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + paddedJson.length + 8, 8)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(paddedJson.length, 0)
  jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  const binaryHeader = Buffer.alloc(8)
  binaryHeader.writeUInt32LE(0, 0)
  binaryHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonHeader, paddedJson, binaryHeader, binary])
}

function modelJson(materials = []) {
  return { asset: { version: '2.0' }, buffers: [{ byteLength: 0 }], meshes: [{ primitives: [] }], materials }
}

function glbJsonAndBinary(bytes) {
  let offset = 12
  let json = null
  let binary = null
  while (offset + 8 <= bytes.length) {
    const chunkLength = bytes.readUInt32LE(offset)
    const chunkType = bytes.readUInt32LE(offset + 4)
    const end = offset + 8 + chunkLength
    if (chunkType === 0x4e4f534a) json = JSON.parse(bytes.toString('utf8', offset + 8, end).trim())
    if (chunkType === 0x004e4942) binary = bytes.subarray(offset + 8, end)
    offset = end
  }
  assert.ok(json && binary)
  return { json, binary }
}

function imageDimensions(bytes, image) {
  const { json, binary } = glbJsonAndBinary(bytes)
  const view = json.bufferViews[image.bufferView]
  const encoded = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
  const png = decodePng(encoded)
  return { width: png.width, height: png.height }
}

test('палитра включает материал по умолчанию и нормализатор идемпотентен', () => {
  assert.equal(MATERIAL_SRGB._defaultMat, '#6f6453')
  const json = modelJson([{ name: '_defaultMat', pbrMetallicRoughness: { metallicFactor: 1, roughnessFactor: 0 } }])
  assert.equal(normalizeKenneyMaterials(json), 1)
  const normalized = structuredClone(json)
  assert.equal(normalizeKenneyMaterials(json), 0)
  assert.deepEqual(json, normalized)
})

test('новые привязки используют точные reuses и staged Nature модели', () => {
  const selected = new Map(KENNEY_SELECTION.map(([name, category, label, assetIds, yaw]) => [name, { category, label, assetIds, yaw }]))
  assert.deepEqual(selected.get('sign')?.assetIds, ['signpost'])
  assert.deepEqual(selected.get('fence_simple')?.assetIds, ['village_fence'])
  assert.deepEqual(selected.get('statue_head')?.assetIds, ['statue'])
  assert.deepEqual(selected.get('rock_tallC')?.assetIds, ['stalagmite'])
  assert.deepEqual(selected.get('log_stack')?.assetIds, ['woodpile', 'firewood_stack'])
  assert.deepEqual(selected.get('log_stackLarge')?.assetIds, ['woodpile', 'firewood_stack'])

  assert.deepEqual(DUNGEON_SELECTION, [['stairs', 'Переходы', 'Лестница', ['stairs_up', 'stairs_down'], 0]])
  assert.equal(DUNGEON_SOURCE.archive, 'kenney_modular-dungeon-kit_1.0.zip')
  assert.equal(DUNGEON_SOURCE.archiveSha256, 'dd0aa6776db8912283cdca60161dee6a8839bbda3558eba2ea501419eb5b4623')
})

test('Dungeon не включается без явной пары каталога и архива', async () => {
  const candidate = join(work, 'dungeon-options')
  await mkdir(candidate)
  await assert.rejects(
    importEnvironmentModels({ outputDir: candidate, dungeonDir: work }),
    /одновременно dungeonDir и dungeonArchive/u,
  )
  assert.deepEqual(await readdir(candidate), [])
})

test('политика BaseColor фактически уменьшает только выбранные PNG', { skip: !existsSync(join(process.cwd(), 'tmp/quaternius-fantasy-props-extracted/Exports/glTF/Chandelier.gltf')) }, async () => {
  const source = join(process.cwd(), 'tmp/quaternius-fantasy-props-extracted/Exports/glTF/Chandelier.gltf')
  const reducedPath = join(work, 'reduced-chandelier.glb')
  const standardPath = join(work, 'standard-chandelier.glb')
  await convert(source, reducedPath, { baseColorMaxSide: REDUCED_BASE_COLOR_SIDE })
  await convert(source, standardPath)
  const dimensionsFor = (file, pattern) => {
    const bytes = readFileSync(file)
    const { json } = glbJsonAndBinary(bytes)
    return json.images.filter((image) => pattern.test(String(image.name ?? ''))).map((image) => imageDimensions(bytes, image))
  }
  const reducedBase = dimensionsFor(reducedPath, /base[_-]?color/iu)
  const reducedNormalOrm = dimensionsFor(reducedPath, /(?:normal|orm)/iu)
  const standardBase = dimensionsFor(standardPath, /base[_-]?color/iu)
  assert.ok(reducedBase.length > 0)
  assert.ok(reducedBase.every(({ width, height }) => Math.max(width, height) <= REDUCED_BASE_COLOR_SIDE))
  assert.ok(reducedNormalOrm.length > 0 && reducedNormalOrm.every(({ width, height }) => Math.max(width, height) <= REDUCED_BASE_COLOR_SIDE))
  assert.ok(standardBase.some(({ width, height }) => Math.max(width, height) === TEXTURE_POLICY.baseColorMaxSide))
  assert.deepEqual(TEXTURE_POLICY.reducedBaseColorModels, REDUCED_BASE_COLOR_MODELS)
})

test('Modular Dungeon stairs преобразуются в самодостаточный GLB', { skip: !existsSync(new URL('../tmp/kenney_modular-dungeon-extracted/Models/GLB format/stairs.glb', import.meta.url)) }, async () => {
  const source = new URL('../tmp/kenney_modular-dungeon-extracted/Models/GLB format/stairs.glb', import.meta.url)
  const output = join(work, 'dungeon-stairs.glb')
  const result = await convert(fileURLToPath(source), output)
  const inspected = await inspectModelFile(output)
  assert.equal(inspected.sha256, result.hash)
  assert.ok(inspected.json.images?.every((image) => image.uri === undefined && Number.isInteger(image.bufferView)))
  assert.ok(inspected.json.buffers?.every((buffer) => buffer.uri === undefined))
})

test('inspectModelFile проверяет GLB и возвращает хеш байтов', async () => {
  const file = join(work, 'fixture.glb')
  const bytes = fixtureGlb(modelJson())
  await writeFile(file, bytes)
  const inspected = await inspectModelFile(file)
  assert.equal(inspected.bytes, bytes.length)
  assert.equal(inspected.sha256.length, 64)
  assert.equal(inspected.json.meshes.length, 1)
})

test('архив без файла и архив с неверным хешем отклоняются', async () => {
  await assert.rejects(
    verifySourceArchive(join(work, 'missing.zip'), SOURCES[0]),
    /Не найден архив источника/u,
  )
  const archive = join(work, 'wrong.zip')
  await writeFile(archive, 'fixture')
  await assert.rejects(
    verifySourceArchive(archive, SOURCES[0]),
    /не совпадает/u,
  )
})

test('импорт не пишет в каталог-кандидат при отклонённом архиве', async () => {
  const candidate = join(work, 'rejected-candidate')
  await mkdir(candidate)
  await assert.rejects(importEnvironmentModels({
    outputDir: candidate,
    quaterniusDir: join(work, 'missing-quaternius'),
    kenneyDir: join(work, 'missing-kenney'),
    quaterniusArchive: join(work, 'missing-quaternius.zip'),
    kenneyArchive: join(work, 'missing-kenney.zip'),
  }), /Не найден архив источника/u)
  assert.deepEqual(await readdir(candidate), [])
})

test('палитра работает только в безопасном кандидате и не меняет файл повторно', async () => {
  const candidate = join(work, 'candidate')
  const kenney = join(candidate, 'kenney')
  await mkdir(kenney, { recursive: true })
  const bytes = fixtureGlb(modelJson([{ name: '_defaultMat' }]))
  for (const sourceName of [
    'tree_default', 'tree_oak', 'tree_pineDefaultA', 'tree_pineRoundA', 'tree_pineTallA_detailed', 'tree_simple',
    'tree_default_fall', 'stump_old', 'stump_roundDetailed', 'stump_squareDetailedWide', 'log', 'log_large',
    'log_stack', 'log_stackLarge', 'rock_smallA', 'rock_smallB', 'rock_smallFlatA', 'rock_largeA', 'rock_tallA',
    'plant_bush', 'plant_bushDetailed', 'plant_bushLarge', 'plant_bushSmall', 'mushroom_red', 'mushroom_redGroup',
    'mushroom_tanGroup', 'grass', 'grass_large', 'flower_redA', 'flower_yellowA', 'campfire_logs',
  ]) await writeFile(join(kenney, `${sourceName.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase()}.glb`), bytes)
  const first = await normalizeKenneyOutput({ outputDir: candidate })
  const firstBytes = await readFile(join(kenney, 'tree_default.glb'))
  const second = await normalizeKenneyOutput(candidate)
  const secondBytes = await readFile(join(kenney, 'tree_default.glb'))
  assert.equal(first.changedFiles, 31)
  assert.equal(second.changedFiles, 0)
  assert.equal(second.changedMaterials, 0)
  assert.deepEqual(secondBytes, firstBytes)
  assert.equal((await readdir(candidate)).includes('kenney'), true)
})

test('запрещённый каталог не принимается как кандидат', async () => {
  await assert.rejects(
    validateCandidateOutputDir(join(process.cwd(), 'public/assets/models/environment')),
    /Каталог-кандидат запрещён/u,
  )
})

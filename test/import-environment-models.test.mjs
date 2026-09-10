import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import {
  MATERIAL_SRGB,
  SOURCES,
  importEnvironmentModels,
  inspectModelFile,
  normalizeKenneyMaterials,
  normalizeKenneyOutput,
  validateCandidateOutputDir,
  verifySourceArchive,
} from '../tools/import-environment-models.mjs'

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

test('палитра включает материал по умолчанию и нормализатор идемпотентен', () => {
  assert.equal(MATERIAL_SRGB._defaultMat, '#6f6453')
  const json = modelJson([{ name: '_defaultMat', pbrMetallicRoughness: { metallicFactor: 1, roughnessFactor: 0 } }])
  assert.equal(normalizeKenneyMaterials(json), 1)
  const normalized = structuredClone(json)
  assert.equal(normalizeKenneyMaterials(json), 0)
  assert.deepEqual(json, normalized)
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

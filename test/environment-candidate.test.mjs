import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { encodePng } from '../tools/png-codec.mjs'
import { validateEnvironmentCandidate } from '../tools/environment-candidate.mjs'

const URL_ROOT = '/assets/models/environment/'
const temporaryCandidates = []

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function minimalGlb() {
  const binary = Buffer.alloc(42)
  const positions = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0],
  ]
  positions.forEach((position, vertex) => position.forEach((value, channel) => binary.writeFloatLE(value, vertex * 12 + channel * 4)))
  binary.writeUInt16LE(0, 36)
  binary.writeUInt16LE(1, 38)
  binary.writeUInt16LE(2, 40)
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
  }
  const json = Buffer.from(JSON.stringify(document))
  const jsonPadded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const binPadded = Buffer.concat([binary, Buffer.alloc((4 - (binary.length % 4)) % 4)])
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(jsonPadded.length, 0)
  jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  const binHeader = Buffer.alloc(8)
  binHeader.writeUInt32LE(binPadded.length, 0)
  binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonHeader, jsonPadded, binHeader, binPadded])
}

function atlasPng() {
  const data = new Uint8Array([
    255, 255, 255, 255, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
  ])
  return encodePng({ width: 2, height: 2, data })
}

async function writeFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'skazanie-environment-candidate-'))
  temporaryCandidates.push(root)
  await mkdir(join(root, 'family'), { recursive: true })
  const model = options.model ?? minimalGlb()
  const png = options.png ?? atlasPng()
  await writeFile(join(root, 'family', 'model.glb'), model)
  await writeFile(join(root, 'family', 'LICENSE.txt'), 'CC0-1.0\n')
  await writeFile(join(root, 'family', 'NOTICE.txt'), 'Test family source notice.\n')
  await writeFile(join(root, 'atlas.png'), png)
  const manifest = {
    version: 1,
    sources: [{ url: 'https://example.test/family', license: 'CC0-1.0', author: 'Test family' }],
    models: [{
      key: 'test-model', label: 'Тестовая модель', category: 'Предметы',
      url: `${URL_ROOT}family/model.glb`, assetIds: ['chair'], yaw: 0,
      preview: { x: 0, y: 0, w: 1, h: 1 },
    }],
    atlas: { image: `${URL_ROOT}atlas.png`, key: digest(png) },
    ...(options.manifest ?? {}),
  }
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return root
}

async function rewriteManifest(root, update) {
  const file = join(root, 'manifest.json')
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, `${JSON.stringify(update(manifest), null, 2)}\n`)
}

test.afterEach(async () => {
  while (temporaryCandidates.length) await rm(temporaryCandidates.pop(), { recursive: true, force: true })
})

test('валидный минимальный candidate даёт отсортированный inventory и fingerprint', async () => {
  const root = await writeFixture()
  const result = await validateEnvironmentCandidate(root)
  assert.equal(result.manifest.version, 1)
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/u)
  assert.deepEqual(result.files.map((file) => file.path), [
    'atlas.png', 'family/LICENSE.txt', 'family/NOTICE.txt', 'family/model.glb', 'manifest.json',
  ])
  assert.equal(result.files.find((file) => file.path === 'family/model.glb').sha256, digest(await readFile(join(root, 'family', 'model.glb'))))
})

test('отсутствующий PNG и GLB отклоняются', async () => {
  const missingPng = await writeFixture()
  await rm(join(missingPng, 'atlas.png'))
  await assert.rejects(() => validateEnvironmentCandidate(missingPng), /CANDIDATE_ATLAS_MISSING|PNG/u)

  const missingGlb = await writeFixture()
  await rm(join(missingGlb, 'family', 'model.glb'))
  await assert.rejects(() => validateEnvironmentCandidate(missingGlb), /CANDIDATE_MODEL_MISSING|GLB/u)
})

test('изменение PNG после сборки даёт hash drift', async () => {
  const root = await writeFixture()
  const bytes = await readFile(join(root, 'atlas.png'))
  bytes[bytes.length - 1] ^= 1
  await writeFile(join(root, 'atlas.png'), bytes)
  await assert.rejects(() => validateEnvironmentCandidate(root), /CANDIDATE_ATLAS_HASH|SHA-256|hash/u)
})

test('некорректные frame coordinates и пустой frame отклоняются', async () => {
  const outside = await writeFixture()
  await rewriteManifest(outside, (manifest) => ({ ...manifest, models: [{ ...manifest.models[0], preview: { x: 2, y: 0, w: 1, h: 1 } }] }))
  await assert.rejects(() => validateEnvironmentCandidate(outside), /CANDIDATE_PREVIEW_BOUNDS|frame|preview/u)

  const empty = await writeFixture({ png: encodePng({ width: 2, height: 2, data: new Uint8Array(16) }) })
  await assert.rejects(() => validateEnvironmentCandidate(empty), /CANDIDATE_PREVIEW_EMPTY|preview/u)

  const holeData = new Uint8Array(3 * 4)
  holeData.set([255, 255, 255, 255], 0)
  holeData.set([255, 255, 255, 255], 8)
  const hole = await writeFixture({ png: encodePng({ width: 3, height: 1, data: holeData }) })
  await rewriteManifest(hole, (manifest) => ({ ...manifest, models: [{ ...manifest.models[0], preview: { x: 1, y: 0, w: 1, h: 1 } }] }))
  await assert.rejects(() => validateEnvironmentCandidate(hole), /CANDIDATE_PREVIEW_EMPTY|preview/u)
})

test('URI traversal и неизвестный semantic assetId отклоняются', async () => {
  const traversal = await writeFixture()
  await rewriteManifest(traversal, (manifest) => ({ ...manifest, models: [{ ...manifest.models[0], url: `${URL_ROOT}../outside.glb` }] }))
  await assert.rejects(() => validateEnvironmentCandidate(traversal), /CANDIDATE_URL_TRAVERSAL|CANDIDATE_URL_ROOT|путь/u)

  const unknownAsset = await writeFixture()
  await rewriteManifest(unknownAsset, (manifest) => ({ ...manifest, models: [{ ...manifest.models[0], assetIds: ['not-a-real-asset'] }] }))
  await assert.rejects(() => validateEnvironmentCandidate(unknownAsset), /CANDIDATE_ASSET_ID|assetId/u)
})

test('повреждённый GLB отклоняется до publisher', async () => {
  const root = await writeFixture()
  const bytes = await readFile(join(root, 'family', 'model.glb'))
  await writeFile(join(root, 'family', 'model.glb'), bytes.subarray(0, bytes.length - 4))
  await assert.rejects(() => validateEnvironmentCandidate(root), /GLB_LENGTH|GLB_CHUNK|GLB/u)
})

test('случайные файлы и пустой каталог моделей не принимаются к публикации', async () => {
  const extra = await writeFixture()
  await writeFile(join(extra, '.env'), 'Тестовый незаявленный файл\n')
  await assert.rejects(() => validateEnvironmentCandidate(extra), /CANDIDATE_UNDECLARED_FILE/u)
  const empty = await writeFixture()
  await rewriteManifest(empty, (manifest) => ({ ...manifest, models: [] }))
  await assert.rejects(() => validateEnvironmentCandidate(empty), /CANDIDATE_MANIFEST_VERSION/u)
})

test('receipt.json проверяется, но не входит в inventory и fingerprint', async () => {
  const root = await writeFixture()
  const first = await validateEnvironmentCandidate(root)
  await writeFile(join(root, 'receipt.json'), `${JSON.stringify({ schema: 'environment-candidate-receipt/v1', fingerprint: first.fingerprint, files: first.files })}\n`)
  const second = await validateEnvironmentCandidate(root)
  assert.equal(second.fingerprint, first.fingerprint)
  assert.equal(second.files.some((file) => file.path === 'receipt.json'), false)
  await writeFile(join(root, 'family', 'NOTICE.txt'), 'Обновлённый notice.\n')
  const reaccepted = await validateEnvironmentCandidate(root, { checkReceipt: false })
  assert.notEqual(reaccepted.fingerprint, first.fingerprint)
  await assert.rejects(() => validateEnvironmentCandidate(root), /CANDIDATE_RECEIPT_FINGERPRINT|receipt/u)
  await writeFile(join(root, 'receipt.json'), `${JSON.stringify({ schema: 'environment-candidate-receipt/v1', fingerprint: '0'.repeat(64), files: first.files })}\n`)
  await assert.rejects(() => validateEnvironmentCandidate(root), /CANDIDATE_RECEIPT_FINGERPRINT|receipt/u)
})

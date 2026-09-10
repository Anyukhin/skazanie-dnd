import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import test from 'node:test'
import { encodePng } from '../tools/png-codec.mjs'
import { registerAssets } from '../tools/register-asset-rights.mjs'
import { prepareEnvironmentAssets, publishEnvironmentCandidate, replaceFileAtomically, sealEnvironmentCandidate } from '../tools/environment-assets.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (value) => `${JSON.stringify(value, null, 2)}\n`

function triangleGlb() {
  const binary = Buffer.from(new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0]).buffer)
  const source = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{}],
    buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 0, 1] }],
  }
  const text = Buffer.from(JSON.stringify(source))
  const body = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 32)])
  const header = Buffer.alloc(20)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + body.length + binary.length, 8)
  header.writeUInt32LE(body.length, 12); header.writeUInt32LE(0x4e4f534a, 16)
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binary.length, 0); binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, body, binHeader, binary])
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'skazanie-environment-publication-'))
  t.after(async () => {
    const actual = await realpath(root)
    assert.ok(actual.startsWith(`${await realpath(tmpdir())}${sep}`))
    await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const candidate = join(root, 'tmp', 'candidate')
  const assets = join(root, 'public', 'assets')
  const active = join(assets, 'models', 'environment')
  const registry = join(root, 'data', 'asset-rights.json')
  await mkdir(join(candidate, 'quaternius'), { recursive: true })
  await mkdir(active, { recursive: true }); await mkdir(dirname(registry), { recursive: true })
  await writeFile(join(active, 'manifest.json'), json({ version: 1, models: [], label: 'Прежний выпуск' }))
  await writeFile(join(active, 'legacy.txt'), 'Файл старого клиента')
  await writeFile(registry, json({ schema: 'test', assets: [], rights_status: 'unchanged' }))
  registerAssets(['models/environment/manifest.json', 'models/environment/legacy.txt'], registry, { assetsRoot: assets })
  const glb = triangleGlb()
  await writeFile(join(candidate, 'quaternius', 'crate.glb'), glb)
  await writeFile(join(candidate, 'quaternius', 'LICENSE.txt'), 'CC0-1.0\n')
  await writeFile(join(candidate, 'quaternius', 'NOTICE.txt'), 'Тестовая модель, оригинальная геометрия.\n')
  const rgba = new Uint8Array(2048 * 256 * 4)
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) rgba.set([100, 140, 80, 255], (y * 2048 + x) * 4)
  const png = encodePng({ width: 2048, height: 256, data: rgba })
  await writeFile(join(candidate, 'topdown.png'), png)
  await writeFile(join(candidate, 'manifest.json'), json({ version: 1,
    sources: [{ url: 'https://quaternius.com/packs/fantasypropsmegakit.html', license: 'CC0-1.0', author: 'Quaternius', archive: 'fixture.zip', archiveSha256: digest(glb) }],
    build: { schema: 'environment-candidate/v1', importerVersion: 2, normalizationVersion: 1, selectionVersion: 1,
      sourceInputs: [{ path: 'quaternius/crate.glb', sha256: digest(glb), bytes: glb.length }] },
    models: [{ key: 'q-crate', label: 'Ящик', category: 'Хранилища', url: '/assets/models/environment/quaternius/crate.glb', assetIds: ['crate'], yaw: 0, preview: { x: 0, y: 0, w: 4, h: 4 } }],
    atlas: { image: '/assets/models/environment/topdown.png', key: digest(png) },
  }))
  return { root, candidate, active, registry, assets, glb }
}

test('активация использует неизменяемые URL и сохраняет файлы старых клиентов', async (t) => {
  const f = await fixture(t)
  await sealEnvironmentCandidate(f.candidate)
  const result = await publishEnvironmentCandidate(f.candidate, { rootDir: f.root })
  assert.equal(result.activated, true)
  const manifest = JSON.parse(await readFile(join(f.active, 'manifest.json'), 'utf8'))
  assert.match(manifest.models[0].url, new RegExp(`/releases/${result.releaseId}/quaternius/crate\\.glb$`))
  assert.equal(await readFile(join(f.active, 'legacy.txt'), 'utf8'), 'Файл старого клиента')
  const registry = JSON.parse(await readFile(f.registry, 'utf8'))
  assert.equal(registry.rights_status, 'unchanged')
  for (const [path, hash, bytes] of registry.assets) {
    const stored = await readFile(join(f.assets, path))
    assert.equal(digest(stored), hash, path); assert.equal(stored.length, bytes, path)
  }
  const before = await readFile(f.registry)
  const repeated = await publishEnvironmentCandidate(f.candidate, { rootDir: f.root })
  assert.equal(repeated.releaseId, result.releaseId)
  assert.deepEqual(await readFile(f.registry), before)
})

test('изменённый после проверки кандидат и dry-run не меняют активные файлы', async (t) => {
  const f = await fixture(t)
  await sealEnvironmentCandidate(f.candidate)
  const before = await readFile(join(f.active, 'manifest.json'))
  const registry = await readFile(f.registry)
  assert.equal((await publishEnvironmentCandidate(f.candidate, { rootDir: f.root, dryRun: true })).activated, false)
  assert.deepEqual(await readFile(join(f.active, 'manifest.json')), before)
  await writeFile(join(f.candidate, 'quaternius', 'NOTICE.txt'), 'Изменение после приёмки\n')
  await assert.rejects(publishEnvironmentCandidate(f.candidate, { rootDir: f.root }), /изменился|провер|receipt/iu)
  assert.deepEqual(await readFile(join(f.active, 'manifest.json')), before)
  assert.deepEqual(await readFile(f.registry), registry)
})

test('ошибка переключения каталога откатывает реестр и новый выпуск', async (t) => {
  const f = await fixture(t)
  await sealEnvironmentCandidate(f.candidate)
  const before = await readFile(join(f.active, 'manifest.json'))
  const registry = await readFile(f.registry)
  await assert.rejects(publishEnvironmentCandidate(f.candidate, { rootDir: f.root, replaceFile: async (path, bytes) => {
    if (resolve(path) === resolve(join(f.active, 'manifest.json'))) throw new Error('Тестовый отказ записи каталога')
    await replaceFileAtomically(path, bytes)
  } }), /Тестовый отказ/u)
  assert.deepEqual(await readFile(join(f.active, 'manifest.json')), before)
  assert.deepEqual(await readFile(f.registry), registry)
  assert.deepEqual(await readdir(join(f.active, 'releases')), [])
  assert.equal((await readdir(join(f.root, 'tmp'))).includes('environment-publication.lock'), false)
})

test('повторная приёмка обновлённого кандидата сохраняет предыдущий неизменяемый выпуск', async (t) => {
  const f = await fixture(t)
  const before = await sealEnvironmentCandidate(f.candidate)
  const first = await publishEnvironmentCandidate(f.candidate, { rootDir: f.root })
  const originalRelease = await readFile(join(f.active, 'releases', first.releaseId, 'manifest.json'))
  await writeFile(join(f.candidate, 'quaternius', 'NOTICE.txt'), 'Уточнённое описание модели\n')
  const after = await sealEnvironmentCandidate(f.candidate)
  assert.notEqual(after.fingerprint, before.fingerprint)
  const second = await publishEnvironmentCandidate(f.candidate, { rootDir: f.root })
  assert.notEqual(second.releaseId, first.releaseId)
  assert.deepEqual(await readFile(join(f.active, 'releases', first.releaseId, 'manifest.json')), originalRelease)
  assert.equal(JSON.parse(await readFile(join(f.active, 'manifest.json'))).release.id, second.releaseId)
})

test('отказ приёмки завершает prepare ошибкой и закрывает сервер вместо зависания', { timeout: 5000 }, async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.candidate, 'quaternius', 'crate.glb'), 'Повреждённый GLB')
  let closed = 0
  await assert.rejects(prepareEnvironmentAssets({ outputDir: f.candidate }, {
    importModels: async () => ({ directory: f.candidate }),
    startAtlas: async ({ onSaved }) => {
      queueMicrotask(() => { void onSaved().catch(() => {}) })
      return { url: 'fixture://atlas', close: async () => { closed += 1 } }
    },
  }), /GLB/u)
  assert.equal(closed, 1)
})

test('ошибка после физической замены каталога возвращает оба прежних файла', async (t) => {
  const f = await fixture(t)
  await sealEnvironmentCandidate(f.candidate)
  const oldManifest = await readFile(join(f.active, 'manifest.json'))
  const oldRegistry = await readFile(f.registry)
  await assert.rejects(publishEnvironmentCandidate(f.candidate, { rootDir: f.root, replaceFile: async (path, bytes) => {
    await replaceFileAtomically(path, bytes)
    if (resolve(path) === resolve(join(f.active, 'manifest.json'))) throw new Error('Отказ после замены')
  } }), /Отказ после замены/u)
  assert.deepEqual(await readFile(join(f.active, 'manifest.json')), oldManifest)
  assert.deepEqual(await readFile(f.registry), oldRegistry)
  assert.deepEqual(await readdir(join(f.active, 'releases')), [])
})

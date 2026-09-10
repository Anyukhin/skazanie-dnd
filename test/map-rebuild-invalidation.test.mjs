import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  addProp,
  createTacticalMap,
  serializeTacticalMap,
  setCell,
  setEdge,
} from '../server/tactical-map.mjs'

const buildDir = mkdtempSync(join(tmpdir(), 'skazanie-map-rebuild-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sources = [
  '../src/board3d-scene-signature.ts', '../src/prop-model-catalog.ts',
  '../src/scene-map-cache.ts', '../src/tactical-map-client.ts',
]
  .map((relative) => fileURLToPath(new URL(relative, import.meta.url)))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', buildDir, ...sources,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
for (const name of readdirSync(buildDir)) {
  if (!name.endsWith('.js')) continue
  const file = join(buildDir, name)
  const source = readFileSync(file, 'utf8').replace(/(from\s+["'])(\.\/[^"']+)(["'])/g, '$1$2.mjs$3')
  writeFileSync(join(buildDir, name.replace(/\.js$/u, '.mjs')), source)
  rmSync(file)
}
globalThis.atob ??= (value) => Buffer.from(value, 'base64').toString('binary')
globalThis.btoa ??= (value) => Buffer.from(value, 'binary').toString('base64')
const cache = await import(pathToFileURL(join(buildDir, 'scene-map-cache.mjs')).href)
const client = await import(pathToFileURL(join(buildDir, 'tactical-map-client.mjs')).href)
const signatures = await import(pathToFileURL(join(buildDir, 'board3d-scene-signature.mjs')).href)
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

function decoded(map) {
  const value = client.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(map))))
  assert.ok(value)
  return value
}

function decodedRaw(raw) {
  const value = client.decodeTacticalMap(JSON.parse(JSON.stringify(raw)))
  assert.ok(value)
  return value
}

function mapFixture(options = {}) {
  return createTacticalMap({
    width: 3,
    height: 2,
    catalogRevision: 'base',
    fill: { passable: true, revealed: true, material: 'stone', elevation: 0 },
    ...options,
  })
}

test('map_unchanged сохраняет serialized map и content signature', () => {
  cache.forgetSceneMaps()
  const raw = { version: 'map', width: 1, height: 1 }
  const first = cache.resolveSceneMap({ map: raw, map_hash: 'same-content' })
  const unchanged = cache.resolveSceneMap({ map_hash: 'same-content', map_unchanged: true })
  assert.equal(first?.map, raw)
  assert.equal(unchanged?.map, raw)
  assert.equal(cache.sceneMapContentSignature(first), cache.sceneMapContentSignature(unchanged))
})

test('signature различает legacy object identity и считает hash содержательной подписью', () => {
  const first = { map: { id: 1 }, cells: [] }
  const second = { map: { id: 2 }, cells: [] }
  assert.equal(cache.sceneMapContentSignature({ map_hash: 'same', ...first }), cache.sceneMapContentSignature({ map_hash: 'same', ...second }))
  assert.notEqual(cache.sceneMapContentSignature(first), cache.sceneMapContentSignature(second))
  assert.equal(cache.sceneMapContentSignature(null), '')
})

test('новая ссылка с прежним содержимым сохраняет обе подписи', () => {
  const source = mapFixture()
  const first = decoded(source)
  const clone = decodedRaw(serializeTacticalMap(source))
  assert.notEqual(first, clone)
  assert.deepEqual(signatures.mapSignaturesFor(first), signatures.mapSignaturesFor(clone))
})

test('предметы, дверь, материал, этаж и каталог обновляют только окружение', () => {
  const base = signatures.mapSignaturesFor(decoded(mapFixture()))
  const variants = [
    ['material', (map) => setCell(map, 0, 0, { material: 'wood' })],
    ['prop', (map) => addProp(map, { id: 'barrel-1', assetId: 'barrel', x: 1.5, y: .5, footprint: [{ x: 1, y: 0 }] })],
    ['door', (map) => setEdge(map, 0, 0, 1, 0, { kind: 'wall', blocksMove: true, blocksSight: true })],
    ['level', (map) => { map.levelIndex = 1 }],
    ['catalog', (map) => { map.catalogRevision = 'future' }],
  ]
  for (const [name, mutate] of variants) {
    const map = mapFixture()
    mutate(map)
    const changed = signatures.mapSignaturesFor(decoded(map))
    assert.notEqual(changed.staticKey, base.staticKey, `${name}: static signature`)
    assert.equal(changed.geometryKey, base.geometryKey, `${name}: terrain geometry signature`)
  }
})

test('раскрытие и высоты обновляют окружение и геометрию наложений', () => {
  const base = signatures.mapSignaturesFor(decoded(mapFixture()))
  for (const mutate of [
    (map) => setCell(map, 0, 0, { revealed: false }),
    (map) => setCell(map, 0, 0, { elevation: 5 }),
  ]) {
    const changed = mapFixture()
    mutate(changed)
    const current = signatures.mapSignaturesFor(decoded(changed))
    assert.notEqual(current.staticKey, base.staticKey)
    assert.notEqual(current.geometryKey, base.geometryKey)
  }
})

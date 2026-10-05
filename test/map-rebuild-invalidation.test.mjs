import assert from 'node:assert/strict'
import test from 'node:test'

import { compileClientModules } from './kit/client-ts.mjs'

import {
  addProp,
  createTacticalMap,
  serializeTacticalMap,
  setCell,
  setEdge,
} from '../server/tactical-map.mjs'

globalThis.atob ??= (value) => Buffer.from(value, 'base64').toString('binary')
globalThis.btoa ??= (value) => Buffer.from(value, 'binary').toString('base64')
const { modules: [cache, client, signatures] } = await compileClientModules([
  'src/scene-map-cache.ts', 'src/tactical-map-client.ts', 'src/board3d-scene-signature.ts', 'src/prop-model-catalog.ts',
])

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

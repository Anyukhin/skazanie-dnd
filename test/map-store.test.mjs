import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MapStore, externalizeMaps, internalizeMaps, isMapRef } from '../server/map-store.mjs'
import { buildBuildingScene } from '../server/building-generator.mjs'
import { legacyCellsFromTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'

function tempStore(t) {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-map-store-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, store: new MapStore({ rootDir: root }) }
}

function sceneState(seed = 'store') {
  const map = buildBuildingScene({ seed, width: 30, height: 30 }).map
  const serialized = serializeTacticalMap(map)
  return {
    sessionCode: 'STORE',
    scene: { title: 'Сцена', location: 'Дом', cells: legacyCellsFromTacticalMap(map), map: serialized },
    locationMaps: { 'loc-1': { version: 2, map: serialized } },
  }
}

test('карта кладётся по хешу и читается обратно без изменений', (t) => {
  const { store } = tempStore(t)
  const map = serializeTacticalMap(buildBuildingScene({ seed: 'put', width: 20, height: 20 }).map)
  const ref = store.put(map)
  assert.ok(isMapRef(ref))
  assert.equal(ref.width, 20)
  assert.equal(ref.height, 20)
  assert.deepEqual(store.get(ref.hash), map)
})

test('одинаковое содержимое не порождает второй файл', (t) => {
  const { root, store } = tempStore(t)
  const map = serializeTacticalMap(buildBuildingScene({ seed: 'dedup', width: 20, height: 20 }).map)
  const first = store.put(map)
  const second = store.put(JSON.parse(JSON.stringify(map)))
  assert.equal(first.hash, second.hash)
  const files = readdirSync(join(root, 'maps'), { recursive: true })
    .filter((name) => String(name).endsWith('.json'))
  assert.equal(files.length, 1, `файлов ${files.length}, ожидался один`)
})

test('разное содержимое даёт разные хеши', (t) => {
  const { store } = tempStore(t)
  const a = store.put(serializeTacticalMap(buildBuildingScene({ seed: 'a', width: 20, height: 20 }).map))
  const b = store.put(serializeTacticalMap(buildBuildingScene({ seed: 'b', width: 20, height: 20 }).map))
  assert.notEqual(a.hash, b.hash)
})

test('вынос карты из состояния и возврат дают то же состояние', (t) => {
  const { store } = tempStore(t)
  const state = sceneState()
  const stripped = externalizeMaps(state, store)
  assert.ok(isMapRef(stripped.scene.map), 'в состоянии обязана остаться ссылка')
  assert.ok(isMapRef(stripped.locationMaps['loc-1'].map))
  assert.equal('cells' in stripped.scene, false, 'производные клетки в снимок не пишутся')

  const restored = internalizeMaps(stripped, store)
  assert.deepEqual(restored.missing, [])
  assert.deepEqual(restored.state, state, 'состояние обязано вернуться в прежний вид')
})

test('вынос карты резко уменьшает снимок', (t) => {
  const { store } = tempStore(t)
  const state = sceneState()
  const before = Buffer.byteLength(JSON.stringify(state)) / 1024
  const after = Buffer.byteLength(JSON.stringify(externalizeMaps(state, store))) / 1024
  console.log(`  снимок: ${before.toFixed(1)} КБ → ${after.toFixed(1)} КБ`)
  assert.ok(after < before / 2, `снимок ${after.toFixed(1)} КБ против ${before.toFixed(1)} КБ — вынос почти ничего не дал`)

  // Порог плана: вклад карты в снимок не больше 5 КБ. Ссылка — это хеш,
  // ширина и высота, то есть сотни байт.
  const refOnly = Buffer.byteLength(JSON.stringify(externalizeMaps(state, store).scene.map)) / 1024
  assert.ok(refOnly < 0.3, `ссылка на карту весит ${refOnly.toFixed(2)} КБ`)
})

test('потерянный файл карты не роняет состояние', (t) => {
  const { store } = tempStore(t)
  const stripped = externalizeMaps(sceneState(), store)
  unlinkSync(store.fileFor(stripped.scene.map.hash))
  store.cache.clear()

  const restored = internalizeMaps(stripped, store)
  assert.equal(restored.missing.length, 2, 'обе ссылки указывают на один потерянный файл')
  assert.ok(isMapRef(restored.state.scene.map), 'ссылка остаётся ссылкой, а не превращается в мусор')
  assert.equal(restored.state.scene.cells, undefined,
    'без файла карты клетки не восстановить — снимок непригоден, хранилище переиграет события')
})

test('повторный вынос уже вынесенного ничего не меняет', (t) => {
  const { store } = tempStore(t)
  const once = externalizeMaps(sceneState(), store)
  const twice = externalizeMaps(once, store)
  assert.equal(twice, once, 'состояние без карт обязано вернуться тем же объектом')
})

test('состояние без карт проходит через обе функции без изменений', (t) => {
  const { store } = tempStore(t)
  const plain = { sessionCode: 'PLAIN', scene: { title: 'Без карты', cells: [] } }
  assert.equal(externalizeMaps(plain, store), plain)
  assert.equal(internalizeMaps(plain, store).state, plain)
})

test('файлы карт раскладываются по подкаталогам, а не в один', (t) => {
  const { root, store } = tempStore(t)
  for (let index = 0; index < 6; index += 1) {
    store.put(serializeTacticalMap(buildBuildingScene({ seed: `spread-${index}`, width: 18, height: 18 }).map))
  }
  const entries = readdirSync(join(root, 'maps'))
  assert.ok(entries.length > 1, 'карты обязаны раскладываться по подкаталогам')
  for (const entry of entries) {
    assert.ok(statSync(join(root, 'maps', entry)).isDirectory(), 'в корне хранилища лежат только подкаталоги')
  }
})

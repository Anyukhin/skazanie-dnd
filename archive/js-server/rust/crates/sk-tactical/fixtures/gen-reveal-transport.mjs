import '../../../fixtures-env.mjs'
// Эталон server/reveal-transport.mjs для Rust:
//
//   node rust/crates/sk-tactical/fixtures/gen-reveal-transport.mjs
//
// Проекции карт для игрока (`publicTacticalMapWithHashFor`) по мере
// раскрытия — однородные и правдоподобные карты, раскрытие, открывающее
// предмет, смена материала, карты другого размера — и последовательности
// вызовов над чистым кэшем: `sceneMapUpdateFor`, `compactSceneFor`,
// `compactStateForTransport`, вытеснение из кэша и повторные вопросы той же
// пары (запомненный ответ сторожа).
import * as r from '../../../../server/reveal-transport.mjs'
import * as t from '../../../../server/tactical-map.mjs'
import { publicTacticalMapWithHashFor } from '../../../../server/viewer-projection.mjs'
import { encode, hash, mulberry32, writeFixture } from './common.mjs'

const random = mulberry32(2026_10_19)
const int = (n) => Math.floor(random() * n)
const pick = (items) => items[int(items.length)]
const chance = (p) => random() < p

function plainMap(width, height) {
  return t.createTacticalMap({ width, height, seed: 'transport', catalogRevision: null, fill: { passable: true, revealed: false } })
}

function plausibleMap(width, height) {
  const map = t.createTacticalMap({ width, height, seed: 'plausible', catalogRevision: null, fill: { passable: true, revealed: false } })
  for (let y = 0; y < height; y += 1) {
    const material = y < height / 4 ? 'grass' : y < (height * 3) / 4 ? 'earth' : 'sand'
    for (let x = 0; x < width; x += 1) t.setCell(map, x, y, { material, variant: int(6) })
  }
  return map
}

function revealCircle(map, cx, cy, radius) {
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (!t.cellAt(map, x, y) || Math.hypot(x - cx, y - cy) > radius) continue
      t.setCell(map, x, y, { revealed: true })
    }
  }
}

/** Проекция карты для игрока вместе с хешем. */
function project(map) {
  const projected = publicTacticalMapWithHashFor(t.serializeTacticalMap(map))
  return { map: projected.map, hash: projected.hash }
}

// Серии снимков: одна карта, раскрываемая шаг за шагом.
const series = []
const addSeries = (map, steps) => {
  const snapshots = []
  for (const step of steps) {
    step(map)
    snapshots.push(project(map))
  }
  series.push(snapshots)
}
addSeries(plainMap(30, 30), [(m) => revealCircle(m, 15, 15, 3), (m) => revealCircle(m, 15, 15, 5), (m) => revealCircle(m, 15, 15, 8), (m) => revealCircle(m, 5, 5, 2)])
addSeries(plausibleMap(100, 100), [(m) => revealCircle(m, 50, 50, 12), (m) => revealCircle(m, 50, 50, 18), (m) => revealCircle(m, 30, 70, 6)])
{
  const map = plainMap(20, 20)
  for (let y = 0; y < 20; y += 1) for (let x = 0; x < 20; x += 1) t.setCell(map, x, y, { material: y < 10 ? 'wood' : 'marble', variant: (x * 3 + y) % 6 })
  for (let x = 6; x < 14; x += 1) t.setCell(map, x, 12, { surface: 'water' })
  addSeries(map, [(m) => revealCircle(m, 10, 10, 3), (m) => revealCircle(m, 10, 10, 6), (m) => revealCircle(m, 10, 10, 9)])
}
{
  const map = plainMap(20, 20)
  t.addProp(map, { id: 'well', assetId: 'well', x: 10.5, y: 15.5, footprint: [{ x: 10, y: 15 }] })
  addSeries(map, [(m) => revealCircle(m, 10, 10, 3), (m) => revealCircle(m, 10, 10, 6)])
}
{
  const map = plainMap(20, 20)
  for (let y = 0; y < 20; y += 1) t.setCell(map, 5, y, { passable: false })
  addSeries(map, [(m) => revealCircle(m, 10, 10, 4), (m) => revealCircle(m, 10, 10, 8)])
}
addSeries(plainMap(30, 30), [(m) => revealCircle(m, 15, 15, 4)])
// Заполнители для вытеснения: двадцать пять разных малых карт.
const fillers = []
for (let index = 0; index < r.PROJECTED_MAP_CACHE_LIMIT + 2; index += 1) {
  const map = plainMap(10, 10)
  revealCircle(map, index % 10, Math.floor(index / 10), 1)
  fillers.push(project(map))
}
series.push(fillers)

const maps = series.flat()
const indexOf = (snapshot) => maps.indexOf(snapshot)

const sequences = []
for (let number = 0; number < 70; number += 1) {
  r.forgetProjectedMaps()
  const steps = []
  const chain = pick(series)
  let client = ''
  const length = 6 + int(20)
  for (let index = 0; index < length; index += 1) {
    const roll = random()
    const current = chance(0.8) ? pick(chain) : pick(maps)
    const clientHash = chance(0.7) ? client : pick(['', 'ниоткуда', pick(maps).hash, current.hash])
    if (roll < 0.6) {
      const map = chance(0.05) ? null : current.map
      const mapHash = chance(0.05) ? '' : current.hash
      const update = r.sceneMapUpdateFor(map, mapHash, clientHash)
      steps.push({ op: 'update', map: map ? indexOf(current) : null, hash: mapHash, clientHash, kind: update.kind, result: hash(update) })
      if (update.kind !== 'full' || chance(0.5)) client = update.hash
    } else if (roll < 0.85) {
      const scene = chance(0.1)
        ? pick([null, [], 'x', { title: 'Без карты', cells: [] }, { title: 'Без хеша', map: current.map }])
        : { title: 'Зал', location: 'Крепость', map: current.map, map_hash: current.hash, cells: [], ...(chance(0.2) ? { map_delta: 'прежнее' } : {}) }
      const result = r.compactSceneFor(scene, clientHash)
      steps.push({ op: 'scene', map: indexOf(current), sceneKind: scene && typeof scene === 'object' && !Array.isArray(scene) ? (scene.map_hash ? 'full' : scene.map ? 'nohash' : 'nomap') : encode(scene), mapDelta: Boolean(scene?.map_delta), clientHash, same: result.scene === scene, result: hash(result) })
      if (result.hash) client = result.hash
    } else {
      const state = chance(0.1)
        ? pick([null, { players: [] }, { scene: null }, []])
        : { sessionCode: 'T', scene: { title: 'Зал', map: current.map, map_hash: current.hash }, players: [{ id: 'hero' }] }
      const result = r.compactStateForTransport(state, clientHash)
      steps.push({ op: 'state', map: indexOf(current), stateKind: state && typeof state === 'object' && !Array.isArray(state) ? (state.scene ? 'scene' : state.players ? 'players' : 'null-scene') : encode(state), clientHash, same: result.state === state, result: hash(result) })
      client = result.hash
    }
  }
  sequences.push(steps)
}

writeFixture(new URL('./reveal-transport.json', import.meta.url), {
  limit: r.PROJECTED_MAP_CACHE_LIMIT,
  maps,
  sequences,
})

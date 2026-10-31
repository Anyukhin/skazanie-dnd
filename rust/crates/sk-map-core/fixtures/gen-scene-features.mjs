import '../../../fixtures-env.mjs'
// Эталон server/scene-features.mjs для Rust:
//
//   node rust/crates/sk-map-core/fixtures/gen-scene-features.mjs
//
// - залы: прямоугольное помещение от 6×6 до 22×16 клеток с дверями по
//   стенам, точкой отряда внутри, снаружи или без неё — `raiseDais` с разной
//   высотой и глубиной, `deepestRoom`;
// - случайные планировки (до и после тонких стен) — `deepestRoom` и помост
//   в каждом помещении.
// Вызовы изнутри генераторов — в `generator-calls.json`.
import * as t from '../../../../server/tactical-map.mjs'
import { SCENE_FEATURES_VERSION, deepestRoom, raiseDais } from '../../../../server/scene-features.mjs'
import { thinWalls } from '../../../../server/thin-walls.mjs'
import { attempt, hash, mulberry32, writeFixture } from './common.mjs'
import { randomLayout } from './layouts.mjs'

const random = mulberry32(2026_10_35)
const int = (n) => Math.floor(random() * n)
const pick = (items) => items[int(items.length)]
const chance = (p) => random() < p

/** Зал с кладкой по краю, двери по стенам; иногда второй зал за перегородкой. */
function hallMap(index) {
  const width = 8 + int(17)
  const height = 8 + int(11)
  const map = t.createTacticalMap({ width, height, seed: `dais:${index}` })
  t.addZone(map, { id: 'yard', kind: 'exterior', material: 'grass' })
  t.addZone(map, { id: 'hall', kind: 'interior', material: 'stone', label: 'Зал' })
  const split = chance(0.4) ? 2 + int(Math.max(1, width - 4)) : -1
  if (split >= 0) t.addZone(map, { id: 'side', kind: 'interior', material: 'wood', label: 'Алтарная' })
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const ring = x === 0 || y === 0 || x === width - 1 || y === height - 1
      if (ring) t.setCell(map, x, y, { passable: chance(0.15), zone: 'yard', material: 'grass' })
      else if (x === split) t.setCell(map, x, y, { passable: false, zone: '' })
      else t.setCell(map, x, y, { passable: true, zone: split >= 0 && x > split ? 'side' : 'hall', material: 'stone' })
    }
  }
  for (let door = 0; door < int(4); door += 1) {
    const vertical = chance(0.5)
    const x = vertical ? pick([0, width - 2]) : 1 + int(width - 2)
    const y = vertical ? 1 + int(height - 2) : pick([0, height - 2])
    t.setDoor(map, { id: `door-${door}`, x, y, dir: vertical ? 'e' : 's', state: pick(['open', 'closed', 'locked']), blocksMove: chance(0.5) })
  }
  if (split >= 0 && chance(0.7)) {
    const y = 1 + int(height - 2)
    t.setCell(map, split, y, { passable: true, zone: 'hall' })
    t.setDoor(map, { id: 'inner', x: split, y, dir: 'e', state: 'closed', blocksMove: true })
  }
  if (chance(0.8)) t.addSpawnPoint(map, { id: 'party', x: int(width), y: int(height), role: chance(0.9) ? 'party' : 'enemy' })
  return map
}

const maps = []
const dais = []
const deepest = []
const record = (map, label) => {
  const before = JSON.parse(JSON.stringify(t.serializeTacticalMap(map)))
  const index = maps.length
  maps.push({ label, before })
  deepest.push({ map: index, result: attempt(() => deepestRoom(t.deserializeTacticalMap(before))) })
  const zones = [...new Set(map.zones.filter((zone) => zone.kind === 'interior').map((zone) => zone.id)), 'nowhere']
  for (const zoneId of zones) {
    if (zoneId === 'nowhere' && !chance(0.1)) continue
    const copy = t.deserializeTacticalMap(before)
    const options = pick([undefined, {}, { height: 5, depth: 3 }, { height: 10 }, { depth: 1 }, { depth: 4, height: -5 }, { height: 200, depth: 2 }, { depth: 0 }])
    const outcome = attempt(() => raiseDais(copy, zoneId, options))
    const after = t.serializeTacticalMap(copy)
    dais.push({ map: index, zoneId, options: options ?? null, outcome, after: hash(after) })
  }
}
for (let index = 0; index < 200; index += 1) record(hallMap(index), `hall:${index}`)
for (let index = 0; index < 160; index += 1) {
  const map = randomLayout(t, random, `features:${index}`)
  if (chance(0.7)) thinWalls(map)
  record(map, `layout:${index}`)
}

writeFixture(new URL('./scene-features.json', import.meta.url), {
  version: SCENE_FEATURES_VERSION,
  maps,
  deepest,
  dais,
})

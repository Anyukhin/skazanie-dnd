import '../../../fixtures-env.mjs'
// Эталон server/combat-bounds.mjs и помощников движка `syncCombatBounds` /
// `growCombatBounds` для Rust:
//
//   node rust/crates/sk-tactical/fixtures/gen-combat-bounds.mjs
//
// Чистые функции — на случайных размерах, участниках, запасах и картах.
// `syncCombatBounds` и `growCombatBounds` не экспортируются из
// `rules-engine.mjs`, поэтому здесь — их копия строка в строку над
// экспортируемыми частями (карта сцены, площадь актёра); копия сверяется с
// настоящим редьюсером (`CombatStarted`, `ActorMoved`) на нормализованных
// состояниях, и расхождение роняет генератор.
import * as cb from '../../../../server/combat-bounds.mjs'
import * as t from '../../../../server/tactical-map.mjs'
import { footprintCellsFor } from '../../../../server/actor-footprint.mjs'
import { actorPosition, findActor } from '../../../../server/rules/actors.mjs'
import { applyGameEvent, normalizeCampaignState } from '../../../../server/rules-engine.mjs'
import { encode, hash, mulberry32, writeFixture } from './common.mjs'

const random = mulberry32(2026_10_17)
const int = (n) => Math.floor(random() * n)
const pick = (items) => items[int(items.length)]
const chance = (p) => random() < p
const clone = (value) => JSON.parse(JSON.stringify(value))

// --- копия помощников rules-engine.mjs ---------------------------------------

function sceneTacticalMap(state) {
  const raw = state?.scene?.map
  if (!raw || typeof raw !== 'object') return null
  try {
    return t.deserializeTacticalMap(raw)
  } catch {
    return null
  }
}

function writeSceneTacticalMap(state, map) {
  if (!state?.scene) return state
  state.scene.map = t.serializeTacticalMap(map)
  state.scene.cells = t.legacyCellsFromTacticalMap(map)
  return state
}

function rebuildSceneTacticalMap(state) {
  const cells = Array.isArray(state.scene.cells) ? state.scene.cells : []
  if (!cells.length) return null
  const map = t.tacticalMapFromLegacyCells(cells, {
    locationId: String(state.scene.location_id ?? state.scene.locationId ?? ''),
    seed: String(state.worldMap?.seed ?? ''),
  })
  state.scene.map = t.serializeTacticalMap(map)
  return map
}

function ensureSceneTacticalMap(state) {
  if (!state?.scene || typeof state.scene !== 'object' || Array.isArray(state.scene)) return null
  const existing = sceneTacticalMap(state)
  if (existing) return existing
  return rebuildSceneTacticalMap(state)
}

function actorFootprintCellsAt(state, id, position = actorPosition(state, id)) {
  return footprintCellsFor(findActor(state, id), position)
}

function syncCombatBounds(state, actorIds) {
  const map = ensureSceneTacticalMap(state)
  if (!map || !cb.combatBoundsUseful(map)) return state
  const points = (Array.isArray(actorIds) ? actorIds : []).flatMap((id) => actorFootprintCellsAt(state, String(id)))
  if (!points.length) return state
  cb.applyCombatBounds(map, points)
  return writeSceneTacticalMap(state, map)
}

function growCombatBounds(state, position, actorIdValue = null) {
  const points = actorIdValue
    ? actorFootprintCellsAt(state, String(actorIdValue), position)
    : [{ x: Number(position?.x), y: Number(position?.y) }]
  if (!points.length || points.some((point) => !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y))) return state
  if (!state?.mechanics?.combat?.active) return state
  const map = sceneTacticalMap(state)
  if (!map?.combatBounds) return state
  for (const point of points) {
    if (cb.combatBoundsContain(map.combatBounds, point.x, point.y)) continue
    map.combatBounds = cb.expandCombatBounds(map, map.combatBounds, point.x, point.y)
  }
  return writeSceneTacticalMap(state, map)
}

// --- чистые функции -----------------------------------------------------------

const junkPoints = [null, { x: 1.5, y: 2 }, { x: '7', y: '8' }, {}, { x: null, y: 3 }, 'x']
const randomPoints = (width, height) => Array.from({ length: int(5) }, () => (chance(0.1) ? pick(junkPoints) : { x: int(width + 20) - 10, y: int(height + 20) - 10 }))
const margins = [undefined, 0, 3, 12, -2, 30]
const compute = []
for (let index = 0; index < 400; index += 1) {
  const width = 1 + int(100)
  const height = 1 + int(100)
  const participants = chance(0.03) ? 'не массив' : randomPoints(width, height)
  const margin = pick(margins)
  compute.push({ width, height, participants, margin: encode(margin), result: cb.computeCombatBounds({ width, height }, participants, margin === undefined ? {} : { margin }) })
}
const expand = []
for (let index = 0; index < 400; index += 1) {
  const width = 1 + int(100)
  const height = 1 + int(100)
  const bounds = chance(0.2) ? null : { minX: int(width), minY: int(height), maxX: int(width), maxY: int(height) }
  const x = int(width + 40) - 20
  const y = int(height + 40) - 20
  const margin = pick(margins)
  expand.push({ width, height, bounds, x, y, margin: encode(margin), contain: cb.combatBoundsContain(bounds, x, y), result: cb.expandCombatBounds({ width, height }, bounds, x, y, margin === undefined ? {} : { margin }) })
}
const useful = Array.from({ length: 100 }, () => {
  const width = 1 + int(60)
  const height = 1 + int(60)
  return [width, height, cb.combatBoundsUseful({ width, height })]
})

// --- карты и состояния --------------------------------------------------------

function regionMap(width, height, seed) {
  const map = t.createTacticalMap({ width, height, seed, catalogRevision: null, fill: { passable: true, revealed: true } })
  for (let index = 0; index < width; index += 1) {
    const x = int(width)
    const y = int(height)
    t.setCell(map, x, y, { passable: false })
    if (x + 1 < width && chance(0.5)) t.setEdge(map, x, y, x + 1, y, { kind: 'wall' })
  }
  if (chance(0.5)) {
    for (let y = 0; y < height; y += 1) if (chance(0.7)) t.setCell(map, Math.floor(width / 2), y, { passable: false })
  }
  return map
}

const maps = [regionMap(60, 60, 'big'), regionMap(40, 32, 'mid'), regionMap(20, 20, 'small'), regionMap(29, 1, 'line'), regionMap(100, 100, 'region')]
const coverage = []
for (const map of maps) {
  for (let index = 0; index < 40; index += 1) {
    const bounds = chance(0.1) ? null : { minX: int(map.width + 4) - 2, minY: int(map.height + 4) - 2, maxX: int(map.width + 4) - 2, maxY: int(map.height + 4) - 2 }
    coverage.push({ map: maps.indexOf(map), bounds, result: cb.combatBoundsCoverage(map, bounds) })
  }
}

const actorIds = ['hero', 'mage', 'ogre', 'wolf', 'ghost', 'drake']
function randomActors(width, height) {
  const players = [{ id: 'hero', character: 'Герой', hp: 10, maxHp: 10, inventory: [], x: int(width), y: int(height) }, { id: 'mage', character: 'Маг', hp: 8, maxHp: 8, inventory: [], x: int(width), y: int(height) }]
  const enemies = [
    { id: 'ogre', name: 'Огр', hp: 30, maxHp: 30, alive: true, x: int(width), y: int(height), footprint: { version: 1, size: 2 } },
    { id: 'wolf', name: 'Волк', hp: 5, maxHp: 5, alive: true, x: int(width), y: int(height) },
    { id: 'drake', name: 'Дракон', hp: 50, maxHp: 50, alive: true, x: int(width), y: int(height), footprint: { version: 1, size: pick([3, 4, 9]) } },
  ]
  if (chance(0.2)) enemies[1].x = 'далеко'
  const positions = {}
  for (const actor of [...players, ...enemies]) {
    if (chance(0.6)) positions[actor.id] = chance(0.1) ? { x: null, y: 2 } : { x: int(width), y: int(height) }
  }
  return { players, enemies, positions }
}

const baseStates = []
for (const [mapIndex, withBounds] of [[0, false], [0, true], [1, true], [2, false], [4, true], [4, false]]) {
  const map = t.deserializeTacticalMap(t.serializeTacticalMap(maps[mapIndex]))
  const { players, enemies, positions } = randomActors(map.width, map.height)
  if (withBounds) cb.applyCombatBounds(map, [{ x: players[0].x, y: players[0].y }])
  baseStates.push({
    scene: { title: 'Сцена', location_id: `loc-${mapIndex}`, map: t.serializeTacticalMap(map) },
    worldMap: { seed: 'world' },
    players,
    enemies,
    mechanics: { positions, combat: { active: chance(0.8) } },
  })
}
// Сцена без карты, только клетки: путь пересборки по старым клеткам.
const corridor = Array.from({ length: 31 }, (_, x) => ({ x, y: 0, type: x === 15 ? 'wall' : 'floor', revealed: true }))
baseStates.push({ scene: { title: 'Коридор', locationId: 'corridor', cells: corridor }, worldMap: { seed: 7 }, players: [{ id: 'hero', x: 1, y: 0, hp: 5 }], enemies: [{ id: 'wolf', x: 29, y: 0, hp: 3 }], mechanics: { positions: {}, combat: { active: true } } })
baseStates.push({ scene: { title: 'Коридор', cells: corridor.slice(0, 20) }, players: [{ id: 'hero', x: 1, y: 0 }], mechanics: { positions: {} } })
// Повреждённая карта, массив вместо сцены, сцены нет, клетки за краем.
baseStates.push({ scene: { map: { width: 'x' }, cells: corridor }, players: [{ id: 'hero', x: 3, y: 0 }], mechanics: { combat: { active: true } } })
baseStates.push({ scene: [], players: [{ id: 'hero', x: 3, y: 0 }] })
baseStates.push({ players: [{ id: 'hero', x: 3, y: 0 }] })
baseStates.push({ scene: { cells: [{ x: 120, y: 0, type: 'floor', revealed: true }] }, players: [{ id: 'hero', x: 3, y: 0 }] })

const outcome = (state, run) => {
  try {
    run(state)
    const map = sceneTacticalMap(state)
    return { state: hash(state), combatBounds: map ? map.combatBounds : 'нет карты' }
  } catch (error) {
    return { error: { name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) } }
  }
}

const sync = []
for (let index = 0; index < 300; index += 1) {
  const base = int(baseStates.length)
  const ids = chance(0.05) ? 'не массив' : Array.from({ length: int(5) }, () => pick([...actorIds, 'никто']))
  const idStrings = Array.isArray(ids) ? ids.map((id) => String(id)) : []
  sync.push({ base, ids: idStrings, ...outcome(clone(baseStates[base]), (state) => syncCombatBounds(state, ids)) })
}
const grow = []
for (let index = 0; index < 500; index += 1) {
  const base = int(baseStates.length)
  const width = 100
  const position = chance(0.1) ? pick([undefined, null, { x: 1.5, y: 2 }, { x: '40', y: '3' }, 'x']) : { x: int(width + 10) - 5, y: int(width + 10) - 5 }
  const actorId = pick([undefined, '', ...actorIds, 'никто'])
  grow.push({ base, position: encode(position), actorId: encode(actorId), ...outcome(clone(baseStates[base]), (state) => growCombatBounds(state, position, actorId)) })
}

// --- сверка копии с настоящим редьюсером --------------------------------------

let checked = 0
for (const base of baseStates.slice(0, 6)) {
  const normalized = normalizeCampaignState({ sessionCode: 'BOUNDS', partyMemberIds: base.players.map((player) => player.id), ...clone(base) })
  const initiative = [...base.players, ...base.enemies].map((actor) => ({ actor_id: actor.id }))
  const started = applyGameEvent(normalized, { event_type: 'CombatStarted', payload: { round: 1, active_index: 0, initiative }, actor_id: '', target_ids: initiative.map((entry) => entry.actor_id), source_rule_ids: [] })
  const copy = clone(normalized)
  syncCombatBounds(copy, initiative.map((entry) => entry.actor_id))
  if (JSON.stringify(sceneTacticalMap(copy)?.combatBounds) !== JSON.stringify(sceneTacticalMap(started)?.combatBounds)) throw new Error('копия syncCombatBounds разошлась с редьюсером')
  const to = { x: int(100), y: int(100) }
  const moved = applyGameEvent(started, { event_type: 'ActorMoved', payload: { to, distance: 5 }, actor_id: 'hero', target_ids: ['hero'], source_rule_ids: [] })
  const grown = clone(started)
  grown.mechanics.positions.hero = clone(to)
  growCombatBounds(grown, to, 'hero')
  if (JSON.stringify(sceneTacticalMap(grown)?.combatBounds) !== JSON.stringify(sceneTacticalMap(moved)?.combatBounds)) throw new Error('копия growCombatBounds разошлась с редьюсером')
  checked += 1
}
console.log(`  копия сверена с редьюсером на ${checked} состояниях`)

writeFixture(new URL('./combat-bounds.json', import.meta.url), {
  margin: cb.COMBAT_BOUNDS_MARGIN_CELLS,
  compute,
  expand,
  useful,
  maps: maps.map((map) => t.serializeTacticalMap(map)),
  coverage,
  baseStates,
  sync,
  grow,
})

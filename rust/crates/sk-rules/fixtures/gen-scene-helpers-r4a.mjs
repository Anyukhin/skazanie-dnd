import '../../../fixtures-env.mjs'
// Эталоны помощников сцены для разбора команд (задача Р4а): запись
// взаимодействия с предметом `sceneObjectState` (2760), расстановка отряда
// у входа новой сцены `sceneAdvancePartyPositions` (12223), места на
// целевом этаже `levelArrivalPositions` (2550) и переезд жителей при замене
// карты `planImportRelocations` (2504).
//
// Состояния — нормализованные состояния `reduce-r4a.json` с заплаткой
// (крупный герой, позиции, сущности, стэш этажа); карта — зал с дверью,
// сундуком, лестницей и факелом с заплаткой (этаж, `blocksMove` предметов,
// дверь). Заплатки хранятся вместо полных состояний: так эталон мал.
//
// Запуск (после gen-reduce-r4a.mjs): node rust/crates/sk-rules/fixtures/gen-scene-helpers-r4a.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { loadOpenCopy, sourceSha256 } from './open-copy.mjs'

const E = await loadOpenCopy()
const json = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)))
const data = JSON.parse(readFileSync(new URL('reduce-r4a.json', import.meta.url), 'utf8'))

let seed = 0x5ce0e004
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (list) => list[Math.floor(random() * list.length)]
const chance = (p) => random() < p
const integer = (low, high) => low + Math.floor(random() * (high - low + 1))

const groundMap = data.bases[0].scene.map

/** Заплатка карты и её применение (то же делает тест Rust). */
function mapPatch() {
  const patch = {}
  if (chance(0.5)) patch.level_index = pick([0, 1, -1])
  if (chance(0.4)) patch.blocks_move = [chance(0.5), chance(0.5), chance(0.5)]
  if (chance(0.3)) patch.door = { state: pick(['open', 'closed', 'locked']), blocksMove: chance(0.5), blocksSight: false }
  return patch
}
function applyMapPatch(patch) {
  const map = E.deserializeTacticalMap(structuredClone(groundMap))
  if (patch.level_index !== undefined) map.levelIndex = patch.level_index
  if (patch.blocks_move) map.props.forEach((prop, index) => { prop.blocksMove = patch.blocks_move[index] ?? prop.blocksMove })
  if (patch.door) E.setTacticalDoor(map, { ...map.doors[0], ...patch.door })
  return map
}

/** Заплатка состояния: поля целиком (`players`, `positions`, `entities`, `levelEntities`). */
function statePatch() {
  const base = integer(0, data.bases.length - 1)
  const source = data.bases[base]
  const patch = { base }
  if (chance(0.4)) {
    patch.players = source.players.map((player) => {
      const { combatSpells, combatActions, characterSheet, inventoryLoad, ...rest } = player
      return chance(0.5) ? { ...rest, footprint: { version: 1, size: pick([1, 2, 3]) } } : rest
    })
  }
  if (chance(0.5)) {
    patch.positions = {
      ...source.mechanics.positions,
      ...(chance(0.6) ? { 'goblin-1': { x: integer(-2, 13), y: integer(-2, 13) } } : {}),
      ...(chance(0.4) ? { zed: { x: integer(0, 11), y: integer(0, 11) }, 'b-1': { x: '3', y: 'x' } } : {}),
    }
  }
  if (chance(0.5)) {
    patch.entities = json([
      { id: 'e-2', kind: 'enemy', x: integer(0, 11), y: integer(0, 11) },
      { id: 'e-1', kind: 'chest', x: integer(0, 11), y: integer(0, 11), footprint: chance(0.3) ? { version: 1, size: 2 } : undefined },
      { id: '', kind: 'torch', x: 1, y: 1 },
      { kind: 'barrel', x: 'a', y: 2 },
    ])
  }
  if (chance(0.5)) {
    const location = E.sceneLocationId(source)
    patch.levelEntities = json({
      ...(source.levelEntities ?? {}),
      [E.levelKey(location, pick([0, 1, -1]))]: {
        enemies: [{ id: 'rat', footprint: chance(0.5) ? { version: 1, size: 2 } : undefined }],
        summons: [],
        positions: { rat: { x: integer(1, 10), y: integer(1, 10) }, ghost: { x: integer(1, 10), y: integer(1, 10) }, bad: { x: 'q' } },
        npc_placements: [{ npc_id: 'npc-guard', x: integer(1, 10), y: integer(1, 10), footprint: chance(0.5) ? { version: 1, size: 2 } : undefined }, { x: 'a' }],
      },
    })
  }
  return patch
}
function applyStatePatch(patch) {
  const state = structuredClone(data.bases[patch.base])
  if (patch.players) state.players = structuredClone(patch.players)
  if (patch.positions) state.mechanics.positions = structuredClone(patch.positions)
  if (patch.entities) state.entities = structuredClone(patch.entities)
  if (patch.levelEntities) state.levelEntities = structuredClone(patch.levelEntities)
  return state
}

const attempt = (fn) => {
  try {
    return { result: json(fn()) }
  } catch (error) {
    return { error: String(error?.code ?? error?.name ?? 'Error') }
  }
}
const cases = { scene_object_state: [], scene_advance_party_positions: [], level_arrival_positions: [], plan_import_relocations: [] }

for (let n = 0; n < 160; n += 1) {
  const base = integer(0, data.bases.length - 1)
  const state = structuredClone(data.bases[base])
  const map = E.deserializeTacticalMap(structuredClone(groundMap))
  const prop = pick(map.props)
  prop.state = pick(['', 'open', 'taken', 'used', 'closed', 'idle'])
  const saved = pick([
    undefined, null, 0,
    { state: 'closed', inspected: true, last_actor_id: pick(['hero', '', null, 'x'.repeat(130)]), inspection_attempted: pick([true, false]), used: pick([true, false]) },
    { inspection_attempted_by: ['a', 'a', ' b ', 5], used_by: ['hero'], knowledge_ids: ['k', null], extra: 1, last_actor_id: 'hero-2' },
    { inspection_attempted: true, used: true, last_actor_id: 'hero' },
  ])
  state.mechanics.scene_interactions = saved === undefined ? {} : { [prop.id]: saved }
  const definition = json({ initialState: pick(['locked', '', undefined, 5, 'x'.repeat(50)]), kind: pick(['campfire', 'chest', undefined]) })
  cases.scene_object_state.push({ base, scene_interactions: json(state.mechanics.scene_interactions), prop_id: prop.id, prop_state: prop.state, definition, ...attempt(() => E.sceneObjectState(state, prop, definition)) })
}

for (let n = 0; n < 200; n += 1) {
  const patch = statePatch()
  const withMap = chance(0.7)
  const map_patch = withMap ? mapPatch() : null
  const map = withMap ? applyMapPatch(map_patch) : null
  const reverse = chance(0.3)
  const extra = chance(0.2)
  const tiny = chance(0.1)
  const broken = withMap && chance(0.1)
  const cells = map ? E.legacyCellsFromTacticalMap(map) : structuredClone(data.bases[0].scene.cells)
  const ordered = reverse ? [...cells].reverse() : cells
  const entrance = pick([{ x: integer(0, 11), y: integer(0, 11) }, { x: 'a' }, undefined])
  const transition = json({
    entrance,
    scene: { cells: tiny ? [{ x: 1, y: 1, type: 'floor' }] : extra ? [...ordered, { x: 2, y: 2, type: 'floor' }, { x: 'q', y: 1 }, null] : ordered, ...(map ? { map: broken ? { broken: true } : E.serializeTacticalMap(map) } : {}) },
  })
  const state = applyStatePatch(patch)
  cases.scene_advance_party_positions.push({ patch, map_patch, reverse, extra, tiny, broken, entrance: json(entrance), ...attempt(() => E.sceneAdvancePartyPositions(state, transition)) })
}

for (let n = 0; n < 200; n += 1) {
  const patch = statePatch()
  const map_patch = mapPatch()
  const map = applyMapPatch(map_patch)
  const arrival = pick([...map.props.map((prop) => prop.id), null, 'empty'])
  const arrivalProp = arrival === 'empty' ? { footprint: [] } : arrival ? map.props.find((prop) => prop.id === arrival) : null
  const state = applyStatePatch(patch)
  cases.level_arrival_positions.push({ patch, map_patch, arrival, ...attempt(() => E.levelArrivalPositions(state, map, arrivalProp)) })
}

for (let n = 0; n < 200; n += 1) {
  const patch = statePatch()
  const map_patch = mapPatch()
  const map = applyMapPatch(map_patch)
  const party = json(pick([
    [{ actor_id: 'hero', x: 2, y: 2 }, { actor_id: 'hero-2', x: 3, y: 2 }],
    [{ actor_id: 'hero', x: integer(0, 11), y: integer(0, 11) }],
    [],
  ]))
  const state = applyStatePatch(patch)
  cases.plan_import_relocations.push({ patch, map_patch, party_positions: party, ...attempt(() => E.planImportRelocations(state, map, party)) })
}

writeFileSync(new URL('scene-helpers-r4a.json', import.meta.url), `${JSON.stringify({ source_sha256: sourceSha256(), cases })}\n`)
console.log(Object.fromEntries(Object.entries(cases).map(([name, list]) => [name, `${list.length} (отказов ${list.filter((entry) => entry.error).length})`])))

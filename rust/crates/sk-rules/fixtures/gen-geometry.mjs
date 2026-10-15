import '../../../fixtures-env.mjs'
// Эталоны задачи Р1: тактическая геометрия (`server/rules/tactical-geometry.mjs`
// целиком), площадь и помещение существа, вынужденное перемещение,
// местность и цена шага, прыжок, скорость и проекция движения, геометрия
// областей и цели заклинаний, синхронизация карты и клеток сцены, частная
// копия шести функций `server/npc-positioning.mjs`.
//
// Состояния двух родов:
//
// - синтетические: карты генератора сцен (`generateSceneGeometry`) и ручные
//   карты со стенами, окнами, дверями всех состояний, предметами с
//   `blocksMove` и укрытием, высотами, трудной местностью и водой; на них —
//   герои, противники и призывы площадью 1×1…4×4, умирающие, союзники,
//   полурослики сквозь крупных, состояния скорости, страх и «Приказ»,
//   длящиеся области (стены, сферы, кубы, круговые, ауры за заклинателем,
//   паутина, тяжёлая местность), социальные NPC с постами и без;
// - корпус: состояния до команды из `tmp/corpus-v1` (бой: движение, удар,
//   заклинание, приём), облегчённые до полей, которые читает геометрия.
//
// В эталоне состояние хранится без `scene.cells`: клетки — производная
// `legacyCellsFromTacticalMap` карты плюс правки (`patches`) — так их
// собирают и JS здесь, и Rust в тесте. Вызов — `{ f, s, a, o }`: функция,
// индекс состояния, аргументы, выход. Крупный выход — `sha256:` строки
// `JSON.stringify`; множества — отсортированные ключи `x,y`.
//
// Запуск: node rust/crates/sk-rules/fixtures/gen-geometry.mjs [каталог корпуса]
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as t from '../../../../server/tactical-map.mjs'
import * as g from '../../../../server/rules/tactical-geometry.mjs'
import * as npc from '../../../../server/npc-positioning.mjs'
import { generateSceneGeometry } from '../../../../server/adventure-director.mjs'
import { canonicalCombatSpellFor } from '../../../../server/combat-spells.mjs'
import { withRetentionMode } from '../../../../server/retention-context.mjs'
import { loadOpenCopy, sourceSha256 } from './open-copy.mjs'

const E = await loadOpenCopy()
const corpusDir = process.argv[2] ?? process.env.SK_RULES_CORPUS ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'

let seed = 0x5eed_0001
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let value = seed
  value = Math.imul(value ^ (value >>> 15), value | 1)
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}
const int = (n) => Math.floor(random() * n)
const pick = (list) => list[int(list.length)]
const chance = (p) => random() < p
const clone = (value) => (value === undefined ? undefined : structuredClone(value))
const json = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const U = '__undefined__'
const arg = (value) => (value === U ? undefined : value)

/** Выход в эталон: JSON (как его увидит Rust), крупное — хешем. */
function out(value) {
  if (value === undefined) return U
  if (value instanceof Set) value = [...value].sort()
  const text = JSON.stringify(value)
  return text.length > 320 ? `sha256:${sha(value)}` : JSON.parse(text)
}
function attempt(fn) {
  try {
    return { ok: out(fn()) }
  } catch (error) {
    if (error?.name !== 'RulesValidationError') return { fault: String(error?.name) }
    return { err: [error.code, error.message] }
  }
}

// --- карты ------------------------------------------------------------------

const ASSETS = ['crate', 'barrel', 'pillar', 'tree_oak', 'boulder', 'table', 'bookshelf', 'statue']
function manualMap(index) {
  const width = 7 + int(11)
  const height = 7 + int(11)
  const map = t.createTacticalMap({ width, height, locationId: `syn-${index}`, seed: `syn-${index}`, fill: { passable: true, revealed: true } })
  for (let n = int(width * height / 6); n > 0; n -= 1) t.setCell(map, int(width), int(height), { passable: false, surface: chance(0.3) ? 'water' : 'none' })
  for (let n = int(8); n > 0; n -= 1) t.setCell(map, int(width), int(height), { moveCost: 2 })
  for (let n = int(6); n > 0; n -= 1) t.setCell(map, int(width), int(height), { elevation: pick([5, 10, -5, 15, 3]) })
  for (let n = int(10); n > 0; n -= 1) t.setCell(map, int(width), int(height), { revealed: false })
  for (let n = int(width * height / 5); n > 0; n -= 1) {
    const x = int(width - 1)
    const y = int(height - 1)
    const [bx, by] = chance(0.5) ? [x + 1, y] : [x, y + 1]
    const kind = pick(['wall', 'wall', 'wall', 'window', 'rail', 'ledge', 'loophole', 'grate'])
    t.setEdge(map, x, y, bx, by, { kind, ...(kind === 'window' ? { blocksMove: true, blocksSight: false } : {}) })
  }
  for (let n = int(5); n > 0; n -= 1) {
    const x = int(width - 1)
    const y = int(height - 1)
    const dir = pick(['e', 's'])
    const state = pick(['open', 'closed', 'locked', 'broken'])
    t.setDoor(map, { id: `door-${index}-${n}`, x, y, dir, state, ...(chance(0.2) ? { barricade: { material_item_id: 'plank', actor_id: 'hero', previous_state: 'open' } } : {}) })
  }
  for (let n = int(6); n > 0; n -= 1) {
    const x = int(width)
    const y = int(height)
    const side = chance(0.7) ? 1 : 2
    const footprint = []
    for (let dy = 0; dy < side; dy += 1) for (let dx = 0; dx < side; dx += 1) footprint.push({ x: x + dx, y: y + dy })
    t.addProp(map, {
      id: `prop-${index}-${n}`,
      assetId: pick(ASSETS),
      x: x + (chance(0.5) ? 0.5 : 0),
      y,
      footprint: chance(0.85) ? footprint : [],
      blocksMove: chance(0.6),
      cover: pick(['none', 'half', 'three_quarters']),
    })
  }
  return map
}

const generatedLocations = ['Таверна', 'Склеп', 'Пещера', 'Тёмный лес', 'Деревня', 'Замок', 'Руины', 'Кладбище']
const maps = []
for (const location of generatedLocations) {
  try {
    maps.push(t.serializeTacticalMap(generateSceneGeometry({ location, seed: `r1:${location}`, useLibrary: false }).map))
  } catch (error) {
    console.log(`генератор отказал: ${location} ${error.message}`)
  }
}
for (let index = 0; index < 26; index += 1) maps.push(t.serializeTacticalMap(manualMap(index)))

// --- состояния ----------------------------------------------------------------

/** Состояние эталона: база без клеток, карта и правки производных клеток. */
const states = []
function assemble(spec) {
  const state = clone(spec.base)
  state.scene = { ...(state.scene ?? {}) }
  if (spec.map != null) {
    const raw = clone(spec.mapValue ?? maps[spec.map])
    state.scene.map = raw
    let cells = []
    try {
      cells = t.legacyCellsFromTacticalMap(t.deserializeTacticalMap(raw))
    } catch {
      cells = []
    }
    for (const [index, patch] of spec.patches ?? []) if (cells[index]) Object.assign(cells[index], json(patch))
    if (spec.cells !== false) state.scene.cells = cells
  }
  return state
}

const SIZES = [undefined, undefined, 'small', 'large', 'Huge', 'громадный', 'tiny', 'medium', 'большой', 3]
const CONDITIONS = ['prone', 'grappled', 'restrained', 'hasted', 'slowed', 'freedom-of-movement', 'speed-reduced-10', 'exhaustion:5', 'kinetic-jaunt', 'stunned', 'invisible']
const SPELL_IDS = ['web', 'grease', 'wall-of-fire', 'spike-growth', 'entangle', 'fog-cloud', 'stinking-cloud', 'moonbeam', 'spirit-guardians', 'darkness', 'silence', 'sleet-storm', 'cloud-of-daggers', '']

function walkablePoints(state) {
  const cells = Array.isArray(state.scene?.cells) ? state.scene.cells : []
  const walkable = cells.filter((cell) => g.isWalkableCell(cell))
  return walkable.length ? walkable : cells.length ? cells : [{ x: 0, y: 0 }]
}

function randomPoint(state, { fractional = false } = {}) {
  const cells = walkablePoints(state)
  const bounds = state.scene?.map?.width ?? 12
  if (fractional && chance(0.08)) return pick([{ x: 1.5, y: 2 }, { x: 'x', y: 3 }, { x: null, y: 2 }, null, U, { x: '4', y: '5' }])
  if (chance(0.12)) return { x: int(bounds + 4) - 2, y: int(bounds + 4) - 2 }
  const cell = pick(cells)
  return { x: Number(cell.x), y: Number(cell.y) }
}

function randomActor(id, side, points) {
  const point = pick(points)
  const actor = { id, name: id, hp: chance(0.15) ? 0 : 1 + int(30), maxHp: 30, x: Number(point.x), y: Number(point.y), speed: pick([30, 30, 25, 40, undefined, '35']) }
  if (chance(0.35)) actor.footprint = chance(0.9) ? { version: 1, size: 1 + int(4) } : pick([{ version: 2, size: 2 }, { version: 1, size: 7 }, 'large'])
  const size = pick(SIZES)
  if (size !== undefined) actor.size = size
  if (chance(0.05)) actor.alive = false
  if (chance(0.15)) actor.speciesBenefits = { mechanics: { move_through_larger: chance(0.8), ignore_armor_speed_penalty: chance(0.3) } }
  if (chance(0.1)) actor.height_feet = pick([3, 45, '7', 0.5])
  if (side === 'enemy' && chance(0.3)) actor.traits = ['web-walker', { id: 'pack-tactics' }]
  if (side === 'player') {
    actor.level = pick([1, 2, 5, 6, 10, 14, 18])
    actor.characterClass = pick(['monk', 'barbarian', 'fighter', 'wizard', undefined])
    actor.abilities = { str: pick([8, 10, 13, 15, 18, '12', undefined]) }
    if (chance(0.4)) actor.inventory = [{ id: 'armor', catalog_id: pick(['srd_5_2_1:chain-mail', 'srd_5_2_1:plate-armor', 'srd_5_2_1:leather-armor', 'srd_5_2_1:shield', 'srd_5_2_1:dagger']), equipped: chance(0.8) }]
  }
  return actor
}

function syntheticState(index) {
  const mapIndex = index % maps.length
  const spec = { base: {}, map: mapIndex, patches: [] }
  const preview = assemble(spec)
  const points = walkablePoints(preview)
  const players = Array.from({ length: 1 + int(3) }, (_, n) => randomActor(`hero-${n}`, 'player', points))
  const enemies = Array.from({ length: 1 + int(3) }, (_, n) => randomActor(`foe-${n}`, 'enemy', points))
  const actors = []
  if (chance(0.5)) {
    const summon = randomActor('summon-0', 'summon', points)
    Object.assign(summon, { kind: 'summon', ownerId: 'hero-0', faction: pick(['party', 'hostile', 'neutral']), untargetable: chance(0.3) })
    if (summon.faction === 'hostile' && chance(0.5)) enemies.push(summon)
    else actors.push(summon)
  }
  const ids = [...players, ...actors, ...enemies].map((actor) => actor.id)
  const positions = {}
  for (const id of ids) if (chance(0.4)) positions[id] = randomPoint(preview)
  const conditions = {}
  for (const id of ids) {
    if (!chance(0.45)) continue
    const list = []
    for (let n = int(3); n >= 0; n -= 1) {
      const kind = int(10)
      if (kind < 4) list.push(chance(0.5) ? pick(CONDITIONS) : { id: pick(CONDITIONS) })
      else if (kind < 6) list.push({ id: 'frightened', source_actor: pick(ids), ...(chance(0.3) ? { spell_id: 'phantasmal-killer' } : {}) })
      else if (kind < 7) list.push({ id: pick(['command:approach', 'command:flee']), source_actor: pick([...ids, undefined]) })
      else list.push({ id: 'longstrider', effect_id: `ls-${n}`, started_at_seconds: pick([0, 60, 120, undefined]), expires_at_seconds: pick([600, 3600, 30, '900', undefined]) })
    }
    conditions[id] = list
  }
  const effects = []
  for (let n = int(5); n > 0; n -= 1) {
    const spellId = pick(SPELL_IDS)
    const effect = { effect_id: `e-${n}`, spell_id: spellId, source_actor: pick(ids) }
    const kind = int(6)
    if (kind === 0) effect.cells = Array.from({ length: 2 + int(6) }, () => pick(points)).map((cell) => ({ x: Number(cell.x), y: Number(cell.y) }))
    else {
      effect.center = randomPoint(preview)
      effect.radius_feet = pick([5, 10, 15, 20, '10', 0, undefined])
      const shape = pick(['sphere', 'cube', 'cylinder', undefined, null])
      if (shape !== undefined) effect.area_shape = shape
      if (shape === 'cube' && chance(0.5)) effect.area_side_feet = pick([10, 15, 20])
      if (kind === 1) { effect.geometry_version = 'circle-grid-v2'; if (chance(0.6)) effect.grid_origin = effect.center }
      if (kind === 2) { effect.follows_source = true }
      if (chance(0.3)) effect.spreadsAroundCorners = chance(0.5)
    }
    if (chance(0.6)) effect.difficult_terrain = true
    if (chance(0.3)) effect.movement_cost_multiplier = pick([2, 3, 4, '3', 9])
    if (chance(0.3)) effect.condition = pick(['restrained', 'prone', 'blinded'])
    if (chance(0.2)) effect.requires_full_footprint = true
    effects.push(json(effect))
  }
  const location = `syn-loc-${mapIndex}`
  const base = {
    ruleset_id: pick(['srd_5_2_1', 'dnd_5e_2014']),
    players, enemies, actors,
    scene: { location_id: location, title: 'Сцена' },
    mechanics: {
      positions, conditions, active_effects: effects,
      combat: { active: chance(0.7), round: 1, active_index: 0, action_economy: {} },
      death: { heroes: {}, saving_throws: {} },
      world_time: { amount: pick([0, 1, 2]), unit: 'minute', elapsed_minutes: pick([0, 1, 2]), second_remainder: 0 },
    },
  }
  for (const id of ids) {
    if (!chance(0.5)) continue
    const path = []
    let cursor = randomPoint(preview)
    const [dx, dy] = pick([[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1]])
    for (let n = 1 + int(6); n > 0; n -= 1) {
      path.push({ ...cursor })
      cursor = { x: cursor.x + dx, y: cursor.y + dy }
    }
    base.mechanics.combat.action_economy[id] = { movement_spent: pick([0, 10, 15, 30]), movement_path: path, dash_count: pick([0, 1, undefined]), movement_bonus: pick([0, 10, undefined]) }
  }
  for (const player of players) {
    if (player.hp === 0 && chance(0.6)) base.mechanics.death.heroes[player.id] = { status: pick(['dying', 'dead', 'stable']) }
    if (chance(0.3)) base.mechanics.death.saving_throws[player.id] = { successes: int(4), failures: int(4), stable: chance(0.4) }
  }
  if (chance(0.45)) {
    const npcs = []
    const placements = []
    const vitals = {}
    const stances = {}
    for (let n = 1 + int(3); n > 0; n -= 1) {
      const id = `npc-${n}`
      npcs.push({ id, name: `Житель ${n}`, location_id: chance(0.85) ? location : 'elsewhere', role: pick(['стражник', 'ветеран', 'лекарь', 'торговец']), ...(chance(0.15) ? { visibility: 'gm_only' } : {}), ...(chance(0.1) ? { available: false } : {}) })
      const point = pick(points)
      if (chance(0.8)) placements.push({ npc_id: id, location_id: location, x: Number(point.x), y: Number(point.y), ...(chance(0.3) ? { footprint: { version: 1, size: 2 } } : {}) })
      if (chance(0.4)) vitals[id] = { hp: pick([0, 3, 8]), max_hp: 8, alive: pick([true, false, undefined]) }
      if (chance(0.4)) stances[id] = { stance: pick(['hostile', 'neutral', 'guarded', 'weird']) }
    }
    base.social = { npcs }
    base.npc_world = { placements, vitals, stances }
  } else if (chance(0.3)) {
    base.scene_npcs = Array.from({ length: 1 + int(3) }, (_, n) => ({ id: `sn-${n}`, ...pick(points), alive: pick([true, false, undefined]), stance: pick(['hostile', 'neutral', undefined]) }))
  }
  spec.base = json(base)
  // Правки производных клеток: признаки укрытия, туман, высоты, стены.
  const cellCount = assemble(spec).scene.cells.length
  for (let n = int(10); n > 0; n -= 1) {
    const patch = pick([
      { feature: pick(['pillar', 'barrel', 'tree', 'crate', 'altar', 'constructor', 'toString', 'unknown']) },
      { revealed: false }, { revealed: true }, { elevation: pick([5, 10, -5, '15']) }, { type: pick(['wall', 'water', 'Floor', 'DOOR', '']) },
    ])
    spec.patches.push([int(cellCount), patch])
  }
  return spec
}

for (let index = 0; index < 90; index += 1) states.push(syntheticState(index))

// --- корпус -----------------------------------------------------------------

const ACTOR_FIELDS = ['id', 'actor_id', 'name', 'hp', 'maxHp', 'max_hp', 'alive', 'x', 'y', 'footprint', 'size', 'creature_size', 'creatureSize', 'kind', 'faction', 'ownerId', 'owner_id', 'speciesBenefits', 'speed', 'level', 'characterClass', 'role', 'abilities', 'traits', 'height_feet', 'heightFeet', 'untargetable', 'creature_type', 'monster_type']
function slimActor(actor) {
  if (!actor || typeof actor !== 'object') return actor
  const result = {}
  for (const key of ACTOR_FIELDS) if (Object.hasOwn(actor, key)) result[key] = actor[key]
  if (Array.isArray(actor.inventory)) result.inventory = actor.inventory.filter((item) => item?.equipped).map((item) => ({ id: item.id, catalog_id: item.catalog_id, catalogId: item.catalogId, equipped: item.equipped, armor_profile: item.armor_profile }))
  return result
}
function slimState(state) {
  const mechanics = state.mechanics ?? {}
  return json({
    ruleset_id: state.ruleset_id,
    players: (state.players ?? []).map(slimActor),
    enemies: (state.enemies ?? []).map(slimActor),
    actors: (state.actors ?? []).map(slimActor),
    scene: { location_id: state.scene?.location_id, locationId: state.scene?.locationId, title: state.scene?.title, location: state.scene?.location },
    scene_npcs: state.scene_npcs,
    social: state.social?.npcs ? { npcs: state.social.npcs } : undefined,
    npc_world: state.npc_world,
    mechanics: {
      positions: mechanics.positions,
      conditions: mechanics.conditions ?? {},
      active_effects: mechanics.active_effects,
      combat: { active: mechanics.combat?.active, round: mechanics.combat?.round, active_index: mechanics.combat?.active_index, action_economy: mechanics.combat?.action_economy ?? {} },
      death: mechanics.death,
      world_time: mechanics.world_time,
    },
  })
}

const corpusStates = []
if (existsSync(corpusDir)) {
  const seen = new Set()
  const picked = []
  for (const file of readdirSync(corpusDir).filter((name) => name.startsWith('corpus-') && name.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(corpusDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const record = JSON.parse(line)
      if (!['MoveActor', 'CastSpell', 'MakeAttack', 'UseCombatAction'].includes(record.command?.command_type) || seen.has(record.state)) continue
      seen.add(record.state)
      picked.push(record)
    }
  }
  // Разнообразие: сначала состояния с областями, постами NPC и крупными существами.
  const scored = picked.map((record) => {
    const state = JSON.parse(readFileSync(join(corpusDir, 'states', `${record.state}.json`), 'utf8'))
    const actors = [...(state.players ?? []), ...(state.enemies ?? []), ...(state.actors ?? [])]
    const score = (state.mechanics?.active_effects?.length ? 4 : 0) + (state.npc_world?.placements?.length ? 3 : 0)
      + (actors.some((actor) => actor?.footprint?.size > 1) ? 3 : 0) + (state.scene?.map ? 1 : 0)
    return { record, state, score, key: `${record.command.command_type}:${score}:${actors.length}:${state.scene?.map ? sha(state.scene.map).slice(0, 6) : '-'}` }
  })
  const byKey = new Map()
  for (const entry of scored.sort((left, right) => right.score - left.score)) if (!byKey.has(entry.key)) byKey.set(entry.key, entry)
  for (const entry of [...byKey.values()].slice(0, 45)) {
    const slim = slimState(entry.state)
    const map = entry.state.scene?.map
    states.push({ base: slim, mapValue: map, map: map ? -1 : null, patches: [], corpus: entry.record.state, command: entry.record.command })
    corpusStates.push(states.length - 1)
  }
} else {
  console.log(`корпус не найден: ${corpusDir} — только синтетические состояния`)
}

// Состояния для синхронизации карты и клеток: расхождения клеток с картой.
const syncStates = []
for (let index = 0; index < 24; index += 1) {
  const mapIndex = int(maps.length)
  const spec = { base: { scene: { location_id: `sync-${index}` }, worldMap: { seed: `world-${index}` } }, map: mapIndex, patches: [] }
  const count = assemble(spec).scene.cells.length
  const kind = index % 6
  if (kind === 1) for (let n = 1 + int(6); n > 0; n -= 1) spec.patches.push([int(count), { revealed: chance(0.5) }])
  if (kind === 2) for (let n = 1 + int(6); n > 0; n -= 1) spec.patches.push([int(count), { type: pick(['wall', 'floor', 'water', 'door']), material: pick(['wood', 'stone', 'lava', undefined]) }])
  if (kind === 3) spec.patches.push([int(count), { feature: 'barrel' }], [int(count), { x: 999 }])
  if (kind === 4) spec.mapValue = { version: 'broken' }
  if (kind === 5) spec.cells = false
  states.push(spec)
  syncStates.push(states.length - 1)
}

const built = states.map(assemble)

// --- заклинания -------------------------------------------------------------

const SPELLS = ['fireball', 'stinking-cloud', 'shatter', 'moonbeam', 'sleep', 'wall-of-sand', 'wall-of-fire', 'tidal-wave', 'lightning-bolt', 'burning-hands', 'dragon-s-breath', 'thunderwave',
  'entangle', 'grease', 'faerie-fire', 'cloud-of-daggers', 'spirit-guardians', 'word-of-radiance', 'thunderclap', 'wither-and-bloom', 'mass-cure-wounds', 'bless', 'longstrider', 'healing-word',
  'magic-missile', 'cure-wounds', 'fog-cloud', 'misty-step', 'thorn-whip', 'gust', 'destructive-wave', 'color-spray', 'web', 'hold-person', 'chain-lightning']
const spells = []
for (const id of SPELLS) {
  for (const rulesetId of ['srd_5_2_1', 'dnd_5e_2014']) {
    const spell = canonicalCombatSpellFor(id, { rulesetId })
    if (spell) spells.push(json(spell))
  }
}
for (let n = 0; n < 12; n += 1) {
  const spell = clone(pick(spells))
  if (chance(0.5)) spell.radius = pick([5, 10, 30, '15', 0, 700])
  if (chance(0.4)) spell.selectTargetsInArea = true
  if (chance(0.3)) spell.areaShape = pick(['cube', 'sphere', 'cylinder', null, 'line'])
  if (chance(0.3)) spell.areaGeometryVersion = 'circle-grid-v2'
  if (chance(0.2)) spell.areaWidthFeet = 10
  if (chance(0.3)) spell.forcedMovementMaxSize = pick(['large', 'medium', 'huge'])
  spells.push(json(spell))
}

// --- вызовы -----------------------------------------------------------------

const cases = []
const add = (f, s, a, o) => cases.push({ f, s, a: json(a.map((value) => (value === undefined ? U : value))), o })

const actorIds = (state) => E.listActors(state).map((actor) => E.actorId(actor))
const someId = (state) => pick([...actorIds(state), ...actorIds(state), 'ghost'])
const mapOf = (state) => g.sceneTacticalMap(state)
const neighbour = (point) => {
  const [dx, dy] = pick([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]])
  return { x: point.x + dx, y: point.y + dy }
}
const orthogonal = (point) => {
  const [dx, dy] = pick([[1, 0], [-1, 0], [0, 1], [0, -1]])
  return { x: point.x + dx, y: point.y + dy }
}
const integerPoint = (state) => {
  const point = randomPoint(state)
  return point && typeof point === 'object' && Number.isSafeInteger(point.x) && Number.isSafeInteger(point.y) ? point : { x: 1, y: 1 }
}
const commandFor = (state, spell) => {
  const ids = actorIds(state)
  return json({
    actor_id: pick(ids),
    target_id: chance(0.5) ? pick(ids) : '',
    target_ids: chance(0.6) ? Array.from({ length: int(4) }, () => pick([...ids, 'npc-1', 'npc-2', 'ghost'])) : [],
    to: chance(0.9) ? integerPoint(state) : undefined,
    slot_level: pick([undefined, 1, 3, 5, 'x']),
    blind_target: chance(0.3),
  })
}

const stepCostKinds = ['bfs', 'weighted']
for (const [stateIndex, state] of built.entries()) {
  if (syncStates.includes(stateIndex)) continue
  const map = mapOf(state)
  const ids = actorIds(state)
  const repeat = corpusStates.includes(stateIndex) ? 5 : 3
  for (let n = 0; n < repeat; n += 1) {
    const id = someId(state)
    const other = someId(state)
    const point = integerPoint(state)
    const near = neighbour(point)
    const loose = randomPoint(state, { fractional: true })
    // Дробная или строковая точка в линии действия зацикливает JS (`lineCells`):
    // туда — только целые клетки и пустые значения.
    const sparse = pick([point, point, point, null, U])
    // tactical-geometry.mjs
    if (map) {
      const radius = pick([U, 3, 9, 0, 20])
      const door = map.doors.length && chance(0.5) ? pick(map.doors).id : U
      add('cellsVisibleFrom', stateIndex, [point, radius, door], out(g.cellsVisibleFrom(map, point, { ...(arg(radius) === undefined ? {} : { radius }), ...(arg(door) === undefined ? {} : { openedDoorId: door }) })))
      add('sightEdgeBlocked', stateIndex, [point, near], out(g.sightEdgeBlocked(map, point, near)))
      add('footprintPlacementEdgesBlocked', stateIndex, [id, point], out(g.footprintPlacementEdgesBlocked(map, E.findActor(state, id), point)))
      const step = orthogonal(point)
      add('footprintStepBlocked', stateIndex, [id, point, step], out(g.footprintStepBlocked(map, E.findActor(state, id), point, step)))
      add('transparentMapCell', stateIndex, [point], out(g.isTransparentMapCell(t.cellAt(map, point.x, point.y))))
    }
    const except = pick([id, U, null])
    add('downedHeroPositions', stateIndex, [except], out(g.downedHeroPositions(state, arg(except))))
    add('allyPassablePositions', stateIndex, [id], out(g.allyPassablePositions(state, id)))
    const includeDowned = chance(0.7)
    add('occupiedPositions', stateIndex, [except, includeDowned], out(g.occupiedPositions(state, arg(except), { includeDowned })))
    add('propMovementPositions', stateIndex, [], out(g.propMovementPositions(map)))
    for (const kind of stepCostKinds) {
      const allow = chance(0.3)
      const destination = chance(0.85) ? integerPoint(state) : loose
      const stepCost = kind === 'weighted' ? E.movementStepCostFor(state, id) : null
      const path = g.shortestTacticalPath(state, id, arg(destination), { allowOccupiedDestination: allow, ...(stepCost ? { stepCost: stepCost.stepCost, tacticalMap: stepCost.map } : {}) })
      add('shortestTacticalPath', stateIndex, [id, destination, allow, kind], out(path))
    }
    const from = integerPoint(state)
    const to = integerPoint(state)
    add('lineCells', stateIndex, [from, to], out(g.lineCells(from, to)))
    add('assertClearTrajectory', stateIndex, [from, to], attempt(() => g.assertClearTrajectory(state, from, to)))
    add('trajectoryDetails', stateIndex, [from, to], out(g.trajectoryDetails(state, from, to)))
    const hidden = chance(0.3)
    const fromPosition = chance(0.8) ? E.actorPosition(state, id) ?? from : from
    const toPosition = chance(0.8) ? E.actorPosition(state, other) ?? to : to
    add('actorTrajectoryDetails', stateIndex, [id, other, fromPosition, toPosition, hidden], out(g.actorTrajectoryDetails(state, id, other, fromPosition, toPosition, { allowHiddenTarget: hidden })))
    // `positionKey` берёт координаты как есть (`${null}` — «null»): только числа.
    const probe = pick([point, point, { x: 1.5, y: 2 }, null, U])
    add('elevationAt', stateIndex, [probe], out(g.elevationAt(state, arg(probe))))
    const distance = pick([null, 5, 10, 30, U])
    add('highGroundBetween', stateIndex, [from, to, distance], out(g.highGroundBetween(state, from, to, arg(distance))))
    add('coverBetween', stateIndex, [id, other, fromPosition, toPosition], out(g.coverBetween(state, id, other, fromPosition, toPosition)))
    add('hasClearTrajectory', stateIndex, [from, to], out(g.hasClearTrajectory(state, from, to)))
    // площадь и помещение
    const visibleAt = pick([point, U])
    add('actorFootprintVisible', stateIndex, [id, visibleAt], out(E.actorFootprintVisible(state, id, arg(visibleAt))))
    const object = pick([{ x: point.x, y: point.y }, { footprint: [near, point] }, { footprint: [] , x: near.x, y: near.y }, null])
    add('actorObjectDistanceCells', stateIndex, [id, object, U], out(E.actorObjectDistanceCells(state, id, object)))
    add('distanceBetweenActorPositions', stateIndex, [id, point, other, near], out(E.distanceBetweenActorPositions(state, id, point, other, near)))
    const allowOccupied = chance(0.3)
    add('actorFootprintFits', stateIndex, [id, point, allowOccupied], out(E.actorFootprintFits(state, id, point, { allowOccupied })))
    // вынужденное перемещение и траектории
    const feet = pick([5, 10, 15, 20, 0, '10', U])
    add('forcedPushPath', stateIndex, [id, point, feet], out(E.forcedPushPath(state, id, point, arg(feet))))
    add('forcedPullPath', stateIndex, [id, point, feet], out(E.forcedPullPath(state, id, point, arg(feet))))
    const roll = pick([1, 2, 3, 4, 0, 9, '3', U])
    add('forcedRandomStepPath', stateIndex, [id, roll], out(E.forcedRandomStepPath(state, id, arg(roll))))
    add('farthestSafeDestinationAwayFrom', stateIndex, [id, point, feet], out(E.farthestSafeDestinationAwayFrom(state, id, point, arg(feet))))
    add('hasClearActorTrajectory', stateIndex, [id, other, fromPosition, toPosition, hidden], out(E.hasClearActorTrajectory(state, id, other, fromPosition, toPosition, { allowHiddenTarget: hidden })))
    add('assertClearActorTrajectory', stateIndex, [id, other, fromPosition, toPosition, hidden], attempt(() => E.assertClearActorTrajectory(state, id, other, fromPosition, toPosition, { allowHiddenTarget: hidden })))
    add('hasClearActorToPoint', stateIndex, [id, fromPosition, to], out(E.hasClearActorToPoint(state, id, fromPosition, to)))
    add('assertClearActorToPoint', stateIndex, [id, fromPosition, to], attempt(() => E.assertClearActorToPoint(state, id, fromPosition, to)))
    // движение
    const pathOf = g.shortestTacticalPath(state, id, to) ?? [to]
    add('assertVoluntaryMovementPath', stateIndex, [id, fromPosition, to, pathOf], attempt(() => E.assertVoluntaryMovementPath(state, id, fromPosition, to, pathOf)))
    const jumpTo = chance(0.7) && E.actorPosition(state, id) ? (() => { const at = E.actorPosition(state, id); const [dx, dy] = pick([[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [0, 0]]); const span = 1 + int(4); return { x: at.x + dx * span, y: at.y + dy * span } })() : loose
    const running = chance(0.4)
    const minimum = pick([U, 5, 10])
    add('longJumpMovementFor', stateIndex, [id, jumpTo, running, minimum], attempt(() => E.longJumpMovementFor(state, id, arg(jumpTo), { runningStart: running, ...(arg(minimum) === undefined ? {} : { minimumDistanceFeet: minimum }) })))
    const minimumCharge = pick([20, 10, '15', U])
    add('completedStraightCharge', stateIndex, [id, other, minimumCharge], out(E.completedStraightCharge(state, id, other, arg(minimumCharge))))
    add('effectiveSpeedFeet', stateIndex, [id], out(E.effectiveSpeedFeet(state, E.findActor(state, id), id)))
    add('activeLongstriderConditions', stateIndex, [id], out(E.activeLongstriderConditions(state, id)))
    const speed = pick([0, 25, 30])
    add('movementBonusFeet', stateIndex, [id, speed], out(E.movementBonusFeet(state, id, speed)))
    add('movementForActor', stateIndex, [id], out(E.movementForActor(state, id)))
    const cost = pick([0, 30, 300, 1200, '60', U])
    add('explorationMovementDurationSeconds', stateIndex, [id, cost], attempt(() => E.explorationMovementDurationSeconds(state, id, arg(cost))))
    // местность
    const actorArg = pick([id, U])
    const lookup = E.difficultTerrainLookupFor(state)
    add('heavyTerrainMultiplierAt', stateIndex, [point, actorArg], out(E.heavyTerrainMultiplierAt(state, point, lookup, arg(actorArg) === undefined ? null : E.findActor(state, actorArg))))
    const withLookup = chance(0.7)
    add('difficultTerrainKindsAt', stateIndex, [point, actorArg, withLookup], out(E.difficultTerrainKindsAt(state, point, map, withLookup ? lookup : null, arg(actorArg) === undefined ? null : E.findActor(state, actorArg))))
    const costs = E.movementStepCostFor(state, id)
    const steps = [point, near, to, orthogonal(to)]
    add('movementStepCostFor', stateIndex, [id, steps], out({
      ignoresTerrain: costs.ignoresTerrain, webWalker: costs.webWalker, crawling: costs.crawling,
      steps: steps.map((step) => [costs.stepCost(step), costs.difficultAt(step), costs.chargesDifficultAt(step), costs.throughCreatureAt(step)]),
    }))
    add('movementCostOfPath', stateIndex, [id, pathOf], out(E.movementCostOfPath(state, id, pathOf)))
    // цели и расстояния
    add('distanceBetweenActors', stateIndex, [id, other], out(E.distanceBetweenActors(state, id, other)))
    add('deathSaveTracker', stateIndex, [id], out([E.deathSaveTracker(state, id), E.isDeadHero(state, id), E.isDyingHero(state, id), E.isUnstableDyingHero(state, id)]))
    const knight = pick([...ids, 'npc-1', 'npc-2', 'ghost'])
    add('knightDistanceFeet', stateIndex, [id, knight], out(E.knightDistanceFeet(state, id, knight)))
    add('areaCasterSideIds', stateIndex, [id], out(E.areaCasterSideIds(state, id)))
    // области
    const effects = state.mechanics?.active_effects ?? []
    if (effects.length) {
      const effectIndex = int(effects.length)
      const effect = effects[effectIndex]
      const areaCenter = E.areaCenterOf(state, effect)
      add('areaCenterOf', stateIndex, [effectIndex], out(areaCenter && typeof areaCenter === 'object' ? { x: Number(areaCenter.x), y: Number(areaCenter.y) } : areaCenter))
      add('positionInEffect', stateIndex, [sparse, effectIndex, actorArg], out(E.positionInEffect(state, arg(sparse), effect, arg(actorArg) === undefined ? null : E.findActor(state, actorArg))))
      add('areaEffectAffectsActor', stateIndex, [point, effectIndex, id], out(E.areaEffectAffectsActor(state, point, effect, E.findActor(state, id))))
      add('activeAreaEffectsAt', stateIndex, [point, actorArg], out(E.activeAreaEffectsAt(state, point, arg(actorArg) === undefined ? null : E.findActor(state, actorArg)).map((entry) => effects.indexOf(entry))))
      if (n < 2) add('areaCellsOf', stateIndex, [effectIndex], out(E.areaCellsOf(state, effect)))
      const otherEffect = int(effects.length)
      if (n < 2) add('areasOverlap', stateIndex, [effectIndex, otherEffect], out(E.areasOverlap(state, effect, effects[otherEffect])))
    }
    const spellIndex = int(spells.length)
    const spell = spells[spellIndex]
    const command = commandFor(state, spell)
    add('spellTargetsAt', stateIndex, [command, spellIndex], out(E.spellTargetsAt(state, command, spell).map((actor) => [E.actorId(actor), sha(actor)])))
    add('npcSpellTargetsAt', stateIndex, [command, spellIndex], out(E.npcSpellTargetsAt(state, command, spell).map(({ npc: target, placement }) => [String(target.id), sha(target), sha(placement)])))
    add('wallCells', stateIndex, [command, spellIndex], out(E.wallCells(state, command, spell)))
    add('spellCreatureFor', stateIndex, [knight, spellIndex], out(E.spellCreatureFor(state, knight, spell)))
    const center = chance(0.85) ? point : pick([null, U])
    const origin = integerPoint(state)
    add('areaLineOfEffectClear', stateIndex, [origin, point, spellIndex], out(E.areaLineOfEffectClear(state, origin, point, spell)))
    const within = pick(['all', 'sphere', 'cone', 'cube'])
    const withinRadius = pick([5, 10, 20])
    const withinFn = {
      all: () => true,
      sphere: (target, from) => E.positionInArea(target, from, withinRadius, 'sphere'),
      cone: (target, from) => E.positionInCone(target, from, center, withinRadius),
      cube: (target, from) => E.positionInDirectedCube(target, from, center, withinRadius),
    }[within]
    const targetPosition = E.actorPosition(state, other) ?? point
    add('areaTargetHasLineOfEffect', stateIndex, [command, spellIndex, center, other, targetPosition, within, withinRadius],
      out(E.areaTargetHasLineOfEffect(state, command, spell, arg(center), other, targetPosition, undefined, withinFn)))
    const shape = pick(['sphere', 'cone', 'cube', 'cylinder', U])
    const radiusFeet = pick([5, 10, 15, 30, 0])
    const originActor = pick([U, id])
    add('actorInArea', stateIndex, [id, point, center, radiusFeet, shape, originActor, origin],
      out(E.actorInArea(state, id, point, arg(center), radiusFeet, arg(shape), arg(originActor) ?? null, origin)))
    // NPC (частная копия)
    add('npcPlacementFor', stateIndex, [knight], out(npc.npcPlacementFor(state, knight)))
    add('npcInteractionTargetForViewer', stateIndex, [knight], out(npc.npcInteractionTargetForViewer(state, knight)))
    add('npcCombatActorFor', stateIndex, [knight], out(npc.npcCombatActorFor(state, knight)))
  }
  // Прицельные вызовы: точки внутри областей, высоты, прыжки с места, посты NPC.
  const effectList = state.mechanics?.active_effects ?? []
  for (const [effectIndex, effect] of effectList.entries()) {
    const inside = Array.isArray(effect.cells) ? effect.cells[0] : effect.center
    if (!inside || !Number.isSafeInteger(Number(inside.x)) || !Number.isSafeInteger(Number(inside.y))) continue
    const at = { x: Number(inside.x), y: Number(inside.y) }
    const mover = someId(state)
    const lookup = E.difficultTerrainLookupFor(state)
    add('heavyTerrainMultiplierAt', stateIndex, [at, mover], out(E.heavyTerrainMultiplierAt(state, at, lookup, E.findActor(state, mover))))
    add('positionInEffect', stateIndex, [at, effectIndex, mover], out(E.positionInEffect(state, at, effect, E.findActor(state, mover))))
    const costs = E.movementStepCostFor(state, mover)
    const probes = [at, orthogonal(at)]
    add('movementStepCostFor', stateIndex, [mover, probes], out({
      ignoresTerrain: costs.ignoresTerrain, webWalker: costs.webWalker, crawling: costs.crawling,
      steps: probes.map((step) => [costs.stepCost(step), costs.difficultAt(step), costs.chargesDifficultAt(step), costs.throughCreatureAt(step)]),
    }))
  }
  const raised = (state.scene?.cells ?? []).filter((cell) => Number(cell.elevation ?? 0) !== 0)
  for (let n = Math.min(4, raised.length); n > 0; n -= 1) {
    const high = pick(raised)
    const low = integerPoint(state)
    const from = { x: Number(high.x), y: Number(high.y) }
    add('elevationAt', stateIndex, [from], out(g.elevationAt(state, from)))
    add('highGroundBetween', stateIndex, [from, low, 30], out(g.highGroundBetween(state, from, low, 30)))
    add('highGroundBetween', stateIndex, [low, from, 15], out(g.highGroundBetween(state, low, from, 15)))
  }
  for (const id of ids.slice(0, 3)) {
    const at = E.actorPosition(state, id)
    if (!at) continue
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const span = 1 + int(3)
      const to = { x: at.x + dx * span, y: at.y + dy * span }
      const running = chance(0.3)
      add('longJumpMovementFor', stateIndex, [id, to, running, U], attempt(() => E.longJumpMovementFor(state, id, to, { runningStart: running })))
    }
  }
  for (const placement of (state.npc_world?.placements ?? []).slice(0, 2)) {
    const spellIndex = int(spells.length)
    const command = { ...commandFor(state, spells[spellIndex]), to: { x: placement.x, y: placement.y } }
    add('npcSpellTargetsAt', stateIndex, [command, spellIndex], out(E.npcSpellTargetsAt(state, command, spells[spellIndex]).map(({ npc: target, placement: post }) => [String(target.id), sha(target), sha(post)])))
    add('spellTargetsAt', stateIndex, [command, spellIndex], out(E.spellTargetsAt(state, command, spells[spellIndex]).map((actor) => [E.actorId(actor), sha(actor)])))
  }
  add('sceneNpcOccupiedCells', stateIndex, [], out(npc.sceneNpcOccupiedCells(state)))
  add('sceneNpcTransitCells', stateIndex, [], out(npc.sceneNpcTransitCells(state)))
  add('placedSceneNpcTargets', stateIndex, [], out(npc.placedSceneNpcTargets(state)))
  add('sceneNpcOccupiedCellsLegacy', stateIndex, [], out(withRetentionMode('legacy', () => npc.sceneNpcOccupiedCells(state))))
}

// Чистые функции без состояния: клетки, ранги, рост, области по точкам.
const cellSamples = [null, {}, { type: 'wall' }, { type: 'WALL' }, { type: 'floor' }, { type: 'Door' }, { type: 'water' }, { type: '' }, { type: null }, { type: 0 }, { type: ['floor'] }, { type: { a: 1 } }, { type: 'pit' }, { type: false }]
for (const cell of cellSamples) add('cellKinds', -1, [cell], out([g.isWalkableCell(cell), g.isTransparentCell(cell)]))
for (const actor of [null, {}, { size: 'Large' }, { creature_size: 'ОГРОМНЫЙ' }, { creatureSize: 'tiny' }, { footprint: { version: 1, size: 3 } }, { footprint: { version: 1, size: 2 }, size: 'small' }, { size: 'Gargantuan' }, { size: 'маленький' }, { size: 5 }, { size: null, footprint: { version: 1, size: 4 } }, { size: ['huge'] }, { size: 'крошечный' }, { size: 'medium' }, { height_feet: 12 }, { heightFeet: '40' }, { height_feet: 0, size: 'huge' }, { size: 'constructor' }, { size: 'toString' }, { footprint: { version: 1, size: 2 } }]) {
  add('actorShape', -1, [actor], out([g.creatureSizeRank(actor), E.creatureHeightFeet(actor), E.isLargeOrLarger(actor), E.sizeRankByName(actor?.size)]))
}
for (let n = 0; n < 40; n += 1) {
  const base = pick([{ x: 1, y: 1 }, { size: 'large' }, { footprint: { version: 1, size: 2 }, hp: 3 }, { id: 'a' }])
  const actor = chance(0.5) ? { ...base, footprint: pick([{ version: 1, size: 2 }, 'bad', null, { version: 1, size: 9 }]) } : base
  const size = pick([U, 'huge', 'small', 2, null, 'Gargantuan'])
  add('footprintFields', -1, [actor, size], out([E.normalizeActorFootprintFields(actor), E.stampActorFootprint(actor, arg(size))]))
}
for (let n = 0; n < 220; n += 1) {
  const position = pick([{ x: int(9) - 4, y: int(9) - 4 }, { x: int(9) - 4, y: int(9) - 4 }, { x: 0.5, y: 1 }, null])
  const center = pick([{ x: 0, y: 0 }, { x: 1, y: -1 }, { x: 0.5, y: 0 }, null])
  const toward = pick([{ x: 3, y: 0 }, { x: 0, y: -2 }, { x: 2, y: 2 }, { x: 0, y: 0 }, { x: -3, y: 1 }])
  const radius = pick([5, 10, 15, 20, 0, -5, '10', U, null])
  const side = pick([U, null, 10, 15, 20, 0])
  const shape = pick(['sphere', 'cube', 'cylinder', 'cone', U, null])
  const version = pick([U, null, 'circle-grid-v2'])
  add('pointArea', -1, [position, center, toward, radius, side, shape, version], out([
    E.positionInArea(position, center, arg(radius), arg(shape), arg(side), arg(version)),
    E.positionInCone(position, center, toward, arg(radius)),
    E.positionInDirectedCube(position, center, toward, arg(radius)),
    E.positionInPointCube(position, center, arg(radius), arg(side)),
    E.pointCubeBounds(center, arg(radius), arg(side)),
    E.pointCubeCellCount(arg(radius), arg(side)),
  ]))
}
for (const [spellIndex, spell] of spells.entries()) {
  const center = pick([{ x: 3, y: 4 }, { x: 2.5, y: -1 }, null])
  const target = pick([null, { size: 'huge' }, { size: 'small' }, { footprint: { version: 1, size: 3 } }])
  add('spellShape', -1, [spellIndex, center, target], out([E.circularSpellGeometry(spell), E.circularAreaMetadata(spell, center), E.spreadsAroundCorners(spell), E.forcedMovementSizeAllowed(spell, target)]))
}
for (let n = 0; n < 30; n += 1) {
  const state = built[pick(corpusStates.length ? [...corpusStates, 0, 1, 2] : [0, 1, 2])]
  const ids = actorIds(state)
  const command = { actor_id: pick([...ids, 'ghost']), blind_target: chance(0.6) }
  const context = { isNpcScheduler: chance(0.4), allowBlindTarget: chance(0.3), isAdmin: chance(0.2), isDirector: chance(0.2) }
  const withState = chance(0.8)
  add('blindTargetAllowed', built.indexOf(state), [command, context, withState], out(E.blindTargetAllowed(command, context, withState ? state : null)))
}
for (const actor of [{ level: 5, characterClass: 'barbarian' }, { level: 4, characterClass: 'barbarian' }, { level: 5, characterClass: 'barbarian', inventory: [{ catalog_id: 'srd_5_2_1:plate-armor', equipped: true }] },
  { level: 2, characterClass: 'monk' }, { level: 6, characterClass: 'monk' }, { level: 10, role: 'монах' }, { level: 14, characterClass: 'monk' }, { level: 18, characterClass: 'monk' },
  { level: 9, characterClass: 'monk', inventory: [{ catalog_id: 'srd_5_2_1:shield', equipped: true }] }, { level: 9, characterClass: 'monk', inventory: [{ armor_profile: { category: 'light' }, equipped: true }] },
  { level: 9, characterClass: 'monk', inventory: [{ catalog_id: 'srd_5_2_1:shield', equipped: 1 }] }, { level: '7', characterClass: 'monk' }, {}, null]) {
  add('classSpeedBonusFeet', -1, [actor], out(E.classSpeedBonusFeet(actor)))
}

// --- синхронизация карты и клеток --------------------------------------------

for (const stateIndex of syncStates) {
  const run = (fn) => {
    const state = clone(built[stateIndex])
    try {
      const result = fn(state)
      return { ok: [result && typeof result === 'object' && result.layers ? sha(t.serializeTacticalMap(result)) : out(result ?? null), sha(state.scene ?? null)] }
    } catch (error) {
      return { err: [error?.code ?? error?.name, String(error?.message)] }
    }
  }
  add('syncSceneCells', stateIndex, [], run((state) => { E.syncSceneCells(state); return null }))
  add('ensureSceneTacticalMap', stateIndex, [], run((state) => E.ensureSceneTacticalMap(state)))
  add('rebuildSceneTacticalMap', stateIndex, [], run((state) => E.rebuildSceneTacticalMap(state)))
  add('reconcileSceneTacticalMap', stateIndex, [], run((state) => E.reconcileSceneTacticalMap(state)))
  const other = maps[int(maps.length)]
  add('writeSceneTacticalMap', stateIndex, [maps.indexOf(other)], run((state) => { E.writeSceneTacticalMap(state, t.deserializeTacticalMap(other)); return null }))
  const state = built[stateIndex]
  const cells = Array.isArray(state.scene?.cells) ? state.scene.cells : []
  let derived = []
  try { derived = state.scene?.map ? t.legacyCellsFromTacticalMap(t.deserializeTacticalMap(state.scene.map)) : [] } catch { derived = [] }
  add('legacyCompare', stateIndex, [], out([E.sameLegacyGrid(cells, derived), E.legacyCellsDiverged(cells, derived)]))
  if (state.scene?.map && derived.length) {
    let merged
    try {
      const map = t.deserializeTacticalMap(state.scene.map)
      E.mergeLegacyCells(map, cells)
      merged = sha(t.serializeTacticalMap(map))
    } catch (error) {
      merged = `error:${error.code}`
    }
    add('mergeLegacyCells', stateIndex, [], merged)
  }
}

const statesOut = states.map((spec) => ({ base: spec.base, map: spec.map, ...(spec.mapValue ? { map_value: spec.mapValue } : {}), patches: spec.patches, ...(spec.cells === false ? { cells: false } : {}), ...(spec.corpus ? { corpus: spec.corpus } : {}) }))
const counts = {}
for (const entry of cases) counts[entry.f] = (counts[entry.f] ?? 0) + 1
const body = [
  '{',
  `"source_sha256": ${JSON.stringify(sourceSha256())},`,
  `"maps": [\n${maps.map((map) => JSON.stringify(map)).join(',\n')}\n],`,
  `"spells": [\n${spells.map((spell) => JSON.stringify(spell)).join(',\n')}\n],`,
  `"states": [\n${statesOut.map((spec) => JSON.stringify(spec)).join(',\n')}\n],`,
  `"cases": [\n${cases.map((entry) => JSON.stringify(entry)).join(',\n')}\n]`,
  '}',
].join('\n')
writeFileSync(new URL('./geometry.json', import.meta.url), `${body}\n`)
console.log(`geometry.json: ${(body.length / 1024 / 1024).toFixed(2)} МБ, карт ${maps.length}, состояний ${states.length} (корпус ${corpusStates.length}), заклинаний ${spells.length}, вызовов ${cases.length}`)
console.log(Object.entries(counts).map(([name, count]) => `${name} ${count}`).join(', '))

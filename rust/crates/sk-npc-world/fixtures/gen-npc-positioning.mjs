import '../../../fixtures-env.mjs'
import { startCapture } from './hook.mjs'
// Эталон server/npc-positioning.mjs для Rust:
//
//   node rust/crates/sk-npc-world/fixtures/gen-npc-positioning.mjs [каталог корпуса]
//
// Источники входов:
//
// - сценарии `test/npc-positioning.test.mjs` и соседних тестов модуля через
//   настоящий Rules Engine (`resolveCommand`, `applyGameEvent`, проекция) —
//   каждый верхний вызов модуля изнутри конвейера перехватывается хуком;
// - корпус паритета: состояния кампаний (`tmp/corpus-v1/states`) и повтор
//   записанных команд с теми же костями под тем же перехватом;
// - сотни случайных сцен: карты, NPC, миры NPC с мусором старых сохранений
//   (`null` в коллекциях, ключи прототипа как id, строки вместо чисел).
//
// Состояния урезаются до полей, которые читает модуль, и JS исполняется
// заново на урезанном входе — Rust получает ровно его.
import { fixtureWriter, mulberry32, chooser, viaJson, PROTOTYPE_KEYS } from './common.mjs'
import { corpusDir, corpusRecords, corpusState, mechanicsProfile, randomMap, randomNpc, randomNpcWorld, replayDice, ASSETS } from './npc-scenes.mjs'

const p = await import('../../../../server/npc-positioning.mjs')
const t = await import('../../../../server/tactical-map.mjs')
const rules = await import('../../../../server/rules-engine.mjs')
const { DiceService, SequenceDiceRng } = await import('../../../../server/dice-service.mjs')
const { withRetentionMode, retentionMode } = await import('../../../../server/retention-context.mjs')
const { campaignStateForViewer } = await import('../../../../server/viewer-projection.mjs')
const { getWorldTemplate } = await import('../../../../server/world-template-catalog.mjs')

const writer = fixtureWriter('npc-positioning', retentionMode)
const random = mulberry32(2026_10_15)
const { int, pick, chance } = chooser(random)

// ---------------------------------------------------------------------------
// Урезание состояния до полей, которые читает npc-positioning
// ---------------------------------------------------------------------------

const pickKeys = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const result = {}
  for (const key of keys) if (Object.hasOwn(value, key)) result[key] = value[key]
  return result
}
const NPC_KEYS = ['id', 'name', 'role', 'tags', 'location', 'location_id', 'locationId', 'available', 'visibility', 'reveal_on_presence', 'public_summary', 'post_assets', 'post_terrain', 'faction_id']
const ACTOR_KEYS = ['id', 'actor_id', 'name', 'x', 'y', 'hp', 'maxHp', 'alive', 'footprint', 'origin', 'size']

const bigMaps = new Set()
export function strip(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  const out = {}
  if (state.scene !== undefined) {
    out.scene = pickKeys(state.scene, ['title', 'location', 'location_id', 'locationId', 'map', 'map_requirements'])
    // Крупных карт корпуса — не больше трёх разных: остальные сцены идут без карты.
    if (out.scene && typeof out.scene === 'object' && out.scene.map && typeof out.scene.map === 'object') {
      const text = JSON.stringify(out.scene.map)
      if (text.length > 20_000 && !bigMaps.has(text)) {
        if (bigMaps.size < 3) bigMaps.add(text)
        else out.scene = { ...out.scene, map: null }
      }
    }
  }
  if (state.social !== undefined) {
    out.social = state.social && typeof state.social === 'object' && !Array.isArray(state.social)
      ? { npcs: Array.isArray(state.social.npcs) ? state.social.npcs.map((npc) => pickKeys(npc, NPC_KEYS)) : state.social.npcs }
      : state.social
  }
  if (state.npc_world !== undefined) out.npc_world = state.npc_world
  for (const key of ['players', 'enemies', 'actors']) {
    if (state[key] !== undefined) out[key] = Array.isArray(state[key]) ? state[key].map((actor) => pickKeys(actor, ACTOR_KEYS)) : state[key]
  }
  if (state.entities !== undefined) out.entities = Array.isArray(state.entities) ? state.entities.map((entity) => pickKeys(entity, ['id', 'kind', 'x', 'y', 'footprint'])) : state.entities
  if (state.mechanics && typeof state.mechanics === 'object') {
    out.mechanics = {}
    if (state.mechanics.positions !== undefined) out.mechanics.positions = state.mechanics.positions
    if (state.mechanics.combat !== undefined) out.mechanics.combat = state.mechanics.combat && typeof state.mechanics.combat === 'object' ? { active: state.mechanics.combat.active } : state.mechanics.combat
    if (state.mechanics.world_time !== undefined) out.mechanics.world_time = pickKeys(state.mechanics.world_time, ['elapsed_minutes'])
  }
  if (state.worldMemory && typeof state.worldMemory === 'object') {
    const npcIds = new Set((Array.isArray(state.social?.npcs) ? state.social.npcs : []).map((npc) => String(npc?.id)))
    out.worldMemory = { entities: Array.isArray(state.worldMemory.entities) ? state.worldMemory.entities.filter((entity, index) => index < 3 || npcIds.has(String(entity?.id))).map((entity) => pickKeys(entity, ['id'])) : state.worldMemory.entities }
  }
  if (state.scene_npcs !== undefined) out.scene_npcs = state.scene_npcs
  return out
}

// ---------------------------------------------------------------------------
// Таблица функций: имя → вызов и индексы аргументов-состояний
// ---------------------------------------------------------------------------

const withSet = (options) => (options && Array.isArray(options.occupied) ? { ...options, occupied: new Set(options.occupied) } : options)
const FNS = {
  normalizeNpcWorldState: { fn: (input, options) => p.normalizeNpcWorldState(input, options), states: [], refs: [0] },
  normalizeNpcWorldStateLegacy: { fn: (input) => p.normalizeNpcWorldStateLegacy(input), states: [], refs: [0] },
  sceneLocationId: { fn: (state) => p.sceneLocationId(state), states: [0] },
  presentSceneNpcs: { fn: (state) => p.presentSceneNpcs(state), states: [0] },
  npcPlacementFor: { fn: (...args) => p.npcPlacementFor(...args), states: [0] },
  npcVitalFor: { fn: (state, id) => p.npcVitalFor(state, id), states: [0] },
  npcMechanicsFor: { fn: (state, id) => p.npcMechanicsFor(state, id), states: [0] },
  npcCombatActorFor: { fn: (state, id) => p.npcCombatActorFor(state, id), states: [0] },
  npcInteractionTargetForViewer: { fn: (state, id) => p.npcInteractionTargetForViewer(state, id), states: [0] },
  initialNpcVital: { fn: (npc) => p.initialNpcVital(npc), states: [] },
  isValidNpcPost: { fn: (state, position, options) => p.isValidNpcPost(state, position, withSet(options)), states: [0] },
  planSceneNpcPlacementEvents: { fn: (state) => p.planSceneNpcPlacementEvents(state), states: [0] },
  validateNpcWorldCommand: { fn: (input, state, context) => p.validateNpcWorldCommand(input, state, context), states: [1] },
  placedSceneNpcTargets: { fn: (state) => p.placedSceneNpcTargets(state), states: [0] },
  sceneNpcOccupiedCells: { fn: (state) => p.sceneNpcOccupiedCells(state), states: [0] },
  sceneNpcTransitCells: { fn: (state) => p.sceneNpcTransitCells(state), states: [0] },
  npcTargetsWithinArea: { fn: (state, center, radius) => p.npcTargetsWithinArea(state, center, radius), states: [0] },
  npcMissCollateralTarget: { fn: (state, options) => p.npcMissCollateralTarget(state, options), states: [0] },
  npcHarmEventDrafts: { fn: (state, options) => p.npcHarmEventDrafts(state, options), states: [0] },
  planAuthoredNpcWorldEvents: { fn: (before, after, events, options) => p.planAuthoredNpcWorldEvents(before, after, events, options), states: [0, 1] },
  npcCombatStanceEventDrafts: { fn: (state, options) => p.npcCombatStanceEventDrafts(state, options), states: [0] },
  applyNpcWorldEvent: { fn: (input, event, options) => p.applyNpcWorldEvent(input, event, options), states: [], refs: [0] },
  sceneNpcsForViewer: { fn: (state) => p.sceneNpcsForViewer(state), states: [0] },
}

function record(name, args, options = {}) {
  const spec = FNS[name]
  const prepared = args.map((arg, index) => (spec.states.includes(index) ? strip(arg) : arg))
  return writer.call(name, spec.fn, prepared, { stateArgs: [...spec.states, ...(spec.refs ?? [])], ...options })
}

// Перехват конвейера: аргументы верхних вызовов модуля снимаются сразу
// (состояние потом меняется), урезанными.
const captured = []
const capturedPerFn = new Map()
const CAPTURE_LIMIT = 1_500
function capture(module, name, args) {
  if (module !== 'server/npc-positioning.mjs' || !FNS[name]) return
  if ((capturedPerFn.get(name) ?? 0) >= CAPTURE_LIMIT) return
  capturedPerFn.set(name, (capturedPerFn.get(name) ?? 0) + 1)
  try {
    const spec = FNS[name]
    captured.push({ name, retention: retentionMode(), args: args.map((arg, index) => viaJson(spec.states.includes(index) ? strip(arg) : withoutSets(arg))) })
  } catch { /* вход не сериализуется */ }
}
const withoutSets = (value) => (value && typeof value === 'object' && value.occupied instanceof Set ? { ...value, occupied: [...value.occupied] } : value)

function flushCaptured(cap) {
  for (const entry of captured.splice(0)) {
    if (entry.retention === 'legacy') withRetentionMode('legacy', () => record(entry.name, entry.args, { cap, retention: 'legacy' }))
    else record(entry.name, entry.args, { cap })
  }
}

// ---------------------------------------------------------------------------
// Батарея вызовов над одним состоянием
// ---------------------------------------------------------------------------

const ODD = ['constructor', '__proto__', 'toString', 'undefined', 'null', '', 'missing']

function npcIdsOf(state) {
  return (Array.isArray(state?.social?.npcs) ? state.social.npcs : []).map((npc) => npc?.id).filter((id) => id != null)
}

function battery(state, { cap = Infinity, deep = true } = {}) {
  const ids = [...new Set([...npcIdsOf(state).slice(0, 6), ...ODD.filter(() => chance(0.2))])]
  for (const name of ['sceneLocationId', 'presentSceneNpcs', 'placedSceneNpcTargets', 'sceneNpcOccupiedCells', 'sceneNpcTransitCells', 'planSceneNpcPlacementEvents', 'sceneNpcsForViewer']) {
    record(name, [state], { cap })
  }
  record('normalizeNpcWorldState', [state?.npc_world, undefined], { cap })
  for (const id of ids) {
    record('npcPlacementFor', [state, id], { cap })
    if (chance(0.2)) record('npcPlacementFor', [state, id, pick(['road', null, '', state?.scene?.location_id])], { cap })
    record('npcVitalFor', [state, id], { cap })
    record('npcMechanicsFor', [state, id], { cap })
    record('npcCombatActorFor', [state, id], { cap })
    record('npcInteractionTargetForViewer', [state, id], { cap })
  }
  if (!deep) return
  const width = Math.max(1, Number(state?.scene?.map?.width) || 6)
  const height = Math.max(1, Number(state?.scene?.map?.height) || 6)
  const posts = []
  for (let index = 0; index < 6; index += 1) posts.push({ x: int(-1, width), y: int(-1, height) })
  for (const post of posts) {
    const except = pick([...ids, '', undefined])
    record('isValidNpcPost', [state, post, except === undefined ? undefined : { exceptNpcId: String(except) }], { cap })
  }
  if (chance(0.3)) record('isValidNpcPost', [state, { x: '2', y: 1.5 }, { occupied: ['1,1', '2,2'], exceptNpcId: pick(ids) ?? '' }], { cap })
  const contexts = [{ isDirector: true }, { isAdmin: true }, { serverAuthoritativeCombat: true }, {}, { isAdmin: true, serverAuthoritativeCombat: true }]
  for (const id of ids.slice(0, 5)) {
    const to = chance(0.7) ? { x: int(0, width - 1), y: int(0, height - 1) } : pick([undefined, { x: 'a', y: 1 }, 5, { x: 1 }])
    const command = pick(['PlaceNpc', 'MoveNpc', 'HarmNpc', 'Other'])
    record('validateNpcWorldCommand', [{ command_type: command, command_id: `cmd-${id}`, npc_id: id, ...(to === undefined ? {} : { to }), amount: pick([1, 3, 0, 2000, '4', undefined]), ...(chance(0.2) ? { location_id: pick(['road', state?.scene?.location_id ?? '']) } : {}), ...(chance(0.2) ? { damage_type: 'fire', trigger: 'test' } : {}) }, state, pick(contexts)], { cap })
    record('npcHarmEventDrafts', [state, harmOptions(id)], { cap })
  }
  const placed = (state?.npc_world?.placements ?? [])
  const centers = [...(Array.isArray(placed) ? placed.slice(0, 3) : []), { x: int(0, width), y: int(0, height) }, undefined]
  for (const center of centers) {
    const point = center && typeof center === 'object' ? { x: center.x, y: center.y } : center
    record('npcTargetsWithinArea', [state, point, pick([5, 10, 15, 0, 'x', -5, 30])], { cap })
    record('npcMissCollateralTarget', [state, { targetPosition: point, attackTotal: pick([10, 11, 12, '9']), armorClass: pick([12, 13, 14, undefined]) }], { cap })
  }
  const participants = [...(state?.players ?? []), ...(state?.enemies ?? [])].map((actor) => actor?.id).filter(Boolean)
  record('npcCombatStanceEventDrafts', [state, { sourceEventId: pick(['combat-started:x', '', 7]), participantIds: [...participants.slice(0, 3), ...(chance(0.3) ? ['constructor', 'ghost'] : [])] }], { cap })
  // Цепочка событий над миром NPC.
  let world = state?.npc_world
  const events = [...p.planSceneNpcPlacementEvents(viaJson(strip(state))), ...syntheticEvents(ids)]
  for (const event of events.slice(0, 10)) {
    const options = pick([undefined, undefined, { isLegacy: true }, { retention: 'legacy' }, { retention: 'current' }])
    record('applyNpcWorldEvent', [world, event, options], { cap })
    try {
      world = p.applyNpcWorldEvent(viaJson(world), viaJson(event), options)
    } catch {
      break
    }
  }
}

function harmOptions(id) {
  const components = chance(0.35)
    ? Array.from({ length: int(1, 3) }, () => ({
      damage_type: pick(['fire', 'cold', 'thunder', '', undefined]),
      raw_amount: pick([0, 3, 7, 15, '4']),
      applied_amount: pick([0, 2, 5, 9, undefined]),
      ...(chance(0.3) ? { temporary_hp_absorbed: pick([0, 3, 7]) } : {}),
      ...(chance(0.1) ? { amount: 4 } : {}),
    }))
    : pick([undefined, [], 'x'])
  const temporary = chance(0.2)
  return {
    npcId: id,
    amount: pick([1, 2, 3, 4, 7, 20, 0, -3, '5', undefined]),
    ...(chance(0.6) ? { damageType: pick(['fire', 'bludgeoning', null, 'mixed']) } : {}),
    ...(components === undefined ? {} : { damageComponents: components }),
    ...(temporary ? { temporaryHpBefore: pick([10, 5, null]), temporaryHpAfter: pick([0, 2, undefined]), temporaryHpAbsorbed: pick([undefined, 3, 10]) } : {}),
    ...(chance(0.8) ? { sourceEventId: pick(['spell-cast:wave', 'attack:1', '', 5]) } : {}),
    ...(chance(0.8) ? { sourceActorId: pick(['hero', '', null]) } : {}),
    ...(chance(0.5) ? { trigger: pick(['area-spell', 'miss-collateral', 'test']) } : {}),
    ...(chance(0.8) ? { commandId: pick(['harm-1', 'wave', '', 12]) } : {}),
  }
}

function syntheticEvents(ids) {
  const id = () => pick([...ids, 'constructor', '__proto__', 'ghost', ''])
  const events = []
  for (let index = int(1, 6); index > 0; index -= 1) {
    const kind = pick(['NpcPlaced', 'NpcMoved', 'NpcHarmed', 'NpcDied', 'NpcStanceChanged', 'ItemGranted', 'ItemTransferred', 'Other'])
    const npcId = id()
    switch (kind) {
      case 'NpcPlaced':
      case 'NpcMoved':
        events.push({ event_type: kind, event_id: `e-${index}`, payload: { npc_id: npcId, location_id: pick(['market', 'road']), x: int(0, 6), y: int(0, 6), ...(chance(0.5) ? { vitality: { hp: pick([3, 9]), max_hp: 9, alive: true } } : {}), ...(chance(0.2) ? { footprint: { version: 1, size: 2 } } : {}) } })
        break
      case 'NpcHarmed':
        events.push({ event_type: kind, event_id: `e-${index}`, payload: { npc_id: npcId, hp_after: pick([0, 1, 3, '2']), max_hp: pick([4, 9]), ...(chance(0.4) ? { schema_version: 2, non_lethal: true, alive: true } : {}) } })
        break
      case 'NpcDied':
        events.push({ event_type: kind, event_id: `e-${index}`, payload: { npc_id: npcId } })
        break
      case 'NpcStanceChanged':
        events.push({ event_type: kind, event_id: `e-${index}`, payload: { npc_id: npcId, stance: pick(['frightened', 'hostile', 'bogus']), reason: 'test', ...(chance(0.5) ? { source_event_id: 'src' } : {}), propagation_depth: pick([0, 1, 3]) } })
        break
      case 'ItemGranted':
        events.push({ event_type: kind, payload: { source_npc_id: npcId, item: { id: pick(['item-marta-0', 'item-bor-1', 'x']), item_instance_id: pick([undefined, 'inst-marta-0']) } } })
        break
      case 'ItemTransferred':
        events.push({ event_type: kind, payload: { recipient_kind: pick(['npc', 'npc', 'hero']), to_actor_id: npcId, quantity: pick([1, 3, '2', 0]), stackable: pick([undefined, false]), item: pick([{ id: 'coin', name: 'Монета', type: 'treasure' }, { id: 'key', name: 'Ключ' }, ['a'], null]) } })
        break
      default:
        events.push({ event_type: kind, payload: { npc_id: npcId } })
    }
  }
  return events
}

// ---------------------------------------------------------------------------
// 1. Сценарии тестов через настоящий Rules Engine
// ---------------------------------------------------------------------------

const dice = (values) => {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `npc-roll-${++id}`, now: () => '2026-07-31T12:00:00.000Z' })
}

function openMap({ width = 9, height = 7, locationId = 'market' } = {}) {
  const map = t.createTacticalMap({ width, height, locationId, seed: `npc-map:${locationId}` })
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) t.setCell(map, x, y, { passable: true, revealed: true, material: 'stone' })
  t.addProp(map, { id: 'bar-1', assetId: 'bar_counter', x: width - 2, y: 2, footprint: [{ x: width - 2, y: 2 }], blocksMove: true })
  t.addProp(map, { id: 'altar-1', assetId: 'altar', x: 2, y: height - 2, footprint: [{ x: 2, y: height - 2 }], blocksMove: true })
  return map
}

const DEFAULT_NPCS = [
  { id: 'marta', name: 'Марта', role: 'трактирщица', location: 'Рынок', visibility: 'party', available: true, tags: ['faction:guild'] },
  { id: 'bor', name: 'Бор', role: 'стражник', location: 'Рынок', visibility: 'party', available: true, tags: ['faction:watch'] },
]

function npcState({ npcs = DEFAULT_NPCS, combat = false, map = openMap() } = {}) {
  return rules.normalizeCampaignState({
    state_version: 0,
    sessionCode: 'NPC-WORLD',
    scene: { title: 'Рынок', location: 'Рынок', location_id: 'market', map: t.serializeTacticalMap(map) },
    players: [{ id: 'hero', character: 'Лира', hp: 20, maxHp: 20, armor: 14, abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 10 }, x: 0, y: 1,
      inventory: [{ id: 'bomb', name: 'Огненная склянка', type: 'consumable', quantity: 2, combat: { kind: 'thrown-area', damage: '2d6', damageType: 'fire', normalRange: 30, radius: 5, saveAbility: 'dex', saveDc: 12, halfOnSave: true } }] }],
    enemies: [{ id: 'bandit', name: 'Бандит', hp: 12, maxHp: 12, armor: 13, alive: true, abilities: { dex: 10 }, x: 6, y: 1 }],
    social: { npcs, relationships: {}, conversations: [], promises: [] },
    autonomy: { reputations: {} },
    mechanics: combat ? { combat: { active: true, round: 1, initiative: [{ actor_id: 'hero' }, { actor_id: 'bandit' }], active_index: 0, action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement_spent: 0 } } } } : {},
  })
}

function applyCommand(state, command, context = { isDirector: true }) {
  const result = rules.resolveCommand(command, state, { diceService: dice([]), context })
  return { result, state: result.events.reduce(rules.applyGameEvent, state) }
}

const attempt = (fn) => {
  try {
    return fn()
  } catch {
    return null
  }
}

function authoredNpcState({ hp = 20 } = {}) {
  let state = npcState({ combat: true })
  state = applyCommand(state, { command_type: 'PlaceNpc', command_id: 'place-authored-marta', npc_id: 'marta', to: { x: 6, y: 2 } }).state
  const mechanics = structuredClone(getWorldTemplate('astohan-plains').opening.npcs[0].mechanics)
  state.npc_world = { ...state.npc_world, vitals: { ...state.npc_world.vitals, marta: { hp, max_hp: mechanics.hp, alive: hp > 0 } }, profiles: { ...state.npc_world.profiles, marta: mechanics } }
  const actor = p.npcCombatActorFor(state, 'marta')
  state.enemies = [...state.enemies, actor]
  state.mechanics.positions.marta = { x: 6, y: 2 }
  return rules.normalizeCampaignState(state)
}

function authoredNpcAfter(state, { hp, alive = hp > 0, position = { x: 6, y: 2 } } = {}) {
  const after = structuredClone(state)
  after.enemies = after.enemies.map((actor) => (actor.id === 'marta' ? { ...actor, hp, alive, x: position.x, y: position.y } : actor))
  after.mechanics.positions.marta = { ...position }
  return rules.normalizeCampaignState(after)
}

function authoredDamageEvent({ hpBefore, hpAfter, eventId = 'damage-authored-marta', commandId = 'cast-authored-marta' } = {}) {
  return { event_type: 'DamageApplied', event_id: eventId, command_id: commandId, actor_id: 'hero', target_ids: ['marta'],
    payload: { hp_before: hpBefore, hp_after: hpAfter, applied_amount: Math.max(0, hpBefore - hpAfter), raw_amount: Math.max(0, hpBefore - hpAfter), damage_type: 'fire' }, visibility: 'party' }
}

const stopCapture = startCapture(capture)
const labelled = []
const label = (name, state) => {
  writer.stateRef(strip(viaJson(state)), name)
  labelled.push(state)
  return state
}

// «Scene Architect получает детерминированный свободный пост» и «программа сцены».
const base = label('npc-state', npcState())
label('npc-state-two', npcState({ npcs: [
  { id: 'marta', name: 'Марта', role: 'трактирщица', location: 'Рынок', visibility: 'party', available: true },
  { id: 'teren', name: 'Терен', role: 'писарь', location: 'Рынок', visibility: 'party', available: true },
] }))
const altarProgram = viaJson(base)
altarProgram.scene.map_requirements = { version: 'scene-requirements/v2', items: [{ id: 'altar', count: 1 }], posts: [{ npc: 'Марта', id: 'altar' }] }
label('program-altar', altarProgram)
const platformState = viaJson(base)
const platformMap = openMap()
for (const x of [5, 6, 7]) for (const y of [4, 5]) t.setCell(platformMap, x, y, { material: 'wood', elevation: 2 })
platformState.scene.map = t.serializeTacticalMap(platformMap)
platformState.scene.map_requirements = { version: 'scene-requirements/v3', items: [{ id: 'platform', count: 1 }], posts: [{ npc: 'Марта', id: 'platform' }] }
label('program-platform', platformState)

// Коридор: транзит мирного и блок враждебного.
const corridorMap = t.createTacticalMap({ width: 5, height: 1, locationId: 'corridor', seed: 'corridor' })
for (let x = 0; x < 5; x += 1) t.setCell(corridorMap, x, 0, { passable: true, revealed: true })
const corridor = rules.normalizeCampaignState({
  sessionCode: 'NPC-CORRIDOR',
  scene: { title: 'Коридор', location: 'Коридор', location_id: 'corridor', map: t.serializeTacticalMap(corridorMap) },
  players: [{ id: 'hero', hp: 20, maxHp: 20, armor: 14, abilities: { str: 10, dex: 10 }, x: 0, y: 0 }],
  enemies: [{ id: 'enemy', hp: 10, maxHp: 10, armor: 10, alive: true, x: 4, y: 0 }],
  social: { npcs: [{ id: 'marta', name: 'Марта', role: 'житель', location: 'Коридор', visibility: 'party', available: true }], relationships: {}, conversations: [], promises: [] },
  npc_world: { placements: [{ npc_id: 'marta', location_id: 'corridor', x: 2, y: 0 }], vitals: { marta: { hp: 4, max_hp: 4, alive: true } }, stances: { marta: { stance: 'neutral' } } },
})
label('corridor', corridor)
attempt(() => rules.shortestTacticalPath(corridor, 'hero', { x: 3, y: 0 }))
const hostileCorridor = structuredClone(corridor)
hostileCorridor.npc_world.stances.marta.stance = 'hostile'
label('corridor-hostile', hostileCorridor)
attempt(() => rules.shortestTacticalPath(hostileCorridor, 'hero', { x: 3, y: 0 }))
attempt(() => rules.resolveCommand({ command_type: 'MoveActor', command_id: 'corridor-move', actor_id: 'hero', to: { x: 3, y: 0 }, server_authoritative: true }, corridor, { diceService: dice([]), context: { serverAuthoritativeCombat: true, allowedActorIds: ['hero'] } }))

// PlaceNpc / MoveNpc / HarmNpc, отказы и replay.
attempt(() => rules.resolveCommand({ command_type: 'PlaceNpc', npc_id: 'marta', to: { x: 6, y: 2 } }, base, { diceService: dice([]), context: {} }))
attempt(() => rules.resolveCommand({ command_type: 'PlaceNpc', npc_id: 'marta', to: { x: 7, y: 2 } }, base, { diceService: dice([]), context: { isDirector: true } }))
const placed = attempt(() => applyCommand(base, { command_type: 'PlaceNpc', command_id: 'place-marta', npc_id: 'marta', to: { x: 6, y: 2 } }))
if (placed) {
  label('placed-marta', placed.state)
  const moved = attempt(() => applyCommand(placed.state, { command_type: 'MoveNpc', command_id: 'move-marta', npc_id: 'marta', to: { x: 5, y: 2 } }))
  if (moved) {
    label('moved-marta', moved.state)
    const absent = structuredClone(moved.state)
    absent.social.npcs = absent.social.npcs.map((npc) => (npc.id === 'marta' ? { ...npc, location: 'Дорога' } : npc))
    label('absent-marta', absent)
    attempt(() => rules.resolveCommand({ command_type: 'HarmNpc', npc_id: 'marta', amount: 1 }, absent, { diceService: dice([]), context: { isAdmin: true, serverAuthoritativeCombat: true } }))
  }
  const harmed = attempt(() => applyCommand(placed.state, { command_type: 'HarmNpc', command_id: 'harm-idempotent', npc_id: 'marta', amount: 1, damage_type: 'bludgeoning' }, { isAdmin: true, serverAuthoritativeCombat: true }))
  if (harmed) label('harmed-marta', harmed.state)
  const visible = attempt(() => rules.applyGameEvent(placed.state, { event_type: 'NpcHarmed', event_id: 'harm-visible', command_id: 'harm-visible', actor_id: null, target_ids: ['marta'], visibility: 'party', payload: { npc_id: 'marta', hp_before: 4, hp_after: 2, max_hp: 4 } }))
  if (visible) {
    label('bloodied-marta', visible)
    attempt(() => campaignStateForViewer(visible, { role: 'player' }, 'hero'))
  }
  // Возврат в локацию.
  const away = attempt(() => rules.applyGameEvent(placed.state, { command_id: 'to-road', event_type: 'SceneAdvanced', actor_id: null, target_ids: [], visibility: 'party',
    payload: { scene: { title: 'Дорога', location: 'Дорога', location_id: 'road', map: t.serializeTacticalMap(openMap({ locationId: 'road' })) }, party_positions: [{ actor_id: 'hero', x: 0, y: 1 }] } }))
  if (away) {
    label('away-road', away)
    const returned = attempt(() => rules.applyGameEvent(away, { command_id: 'back-to-market', event_type: 'SceneAdvanced', actor_id: null, target_ids: [], visibility: 'party',
      payload: { scene: { title: 'Рынок', location: 'Рынок', location_id: 'market', map: t.serializeTacticalMap(openMap()) }, party_positions: [{ actor_id: 'hero', x: 0, y: 1 }] } }))
    if (returned) label('returned-market', returned)
  }
}

// Автопост рядом с занятым постом и героем.
{
  const npcs = [
    { id: 'marta', name: 'Марта', role: 'трактирщица', location: 'Рынок', visibility: 'party', available: true },
    { id: 'teren', name: 'Терен', role: 'писарь', location: 'Рынок', visibility: 'party', available: true },
  ]
  const placedTwo = attempt(() => applyCommand(npcState({ npcs }), { command_type: 'PlaceNpc', command_id: 'place-marta-before-teren', npc_id: 'marta', to: { x: 6, y: 2 } }).state)
  if (placedTwo) {
    const provisional = p.planSceneNpcPlacementEvents({ ...placedTwo, social: { ...placedTwo.social, npcs: [npcs[1]] } })[0]
    if (provisional) {
      placedTwo.players[0] = { ...placedTwo.players[0], x: provisional.payload.x, y: provisional.payload.y }
      placedTwo.mechanics.positions.hero = { x: provisional.payload.x, y: provisional.payload.y }
      label('auto-post-blocked', placedTwo)
      const auto = attempt(() => applyCommand(placedTwo, { command_type: 'PlaceNpc', command_id: 'place-teren-auto', npc_id: 'teren' }).state)
      if (auto) label('auto-post-placed', auto)
    }
  }
}

// AdvanceScene с NPC новой локации.
attempt(() => rules.resolveCommand({ command_type: 'AdvanceScene', command_id: 'advance-with-npc', scene_args: {
  title: 'Лунная гавань', location: 'Лунная гавань', location_id: 'moon-harbor', mood: 'Холодные фонари над водой', objective: 'Найти капитана', transition: 'Отряд идёт к гавани.',
  arrival: 'В тумане проступают причалы.', hook: 'Жрец ждёт у святилища.', theme: 'harbor', danger: 'низкая', scene_kind: 'settlement', settlement_type: 'town', seed: 'moon-harbor:npc-placement',
  map: { layout: 'streets', width: 9, height: 9, openness: 0.7, water: 0.1, featureCount: 5 } } },
npcState({ npcs: [{ id: 'harbor-priest', name: 'Отец Рем', role: 'жрец', location: 'Лунная гавань', visibility: 'party', available: true }] }), { diceService: dice([]), context: { isAdmin: true } }))

// Площадной урон мирному, смерть и свидетели; бой рядом; ближний промах.
{
  let state = npcState({ combat: true })
  state = attempt(() => applyCommand(state, { command_type: 'PlaceNpc', command_id: 'place-victim', npc_id: 'marta', to: { x: 2, y: 1 } }).state) ?? state
  state = attempt(() => applyCommand(state, { command_type: 'PlaceNpc', command_id: 'place-witness', npc_id: 'bor', to: { x: 4, y: 1 } }).state) ?? state
  label('area-victim', state)
  const area = attempt(() => rules.resolveCommand({ command_type: 'MakeAreaAttack', command_id: 'area-collateral', actor_id: 'hero', item_id: 'bomb', to: { x: 2, y: 1 }, server_authoritative: true }, state,
    { diceService: dice([4, 4, 2]), context: { serverAuthoritativeCombat: true, allowedActorIds: ['hero'] } }))
  if (area) attempt(() => area.events.reduce(rules.applyGameEvent, state))
  const observer = attempt(() => applyCommand(npcState(), { command_type: 'PlaceNpc', command_id: 'place-observer', npc_id: 'marta', to: { x: 2, y: 1 } }).state)
  if (observer) {
    label('observer', observer)
    attempt(() => rules.resolveCommand({ command_type: 'StartCombat', command_id: 'combat-with-observer', server_authoritative: true }, observer, { diceService: dice([10, 10]), context: { isAdmin: true, serverAuthoritativeCombat: true } }))
  }
  let miss = attempt(() => applyCommand(npcState({ combat: true }), { command_type: 'PlaceNpc', command_id: 'place-miss-target', npc_id: 'marta', to: { x: 6, y: 2 } }).state)
  if (miss) {
    miss.players[0] = { ...miss.players[0], x: 5, y: 1 }
    miss.mechanics.positions.hero = { x: 5, y: 1 }
    label('near-miss', miss)
    attempt(() => rules.resolveCommand({ command_type: 'MakeAttack', command_id: 'near-miss', actor_id: 'hero', target_id: 'bandit', attack_modifier: 4, damage_expression: '1d6', damage_type: 'piercing' }, miss,
      { diceService: dice([9, 3]), context: { allowedActorIds: ['hero'] } }))
  }
}

// Паника сорока свидетелей.
{
  const npcs = Array.from({ length: 40 }, (_, index) => ({ id: `npc-${String(index).padStart(2, '0')}`, name: `Свидетель ${index}`, role: 'горожанин', location: 'Рынок', visibility: 'party', available: true }))
  const state = npcState({ npcs })
  state.npc_world = { schema_version: 1, placements: npcs.map((npc, index) => ({ npc_id: npc.id, location_id: 'market', x: 1 + index % 8, y: 1 + Math.floor(index / 8), anchor_prop_id: '', placement_reason: 'test', policy_id: p.NPC_WORLD_POLICY_ID })), vitals: {}, stances: {} }
  label('panic-40', state)
  record('npcCombatStanceEventDrafts', [state, { sourceEventId: 'combat-started:test', participantIds: ['hero', 'bandit'] }])
  record('npcHarmEventDrafts', [state, { npcId: 'npc-10', amount: 10, sourceEventId: 'attack:panic', commandId: 'panic' }])
  record('npcHarmEventDrafts', [state, { npcId: 'npc-19', amount: 1, sourceEventId: 'attack:panic', commandId: 'panic-minor' }])
}

// Публичная площадь NPC.
{
  const state = npcState({ npcs: [{ id: 'marta', name: 'Марта', role: 'трактирщица', location: 'Рынок', visibility: 'party', available: true }] })
  state.npc_world.placements = [{ npc_id: 'marta', location_id: 'market', x: 3, y: 2, footprint: { version: 1, size: 3, cells: [{ x: 99, y: 99 }], internal: 'hidden' } }]
  label('footprint-projection', state)
  attempt(() => campaignStateForViewer(state, { role: 'player' }, 'hero'))
}

// Собеседник по ходу кампании.
for (const [id, location] of [['iara', 'Рынок'], ['dalny', 'Другая деревня']]) {
  const state = npcState({ npcs: [] })
  const resolved = attempt(() => rules.resolveCommand({ command_type: 'UpsertNpcSocialProfile', command_id: `npc-${id}`, npc: { id, name: id === 'iara' ? 'Иара Вейр' : 'Дальний', role: 'хранительница архива', location, public_summary: 'Хранит записи.', voice: 'Тихо.', visibility: 'party', available: true } },
    state, { diceService: dice([]), context: { isAdmin: true, isDirector: true } }))
  if (resolved) attempt(() => p.sceneNpcsForViewer(rules.replayEvents(state, resolved.events)))
}

// Авторский NPC: боевой снимок, мост урона и движения, смерть, нокаут, сдача.
{
  const authored = attempt(() => authoredNpcState())
  if (authored) {
    label('authored', authored)
    record('npcCombatActorFor', [authored, 'marta'])
    const active = rules.normalizeCampaignState({ ...authored, mechanics: { ...authored.mechanics, combat: { ...authored.mechanics.combat, active: true } } })
    label('authored-active', active)
    const ended = rules.normalizeCampaignState({ ...active, mechanics: { ...active.mechanics, combat: { ...active.mechanics.combat, active: false } } })
    label('authored-ended', ended)
    const bridge = (after, events, options) => {
      record('planAuthoredNpcWorldEvents', [authored, after, events, options])
      attempt(() => rules.replayEvents(authored, [...events.filter((event) => event.event_type === 'DamageApplied'), ...p.planAuthoredNpcWorldEvents(authored, after, events, options)]))
    }
    const damage = authoredDamageEvent({ hpBefore: 20, hpAfter: 7 })
    const movedAfter = authoredNpcAfter(authored, { hp: 7, position: { x: 5, y: 2 } })
    label('authored-moved-after', movedAfter)
    bridge(movedAfter, [damage, { event_type: 'ActorMoved', event_id: 'move-authored-marta', command_id: 'cast-authored-marta', actor_id: 'marta', target_ids: ['marta'], payload: { from: { x: 6, y: 2 }, to: { x: 5, y: 2 } } }], { commandId: 'cast-authored-marta', actorId: 'hero' })
    const deadAfter = authoredNpcAfter(authored, { hp: 0, alive: false })
    label('authored-dead-after', deadAfter)
    bridge(deadAfter, [authoredDamageEvent({ hpBefore: 20, hpAfter: 0, eventId: 'damage-authored-death', commandId: 'kill-authored-marta' }), { event_type: 'HitPointsReducedToZero', event_id: 'zero-authored-marta', command_id: 'kill-authored-marta', actor_id: 'hero', target_ids: ['marta'], payload: { condition: 'unconscious' } }], { commandId: 'kill-authored-marta', actorId: 'hero' })
    bridge(authoredNpcAfter(authored, { hp: 1 }), [authoredDamageEvent({ hpBefore: 20, hpAfter: 1, eventId: 'damage-authored-knockout', commandId: 'knockout-authored-marta' }), { event_type: 'CreatureKnockedOut', event_id: 'knockout-authored-marta', command_id: 'knockout-authored-marta', actor_id: 'hero', target_ids: ['marta'], payload: { recovery_minutes: 60 } }], { commandId: 'knockout-authored-marta', actorId: 'hero' })
    const zeroAfter = authoredNpcAfter(authored, { hp: 0, alive: true })
    label('authored-zero-after', zeroAfter)
    bridge(zeroAfter, [authoredDamageEvent({ hpBefore: 20, hpAfter: 0, eventId: 'damage-authored-zero-knockout', commandId: 'zero-knockout-authored-marta' }), { event_type: 'CreatureKnockedOut', event_id: 'zero-knockout-authored-marta', command_id: 'zero-knockout-authored-marta', actor_id: 'hero', target_ids: ['marta'], payload: { recovery_minutes: 60 } }], { commandId: 'zero-knockout-authored-marta', actorId: 'hero' })
    bridge(authoredNpcAfter(authored, { hp: 20, alive: false }), [{ event_type: 'ConditionAdded', event_id: 'surrender-authored-marta', command_id: 'surrender-authored-marta', actor_id: 'hero', target_ids: ['marta'], payload: { condition: 'surrendered' } }], { commandId: 'surrender-authored-marta', actorId: 'hero' })
    // Боевая копия, рождённая в том же коммите.
    const without = rules.normalizeCampaignState({ ...authored, enemies: authored.enemies.filter((actor) => actor.id !== 'marta') })
    const materialized = p.npcCombatActorFor(without, 'marta')
    const materializedAfter = rules.normalizeCampaignState({ ...without, enemies: [...without.enemies, { ...materialized, hp: 7, alive: true }], mechanics: { ...without.mechanics, positions: { ...without.mechanics.positions, marta: { x: 6, y: 2 } } } })
    record('planAuthoredNpcWorldEvents', [without, materializedAfter, [authoredDamageEvent({ hpBefore: 20, hpAfter: 7, commandId: 'materialize-and-harm' })], { commandId: 'materialize-and-harm', actorId: 'hero' }])
    // Варианты моста: без commandId, повтор NpcMoved, урон без hp_after, мусорные события.
    record('planAuthoredNpcWorldEvents', [authored, movedAfter, [damage, { event_type: 'NpcMoved', payload: { npc_id: 'marta' } }], {}])
    record('planAuthoredNpcWorldEvents', [authored, movedAfter, [{ ...damage, payload: { hp_after: 'x' } }], { commandId: 'c' }])
    record('planAuthoredNpcWorldEvents', [authored, movedAfter, 'junk', undefined])
    record('planAuthoredNpcWorldEvents', [authored, movedAfter, [damage, { event_type: 'NpcHarmed', payload: { npc_id: 'marta' } }], { commandId: 'c' }])
    record('planAuthoredNpcWorldEvents', [authored, authoredNpcAfter(authored, { hp: 7 }), [{ ...damage, event_id: undefined, command_id: undefined, payload: { ...damage.payload, trigger: 'area', source_actor_id: 'mage' } }], { commandId: '', actorId: 'hero' }])
    // Большой и огромный авторский NPC: площадь из профиля.
    for (const index of [5, 7]) {
      const npc = getWorldTemplate('astohan-plains').opening.npcs[index]
      const state = npcState({ npcs: [{ id: npc.id, name: npc.name, role: npc.role ?? 'воин', location: 'Рынок', visibility: 'party', available: true }] })
      state.npc_world = { ...state.npc_world, profiles: { [npc.id]: npc.mechanics } }
      label(`authored-${npc.mechanics.size}`, state)
      const placedBig = attempt(() => applyCommand(state, { command_type: 'PlaceNpc', command_id: `place-${npc.id}`, npc_id: npc.id }).state)
      if (placedBig) {
        label(`authored-${npc.mechanics.size}-placed`, placedBig)
        attempt(() => p.npcCombatActorFor(placedBig, npc.id))
        attempt(() => applyCommand(placedBig, { command_type: 'MoveNpc', command_id: `move-${npc.id}`, npc_id: npc.id, to: { x: 1, y: 3 } }))
      }
    }
  }
}

// Временные хиты мирного NPC (волна разрушения).
{
  const state = rules.normalizeCampaignState({
    sessionCode: 'DESTRUCTIVE-WAVE-NPC-TEMP', ruleset_id: 'srd_5_2_1',
    players: [{ id: 'hero', character: 'Герой', hp: 20, maxHp: 20, x: 1, y: 1, inventory: [] }], enemies: [],
    scene: { location: 'market', location_id: 'market', turn: 1, cells: Array.from({ length: 36 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true })) },
    social: { npcs: [{ id: 'villager', name: 'Житель', role: 'житель', location: 'market', visibility: 'party', available: true }] },
    npc_world: { schema_version: 3, placements: [{ npc_id: 'villager', location_id: 'market', x: 2, y: 1, placement_reason: 'destructive-wave-temp-test' }], vitals: { villager: { hp: 100, max_hp: 100, alive: true } }, stances: {}, inventories: {}, profiles: {} },
    mechanics: { temporary_hp: { villager: 10 }, positions: { hero: { x: 1, y: 1 }, villager: { x: 2, y: 1 } } },
  })
  label('temporary-hp', state)
  const harm = (components, before, after) => record('npcHarmEventDrafts', [state, { npcId: 'villager', amount: components.reduce((total, component) => total + component.applied_amount, 0), damageType: 'mixed', damageComponents: components,
    temporaryHpBefore: before, temporaryHpAfter: after, temporaryHpAbsorbed: before - after, sourceEventId: 'spell-cast:wave', sourceActorId: 'hero', trigger: 'area-spell', commandId: 'wave-temp-test' }])
  harm([{ damage_type: 'thunder', raw_amount: 15, applied_amount: 0, temporary_hp_absorbed: 7 }, { damage_type: 'radiant', raw_amount: 5, applied_amount: 0, temporary_hp_absorbed: 3 }], 10, 0)
  harm([{ damage_type: 'thunder', raw_amount: 15, applied_amount: 5, temporary_hp_absorbed: 10 }], 10, 0)
  harm([{ damage_type: 'thunder', raw_amount: 300, applied_amount: 250 }, { damage_type: 'fire', raw_amount: 20, applied_amount: 20 }], 0, 0)
}

// Вещи NPC: передача и выдача из рук; legacy-пределы.
{
  const world = { placements: [], inventories: { marta: Array.from({ length: 101 }, (_, index) => ({ id: `item:${index}`, name: `Предмет ${index}`, type: 'other', quantity: 1 })) } }
  record('normalizeNpcWorldState', [world, undefined])
  record('normalizeNpcWorldStateLegacy', [world])
  withRetentionMode('legacy', () => record('normalizeNpcWorldState', [world, undefined]))
  withRetentionMode('legacy', () => record('applyNpcWorldEvent', [world, { event_type: 'ItemTransferred', payload: { recipient_kind: 'npc', to_actor_id: 'marta', quantity: 2, item: { id: 'new', name: 'Новое' } } }, undefined]))
  record('applyNpcWorldEvent', [world, { event_type: 'ItemTransferred', payload: { recipient_kind: 'npc', to_actor_id: 'marta', quantity: 2, item: { id: 'item:3', name: 'Предмет 3', type: 'other' } } }, undefined])
  record('applyNpcWorldEvent', [world, { event_type: 'ItemTransferred', payload: { recipient_kind: 'npc', to_actor_id: 'marta', quantity: 2, stackable: false, item: { id: 'item:3', name: 'Предмет 3', type: 'other' } } }, undefined])
  record('applyNpcWorldEvent', [world, { event_type: 'ItemGranted', payload: { source_npc_id: 'marta', item: { id: 'item:7' } } }, { isLegacy: true }])
  const big = { vitals: Object.fromEntries(Array.from({ length: 503 }, (_, index) => [`npc:${index}`, { hp: index % 9 }])), stances: Object.fromEntries(Array.from({ length: 502 }, (_, index) => [`npc:${index}`, { stance: 'guarded' }])),
    placements: Array.from({ length: 5_003 }, (_, index) => ({ npc_id: `npc:${index}`, location_id: 'market', x: index % 50, y: Math.floor(index / 50) })),
    profiles: Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`npc:${index}`, mechanicsProfile(`p${index}`)])) }
  for (const options of [undefined, { isLegacy: true }, { retention: 'legacy' }, { isLegacy: false, retention: 'legacy' }]) record('normalizeNpcWorldState', [big, options])
  withRetentionMode('legacy', () => {
    record('normalizeNpcWorldState', [big, undefined])
    record('applyNpcWorldEvent', [big, { event_type: 'NpcPlaced', event_id: 'tail', payload: { npc_id: 'tail', location_id: 'market', x: 1, y: 1 } }, undefined])
  })
  // Мусор старых сохранений.
  for (const junk of [null, undefined, 'world', 5, [], { placements: [null] }, { vitals: { a: null } }, { vitals: [{ hp: 3 }, 'x'] }, { stances: 'ab' }, { profiles: { a: null, b: mechanicsProfile('b'), constructor: mechanicsProfile('c') } },
    { inventories: { a: [{ id: 'x', quantity: 2 }, { id: 'x', quantity: 3 }], ' a ': [{ id: 'y' }], b: [] } }, { placements: [{ npc_id: 'a', location_id: 'm', x: '1', y: '2', footprint: { version: 1, size: 4 } }, { npc_id: 'a', location_id: 'm', x: 5, y: 5 }] }]) {
    record('normalizeNpcWorldState', [junk, undefined])
  }
  for (const npc of [undefined, {}, { role: 'Ветеран' }, { role: 'x', tags: ['hunter'] }, { role: 'лекарь' }, { role: 'Blacksmith' }, { tags: [null, ['guard']] }, { role: 5, tags: 'guard' }, { role: 'KNIGHT' }]) {
    record('initialNpcVital', [npc])
  }
}
stopCapture()
flushCaptured(400)
const afterScenarios = writer.cases.length

// ---------------------------------------------------------------------------
// 2. Корпус паритета: состояния и повтор команд
// ---------------------------------------------------------------------------

const dir = corpusDir(process.argv[2])
let corpusStates = 0
let replayed = 0
if (dir) {
  const seenStates = new Set()
  let records = 0
  const stop = startCapture(capture)
  for (const entry of corpusRecords(dir)) {
    records += 1
    if (seenStates.has(entry.state)) continue
    seenStates.add(entry.state)
    const state = corpusState(dir, entry.state)
    if (!state) continue
    const interesting = (Array.isArray(state.social?.npcs) && state.social.npcs.length) || state.npc_world?.placements?.length
    if (!interesting) continue
    if (corpusStates < 120 && (corpusStates < 50 || chance(0.5))) {
      corpusStates += 1
      stop()
      battery(state, { deep: corpusStates < 80 })
      startCapture(capture)
    }
    if (replayed < 900) {
      replayed += 1
      try {
        const result = rules.resolveCommand(entry.command, state, { diceService: replayDice(entry.dice), context: entry.context ?? {} })
        const after = (entry.outcome?.events ?? result.events ?? []).reduce(rules.applyGameEvent, rules.normalizeCampaignState(state))
        const viewer = after.players?.[0]?.id
        if (viewer) campaignStateForViewer(after, { role: 'player', playerId: viewer }, viewer)
      } catch { /* отказ команды — тоже часть корпуса */ }
    }
  }
  stop()
  console.log(`корпус: записей ${records}, состояний для батареи ${corpusStates}, повторено команд ${replayed}, перехвачено ${captured.length}`)
  flushCaptured(900)
} else {
  console.log('корпус не найден — пропущен')
}
const afterCorpus = writer.cases.length

// ---------------------------------------------------------------------------
// 3. Случайные сцены
// ---------------------------------------------------------------------------

const astohan = getWorldTemplate('astohan-plains').opening.npcs.filter((npc) => npc.mechanics)
for (let index = 0; index < 190; index += 1) {
  const width = int(3, 12)
  const height = int(3, 10)
  const locationId = pick(['market', 'tavern', 'loc-1', 'Market'])
  const location = pick(['Рынок', 'Таверна «Рог»', 'Площадь'])
  const mapKind = random()
  let map
  if (mapKind < 0.8) map = randomMap(t, random, { width, height, locationId: chance(0.8) ? locationId : '', seed: `npc-random:${index}` })
  else if (mapKind < 0.88) map = pick([undefined, null, '', 'map', 5, {}, { width: 3 }])
  else map = t.serializeTacticalMap(openMap({ width, height, locationId }))
  const npcs = Array.from({ length: int(0, 9) }, (_, npcIndex) => randomNpc(random, { location, locationId, index: npcIndex }))
  const authored = []
  if (chance(0.3)) {
    const npc = pick(astohan)
    npcs.push({ id: npc.id, name: npc.name, role: npc.role ?? 'воин', location, visibility: 'party', available: true })
    authored.push([npc.id, npc.mechanics])
  }
  const scene = {
    title: chance(0.9) ? location : '',
    location: chance(0.85) ? location : undefined,
    ...(chance(0.7) ? { location_id: chance(0.9) ? locationId : '' } : {}),
    ...(chance(0.05) ? { locationId } : {}),
    ...(map === undefined ? {} : { map }),
  }
  if (scene.location === undefined) delete scene.location
  if (chance(0.15) && npcs[0]?.name) scene.map_requirements = { version: 'scene-requirements/v3', items: [{ id: pick(['altar', 'platform', 'bar', 'well']), count: 1 }], posts: [{ npc: npcs[0].name, id: pick(['altar', 'platform', 'bar', 'well', 'chest']) }] }
  const players = Array.from({ length: int(0, 3) }, (_, playerIndex) => ({ id: playerIndex === 0 ? 'hero' : `hero-${playerIndex}`, x: int(0, width - 1), y: int(0, height - 1), hp: pick([10, 0, null, '0', 5]), ...(chance(0.1) ? { alive: false } : {}), ...(chance(0.1) ? { footprint: { version: 1, size: 2 } } : {}) }))
  const enemies = Array.from({ length: int(0, 2) }, (_, enemyIndex) => ({ id: chance(0.1) ? 'constructor' : `foe-${enemyIndex}`, x: int(0, width - 1), y: int(0, height - 1), hp: 7, ...(chance(0.15) && npcs[0]?.id ? { origin: { npc_id: String(npcs[0].id) } } : {}) }))
  const state = {
    sessionCode: `RANDOM-${index}`,
    scene,
    social: chance(0.95) ? { npcs } : pick([undefined, { npcs: 'x' }]),
    npc_world: chance(0.9) ? randomNpcWorld(random, { npcs, locationId: scene.location_id || locationId, width, height, authored }) : undefined,
    players,
    enemies,
    ...(chance(0.2) ? { actors: [{ actor_id: 'summon', x: int(0, width - 1), y: int(0, height - 1), hp: 3 }] } : {}),
    ...(chance(0.2) ? { entities: [{ kind: pick(['creature', 'npc', 'prop']), x: int(0, width - 1), y: int(0, height - 1) }] } : {}),
    mechanics: {
      positions: Object.fromEntries([...players, ...enemies].filter(() => chance(0.6)).map((actor) => [actor.id, { x: int(0, width - 1), y: int(0, height - 1) }])),
      ...(chance(0.3) ? { combat: { active: chance(0.7) } } : {}),
      ...(chance(0.3) ? { world_time: { elapsed_minutes: pick([0, 90, 1440, '30', -5]) } } : {}),
    },
    ...(chance(0.2) ? { worldMemory: { entities: [{ id: npcs[0]?.id ?? 'x' }] } } : {}),
    ...(chance(0.2) ? { scene_npcs: [{ id: 'a', x: 1, y: 1, stance: pick(['hostile', 'neutral']) }, { id: 'b', x: 2, y: pick([1, '2', null]), alive: pick([true, false]), footprint: { version: 1, size: 2 } }, null] } : {}),
  }
  if (chance(0.03)) state.mechanics.positions = pick([[{ x: 1, y: 1 }], 'pos', null])
  if (chance(0.1) && state.mechanics.positions && typeof state.mechanics.positions === 'object' && !Array.isArray(state.mechanics.positions)) state.mechanics.positions.constructor = { x: 0, y: 0 }
  if (chance(0.5)) battery(state)
  else withRetentionMode('legacy', () => battery(state, { deep: chance(0.5) }))
}

console.log(`сценарии ${afterScenarios}, корпус ${afterCorpus - afterScenarios}, случайные ${writer.cases.length - afterCorpus}`)
writer.write(new URL('./npc-positioning.json', import.meta.url))
void ASSETS
void PROTOTYPE_KEYS

import '../../../fixtures-env.mjs'
import { startCapture } from './hook.mjs'
// Эталон server/world-deeds.mjs для Rust:
//
//   node rust/crates/sk-world-time/fixtures/gen-world-deeds.mjs [каталог корпуса]
//
// Источники входов:
//
// - тесты модуля и соседей, где летопись пишется изнутри Rules Engine
//   (`world-deeds`, `world-deeds-ui-contract`, пленные, перемирие, карманная
//   кража, взлом, закон, таверна), исполненные в этом же процессе
//   (`node:test`, `isolation: 'none'`): каждый верхний вызов модуля
//   перехватывается хуком;
// - корпус паритета: события записанных команд через `applyGameEvent` и
//   батарея ленты, слухов и репутации на состояниях с летописью;
// - сотни случайных кампаний и цепочек «событие → редьюсер → такт молвы →
//   слух → репутация» с мусором старых сохранений.
//
// Состояния урезаются до полей, которые читает модуль; JS исполняется заново
// на урезанном входе и сверяется с исходом на полном — Rust получает ровно его.
import { run } from 'node:test'
import { fileURLToPath } from 'node:url'

import { fixtureWriter, mulberry32, chooser, viaJson, PROTOTYPE_KEYS } from './common.mjs'
import { corpusDir, corpusRecords, corpusState, pickKeys, mapList, moduleCapture } from './lib.mjs'

const w = await import('../../../../server/world-deeds.mjs')
const rules = await import('../../../../server/rules-engine.mjs')
const { withRetentionMode, retentionMode } = await import('../../../../server/retention-context.mjs')

const writer = fixtureWriter('world-deeds', retentionMode)
const random = mulberry32(2026_10_16)
const { int, pick, chance } = chooser(random)

const STATS = { rumors: 0, reputation: 0, injected: 0 }
const FNS = {
  normalizeWorldDeedsState: { fn: (...args) => w.normalizeWorldDeedsState(...args), states: [], refs: [0] },
  deedFromEvent: { fn: (...args) => w.deedFromEvent(...args), states: [0] },
  applyWorldDeedEvent: { fn: (...args) => w.applyWorldDeedEvent(...args), states: [2], refs: [0] },
  worldDeedsFeed: { fn: (...args) => w.worldDeedsFeed(...args), states: [0] },
  worldNodeIdFor: { fn: (...args) => w.worldNodeIdFor(...args), states: [0] },
  // `Map` в JSON пуст: пишется списком пар в порядке вставки.
  worldHopDistances: { fn: (...args) => [...w.worldHopDistances(...args).entries()], states: [0] },
  rumorClaimId: { fn: (...args) => w.rumorClaimId(...args), states: [] },
  rumorWording: { fn: (...args) => w.rumorWording(...args), states: [] },
  rumorSpreadTargets: { fn: (...args) => w.rumorSpreadTargets(...args), states: [0] },
  planWorldRumorTick: { fn: (...args) => { const out = w.planWorldRumorTick(...args); if (out.targets.length) STATS.rumors += 1; return out }, states: [0] },
  rumorReputationDelta: { fn: (...args) => w.rumorReputationDelta(...args), states: [] },
  planWorldRumorReputation: { fn: (...args) => { const out = w.planWorldRumorReputation(...args); if (out.length) STATS.reputation += 1; return out }, states: [0] },
}

const isPlain = (value) => value && typeof value === 'object' && !Array.isArray(value)
const NPC_KEYS = ['id', 'name', 'location', 'location_id', 'locationId', 'available', 'tags', 'public_summary']
function strict(state) {
  if (!isPlain(state)) return state
  const out = pickKeys(state, ['players', 'partyName', 'captives', 'world_deeds'])
  if (Array.isArray(out.players)) out.players = out.players.map((player) => pickKeys(player, ['id', 'character', 'name']))
  if (state.scene !== undefined) {
    out.scene = isPlain(state.scene) ? pickKeys(state.scene, ['location_id', 'locationId', 'location', 'title']) : state.scene
    if (isPlain(state.scene) && state.scene.map !== undefined) out.scene.map = isPlain(state.scene.map) ? pickKeys(state.scene.map, ['locationId']) : state.scene.map
  }
  if (state.social !== undefined) {
    out.social = isPlain(state.social) ? pickKeys(state.social, ['npcs', 'promises']) : state.social
    if (isPlain(out.social)) {
      if (out.social.npcs !== undefined) out.social.npcs = mapList(out.social.npcs, (npc) => pickKeys(npc, NPC_KEYS))
      if (out.social.promises !== undefined) out.social.promises = mapList(out.social.promises, (entry) => pickKeys(entry, ['id', 'npc_id', 'hero_id']))
    }
  }
  if (state.npc_world !== undefined) out.npc_world = isPlain(state.npc_world) ? pickKeys(state.npc_world, ['vitals']) : state.npc_world
  if (state.mechanics !== undefined) out.mechanics = isPlain(state.mechanics) ? pickKeys(state.mechanics, ['world_time']) : state.mechanics
  if (state.worldMap !== undefined) {
    out.worldMap = isPlain(state.worldMap) ? pickKeys(state.worldMap, ['locations', 'routes']) : state.worldMap
    if (isPlain(out.worldMap)) {
      if (out.worldMap.locations !== undefined) out.worldMap.locations = mapList(out.worldMap.locations, (node) => pickKeys(node, ['id', 'name']))
      if (out.worldMap.routes !== undefined) out.worldMap.routes = mapList(out.worldMap.routes, (route) => pickKeys(route, ['from', 'to']))
    }
  }
  if (state.worldMemory !== undefined) {
    out.worldMemory = isPlain(state.worldMemory) ? pickKeys(state.worldMemory, ['epistemic_claims', 'entities', 'facts']) : state.worldMemory
    if (isPlain(out.worldMemory)) {
      if (out.worldMemory.epistemic_claims !== undefined) out.worldMemory.epistemic_claims = mapList(out.worldMemory.epistemic_claims, (claim) => pickKeys(claim, ['id', 'kind', 'holder_entity_id']))
      for (const key of ['entities', 'facts']) if (out.worldMemory[key] !== undefined) out.worldMemory[key] = mapList(out.worldMemory[key], (entry) => pickKeys(entry, ['id']))
    }
  }
  return out
}
const wide = (state) => (isPlain(state)
  ? pickKeys(state, ['players', 'partyName', 'captives', 'world_deeds', 'scene', 'social', 'npc_world', 'mechanics', 'worldMap', 'worldMemory'])
  : state)

const recorder = moduleCapture({ module: 'server/world-deeds.mjs', fns: FNS, strips: [strict, wide], retentionMode, withRetentionMode, writer, limit: 900 })
const DEED_EVENTS = new Set([
  'NpcDied', 'NpcHarmed', 'SceneObjectOperated', 'DoorForced', 'NpcPromiseResolved', 'ItemTransferred',
  'WitnessConsequencePropagated', 'CaptiveNeglected', 'TruceBroken', 'TavernCheatCaught', 'NpcPickpocketNoticed',
  'MerchantDenouncedThief', 'NpcBribeRefused', 'LockpickNoticed', 'FactionReputationAdjusted',
])
let quiet = 0
function capture(module, name, args) {
  if (module !== 'server/world-deeds.mjs') return
  if (name === 'applyWorldDeedEvent' && !DEED_EVENTS.has(String(args[1]?.event_type ?? ''))) {
    // Чужое событие редьюсер отдаёт как есть: от него остаётся только тип.
    if (quiet >= 200 || !chance(0.03)) return
    quiet += 1
    args = [args[0], { event_type: args[1]?.event_type }, {}]
  }
  if (name === 'normalizeWorldDeedsState' && !(args[0]?.deeds?.length) && !chance(0.02)) return
  recorder.capture(module, name, args)
}

// ---------------------------------------------------------------------------
// 1. Тесты в этом же процессе
// ---------------------------------------------------------------------------

const TEST_FILES = [
  'world-deeds.test.mjs', 'world-deeds-ui-contract.test.mjs', 'npc-world-consequences.test.mjs', 'pickpocket.test.mjs',
  'underworld.test.mjs', 'lockpicking.test.mjs', 'parley.test.mjs', 'captives.test.mjs', 'law-and-order.test.mjs',
  'tavern-life.test.mjs', 'npc-positioning.test.mjs', 'table-situations-doc.test.mjs',
]
const testFile = (name) => fileURLToPath(new URL(`../../../../test/${name}`, import.meta.url))
const stopCapture = startCapture(capture)
let passed = 0
let failed = 0
for await (const event of run({ files: TEST_FILES.map(testFile), isolation: 'none' })) {
  if (event.type === 'test:pass') passed += 1
  if (event.type === 'test:fail') {
    failed += 1
    console.log('упал тест:', event.data?.name)
  }
}
stopCapture()
console.log(`тесты: прошло ${passed}, упало ${failed}`)
recorder.flush(500)
const afterTests = writer.cases.length

// ---------------------------------------------------------------------------
// 2. Батарея и корпус паритета
// ---------------------------------------------------------------------------

const attempt = (fn) => {
  try {
    return fn()
  } catch {
    return null
  }
}
const ODD = [...PROTOTYPE_KEYS.filter((key) => ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'].includes(key)), 'undefined', 'null', '', 'missing']

function battery(state, { cap = Infinity } = {}) {
  const minute = Number(state?.mechanics?.world_time?.elapsed_minutes ?? 0) || 0
  for (const options of [undefined, { limit: pick([1, 3, 500, '2', null, -4]) }].filter((_, index) => index < 1 || chance(0.5))) recorder.record('worldDeedsFeed', [state, options], { cap })
  const minutes = [undefined, minute + pick([0, 360, 720, 1_440, 2_880, 5_000]), pick([0, '900', null, -10, 99_999_999])]
  for (const worldMinute of minutes.filter((_, index) => index < 2 || chance(0.4))) {
    recorder.record('rumorSpreadTargets', [state, worldMinute === undefined ? undefined : { worldMinute }], { cap })
    recorder.record('planWorldRumorTick', [state, { worldMinute, ...(chance(0.3) ? { limit: pick([1, 2, 100, '5', null]) } : {}) }], { cap })
  }
  recorder.record('planWorldRumorReputation', [state], { cap })
  const deeds = attempt(() => w.normalizeWorldDeedsState(state?.world_deeds))?.deeds ?? []
  for (const deed of deeds.slice(0, 2)) {
    recorder.record('worldNodeIdFor', [state, pick([deed.location_id, deed.location_name, ...ODD])], { cap })
    recorder.record('worldHopDistances', [state, deed.location_id], { cap })
  }
}

/** Такт молвы как у сервера: команды памяти мира, затем репутация. */
function tickWorld(state, worldMinute) {
  const plan = attempt(() => w.planWorldRumorTick(viaJson(state), { worldMinute }))
  if (!plan) return state
  let next = state
  for (const command of plan.commands) {
    const result = attempt(() => rules.resolveCommand({ ...command, actor_id: 'system', command_id: `tick-${worldMinute}-${int(0, 1e9)}` }, next, { context: { isAdmin: true } }))
    for (const event of result?.events ?? []) next = attempt(() => rules.applyGameEvent(next, event)) ?? next
  }
  // Если движок команду памяти не принял, слух кладётся в память напрямую:
  // репутации нужен держатель, а не путь, которым слух туда попал.
  const known = new Set((next.worldMemory?.epistemic_claims ?? []).map((claim) => claim?.id))
  const missing = plan.targets.filter((target) => !known.has(target.claim_id))
  if (missing.length) {
    STATS.injected += missing.length
    next = { ...next, worldMemory: { ...(next.worldMemory ?? {}), epistemic_claims: [...(next.worldMemory?.epistemic_claims ?? []), ...missing.map((target) => ({ id: target.claim_id, kind: 'rumor', holder_entity_id: target.npc_id, claim: target.claim }))] } }
  }
  recorder.record('planWorldRumorReputation', [next], { cap: 1_500 })
  for (const event of attempt(() => w.planWorldRumorReputation(viaJson(next))) ?? []) {
    next = attempt(() => rules.applyGameEvent(next, { ...event, event_id: `rep-${int(0, 1e9)}` })) ?? next
  }
  return next
}

const dir = process.env.SK_QUICK ? null : corpusDir(process.argv[2])
if (dir) {
  let records = 0
  let applied = 0
  let batteries = 0
  const seen = new Set()
  for (const entry of corpusRecords(dir)) {
    records += 1
    const events = entry.outcome?.events ?? []
    const relevant = events.some((event) => DEED_EVENTS.has(String(event?.event_type ?? '')))
    if (!relevant && !chance(0.002)) continue
    if (applied >= 600) break
    const state = corpusState(dir, entry.state)
    if (!state) continue
    applied += 1
    const stop = startCapture(capture)
    let after = attempt(() => rules.normalizeCampaignState(state))
    for (const event of events) after = attempt(() => rules.applyGameEvent(after, event)) ?? after
    stop()
    recorder.flush(400)
    if (after?.world_deeds?.deeds?.length && !seen.has(entry.state) && batteries < 8) {
      seen.add(entry.state)
      batteries += 1
      battery(after, { cap: 3_000 })
    }
  }
  console.log(`корпус: записей ${records}, применено ${applied}, батарей ${batteries}`)
} else {
  console.log('корпус пропущен')
}
const afterCorpus = writer.cases.length

// ---------------------------------------------------------------------------
// 3. Случайные кампании и цепочки событий
// ---------------------------------------------------------------------------

const PLACES = [
  { id: 'village', name: 'Тихий Брод' }, { id: 'mill', name: 'Мельница' }, { id: 'capital', name: 'Столица' },
  { id: 'edge', name: 'Край света' }, { id: 'swamp', name: 'Гнилая Топь' },
]
const NPCS = ['guard', 'baker', 'miller', 'clerk', 'hermit', 'gossip', 'smith', 'merchant', 'leader']
const FACTIONS = ['brod-watch', 'brod-guild', 'mill-folk', 'crown', 'wilds-folk']
const NAMES = ['Страж Бран', 'Пекарь Мила', 'Мельник Ждан', 'Писец Ольд', 'Отшельник', 'Кумушка Веся', 'Кузнец Гор', 'Торговец $& Лис', 'Атаман']

function randomWorldMap() {
  if (chance(0.05)) return pick([null, 'map', { locations: 'x' }])
  const locations = PLACES.filter(() => chance(0.85)).map((place) => (chance(0.05) ? pick([null, { name: place.name }, { id: 7, name: 'Семь' }]) : { ...place, ...(chance(0.1) ? { name: place.name.toUpperCase() } : {}) }))
  const routes = []
  for (let index = 0; index + 1 < PLACES.length; index += 1) if (chance(0.8)) routes.push({ from: PLACES[index].id, to: PLACES[index + 1].id })
  if (chance(0.3)) routes.push({ from: pick(PLACES).id, to: pick(PLACES).id })
  if (chance(0.1)) routes.push(pick([null, { from: 'village' }, { from: ' mill ', to: 'swamp' }, 'route']))
  return { locations, routes }
}

function randomNpc(id, index) {
  if (chance(0.03)) return pick([null, 'npc', { id }, { name: 'Безымянный' }])
  const place = pick(PLACES)
  return {
    id: chance(0.03) ? pick([...ODD, 5]) : id,
    name: chance(0.03) ? pick(['', null]) : NAMES[index % NAMES.length],
    location: pick([place.name, place.id, place.name, '', undefined, 'Нигде', '  тихий  брод ']),
    ...(chance(0.2) ? { location_id: pick([place.id, 'nowhere']) } : {}),
    ...(chance(0.1) ? { available: pick([false, true, 'no']) } : {}),
    public_summary: `${NAMES[index % NAMES.length]} живёт тут.`,
    tags: pick([[`faction:${pick(FACTIONS)}`], [`faction:${pick(FACTIONS)}`, `faction:${pick(FACTIONS)}`], [], ['faction:'], 'faction:crown', [`faction:${pick(ODD)}`]]),
  }
}

function randomCampaign() {
  const sceneName = pick(PLACES)
  const npcs = NPCS.map(randomNpc).filter(() => chance(0.85))
  const vitals = Object.fromEntries(NPCS.filter(() => chance(0.25)).map((id) => [id, pick([{ hp: 0, max_hp: 4, alive: false }, { hp: 3, max_hp: 4, alive: true }, { hp: 0, max_hp: 4 }, 'dead'])]))
  return {
    sessionCode: 'DEEDS', campaign: 'Свидетели', activePlayerId: 'hero', partyMemberIds: ['hero', 'hero-2'],
    ...(chance(0.7) ? { partyName: pick(['Отряд героев', '', '  Вольные  ']) } : {}),
    scene: chance(0.04) ? pick([null, 'scene']) : {
      title: pick(['Площадь', 'Двор', '']),
      ...(chance(0.85) ? { location: pick([sceneName.name, sceneName.id, '']) } : {}),
      ...(chance(0.6) ? { location_id: pick([sceneName.id, '', 'unknown']) } : {}),
      cells: [],
    },
    players: pick([[{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, inventory: [] }, { id: 'hero-2', name: 'Борис', hp: 8, maxHp: 8, inventory: [] }], [{ id: 'hero', character: '', name: 'Ада Вторая', hp: 5, maxHp: 5, inventory: [] }], []]),
    worldMap: randomWorldMap(),
    social: {
      npcs,
      promises: chance(0.6) ? [
        { id: 'promise-1', npc_id: pick(NPCS), hero_id: pick(['hero', 'hero-2', undefined]), text: 'Вернуть долг', status: 'open' },
        ...(chance(0.3) ? [{ id: 'promise-2', hero_id: 'hero' }, pick([null, 'promise'])] : []),
      ] : [],
    },
    ...(Object.keys(vitals).length ? { npc_world: { vitals } } : {}),
    ...(chance(0.2) ? { captives: { captives: [{ id: 'captive:1', npc_id: pick(NPCS), name: 'Пленник', status: pick(['held', 'released']), actor_id: 'foe-1' }] } } : {}),
    mechanics: { world_time: pick([{ elapsed_minutes: int(0, 5_000) }, { elapsed_minutes: '120' }, {}, { elapsed_minutes: -50 }]) },
  }
}

const actor = () => pick(['hero', 'hero', 'hero-2', undefined, '', 0, 'stranger'])
function randomEvent(index) {
  const npcId = pick([...NPCS, '', undefined])
  const type = pick([...DEED_EVENTS, 'DoorForced', 'SceneObjectOperated', 'NpcHarmed', 'Unrelated'])
  const base = { event_id: chance(0.9) ? `evt-${index}` : pick([undefined, '', 'bad id']), command_id: chance(0.8) ? `cmd-${index >> 1}` : undefined, event_type: type, actor_id: actor(), visibility: 'party' }
  const payloads = {
    NpcDied: () => ({ npc_id: npcId, ...(chance(0.7) ? { npc_name: pick(NAMES) } : {}), source_actor_id: actor() }),
    NpcHarmed: () => ({ npc_id: npcId, npc_name: pick([...NAMES, '']), hp_after: pick([0, 1, 3, '2', -1, undefined]), source_actor_id: actor() }),
    SceneObjectOperated: () => ({ prop_id: pick(['prop-1', 'prop-2', '']), kind: pick(['container', 'corpse', 'relic', 'campfire', 'lore', 'furnishing', 'barrel', ...ODD]), intent: pick(['ignite', 'topple', 'take', 'inspect', undefined]) }),
    DoorForced: () => ({ door_id: pick(['door-1', '']), success: pick([true, true, false, 'true']) }),
    NpcPromiseResolved: () => ({ promise_id: pick(['promise-1', 'promise-2', 'missing', undefined]), status: pick(['broken', 'fulfilled', 'open']) }),
    ItemTransferred: () => ({ recipient_kind: pick(['npc', 'npc', 'player']), item_id: pick(['item-1', 'item-2']), item: pick([{ name: 'Золотое кольцо', base_price_cp: pick([100, 500, 1_000, '600', -5]) }, { base_price_cp: 250 }, null, 'item']), quantity: pick([1, 2, 3, '4', 0, undefined]), from_actor_id: actor(), to_actor_id: npcId }),
    WitnessConsequencePropagated: () => ({ outcome: pick(['helpful', 'helpful', 'hostile']), source_event_id: `evt-src-${index}`, witness_ids: pick([[npcId], [npcId, 'baker', npcId], [], 'guard', [null, ' ', 'smith']]) }),
    CaptiveNeglected: () => ({ captive_id: pick(['captive:1', 'captive:2']), captive_name: pick(['Пленник', '', undefined]), npc_id: npcId, hero_id: actor() }),
    TruceBroken: () => ({ broken_by: pick(['party', 'party', 'enemy']), leader_id: pick(['leader', '', undefined]), leader_name: pick(['Атаман', '']), actor_id: actor() }),
    TavernCheatCaught: () => ({ npc_id: npcId, npc_name: pick(['Игрок Сом', '']), hero_id: actor() }),
    NpcPickpocketNoticed: () => ({ npc_id: npcId, npc_name: pick(['Прохожий', '']), hero_id: actor() }),
    MerchantDenouncedThief: () => ({ merchant_id: pick(['merchant', '']), item_name: pick(['Кошель', '']), hero_id: actor() }),
    NpcBribeRefused: () => ({ npc_id: npcId, hero_id: actor() }),
    LockpickNoticed: () => ({ target_id: pick(['chest-1', 'door-2']), target_label: pick(['Сундук', '']), severity: pick(['major', 'minor', 'grave']), witness_ids: pick([[npcId], ['baker', 'smith'], [], ['  gossip ']]), hero_id: actor() }),
    FactionReputationAdjusted: () => ({ faction_id: pick(FACTIONS), deed_id: 'placeholder', delta: -2, provenance: { source: 'server-rumor-policy', policy: pick([w.WORLD_RUMOR_POLICY_ID, 'other']) } }),
    Unrelated: () => ({}),
  }
  const payload = chance(0.03) ? pick([null, 'payload', 5]) : payloads[type]()
  return { ...base, payload }
}

function randomDeed(index) {
  if (chance(0.04)) return pick(['deed', 5, [], { id: 'deed:x' }])
  const kind = chance(0.08) ? pick([...ODD, 'heroism', ' murder ']) : pick(Object.keys(w.DEED_KINDS))
  return {
    id: chance(0.06) ? pick([':bad', 'deed x', '', ...ODD, `deed:dup`]) : `deed:${index}`,
    kind,
    ...(chance(0.7) ? { alignment: pick(['dark', 'bright', 'grey', ['bright']]) } : {}),
    ...(chance(0.7) ? { severity: pick(['grave', 'major', 'minor', 'tiny', ['major'], ...ODD]) } : {}),
    actor_ids: pick([['hero'], ['hero', 'hero', ' hero-2 '], [], 'hero', [null, 5, 'hero']]),
    actor_names: pick([['Ада'], ['Ада', 'Борис'], [], ['$& и $$'], 'Ада', [['Ада', null], 7]]),
    subject: pick(['Страж Бран', '', 'чужие   пожитки', 42, ['кольцо']]),
    location_id: pick([...PLACES.map((place) => place.id), '', 'nowhere']),
    location_name: pick([...PLACES.map((place) => place.name), '', '{who} и {what}']),
    at_minutes: pick([0, int(0, 3_000), '400', -20, 2.5, 9_007_199_254_740_991, undefined]),
    witness_ids: pick([[], [pick(NPCS)], [pick(NPCS), pick(NPCS), pick(NPCS)], 'guard', Array.from({ length: 50 }, (_, i) => `npc-${i}`)]),
    ...(chance(0.5) ? { spread_at_minutes: pick([0, int(0, 6_000), '800', -1, 9_007_199_254_740_991]) } : {}),
    ...(chance(0.4) ? { reputation_faction_ids: pick([[pick(FACTIONS)], [], 'crown', [pick(FACTIONS), pick(FACTIONS)]]) } : {}),
    ...(chance(0.4) ? { source_event_ids: pick([['evt-1'], [], ['evt-1', 'evt-1', 'evt-2']]) } : {}),
    ...(chance(0.3) ? { summary: pick(['Сводка', '']) } : {}),
    ...(chance(0.1) ? { secret: pick([true, false]) } : {}),
  }
}

for (let index = 0; index < Number(process.env.SK_ITER ?? 60); index += 1) {
  // Мусор летописи и прямые вызовы.
  const deeds = Array.from({ length: int(0, 6) }, (_, deedIndex) => randomDeed(deedIndex))
  const ledger = pick([{ deeds }, { schema_version: 1, deeds }, { schema_version: '1', deeds }, deeds, null, undefined, { deeds: 'x' }])
  recorder.record('normalizeWorldDeedsState', [ledger], { cap: 1_500 })
  for (const deed of deeds.slice(0, 3)) {
    recorder.record('rumorWording', [deed, pick([0, 1, 2, 3, -1, '1', undefined, null, 1.5])], { cap: 2_000 })
    recorder.record('rumorReputationDelta', [deed, pick([0, 1, 2, 5, '2', undefined])], { cap: 1_500 })
    recorder.record('rumorClaimId', [deed, pick([...NPCS, undefined, null, 5])], { cap: 600 })
  }

  let state = attempt(() => rules.normalizeCampaignState(randomCampaign()))
  if (!state) continue
  if (chance(0.3)) state = { ...state, world_deeds: ledger }
  for (const value of [state.scene?.location, pick(PLACES).name, pick(PLACES).id, pick(ODD), '  СТОЛИЦА ']) {
    if (chance(0.5)) recorder.record('worldNodeIdFor', [state, value], { cap: 2_000 })
  }
  recorder.record('worldHopDistances', [state, pick([...PLACES.map((place) => place.id), '', undefined, 7])], { cap: 2_000 })

  // Цепочка: события → редьюсер летописи → такт молвы → репутация.
  let minute = Number(state.mechanics?.world_time?.elapsed_minutes ?? 0) || 0
  for (let step = int(3, 9); step > 0; step -= 1) {
    const event = randomEvent(index * 100 + step)
    if (event.event_type === 'FactionReputationAdjusted' && isPlain(event.payload)) {
      const existing = attempt(() => w.normalizeWorldDeedsState(state.world_deeds))?.deeds ?? []
      event.payload.deed_id = pick([existing[0]?.id ?? 'deed:none', 'deed:none', ''])
    }
    recorder.record('deedFromEvent', [state, event], { cap: 4_000 })
    recorder.record('applyWorldDeedEvent', [state.world_deeds, event, state], { cap: 5_000 })
    state = attempt(() => rules.applyGameEvent(state, event)) ?? { ...state, world_deeds: attempt(() => w.applyWorldDeedEvent(viaJson(state.world_deeds), viaJson(event), viaJson(state))) ?? state.world_deeds }
    if (chance(0.5)) {
      minute += pick([60, 360, 720, 1_440, 2_880])
      state = { ...state, mechanics: { ...state.mechanics, world_time: { ...(state.mechanics?.world_time ?? {}), elapsed_minutes: minute } } }
      battery(state, { cap: 4_000 })
      state = tickWorld(state, minute) ?? state
    }
  }
  minute += 3_000
  state = { ...state, mechanics: { ...state.mechanics, world_time: { ...(state.mechanics?.world_time ?? {}), elapsed_minutes: minute } } }
  battery(state, { cap: 4_000 })
  state = tickWorld(state, minute)
  battery(state, { cap: 4_000 })
}

writer.write(new URL('./world-deeds.json', import.meta.url))
console.log(`тесты ${afterTests}, корпус ${afterCorpus - afterTests}, случайные ${writer.cases.length - afterCorpus}`)
console.log('урезание:', recorder.stats, 'исходы (с повторами урезания):', STATS)

import '../../../fixtures-env.mjs'
import { startCapture } from './hook.mjs'
// Эталон server/captives.mjs для Rust:
//
//   node rust/crates/sk-world-life/fixtures/gen-captives.mjs [каталог корпуса]
//
// Источники входов:
//
// - сценарии `test/captives.test.mjs` через настоящий Rules Engine
//   (`resolveCommands`, `applyGameEvent`, `replayEvents`, проекция) — каждый
//   верхний вызов модуля изнутри конвейера перехватывается хуком;
// - корпус паритета: состояния кампаний (`tmp/corpus-v1/states`) и повтор
//   записанных команд с теми же костями под тем же перехватом;
// - сотни случайных пленных, врагов и цепочек событий с мусором старых
//   сохранений (`null` в коллекциях, ключи прототипа как id, строки вместо чисел).
//
// Состояния урезаются до полей, которые читает модуль; JS исполняется заново
// на урезанном входе и сверяется с исходом на полном — Rust получает ровно его.
import { fixtureWriter, mulberry32, chooser, viaJson, PROTOTYPE_KEYS } from './common.mjs'
import { corpusDir, corpusRecords, corpusState, replayDice, pickKeys, mapList, moduleCapture } from './lib.mjs'

const c = await import('../../../../server/captives.mjs')
const rules = await import('../../../../server/rules-engine.mjs')
const { DiceService, SequenceDiceRng } = await import('../../../../server/dice-service.mjs')
const { withRetentionMode, retentionMode } = await import('../../../../server/retention-context.mjs')
const { campaignStateForViewer, mechanicsForViewer } = await import('../../../../server/viewer-projection.mjs')

const writer = fixtureWriter('captives', retentionMode)
const random = mulberry32(2026_10_15)
const { int, pick, chance } = chooser(random)

// ---------------------------------------------------------------------------
// Таблица функций и урезание состояния
// ---------------------------------------------------------------------------

const FNS = {
  captiveBandId: { fn: (...args) => c.captiveBandId(...args), states: [] },
  captivePersona: { fn: (...args) => c.captivePersona(...args), states: [0], refs: [1] },
  normalizeCaptivesState: { fn: (...args) => c.normalizeCaptivesState(...args), states: [], refs: [0] },
  captiveList: { fn: (...args) => c.captiveList(...args), states: [0] },
  captiveFor: { fn: (...args) => c.captiveFor(...args), states: [0] },
  heldCaptiveForNpc: { fn: (...args) => c.heldCaptiveForNpc(...args), states: [0] },
  heldCaptives: { fn: (...args) => c.heldCaptives(...args), states: [0] },
  captiveIdFor: { fn: (...args) => c.captiveIdFor(...args), states: [0] },
  captiveOriginFor: { fn: (...args) => c.captiveOriginFor(...args), states: [0], refs: [1] },
  capturableEnemies: { fn: (...args) => c.capturableEnemies(...args), states: [0] },
  captiveKnowledgeDrafts: { fn: (...args) => c.captiveKnowledgeDrafts(...args), states: [0], refs: [1] },
  planCaptureDrafts: { fn: (...args) => c.planCaptureDrafts(...args), states: [0] },
  planCaptiveRelocationDrafts: { fn: (...args) => c.planCaptiveRelocationDrafts(...args), states: [0] },
  captiveInterrogationPolicy: { fn: (...args) => c.captiveInterrogationPolicy(...args), states: [0], refs: [1] },
  captiveSparedDisposition: { fn: (...args) => c.captiveSparedDisposition(...args), states: [], refs: [0] },
  captiveBountyCp: { fn: (...args) => c.captiveBountyCp(...args), states: [], refs: [0] },
  captiveSettlementFor: { fn: (...args) => c.captiveSettlementFor(...args), states: [0] },
  localFactionIds: { fn: (...args) => c.localFactionIds(...args), states: [0] },
  planCaptiveNeglectCommands: { fn: (...args) => c.planCaptiveNeglectCommands(...args), states: [0] },
  captiveNeglectedPayload: { fn: (...args) => c.captiveNeglectedPayload(...args), states: [], refs: [0] },
  planCaptiveNeglectDrafts: { fn: (...args) => c.planCaptiveNeglectDrafts(...args), states: [0] },
  captiveForViewer: { fn: (...args) => c.captiveForViewer(...args), states: [], refs: [0] },
  captivesForViewer: { fn: (...args) => c.captivesForViewer(...args), states: [0] },
  applyCaptiveEvent: { fn: (...args) => c.applyCaptiveEvent(...args), states: [2], refs: [0] },
}

const NPC_KEYS = ['id', 'name', 'role', 'tags', 'location', 'location_id', 'locationId', 'available', 'visibility', 'reveal_on_presence', 'public_summary', 'post_assets', 'post_terrain', 'faction_id', 'schedule']
const ACTOR_KEYS = ['id', 'actor_id', 'name', 'x', 'y', 'hp', 'maxHp', 'alive', 'footprint', 'origin', 'size', 'creature_type', 'creatureType', 'monster_type', 'kind', 'stat_block_id', 'provenance', 'captive']

const slimActor = (actor) => (actor && typeof actor === 'object' && actor.provenance && typeof actor.provenance === 'object' && !Array.isArray(actor.provenance) ? { ...actor, provenance: pickKeys(actor.provenance, ['xp']) } : actor)

function strictStrip(state, name) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  if (name === 'applyCaptiveEvent') {
    return state.mechanics && typeof state.mechanics === 'object' ? { mechanics: pickKeys(state.mechanics, ['world_time']) } : pickKeys(state, ['mechanics'])
  }
  const out = pickKeys(state, ['sessionCode', 'captives', 'npc_world', 'scene_npcs'])
  if (state.scene !== undefined) out.scene = pickKeys(state.scene, ['title', 'location', 'location_id', 'locationId', 'map', 'map_requirements', 'grid', 'cells', 'width', 'height'])
  if (state.social !== undefined) {
    out.social = state.social && typeof state.social === 'object' && !Array.isArray(state.social)
      ? { npcs: mapList(state.social.npcs, (npc) => pickKeys(npc, NPC_KEYS)) }
      : state.social
  }
  for (const key of ['players', 'enemies', 'actors']) if (state[key] !== undefined) out[key] = mapList(state[key], (actor) => slimActor(pickKeys(actor, key === 'enemies' ? ACTOR_KEYS : ['id', 'actor_id', 'x', 'y', 'hp', 'alive', 'footprint', 'size'])))
  if (state.entities !== undefined) out.entities = state.entities
  if (state.mechanics && typeof state.mechanics === 'object') {
    out.mechanics = pickKeys(state.mechanics, ['conditions', 'resting', 'positions', 'world_time'])
    if (state.mechanics.combat !== undefined) out.mechanics.combat = state.mechanics.combat && typeof state.mechanics.combat === 'object' ? { active: state.mechanics.combat.active } : state.mechanics.combat
  } else if (state.mechanics !== undefined) out.mechanics = state.mechanics
  if (state.worldMemory && typeof state.worldMemory === 'object') {
    out.worldMemory = {
      facts: Array.isArray(state.worldMemory.facts) ? state.worldMemory.facts.filter((fact) => fact?.status === 'active' && fact?.visibility === 'gm_only').map((fact) => pickKeys(fact, ['id', 'status', 'visibility', 'summary', 'object'])) : state.worldMemory.facts,
      entities: mapList(state.worldMemory.entities, (entity) => pickKeys(entity, ['id'])),
    }
  } else if (state.worldMemory !== undefined) out.worldMemory = state.worldMemory
  if (state.worldMap && typeof state.worldMap === 'object') out.worldMap = { locations: mapList(state.worldMap.locations, (node) => pickKeys(node, ['id', 'name', 'kind'])) }
  else if (state.worldMap !== undefined) out.worldMap = state.worldMap
  return out
}

// Без карты сцены: она нужна только посту пленного, а весит сотни килобайт.
function mapless(state, name) {
  const out = strictStrip(state, name)
  if (out && typeof out === 'object' && out.scene && typeof out.scene === 'object') out.scene = pickKeys(out.scene, ['title', 'location', 'location_id', 'locationId'])
  return out
}

// Поля состояния, которые читает каждая функция; прочие — только через
// проверку исхода (если его не хватит, берётся урезание пошире).
const READS = {
  captiveList: ['captives'], captiveFor: ['captives'], heldCaptives: ['captives'], heldCaptiveForNpc: ['captives'],
  planCaptiveNeglectCommands: ['captives', 'mechanics'], planCaptiveNeglectDrafts: ['captives', 'mechanics'], captivesForViewer: ['captives'],
  captiveIdFor: ['sessionCode'], captivePersona: ['sessionCode'], captiveOriginFor: ['mechanics'], captiveInterrogationPolicy: [],
  captiveSettlementFor: ['scene', 'worldMap'], captiveKnowledgeDrafts: ['worldMemory'],
  localFactionIds: ['captives', 'scene', 'social', 'npc_world', 'mechanics', 'players', 'enemies', 'actors', 'entities', 'scene_npcs'],
  planCaptiveRelocationDrafts: ['captives', 'scene', 'social', 'npc_world'],
}
function minimal(state, name) {
  const out = mapless(state, name)
  if (!READS[name] || !out || typeof out !== 'object' || Array.isArray(out)) return out
  const result = pickKeys(out, READS[name])
  if (result.mechanics && typeof result.mechanics === 'object' && name !== 'localFactionIds') {
    result.mechanics = pickKeys(result.mechanics, name === 'captiveOriginFor' ? ['conditions', 'resting'] : ['world_time'])
  }
  return result
}

function wideStrip(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  return pickKeys(state, ['sessionCode', 'captives', 'npc_world', 'scene_npcs', 'scene', 'social', 'players', 'enemies', 'actors', 'entities', 'mechanics', 'worldMemory', 'worldMap'])
}

const CAPTIVE_EVENTS = new Set(['CaptiveTaken', 'NpcDied', 'CaptiveMoved', 'CaptiveInterrogated', 'CaptiveFed', 'CaptiveNeglected', 'CaptiveReleased', 'CaptiveHandedOver', 'CaptiveExecuted'])
const recorder = moduleCapture({ module: 'server/captives.mjs', fns: FNS, strips: [minimal, mapless, strictStrip, wideStrip], retentionMode, withRetentionMode, writer, limit: 1_200 })
let quietEvents = 0
function capture(module, name, args) {
  if (name === 'applyCaptiveEvent' && !CAPTIVE_EVENTS.has(String(args[1]?.event_type ?? ''))) {
    // Прочие события реестр не трогают; хватит нескольких сотен.
    if (quietEvents >= 300 || !chance(0.05)) return
    quietEvents += 1
  }
  if (name === 'normalizeCaptivesState' && !(args[0]?.captives?.length) && !chance(0.02)) return
  recorder.capture(module, name, args)
}

// ---------------------------------------------------------------------------
// 1. Сценарии test/captives.test.mjs через Rules Engine
// ---------------------------------------------------------------------------

const VILLAGE = 'Тихий Брод'
const dice = (values = []) => new DiceService({ rng: new SequenceDiceRng(values) })
function cells(width = 6, height = 6) {
  const grid = []
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) grid.push({ x, y, type: 'floor', passable: true, revealed: true })
  return grid
}
function bandit(id, overrides = {}) {
  return { id, name: `Бандит ${id.slice(-1)}`, hp: 0, maxHp: 11, armor: 12, creature_type: 'humanoid', stat_block_id: 'srd_5_2_1:bandit', provenance: { xp: 25 }, x: 4, y: 1, alive: false, ...overrides }
}
function villager(id, name, faction = 'brod-watch') {
  return { id, name, role: 'житель', location: VILLAGE, visibility: 'party', public_summary: `${name} живёт в «${VILLAGE}».`, tags: [`faction:${faction}`] }
}
function campaign({ minutes = 0, npcs = [], sceneKind = 'village', currency, enemies, conditions, resting, facts, sessionCode = 'CAPTIVE', location = VILLAGE } = {}) {
  return rules.normalizeCampaignState({
    sessionCode,
    campaign: 'Пленные и пощада',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    partyName: 'Отряд героев',
    scene: { title: 'Околица', location, location_id: 'village', grid: { width: 6, height: 6 }, cells: cells() },
    players: [{
      id: 'hero', character: 'Ада', hp: 12, maxHp: 12, x: 1, y: 1,
      abilities: { str: 10, dex: 12, con: 12, int: 10, wis: 12, cha: 16 }, proficiency: 2,
      backgroundSkillProficiencies: ['intimidation'], inventory: [], ...(currency ? { currency } : {}),
    }],
    worldMap: { seed: 'captive-seed', locations: [{ id: 'village', name: VILLAGE, kind: sceneKind, x: 100, y: 100 }], routes: [] },
    enemies: enemies ?? [
      bandit('enemy-surrendered', { x: 4, y: 1 }),
      bandit('enemy-knocked', { x: 4, y: 3 }),
      { id: 'enemy-wolf', name: 'Волк 1', hp: 0, maxHp: 11, creature_type: 'beast', stat_block_id: 'srd_5_2_1:wolf', x: 2, y: 4, alive: false },
    ],
    social: { npcs },
    ...(facts ? { worldMemory: { facts, entities: [] } } : {}),
    mechanics: {
      world_time: { elapsed_minutes: minutes },
      combat: { active: true, round: 3, initiative: [{ actor_id: 'hero', total: 18 }], active_index: 0, action_economy: {} },
      conditions: conditions ?? { 'enemy-surrendered': [{ id: 'surrendered' }], 'enemy-knocked': [{ id: 'unconscious' }], 'enemy-wolf': [{ id: 'surrendered' }] },
      resting: resting ?? { 'enemy-knocked': { kind: 'short', reason: 'knockout', recovery_minutes_remaining: 60 } },
    },
  })
}
const attempt = (fn) => {
  try {
    return fn()
  } catch {
    return null
  }
}
const run = (commands, state, context = { allowedActorIds: ['hero'] }, values = []) => attempt(() => rules.resolveCommands(commands, state, { diceService: dice(values), context }))
const endCombat = (state) => run([{ command_type: 'EndCombat', actor_id: 'hero', reason: 'enemies_defeated', command_id: 'cmd-end-combat', campaign_id: 'CAPTIVE' }], state)
const held = (state, actorId = 'enemy-surrendered') => c.heldCaptives(state).find((captive) => captive.actor_id === actorId)
const command = (type, state, extra = {}, actorId = 'enemy-surrendered') => ({ command_type: type, actor_id: 'hero', captive_id: held(state, actorId)?.id ?? 'captive:none', command_id: `cmd-${type}-${int(0, 1e6)}`, campaign_id: 'CAPTIVE', ...extra })

const scenarioStates = []
function scenario(options = {}, { deep = true } = {}) {
  const base = campaign(options)
  const ended = endCombat(base)
  if (!ended) return
  const state = ended.state
  scenarioStates.push(base, state)
  rules.replayEvents(base, ended.events)
  campaignStateForViewer(state, { role: 'player' }, 'hero')
  campaignStateForViewer(state, { role: 'admin' }, 'hero')
  mechanicsForViewer(ended.events, { role: 'player', heroIds: ['hero'] }, 'hero', state)
  if (!deep) return
  for (const roll of [19, 1, 10]) {
    for (const skill of ['intimidation', 'persuasion']) {
      const told = run([command('InterrogateCaptive', state, { skill })], state, undefined, [roll])
      if (told) {
        rules.replayEvents(base, [...ended.events, ...told.events])
        run([command('InterrogateCaptive', told.state, { skill })], told.state, undefined, [roll])
        campaignStateForViewer(told.state, { role: 'player' }, 'hero')
      }
    }
  }
  for (const type of ['ReleaseCaptive', 'HandCaptiveToGuards', 'FeedCaptive', 'ExecuteCaptive']) {
    for (const actorId of ['enemy-surrendered', 'enemy-knocked']) {
      const result = run([command(type, state, {}, actorId)], state)
      if (result) {
        rules.replayEvents(base, [...ended.events, ...result.events])
        run([command('HandCaptiveToGuards', result.state, {}, actorId)], result.state)
        c.capturableEnemies(result.state)
        c.planCaptureDrafts(result.state)
      }
    }
  }
  const hungry = rules.applyGameEvent(state, { event_type: 'TimeAdvanced', payload: { amount: 24, unit: 'hour', elapsed_minutes: c.CAPTIVE_FEED_INTERVAL_MINUTES }, target_ids: [], visibility: 'party' })
  run([command('NeglectCaptive', hungry)], hungry, { isDirector: true })
  run([command('NeglectCaptive', hungry)], hungry)
  const fed = run([command('FeedCaptive', hungry)], hungry)
  if (fed) c.planCaptiveNeglectCommands(fed.state, { worldMinute: c.CAPTIVE_FEED_INTERVAL_MINUTES })
  const advance = (from, minutes, id) => run([{ command_type: 'AdvanceTime', actor_id: 'hero', amount: minutes, unit: 'minute', command_id: id, campaign_id: 'CAPTIVE' }], from, { isAdmin: true, allowedActorIds: ['hero'] })
  const day = advance(state, c.CAPTIVE_FEED_INTERVAL_MINUTES, 'cmd-day')
  if (day) {
    rules.replayEvents(state, day.events)
    const hour = advance(day.state, 60, 'cmd-hour')
    if (hour) advance(hour.state, c.CAPTIVE_FEED_INTERVAL_MINUTES - 60, 'cmd-next-day')
  }
  const harmed = run([{ command_type: 'HarmNpc', npc_id: 'enemy-surrendered', amount: 99, damage_type: 'fire', source_actor_id: 'hero', command_id: 'cmd-harm-captive', campaign_id: 'CAPTIVE' }], state, { isAdmin: true, serverAuthoritativeCombat: true })
  if (harmed) {
    run([command('HandCaptiveToGuards', harmed.state)], harmed.state)
    c.planCaptiveNeglectCommands(harmed.state, { worldMinute: c.CAPTIVE_FEED_INTERVAL_MINUTES })
  }
  const postless = attempt(() => rules.normalizeCampaignState({ ...state, npc_world: { ...state.npc_world, placements: [] } }))
  if (postless) run([command('ExecuteCaptive', postless)], postless)
  const moved = run([{ command_type: 'AdvanceScene', actor_id: 'hero', command_id: 'cmd-advance', campaign_id: 'CAPTIVE', scene_args: { location: 'Старый тракт', title: 'Дорога', objective: 'Идти дальше' } }], state, { isAdmin: true, allowedActorIds: ['hero'] })
  if (moved) mechanicsForViewer(moved.events, { role: 'player', heroIds: ['hero'] }, 'hero', moved.state)
  const fighting = rules.applyGameEvent(state, { event_type: 'CombatStarted', actor_id: 'hero', target_ids: ['hero'], payload: { round: 1, initiative: [{ actor_id: 'hero', total: 15 }], active_index: 0, party_ids: ['hero'], enemy_ids: [] }, visibility: 'public' })
  run([command('ReleaseCaptive', fighting)], fighting)
}

const stopCapture = startCapture(capture)
scenario()
scenario({ npcs: [villager('watchman', 'Страж Бран')] })
scenario({ npcs: [{ ...villager('enemy-surrendered', 'Ждан Прозвище'), location: VILLAGE }] }, { deep: false })
scenario({ sceneKind: 'wilds' }, { deep: false })
scenario({ sceneKind: 'capital', minutes: 3_000, npcs: [villager('watchman', 'Страж Бран'), villager('priest', 'Отец Рем', 'temple')] })
scenario({ facts: [{ id: 'fact:hidden-1', subject_id: 'enemy-surrendered', predicate: 'knows', object: VILLAGE, summary: `Тайник у ${VILLAGE}`, visibility: 'gm_only', status: 'active', source_event_ids: [] }] })
scenario({ npcs: [{ id: 'enemy-knocked', name: 'Вожак', role: 'предводитель', location: VILLAGE, visibility: 'party', available: false, tags: ['parley-leader'] }] }, { deep: false })
scenario({ enemies: [bandit('enemy-surrendered', { creature_type: 'fiend', name: 'Барбед дьявол 2', stat_block_id: 'srd_5_2_1:barbed-devil', provenance: { xp: 2300 } }), bandit('enemy-knocked', { creature_type: 'giant', name: 'Холмовой великан', stat_block_id: 'srd_5_2_1:hill-giant-boss', provenance: { xp: 1800 } })] })
for (let index = 0; index < 18; index += 1) scenario({ sessionCode: `CAPTIVE-${index}`, minutes: int(0, 5_000), location: pick([VILLAGE, 'Каменный Брод', 'village', '']) }, { deep: index < 6 })
stopCapture()
recorder.flush(400)
const afterScenarios = writer.cases.length

// ---------------------------------------------------------------------------
// 2. Батарея прямых вызовов над состоянием
// ---------------------------------------------------------------------------

const ODD = [...PROTOTYPE_KEYS.filter((key) => ['constructor', '__proto__', 'toString', 'hasOwnProperty'].includes(key)), 'undefined', 'null', '', 'missing']

function battery(state, { cap = Infinity } = {}) {
  for (const name of ['captiveList', 'heldCaptives', 'capturableEnemies', 'planCaptureDrafts', 'planCaptiveRelocationDrafts', 'captiveSettlementFor', 'localFactionIds']) recorder.record(name, [state], { cap })
  const captives = attempt(() => c.captiveList(state)) ?? []
  const ids = [...captives.map((captive) => captive.id).slice(0, 4), ...ODD.filter(() => chance(0.2))]
  for (const id of ids) {
    recorder.record('captiveFor', [state, id], { cap })
    recorder.record('heldCaptiveForNpc', [state, id], { cap })
    recorder.record('captiveIdFor', [state, id], { cap })
  }
  for (const captive of captives.slice(0, 4)) {
    recorder.record('heldCaptiveForNpc', [state, captive.npc_id], { cap })
    recorder.record('captiveKnowledgeDrafts', [state, captive], { cap })
    for (const skill of ['intimidation', 'persuasion', undefined, 'deception']) {
      recorder.record('captiveInterrogationPolicy', [state, captive, { skill, reputationShift: pick([0, 2, -5, 9, '1', undefined]) }], { cap })
    }
    recorder.record('captiveSparedDisposition', [captive], { cap })
    recorder.record('captiveBountyCp', [captive], { cap })
    recorder.record('captiveForViewer', [captive], { cap })
    recorder.record('captiveNeglectedPayload', [captive, pick([0, 1_440, 3_000, '2000', undefined, -5])], { cap })
  }
  for (const enemy of (Array.isArray(state?.enemies) ? state.enemies : []).slice(0, 5)) {
    recorder.record('captivePersona', [state, enemy], { cap })
    recorder.record('captiveOriginFor', [state, enemy], { cap })
    recorder.record('captiveBandId', [enemy?.stat_block_id, enemy?.name], { cap })
  }
  for (const minute of [undefined, 0, 1_439, 1_440, 2_880, 10_000, '3000', null].filter((_, index) => index < 2 || chance(0.35))) {
    recorder.record('planCaptiveNeglectCommands', [state, minute === undefined ? undefined : { worldMinute: minute }], { cap })
    recorder.record('planCaptiveNeglectDrafts', [state, { worldMinute: minute }], { cap })
  }
  for (const viewer of [undefined, { isAdmin: true }, { isAdmin: false }, { isAdmin: 'yes' }]) recorder.record('captivesForViewer', [state, viewer], { cap })
}

for (const state of scenarioStates) battery(state)
const afterBattery = writer.cases.length

// ---------------------------------------------------------------------------
// 3. Корпус паритета: состояния и повтор команд
// ---------------------------------------------------------------------------

const RELEVANT = new Set(['EndCombat', 'AdvanceTime', 'AdvanceScene', 'InterrogateCaptive', 'ReleaseCaptive', 'HandCaptiveToGuards', 'FeedCaptive', 'ExecuteCaptive', 'NeglectCaptive', 'HarmNpc', 'TakeRest', 'Rest', 'ShortRest', 'LongRest', 'MakeAttack'])
const dir = process.env.SK_QUICK ? null : corpusDir(process.argv[2])
let corpusStates = 0
let replayed = 0
if (dir) {
  const seen = new Set()
  let records = 0
  for (const entry of corpusRecords(dir)) {
    records += 1
    const type = String(entry.command?.command_type ?? '')
    const relevant = RELEVANT.has(type) || type.includes('Captive')
    if (!relevant && !chance(0.004)) continue
    if (replayed >= 1_300) break
    const state = corpusState(dir, entry.state)
    if (!state) continue
    if (!seen.has(entry.state) && (state.captives?.captives?.length || (corpusStates < 40 && chance(0.2)))) {
      seen.add(entry.state)
      if (corpusStates < 30) {
        corpusStates += 1
        battery(state, { cap: 2_000 })
      }
    }
    replayed += 1
    const stop = startCapture(capture)
    try {
      const result = rules.resolveCommand(entry.command, state, { diceService: replayDice(entry.dice), context: entry.context ?? {} })
      const after = (entry.outcome?.events ?? result.events ?? []).reduce(rules.applyGameEvent, rules.normalizeCampaignState(state))
      const viewer = after.players?.[0]?.id
      if (viewer) campaignStateForViewer(after, { role: 'player', playerId: viewer }, viewer)
    } catch { /* отказ команды — тоже часть корпуса */ }
    stop()
    recorder.flush(1_200)
  }
  console.log(`корпус: записей ${records}, состояний для батареи ${corpusStates}, повторено команд ${replayed}`)
} else {
  console.log('корпус не найден — пропущен')
}
const afterCorpus = writer.cases.length

// ---------------------------------------------------------------------------
// 4. Случайные пленные, враги и цепочки событий
// ---------------------------------------------------------------------------

const IDS = ['enemy-1', 'enemy-2', 'bandit-3', 'orc', 'gob-7', '12', 'npc:vela', 'enemy-surrendered']
const NAMES = ['Бандит 1', 'Орк 2', 'Гоблин', 'Барбед дьявол 2', 'Разбойник', '', 'Капитан  ватаги  3']
const TYPES = ['humanoid', 'Humanoid', 'giant', 'fiend', 'celestial', 'dragon', 'beast', 'undead', 'ooze', '', undefined]
const STAT_BLOCKS = ['srd_5_2_1:bandit', 'srd_5_2_1:goblin-minion', 'srd_5_2_1:goblin-warrior', 'srd_5_2_1:orc-captain', 'thug', 'srd:veteran', '', undefined, 'a:b:c-guard']

function randomEnemy(index) {
  if (chance(0.03)) return pick([null, 5, 'enemy', [], { name: 'Без id' }])
  const id = chance(0.06) ? pick(ODD) : `${pick(IDS)}-${index}`
  const enemy = { id: chance(0.04) ? int(1, 9) : id, name: pick(NAMES), hp: pick([0, 0, 3, -2]), maxHp: pick([11, 7, '9', undefined, 0, 'x']), alive: chance(0.3) }
  const type = pick(TYPES)
  if (type !== undefined) enemy[pick(['creature_type', 'creature_type', 'creatureType', 'monster_type', 'kind'])] = type
  const stat = pick(STAT_BLOCKS)
  if (stat !== undefined) enemy.stat_block_id = stat
  if (chance(0.7)) enemy.provenance = { xp: pick([25, 50, 0, 450, 1800, 20000, '100', -10, undefined]) }
  if (chance(0.8)) {
    enemy.x = pick([1, 2, 3, 4, 5, '3', 2.5, undefined])
    enemy.y = int(0, 5)
  }
  return enemy
}

function randomConditions(enemies) {
  const conditions = {}
  for (const enemy of enemies) {
    if (!enemy || typeof enemy !== 'object' || enemy.id == null || !chance(0.85)) continue
    conditions[String(enemy.id)] = pick([
      [{ id: 'surrendered' }], [{ id: 'unconscious' }], [{ id: 'fled' }], ['surrendered'], [{ id: 'prone' }, { id: 'surrendered' }],
      [], [null], [{ id: 'unconscious' }, { id: 'fled' }], 'surrendered', { id: 'surrendered' },
    ])
  }
  if (chance(0.1)) conditions.constructor = [{ id: 'surrendered' }]
  return conditions
}

function randomCaptive(index) {
  if (chance(0.03)) return pick([chance(0.4) ? null : undefined, 'captive', 7, [], {}, { id: 'captive:x' }])
  const taken = pick([0, 100, 1_440, 3_000, '200', -5, undefined, 2.5])
  return {
    id: chance(0.08) ? pick([' captive:x ', ':bad', 'captive x', '', ...ODD, 'c'.repeat(130)]) : `captive:${index % 7}${pick(['', 'a', 'b'])}`,
    npc_id: chance(0.05) ? pick(['', null, 5]) : pick(IDS),
    actor_id: pick(IDS),
    name: pick(NAMES),
    role: pick(['Бандит', 'Орк', '', '  связанный  ']),
    temper: pick(['broken', 'talkative', 'sullen', 'haggler', 'defiant', 'weird', undefined, ['defiant']]),
    origin: pick(['surrendered', 'knocked_out', 'fled', undefined]),
    status: pick(['held', 'held', 'held', 'released', 'handed_over', 'dead', 'lost', undefined]),
    band_id: pick(['bandit', 'goblin', '', undefined]),
    stat_block_id: pick(STAT_BLOCKS),
    xp: pick([25, 450, 0, -1, '100', undefined, 1e20]),
    taken_at_minutes: taken,
    location_id: pick(['village', 'road', '', undefined]),
    location_name: pick([VILLAGE, 'Старый тракт', '', undefined, '$& и $$ и $`']),
    known_fact_ids: pick([[], ['fact:a'], ['fact:a', 'fact:b', 'fact:c'], ['fact:a', 'fact:a'], [' fact:a ', null, 5], 'fact:a', undefined]),
    revealed_fact_ids: pick([[], ['fact:a'], ['fact:b'], ['fact:a', 'fact:b'], 'fact:a', undefined, [null]]),
    interrogations: pick([0, 1, 3, '2', -1, undefined, null]),
    last_fed_at_minutes: pick([undefined, 0, 1_000, '1440', null, 5.5]),
    neglected_at_minutes: pick([undefined, null, 1_440, '2880', -3, 'x']),
    resolved_at_minutes: pick([undefined, null, 50]),
    resolution: pick(['', 'released', undefined]),
    disposition: pick(['ally', 'informant', 'none', 'enemy', undefined]),
  }
}

function randomFacts() {
  const facts = []
  for (let index = int(0, 5); index > 0; index -= 1) {
    facts.push(chance(0.05) ? pick([null, 'fact']) : {
      id: pick([`fact:${index}`, `fact:z${index}`, `Fact:${index}`, 7]),
      status: pick(['active', 'active', 'retracted']),
      visibility: pick(['gm_only', 'gm_only', 'party']),
      summary: pick([`Тайник у ${VILLAGE}`, 'Ничего', `В «Старый тракт» ждут`, '']),
      object: pick([VILLAGE, 'village', { place: VILLAGE }, undefined]),
    })
  }
  return facts
}

function randomState(index) {
  const enemies = Array.from({ length: int(0, 6) }, (_, enemyIndex) => randomEnemy(enemyIndex))
  const captives = Array.from({ length: int(0, 5) }, (_, captiveIndex) => randomCaptive(captiveIndex))
  const location = pick([VILLAGE, 'Старый тракт', 'village', undefined])
  const npcs = []
  for (let npcIndex = int(0, 4); npcIndex > 0; npcIndex -= 1) {
    npcs.push(chance(0.05) ? pick([null, 'npc']) : {
      id: pick([...IDS, 'watchman', 'priest']),
      name: pick(['Страж Бран', 'Отец Рем', 'Ждан']),
      role: pick(['житель', 'стражник', 'пленник']),
      location: pick([location ?? VILLAGE, 'Дорога', '']),
      visibility: pick(['party', 'public', 'gm_only']),
      available: pick([true, false, undefined]),
      tags: pick([['faction:watch'], ['faction:guild', 'faction:watch'], ['parley-leader'], [], undefined]),
    })
  }
  const raw = {
    sessionCode: pick(['CAPTIVE', 'RANDOM', `R-${index}`, '', undefined, 42]),
    scene: { title: pick(['Околица', 'Дорога', '']), location, location_id: pick(['village', 'road', undefined]), grid: { width: 6, height: 6 }, cells: cells() },
    players: [{ id: 'hero', character: 'Ада', hp: 12, maxHp: 12, x: 1, y: 1 }],
    enemies,
    social: { npcs },
    worldMemory: { facts: randomFacts(), entities: chance(0.5) ? [{ id: pick(IDS), kind: 'npc', name: 'Знакомый' }] : [] },
    worldMap: { locations: chance(0.8) ? [{ id: 'village', name: VILLAGE, kind: pick(['village', 'town', 'wilds', 'capital', 'ruin', undefined]) }, { id: 'road', name: 'Старый тракт', kind: 'road' }] : pick([[], 'junk', undefined]) },
    captives: chance(0.85) ? { schema_version: pick([1, 1, 2, undefined, '1']), captives } : pick([undefined, null, 'junk', { captives: 'x' }]),
    mechanics: {
      world_time: pick([{ elapsed_minutes: int(0, 6_000) }, { elapsed_minutes: '1500' }, { amount: 3, unit: 'day' }, {}, undefined]),
      conditions: randomConditions(enemies),
      resting: Object.fromEntries(enemies.filter((enemy) => enemy && typeof enemy === 'object' && enemy.id != null && chance(0.4)).map((enemy) => [String(enemy.id), { reason: pick(['knockout', 'rest', undefined]) }])),
      ...(chance(0.3) ? { positions: Object.fromEntries(enemies.filter((enemy) => enemy && typeof enemy === 'object' && enemy.id != null).map((enemy) => [String(enemy.id), pick([{ x: int(0, 5), y: int(0, 5) }, null, { x: 9, y: 9 }])])) } : {}),
    },
  }
  return raw
}

for (let index = 0; index < 130; index += 1) {
  const raw = randomState(index)
  // Сырое состояние старого сохранения — и оно же после нормализации кампании.
  const states = [raw]
  const normalized = attempt(() => rules.normalizeCampaignState(viaJson(raw)))
  if (normalized && chance(0.35)) states.push(normalized)
  for (const state of states) battery(state, { cap: 1_800 })
  recorder.record('normalizeCaptivesState', [raw.captives])
  recorder.record('normalizeCaptivesState', [{ captives: raw.captives?.captives }])
  for (const captive of Array.isArray(raw.captives?.captives) ? raw.captives.captives : []) {
    recorder.record('captiveForViewer', [captive])
    recorder.record('captiveBountyCp', [captive ?? {}])
    recorder.record('captiveSparedDisposition', [captive ?? {}])
    recorder.record('captiveNeglectedPayload', [captive ?? {}, pick([1_440, '9', undefined, null])])
    recorder.record('captiveInterrogationPolicy', [raw, captive ?? {}, pick([{}, { skill: 'persuasion' }, { reputationShift: 7 }, { skill: null, reputationShift: null }])])
    recorder.record('captiveKnowledgeDrafts', [raw, captive ?? {}])
  }
  for (const name of [...NAMES, undefined, null, 7]) recorder.record('captiveBandId', [pick(STAT_BLOCKS), name], { cap: 400 })
  // Цепочка «события → редьюсер»: реестр переходит от события к событию.
  let registry = chance(0.5) ? raw.captives : (attempt(() => c.normalizeCaptivesState(raw.captives)) ?? raw.captives)
  const list = Array.isArray(registry?.captives) ? registry.captives : []
  const ids = list.map((captive) => captive?.id).filter(Boolean)
  const npcIds = list.map((captive) => captive?.npc_id).filter(Boolean)
  for (let step = int(1, 8); step > 0; step -= 1) {
    const type = pick([...CAPTIVE_EVENTS, 'Unrelated', '', undefined])
    const captiveId = chance(0.85) ? pick(ids.length ? ids : ['captive:0']) : pick(['', null, ...ODD])
    const payload = pick([
      { captive_id: captiveId, at_minutes: pick([100, 2_000, '300', -4, undefined, 2.5]), success: pick([true, false, 'true']), fact_id: pick(['fact:a', 'fact:new', '', undefined]), disposition: pick(['ally', 'informant', 'none', 'foe']), location_id: 'road', location_name: pick(['Старый тракт', undefined]) },
      { npc_id: pick(npcIds.length ? npcIds : IDS) },
      { captive: randomCaptive(int(0, 9)) },
      undefined, null, 'payload',
    ])
    const event = chance(0.97) ? { event_type: type, payload } : pick([undefined, null, 'event'])
    const stateArg = pick([raw, undefined, { mechanics: { world_time: { elapsed_minutes: int(0, 9_000) } } }, { mechanics: { world_time: { amount: 2, unit: 'hours' } } }])
    recorder.record('applyCaptiveEvent', [registry, event, stateArg])
    registry = attempt(() => c.applyCaptiveEvent(viaJson(registry), viaJson(event), viaJson(stateArg))) ?? registry
  }
}

writer.write(new URL('./captives.json', import.meta.url))
console.log(`сценарии ${afterScenarios}, батарея ${afterBattery - afterScenarios}, корпус ${afterCorpus - afterBattery}, случайные ${writer.cases.length - afterCorpus}`)
console.log('урезание:', recorder.stats)

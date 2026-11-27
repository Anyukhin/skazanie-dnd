// Эталон `server/law-and-order.mjs` для sk-society: `node gen-law-and-order.mjs`.
//
// Три части: константы модуля; случайные состояния с мусором для каждой
// экспортируемой функции; последовательности событий через `applyLawEvent` —
// и случайные цепочки, и настоящие сценарии движка (`rules-engine.mjs`) из
// `test/law-and-order.test.mjs`, где каждый вызов редьюсера закона
// восстанавливается по состояниям до и после события.
import { JUNK, collector, plain, rng, server, write } from './lib.mjs'

const law = await import(server('law-and-order'))
const engine = await import(server('rules-engine'))
const { DiceService, SequenceDiceRng } = await import(server('dice-service'))

const random = rng(20261013)
const c = collector()

// ---------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------

const constants = {
  LAW_SCHEMA_VERSION: law.LAW_SCHEMA_VERSION,
  LAW_POLICY_ID: law.LAW_POLICY_ID,
  WANTED_CRIME_POINTS: law.WANTED_CRIME_POINTS,
  WANTED_LEVEL_THRESHOLDS: law.WANTED_LEVEL_THRESHOLDS,
  MAX_WANTED_LEVEL: law.MAX_WANTED_LEVEL,
  WANTED_LEVEL_LABELS: law.WANTED_LEVEL_LABELS,
  WANTED_DECAY_MINUTES: law.WANTED_DECAY_MINUTES,
  WANTED_FINE_CP: law.WANTED_FINE_CP,
  GUARD_PASSIVE_PERCEPTION: law.GUARD_PASSIVE_PERCEPTION,
  GUARD_CUSTODY_MINUTES: law.GUARD_CUSTODY_MINUTES,
  WANTED_ESCAPE_FAILURE_POINTS: law.WANTED_ESCAPE_FAILURE_POINTS,
  GUARD_ENCOUNTER_THEME: law.GUARD_ENCOUNTER_THEME,
  GUARD_ENCOUNTER_DIFFICULTY: law.GUARD_ENCOUNTER_DIFFICULTY,
  SETTLEMENT_LOCATION_KINDS: [...law.SETTLEMENT_LOCATION_KINDS],
  GUARD_RESOLUTIONS: law.GUARD_RESOLUTIONS,
  GUARD_ESCAPE_SKILLS: law.GUARD_ESCAPE_SKILLS,
  LAW_COMMAND_TYPES: [...law.LAW_COMMAND_TYPES],
  WANTED_CLEAR_REASONS: law.WANTED_CLEAR_REASONS,
  WANTED_TRADE_REFUSAL_LEVEL: law.WANTED_TRADE_REFUSAL_LEVEL,
  WANTED_PRICE_BPS: law.WANTED_PRICE_BPS,
  WANTED_TRADE_REFUSAL_REASON: law.WANTED_TRADE_REFUSAL_REASON,
}

// ---------------------------------------------------------------------------
// Случайные состояния
// ---------------------------------------------------------------------------

const REGION_IDS = ['north', 'south', 'east', ' north ', 'край-1', '7', '12', '', null, 5, 'Ｎorth']
const NODE_IDS = ['village', 'road', 'capital', 'farcity', 'fort', ' village ', '', null, 3]
const KINDS = ['village', 'town', 'city', 'capital', 'port', 'fortress', 'landmark', 'wilds', ' village ', 'VILLAGE', null, 7]
const CRIME_KINDS = ['murder', 'cruelty', 'treachery', 'arson', 'theft', 'destruction', 'violence', 'vandalism', 'defiance', 'bribery_attempt', ' theft ', 'constructor', 'toString', null, '', 4]
const CRIME_IDS = ['crime:a', 'crime:b', 'crime:c', 'crime:a', 'c-1', 'bad id!', '', ' crime:d ', 7, null, 'x'.repeat(150), '.dot']
const MINUTES = [undefined, null, 0, 1, 59, 1_439, 1_440, 1_441, 2_880, 5_000, 10_000, -50, 1.5, '3000', 'abc', 2 ** 53, 2 ** 60, true]
const REASONS = ['fine', 'surrender', 'amnesty', ' fine ', 'bribe', null, undefined, 3]
const SESSIONS = ['LAW', 'law', 'S-1', '', null, undefined, 42, ' Ｌａｗ ']
const TEXTS = ['Тихий Брод', '  Старый   тракт  ', 'Ｂｒｏｄ', '', null, undefined, 17, 'x  y', 'очень '.repeat(80)]

const maybe = (value, p = 0.8) => (random.chance(p) ? value : undefined)
const junkOr = (value, p = 0.85) => (random.chance(p) ? value : random.pick(JUNK))

function worldMap() {
  const regions = [
    { id: 'north', name: random.pick(['Северный край', '  Северный   край ', '', null]) },
    { id: 'south', name: 'Южный край' },
    { id: 'east', name: 'Восточный край' },
    ...random.some([{ id: ' north ', name: 'Дубль' }, { id: '7', name: 'Седьмой' }, { id: 5, name: 'Пятый' }, null, 'x'], 2),
  ]
  const locations = [
    { id: 'village', name: 'Тихий Брод', kind: 'village', regionId: 'north' },
    { id: 'road', name: 'Старый тракт', kind: 'landmark', regionId: 'north' },
    { id: 'capital', name: 'Стольный Град', kind: 'capital', regionId: 'north' },
    { id: 'farcity', name: 'Дальний Град', kind: 'city', regionId: 'east' },
    { id: 'fort', name: 'Застава', kind: 'fortress', regionId: 'south', garrison: random.pick([undefined, false, true, 'no', null]) },
    ...random.some([
      { id: random.pick(NODE_IDS), name: random.pick(TEXTS), kind: random.pick(KINDS), regionId: random.pick(REGION_IDS) },
      null,
      { id: 'village', name: 'Дубль деревни', kind: 'town', regionId: 'south' },
    ], 3),
  ]
  return junkOr({
    regions: junkOr(regions, 0.9),
    locations: junkOr(locations, 0.95),
    currentLocationId: random.pick([...NODE_IDS, 'nowhere', undefined]),
  }, 0.95)
}

function crime() {
  return {
    id: random.pick(CRIME_IDS),
    kind: random.pick(CRIME_KINDS),
    points: maybe(random.pick([1, 2, 3, 4, 13, -2, '3', 1.5, null, 0]), 0.4),
    region_id: random.pick(REGION_IDS),
    region_name: maybe(random.pick(TEXTS)),
    node_id: maybe(random.pick(NODE_IDS)),
    place_name: maybe(random.pick(TEXTS)),
    at_minutes: random.pick(MINUTES),
    witnesses: maybe(random.pick([0, 1, 3, -1, '2', null])),
    summary: maybe(random.pick(TEXTS)),
    cleared_at_minutes: random.chance(0.3) ? random.pick(MINUTES) : undefined,
    cleared_reason: maybe(random.pick(REASONS), 0.3),
  }
}

function encounter() {
  if (random.chance(0.15)) return random.pick(JUNK)
  return {
    id: random.pick(['guard-encounter:1', ' g 2 ', '', null, 9]),
    region_id: random.pick(REGION_IDS),
    region_name: maybe(random.pick(TEXTS)),
    node_id: random.pick([...NODE_IDS, undefined]),
    place_name: maybe(random.pick(TEXTS)),
    level: random.pick([undefined, null, 0, 1, 2, 3, 4, '2', 1.5]),
    fine_cp: random.pick([undefined, 500, 2000, -5, '600', null]),
    officer_name: maybe('Радим'),
    officer_rank: maybe('десятник стражи'),
    demand: maybe(random.pick(TEXTS)),
    escape_dc: random.pick([undefined, null, 11, 4, 31, '13', 2.5]),
    escape_attempts: random.pick([undefined, 0, 1, '2', null, -3, true, [1]]),
    started_at_minutes: random.pick(MINUTES),
  }
}

function lawState() {
  if (random.chance(0.08)) return random.pick(JUNK)
  const cleared = {}
  for (const key of random.some([...REGION_IDS.map(String), ' 7 ', '3', '__x'], 5)) {
    cleared[key] = junkOr({ at_minutes: random.pick(MINUTES), reason: random.pick(REASONS) })
  }
  return {
    schema_version: random.pick([1, 1, 1, undefined, '1', 2]),
    crimes: junkOr(Array.from({ length: random.int(0, 7) }, crime), 0.9),
    cleared: junkOr(cleared, 0.85),
    encounter: random.chance(0.6) ? encounter() : random.pick([undefined, null]),
  }
}

function deeds(eventId) {
  const list = Array.from({ length: random.int(0, 2) }, () => ({ id: 'old', kind: 'theft', source_event_ids: ['old-event'] }))
  if (random.chance(0.85)) {
    list.push({
      id: random.pick(['deed:1', 'deed:2', null, undefined, 77]),
      kind: random.pick(CRIME_KINDS),
      secret: random.pick([false, true, undefined, 'true']),
      source_event_ids: random.pick([[eventId], [eventId, 'x'], ['other'], [null], [7], undefined, eventId]),
      location_name: maybe(random.pick(TEXTS)),
      at_minutes: random.pick(MINUTES),
      witness_ids: random.pick([['baker'], ['baker', 'smith'], [], undefined, 'baker']),
      summary: maybe(random.pick(TEXTS)),
    })
  } else if (random.chance(0.5)) {
    list.push(random.pick([null, 0, 'deed']))
  }
  return { deeds: junkOr(list, 0.95) }
}

function state(eventId = 'evt-1') {
  return {
    sessionCode: random.pick(SESSIONS),
    worldMap: worldMap(),
    law: lawState(),
    world_deeds: deeds(eventId),
    mechanics: junkOr({
      world_time: junkOr({ elapsed_minutes: random.pick(MINUTES) }, 0.9),
      combat: maybe({ active: random.pick([true, false, 'true', 1]) }, 0.4),
    }, 0.95),
  }
}

const EVENT_TYPES = ['GuardEncounterStarted', 'GuardEncounterResolved', 'WantedLevelRaised', 'WantedCleared', 'SceneObjectOperated', 'NpcDied', '', undefined]

function lawEvent(eventId) {
  const type = random.pick(EVENT_TYPES)
  const payload = {}
  if (type === 'GuardEncounterStarted') payload.encounter = encounter()
  if (type === 'GuardEncounterResolved') {
    payload.resolution = random.pick(['flee', ' flee ', 'fine', 'surrender', 'fight', null])
    payload.success = random.pick([true, false, undefined, 'true'])
  }
  if (type === 'WantedLevelRaised') payload.crime = random.chance(0.9) ? crime() : random.pick([undefined, {}, 'x'])
  if (type === 'WantedCleared') {
    payload.region_id = random.pick(REGION_IDS)
    payload.crime_ids = random.pick([['crime:a'], ['crime:a', 'crime:b', ' crime:c '], [], undefined, 'crime:a', [null, 7]])
    payload.at_minutes = random.pick(MINUTES)
    payload.reason = random.pick(REASONS)
  }
  return {
    event_id: random.pick([eventId, eventId, undefined, '', 12]),
    event_type: type,
    payload: random.chance(0.95) ? payload : random.pick([undefined, null]),
  }
}

const VIEWERS = [{ isAdmin: true }, {}, { isAdmin: 'true' }, null, { role: 'admin' }]
const LEVELS = [undefined, null, 0, 1, 2, 3, 4, '2', 2.5, -1, 'abc']

for (let index = 0; index < 200; index += 1) {
  const eventId = `evt-${index}`
  const s = state(eventId)
  c.call('normalizeLawState', law.normalizeLawState, [s.law])
  for (const region of random.some(REGION_IDS, 3)) {
    c.call('wantedFor', law.wantedFor, [s, region])
    c.call('pendingCrimeIdsFor', law.pendingCrimeIdsFor, [s, region])
  }
  c.call('wantedLevelHere', law.wantedLevelHere, [s])
  c.call('wantedHere', law.wantedHere, [s])
  c.call('wantedFeed', law.wantedFeed, [s])
  c.call('currentWorldNode', law.currentWorldNode, [s])
  c.call('currentRegionId', law.currentRegionId, [s])
  c.call('currentSettlement', law.currentSettlement, [s])
  c.call('crimeFromDeedLedger', law.crimeFromDeedLedger, [s, { event_id: random.pick([eventId, eventId, ` ${eventId} `, 'other', undefined, 7]) }])
  c.call('guardEncounterIsHere', law.guardEncounterIsHere, [s])
  c.call('guardEncounterIsHere', law.guardEncounterIsHere, [s, random.chance(0.2) ? null : encounter()])
  c.call('guardEncounterTriggerFor', law.guardEncounterTriggerFor, [s, { commandId: random.pick(['cmd-1', '', undefined, 5]) }])
  c.call('guardEncounterFor', law.guardEncounterFor, [s])
  const anEncounter = encounter()
  c.call('guardOptionsFor', law.guardOptionsFor, [anEncounter])
  c.call('publicGuardEncounterFor', law.publicGuardEncounterFor, [anEncounter])
  c.call('wantedSignsFor', law.wantedSignsFor, [s])
  c.call('wantedPriceBps', law.wantedPriceBps, [s])
  c.call('wantedTradeAvailable', law.wantedTradeAvailable, [s])
  c.call('lawForViewer', law.lawForViewer, [s, random.pick(VIEWERS)])
  c.call('guardOfficerFor', law.guardOfficerFor, [s, { regionId: random.pick(REGION_IDS), level: random.pick(LEVELS) }])
  c.call('applyLawEvent', law.applyLawEvent, [s.law, lawEvent(eventId), s])
}

for (const level of LEVELS) {
  c.call('guardFineCpFor', law.guardFineCpFor, [level])
  c.call('guardEscapeDcFor', law.guardEscapeDcFor, [level])
  for (const options of [{}, { placeName: 'Тихий Брод', fineCp: 2000 }, { placeName: '', fineCp: 49 }, { placeName: '  Ｂрод  ', fineCp: 150 }, { fineCp: -10 }, { fineCp: '6000' }]) {
    c.call('guardDemandFor', law.guardDemandFor, [level, options])
  }
}
for (const points of [...MINUTES, 0, 1, 2, 3, 4, 6, 7, 8, 100]) c.call('wantedLevelForPoints', law.wantedLevelForPoints, [points])
for (const results of [[], [{ success: true }], [{ success: true }, { success: false }], [{ success: false }, { success: 'true' }], [null, { success: true }], undefined, 'x', [{ success: true }, { success: false }, { success: false }]]) {
  c.call('escapeSucceeded', law.escapeSucceeded, [results])
}

// Случайные цепочки: выход редьюсера — вход следующего события.
for (let chain = 0; chain < 60; chain += 1) {
  const s = state(`chain-${chain}`)
  let current = s.law
  for (let step = 0; step < 8; step += 1) {
    const eventId = `chain-${chain}-${step}`
    const stepState = { ...s, world_deeds: deeds(eventId), law: current }
    current = c.call('applyLawEvent', law.applyLawEvent, [current, lawEvent(eventId), stepState])
  }
}

// ---------------------------------------------------------------------------
// Сценарии движка: как в test/law-and-order.test.mjs
// ---------------------------------------------------------------------------

const VILLAGE = 'Тихий Брод'
const ROAD = 'Старый тракт'
const NORTH = 'north'

function engineWorldMap() {
  return {
    seed: 'law-seed',
    regions: [
      { id: NORTH, name: 'Северный край', biome: 'plains', x: 200, y: 200, radius: 205 },
      { id: 'south', name: 'Южный край', biome: 'marsh', x: 200, y: 520, radius: 205 },
      { id: 'east', name: 'Восточный край', biome: 'coast', x: 820, y: 300, radius: 205 },
    ],
    locations: [
      { id: 'village', name: VILLAGE, kind: 'village', x: 200, y: 200, regionId: NORTH },
      { id: 'road', name: ROAD, kind: 'landmark', x: 260, y: 240, regionId: NORTH },
      { id: 'capital', name: 'Стольный Град', kind: 'capital', x: 150, y: 160, regionId: NORTH },
      { id: 'farcity', name: 'Дальний Град', kind: 'city', x: 820, y: 300, regionId: 'east' },
    ],
    routes: [
      { id: 'r1', from: 'village', to: 'road', kind: 'road' },
      { id: 'r2', from: 'road', to: 'farcity', kind: 'road' },
      { id: 'r3', from: 'road', to: 'capital', kind: 'road' },
    ],
  }
}

function cells() {
  const grid = []
  for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) grid.push({ x, y, type: 'floor', revealed: true })
  return grid
}

const villager = (id, name, location = VILLAGE) => ({ id, name, role: 'житель', location, visibility: 'party', public_summary: `${name} живёт в «${location}».`, tags: ['faction:brod-folk'] })

function campaign({ minutes = 0, npcs = [], locationId = 'village', location = VILLAGE, currency } = {}) {
  return engine.normalizeCampaignState({
    sessionCode: 'LAW', campaign: 'Закон и розыск', activePlayerId: 'hero', partyMemberIds: ['hero', 'mate'], partyName: 'Отряд героев',
    scene: { title: 'Площадь', location, location_id: locationId, cells: cells() },
    players: [
      { id: 'hero', character: 'Ада', level: 1, hp: 10, maxHp: 10, x: 2, y: 2, inventory: [], abilities: { str: 10, dex: 14, con: 10, int: 10, wis: 10, cha: 10 }, currency: currency ?? { copper: 0, silver: 0, gold: 100, platinum: 0 } },
      { id: 'mate', character: 'Бор', level: 1, hp: 10, maxHp: 10, x: 3, y: 2, inventory: [], abilities: { str: 14, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, currency: { copper: 0, silver: 0, gold: 5, platinum: 0 } },
    ],
    worldMap: engineWorldMap(),
    social: { npcs },
    mechanics: { world_time: { elapsed_minutes: minutes } },
  })
}

const witnessed = ({ minutes = 0, location = VILLAGE, ...rest } = {}) => campaign({
  minutes, location, npcs: [villager('baker', 'Пекарь Мила', location), villager('smith', 'Кузнец Гор', location)], ...rest,
})

const theftEvent = ({ id = 'evt-theft', commandId = 'cmd-theft', propId = 'chest-1' } = {}) => ({
  event_id: id, command_id: commandId, event_type: 'SceneObjectOperated', actor_id: 'hero', target_ids: [],
  payload: { prop_id: propId, kind: 'container', intent: 'take' }, visibility: 'party',
})
const murderEvent = ({ id = 'evt-murder', commandId = 'cmd-murder', npcId = 'victim' } = {}) => ({
  event_id: id, command_id: commandId, event_type: 'NpcDied', actor_id: 'hero', target_ids: [npcId],
  payload: { npc_id: npcId, npc_name: 'Возчик Сём', source_actor_id: 'hero', trigger: 'server-collateral' }, visibility: 'party',
})
const arsonEvent = ({ id = 'evt-arson', commandId = 'cmd-arson' } = {}) => ({
  event_id: id, command_id: commandId, event_type: 'SceneObjectOperated', actor_id: 'hero', target_ids: [],
  payload: { prop_id: 'hay-1', kind: 'furnishing', intent: 'ignite' }, visibility: 'party',
})

function guardEvent(state, commandId = 'cmd-enter') {
  const level = law.wantedFor(state, NORTH).level
  return {
    event_id: `evt-guard:${commandId}`, command_id: commandId, event_type: 'GuardEncounterStarted', actor_id: 'hero', target_ids: [],
    payload: { encounter: {
      id: `guard-encounter:${commandId}`, region_id: NORTH, region_name: 'Северный край', node_id: 'village', place_name: VILLAGE,
      level, fine_cp: law.WANTED_FINE_CP[level] ?? 500, officer_name: 'Радим', officer_rank: 'десятник стражи', demand: '«Погодите-ка».',
      escape_dc: 11, escape_attempts: 0, started_at_minutes: Math.max(0, Number(state.mechanics?.world_time?.elapsed_minutes ?? 0)),
    } },
    visibility: 'party',
  }
}

let mismatches = 0
/** Применить событие движком и записать вызов `applyLawEvent`, восстановленный по состояниям. */
function apply(state, event) {
  const next = engine.applyGameEvent(state, event)
  const lawInput = state.law
  const reducerState = { ...next, law: lawInput }
  // Вне четырёх событий закона редьюсер читает у события только `event_id`:
  // тяжёлый payload (карты сцены) в эталон не нужен.
  const lawEvent = ['GuardEncounterStarted', 'GuardEncounterResolved', 'WantedLevelRaised', 'WantedCleared'].includes(event.event_type)
    ? event
    : { event_id: event.event_id, event_type: event.event_type, payload: { trimmed: true } }
  const out = c.call('applyLawEvent', law.applyLawEvent, [lawInput, lawEvent, lawView(reducerState)])
  if (JSON.stringify(out) !== JSON.stringify(next.law)) mismatches += 1
  // Ступень, лента и проекция — на каждом шаге настоящего журнала.
  c.call('wantedFor', law.wantedFor, [lawView(next), NORTH])
  c.call('wantedFeed', law.wantedFeed, [lawView(next)])
  c.call('lawForViewer', law.lawForViewer, [lawView(next), { isAdmin: true }])
  c.call('lawForViewer', law.lawForViewer, [lawView(next), {}])
  c.call('guardEncounterTriggerFor', law.guardEncounterTriggerFor, [lawView(next), { commandId: 'cmd-next' }])
  return next
}

/** Только то, что читает закон: полное состояние движка в эталоне не нужно. */
function lawView(state) {
  return {
    sessionCode: state.sessionCode,
    worldMap: state.worldMap,
    law: state.law,
    world_deeds: state.world_deeds,
    mechanics: { world_time: state.mechanics?.world_time, combat: state.mechanics?.combat ? { active: state.mechanics.combat.active } : undefined },
  }
}

function applyAll(state, events) {
  return events.reduce((current, event) => apply(current, event), state)
}

const dice = (sequence = []) => new DiceService({ rng: new SequenceDiceRng(sequence) })

function commands(state, list, { diceValues = [], context = {} } = {}) {
  const result = engine.resolveCommands(list.map((command) => ({ campaign_id: 'LAW', ...command })), state, { diceService: dice(diceValues), context: { allowedActorIds: ['hero', 'mate'], ...context } })
  return applyAll(state, result.events)
}

applyAll(campaign(), [theftEvent(), murderEvent()])
const murdered = applyAll(witnessed(), [theftEvent(), murderEvent(), arsonEvent()])
applyAll(witnessed(), [murderEvent(), theftEvent({ id: 'evt-theft-2', commandId: 'cmd-theft-2' })])
const stopped = apply(applyAll(witnessed(), [murderEvent()]), guardEvent(applyAll(witnessed(), [murderEvent()])))
commands(stopped, [{ command_type: 'ResolveGuardEncounter', actor_id: 'hero', resolution: 'fine', command_id: 'cmd-fine' }])
commands(stopped, [{ command_type: 'ResolveGuardEncounter', actor_id: 'hero', resolution: 'surrender', command_id: 'cmd-surrender' }])
commands(stopped, [{ command_type: 'ResolveGuardEncounter', actor_id: 'hero', resolution: 'fight', command_id: 'cmd-fight' }])
commands(stopped, [{ command_type: 'ResolveGuardEncounter', actor_id: 'hero', resolution: 'flee', skill: 'stealth', command_id: 'cmd-flee-ok' }], { diceValues: [18, 18] })
commands(stopped, [{ command_type: 'ResolveGuardEncounter', actor_id: 'hero', resolution: 'flee', skill: 'athletics', command_id: 'cmd-flee-fail' }], { diceValues: [1, 2] })
commands(stopped, [{ command_type: 'ClearWantedLevel', command_id: 'cmd-amnesty', region_id: NORTH }], { context: { isAdmin: true } })
const guilty = applyAll(witnessed({ locationId: 'road', location: ROAD }), [murderEvent()])
commands(guilty, [{ command_type: 'AdvanceScene', actor_id: 'hero', command_id: 'cmd-enter', scene_args: { location: VILLAGE, title: 'Ворота', objective: 'Осмотреться' } }], { context: { isAdmin: true } })
commands(guilty, [{ command_type: 'AdvanceScene', actor_id: 'hero', command_id: 'cmd-capital', scene_args: { location: 'Стольный Град', title: 'Ворота столицы', objective: 'Осмотреться' } }], { context: { isAdmin: true } })
const quiet = { ...murdered, mechanics: { ...murdered.mechanics, world_time: { amount: 1_440 * 3, unit: 'minute', elapsed_minutes: 1_440 * 3 } } }
applyAll(quiet, [theftEvent({ id: 'evt-late', commandId: 'cmd-late' })])
const replayed = engine.replayEvents(witnessed(), [theftEvent(), murderEvent(), arsonEvent(), theftEvent(), murderEvent()])
c.call('wantedFeed', law.wantedFeed, [lawView(replayed)])

if (mismatches) console.warn(`внимание: ${mismatches} восстановленных вызовов не совпали с state.law движка`)

write('law-and-order.json', { generator: 'gen-law-and-order.mjs', constants, values: c.values, cases: c.cases, skipped: c.skipped })

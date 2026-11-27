import '../../../fixtures-env.mjs'
import { startCapture, quietly } from './story-hook.mjs'
// Эталон server/scenario-knight.mjs для Rust:
//
//   node rust/crates/sk-world-story/fixtures/gen-scenario-knight.mjs [каталог корпуса]
//
// Источники входов:
//
// - сценарии `test/scenario-knight.test.mjs` через настоящий Rules Engine
//   (бутстрап кампании, переходы сцен, ожидание полуночи, бой, ужас, голова,
//   мирный путь, replay) и разбор намерения — каждый верхний вызов модуля
//   изнутри конвейера перехватывается хуком;
// - корпус паритета: состояния Асстохана (`tmp/corpus-v1/states`) и повтор
//   записанных команд на них с теми же костями под тем же перехватом;
// - сотни случайных состояний, событий и фраз с мусором старых сохранений.
//
// Состояния урезаются до полей, которые читает модуль; JS исполняется заново
// на урезанном входе и сверяется с исходом на полном — Rust получает ровно его.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { fixtureWriter, mulberry32, chooser, viaJson, same, pickKeys, PROTOTYPE_KEYS, corpusDir, corpusRecords, corpusStateText, replayDice } from './story-lib.mjs'

const root = new URL('../../../../', import.meta.url)
const K = await import(new URL('server/scenario-knight.mjs', root).href)
const S = await import(new URL('server/campaign-scenario.mjs', root).href)
const { minutesUntilClock } = await import(new URL('server/weather.mjs', root).href)
const { CampaignBootstrapper } = await import(new URL('server/campaign-bootstrap.mjs', root).href)
const rules = await import(new URL('server/rules-engine.mjs', root).href)
const { SceneArchitectAgent } = await import(new URL('server/scene-architect.mjs', root).href)
const { IntentParser } = await import(new URL('server/intent-parser.mjs', root).href)
const { Adjudicator } = await import(new URL('server/adjudicator.mjs', root).href)
const { campaignStateForViewer } = await import(new URL('server/viewer-projection.mjs', root).href)
const { fixedDice, maxDice, minDice } = await import(new URL('test/kit/dice.mjs', root).href)

const writer = fixtureWriter('scenario-knight', ['campaignConcept', 'worldMap', 'social', 'npc_world', 'scenario_knight'])
const random = mulberry32(2026_10_16)
const { int, pick, chance } = chooser(random)
const KAELAN = 'astohan-kaelan'
const CLIFFS = 'astohan-forgotten-cliffs'

// ---------------------------------------------------------------------------
// Таблица функций и урезание состояния

const FNS = {
  scenarioNightVisitorIds: { states: [0] },
  scenarioKnightStartingInventory: { states: [0] },
  minuteInWindow: { states: [] },
  scenarioKnightShouldBePresent: { states: [0] },
  scenarioKnightPresencePlan: { states: [0] },
  normalizeScenarioKnightState: { states: [] },
  scenarioNightIndex: { states: [0] },
  applyScenarioKnightEvent: { states: [2] },
  scenarioKnightState: { states: [0] },
  scenarioKnightRiddleSolved: { states: [0] },
  scenarioKnightPresent: { states: [0] },
  scenarioKnightWard: { states: [0] },
  scenarioKnightDreadFor: { states: [0] },
  scenarioKnightRules: { states: [0] },
  scenarioKnightActionFromText: { states: [] },
}
const STATE_FNS = new Set(Object.entries(FNS).filter(([name, spec]) => spec.states.length && !['scenarioNightVisitorIds', 'scenarioKnightStartingInventory'].includes(name)).map(([name]) => name))

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)

function slim(state) {
  if (!isObject(state)) return state
  const out = pickKeys(state, ['scenario_knight', 'partyMemberIds'])
  if (state.campaignConcept !== undefined) {
    const concept = state.campaignConcept
    out.campaignConcept = isObject(concept) ? pickKeys(concept, ['campaign_mode', 'arc']) : concept
    if (isObject(out.campaignConcept) && isObject(out.campaignConcept.arc)) out.campaignConcept.arc = pickKeys(out.campaignConcept.arc, ['version', 'scenario_id', 'scenario_version'])
  }
  if (state.scene !== undefined) out.scene = pickKeys(state.scene, ['location_id', 'locationId', 'location'])
  if (state.mechanics !== undefined) {
    const mechanics = state.mechanics
    out.mechanics = isObject(mechanics)
      ? Object.fromEntries([['world_time', mechanics.world_time && pickKeys(mechanics.world_time, ['elapsed_minutes'])], ['combat', mechanics.combat && pickKeys(mechanics.combat, ['active'])]].filter(([key]) => mechanics[key] !== undefined))
      : mechanics
  }
  if (state.npc_world !== undefined) out.npc_world = isObject(state.npc_world) ? pickKeys(state.npc_world, ['vitals']) : state.npc_world
  if (state.social !== undefined) {
    out.social = isObject(state.social) && Array.isArray(state.social.npcs)
      ? { npcs: state.social.npcs.filter((npc) => npc?.id === KAELAN) }
      : (isObject(state.social) ? pickKeys(state.social, ['npcs']) : state.social)
  }
  if (state.worldMemory !== undefined) {
    out.worldMemory = isObject(state.worldMemory) && Array.isArray(state.worldMemory.facts)
      ? { facts: state.worldMemory.facts.filter((fact) => fact?.predicate === 'discovery').map((fact) => pickKeys(fact, ['predicate', 'supersedes_fact_id'])) }
      : state.worldMemory
  }
  return out
}
const STRIPS = [slim, (state) => (isObject(state) && state.worldMap !== undefined ? { ...slim(state), worldMap: state.worldMap } : slim(state))]

function outcome(name, args) {
  try {
    return { value: viaJson(K[name](...args.map(viaJson))) }
  } catch (error) {
    return { error: String(error?.name) + String(error?.message) }
  }
}

const stats = { stripped: 0, widened: 0, full: 0 }
/** Событие свёртки — до полей, которые читает модуль. */
function slimEvent(event) {
  if (!isObject(event)) return event
  const out = pickKeys(event, ['event_type', 'actor_id', 'target_ids', 'payload'])
  if (isObject(out.payload)) out.payload = pickKeys(out.payload, ['source', 'saved', 'night'])
  return out
}

function prepare(name, args) {
  if (!STATE_FNS.has(name)) return args.map(viaJson)
  if (name === 'applyScenarioKnightEvent' && args.length > 1) {
    const expected = quietly(() => outcome(name, args))
    const candidate = args.map((arg, i) => viaJson(i === 2 ? STRIPS[0](arg) : i === 1 ? slimEvent(arg) : arg))
    if (same(quietly(() => outcome(name, candidate)), expected)) {
      stats.stripped += 1
      return candidate
    }
  }
  const index = FNS[name].states[0]
  // Исход на полном живом состоянии; урезанное — малое, через JSON дёшево.
  const expected = quietly(() => outcome(name, args))
  for (const [level, strip] of STRIPS.entries()) {
    const candidate = args.map((arg, i) => viaJson(i === index ? strip(arg) : arg))
    if (same(quietly(() => outcome(name, candidate)), expected)) {
      stats[level === 0 ? 'stripped' : 'widened'] += 1
      return candidate
    }
  }
  stats.full += 1
  return args.map(viaJson)
}

function record(name, args, cap = Infinity) {
  if ((writer.counts.get(name) ?? 0) >= cap) return false
  return quietly(() => writer.call(name, (...input) => K[name](...input), prepare(name, args), { stateArgs: FNS[name].states, cap }))
}

let captureCap = 400
function capture(module, name, args) {
  if (module !== 'server/scenario-knight.mjs' || !FNS[name]) return
  try {
    record(name, args, captureCap)
  } catch { /* вход не сериализуется */ }
}

// ---------------------------------------------------------------------------
// 1. Сценарии тестов модуля через настоящий движок

const hero = {
  id: 'knight-hero', character: 'Ярра', name: 'Игрок', role: 'Воин · ур. 7', species: 'Человек', background: 'Странник',
  level: 7, hp: 64, maxHp: 64, armor: 18, speed: 30,
}
const keptStates = []
const keep = (state) => { if (keptStates.length < 400) keptStates.push(viaJson(state)) }

async function campaign(code = 'KNIGHT') {
  const initial = rules.normalizeCampaignState(await new CampaignBootstrapper().create({ code, worldTemplateId: 'astohan-plains', players: [hero] }))
  const run = { initial, state: initial, events: [], step: 0 }
  run.apply = (commands, context = { isAdmin: true }, diceService = fixedDice(10)) => {
    run.step += 1
    const list = (Array.isArray(commands) ? commands : [commands]).map((command, index) => ({ command_id: `${code}-${run.step}-${index}`, ...command }))
    try {
      const result = rules.resolveCommands(list, run.state, { diceService, context })
      run.state = rules.normalizeCampaignState(result.state)
      run.events.push(...result.events)
      keep(run.state)
      return result
    } catch {
      return null
    }
  }
  run.travel = async (locationId) => {
    for (let hop = 0; hop < 8 && S.scenarioLocationId(run.state) !== locationId; hop += 1) {
      const { sceneArgs } = await new SceneArchitectAgent().plan({ state: run.state, decision: `Идём в ${locationId}`, destinationLocationId: locationId })
      if (!run.apply({ command_type: 'AdvanceScene', scene_args: sceneArgs })) break
    }
  }
  run.waitUntil = (minuteOfDay) => run.apply({
    command_type: 'AdvanceTime', unit: 'minute', amount: minutesUntilClock(run.state.mechanics.world_time.elapsed_minutes, minuteOfDay),
  })
  return run
}

function discoverChapel(run) {
  const secretId = S.scenarioClueFactId(S.campaignScenario(run.state), 'cliffs-chapel')
  const secret = run.state.worldMemory.facts.find((fact) => fact.id === secretId)
  if (!secret) return
  run.apply({ command_type: 'RecordWorldFact', fact: {
    id: `fact-secret-found-chapel-${run.step}`, subject_id: secret.subject_id, predicate: 'discovery', object: 'clue',
    summary: secret.summary, visibility: 'party', source_event_ids: [], supersedes_fact_id: secretId,
  } })
}

function standAt(run, x, y) {
  const state = structuredClone(run.state)
  state.mechanics.positions = { ...(state.mechanics.positions ?? {}), [hero.id]: { x, y } }
  const player = state.players.find((entry) => entry.id === hero.id)
  player.x = x
  player.y = y
  run.state = rules.normalizeCampaignState(state)
}

function standNextToKnight(run, dx = 1) {
  const placements = run.state.npc_world.placements ?? {}
  const post = placements[KAELAN] ?? Object.values(placements).flat().find((entry) => entry?.npc_id === KAELAN)
  if (post) standAt(run, Number(post.x) + dx, Number(post.y))
}

const scheduler = { isNpcScheduler: true, isAdmin: true, serverAuthoritativeCombat: true }
const director = { isDirector: true }

async function scenarios() {
  // День и ночь в замке, приход и уход.
  {
    const run = await campaign('KN-A')
    await run.travel(CLIFFS)
    run.waitUntil(0)
    campaignStateForViewer(run.state, { role: 'player', heroIds: [hero.id] }, hero.id)
    run.apply({ command_type: 'AdvanceTime', unit: 'minute', amount: 90 })
    campaignStateForViewer(run.state, { role: 'player', heroIds: [hero.id] }, hero.id)
    rules.replayEvents(run.initial, run.events)
  }
  // Ночью пришли, ушли без свидетелей, вернулись.
  {
    const run = await campaign('KN-B')
    await run.travel(CLIFFS)
    run.waitUntil(1_410)
    await run.travel('astohan-mittlayd')
    await run.travel(CLIFFS)
    run.waitUntil(30)
    run.waitUntil(61)
    rules.replayEvents(run.initial, run.events)
  }
  // Голова, защита, бой, ужас, мирный путь.
  for (const [code, release] of [['KN-C', 'religion'], ['KN-D', 'persuasion']]) {
    const run = await campaign(code)
    await run.travel(CLIFFS)
    run.apply({ command_type: 'ReturnKnightHead', actor_id: hero.id }, {})
    run.waitUntil(0)
    run.apply({ command_type: 'ReturnKnightHead', actor_id: hero.id }, {})
    discoverChapel(run)
    standNextToKnight(run, 6)
    run.apply({ command_type: 'ReturnKnightHead', actor_id: hero.id }, {})
    standNextToKnight(run)
    run.apply({ command_type: 'ReleaseCursedKnight', actor_id: hero.id, skill: release }, {})
    run.apply({ command_type: 'ReturnKnightHead', actor_id: hero.id }, {})
    run.apply({ command_type: 'ReturnKnightHead', actor_id: hero.id }, {})
    run.apply({ command_type: 'ReleaseCursedKnight', actor_id: hero.id, skill: release }, {}, minDice())
    run.apply({ command_type: 'ReleaseCursedKnight', actor_id: hero.id, skill: 'persuasion' }, {})
    run.apply({ command_type: 'AdvanceTime', unit: 'minute', amount: 120 })
    run.waitUntil(0)
    standNextToKnight(run)
    run.apply({ command_type: 'ReleaseCursedKnight', actor_id: hero.id, skill: release }, {}, maxDice())
    run.apply({ command_type: 'AdvanceTime', unit: 'minute', amount: 120 })
    run.waitUntil(0)
    rules.replayEvents(run.initial, run.events)
  }
  // Бой: неуязвимость, сопротивление, ужас, падение.
  for (const [code, dice] of [['KN-E', minDice], ['KN-F', maxDice], ['KN-G', () => fixedDice(12)]]) {
    const run = await campaign(code)
    await run.travel(CLIFFS)
    run.waitUntil(0)
    standNextToKnight(run)
    run.apply({ command_type: 'CreateEncounter', npc_id: KAELAN, difficulty: 'deadly', seed: `knight-${code}` }, director)
    run.apply({ command_type: 'StartCombat', server_authoritative: true }, director)
    for (let turn = 0; turn < 6 && run.state.mechanics.combat?.active; turn += 1) {
      const combat = run.state.mechanics.combat
      const active = String(combat.initiative?.[combat.active_index]?.actor_id ?? '')
      if (!active) break
      run.apply({ command_type: 'EndTurn', actor_id: active }, scheduler, dice())
    }
    run.apply({ command_type: 'ApplyDamage', actor_id: hero.id, target_id: KAELAN, amount: 20, damage_type: 'slashing', ruling_id: `dmg-${code}-1` })
    run.apply({ command_type: 'AdvanceTime', unit: 'minute', amount: 120 })
    const withHead = structuredClone(run.state)
    withHead.scenario_knight = { ...withHead.scenario_knight, head_returned: true }
    run.state = rules.normalizeCampaignState(withHead)
    run.apply({ command_type: 'ApplyDamage', actor_id: hero.id, target_id: KAELAN, amount: 20, damage_type: 'slashing', ruling_id: `dmg-${code}-2` })
    run.apply({ command_type: 'ApplyDamage', actor_id: hero.id, target_id: KAELAN, amount: 999, damage_type: 'force', ruling_id: `dmg-${code}-3` })
    run.apply({ command_type: 'EndCombat', actor_id: hero.id, reason: 'enemies_defeated' }, director)
    run.apply({ command_type: 'AdvanceTime', unit: 'minute', amount: 1_440 })
    rules.replayEvents(run.initial, run.events)
  }
  // Разбор намерения игрока.
  {
    const run = await campaign('KN-H')
    for (const message of ['Ставлю голову перед рыцарем', 'Молюсь об упокоении Каэлана', 'Убеждаю рыцаря обрести покой', 'Ждём до полуночи', 'Ждём темноты в укрытии', 'Отдаю голову всаднику', 'Освобождаю Дуннахана от клятвы']) {
      try {
        const intent = await new IntentParser().parse({ message, playerId: hero.id, visibleState: run.state })
        await new Adjudicator().createPlan({ intent, state: run.state, retrievedRules: { results: [], confidence: 1 } })
      } catch { /* разбор без модели */ }
    }
  }
}

const stop = startCapture(capture)
await scenarios()
stop()
console.log('сценарии:', JSON.stringify(stats))

// ---------------------------------------------------------------------------
// 2. Корпус паритета

const dir = corpusDir(process.argv[2])
let corpusCount = 0
if (dir) {
  const astohan = new Set()
  let others = 0
  for (const file of readdirSync(join(dir, 'states')).sort()) {
    const text = corpusStateText(dir, file.replace(/\.json$/u, ''))
    if (!text) continue
    const isAstohan = text.includes('"scenario_id":"astohan')
    if (!isAstohan && (others >= 60 || !chance(0.02))) continue
    let state
    try { state = JSON.parse(text) } catch { continue }
    if (isAstohan) astohan.add(file.replace(/\.json$/u, ''))
    else others += 1
    corpusCount += 1
    for (const name of STATE_FNS) {
      if (name === 'applyScenarioKnightEvent') continue
      const args = name === 'scenarioKnightWard' ? [state, KAELAN] : name === 'scenarioKnightDreadFor' ? [state, state.partyMemberIds?.[0] ?? 'x', 5] : [state]
      record(name, args, 2_500)
    }
    if (isAstohan) {
      record('applyScenarioKnightEvent', [state.scenario_knight, { event_type: 'ScenarioKnightReleaseFailed', actor_id: 'hero', payload: { night: K.scenarioNightIndex(state) } }, state], 2_500)
    }
  }
  // Повтор команд корпуса на состояниях Асстохана под перехватом.
  let replayed = 0
  captureCap = 1_500
  for (const entry of corpusRecords(dir)) {
    if (!astohan.has(entry.state) || replayed >= 600) continue
    const text = corpusStateText(dir, entry.state)
    if (!text) continue
    replayed += 1
    const state = JSON.parse(text)
    const stopCorpus = startCapture(capture)
    try {
      const result = rules.resolveCommand(entry.command, state, { diceService: replayDice(entry.dice), context: entry.context ?? {} })
      ;(entry.outcome?.events ?? result.events ?? []).reduce(rules.applyGameEvent, rules.normalizeCampaignState(state))
    } catch { /* отказ команды — тоже часть корпуса */ }
    stopCorpus()
  }
  console.log(`корпус: состояний ${corpusCount} (Асстохан ${astohan.size}), повторено команд ${replayed}`)
} else {
  console.log('корпус не найден — пропущен')
}
console.log('после корпуса:', JSON.stringify(stats))

// ---------------------------------------------------------------------------
// 3. Случайные входы и мусор старых сохранений

const junk = () => pick([null, undefined, '', 0, -1, 1.5, 'строка', [], {}, [null], { 0: 'x' }, true, false, 'constructor', '__proto__', NaN, 1e21, '  пробелы  внутри  ', ...PROTOTYPE_KEYS])
const ids = () => pick([KAELAN, 'knight-hero', 'other', '', null, undefined, 7, 'constructor', '__proto__', 'toString', ['astohan-kaelan'], ` ${KAELAN}`])
const minutes = () => pick([0, 30, 59, 60, 61, 900, 959, 960, 1_000, 1_379, 1_380, 1_439, 1_440, 2_000, 2_879, 2_880, int(0, 20_000), -5, '960', 'abc', null, undefined, 1.7, 959.5, 9_007_199_254_740_993, 1e20, [960], {}, true])
const locations = [CLIFFS, 'astohan-mittlayd', 'astohan-stormberg', '', 'Замок Забытых Скал', 'Миттлайд', null, 7]

const bases = keptStates.filter((state) => S.campaignScenario(state))
const base = () => structuredClone(pick(bases))

function mutate(state) {
  if (chance(0.6)) state.mechanics.world_time = chance(0.9) ? { ...state.mechanics.world_time, elapsed_minutes: minutes() } : junk()
  if (chance(0.3)) {
    const location = pick(locations)
    state.scene = chance(0.85) ? { ...state.scene, location_id: location, ...(chance(0.3) ? { location: pick(locations) } : {}) } : junk()
    if (chance(0.3) && isObject(state.scene)) delete state.scene.location_id
  }
  if (chance(0.25)) state.mechanics.combat = chance(0.8) ? { ...state.mechanics.combat, active: pick([true, false, 1, 0, '', 'yes', null]) } : junk()
  if (chance(0.2)) state.npc_world = { ...state.npc_world, vitals: chance(0.8) ? { [KAELAN]: { alive: pick([false, true, null, 0, 'false']) } } : junk() }
  if (chance(0.4)) {
    state.scenario_knight = chance(0.7) ? {
      ...(isObject(state.scenario_knight) ? state.scenario_knight : {}),
      head_returned: pick([true, false, 'true', 1, undefined]),
      released: pick([true, false, false, false, 'true', 1, undefined]),
      head_returned_by: pick(['hero', '  a  b ', junk(), 'x'.repeat(300)]),
      attempts: pick([[], ['knight-hero:1'], junk(), Array.from({ length: int(0, 130) }, (_, i) => (chance(0.1) ? junk() : `h${i}:${int(0, 3)}`))]),
      dread_resisted: pick([[], ['knight-hero:0', 'knight-hero:1'], [`knight-hero:${K.scenarioNightIndex(state)}`], junk(), [null, '', ' ', {}, 5]]),
    } : junk()
  }
  if (chance(0.3) && isObject(state.social) && Array.isArray(state.social.npcs)) {
    const npcs = state.social.npcs
    const action = int(0, 4)
    if (action === 0) state.social.npcs = npcs.filter((npc) => npc?.id !== KAELAN)
    else if (action === 1) state.social.npcs = npcs.map((npc) => (npc?.id === KAELAN ? { ...npc, available: pick([true, false, null, undefined, 0, 'no']) } : npc))
    else if (action === 2) state.social.npcs = [null, 5, 'x', { id: KAELAN, available: pick([true, false]) }, ...npcs]
    else if (action === 3) state.social = junk()
    else state.social.npcs = npcs.map((npc) => (npc?.id === KAELAN ? { id: KAELAN, name: 'Каэлан', inventory: null, tags: ['x'], available: pick([true, false]), extra: 1 } : npc))
  }
  if (chance(0.25) && isObject(state.worldMemory)) {
    const id = S.scenarioClueFactId(S.campaignScenario(state) ?? { id: 'astohan-plains' }, 'cliffs-chapel')
    state.worldMemory = { ...state.worldMemory, facts: pick([[], [null, { predicate: 'discovery', supersedes_fact_id: id }], [{ predicate: 'secret', supersedes_fact_id: id }], [{ predicate: 'discovery', supersedes_fact_id: `${id}x` }], junk()]) }
  }
  if (chance(0.2)) state.partyMemberIds = pick([['knight-hero'], [], ['other', 'knight-hero'], [7, null], junk()])
  if (chance(0.05)) state.campaignConcept = pick([junk(), { ...state.campaignConcept, campaign_mode: 'persistent' }, { ...state.campaignConcept, arc: { ...state.campaignConcept.arc, scenario_version: 99 } }])
  return state
}

for (let i = 0; i < 1_500; i += 1) {
  const state = mutate(base())
  const target = ids()
  for (const name of ['scenarioKnightShouldBePresent', 'scenarioKnightPresencePlan', 'scenarioNightIndex', 'scenarioKnightState', 'scenarioKnightRiddleSolved', 'scenarioKnightPresent', 'scenarioKnightRules']) record(name, [state], 3_000)
  record('scenarioKnightWard', chance(0.1) ? [state] : [state, target], 3_000)
  const distance = pick([null, undefined, 0, 5, 29.9, 30, 30.1, 60, -1, '5', NaN, Infinity])
  record('scenarioKnightDreadFor', chance(0.05) ? [state] : [state, pick(['knight-hero', ...[target]]), distance], 3_000)
}

// Свёртка: реестр × событие × состояние.
const eventTypes = [K.SCENARIO_KNIGHT_HEAD_EVENT, K.SCENARIO_KNIGHT_RELEASED_EVENT, K.SCENARIO_KNIGHT_RELEASE_FAILED_EVENT, 'SavingThrowResolved', 'SavingThrowResolved', 'DamageApplied', '', null]
for (let i = 0; i < 1_500; i += 1) {
  const state = chance(0.1) ? mutate(base()) : (chance(0.05) ? { campaignConcept: null } : pick(bases))
  const ledger = chance(0.8) ? mutate(base()).scenario_knight : junk()
  const event = chance(0.08) ? junk() : {
    event_type: pick(eventTypes),
    ...(chance(0.9) ? { actor_id: ids() } : {}),
    ...(chance(0.9) ? { target_ids: pick([['knight-hero'], [], 'knight-hero', { 0: 'hero' }, [null], [7], junk()]) } : {}),
    ...(chance(0.95) ? { payload: chance(0.9) ? {
      source: pick([K.SCENARIO_KNIGHT_DREAD_SOURCE, K.SCENARIO_KNIGHT_DREAD_SOURCE, 'other', null]),
      saved: pick([true, true, false, 'true', 1]),
      night: pick([0, 1, 2, -3, 2.7, -0.5, '4', 'x', null, undefined, 1e21, '1e400', [], [3]]),
    } : junk() } : {}),
  }
  record('applyScenarioKnightEvent', [ledger, event, state], 3_000)
}

// Реестр сам по себе.
for (let i = 0; i < 400; i += 1) record('normalizeScenarioKnightState', chance(0.1) ? [] : [chance(0.6) ? mutate(base()).scenario_knight : junk()], 1_000)

// Окно ночи.
for (let i = 0; i < 400; i += 1) {
  const window = chance(0.9) ? { from_minute: pick([1_380, 60, 0, 600, 1_439, int(0, 1_440)]), to_minute: pick([60, 1_380, 0, 600, int(0, 1_440)]) } : pick([{}, { from_minute: 10 }, { to_minute: 10 }])
  record('minuteInWindow', [pick([0, 59, 60, 61, 1_379, 1_380, 1_439, int(0, 1_439), 0.5, -1]), window], 1_000)
}

// Сценарий: ночные гости и вещи рыцаря.
const scenario = S.campaignScenario(bases[0])
for (const value of [scenario, null, undefined, {}, { knight: null }, { knight: { npc_id: 'x' } }, { knight: { npc_id: 7, release: { reward: { catalog_id: 'c' } } } }, { knight: { npc_id: '', release: { reward: { catalog_id: 'c' } } } }, { knight: { npc_id: 'x', release: { reward: { catalog_id: '' } } } }, { knight: { npc_id: ['a', 'b'], release: { reward: { catalog_id: { a: 1 } } } } }, { knight: { npc_id: true } }, { knight: { npc_id: 0 } }, 'строка', []]) {
  record('scenarioNightVisitorIds', [value])
  record('scenarioKnightStartingInventory', [value])
}

// Фразы игрока.
const verbs = ['Ставлю', 'ставлю', 'Возвращаю', 'Верну', 'Кладу', 'Положу', 'Отдаю', 'Протягиваю', 'Приношу', 'Подаю', 'Водружаю', 'Поставить', 'Переставляю', 'Уставляю', 'Молюсь', 'Молитвой', 'Упокоить', 'Освобождаю', 'Отпускаю', 'Отпусти', 'Убеждаю', 'Уговариваю', 'Благословляю', 'Беру', 'Смотрю на']
const middles = ['', ' ', ' эту ', ' его ', ' голову ', ' об упокоении ', ' рыцаря ', ' призрака. И ', ' перед ним ', ' — ', ' очень-очень долго и упорно, с надеждой и верой в лучшее, по-настоящему тихо и сосредоточенно ', ' ГОЛОВУ ', ' голoву ']
const objects = ['голову', 'Голову', 'головы', 'рыцаря', 'Каэлана', 'Дуннахана', 'всадника', 'стража', 'покой', 'проклятие', 'клятву', 'богов', 'святых', 'мир', 'ЁЖИКА', 'Ёлку', '']
for (let i = 0; i < 1_500; i += 1) {
  const text = chance(0.05) ? junk() : `${chance(0.2) ? pick(['Я ', 'Тихо ', '  ', 'и ']) : ''}${pick(verbs)}${pick(middles)}${pick(objects)}${chance(0.3) ? pick([' перед рыцарем', ' Каэлану', ' богу', '. Потом рыцарь', '!', ' о покое святого', ' обряд']) : ''}`
  record('scenarioKnightActionFromText', [typeof text === 'string' && chance(0.15) ? text.toUpperCase() : text], 3_000)
}
for (const text of ['Ставлю голову перед рыцарем', 'Молюсь об упокоении Каэлана', 'Убеждаю рыцаря обрести покой', 'x'.repeat(1_100) + ' ставлю голову', 'ставлю' + ' '.repeat(2_000) + 'голову', 'поставлю голову 😀', 'ставлю    \n\t голову']) record('scenarioKnightActionFromText', [text])

console.log('итого:', JSON.stringify(stats))
writer.write(new URL('./scenario-knight.json.gz', import.meta.url), {
  constants: {
    SCENARIO_KNIGHT_PRESENCE_EVENT: K.SCENARIO_KNIGHT_PRESENCE_EVENT,
    SCENARIO_KNIGHT_PRESENCE_EVENT_SCHEMA_VERSION: K.SCENARIO_KNIGHT_PRESENCE_EVENT_SCHEMA_VERSION,
    SCENARIO_KNIGHT_SCHEMA_VERSION: K.SCENARIO_KNIGHT_SCHEMA_VERSION,
    SCENARIO_KNIGHT_COMMAND_TYPES: [...K.SCENARIO_KNIGHT_COMMAND_TYPES],
    SCENARIO_KNIGHT_HEAD_EVENT: K.SCENARIO_KNIGHT_HEAD_EVENT,
    SCENARIO_KNIGHT_RELEASED_EVENT: K.SCENARIO_KNIGHT_RELEASED_EVENT,
    SCENARIO_KNIGHT_RELEASE_FAILED_EVENT: K.SCENARIO_KNIGHT_RELEASE_FAILED_EVENT,
    SCENARIO_KNIGHT_DREAD_SOURCE: K.SCENARIO_KNIGHT_DREAD_SOURCE,
  },
})

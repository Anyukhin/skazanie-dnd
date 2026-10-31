import '../../../fixtures-env.mjs'
import { startCapture } from './hook.mjs'
// Эталон server/autonomous-campaign.mjs для Rust:
//
//   node rust/crates/sk-world-story/fixtures/gen-autonomous-campaign.mjs [каталог корпуса]
//
// Источники входов:
//
// - тесты автономного цикла (`autonomous-campaign`, `director-*`,
//   `evening-campaign`, `persistent-campaign`, `quest-progress-evidence`,
//   `encounter-reward`), исполненные в этом же процессе (`node:test`,
//   `isolation: 'none'`): каждый верхний вызов модуля — из теста, из
//   оркестратора, политики цикла и редьюсера Rules Engine — перехватывается;
// - корпус паритета: события записанных команд через `applyGameEvent`;
// - сотни случайных намерений Режиссёра (механика на любой глубине, чужие
//   поля, версии) и цепочек событий `autonomy` с мусором старых сохранений.
import { run } from 'node:test'
import { fileURLToPath } from 'node:url'

import { fixtureWriter, mulberry32, chooser, viaJson, PROTOTYPE_KEYS } from './common.mjs'
import { corpusDir, corpusRecords, corpusState, pickKeys, mapList, moduleCapture } from './lib.mjs'

const a = await import('../../../../server/autonomous-campaign.mjs')
const rules = await import('../../../../server/rules-engine.mjs')
const { ENCOUNTER_THEMES } = await import('../../../../server/encounter-assembler.mjs')
const { withRetentionMode, retentionMode } = await import('../../../../server/retention-context.mjs')

const writer = fixtureWriter('autonomous-campaign', retentionMode)
const random = mulberry32(2026_10_19)
const { int, pick, chance } = chooser(random)

const FNS = {
  normalizeDirectorIntent: { fn: (...args) => a.normalizeDirectorIntent(...args), states: [] },
  normalizeAutonomyState: { fn: (...args) => a.normalizeAutonomyState(...args), states: [], refs: [0] },
  serverReputationDelta: { fn: (...args) => a.serverReputationDelta(...args), states: [] },
  ensureAvailableHook: { fn: (...args) => a.ensureAvailableHook(...args), states: [0] },
  applyAutonomyEvent: { fn: (...args) => a.applyAutonomyEvent(...args), states: [], refs: [0] },
}

const isPlain = (value) => value && typeof value === 'object' && !Array.isArray(value)
function strict(state) {
  if (!isPlain(state)) return state
  const out = pickKeys(state, ['state_version'])
  if (state.autonomy !== undefined) out.autonomy = isPlain(state.autonomy) ? { hooks: mapList(state.autonomy.hooks, (hook) => pickKeys(hook, ['status'])) } : state.autonomy
  if (state.worldMemory !== undefined) out.worldMemory = isPlain(state.worldMemory) ? { quests: mapList(state.worldMemory.quests, (quest) => pickKeys(quest, ['status', 'clock', 'title'])) } : state.worldMemory
  if (state.scene !== undefined) out.scene = isPlain(state.scene) ? pickKeys(state.scene, ['location']) : state.scene
  return out
}
const wide = (state) => (isPlain(state) ? pickKeys(state, ['state_version', 'autonomy', 'worldMemory', 'scene']) : state)
const recorder = moduleCapture({ module: 'server/autonomous-campaign.mjs', fns: FNS, strips: [strict, wide], retentionMode, withRetentionMode, writer, limit: 900 })

const AUTONOMY_EVENTS = new Set([
  'DirectorIntentRecorded', 'DirectorIntentOutcomeRecorded', 'CampaignPacingAdvanced', 'TravelResolved', 'DowntimeResolved',
  'RandomEncounterTriggered', 'NextHookOffered', 'TransitionUnlocked', 'EncounterOutcomeRecorded', 'SceneResolutionRecorded',
  'FactionReputationAdjusted', 'WitnessConsequencePropagated',
])
let quiet = 0
function trimAutonomy(autonomy) {
  const out = { ...autonomy }
  for (const [key, value] of Object.entries(out)) if (Array.isArray(value) && value.length > 3) out[key] = value.slice(-3)
  return out
}
function capture(module, name, args) {
  if (module !== 'server/autonomous-campaign.mjs') return
  if (name === 'applyAutonomyEvent' && !AUTONOMY_EVENTS.has(String(args[1]?.event_type ?? '')) && !args[1]?.payload?.consequence_key) {
    // Чужое событие редьюсер только нормализует: от него остаётся тип.
    if (quiet >= 150 || !chance(0.02)) return
    quiet += 1
    args = [args[0], { event_type: args[1]?.event_type, payload: {} }]
  }
  if (name === 'normalizeAutonomyState' && !chance(0.05)) return
  // Длинные истории живой кампании урезаются до хвоста: редьюсер их только
  // копирует и режет, а JS исполняется заново на урезанном входе.
  if ((name === 'applyAutonomyEvent' || name === 'normalizeAutonomyState') && isPlain(args[0])) args = [trimAutonomy(args[0]), ...args.slice(1)]
  recorder.capture(module, name, args)
}

// ---------------------------------------------------------------------------
// 1. Тесты в этом же процессе
// ---------------------------------------------------------------------------

const TEST_FILES = [
  'autonomous-campaign.test.mjs', 'director-freedom-regression.test.mjs', 'director-three-scenes.test.mjs', 'encounter-reward.test.mjs',
  'evening-campaign.test.mjs', 'persistent-campaign.test.mjs', 'quest-progress-evidence.test.mjs',
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
recorder.flush(400)
const afterTests = writer.cases.length

// ---------------------------------------------------------------------------
// 2. Корпус паритета
// ---------------------------------------------------------------------------

const attempt = (fn) => {
  try {
    return fn()
  } catch {
    return null
  }
}
const dir = process.env.SK_QUICK ? null : corpusDir(process.argv[2])
if (dir) {
  let applied = 0
  for (const entry of corpusRecords(dir)) {
    const events = entry.outcome?.events ?? []
    if (!events.some((event) => AUTONOMY_EVENTS.has(String(event?.event_type ?? '')) || event?.payload?.consequence_key) && !chance(0.002)) continue
    if (applied >= 250) break
    const state = corpusState(dir, entry.state)
    if (!state) continue
    applied += 1
    const stop = startCapture(capture)
    let after = attempt(() => rules.normalizeCampaignState(state))
    for (const event of events) after = attempt(() => rules.applyGameEvent(after, event)) ?? after
    stop()
    recorder.flush(300)
    if (after && chance(0.3)) recorder.record('ensureAvailableHook', [after, pick([undefined, 'fail-safe', 'director', null])], { cap: 1_500 })
  }
  console.log(`корпус: применено ${applied}`)
} else {
  console.log('корпус пропущен')
}
const afterCorpus = writer.cases.length

// ---------------------------------------------------------------------------
// 3. Случайные намерения и цепочки событий
// ---------------------------------------------------------------------------

const ODD = [...PROTOTYPE_KEYS.filter((key) => ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'].includes(key)), '', 'null']
const MECHANICAL = ['hp', 'max_hp', 'maxHp', 'MAX-HP', 'Max_Hp', 'dc', 'DC', 'difficulty_class', 'roll', 'dice', 'price', 'quantity', 'xp', 'xp_budget', 'xpBudget', 'loot', 'coordinates', 'x', 'Y', 'damage', 'armor', 'initiative', 'reputation_delta', 'reputationDelta', 'amount', 'x-', '_x_', 'hp2', 'hps', 'İ', 'damages']
const TEXTS = ['Follow the tracks', '  Северные   ворота ', 'Ｆｕｌｌ', '', 'Я'.repeat(400), 5, null, ['массив', 'строк'], { text: 'объект' }, true]
const IDS = ['marta', 'ledger-quest', 'astohan-sargat', ' npc:1 ', 'bad id', '', ':x', 'a'.repeat(130), 7, null, undefined]

function randomIntent() {
  if (chance(0.03)) return pick([null, 'intent', [], 5, undefined])
  const type = chance(0.85) ? pick(a.DIRECTOR_INTENT_TYPES) : pick(['deal_damage', ' end_scene ', 'END_SCENE', '', 7, ...ODD])
  const intent = { type }
  if (chance(0.7)) intent.theme = chance(0.85) ? pick(ENCOUNTER_THEMES) : pick(['dragon', ' beasts', 'Beasts', 5])
  if (chance(0.7)) intent.difficulty = pick(['easy', 'medium', 'hard', 'deadly', 'impossible', 'Easy'])
  if (chance(0.5)) intent.npc_id = pick(IDS)
  if (chance(0.5)) intent.quest_id = pick(IDS)
  if (chance(0.4)) intent.hook = pick(TEXTS)
  if (chance(0.4)) intent.destination = pick(TEXTS)
  if (chance(0.4)) intent.resolution = pick(['negotiation', 'objective', 'decision', 'surrender', 1])
  if (chance(0.4)) intent.reason = pick([...TEXTS, { nested: { deeper: pick(['ok', 1]) } }, { [pick(MECHANICAL)]: 1 }, [{ [pick(MECHANICAL)]: 1 }], [[{ ok: 1 }]]])
  if (chance(0.2)) intent.version = pick([a.DIRECTOR_INTENT_VERSION, 'skazanie:director-intent-v0', null, 1])
  if (chance(0.12)) intent[pick(MECHANICAL)] = pick([1, 0, null, 'x'])
  if (chance(0.08)) intent[pick(['extra', 'Type', '0', '10', 'zeta', ...ODD.filter(Boolean)])] = 1
  return intent
}

function randomAutonomy() {
  if (chance(0.05)) return pick([null, undefined, 'autonomy', [], 5])
  const list = (length, make) => (chance(0.1) ? pick(['list', null, {}]) : Array.from({ length }, make))
  return {
    ...(chance(0.6) ? { director_history: list(int(0, 4), (_, i) => ({ type: 'continue_exploration', at: i })) } : {}),
    ...(chance(0.4) ? { director_outcomes: list(int(0, 3), (_, i) => ({ ok: i % 2 === 0 })) } : {}),
    ...(chance(0.6) ? { hooks: list(int(0, 4), (_, i) => pick([{ id: `hook-${i}`, text: 'Тропа', status: pick(['available', 'used']) }, { id: `hook-${i % 2}`, status: 'available' }, { text: 'без id' }, { id: 5, status: 'used' }])) } : {}),
    ...(chance(0.3) ? { transitions: list(int(0, 3), (_, i) => ({ id: `t-${i}` })) } : {}),
    ...(chance(0.3) ? { encounter_outcomes: list(int(0, 3), (_, i) => ({ encounter_id: `e-${i}` })) } : {}),
    ...(chance(0.6) ? { reputations: pick([{ crown: 5, guild: -120, ' mill ': '7', '': 3, x: 2.5, y: 'abc', 12: 4, 3: 1, constructor: 2 }, {}, null, ['a', 'b'], 'str', { [pick(ODD)]: 9 }]) } : {}),
    ...(chance(0.3) ? { witness_graph: list(int(0, 2), () => ({ outcome: 'helpful' })) } : {}),
    ...(chance(0.6) ? { pacing: pick([{ beat: pick([3, '4', -2, 'x', 2.5, 'Infinity', null]), phase: pick(['breather', 'climax', 'chaos', 5]), tension: pick([50, 150, -5, '30', 'abc']), last_intent_type: pick(['end_scene', '  x  ', 5, null]) }, null, [], 'pacing']) } : {}),
    ...(chance(0.4) ? { applied_consequences: pick([['a', 'a', ' b ', '', null, 5], 'x']) } : {}),
    ...(chance(0.3) ? { admin_interventions: pick([2, -3, '4', 1.5, 'x', null]) } : {}),
    ...(chance(0.2) ? { schema_version: pick([1, 2, 3]) } : {}),
  }
}

function randomEvent(index) {
  const type = pick([...AUTONOMY_EVENTS, 'NpcDied', 'Unrelated', 'FactionReputationAdjusted', 'CampaignPacingAdvanced', 'NextHookOffered'])
  const payloads = {
    CampaignPacingAdvanced: () => ({ beat: pick([0, 1, 5, '6', -3, 'x', 'Infinity', 2.5, undefined]), phase: pick(['development', 'escalation', 'climax', 'nope', undefined]), tension_after: pick([10, 60, 140, -1, '25', 'x', undefined]), intent_type: pick(['request_encounter', '   end_scene  ', 9, undefined]) }),
    NextHookOffered: () => ({ hook: pick([{ id: `hook-${index % 3}`, text: 'Зацепка', status: 'available' }, { text: 'без id' }, undefined, null, 'hook', { id: 5 }]) }),
    TransitionUnlocked: () => ({ transition: pick([{ id: `t-${index}` }, undefined, null]) }),
    FactionReputationAdjusted: () => ({ faction_id: pick(['crown', 'guild', ' crown ', '', 12, ...ODD]), delta: pick([1, -3, 5, '7', 0, null, 2.5, 'abc', 250, [4], true]) }),
    Unrelated: () => ({ note: 'x' }),
    NpcDied: () => ({ npc_id: 'n' }),
  }
  const payload = chance(0.04) ? pick([null, 'payload', 5, []]) : (payloads[type]?.() ?? { step: index, kind: type })
  if (isPlain(payload) && chance(0.2)) payload.consequence_key = pick([`key-${index % 4}`, '  key-0 ', '', 0, 'Я'.repeat(200), 5])
  return { event_type: type, ...(payload === undefined ? {} : { payload }) }
}

const REPUTATION = [
  undefined, {}, { severity: 'major' }, { outcome: 'helpful' }, { outcome: 'harmful', severity: 'major' }, { outcome: 'neutral', severity: 'minor' },
  { outcome: 'helpful', severity: 'grave' }, { outcome: 'evil' }, { severity: null }, { outcome: null }, { outcome: 'helpful', severity: 'constructor' },
  { outcome: 'constructor' }, { outcome: '__proto__', severity: '__proto__' }, { outcome: '__proto__', severity: 'toString' }, { outcome: 'toString', severity: 'valueOf' },
  { outcome: 'helpful', severity: '__proto__' }, { outcome: ['helpful'], severity: ['major'] }, { severity: 5 },
]
// Пределы длины — отдельными случаями, а не в каждой цепочке: такие входы крупные.
const LONG = [
  { reputations: Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`f-${i}`, i])) },
  { applied_consequences: Array.from({ length: 2_005 }, (_, i) => `c-${i % 2_003}`) },
  { travel_history: Array.from({ length: 205 }, (_, i) => i), hooks: Array.from({ length: 103 }, (_, i) => ({ id: `h-${i}` })), director_history: Array.from({ length: 503 }, (_, i) => i) },
]
for (const autonomy of LONG) {
  recorder.record('normalizeAutonomyState', [autonomy], { cap: 1_500 })
  recorder.record('applyAutonomyEvent', [autonomy, { event_type: 'FactionReputationAdjusted', payload: { faction_id: 'f-204', delta: 3, consequence_key: 'c-new' } }], { cap: 4_000 })
}
for (const options of REPUTATION) recorder.record('serverReputationDelta', options === undefined ? [] : [options], { cap: 200 })

for (let index = 0; index < Number(process.env.SK_ITER ?? 500); index += 1) {
  recorder.record('normalizeDirectorIntent', [randomIntent()], { cap: 4_000 })
  let autonomy = randomAutonomy()
  recorder.record('normalizeAutonomyState', [autonomy], { cap: 1_500 })
  for (let step = int(1, 6); step > 0; step -= 1) {
    const event = randomEvent(index * 10 + step)
    recorder.record('applyAutonomyEvent', [autonomy, event], { cap: 4_000 })
    autonomy = attempt(() => a.applyAutonomyEvent(viaJson(autonomy), viaJson(event))) ?? autonomy
  }
  const state = {
    ...(chance(0.8) ? { state_version: pick([0, 3, 12, '7', null]) } : {}),
    autonomy: chance(0.1) ? pick([null, 'x']) : autonomy,
    ...(chance(0.6) ? { worldMemory: { quests: pick([[], [{ id: 'q', title: 'Пропавший караван', status: 'active' }], [{ status: 'active', clock: { triggered: true }, title: 'Старое' }, { status: 'active', title: pick(['Новое', 5, null, undefined]) }], [{ status: 'done', title: 'x' }]]) } } : {}),
    ...(chance(0.7) ? { scene: { location: pick(['Тихий Брод', '  Мельница  ', '', 5, null]) } } : {}),
  }
  recorder.record('ensureAvailableHook', [state, pick([undefined, 'fail-safe', 'director', null, 7, { origin: 'x' }])], { cap: 2_000 })
}

writer.write(new URL('./autonomous-campaign.json', import.meta.url))
console.log(`тесты ${afterTests}, корпус ${afterCorpus - afterTests}, случайные ${writer.cases.length - afterCorpus}`)
console.log('урезание:', recorder.stats)

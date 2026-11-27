import '../../../fixtures-env.mjs'
import { startCapture, quietly } from './story-hook.mjs'
// Эталон server/offscreen-world.mjs для Rust:
//
//   node rust/crates/sk-world-story/fixtures/gen-offscreen-world.mjs [каталог корпуса]
//
// Источники входов:
//
// - `test/offscreen-world.test.mjs` и `test/offscreen-world-ui-contract.test.mjs`
//   целиком под перехватом: ход времени через настоящий Rules Engine, replay,
//   проекция, рекап — каждый верхний вызов модуля из конвейера записывается;
// - корпус паритета: ход мира, лента и антагонист по состояниям кампаний;
// - сотни случайных кампаний «каравана» (задания с часами, фракции со славой
//   и тегами, NPC, торговцы, поступки и молва, прежняя лента) и цепочки ходов
//   мира через свёртку; мусор старых сохранений в реестре и событиях.
//
// Состояние урезается (без `locationMaps`, клеток сцены и журналов); JS
// исполняется заново на урезанном входе и сверяется с исходом на полном.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { fixtureWriter, mulberry32, chooser, viaJson, same, PROTOTYPE_KEYS, corpusDir, corpusStateText } from './story-lib.mjs'

const root = new URL('../../../../', import.meta.url)
const O = await import(new URL('server/offscreen-world.mjs', root).href)
const { normalizeCampaignState, applyGameEvent } = await import(new URL('server/rules-engine.mjs', root).href)

const writer = fixtureWriter('offscreen-world', ['campaignConcept', 'worldMap', 'map', 'social', 'npc_world', 'worldMemory'])
const random = mulberry32(2026_10_17)
const { int, pick, chance } = chooser(random)

const FNS = {
  offscreenCampaignDay: { states: [] },
  normalizeOffscreenWorldState: { states: [] },
  antagonistFactionFor: { states: [0] },
  planOffscreenWorldStep: { states: [0] },
  offscreenLinesFor: { states: [] },
  applyOffscreenWorldEvent: { states: [] },
  offscreenWorldFeed: { states: [0] },
  offscreenChronicleEntry: { states: [] },
}
const STRIPPED = new Set(['antagonistFactionFor', 'planOffscreenWorldStep', 'offscreenWorldFeed'])
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)
const DROP = ['locationMaps', 'events', 'chronicle', 'history', 'transcript', 'narration_log', 'usage', 'rulings', 'combatLog']
function slim(state) {
  if (!isObject(state)) return state
  const out = { ...state }
  for (const key of DROP) delete out[key]
  if (isObject(out.scene)) {
    out.scene = { ...out.scene }
    delete out.scene.cells
    delete out.scene.map
  }
  return out
}

function outcome(name, args) {
  try {
    return { value: viaJson(O[name](...args)) }
  } catch (error) {
    return { error: String(error?.name) + String(error?.message) }
  }
}

const stats = { stripped: 0, full: 0 }
function prepare(name, args) {
  if (!STRIPPED.has(name)) return args.map(viaJson)
  const expected = quietly(() => outcome(name, args.map(viaJson)))
  const candidate = args.map((arg, index) => viaJson(index === 0 ? slim(arg) : arg))
  if (same(quietly(() => outcome(name, candidate)), expected)) {
    stats.stripped += 1
    return candidate
  }
  stats.full += 1
  return args.map(viaJson)
}

function record(name, args, cap = Infinity) {
  if ((writer.counts.get(name) ?? 0) >= cap) return false
  return quietly(() => writer.call(name, (...input) => O[name](...input), prepare(name, args), { stateArgs: FNS[name].states, cap }))
}

function capture(module, name, args) {
  if (module !== 'server/offscreen-world.mjs' || !FNS[name]) return
  try {
    record(name, args, 800)
  } catch { /* вход не сериализуется */ }
}

// ---------------------------------------------------------------------------
// 1. Тесты модуля под перехватом

const stop = startCapture(capture)
const finished = new Promise((resolve) => {
  process.once('beforeExit', resolve)
})
await import(new URL('test/offscreen-world.test.mjs', root).href)
await import(new URL('test/offscreen-world-ui-contract.test.mjs', root).href)
await finished
stop()
console.log('тесты:', JSON.stringify(stats), JSON.stringify(Object.fromEntries(writer.counts)))

// ---------------------------------------------------------------------------
// 2. Случайные кампании и цепочки ходов мира

const junk = () => pick([null, undefined, '', 0, -3, 7.5, 'строка', [], {}, [null], true, '  ', ...PROTOTYPE_KEYS.slice(0, 4)])
const VIS = ['party', 'public', 'gm_only', '', undefined, ' party ', 'PARTY', null]
const TITLES = ['Караван у брода', 'Найти в «Скале» другой путь к разгадке: тайна, которую хранит старый мельник у запруды на окраине, ведь иначе', 'Дело', '', 'x'.repeat(200), 'Спасти   детей.   ', 'Короткое: имя задания', 'Очень длинное название задания без двоеточия которое никак не помещается в семьдесят знаков подряд никак']
function quest(index) {
  const max = pick([4, 4, 6, 1, 2, 0, '5', null, undefined])
  return {
    id: chance(0.95) ? pick([`quest-${index}`, `q${int(0, 30)}`, 'constructor', 'Б-квест', `quest-${index}`]) : junk(),
    title: pick(TITLES),
    summary: pick(['Ждут помощи.', '', 'Длинное описание '.repeat(int(1, 80))]),
    status: pick(['active', 'active', 'active', 'completed', 'failed', undefined]),
    visibility: pick(VIS),
    entity_ids: [],
    objectives: [],
    clock: chance(0.9) ? { current: pick([0, 1, 2, 3, 4, 5, '2', -1, null]), max, ...(chance(0.15) ? { triggered: pick([true, false, 'true']) } : {}) } : junk(),
  }
}
function faction(index) {
  return {
    id: chance(0.95) ? pick([`faction-${index}`, 'faction-wolves', 'faction-cult', `f${int(0, 9)}`]) : junk(),
    kind: pick(['faction', 'faction', 'faction', 'person', undefined]),
    name: pick(['Волчья ватага', 'Круг', '', '  Серые   плащи  ', undefined]),
    visibility: pick(VIS),
    tags: pick([[], ['antagonist'], ['enemy', 'x'], ['hostile'], [' antagonist '], junk(), [null]]),
  }
}
function npc(index) {
  return {
    id: chance(0.95) ? pick([`npc-${index}`, 'innkeeper', 'miller', 'merchant-1', `n${int(0, 20)}`]) : junk(),
    name: pick(['Ждан', 'Мельник Гость', '', 'Тень', undefined, '  Ольха  ']),
    role: 'житель',
    location: pick(['Тихий Брод', 'Мельница', 'Город']),
    location_id: pick(['village', 'mill', undefined]),
    visibility: pick(VIS),
    available: pick([true, true, false, undefined, 0]),
    ...(chance(0.3) ? { schedule: pick([[{ from: 360, to: 1_200, location: 'Мельница', available: true }], ['утро', null, 5], [], junk()]) } : {}),
    ...(chance(0.2) ? { dossier: { notes: 'досье' } } : {}),
    public_summary: 'Житель.',
  }
}
function step(index) {
  return {
    id: chance(0.9) ? pick([`offscreen:${index}`, `offscreen:${int(0, 9)}`, 'bad id!', '', '-x']) : junk(),
    at_minutes: pick([0, 480, 1_440, int(0, 20_000), '900', -5, null]),
    elapsed_minutes: pick([480, 1_440, undefined, 'x']),
    ...(chance(0.7) ? { day: pick([1, 2, 0, -1, 'x', undefined, 3.5]) } : {}),
    entries: chance(0.9) ? Array.from({ length: int(0, 14) }, () => (chance(0.9) ? {
      kind: pick(['quest_clock', 'quest_deadline', 'quest_expired', 'faction_move', 'rumor_spread', 'unknown', 'constructor']),
      summary: pick(['Срок поджимает.', '', 'Молва идёт.', 'x'.repeat(500)]),
      quest_id: pick(['quest-1', '', undefined]),
      quest_title: pick(TITLES),
      faction_id: pick(['faction-wolves', '', undefined]),
      move_kind: pick(['took_hostage', 'moved_camp', 'reinforced_posts', 'burned_town', '']),
      npc_id: pick(['miller', '', undefined]),
      count: pick([1, 3, -2, '4', null]),
    } : junk())) : junk(),
    lines: pick([['Строка.'], [], ['', '  a  ', 'b', 'c', 'd'], junk()]),
  }
}
function ledger() {
  if (chance(0.15)) return junk()
  return {
    ...(chance(0.6) ? { schema_version: pick([1, 1, 2, '1']) } : {}),
    steps: chance(0.9) ? Array.from({ length: int(0, chance(0.1) ? 45 : 4) }, (_, index) => (chance(0.97) ? step(index) : junk())) : junk(),
    watch: chance(0.8) ? Array.from({ length: int(0, chance(0.1) ? 20 : 3) }, () => (chance(0.95) ? { quest_id: pick(['quest-0', 'quest-1', 'q3', '', 'quest-2']), since_minutes: pick([0, 100, 1_440, '50', null]) } : junk())) : junk(),
  }
}
function campaign() {
  // Мусор, на котором падает сама нормализация кампании, — не вход модуля.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { return rawCampaign() } catch { /* следующая попытка */ }
  }
  return normalizeCampaignState({})
}
function rawCampaign() {
  const minutes = pick([0, 480, 1_440, int(0, 30_000), 'x'])
  return normalizeCampaignState({
    sessionCode: pick(['OFFSCREEN', 'K2', '']),
    campaign: 'Караван',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Ада', hp: 12, maxHp: 12, inventory: [] }],
    scene: { title: pick(['Двор постоялого', '']), location: pick(['Тихий Брод', 'Мельница', '', undefined]), location_id: pick(['village', 'mill']), cells: [] },
    worldMap: {
      seed: pick(['offscreen-seed', 'other-seed', '']),
      currentLocationId: 'village',
      locations: [
        { id: 'village', name: 'Тихий Брод', kind: 'village', x: 100, y: 300 },
        { id: 'mill', name: 'Мельница', kind: 'landmark', x: 300, y: 300 },
      ],
      routes: [{ id: 'r1', from: 'village', to: 'mill', kind: 'road' }],
    },
    social: { npcs: Array.from({ length: int(0, 6) }, (_, index) => npc(index)) },
    worldMemory: {
      entities: Array.from({ length: int(0, 4) }, (_, index) => faction(index)),
      quests: Array.from({ length: int(0, 7) }, (_, index) => quest(index)),
      summaries: [],
    },
    autonomy: { reputations: chance(0.8) ? { 'faction-wolves': pick([-30, -1, 0, 5]), 'faction-0': pick([-5, -30, 2, '-7']), 'faction-1': pick([-30, -2]) } : junk() },
    mechanics: { world_time: { elapsed_minutes: minutes } },
    ...(chance(0.3) ? { merchants: [{ id: pick(['merchant-1', 'miller', 'npc-0']), name: 'Купец' }] } : {}),
    ...(chance(0.25) ? { world_deeds: { deeds: [{ id: 'deed-1', summary: 'Отряд спас мельника.', location_id: 'village', recorded_at_minutes: 0, spread_at_minutes: pick([0, 600, 2_000]), secret: chance(0.2) }] } } : {}),
    ...(chance(0.6) ? { offscreen_world: ledger() } : {}),
  })
}

let chains = 0
for (let index = 0; index < 500; index += 1) {
  let state = campaign()
  record('antagonistFactionFor', [state], 3_000)
  record('offscreenWorldFeed', chance(0.3) ? [state, { limit: pick([1, 5, 0, -3, 100, '3', null, undefined]) }] : [state], 3_000)
  for (let hop = 0; hop < int(1, 5); hop += 1) {
    const jump = pick([10, 479, 480, 720, 1_440, 1_441, 2_880, 43_200, '600', null, undefined, -1])
    record('planOffscreenWorldStep', chance(0.05) ? [state] : [state, { elapsedMinutes: jump }], 6_000)
    const planned = quietly(() => O.planOffscreenWorldStep(state, { elapsedMinutes: jump }))
    if (!planned) continue
    chains += 1
    for (const draft of planned.drafts) {
      if (draft.event_type === O.OFFSCREEN_WORLD_EVENT_TYPE) {
        record('applyOffscreenWorldEvent', [state.offscreen_world, draft], 6_000)
        record('offscreenChronicleEntry', [draft], 3_000)
      }
    }
    try {
      const events = planned.drafts.map((draft, i) => ({ event_id: `e-${index}-${hop}-${i}`, version: i + 1, ...draft }))
      state = events.reduce((next, event) => quietly(() => applyGameEvent(next, event)), state)
      state = normalizeCampaignState({ ...state, mechanics: { ...state.mechanics, world_time: { ...state.mechanics.world_time, elapsed_minutes: Number(state.mechanics.world_time.elapsed_minutes) + (Number(jump) || 0) } } })
    } catch { break }
    record('offscreenWorldFeed', [state], 3_000)
  }
}
console.log('цепочек:', chains)

// Реестр, строки, свёртка, карточка — на мусоре.
for (let index = 0; index < 600; index += 1) {
  record('normalizeOffscreenWorldState', chance(0.05) ? [] : [ledger()], 2_000)
  const entries = chance(0.9) ? (step(index).entries ?? []) : junk()
  record('offscreenLinesFor', chance(0.05) ? [] : [entries], 2_000)
  const event = chance(0.1) ? junk() : {
    event_type: pick([O.OFFSCREEN_WORLD_EVENT_TYPE, O.OFFSCREEN_WORLD_EVENT_TYPE, 'Other', null]),
    payload: chance(0.9) ? { step: chance(0.9) ? step(index) : junk(), ...(chance(0.6) ? { watch_after: pick([[{ quest_id: 'q', since_minutes: 3 }], [], junk()]) } : {}) } : junk(),
  }
  record('applyOffscreenWorldEvent', [ledger(), event], 8_000)
  record('offscreenChronicleEntry', chance(0.03) ? [] : [event], 4_000)
  record('offscreenCampaignDay', [pick([0, 479, 480, 1_380, 1_440, 2_000, int(0, 50_000), -10, '900', null, undefined, 'x', 1e20])], 1_000)
}

// ---------------------------------------------------------------------------
// 3. Корпус паритета

const dir = corpusDir(process.argv[2])
if (dir) {
  let taken = 0
  for (const file of readdirSync(join(dir, 'states')).sort()) {
    if (taken >= 260) break
    if (!chance(0.05)) continue
    const text = corpusStateText(dir, file.replace(/\.json$/u, ''))
    if (!text || text.length > 900_000) continue
    let state
    try { state = JSON.parse(text) } catch { continue }
    taken += 1
    record('antagonistFactionFor', [state], 6_000)
    record('offscreenWorldFeed', [state], 6_000)
    for (const jump of [480, 1_440, 4_320]) record('planOffscreenWorldStep', [state, { elapsedMinutes: jump }], 9_000)
  }
  console.log(`корпус: состояний ${taken}`)
} else {
  console.log('корпус не найден — пропущен')
}

console.log('итого:', JSON.stringify(stats))
writer.write(new URL('./offscreen-world.json.gz', import.meta.url), {
  constants: {
    OFFSCREEN_WORLD_SCHEMA_VERSION: O.OFFSCREEN_WORLD_SCHEMA_VERSION,
    OFFSCREEN_WORLD_POLICY_ID: O.OFFSCREEN_WORLD_POLICY_ID,
    OFFSCREEN_WORLD_EVENT_TYPE: O.OFFSCREEN_WORLD_EVENT_TYPE,
    OFFSCREEN_CARD_TITLE: O.OFFSCREEN_CARD_TITLE,
    OFFSCREEN_CARD_TITLE_PREFIX: O.OFFSCREEN_CARD_TITLE_PREFIX,
    OFFSCREEN_STEP_MINIMUM_MINUTES: O.OFFSCREEN_STEP_MINIMUM_MINUTES,
    OFFSCREEN_STEP_INTERVAL_MINUTES: O.OFFSCREEN_STEP_INTERVAL_MINUTES,
    OFFSCREEN_QUEST_EXPIRY_MINUTES: O.OFFSCREEN_QUEST_EXPIRY_MINUTES,
    OFFSCREEN_QUEST_TICK_LIMIT: O.OFFSCREEN_QUEST_TICK_LIMIT,
    FACTION_MOVE_KINDS: [...O.FACTION_MOVE_KINDS],
    OFFSCREEN_ENTRY_LABELS: O.OFFSCREEN_ENTRY_LABELS,
  },
})

import '../../../fixtures-env.mjs'
import { startCapture } from './hook.mjs'
// Эталон server/courier-letters.mjs для Rust:
//
//   node rust/crates/sk-world-life/fixtures/gen-courier-letters.mjs [каталог корпуса]
//
// Источники входов:
//
// - тесты `test/courier-letters.test.mjs` и `test/courier-letters-ui-contract.test.mjs`,
//   исполненные в этом же процессе (`node:test`, `isolation: 'none'`): каждый
//   верхний вызов модуля — из теста или изнутри Rules Engine и проекции —
//   перехватывается хуком;
// - батарея прямых вызовов над перехваченными состояниями;
// - корпус паритета: состояния кампаний и повтор записанных команд;
// - сотни случайных писем, карт мира и цепочек событий с мусором старых
//   сохранений (`null` в коллекциях, ключи прототипа как id, строки вместо чисел).
//
// Состояния урезаются до полей, которые читает модуль; JS исполняется заново
// на урезанном входе и сверяется с исходом на полном — Rust получает ровно его.
import { run } from 'node:test'
import { fileURLToPath } from 'node:url'

import { fixtureWriter, mulberry32, chooser, viaJson, PROTOTYPE_KEYS } from './common.mjs'
import { corpusDir, corpusRecords, corpusState, replayDice, pickKeys, mapList, moduleCapture } from './lib.mjs'

const c = await import('../../../../server/courier-letters.mjs')
const rules = await import('../../../../server/rules-engine.mjs')
const { withRetentionMode, retentionMode } = await import('../../../../server/retention-context.mjs')
const { campaignStateForViewer } = await import('../../../../server/viewer-projection.mjs')

const writer = fixtureWriter('courier-letters', retentionMode)
const random = mulberry32(2026_10_16)
const { int, pick, chance } = chooser(random)

const FNS = {
  normalizeCourierLetterState: { fn: (...args) => c.normalizeCourierLetterState(...args), states: [], refs: [0] },
  applyCourierLetterEvent: { fn: (...args) => c.applyCourierLetterEvent(...args), states: [], refs: [0] },
  worldLeaguesBetween: { fn: (...args) => c.worldLeaguesBetween(...args), states: [], refs: [0] },
  courierToneFor: { fn: (...args) => c.courierToneFor(...args), states: [] },
  // Четвёртый аргумент — внутренний счёт прохода с функциями; через JSON он не
  // переходит, и вызов записывается без него.
  courierAddresseeFor: { fn: (state, kind, id) => c.courierAddresseeFor(state, kind, id), states: [0] },
  courierLetterAddressees: { fn: (...args) => c.courierLetterAddressees(...args), states: [0] },
  courierLettersFor: { fn: (...args) => c.courierLettersFor(...args), states: [0] },
  openCourierLettersFor: { fn: (...args) => c.openCourierLettersFor(...args), states: [0] },
  courierLetterPromiseFrom: { fn: (...args) => c.courierLetterPromiseFrom(...args), states: [] },
  courierLetterReplyBase: { fn: (...args) => c.courierLetterReplyBase(...args), states: [], refs: [0] },
  courierLetterReplyFor: { fn: (...args) => c.courierLetterReplyFor(...args), states: [], refs: [0] },
  planCourierLetter: { fn: (...args) => c.planCourierLetter(...args), states: [0] },
  planCourierLetterTicks: { fn: (...args) => c.planCourierLetterTicks(...args), states: [0] },
  courierLetterForViewer: { fn: (...args) => c.courierLetterForViewer(...args), states: [], refs: [0] },
  courierLettersForViewer: { fn: (...args) => c.courierLettersForViewer(...args), states: [0] },
  courierLetterChronicleEntry: { fn: (...args) => c.courierLetterChronicleEntry(...args), states: [] },
}

const NPC_KEYS = ['id', 'name', 'role', 'tags', 'location', 'location_id', 'locationId', 'available', 'visibility', 'reveal_on_presence', 'public_summary', 'post_assets', 'post_terrain', 'faction_id', 'schedule']
const ACTOR_KEYS = ['id', 'actor_id', 'name', 'x', 'y', 'hp', 'maxHp', 'alive', 'footprint', 'origin', 'size']
const READS = {
  courierLettersFor: ['courier_letters'],
  openCourierLettersFor: ['courier_letters'],
  planCourierLetterTicks: ['courier_letters', 'mechanics', 'social', 'npc_world', 'enemies', 'actors', 'worldMemory', 'merchants', 'autonomy'],
}

function strict(state, { map = false } = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  const out = pickKeys(state, ['npc_world', 'scene_npcs', 'entities', 'courier_letters'])
  if (state.merchants !== undefined) out.merchants = mapList(state.merchants, (merchant) => pickKeys(merchant, ['id', 'name', 'title', 'location', 'available', 'description', 'greeting', 'voice', 'role', 'tags']))
  if (state.scene !== undefined) out.scene = map ? state.scene : pickKeys(state.scene, ['title', 'location', 'location_id', 'locationId'])
  if (state.social !== undefined) {
    out.social = state.social && typeof state.social === 'object' && !Array.isArray(state.social)
      ? { npcs: mapList(state.social.npcs, (npc) => pickKeys(npc, NPC_KEYS)), relationships: state.social.relationships }
      : state.social
  }
  for (const key of ['players', 'enemies', 'actors']) if (state[key] !== undefined) out[key] = mapList(state[key], (actor) => pickKeys(actor, ACTOR_KEYS))
  if (state.mechanics && typeof state.mechanics === 'object') {
    out.mechanics = pickKeys(state.mechanics, ['world_time', 'positions'])
    if (state.mechanics.combat !== undefined) out.mechanics.combat = state.mechanics.combat && typeof state.mechanics.combat === 'object' ? { active: state.mechanics.combat.active } : state.mechanics.combat
  } else if (state.mechanics !== undefined) out.mechanics = state.mechanics
  if (state.worldMemory && typeof state.worldMemory === 'object') out.worldMemory = { entities: state.worldMemory.entities }
  else if (state.worldMemory !== undefined) out.worldMemory = state.worldMemory
  if (state.worldMap && typeof state.worldMap === 'object') {
    out.worldMap = pickKeys(state.worldMap, ['locations', 'routes', 'currentLocationId'])
    out.worldMap.locations = mapList(out.worldMap.locations, (node) => pickKeys(node, ['id', 'name', 'x', 'y']))
    out.worldMap.routes = mapList(out.worldMap.routes, (route) => pickKeys(route, ['from', 'to', 'distance', 'discovered']))
    if (out.worldMap.routes === undefined) delete out.worldMap.routes
    if (out.worldMap.locations === undefined) delete out.worldMap.locations
  }
  else if (state.worldMap !== undefined) out.worldMap = state.worldMap
  if (state.autonomy && typeof state.autonomy === 'object') out.autonomy = pickKeys(state.autonomy, ['reputations'])
  else if (state.autonomy !== undefined) out.autonomy = state.autonomy
  return out
}
function minimal(state, name) {
  const out = strict(state)
  if (!READS[name] || !out || typeof out !== 'object' || Array.isArray(out)) return out
  return pickKeys(out, READS[name])
}
const wide = (state) => (state && typeof state === 'object' && !Array.isArray(state)
  ? pickKeys(state, ['scene', 'worldMap', 'social', 'npc_world', 'mechanics', 'enemies', 'actors', 'players', 'entities', 'scene_npcs', 'worldMemory', 'autonomy', 'courier_letters', 'merchants'])
  : state)

const recorder = moduleCapture({ module: 'server/courier-letters.mjs', fns: FNS, strips: [minimal, (state) => strict(state), (state) => strict(state, { map: true }), wide], retentionMode, withRetentionMode, writer, limit: 900 })
const LETTER_EVENTS = new Set(Object.values(c.COURIER_LETTER_EVENT_TYPES))
let quiet = 0
const seenStates = []
function capture(module, name, args) {
  if (module !== 'server/courier-letters.mjs') return
  if (name === 'applyCourierLetterEvent' && !LETTER_EVENTS.has(String(args[1]?.event_type ?? ''))) {
    if (quiet >= 250 || !chance(0.05)) return
    quiet += 1
    // Чужое событие почту не трогает: его полезная нагрузка (сцены, карты) не нужна.
    const event = args[1]
    args = [args[0], event && typeof event === 'object' ? { event_type: event.event_type, payload: pickKeys(event.payload, ['letter_id']) } : event]
  }
  if (name === 'normalizeCourierLetterState' && !(args[0]?.letters?.length) && !chance(0.02)) return
  if (['planCourierLetterTicks', 'courierLetterAddressees', 'courierLettersForViewer'].includes(name) && seenStates.length < 400 && chance(0.3)) {
    try {
      seenStates.push(viaJson(args[0]))
    } catch { /* не сериализуется */ }
  }
  recorder.capture(module, name, args)
}

// ---------------------------------------------------------------------------
// 1. Тесты модуля в этом же процессе
// ---------------------------------------------------------------------------

const testFile = (name) => fileURLToPath(new URL(`../../../../test/${name}`, import.meta.url))
const stopCapture = startCapture(capture)
let passed = 0
let failed = 0
for await (const event of run({ files: [testFile('courier-letters.test.mjs'), testFile('courier-letters-ui-contract.test.mjs')], isolation: 'none' })) {
  if (event.type === 'test:pass') passed += 1
  if (event.type === 'test:fail') {
    failed += 1
    console.log('упал тест:', event.data?.name, String(event.data?.details?.error?.cause?.message ?? event.data?.details?.error?.message ?? '').slice(0, 300))
  }
}
stopCapture()
console.log(`тесты: прошло ${passed}, упало ${failed}`)
recorder.flush(500)
const afterTests = writer.cases.length

// ---------------------------------------------------------------------------
// 2. Батарея прямых вызовов над состоянием
// ---------------------------------------------------------------------------

const ODD = [...PROTOTYPE_KEYS.filter((key) => ['constructor', '__proto__', 'toString', 'hasOwnProperty'].includes(key)), 'undefined', 'null', '', 'missing']
const attempt = (fn) => {
  try {
    return fn()
  } catch {
    return null
  }
}

function battery(state, { cap = Infinity } = {}) {
  recorder.record('courierLetterAddressees', [state], { cap })
  for (const options of [undefined, { isAdmin: true }, { isAdmin: false, limit: pick([1, 3, 50, '2', null, undefined]) }]) recorder.record('courierLettersForViewer', [state, options], { cap })
  const heroes = [...new Set([...(Array.isArray(state?.players) ? state.players : []).map((player) => player?.id), 'hero', ...ODD.filter(() => chance(0.15))])]
  for (const hero of heroes.slice(0, 4)) {
    recorder.record('courierLettersFor', [state, hero], { cap })
    recorder.record('openCourierLettersFor', [state, hero], { cap })
  }
  const npcIds = (Array.isArray(state?.social?.npcs) ? state.social.npcs : []).map((npc) => npc?.id).slice(0, 6)
  const factionIds = (Array.isArray(state?.worldMemory?.entities) ? state.worldMemory.entities : []).filter((entity) => entity?.kind === 'faction').map((entity) => entity.id).slice(0, 3)
  const addressees = []
  for (const id of [...npcIds, ...ODD.filter(() => chance(0.2))]) {
    recorder.record('courierAddresseeFor', [state, pick(['npc', 'npc', 'faction', 'NPC', undefined]), id], { cap })
    const addressee = attempt(() => c.courierAddresseeFor(state, 'npc', id))
    if (addressee) addressees.push(addressee)
  }
  for (const id of factionIds) {
    recorder.record('courierAddresseeFor', [state, 'faction', id], { cap })
    const addressee = attempt(() => c.courierAddresseeFor(state, 'faction', id))
    if (addressee) addressees.push(addressee)
  }
  for (const addressee of addressees.slice(0, 4)) {
    recorder.record('planCourierLetter', [state, {
      heroId: pick(heroes), heroName: pick(['Ада', 'Бор', '', undefined]), addressee,
      body: pick(BODIES), commandId: pick(['cmd-1', '', undefined, 7]), atMinutes: pick([undefined, null, 100, '50', -3]),
      replyDraft: pick(['', 'Приходи, друг.', undefined]), replyDraftTone: pick(['warm', 'plain', 'weird', undefined]), replyProvider: pick(['', 'RouterLlmClient', undefined]),
    }], { cap })
  }
  for (const jump of [0, 60, 480, 1_440, 4_000, 43_200, '600', -5].filter((_, index) => index < 2 || chance(0.4))) {
    recorder.record('planCourierLetterTicks', [state, { elapsedMinutes: jump }], { cap })
  }
  const map = strict({ worldMap: state?.worldMap }).worldMap
  const nodes = (Array.isArray(map?.locations) ? map.locations : []).map((node) => node?.id).slice(0, 5)
  for (const from of nodes.slice(0, 2)) for (const to of nodes) recorder.record('worldLeaguesBetween', [map, from, to], { cap })
  for (const letter of (attempt(() => c.normalizeCourierLetterState(state?.courier_letters))?.letters ?? []).slice(0, 4)) {
    for (const tone of ['warm', 'friendly', 'plain', 'cold', 'silent', undefined]) {
      recorder.record('courierLetterReplyBase', [letter, tone], { cap: Math.min(cap, 900) })
      recorder.record('courierLetterReplyFor', [letter, tone], { cap: Math.min(cap, 900) })
    }
    recorder.record('courierLetterForViewer', [letter, pick([undefined, { isAdmin: true }, { isAdmin: 1 }])], { cap })
    recorder.record('courierLetterChronicleEntry', [{ event_type: 'CourierLetterSent', payload: { letter } }], { cap })
  }
}

const BODIES = [
  'Здравствуй. Помощь нужна у брода.', 'Обещаю вернуть долг завтра. Жди.', 'Клянусь, приду через 2 часа!', 'Привет… Даю слово, что помогу. Через три дня.',
  'Мы заплатим. Ждите нас к вечеру?', 'ОБЕЩАЮ всё исправить', 'Ничего не обещаю.', 'перевернуть', '', '   ', 'Верну. Приеду.', 'Обещание: принесу. Завтра будем.',
  `Слово ${'а'.repeat(1_300)}`, 'Помогу завтра', 'Придём!Поможем.',
]

for (const state of seenStates) battery(state, { cap: 2_500 })
const afterBattery = writer.cases.length

// ---------------------------------------------------------------------------
// 3. Корпус паритета
// ---------------------------------------------------------------------------

const RELEVANT = new Set(['SendLetter', 'AdvanceTime', 'TakeRest', 'Rest', 'ShortRest', 'LongRest', 'AdvanceScene', 'HarmNpc', 'TravelTo', 'Travel'])
const dir = process.env.SK_QUICK ? null : corpusDir(process.argv[2])
if (dir) {
  let corpusStates = 0
  let replayed = 0
  let records = 0
  const seen = new Set()
  for (const entry of corpusRecords(dir)) {
    records += 1
    const type = String(entry.command?.command_type ?? '')
    if (!RELEVANT.has(type) && !chance(0.004)) continue
    if (replayed >= 1_200) break
    const state = corpusState(dir, entry.state)
    if (!state) continue
    if (!seen.has(entry.state) && (state.courier_letters?.letters?.length || (corpusStates < 5 && chance(0.2))) && corpusStates < 15) {
      seen.add(entry.state)
      corpusStates += 1
      battery(state, { cap: 3_000 })
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
    recorder.flush(400)
  }
  console.log(`корпус: записей ${records}, состояний для батареи ${corpusStates}, повторено команд ${replayed}`)
} else {
  console.log('корпус пропущен')
}
const afterCorpus = writer.cases.length

// ---------------------------------------------------------------------------
// 4. Случайные письма, карты мира и цепочки событий
// ---------------------------------------------------------------------------

const PLACES = ['Трактир «У моста»', 'Мельница', 'Брод', 'Старый тракт', 'Кряж', 'Погреб']
const NODE_IDS = ['inn', 'mill', 'ford', 'road', 'ridge', 'cellar']

function randomMap() {
  if (chance(0.06)) return pick([undefined, null, 'map', { locations: 'x' }, { locations: [null] }])
  const count = int(1, 6)
  const locations = Array.from({ length: count }, (_, index) => ({
    id: chance(0.04) ? pick(ODD) : NODE_IDS[index], name: chance(0.9) ? PLACES[index] : PLACES[index].toUpperCase(),
    x: chance(0.95) ? int(0, 600) : pick(['100', undefined, null]), y: int(0, 600), kind: pick(['town', 'village', 'wilds']),
  }))
  const routes = []
  for (let index = int(0, 8); index > 0; index -= 1) {
    routes.push(chance(0.04) ? pick([null, 'route', {}]) : {
      id: `route-${index}`, from: pick([...NODE_IDS.slice(0, count), 'ghost', ' inn ']), to: pick([...NODE_IDS.slice(0, count), 'ghost']),
      distance: pick([1, 1, 2, 3, 5, 0, -2, '2', undefined, 2.5, null]), discovered: pick([true, true, false, undefined, 'no']),
    })
  }
  return { locations, routes, currentLocationId: pick([...NODE_IDS.slice(0, count), undefined]) }
}

function randomLetter(index) {
  if (chance(0.02)) return pick([chance(0.3) ? null : undefined, 'letter', 5, [], {}])
  const sent = pick([0, 100, 600, 1_440, '300', -10, undefined, 2.5])
  const due = pick([undefined, 480, 1_000, 2_000, '900', 50, null])
  return {
    id: chance(0.06) ? pick([':bad', 'letter x', '', ...ODD, 'l'.repeat(150)]) : `letter:${index % 6}${pick(['', 'a'])}`,
    hero_id: chance(0.05) ? pick(['', null]) : pick(['hero', 'hero-2', 'bor']),
    hero_name: pick(['Ада', 'Бор', '', undefined]),
    addressee_kind: pick(['npc', 'npc', 'faction', 'guild', undefined]),
    addressee_id: chance(0.04) ? pick(['', null]) : pick(['ally', 'stranger', 'foe', 'barkeep', 'faction-wolves', 'ghost', 'constructor']),
    addressee_name: pick(['Мельник Гость', 'Волчья ватага', '', undefined]),
    place_name: pick(['Мельница', '', undefined]),
    leagues: pick([0, 1, 2, 6, 40, -1, '3', undefined, null]),
    fee_cp: pick([50, 60, -5, '70', undefined]),
    body: pick(BODIES),
    promise_text: pick(['', 'Обещаю вернуть долг завтра.', undefined]),
    promise_due_hint: pick(['', 'завтра', 'через 2 часа', undefined]),
    status: pick(['in_transit', 'in_transit', 'delivered', 'answered', 'returned', 'unanswered', 'lost', undefined]),
    sent_at_minutes: sent,
    delivery_due_minutes: due,
    reply_due_minutes: pick([undefined, 1_500, 3_000, '2500', null]),
    delivered_at_minutes: pick([undefined, null, null, 500, 1_000, '800']),
    answered_at_minutes: pick([undefined, null, 2_000]),
    returned_at_minutes: pick([undefined, null]),
    return_reason: pick(['', 'dead', 'gone', 'lost', undefined]),
    tone: pick(['warm', 'friendly', 'plain', 'cold', 'silent', 'rude', undefined]),
    reply_draft: pick(['', 'Приходи, друг, у нас всегда найдётся место.', undefined]),
    reply_draft_tone: pick(['', 'warm', 'cold', 'odd', undefined]),
    reply_text: pick(['', 'Ответ.', undefined]),
    reply_provider: pick(['', 'llm', 'RouterLlmClient', undefined]),
  }
}

function randomState(index) {
  const map = randomMap()
  const names = chance(0.4) ? ['Мельник Гость', 'Miller Guest', 'Ростовщик Злоба', 'Bazhen', 'Тень у очага'] : ['Мельник Гость', 'Возчик Сновид', 'Ростовщик Злоба', 'Трактирщик Бажен', 'Тень у очага']
  const ids = ['ally', 'stranger', 'foe', 'barkeep', 'secret']
  const npcs = []
  for (let npcIndex = 0; npcIndex < 5; npcIndex += 1) {
    if (!chance(0.75)) continue
    npcs.push(chance(0.03) ? pick([null, 'npc']) : {
      id: chance(0.04) ? pick(ODD) : ids[npcIndex], name: names[npcIndex], role: pick(['мельник', 'возчик', '']),
      location: pick([...PLACES, '', undefined]), visibility: pick(['party', 'party', 'public', 'gm_only', undefined]),
      available: pick([true, true, false, undefined]), public_summary: 'Живёт тут.',
      ...(chance(0.15) ? { schedule: [{ start: pick([0, 480, 1_200]), end: pick([600, 1_440]), location: pick(PLACES), available: pick([true, false]) }] } : {}),
    })
  }
  const relationships = {}
  for (const id of ids) if (chance(0.6)) relationships[id] = { hero: pick([60, 25, 0, -25, -70, '30', 100, 200, -200]), ...(chance(0.3) ? { 'hero-2': pick([10, 55]) } : {}) }
  if (chance(0.05)) relationships.constructor = { hero: 80 }
  const entities = [
    { id: 'faction-wolves', kind: 'faction', name: 'Волчья ватага', visibility: pick(['party', 'public', 'gm_only', undefined]), tags: [] },
    ...(chance(0.5) ? [{ id: 'faction-secret', kind: 'faction', name: 'Тайный круг', visibility: 'gm_only', tags: [] }] : []),
    ...(chance(0.4) ? [{ id: pick(ids), kind: 'npc', name: 'Знакомый', summary: 'Знает отряд.' }] : []),
    ...(chance(0.03) ? [null] : []),
  ]
  const letters = Array.from({ length: int(0, 6) }, (_, letterIndex) => randomLetter(letterIndex))
  const vitals = {}
  for (const id of ids) if (chance(0.25)) vitals[id] = { hp: pick([0, 5]), max_hp: 5, alive: pick([true, false, undefined]) }
  const sceneNode = pick([...NODE_IDS, undefined])
  return {
    scene: { title: pick([...PLACES, '']), location: pick([...PLACES, undefined]), location_id: sceneNode, ...(chance(0.1) ? { locationId: pick(NODE_IDS) } : {}) },
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10 }],
    worldMap: map,
    social: { npcs, relationships },
    worldMemory: { entities },
    autonomy: chance(0.7) ? { reputations: pick([{ 'faction-wolves': pick([30, -60, 0, '55']) }, {}, [5], 'x']) } : undefined,
    npc_world: chance(0.6) ? { vitals } : undefined,
    courier_letters: chance(0.9) ? { schema_version: pick([1, 1, 2, undefined]), letters } : pick([undefined, null, 'junk']),
    mechanics: {
      world_time: pick([{ elapsed_minutes: int(0, 5_000) }, { elapsed_minutes: '700' }, { amount: 2, unit: 'day' }, {}, undefined]),
      ...(chance(0.1) ? { combat: { active: true } } : {}),
    },
    ...(chance(0.15) ? { enemies: [{ id: 'enemy-1', origin: { npc_id: pick(ids) }, hp: 5 }] } : {}),
  }
}

for (let index = 0; index < 100; index += 1) {
  const raw = randomState(index)
  const states = [raw]
  const normalized = attempt(() => rules.normalizeCampaignState(viaJson(raw)))
  if (normalized && chance(0.3)) states.push(normalized)
  for (const state of states) {
    if (chance(0.25)) withRetentionMode('legacy', () => battery(state, { cap: 2_500 }))
    else battery(state, { cap: 2_500 })
  }
  recorder.record('normalizeCourierLetterState', [raw.courier_letters])
  for (const score of [pick([-100, -50, -49, -20, -19, 0, 19, 20, 49, 50, 100, 500, '30', null, undefined, true, '', ' ', 2.5])]) recorder.record('courierToneFor', [score], { cap: 300 })
  recorder.record('courierLetterPromiseFrom', [pick([...BODIES, undefined, null, 5])], { cap: 300 })
  for (const letter of (Array.isArray(raw.courier_letters?.letters) ? raw.courier_letters.letters : []).slice(0, 3)) {
    recorder.record('courierLetterForViewer', [letter ?? {}, pick([undefined, { isAdmin: true }])], { cap: 1_500 })
    recorder.record('courierLetterReplyBase', [letter ?? {}, pick(['warm', 'cold', 'silent', null, ['plain'], 'constructor', undefined])], { cap: 1_500 })
    recorder.record('courierLetterReplyFor', [letter ?? {}, pick(['warm', 'friendly', 'cold', 'silent', undefined])], { cap: 1_500 })
  }
  let registry = chance(0.5) ? raw.courier_letters : (attempt(() => c.normalizeCourierLetterState(raw.courier_letters)) ?? raw.courier_letters)
  const list = Array.isArray(registry?.letters) ? registry.letters : []
  const letterIds = list.map((letter) => letter?.id).filter(Boolean)
  for (let step = int(1, 7); step > 0; step -= 1) {
    const type = pick([...LETTER_EVENTS, 'Unrelated', undefined])
    const payload = pick([
      { letter_id: chance(0.85) ? pick(letterIds.length ? letterIds : ['letter:0']) : pick(['', null, ...ODD]), at_minutes: pick([100, 900, '400', -3, undefined, 2.5, null, true]), tone: pick(['warm', 'cold', 'odd', undefined]), reason: pick(['dead', 'gone', 'x', undefined]), reply: pick(['Ответ.', '', undefined]), provider: pick(['llm', undefined]), summary: pick(['Сводка.', '', undefined]), addressee_name: pick(['Гость', undefined]), hero_name: pick(['Ада', '', undefined]) },
      { letter: randomLetter(int(0, 9)) },
      undefined, null, 'payload',
    ])
    const event = chance(0.97) ? { event_type: type, payload } : pick([undefined, null, 'event'])
    recorder.record('applyCourierLetterEvent', [registry, event])
    recorder.record('courierLetterChronicleEntry', [event ?? {}], { cap: 1_500 })
    registry = attempt(() => c.applyCourierLetterEvent(viaJson(registry), viaJson(event))) ?? registry
  }
}

writer.write(new URL('./courier-letters.json', import.meta.url))
console.log(`тесты ${afterTests}, батарея ${afterBattery - afterTests}, корпус ${afterCorpus - afterBattery}, случайные ${writer.cases.length - afterCorpus}`)
console.log('урезание:', recorder.stats)

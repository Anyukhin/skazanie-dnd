import '../../../fixtures-env.mjs'
import { startCapture } from './hook.mjs'
// Эталон server/world-offices.mjs для Rust:
//
//   node rust/crates/sk-world-life/fixtures/gen-world-offices.mjs [каталог корпуса]
//
// Источники входов:
//
// - тесты `test/world-offices.test.mjs`, `test/world-offices-knowledge.test.mjs`
//   и `test/campaign-world-offices.test.mjs`, исполненные в этом же процессе
//   (`node:test`, `isolation: 'none'`): каждый верхний вызов модуля — из теста
//   или изнутри Rules Engine и проекции — перехватывается хуком;
// - корпус паритета: состояния кампаний с должностями и повтор записанных команд;
// - сотни случайных должностей, кампаний и цепочек «смерть → освобождение →
//   преемство» с мусором старых сохранений.
//
// Состояния урезаются до полей, которые читает модуль; JS исполняется заново
// на урезанном входе и сверяется с исходом на полном — Rust получает ровно его.
import { run } from 'node:test'
import { fileURLToPath } from 'node:url'

import { fixtureWriter, mulberry32, chooser, viaJson, PROTOTYPE_KEYS } from './common.mjs'
import { corpusDir, corpusRecords, corpusState, replayDice, pickKeys, mapList, moduleCapture } from './lib.mjs'

const o = await import('../../../../server/world-offices.mjs')
const rules = await import('../../../../server/rules-engine.mjs')
const { withRetentionMode, retentionMode } = await import('../../../../server/retention-context.mjs')
const { campaignStateForViewer } = await import('../../../../server/viewer-projection.mjs')

const writer = fixtureWriter('world-offices', retentionMode)
const random = mulberry32(2026_10_17)
const { int, pick, chance } = chooser(random)

const FNS = {
  validateOfficeConfiguration: { fn: (...args) => o.validateOfficeConfiguration(...args), states: [], refs: [0] },
  normalizeWorldOfficesState: { fn: (...args) => o.normalizeWorldOfficesState(...args), states: [], refs: [0] },
  planOfficeVacancyDrafts: { fn: (...args) => o.planOfficeVacancyDrafts(...args), states: [0] },
  planOfficeSuccessionDrafts: { fn: (...args) => o.planOfficeSuccessionDrafts(...args), states: [0] },
  applyWorldOfficeEvent: { fn: (...args) => o.applyWorldOfficeEvent(...args), states: [], refs: [0] },
  officesForViewer: { fn: (...args) => o.officesForViewer(...args), states: [0] },
  officeChronicleEntry: { fn: (...args) => o.officeChronicleEntry(...args), states: [] },
}

const NPC_KEYS = ['id', 'name', 'role', 'tags', 'location', 'available', 'visibility', 'schedule', 'faction_id']
function strict(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  const out = pickKeys(state, ['world_offices', 'npc_world', 'captives', 'offices'])
  if (state.social !== undefined) {
    out.social = state.social && typeof state.social === 'object' && !Array.isArray(state.social)
      ? { npcs: mapList(state.social.npcs, (npc) => pickKeys(npc, NPC_KEYS)) }
      : state.social
  }
  for (const key of ['enemies', 'actors']) if (state[key] !== undefined) out[key] = mapList(state[key], (actor) => pickKeys(actor, ['id', 'origin', 'hp', 'alive']))
  if (state.mechanics && typeof state.mechanics === 'object') {
    out.mechanics = pickKeys(state.mechanics, ['world_time'])
    if (state.mechanics.combat !== undefined) out.mechanics.combat = state.mechanics.combat && typeof state.mechanics.combat === 'object' ? { active: state.mechanics.combat.active } : state.mechanics.combat
  } else if (state.mechanics !== undefined) out.mechanics = state.mechanics
  if (state.worldMemory && typeof state.worldMemory === 'object' && !Array.isArray(state.worldMemory)) {
    const memory = pickKeys(state.worldMemory, ['knowledge_ledger', 'knowledge_revealed'])
    for (const key of ['knowledge_ledger', 'knowledge_revealed']) if (memory[key] !== undefined) memory[key] = mapList(memory[key], (entry) => pickKeys(entry, ['hero_id', 'fact_id', 'recorded_at_minutes']))
    if (state.worldMemory.facts !== undefined) memory.facts = mapList(state.worldMemory.facts, (fact) => pickKeys(fact, ['id', 'subject_id', 'predicate', 'source_event_ids', 'recorded_at_minutes', 'visibility']))
    out.worldMemory = memory
  } else if (state.worldMemory !== undefined) out.worldMemory = state.worldMemory
  return out
}
const wide = (state) => (state && typeof state === 'object' && !Array.isArray(state)
  ? pickKeys(state, ['world_offices', 'offices', 'npc_world', 'captives', 'social', 'enemies', 'actors', 'mechanics', 'worldMemory', 'players', 'scene'])
  : state)

const recorder = moduleCapture({ module: 'server/world-offices.mjs', fns: FNS, strips: [(state) => { const out = strict(state); if (out && typeof out === 'object' && !Array.isArray(out)) delete out.worldMemory; return out }, strict, wide], retentionMode, withRetentionMode, writer, limit: 900 })
const OFFICE_EVENTS = new Set(o.WORLD_OFFICE_EVENT_TYPES)
let quiet = 0
let quietVacancy = 0
function capture(module, name, args) {
  if (module !== 'server/world-offices.mjs') return
  if (name === 'applyWorldOfficeEvent' && !OFFICE_EVENTS.has(String(args[1]?.event_type ?? ''))) {
    if (quiet >= 200 || !chance(0.05)) return
    quiet += 1
    args = [args[0], { event_type: args[1]?.event_type, payload: pickKeys(args[1]?.payload, ['schema_version', 'office_id']) }, args[2]]
  }
  if (name === 'planOfficeVacancyDrafts') {
    // Чужие события список смертей не трогает: от них остаётся только тип.
    const events = Array.isArray(args[1]) ? args[1] : []
    const deaths = events.filter((event) => event?.event_type === 'NpcDied')
    if (!deaths.length && (quietVacancy >= 200 || !chance(0.05))) return
    if (!deaths.length) quietVacancy += 1
    args = [args[0], events.map((event) => (event?.event_type === 'NpcDied' ? event : { event_type: event?.event_type })).slice(0, 12), ...args.slice(2)]
  }
  if (name === 'normalizeWorldOfficesState' && !(args[0]?.offices?.length) && !chance(0.02)) return
  recorder.capture(module, name, args)
}

// ---------------------------------------------------------------------------
// 1. Тесты модуля в этом же процессе
// ---------------------------------------------------------------------------

const testFile = (name) => fileURLToPath(new URL(`../../../../test/${name}`, import.meta.url))
const stopCapture = startCapture(capture)
let passed = 0
let failed = 0
for await (const event of run({ files: ['world-offices.test.mjs', 'world-offices-knowledge.test.mjs', 'campaign-world-offices.test.mjs'].map(testFile), isolation: 'none' })) {
  if (event.type === 'test:pass') passed += 1
  if (event.type === 'test:fail') {
    failed += 1
    console.log('упал тест:', event.data?.name)
  }
}
stopCapture()
console.log(`тесты: прошло ${passed}, упало ${failed}`)
recorder.flush(600)
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
const ODD = [...PROTOTYPE_KEYS.filter((key) => ['constructor', '__proto__', 'toString', 'hasOwnProperty'].includes(key)), 'undefined', 'null', '', 'missing']
const VIEWERS = [undefined, {}, { isAdmin: true }, { role: 'admin' }, { playerId: 'hero' }, { playerId: 'hero', isPartyMember: false }, { role: 'player', playerId: 'hero-2' }, { playerId: 'hero', asOfMinutes: 10 }]

function battery(state, { cap = Infinity } = {}) {
  for (const viewer of VIEWERS.filter((_, index) => index < 3 || chance(0.4))) recorder.record('officesForViewer', [state, viewer], { cap })
  for (const options of [undefined, { worldMinute: pick([0, 1_440, 99_999, '500', null]) }, { elapsedMinutes: pick([60, 1_440, -5, '30']) }].filter((_, index) => index < 1 || chance(0.6))) {
    recorder.record('planOfficeSuccessionDrafts', [state, options], { cap })
  }
  const offices = attempt(() => o.normalizeWorldOfficesState(state?.world_offices))?.offices ?? []
  const holders = offices.map((office) => office.holder_npc_id).filter(Boolean)
  for (const holder of [...holders.slice(0, 3), pick(ODD)]) {
    const death = { event_type: 'NpcDied', event_id: pick([`event:${holder}-died`, undefined, 7]), command_id: pick(['cmd-1', undefined]), payload: { npc_id: holder }, ...(chance(0.5) ? { visibility: pick(['party', 'gm_only', 'public']) } : {}) }
    recorder.record('planOfficeVacancyDrafts', [state, [death, ...(chance(0.3) ? [death, { event_type: 'Other' }] : [])], pick([undefined, { worldMinute: int(0, 5_000) }, { atMinutes: '120' }])], { cap })
  }
}

const dir = process.env.SK_QUICK ? null : corpusDir(process.argv[2])
if (dir) {
  const RELEVANT = new Set(['HarmNpc', 'AdvanceTime', 'MakeAttack', 'CastSpell', 'ExecuteCaptive', 'TakeRest', 'LongRest', 'ShortRest', 'AdvanceScene'])
  let corpusStates = 0
  let replayed = 0
  let records = 0
  const seen = new Set()
  for (const entry of corpusRecords(dir)) {
    records += 1
    const type = String(entry.command?.command_type ?? '')
    if (!RELEVANT.has(type) && !chance(0.004)) continue
    if (replayed >= 700) break
    const state = corpusState(dir, entry.state)
    if (!state || !state.world_offices?.offices?.length) continue
    if (!seen.has(entry.state) && corpusStates < 25) {
      seen.add(entry.state)
      corpusStates += 1
      battery(state, { cap: 2_000 })
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
// 3. Случайные должности, кампании и цепочки событий
// ---------------------------------------------------------------------------

const NPCS = ['npc:king', 'npc:marshal', 'npc:steward', 'npc:abbot', 'npc:guard-1']
const FACTIONS = ['faction:crown', 'faction:church', 'faction:guild']
const GATES = [
  { visibility: 'party' }, { visibility: 'gm_only' }, { visibility: 'specific_player', hero_ids: ['hero'], fact_id: 'fact:death' },
  { visibility: 'public' }, { visibility: 'secret' }, 'gate', null,
]

function randomOffice(index) {
  if (chance(0.03)) return pick([null, 'office', 5, []])
  const office = {
    id: chance(0.06) ? pick([':bad', 'office x', '', ...ODD]) : `office:${index % 4}`,
    title: chance(0.05) ? pick(['', '   ', null]) : pick(['Корона Валедора', 'Настоятель', '  Старшина  гильдии ']),
    faction_id: chance(0.04) ? pick(['', 'bad id']) : pick(FACTIONS),
    holder_npc_id: pick([...NPCS, null, undefined, '', 'bad id']),
    visibility: pick(['party', 'party', 'gm_only', undefined, null, 'public']),
    defender_npc_ids: pick([undefined, [], ['npc:guard-1'], ['npc:guard-1', 'npc:guard-1', ' npc:guard-2 '], ['bad id'], 'npc:guard-1', Array.from({ length: 30 }, (_, i) => `npc:g-${i}`)]),
  }
  if (chance(0.8)) {
    office.successor = chance(0.05) ? pick(['marshal', [], null]) : {
      npc_id: pick([...NPCS, 'bad id', '']),
      delay_minutes: pick([1_440, 60, 1, 0, 600_000, '120', 2.5, undefined]),
      ...(chance(0.8) ? { required_tags: pick([[], ['marshal'], ['marshal', 'heir'], ['bad tag'], 'marshal', Array.from({ length: 14 }, (_, i) => `tag-${i}`)]) } : {}),
      ...(chance(0.03) ? { extra: 1 } : {}),
    }
  }
  if (chance(0.04)) office.unknown_field = true
  if (chance(0.3)) office.status = pick(['held', 'vacant', 'weird'])
  if (chance(0.3)) {
    office.pending = pick([
      { succession_id: `succession:${index}`, candidate_npc_id: pick(NPCS), due_at_minutes: pick([0, 1_440, '300', 2.5, undefined]), vacated_at_minutes: pick([0, '10', undefined, -4]), source_event_id: pick(['event:x', 'bad id', undefined]), ...(chance(0.5) ? { previous_status: pick(['held', 'vacant', 'x']) } : {}), ...(chance(0.5) ? { previous_holder_npc_id: pick([...NPCS, null, 'bad id']) } : {}), ...(chance(0.5) ? { knowledge_gate: pick(GATES) } : {}) },
      null, 'pending', { due_at_minutes: 5 },
    ])
  }
  if (chance(0.3)) {
    office[pick(['succession_history', 'history'])] = Array.from({ length: int(0, 4) }, (_, entry) => (chance(0.05) ? null : {
      succession_id: pick([`succession:h${entry}`, `succession:h0`, '']), outcome: pick(['installed', 'skipped', 'odd']), reason: pick(['successor_installed', 'candidate_dead', '']),
      candidate_npc_id: pick([...NPCS, undefined]), at_minutes: pick([10, '20', -1, undefined]), source_event_id: pick(['event:y', undefined]),
      ...(chance(0.5) ? { previous_status: pick(['held', 'vacant']), previous_holder_npc_id: pick([...NPCS, null]), knowledge_gate: pick(GATES) } : {}),
    }))
  }
  return office
}

function randomCampaign(offices) {
  const npcs = NPCS.filter(() => chance(0.85)).map((id) => ({
    id, name: id.slice(4), role: 'житель', location: 'Штормберг', visibility: 'party', available: pick([true, true, false, undefined]),
    tags: [pick(FACTIONS.map((faction) => `faction:${faction}`)), ...(chance(0.6) ? ['marshal'] : []), ...(chance(0.3) ? ['heir'] : [])],
    ...(chance(0.1) ? { schedule: [{ start: 0, end: 720, location: 'Поле', available: false }] } : {}),
  }))
  const vitals = Object.fromEntries(NPCS.filter(() => chance(0.7)).map((id) => [id, { hp: pick([0, 10]), max_hp: 10, alive: pick([true, true, false, undefined]) }]))
  return {
    mechanics: { world_time: pick([{ elapsed_minutes: int(0, 6_000) }, { elapsed_minutes: '100' }, {}]), ...(chance(0.1) ? { combat: { active: true } } : {}) },
    world_offices: { offices },
    social: { npcs },
    npc_world: { vitals },
    ...(chance(0.2) ? { captives: { captives: [{ status: pick(['held', 'released']), npc_id: pick(NPCS), actor_id: pick(NPCS) }] } } : {}),
    ...(chance(0.5) ? { worldMemory: { facts: [], entities: [], knowledge: pick([[], [{ hero_id: 'hero', fact_id: 'fact:death', at_minutes: 5 }]]) } } : {}),
    ...(chance(0.1) ? { enemies: [{ id: 'enemy-1', origin: { npc_id: pick(NPCS) } }] } : {}),
  }
}

for (let index = 0; index < 250; index += 1) {
  const offices = Array.from({ length: int(0, 4) }, (_, officeIndex) => randomOffice(officeIndex))
  const known = chance(0.3) ? { knownNpcIds: pick([NPCS, NPCS.slice(0, 2), [], 'x', null]), knownFactionIds: pick([FACTIONS, [FACTIONS[0]], undefined]) } : {}
  for (const office of offices.slice(0, 3)) {
    recorder.record('validateOfficeConfiguration', [office, pick([undefined, {}, known, { ...known, allowCurrentSuccessor: true }])], { cap: 2_500 })
  }
  recorder.record('normalizeWorldOfficesState', [{ offices }, pick([undefined, {}, known, { offices: offices.slice(0, 1) }, { configuration: offices }])], { cap: 2_500 })
  const state = randomCampaign(offices)
  battery(state, { cap: 4_000 })
  // Цепочка: смерть держателя → освобождение → минута преемства → событие.
  let registry = attempt(() => o.normalizeWorldOfficesState({ offices })) ?? { offices }
  for (let step = int(2, 6); step > 0; step -= 1) {
    const current = { ...state, world_offices: registry }
    const holder = registry.offices?.find((office) => office.holder_npc_id)?.holder_npc_id ?? pick(NPCS)
    const deaths = [{ event_type: 'NpcDied', event_id: `event:died-${index}-${step}`, payload: { npc_id: holder }, visibility: pick(['party', 'gm_only', undefined]) }]
    const vacancies = attempt(() => o.planOfficeVacancyDrafts(viaJson(current), deaths, { worldMinute: step * 100 })) ?? []
    const successions = attempt(() => o.planOfficeSuccessionDrafts(viaJson(current), { worldMinute: pick([step * 100, 99_999]) })) ?? []
    const drafts = [...vacancies, ...successions]
    if (chance(0.3)) drafts.push({ event_type: pick([...OFFICE_EVENTS, 'Other']), payload: { schema_version: pick([1, 2, 3, '2']), office_id: pick(['office:0', 'office:1', '', 'bad id']), succession_id: pick(['succession:0', '']), holder_npc_id: pick(NPCS), previous_holder_npc_id: pick(NPCS), reason: pick(['candidate_dead', 'odd']), due_at_minutes: pick([5, '6', undefined]), knowledge_gate: pick(GATES) } })
    for (const draft of drafts) {
      const event = { ...draft, event_id: `event:office-${index}-${step}`, ...(chance(0.2) ? { payload: { ...draft.payload, schema_version: pick([1, 2, 3]) } } : {}) }
      recorder.record('applyWorldOfficeEvent', [registry, event, pick([undefined, {}, known])], { cap: 3_000 })
      recorder.record('officeChronicleEntry', [event, pick([undefined, { isAdmin: true }, { isAdmin: 'yes' }])], { cap: 1_500 })
      registry = attempt(() => o.applyWorldOfficeEvent(viaJson(registry), viaJson(event))) ?? registry
    }
    for (const viewer of VIEWERS.filter(() => chance(0.3))) recorder.record('officesForViewer', [{ ...state, world_offices: registry }, viewer], { cap: 4_000 })
    recorder.record('officesForViewer', [registry, pick(VIEWERS)], { cap: 4_000 })
  }
}

writer.write(new URL('./world-offices.json', import.meta.url))
console.log(`тесты ${afterTests}, корпус ${afterCorpus - afterTests}, случайные ${writer.cases.length - afterCorpus}`)
console.log('урезание:', recorder.stats)

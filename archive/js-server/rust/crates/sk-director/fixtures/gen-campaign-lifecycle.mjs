import '../../../fixtures-env.mjs'
// Эталон server/campaign-lifecycle.mjs для Rust:
//
//   node rust/crates/sk-director/fixtures/gen-campaign-lifecycle.mjs
//
// Секция `calls` (`campaign-lifecycle.json.gz`): вызовы экспортов —
// `collectEpilogueFacts`, `normalizeCampaignLifecycle`, `campaignIsReadOnly`,
// `assertCampaignPlayable`, `lifecycleEventForAction`,
// `buildDeterministicEpilogue`, `campaignCanAutoComplete`,
// `campaignCanAdvanceArc`, `campaignArcCarryOver`,
// `buildEpilogueNarrationBrief` — из тестов JS (перехват: жизненный цикл,
// цепочка арок, сценарий, вечерняя и постоянная кампании, автономный
// Режиссёр) и случайные состояния с мусором. У `lifecycleEventForAction` без
// `now` время подставлено: иначе эталон зависел бы от часов.
import { readFileSync } from 'node:fs'
import { argsFrom, argsOf, captureTests, errorOf, mulberry32, picker, plain, writeFixture } from './common.mjs'

const root = new URL('../../../../', import.meta.url)
const cl = await import(new URL('server/campaign-lifecycle.mjs', root).href)
const { buildCampaignArcPlan } = await import(new URL('server/campaign-loop-policy.mjs', root).href)
const { SCENARIO_ARC_VERSION } = await import(new URL('server/campaign-scenario.mjs', root).href)
const scenarios = JSON.parse(readFileSync(new URL('data/campaign-scenarios-v1.json', root), 'utf8'))

const FIXTURE = new URL('./campaign-lifecycle.json.gz', import.meta.url)
const NOW = '2026-10-16T12:00:00.000Z'
const { int, pick, chance } = picker(mulberry32(2026_10_16_2))
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const FNS = ['collectEpilogueFacts', 'normalizeCampaignLifecycle', 'campaignIsReadOnly', 'assertCampaignPlayable', 'lifecycleEventForAction',
  'buildDeterministicEpilogue', 'campaignCanAutoComplete', 'campaignCanAdvanceArc', 'campaignArcCarryOver', 'buildEpilogueNarrationBrief']

const STATE_KEYS = ['campaign', 'players', 'mechanics', 'worldMemory', 'social', 'autonomy', 'worldMap', 'adventure', 'scene', 'campaignConcept']
const calls = []
const seen = new Set()
function add(fn, args, label) {
  if (fn === 'lifecycleEventForAction') {
    const options = args[2]
    if (options === undefined) args = [args[0], args[1], { now: NOW }]
    else if (options && typeof options === 'object' && !Array.isArray(options) && !('now' in options)) args = [args[0], args[1], { ...options, now: NOW }]
  }
  const run = (encoded) => {
    try {
      const value = cl[fn](...argsFrom(encoded))
      return { out: value === undefined ? null : plain(value) }
    } catch (error) {
      return { error: errorOf(error) }
    }
  }
  let encoded = argsOf(args)
  const key = JSON.stringify([fn, encoded])
  if (seen.has(key)) return
  seen.add(key)
  const outcome = run(encoded)
  // Состояние урезается до полей, которые читает модуль и его соседи; урезанное
  // берётся, только если исход тот же.
  const at = fn === 'lifecycleEventForAction' ? 1 : fn === 'normalizeCampaignLifecycle' ? -1 : 0
  const state = encoded.args[at]
  if (at >= 0 && state && typeof state === 'object' && !Array.isArray(state)) {
    const trimmed = Object.fromEntries(Object.entries(state).filter(([field]) => STATE_KEYS.includes(field)))
    const candidate = { ...encoded, args: encoded.args.map((value, index) => (index === at ? trimmed : value)) }
    if (JSON.stringify(run(candidate)) === JSON.stringify(outcome)) encoded = candidate
  }
  calls.push({ fn, label, ...encoded, ...outcome })
}

// --- перехват тестов ------------------------------------------------------------------------

const captured = await captureTests(
  ['campaign-lifecycle', 'campaign-arc-chain', 'campaign-controls', 'campaign-scenario', 'evening-campaign', 'persistent-campaign', 'autonomous-campaign'],
  { '/server/campaign-lifecycle.mjs': FNS },
  { limit: 120 },
)
console.log(`перехвачено вызовов: ${captured.length}`)
for (const record of captured) add(record.fn, argsFrom(record), `test/${record.test}`)

// --- случайные состояния ----------------------------------------------------------------------

const JUNK = [undefined, null, '', '  ', 'строка', 5, 0, 1.5, true, [], {}, ['a'], 'constructor', '__proto__']
const junk = () => pick(JUNK)
const VIS = ['party', 'public', 'gm_only', 'hidden', '', undefined, null, ' party ', 5]
const scenario = scenarios.scenarios?.[0] ?? scenarios[0]

function randomState() {
  if (chance(0.04)) return pick([null, 5, 'state', []])
  const state = {}
  if (chance(0.8)) state.campaign = pick(['Сказание', '', 'К'.repeat(200), 5, null])
  if (chance(0.8)) {
    state.players = Array.from({ length: int(5) }, (_, index) => (chance(0.08) ? junk() : {
      id: pick([`hero-${index}`, '', 7, null, ' hero ']), character: pick(['Астер', 'Лира', '', undefined]), name: pick(['Имя', undefined]),
    }))
  }
  const mechanics = {}
  if (chance(0.6)) {
    mechanics.campaign_lifecycle = chance(0.1) ? junk() : {
      status: pick(['setup', 'active', 'paused', 'completed', 'failed', 'archived', 'weird', undefined, 5]),
      ...(chance(0.4) ? { reason: pick(['причина', null, 5, { a: 1 }, 'я'.repeat(300)]) } : {}),
      ...(chance(0.3) ? { paused_at: pick([NOW, null, 5]) } : {}),
      ...(chance(0.3) ? { concluded_at: pick([NOW, null]) } : {}),
      ...(chance(0.3) ? { updated_at: pick([NOW, null]) } : {}),
      ...(chance(0.2) ? { archived_at: NOW } : {}),
      ...(chance(0.3) ? { epilogue: pick(['Эпилог.', null, 'э'.repeat(9000), 7]) } : {}),
      ...(chance(0.3) ? { epilogue_fact_keys: pick([['hero:a', ' quest:b ', '', 5, null], 'x', Array.from({ length: 70 }, (_, i) => `k${i}`)]) } : {}),
      ...(chance(0.3) ? { changed_by: pick(['admin', null, 5]) } : {}),
      ...(chance(0.2) ? { ending: pick([{ id: 'victory', title: 'Победа', outcome: 'boss_defeated' }, [], null, 'x']) } : {}),
    }
  }
  if (chance(0.5)) {
    mechanics.death = {
      campaign_status: pick(['active', 'party_defeated', undefined, 5]),
      heroes: { 'hero-0': { status: pick(['dead', 'alive']) }, 'hero-2': { status: 'dead' } },
    }
  }
  if (chance(0.3)) mechanics.combat = { active: pick([true, false, 1, 0, 'yes']) }
  state.mechanics = chance(0.95) ? mechanics : junk()
  if (chance(0.8)) {
    const entities = Array.from({ length: int(6) }, (_, index) => (chance(0.05) ? junk() : {
      id: pick([`npc-${index}`, `loc-${index}`, 'faction-guild', 'faction-crown', '', 5]),
      kind: pick(['npc', 'location', 'faction', 'item', ' faction ', undefined]),
      name: pick(['Илва', 'Старый Брод', 'Гильдия', 'Корона', '', undefined]),
      visibility: pick(VIS),
      ...(chance(0.6) ? { tags: pick([['visited'], ['x'], 'visited', []]) } : {}),
    }))
    const quests = Array.from({ length: int(9) }, (_, index) => (chance(0.05) ? pick([null, 5]) : {
      id: pick([`quest-${index}`, `quest:chapter:${index}`, '', 7]), title: pick(['Найти печать', '', 'З'.repeat(300)]),
      status: pick(['completed', 'failed', 'abandoned', 'active', ' completed ', undefined]), summary: pick(['Печать найдена.', 'Итог!!!', '', undefined]),
      visibility: pick(VIS),
    }))
    const facts = Array.from({ length: int(10) }, (_, index) => (chance(0.05) ? junk() : {
      id: pick([`fact-${index}`, '']), subject_id: pick(['npc-0', 'loc-1', 'npc-2', 'faction-guild', '']), predicate: pick(['fate', 'state', '']),
      summary: pick(['Илва уехала.', 'Мост сгорел…', '', undefined]), object: pick(['объект', undefined]),
      status: pick(['active', 'superseded', undefined]), visibility: pick(VIS),
    }))
    state.worldMemory = chance(0.95) ? { entities, quests, facts } : junk()
  }
  if (chance(0.6)) {
    state.social = {
      npcs: Array.from({ length: int(4) }, (_, index) => (chance(0.05) ? junk() : { id: pick([`npc-${index}`, '']), name: pick(['Илва', '', undefined]), visibility: pick(VIS) })),
      promises: Array.from({ length: int(5) }, (_, index) => (chance(0.05) ? pick([null, 5]) : {
        id: pick([`p-${index}`, '']), npc_id: pick(['npc-0', 'npc-1', 'npc-9', '']), direction: pick(['party_to_npc', 'npc_to_party', '']),
        status: pick(['fulfilled', 'broken', 'open', undefined]), text: pick(['Вернуть долг.', 'Сберечь мост!', '']), visibility: pick(VIS),
      })),
    }
  }
  if (chance(0.6)) {
    state.autonomy = {
      reputations: chance(0.9) ? { 'faction-guild': pick([30, -60, 0, '25', 2.5, 500, -500, null]), 'faction-crown': pick([30, -30, 60, 10]), 'faction-ghost': 40, 5: 20 } : junk(),
      ...(chance(0.6) ? { pacing: { phase: pick(['climax', 'rising', 'resolution', undefined]) } } : {}),
    }
  }
  if (chance(0.5)) {
    state.worldMap = { locations: Array.from({ length: int(4) }, (_, index) => ({ id: pick([`loc-${index}`, '']), name: pick(['Старый Брод', 'Ольшанка', ' ольшанка ', '']), visited: pick([true, false, 'true']) })) }
  }
  if (chance(0.7)) {
    state.adventure = {
      chapter: pick([1, 2, '3', 0, null, 2.5, 'x']),
      visitedLocations: pick([['Старый Брод', 'Ольшанка', 'старый брод', '', 5], [], 'x']),
      visitedLocationIds: pick([['loc-0', '', 'loc-9'], [], undefined]),
      history: Array.from({ length: int(4) }, (_, index) => (chance(0.1) ? junk() : { chapter: pick([index, '2', null]), location: 'Брод', outcome: 'Итог', visibility: pick(VIS) })),
    }
  }
  if (chance(0.6)) state.scene = { objective: pick(['Найти печать', '', undefined]), location: pick(['Склеп', '', undefined]) }
  if (chance(0.5)) {
    const roll = int(4)
    state.campaignConcept = roll === 0 ? { campaign_mode: 'persistent' }
      : roll === 1 ? { arc: clone(buildCampaignArcPlan(pick(['seed-a', 'seed-b', '']), pick([1, 2, 12]))) }
        : roll === 2 && scenario ? { arc: { version: SCENARIO_ARC_VERSION, scenario_id: scenario.id, scenario_version: scenario.version } }
          : { arc: pick([null, { version: 'x' }, 5]) }
  }
  return state
}

const OUTCOMES = [undefined, 'failed', 'FAILURE', ' defeat ', 'completed', 'victory', 'success', 'x', { outcome: 'failed' }, { outcome: 'complete' }, {}, null, 5]
const ACTIONS = ['activate', 'pause', 'resume', 'complete', 'fail', 'archive', 'chain_arcs', 'conclude_after_arc', 'COMPLETE', 'constructor', '__proto__', 'tostring', '', null, undefined, 5, 'нет']
for (let index = 0; index < 1200; index += 1) {
  const state = randomState()
  const fn = pick(FNS)
  const label = `random/${index}`
  if (fn === 'normalizeCampaignLifecycle') {
    const args = [state?.mechanics?.campaign_lifecycle ?? junk()]
    if (chance(0.6)) args.push(pick(['active', 'party_defeated', undefined, null, 5]))
    add(fn, args, label)
  } else if (fn === 'lifecycleEventForAction') {
    const options = chance(0.05) ? pick([null, undefined]) : { actorId: pick(['system', 'admin', undefined, null, 5]), reason: pick(['причина', '', undefined, 'я'.repeat(300)]), now: NOW }
    add(fn, [pick(ACTIONS), state, options], label)
  } else if (['collectEpilogueFacts', 'buildDeterministicEpilogue', 'buildEpilogueNarrationBrief'].includes(fn)) {
    add(fn, chance(0.8) ? [state, pick(OUTCOMES)] : [state], label)
  } else {
    add(fn, [state], label)
  }
}
// Без аргументов вовсе: `state = {}` по умолчанию.
for (const fn of FNS) add(fn, [], `empty/${fn}`)

const counts = {}
for (const call of calls) counts[`${call.fn}${call.error ? ':error' : ''}`] = (counts[`${call.fn}${call.error ? ':error' : ''}`] ?? 0) + 1
console.log(counts)
writeFixture(FIXTURE, { calls }, { gzip: true })

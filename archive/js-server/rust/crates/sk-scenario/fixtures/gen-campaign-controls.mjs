// Эталоны `server/campaign-controls.mjs` для Rust-переноса (`sk-scenario`).
//
// Журналы событий собираются случайно, но воспроизводимо: команды из
// нескольких событий, границы сцены и арки, служебные события, цепочки
// `CampaignRewound`, перемешанный порядок, битые версии и разрывы. Для каждого
// журнала записан план отката и переигрывания сцены или отказ (код и текст).
//
// Запуск: node rust/crates/sk-scenario/fixtures/gen-campaign-controls.mjs
import { writeFileSync } from 'node:fs'

const root = new URL('../../../../', import.meta.url)
const { campaignRewindEvent, planCampaignControl } = await import(new URL('server/campaign-controls.mjs', root).href)

function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = rng(7310)
const pick = (list) => list[Math.floor(random() * list.length)]

const GAMEPLAY = ['AttackResolved', 'DamageApplied', 'MovementResolved', 'MerchantCreated', 'AbilityCheckResolved', 'SpellCast']
const SERVICE = ['NarrativeSummaryRecorded', 'PublicDieRolled', 'CampaignPaused', 'CampaignResumed', 'CampaignArcChainSet']
const SCENE = ['SceneAdvanced']
const HARD = ['LegacyStateImported', 'CampaignArcCompleted', 'CampaignCompleted', 'CampaignFailed', 'CampaignArchived']

const outcome = (fn) => {
  try {
    return { ok: fn() }
  } catch (error) {
    return { error: { code: error?.code ?? null, message: String(error?.message ?? error), name: error?.name ?? null } }
  }
}

/** Действующий журнал: события подряд, команда — одно или несколько событий. */
function journal(length) {
  const events = []
  let version = 0
  let command = 0
  while (events.length < length) {
    command += 1
    const size = 1 + Math.floor(random() * 3)
    const roll = random()
    const pool = roll < 0.1 ? HARD : roll < 0.25 ? SCENE : roll < 0.4 ? SERVICE : GAMEPLAY
    for (let index = 0; index < size && events.length < length; index += 1) {
      version += 1
      const type = index === 0 ? pick(pool) : pick(random() < 0.3 ? SERVICE : GAMEPLAY)
      const event = { event_type: type, state_version_before: version - 1, state_version_after: version }
      const idRoll = random()
      if (idRoll < 0.7) event.command_id = `cmd-${command}`
      else if (idRoll < 0.8) event.idempotency_key = `key-${command}`
      else if (idRoll < 0.9) event.event_id = `evt-${version}`
      else if (idRoll < 0.95) event.command_id = null
      if (random() < 0.5) event.event_id ??= `${command}:${version}`
      events.push(event)
    }
  }
  return events
}

/** Добавить откат на прошлую версию: событие без геймплея после него. */
function withRewind(events) {
  const last = events.at(-1)?.state_version_after ?? 0
  if (last < 2) return events
  const target = Math.floor(random() * (last - 1)) + (random() < 0.1 ? last : 0)
  return [...events, {
    event_type: 'CampaignRewound',
    command_id: `rewind-${last}`,
    state_version_before: last,
    state_version_after: last + 1,
    payload: { target_version: random() < 0.05 ? 'x' : target },
  }]
}

const actions = ['rewind_turn', 'replay_scene', ' rewind_turn ', 'replay_scene\n', '', 'bogus', null, undefined, 5]
const plans = []
for (let index = 0; index < 400; index += 1) {
  let events = journal(1 + Math.floor(random() * 10))
  const rewinds = Math.floor(random() * 3)
  for (let step = 0; step < rewinds; step += 1) {
    events = withRewind(events)
    if (random() < 0.5) events = [...events, ...journal(1 + Math.floor(random() * 3)).map((event) => ({
      ...event,
      state_version_before: event.state_version_before + events.at(-1).state_version_after,
      state_version_after: event.state_version_after + events.at(-1).state_version_after,
    }))]
  }
  const last = events.at(-1)?.state_version_after ?? 0
  // Порча журнала: версия строкой, отрицательная, дробная, разрыв, перемешивание.
  const corruption = random()
  if (corruption < 0.04 && events.length) events[Math.floor(random() * events.length)].state_version_before = String(events[0].state_version_before)
  else if (corruption < 0.06 && events.length) events[Math.floor(random() * events.length)].state_version_after = -1
  else if (corruption < 0.08 && events.length) events[Math.floor(random() * events.length)].state_version_before = 1.5
  else if (corruption < 0.11 && events.length > 2) events.splice(1, 1)
  else if (corruption < 0.13) events.push(null)
  else if (corruption < 0.25) events.sort(() => random() - 0.5)
  const currentRoll = random()
  const currentVersion = currentRoll < 0.8 ? last : currentRoll < 0.85 ? String(last) : currentRoll < 0.9 ? last - 1 : currentRoll < 0.95 ? last + 3 : pick([null, undefined, -1, 'abc', 2.5])
  const action = index % 10 === 9 ? pick(actions) : index % 2 ? 'rewind_turn' : 'replay_scene'
  const input = { action, events, currentVersion }
  plans.push({ input: JSON.parse(JSON.stringify(input, (key, value) => (value === undefined ? '__undefined__' : value))), result: outcome(() => planCampaignControl(input)) })
}
plans.push({ input: { action: 'rewind_turn', events: 'не журнал', currentVersion: 0 }, result: outcome(() => planCampaignControl({ action: 'rewind_turn', events: 'не журнал', currentVersion: 0 })) })

const states = [
  { state_version: 12, isNarrating: true, mechanics: { campaign_lifecycle: { status: 'active' }, combat: { active: false } }, campaignConcept: { arc_chain: false, title: 'Старая арка' } },
  { state_version: 3 },
  { mechanics: 'не объект', campaignConcept: [1, 2] },
  { isNarrating: false, mechanics: null, campaignConcept: null },
]
const currents = [
  { state_version: 20, mechanics: { campaign_lifecycle: { status: 'paused', reason: 'manual' } }, campaignConcept: { arc_chain: true } },
  { state_version: '7', mechanics: { campaign_lifecycle: [1] }, campaignConcept: { arc_chain: 'yes' } },
  { mechanics: { campaign_lifecycle: null }, campaignConcept: { title: 'без цепочки' } },
  { state_version: null, campaignConcept: { arc_chain: null } },
  { state_version: -2 },
  null,
  'строка',
]
const rewinds = []
for (const action of ['rewind_turn', 'replay_scene', 'bogus', '']) {
  for (const [stateIndex, targetState] of [...states.entries(), [-1, null], [-2, [1]], [-3, 'строка']]) {
    for (const [currentIndex, currentState] of currents.entries()) {
      for (const targetVersion of [12, '4', -1, null]) {
        if (random() < 0.6) continue
        const input = { action, targetState, currentState, targetVersion, actorId: pick(['owner', null, 7, undefined]), occurredAt: pick(['2026-07-31T00:00:00.000Z', null, 5]) }
        rewinds.push({
          input: JSON.parse(JSON.stringify(input, (key, value) => (value === undefined ? '__undefined__' : value))),
          state: stateIndex,
          current: currentIndex,
          result: outcome(() => campaignRewindEvent(input)),
        })
      }
    }
  }
}

writeFileSync(new URL('campaign-controls.json', import.meta.url), `${JSON.stringify({ generated_by: 'rust/crates/sk-scenario/fixtures/gen-campaign-controls.mjs', plans, rewinds })}\n`)
const failed = plans.filter((entry) => entry.result.error).length
console.log(`планов ${plans.length} (отказов ${failed}), событий отката ${rewinds.length}`)

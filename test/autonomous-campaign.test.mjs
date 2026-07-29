import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AUTONOMY_EVAL_SCENARIOS, LONG_CAMPAIGN_EVALS } from '../eval/autonomous-scenarios.mjs'
import { DirectorIntentError, normalizeDirectorIntent } from '../server/autonomous-campaign.mjs'
import { AutonomousCampaignOrchestrator } from '../server/autonomous-orchestrator.mjs'
import { createAutonomyEvalReport } from '../server/autonomy-eval.mjs'
import { DiceService } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { ALLOWED_COMMAND_TYPES, RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

function cells(width = 13, height = 9) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
    type: 'floor',
    revealed: index % width < 5,
  }))
}
function campaign() {
  return normalizeCampaignState({
    sessionCode: 'AUTONOMY-30',
    campaign: 'Autonomous test campaign',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{
      id: 'hero', character: 'Aster', level: 5, hp: 200, maxHp: 200, armor: 25,
      speed: 30, proficiency: 3, experience: 0,
      abilities: { str: 18, dex: 14, con: 18, int: 10, wis: 12, cha: 16 },
      x: 0, y: 0,
      inventory: [{
        id: 'server-longsword', name: 'Longsword', type: 'weapon', quantity: 1, equipped: true,
        combat: { kind: 'melee', ability: 'str', range_feet: 5, damage_expression: '1d8+4', damage_type: 'slashing', proficient: true },
      }],
    }],
    enemies: [],
    scene: { title: 'Old Road', location: 'Old Road', objective: 'Find the missing ledger', turn: 1, cells: cells() },
    mechanics: { positions: { hero: { x: 0, y: 0 } }, world_time: { elapsed_minutes: 0 } },
    worldMemory: {
      entities: [
        { id: 'old-road', kind: 'location', name: 'Old Road', summary: '', aliases: [], visibility: 'party', tags: [] },
        { id: 'guild', kind: 'faction', name: 'Road Wardens', summary: '', aliases: [], visibility: 'party', tags: [] },
      ],
      facts: [],
      quests: [{
        id: 'ledger-quest', title: 'The Missing Ledger', summary: '', status: 'active', visibility: 'party', entity_ids: ['old-road'], objectives: ['Find the ledger'],
        clock: { current: 0, max: 8, label: 'Evidence' },
      }],
      knowledge: {},
    },
    social: {
      npcs: [{
        id: 'marta', name: 'Marta', role: 'warden', location: 'Old Road', public_summary: 'A road warden.',
        voice: 'Brief.', goals: [], beliefs: [], known_fact_ids: [], visibility: 'party', available: true,
        tags: ['faction:guild'],
      }],
      relationships: { marta: { hero: 0 } },
      conversations: [{ id: 'opening-talk', npc_id: 'marta', hero_id: 'hero', player_message: 'We will find it.', npc_reply: 'Return before nightfall.', stance: 'neutral', disclosed_fact_ids: [], visibility: 'party' }],
      promises: [{
        id: 'promise-ledger', npc_id: 'marta', hero_id: 'hero', direction: 'party_to_npc', text: 'Find the ledger.',
        due_hint: 'in 1 day', status: 'open', visibility: 'party', source_conversation_id: 'opening-talk', created_at_minutes: 0, deadline_minutes: 1_440,
      }],
    },
  })
}

class SeededDiceRng {
  constructor(seed = 0x5eed1234) {
    this.state = seed >>> 0
  }

  randint(minimum, maximum) {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) >>> 0
    return minimum + (this.state % (maximum - minimum + 1))
  }
}

async function fixture(t, initialState = campaign(), narrator = null) {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-autonomy-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const eventStore = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState, snapshotEvery: 7 })
  await eventStore.initializeCampaign({ campaign_id: 'AUTONOMY-30', initial_state: initialState })
  const diceService = new DiceService({ rng: new SeededDiceRng() })
  const rulesEngine = new RulesEngine({ diceService })
  return { rootDir, eventStore, rulesEngine, autonomy: new AutonomousCampaignOrchestrator({ eventStore, rulesEngine, narrator, now: () => 1_784_466_000_000 }) }
}

test('Director contract accepts only six narrative intentions and rejects forged mechanics', () => {
  const valid = [
    { type: 'continue_exploration' },
    { type: 'open_social_scene', npc_id: 'marta' },
    { type: 'advance_quest_clock', quest_id: 'ledger-quest' },
    { type: 'request_encounter', theme: 'beasts', difficulty: 'easy' },
    { type: 'end_scene', destination: 'North Gate' },
    { type: 'offer_next_hook', hook: 'Follow the tracks' },
  ]
  assert.deepEqual(valid.map((intent) => normalizeDirectorIntent(intent).type), [
    'continue_exploration', 'open_social_scene', 'advance_quest_clock', 'request_encounter', 'end_scene', 'offer_next_hook',
  ])
  for (const forged of [
    { type: 'deal_damage', damage: 999 },
    { type: 'request_encounter', theme: 'beasts', difficulty: 'easy', hp: 1 },
    { type: 'advance_quest_clock', quest_id: 'ledger-quest', amount: 20 },
    { type: 'request_encounter', theme: 'dragon', difficulty: 'impossible' },
  ]) assert.throws(() => normalizeDirectorIntent(forged), DirectorIntentError)
})

// Тест выше берёт три образца механических полей. Контракт же обещает, что
// отклоняются **все** — и на каждом из шести намерений, а не только на том, где
// пример оказался под рукой. Здесь перебор: каждое поле из списка, в змеином и
// верблюжьем написании, на каждом валидном намерении, сверху и вложенно.
const VALID_INTENTS = Object.freeze([
  { type: 'continue_exploration' },
  { type: 'open_social_scene', npc_id: 'marta' },
  { type: 'advance_quest_clock', quest_id: 'ledger-quest' },
  { type: 'request_encounter', theme: 'beasts', difficulty: 'easy' },
  { type: 'end_scene', destination: 'North Gate' },
  { type: 'offer_next_hook', hook: 'Follow the tracks' },
])

// Список из docs/loop-rules.md, ось 2: hp, dc, броски, цены, количества, XP,
// координаты, урон, инициатива, reputation delta.
const MECHANICAL_FIELDS = Object.freeze([
  'hp', 'max_hp', 'dc', 'difficulty_class', 'roll', 'dice', 'price', 'quantity',
  'xp', 'xp_budget', 'loot', 'coordinates', 'x', 'y', 'damage', 'armor',
  'initiative', 'reputation_delta', 'amount',
])

/** `max_hp` → `maxHp`: то же поле, к которому модель придёт естественнее. */
function camelCase(field) {
  return field.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase())
}

test('ни одно механическое поле не проходит контракт Директора — ни на одном намерении', () => {
  for (const base of VALID_INTENTS) {
    for (const field of MECHANICAL_FIELDS) {
      for (const key of new Set([field, camelCase(field), field.toUpperCase()])) {
        assert.throws(
          () => normalizeDirectorIntent({ ...base, [key]: 7 }),
          DirectorIntentError,
          `${base.type}: поле ${key} прошло контракт`,
        )
      }
    }
  }
})

test('механическое поле не проходит и вложенным в разрешённое поле намерения', () => {
  for (const field of MECHANICAL_FIELDS) {
    for (const key of new Set([field, camelCase(field)])) {
      assert.throws(
        () => normalizeDirectorIntent({ type: 'offer_next_hook', hook: 'Follow the tracks', reason: { [key]: 7 } }),
        DirectorIntentError,
        `вложенное поле reason.${key} прошло контракт`,
      )
    }
  }
})

// Автономный слой сам команд не исполняет — он их составляет, а исполняет
// RulesEngine. Значит любой тип команды, который слой умеет написать, движок
// обязан уметь принять. Иначе получается второй путь, который расходится с
// первым молча: код есть, читается как рабочий, а до исполнения не доживает.
//
// Проверка статическая, по исходникам: типы, собранные из переменных, она не
// увидит, но именно записанные строкой расхождения и накапливаются.
test('автономный слой не умеет писать команду, которой движок не знает', async () => {
  const modules = ['autonomous-campaign.mjs', 'autonomous-orchestrator.mjs', 'campaign-loop-policy.mjs']
  const unknown = []
  for (const name of modules) {
    const source = await readFile(new URL(`../server/${name}`, import.meta.url), 'utf8')
    for (const match of source.matchAll(/command_type:\s*'([A-Za-z]+)'/g)) {
      if (!ALLOWED_COMMAND_TYPES.has(match[1])) unknown.push(`${name}: ${match[1]}`)
    }
  }
  assert.deepEqual([...new Set(unknown)], [], 'эти команды движок исполнить не сможет')
})

// Расписание NPC — такой же факт мира, как его местоположение: `AdvanceTime`
// исполняет пересечённые записи, а `npcProfileAtWorldTime` выводит из них, где
// NPC сейчас. Разговор это уже проверяет и отвечает NPC_SOCIAL_WRONG_LOCATION.
// Значит и Директор не должен открывать сцену с тем, кого по его же расписанию
// в локации нет: иначе цель «Поговорить с Мартой» ставится, а разговор потом
// невозможен — сцена встаёт.
test('социальную сцену нельзя открыть с NPC, которого расписание увело из локации', async (t) => {
  const state = campaign()
  state.social.npcs[0] = {
    ...state.social.npcs[0],
    schedule: [{
      id: 'day-shift', days: [], start_minute: 480, end_minute: 1_080,
      location: 'Warehouse', available: true, visibility: 'party',
    }],
  }
  // Десять часов мира: Марта на складе, отряд остался на Old Road.
  state.mechanics.world_time = { ...state.mechanics.world_time, elapsed_minutes: 600 }
  const { autonomy } = await fixture(t, normalizeCampaignState(state))

  const result = await autonomy.runIntent({
    campaignId: 'AUTONOMY-30',
    intent: { type: 'open_social_scene', npc_id: 'marta' },
    idempotencyKey: 'schedule-away-1',
  })
  const events = (result.results ?? []).flatMap((stage) => stage.events ?? [])
  const opened = events.find((entry) => entry.event_type === 'SocialSceneOpened')
  assert.notEqual(opened?.payload?.npc_id, 'marta', 'Директор открыл сцену с NPC, которого нет в локации')

  // И подменять отсутствующего собой собранный NPC тоже не должен: обещания и
  // разговоры привязаны к идентификатору, а профиль уезжает в upsert.
  const upserted = events.filter((entry) => entry.event_type === 'NpcSocialProfileUpserted')
  assert.equal(upserted.some((entry) => entry.payload?.npc?.id === 'marta'), false, 'собранный NPC занял чужой идентификатор')
  const marta = (result.state?.social?.npcs ?? []).find((npc) => npc.id === 'marta')
  assert.equal(marta?.name, 'Marta', 'настоящий профиль NPC переписан')
  assert.equal(marta?.location, 'Old Road')
})

test('climax resolves a triggered quest and completes the campaign replay-identically', async (t) => {
  const initial = campaign()
  initial.worldMemory.quests[0].clock = { current: 7, max: 8, label: 'Evidence', triggered: false }
  initial.autonomy = { pacing: { beat: 7, phase: 'escalation', tension: 70 } }
  const { eventStore, autonomy } = await fixture(t, initial)

  const result = await autonomy.runIntent({
    campaignId: 'AUTONOMY-30',
    intent: { type: 'advance_quest_clock', quest_id: 'ledger-quest' },
    idempotencyKey: 'final-turn',
  })

  assert.equal(result.state.worldMemory.quests[0].status, 'completed')
  assert.equal(result.state.mechanics.campaign_lifecycle.status, 'completed', JSON.stringify({
    pacing: result.state.autonomy.pacing,
    quests: result.state.worldMemory.quests.map((quest) => ({ id: quest.id, status: quest.status, clock: quest.clock })),
  }))
  assert.match(result.state.mechanics.campaign_lifecycle.epilogue, /Autonomous test campaign/u)
  const events = await eventStore.getEvents('AUTONOMY-30')
  for (const required of ['QuestClockAdvanced', 'QuestResolved', 'WorldFactRecorded', 'DirectorIntentOutcomeRecorded', 'CampaignCompleted']) {
    assert.ok(events.some((entry) => entry.event_type === required), `missing ${required}`)
  }
  const replayed = await eventStore.replay('AUTONOMY-30', { use_snapshots: false })
  assert.deepEqual(replayed.state, result.state)

  const beforeCount = events.length
  const duplicate = await autonomy.runIntent({
    campaignId: 'AUTONOMY-30',
    intent: { type: 'advance_quest_clock', quest_id: 'ledger-quest' },
    idempotencyKey: 'final-turn',
  })
  assert.equal(duplicate.duplicate, true)
  assert.deepEqual(duplicate.state, result.state)
  assert.equal(await autonomy.completeCampaignIfReady('AUTONOMY-30', 'final-turn'), null)
  assert.equal((await eventStore.getEvents('AUTONOMY-30')).length, beforeCount)
})

test('epilogue narrator receives only visible facts and its prose is committed', async (t) => {
  const initial = campaign()
  initial.autonomy = { pacing: { beat: 9, phase: 'climax', tension: 90 } }
  initial.worldMemory.quests[0].status = 'completed'
  initial.worldMemory.quests[0].summary = 'The ledger was recovered.'
  initial.worldMemory.facts.push(
    { id: 'fact:visible', subject_id: 'old-road', predicate: 'outcome', object: 'recovered', summary: 'The road wardens recovered the ledger.', visibility: 'party' },
    { id: 'fact:secret', subject_id: 'old-road', predicate: 'secret', object: 'hidden', summary: 'A secret patron escaped.', visibility: 'gm_only' },
  )
  let receivedBrief = null
  const narrator = {
    async render(brief) {
      receivedBrief = brief
      return { narration: 'Летопись дороги завершилась возвращением реестра. Стражи сохранили память о поступке героев.', provider: 'test-llm' }
    },
  }
  const { autonomy } = await fixture(t, initial, narrator)

  const completion = await autonomy.completeCampaignIfReady('AUTONOMY-30', 'epilogue-turn')
  assert.equal(completion.epilogue_provider, 'test-llm')
  assert.match(completion.state.mechanics.campaign_lifecycle.epilogue, /Летопись дороги/u)
  assert.match(JSON.stringify(receivedBrief), /recovered the ledger/u)
  assert.doesNotMatch(JSON.stringify(receivedBrief), /secret patron|fact:secret/u)
})

test('30+ turn campaign completes the autonomous vertical slice and survives replay/restart', { timeout: 60_000 }, async (t) => {
  const { rootDir, eventStore, rulesEngine, autonomy } = await fixture(t)
  const turns = []
  const run = async (intent) => {
    const key = `turn-${turns.length + 1}`
    const result = await autonomy.runIntent({ campaignId: 'AUTONOMY-30', intent, idempotencyKey: key })
    turns.push({ key, intent: intent.type, version: result.state_version })
    return result
  }

  await run({ type: 'continue_exploration' })
  const explorationCheck = await autonomy.runCommands('AUTONOMY-30', 'turn-exploration-check', [{ command_type: 'MakeAbilityCheck', actor_id: 'hero', ability: 'wis', skill: 'perception', difficulty: 12 }])
  turns.push({ key: 'turn-exploration-check', intent: 'server-exploration-check', version: explorationCheck.state_version })

  await run({ type: 'open_social_scene', npc_id: 'marta' })
  await run({ type: 'open_social_scene', npc_id: 'generated-witness' })
  const check = await autonomy.runCommands('AUTONOMY-30', 'turn-social-check', [{ command_type: 'MakeAbilityCheck', actor_id: 'hero', ability: 'cha', skill: 'persuasion', difficulty: 12 }])
  turns.push({ key: 'turn-social-check', intent: 'server-social-check', version: check.state_version })
  const secondSocialCheck = await autonomy.runCommands('AUTONOMY-30', 'turn-social-check-2', [{ command_type: 'MakeAbilityCheck', actor_id: 'hero', ability: 'wis', skill: 'insight', difficulty: 11 }])
  turns.push({ key: 'turn-social-check-2', intent: 'server-social-check', version: secondSocialCheck.state_version })

  await autonomy.bindPromise('AUTONOMY-30', { promiseId: 'promise-ledger', condition: { event_type: 'QuestClockAdvanced', quest_id: 'ledger-quest' }, idempotencyKey: 'turn-bind-promise' })
  turns.push({ key: 'turn-bind-promise', intent: 'bind-promise', version: (await autonomy.load('AUTONOMY-30')).state_version })
  await run({ type: 'advance_quest_clock', quest_id: 'ledger-quest' })
  await run({ type: 'request_encounter', theme: 'beasts', difficulty: 'easy' })
  const combat = await autonomy.runCombat('AUTONOMY-30', { idempotencyPrefix: 'turn-combat', maxTurns: 120 })
  turns.push(...combat.turns.map((entry, index) => ({ key: `combat-${index + 1}`, intent: 'combat-turn' })))
  const completed = await autonomy.completeEncounter({ campaignId: 'AUTONOMY-30', outcome: 'enemies_defeated', idempotencyKey: 'turn-completion' })
  turns.push({ key: 'turn-completion', intent: 'encounter-completion', version: completed.state_version })
  await autonomy.registerNpcSchedule('AUTONOMY-30', { npcId: 'marta', entries: [{ at_minutes: 540, action: 'move', location: 'North Gate', summary: 'Marta begins her patrol.' }], idempotencyKey: 'turn-schedule' })
  turns.push({ key: 'turn-schedule', intent: 'npc-schedule' })
  const advanced = await autonomy.advanceTime('AUTONOMY-30', { amount: 60, unit: 'minute', idempotencyKey: 'turn-time' })
  turns.push({ key: 'turn-time', intent: 'advance-time' })
  await run({ type: 'end_scene', destination: 'North Gate' })
  await run({ type: 'offer_next_hook', hook: 'Question the gate sentries' })
  while (turns.length < 32) {
    await run(turns.length % 3 === 0
      ? { type: 'advance_quest_clock', quest_id: 'ledger-quest' }
      : turns.length % 3 === 1
        ? { type: 'continue_exploration' }
        : { type: 'offer_next_hook', hook: `Follow clue ${turns.length}` })
  }

  const loaded = await eventStore.load('AUTONOMY-30')
  const eventTypes = (await eventStore.getEvents('AUTONOMY-30')).map((event) => event.event_type)
  assert.ok(turns.length >= 30)
  for (const required of ['SceneAdvanced', 'AbilityCheckResolved', 'NpcPromiseResolved', 'EncounterCreated', 'CombatStarted', 'AttackResolved', 'EncounterEnded', 'EncounterOutcomeRecorded', 'ServerLootGenerated', 'ItemGranted', 'QuestClockAdvanced', 'WorldFactRecorded', 'TransitionUnlocked', 'NpcScheduleRegistered', 'CampaignPacingAdvanced', 'TravelResolved', 'DowntimeResolved']) {
    assert.ok(eventTypes.includes(required), `missing event ${required}`)
  }
  assert.ok(eventTypes.filter((type) => type === 'AbilityCheckResolved').length >= 3)
  assert.equal(loaded.state.social.promises.find((promise) => promise.id === 'promise-ledger').status, 'fulfilled')
  assert.equal(loaded.state.social.npcs.find((npc) => npc.id === 'marta').location, 'North Gate')
  assert.ok(loaded.state.players[0].inventory.some((item) => String(item.id).startsWith('loot-')))
  assert.ok(loaded.state.worldMemory.quests.find((quest) => quest.id === 'ledger-quest').clock.current >= 2)
  assert.ok(cleanObjective(loaded.state.scene.objective))
  assert.equal(advanced.scheduled_actions, 1)
  assert.ok(loaded.state.autonomy.pacing.beat >= 7)
  assert.equal(loaded.state.autonomy.travel_history.length, 1)
  assert.equal(loaded.state.autonomy.downtime_history.length, 1)
  const authorizedTypes = loaded.state.autonomy.director_history.map((entry) => entry.intent.type)
  assert.ok(authorizedTypes.every((type, index) => index === 0 || type !== authorizedTypes[index - 1]))
  assert.equal(loaded.state.social.npcs.some((npc) => npc.id === 'generated-witness'), false)

  const replayed = await eventStore.replay('AUTONOMY-30', { use_snapshots: false })
  assert.deepEqual(replayed.state, loaded.state)
  const reopened = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState, snapshotEvery: 7 })
  const restarted = await reopened.load('AUTONOMY-30')
  assert.deepEqual(restarted.state, loaded.state)

  const duplicate = await autonomy.completeEncounter({ campaignId: 'AUTONOMY-30', outcome: 'enemies_defeated', idempotencyKey: 'turn-completion' })
  assert.deepEqual(duplicate.state, loaded.state)
  assert.equal(turns.some((turn) => /admin/iu.test(turn.intent)), false)
  assert.ok(rulesEngine)
})

test('eval set is measurable, contains 30+ scenarios and several long campaigns', () => {
  assert.ok(AUTONOMY_EVAL_SCENARIOS.length >= 30)
  assert.ok(LONG_CAMPAIGN_EVALS.length >= 3)
  const report = createAutonomyEvalReport({
    runs: AUTONOMY_EVAL_SCENARIOS.map((scenario, index) => ({
      id: scenario.id, turns: 1, latency_ms: index + 1,
      contradictions: 0, forgotten_facts: 0, invented_facts: 0, mechanical_errors: 0,
      replay_identical: true, restart_identical: true, admin_interventions: 0,
    })),
    longCampaigns: LONG_CAMPAIGN_EVALS,
    tokenUsage: [{ input_tokens: 120, output_tokens: 30 }],
  })
  assert.equal(report.scenario_count, AUTONOMY_EVAL_SCENARIOS.length)
  assert.equal(report.story_coherence.rate, 1)
  assert.equal(report.mechanics.accuracy, 1)
  assert.equal(report.repeatability.identical_rate, 1)
  assert.equal(report.admin_interventions.count, 0)
  assert.equal(report.llm_tokens.total, 150)
  assert.ok(Number.isFinite(report.latency_ms.p95))
})

function cleanObjective(value) {
  return typeof value === 'string' && value.trim().length > 0
}

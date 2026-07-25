import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Adjudicator } from '../server/adjudicator.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { IntentParser } from '../server/intent-parser.mjs'
import { buildNarrationBrief, verifyNarration } from '../server/security.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

function hero(id, character = id) {
  return {
    id, character, name: character, hp: 10, maxHp: 10, armor: 14,
    abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [],
  }
}

function campaign(overrides = {}) {
  return normalizeCampaignState({
    sessionCode: 'FREE-ACTION',
    activePlayerId: 'hero',
    scene: { title: 'Зал', location: 'Старый трактир', objective: 'Осмотреть зал', cells: [] },
    players: [hero('hero', 'Ада'), hero('other', 'Бор')],
    ...overrides,
  })
}

async function setup(initialState = campaign()) {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-free-action-'))
  const dice = new DiceService({ rng: new SequenceDiceRng([]), idFactory: (() => { let id = 0; return () => `free-roll-${++id}` })() })
  const eventStore = new FileEventStore({
    rootDir: join(root, 'events'),
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    idFactory: (() => { let id = 0; return () => `free-event-${++id}` })(),
  })
  const rulesEngine = new RulesEngine({ diceService: dice })
  let narratorCalls = 0
  const orchestrator = new GameOrchestrator({
    rulesEngine,
    eventStore,
    narrator: { render: async () => { narratorCalls += 1; throw new Error('Свободное действие не должно вызывать Narrator') } },
    idFactory: (() => { let id = 0; return () => `free-turn-${++id}` })(),
  })
  await eventStore.initializeCampaign({ campaign_id: 'FREE-ACTION', initial_state: initialState })
  return { orchestrator, eventStore, narratorCalls: () => narratorCalls, initialState }
}

function actionInput(message, idempotencyKey, state) {
  return {
    state,
    campaignId: 'FREE-ACTION',
    playerId: 'hero',
    allowedActorIds: ['hero'],
    message,
    idempotencyKey,
  }
}

test('пустой ввод получает уточнение, фиксируется без расхода хода и не показывает служебное имя поля', async () => {
  const { orchestrator, eventStore, narratorCalls } = await setup()
  const result = await orchestrator.handle(actionInput('', 'free-empty', campaign()))

  assert.match(result.narration, /Опишите действие подробнее/u)
  assert.doesNotMatch(result.narration, /message|Нужно уточнение|RulingRecorded/u)
  assert.equal(result.turn_consumed, false)
  assert.deepEqual(result.mechanics.map((event) => event.event_type), ['ActionDeclared'])
  assert.equal(narratorCalls(), 0)
  assert.ok((await eventStore.load('FREE-ACTION')).state_version > 0)
})

test('мусорный ввод не становится ruling или случайной проверкой', async () => {
  const { orchestrator } = await setup()
  const result = await orchestrator.handle(actionInput('asdkjhasdf', 'free-noise', campaign()))

  assert.equal(result.free_action_outcome, 'clarification')
  assert.match(result.narration, /Опишите действие подробнее/u)
  assert.equal(result.mechanics.some((event) => event.event_type === 'RulingRecorded'), false)
  assert.equal(result.mechanics.some((event) => event.event_type === 'AbilityCheckResolved'), false)
  assert.equal(result.turn_consumed, false)
})

test('физически невозможное действие просит подтверждённый способ вместо нерелевантной проверки', async () => {
  const { orchestrator } = await setup()
  const result = await orchestrator.handle(actionInput('Взлетаю под облака и осматриваю всю долину с высоты', 'free-impossible', campaign()))

  assert.equal(result.free_action_outcome, 'clarification')
  assert.match(result.narration, /заклинание|предмет|способность/u)
  assert.equal(result.mechanics.some((event) => event.event_type === 'AbilityCheckResolved'), false)
  assert.equal(result.mechanics.some((event) => event.event_type === 'RulingRecorded'), false)
  assert.equal(result.turn_consumed, false)
})

test('разумное импровизированное действие получает bounded consequence через единственный живой путь', async () => {
  const { orchestrator } = await setup()
  const result = await orchestrator.handle(actionInput('Подпираю дверь тяжёлой скамьёй, чтобы её не открыли снаружи', 'free-door', campaign()))

  assert.equal(result.free_action_outcome, 'bounded_ruling')
  assert.deepEqual(result.mechanics.map((event) => event.event_type), ['ActionDeclared', 'RulingRecorded', 'ObjectiveUpdated'])
  assert.equal(result.ruling.status, 'applied')
  assert.equal(result.ruling.world_change, true)
  assert.match(result.authoritative_state.scene.objective, /баррикад|дверь/u)
  assert.match(result.narration, /Следующая цель отряда/u)
  assert.doesNotMatch(result.narration, /RulingRecorded|решени[ея]\s+ведущего/u)
  assert.equal(result.turn_consumed, false)
})

test('свободное действие вне очереди фиксирует отказ, но не меняет цель и не тратит ход', async () => {
  const initialState = campaign({
    activePlayerId: 'other',
    mechanics: {
      combat: {
        active: true,
        round: 1,
        initiative: [{ actor_id: 'other' }, { actor_id: 'hero' }],
        active_index: 0,
        action_economy: {},
      },
    },
  })
  const { orchestrator } = await setup(initialState)
  const result = await orchestrator.handle(actionInput('Подпираю дверь скамьёй', 'free-out-of-turn', initialState))

  assert.equal(result.rejected, true)
  assert.match(result.narration, /Сейчас действует другой участник/u)
  assert.equal(result.turn_consumed, false)
  assert.deepEqual(result.mechanics.map((event) => event.event_type), ['ActionDeclared'])
  assert.equal(result.authoritative_state.scene.objective, initialState.scene.objective)
  assert.equal(result.mechanics.some((event) => event.event_type === 'RulingRecorded'), false)
  assert.equal(result.mechanics.some((event) => event.event_type === 'ObjectiveUpdated'), false)
})

test('повтор свободного действия с тем же idempotency_key возвращает прежний commit и replay совпадает', async () => {
  const { orchestrator, eventStore } = await setup()
  const input = actionInput('Кричу страже у ворот, что видел вора в переулке', 'free-idempotent', campaign())
  const first = await orchestrator.handle(input)
  const afterFirst = await eventStore.load('FREE-ACTION')
  const second = await orchestrator.handle(input)
  const afterSecond = await eventStore.load('FREE-ACTION')
  const replay = await eventStore.replay('FREE-ACTION')

  assert.equal(second.idempotent_replay, true)
  assert.equal(second.turn_id, first.turn_id)
  assert.equal(second.state_version, first.state_version)
  assert.deepEqual(second.mechanics, first.mechanics)
  assert.equal(afterSecond.state_version, afterFirst.state_version)
  assert.deepEqual(replay.state, afterSecond.state)
})

test('таблица сложности выбирает только серверные значения 10, 15 и 20', async () => {
  const state = campaign()
  const adjudicator = new Adjudicator()
  const make = (intent) => adjudicator.createPlan({ intent, state, retrievedRules: { results: [], confidence: 1 } })

  assert.equal((await make({ actor_id: 'hero', intent: 'ability_check', approach: 'strength', difficulty_category: 'easy', raw_message: 'проверяю дверь' })).proposed_commands[0].difficulty, 10)
  assert.equal((await make({ actor_id: 'hero', intent: 'ability_check', approach: 'strength', difficulty_category: 'hard', raw_message: 'проверяю дверь' })).proposed_commands[0].difficulty, 20)
  assert.equal((await make({ actor_id: 'hero', intent: 'ability_check', approach: 'strength', difficulty_category: '999', raw_message: 'проверяю дверь' })).proposed_commands[0].difficulty, 15)
  assert.equal((await make({ actor_id: 'hero', intent: 'saving_throw', approach: 'constitution', raw_message: 'спасбросок от ловушки' })).proposed_commands[0].difficulty, 15)
})

test('Verifier блокирует утверждение изменения мира без подтверждённого события', () => {
  const brief = buildNarrationBrief({
    visible_events: [{ event_type: 'RulingRecorded', visibility: 'public', payload: { ruling: { world_change: false } } }],
    visible_state_changes: [],
    known_environment: { scene: { location: 'Зал' } },
    permitted_npc_reactions: [],
    narration_constraints: ['no-unconfirmed-world-changes'],
  })
  const rejected = verifyNarration('Занавес мгновенно вспыхивает, и зал заполняет дым.', brief)
  assert.equal(rejected.valid, false)
  assert.ok(rejected.violations.some((violation) => violation.code === 'WORLD_CHANGE_NOT_IN_BRIEF'))
  assert.equal(verifyNarration('Ситуация остаётся открытой.', brief).valid, true)
})

test('IntentParser отделяет невозможный полёт от проверки наблюдательности', async () => {
  const intent = await new IntentParser().parse({
    message: 'Взлетаю под облака и осматриваю долину',
    playerId: 'hero',
    visibleState: { players: [{ id: 'hero' }] },
  })
  assert.equal(intent.intent, 'improvised_action')
  assert.equal(intent.free_action_kind, 'physically_impossible')
})

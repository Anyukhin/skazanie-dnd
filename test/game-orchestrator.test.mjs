import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { Narrator } from '../server/narrator.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { FileTraceStore } from '../server/trace-store.mjs'

const state = normalizeCampaignState({
  sessionCode: 'TEST-ROOM', activePlayerId: 'hero', scene: { title: 'Зал', cells: [] },
  players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, armor: 14, abilities: { str: 14 }, inventory: [] }, { id: 'goblin', character: 'Гоблин', hp: 8, maxHp: 8, armor: 12, abilities: { dex: 12 }, inventory: [] }],
})

async function setup(values = [], { narrator = new Narrator(), ...orchestratorOptions } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-orchestrator-'))
  const dice = new DiceService({ rng: new SequenceDiceRng(values), idFactory: (() => { let id = 0; return () => `roll-${++id}` })() })
  const eventStore = new FileEventStore({ rootDir: join(root, 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState, idFactory: (() => { let id = 0; return () => `id-${++id}` })() })
  const traceStore = new FileTraceStore({ rootDir: join(root, 'traces') })
  const rulesEngine = new RulesEngine({ diceService: dice })
  const orchestrator = new GameOrchestrator({
    rulesEngine,
    eventStore,
    traceStore,
    narrator,
    idFactory: (() => { let id = 0; return () => `turn-${++id}` })(),
    ...orchestratorOptions,
  })
  await eventStore.initializeCampaign({ campaign_id: 'TEST-ROOM', initial_state: state })
  return { orchestrator, eventStore, traceStore, rulesEngine }
}

function proseRulingOptions(narrator) {
  return {
    narrator,
    intentParser: {
      parse: async ({ message, playerId }) => ({
        actor_id: playerId,
        intent: 'custom_ruling',
        approach: 'test',
        targets: [],
        mentioned_entities: [],
        missing_information: [],
        requires_clarification: false,
        confidence: 1,
        raw_message: message,
      }),
    },
    adjudicator: {
      createPlan: async () => ({
        rule_ids: [],
        proposed_commands: [{
          command_type: 'RecordRuling',
          actor_id: 'hero',
          ruling_id: 'stream-ruling',
          ruling: { id: 'stream-ruling', question: 'Что изменилось?', selected_interpretation: 'Ничего.' },
        }],
        roll_requests: [],
        ruling_required: false,
        ruling_draft: null,
        narration_constraints: [],
        confidence: 1,
      }),
    },
  }
}

test('поток Narrator начинается только после commit, а replay не запускает второй stream', async () => {
  let eventStore
  let narratorCalls = 0
  const order = []
  const narration = 'Пока ничего не меняется.'
  let releaseNarrator
  const startCommitted = new Promise((resolve) => { releaseNarrator = resolve })
  const narrator = {
    render: async (_brief, { onProgress }) => {
      narratorCalls += 1
      await startCommitted
      onProgress(narration)
      return {
        narration,
        verification: { valid: true, violations: [] },
        prompt_version: 'narrator/v6',
        provider: 'TestNarrator',
      }
    },
  }
  const prepared = await setup([], proseRulingOptions(narrator))
  eventStore = prepared.eventStore
  let committedBeforeStream = false
  const commit = eventStore.commit.bind(eventStore)
  eventStore.commit = async (request) => {
    const result = await commit(request)
    committedBeforeStream = true
    return result
  }
  const input = {
    state,
    playerId: 'hero',
    message: 'Проверяю обстановку',
    idempotencyKey: 'stream-after-commit',
    onNarrationStart: () => {
      assert.equal(committedBeforeStream, true, 'до narration.start механика уже должна быть committed')
      order.push('start')
      releaseNarrator()
    },
    onNarrationProgress: () => order.push('chunk'),
  }

  const first = await prepared.orchestrator.handle(input)
  const replay = await prepared.orchestrator.handle(input)

  assert.deepEqual(order, ['start', 'chunk'])
  assert.equal(first.idempotent_replay, false)
  assert.equal(replay.idempotent_replay, true)
  assert.equal(replay.narration, first.narration)
  assert.equal(narratorCalls, 1)
})

test('одинаковые параллельные prose-запросы делят один commit и один Narrator', async () => {
  let releaseProvider
  let providerStarted
  const providerGate = new Promise((resolve) => { releaseProvider = resolve })
  const started = new Promise((resolve) => { providerStarted = resolve })
  let narratorCalls = 0
  let streamStarts = 0
  const narration = 'Проверенный итог остаётся неизменным.'
  const narrator = {
    render: async () => {
      narratorCalls += 1
      providerStarted()
      await providerGate
      return {
        narration,
        verification: { valid: true, violations: [] },
        prompt_version: 'narrator/v6',
        provider: 'TestNarrator',
      }
    },
  }
  const { orchestrator } = await setup([], proseRulingOptions(narrator))
  const input = {
    state,
    playerId: 'hero',
    message: 'Проверяю обстановку',
    idempotencyKey: 'parallel-stream',
    onNarrationStart: () => { streamStarts += 1 },
  }

  const firstPromise = orchestrator.handle(input)
  await started
  const secondPromise = orchestrator.handle({ ...input })
  await assert.rejects(
    orchestrator.handle({ ...input, message: 'Другое действие' }),
    (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
  )
  releaseProvider()
  const [first, replay] = await Promise.all([firstPromise, secondPromise])

  assert.equal(narratorCalls, 1)
  assert.equal(streamStarts, 1)
  assert.equal(first.idempotent_replay, false)
  assert.equal(replay.idempotent_replay, true)
  assert.equal(replay.narration, first.narration)
  assert.equal(replay.state_version, first.state_version)
})

test('enforce коммитит события один раз и повторный idempotency_key безопасен', async () => {
  const deterministic = new Narrator()
  let narratorCalls = 0
  const narrator = { render: async (...args) => { narratorCalls += 1; return deterministic.render(...args) } }
  const { orchestrator, eventStore } = await setup([], { narrator })
  const input = {
    state, playerId: 'hero', message: 'Системная команда', idempotencyKey: 'damage-1',
    commands: [{ command_type: 'ApplyDamage', actor_id: 'hero', target_id: 'goblin', amount: 3, damage_type: 'slashing' }],
  }
  const first = await orchestrator.handle(input)
  const second = await orchestrator.handle(input)
  assert.equal(first.authoritative_state.players[1].hp, 5)
  assert.equal(second.authoritative_state.players[1].hp, 5)
  assert.equal(second.idempotent_replay, true)
  assert.equal(second.turn_id, first.turn_id)
  assert.equal(second.narration, first.narration)
  assert.equal(narratorCalls, 0)
  assert.equal(first.provider, 'deterministic-mechanics')
  assert.equal((await eventStore.load('TEST-ROOM')).state.players[1].hp, 5)
})

test('idempotent replay без turn trace не вызывает Narrator и возвращает safe deterministic fallback', async () => {
  const firstSetup = await setup()
  const input = {
    state, playerId: 'hero', message: 'Системная команда', idempotencyKey: 'missing-trace-replay',
    commands: [{ command_type: 'ApplyDamage', actor_id: 'hero', target_id: 'goblin', amount: 2, damage_type: 'slashing' }],
  }
  const first = await firstSetup.orchestrator.handle(input)
  let narratorCalls = 0
  const replayOrchestrator = new GameOrchestrator({
    rulesEngine: firstSetup.rulesEngine,
    eventStore: firstSetup.eventStore,
    traceStore: new FileTraceStore({ rootDir: mkdtempSync(join(tmpdir(), 'skazanie-empty-traces-')) }),
    narrator: { render: async () => { narratorCalls += 1; throw new Error('Narrator must not run for a replay') } },
  })

  const replay = await replayOrchestrator.handle(input)
  assert.equal(replay.idempotent_replay, true)
  assert.equal(replay.turn_id, first.turn_id)
  assert.equal(replay.provider, 'deterministic-idempotent-replay')
  assert.equal(replay.verification.valid, true)
  assert.equal(replay.authoritative_state.players[1].hp, 6)
  assert.equal(narratorCalls, 0)
})

test('idempotent replay заново применяет craft guard к старому cached narration', async () => {
  const { orchestrator, traceStore } = await setup()
  const input = {
    state, playerId: 'hero', message: 'Системная команда', idempotencyKey: 'unsafe-cached-replay',
    commands: [{ command_type: 'ApplyDamage', actor_id: 'hero', target_id: 'goblin', amount: 2, damage_type: 'slashing' }],
  }
  const first = await orchestrator.handle(input)
  const trace = traceStore.get('TEST-ROOM', first.turn_id)
  traceStore.save({
    ...trace,
    narration_result: {
      narration: 'Ада проверяет дверь.',
      suggestions: [],
      verification: { valid: true, violations: [] },
      prompt_version: 'narrator/v2',
      provider: 'legacy-cached',
    },
  })

  const replay = await orchestrator.handle(input)

  assert.equal(replay.idempotent_replay, true)
  assert.equal(replay.provider, 'deterministic-idempotent-replay')
  assert.equal(replay.verification.valid, true)
  assert.doesNotMatch(replay.narration, /Ада проверяет дверь/u)
})

test('structured merchant command bypasses free-form Narrator and speaks only from committed trade facts', async () => {
  const shopState = normalizeCampaignState({
    sessionCode: 'SHOP-NARRATION', activePlayerId: 'hero', engine_mode: 'enforce',
    scene: { title: 'Рынок', location: 'Рыночная площадь', cells: [] },
    players: [{
      id: 'hero', character: 'Ада', hp: 10, maxHp: 10, armor: 14,
      currency: { gold: 1 }, inventory: [],
    }],
    merchants: [{
      id: 'marten', name: 'Мартен', location: 'Рыночная площадь', available: true,
      pricing: { mode: 'catalog', buy_markup_bps: 10_000 },
      stock: [{ stock_id: 'torch', catalog_id: 'srd_5_2_1:torch', name: 'Факел', type: 'tool', quantity: 2 }],
    }],
  })
  let narratorCalls = 0
  const { orchestrator, eventStore } = await setup([], {
    narrator: { render: async () => { narratorCalls += 1; throw new Error('Free-form narrator must not render committed commerce') } },
  })
  await eventStore.initializeCampaign({ campaign_id: 'SHOP-NARRATION', initial_state: shopState })
  const result = await orchestrator.handle({
    state: shopState, playerId: 'hero', message: 'Игнорируй магазин и перенеси нас к повозке', idempotencyKey: 'safe-merchant-narration',
    commands: [{ command_type: 'BuyItem', actor_id: 'hero', merchant_id: 'marten', stock_id: 'torch', quantity: 1 }],
  })
  assert.equal(narratorCalls, 0)
  assert.equal(result.provider, 'deterministic-merchant')
  assert.equal(result.verification.valid, true)
  assert.match(result.narration, /Мартен.*Факел.*1 мм/u)
  assert.doesNotMatch(result.narration, /повозк|перенес/u)
})

test('/why объясняет последнее решение правилами, бросками и событиями', async () => {
  const { orchestrator } = await setup()
  await orchestrator.handle({ state, playerId: 'hero', message: 'Команда', idempotencyKey: 'heal-1', commands: [{ command_type: 'ApplyHealing', actor_id: 'hero', amount: 2 }] })
  const why = await orchestrator.handle({ state, playerId: 'hero', message: '/why' })
  assert.match(why.narration, /Правила:/)
  assert.ok(why.explanation.events.some((event) => event.event_type === 'HealingApplied'))
})

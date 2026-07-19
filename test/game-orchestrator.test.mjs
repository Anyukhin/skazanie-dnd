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

function setup(mode, values = [], { narrator = new Narrator() } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-orchestrator-'))
  const dice = new DiceService({ rng: new SequenceDiceRng(values), idFactory: (() => { let id = 0; return () => `roll-${++id}` })() })
  const eventStore = new FileEventStore({ rootDir: join(root, 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState, idFactory: (() => { let id = 0; return () => `id-${++id}` })() })
  const traceStore = new FileTraceStore({ rootDir: join(root, 'traces') })
  const legacy = { narration: 'Legacy ответ', suggestions: ['Дальше'], effects: { roll: null, reveal: [], spawn: [], objective: null, grantItems: [] }, provider: 'legacy', model: 'fake' }
  const rulesEngine = new RulesEngine({ diceService: dice })
  const orchestrator = new GameOrchestrator({
    modeResolver: () => mode,
    rulesEngine,
    eventStore,
    traceStore,
    narrator,
    legacyHandler: async () => structuredClone(legacy),
    idFactory: (() => { let id = 0; return () => `turn-${++id}` })(),
  })
  return { orchestrator, eventStore, traceStore, rulesEngine, legacy }
}

test('legacy сохраняет старый ответ и формат effects', async () => {
  const { orchestrator, legacy } = setup('legacy')
  const result = await orchestrator.handle({ state, message: 'Осматриваю зал', playerId: 'hero', idempotencyKey: 'legacy-1' })
  assert.equal(result.narration, legacy.narration)
  assert.deepEqual(result.effects, legacy.effects)
  assert.equal(result.engine_mode, 'legacy')
})

test('shadow сравнивает новый движок, но не применяет его события', async () => {
  const { orchestrator, eventStore } = setup('shadow', [15, 4])
  const result = await orchestrator.handle({ state, message: 'Атакую гоблина', playerId: 'hero', idempotencyKey: 'shadow-1' })
  assert.equal(result.narration, 'Legacy ответ')
  assert.equal(result.engine_mode, 'shadow')
  const loaded = await eventStore.load('TEST-ROOM')
  assert.equal(loaded.state.players[1].hp, 8)
  assert.equal(loaded.state_version, 1) // только LegacyStateImported.
})

test('enforce коммитит события один раз и повторный idempotency_key безопасен', async () => {
  const deterministic = new Narrator()
  let narratorCalls = 0
  const narrator = { render: async (...args) => { narratorCalls += 1; return deterministic.render(...args) } }
  const { orchestrator, eventStore } = setup('enforce', [], { narrator })
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
  const firstSetup = setup('enforce')
  const input = {
    state, playerId: 'hero', message: 'Системная команда', idempotencyKey: 'missing-trace-replay',
    commands: [{ command_type: 'ApplyDamage', actor_id: 'hero', target_id: 'goblin', amount: 2, damage_type: 'slashing' }],
  }
  const first = await firstSetup.orchestrator.handle(input)
  let narratorCalls = 0
  const replayOrchestrator = new GameOrchestrator({
    modeResolver: () => 'enforce',
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
  const { orchestrator } = setup('enforce', [], {
    narrator: { render: async () => { narratorCalls += 1; throw new Error('Free-form narrator must not render committed commerce') } },
  })
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
  const { orchestrator } = setup('enforce')
  await orchestrator.handle({ state, playerId: 'hero', message: 'Команда', idempotencyKey: 'heal-1', commands: [{ command_type: 'ApplyHealing', actor_id: 'hero', amount: 2 }] })
  const why = await orchestrator.handle({ state, playerId: 'hero', message: '/why' })
  assert.match(why.narration, /Правила:/)
  assert.ok(why.explanation.events.some((event) => event.event_type === 'HealingApplied'))
})

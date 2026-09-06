import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { Narrator } from '../server/narrator.mjs'
import { RollRegistry } from '../server/roll-registry.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

function state(overrides = {}) {
  return normalizeCampaignState({
    sessionCode: 'DIALOGUE',
    activePlayerId: 'hero',
    scene: { title: 'Зал', location: 'Трактир', objective: 'Осмотреть зал', cells: [] },
    players: [{
      id: 'hero', character: 'Ада', hp: 10, maxHp: 10, armor: 14,
      abilities: { str: 16, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [],
    }, { id: 'other', character: 'Бор', hp: 10, maxHp: 10, armor: 14, abilities: { str: 10 }, inventory: [] }],
    ...overrides,
  })
}

async function fixture({ rollRegistry = null, narrator = null, initialState = state(), diceValues = [18, 3, 18, 3] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-dialogue-'))
  const dice = new DiceService({ rng: new SequenceDiceRng(diceValues) })
  const eventStore = new FileEventStore({ rootDir: join(root, 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  const rulesEngine = new RulesEngine({ diceService: dice })
  const orchestrator = new GameOrchestrator({
    eventStore,
    rulesEngine,
    rollRegistry,
    narrator: narrator ?? { render: async () => ({ narration: 'Подтверждённый итог действия.', provider: 'test' }) },
  })
  await eventStore.initializeCampaign({ campaign_id: 'DIALOGUE', initial_state: initialState })
  return { orchestrator, eventStore, initial: initialState, dice }
}

function input(initial, action, idempotencyKey, extra = {}) {
  return {
    state: initial,
    campaignId: 'DIALOGUE',
    playerId: 'hero',
    allowedActorIds: ['hero'],
    message: action,
    idempotencyKey,
    ...extra,
  }
}

test('уточнение хранится на сервере, продолжение получает canonical resolved_action и переживает перезапуск оркестратора', async () => {
  const fixtureData = await fixture()
  const first = await fixtureData.orchestrator.handle(input(fixtureData.initial, 'Делаю непонятное действие', 'clarify-1'))
  assert.equal(first.free_action_outcome, 'clarification')
  assert.equal(typeof first.clarification.id, 'string')
  assert.equal(first.clarification.original_intent, undefined)
  assert.deepEqual(Object.keys(first.clarification).sort(), ['action', 'actor_id', 'campaign_id', 'id', 'question', 'state_version'])

  const restarted = new GameOrchestrator({
    eventStore: fixtureData.eventStore,
    rulesEngine: new RulesEngine({ diceService: fixtureData.dice }),
    narrator: { render: async () => ({ narration: 'Действие принято.', provider: 'test' }) },
  })
  const continued = await restarted.handle(input(fixtureData.initial, 'Подпираю дверь скамьёй', 'clarify-2', {
    clarification_id: first.clarification.id,
  }))
  assert.match(continued.resolved_action, /Делаю непонятное действие.*Подпираю дверь/u)
  assert.ok(['check_success', 'check_failure', 'check_required'].includes(continued.free_action_outcome))
  await assert.rejects(
    restarted.handle({ ...input(fixtureData.initial, 'Подпираю дверь скамьёй', 'clarify-forged', { clarification_id: first.clarification.id }), playerId: 'other', allowedActorIds: ['other'] }),
    { code: 'CLARIFICATION_FORBIDDEN' },
  )
})

test('вопросы и обсуждение не создают бросков, событий и не повторяют текст игрока рассказчиком', async () => {
  const { orchestrator, eventStore, initial } = await fixture()
  const question = await orchestrator.handle(input(initial, 'Можно ли открыть эту дверь?', 'question-1'))
  assert.equal(question.action_kind, 'question')
  assert.equal(question.turn_consumed, false)
  assert.deepEqual(question.mechanics, [])
  assert.equal(question.effects.roll, null)
  const discussion = await orchestrator.handle(input(initial, 'Давайте подождём товарища', 'discussion-1'))
  assert.equal(discussion.action_kind, 'discussion')
  assert.equal(discussion.narration, '')
  assert.deepEqual(discussion.mechanics, [])
  assert.equal((await eventStore.load('DIALOGUE')).state_version, 0)
})

test('изменённая до броска заявка отменяет старую карточку проверки', async () => {
  const registry = new RollRegistry({ diceService: new DiceService({ rng: new SequenceDiceRng([18, 18]) }) })
  const { orchestrator, initial } = await fixture({ rollRegistry: registry })
  const offered = await orchestrator.handle(input(initial, 'Подпираю дверь тяжёлой скамьёй', 'proposal-1'))
  const oldCheckId = offered.check.check_id
  const edited = await orchestrator.handle(input(initial, 'Подпираю дверь верёвкой', 'proposal-2', {
    supersedes_check_id: oldCheckId,
  }))
  assert.equal(edited.free_action_outcome, 'check_required')
  assert.notEqual(edited.check.check_id, oldCheckId)
  assert.throws(() => registry.issue({ checkId: oldCheckId, campaignId: 'DIALOGUE', actorId: 'hero' }), { code: 'CHECK_INVALIDATED' })
})

test('непонятный fallback не создаёт проверку Восприятия', async () => {
  const registry = new RollRegistry({ diceService: new DiceService({ rng: new SequenceDiceRng([18]) }) })
  const { orchestrator, initial } = await fixture({ rollRegistry: registry })
  const result = await orchestrator.handle(input(initial, 'Что-то странное и непонятное', 'unknown-1'))
  assert.equal(result.free_action_outcome, 'clarification')
  assert.equal(registry.checks.size, 0)
  assert.equal(result.mechanics.some((event) => event.event_type === 'AbilityCheckResolved'), false)
})

test('фраза «Бросаю шишку и пытаюсь поймать её ртом» получает уточнение без проверки Мудрости', async () => {
  const registry = new RollRegistry({ diceService: new DiceService({ rng: new SequenceDiceRng([18]) }) })
  const { orchestrator, initial } = await fixture({ rollRegistry: registry })
  const result = await orchestrator.handle(input(initial, 'Бросаю шишку и пытаюсь поймать её ртом', 'unknown-catch-1'))
  assert.equal(result.free_action_outcome, 'clarification')
  assert.equal(registry.checks.size, 0)
  assert.equal(result.mechanics.some((event) => event.event_type === 'AbilityCheckResolved'), false)
})

test('после commit рассказчик получает исходное намерение и подтверждённые события', async () => {
  let receivedBrief = null
  const { orchestrator, initial } = await fixture({
    narrator: {
      render: async (brief) => {
        receivedBrief = brief
        return { narration: 'Ада подпирает дверь, и проход закрыт.', provider: 'test-narrator' }
      },
    },
  })
  const result = await orchestrator.handle(input(initial, 'Подпираю дверь тяжёлой скамьёй', 'narration-1'))
  assert.equal(result.provider, 'test-narrator')
  assert.match(receivedBrief.known_environment.player_intent.action, /Подпираю дверь/u)
  assert.ok(receivedBrief.visible_events.some((event) => event.event_type === 'AbilityCheckResolved'))
  assert.match(result.narration, /дверь/u)
})

test('реальный deterministic Narrator даёт bounded текст исходной задумки без сырых механических ключей', async () => {
  const { orchestrator, initial } = await fixture({ narrator: new Narrator(), diceValues: [1, 1] })
  const result = await orchestrator.handle(input(initial, 'Подпираю дверь верёвкой', 'narrator-deterministic-free-action'))
  assert.match(result.narration, /Задумка.*Подпираю дверь верёвкой.*не удалась/u)
  assert.doesNotMatch(result.narration, /athletics|minute|Намерение героя принято|Для действия сохранён/u)
  assert.doesNotMatch(result.narration, /\.\./u)
  assert.ok(result.mechanics.some((event) => event.event_type === 'TimeAdvanced'))
})

test('ответ на вопрос по карточке не склеивает двойные точки', async () => {
  const registry = new RollRegistry({ diceService: new DiceService({ rng: new SequenceDiceRng([18]) }) })
  const { orchestrator, initial } = await fixture({ rollRegistry: registry })
  const offer = await orchestrator.handle(input(initial, 'Подпираю дверь верёвкой', 'question-card-offer'))
  const answer = await orchestrator.handle(input(initial, 'Почему нужен бросок?', 'question-card-answer', {
    request_kind: 'question',
    question_check_id: offer.check.check_id,
  }))
  assert.match(answer.narration, /Карточка готова/u)
  assert.doesNotMatch(answer.narration, /\.\./u)
})

test('ответ на уточнение действительно заполняет недостающую цель и исполняет исходную атаку', async () => {
  const initialState = state({
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 8, maxHp: 8, armor: 10, alive: true }],
    mechanics: {
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'hero' }, { actor_id: 'goblin' }],
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
  const { orchestrator, initial } = await fixture({ initialState })
  const first = await orchestrator.handle(input(initial, 'Атакую', 'missing-target-1'))
  assert.equal(first.action_kind, 'clarification')
  const continued = await orchestrator.handle(input(initial, 'Гоблина', 'missing-target-2', {
    clarification_id: first.clarification.id,
  }))
  assert.match(continued.resolved_action, /Атакую.*Гоблина/u)
  assert.ok(continued.mechanics.some((event) => event.event_type === 'AttackResolved'))
})

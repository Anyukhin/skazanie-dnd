import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { applyGameEvent, normalizeCampaignState, RulesEngine } from '../server/rules-engine.mjs'
import { classifyFreeActionKind, IntentParser } from '../server/intent-parser.mjs'
import { isEncounterRequest } from '../src/director-continuation.mjs'
import { fallbackDirectorIntent } from '../server/director-agent.mjs'

const ENCOUNTER_REQUEST = 'Ищем бой с грабителем, укравшим припасы: идём по дороге к старой мельнице и внимательно смотрим по сторонам.'

function cells(width = 9, height = 5) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
    type: 'floor',
    revealed: true,
  }))
}

function campaign() {
  return normalizeCampaignState({
    sessionCode: 'COMBAT-ENTRY',
    partyMemberIds: ['hero', 'companion'],
    activePlayerId: 'hero',
    scene: {
      title: 'Старая дорога',
      location: 'Старая дорога',
      objective: 'Найти пропавшие припасы',
      cells: cells(),
    },
    players: [
      { id: 'hero', character: 'Лада', hp: 12, maxHp: 12, armor: 16, level: 1, proficiency: 2, abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, x: 1, y: 2, inventory: [] },
      { id: 'companion', character: 'Бор', hp: 10, maxHp: 10, armor: 14, level: 1, proficiency: 2, abilities: { str: 10, dex: 12, con: 12, int: 10, wis: 14, cha: 10 }, x: 2, y: 2, inventory: [] },
    ],
    enemies: [],
    mechanics: { positions: { hero: { x: 1, y: 2 }, companion: { x: 2, y: 2 } } },
  })
}

async function setup(initialState = campaign(), t) {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-combat-entry-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const eventStore = new FileEventStore({
    rootDir: join(root, 'events'),
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
  })
  const rulesEngine = new RulesEngine({
    diceService: new DiceService({ rng: new SequenceDiceRng(Array(32).fill(12)) }),
  })
  const orchestrator = new GameOrchestrator({
    eventStore,
    rulesEngine,
    narrator: { render: async () => ({ narration: 'Запасное повествование.', provider: 'deterministic-test' }) },
  })
  await eventStore.initializeCampaign({ campaign_id: initialState.sessionCode, initial_state: initialState })
  return { orchestrator, eventStore }
}

test('сложная просьба о поиске боя не становится ни encounter-командой, ни обыском тела', async () => {
  const intent = await new IntentParser().parse({
    message: ENCOUNTER_REQUEST,
    playerId: 'hero',
    visibleState: campaign(),
  })

  assert.equal(isEncounterRequest(ENCOUNTER_REQUEST), false)
  assert.equal(intent.intent, 'improvised_action')
  assert.equal(intent.free_action_kind, null)
})

test('интерфейс передаёт только явные короткие просьбы существующей политике встреч', () => {
  for (const message of ['Ищем бой', 'Хочу бой!', 'Начать бой.', 'Начинаем бой']) {
    assert.equal(isEncounterRequest(message), true, message)
    assert.equal(fallbackDirectorIntent(campaign(), message).type, 'request_encounter', message)
  }
  for (const message of ['Атакуем Миру', 'Нападаем на охранника', 'Ищем бой с грабителем', 'Начать бой?', 'Не хочу бой']) {
    assert.equal(isEncounterRequest(message), false, message)
  }
  assert.equal(isEncounterRequest('Начать бой', { npcId: 'mira' }), false)
  assert.equal(isEncounterRequest('Начать бой', { requestKind: 'question' }), false)
  assert.equal(isEncounterRequest('Начать бой', { requestKind: 'discussion' }), false)
})

test('обыск тела использует точные словоформы и не ловит телегу, телескоп или остановку', () => {
  for (const message of ['Обыскиваю тело гоблина', 'Проверяю труп разбойника', 'Осматриваю останки', 'Ищу карманы тела', 'Проверяю содержимое карманов', 'Обыскиваю пять тел']) {
    assert.equal(classifyFreeActionKind(message), 'corpse_search', message)
  }
  for (const message of ['Ищу телегу', 'Осматриваю телескоп', 'Проверяю остановку', 'Ищу бой с грабителем', 'Осматриваю карманные часы', 'Осматриваю труппу артистов']) {
    assert.notEqual(classifyFreeActionKind(message), 'corpse_search', message)
  }
})

test('сложная N08-фраза остаётся обычным free-action путём без встречи', async (t) => {
  const initial = campaign()
  const { orchestrator, eventStore } = await setup(initial, t)
  const result = await orchestrator.handle({
    state: initial,
    campaignId: initial.sessionCode,
    playerId: 'hero',
    allowedActorIds: ['hero'],
    message: ENCOUNTER_REQUEST,
    idempotencyKey: 'combat-entry-free-action',
  })

  assert.equal(result.mechanics.some((event) => event.event_type === 'EncounterCreated'), false)
  assert.equal(result.mechanics.some((event) => event.event_type === 'CombatStarted'), false)
  const persisted = await eventStore.load(initial.sessionCode)
  assert.equal(persisted.state.enemies.length, 0)
  assert.equal(persisted.state.mechanics.combat.active, false)
})

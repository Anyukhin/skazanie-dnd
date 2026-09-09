import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { RulesEngine, normalizeCampaignState, applyGameEvent } from '../server/rules-engine.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { AutonomousCampaignOrchestrator } from '../server/autonomous-orchestrator.mjs'
import { ActionAdjudicator } from '../server/action-adjudicator.mjs'
import { IntentParser, inferRequestKind } from '../server/intent-parser.mjs'
import { createTacticalMap, setCell, setDoor, serializeTacticalMap, legacyCellsFromTacticalMap } from '../server/tactical-map.mjs'

async function fixture({ reader = new ActionAdjudicator(), narrator, state: extra = {} } = {}) {
  const state = normalizeCampaignState({
    sessionCode: 'DM-UPGRADE', activePlayerId: 'hero', partyMemberIds: ['hero'],
    scene: { title: 'Караульная', location: 'Караульная', objective: 'Найти пропавшего курьера', cells: [] },
    players: [{ id: 'hero', character: 'Ада', hp: 12, maxHp: 12, armor: 14, speed: 30,
      abilities: { str: 14, dex: 14, con: 12, int: 12, wis: 12, cha: 12 },
      currency: { gold: 10 }, inventory: [{ id: 'rope', name: 'Верёвка', quantity: 1 }] }],
    ...extra,
  })
  const eventStore = new FileEventStore({ rootDir: join(mkdtempSync(join(tmpdir(), 'skazanie-dm-upgrade-')), 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaign_id: state.sessionCode, initial_state: state })
  const rulesEngine = new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([18, 18, 18]) }) })
  const unknownActionHandler = new AutonomousCampaignOrchestrator({ eventStore, rulesEngine, actionAdjudicator: reader })
  const game = new GameOrchestrator({ eventStore, rulesEngine, unknownActionHandler, ...(narrator ? { narrator } : {}) })
  let next = 0
  return { state, game, eventStore, send: async (message, options = {}) => game.handle({ state: (await eventStore.load(state.sessionCode)).state, playerId: 'hero', message, idempotencyKey: `upgrade-${++next}`, ...options }) }
}

test('обычная работа с верёвкой не становится явным запросом проверки Мудрости', async () => {
  const { state } = await fixture()
  const intent = await new IntentParser().parse({ playerId: 'hero', visibleState: state, message: 'Развязываю и заново завязываю верёвку, проверяя прочность узлов перед использованием.' })
  assert.equal(intent.intent, 'improvised_action')
  assert.equal(inferRequestKind('А если вместо камня бросить монету?'), 'question')
})

test('упоминание удара в адресной речи остаётся разговором, а не атакой', async () => {
  const { state } = await fixture({ state: roomWithDoor() })
  const intent = await new IntentParser().parse({ playerId: 'hero', visibleState: state,
    message: 'Говорю Мире: предлагаю условный сигнал — три удара по пустой кружке.' })
  assert.equal(intent.intent, 'social')
  assert.deepEqual(intent.targets, ['mira'])
})

test('прямое обращение по имени выбирает видимого собеседника, а одинаковые имена требуют уточнения', async () => {
  const { state } = await fixture({ state: roomWithDoor() })
  const parser = new IntentParser()
  const message = 'Мира, напомни, какой условный сигнал мы выбрали?'
  const parsed = await parser.parse({ playerId: 'hero', visibleState: state, message })
  assert.equal(parsed.intent, 'social')
  assert.deepEqual(parsed.targets, ['mira'])
  state.social.npcs.push({ ...state.social.npcs[0], id: 'other-mira', name: 'Мира Лесная' })
  const ambiguous = await parser.parse({ playerId: 'hero', visibleState: state, message })
  assert.equal(ambiguous.requires_clarification, true)
  assert.deepEqual(ambiguous.missing_information, ['ambiguous_npc'])
  const hidden = await parser.parse({ playerId: 'hero', visibleState: { ...state, social: { npcs: [] } }, message })
  assert.deepEqual(hidden.targets, [])
  const physical = await parser.parse({ playerId: 'hero', visibleState: state, message: 'Подхожу к Мире, затем открываю дверь' })
  assert.notEqual(physical.intent, 'social')
})

test('безопасная импровизация сохраняет цель и не вызывает модель, даже когда она доступна', async () => {
  let calls = 0
  const reader = new ActionAdjudicator({ llmClient: { completeJson: async () => { calls += 1; throw Error('не нужен') } } })
  const { send, state, eventStore } = await fixture({ reader })
  const response = await send('Подбрасываю монету и ловлю её другой рукой')
  assert.equal(response.free_action_outcome, 'auto_success')
  assert.equal(calls, 0)
  assert.equal(response.effects.roll, null)
  assert.equal(response.authoritative_state.scene.objective, state.scene.objective)
  assert.ok(!response.mechanics.some(event => event.event_type === 'ObjectiveUpdated'))
  const replay = await eventStore.load(state.sessionCode)
  assert.equal(replay.state.scene.objective, state.scene.objective)
})

test('упоминание ворот не создаёт сообщения о воре или другой новой цели', async () => {
  const reader = { read: async (_state, _actor, action) => ({ goal_summary: action, approach_summary: action, ability: 'cha', skill: 'persuasion', plausibility: 'trivial', risk: 'none', required_means: [], effect: 'none', source: 'agent-adjudicator' }) }
  const { send, state } = await fixture({ reader })
  const response = await send('Сравниваю рассказы о Северных воротах')
  assert.equal(response.authoritative_state.scene.objective, state.scene.objective)
  assert.doesNotMatch(response.narration, /сообщени[ея] о воре/u)
})

test('вопрос о способе получает предметное объяснение без событий и броска', async () => {
  const { send, eventStore, state } = await fixture()
  const response = await send('Можно ли отвлечь собеседника стуком по столу?', { requestKind: 'question' })
  assert.match(response.narration, /внимани|отвлеч/u)
  assert.doesNotMatch(response.narration, /точного ответа пока нет/u)
  assert.deepEqual(response.mechanics, [])
  assert.equal(response.effects.roll, null)
  assert.equal((await eventStore.load(state.sessionCode)).state_version, 0)
})

test('тёплая память рассказчика включает только что выполненную свободную импровизацию', async () => {
  const { send, game, state } = await fixture({ narrator: { render: async () => ({ narration: 'Монета снова у вас в ладони.', provider: 'test' }) } })
  const response = await send('Подбрасываю монету и ловлю её другой рукой')
  assert.ok(game.recentNarrationsFor(state.sessionCode).includes(response.narration))
})

test('последовательный план исполняется по одному подтверждённому шагу и переживает вопрос между шагами', async () => {
  const { send, eventStore, state } = await fixture()
  const planned = await send('Сначала подбрасываю монету и ловлю её другой рукой; затем сматываю верёвку')
  assert.equal(planned.action_kind, 'clarification')
  assert.deepEqual(planned.mechanics, [])
  const first = await send('Да', { clarificationId: planned.clarification.id, requestKind: 'action', idempotencyKey: 'sequence-first' })
  assert.equal(first.free_action_outcome, 'auto_success')
  assert.match(first.clarification.action, /сматываю верёвку/u)
  assert.equal(first.mechanics.filter(event => event.event_type === 'ActionDeclared').length, 1)
  const repeated = await send('Да', { clarificationId: planned.clarification.id, requestKind: 'action', idempotencyKey: 'sequence-first' })
  assert.equal(repeated.idempotent_replay, true)
  assert.equal(repeated.clarification.id, first.clarification.id)
  const version = (await eventStore.load(state.sessionCode)).state_version
  const discussion = await send('Почему без проверки?', { requestKind: 'question', clarificationId: first.clarification.id })
  assert.deepEqual(discussion.mechanics, [])
  assert.equal((await eventStore.load(state.sessionCode)).state_version, version)
  const second = await send('Да', { clarificationId: first.clarification.id, requestKind: 'action' })
  assert.equal(second.free_action_outcome, 'auto_success')
  assert.equal(second.clarification ?? null, null)
  assert.equal(second.authoritative_state.scene.objective, state.scene.objective)
})

function roomWithDoor() {
  const map = createTacticalMap({ width: 6, height: 3, locationId: 'room', seed: 'dialogue-effects' })
  for (let y = 0; y < 3; y++) for (let x = 0; x < 6; x++) setCell(map, x, y, { passable: true, revealed: true, material: 'stone' })
  setDoor(map, { id: 'door', x: 1, y: 1, dir: 'e', state: 'closed' })
  return {
    scene: { title: 'Караульная', location: 'Караульная', location_id: 'room', objective: 'Найти курьера', map: serializeTacticalMap(map), cells: legacyCellsFromTacticalMap(map) },
    players: [{ id: 'hero', character: 'Ада', x: 1, y: 1, hp: 12, maxHp: 12, armor: 14, speed: 30, abilities: { str: 14, dex: 14 }, inventory: [{ id: 'rope', name: 'Верёвка', quantity: 1 }] }],
    social: { npcs: [{ id: 'mira', name: 'Мира Ветрокрыл', role: 'проводница', location: 'Караульная', visibility: 'party', available: true }] },
    npc_world: { schema_version: 3, placements: [{ npc_id: 'mira', location_id: 'room', x: 5, y: 1 }], inventories: {}, vitals: {} },
  }
}

test('открывание и закрывание двери свободным текстом меняют реальную дверь и переживают replay', async () => {
  let reads = 0
  const { send, game, state, eventStore } = await fixture({ state: roomWithDoor(), reader: { read: async () => { reads++; throw Error('стандартная дверь без модели') } } })
  const opened = await send('Открываю дверь ломом', { idempotencyKey: 'open-door' })
  assert.ok(opened.mechanics.some(event => event.event_type === 'DoorStateChanged' && event.payload.state === 'open'))
  const repeated = await send('Открываю дверь ломом', { idempotencyKey: 'open-door' })
  assert.equal(repeated.idempotent_replay, true)
  const closed = await send('Закрываю дверь')
  assert.ok(closed.mechanics.some(event => event.event_type === 'DoorStateChanged' && event.payload.state === 'closed'))
  assert.equal(reads, 0)
  assert.equal((await eventStore.load(state.sessionCode)).state.scene.map.doors[0].state, 'closed')
})

test('подход к NPC и передача своей вещи исполняются реальными командами без модели', async () => {
  const initial = roomWithDoor()
  initial.scene.map.doors[0].state = 'open'
  const { send } = await fixture({ state: initial, reader: { read: async () => { throw Error('стандартная команда без модели') } } })
  const moved = await send('Подхожу к Мире')
  assert.ok(moved.mechanics.some(event => event.event_type === 'ActorMoved'))
  const transferred = await send('Передаю верёвку Мире')
  assert.equal(transferred.free_action_outcome, 'item_transfer')
  assert.equal(transferred.authoritative_state.players[0].inventory.some(item => item.id === 'rope'), false)
  assert.ok(transferred.authoritative_state.npc_world.inventories.mira.length > 0)
})

test('баррикада из своей верёвки подтверждается, блокирует дверь и не расходуется повторно', async () => {
  const { send, state, eventStore } = await fixture({ state: roomWithDoor() })
  const offered = await send('Подпираю дверь верёвкой')
  assert.equal(offered.clarification.confirmation_required, true)
  assert.equal(offered.mechanics.length, 0)
  const options = { requestKind: 'action', clarificationId: offered.clarification.id, idempotencyKey: 'barrier-confirm' }
  const placed = await send('Да', options)
  assert.ok(placed.mechanics.some(event => event.event_type === 'DoorBarricaded'))
  assert.equal(placed.authoritative_state.players[0].inventory.length, 0)
  const replay = await send('Да', options)
  assert.equal(replay.idempotent_replay, true)
  assert.equal((await eventStore.load(state.sessionCode)).state.players[0].inventory.length, 0)
  const blocked = await send('Открываю дверь')
  assert.equal(blocked.free_action_outcome, 'clarification')
  assert.match(blocked.narration, /баррикад/u)
  const cleared = await send('Убираю баррикаду')
  assert.ok(cleared.mechanics.some(event => event.event_type === 'DoorBarricadeCleared'))
  assert.equal(cleared.authoritative_state.scene.map.doors[0].barricade, null)
  assert.equal(cleared.authoritative_state.scene.map.doors[0].state, 'closed')
})

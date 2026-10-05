import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activeInitiativeIndex,
  combatTurnActive,
  currentTurnActorId,
  latestRoomVersion,
  mergeAuthoritativeState,
  mergeTacticalCommandState,
  parseNarrationPreview,
  pendingActionForSnapshot,
  twoPhaseCheckCommandFor,
} from '../src/game-session-state.mjs'

/**
 * Чистые правила клиентской сессии (`src/game-session-state.mjs`) напрямую,
 * без транспиляции хука. Слияния — самое рискованное: ошибка в них молча
 * откатывает экран к устаревшему снимку или теряет локальное представление.
 */

function hero(id, extra = {}) {
  return {
    id, character: `Герой ${id}`, hp: 10, maxHp: 10, x: 1, y: 1,
    abilities: { str: 10 }, currency: { gp: 1 }, inventory: [], portrait: '', portraitPosition: '',
    ...extra,
  }
}

function gameState(extra = {}) {
  return {
    sessionCode: 'A',
    campaign: 'Кампания',
    players: [hero('hero')],
    enemies: [],
    actors: [],
    merchants: [],
    messages: [],
    activePlayerId: 'hero',
    pendingCheck: null,
    pendingAction: null,
    agentInteraction: null,
    isNarrating: false,
    engine_mode: 'enforce',
    state_version: 1,
    scene: { title: 'Старая сцена', cells: [] },
    mechanics: {},
    ...extra,
  }
}

const combatAt = (index, initiative = [{ actor_id: 'hero' }, { actor_id: 'goblin' }]) => ({
  combat: { active: true, active_index: index, initiative },
})

test('latestRoomVersion: счётчик только растёт, мусор его не двигает', () => {
  assert.equal(latestRoomVersion(5, 7), 7)
  assert.equal(latestRoomVersion(5, '9'), 9)
  assert.equal(latestRoomVersion(7, 5), 7, 'устаревший снимок не откатывает версию')
  assert.equal(latestRoomVersion(5, 5), 5)
  for (const junk of [undefined, null, 'abc', -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(latestRoomVersion(5, junk), 5, String(junk))
  }
  assert.equal(latestRoomVersion(0, 0), 0)
})

test('ход: в бою — участник инициативы, вне боя и без очереди — выбранный герой', () => {
  assert.equal(currentTurnActorId(gameState()), 'hero')
  assert.equal(currentTurnActorId(gameState({ mechanics: combatAt(1) })), 'goblin')
  assert.equal(currentTurnActorId(gameState({ mechanics: combatAt('junk') })), 'hero', 'мусорный индекс — начало очереди')
  assert.equal(currentTurnActorId(gameState({ mechanics: combatAt(-3) })), 'hero')
  assert.equal(currentTurnActorId(gameState({ mechanics: combatAt(9) })), 'hero', 'индекс за очередью — выбранный герой')
  assert.equal(currentTurnActorId(gameState({ mechanics: combatAt(1, []) })), 'hero', 'бой без очереди — ещё не бой')
  assert.equal(currentTurnActorId(gameState({ mechanics: { combat: { active: false, active_index: 1, initiative: [{ actor_id: 'x' }, { actor_id: 'y' }] } } })), 'hero')

  assert.equal(combatTurnActive(gameState()), false)
  assert.equal(combatTurnActive(gameState({ mechanics: combatAt(0) })), true)
  assert.equal(combatTurnActive(gameState({ mechanics: combatAt(0, []) })), false)
  assert.equal(activeInitiativeIndex({ active_index: 2 }), 2)
  assert.equal(activeInitiativeIndex({ active_index: -1 }), 0)
  assert.equal(activeInitiativeIndex(undefined), 0)
})

test('twoPhaseCheckCommandFor: закрытый список, у предмета сцены — только молитва', () => {
  for (const command_type of ['ProposeParley', 'ResolveGuardEncounter', 'AnswerTavernDiceRound', 'CalmBeast']) {
    const command = { command_type, actor_id: 'hero' }
    assert.equal(twoPhaseCheckCommandFor(command), command, command_type)
  }
  const pray = { command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'shrine', intent: 'pray' }
  assert.equal(twoPhaseCheckCommandFor(pray), pray)
  assert.equal(twoPhaseCheckCommandFor({ ...pray, intent: 'inspect' }), null)
  for (const command_type of ['MoveActor', 'EndTurn', 'FeedBeast', 'ScareWithBeast', 'SettleParley']) {
    assert.equal(twoPhaseCheckCommandFor({ command_type, actor_id: 'hero' }), null, command_type)
  }
})

test('parseNarrationPreview: принимает кадр потока и отсекает чужое', () => {
  const frame = (payload) => JSON.stringify({ message_id: 'narration-1', text: 'Дверь скрипит', phase: 'streaming', ...payload })
  assert.deepEqual(parseNarrationPreview(frame()), { messageId: 'narration-1', text: 'Дверь скрипит', phase: 'streaming', replayed: false })
  assert.equal(parseNarrationPreview(frame({ replayed: true })).replayed, true)
  assert.equal(parseNarrationPreview(frame({ replayed: 'yes' })).replayed, false)
  assert.equal(parseNarrationPreview(frame({ phase: 'unknown' })), null)
  assert.equal(parseNarrationPreview(frame({ phase: 7 })), null)
  assert.equal(parseNarrationPreview(frame({ message_id: 'bad id with spaces' })), null)
  assert.equal(parseNarrationPreview(frame({ message_id: '' })), null)
  assert.equal(parseNarrationPreview(frame({ text: 'я'.repeat(7000) })), null, 'текст больше 12 КБ')
  assert.equal(parseNarrationPreview(frame({ pad: 'x'.repeat(17 * 1024) })), null, 'кадр больше 16 КБ')
  assert.equal(parseNarrationPreview(frame({ text: 42 })).text, '')
  assert.throws(() => parseNarrationPreview('{not json'), SyntaxError)
})

test('pendingActionForSnapshot: предложение переживает только свой снимок своей кампании', () => {
  const proposal = { id: 'p1', state_version: 4, kind: 'approach_attack', actor_id: 'hero', target_id: 'goblin' }
  const ready = { proposal, action: 'Атакую', playerId: 'hero', status: 'ready', idempotencyKey: 'k' }
  const current = gameState({ pendingAction: ready })
  assert.equal(pendingActionForSnapshot(current, gameState({ state_version: 4 })), ready, 'та же версия')
  assert.equal(pendingActionForSnapshot(current, gameState({ state_version: 5 })), null, 'версия ушла вперёд — предложение устарело')
  assert.equal(pendingActionForSnapshot(current, gameState({ sessionCode: 'B', state_version: 4 })), null, 'чужая кампания')
  const submitting = { ...ready, status: 'submitting' }
  assert.equal(pendingActionForSnapshot(gameState({ pendingAction: submitting }), gameState({ state_version: 9 })), submitting, 'отправляемое не теряется')
  assert.equal(pendingActionForSnapshot(gameState(), gameState({ state_version: 4 })), null)
})

test('mergeAuthoritativeState: без авторитетного состояния — прежний объект', () => {
  const current = gameState()
  assert.equal(mergeAuthoritativeState(current, null), current)
  assert.equal(mergeAuthoritativeState(current, { narration: 'текст' }), current)
})

test('mergeAuthoritativeState: позиции и инвентарь — только по своим событиям, хиты — всегда', () => {
  const current = gameState({ players: [hero('hero', { x: 1, y: 1, inventory: [{ id: 'old' }], portrait: 'local.png' }), hero('local-only')] })
  const server = gameState({
    state_version: 8,
    players: [hero('hero', { hp: 3, x: 5, y: 6, inventory: [{ id: 'new' }] }), hero('server-only')],
    enemies: [{ id: 'goblin', alive: true }],
    messages: [{ id: 'm1' }],
    mechanics: { round: 2 },
    scene: { title: 'Новая сцена', cells: [] },
  })
  const plain = mergeAuthoritativeState(current, { authoritative_state: server, mechanics: [{ event_type: 'DamageApplied' }] })
  const merged = plain.players.find((player) => player.id === 'hero')
  assert.equal(merged.hp, 3)
  assert.deepEqual([merged.x, merged.y], [1, 1], 'без перемещения позиция локальная')
  assert.deepEqual(merged.inventory, [{ id: 'old' }], 'без выдачи предмета инвентарь локальный')
  assert.equal(merged.portrait, 'local.png')
  assert.deepEqual(plain.players.map((player) => player.id), ['hero', 'local-only'], 'состав партии — локальный')
  assert.equal(plain.state_version, 8)
  assert.deepEqual(plain.enemies, server.enemies)
  assert.deepEqual(plain.messages, server.messages)
  assert.deepEqual(plain.mechanics, { round: 2 })
  assert.equal(plain.scene.title, 'Старая сцена', 'сцена меняется только событиями сцены')

  const moved = mergeAuthoritativeState(current, { authoritative_state: server, mechanics: [{ event_type: 'ActorMoved' }, { event_type: 'ItemGranted' }] })
  const movedHero = moved.players.find((player) => player.id === 'hero')
  assert.deepEqual([movedHero.x, movedHero.y], [5, 6])
  assert.deepEqual(movedHero.inventory, [{ id: 'new' }])
})

test('mergeAuthoritativeState: событие сцены забирает сцену целиком, версия — из ответа, если её нет в состоянии', () => {
  const current = gameState({ activePlayerId: 'hero', mapFeedback: [{ id: 'old' }] })
  const server = gameState({ scene: { title: 'Новый этаж', cells: [] }, activePlayerId: 'other', state_version: undefined, mapFeedback: undefined })
  const next = mergeAuthoritativeState(current, { authoritative_state: server, state_version: 12, mechanics: [{ event_type: 'MapLevelChanged' }] })
  assert.equal(next.scene.title, 'Новый этаж')
  assert.equal(next.activePlayerId, 'other')
  assert.deepEqual(next.mapFeedback, [])
  assert.equal(next.state_version, 12)
  assert.equal(next.engine_mode, 'enforce')
})

test('mergeTacticalCommandState: игроки сервера поверх локального представления', () => {
  const current = gameState({
    players: [hero('hero', { abilities: { str: 10, dex: 14 }, currency: { gp: 1, sp: 5 }, portrait: 'local.png', portraitPosition: 'top' })],
  })
  const authoritative = gameState({
    state_version: 3,
    players: [{ id: 'hero', hp: 4, abilities: { str: 12 }, currency: { gp: 2 } }, { id: 'newcomer', hp: 7 }],
  })
  const next = mergeTacticalCommandState(current, authoritative, {}, 'req-1')
  const merged = next.players.find((player) => player.id === 'hero')
  assert.equal(merged.hp, 4)
  assert.deepEqual(merged.abilities, { str: 12, dex: 14 })
  assert.deepEqual(merged.currency, { gp: 2, sp: 5 })
  assert.equal(merged.portrait, 'local.png', 'портрет сервер не присылает')
  assert.equal(merged.portraitPosition, 'top')
  assert.deepEqual(merged.inventory, [], 'инвентарь без серверного берётся локальный')
  assert.deepEqual(next.players.find((player) => player.id === 'newcomer'), { id: 'newcomer', hp: 7 })
  assert.equal(next.state_version, 3)
  assert.equal(next.isNarrating, false)
  assert.equal(next.pendingCheck, null)

  const emptyParty = mergeTacticalCommandState(current, gameState({ players: [] }), {}, 'req-2')
  assert.deepEqual(emptyParty.players.map((player) => player.id), ['hero'], 'пустой список сервера не стирает партию')
})

test('mergeTacticalCommandState: реплика добавляется один раз, ход берётся из инициативы', () => {
  const current = gameState({ isNarrating: true })
  const authoritative = gameState({ messages: [{ id: 'm0', text: 'раньше' }], mechanics: combatAt(1), activePlayerId: 'hero' })
  const result = { narration: '  Гоблин падает.  ', narration_message_id: 'narr-1', narration_speaker: 'narrator' }
  const next = mergeTacticalCommandState(current, authoritative, result, 'req')
  assert.equal(next.messages.length, 2)
  assert.deepEqual(
    { id: next.messages[1].id, speaker: next.messages[1].speaker, author: next.messages[1].author, text: next.messages[1].text, turnConsumed: next.messages[1].turnConsumed },
    { id: 'narr-1', speaker: 'narrator', author: 'Рассказчик', text: 'Гоблин падает.', turnConsumed: false },
  )
  assert.equal(next.activePlayerId, 'goblin', 'активный — тот, чей ход в инициативе')
  assert.equal(next.isNarrating, false)

  // Повтор того же ответа (снимок уже содержит реплику) её не удваивает.
  const replay = mergeTacticalCommandState(next, { ...authoritative, messages: next.messages }, result, 'req')
  assert.equal(replay.messages.length, 2)

  // Без id реплики ключ строится из хода или запроса; системная — от «Системы боя».
  const system = mergeTacticalCommandState(current, gameState(), { narration: 'Промах.', turn_id: 'turn-7' }, 'req-9')
  assert.equal(system.messages.at(-1).id, 'turn-7-tactical-narration')
  assert.equal(system.messages.at(-1).author, 'Система боя')
  const byRequest = mergeTacticalCommandState(current, gameState(), { narration: 'Промах.' }, 'req-9')
  assert.equal(byRequest.messages.at(-1).id, 'req-9-tactical-narration')
  const blank = mergeTacticalCommandState(current, gameState(), { narration: '   ' }, 'req-9')
  assert.equal(blank.messages.length, 0, 'пустая реплика не добавляется')
})

test('mergeTacticalCommandState: устаревшие поля сервера не держат локальную карточку и часы хода', () => {
  const current = gameState({ pendingCheck: { check_id: 'c' }, turn_clock: { deadline: 1 }, agentInteraction: { id: 'vote' }, engine_mode: 'enforce' })
  const authoritative = { ...gameState(), pendingCheck: undefined, turn_clock: undefined, agentInteraction: undefined, engine_mode: undefined, enemies: undefined }
  const next = mergeTacticalCommandState({ ...current, enemies: [{ id: 'local' }] }, authoritative, {}, 'r')
  assert.equal(next.pendingCheck, null)
  assert.equal(next.turn_clock, null)
  assert.equal(next.agentInteraction, null)
  assert.equal(next.engine_mode, 'enforce', 'режим движка без серверного остаётся локальным')
  assert.deepEqual(next.enemies, [{ id: 'local' }], 'отсутствующий список врагов не стирает локальный')
})

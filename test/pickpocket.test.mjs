import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { DiceService } from '../server/dice-service.mjs'
import { resolvePickpocket } from '../server/free-action-adjudication.mjs'
import { WANTED_CRIME_POINTS, wantedFor } from '../server/law-and-order.mjs'
import {
  PICKPOCKET_CROWD_STEPS,
  npcPassiveInsightFor,
  npcPocketFor,
  pickpocketCrowdStep,
  pickpocketDifficultyFor,
} from '../server/pickpocket.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand, validateCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'

const PLAYER = Object.freeze({ id: 'user-1', role: 'player' })
const NEIGHBOUR = Object.freeze({ id: 'user-2', role: 'player' })
const ADMIN = Object.freeze({ id: 'gm', role: 'admin' })

class FixedRng {
  constructor(value) { this.value = value }
  randint(minimum, maximum) { return Math.max(minimum, Math.min(maximum, this.value)) }
}

function dice(value = 20) {
  let id = 0
  return new DiceService({ rng: new FixedRng(value), idFactory: () => `roll-${++id}`, now: () => '2026-08-16T00:00:00.000Z' })
}

function fixture({ npcs = null, combat = false } = {}) {
  const people = npcs ?? [
    { id: 'npc-1', name: 'Горазд', role: 'купец', location: 'Рынок', available: true, visibility: 'party' },
    { id: 'npc-2', name: 'Ждан', role: 'страж', location: 'Рынок', available: true, visibility: 'party' },
  ]
  return normalizeCampaignState({
    sessionCode: 'THIEF-UNIT',
    partyMemberIds: ['hero', 'ally'],
    members: [
      { user_id: 'user-1', hero_id: 'hero', role: 'player' },
      { user_id: 'user-2', hero_id: 'ally', role: 'player' },
    ],
    players: [
      { id: 'hero', character: 'Ильма', hp: 30, maxHp: 30, armor: 14, speed: 30, level: 3, proficiency: 2, x: 1, y: 1,
        abilities: { str: 10, dex: 18, con: 12, int: 10, wis: 12, cha: 12 },
        currency: { copper: 0, silver: 0, gold: 0, platinum: 0 }, inventory: [] },
      { id: 'ally', character: 'Тарн', hp: 30, maxHp: 30, armor: 14, speed: 30, level: 3, proficiency: 2, x: 2, y: 1,
        abilities: { str: 16, dex: 10, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [] },
    ],
    social: { npcs: people },
    npc_world: {
      placements: [
        { npc_id: 'npc-1', location_id: 'Рынок', x: 2, y: 1 },
        { npc_id: 'npc-2', location_id: 'Рынок', x: 3, y: 1 },
      ],
    },
    worldMap: {
      seed: 'thief-seed',
      regions: [{ id: 'region-1', name: 'Приречье', biome: 'plains', x: 200, y: 200, radius: 205 }],
      locations: [{ id: 'market', name: 'Рынок', kind: 'town', x: 200, y: 200, regionId: 'region-1' }],
      currentLocationId: 'market',
    },
    scene: {
      turn: 1, location: 'Рынок',
      cells: Array.from({ length: 36 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true })),
    },
    mechanics: combat ? { combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero', total: 12 }] } } : {},
  })
}

/**
 * Событиям проставляется `event_id`, как это делает хранилище на коммите.
 * Без него мост «поступок → преступление» (`crimeFromDeedLedger`) не сработает:
 * он сверяет, что поступок родился именно от этого события, — и молчаливо
 * пропустил бы кражу мимо ступени розыска.
 */
function commit(state, command, { roll = 20, context = { isAdmin: true } } = {}) {
  const commandId = `${command.command_type}-${Math.random().toString(36).slice(2, 10)}`
  const result = resolveCommand(
    { campaign_id: 'campaign-1', command_id: commandId, server_authoritative: true, ...command },
    state,
    { diceService: dice(roll), context },
  )
  const events = result.events.map((event, index) => ({ ...event, event_id: event.event_id ?? `${commandId}:${index + 1}` }))
  return { events, rolls: result.rolls ?? [], state: events.reduce(applyGameEvent, state) }
}

function rejects(state, command, code, context = { isAdmin: true }) {
  assert.throws(
    () => validateCommand({ campaign_id: 'campaign-1', command_id: 'cmd-1', server_authoritative: true, ...command }, state, context),
    (error) => error.code === code,
    `${command.command_type} ожидал ${code}`,
  )
}

const eventTypes = (events) => events.map((event) => event.event_type)
const conditionsOf = (state, id) => (state.mechanics.conditions[id] ?? []).map((condition) => String(condition?.id ?? condition))

// ---------------------------------------------------------------------------
// Карман и сложность

test('карман выводится из сида, а не хранится, и один сид даёт один кошелёк', () => {
  const state = fixture()
  const first = npcPocketFor(state, { id: 'npc-1', role: 'купец' })
  const second = npcPocketFor(state, { id: 'npc-1', role: 'купец' })
  assert.deepEqual(first, second, 'replay обязан дать тот же карман')
  assert.ok(first.purse_cp > 0)
  assert.notDeepEqual(first, npcPocketFor(state, { id: 'npc-2', role: 'купец' }), 'у разных людей карманы разные')
  assert.notDeepEqual(first, npcPocketFor({ sessionCode: 'OTHER' }, { id: 'npc-1', role: 'купец' }), 'другая кампания — другой карман')
  // Нищий беднее купца по построению таблицы, а не по удаче броска.
  assert.ok(npcPocketFor(state, { id: 'npc-3', role: 'нищий' }).purse_cp < 20)
  assert.equal(npcPocketFor(state, {}), null)
})

test('толпа помогает вору, а разговор наедине — жертве', () => {
  const state = fixture()
  const npc = { id: 'npc-1', role: 'купец' }
  const alone = pickpocketDifficultyFor(state, npc, 1)
  const crowd = pickpocketDifficultyFor(state, npc, 8)
  assert.ok(crowd.difficulty < alone.difficulty, 'в толчее рука теряется, наедине — нет')
  assert.equal(alone.crowd_label, 'наедине')
  assert.equal(crowd.crowd_label, 'в толчее')
  assert.equal(pickpocketCrowdStep(0).shift, 3)
  assert.equal(pickpocketCrowdStep(999).shift, -3)
  // Ступени не пересекаются и покрывают весь диапазон.
  for (let count = 0; count <= 12; count += 1) assert.ok(PICKPOCKET_CROWD_STEPS.includes(pickpocketCrowdStep(count)))
  // Внимание жертвы — то же число, что читает карточка проверки.
  assert.equal(alone.difficulty, npcPassiveInsightFor(state, npc) + 3)
})

// ---------------------------------------------------------------------------
// Отказы

test('красть у героев нельзя, и отказ называет причину прямо', () => {
  const state = fixture()
  rejects(state, { command_type: 'PickpocketNpc', actor_id: 'hero', npc_id: 'ally' }, 'PICKPOCKET_PARTY_TARGET_FORBIDDEN')
  rejects(state, { command_type: 'PickpocketNpc', actor_id: 'hero', npc_id: 'hero' }, 'PICKPOCKET_PARTY_TARGET_FORBIDDEN')
  // И свободной фразой тоже: у отряда нет карманов друг для друга.
  const spoken = resolvePickpocket(state, 'hero', 'срезаю кошель у Тарна', {})
  assert.equal(spoken.status, 'clarification')
  assert.match(spoken.narration, /У своих не крадут/u)
})

test('посреди боя и у отсутствующего человека карманов не чистят', () => {
  rejects(fixture({ combat: true }), { command_type: 'PickpocketNpc', actor_id: 'hero', npc_id: 'npc-1' }, 'COMBAT_ACTIVE')
  rejects(fixture(), { command_type: 'PickpocketNpc', actor_id: 'hero', npc_id: 'npc-нет' }, 'NPC_NOT_PRESENT')
})

test('кража дальше пяти футов отклоняется до броска и не меняет состояние', () => {
  const state = fixture()
  state.npc_world.placements[0].x = 11
  const before = structuredClone(state)
  let diceCalls = 0
  const guardedDice = { rollCheck(...args) { diceCalls += 1; return dice(20).rollCheck(...args) } }
  assert.throws(
    () => resolveCommand(
      { campaign_id: 'campaign-1', command_id: 'pickpocket-far', server_authoritative: true,
        command_type: 'PickpocketNpc', actor_id: 'hero', npc_id: 'npc-1' },
      state,
      { diceService: guardedDice, context: { isAdmin: true } },
    ),
    (error) => error.code === 'PICKPOCKET_OUT_OF_REACH',
  )
  assert.equal(diceCalls, 0)
  assert.deepEqual(state, before)
})

test('карман один: обчищенный второй раз не отдаёт ничего', () => {
  const state = fixture()
  const first = commit(state, { command_type: 'PickpocketNpc', actor_id: 'hero', npc_id: 'npc-1' })
  assert.ok(conditionsOf(first.state, 'npc-1').includes('pocket-picked:npc-1'))
  rejects(first.state, { command_type: 'PickpocketNpc', actor_id: 'hero', npc_id: 'npc-1' }, 'PICKPOCKET_POCKET_EMPTY')
})

// ---------------------------------------------------------------------------
// Успех и провал

test('успех на соседней клетке отдаёт содержимое кармана, помечает добычу краденым и не зовёт свидетелей', () => {
  const state = fixture()
  const result = commit(state, { command_type: 'PickpocketNpc', actor_id: 'hero', npc_id: 'npc-1' }, { roll: 20 })
  const picked = result.events.find((event) => event.event_type === 'NpcPocketPicked')
  assert.ok(picked, 'удачная кража обязана иметь своё событие')
  assert.ok(picked.payload.purse_cp > 0)
  assert.equal(result.state.players[0].currency.copper + result.state.players[0].currency.silver * 10
    + result.state.players[0].currency.gold * 100, picked.payload.purse_cp)
  for (const item of result.state.players[0].inventory) assert.equal(item.origin, 'stolen')
  assert.equal(eventTypes(result.events).includes('NpcPickpocketNoticed'), false)
  // Летопись поступков молчит: удачная кража тем и удачна, что её не видели.
  assert.deepEqual(result.state.world_deeds?.deeds ?? [], [])
  assert.equal(wantedFor(result.state, 'region-1').level, 0)
})

test('провал — скандал: поступок, свидетели, отношение вниз и очки розыска', () => {
  const state = fixture()
  const result = commit(state, { command_type: 'PickpocketNpc', actor_id: 'hero', npc_id: 'npc-1' }, { roll: 1 })
  assert.ok(eventTypes(result.events).includes('NpcPickpocketNoticed'))
  assert.equal(eventTypes(result.events).includes('NpcPocketPicked'), false, 'пойманная рука не уносит ничего')
  assert.deepEqual(result.state.players[0].inventory, [])

  const deed = (result.state.world_deeds?.deeds ?? []).at(-1)
  assert.equal(deed?.kind, 'theft')
  assert.equal(deed.secret, false, 'жертва — свидетель сама по себе, даже в пустом переулке')
  assert.ok(deed.witness_ids.includes('npc-1'))
  assert.ok(deed.actor_ids.includes('hero'))

  // Эскалация идёт существующим мостом «поступок → преступление», а не своей
  // веткой: кража судится той же меркой, что поджог и погром.
  const wanted = wantedFor(result.state, 'region-1')
  assert.equal(wanted.points, WANTED_CRIME_POINTS.theft)
  assert.equal(wanted.level, 1, 'кражи хватает ровно на первую ступень')
  assert.ok(eventTypes(result.events).includes('NpcRelationshipAdjusted'))
})

test('кража переживает replay, а маркер кармана идемпотентен', () => {
  const state = fixture()
  const result = commit(state, { command_type: 'PickpocketNpc', actor_id: 'hero', npc_id: 'npc-1' }, { roll: 20 })
  const replayed = replayEvents(state, result.events)
  assert.deepEqual(replayed.players[0].currency, result.state.players[0].currency)
  assert.deepEqual(conditionsOf(replayed, 'npc-1'), ['pocket-picked:npc-1'])
  assert.deepEqual(
    conditionsOf(replayEvents(state, [...result.events, ...result.events]), 'npc-1'),
    ['pocket-picked:npc-1'],
    'повтор свёртки второго маркера не заводит',
  )
})

// ---------------------------------------------------------------------------
// Проекция

test('проекция чиста: чужой кошелёк, служебный маркер и краденое у соседа закрыты', () => {
  const state = fixture()
  const result = commit(state, { command_type: 'PickpocketNpc', actor_id: 'hero', npc_id: 'npc-1' }, { roll: 20 })

  const thief = campaignStateForViewer(result.state, PLAYER, 'hero')
  const neighbour = campaignStateForViewer(result.state, NEIGHBOUR, 'ally')
  for (const [label, room] of [['вор', thief], ['сосед', neighbour]]) {
    assert.deepEqual(room.mechanics.conditions['npc-1'] ?? [], [],
      `${label}: служебный маркер «карман обчищен» уехал столу`)
  }
  // Своё краденое вор видит, чужое соседу — нет.
  const thiefItems = thief.players.find((player) => player.id === 'hero').inventory
  const seenByNeighbour = neighbour.players.find((player) => player.id === 'hero').inventory
  for (const item of thiefItems) assert.equal(item.origin, 'stolen')
  for (const item of seenByNeighbour) assert.equal(item.origin, undefined)

  const events = mechanicsForViewer(result.events, PLAYER, 'hero', result.state)
  const picked = events.find((event) => event.event_type === 'NpcPocketPicked')
  assert.equal(picked.payload.purse_cp, undefined, 'опись чужого кармана игроку не принадлежит')
  assert.equal(typeof picked.payload.balance_after_cp, 'number', 'а свой баланс — принадлежит')

  const gm = mechanicsForViewer(result.events, ADMIN, '', result.state)
  assert.equal(gm.find((event) => event.event_type === 'NpcPocketPicked').payload.purse_cp, picked.payload.balance_after_cp)
})

// ---------------------------------------------------------------------------
// Свободная фраза

test('«обчищаю карманы» разбирается в ту же команду, что и кнопка меню', () => {
  const state = fixture()
  const spoken = resolvePickpocket(state, 'hero', 'тихонько обчищаю карманы Горазда', {})
  assert.deepEqual(spoken.command, { command_type: 'PickpocketNpc', actor_id: 'hero', npc_id: 'npc-1' })

  // Двое подходящих — уточнение, а не догадка сервера.
  assert.equal(resolvePickpocket(state, 'hero', 'срезаю кошель', {}).status, 'clarification')
  // Обыск трупа остаётся обыском: слово «карман» есть в обоих шаблонах, и
  // порядок веток — часть контракта.
  assert.equal(resolvePickpocket(state, 'hero', 'обыскиваю карманы трупа', {}), null)
  assert.equal(resolvePickpocket(state, 'hero', 'иду к лавке', {}), null)
  assert.equal(resolvePickpocket(fixture({ combat: true }), 'hero', 'обчищаю карманы Горазда', {}).status, 'clarification')
})

test('кнопка кражи идёт тем же каналом, что и свободная фраза, и не судит сама', () => {
  const board = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
  const server = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8')

  assert.match(board, /Обчистить карманы<\/button>/u)
  assert.match(board, /onNpcAction\(`Незаметно обчищаю карманы: \$\{sceneNpc\.name\}`, sceneNpc\.id\)/u)
  // Доска не выдумывает своих правил: ни СЛ, ни кармана, ни списка ролей у неё
  // нет — она только называет причину отказа до нажатия.
  assert.doesNotMatch(board, /purse_cp|pickpocketDifficulty|pocket-picked/u)

  // Дверь HTTP закрыта белым списком полей: клиент называет вора и жертву, и
  // ничего больше.
  assert.match(server, /PLAYER_PICKPOCKET_COMMANDS = new Set\(\['PickpocketNpc'\]\)/u)
  assert.match(server, /PICKPOCKET_COMMAND_UNKNOWN_FIELD/u)
})

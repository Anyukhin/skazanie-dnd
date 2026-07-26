import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `grp-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }

/** Два героя подряд в очереди, затем два врага: ровно две фазы. */
function field({ group = false } = {}) {
  const cells = Array.from({ length: 96 }, (_, index) => ({ x: index % 16, y: Math.floor(index / 16), type: 'floor', revealed: true }))
  const hero = (id, x) => ({ id, character: id, characterClass: 'fighter', level: 5, hp: 40, maxHp: 40, armor: 16, speed: 30, proficiency: 3, abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 10 }, inventory: [SWORD], x, y: 2 })
  const foe = (id, x) => ({ id, name: id, creature_type: 'humanoid', hp: 60, maxHp: 60, armor: 12, speed: 30, abilities: { str: 14, dex: 10, con: 12, int: 8, wis: 8, cha: 8 }, x, y: 2, alive: true, inventory: [SWORD] })
  return normalizeCampaignState({
    sessionCode: 'GRP-1',
    partyMemberIds: ['ann', 'bob'],
    players: [hero('ann', 1), hero('bob', 2)],
    enemies: [foe('orc', 5), foe('gob', 6)],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        group_initiative: group,
        turn_completed: [],
        initiative: [{ actor_id: 'ann', total: 20 }, { actor_id: 'bob', total: 18 }, { actor_id: 'orc', total: 10 }, { actor_id: 'gob', total: 8 }],
        action_economy: Object.fromEntries(['ann', 'bob', 'orc', 'gob'].map((id) => [id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])),
      },
    },
  })
}

const endTurn = (state, actor) => resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: actor }), state, options(dice()))
const walk = (state, actor, to) => resolveCommand(authoritative({ command_type: 'MoveActor', actor_id: actor, to }), state, options(dice()))

test('без флага очередь строго индивидуальна, как в редакции', () => {
  const state = field()
  assert.equal(state.mechanics.combat.group_initiative, false, 'умолчание — индивидуальная очередь')
  assert.throws(() => walk(state, 'bob', { x: 2, y: 3 }), (error) => error.code === 'OUT_OF_TURN')

  const after = replayEvents(state, endTurn(state, 'ann').events)
  assert.equal(after.mechanics.combat.active_index, 1, 'указатель сдвигается на одного')
})

test('в групповом режиме союзник по фазе ходит, не дожидаясь очереди', () => {
  const state = field({ group: true })
  assert.ok(walk(state, 'bob', { x: 2, y: 3 }).events.some((event) => event.event_type === 'ActorMoved'), 'второй герой ходит в ту же фазу')
  assert.throws(() => walk(state, 'orc', { x: 5, y: 3 }), (error) => error.code === 'OUT_OF_TURN', 'враг в чужую фазу не лезет')
})

test('фаза закрывается, только когда отходили все её участники', () => {
  const state = field({ group: true })
  const afterAnn = replayEvents(state, endTurn(state, 'ann').events)
  assert.equal(afterAnn.mechanics.combat.active_index, 0, 'указатель стоит: в фазе остался второй')
  assert.deepEqual(afterAnn.mechanics.combat.turn_completed, ['ann'])
  assert.equal(endTurn(state, 'ann').events.some((event) => event.event_type === 'TurnStarted'), false, 'чужого хода никто не начинал')

  // Отходивший второй раз не ходит.
  assert.throws(() => walk(afterAnn, 'ann', { x: 1, y: 3 }), (error) => error.code === 'OUT_OF_TURN')

  const afterBob = replayEvents(afterAnn, endTurn(afterAnn, 'bob').events)
  assert.equal(afterBob.mechanics.combat.active_index, 2, 'фаза закрыта — ход переходит врагам')
  assert.deepEqual(afterBob.mechanics.combat.turn_completed, [], 'счёт отходивших обнулён')
})

test('вся вражеская фаза получает свежую экономику хода', () => {
  const state = field({ group: true })
  const spent = normalizeCampaignState({
    ...state,
    mechanics: {
      ...state.mechanics,
      combat: {
        ...state.mechanics.combat,
        action_economy: { ...state.mechanics.combat.action_economy, gob: { action: false, bonus_action: false, reaction: false, movement: false, movement_spent: 30 } },
      },
    },
  })
  const afterAnn = replayEvents(spent, endTurn(spent, 'ann').events)
  const afterBob = replayEvents(afterAnn, endTurn(afterAnn, 'bob').events)
  assert.equal(afterBob.mechanics.combat.action_economy.gob.action, true, 'второму врагу фазы тоже вернули действие')
  assert.equal(afterBob.mechanics.combat.action_economy.orc.action, true)
})

test('круг замыкается и раунд растёт', () => {
  let state = field({ group: true })
  for (const actor of ['ann', 'bob', 'orc', 'gob']) state = replayEvents(state, endTurn(state, actor).events)
  assert.equal(state.mechanics.combat.active_index, 0, 'очередь вернулась к первой фазе')
  assert.equal(state.mechanics.combat.round, 2, 'начался второй раунд')
})

test('StartCombat включает режим только по явному флагу', () => {
  const base = normalizeCampaignState({
    ...field(),
    mechanics: { ...field().mechanics, combat: { active: false, round: 0, initiative: [], active_index: -1, action_economy: {} } },
  })
  const start = (extra) => resolveCommand(
    authoritative({ command_type: 'StartCombat', actor_id: 'ann', ...extra }),
    base,
    options(dice([15, 14, 10, 9])),
  )
  assert.equal(replayEvents(base, start({}).events).mechanics.combat.group_initiative, false)
  assert.equal(replayEvents(base, start({ group_initiative: true }).events).mechanics.combat.group_initiative, true)
})

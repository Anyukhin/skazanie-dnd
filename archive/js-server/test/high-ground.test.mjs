import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `height-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
const BOW = { id: 'bow', name: 'Длинный лук', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'ranged', ability: 'dex', damage: '1d8', damageType: 'piercing', normalRange: 150 } }
const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }

/**
 * Уступ по левому краю карты: клетки x ≤ 1 подняты на десять футов.
 * Высота — необязательное поле клетки, поэтому вся остальная карта на нуле.
 */
function ledgeField({ archerAt = { x: 1, y: 1 }, foeAt = { x: 6, y: 1 }, inventory = [BOW] } = {}) {
  const cells = Array.from({ length: 30 }, (_, index) => {
    const x = index % 10
    const y = Math.floor(index / 10)
    return { x, y, type: 'floor', revealed: true, ...(x <= 1 ? { elevation: 10 } : {}) }
  })
  return normalizeCampaignState({
    sessionCode: 'HEIGHT-1',
    partyMemberIds: ['archer'],
    players: [{ id: 'archer', character: 'Лучница', characterClass: 'ranger', level: 5, hp: 30, maxHp: 30, armor: 15, speed: 30, proficiency: 3, abilities: { str: 12, dex: 16, con: 12, int: 10, wis: 14, cha: 10 }, inventory, x: archerAt.x, y: archerAt.y }],
    enemies: [{ id: 'foe', name: 'Враг', creature_type: 'humanoid', hp: 40, maxHp: 40, armor: 13, speed: 30, abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, x: foeAt.x, y: foeAt.y, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'archer', total: 20 }, { actor_id: 'foe', total: 8 }],
        action_economy: {
          archer: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const shoot = (state, values, actor = 'archer', target = 'foe', item = 'bow') => resolveCommand(
  authoritative({ command_type: 'MakeAttack', actor_id: actor, target_id: target, item_id: item }),
  state,
  options(dice(values)),
)

const attackRoll = (result) => result.rolls.find((roll) => roll.purpose === 'attack')
const resolved = (result) => result.events.find((event) => event.event_type === 'AttackResolved').payload

test('выстрел с уступа идёт с преимуществом', () => {
  const result = shoot(ledgeField(), [7, 16, 4])
  assert.equal(attackRoll(result).mode, 'advantage')
  assert.equal(resolved(result).high_ground, 'higher')
})

test('выстрел снизу вверх идёт с помехой', () => {
  const state = ledgeField({ archerAt: { x: 6, y: 1 }, foeAt: { x: 1, y: 1 } })
  const result = shoot(state, [16, 7, 4])
  assert.equal(attackRoll(result).mode, 'disadvantage')
  assert.equal(resolved(result).high_ground, 'lower')
})

test('на ровном месте высота ничего не меняет', () => {
  const state = ledgeField({ archerAt: { x: 4, y: 1 }, foeAt: { x: 8, y: 1 } })
  const result = shoot(state, [12, 4])
  assert.equal(attackRoll(result).mode, 'normal')
  assert.equal(resolved(result).high_ground, undefined)
})

test('в ближнем бою высота не считается', () => {
  const state = ledgeField({ archerAt: { x: 1, y: 1 }, foeAt: { x: 2, y: 1 }, inventory: [SWORD] })
  const result = shoot(state, [12, 4], 'archer', 'foe', 'sword')
  assert.equal(attackRoll(result).mode, 'normal', 'разница в пару футов на соседней клетке ничего не решает')
  assert.equal(resolved(result).high_ground, undefined)
})

test('преимущество с высоты гасится помехой от состояния', () => {
  const state = ledgeField()
  const blinded = normalizeCampaignState({
    ...state,
    mechanics: { ...state.mechanics, conditions: { archer: [{ id: 'blinded' }] } },
  })
  const result = shoot(blinded, [16, 4])
  assert.equal(attackRoll(result).mode, 'normal', 'высота и слепота гасят друг друга, а не складываются')
})

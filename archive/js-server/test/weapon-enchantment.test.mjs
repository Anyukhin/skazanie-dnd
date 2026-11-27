import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `ench-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }

function field({ conditions = {} } = {}) {
  const cells = Array.from({ length: 60 }, (_, index) => ({ x: index % 12, y: Math.floor(index / 12), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'ENCH-1',
    partyMemberIds: ['knight'],
    players: [{ id: 'knight', character: 'Рыцарь', characterClass: 'paladin', level: 9, hp: 50, maxHp: 50, armor: 18, speed: 30, proficiency: 4, abilities: { str: 18, dex: 10, con: 16, int: 10, wis: 12, cha: 16 }, inventory: [SWORD], x: 1, y: 1 }],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 60, maxHp: 60, armor: 15, speed: 30, abilities: { str: 16, dex: 10, con: 14, int: 8, wis: 8, cha: 8 }, x: 2, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      conditions,
      resources: { knight: { spell_slots_2: { current: 3, max: 3 }, spell_slots_3: { current: 3, max: 3 } } },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'knight', total: 20 }, { actor_id: 'brute', total: 8 }],
        action_economy: {
          knight: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          brute: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const strike = (state, values) => resolveCommand(
  authoritative({ command_type: 'MakeAttack', actor_id: 'knight', target_id: 'brute', item_id: 'sword' }),
  state,
  options(dice(values)),
)
const attackOf = (result) => result.events.find((event) => event.event_type === 'AttackResolved').payload
const damageOf = (result) => result.events.find((event) => event.event_type === 'DamageApplied').payload

test('Магическое оружие даёт +1 к броску атаки и +1 к урону', () => {
  const plain = strike(field(), [10, 5])
  const magic = strike(field({ conditions: { knight: [{ id: 'magic-weapon' }] } }), [10, 5])

  assert.equal(magic.rolls.find((roll) => roll.purpose === 'attack').modifier - plain.rolls.find((roll) => roll.purpose === 'attack').modifier, 1, 'бросок атаки точнее ровно на единицу')
  assert.equal(damageOf(magic).raw_amount - damageOf(plain).raw_amount, 1, 'урон выше ровно на единицу')
})

test('надбавка решает исход на границе класса доспеха', () => {
  // Класс доспеха 15. Голый бросок даёт ровно 14, зачарованный — 15.
  const roll = 6
  assert.equal(attackOf(strike(field(), [roll, 5])).hit, false)
  assert.equal(attackOf(strike(field({ conditions: { knight: [{ id: 'magic-weapon' }] } }), [roll, 5])).hit, true)
})

test('Стихийное оружие добавляет кость урона и точность', () => {
  const result = strike(field({ conditions: { knight: [{ id: 'elemental-weapon' }] } }), [10, 5, 3])
  const bonus = result.rolls.find((roll) => roll.purpose === 'condition_damage:elemental-weapon')
  assert.ok(bonus, 'лишняя кость обязана попасть в протокол броска')
  assert.equal(bonus.expression, '1d4')
  assert.equal(damageOf(result).raw_amount, 5 + 4 + 3, 'меч, модификатор Силы и стихийная кость')
})

test('на критическом попадании лишняя кость удваивается', () => {
  const result = strike(field({ conditions: { knight: [{ id: 'elemental-weapon' }] } }), [20, 5, 5, 3, 3])
  assert.equal(attackOf(result).critical, true)
  assert.equal(result.rolls.find((roll) => roll.purpose === 'condition_damage:elemental-weapon').expression, '2d4')
})

test('Плащ крестоносца добавляет кость и складывается с зачарованием оружия', () => {
  const result = strike(field({ conditions: { knight: [{ id: 'magic-weapon' }, { id: 'crusader-s-mantle' }] } }), [10, 5, 3])
  assert.ok(result.rolls.some((roll) => roll.purpose === 'condition_damage:crusader-s-mantle'))
  assert.equal(damageOf(result).raw_amount, 5 + 4 + 1 + 3, 'меч, Сила, плоская надбавка и кость плаща')
})

test('заклинание кладёт состояние, а не считает надбавку само', () => {
  const state = field()
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'knight', spell_id: 'magic-weapon', target_id: 'knight' }),
    state,
    options(dice()),
  )
  assert.ok(replayEvents(state, cast.events).mechanics.conditions.knight.some((condition) => String(condition.id) === 'magic-weapon'))
})

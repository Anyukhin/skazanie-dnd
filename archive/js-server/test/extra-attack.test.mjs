import assert from 'node:assert/strict'
import test from 'node:test'

import { weaponAttacksPerActionFor } from '../server/combat-actions.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `extra-attack-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }

function battle({ characterClass = 'fighter', level = 5 } = {}) {
  const cells = Array.from({ length: 40 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'EXTRA-ATTACK',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Бранн', characterClass, level, hp: 40, maxHp: 40, armor: 17, speed: 30, proficiency: level >= 9 ? 4 : 3, abilities: { str: 16, dex: 12, con: 16, int: 10, wis: 10, cha: 10 }, inventory: [SWORD], x: 1, y: 1 }],
    enemies: [{ id: 'ogre', name: 'Огр', creature_type: 'giant', hp: 200, maxHp: 200, armor: 11, speed: 30, abilities: { str: 18, dex: 8, con: 16, int: 5, wis: 7, cha: 7 }, x: 2, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 18 }, { actor_id: 'ogre', total: 8 }],
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

const strike = (state, values) => resolveCommand(
  authoritative({ command_type: 'MakeAttack', actor_id: 'hero', target_id: 'ogre', item_id: 'sword' }),
  state,
  options(dice(values)),
)

test('число атак за одно действие берётся из каталога умений, а не из отдельной таблицы', () => {
  const abilities = { str: 16, dex: 12, con: 16, int: 10, wis: 10, cha: 10 }
  const actor = (characterClass, level) => ({ id: 'x', characterClass, level, proficiency: 2 + Math.floor((level - 1) / 4), abilities, inventory: [] })
  assert.equal(weaponAttacksPerActionFor(actor('fighter', 4)), 1)
  assert.equal(weaponAttacksPerActionFor(actor('fighter', 5)), 2)
  assert.equal(weaponAttacksPerActionFor(actor('fighter', 11)), 3)
  assert.equal(weaponAttacksPerActionFor(actor('paladin', 5)), 2)
  assert.equal(weaponAttacksPerActionFor(actor('ranger', 5)), 2)
  assert.equal(weaponAttacksPerActionFor(actor('barbarian', 5)), 2)
  assert.equal(weaponAttacksPerActionFor(actor('wizard', 12)), 1, 'волшебник не получает дополнительной атаки')
  assert.equal(weaponAttacksPerActionFor(null), 1)
})

test('воин пятого уровня бьёт дважды за одно действие «Атака»', () => {
  const state = battle()
  const first = strike(state, [15, 5])
  let current = replayEvents(state, first.events)
  assert.equal(current.mechanics.combat.action_economy.hero.action, false, 'действие тратится первой же атакой')
  assert.equal(current.mechanics.combat.action_economy.hero.attacks_used, 1)
  assert.equal(current.mechanics.combat.action_economy.hero.attacks_allowed, 2)

  const second = strike(current, [16, 6])
  current = replayEvents(current, second.events)
  assert.ok(second.events.some((event) => event.event_type === 'AttackResolved'))
  assert.equal(current.mechanics.combat.action_economy.hero.attacks_used, 2)

  assert.throws(
    () => strike(current, [17, 7]),
    (error) => error.code === 'ACTION_SPENT',
    'третья атака воину пятого уровня недоступна',
  )
})

test('воин одиннадцатого уровня бьёт трижды, четвёртая атака закрыта', () => {
  let current = battle({ level: 11 })
  for (const values of [[15, 5], [15, 5], [15, 5]]) current = replayEvents(current, strike(current, values).events)
  assert.equal(current.mechanics.combat.action_economy.hero.attacks_used, 3)
  assert.equal(current.mechanics.combat.action_economy.hero.attacks_allowed, 3)
  assert.throws(() => strike(current, [15, 5]), (error) => error.code === 'ACTION_SPENT')
})

test('без дополнительной атаки вторая атака по-прежнему запрещена', () => {
  const state = battle({ characterClass: 'wizard', level: 12 })
  const first = strike(state, [15, 5])
  const after = replayEvents(state, first.events)
  assert.equal(after.mechanics.combat.action_economy.hero.attacks_allowed, 1)
  assert.throws(() => strike(after, [15, 5]), (error) => error.code === 'ACTION_SPENT')
})

test('потратив действие на заклинание, воин не получает права атаковать', () => {
  const state = battle({ characterClass: 'paladin', level: 5 })
  const spent = { ...state, mechanics: { ...state.mechanics, combat: { ...state.mechanics.combat, action_economy: { hero: { action: false, bonus_action: true, reaction: true, movement: true, movement_spent: 0, attacks_used: 0, attacks_allowed: 2 } } } } }
  assert.throws(
    () => strike(spent, [15, 5]),
    (error) => error.code === 'ACTION_SPENT',
    'дополнительная атака доступна только внутри уже совершённого действия «Атака»',
  )
})

test('между двумя атаками можно переместиться, как в пошаговом бою', () => {
  const state = battle()
  let current = replayEvents(state, strike(state, [15, 5]).events)
  const moved = resolveCommand(authoritative({ command_type: 'MoveActor', actor_id: 'hero', to: { x: 1, y: 2 } }), current, options(dice()))
  current = replayEvents(current, moved.events)
  const second = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'hero', target_id: 'ogre', item_id: 'sword' }),
    current,
    options(dice([16, 6])),
  )
  assert.ok(second.events.some((event) => event.event_type === 'AttackResolved'))
})

test('новый ход возвращает обе атаки', () => {
  const state = battle()
  let current = replayEvents(state, strike(state, [15, 5]).events)
  current = replayEvents(current, strike(current, [15, 5]).events)
  // Экономика хода сбрасывается не окончанием чужого хода, а началом своего,
  // поэтому круг нужно провернуть целиком.
  current = replayEvents(current, resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'hero' }), current, options(dice([10]))).events)
  assert.equal(current.mechanics.combat.action_economy.hero.attacks_used, 2, 'пока идёт чужой ход, счётчик сохраняется')
  current = replayEvents(current, resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'ogre' }), current, options(dice([10, 10, 10]))).events)
  const economy = current.mechanics.combat.action_economy.hero
  assert.equal(economy.attacks_used, 0)
  assert.equal(economy.action, true)
  assert.ok(strike(current, [15, 5]).events.some((event) => event.event_type === 'AttackResolved'))
})

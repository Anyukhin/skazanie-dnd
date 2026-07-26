import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `condition-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }
const BOW = { id: 'bow', name: 'Длинный лук', type: 'weapon', quantity: 1, equipped: false, combat: { kind: 'ranged', ability: 'dex', damage: '1d8', damageType: 'piercing', normalRange: 150 } }

/**
 * Hero at (1,1) with a goblin adjacent at (2,1): every rule below depends on
 * reach, so the fixture keeps the two exactly five feet apart unless a test
 * moves them.
 */
function combatState({ conditions = {}, goblinAt = { x: 2, y: 1 }, inventory = [SWORD] } = {}) {
  const cells = Array.from({ length: 40 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'CONDITIONS-1',
    players: [
      { id: 'hero', character: 'Бранн', role: 'Воин · ур. 3', characterClass: 'fighter', subclass: 'Мастер боевых искусств', level: 3, hp: 30, maxHp: 30, armor: 17, speed: 30, proficiency: 2, abilities: { str: 16, dex: 14, con: 16, int: 10, wis: 10, cha: 10 }, inventory, x: 1, y: 1 },
    ],
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 40, maxHp: 40, armor: 12, speed: 30, abilities: { str: 8, dex: 14, con: 10, int: 8, wis: 8, cha: 8 }, x: goblinAt.x, y: goblinAt.y, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      conditions,
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 18 }, { actor_id: 'goblin', total: 12 }],
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

// Without an explicit weapon the engine falls back to an unarmed flat-damage
// profile, and the damage never becomes a roll — which is exactly what the
// critical-hit assertions need to see.
function attack(state, values, extra = {}) {
  return resolveCommand(authoritative({ command_type: 'MakeAttack', actor_id: 'hero', target_id: 'goblin', item_id: 'sword', ...extra }), state, options(dice(values)))
}

const attackRoll = (result) => result.rolls.find((roll) => roll.purpose === 'attack')
const attackEvent = (result) => result.events.find((event) => event.event_type === 'AttackResolved')
const damageEvent = (result) => result.events.find((event) => event.event_type === 'DamageApplied')

test('состояния недееспособности закрывают действия, но оставляют возможность окончить ход', () => {
  for (const condition of ['incapacitated', 'stunned', 'paralyzed', 'unconscious', 'petrified']) {
    const state = combatState({ conditions: { hero: [{ id: condition }] } })
    assert.throws(
      () => attack(state, [15, 15, 5]),
      (error) => error.code === 'ACTOR_INCAPACITATED' && error.message.includes(condition),
      `состояние ${condition} обязано закрывать действие`,
    )
    assert.throws(
      () => resolveCommand(authoritative({ command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'dodge' }), state, options(dice())),
      (error) => error.code === 'ACTOR_INCAPACITATED',
      `состояние ${condition} обязано закрывать и действия из каталога`,
    )
    const ended = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'hero' }), state, options(dice([10])))
    assert.ok(ended.events.some((event) => event.event_type === 'TurnEnded'), `состояние ${condition} не должно мешать закончить ход`)
  }
})

test('состояния со скоростью 0 запрещают собственное перемещение', () => {
  for (const condition of ['grappled', 'restrained', 'paralyzed', 'stunned', 'unconscious', 'petrified']) {
    const state = combatState({ conditions: { hero: [{ id: condition }] } })
    assert.throws(
      () => resolveCommand(authoritative({ command_type: 'MoveActor', actor_id: 'hero', to: { x: 1, y: 2 } }), state, options(dice())),
      (error) => error.code === 'SPEED_IS_ZERO' && error.message.includes(condition),
      `состояние ${condition} обязано обнулять скорость`,
    )
  }
  const free = resolveCommand(authoritative({ command_type: 'MoveActor', actor_id: 'hero', to: { x: 1, y: 2 } }), combatState(), options(dice()))
  assert.ok(free.events.some((event) => event.event_type === 'ActorMoved'), 'без состояний перемещение обязано проходить')
})

test('ослепление даёт преимущество по цели, помеху атакующему, а вместе — обычный бросок', () => {
  const againstBlinded = attack(combatState({ conditions: { goblin: [{ id: 'blinded' }] } }), [7, 16, 4])
  assert.equal(attackRoll(againstBlinded).mode, 'advantage')
  assert.deepEqual(attackEvent(againstBlinded).payload.condition_advantage, ['target:blinded'])

  const byBlinded = attack(combatState({ conditions: { hero: [{ id: 'blinded' }] } }), [16, 7, 4])
  assert.equal(attackRoll(byBlinded).mode, 'disadvantage')
  assert.deepEqual(attackEvent(byBlinded).payload.condition_disadvantage, ['attacker:blinded'])

  const bothBlinded = attack(combatState({ conditions: { hero: [{ id: 'blinded' }], goblin: [{ id: 'blinded' }] } }), [16, 4])
  assert.equal(attackRoll(bothBlinded).mode, 'normal', 'преимущество и помеха обязаны гасить друг друга')
})

test('невидимость атакующего даёт ему преимущество, а атакам по нему — помеху', () => {
  const invisibleAttacker = attack(combatState({ conditions: { hero: [{ id: 'invisible' }] } }), [7, 16, 4])
  assert.equal(attackRoll(invisibleAttacker).mode, 'advantage')
  const invisibleTarget = attack(combatState({ conditions: { goblin: [{ id: 'invisible' }] } }), [16, 7, 4])
  assert.equal(attackRoll(invisibleTarget).mode, 'disadvantage')
})

test('ближнее попадание по парализованной цели становится критическим без натуральной 20', () => {
  const result = attack(combatState({ conditions: { goblin: [{ id: 'paralyzed' }] } }), [9, 12, 5, 6])
  const roll = attackRoll(result)
  assert.equal(roll.mode, 'advantage', 'парализованная цель обязана давать преимущество')
  assert.equal(roll.kept, 12)
  assert.notEqual(roll.kept, 20)
  const payload = attackEvent(result).payload
  assert.equal(payload.hit, true)
  assert.equal(payload.critical, true)
  assert.equal(payload.automatic_critical, true)
  const damageRoll = result.rolls.find((entry) => entry.purpose === 'damage')
  assert.equal(damageRoll.expression, '2d8+3', 'критическое попадание обязано удвоить кости урона')
})

test('дальняя атака по парализованной цели остаётся обычной', () => {
  const state = combatState({ conditions: { goblin: [{ id: 'paralyzed' }] }, goblinAt: { x: 6, y: 1 }, inventory: [BOW] })
  const result = attack(state, [9, 12, 5], { item_id: 'bow' })
  const payload = attackEvent(result).payload
  assert.equal(payload.hit, true)
  assert.equal(payload.critical, false, 'автокритом становится только удар в упор')
  assert.equal(payload.automatic_critical, undefined)
})

test('сбитая с ног цель даёт преимущество в упор и помеху с дистанции', () => {
  const melee = attack(combatState({ conditions: { goblin: [{ id: 'prone' }] } }), [7, 16, 4])
  assert.equal(attackRoll(melee).mode, 'advantage')
  const ranged = attack(combatState({ conditions: { goblin: [{ id: 'prone' }] }, goblinAt: { x: 6, y: 1 }, inventory: [BOW] }), [16, 7, 4], { item_id: 'bow' })
  assert.equal(attackRoll(ranged).mode, 'disadvantage')
})

test('оглушённая цель автоматически проваливает спасбросок Силы, даже выбросив 20', () => {
  const state = combatState({ conditions: { goblin: [{ id: 'stunned' }] } })
  const result = resolveCommand(
    authoritative({ command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'trip-attack', target_id: 'goblin', item_id: 'sword' }),
    state,
    options(dice([9, 12, 5, 4, 20])),
  )
  const save = result.events.find((event) => event.event_type === 'SavingThrowResolved')
  assert.equal(save.payload.ability, 'str')
  assert.equal(save.payload.kept, 20, 'бросок обязан состояться и попасть в протокол')
  assert.equal(save.payload.saved, false, 'оглушение обязано отменить успех')
  assert.equal(save.payload.auto_failed, true)
  assert.equal(save.payload.auto_failed_condition, 'stunned')
  assert.ok(result.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'prone'))
})

test('окаменение делает цель устойчивой ко всему урону', () => {
  const petrified = attack(combatState({ conditions: { goblin: [{ id: 'petrified' }] } }), [9, 12, 6])
  const payload = damageEvent(petrified).payload
  assert.equal(payload.resistant, true)
  assert.equal(payload.raw_amount, 9)
  assert.equal(payload.applied_amount, 4, 'урон обязан делиться пополам с округлением вниз')
})

test('атака заклинанием подчиняется тем же состояниям, что и удар оружием', () => {
  const cells = Array.from({ length: 40 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  const state = normalizeCampaignState({
    sessionCode: 'CONDITIONS-2',
    players: [{ id: 'cleric', character: 'Мира', role: 'Жрец · ур. 5', characterClass: 'cleric', level: 5, hp: 30, maxHp: 30, armor: 16, speed: 30, proficiency: 3, abilities: { str: 10, dex: 12, con: 14, int: 10, wis: 18, cha: 10 }, inventory: [], x: 1, y: 1 }],
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 60, maxHp: 60, armor: 12, speed: 30, abilities: { str: 8, dex: 14, con: 10, int: 8, wis: 8, cha: 8 }, x: 2, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      conditions: { goblin: [{ id: 'paralyzed' }] },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'cleric', total: 18 }, { actor_id: 'goblin', total: 12 }],
        action_economy: { cleric: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
  const result = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'inflict-wounds', target_id: 'goblin' }),
    state,
    options(dice([8, 11, 7, 7, 7, 7, 7, 7])),
  )
  const resolved = result.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(resolved.payload.hit, true)
  assert.equal(resolved.payload.critical, true)
  assert.equal(resolved.payload.automatic_critical, true)
  assert.deepEqual(resolved.payload.condition_advantage, ['target:paralyzed'])
  const damageRoll = result.rolls.find((entry) => entry.purpose === 'spell_damage:inflict-wounds')
  assert.equal(damageRoll.expression, '6d10', 'автокрит обязан удвоить кости заклинания, а не только оружия')
})

test('последствия состояний воспроизводятся replay-ем без расхождений', () => {
  const state = combatState({ conditions: { goblin: [{ id: 'paralyzed' }] } })
  const result = attack(state, [9, 12, 5, 6])
  const applied = result.events.reduce(applyGameEvent, state)
  const replayed = replayEvents(state, result.events)
  assert.deepEqual(replayed, applied)
  assert.equal(applied.enemies[0].hp, 40 - damageEvent(result).payload.applied_amount)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

const cells = Array.from({ length: 24 }, (_, index) => ({
  x: index % 6,
  y: Math.floor(index / 6),
  type: 'floor',
  revealed: true,
}))

const SHORTSWORD = {
  id: 'shortsword',
  name: 'Короткий меч',
  type: 'weapon',
  equipped: true,
  quantity: 1,
  combat: { kind: 'melee', ability: 'dex', damage: '1d6', damageType: 'piercing', normalRange: 5 },
}

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `monk-flurry-roll-${++id}`,
    now: () => '2026-09-07T12:00:00.000Z',
  })
}

function battle({ level = 5, enemyHp = 100, inventory = [SHORTSWORD] } = {}) {
  return normalizeCampaignState({
    sessionCode: 'MONK-FLURRY',
    partyMemberIds: ['monk'],
    activePlayerId: 'monk',
    players: [{
      id: 'monk',
      character: 'Монах',
      characterClass: 'monk',
      role: 'Монах',
      level,
      hp: 40,
      maxHp: 40,
      armor: 16,
      speed: 30,
      proficiency: level >= 5 ? 3 : 2,
      abilities: { str: 10, dex: 16, con: 14, int: 10, wis: 14, cha: 10 },
      inventory,
      x: 1,
      y: 1,
    }],
    enemies: [{
      id: 'target',
      name: 'Цель',
      hp: enemyHp,
      maxHp: enemyHp,
      armor: 10,
      speed: 30,
      alive: true,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      x: 2,
      y: 1,
    }],
    scene: { title: 'Арена', location: 'arena', turn: 1, cells },
    mechanics: {
      resources: { monk: { ki: { current: 2, max: 2 } } },
      positions: { monk: { x: 1, y: 1 }, target: { x: 2, y: 1 } },
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'monk', total: 20 }, { actor_id: 'target', total: 10 }],
        action_economy: {
          monk: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0, attacks_used: 0, attacks_allowed: 1 },
          target: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0, attacks_used: 0, attacks_allowed: 1 },
        },
      },
    },
  })
}

function authoritative(command) {
  return { ...command, server_authoritative: true }
}

function resolve(command, state, values = []) {
  return resolveCommand(authoritative(command), state, {
    diceService: dice(values),
    context: { serverAuthoritativeCombat: true, isAdmin: true },
  })
}

function apply(state, events) {
  return events.reduce(applyGameEvent, state)
}

function ordinaryAttack(state, values = [15, 1]) {
  return resolve({ command_type: 'MakeAttack', actor_id: 'monk', target_id: 'target', item_id: 'shortsword' }, state, values)
}

function flurry(state, values = [15, 1, 15, 1]) {
  return resolve({ command_type: 'UseCombatAction', actor_id: 'monk', action_id: 'flurry-of-blows', target_id: 'target' }, state, values)
}

function martialArtsStrike(state, values = [15, 1]) {
  return resolve({ command_type: 'UseCombatAction', actor_id: 'monk', action_id: 'martial-arts-strike', target_id: 'target' }, state, values)
}

test('Шквал после обычной атаки делает два безоружных удара и платит только бонусное действие и ци', () => {
  const initial = battle()
  const first = ordinaryAttack(initial, [15, 1])
  const afterAttack = apply(initial, first.events)
  const result = flurry(afterAttack, [15, 1, 15, 1])
  const attacks = result.events.filter((event) => event.event_type === 'AttackResolved')
  assert.equal(attacks.length, 2)
  assert.ok(attacks.every((event) => event.payload.item_id === null))
  assert.ok(attacks.every((event) => event.payload.damage_expression === '1d6+3'))
  assert.ok(attacks.every((event) => event.payload.damage_type === 'bludgeoning'))
  assert.ok(attacks.every((event) => event.payload.economy?.action === false && event.payload.economy?.attack === false))
  assert.ok(result.events.some((event) => event.event_type === 'ResourceSpent' && event.payload.resource === 'ki' && event.payload.amount === 1))

  const afterFlurry = apply(afterAttack, result.events)
  const economy = afterFlurry.mechanics.combat.action_economy.monk
  assert.equal(economy.action, false)
  assert.equal(economy.bonus_action, false)
  assert.equal(economy.attacks_used, 1)
  assert.equal(afterFlurry.mechanics.resources.monk.ki.current, 1)
  assert.equal(afterFlurry.enemies[0].hp, 88)
  assert.deepEqual(afterFlurry, replayEvents(initial, [...first.events, ...result.events]))
})

test('монах пятого уровня сохраняет две атаки действия и получает ещё два удара Шквала', () => {
  const initial = battle()
  const first = apply(initial, ordinaryAttack(initial, [15, 1]).events)
  const secondResult = ordinaryAttack(first, [15, 1])
  const second = apply(first, secondResult.events)
  assert.equal(second.mechanics.combat.action_economy.monk.attacks_used, 2)

  const flurryResult = flurry(second, [15, 1, 15, 1])
  const after = apply(second, flurryResult.events)
  assert.equal(flurryResult.events.filter((event) => event.event_type === 'AttackResolved').length, 2)
  assert.equal(after.mechanics.combat.action_economy.monk.attacks_used, 2)
  assert.equal(after.mechanics.combat.action_economy.monk.bonus_action, false)
})

test('Шквал нельзя применить до действия «Атака» или повторно в тот же ход', () => {
  const initial = battle()
  assert.throws(() => flurry(initial), (error) => error.code === 'MONK_ATTACK_ACTION_REQUIRED')

  const afterAttack = apply(initial, ordinaryAttack(initial, [15, 1]).events)
  const afterSecondAttack = apply(afterAttack, ordinaryAttack(afterAttack, [15, 1]).events)
  assert.throws(
    () => resolve({ command_type: 'MakeAttack', actor_id: 'monk', target_id: 'target', monk_bonus_attack: true }, afterSecondAttack),
    (error) => error.code === 'ACTION_SPENT',
  )
  const afterFlurry = apply(afterAttack, flurry(afterAttack).events)
  assert.throws(() => flurry(afterFlurry), (error) => error.code === 'BONUS_ACTION_SPENT')
})

test('Шквал останавливается после смертельного первого удара и не бьёт мёртвую цель', () => {
  const initial = battle({ enemyHp: 3 })
  const miss = ordinaryAttack(initial, [1])
  const afterMiss = apply(initial, miss.events)
  const result = flurry(afterMiss, [15, 1])
  assert.equal(result.events.filter((event) => event.event_type === 'AttackResolved').length, 1)
  const after = apply(afterMiss, result.events)
  assert.equal(after.enemies[0].hp, 0)
})

test('Боевые искусства требуют отсутствия доспеха и щита, а Шквал в них делает базовый безоружный удар', () => {
  for (const item of [
    { id: 'armor', catalog_id: 'srd_5_2_1:leather-armor', equipped: true, quantity: 1 },
    { id: 'shield', catalog_id: 'srd_5_2_1:shield', equipped: true, quantity: 1 },
  ]) {
    const initial = battle({ inventory: [SHORTSWORD, item] })
    const afterAttack = apply(initial, ordinaryAttack(initial, [15, 1]).events)
    assert.throws(() => martialArtsStrike(afterAttack), (error) => error.code === 'MONK_MARTIAL_ARTS_REQUIRES_UNARMORED')
    const result = flurry(afterAttack, [15, 1, 15, 1])
    const attacks = result.events.filter((event) => event.event_type === 'AttackResolved')
    assert.equal(attacks[0].payload.damage_expression, null)
    assert.equal(result.events.find((event) => event.event_type === 'DamageApplied').payload.raw_amount, 1)
  }
})

test('безоружный куб монаха масштабируется на 1-м, 5-м и 11-м уровнях', () => {
  for (const [level, expected] of [[1, '1d4+3'], [5, '1d6+3'], [11, '1d8+3']]) {
    const initial = battle({ level, enemyHp: 100 })
    const afterAttack = apply(initial, ordinaryAttack(initial, [1]).events)
    const result = martialArtsStrike(afterAttack, [15, 1])
    assert.equal(result.events.find((event) => event.event_type === 'AttackResolved').payload.damage_expression, expected)
  }
})

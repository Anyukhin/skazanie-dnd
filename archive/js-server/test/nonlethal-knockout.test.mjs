import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { RulesValidationError, applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `knockout-roll-${++id}`,
    now: () => '2026-07-18T12:00:00.000Z',
  })
}

function applyAll(state, events) {
  return events.reduce((current, event) => applyGameEvent(current, event), state)
}

function fixture({ caster = false, targetHp = 5 } = {}) {
  const cells = Array.from({ length: 21 }, (_, index) => ({ x: index % 7, y: Math.floor(index / 7), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'KNOCKOUT',
    partyMemberIds: ['attacker', 'medic'],
    players: [
      caster
        ? { id: 'attacker', character: 'Ирис', characterClass: 'wizard', level: 5, hp: 24, maxHp: 24, armor: 14, speed: 30, proficiency: 3, knownSpellIds: ['shocking-grasp', 'fire-bolt'], preparedSpellIds: [], abilities: { str: 8, dex: 14, con: 14, int: 16, wis: 12, cha: 10 }, inventory: [], x: 1, y: 1 }
        : { id: 'attacker', character: 'Бранн', characterClass: 'fighter', level: 5, hp: 36, maxHp: 36, armor: 17, speed: 30, proficiency: 3, abilities: { str: 16, dex: 14, con: 16, int: 10, wis: 10, cha: 10 }, inventory: [
          { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } },
          { id: 'bow', name: 'Длинный лук', type: 'weapon', quantity: 1, combat: { kind: 'ranged', ability: 'dex', damage: '1d8', damageType: 'piercing', normalRange: 150, longRange: 600 } },
        ], x: 1, y: 1 },
      { id: 'medic', character: 'Лира', characterClass: 'cleric', level: 5, hp: 28, maxHp: 28, armor: 16, speed: 30, proficiency: 3, skills: ['medicine'], abilities: { str: 10, dex: 12, con: 14, int: 10, wis: 16, cha: 10 }, inventory: [], x: 2, y: 2 },
    ],
    enemies: [{ id: 'foe', name: 'Наёмник', hp: targetHp, maxHp: 20, armor: 12, speed: 30, proficiency: 2, abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, x: 2, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'attacker', total: 18 }, { actor_id: 'medic', total: 15 }, { actor_id: 'foe', total: 10 }],
        action_economy: {
          attacker: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          medic: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function knockOutWithSword(initial = fixture()) {
  return resolveCommand({ command_type: 'MakeAttack', actor_id: 'attacker', target_id: 'foe', item_id: 'sword', knock_out: true, server_authoritative: true }, initial, {
    diceService: dice([15, 5]), context: { serverAuthoritativeCombat: true },
  })
}

test('ближняя атака по явному выбору оставляет цель с 1 ОЗ и начинает короткий отдых', () => {
  const initial = fixture()
  const result = knockOutWithSword(initial)
  assert.ok(result.events.some((event) => event.event_type === 'CreatureKnockedOut'))
  assert.ok(!result.events.some((event) => event.event_type === 'HitPointsReducedToZero'))
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(damage.payload.hp_after, 1)
  assert.equal(damage.payload.knocked_out, true)

  const after = applyAll(initial, result.events)
  assert.equal(after.enemies[0].hp, 1)
  assert.equal(after.enemies[0].alive, true)
  assert.ok(after.mechanics.conditions.foe.some((condition) => condition.id === 'unconscious'))
  assert.deepEqual(after.mechanics.resting.foe, { kind: 'short', reason: 'knockout', recovery_minutes_remaining: 60 })
  assert.deepEqual(replayEvents(initial, result.events), after)
})

test('без выбора та же атака снижает цель до 0 ОЗ обычным способом', () => {
  const initial = fixture()
  const result = resolveCommand({ command_type: 'MakeAttack', actor_id: 'attacker', target_id: 'foe', item_id: 'sword', server_authoritative: true }, initial, {
    diceService: dice([15, 5]), context: { serverAuthoritativeCombat: true },
  })
  assert.ok(result.events.some((event) => event.event_type === 'HitPointsReducedToZero'))
  assert.ok(!result.events.some((event) => event.event_type === 'CreatureKnockedOut'))
  const after = applyAll(initial, result.events)
  assert.equal(after.enemies[0].hp, 0)
  assert.equal(after.enemies[0].alive, false)
})

test('сервер запрещает подменить нокаут дальней атакой оружием или заклинанием', () => {
  const weaponState = fixture()
  weaponState.players[0].inventory = weaponState.players[0].inventory.map((item) => ({ ...item, equipped: item.id === 'bow' }))
  assert.throws(() => resolveCommand({ command_type: 'MakeAttack', actor_id: 'attacker', target_id: 'foe', item_id: 'bow', knock_out: true, server_authoritative: true }, weaponState, {
    diceService: dice(), context: { serverAuthoritativeCombat: true },
  }), (error) => error instanceof RulesValidationError && error.code === 'KNOCKOUT_REQUIRES_MELEE_ATTACK')

  const spellState = fixture({ caster: true })
  assert.throws(() => resolveCommand({ command_type: 'CastSpell', actor_id: 'attacker', target_id: 'foe', spell_id: 'fire-bolt', knock_out: true, server_authoritative: true }, spellState, {
    diceService: dice(), context: { serverAuthoritativeCombat: true },
  }), (error) => error instanceof RulesValidationError && error.code === 'KNOCKOUT_REQUIRES_MELEE_ATTACK')
})

test('рукопашная атака заклинанием тоже может нокаутировать цель', () => {
  const initial = fixture({ caster: true, targetHp: 6 })
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'attacker', target_id: 'foe', spell_id: 'shocking-grasp', knock_out: true, server_authoritative: true }, initial, {
    diceService: dice([15, 4, 4]), context: { serverAuthoritativeCombat: true },
  })
  assert.ok(result.events.some((event) => event.event_type === 'CreatureKnockedOut' && event.payload.attack_kind === 'melee-spell'))
  const after = applyAll(initial, result.events)
  assert.equal(after.enemies[0].hp, 1)
  assert.equal(after.mechanics.resting.foe.recovery_minutes_remaining, 60)
})

test('нокаут заканчивается после полного короткого отдыха и сохраняется в replay', () => {
  const initial = fixture()
  const knocked = applyAll(initial, knockOutWithSword(initial).events)
  const firstHalf = resolveCommand({ command_type: 'AdvanceTime', amount: 30, unit: 'minute' }, knocked, { diceService: dice(), context: {} })
  const waiting = applyAll(knocked, firstHalf.events)
  assert.equal(waiting.mechanics.resting.foe.recovery_minutes_remaining, 30)
  assert.ok(waiting.mechanics.conditions.foe.some((condition) => condition.id === 'unconscious'))

  const secondHalf = resolveCommand({ command_type: 'AdvanceTime', amount: 30, unit: 'minute' }, waiting, { diceService: dice(), context: {} })
  assert.ok(secondHalf.events.some((event) => event.event_type === 'RestCompleted' && event.payload.reason === 'knockout'))
  const awake = applyAll(waiting, secondHalf.events)
  assert.equal(awake.mechanics.resting.foe, undefined)
  assert.equal(awake.mechanics.conditions.foe.some((condition) => condition.id === 'unconscious'), false)
  assert.deepEqual(replayEvents(waiting, secondHalf.events), awake)
})

test('лечение досрочно будит нокаутированное существо', () => {
  const initial = fixture()
  const knocked = applyAll(initial, knockOutWithSword(initial).events)
  const healed = resolveCommand({ command_type: 'ApplyHealing', actor_id: 'medic', target_id: 'foe', amount: 2 }, knocked, { diceService: dice(), context: {} })
  const after = applyAll(knocked, healed.events)
  assert.equal(after.enemies[0].hp, 3)
  assert.equal(after.mechanics.resting.foe, undefined)
  assert.equal(after.mechanics.conditions.foe.some((condition) => condition.id === 'unconscious'), false)
})

test('первая помощь СЛ 10 будит только при успешной проверке Медицины', () => {
  const initial = fixture()
  const knocked = applyAll(initial, knockOutWithSword(initial).events)
  knocked.mechanics.combat.active_index = 1
  knocked.mechanics.combat.action_economy.medic.action = true

  const failed = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'medic', action_id: 'first-aid', target_id: 'foe', server_authoritative: true }, knocked, {
    diceService: dice([1]), context: { serverAuthoritativeCombat: true },
  })
  assert.ok(!failed.events.some((event) => event.event_type === 'KnockoutEnded'))
  const stillOut = applyAll(knocked, failed.events)
  assert.ok(stillOut.mechanics.conditions.foe.some((condition) => condition.id === 'unconscious'))

  stillOut.mechanics.combat.action_economy.medic.action = true
  const success = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'medic', action_id: 'first-aid', target_id: 'foe', server_authoritative: true }, stillOut, {
    diceService: dice([5]), context: { serverAuthoritativeCombat: true },
  })
  assert.ok(success.events.some((event) => event.event_type === 'KnockoutEnded'))
  const awake = applyAll(stillOut, success.events)
  assert.equal(awake.mechanics.resting.foe, undefined)
  assert.equal(awake.mechanics.conditions.foe.some((condition) => condition.id === 'unconscious'), false)
})

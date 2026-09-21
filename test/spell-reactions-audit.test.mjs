import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `absorb-elements-${++id}`, now: () => '2026-09-19T12:00:00.000Z' })
}

function state({ meleeSpell = false } = {}) {
  const cells = Array.from({ length: 24 }, (_, index) => ({ x: index % 8, y: Math.floor(index / 8), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'ABSORB-ELEMENTS-AUDIT',
    players: [{
      id: 'fighter', character: 'Элементалист', characterClass: 'wizard', level: 5,
      hp: 20, maxHp: 30, armor: 14, speed: 30, proficiency: 3,
      abilities: { str: 16, dex: 14, con: 14, int: 16, wis: 10, cha: 10 },
      knownSpellIds: ['absorb-elements', ...(meleeSpell ? ['shocking-grasp'] : [])],
      preparedSpellIds: ['absorb-elements', ...(meleeSpell ? ['shocking-grasp'] : [])],
      inventory: [
        { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } },
        { id: 'bow', name: 'Лук', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'ranged', ability: 'dex', damage: '1d6', damageType: 'piercing', normalRange: 80, range: 320 } },
      ],
      x: 1, y: 1,
    }],
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 40, maxHp: 40, armor: 12, speed: 30, attackBonus: 4, damageDice: 6, damageBonus: 0, attack_profile: { name: 'Огненный коготь', attack_modifier: 4, damage_expression: '1d6', damage_type: 'fire', range_feet: 5 }, abilities: { str: 10, dex: 14, con: 10, int: 8, wis: 8, cha: 8 }, x: 2, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: { combat: { active: true, round: 1, initiative: [{ actor_id: 'fighter', total: 18 }, { actor_id: 'goblin', total: 12 }], active_index: 1, action_economy: {
      fighter: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
      goblin: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
    } } },
  })
}

function applyAll(current, events) {
  return events.reduce((stateValue, event) => applyGameEvent(stateValue, event), current)
}

function triggerAbsorbElements(initial, slotLevel = 1) {
  initial.mechanics.resources.fighter.spell_slots_1.current = slotLevel >= 3 ? 0 : 1
  initial.mechanics.resources.fighter.spell_slots_2.current = 0
  initial.mechanics.resources.fighter.spell_slots_3.current = slotLevel >= 3 ? 1 : 0
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'goblin', target_id: 'fighter', server_authoritative: true }, initial, {
    diceService: dice([18, 6]), context: { serverAuthoritativeCombat: true },
  })
  const afterAttack = applyAll(initial, attack.events)
  assert.ok(afterAttack.mechanics.combat.reaction_window?.action_ids.includes('cast:absorb-elements'))
  const reaction = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'cast:absorb-elements', server_authoritative: true }, afterAttack, {
    // Урон атаки теперь бросается после предуронового окна; d20 уже есть
    // в pending transcript, а этот d6 нужен для продолжения исходной атаки.
    diceService: dice([6]), context: { serverAuthoritativeCombat: true },
  })
  return { state: applyAll(afterAttack, reaction.events), events: reaction.events }
}

function advanceToFighter(stateValue) {
  const endGoblin = resolveCommand({ command_type: 'EndTurn', actor_id: 'goblin', server_authoritative: true }, stateValue, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  return applyAll(stateValue, endGoblin.events)
}

function endFighter(stateValue) {
  const end = resolveCommand({ command_type: 'EndTurn', actor_id: 'fighter', server_authoritative: true }, stateValue, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  return applyAll(stateValue, end.events)
}

function meleeAttack(current, rolls = [18, 6, 3]) {
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'fighter', target_id: 'goblin', item_id: 'sword', server_authoritative: true }, current, {
    diceService: dice(rolls), context: { serverAuthoritativeCombat: true },
  })
  return { state: applyAll(current, attack.events), events: attack.events }
}

test('Absorb Elements добавляет выбранный элемент к следующему попаданию и расходуется один раз', () => {
  const reaction = triggerAbsorbElements(state())
  const currentTurn = reaction.state
  assert.ok(currentTurn.mechanics.conditions.fighter.some((entry) => entry.id === 'absorbing-element:fire'))
  const riderBeforeTurn = currentTurn.mechanics.conditions.fighter.find((entry) => entry.id === 'absorbing-element-rider:fire')
  assert.equal(riderBeforeTurn?.absorb_elements_rider_armed, false)
  assert.throws(() => meleeAttack(currentTurn), (error) => error.code === 'OUT_OF_TURN')
  const armed = advanceToFighter(currentTurn)
  const condition = armed.mechanics.conditions.fighter.find((entry) => entry.id === 'absorbing-element-rider:fire')
  assert.equal(condition?.slot_level, 1)
  assert.equal(condition?.rider_damage, '1d6')
  assert.equal(condition?.absorb_elements_rider_armed, true)
  assert.equal(armed.mechanics.conditions.fighter.some((entry) => entry.id === 'absorbing-element:fire'), false)
  const hit = meleeAttack(armed)
  const rider = hit.events.find((event) => event.event_type === 'DamageApplied' && event.payload.absorb_elements === true)
  assert.equal(rider?.payload.damage_type, 'fire')
  assert.equal(rider?.payload.applied_amount, 3)
  assert.equal(hit.state.mechanics.conditions.fighter.some((entry) => entry.id === 'absorbing-element-rider:fire'), false)
  const second = meleeAttack(advanceToFighter(endFighter(hit.state)), [18, 6, 6])
  assert.equal(second.events.some((event) => event.payload?.absorb_elements === true), false)
})

test('miss и ranged attack не расходуют rider, а окончание следующего хода снимает его', () => {
  const armed = advanceToFighter(triggerAbsorbElements(state()).state)
  const miss = meleeAttack(armed, [1])
  assert.equal(miss.events.some((event) => event.payload?.absorb_elements === true), false)
  assert.ok(miss.state.mechanics.conditions.fighter.some((entry) => entry.id === 'absorbing-element-rider:fire'))
  const rangedState = advanceToFighter(triggerAbsorbElements(state()).state)
  const ranged = resolveCommand({ command_type: 'MakeAttack', actor_id: 'fighter', target_id: 'goblin', item_id: 'bow', server_authoritative: true }, rangedState, {
    diceService: dice([18, 6]), context: { serverAuthoritativeCombat: true },
  })
  const afterRanged = applyAll(rangedState, ranged.events)
  assert.equal(ranged.events.some((event) => event.payload?.absorb_elements === true), false)
  assert.ok(afterRanged.mechanics.conditions.fighter.some((entry) => entry.id === 'absorbing-element-rider:fire'))
  const expired = endFighter(afterRanged)
  assert.equal(expired.mechanics.conditions.fighter.some((entry) => entry.id === 'absorbing-element-rider:fire'), false)
})

test('upcast удваивает кости rider, крит удваивает их, а тип выбранного элемента сохраняется', () => {
  const upcast = advanceToFighter(triggerAbsorbElements(state(), 3).state)
  const hit = meleeAttack(upcast, [18, 6, 1, 1, 1])
  const roll = hit.events.find((event) => event.event_type === 'DieRolled' && event.payload.absorb_elements === true)
  const rider = hit.events.find((event) => event.event_type === 'DamageApplied' && event.payload.absorb_elements === true)
  assert.equal(roll?.payload.expression, '3d6')
  assert.equal(rider?.payload.damage_type, 'fire')

  const criticalSource = advanceToFighter(triggerAbsorbElements(state()).state)
  const critical = meleeAttack(criticalSource, [20, 6, 1, 1, 1])
  const criticalRoll = critical.events.find((event) => event.event_type === 'DieRolled' && event.payload.absorb_elements === true)
  assert.equal(criticalRoll?.payload.expression, '2d6')
})

test('rider срабатывает на melee spell attack, а не только на MakeAttack с оружием', () => {
  const armed = advanceToFighter(triggerAbsorbElements(state({ meleeSpell: true })).state)
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'fighter', spell_id: 'shocking-grasp', target_id: 'goblin', target_ids: ['goblin'], server_authoritative: true }, armed, {
    diceService: dice([18, 6, 1, 1, 1]), context: { serverAuthoritativeCombat: true },
  })
  const rider = cast.events.find((event) => event.event_type === 'DamageApplied' && event.payload.absorb_elements === true)
  assert.equal(rider?.payload.damage_type, 'fire')
  assert.equal(cast.events.some((event) => event.event_type === 'ConditionRemoved' && event.payload.condition === 'absorbing-element-rider:fire'), true)
})

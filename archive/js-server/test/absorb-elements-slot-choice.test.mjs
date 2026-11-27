import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

// «Поглощение стихий» усиливается ячейкой: окно реакции предлагает низшую
// доступную, а игрок выбирает старшую командой `slot_level`.

const applyAll = (stateValue, events) => events.reduce((current, event) => applyGameEvent(current, event), stateValue)
const context = { serverAuthoritativeCombat: true }
function dice(values = Array(100).fill(1)) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `absorb-slot-${++id}`, now: () => '2026-10-02T12:00:00.000Z' })
}

function areaState() {
  const cells = Array.from({ length: 64 }, (_, index) => ({ x: index % 8, y: Math.floor(index / 8), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'ABSORB-SLOT',
    partyMemberIds: ['caster', 'target'],
    players: [
      { id: 'caster', character: 'Маг', characterClass: 'wizard', level: 5, hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3,
        abilities: { int: 18, dex: 14, con: 14 }, inventory: [], knownSpellIds: ['fireball'], preparedSpellIds: ['fireball'], x: 1, y: 1 },
      { id: 'target', character: 'Цель', characterClass: 'wizard', level: 5, hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3,
        abilities: { int: 18, dex: 14, con: 14 }, inventory: [], knownSpellIds: ['absorb-elements'], preparedSpellIds: ['absorb-elements'], x: 3, y: 1 },
    ],
    enemies: [],
    scene: { turn: 1, cells },
    mechanics: {
      resources: {
        caster: { spell_slots_3: { current: 1, max: 1 } },
        target: { spell_slots_1: { current: 2, max: 4 }, spell_slots_2: { current: 0, max: 3 }, spell_slots_3: { current: 1, max: 2 } },
      },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'target', total: 10 }],
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          target: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}
const fireball = { command_type: 'CastSpell', command_id: 'slot-fireball', actor_id: 'caster', spell_id: 'fireball', to: { x: 3, y: 1 }, slot_level: 3, server_authoritative: true }

function waitingWindow() {
  const initial = areaState()
  const first = resolveCommand(fireball, initial, { diceService: dice(), context })
  const waiting = applyAll(initial, first.events)
  const option = waiting.mechanics.combat.reaction_window.action_options.find((entry) => entry.id === 'cast:absorb-elements')
  return { waiting, option }
}
const absorb = (extra = {}) => ({ command_type: 'UseCombatAction', command_id: 'absorb-slot', actor_id: 'target', action_id: 'cast:absorb-elements', server_authoritative: true, ...extra })

test('окно предлагает низшую ячейку, игрок выбирает ячейку 3-го круга', () => {
  const { waiting, option } = waitingWindow()
  assert.equal(option.slot_level, 1)
  const accepted = resolveCommand(absorb({ slot_level: 3 }), waiting, { diceService: dice(), context })
  const final = applyAll(waiting, accepted.events)
  assert.equal(final.mechanics.resources.target.spell_slots_3.current, 0, 'потрачена выбранная ячейка')
  assert.equal(final.mechanics.resources.target.spell_slots_1.current, 2, 'низшая цела')
  const rider = final.mechanics.conditions.target.find((condition) => condition.id === 'absorbing-element-rider:fire')
  assert.equal(rider?.slot_level, 3, 'кость следующего удара — 3к6')
  assert.deepEqual(replayEvents(waiting, accepted.events), final)
})

test('без выбора тратится предложенная ячейка, как раньше', () => {
  const { waiting } = waitingWindow()
  const final = applyAll(waiting, resolveCommand(absorb(), waiting, { diceService: dice(), context }).events)
  assert.equal(final.mechanics.resources.target.spell_slots_1.current, 1)
  assert.equal(final.mechanics.conditions.target.find((condition) => condition.id === 'absorbing-element-rider:fire')?.slot_level, 1)
})

test('нельзя выбрать ячейку ниже предложенной или пустой круг', () => {
  const { waiting } = waitingWindow()
  assert.throws(() => resolveCommand(absorb({ slot_level: 2 }), waiting, { diceService: dice(), context }), (error) => error?.code === 'INSUFFICIENT_RESOURCE')
  assert.throws(() => resolveCommand(absorb({ slot_level: 4 }), waiting, { diceService: dice(), context }), (error) => error?.code === 'INSUFFICIENT_RESOURCE')
  assert.throws(() => resolveCommand(absorb({ slot_level: 0 }), waiting, { diceService: dice(), context }), (error) => error?.code === 'INVALID_SPELL_SLOT_LEVEL')
})

function meleeState() {
  const cells = Array.from({ length: 24 }, (_, index) => ({ x: index % 8, y: Math.floor(index / 8), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'ABSORB-SLOT-MELEE',
    players: [{
      id: 'fighter', character: 'Элементалист', characterClass: 'wizard', level: 5, hp: 20, maxHp: 30, armor: 14, speed: 30, proficiency: 3,
      abilities: { str: 16, dex: 14, con: 14, int: 16, wis: 10, cha: 10 },
      knownSpellIds: ['absorb-elements'], preparedSpellIds: ['absorb-elements'],
      inventory: [{ id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }],
      x: 1, y: 1,
    }],
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 40, maxHp: 40, armor: 12, speed: 30, attack_profile: { name: 'Огненный коготь', attack_modifier: 4, damage_expression: '1d6', damage_type: 'fire', range_feet: 5 }, abilities: { str: 10, dex: 14, con: 10, int: 8, wis: 8, cha: 8 }, x: 2, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: { combat: { active: true, round: 1, initiative: [{ actor_id: 'fighter', total: 18 }, { actor_id: 'goblin', total: 12 }], active_index: 1, action_economy: {
      fighter: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
      goblin: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
    } } },
  })
}

test('защита от попадания тоже берёт выбранную ячейку', () => {
  const initial = meleeState()
  const attack = resolveCommand({ command_type: 'MakeAttack', actor_id: 'goblin', target_id: 'fighter', server_authoritative: true }, initial, { diceService: dice([18, 6]), context })
  const waiting = applyAll(initial, attack.events)
  const before = waiting.mechanics.resources.fighter
  assert.ok(before.spell_slots_1.current > 0 && before.spell_slots_2.current > 0)
  const reaction = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'cast:absorb-elements', slot_level: 2, server_authoritative: true }, waiting, { diceService: dice([6]), context })
  const final = applyAll(waiting, reaction.events)
  assert.equal(final.mechanics.resources.fighter.spell_slots_2.current, before.spell_slots_2.current - 1)
  assert.equal(final.mechanics.resources.fighter.spell_slots_1.current, before.spell_slots_1.current)
  assert.equal(final.mechanics.conditions.fighter.find((condition) => condition.id === 'absorbing-element-rider:fire')?.slot_level, 2)
})

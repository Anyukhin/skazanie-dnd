import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
let commandNumber = 0

function dice(values = []) {
  let rollNumber = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `source-candidate-${++rollNumber}`,
    now: () => '2026-09-26T12:00:00.000Z',
  })
}

function field({ foeAt = { x: 8, y: 1 }, conditions = {} } = {}) {
  const cells = Array.from({ length: 240 }, (_, index) => ({
    x: index % 24,
    y: Math.floor(index / 24),
    type: 'floor',
    revealed: true,
  }))
  return normalizeCampaignState({
    sessionCode: 'SOURCE-RUNTIME-REGRESSION',
    partyMemberIds: ['mage'],
    players: [{
      id: 'mage', character: 'Аль', characterClass: 'wizard', level: 12,
      hp: 80, maxHp: 80, armor: 13, speed: 30, proficiency: 4,
      abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 12, cha: 10 },
      inventory: [], x: 1, y: 1,
    }],
    enemies: [{
      id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 120, maxHp: 120,
      armor: 10, speed: 30, abilities: { str: 12, dex: 8, con: 10, int: 8, wis: 8, cha: 8 },
      x: foeAt.x, y: foeAt.y, alive: true,
    }],
    scene: { turn: 1, cells },
    mechanics: {
      conditions,
      resources: { mage: Object.fromEntries([1, 2, 3, 4, 5, 6].map((slot) => [`spell_slots_${slot}`, { current: 3, max: 3 }])) },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'mage', total: 20 }, { actor_id: 'brute', total: 8 }],
        action_economy: {
          mage: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          brute: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function healField() {
  const state = field({ foeAt: { x: 8, y: 1 } })
  state.players[0].characterClass = 'cleric'
  state.partyMemberIds = ['mage', 'undead-ally', 'construct-ally']
  state.players.push(
    { id: 'undead-ally', character: 'Нежить', creature_type: 'undead', characterClass: 'fighter', level: 12, hp: 1, maxHp: 40, armor: 12, speed: 30, proficiency: 4, abilities: { str: 12, dex: 12, con: 12, int: 8, wis: 8, cha: 8 }, inventory: [], x: 2, y: 1 },
    { id: 'construct-ally', character: 'Конструкт', creature_type: 'construct', characterClass: 'fighter', level: 12, hp: 1, maxHp: 40, armor: 12, speed: 30, proficiency: 4, abilities: { str: 12, dex: 12, con: 12, int: 8, wis: 8, cha: 8 }, inventory: [], x: 3, y: 1 },
  )
  state.mechanics.combat.initiative.push({ actor_id: 'undead-ally', total: 7 }, { actor_id: 'construct-ally', total: 6 })
  for (const id of ['undead-ally', 'construct-ally']) state.mechanics.combat.action_economy[id] = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  return normalizeCampaignState(state)
}

function command(command, state, diceService) {
  return resolveCommand(authoritative({ command_id: `source-candidate-${++commandNumber}`, ...command }), state, options(diceService))
}

function event(result, type, predicate = () => true) {
  return result.events.find((candidate) => candidate.event_type === type && predicate(candidate))
}

test('Heal не лечит нежить и конструкта через общий immuneCreatureTypes handler', () => {
  const state = healField()
  const service = dice([])
  for (const targetId of ['undead-ally', 'construct-ally']) {
    const result = command({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'heal', target_id: targetId, slot_level: 6 }, state, service)
    assert.equal(result.events.some((candidate) => candidate.event_type === 'HealingApplied'), false, targetId)
    assert.equal(replayEvents(state, result.events).players.find((player) => player.id === targetId).hp, 1, targetId)
  }
})

test('Immolation повторяет save и 4d6 в конце хода, а не в начале', () => {
  const service = dice([1, ...Array.from({ length: 8 }, () => 4), 1, ...Array.from({ length: 4 }, () => 4)])
  const state = field({ foeAt: { x: 4, y: 1 } })
  const cast = command({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'immolation', target_id: 'brute', slot_level: 5 }, state, service)
  const burning = event(cast, 'ConditionAdded', (candidate) => candidate.payload.condition === 'burning')
  assert.equal(burning.payload.repeat_save_timing, 'turn-end')
  assert.equal(burning.payload.repeat_save_ends_concentration, false)
  assert.equal(burning.payload.recurring_damage, '4d6')
  assert.equal(burning.payload.recurring_damage_timing, 'turn-end')
  assert.equal(burning.payload.start_turn_save, undefined)

  const lit = replayEvents(state, cast.events)
  const afterMage = command({ command_type: 'EndTurn', actor_id: 'mage' }, lit, service)
  assert.equal(afterMage.events.some((candidate) => candidate.event_type === 'DamageApplied' && candidate.payload.spell_id === 'immolation'), false)
  const afterBrute = command({ command_type: 'EndTurn', actor_id: 'brute' }, replayEvents(lit, afterMage.events), service)
  const save = event(afterBrute, 'SpellSavingThrowResolved', (candidate) => candidate.payload.spell_id === 'immolation')
  const damage = event(afterBrute, 'DamageApplied', (candidate) => candidate.payload.spell_id === 'immolation')
  assert.equal(save.payload.trigger, 'turn-end-repeat')
  assert.equal(save.payload.saved, false)
  assert.equal(damage.payload.trigger, 'turn-end')
  assert.equal(damage.payload.raw_amount, 16)
})

test('успешный повторный save Immolation снимает эффект до recurring damage', () => {
  const service = dice([1, ...Array.from({ length: 8 }, () => 4), 20])
  const state = field({ foeAt: { x: 4, y: 1 } })
  const cast = command({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'immolation', target_id: 'brute' }, state, service)
  const lit = replayEvents(state, cast.events)
  const afterMage = command({ command_type: 'EndTurn', actor_id: 'mage' }, lit, service)
  const afterBrute = command({ command_type: 'EndTurn', actor_id: 'brute' }, replayEvents(lit, afterMage.events), service)
  assert.equal(afterBrute.events.some((candidate) => candidate.event_type === 'DamageApplied' && candidate.payload.spell_id === 'immolation'), false)
  assert.ok(afterBrute.events.some((candidate) => candidate.event_type === 'ConcentrationEnded' && candidate.payload.reason === 'repeat-save'))
})

test('Phantasmal Killer использует конец хода и +1d10 при повышении', () => {
  const service = dice([1, 1, ...Array.from({ length: 5 }, () => 4)])
  const state = field({ foeAt: { x: 4, y: 1 } })
  const cast = command({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'phantasmal-killer', target_id: 'brute', slot_level: 5 }, state, service)
  const frightened = event(cast, 'ConditionAdded', (candidate) => candidate.payload.condition === 'frightened')
  assert.equal(frightened.payload.repeat_save_timing, 'turn-end')
  assert.equal(frightened.payload.repeat_save_ends_concentration, false)
  assert.equal(frightened.payload.recurring_damage, '5d10')
  assert.equal(frightened.payload.recurring_damage_timing, 'turn-end')
  assert.equal(frightened.payload.start_turn_save, undefined)

  const haunted = replayEvents(state, cast.events)
  const afterMage = command({ command_type: 'EndTurn', actor_id: 'mage' }, haunted, service)
  assert.equal(afterMage.events.some((candidate) => candidate.event_type === 'DamageApplied' && candidate.payload.spell_id === 'phantasmal-killer'), false)
  const afterBrute = command({ command_type: 'EndTurn', actor_id: 'brute' }, replayEvents(haunted, afterMage.events), service)
  const damage = event(afterBrute, 'DamageApplied', (candidate) => candidate.payload.spell_id === 'phantasmal-killer')
  assert.equal(damage.payload.trigger, 'turn-end')
  assert.equal(damage.payload.raw_amount, 20)
})

test('Wall of Light бьёт при появлении и в конце хода без entry-save, с +1d8', () => {
  const initialService = dice([...Array.from({ length: 5 }, () => 4), 1])
  const initial = command({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'wall-of-light', to: { x: 5, y: 1 }, slot_level: 6 }, field({ foeAt: { x: 5, y: 1 } }), initialService)
  const area = event(initial, 'SpellAreaCreated').payload.effect
  assert.equal(area.damage, '5d8')
  assert.equal(area.trigger_on_enter, false)
  assert.equal(area.save_ability, null)
  assert.equal(area.half_on_save, false)
  assert.equal(event(initial, 'DamageApplied', (candidate) => candidate.payload.spell_id === 'wall-of-light').payload.raw_amount, 20)

  const service = dice(Array.from({ length: 5 }, () => 4))
  const castState = replayEvents(field({ foeAt: { x: 9, y: 1 } }), command({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'wall-of-light', to: { x: 5, y: 1 }, slot_level: 6 }, field({ foeAt: { x: 9, y: 1 } }), service).events)
  const afterMage = command({ command_type: 'EndTurn', actor_id: 'mage' }, castState, service)
  const walked = command({ command_type: 'MoveActor', actor_id: 'brute', to: { x: 5, y: 1 } }, replayEvents(castState, afterMage.events), service)
  assert.equal(walked.events.some((candidate) => candidate.event_type === 'DamageApplied' && candidate.payload.spell_id === 'wall-of-light'), false)
  assert.equal(walked.events.some((candidate) => candidate.event_type === 'SpellSavingThrowResolved' && candidate.payload.spell_id === 'wall-of-light'), false)
  const ended = command({ command_type: 'EndTurn', actor_id: 'brute' }, replayEvents(castState, [...afterMage.events, ...walked.events]), service)
  assert.equal(ended.events.some((candidate) => candidate.event_type === 'SpellSavingThrowResolved' && candidate.payload.spell_id === 'wall-of-light'), false)
  assert.equal(event(ended, 'DamageApplied', (candidate) => candidate.payload.spell_id === 'wall-of-light').payload.raw_amount, 20)
})

test('Wall of Light снимает ослепление повторным save, сохраняя концентрацию стены', () => {
  const service = dice([4, 4, 4, 4, 1, 20])
  const state = field({ foeAt: { x: 5, y: 1 } })
  const cast = command({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'wall-of-light', to: { x: 5, y: 1 } }, state, service)
  const blinded = event(cast, 'ConditionAdded', (candidate) => candidate.payload.condition === 'blinded')
  assert.equal(blinded.payload.repeat_save_timing, 'turn-end')
  assert.equal(blinded.payload.repeat_save_ends_concentration, false)
  const lit = replayEvents(state, cast.events)
  const afterMage = command({ command_type: 'EndTurn', actor_id: 'mage' }, lit, service)
  const walked = command({ command_type: 'MoveActor', actor_id: 'brute', to: { x: 8, y: 1 } }, replayEvents(lit, afterMage.events), service)
  assert.equal(walked.events.some((candidate) => candidate.event_type === 'DamageApplied' && candidate.payload.spell_id === 'wall-of-light'), false)
  const ended = command({ command_type: 'EndTurn', actor_id: 'brute' }, replayEvents(lit, [...afterMage.events, ...walked.events]), service)
  assert.equal(ended.events.some((candidate) => candidate.event_type === 'DamageApplied' && candidate.payload.spell_id === 'wall-of-light'), false)
  assert.ok(ended.events.some((candidate) => candidate.event_type === 'SpellSavingThrowResolved' && candidate.payload.spell_id === 'wall-of-light' && candidate.payload.saved === true))
  assert.ok(ended.events.some((candidate) => candidate.event_type === 'ConditionRemoved' && candidate.payload.condition === 'blinded'))
  assert.equal(ended.events.some((candidate) => candidate.event_type === 'ConcentrationEnded' && candidate.payload.effect_id?.startsWith('wall-of-light:')), false)
  const after = replayEvents(lit, [...afterMage.events, ...walked.events, ...ended.events])
  assert.ok(after.mechanics.concentration?.mage, 'сама стена продолжает концентрацию')
})

test('Dawn не наносит entry-урон, но наносит урон в конце хода', () => {
  const service = dice([1, 4, 4, 4, 4, 1, 4, 4, 4, 4, 1, 4, 4, 4, 4])
  const state = field({ foeAt: { x: 4, y: 1 } })
  state.enemies[0].speed = 60
  const cast = command({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'dawn', to: { x: 12, y: 1 } }, state, service)
  const area = event(cast, 'SpellAreaCreated').payload.effect
  assert.equal(area.trigger_on_enter, false)
  const lit = replayEvents(state, cast.events)
  const afterMage = command({ command_type: 'EndTurn', actor_id: 'mage' }, lit, service)
  const walked = command({ command_type: 'MoveActor', actor_id: 'brute', to: { x: 12, y: 1 } }, replayEvents(lit, afterMage.events), service)
  assert.equal(walked.events.some((candidate) => candidate.event_type === 'DamageApplied' && candidate.payload.spell_id === 'dawn'), false)
  assert.equal(walked.events.some((candidate) => candidate.event_type === 'SpellSavingThrowResolved' && candidate.payload.spell_id === 'dawn'), false)
  const ended = command({ command_type: 'EndTurn', actor_id: 'brute' }, replayEvents(lit, [...afterMage.events, ...walked.events]), service)
  assert.ok(ended.events.some((candidate) => candidate.event_type === 'SpellSavingThrowResolved' && candidate.payload.spell_id === 'dawn' && candidate.payload.trigger === 'turn-end'))
  assert.equal(event(ended, 'DamageApplied', (candidate) => candidate.payload.spell_id === 'dawn').payload.raw_amount, 16)
})

test('Mental Prison наносит урон и корректно завершает концентрацию при save success', () => {
  const state = field({ foeAt: { x: 4, y: 1 } })
  const result = command({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'mental-prison', target_id: 'brute' }, state, dice([20, 4, 4, 4, 4, 4]))
  const save = event(result, 'SpellSavingThrowResolved', (candidate) => candidate.payload.spell_id === 'mental-prison')
  const damage = event(result, 'DamageApplied', (candidate) => candidate.payload.spell_id === 'mental-prison')
  assert.equal(save.payload.saved, true)
  assert.equal(damage.payload.saved, true)
  assert.equal(damage.payload.raw_amount, 20)
  assert.ok(result.events.some((candidate) => candidate.event_type === 'ConcentrationEnded' && candidate.payload.reason === 'save-success'))
  assert.equal(result.events.some((candidate) => candidate.event_type === 'ConditionAdded' && candidate.payload.condition === 'incapacitated'), false)
  const after = replayEvents(state, result.events)
  assert.equal(after.mechanics.resources.mage.spell_slots_6.current, 2)
  assert.equal(after.mechanics.concentration?.mage, undefined)
  assert.deepEqual(after, replayEvents(state, result.events), 'replay сохраняет урон, расход ячейки и конец концентрации')
})

test('Mental Prison при failed save оставляет урон и restrained, расходуя ячейку', () => {
  const state = field({ foeAt: { x: 4, y: 1 } })
  const result = command({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'mental-prison', target_id: 'brute' }, state, dice([1, 4, 4, 4, 4, 4]))
  const save = event(result, 'SpellSavingThrowResolved', (candidate) => candidate.payload.spell_id === 'mental-prison')
  const damage = event(result, 'DamageApplied', (candidate) => candidate.payload.spell_id === 'mental-prison')
  assert.equal(save.payload.saved, false)
  assert.equal(damage.payload.saved, false)
  assert.equal(damage.payload.raw_amount, 20)
  assert.ok(result.events.some((candidate) => candidate.event_type === 'ConditionAdded' && candidate.payload.condition === 'restrained'))
  assert.equal(result.events.some((candidate) => candidate.event_type === 'ConcentrationEnded'), false)
  const after = replayEvents(state, result.events)
  assert.equal(after.mechanics.resources.mage.spell_slots_6.current, 2)
  assert.ok(after.mechanics.concentration?.mage)
  assert.deepEqual(after, replayEvents(state, result.events), 'failed save тоже детерминирован после replay')
})

test('старое recurring condition без маркера остаётся start-turn для replay', () => {
  const state = field({
    foeAt: { x: 4, y: 1 },
    conditions: {
      brute: [{ id: 'legacy-burning', duration: 'rounds:2', source_actor: 'mage', spell_id: 'legacy', recurring_damage: '1d6', recurring_damage_type: 'fire' }],
    },
  })
  const result = command({ command_type: 'EndTurn', actor_id: 'mage' }, state, dice([4]))
  const damage = event(result, 'DamageApplied', (candidate) => candidate.payload.spell_id === 'legacy')
  assert.equal(damage.payload.trigger, 'turn-start')
  assert.equal(damage.payload.raw_amount, 4)
})

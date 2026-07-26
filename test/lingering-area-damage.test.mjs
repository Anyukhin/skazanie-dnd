import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `area-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

/**
 * Druid at (1,1), a lone brute at (8,1) far outside any area the druid drops in
 * the middle of the room.  The brute then has to walk through it, which is the
 * whole point of a lingering area.
 */
function fieldState({ casterClass = 'druid', level = 9 } = {}) {
  const cells = Array.from({ length: 30 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'AREA-1',
    partyMemberIds: ['druid'],
    players: [{ id: 'druid', character: 'Вейл', characterClass: casterClass, level, hp: 40, maxHp: 40, armor: 14, speed: 30, proficiency: 4, abilities: { str: 10, dex: 14, con: 14, int: 12, wis: 18, cha: 12 }, inventory: [], x: 1, y: 1 }],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 60, maxHp: 60, armor: 13, speed: 30, abilities: { str: 16, dex: 10, con: 14, int: 8, wis: 8, cha: 8 }, x: 8, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'druid', total: 20 }, { actor_id: 'brute', total: 8 }],
        action_economy: {
          druid: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          brute: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function cast(state, spellId, values, to) {
  return resolveCommand(authoritative({ command_type: 'CastSpell', actor_id: 'druid', spell_id: spellId, to }), state, options(dice(values)))
}

const brutesTurn = (state) => ({ ...state, mechanics: { ...state.mechanics, combat: { ...state.mechanics.combat, active_index: 1 } } })

test('Лунный луч оставляет область, которая жжёт вошедшего', () => {
  const state = fieldState()
  // Область у (5,1): громила в (8,1) вне её, поэтому при накладывании урона нет.
  const placed = cast(state, 'moonbeam', [], { x: 5, y: 1 })
  const area = placed.events.find((event) => event.event_type === 'SpellAreaCreated')
  assert.ok(area, 'заклинание обязано создать длящуюся область')
  assert.equal(area.payload.effect.damage, '2d10')
  assert.equal(area.payload.effect.damage_type, 'radiant')
  assert.equal(area.payload.effect.half_on_save, true)
  assert.equal(area.payload.effect.trigger_on_enter, true)
  assert.equal(placed.events.some((event) => event.event_type === 'DamageApplied'), false, 'цель вне области урона не получает')

  const lit = replayEvents(state, placed.events)
  const walked = resolveCommand(
    authoritative({ command_type: 'MoveActor', actor_id: 'brute', to: { x: 5, y: 1 } }),
    brutesTurn(lit),
    options(dice([3, 6, 6])),
  )
  const save = walked.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(save.payload.ability, 'con')
  assert.equal(save.payload.trigger, 'area-enter')
  assert.equal(save.payload.saved, false)
  const damage = walked.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(damage.payload.spell_id, 'moonbeam')
  assert.equal(damage.payload.area_effect, true)
  assert.equal(damage.payload.damage_type, 'radiant')
  assert.equal(damage.payload.raw_amount, 12)
})

test('успешный спасбросок в области делит урон пополам', () => {
  const state = fieldState()
  const lit = replayEvents(state, cast(state, 'moonbeam', [], { x: 5, y: 1 }).events)
  const walked = resolveCommand(
    authoritative({ command_type: 'MoveActor', actor_id: 'brute', to: { x: 5, y: 1 } }),
    brutesTurn(lit),
    options(dice([20, 7, 7])),
  )
  assert.equal(walked.events.find((event) => event.event_type === 'SpellSavingThrowResolved').payload.saved, true)
  assert.equal(walked.events.find((event) => event.event_type === 'DamageApplied').payload.raw_amount, 7)
})

test('Облако кинжалов режет без всякого спасброска', () => {
  const state = fieldState({ casterClass: 'wizard' })
  const placed = cast(state, 'cloud-of-daggers', [], { x: 5, y: 1 })
  const area = placed.events.find((event) => event.event_type === 'SpellAreaCreated')
  assert.equal(area.payload.effect.save_ability, null)
  assert.equal(area.payload.effect.damage, '4d4')

  const filled = replayEvents(state, placed.events)
  const walked = resolveCommand(
    authoritative({ command_type: 'MoveActor', actor_id: 'brute', to: { x: 5, y: 1 } }),
    brutesTurn(filled),
    options(dice([2, 2, 2, 2])),
  )
  assert.equal(walked.events.some((event) => event.event_type === 'SpellSavingThrowResolved'), false, 'спасброска у облака нет')
  const damage = walked.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(damage.payload.raw_amount, 8)
  assert.equal(damage.payload.damage_type, 'slashing')
})

test('окончание хода внутри области снова наносит урон', () => {
  const state = fieldState({ casterClass: 'wizard' })
  const filled = replayEvents(state, cast(state, 'cloud-of-daggers', [], { x: 5, y: 1 }).events)
  const walked = resolveCommand(
    authoritative({ command_type: 'MoveActor', actor_id: 'brute', to: { x: 5, y: 1 } }),
    brutesTurn(filled),
    options(dice([1, 1, 1, 1])),
  )
  const inside = replayEvents(brutesTurn(filled), walked.events)
  const ended = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'brute' }), inside, options(dice([3, 3, 3, 3, 10])))
  const damage = ended.events.find((event) => event.event_type === 'DamageApplied' && event.payload.trigger === 'turn-end')
  assert.ok(damage, 'в конце хода внутри области урон обязан повториться')
  assert.equal(damage.payload.raw_amount, 12)
})

test('Стражи веры держатся вокруг заклинателя и уходят вместе с ним', () => {
  const state = fieldState({ casterClass: 'cleric' })
  const placed = cast(state, 'spirit-guardians', [], { x: 1, y: 1 })
  const area = placed.events.find((event) => event.event_type === 'SpellAreaCreated')
  assert.equal(area.payload.effect.follows_source, true)
  assert.equal(area.payload.effect.source_actor, 'druid')
  assert.equal(area.payload.effect.radius_feet, 15)

  // Громила в (8,1) вне ауры: вход в (5,1) её не задевает.
  const guarded = replayEvents(state, placed.events)
  const farStep = resolveCommand(
    authoritative({ command_type: 'MoveActor', actor_id: 'brute', to: { x: 5, y: 1 } }),
    brutesTurn(guarded),
    options(dice()),
  )
  assert.equal(farStep.events.some((event) => event.event_type === 'DamageApplied'), false, 'до ауры ещё далеко')

  // Заклинатель делает шаг навстречу — аура едет с ним и накрывает громилу.
  const moved = replayEvents(brutesTurn(guarded), farStep.events)
  const casterStep = resolveCommand(
    authoritative({ command_type: 'MoveActor', actor_id: 'druid', to: { x: 3, y: 1 } }),
    { ...moved, mechanics: { ...moved.mechanics, combat: { ...moved.mechanics.combat, active_index: 0 } } },
    options(dice()),
  )
  const advanced = replayEvents(moved, casterStep.events)
  const ended = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'brute' }), { ...advanced, mechanics: { ...advanced.mechanics, combat: { ...advanced.mechanics.combat, active_index: 1 } } }, options(dice([4, 5, 5, 5])))
  const damage = ended.events.find((event) => event.event_type === 'DamageApplied')
  assert.ok(damage, 'после переезда ауры конец хода внутри неё обязан ранить')
  assert.equal(damage.payload.spell_id, 'spirit-guardians')
  assert.equal(damage.payload.damage_type, 'radiant')
})

test('Испепеление поджигает цель, и пламя жжёт в начале её хода', () => {
  const state = fieldState({ casterClass: 'sorcerer', level: 9 })
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'druid', spell_id: 'immolation', target_id: 'brute', target_ids: ['brute'] }),
    state,
    options(dice([...Array.from({ length: 8 }, () => 4), 3])),
  )
  const burning = cast.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'burning')
  assert.equal(burning.payload.recurring_damage, '3d6')
  assert.equal(burning.payload.recurring_damage_type, 'fire')
  assert.equal(burning.payload.repeat_save_timing, 'turn-end')

  // Начало хода горящего: сначала ход заклинателя завершается, очередь доходит
  // до цели, и пламя срабатывает событием TurnStarted.
  const burnt = replayEvents(state, cast.events)
  const passed = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'druid' }), burnt, options(dice([2, 2, 2, 10])))
  const recurring = passed.events.find((event) => event.event_type === 'DamageApplied' && event.payload.recurring === true)
  assert.ok(recurring, 'в начале своего хода горящая цель обязана получить урон')
  assert.equal(recurring.payload.spell_id, 'immolation')
  assert.equal(recurring.payload.damage_type, 'fire')
  assert.equal(recurring.payload.raw_amount, 6)
})

test('Фантомный убийца повторяет спасбросок в начале хода цели', () => {
  const state = fieldState({ casterClass: 'wizard', level: 9 })
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'druid', spell_id: 'phantasmal-killer', target_id: 'brute', target_ids: ['brute'] }),
    state,
    options(dice([3])),
  )
  const fear = cast.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'frightened')
  assert.equal(fear.payload.start_turn_save, 'wis')
  assert.equal(fear.payload.recurring_damage, '4d10')

  // Провал спасброска в начале хода — видение держится и ранит.
  const haunted = replayEvents(state, cast.events)
  const failed = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'druid' }), haunted, options(dice([2, 5, 5, 5, 5, 10])))
  assert.equal(failed.events.find((event) => event.event_type === 'SpellSavingThrowResolved' && event.payload.trigger === 'turn-start').payload.saved, false)
  assert.equal(failed.events.find((event) => event.event_type === 'DamageApplied' && event.payload.recurring === true).payload.raw_amount, 20)

  // Успех развеивает видение и урона не приносит.
  const saved = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'druid' }), haunted, options(dice([20, 10])))
  assert.equal(saved.events.find((event) => event.event_type === 'SpellSavingThrowResolved' && event.payload.trigger === 'turn-start').payload.saved, true)
  assert.equal(saved.events.some((event) => event.event_type === 'DamageApplied' && event.payload.recurring === true), false)
})

test('исход длящейся области воспроизводится replay-ем', () => {
  const state = fieldState()
  const placed = cast(state, 'moonbeam', [], { x: 5, y: 1 })
  const lit = replayEvents(state, placed.events)
  const walked = resolveCommand(
    authoritative({ command_type: 'MoveActor', actor_id: 'brute', to: { x: 5, y: 1 } }),
    brutesTurn(lit),
    options(dice([3, 6, 6])),
  )
  const after = replayEvents(brutesTurn(lit), walked.events)
  assert.equal(after.enemies[0].hp, 60 - walked.events.find((event) => event.event_type === 'DamageApplied').payload.applied_amount)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `wall-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

/** Заклинатель в (1,1), враг далеко справа: стену ставим поперёк его пути. */
function wallField(casterClass = 'wizard', level = 9) {
  const cells = Array.from({ length: 60 }, (_, index) => ({ x: index % 12, y: Math.floor(index / 12), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'WALL-1',
    partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Аль', characterClass: casterClass, level, hp: 40, maxHp: 40, armor: 13, speed: 30, proficiency: 4, abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 18, cha: 12 }, inventory: [], x: 1, y: 1 }],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 80, maxHp: 80, armor: 13, speed: 30, abilities: { str: 16, dex: 10, con: 14, int: 8, wis: 8, cha: 8 }, x: 9, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
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

const brutesTurn = (state) => ({ ...state, mechanics: { ...state.mechanics, combat: { ...state.mechanics.combat, active_index: 1 } } })

test('Стена огня встаёт поперёк подхода и центрируется на выбранной клетке', () => {
  const state = wallField()
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'wall-of-fire', to: { x: 5, y: 1 } }),
    state,
    options(dice(Array.from({ length: 12 }, () => 4))),
  )
  const area = cast.events.find((event) => event.event_type === 'SpellAreaCreated')
  assert.ok(area, 'стена обязана оставить длящуюся область')
  const wall = area.payload.effect.cells
  assert.ok(Array.isArray(wall) && wall.length > 1, 'стена задаётся списком клеток')
  assert.equal(wall.every((cell) => cell.x === 5), true, 'стена идёт поперёк направления заклинателя')
  assert.ok(wall.some((cell) => cell.y === 1), 'выбранная клетка внутри стены')
  assert.equal(wall.some((cell) => cell.x === 1 && cell.y === 1), false, 'заклинатель в собственном огне не оказывается')
  assert.equal(area.payload.effect.damage, '5d8')
})

test('вошедший в стену получает урон, спасбросок делит его пополам', () => {
  const state = wallField()
  const lit = replayEvents(state, resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'wall-of-fire', to: { x: 5, y: 1 } }),
    state,
    options(dice(Array.from({ length: 12 }, () => 4))),
  ).events)

  // Триггер срабатывает по клетке назначения: громила заканчивает шаг в стене.
  const walked = resolveCommand(
    authoritative({ command_type: 'MoveActor', actor_id: 'brute', to: { x: 5, y: 1 } }),
    brutesTurn(lit),
    options(dice([3, ...Array.from({ length: 5 }, () => 4)])),
  )
  const save = walked.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(save.payload.trigger, 'area-enter')
  assert.equal(save.payload.saved, false)
  const damage = walked.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(damage.payload.spell_id, 'wall-of-fire')
  assert.equal(damage.payload.damage_type, 'fire')
  assert.equal(damage.payload.raw_amount, 20)
})

test('обойти стену стороной можно без всякого урона', () => {
  const state = wallField()
  const lit = replayEvents(state, resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'wall-of-fire', to: { x: 5, y: 1 } }),
    state,
    options(dice(Array.from({ length: 12 }, () => 4))),
  ).events)
  const around = resolveCommand(
    authoritative({ command_type: 'MoveActor', actor_id: 'brute', to: { x: 7, y: 3 } }),
    brutesTurn(lit),
    options(dice()),
  )
  assert.equal(around.events.some((event) => event.event_type === 'DamageApplied'), false, 'клетки в стороне от стены не жгут')
  assert.ok(around.events.some((event) => event.event_type === 'ActorMoved'))
})

test('Молния бьёт лучом из заклинателя, а не поперёк направления', () => {
  const state = wallField()
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'lightning-bolt', to: { x: 9, y: 1 } }),
    state,
    options(dice([...Array.from({ length: 8 }, () => 4), 3])),
  )
  const damage = cast.events.find((event) => event.event_type === 'DamageApplied')
  assert.ok(damage, 'громила на линии луча обязан попасть под удар')
  assert.equal(damage.payload.damage_type, 'lightning')
  assert.equal(cast.rolls.find((roll) => roll.purpose.startsWith('spell_damage')).expression, '8d6')

  // Цель в стороне от луча не задета.
  const aside = normalizeCampaignState({
    ...state,
    enemies: [{ ...state.enemies[0], y: 2 }],
    mechanics: { ...state.mechanics, positions: { ...state.mechanics.positions, brute: { x: 9, y: 2 } } },
  })
  const missed = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'lightning-bolt', to: { x: 9, y: 1 } }),
    aside,
    options(dice(Array.from({ length: 10 }, () => 4))),
  )
  assert.equal(missed.events.some((event) => event.event_type === 'DamageApplied'), false, 'соседний ряд лучом не задет')
})

test('Стена клинков делает свои клетки труднопроходимыми', () => {
  const state = wallField('cleric', 11)
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'blade-barrier', to: { x: 5, y: 1 } }),
    state,
    options(dice(Array.from({ length: 14 }, () => 5))),
  )
  const effect = cast.events.find((event) => event.event_type === 'SpellAreaCreated').payload.effect
  assert.equal(effect.difficult_terrain, true)
  assert.equal(effect.damage, '6d10')
  assert.ok(effect.cells.length > 1)
  assert.equal(cast.events.find((event) => event.event_type === 'ResourceSpent').payload.resource, 'spell_slots_6')
})

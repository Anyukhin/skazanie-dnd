import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `acid-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

/** Волшебник и цель с КД 15: при +7 к атаке бросок 3 промахивается, 12 попадает. */
function acidField() {
  const cells = Array.from({ length: 30 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'ACID-1',
    partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Аль', characterClass: 'wizard', level: 5, hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3, abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 12, cha: 10 }, inventory: [], x: 1, y: 1 }],
    enemies: [{ id: 'foe', name: 'Враг', hp: 60, maxHp: 60, armor: 15, speed: 30, abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, x: 5, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'mage', total: 20 }, { actor_id: 'foe', total: 8 }],
        action_economy: { mage: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

const acidArrow = (state, values) => resolveCommand(
  authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'melf-s-acid-arrow', target_id: 'foe', target_ids: ['foe'] }),
  state,
  options(dice(values)),
)

test('попадание наносит урон сразу и оставляет кислоту на цели', () => {
  const state = acidField()
  const result = acidArrow(state, [12, 3, 3, 3, 3])
  const resolved = result.events.find((event) => event.event_type === 'AttackResolved').payload
  assert.equal(resolved.hit, true)
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(damage.payload.raw_amount, 12)
  assert.equal(damage.payload.damage_type, 'acid')

  const covered = result.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'acid-covered')
  assert.equal(covered.payload.recurring_damage, '2d4')
  assert.equal(covered.payload.recurring_damage_type, 'acid')
})

test('промах всё равно обжигает вполовину, но продолжения не оставляет', () => {
  const state = acidField()
  const result = acidArrow(state, [3, 4, 4, 4, 4])
  const resolved = result.events.find((event) => event.event_type === 'AttackResolved').payload
  assert.equal(resolved.hit, false)
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')
  assert.ok(damage, 'при промахе половина урона всё равно доходит')
  assert.equal(damage.payload.on_miss, true)
  assert.equal(damage.payload.raw_amount, 8, 'половина от 16')
  assert.equal(result.events.some((event) => event.event_type === 'ConditionAdded'), false, 'кислота на цели не остаётся')
})

test('отложенный урон приходит на следующем ходу цели и срабатывает один раз', () => {
  const state = acidField()
  const hit = acidArrow(state, [12, 3, 3, 3, 3])
  let current = replayEvents(state, hit.events)

  const passed = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'mage' }), current, options(dice([2, 2, 10])))
  const delayed = passed.events.find((event) => event.event_type === 'DamageApplied' && event.payload.recurring === true)
  assert.ok(delayed, 'в начале хода цели кислота обязана сработать')
  assert.equal(delayed.payload.spell_id, 'melf-s-acid-arrow')
  assert.equal(delayed.payload.raw_amount, 4)

  // Состояние живёт один раунд: на следующем ходу цели кислоты уже нет.
  current = replayEvents(current, passed.events)
  assert.equal(
    (current.mechanics.conditions.foe ?? []).some((condition) => condition.id === 'acid-covered'),
    false,
    'кислота сходит после единственного срабатывания',
  )
})

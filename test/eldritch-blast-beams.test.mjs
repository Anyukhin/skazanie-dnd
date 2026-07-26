import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `beam-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

/** Колдун и два противника: лучи можно и сложить в одного, и развести. */
function warlockField(level) {
  const cells = Array.from({ length: 30 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'BEAMS-1',
    partyMemberIds: ['warlock'],
    players: [{ id: 'warlock', character: 'Кель', characterClass: 'warlock', level, hp: 30, maxHp: 30, armor: 13, speed: 30, proficiency: level >= 9 ? 4 : 3, abilities: { str: 8, dex: 14, con: 14, int: 12, wis: 10, cha: 18 }, inventory: [], x: 1, y: 1 }],
    enemies: [
      { id: 'foe', name: 'Первый', hp: 60, maxHp: 60, armor: 18, speed: 30, abilities: {}, x: 5, y: 1, alive: true },
      { id: 'foe-two', name: 'Второй', hp: 60, maxHp: 60, armor: 18, speed: 30, abilities: {}, x: 5, y: 2, alive: true },
    ],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'warlock', total: 20 }, { actor_id: 'foe', total: 8 }],
        action_economy: { warlock: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

const blast = (state, values, extra = {}) => resolveCommand(
  authoritative({ command_type: 'CastSpell', actor_id: 'warlock', spell_id: 'eldritch-blast', target_id: 'foe', target_ids: ['foe'], ...extra }),
  state,
  options(dice(values)),
)

const attacksIn = (result) => result.events.filter((event) => event.event_type === 'AttackResolved')

test('число лучей Мистического заряда растёт с уровнем колдуна', () => {
  // Каждый луч: бросок атаки и, при попадании, кость урона.
  assert.equal(attacksIn(blast(warlockField(4), [15, 5])).length, 1, 'до пятого уровня луч один')
  assert.equal(attacksIn(blast(warlockField(5), [15, 5, 15, 5])).length, 2, 'с пятого уровня лучей два')
  assert.equal(attacksIn(blast(warlockField(11), [15, 5, 15, 5, 15, 5])).length, 3, 'с одиннадцатого — три')
  assert.equal(attacksIn(blast(warlockField(12), [15, 5, 15, 5, 15, 5])).length, 3, 'до семнадцатого больше трёх не бывает')
})

test('каждый луч бросает атаку отдельно и наносит урон отдельно', () => {
  const result = blast(warlockField(11), [18, 6, 3, 19, 7])
  const attacks = attacksIn(result)
  assert.equal(attacks.length, 3)
  assert.deepEqual(attacks.map((event) => event.payload.hit), [true, false, true], 'промах одного луча не отменяет остальные')
  const damages = result.events.filter((event) => event.event_type === 'DamageApplied')
  assert.equal(damages.length, 2, 'урон наносят только попавшие лучи')
  assert.ok(damages.every((event) => event.payload.damage_type === 'force'))
})

test('лучи можно развести по разным целям', () => {
  const state = warlockField(5)
  const result = blast(state, [15, 5, 15, 5], { target_ids: ['foe', 'foe-two'] })
  const attacks = attacksIn(result)
  assert.equal(attacks.length, 2)
  assert.deepEqual(attacks.map((event) => event.payload.target_id), ['foe', 'foe-two'])
  const after = replayEvents(state, result.events)
  assert.ok(after.enemies.every((enemy) => enemy.hp < 60), 'досталось обоим')
})

test('лучи стоят одного действия, а не трёх', () => {
  const state = warlockField(11)
  const result = blast(state, [15, 5, 15, 5, 15, 5])
  const after = replayEvents(state, result.events)
  assert.equal(after.mechanics.combat.action_economy.warlock.action, false)
  assert.equal(result.events.filter((event) => event.event_type === 'SpellCast').length, 3, 'каждый луч остаётся отдельным броском в протоколе')
})

test('лучи не бьют по уже павшей цели', () => {
  const state = warlockField(11)
  const weakened = normalizeCampaignState({
    ...state,
    enemies: [{ ...state.enemies[0], hp: 3 }, state.enemies[1]],
  })
  const result = blast(weakened, [20, 6, 6])
  const attacks = attacksIn(result)
  assert.equal(attacks.length, 1, 'после падения цели оставшиеся лучи не тратятся впустую')
})

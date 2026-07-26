import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `image-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

/** Волшебник с Ловкостью 14 (КД двойника 12) и враг с +5 к атаке в упор. */
function duelField(conditions = {}) {
  const cells = Array.from({ length: 20 }, (_, index) => ({ x: index % 5, y: Math.floor(index / 5), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'IMAGE-1',
    partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Аль', characterClass: 'wizard', level: 5, hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3, abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 12, cha: 10 }, inventory: [], x: 1, y: 1 }],
    enemies: [{ id: 'thug', name: 'Головорез', hp: 40, maxHp: 40, armor: 13, speed: 30, attackBonus: 5, damageDice: 8, damageBonus: 3, abilities: { str: 16, dex: 12, con: 14, int: 8, wis: 10, cha: 8 }, x: 2, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      conditions,
      combat: {
        active: true, round: 1, active_index: 1,
        initiative: [{ actor_id: 'mage', total: 20 }, { actor_id: 'thug', total: 10 }],
        action_economy: { thug: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

const swing = (state, values) => resolveCommand(
  authoritative({ command_type: 'MakeAttack', actor_id: 'thug', target_id: 'mage' }),
  state,
  options(dice(values)),
)

const resolved = (result) => result.events.find((event) => event.event_type === 'AttackResolved').payload

test('удар уходит в двойника: цель не получает урона, двойник развеивается', () => {
  const state = duelField({ mage: [{ id: 'mirror-image:3' }] })
  // Бросок атаки 15, затем проверка перехвата 12 — при трёх двойниках хватает 6.
  const result = swing(state, [15, 12])
  const payload = resolved(result)
  assert.equal(payload.mirror_image_intercepted, true)
  assert.equal(payload.mirror_images_before, 3)
  assert.equal(payload.hit, false, 'перехваченный удар не считается попаданием по цели')
  assert.equal(result.events.some((event) => event.event_type === 'DamageApplied'), false)

  const after = replayEvents(state, result.events)
  const left = (after.mechanics.conditions.mage ?? []).map((condition) => condition.id)
  assert.deepEqual(left, ['mirror-image:2'], 'двойников стало на одного меньше')
})

test('низкий бросок перехвата оставляет удар настоящей цели', () => {
  const state = duelField({ mage: [{ id: 'mirror-image:3' }] })
  const result = swing(state, [15, 3, 5])
  const payload = resolved(result)
  assert.equal(payload.mirror_image_intercepted, undefined)
  assert.equal(payload.hit, true)
  assert.ok(result.events.some((event) => event.event_type === 'DamageApplied'))
  const after = replayEvents(state, result.events)
  assert.deepEqual((after.mechanics.conditions.mage ?? []).map((condition) => condition.id), ['mirror-image:3'], 'двойник цел')
})

test('слабый удар в двойника не развеивает его', () => {
  // Атака 5 + 5 = 10 против КД двойника 12: двойник не задет и остаётся.
  const state = duelField({ mage: [{ id: 'mirror-image:3' }] })
  const result = swing(state, [5, 12])
  assert.equal(resolved(result).mirror_image_intercepted, true)
  const after = replayEvents(state, result.events)
  assert.deepEqual((after.mechanics.conditions.mage ?? []).map((condition) => condition.id), ['mirror-image:3'])
})

test('порог перехвата растёт по мере того, как двойников становится меньше', () => {
  // С одним двойником нужно 11 и выше: бросок 9 его не задевает.
  const single = duelField({ mage: [{ id: 'mirror-image:1' }] })
  assert.equal(resolved(swing(single, [15, 9, 5])).mirror_image_intercepted, undefined)
  assert.equal(resolved(swing(single, [15, 11])).mirror_image_intercepted, true)
})

test('слепой нападающий двойников не видит', () => {
  const state = duelField({ mage: [{ id: 'mirror-image:3' }], thug: [{ id: 'blinded' }] })
  const result = swing(state, [15, 15, 5])
  assert.equal(resolved(result).mirror_image_intercepted, undefined, 'двойники обманывают только зрячего')
})

test('Размытие даёт помеху атакам по цели', () => {
  const state = duelField({ mage: [{ id: 'blurred' }] })
  const result = swing(state, [18, 4, 5])
  assert.equal(result.rolls.find((roll) => roll.purpose === 'attack').mode, 'disadvantage')
  assert.equal(resolved(result).kept, 4)
})

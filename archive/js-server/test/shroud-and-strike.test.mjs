import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `sh-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }
const BOW = { id: 'bow', name: 'Длинный лук', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'ranged', ability: 'dex', damage: '1d8', damageType: 'piercing', normalRange: 150 } }

function field({ casterClass = 'wizard', level = 12, inventory = [SWORD], conditions = {}, foes = [{ id: 'brute', x: 2, y: 2 }] } = {}) {
  const cells = Array.from({ length: 96 }, (_, index) => ({ x: index % 16, y: Math.floor(index / 16), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'SH-1',
    partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Аль', characterClass: casterClass, level, hp: 60, maxHp: 60, armor: 13, speed: 30, proficiency: 4, abilities: { str: 18, dex: 18, con: 14, int: 18, wis: 16, cha: 16 }, inventory, x: 1, y: 2 }],
    enemies: foes.map((foe) => ({ id: foe.id, name: foe.id, creature_type: 'humanoid', hp: 120, maxHp: 120, armor: 10, speed: 30, abilities: { str: 14, dex: 10, con: 12, int: 8, wis: 8, cha: 8 }, x: foe.x, y: foe.y, alive: true, inventory: [SWORD] })),
    scene: { turn: 1, cells },
    mechanics: {
      conditions,
      resources: { mage: Object.fromEntries([1, 2, 3, 4, 5, 6].map((slot) => [`spell_slots_${slot}`, { current: 3, max: 3 }])) },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'mage', total: 20 }, ...foes.map((foe, index) => ({ actor_id: foe.id, total: 10 - index }))],
        action_economy: Object.fromEntries([['mage', { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }],
          ...foes.map((foe) => [foe.id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])]),
      },
    },
  })
}

const strike = (state, values, item = 'sword', target = 'brute') => resolveCommand(
  authoritative({ command_type: 'MakeAttack', actor_id: 'mage', target_id: target, item_id: item }),
  state,
  options(dice(values)),
)
const damages = (result) => result.events.filter((event) => event.event_type === 'DamageApplied').map((event) => event.payload)

test('Саван духов добавляет кость только вблизи', () => {
  const near = strike(field({ conditions: { mage: [{ id: 'spirit-shroud' }] } }), [15, 5, 6])
  assert.ok(near.rolls.some((roll) => roll.purpose === 'condition_damage:spirit-shroud'), 'в упор кость выдаётся')
  assert.equal(damages(near)[0].raw_amount, 5 + 4 + 6)

  const far = strike(
    field({ inventory: [BOW], conditions: { mage: [{ id: 'spirit-shroud' }] }, foes: [{ id: 'brute', x: 9, y: 2 }] }),
    [15, 5],
    'bow',
  )
  assert.equal(far.rolls.some((roll) => roll.purpose === 'condition_damage:spirit-shroud'), false, 'за десять футов духи не достают')
  assert.equal(damages(far)[0].raw_amount, 5 + 4)
})

test('Тень Мойла даёт помеху атакующим и жжёт ударившего', () => {
  const state = field({ casterClass: 'warlock', conditions: { mage: [{ id: 'shadow-of-moil' }] } })
  const hit = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'brute', target_id: 'mage', item_id: 'sword' }),
    { ...state, mechanics: { ...state.mechanics, combat: { ...state.mechanics.combat, active_index: 1 } } },
    options(dice([18, 17, 5, 4, 4])),
  )
  assert.equal(hit.rolls.find((roll) => roll.purpose === 'attack').mode, 'disadvantage')
  const back = hit.events.find((event) => event.event_type === 'DamageApplied' && event.payload.retaliation)
  assert.ok(back, 'тени обязаны ответить')
  assert.equal(back.payload.damage_type, 'necrotic')
  assert.equal(back.payload.raw_amount, 8)
})

test('Стальной ветер бьёт всех выбранных без броска', () => {
  const state = field({ foes: [{ id: 'brute', x: 2, y: 2 }, { id: 'brute-two', x: 3, y: 3 }] })
  const result = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'steel-wind-strike', target_ids: ['brute', 'brute-two'] }),
    state,
    options(dice(Array.from({ length: 6 }, () => 5))),
  )
  assert.equal(result.events.some((event) => event.event_type === 'AttackResolved'), false, 'броска атаки нет')
  assert.equal(result.events.some((event) => event.event_type === 'SpellSavingThrowResolved'), false, 'спасброска нет')
  const hits = damages(result)
  assert.equal(hits.length, 2, 'обе цели задеты')
  assert.equal(hits.every((entry) => entry.raw_amount === 30 && entry.damage_type === 'force'), true)
})

test('Едкая струя Таши облепляет кислотой и капает каждый ход', () => {
  const state = field({ foes: [{ id: 'brute', x: 5, y: 2 }] })
  const result = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'tasha-s-caustic-brew', to: { x: 6, y: 2 } }),
    state,
    options(dice([2])),
  )
  const covered = result.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'acid-covered')
  assert.ok(covered, 'провалившего спасбросок обливает')
  assert.equal(covered.payload.recurring_damage, '2d4')
  assert.equal(covered.payload.recurring_damage_type, 'acid')
  assert.equal(result.events.some((event) => event.event_type === 'DamageApplied'), false, 'сразу струя урона не наносит')
})

test('Тошнотворное сияние оставляет светящуюся область', () => {
  const result = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'sickening-radiance', to: { x: 12, y: 2 } }),
    field({ foes: [{ id: 'brute', x: 12, y: 2 }] }),
    options(dice([4, 4, 4, 4, 2])),
  )
  assert.equal(damages(result)[0].damage_type, 'radiant')
  const effect = result.events.find((event) => event.event_type === 'SpellAreaCreated').payload.effect
  assert.equal(effect.damage, '4d10')
  assert.equal(effect.trigger_on_turn_end, true)
})

test('Кинетический прыжок ускоряет и снимает атаки по возможности', () => {
  const state = field({ casterClass: 'bard' })
  const after = replayEvents(state, resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'kinetic-jaunt', target_id: 'mage' }),
    state,
    options(dice()),
  ).events)
  const ids = after.mechanics.conditions.mage.map((condition) => String(condition.id))
  assert.ok(ids.includes('kinetic-jaunt'))
  assert.ok(ids.includes('disengaged'), 'отход входит в тот же эффект')
})

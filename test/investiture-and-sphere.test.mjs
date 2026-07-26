import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `inv-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }

function field({ casterClass = 'wizard', level = 12, foeAt = { x: 2, y: 2 }, conditions = {} } = {}) {
  const cells = Array.from({ length: 96 }, (_, index) => ({ x: index % 16, y: Math.floor(index / 16), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'INV-1',
    partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Аль', characterClass: casterClass, level, hp: 60, maxHp: 60, armor: 13, speed: 30, proficiency: 4, abilities: { str: 14, dex: 14, con: 14, int: 18, wis: 18, cha: 16 }, inventory: [SWORD], x: 1, y: 2 }],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 120, maxHp: 120, armor: 10, speed: 30, abilities: { str: 8, dex: 8, con: 10, int: 8, wis: 8, cha: 8 }, x: foeAt.x, y: foeAt.y, alive: true, inventory: [SWORD] }],
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

const cast = (state, spellId, values, extra = {}) => resolveCommand(
  authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: spellId, ...extra }),
  state,
  options(dice(values)),
)
const brutesTurn = (state) => ({ ...state, mechanics: { ...state.mechanics, combat: { ...state.mechanics.combat, active_index: 1 } } })
const damages = (result) => result.events.filter((event) => event.event_type === 'DamageApplied').map((event) => event.payload)

test('Сфера Отилюка обездвиживает и отсекает урон целиком', () => {
  const state = field()
  const caged = replayEvents(state, cast(state, 'otiluke-s-resilient-sphere', [2], { target_id: 'brute' }).events)
  assert.ok(caged.mechanics.conditions.brute.some((condition) => String(condition.id) === 'resilient-sphere'))

  const swing = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'mage', target_id: 'brute', item_id: 'sword' }),
    { ...caged, mechanics: { ...caged.mechanics, combat: { ...caged.mechanics.combat, action_economy: { ...caged.mechanics.combat.action_economy, mage: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } } } },
    options(dice([18, 5])),
  )
  const damage = damages(swing)[0]
  assert.equal(damage.immune, true, 'неуязвимость, а не половина урона')
  assert.equal(damage.applied_amount, 0)
})

test('Облачение пламенем даёт сопротивление и жжёт стоящих рядом', () => {
  const state = field({ casterClass: 'druid' })
  const burning = replayEvents(state, cast(state, 'investiture-of-flame', [], { target_id: 'mage' }).events)
  const effect = burning.mechanics.active_effects.find((candidate) => candidate.spell_id === 'investiture-of-flame')
  assert.ok(effect, 'вокруг заклинателя остаётся область')
  assert.equal(effect.follows_source, true, 'область едет вместе с ним')
  assert.equal(effect.damage, '1d10')

  // Сопротивление огню: та же кость урона режется вдвое.
  const scorch = resolveCommand(
    authoritative({ command_type: 'ApplyDamage', actor_id: 'mage', target_id: 'mage', amount: 20, damage_type: 'fire' }),
    burning,
    // Урон по концентрирующемуся тянет за собой проверку концентрации.
    options(dice([18])),
  )
  assert.equal(damages(scorch)[0].resistant, true)
  assert.equal(damages(scorch)[0].applied_amount, 10)
})

test('Облачение льдом покрывает землю наледью', () => {
  const state = field({ casterClass: 'druid' })
  const iced = replayEvents(state, cast(state, 'investiture-of-ice', [], { target_id: 'mage' }).events)
  const effect = iced.mechanics.active_effects.find((candidate) => candidate.spell_id === 'investiture-of-ice')
  assert.equal(effect.difficult_terrain, true)
  assert.equal(effect.follows_source, true)
  assert.equal(effect.damage, null, 'сама наледь урона не наносит')
})

test('Облачение ветром даёт помеху атакующим', () => {
  const state = field({ casterClass: 'druid' })
  const windy = replayEvents(state, cast(state, 'investiture-of-wind', [], { target_id: 'mage' }).events)
  const swing = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'brute', target_id: 'mage', item_id: 'sword' }),
    brutesTurn(windy),
    options(dice([18, 3, 5])),
  )
  assert.equal(swing.rolls.find((roll) => roll.purpose === 'attack').mode, 'disadvantage')
})

test('Рука Бигби бьёт атакой заклинания', () => {
  const result = cast(field(), 'bigby-s-hand', [15, 5, 5, 5, 5], { target_id: 'brute' })
  assert.ok(result.events.some((event) => event.event_type === 'AttackResolved'))
  assert.equal(damages(result)[0].raw_amount, 20)
  assert.equal(damages(result)[0].damage_type, 'force')
})

test('Водоворот и Водяная сфера: урон и захват', () => {
  const storm = cast(field({ casterClass: 'druid', foeAt: { x: 10, y: 2 } }), 'maelstrom', [4, 4, 4, 4, 4, 4, 2], { to: { x: 10, y: 2 }, target_id: undefined })
  assert.equal(damages(storm)[0].raw_amount, 24)

  const sphere = cast(field({ casterClass: 'druid' }), 'watery-sphere', [2], { target_id: 'brute' })
  assert.ok(sphere.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'restrained'))
})

test('Дверь измерений переносит без урона', () => {
  const result = cast(field(), 'dimension-door', [], { to: { x: 14, y: 5 } })
  const moved = result.events.find((event) => event.event_type === 'ActorMoved')
  assert.equal(moved.payload.teleport, true)
  assert.deepEqual(moved.payload.to, { x: 14, y: 5 })
  assert.equal(damages(result).length, 0)
})

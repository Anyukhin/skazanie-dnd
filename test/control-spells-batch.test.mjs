import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `ctrl-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

function field({ casterClass = 'wizard', level = 12, foeType = 'humanoid', foeAt = { x: 4, y: 2 } } = {}) {
  const cells = Array.from({ length: 96 }, (_, index) => ({ x: index % 16, y: Math.floor(index / 16), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'CTRL-1',
    partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Аль', characterClass: casterClass, level, hp: 50, maxHp: 50, armor: 13, speed: 30, proficiency: 4, abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 18, cha: 16 }, inventory: [], x: 1, y: 2 }],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: foeType, hp: 90, maxHp: 90, armor: 13, speed: 30, abilities: { str: 8, dex: 8, con: 10, int: 8, wis: 8, cha: 8 }, x: foeAt.x, y: foeAt.y, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
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
  authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: spellId, target_id: 'brute', ...extra }),
  state,
  options(dice(values)),
)
const conditionsAdded = (result) => result.events.filter((event) => event.event_type === 'ConditionAdded').map((event) => event.payload.condition)

test('Раскаление металла жжёт без броска атаки и без спасброска', () => {
  const result = cast(field({ casterClass: 'druid' }), 'heat-metal', [4, 4])
  assert.equal(result.events.some((event) => event.event_type === 'AttackResolved'), false, 'броска атаки нет')
  assert.equal(result.events.some((event) => event.event_type === 'SpellSavingThrowResolved'), false, 'спасброска нет')
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(damage.payload.raw_amount, 8)
  assert.equal(damage.payload.damage_type, 'fire')
})

test('Порыв ветра бьёт полосой из заклинателя и отбрасывает', () => {
  const result = cast(field({ casterClass: 'druid' }), 'gust-of-wind', [2], { to: { x: 8, y: 2 }, target_id: undefined })
  const save = result.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(save.payload.ability, 'str')
  assert.equal(save.payload.saved, false)
  const moved = result.events.find((event) => event.event_type === 'ActorMoved' && event.payload.forced_movement)
  assert.ok(moved, 'провалившего спасбросок сдувает')
  assert.equal(moved.payload.to.x > 4, true, 'отброшен прочь от заклинателя')
  assert.equal(result.events.some((event) => event.event_type === 'DamageApplied'), false, 'урона у порыва нет')
})

test('стоящий в стороне от полосы под порыв не попадает', () => {
  const result = cast(field({ casterClass: 'druid', foeAt: { x: 4, y: 4 } }), 'gust-of-wind', [2], { to: { x: 8, y: 2 }, target_id: undefined })
  assert.equal(result.events.some((event) => event.event_type === 'ActorMoved'), false)
})

test('Превращение плоти в камень опутывает и даёт повторный спасбросок', () => {
  const result = cast(field({ casterClass: 'warlock' }), 'flesh-to-stone', [2])
  const restrained = result.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'restrained')
  assert.ok(restrained, 'провал спасброска Телосложения опутывает')
  assert.equal(restrained.payload.repeat_save_timing, 'turn-end')
  assert.equal(restrained.payload.save_ability, 'con')
  assert.equal(conditionsAdded(result).includes('petrified'), false, 'окончательного окаменения сервер не выдаёт')
})

test('Дурной глаз выдаёт выбранный исход, а не все сразу', () => {
  const asleep = cast(field({ casterClass: 'warlock' }), 'eyebite', [2], { spell_option: 'asleep' })
  assert.deepEqual(conditionsAdded(asleep), ['unconscious'])

  const sickened = cast(field({ casterClass: 'warlock' }), 'eyebite', [2], { spell_option: 'sickened' })
  assert.deepEqual(conditionsAdded(sickened), ['poisoned'])

  const panicked = cast(field({ casterClass: 'warlock' }), 'eyebite', [2], { spell_option: 'panicked' })
  assert.deepEqual(conditionsAdded(panicked), ['frightened'])
})

test('успешный спасбросок от Дурного глаза не оставляет ничего', () => {
  const result = cast(field({ casterClass: 'warlock' }), 'eyebite', [20], { spell_option: 'asleep' })
  assert.equal(result.events.find((event) => event.event_type === 'SpellSavingThrowResolved').payload.saved, true)
  assert.deepEqual(conditionsAdded(result), [])
})

test('Корона безумия действует только на гуманоида', () => {
  const human = cast(field({ casterClass: 'bard' }), 'crown-of-madness', [2])
  assert.deepEqual(conditionsAdded(human), ['charmed'])

  const undead = cast(field({ casterClass: 'bard', foeType: 'undead' }), 'crown-of-madness', [2])
  assert.equal(undead.events.find((event) => event.event_type === 'SpellSavingThrowResolved').payload.automatic_success, true)
  assert.deepEqual(conditionsAdded(undead), [])
})

test('Внушение очаровывает провалившего спасбросок Мудрости', () => {
  const result = cast(field({ casterClass: 'bard' }), 'suggestion', [2])
  assert.equal(result.events.find((event) => event.event_type === 'SpellSavingThrowResolved').payload.ability, 'wis')
  assert.deepEqual(conditionsAdded(result), ['charmed'])
  assert.ok(replayEvents(field({ casterClass: 'bard' }), result.events).mechanics.conditions.brute.some((condition) => String(condition.id) === 'charmed'))
})

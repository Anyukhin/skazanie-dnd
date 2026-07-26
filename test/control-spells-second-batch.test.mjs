import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `two-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }
const DAGGER = { id: 'dagger', name: 'Кинжал', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'dex', damage: '1d4', damageType: 'piercing', normalRange: 5 } }

function field({ casterClass = 'wizard', level = 12, foeType = 'humanoid', foeAt = { x: 8, y: 2 }, inventory = [] } = {}) {
  const cells = Array.from({ length: 96 }, (_, index) => ({ x: index % 16, y: Math.floor(index / 16), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'CTRL-2',
    partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Аль', characterClass: casterClass, level, hp: 50, maxHp: 50, armor: 13, speed: 30, proficiency: 4, abilities: { str: 18, dex: 18, con: 14, int: 18, wis: 18, cha: 16 }, inventory, x: 1, y: 2 }],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: foeType, hp: 120, maxHp: 120, armor: 10, speed: 30, abilities: { str: 8, dex: 8, con: 10, int: 8, wis: 8, cha: 8 }, x: foeAt.x, y: foeAt.y, alive: true }],
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
const damageOf = (result) => result.events.find((event) => event.event_type === 'DamageApplied').payload

test('Тошнотворное облако лишает действия и повторяет спасбросок', () => {
  const result = cast(field(), 'stinking-cloud', [2], { to: { x: 8, y: 2 }, target_id: undefined })
  const stunned = result.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'incapacitated')
  assert.ok(stunned, 'провал спасброска Телосложения лишает хода')
  assert.equal(stunned.payload.repeat_save_timing, 'turn-end')
  assert.equal(result.events.find((event) => event.event_type === 'SpellAreaCreated').payload.effect.condition, 'incapacitated')
})

test('Приливная волна бьёт и сбивает с ног', () => {
  const result = cast(field({ casterClass: 'druid' }), 'tidal-wave', [4, 4, 4, 4, 2], { to: { x: 8, y: 2 }, target_id: undefined })
  assert.equal(damageOf(result).raw_amount, 16)
  assert.equal(damageOf(result).damage_type, 'bludgeoning')
  assert.deepEqual(conditionsAdded(result), ['prone'])
})

test('Рассвет оставляет столб, который жжёт и потом', () => {
  const result = cast(field({ casterClass: 'cleric' }), 'dawn', [4, 4, 4, 4, 2], { to: { x: 8, y: 2 }, target_id: undefined })
  const effect = result.events.find((event) => event.event_type === 'SpellAreaCreated').payload.effect
  assert.equal(effect.damage, '4d10')
  assert.equal(effect.damage_type, 'radiant')
  assert.equal(effect.trigger_on_enter, true)
  assert.equal(effect.trigger_on_turn_end, true)
  assert.equal(damageOf(result).damage_type, 'radiant')
})

test('Священное оружие добавляет 2к8 удару', () => {
  // Жрец, а не паладин: паладину пятый круг доступен только с 17-го уровня,
  // а кампания идёт до двенадцатого.
  const state = field({ casterClass: 'cleric', level: 12, inventory: [SWORD], foeAt: { x: 2, y: 2 } })
  const blessed = replayEvents(state, cast(state, 'holy-weapon', [], { target_id: 'mage' }).events)
  assert.ok(blessed.mechanics.conditions.mage.some((condition) => String(condition.id) === 'holy-weapon'))
  const strike = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'mage', target_id: 'brute', item_id: 'sword' }),
    blessed,
    options(dice([15, 5, 4, 4])),
  )
  const bonus = strike.rolls.find((roll) => roll.purpose === 'condition_damage:holy-weapon')
  assert.equal(bonus.expression, '2d8')
  assert.equal(damageOf(strike).raw_amount, 5 + 4 + 8)
})

test('Луч ослабления режет силовой удар вдвое, но не трогает ловкий', () => {
  const strong = field({ inventory: [SWORD], foeAt: { x: 2, y: 2 } })
  strong.mechanics.conditions = { mage: [{ id: 'enfeebled' }] }
  const heavy = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'mage', target_id: 'brute', item_id: 'sword' }),
    normalizeCampaignState(strong),
    options(dice([15, 5])),
  )
  assert.equal(damageOf(heavy).raw_amount, 4, 'меч на 5 плюс Сила 4 — девять, ослабление режет до четырёх')

  const quick = field({ inventory: [DAGGER], foeAt: { x: 2, y: 2 } })
  quick.mechanics.conditions = { mage: [{ id: 'enfeebled' }] }
  const light = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'mage', target_id: 'brute', item_id: 'dagger' }),
    normalizeCampaignState(quick),
    options(dice([15, 3])),
  )
  assert.equal(damageOf(light).raw_amount, 7, 'кинжал от Ловкости ослабление не режет')
})

test('Подчинение зверя не действует на гуманоида', () => {
  const beast = cast(field({ casterClass: 'druid', foeType: 'beast' }), 'dominate-beast', [2])
  assert.deepEqual(conditionsAdded(beast), ['charmed'])

  const human = cast(field({ casterClass: 'druid' }), 'dominate-beast', [2])
  assert.equal(human.events.find((event) => event.event_type === 'SpellSavingThrowResolved').payload.automatic_success, true)
  assert.deepEqual(conditionsAdded(human), [])
})

test('Истощение бьёт сразу и повторяется в начале хода цели', () => {
  const result = cast(field({ casterClass: 'warlock' }), 'enervation', [4, 4, 4, 4, 2])
  assert.equal(damageOf(result).raw_amount, 16)
  assert.equal(damageOf(result).damage_type, 'necrotic')
  const drained = result.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'enervated')
  assert.equal(drained.payload.recurring_damage, '4d8')
  assert.equal(drained.payload.recurring_damage_type, 'necrotic')
})

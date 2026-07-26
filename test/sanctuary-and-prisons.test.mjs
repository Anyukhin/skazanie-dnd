import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `sanc-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }

function field({ casterClass = 'cleric', level = 12, conditions = {}, foeAt = { x: 2, y: 2 } } = {}) {
  const cells = Array.from({ length: 96 }, (_, index) => ({ x: index % 16, y: Math.floor(index / 16), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'SANC-1',
    partyMemberIds: ['cleric', 'ally'],
    players: [
      { id: 'cleric', character: 'Жрец', characterClass: casterClass, level, hp: 50, maxHp: 50, armor: 16, speed: 30, proficiency: 4, abilities: { str: 12, dex: 12, con: 14, int: 10, wis: 18, cha: 12 }, inventory: [], x: 1, y: 2 },
      { id: 'ally', character: 'Бор', characterClass: 'wizard', level: 9, hp: 30, maxHp: 30, armor: 11, speed: 30, proficiency: 4, abilities: { str: 8, dex: 12, con: 12, int: 18, wis: 10, cha: 10 }, inventory: [], x: 3, y: 2 },
    ],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 120, maxHp: 120, armor: 10, speed: 30, abilities: { str: 16, dex: 10, con: 14, int: 8, wis: 8, cha: 8 }, x: foeAt.x, y: foeAt.y, alive: true, inventory: [SWORD] }],
    scene: { turn: 1, cells },
    mechanics: {
      conditions,
      resources: { cleric: Object.fromEntries([1, 2, 3, 4, 5, 6].map((slot) => [`spell_slots_${slot}`, { current: 3, max: 3 }])) },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'cleric', total: 20 }, { actor_id: 'ally', total: 15 }, { actor_id: 'brute', total: 8 }],
        action_economy: Object.fromEntries(['cleric', 'ally', 'brute'].map((id) => [id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])),
      },
    },
  })
}

const brutesTurn = (state) => ({ ...state, mechanics: { ...state.mechanics, combat: { ...state.mechanics.combat, active_index: 2 } } })
const swing = (state, values, target = 'ally') => resolveCommand(
  authoritative({ command_type: 'MakeAttack', actor_id: 'brute', target_id: target, item_id: 'sword' }),
  brutesTurn(state),
  options(dice(values)),
)

test('Святилище съедает действие нападающего, и броска атаки не происходит', () => {
  const state = field({ conditions: { ally: [{ id: 'sanctuary', save_dc: 16 }] } })
  const blocked = swing(state, [3])
  const save = blocked.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(save.payload.spell_id, 'sanctuary')
  assert.equal(save.payload.saved, false)
  assert.equal(blocked.events.some((event) => event.event_type === 'AttackResolved'), false, 'атаки не было вовсе')
  assert.equal(blocked.rolls.some((roll) => roll.purpose === 'attack'), false, 'кость атаки не бросалась')
  assert.ok(blocked.events.some((event) => event.event_type === 'CombatActionUsed' && event.payload.action_id === 'sanctuary-blocked'))
  assert.equal(replayEvents(state, blocked.events).mechanics.combat.action_economy.brute.action, false, 'действие потрачено впустую')
})

test('прошедший спасбросок бьёт как обычно', () => {
  const state = field({ conditions: { ally: [{ id: 'sanctuary', save_dc: 10 }] } })
  const hit = swing(state, [18, 15, 5])
  assert.equal(hit.events.find((event) => event.event_type === 'SpellSavingThrowResolved').payload.saved, true)
  assert.ok(hit.events.some((event) => event.event_type === 'AttackResolved'), 'атака состоялась')
  assert.ok(hit.events.some((event) => event.event_type === 'DamageApplied'))
})

test('Святилище защищает только того, на кого наложено', () => {
  const state = field({ conditions: { ally: [{ id: 'sanctuary', save_dc: 16 }] } })
  const other = swing(state, [18, 5], 'cleric')
  assert.equal(other.events.some((event) => event.event_type === 'SpellSavingThrowResolved'), false, 'по жрецу бьют без всякой проверки')
  assert.ok(other.events.some((event) => event.event_type === 'AttackResolved'))
})

test('заклинание кладёт состояние со своей Сл', () => {
  const state = field()
  const warded = replayEvents(state, resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'sanctuary', target_id: 'ally' }),
    state,
    options(dice()),
  ).events)
  assert.ok(warded.mechanics.conditions.ally.some((condition) => String(condition.id) === 'sanctuary'))
})

test('Мысленная темница бьёт и запирает разум', () => {
  const result = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'mental-prison', target_id: 'brute' }),
    field({ casterClass: 'warlock' }),
    options(dice([...Array.from({ length: 5 }, () => 6), 2])),
  )
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(damage.payload.raw_amount, 30)
  assert.equal(damage.payload.damage_type, 'psychic')
  assert.ok(result.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'incapacitated'))
})

test('Массовое внушение очаровывает нескольких разом', () => {
  const state = field({ casterClass: 'bard' })
  const crowd = normalizeCampaignState({
    ...state,
    enemies: [state.enemies[0], { ...state.enemies[0], id: 'brute-two', x: 4, y: 4 }],
    mechanics: {
      ...state.mechanics,
      combat: {
        ...state.mechanics.combat,
        initiative: [...state.mechanics.combat.initiative, { actor_id: 'brute-two', total: 5 }],
        action_economy: { ...state.mechanics.combat.action_economy, 'brute-two': { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
  const result = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'mass-suggestion', target_ids: ['brute', 'brute-two'] }),
    crowd,
    options(dice([2, 2])),
  )
  const charmed = result.events.filter((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'charmed')
  assert.equal(charmed.length, 2, 'очарованы обе цели')
})

test('Стена света жжёт и слепит, Пылающая сфера остаётся областью', () => {
  const light = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'wall-of-light', to: { x: 8, y: 2 } }),
    field({ casterClass: 'sorcerer' }),
    options(dice([4, 4, 4, 4])),
  )
  const wall = light.events.find((event) => event.event_type === 'SpellAreaCreated').payload.effect
  assert.equal(wall.damage, '4d8')
  assert.equal(wall.damage_type, 'radiant')
  assert.ok(Array.isArray(wall.cells) && wall.cells.length > 1, 'стена задана списком клеток')

  const sphere = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'flaming-sphere', to: { x: 8, y: 2 } }),
    field({ casterClass: 'druid' }),
    options(dice([4, 4])),
  )
  const burning = sphere.events.find((event) => event.event_type === 'SpellAreaCreated').payload.effect
  assert.equal(burning.damage, '2d6')
  assert.equal(burning.trigger_on_enter, true)
})

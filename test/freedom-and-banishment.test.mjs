import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `fm-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

function field({ casterClass = 'cleric', conditions = {}, effects = [] } = {}) {
  const cells = Array.from({ length: 96 }, (_, index) => ({ x: index % 16, y: Math.floor(index / 16), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'FM-1',
    partyMemberIds: ['hero', 'ally'],
    players: [
      { id: 'hero', character: 'Бор', characterClass: 'fighter', level: 9, hp: 50, maxHp: 50, armor: 17, speed: 30, proficiency: 4, abilities: { str: 18, dex: 12, con: 16, int: 10, wis: 12, cha: 10 }, inventory: [], x: 1, y: 2 },
      { id: 'ally', character: 'Жрец', characterClass: casterClass, level: 12, hp: 50, maxHp: 50, armor: 16, speed: 30, proficiency: 4, abilities: { str: 12, dex: 12, con: 14, int: 12, wis: 18, cha: 16 }, inventory: [], x: 2, y: 3 },
    ],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 90, maxHp: 90, armor: 12, speed: 30, abilities: { str: 14, dex: 10, con: 12, int: 8, wis: 8, cha: 8 }, x: 10, y: 2, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      conditions,
      active_effects: effects,
      resources: { ally: Object.fromEntries([1, 2, 3, 4, 5, 6].map((slot) => [`spell_slots_${slot}`, { current: 3, max: 3 }])) },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'ally', total: 15 }, { actor_id: 'brute', total: 8 }],
        action_economy: Object.fromEntries(['hero', 'ally', 'brute'].map((id) => [id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])),
      },
    },
  })
}

const mud = [{ id: 'mud', effect_id: 'mud', spell_id: 'spike-growth', center: { x: 4, y: 2 }, radius_feet: 20, area_shape: 'sphere', difficult_terrain: true, expires_round: 99 }]
const walk = (state, to) => resolveCommand(authoritative({ command_type: 'MoveActor', actor_id: 'hero', to }), state, options(dice()))
/** Заклинатель второй в очереди, поэтому для его заклинаний двигаем указатель. */
const castersTurn = (state) => ({ ...state, mechanics: { ...state.mechanics, combat: { ...state.mechanics.combat, active_index: 1 } } })
const cast = (state, spellId, values, extra = {}) => resolveCommand(
  authoritative({ command_type: 'CastSpell', actor_id: 'ally', spell_id: spellId, ...extra }),
  castersTurn(state),
  options(dice(values)),
)

test('Свобода перемещения снимает запрет двигаться, но не само состояние', () => {
  const held = field({ conditions: { hero: [{ id: 'grappled' }] } })
  assert.throws(() => walk(held, { x: 2, y: 2 }), /Скорость существа равна 0/u)

  const free = field({ conditions: { hero: [{ id: 'grappled' }, { id: 'freedom-of-movement' }] } })
  assert.ok(walk(free, { x: 2, y: 2 }).events.some((event) => event.event_type === 'ActorMoved'), 'схваченный, но свободный шагает')
  assert.ok(replayEvents(free, walk(free, { x: 2, y: 2 }).events).mechanics.conditions.hero.some((condition) => String(condition.id) === 'grappled'), 'сам захват остаётся')
})

test('Свобода перемещения не платит за труднопроходимость', () => {
  const stuck = field({ effects: mud })
  // Шесть клеток по грязи стоят вдвое — тридцати футов не хватает.
  assert.throws(() => walk(stuck, { x: 7, y: 2 }), (error) => error.code === 'SPEED_EXCEEDED')

  const free = field({ conditions: { hero: [{ id: 'freedom-of-movement' }] }, effects: mud })
  const moved = walk(free, { x: 7, y: 2 })
  assert.ok(moved.events.some((event) => event.event_type === 'ActorMoved'))
  assert.equal(moved.events.find((event) => event.event_type === 'ActorMoved').payload.movement_cost, 30, 'грязь не берёт лишнего')
})

test('Изгнание выключает цель из боя', () => {
  const state = field()
  const result = cast(state, 'banishment', [2], {target_id: 'brute' })
  assert.ok(result.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'banished'))
  const after = replayEvents(state, result.events)
  assert.throws(() => resolveCommand(
    authoritative({ command_type: 'MoveActor', actor_id: 'brute', to: { x: 9, y: 2 } }),
    { ...after, mechanics: { ...after.mechanics, combat: { ...after.mechanics.combat, active_index: 2 } } },
    options(dice()),
  ), /Скорость существа равна 0/u)
})

test('Аура чистоты даёт сопротивление яду и уверенность в спасбросках', () => {
  const state = field()
  const pure = replayEvents(state, cast(state, 'aura-of-purity', [], {target_ids: ['hero'] }).events)
  assert.ok(pure.mechanics.conditions.hero.some((condition) => String(condition.id) === 'aura-of-purity'))

  const poison = resolveCommand(
    authoritative({ command_type: 'ApplyDamage', actor_id: 'ally', target_id: 'hero', amount: 20, damage_type: 'poison' }),
    pure,
    options(dice([18])),
  )
  assert.equal(poison.events.find((event) => event.event_type === 'DamageApplied').payload.applied_amount, 10)

  const save = resolveCommand(
    authoritative({ command_type: 'MakeSavingThrow', actor_id: 'hero', ability: 'wis', difficulty: 15 }),
    pure,
    options(dice([3, 19])),
  )
  assert.equal(save.rolls.at(-1).mode, 'advantage')
})

test('Усиление характеристики выбирает, чему помогать', () => {
  const state = field({ casterClass: 'bard' })
  const strong = replayEvents(state, cast(state, 'enhance-ability', [], {target_id: 'hero', spell_option: 'dex' }).events)
  assert.ok(strong.mechanics.conditions.hero.some((condition) => String(condition.id) === 'enhanced-dex'))

  const nimble = resolveCommand(
    authoritative({ command_type: 'MakeAbilityCheck', actor_id: 'hero', ability: 'dex', difficulty: 15 }),
    strong,
    options(dice([3, 18])),
  )
  assert.equal(nimble.rolls[0].mode, 'advantage')
  assert.equal(nimble.events[0].payload.check_advantage_condition, 'enhanced-dex')

  const clumsy = resolveCommand(
    authoritative({ command_type: 'MakeAbilityCheck', actor_id: 'hero', ability: 'int', difficulty: 15 }),
    strong,
    options(dice([12])),
  )
  assert.equal(clumsy.rolls[0].mode, 'normal', 'другая характеристика не усилена')
})

test('Стена песка оставляет труднопроходимую полосу', () => {
  const state = field({ casterClass: 'wizard' })
  const sand = cast(state, 'wall-of-sand', [], {to: { x: 8, y: 3 } })
  const wall = sand.events.find((event) => event.event_type === 'SpellAreaCreated').payload.effect
  assert.equal(wall.difficult_terrain, true)
  assert.ok(Array.isArray(wall.cells) && wall.cells.length > 1)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { exhaustionLevelOf, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `ex-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }

function field({ conditions = {}, foeAt = { x: 2, y: 5 } } = {}) {
  const cells = Array.from({ length: 96 }, (_, index) => ({ x: index % 16, y: Math.floor(index / 16), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'EX-1',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Бор', characterClass: 'fighter', level: 9, hp: 60, maxHp: 60, armor: 16, speed: 30, proficiency: 4, abilities: { str: 18, dex: 14, con: 16, int: 10, wis: 12, cha: 10 }, inventory: [SWORD], x: 1, y: 2 }],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 90, maxHp: 90, armor: 10, speed: 30, abilities: { str: 14, dex: 10, con: 12, int: 8, wis: 8, cha: 8 }, x: foeAt.x, y: foeAt.y, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      conditions,
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'brute', total: 8 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          brute: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const at = (level) => field({ conditions: level ? { hero: [{ id: `exhaustion:${level}` }] } : {} })
/** Отдыхать в бою нельзя, а завершить можно только уже начатый отдых. */
const outOfCombat = (state, kind = 'long') => normalizeCampaignState({
  ...state,
  mechanics: { ...state.mechanics, resting: { hero: { kind } }, combat: { ...state.mechanics.combat, active: false } },
})

test('ступень истощения читается из идентификатора состояния', () => {
  assert.equal(exhaustionLevelOf(at(0), 'hero'), 0)
  assert.equal(exhaustionLevelOf(at(3), 'hero'), 3)
  assert.equal(exhaustionLevelOf(at(6), 'hero'), 6)
})

test('первая ступень мешает проверкам характеристик', () => {
  const check = (state) => resolveCommand(
    authoritative({ command_type: 'MakeAbilityCheck', actor_id: 'hero', ability: 'str', difficulty: 15 }),
    state,
    options(dice([18, 4])),
  )
  const healthy = check(at(0))
  assert.equal(healthy.rolls[0].mode, 'normal')

  const tired = check(at(1))
  assert.equal(tired.rolls[0].mode, 'disadvantage', 'с первой ступени проверки идут с помехой')
  assert.equal(tired.events[0].payload.check_disadvantage_condition, 'exhaustion:1')
})

test('вторая ступень режет скорость вдвое, пятая обнуляет', () => {
  const walk = (state, to) => resolveCommand(
    authoritative({ command_type: 'MoveActor', actor_id: 'hero', to }),
    state,
    options(dice()),
  )
  // Тридцать футов скорости — шесть клеток. На второй ступени остаётся три.
  assert.ok(walk(at(0), { x: 7, y: 2 }).events.some((event) => event.event_type === 'ActorMoved'))
  assert.throws(() => walk(at(2), { x: 7, y: 2 }), (error) => error.code === 'SPEED_EXCEEDED')
  assert.ok(walk(at(2), { x: 4, y: 2 }).events.some((event) => event.event_type === 'ActorMoved'))
  assert.throws(() => walk(at(5), { x: 2, y: 2 }), /Скорость существа равна 0/u, 'пятая ступень не даёт сделать и шага')
})

test('третья ступень мешает атакам и спасброскам', () => {
  const at = (level) => field({ foeAt: { x: 2, y: 2 }, conditions: level ? { hero: [{ id: `exhaustion:${level}` }] } : {} })
  const swing = (state) => resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'hero', target_id: 'brute', item_id: 'sword' }),
    state,
    options(dice([18, 3, 5])),
  )
  assert.equal(swing(at(2)).rolls.find((roll) => roll.purpose === 'attack').mode, 'normal', 'на второй ступени атака ещё цела')
  assert.equal(swing(at(3)).rolls.find((roll) => roll.purpose === 'attack').mode, 'disadvantage')

  // Спасбросок берём удачный: провал у воина 9-го уровня открыл бы окно
  // «Несгибаемого» и события спасброска в этой команде ещё не было бы.
  const save = (state) => resolveCommand(
    authoritative({ command_type: 'MakeSavingThrow', actor_id: 'hero', ability: 'dex', difficulty: 15 }),
    state,
    options(dice([18, 17])),
  )
  assert.equal(save(at(2)).rolls.at(-1).mode, 'normal', 'на второй ступени спасбросок ещё цел')
  const tired = save(at(3))
  assert.equal(tired.rolls.at(-1).mode, 'disadvantage')
  assert.equal(tired.events.find((event) => event.event_type === 'SavingThrowResolved').payload.save_disadvantage_condition, 'exhaustion:3')
})

test('длительный отдых снимает ровно одну ступень', () => {
  const rest = (state) => resolveCommand(
    authoritative({ command_type: 'CompleteRest', actor_id: 'hero', kind: 'long' }),
    outOfCombat(state),
    options(dice()),
  )
  const third = rest(at(3))
  assert.ok(third.events.some((event) => event.event_type === 'ConditionRemoved' && event.payload.condition === 'exhaustion:3'))
  assert.ok(third.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'exhaustion:2'))
  assert.equal(exhaustionLevelOf(replayEvents(at(3), third.events), 'hero'), 2, 'из третьей ступени выходят во вторую, а не в ноль')

  const last = rest(at(1))
  assert.ok(last.events.some((event) => event.event_type === 'ConditionRemoved' && event.payload.condition === 'exhaustion:1'))
  assert.equal(last.events.some((event) => event.event_type === 'ConditionAdded' && String(event.payload.condition).startsWith('exhaustion:')), false)
  assert.equal(exhaustionLevelOf(replayEvents(at(1), last.events), 'hero'), 0)

  const healthy = rest(at(0))
  assert.equal(healthy.events.some((event) => String(event.payload.condition ?? '').startsWith('exhaustion:')), false, 'здоровому отдых ничего не меняет')
})

test('короткий отдых истощение не лечит', () => {
  const short = resolveCommand(
    authoritative({ command_type: 'CompleteRest', actor_id: 'hero', kind: 'short' }),
    outOfCombat(at(3), 'short'),
    options(dice()),
  )
  assert.equal(short.events.some((event) => String(event.payload.condition ?? '').startsWith('exhaustion:')), false)
})

test('истощение накапливается ступенями и не превышает шестой', () => {
  const state = normalizeCampaignState({
    ...field(),
    players: [{ ...field().players[0], characterClass: 'wizard', level: 12 }],
    mechanics: { ...field().mechanics, resources: { hero: { spell_slots_4: { current: 3, max: 3 } } } },
  })
  const glow = (from) => resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'hero', spell_id: 'sickening-radiance', to: { x: 8, y: 2 } }),
    from,
    options(dice([4, 4, 4, 4, 2])),
  )
  const moved = normalizeCampaignState({ ...state, enemies: [{ ...state.enemies[0], x: 8, y: 2 }] })

  const first = glow(moved)
  const added = first.events.find((event) => event.event_type === 'ConditionAdded' && String(event.payload.condition).startsWith('exhaustion:'))
  assert.equal(added.payload.condition, 'exhaustion:1')
  assert.equal(added.payload.exhaustion_level, 1)
  assert.equal(first.events.some((event) => event.event_type === 'ConditionRemoved'), false, 'снимать пока нечего')

  const afterFirst = replayEvents(moved, first.events)
  assert.equal(exhaustionLevelOf(afterFirst, 'brute'), 1)

  const second = glow({ ...afterFirst, mechanics: { ...afterFirst.mechanics, concentration: {}, combat: { ...afterFirst.mechanics.combat, action_economy: { ...afterFirst.mechanics.combat.action_economy, hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } } } })
  assert.ok(second.events.some((event) => event.event_type === 'ConditionRemoved' && event.payload.condition === 'exhaustion:1'), 'нижняя ступень снимается')
  assert.ok(second.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'exhaustion:2'))
})

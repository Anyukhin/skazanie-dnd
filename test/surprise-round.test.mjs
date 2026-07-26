import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `surprise-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }

/**
 * One hero and one guard. The guard's passive Perception is 10 (Wisdom 10, no
 * proficiency), so a Stealth result of 11 hides from it and 10 does not — the
 * boundary the surprise rule actually turns on.
 */
function ambushState({ heroConditions = [], guardWisdom = 10, guardProficiency = 0 } = {}) {
  const cells = Array.from({ length: 40 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'SURPRISE-1',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Тень', role: 'Плут · ур. 5', characterClass: 'rogue', level: 5, hp: 30, maxHp: 30, armor: 15, speed: 30, proficiency: 3, abilities: { str: 12, dex: 18, con: 12, int: 10, wis: 12, cha: 10 }, inventory: [SWORD], x: 1, y: 1 }],
    enemies: [{
      id: 'guard', name: 'Часовой', creature_type: 'humanoid', hp: 30, maxHp: 30, armor: 13, speed: 30,
      abilities: { str: 14, dex: 12, con: 12, int: 10, wis: guardWisdom, cha: 10 },
      ...(guardProficiency ? { proficiency: guardProficiency } : {}),
      x: 3, y: 1, alive: true,
    }],
    scene: { turn: 1, cells },
    mechanics: {
      conditions: heroConditions.length ? { hero: heroConditions } : {},
      combat: { active: false, round: 0, initiative: [], active_index: -1, action_economy: {}, reaction_window: null },
    },
  })
}

// Инициатива: два броска d20 подряд, герой ходит первым.
const startCombat = (state, values = [18, 5]) => resolveCommand(
  authoritative({ command_type: 'StartCombat', actor_id: 'hero' }),
  state,
  options(dice(values)),
)

const surpriseOf = (result) => result.events.find((event) => event.event_type === 'CombatStarted').payload.surprised
const surprisedIds = (result) => result.events
  .filter((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'surprised')
  .flatMap((event) => event.target_ids)

test('скрытый герой, обошедший пассивное Восприятие, застаёт часового врасплох', () => {
  const state = ambushState({ heroConditions: [{ id: 'hidden', check_total: 11 }] })
  const started = startCombat(state)
  assert.deepEqual(surpriseOf(started), ['guard'])
  assert.deepEqual(surprisedIds(started), ['guard'])
  const added = started.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'surprised')
  assert.equal(added.payload.duration, 'until-own-turn-end')
  assert.equal(added.payload.passive_perception, 10)
})

test('часовой, чьё пассивное Восприятие не уступает Скрытности, внезапности не получает', () => {
  const noticed = startCombat(ambushState({ heroConditions: [{ id: 'hidden', check_total: 10 }] }))
  assert.equal(surpriseOf(noticed), undefined)
  assert.deepEqual(surprisedIds(noticed), [])

  // Мудрость 16 и владение мастерством +2 дают пассивное Восприятие 15.
  const attentive = startCombat(ambushState({ heroConditions: [{ id: 'hidden', check_total: 14 }], guardWisdom: 16, guardProficiency: 2 }))
  assert.equal(surpriseOf(attentive), undefined, 'пассивное Восприятие 15 замечает Скрытность 14')
})

test('несокрытый нападающий отменяет внезапность для всей стороны', () => {
  const open = startCombat(ambushState())
  assert.equal(surpriseOf(open), undefined)
  assert.deepEqual(surprisedIds(open), [])
})

test('застигнутый врасплох теряет действие, перемещение и реакцию, но может окончить ход', () => {
  const state = ambushState({ heroConditions: [{ id: 'hidden', check_total: 11 }] })
  const started = startCombat(state)
  const ambushed = replayEvents(state, started.events)
  const guardsTurn = { ...ambushed, mechanics: { ...ambushed.mechanics, combat: { ...ambushed.mechanics.combat, active_index: 1 } } }

  for (const command of [
    { command_type: 'MakeAttack', actor_id: 'guard', target_id: 'hero' },
    { command_type: 'UseCombatAction', actor_id: 'guard', action_id: 'dodge' },
  ]) {
    assert.throws(
      () => resolveCommand(authoritative(command), guardsTurn, options(dice([10, 10, 10]))),
      (error) => error.code === 'ACTOR_INCAPACITATED' && error.message.includes('surprised'),
      `${command.command_type} обязан быть закрыт внезапностью`,
    )
  }
  assert.throws(
    () => resolveCommand(authoritative({ command_type: 'MoveActor', actor_id: 'guard', to: { x: 4, y: 1 } }), guardsTurn, options(dice())),
    (error) => error.code === 'SPEED_IS_ZERO' && error.message.includes('surprised'),
  )
  assert.deepEqual(planNpcTurn(guardsTurn, 'guard'), [{ command_type: 'EndTurn', actor_id: 'guard' }], 'планировщик не имеет права предлагать ход застигнутому врасплох')

  const ended = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'guard' }), guardsTurn, options(dice([10])))
  assert.ok(ended.events.some((event) => event.event_type === 'TurnEnded'))
})

test('внезапность спадает в конце собственного хода, а не в его начале', () => {
  const state = ambushState({ heroConditions: [{ id: 'hidden', check_total: 11 }] })
  const started = startCombat(state)
  let current = replayEvents(state, started.events)

  const heroEnds = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'hero' }), current, options(dice([10])))
  current = replayEvents(current, heroEnds.events)
  assert.ok(
    (current.mechanics.conditions.guard ?? []).some((condition) => condition.id === 'surprised'),
    'чужой ход не имеет права снимать внезапность',
  )

  const guardEnds = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'guard' }), current, options(dice([10])))
  current = replayEvents(current, guardEnds.events)
  assert.ok(
    !(current.mechanics.conditions.guard ?? []).some((condition) => condition.id === 'surprised'),
    'после собственного хода внезапность обязана спасть',
  )
  const acted = resolveCommand(
    authoritative({ command_type: 'MoveActor', actor_id: 'guard', to: { x: 4, y: 1 } }),
    { ...current, mechanics: { ...current.mechanics, combat: { ...current.mechanics.combat, active_index: 1 } } },
    options(dice()),
  )
  assert.ok(acted.events.some((event) => event.event_type === 'ActorMoved'), 'во втором раунде часовой действует свободно')
})

test('действие «Засада» сохраняет результат броска для сравнения с Восприятием', () => {
  const state = normalizeCampaignState({
    ...ambushState(),
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 18 }, { actor_id: 'guard', total: 5 }],
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
  const hidden = resolveCommand(
    authoritative({ command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'hide' }),
    state,
    options(dice([15])),
  )
  const added = hidden.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'hidden')
  assert.equal(added.payload.check_total, 15 + 4 + 3, 'итог обязан включать Ловкость и владение Скрытностью')
  const applied = hidden.events.reduce(applyGameEvent, state)
  assert.equal(applied.mechanics.conditions.hero.find((condition) => condition.id === 'hidden').check_total, 22)
})

test('решение о внезапности переживает replay', () => {
  const state = ambushState({ heroConditions: [{ id: 'hidden', check_total: 11 }] })
  const started = startCombat(state)
  assert.deepEqual(replayEvents(state, started.events), started.events.reduce(applyGameEvent, state))
})

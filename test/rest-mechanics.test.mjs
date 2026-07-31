import assert from 'node:assert/strict'
import test from 'node:test'

import { Adjudicator } from '../server/adjudicator.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  RULE_IDS,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
  resolveCommands,
  validateCommand,
} from '../server/rules-engine.mjs'

const diceService = new DiceService({ rng: new SequenceDiceRng([]) })

function fighterState(overrides = {}) {
  return normalizeCampaignState({
    players: [{
      id: 'fighter', character: 'Бран', role: 'Воин · ур. 2', level: 2,
      hp: 7, maxHp: 18, abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 8 },
      inventory: [],
    }],
    mechanics: {
      resources: {
        fighter: {
          second_wind: { current: 0, max: 1 },
          action_surge: { current: 0, max: 1 },
          campaign_charge: { current: 0, max: 3 },
        },
      },
    },
    ...overrides,
  })
}

test('естественная команда отдыха превращается в атомарный серверный цикл с ходом времени', async () => {
  const plan = await new Adjudicator().createPlan({
    intent: { intent: 'rest', actor_id: 'fighter', raw_message: 'Устраиваю короткий отдых', confidence: 1 },
    state: fighterState(),
    retrievedRules: { results: [], confidence: 1 },
  })
  assert.deepEqual(plan.proposed_commands.map((command) => command.command_type), ['StartRest', 'AdvanceTime', 'CompleteRest'])
  assert.equal(plan.proposed_commands[1].amount, 60)
  assert.equal(plan.proposed_commands[2].hit_dice, 1, 'UI-intent явно выбирает одну кость хитов')

  const result = resolveCommands(plan.proposed_commands, fighterState(), {
    diceService: new DiceService({ rng: new SequenceDiceRng([5]) }),
    context: { allowedActorIds: ['fighter'] },
  })
  assert.deepEqual(result.events.map((event) => event.event_type), [
    'RestStarted', 'TimeAdvanced', 'DieRolled', 'HitDiceRolled', 'ResourceSpent', 'HealingApplied', 'RestCompleted',
  ])
  assert.equal(result.state.mechanics.world_time.amount, 60)
  assert.equal(result.state.mechanics.resources.fighter.second_wind.current, 1)
  assert.equal(result.state.mechanics.resources.fighter.action_surge.current, 1)
  assert.equal(result.state.mechanics.resources.fighter.campaign_charge.current, 0)
  assert.equal(result.state.players[0].hp, 14)
  assert.deepEqual(result.state.mechanics.resources.fighter.hit_dice, { current: 1, max: 2, sides: 10 })
  assert.equal(result.state.mechanics.resting.fighter, undefined)
})

test('долгий отдых лечит и восстанавливает долгие ресурсы, но не снимает постоянное состояние', () => {
  const state = normalizeCampaignState({
    players: [{
      id: 'wizard', character: 'Мира', role: 'Волшебник · ур. 3', level: 3,
      hp: 2, maxHp: 14, abilities: { int: 16, con: 12 }, inventory: [],
    }],
    mechanics: {
      temporary_hp: { wizard: 5 },
      resources: { wizard: { spell_slots_1: { current: 0, max: 4 }, arcane_recovery: { current: 0, max: 1 } } },
      conditions: { wizard: [
        { id: 'poisoned', duration: null },
        { id: 'shielded', duration: 'until-next-turn' },
        { id: 'blessed', duration: 'concentration', effect_id: 'spell:bless' },
      ] },
      concentration: { wizard: { effect_id: 'spell:bless' } },
      active_effects: [{ effect_id: 'spell:bless', source_actor: 'wizard' }],
    },
  })
  const commands = [
    { command_type: 'StartRest', actor_id: 'wizard', kind: 'long', source_rule_ids: [RULE_IDS.resource] },
    { command_type: 'AdvanceTime', amount: 480, unit: 'minute', source_rule_ids: [RULE_IDS.resource] },
    { command_type: 'CompleteRest', actor_id: 'wizard', kind: 'long', source_rule_ids: [RULE_IDS.resource] },
  ]
  const result = resolveCommands(commands, state, { diceService, context: { allowedActorIds: ['wizard'] } })
  assert.deepEqual(result.events.map((event) => event.event_type), ['RestStarted', 'TimeAdvanced', 'ConcentrationEnded', 'RestCompleted'])
  assert.equal(result.state.players[0].hp, 14)
  assert.equal(result.state.mechanics.temporary_hp.wizard, 0)
  assert.equal(result.state.mechanics.resources.wizard.spell_slots_1.current, 4)
  assert.equal(result.state.mechanics.resources.wizard.arcane_recovery.current, 1)
  assert.deepEqual(result.state.mechanics.conditions.wizard.map((condition) => condition.id), ['poisoned'])
  assert.equal(result.state.mechanics.concentration.wizard, undefined)
  assert.deepEqual(result.state.mechanics.active_effects, [])
})

test('нельзя мгновенно завершить не начатый отдых или отдыхать во время боя', () => {
  const state = fighterState()
  assert.throws(
    () => validateCommand({ command_type: 'CompleteRest', actor_id: 'fighter', kind: 'short' }, state, { allowedActorIds: ['fighter'] }),
    (error) => error.code === 'REST_NOT_STARTED',
  )
  const combat = normalizeCampaignState({
    ...state,
    mechanics: { ...state.mechanics, combat: { active: true, round: 1, initiative: [{ actor_id: 'fighter' }], active_index: 0 } },
  })
  assert.throws(
    () => validateCommand({ command_type: 'StartRest', actor_id: 'fighter', kind: 'long' }, combat, { allowedActorIds: ['fighter'] }),
    (error) => error.code === 'REST_DURING_COMBAT',
  )
})

test('игрок выбирает несколько костей хитов, бросок детерминирован, расход replay-safe', () => {
  const initial = fighterState({
    mechanics: {
      resting: { fighter: { kind: 'short' } },
      resources: {
        fighter: {
          hit_dice: { current: 2, max: 2, sides: 10 },
          second_wind: { current: 0, max: 1 },
        },
      },
    },
  })
  const result = resolveCommand({
    command_type: 'CompleteRest',
    actor_id: 'fighter',
    kind: 'short',
    hit_dice: 2,
  }, initial, {
    diceService: new DiceService({ rng: new SequenceDiceRng([4, 6]) }),
    context: { allowedActorIds: ['fighter'] },
  })
  const rolled = result.events.find((event) => event.event_type === 'HitDiceRolled')
  assert.equal(rolled.payload.expression, '2d10+4')
  assert.equal(rolled.payload.requested_healing, 14)
  const replayed = replayEvents(initial, result.events)
  assert.equal(replayed.players[0].hp, 18)
  assert.equal(replayed.mechanics.resources.fighter.hit_dice.current, 0)
  assert.equal(replayed.mechanics.resting.fighter, undefined)
  assert.throws(() => validateCommand({
    command_type: 'CompleteRest',
    actor_id: 'fighter',
    kind: 'short',
    hit_dice: 3,
  }, initial, { allowedActorIds: ['fighter'] }), (error) => error.code === 'HIT_DICE_INSUFFICIENT')
  assert.throws(() => validateCommand({
    command_type: 'CompleteRest',
    actor_id: 'fighter',
    kind: 'short',
    hit_dice: 1,
  }, initial, { allowedActorIds: ['other'] }), (error) => error.code === 'ACTOR_FORBIDDEN')
})

test('долгий отдых восстанавливает половину максимума костей хитов, а не весь запас', () => {
  const initial = normalizeCampaignState({
    players: [{
      id: 'fighter', character: 'Бран', role: 'Воин · ур. 5', level: 5,
      hp: 18, maxHp: 18, abilities: { str: 16, dex: 12, con: 14 }, inventory: [],
    }],
    mechanics: {
      resting: { fighter: { kind: 'long' } },
      resources: { fighter: { hit_dice: { current: 0, max: 5, sides: 10 } } },
    },
  })
  const result = resolveCommand({
    command_type: 'CompleteRest', actor_id: 'fighter', kind: 'long',
  }, initial, { diceService, context: { allowedActorIds: ['fighter'] } })
  const recovered = result.events.find((event) => event.event_type === 'HitDiceRecovered')
  assert.deepEqual({ amount: recovered.payload.amount, before: recovered.payload.before, after: recovered.payload.after }, {
    amount: 3, before: 0, after: 3,
  })
  assert.equal(replayEvents(initial, result.events).mechanics.resources.fighter.hit_dice.current, 3)
})

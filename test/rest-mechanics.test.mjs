import assert from 'node:assert/strict'
import test from 'node:test'

import { Adjudicator } from '../server/adjudicator.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  RULE_IDS,
  applyGameEvent,
  hitPointDicePoolForActor,
  normalizeCampaignState,
  resolveCommands,
  validateCommand,
} from '../server/rules-engine.mjs'
import { worldClockEventDrafts } from '../server/weather.mjs'

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

  const result = resolveCommands(plan.proposed_commands, fighterState(), { diceService, context: { allowedActorIds: ['fighter'] } })
  assert.deepEqual(result.events.map((event) => event.event_type), ['RestStarted', 'TimeAdvanced', 'RestCompleted'])
  assert.equal(result.state.mechanics.world_time.amount, 60)
  assert.equal(result.state.mechanics.resources.fighter.second_wind.current, 1)
  assert.equal(result.state.mechanics.resources.fighter.action_surge.current, 1)
  assert.equal(result.state.mechanics.resources.fighter.campaign_charge.current, 0)
  assert.equal(result.state.players[0].hp, 7)
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
  // Смену времени суток и погоды пишут мировые часы (`server/weather.mjs`), и к
  // отдыху они отношения не имеют — но вычёркивать их из списка нельзя: тогда
  // лишнее или задвоенное событие неба в этом контуре не заметил бы никто.
  // Поэтому они стоят на своём месте, а ждут их ровно столько, сколько написали
  // сами часы: сразу после `TimeAdvanced`.
  const sky = worldClockEventDrafts(state, 480).map((draft) => draft.event_type)
  assert.ok(sky.includes('TimeOfDayChanged'), 'восемь часов сна обязаны перевести время суток')
  assert.deepEqual(
    result.events.map((event) => event.event_type),
    ['RestStarted', 'TimeAdvanced', ...sky, 'ConcentrationEnded', 'HitPointDiceRestored', 'RestCompleted'],
  )
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

test('короткий отдых тратит кости хитов по одной и лечит по броску с Телосложением', () => {
  const state = fighterState()
  const localDice = new DiceService({
    rng: new SequenceDiceRng([6, 10]),
    idFactory: (() => { let id = 0; return () => `hit-die-roll-${++id}` })(),
  })
  const result = resolveCommands([
    { command_type: 'StartRest', actor_id: 'fighter', kind: 'short' },
    { command_type: 'AdvanceTime', amount: 60, unit: 'minute' },
    { command_type: 'SpendHitPointDie', actor_id: 'fighter' },
    { command_type: 'SpendHitPointDie', actor_id: 'fighter' },
    { command_type: 'CompleteRest', actor_id: 'fighter', kind: 'short' },
  ], state, { diceService: localDice, context: { allowedActorIds: ['fighter'] } })

  assert.deepEqual(result.events.map((event) => event.event_type), [
    'RestStarted', 'TimeAdvanced',
    'HitPointDieSpent', 'HealingApplied',
    'HitPointDieSpent', 'HealingApplied',
    'RestCompleted',
  ])
  assert.equal(result.events[0].event_schema_version, 2)
  assert.equal(result.events[0].payload.started_at_minutes, 0)
  assert.equal(result.events.at(-1).payload.duration_minutes, 60)
  assert.deepEqual(result.state.mechanics.hit_point_dice.fighter, {
    schema_version: 1, maximum: 2, spent: 2, die_size: 10,
  })
  assert.equal(result.state.players[0].hp, 18)
  assert.equal(result.events[2].payload.formula, '1d10+2')
  assert.equal(result.events[2].payload.applied_healing, 8)
  assert.equal(result.events[4].payload.applied_healing, 3)
  const replayed = result.events.reduce((current, event) => applyGameEvent(current, event), state)
  assert.equal(replayed.players[0].hp, result.state.players[0].hp)
  assert.deepEqual(replayed.mechanics.hit_point_dice.fighter, result.state.mechanics.hit_point_dice.fighter)
})

test('кость хитов нельзя тратить до 60 минут, при полных хитах или без оставшихся костей', () => {
  const started = resolveCommands([
    { command_type: 'StartRest', actor_id: 'fighter', kind: 'short' },
  ], fighterState(), { diceService, context: { allowedActorIds: ['fighter'] } }).state
  assert.throws(
    () => validateCommand({ command_type: 'SpendHitPointDie', actor_id: 'fighter' }, started, { allowedActorIds: ['fighter'] }),
    (error) => error.code === 'REST_DURATION_INSUFFICIENT',
  )
  assert.throws(
    () => validateCommand({ command_type: 'CompleteRest', actor_id: 'fighter', kind: 'short' }, started, { allowedActorIds: ['fighter'] }),
    (error) => error.code === 'REST_DURATION_INSUFFICIENT',
  )
  assert.throws(
    () => validateCommand({ command_type: 'CompleteRest', actor_id: 'fighter', kind: 'short', rest_id: 'forged' }, started, { allowedActorIds: ['fighter'] }),
    (error) => error.code === 'REST_ID_MISMATCH',
  )

  const eligible = resolveCommands([
    { command_type: 'AdvanceTime', amount: 60, unit: 'minute' },
  ], started, { diceService, context: { allowedActorIds: ['fighter'] } }).state
  const fullHp = normalizeCampaignState({ ...eligible, players: [{ ...eligible.players[0], hp: 18 }] })
  assert.throws(
    () => validateCommand({ command_type: 'SpendHitPointDie', actor_id: 'fighter' }, fullHp, { allowedActorIds: ['fighter'] }),
    (error) => error.code === 'HIT_POINTS_ALREADY_FULL',
  )
  const emptyPool = normalizeCampaignState({
    ...eligible,
    mechanics: { ...eligible.mechanics, hit_point_dice: { fighter: { schema_version: 1, maximum: 2, spent: 2, die_size: 10 } } },
  })
  assert.throws(
    () => validateCommand({ command_type: 'SpendHitPointDie', actor_id: 'fighter' }, emptyPool, { allowedActorIds: ['fighter'] }),
    (error) => error.code === 'HIT_POINT_DICE_EXHAUSTED',
  )
})

test('долгий отдых восстанавливает все потраченные кости хитов событием из payload', () => {
  const state = fighterState({
    mechanics: {
      resources: { fighter: {} },
      hit_point_dice: { fighter: { schema_version: 1, maximum: 2, spent: 2, die_size: 10 } },
    },
  })
  const result = resolveCommands([
    { command_type: 'StartRest', actor_id: 'fighter', kind: 'long' },
    { command_type: 'AdvanceTime', amount: 480, unit: 'minute' },
    { command_type: 'CompleteRest', actor_id: 'fighter', kind: 'long' },
  ], state, { diceService, context: { allowedActorIds: ['fighter'] } })
  const restored = result.events.find((event) => event.event_type === 'HitPointDiceRestored')
  assert.equal(restored.payload.restored, 2)
  assert.equal(result.state.mechanics.hit_point_dice.fighter.spent, 0)
})

test('размер кости хитов определяется классом, а неизвестный класс получает d8', () => {
  const expected = new Map([
    ['barbarian', 12],
    ['fighter', 10], ['paladin', 10], ['ranger', 10],
    ['bard', 8], ['cleric', 8], ['druid', 8], ['monk', 8], ['rogue', 8], ['warlock', 8],
    ['sorcerer', 6], ['wizard', 6],
    ['inventor', 8],
  ])
  const state = normalizeCampaignState({
    players: [...expected.keys()].map((characterClass) => ({
      id: characterClass,
      characterClass,
      level: 3,
      hp: 10,
      maxHp: 10,
      abilities: { con: 10 },
      inventory: [],
    })),
  })

  for (const [actorId, dieSize] of expected) {
    assert.deepEqual(hitPointDicePoolForActor(state, actorId), {
      schema_version: 1,
      maximum: 3,
      spent: 0,
      die_size: dieSize,
    })
  }
})

test('лечение костью хитов не опускается ниже одного при отрицательном Телосложении', () => {
  const state = normalizeCampaignState({
    players: [{
      id: 'sorcerer', characterClass: 'sorcerer', level: 1,
      hp: 2, maxHp: 8, abilities: { con: 1 }, inventory: [],
    }],
  })
  const localDice = new DiceService({ rng: new SequenceDiceRng([1]) })
  const result = resolveCommands([
    { command_type: 'StartRest', actor_id: 'sorcerer', kind: 'short' },
    { command_type: 'AdvanceTime', amount: 60, unit: 'minute' },
    { command_type: 'SpendHitPointDie', actor_id: 'sorcerer' },
  ], state, { diceService: localDice, context: { allowedActorIds: ['sorcerer'] } })

  const spent = result.events.find((event) => event.event_type === 'HitPointDieSpent')
  assert.equal(spent.payload.formula, '1d6-5')
  assert.equal(spent.payload.healing_total, 1)
  assert.equal(spent.payload.applied_healing, 1)
  assert.equal(result.state.players[0].hp, 3)
})

test('редьюсер Hit Dice отклоняет события без версии и с неизвестной версией', () => {
  const state = fighterState()
  const payload = {
    schema_version: 1,
    pool_after: { schema_version: 1, maximum: 2, spent: 1, die_size: 10 },
  }
  const baseEvent = {
    event_type: 'HitPointDieSpent',
    actor_id: 'fighter',
    target_ids: ['fighter'],
    payload,
  }

  assert.equal(applyGameEvent(state, baseEvent).mechanics.hit_point_dice.fighter, undefined)
  assert.equal(applyGameEvent(state, { ...baseEvent, event_schema_version: 99 }).mechanics.hit_point_dice.fighter, undefined)
  assert.deepEqual(applyGameEvent(state, { ...baseEvent, event_schema_version: 1 }).mechanics.hit_point_dice.fighter, payload.pool_after)
})

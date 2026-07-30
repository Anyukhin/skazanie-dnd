import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CombatTurnCoordinator,
  activeTurnActorIds,
  combatTurnClock,
  combatTurnClockForState,
} from '../server/combat-turn-coordinator.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

function fixture({ activeActor = 'hero', group = false } = {}) {
  const initiative = activeActor === 'wolf'
    ? [{ actor_id: 'wolf', total: 20 }, { actor_id: 'hero', total: 10 }]
    : [{ actor_id: 'hero', total: 20 }, { actor_id: 'wolf', total: 10 }]
  return normalizeCampaignState({
    sessionCode: 'TURN-CLOCK',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Ада', hp: 20, maxHp: 20, armor: 14, speed: 30,
      abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
    }],
    enemies: [{
      id: 'wolf', name: 'Волк', hp: 12, maxHp: 12, armor: 12, speed: 40,
      abilities: { str: 12, dex: 14, con: 12, int: 3, wis: 12, cha: 6 },
      alive: true,
    }],
    scene: { turn: 1, cells: [] },
    mechanics: {
      conditions: activeActor === 'wolf' ? { wolf: [{ id: 'stunned', duration: 'until-own-turn-end' }] } : {},
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative,
        group_initiative: group,
        turn_completed: [],
        action_economy: Object.fromEntries(initiative.map(({ actor_id }) => [
          actor_id,
          { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        ])),
      },
    },
  })
}

function testStore(t, state, clock) {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-turn-clock-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  return new FileEventStore({
    rootDir,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    clock,
    idFactory: (() => {
      let id = 0
      return () => `turn-event-${++id}`
    })(),
  })
}

function engine() {
  return new RulesEngine({
    diceService: new DiceService({
      rng: new SequenceDiceRng([]),
      idFactory: () => 'unused-roll',
      now: () => '2026-07-30T12:00:00.000Z',
    }),
  })
}

async function recordTurnStart(store, campaignId, state, actorId) {
  await store.initializeCampaign({ campaign_id: campaignId, initial_state: state })
  return store.commit({
    campaign_id: campaignId,
    expected_state_version: 0,
    idempotency_key: `start:${campaignId}`,
    command_id: `start:${campaignId}`,
    events: [{
      event_type: 'TurnStarted',
      actor_id: actorId,
      target_ids: [actorId],
      payload: { round: 1, active_index: 0 },
      source_rule_ids: ['srd_5_2_1:combat/turns'],
      visibility: 'public',
    }],
  })
}

test('серверный координатор сразу завершает ход NPC и открывает таймер героя', async (t) => {
  const nowMs = Date.parse('2026-07-30T12:00:00.000Z')
  const store = testStore(t, fixture({ activeActor: 'wolf' }), () => new Date(nowMs))
  await recordTurnStart(store, 'NPC-PUSH', fixture({ activeActor: 'wolf' }), 'wolf')
  const committedBatches = []
  const scheduled = []
  const coordinator = new CombatTurnCoordinator({
    eventStore: store,
    rulesEngine: engine(),
    timeoutMs: 120_000,
    now: () => nowMs,
    setTimer: (_callback, delay) => {
      const handle = { delay }
      scheduled.push(handle)
      return handle
    },
    clearTimer: () => {},
    onCommitted: ({ events }) => committedBatches.push(events),
  })
  t.after(() => coordinator.close())

  await coordinator.settleNow('NPC-PUSH')

  const loaded = await store.load('NPC-PUSH')
  assert.equal(loaded.state.mechanics.combat.initiative[loaded.state.mechanics.combat.active_index].actor_id, 'hero')
  assert.ok(committedBatches.flat().some((event) => event.event_type === 'TurnEnded' && event.actor_id === 'wolf'))
  assert.deepEqual(coordinator.clockFor('NPC-PUSH')?.actor_ids, ['hero'])
  assert.equal(scheduled.at(-1)?.delay, 120_000)
})

test('сервер без участия клиента завершает всю групповую фазу NPC', async (t) => {
  const nowMs = Date.parse('2026-07-30T12:00:00.000Z')
  const state = fixture({ activeActor: 'wolf', group: true })
  state.enemies.push({ ...state.enemies[0], id: 'wolf-two', name: 'Второй волк' })
  state.mechanics.conditions['wolf-two'] = [{ id: 'stunned', duration: 'until-own-turn-end' }]
  state.mechanics.combat.initiative.splice(1, 0, { actor_id: 'wolf-two', total: 15 })
  state.mechanics.combat.action_economy['wolf-two'] = {
    action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0,
  }
  const store = testStore(t, state, () => new Date(nowMs))
  await recordTurnStart(store, 'NPC-GROUP-PUSH', state, 'wolf')
  const coordinator = new CombatTurnCoordinator({
    eventStore: store,
    rulesEngine: engine(),
    timeoutMs: 120_000,
    now: () => nowMs,
  })
  t.after(() => coordinator.close())

  await coordinator.settleNow('NPC-GROUP-PUSH')

  const loaded = await store.load('NPC-GROUP-PUSH')
  assert.equal(loaded.state.mechanics.combat.initiative[loaded.state.mechanics.combat.active_index].actor_id, 'hero')
  const ended = (await store.getEvents('NPC-GROUP-PUSH'))
    .filter((event) => event.event_type === 'TurnEnded')
    .map((event) => event.actor_id)
  assert.deepEqual(ended, ['wolf', 'wolf-two'])
})

test('истёкший дедлайн коммитит replay-safe авто-пропуск с устойчивым idempotency key', async (t) => {
  let storeClockMs = Date.parse('2026-07-30T12:00:00.000Z')
  const nowMs = storeClockMs + 30_000
  const state = fixture()
  const store = testStore(t, state, () => new Date(storeClockMs))
  await recordTurnStart(store, 'TIMEOUT-REPLAY', state, 'hero')
  storeClockMs = nowMs
  const reopened = new FileEventStore({
    rootDir: store.rootDir,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    clock: () => new Date(storeClockMs),
    idFactory: (() => {
      let id = 100
      return () => `turn-event-${++id}`
    })(),
  })
  const committedBatches = []
  const errors = []
  const coordinator = new CombatTurnCoordinator({
    eventStore: reopened,
    rulesEngine: engine(),
    timeoutMs: 20_000,
    now: () => nowMs,
    runNpcTurns: async () => ({ events: [] }),
    onCommitted: ({ events }) => committedBatches.push(events),
    onError: (error) => errors.push(error),
  })
  t.after(() => coordinator.close())

  await coordinator.settleNow('TIMEOUT-REPLAY')
  await coordinator.settleNow('TIMEOUT-REPLAY')

  assert.deepEqual(errors, [])
  const timeoutEvents = (await store.getEvents('TIMEOUT-REPLAY'))
    .filter((event) => event.event_type === 'TurnEnded' && event.payload.auto_skipped === true)
  assert.equal(timeoutEvents.length, 1)
  assert.equal(timeoutEvents[0].payload.auto_skip_reason, 'turn-timeout')
  assert.match(timeoutEvents[0].idempotency_key, /^turn-timeout:TIMEOUT-REPLAY:r1:i0:[a-f0-9]{20}:[a-f0-9]{20}$/u)
  assert.equal(committedBatches.flat().filter((event) => event.payload?.auto_skipped === true).length, 1)

  const replayed = await store.replay('TIMEOUT-REPLAY', { useSnapshots: false })
  assert.equal(replayed.state.mechanics.combat.active_index, 1)
  assert.equal(replayed.state.mechanics.combat.initiative[1].actor_id, 'wolf')
})

test('тайм-аут не замораживает бой на ещё не созданном месте героя', async (t) => {
  let storeClockMs = Date.parse('2026-07-30T12:00:00.000Z')
  const state = fixture()
  state.players[0].characterSetupRequired = true
  const store = testStore(t, state, () => new Date(storeClockMs))
  await recordTurnStart(store, 'SETUP-TIMEOUT', state, 'hero')
  storeClockMs += 30_000
  const errors = []
  const coordinator = new CombatTurnCoordinator({
    eventStore: store,
    rulesEngine: engine(),
    timeoutMs: 20_000,
    now: () => storeClockMs,
    runNpcTurns: async () => ({ events: [] }),
    onError: (error) => errors.push(error),
  })
  t.after(() => coordinator.close())

  await coordinator.settleNow('SETUP-TIMEOUT')

  assert.deepEqual(errors, [])
  const events = await store.getEvents('SETUP-TIMEOUT')
  assert.ok(events.some((event) => (
    event.event_type === 'TurnEnded'
    && event.actor_id === 'hero'
    && event.payload.auto_skipped === true
  )))
  const loaded = await store.load('SETUP-TIMEOUT')
  assert.equal(loaded.state.mechanics.combat.initiative[loaded.state.mechanics.combat.active_index].actor_id, 'wolf')
})

test('истёкшее окно реакции автоматически отклоняется и не замораживает ход NPC', async (t) => {
  let storeClockMs = Date.parse('2026-07-30T12:00:00.000Z')
  const state = fixture({ activeActor: 'wolf' })
  const store = testStore(t, state, () => new Date(storeClockMs))
  await recordTurnStart(store, 'REACTION-TIMEOUT', state, 'wolf')
  storeClockMs += 5_000
  const reactionId = 'opportunity:wolf:hero:1'
  await store.commit({
    campaign_id: 'REACTION-TIMEOUT',
    expected_state_version: 1,
    idempotency_key: 'open:REACTION-TIMEOUT',
    command_id: 'open:REACTION-TIMEOUT',
    events: [{
      event_type: 'ReactionWindowOpened',
      actor_id: 'wolf',
      target_ids: ['hero'],
      payload: {
        id: reactionId,
        trigger: 'enemy-left-reach',
        actor_id: 'hero',
        source_actor_id: 'wolf',
        target_id: 'hero',
        action_ids: ['opportunity-attack'],
      },
      source_rule_ids: ['srd_5_2_1:combat/reactions'],
      visibility: 'public',
    }],
  })

  const before = await store.load('REACTION-TIMEOUT')
  const clock = combatTurnClock(before.state, await store.getEvents('REACTION-TIMEOUT'), {
    timeoutMs: 20_000,
    now: storeClockMs,
  })
  assert.deepEqual(activeTurnActorIds(before.state), ['hero'])
  assert.equal(clock?.reaction_window_id, reactionId)
  assert.equal(clock?.started_at, '2026-07-30T12:00:05.000Z')
  assert.equal(clock?.deadline_at, '2026-07-30T12:00:25.000Z')

  storeClockMs += 25_000
  const committedBatches = []
  const coordinator = new CombatTurnCoordinator({
    eventStore: store,
    rulesEngine: engine(),
    timeoutMs: 20_000,
    now: () => storeClockMs,
    runNpcTurns: async () => ({ events: [] }),
    onCommitted: ({ events }) => committedBatches.push(events),
  })
  t.after(() => coordinator.close())

  await coordinator.settleNow('REACTION-TIMEOUT')
  await coordinator.settleNow('REACTION-TIMEOUT')

  const events = await store.getEvents('REACTION-TIMEOUT')
  const automaticDeclines = events.filter((event) => (
    event.event_type === 'ReactionWindowClosed'
    && event.payload.auto_declined === true
  ))
  assert.equal(automaticDeclines.length, 1)
  assert.equal(automaticDeclines[0].payload.auto_decline_reason, 'turn-timeout')
  assert.match(automaticDeclines[0].idempotency_key, /^reaction-timeout:REACTION-TIMEOUT:[a-f0-9]{20}$/u)
  assert.equal(events.some((event) => event.event_type === 'TurnEnded'), false)
  assert.equal((await store.load('REACTION-TIMEOUT')).state.mechanics.combat.reaction_window, null)
  assert.equal(committedBatches.flat().filter((event) => event.payload?.auto_declined === true).length, 1)
})

test('таймер групповой фазы показывает только тех, кто ещё не завершил ход', () => {
  const state = fixture({ group: true })
  state.players.push({ ...state.players[0], id: 'bard', character: 'Бард' })
  state.mechanics.combat.initiative.splice(1, 0, { actor_id: 'bard', total: 15 })
  state.mechanics.combat.action_economy.bard = {
    action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0,
  }
  state.mechanics.combat.turn_completed = ['hero']
  const events = [{
    event_type: 'TurnStarted',
    created_at: '2026-07-30T12:00:00.000Z',
    target_ids: ['hero'],
  }]

  assert.deepEqual(activeTurnActorIds(state), ['bard'])
  assert.deepEqual(combatTurnClock(state, events, {
    timeoutMs: 90_000,
    now: Date.parse('2026-07-30T12:00:10.000Z'),
  }), {
    actor_ids: ['bard'],
    round: 1,
    active_index: 0,
    turn_id: 'legacy:1:0:2026-07-30T12:00:00.000Z',
    started_at: '2026-07-30T12:00:00.000Z',
    deadline_at: '2026-07-30T12:01:30.000Z',
    duration_ms: 90_000,
  })
})

test('одинаковая инициатива в двух боях получает разные durable turn id', () => {
  const state = fixture()
  const common = {
    event_type: 'TurnStarted',
    created_at: '2026-07-30T12:00:00.000Z',
    target_ids: ['hero'],
  }
  const first = combatTurnClock(state, [{ ...common, event_id: 'combat-one:turn-one' }], {
    timeoutMs: 90_000,
    now: Date.parse(common.created_at),
  })
  const second = combatTurnClock(state, [{ ...common, event_id: 'combat-two:turn-one' }], {
    timeoutMs: 90_000,
    now: Date.parse(common.created_at),
  })

  assert.equal(first?.round, second?.round)
  assert.equal(first?.active_index, second?.active_index)
  assert.notEqual(first?.turn_id, second?.turn_id)
})

test('SSE не публикует clock прошлого участника после смены active index', () => {
  const state = fixture()
  const clock = combatTurnClock(state, [{
    event_type: 'TurnStarted',
    event_id: 'turn-one',
    created_at: '2026-07-30T12:00:00.000Z',
    target_ids: ['hero'],
  }], {
    timeoutMs: 90_000,
    now: Date.parse('2026-07-30T12:00:10.000Z'),
  })

  assert.equal(combatTurnClockForState(state, clock), clock)
  const enemyTurn = normalizeCampaignState({
    ...state,
    mechanics: {
      ...state.mechanics,
      combat: { ...state.mechanics.combat, active_index: 1 },
    },
  })
  assert.equal(combatTurnClockForState(enemyTurn, clock), null)
})

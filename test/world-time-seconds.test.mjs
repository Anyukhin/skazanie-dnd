import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand, worldTimeSeconds } from '../server/rules-engine.mjs'

function dice(values = []) {
  let next = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `clock-roll-${++next}`, now: () => '2026-09-21T12:00:00.000Z' })
}

function field({ active = true, group = false, worldTime = {}, conditions = {} } = {}) {
  const hero = (id, x) => ({
    id, character: id, characterClass: 'fighter', level: 3, hp: 20, maxHp: 20, armor: 12, speed: 30,
    abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [], x, y: 2,
  })
  const ids = group ? ['ann', 'bob', 'orc'] : ['ann', 'orc']
  return normalizeCampaignState({
    sessionCode: 'CLOCK-SECONDS', partyMemberIds: ['ann', ...(group ? ['bob'] : [])],
    players: [hero('ann', 1), ...(group ? [hero('bob', 2)] : [])],
    enemies: [{ ...hero('orc', 6), name: 'Орк', alive: true }],
    scene: { turn: 1, cells: Array.from({ length: 96 }, (_, i) => ({ x: i % 16, y: Math.floor(i / 16), type: 'floor', revealed: true })) },
    mechanics: {
      conditions, world_time: worldTime,
      combat: {
        active, round: active ? 1 : 0, active_index: active ? 0 : -1, group_initiative: group,
        initiative: active ? ids.map((id, index) => ({ actor_id: id, total: 20 - index * 5 })) : [],
        action_economy: Object.fromEntries(ids.map((id) => [id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])),
      },
    },
  })
}

function execute(state, command, values = []) {
  const result = resolveCommand({ actor_id: 'ann', server_authoritative: true, ...command }, state, {
    diceService: dice(values), context: { isAdmin: true, serverAuthoritativeCombat: true },
  })
  return { ...result, state: replayEvents(state, result.events) }
}

const advance = (state, amount, unit = 'second') => execute(state, { command_type: 'AdvanceTime', amount, unit })
const endTurn = (state, actor) => execute(state, { command_type: 'EndTurn', actor_id: actor })
const endCombat = (state) => execute(state, { command_type: 'EndCombat', actor_id: state.mechanics.combat.initiative[state.mechanics.combat.active_index]?.actor_id ?? 'ann' })
const ticks = (result) => result.events.filter((event) => event.event_type === 'TimeAdvanced')

test('старые снимки и события остаются минутными, старые TurnStarted не начисляют секунды', () => {
  const initial = field({ worldTime: { amount: 2, unit: 'hour' } })
  assert.deepEqual(initial.mechanics.world_time, { amount: 120, unit: 'minute', elapsed_minutes: 120 })
  const historical = [
    { event_type: 'TimeAdvanced', payload: { amount: 1, unit: 'round' } },
    { event_type: 'TurnStarted', payload: { round: 2, active_index: 0 }, target_ids: ['ann'] },
    { event_type: 'TimeAdvanced', payload: { amount: 8, unit: 'hour', elapsed_minutes: 3 } },
  ]
  const after = replayEvents(initial, historical)
  assert.deepEqual(after.mechanics.world_time, { amount: 123, unit: 'minute', elapsed_minutes: 123 })
  assert.equal(worldTimeSeconds(after), 7_380)
  assert.equal(after.mechanics.combat.round_time_pending, undefined)
})

test('дробные секунды нормализуются до миллисекунды и накапливаются в тех же мировых минутах', () => {
  let state = field({ active: false, worldTime: { elapsed_minutes: 9, second_remainder: 59.25 } })
  const first = advance(state, 0.75)
  assert.equal(ticks(first)[0].payload.clock_version, 2)
  assert.equal(ticks(first)[0].payload.elapsed_seconds, 0.75)
  assert.equal(ticks(first)[0].payload.elapsed_minutes, 1)
  assert.deepEqual(first.state.mechanics.world_time, { amount: 10, unit: 'minute', elapsed_minutes: 10, second_remainder: 0 })
  state = first.state
  for (let i = 0; i < 8; i += 1) state = normalizeCampaignState(advance(state, 0.75).state)
  assert.equal(worldTimeSeconds(state), 606)
  for (let i = 0; i < 10; i += 1) state = advance(state, 0.1).state
  assert.equal(state.mechanics.world_time.second_remainder, 7)
  assert.equal(worldTimeSeconds(advance(state, 0.1234).state), 607.123)
  assert.equal(Object.hasOwn(state.mechanics.world_time, 'elapsed_seconds'), false)
})

test('новый раунд и старое минутное событие сохраняют остаток секунд', () => {
  const initial = field({ worldTime: { elapsed_minutes: 4, second_remainder: 5.25 } })
  const byRound = advance(initial, 1, 'round')
  assert.equal(worldTimeSeconds(byRound.state), 251.25)
  const legacy = applyGameEvent(byRound.state, { event_type: 'TimeAdvanced', payload: { elapsed_minutes: 2 } })
  assert.deepEqual(legacy.mechanics.world_time, { amount: 6, unit: 'minute', elapsed_minutes: 6, second_remainder: 11.25 })
})

test('условия с абсолютными секундами истекают точно на границе; старые минутные остаются минутными', () => {
  const initial = field({ active: false, worldTime: { elapsed_minutes: 0, second_remainder: 59.5 }, conditions: { ann: [
    { id: 'longstrider', effect_id: 'a', expires_at_seconds: 60.25, expires_at_minutes: 1 },
    { id: 'longstrider', effect_id: 'b', expires_at_seconds: 61.5 },
    { id: 'old-effect', expires_at_minutes: 1 },
  ] } })
  const atMinute = advance(initial, 0.5).state
  assert.deepEqual(atMinute.mechanics.conditions.ann.map((c) => c.effect_id), ['a', 'b'])
  const before = advance(atMinute, 0.249).state
  assert.equal(before.mechanics.conditions.ann.length, 2)
  const exact = advance(before, 0.001).state
  assert.deepEqual(exact.mechanics.conditions.ann.map((c) => c.effect_id), ['b'])
  const done = advance(exact, 1.25).state
  assert.deepEqual(done.mechanics.conditions.ann, [])
})

test('время идёт один раз за полный раунд, между TurnEnded и TurnStarted', () => {
  const first = endTurn(field(), 'ann')
  assert.equal(ticks(first).length, 0)
  assert.equal(worldTimeSeconds(first.state), 0)
  const completed = endTurn(first.state, 'orc')
  const types = completed.events.map((event) => event.event_type)
  assert.equal(ticks(completed).length, 1)
  assert.equal(ticks(completed)[0].payload.elapsed_seconds, 6)
  assert.equal(ticks(completed)[0].payload.policy_id, 'round6-completed-and-final-started')
  assert.ok(types.indexOf('TurnEnded') < types.indexOf('TimeAdvanced'))
  assert.ok(types.indexOf('TimeAdvanced') < types.indexOf('TurnStarted'))
  assert.equal(worldTimeSeconds(completed.state), 6)
  assert.equal(completed.state.mechanics.combat.round, 2)
  assert.equal(worldTimeSeconds(endCombat(completed.state).state), 6, 'свежий раунд не оплачивается повторно')
})

test('групповая фаза не начисляет время за каждого союзника и запрещает повторный EndTurn', () => {
  const ann = endTurn(field({ group: true }), 'ann')
  assert.equal(ticks(ann).length, 0)
  assert.throws(() => endTurn(ann.state, 'ann'), (error) => error.code === 'OUT_OF_TURN')
  const bob = endTurn(ann.state, 'bob')
  assert.equal(ticks(bob).length, 0)
  const orc = endTurn(bob.state, 'orc')
  assert.equal(ticks(orc).length, 1)
  assert.equal(worldTimeSeconds(orc.state), 6)
})

test('финальный неполный раунд начисляется только после подтверждённого действия', () => {
  const initial = field({ active: false })
  const start = execute(initial, { command_type: 'StartCombat' }, [20, 10])
  assert.equal(worldTimeSeconds(endCombat(start.state).state), 0, 'StartCombat + EndCombat не тратят время')
  const skipped = endTurn(start.state, 'ann')
  assert.equal(worldTimeSeconds(endCombat(skipped.state).state), 0, 'пустой EndTurn не создаёт действие')
  const dashed = execute(start.state, { command_type: 'UseCombatAction', action_id: 'dash' })
  assert.equal(dashed.events[0].event_type, 'CombatRoundTimeMarked')
  assert.equal(dashed.events[0].event_schema_version, 2)
  assert.equal(dashed.state.mechanics.combat.round_time_pending, true)
  assert.equal(worldTimeSeconds(dashed.state), 0)
  const passed = endTurn(dashed.state, 'ann')
  assert.equal(passed.state.mechanics.combat.round_time_pending, true, 'смена участника в том же раунде сохраняет marker')
  const final = endCombat(passed.state)
  assert.equal(worldTimeSeconds(final.state), 6)
  assert.ok(final.events.findIndex((e) => e.event_type === 'TimeAdvanced') < final.events.findIndex((e) => e.event_type === 'CombatEnded'))
  assert.equal(final.state.mechanics.combat.round_time_pending, undefined)
  assert.throws(() => endCombat(final.state), (error) => error.code === 'COMBAT_NOT_ACTIVE')
})

test('реальное перемещение начинает финальный раунд, отказ и нулевой путь — нет', () => {
  const initial = field()
  assert.throws(() => execute(initial, { command_type: 'MoveActor', actor_id: 'orc', to: { x: 6, y: 3 } }), (error) => error.code === 'OUT_OF_TURN')
  assert.equal(initial.mechanics.combat.round_time_pending, undefined)
  assert.throws(() => execute(initial, { command_type: 'MoveActor', to: { x: 1, y: 2 } }), (error) => error.code === 'PATH_BLOCKED')
  assert.equal(worldTimeSeconds(endCombat(initial).state), 0)
  const moved = execute(initial, { command_type: 'MoveActor', to: { x: 1, y: 3 } })
  assert.equal(moved.state.mechanics.combat.round_time_pending, true)
  const again = execute(moved.state, { command_type: 'MoveActor', to: { x: 1, y: 4 } })
  assert.equal(again.events.some((event) => event.event_type === 'CombatRoundTimeMarked'), false)
  assert.equal(worldTimeSeconds(endCombat(again.state).state), 6)
  assert.equal(worldTimeSeconds(endCombat(initial).state), 0)
})

test('десятый раунд пересекает минуту и запускает прежнее восстановление ровно один раз', () => {
  let state = field()
  state.mechanics.resting.orc = { reason: 'knockout', recovery_minutes_remaining: 2 }
  for (let round = 1; round <= 10; round += 1) {
    state = endTurn(state, 'ann').state
    const result = endTurn(state, 'orc')
    const recovery = result.events.filter((event) => event.event_type === 'KnockoutRecoveryProgressed')
    assert.equal(recovery.length, round === 10 ? 1 : 0)
    if (round === 10) assert.equal(recovery[0].payload.elapsed_minutes, 1)
    state = result.state
  }
  assert.equal(worldTimeSeconds(state), 60)
  assert.equal(state.mechanics.world_time.elapsed_minutes, 1)
  assert.equal(state.mechanics.resting.orc.recovery_minutes_remaining, 1)
})

test('новые часы и pending marker одинаковы после commit, идемпотентного повтора и restart/replay', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-seconds-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const initial = field({ worldTime: { elapsed_minutes: 59, second_remainder: 58.75 } })
  const makeStore = () => new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState, initialStateFactory: () => initial, snapshotEvery: 2 })
  const store = makeStore()
  await store.initializeCampaign({ campaign_id: 'seconds', initial_state: initial })
  const action = execute(initial, { command_type: 'UseCombatAction', command_id: 'clock-dash', action_id: 'dash' })
  const request = { campaign_id: 'seconds', expected_state_version: 0, idempotency_key: 'dash-once', command_id: 'clock-dash', events: action.events }
  const first = await store.commit(request)
  const duplicate = await store.commit(request)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.state_version, first.state_version)
  const restored = await makeStore().replay('seconds', { use_snapshots: false })
  assert.deepEqual(restored.state, first.state)
  assert.equal(restored.state.mechanics.combat.round_time_pending, true)
  const ended = endCombat(restored.state)
  const finalRequest = { campaign_id: 'seconds', expected_state_version: first.state_version, idempotency_key: 'end-once', events: ended.events }
  const final = await store.commit(finalRequest)
  const repeated = await store.commit(finalRequest)
  assert.equal(repeated.duplicate, true)
  assert.equal(worldTimeSeconds(final.state), 3_604.75)
  assert.equal(worldTimeSeconds(repeated.state), 3_604.75)
  const replayed = await makeStore().replay('seconds', { use_snapshots: false })
  const snapshot = await makeStore().load('seconds')
  assert.deepEqual(replayed.state, final.state)
  assert.deepEqual(snapshot.state, final.state)
})

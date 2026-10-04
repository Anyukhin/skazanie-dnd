import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { FileTraceStore, buildTurnExplanation, isMechanicalTrace, redactTrace } from '../server/trace-store.mjs'

test('turn trace сохраняется, восстанавливается и объясняется через /why', () => {
  const store = new FileTraceStore({ rootDir: mkdtempSync(join(tmpdir(), 'skazanie-trace-')) })
  store.save({ turn_id: 'turn-1', campaign_id: 'ROOM-1', idempotency_key: 'damage-once', engine_mode: 'enforce', retrieved_rule_ids: ['rule-1'], validated_commands: [{ command_type: 'ApplyDamage' }], rolls: [{ total: 14 }], events: [{ event_type: 'DamageApplied' }], state_version_before: 1, state_version_after: 2, narration_result: { narration: 'Урон применён.', suggestions: [], provider: 'deterministic', verification: { valid: true } } })
  const explanation = buildTurnExplanation(store.get('ROOM-1', 'turn-1'))
  assert.equal(explanation.engine_mode, 'enforce')
  assert.deepEqual(explanation.rules_used, ['rule-1'])
  const stored = store.latest('ROOM-1')
  assert.equal(stored.turn_id, 'turn-1')
  assert.equal(stored.idempotency_key, 'damage-once')
  assert.equal(stored.narration_result.narration, 'Урон применён.')
})

test('секреты редактируются до записи трассировки', () => {
  const redacted = redactTrace({ apiKey: 'sk-secret-value-123456', nested: { authorization: 'Bearer abc.def', text: 'ok' } })
  assert.equal(redacted.apiKey, '[REDACTED]')
  assert.equal(redacted.nested.authorization, '[REDACTED]')
  assert.equal(redacted.nested.text, 'ok')
})

test('recent возвращает ограниченное окно последних трасс для антиповтора', () => {
  const store = new FileTraceStore({ rootDir: mkdtempSync(join(tmpdir(), 'skazanie-trace-recent-')) })
  for (let index = 1; index <= 4; index += 1) {
    store.save({
      turn_id: `turn-${index}`,
      campaign_id: 'ROOM-RECENT',
      created_at: `2026-07-29T20:00:0${index}.000Z`,
      narration_result: { narration: `Текст ${index}.` },
    })
  }

  assert.deepEqual(store.recent('ROOM-RECENT', 3).map((trace) => trace.turn_id), ['turn-4', 'turn-3', 'turn-2'])
  assert.equal(store.latest('ROOM-RECENT').turn_id, 'turn-4')
})

test('latest с predicate пропускает бесплатные dialogue traces', () => {
  const store = new FileTraceStore({ rootDir: mkdtempSync(join(tmpdir(), 'skazanie-trace-filter-')) })
  store.save({
    turn_id: 'turn-mechanics', campaign_id: 'ROOM-FILTER', created_at: '2026-07-29T20:00:01.000Z',
    events: [{ event_type: 'DamageApplied' }], narration_result: { narration: 'Урон.' },
  })
  store.save({
    turn_id: 'turn-question', campaign_id: 'ROOM-FILTER', created_at: '2026-07-29T20:00:02.000Z',
    events: [], narration_result: { narration: 'Ответ.', verification: { response_plan: { mode: 'table_talk' } } },
  })

  assert.equal(store.latest('ROOM-FILTER').turn_id, 'turn-question')
  assert.equal(store.latest('ROOM-FILTER', { predicate: isMechanicalTrace }).turn_id, 'turn-mechanics')
})

test('объяснение хода проецирует private knowledge для конкретного героя', () => {
  const trace = {
    turn_id: 'private-turn',
    engine_mode: 'enforce',
    retrieved_rule_ids: [],
    validated_commands: [],
    rolls: [],
    events: [
      { event_type: 'KnowledgeRevealed', visibility: 'specific_player', target_ids: ['hero'], payload: { fact_id: 'fact:secret', summary: 'hidden route' } },
      { event_type: 'QuestClockAdvanced', visibility: 'party', payload: { quest_id: 'quest:open' } },
    ],
  }
  const hero = buildTurnExplanation(trace, { playerId: 'hero', isPartyMember: true, role: 'player' })
  const rogue = buildTurnExplanation(trace, { playerId: 'rogue', isPartyMember: true, role: 'player' })

  assert.match(JSON.stringify(hero), /hidden route/u)
  assert.doesNotMatch(JSON.stringify(rogue), /hidden route|fact:secret/u)
  assert.match(JSON.stringify(rogue), /quest:open/u)
})

// Аудит PR #131, SEC-03: восстановленная трасса — запасная. Она не затирает
// полную трассу исходного хода, а та, записанная позже, затирает её.
test('saveIfAbsent не перезаписывает существующую трассу', () => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-trace-absent-'))
  try {
    const store = new FileTraceStore({ rootDir: root })
    const first = store.saveIfAbsent({ turn_id: 'turn-1', campaign_id: 'ROOM-ABSENT', events: [{ event_type: 'DamageApplied' }], recovery: { reason: 'trace_missing_after_commit' } })
    assert.equal(first.created, true)
    assert.equal(store.get('ROOM-ABSENT', 'turn-1').recovery.reason, 'trace_missing_after_commit')
    const second = store.saveIfAbsent({ turn_id: 'turn-1', campaign_id: 'ROOM-ABSENT', events: [] })
    assert.equal(second.created, false)
    assert.equal(store.get('ROOM-ABSENT', 'turn-1').events.length, 1, 'существующая трасса осталась прежней')
    store.save({ turn_id: 'turn-1', campaign_id: 'ROOM-ABSENT', events: [{ event_type: 'DamageApplied' }], narration_result: { narration: 'Полная трасса.' } })
    assert.equal(store.get('ROOM-ABSENT', 'turn-1').recovery, undefined, 'полная трасса исходного хода вытесняет запасную')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Аудит PR #131, SEC-03: commit хода прошёл, запись трассы упала. Раньше
// повтор с тем же ключом читался как дубликат и трассу не писал — `/why` по
// этому ходу оставался пустым навсегда. События при этом не терялись.
test('повтор хода восстанавливает трассу, потерянную после commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-trace-recovery-'))
  try {
    const campaignId = 'TRACE-RECOVERY'
    const initial = normalizeCampaignState({
      sessionCode: campaignId, activePlayerId: 'hero',
      scene: { title: 'Зал', cells: [] },
      players: [
        { id: 'hero', character: 'Ада', hp: 10, maxHp: 10, armor: 14, abilities: { str: 14 }, inventory: [] },
        { id: 'goblin', character: 'Гоблин', hp: 8, maxHp: 8, armor: 12, abilities: { dex: 12 }, inventory: [] },
      ],
    })
    const eventStore = new FileEventStore({ rootDir: join(root, 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState })
    const actualTraceStore = new FileTraceStore({ rootDir: join(root, 'traces') })
    let failNextSave = true
    const traceStore = {
      save(input) {
        if (failNextSave) { failNextSave = false; throw new Error('сбой записи трассы после commit') }
        return actualTraceStore.save(input)
      },
      saveIfAbsent: (input) => actualTraceStore.saveIfAbsent(input),
      get: (...args) => actualTraceStore.get(...args),
      latest: (...args) => actualTraceStore.latest(...args),
      recent: (...args) => actualTraceStore.recent(...args),
    }
    const orchestrator = new GameOrchestrator({
      eventStore,
      rulesEngine: new RulesEngine({ diceService: new DiceService() }),
      traceStore,
      unknownActionHandler: {},
    })
    await eventStore.initializeCampaign({ campaign_id: campaignId, initial_state: initial })
    const input = {
      state: initial, campaignId, playerId: 'hero', message: 'Системная команда', idempotencyKey: 'trace-recovery',
      commands: [{ command_type: 'ApplyDamage', actor_id: 'hero', target_id: 'goblin', amount: 2, damage_type: 'slashing' }],
    }

    await assert.rejects(orchestrator.handle(input), /сбой записи трассы после commit/u)
    const committed = await eventStore.getByIdempotencyKey(campaignId, 'trace-recovery')
    assert.ok(committed, 'событие пережило сбой записи трассы')

    const replay = await orchestrator.handle(input)
    assert.equal(replay.idempotent_replay, true)
    const trace = actualTraceStore.get(campaignId, replay.turn_id)
    assert.ok(trace, 'повтор восстановил трассу')
    assert.equal(trace.recovery.reason, 'trace_missing_after_commit')
    assert.equal(trace.request_fingerprint, null, 'отпечаток исходного запроса не выдумывается')
    assert.equal(trace.idempotency_key, 'trace-recovery')
    assert.deepEqual(trace.events.map((event) => event.event_id), committed.events.map((event) => event.event_id))
    assert.equal(trace.state_version_before, 0)
    assert.equal(trace.state_version_after, 1)
    assert.equal(trace.created_at, committed.events.at(-1).created_at, 'время трассы — время commit, а не повтора')

    const explanation = orchestrator.explanation(campaignId, replay.turn_id)
    assert.equal(explanation.turn_id, replay.turn_id)
    assert.ok(explanation.events.some((event) => event.event_type === 'DamageApplied'), JSON.stringify(explanation.events))
    assert.equal(explanation.recovery.reason, 'trace_missing_after_commit')

    // Следующий повтор трассу не переписывает, а журнал не растёт.
    const again = await orchestrator.handle(input)
    assert.equal(again.idempotent_replay, true)
    assert.equal(actualTraceStore.get(campaignId, replay.turn_id).recovery.recovered_at, trace.recovery.recovered_at)
    assert.equal((await eventStore.load(campaignId)).state_version, 1, 'восстановление трассы не создаёт событий')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

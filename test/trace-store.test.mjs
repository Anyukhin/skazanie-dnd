import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FileTraceStore, buildTurnExplanation, redactTrace } from '../server/trace-store.mjs'

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

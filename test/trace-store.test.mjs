import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FileTraceStore, buildTurnExplanation, compareShadowResults, redactTrace } from '../server/trace-store.mjs'

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

test('shadow comparison делает расхождения видимыми, но не объявляет их ошибкой', () => {
  const comparison = compareShadowResults({ effects: { roll: { total: 10 }, reveal: [], grantItems: [] } }, { rolls: [{ total: 12 }], events: [] })
  assert.equal(comparison.severity, 'warning')
  assert.equal(comparison.differences[0].field, 'roll.total')
})

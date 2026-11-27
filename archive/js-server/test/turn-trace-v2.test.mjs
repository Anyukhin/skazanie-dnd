import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TURN_TRACE_SCHEMA_VERSION,
  buildTurnExplanation,
  migrateTraceToV2,
} from '../server/trace-store.mjs'

/**
 * Шаг 8 плана `docs/agent-architecture-plan.md`: `turn-trace/v2` и сквозной
 * `proposal_id`.
 *
 * Смысл версии — чтобы `/why` мог точно разделить, что предложила модель, что
 * изменил сервер и что сохранилось. Сохранённые трассы при этом **не
 * переписываются**: миграция происходит на чтении, иначе пришлось бы трогать
 * историю кампаний ради формата.
 */

const v1Trace = Object.freeze({
  turn_id: 'turn-1',
  campaign_id: 'OLD',
  engine_mode: 'enforce',
  retrieved_rule_ids: ['srd_5_2_1:combat/attack'],
  validated_commands: [{ command_type: 'MakeAttack' }],
  rolls: [{ expression: '1d20', total: 17 }],
  events: [{ event_type: 'AttackResolved' }],
  state_version_before: 4,
  state_version_after: 5,
  verification_result: { valid: true },
})

test('версия схемы объявлена и совпадает с той, что пишет оркестратор', () => {
  assert.equal(TURN_TRACE_SCHEMA_VERSION, 'turn-trace/v2')
})

test('старая трасса читается как v2, но файл не переписывается', () => {
  const migrated = migrateTraceToV2(v1Trace)
  assert.equal(migrated.schema_version, 'turn-trace/v2')
  assert.equal(migrated.migrated_from, 'turn-trace/v1')
  assert.deepEqual(v1Trace.schema_version, undefined, 'исходная запись обязана остаться нетронутой')
  assert.deepEqual(migrated.events, v1Trace.events)
})

test('у старой трассы proposal_id честно отсутствует, а не выдумывается', () => {
  const migrated = migrateTraceToV2(v1Trace)
  assert.equal(migrated.proposal_id, null,
    '`/why` обязано отличать «предложение неизвестно» от «предложения не было»')
  const explanation = buildTurnExplanation(v1Trace)
  assert.equal(explanation.proposal_id, null)
  assert.equal(explanation.schema_version, 'turn-trace/v2')
})

test('объяснение хода сохраняет прежние поля — старые кампании не ломаются', () => {
  const explanation = buildTurnExplanation(v1Trace)
  assert.equal(explanation.turn_id, 'turn-1')
  assert.equal(explanation.engine_mode, 'enforce')
  assert.deepEqual(explanation.rules_used, ['srd_5_2_1:combat/attack'])
  assert.deepEqual(explanation.commands, [{ command_type: 'MakeAttack' }])
  assert.deepEqual(explanation.rolls, [{ expression: '1d20', total: 17 }])
  assert.equal(explanation.state_version_before, 4)
  assert.equal(explanation.state_version_after, 5)
  assert.deepEqual(explanation.verification, { valid: true })
})

test('трасса v2 проходит без повторной миграции', () => {
  const v2 = { ...v1Trace, schema_version: 'turn-trace/v2', proposal_id: 'proposal:abc' }
  const migrated = migrateTraceToV2(v2)
  assert.equal(migrated, v2, 'уже актуальная запись возвращается как есть')
  assert.equal(buildTurnExplanation(v2).proposal_id, 'proposal:abc')
})

test('пустая трасса не превращается в объект', () => {
  assert.equal(migrateTraceToV2(null), null)
  assert.equal(buildTurnExplanation(null), null)
})

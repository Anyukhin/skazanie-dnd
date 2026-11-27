import assert from 'node:assert/strict'
import test from 'node:test'
import { budgetCriterion, playthroughUsage } from '../eval/playthrough-usage.mjs'

const rejected = { requests: 61, completed_requests: 0, failed_requests: 60, committed_tokens: 0, input_tokens: 0, output_tokens: 0, provider_cost: 0 }
test('при отказе провайдера и одной открытой резервации бюджет вечера неизвестен', () => {
  const usage = playthroughUsage(rejected, 25)
  assert.equal(usage.cost_rub, null)
  assert.equal(usage.per_evening_rub, null)
  const result = budgetCriterion(true, usage)
  assert.equal(result.score, null)
  assert.match(result.detail, /успешно 0, ошибок 60/u)
})

test('цену берём из usage, даже когда известны токены обоих типов', () => {
  const report = { ...rejected, requests: 1, completed_requests: 1, failed_requests: 0, committed_tokens: 100, input_tokens: 80, output_tokens: 20 }
  assert.equal(playthroughUsage(report, 1).cost_rub, null)
  const priced = playthroughUsage({ ...report, provider_cost: .12, confirmed_cost_requests: 1 }, 2)
  assert.equal(priced.cost_rub, .12)
  assert.equal(priced.per_evening_rub, 9)
  assert.equal(budgetCriterion(true, priced).score, 10)
})

test('расход на отбракованный ответ учитывается даже когда прогноз делать рано', () => {
  const usage = playthroughUsage({ ...rejected, provider_cost: .35, confirmed_cost_requests: 1, unknown_cost_requests: 60, interrupted_requests: 1 }, 4)
  assert.equal(usage.cost_rub, .35)
  assert.equal(usage.per_evening_rub, null)
  assert.equal(usage.unknown_cost_requests, 60)
  assert.equal(usage.interrupted_requests, 1)
  assert.equal(budgetCriterion(false, null).score, null)
})

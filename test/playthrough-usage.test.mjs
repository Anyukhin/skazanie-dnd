import assert from 'node:assert/strict'
import test from 'node:test'
import { budgetCriterion, playthroughUsage } from '../eval/playthrough-usage.mjs'

const rejected = { requests: 61, completed_requests: 0, failed_requests: 60, committed_tokens: 0, input_tokens: 0, output_tokens: 0, provider_cost: 0 }
test('при отказе провайдера и одной открытой резервации бюджет вечера неизвестен', () => {
  const usage = playthroughUsage(rejected, 25, 'local', null)
  assert.equal(usage.cost_rub, null)
  assert.equal(usage.per_evening_rub, null)
  const result = budgetCriterion(true, usage)
  assert.equal(result.score, null)
  assert.match(result.detail, /успешно 0, ошибок 60/u)
})

test('ответ с токенами, но без цены или тарифа не получает нулевую цену', () => {
  const report = { ...rejected, requests: 1, completed_requests: 1, failed_requests: 0, committed_tokens: 100, input_tokens: 80, output_tokens: 20 }
  assert.equal(playthroughUsage(report, 1, '', null).cost_rub, null)
  const priced = playthroughUsage(report, 2, 'stand-model', { prompt: .001, completion: .002 })
  assert.equal(priced.cost_rub, .12)
  assert.equal(priced.per_evening_rub, 9)
  assert.equal(budgetCriterion(true, priced).score, 10)
})

test('расход на отбракованный ответ учитывается даже когда прогноз делать рано', () => {
  const usage = playthroughUsage({ ...rejected, provider_cost: .35 }, 4, 'stand-model', null)
  assert.equal(usage.cost_rub, .35)
  assert.equal(usage.per_evening_rub, null)
  assert.equal(budgetCriterion(false, null).score, null)
})

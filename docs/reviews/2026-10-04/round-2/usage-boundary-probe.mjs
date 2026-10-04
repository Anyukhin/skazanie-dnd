import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RouterAIClient } from '../../../../server/llm-client.mjs'
import { DurableUsageLedger, MeteredLLMClient } from '../../../../server/usage-ledger.mjs'

// Архивная проба второго прохода. Ответы поставщика синтетические, fetch
// заменён целиком; рабочие .env и storage не используются.
const root = mkdtempSync(join(tmpdir(), 'skazanie-usage-boundary-'))
const now = () => Date.parse('2026-10-04T12:00:00Z')
const input = { messages: [{ role: 'user', content: 'Проба' }], maxTokens: 40, json: true }

function fixture(name, content) {
  let calls = 0
  const ledger = new DurableUsageLedger({
    storageFile: join(root, `${name}.json`), dailyTokenLimit: 200, now,
  })
  const provider = new RouterAIClient({
    apiKey: 'local-probe-not-a-secret', baseUrl: 'https://provider.invalid/v1', model: 'probe',
    fetchImpl: async () => {
      calls++
      return new Response(JSON.stringify({
        model: 'probe', choices: [{ message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100, cost: 0.25 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  return { ledger, client: new MeteredLLMClient({ client: provider, ledger }), calls: () => calls }
}

try {
  const rejected = fixture('rejected', 'это не JSON')
  for (let index = 0; index < 3; index++) {
    await assert.rejects(rejected.client.completeJson(input), { code: 'LLM_JSON_INVALID' })
  }
  const invalidReport = rejected.ledger.report()
  assert.equal(rejected.calls(), 3)
  assert.equal(invalidReport.failed_requests, 3)
  assert.equal(invalidReport.committed_tokens, 0)
  assert.equal(invalidReport.reserved_tokens, 0)
  assert.equal(invalidReport.provider_cost, 0)

  const duplicated = fixture('duplicated', '{"ok":true}')
  const options = { usageRequestId: 'same-attempt-id' }
  await duplicated.client.completeJson(input, options)
  await duplicated.client.completeJson(input, options)
  const duplicateReport = duplicated.ledger.report()
  assert.equal(duplicated.calls(), 2)
  assert.equal(duplicateReport.completed_requests, 1)
  assert.equal(duplicateReport.committed_tokens, 100)
  assert.equal(duplicateReport.provider_cost, 0.25)

  // Контроль: при разных ID два обычных успешных вызова учитываются оба.
  const control = fixture('control', '{"ok":true}')
  await control.client.completeJson(input, { usageRequestId: 'attempt-one' })
  await control.client.completeJson(input, { usageRequestId: 'attempt-two' })
  const controlReport = control.ledger.report()
  assert.equal(control.calls(), 2)
  assert.equal(controlReport.completed_requests, 2)
  assert.equal(controlReport.committed_tokens, 200)

  console.log(JSON.stringify({
    rejected_response: {
      provider_calls: rejected.calls(), supplied_usage_tokens: 300,
      ledger_tokens: invalidReport.committed_tokens, ledger_cost: invalidReport.provider_cost,
      failed_requests: invalidReport.failed_requests, daily_limit: invalidReport.daily_token_limit,
    },
    repeated_request_id: {
      provider_calls: duplicated.calls(), supplied_usage_tokens: 200,
      ledger_tokens: duplicateReport.committed_tokens, ledger_cost: duplicateReport.provider_cost,
      completed_requests: duplicateReport.completed_requests,
    },
    distinct_id_control: { provider_calls: control.calls(), ledger_tokens: controlReport.committed_tokens },
    actual_external_spend: 0,
  }, null, 2))
} finally {
  rmSync(root, { recursive: true, force: true })
}

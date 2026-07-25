import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DurableUsageLedger,
  MeteredLLMClient,
  UsageQuotaExceededError,
} from '../server/usage-ledger.mjs'

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-usage-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let now = Date.parse('2026-07-24T12:00:00.000Z')
  const ledger = new DurableUsageLedger({
    storageFile: join(root, 'usage.json'),
    dailyTokenLimit: 100,
    reservationTtlMs: 1_000,
    now: () => now,
    ...options,
  })
  return { root, ledger, advance: (milliseconds) => { now += milliseconds } }
}

test('durable quota reserves before a call, settles provider usage and survives restart', (t) => {
  const { root, ledger } = fixture(t)
  ledger.reserve({ requestId: 'one', estimatedTokens: 60, scope: 'campaign:a', model: 'test' })
  assert.equal(ledger.report().reserved_tokens, 60)
  ledger.settle('one', { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, cost: 0.004 })
  assert.deepEqual(ledger.report(), {
    day: '2026-07-24',
    daily_token_limit: 100,
    committed_tokens: 20,
    reserved_tokens: 0,
    input_tokens: 12,
    output_tokens: 8,
    provider_cost: 0.004,
    requests: 1,
    completed_requests: 1,
    failed_requests: 0,
  })
  const reopened = new DurableUsageLedger({
    storageFile: join(root, 'usage.json'),
    dailyTokenLimit: 100,
    now: () => Date.parse('2026-07-24T12:01:00.000Z'),
  })
  assert.equal(reopened.report().committed_tokens, 20)
  assert.throws(
    () => reopened.reserve({ requestId: 'two', estimatedTokens: 81 }),
    UsageQuotaExceededError,
  )
})

test('expired and failed reservations release quota without storing prompts', (t) => {
  const { ledger, advance } = fixture(t)
  ledger.reserve({ requestId: 'expired', estimatedTokens: 90, scope: 'campaign:secret', model: 'test' })
  advance(1_001)
  assert.equal(ledger.report().reserved_tokens, 0)
  ledger.reserve({ requestId: 'failed', estimatedTokens: 90 })
  ledger.fail('failed', 'LLM_TIMEOUT')
  assert.equal(ledger.report().failed_requests, 1)
  assert.equal(ledger.report().reserved_tokens, 0)
})

test('metered client rejects over-budget requests before provider invocation', async (t) => {
  const { ledger } = fixture(t)
  let calls = 0
  const provider = {
    model: 'fake',
    maxTokens: 20,
    async complete() {
      calls += 1
      return { content: '{}', usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } }
    },
    health: () => [],
    probe: async () => [],
  }
  const client = new MeteredLLMClient({ client: provider, ledger })
  await client.complete({ messages: [{ role: 'user', content: 'small' }], maxTokens: 20 })
  assert.equal(calls, 1)
  await assert.rejects(
    () => client.complete({ messages: [{ role: 'user', content: 'large' }], maxTokens: 90 }),
    UsageQuotaExceededError,
  )
  assert.equal(calls, 1)
})

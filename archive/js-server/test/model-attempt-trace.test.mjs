import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { currentModelAttempts, runWithModelAttemptCollector } from '../server/campaign-ai-context.mjs'
import { FallbackLLMClient, LLMResponseError } from '../server/llm-client.mjs'
import { FileTraceStore } from '../server/trace-store.mjs'

test('трасса сохраняет безопасную хронологию попыток провайдеров', async (t) => {
  const primary = {
    model: 'baidu/ernie-5.5-flash-preview:free', providerLabel: 'OpenRouter',
    complete: async () => { throw new LLMResponseError('invalid JSON', 'LLM_JSON_INVALID') },
  }
  const reserve = {
    model: 'qwen3:14b', providerLabel: 'Ollama',
    complete: async () => ({ role: 'assistant', content: '{"ok":true}', model: 'qwen3:14b', provider: 'Ollama' }),
  }
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-model-attempt-trace-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const traceStore = new FileTraceStore({ rootDir })
  await runWithModelAttemptCollector(async () => {
    const cascade = new FallbackLLMClient({ clients: [primary], providerFallback: reserve })
    const result = await cascade.complete({ messages: [{ role: 'user', content: 'test' }], role: 'narrator', json: true, jsonSchema: { type: 'object' } })
    assert.equal(result.provider, 'Ollama')
    const attempts = currentModelAttempts()
    assert.equal(attempts.length, 2)
    assert.deepEqual(attempts.map((attempt) => attempt.outcome), ['error', 'success'])
    assert.equal(attempts[0].error_code, 'LLM_JSON_INVALID')
    assert.equal(attempts[1].resolved_model, 'qwen3:14b')
    assert.equal(attempts[1].fallback_reason, 'previous_attempt_failed')
    assert.ok(attempts.every((attempt) => attempt.role === 'narrator' && attempt.schema_requested === true))
    const trace = traceStore.save({ campaign_id: 'MODEL-ATTEMPT-TRACE', turn_id: 'turn-1', model_attempts: attempts })
    assert.deepEqual(trace.model_attempts.map((attempt) => attempt.model), [primary.model, reserve.model])
    assert.doesNotMatch(JSON.stringify(trace), /test|OpenRouter.*https|Bearer|api[_-]?key/iu)
  })
  assert.deepEqual(currentModelAttempts(), [], 'попытки не переходят между ходами')
})

test('трасса видит последнюю модель, если внешний таймер прервал ожидание', async () => {
  const controller = new AbortController()
  const cascade = new FallbackLLMClient({ clients: [{
    model: 'openrouter/free', providerLabel: 'OpenRouter', complete: async () => new Promise(() => {}),
  }] })
  await runWithModelAttemptCollector(async () => {
    const pending = cascade.complete({ role: 'narrator', messages: [] }, { timeoutMs: 60_000, signal: controller.signal })
    try {
      const [attempt] = currentModelAttempts()
      assert.equal(attempt.model, 'openrouter/free')
      assert.equal(attempt.error_code, 'LLM_ATTEMPT_INTERRUPTED')
      assert.ok(Number.isInteger(attempt.duration_ms))
    } finally {
      controller.abort(new Error('внешний таймер'))
      await assert.rejects(pending)
    }
  })
})

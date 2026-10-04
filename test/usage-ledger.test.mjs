import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FallbackLLMClient,
  LLMResponseError,
  RouterAIClient,
} from '../server/llm-client.mjs'
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

// Аудит PR #131, COST-01: настоящий RouterAIClient и настоящий ledger, подменён
// только транспорт. Сети нет: `fetchImpl` отвечает из сценария.
const ACCOUNTING_MESSAGES = [{ role: 'user', content: 'usage check' }]

function scriptedProvider(responses) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    const next = responses.shift()
    if (!next) throw new Error('scripted provider exhausted')
    const status = next.status ?? 200
    return { ok: status < 400, status, text: async () => JSON.stringify(next.body ?? {}) }
  }
  return { fetchImpl, calls }
}

function routerClient(fetchImpl, overrides = {}) {
  return new RouterAIClient({
    apiKey: 'test-key',
    baseUrl: 'http://127.0.0.1:9/api/v1',
    model: 'test/model',
    maxTokens: 50,
    timeoutMs: 1_000,
    fetchImpl,
    ...overrides,
  })
}

function completion(content, usage) {
  return { body: { model: 'test/model', usage, choices: [{ message: { role: 'assistant', content } }] } }
}

test('COST-01: успешный ответ учитывается один раз по usage поставщика', async (t) => {
  const { ledger } = fixture(t, { dailyTokenLimit: 10_000 })
  const provider = scriptedProvider([
    completion('{"ok":true}', { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40, cost: 0.1 }),
  ])
  const client = new MeteredLLMClient({ client: routerClient(provider.fetchImpl), ledger })
  assert.deepEqual(await client.completeJson({ messages: ACCOUNTING_MESSAGES }), { ok: true })
  assert.equal(provider.calls.length, 1)
  const report = ledger.report()
  assert.equal(report.committed_tokens, 40)
  assert.equal(report.input_tokens, 30)
  assert.equal(report.output_tokens, 10)
  assert.equal(report.provider_cost, 0.1)
  assert.equal(report.completed_requests, 1)
  assert.equal(report.failed_requests, 0)
  assert.equal(report.reserved_tokens, 0)
})

test('COST-01: оплаченный ответ с некорректным JSON записывает расход, а ошибка остаётся прежней', async (t) => {
  const { root, ledger } = fixture(t, { dailyTokenLimit: 10_000 })
  const provider = scriptedProvider([completion('{"ok":', { total_tokens: 100, cost: 0.25 })])
  const client = new MeteredLLMClient({ client: routerClient(provider.fetchImpl), ledger })
  await assert.rejects(
    client.completeJson({ messages: ACCOUNTING_MESSAGES }),
    (error) => error instanceof LLMResponseError
      && error.code === 'LLM_JSON_INVALID'
      && /некорректный JSON/u.test(error.message),
  )
  const report = ledger.report()
  assert.equal(report.committed_tokens, 100)
  assert.equal(report.provider_cost, 0.25)
  assert.equal(report.completed_requests, 0)
  assert.equal(report.failed_requests, 1)
  assert.equal(report.reserved_tokens, 0)
  const entry = Object.values(JSON.parse(readFileSync(join(root, 'usage.json'), 'utf8')).requests)[0]
  assert.equal(entry.status, 'failed')
  assert.equal(entry.error_code, 'LLM_JSON_INVALID')
  assert.equal(entry.total_tokens, 100)
  // Расход переживает перезапуск так же, как расход успешного ответа.
  const reopened = new DurableUsageLedger({ storageFile: join(root, 'usage.json'), dailyTokenLimit: 10_000, now: ledger.now })
  assert.equal(reopened.report().committed_tokens, 100)
})

test('COST-01: известный расход непригодных ответов участвует в следующей проверке квоты', async (t) => {
  // Оценка одного запроса: 41 байт сообщений + 50 токенов ответа = 91.
  const { ledger } = fixture(t, { dailyTokenLimit: 250 })
  const provider = scriptedProvider([
    completion('not json', { total_tokens: 100 }),
    completion('not json', { total_tokens: 100 }),
    completion('not json', { total_tokens: 100 }),
  ])
  const client = new MeteredLLMClient({ client: routerClient(provider.fetchImpl), ledger })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(client.completeJson({ messages: ACCOUNTING_MESSAGES }), (error) => error.code === 'LLM_JSON_INVALID')
  }
  // 200 потрачено + 91 в резерв > 250: третий запрос до поставщика не доходит.
  await assert.rejects(client.completeJson({ messages: ACCOUNTING_MESSAGES }), UsageQuotaExceededError)
  assert.equal(provider.calls.length, 2)
  assert.equal(ledger.report().committed_tokens, 200)
})

test('COST-01: отказ до отправки и сбой без разобранного ответа ничего не списывают', async (t) => {
  const { ledger } = fixture(t, { dailyTokenLimit: 10_000 })
  const provider = scriptedProvider([{ status: 503, body: { error: 'unavailable' } }])
  // Без ключа запрос не уходит вовсе.
  const unconfigured = new MeteredLLMClient({ client: routerClient(provider.fetchImpl, { apiKey: '' }), ledger })
  await assert.rejects(unconfigured.completeJson({ messages: ACCOUNTING_MESSAGES }), (error) => error.code === 'LLM_NOT_CONFIGURED')
  assert.equal(provider.calls.length, 0)
  // HTTP-ошибка: тело не разбирается, расход неизвестен и не придумывается.
  const failing = new MeteredLLMClient({ client: routerClient(provider.fetchImpl), ledger })
  await assert.rejects(failing.completeJson({ messages: ACCOUNTING_MESSAGES }), (error) => error.code === 'LLM_PROVIDER_ERROR')
  assert.equal(provider.calls.length, 1)
  const report = ledger.report()
  assert.equal(report.committed_tokens, 0)
  assert.equal(report.provider_cost, 0)
  assert.equal(report.failed_requests, 2)
  assert.equal(report.reserved_tokens, 0)
})

test('COST-01: каскад моделей сохраняет расход каждой попытки', async (t) => {
  const { ledger } = fixture(t, { dailyTokenLimit: 10_000 })
  const first = scriptedProvider([completion('not json', { total_tokens: 70 })])
  const second = scriptedProvider([completion('{"ok":true}', { total_tokens: 30 })])
  const cascade = new FallbackLLMClient({
    clients: [
      new MeteredLLMClient({ client: routerClient(first.fetchImpl, { model: 'test/first' }), ledger }),
      new MeteredLLMClient({ client: routerClient(second.fetchImpl, { model: 'test/second' }), ledger }),
    ],
  })
  const result = await cascade.complete({ messages: ACCOUNTING_MESSAGES, json: true })
  assert.deepEqual(result.json, { ok: true })
  assert.equal(result.fallback_used, true)
  const report = ledger.report()
  assert.equal(report.committed_tokens, 100)
  assert.equal(report.completed_requests, 1)
  assert.equal(report.failed_requests, 1)
})

// Аудит PR #131, AI-02: сторож проводки. Каждый текстовый клиент поставщика в
// server/index.mjs создаётся внутри MeteredLLMClient — летописец больше не
// получает голый RouterAIClient, — а картинки идут через общий проверяющий
// генератор, без собственного fetch к поставщику.
test('AI-02: server/index.mjs не держит неучтённых путей к поставщику', () => {
  const source = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8')
  const providerClients = source.match(/new RouterAIClient\(/gu) ?? []
  const meteredClients = source.match(/new MeteredLLMClient\(\{\s*client: new RouterAIClient\(/gu) ?? []
  assert.ok(providerClients.length >= 2, 'поиск потерял текстовые клиенты: каскад и летописец')
  assert.equal(meteredClients.length, providerClients.length, 'каждый RouterAIClient обязан быть обёрнут в MeteredLLMClient')
  assert.doesNotMatch(source, /new LoreAuthor\(\{\s*llmClient:[^\n]*new RouterAIClient/u)
  assert.doesNotMatch(source, /fetch\(`\$\{baseUrl\}/u, 'прямой fetch к поставщику в обход image-generation и ledger')
})

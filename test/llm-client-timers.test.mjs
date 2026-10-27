// Сроки каскада моделей: лимит модели за обёрткой учёта, поздние дельты
// снятой попытки и срок больше, чем умеет таймер Node
// (docs/rust-port-js-findings.md, P1 `llm-client`). Сеть не нужна: клиенты —
// заглушки, у RouterAIClient подменён fetch.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { FakeLLM, FallbackLLMClient, RouterAIClient } from '../server/llm-client.mjs'
import { DurableUsageLedger, MeteredLLMClient } from '../server/usage-ledger.mjs'

const MESSAGES = [{ role: 'user', content: 'проверка сроков' }]
const BEYOND_NODE_TIMER_MS = 2 ** 31

function ledgerFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-llm-timers-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return new DurableUsageLedger({ storageFile: join(root, 'usage.json'), dailyTokenLimit: 100_000 })
}

/** fetch, который отвечает только отменой своего сигнала. */
function hangingFetch() {
  return (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  })
}

function answeringFetch(content, delayMs = 0) {
  return async () => {
    if (delayMs) await sleep(delayMs)
    const body = { model: 'test/reserve', usage: { total_tokens: 9 }, choices: [{ message: { role: 'assistant', content } }] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
}

function router(model, timeoutMs, fetchImpl) {
  return new RouterAIClient({ apiKey: 'test-key', baseUrl: 'http://127.0.0.1:9/api/v1', model, maxTokens: 50, timeoutMs, fetchImpl })
}

test('каскад снимает основную модель по её лимиту и за обёрткой учёта расхода', async (t) => {
  const ledger = ledgerFixture(t)
  const primary = new MeteredLLMClient({ client: router('test/primary', 40, hangingFetch()), ledger })
  const reserve = new MeteredLLMClient({ client: router('test/reserve', 5_000, answeringFetch('резерв')), ledger })
  // Каскад читает лимит модели из `client.timeoutMs`; обёртка учёта его прятала.
  assert.equal(primary.timeoutMs, 40, 'обёртка учёта показывает лимит модели')
  assert.equal(reserve.timeoutMs, 5_000)
  const cascade = new FallbackLLMClient({ clients: [primary, reserve] })
  const started = Date.now()
  const result = await cascade.complete({ messages: MESSAGES })
  const elapsed = Date.now() - started
  assert.equal(result.content, 'резерв')
  assert.deepEqual(result.fallback_attempts, [{ model: 'test/primary', code: 'LLM_TIMEOUT' }])
  assert.ok(elapsed < 2_000, `основная снята по своему лимиту: ${elapsed} мс`)
  const report = ledger.report()
  assert.equal(report.completed_requests, 1)
  assert.equal(report.failed_requests, 1)
  assert.equal(report.reserved_tokens, 0)

  // Явный срок вызова больше лимита модели — длинный разовый вызов (568af070):
  // за обёрткой он так же не обрезается лимитом, а ждёт свои 60 % срока.
  const slowPrimary = new MeteredLLMClient({ client: router('test/slow', 20, answeringFetch('мир', 60)), ledger })
  const long = new FallbackLLMClient({ clients: [slowPrimary, reserve] })
  assert.equal((await long.complete({ messages: MESSAGES }, { timeoutMs: 400 })).content, 'мир')
})

test('дельта снятой по сроку попытки не попадает в живой поток, а её сигнал отменён', async () => {
  const deltas = []
  let lateSignalAborted = null
  let lateDeltaSent = null
  const slow = {
    model: 'test/slow',
    timeoutMs: 20,
    async complete(_input, options) {
      // Модель, которая сигнал не слушает: проигравшая гонку попытка
      // продолжает работать и пишет в поток уже после переключения.
      await sleep(150)
      lateSignalAborted = options.signal?.aborted ?? null
      await options.onDelta('поздний текст основной модели')
      lateDeltaSent = true
      return { role: 'assistant', content: 'поздний текст основной модели', tool_calls: [], model: 'test/slow' }
    },
  }
  const reserve = {
    model: 'test/reserve',
    async complete(_input, options) {
      await options.onDelta('ответ резервной')
      return { role: 'assistant', content: 'ответ резервной', tool_calls: [], model: 'test/reserve' }
    },
  }
  const cascade = new FallbackLLMClient({ clients: [slow, reserve] })
  const result = await cascade.complete({ messages: MESSAGES, timeoutMs: 100, onDelta: (delta) => deltas.push(delta) })
  assert.equal(result.content, 'ответ резервной')
  await sleep(250)
  assert.equal(lateDeltaSent, true, 'основная модель дошла до поздней дельты')
  assert.equal(lateSignalAborted, true, 'сигнал снятой попытки отменён')
  assert.deepEqual(deltas, ['ответ резервной'])
})

test('срок больше 2^31−1 мс не превращается в таймер на 1 мс', async () => {
  const fake = new FakeLLM({ responses: ['ответ без спешки'], delayMs: 30 })
  const direct = await fake.complete({ messages: MESSAGES, timeoutMs: BEYOND_NODE_TIMER_MS })
  assert.equal(direct.content, 'ответ без спешки')

  const routed = router('test/long', BEYOND_NODE_TIMER_MS, answeringFetch('ответ поставщика', 30))
  assert.equal((await routed.complete({ messages: MESSAGES })).content, 'ответ поставщика')

  const cascade = new FallbackLLMClient({ clients: [new FakeLLM({ responses: ['ответ каскада'], delayMs: 30 })] })
  const cascaded = await cascade.complete({ messages: MESSAGES, timeoutMs: BEYOND_NODE_TIMER_MS + 5 })
  assert.equal(cascaded.content, 'ответ каскада')
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FallbackLLMClient,
  LLMResponseError,
  LLMTimeoutError,
  RouterAIClient,
  parseRouterAIEventStream,
} from '../server/llm-client.mjs'

function chunkedBody(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

test('RouterAI SSE parser joins split frames, emits raw deltas and keeps usage before DONE', async () => {
  const source = [
    sse({ model: 'stream-model', choices: [{ delta: { content: 'Первая ' } }] }),
    sse({ choices: [{ delta: { content: 'фраза.' } }] }),
    sse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } }),
    'data: [DONE]\n\n',
  ].join('')
  const chunks = [source.slice(0, 7), source.slice(7, 43), source.slice(43, 89), source.slice(89)]
  const deltas = []

  const result = await parseRouterAIEventStream(chunkedBody(chunks), {
    onDelta: (delta) => deltas.push(delta),
  })

  assert.equal(result.content, 'Первая фраза.')
  assert.deepEqual(deltas, ['Первая ', 'фраза.'])
  assert.equal(result.model, 'stream-model')
  assert.deepEqual(result.usage, { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 })
  assert.equal(result.done, true)
})

test('RouterAI SSE parser rejects malformed and incomplete streams', async () => {
  await assert.rejects(
    parseRouterAIEventStream(chunkedBody(['data: {"choices":\n\n', 'data: [DONE]\n\n'])),
    (error) => error instanceof LLMResponseError && error.code === 'LLM_JSON_INVALID',
  )
  await assert.rejects(
    parseRouterAIEventStream(chunkedBody([
      sse({ choices: [{ delta: { content: 'Обрезанный ответ.' } }] }),
    ])),
    (error) => error instanceof LLMResponseError && error.code === 'LLM_STREAM_INCOMPLETE',
  )
})

test('RouterAI SSE parser enforces per-event and total response bounds', async () => {
  await assert.rejects(
    parseRouterAIEventStream(chunkedBody([
      sse({ choices: [{ delta: { content: 'x'.repeat(200) } }] }),
      'data: [DONE]\n\n',
    ]), { maxEventBytes: 64, maxResponseBytes: 1_000 }),
    (error) => error instanceof LLMResponseError && error.code === 'LLM_RESPONSE_TOO_LARGE',
  )
  await assert.rejects(
    parseRouterAIEventStream(chunkedBody([
      sse({ choices: [{ delta: { content: 'x'.repeat(80) } }] }),
      'data: [DONE]\n\n',
    ]), { maxEventBytes: 512, maxResponseBytes: 100 }),
    (error) => error instanceof LLMResponseError && error.code === 'LLM_RESPONSE_TOO_LARGE',
  )
})

test('RouterAIClient requests streaming only when onDelta is supplied and preserves non-stream calls', async () => {
  const requests = []
  const streamClient = new RouterAIClient({
    apiKey: 'test-key',
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body))
      return {
        ok: true,
        status: 200,
        body: chunkedBody([
          sse({ model: 'stream-model', choices: [{ delta: { content: 'Готово.' } }] }),
          sse({ choices: [], usage: { total_tokens: 3 } }),
          'data: [DONE]\n\n',
        ]),
      }
    },
  })
  const deltas = []
  const streamed = await streamClient.complete({
    messages: [{ role: 'user', content: 'test' }],
    onDelta: (delta) => deltas.push(delta),
  })
  assert.equal(requests[0].stream, true)
  assert.deepEqual(requests[0].stream_options, { include_usage: true })
  assert.equal(streamed.content, 'Готово.')
  assert.deepEqual(streamed.usage, { total_tokens: 3 })
  assert.deepEqual(deltas, ['Готово.'])

  const plainClient = new RouterAIClient({
    apiKey: 'test-key',
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body))
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          model: 'plain-model',
          choices: [{ message: { role: 'assistant', content: 'Обычный ответ.' } }],
          usage: { total_tokens: 2 },
        }),
      }
    },
  })
  const plain = await plainClient.complete({ messages: [{ role: 'user', content: 'test' }] })
  assert.equal(requests[1].stream, undefined)
  assert.equal(plain.content, 'Обычный ответ.')
})

test('fallback switches provider only before the first delivered delta', async () => {
  const calls = []
  const deltas = []
  const primaryBeforeDelta = {
    model: 'primary-before',
    async complete() {
      calls.push('primary-before')
      throw new LLMTimeoutError(10)
    },
  }
  const secondary = {
    model: 'secondary',
    async complete(_input, options) {
      calls.push('secondary')
      await options.onDelta('Цельный ответ.')
      return { role: 'assistant', content: 'Цельный ответ.', tool_calls: [], model: 'secondary' }
    },
  }
  const before = new FallbackLLMClient({ clients: [primaryBeforeDelta, secondary] })
  const recovered = await before.complete({
    messages: [{ role: 'user', content: 'test' }],
    onDelta: (delta) => deltas.push(delta),
  })
  assert.equal(recovered.content, 'Цельный ответ.')
  assert.deepEqual(calls, ['primary-before', 'secondary'])
  assert.deepEqual(deltas, ['Цельный ответ.'])

  let secondaryCalls = 0
  const primaryAfterDelta = {
    model: 'primary-after',
    async complete(_input, options) {
      await options.onDelta('Начало первого провайдера.')
      throw new LLMTimeoutError(10)
    },
  }
  const forbiddenSecondary = {
    model: 'forbidden-secondary',
    async complete() {
      secondaryCalls += 1
      return { role: 'assistant', content: 'Другой ответ.', tool_calls: [], model: 'forbidden-secondary' }
    },
  }
  const after = new FallbackLLMClient({ clients: [primaryAfterDelta, forbiddenSecondary] })
  const delivered = []
  await assert.rejects(
    after.complete({
      messages: [{ role: 'user', content: 'test' }],
      onDelta: (delta) => delivered.push(delta),
    }),
    LLMTimeoutError,
  )
  assert.deepEqual(delivered, ['Начало первого провайдера.'])
  assert.equal(secondaryCalls, 0)
})

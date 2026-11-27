// Две детерминированные проверки без сети: текущий вызов и передача бюджета каскаду.
import assert from 'node:assert/strict'
import { Narrator } from '../server/narrator.mjs'
import { FallbackLLMClient } from '../server/llm-client.mjs'
import { buildNarrationBrief } from '../server/security.mjs'

async function check(forwardTimeout) {
  let fallbackCalls = 0
  const timeoutMs = 120
  const chain = new FallbackLLMClient({ clients: [
    { model: 'slow', timeoutMs: 200, complete: ({ signal }) => new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }) },
    { model: 'fast', timeoutMs: 200, complete: async () => {
      fallbackCalls += 1
      return { content: 'Пока ничего не меняется.' }
    } },
  ] })
  const client = forwardTimeout ? { complete: request => chain.complete({ ...request, timeoutMs }) } : chain
  const result = await new Narrator({ llmClient: client }).render(
    buildNarrationBrief({ known_environment: { location: 'Зал' } }), { timeoutMs },
  )
  return { forward_timeout: forwardTimeout, fallback_calls: fallbackCalls,
    provider: result.provider, error: result.verification.provider_error ?? null }
}
const current = await check(false)
const proposed = await check(true)
assert.equal(proposed.fallback_calls, 1, 'Переданный бюджет должен оставить время быстрой резервной модели')
assert.equal(proposed.error, null)
console.log(JSON.stringify({ network_calls: 0, current, proposed }, null, 2))

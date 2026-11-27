import assert from 'node:assert/strict'
import test from 'node:test'
import { startAstohanBudgetRouter } from '../eval/astohan-model-budget.mjs'
import { judgeAstohanNarration } from '../eval/astohan-model-review.mjs'
import { chatCompletion, startFakeProvider } from './kit/llm.mjs'

const scenario = 'test/game'
const judgeModel = 'test/reviewer'
const endpoint = {
  tag: 'verified', max_prompt_tokens: 1000, max_completion_tokens: 1000,
  supported_parameters: ['max_tokens'],
  pricing: { prompt: .011, completion: 0 }, pricing_units: { prompt: 'token', completion: 'token' },
}
const sample = [{ action: 'Сверяю карту', text: 'Герой различает выход.' }]
const verdict = { relevance: 5, concreteness: 4, consequence: 3, style: 4, voice: 3, consistency: 5, issue: '', contradiction: '' }

function call(router, model = scenario, options = {}, signal) {
  return fetch(router.baseUrl + '/chat/completions', {
    method: 'POST', signal, headers: { authorization: 'Bearer ' + router.standKey, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 50, messages: [{ role: 'user', content: 'Проверка' }], ...options }),
  })
}

function catalog(path, endpoints) {
  return { data: { id: path.replace(/^\/models\//u, '').replace(/\/endpoints$/u, ''), endpoints } }
}

test('игровой поток и прямой судья делят резерв при обрыве', async (t) => {
  let upstreamStarted
  let finishGameCall
  const started = new Promise((resolve) => { upstreamStarted = resolve })
  const finish = new Promise((resolve) => { finishGameCall = resolve })
  const provider = await startFakeProvider(t, async ({ path, method, body }, res) => {
    if (method === 'GET') return catalog(path, [endpoint])
    if (body.model === judgeModel) return chatCompletion(verdict, { model: judgeModel, usage: { cost: .75 } })
    upstreamStarted()
    await finish
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: {"choices":[]}\n\ndata: [DONE]\n\n')
  })
  const router = await startAstohanBudgetRouter({ upstream: provider.baseUrl, liveKey: 'never-forwarded-fixture-key' })
  t.after(async () => { finishGameCall(); await router.close() })

  const cancel = new AbortController()
  const game = call(router, scenario, { stream: true, provider: { only: ['ignored'] } }, cancel.signal)
  const disconnected = assert.rejects(game, { name: 'AbortError' })
  await started
  const before = await judgeAstohanNarration(sample, router, judgeModel)
  assert.equal(before.stop_reason, 'STAND_BUDGET_EXCEEDED')
  assert.equal(provider.requests.filter((request) => request.method === 'POST').length, 1)
  cancel.abort()
  await disconnected
  finishGameCall()

  const after = await judgeAstohanNarration(sample, router, judgeModel)
  assert.equal(after.stop_reason, 'STAND_BUDGET_EXCEEDED')
  assert.equal(after.verdicts.length, 0)
  await router.close()
  assert.deepEqual(router.report(), {
    limit_rub: 20, known_rub: 0, unknown_requests: 1, reserved_rub: 11, refused: 2, requests: 1, exceeded_quote: 0,
    unconfirmed_generations: [],
  })
  const sent = provider.requests.find((request) => request.method === 'POST')
  assert.deepEqual(sent.body.provider, { only: ['verified'], order: ['verified'], allow_fallbacks: false })
  assert.deepEqual(sent.body.stream_options, { include_usage: true })
  assert.equal(sent.headers.authorization, 'Bearer skazanie-local-budget-provider')
})

test('подтверждённая цена высвобождает остаток и допускает судью', async (t) => {
  const provider = await startFakeProvider(t, ({ path, method, body }, res) => {
    if (method === 'GET') return catalog(path, [endpoint])
    if (body.model === scenario) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end('data: {"choices":[],"usage":{"cost":0.25}}\n\ndata: [DONE]\n\n')
      return
    }
    return chatCompletion(verdict, { model: judgeModel, usage: { cost: .75 } })
  })
  const router = await startAstohanBudgetRouter({ upstream: provider.baseUrl })
  t.after(() => router.close())
  assert.match(await (await call(router, scenario, { stream: true })).text(), /\[DONE\]/u)
  const judged = await judgeAstohanNarration(sample, router, judgeModel)
  assert.equal(judged.average, 4)
  assert.equal(judged.consistency_average, 5)
  assert.equal(router.report().known_rub, 1)
  assert.equal(router.report().unknown_requests, 0)
  assert.equal(router.report().reserved_rub, 0)
})

test('общий tag нельзя использовать, если один из его тарифов неизвестен', async (t) => {
  const provider = await startFakeProvider(t, ({ path, method }) => {
    if (method !== 'GET') throw new Error('неограниченный запрос отправлен')
    return catalog(path, [endpoint, { ...endpoint, pricing_units: { prompt: 'request', completion: 'token' } }])
  })
  const router = await startAstohanBudgetRouter({ upstream: provider.baseUrl })
  t.after(() => router.close())
  const response = await call(router)
  assert.equal(response.status, 429)
  assert.equal((await response.json()).error.code, 'STAND_TARIFF_UNVERIFIED')
  assert.equal((await call(router, scenario, { plugins: [{ id: 'web' }] })).status, 400)
  assert.equal(provider.requests.filter((request) => request.method === 'POST').length, 0)
})

test('сверка ID оборванной генерации учитывает фактическую цену и блокирует превышенный тариф', async (t) => {
  let lookedUp = 0
  const provider = await startFakeProvider(t, ({ path, method }, res) => {
    if (path === '/generation?id=rai-gen-fixture') {
      lookedUp++
      if (lookedUp === 1) return { status: 404, json: {} }
      return { data: { id: 'rai-gen-fixture', total_cost: '11.5' } }
    }
    if (method === 'GET') return catalog(path, [endpoint])
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Generation-Id': 'rai-gen-fixture' })
    res.write('data: {"choices":[]}\n\n')
    res.end()
  })
  const router = await startAstohanBudgetRouter({ upstream: provider.baseUrl })
  t.after(() => router.close())
  await (await call(router, scenario, { stream: true })).text()
  assert.deepEqual(router.report().unconfirmed_generations, ['rai-gen-fixture'])
  await router.close()
  const report = router.report()
  assert.equal(lookedUp, 2)
  assert.equal(report.known_rub, 11.5)
  assert.equal(report.reserved_rub, 0)
  assert.equal(report.unknown_requests, 0)
  assert.equal(report.exceeded_quote, 1)
})

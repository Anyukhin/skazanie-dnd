import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { openRouterFreeModels, RouterAIClient } from '../server/llm-client.mjs'
import { createCampaign, expectStatus, registerUser, setupAdmin, startTestServer } from './kit/http.mjs'
import { chatCompletion, startFakeProvider } from './kit/llm.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const freeModels = ['test/primary:free', 'test/reserve:free']
const localModel = 'qwen-test:14b'
const opening = {
  campaignName: 'Речной архив',
  scene: { title: 'Архив у реки', location: 'Речной архив', objective: 'Встретить смотрителя' },
}
const prologue = 'Луч фонаря дрожит на арке речного архива. Смотритель ждёт под навесом и держит связку ключей. Вода у лестницы поднялась за ночь. Из окна тянет сырой бумагой.'

test('OpenRouter отклоняет платную конфигурацию и сохраняет порядок бесплатных моделей', () => {
  assert.deepEqual(openRouterFreeModels(), ['openrouter/free'])
  assert.deepEqual(openRouterFreeModels(' test/primary:free , test/primary:free,test/reserve:free'), freeModels)
  assert.deepEqual(openRouterFreeModels('openrouter/free,test/paid'), ['openrouter/free'])
  assert.deepEqual(openRouterFreeModels('test/paid,invalid:free'), ['openrouter/free'])
  assert.throws(() => new RouterAIClient({ openRouterFree: true, model: 'test/paid' }), /бесплатной/u)
})

for (const rateLimited of [false, true]) {
  const route = rateLimited ? 'Ollama после лимита OpenRouter' : 'вторая бесплатная модель OpenRouter'
  test(route, { timeout: runnerTimeout(40_000) }, async (t) => {
    const routerAi = await startFakeProvider(t, () => null)
    const cloud = await startFakeProvider(t, (request) => {
      if (request.path !== '/chat/completions') return null
      if (rateLimited || request.body.model === freeModels[0]) {
        return { status: 429, json: { error: { code: 429 } } }
      }
      return chatCompletion(request.body.response_format ? opening : prologue, { model: freeModels[1] })
    })
    const local = await startFakeProvider(t, (request) => chatCompletion(
      request.body.response_format ? opening : prologue, { model: localModel },
    ))
    const cloudModels = rateLimited ? freeModels.slice(0, 1) : freeModels
    const server = await startTestServer(t, {
      storagePrefix: 'skazanie-openrouter-api-',
      env: {
        ...routerAi.env,
        OPENROUTER_API_KEY: 'kit-openrouter-key',
        DND_AI_OPENROUTER_BASE_URL: cloud.baseUrl,
        DND_AI_OPENROUTER_MODELS: cloudModels.join(','),
        DND_AI_MODEL: 'test/paid',
        DND_AI_FALLBACK_MODELS: 'test/other-paid',
        DND_AI_LORE_MODEL: 'test/paid-lore',
        DND_AI_OLLAMA_MODEL: localModel,
        DND_AI_OLLAMA_BASE_URL: local.baseUrl,
      },
    })
    const { client: admin } = await setupAdmin(server)
    const { client: player } = await registerUser(server)
    const health = expectStatus(await player.get('/api/health'))
    assert.equal(health.configured, true)
    assert.equal(health.provider, 'OpenRouter')
    assert.equal(health.model, freeModels[0])
    assert.deepEqual(health.fallbackModels, [...cloudModels.slice(1), localModel])
    assert.equal(cloud.requests.length, 0, 'старт не тратит бесплатную квоту')

    await createCampaign(player, {
      code: 'OPENROUTER-API',
      bootstrap: { slotCount: 2, world: { preset: 'Классическое фэнтези' }, rulesetId: 'dnd_5e_2014' },
    })

    assert.equal(routerAi.requests.length, 0, 'платный текстовый маршрут и стартовые пробы отключены')
    assert.ok(cloud.requests.every(({ body, headers }) => cloudModels.includes(body?.model) && headers.authorization === 'Bearer kit-openrouter-key'))
    assert.equal(cloud.requests[0].body.model, freeModels[0])
    const strictRequest = cloud.requests.find(({ body }) => body?.response_format?.type === 'json_schema')
    assert.deepEqual(strictRequest?.body.provider, { require_parameters: true })
    if (!rateLimited) assert.equal(local.requests.length, 0)
    const requests = rateLimited ? local.requests : cloud.requests.filter(({ body }) => body.model === freeModels[1])
    assert.ok(requests.some(({ body }) => body.response_format?.type === 'json_schema'), 'создатель передаёт схему')
    assert.ok(requests.some(({ body }) => !body.response_format), 'летописец использует тот же маршрут')
    const usage = expectStatus(await admin.get('/api/admin/usage')).usage
    assert.ok(usage.committed_tokens >= 40)
    assert.equal(usage.provider_cost, 0)
    const ledger = JSON.parse(readFileSync(join(server.storageDir, 'engine', 'llm-usage.json'), 'utf8'))
    const model = rateLimited ? localModel : freeModels[1]
    assert.ok(Object.values(ledger.requests).some((entry) => entry.scope === 'lore' && entry.model === model && entry.status === 'completed'))
  })
}

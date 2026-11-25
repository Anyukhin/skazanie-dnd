import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createCampaign, expectStatus, registerUser, setupAdmin, startTestServer } from './kit/http.mjs'
import { chatCompletion, startFakeProvider } from './kit/llm.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const model = 'qwen-test:14b'
const prologue = 'Луч фонаря дрожит на арке речного архива. Смотритель ждёт под навесом и крепко держит связку ключей. Вода у лестницы поднялась за ночь. Из приоткрытого окна тянет сырой бумагой.'

for (const cloudConfigured of [true, false]) {
  const description = cloudConfigured ? 'после отказа облака' : 'без облачного ключа'
  test(`Ollama создаёт кампанию и пролог ${description}`, { timeout: runnerTimeout(40_000) }, async (t) => {
    const cloud = await startFakeProvider(t, () => ({ status: 402, json: { error: { code: 402 } } }))
    const local = await startFakeProvider(t, (request) => {
      if (request.path !== '/chat/completions') return null
      const opening = { campaignName: 'Речной архив', scene: { title: 'Архив у реки', location: 'Речной архив', objective: 'Встретить смотрителя' } }
      return chatCompletion(request.body.response_format ? opening : prologue, { model })
    })
    const server = await startTestServer(t, {
      storagePrefix: 'skazanie-ollama-api-',
      env: {
        ...(cloudConfigured ? cloud.env : {}),
        DND_AI_MODEL: 'test/paid',
        DND_AI_FALLBACK_MODELS: 'test/other-paid',
        DND_AI_LORE_MODEL: 'test/paid-lore',
        DND_AI_OLLAMA_MODEL: model,
        DND_AI_OLLAMA_BASE_URL: local.baseUrl,
        DND_RUNTIME_IMAGE_GENERATION: 'on',
      },
    })
    const { client: admin } = await setupAdmin(server)
    const { client: player } = await registerUser(server)
    const health = expectStatus(await player.get('/api/health'))
    assert.equal(health.configured, true)
    if (!cloudConfigured) {
      assert.equal(health.model, model)
      expectStatus(await admin.post('/api/items/generate-image', { prompt: 'Ключ от архива' }), 503)
    }
    await createCampaign(player, {
      code: 'OLLAMA-API',
      bootstrap: { slotCount: 2, world: { preset: 'Классическое фэнтези' }, rulesetId: 'dnd_5e_2014' },
    })
    if (!cloudConfigured) {
      const settings = expectStatus(await player.get('/api/campaigns/OLLAMA-API/settings'))
      assert.deepEqual(settings.availableModels, [model])
      assert.equal(settings.settings.model, model)
    }

    assert.ok(local.requests.some((request) => request.body?.response_format?.type === 'json_schema'), 'схема создателя доходит до Ollama')
    assert.ok(local.requests.some((request) => !request.body?.response_format), 'летописец использует тот же резерв')
    assert.ok(local.requests.every((request) => request.body?.model === model && request.headers.authorization === 'Bearer ollama'))
    assert.ok(cloud.requests.every((request) => request.body?.model !== 'test/other-paid'), 'отказ общего ключа пропускает остальные облачные модели')
    if (!cloudConfigured) assert.equal(cloud.requests.length, 0)
    const usage = expectStatus(await admin.get('/api/admin/usage')).usage
    assert.ok(usage.committed_tokens >= 40)
    assert.equal(usage.provider_cost, 0)
    const ledger = JSON.parse(readFileSync(join(server.storageDir, 'engine', 'llm-usage.json'), 'utf8'))
    assert.ok(Object.values(ledger.requests).some((entry) => entry.scope === 'lore' && entry.model === model && entry.status === 'completed'))
  })
}

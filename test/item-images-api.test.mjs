// Аудит PR #131, AI-02: картинка предмета (`POST /api/items/generate-image`)
// идёт тем же путём, что портреты NPC и иллюстрации локаций, — через общий
// проверяющий генератор `image-generation.mjs` и резерв в общем usage-ledger.
// Раньше маршрут сам стучался в `/images`, не проверял формат файла и не
// попадал ни в дневную квоту, ни в отчёт расхода.
//
// Поставщик — локальная заглушка на 127.0.0.1: сеть не нужна.
import { runnerTimeout } from './shared-runner-timeout.mjs'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { setupAdmin, startTestServer } from './kit/http.mjs'
import { startFakeProvider } from './kit/llm.mjs'

const WEBP = Buffer.from('524946460400000057454250', 'hex')
const NOT_AN_IMAGE = Buffer.from('<!doctype html><title>not an image</title>', 'utf8')
const PROMPT = 'Старый бронзовый ключ с волчьей головой на кольце'

/**
 * Заглушка поставщика: `/images` отвечает из очереди, текстовая модель
 * недоступна (стартовый probe получает 503 и уходит в cooldown).
 */
async function startProvider(t, imageResponses) {
  const imageRequests = []
  const provider = await startFakeProvider(t, (request) => {
    if (request.path !== '/images' || request.method !== 'POST') {
      return { status: 503, json: { error: 'text model disabled in item image test' } }
    }
    imageRequests.push(request.body)
    const next = imageResponses.shift()
    return {
      data: [{ b64_json: (next?.bytes ?? WEBP).toString('base64') }],
      usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
      cost: 0.025,
    }
  })
  return { providerBaseUrl: provider.baseUrl, imageRequests }
}

async function bootServer(t, { providerBaseUrl, dailyTokenLimit }) {
  const server = await startTestServer(t, {
    storagePrefix: 'skazanie-item-image-api-',
    env: {
      ROUTERAI_API_KEY: 'item-image-api-test-key',
      ROUTERAI_BASE_URL: providerBaseUrl,
      DND_IMAGE_MODEL: 'test/item-image-v1',
      DND_RUNTIME_IMAGE_GENERATION: 'on',
      DND_AI_MODEL: 'test/text-model',
      DND_AI_FALLBACK_MODELS: '',
      DND_AI_DAILY_TOKEN_LIMIT: String(dailyTokenLimit),
    },
  })
  const { client } = await setupAdmin(server, { name: 'Item Image Admin', email: 'admin@item-image.test', password: 'very-secure-admin-password' })
  return { storage: server.storageDir, client, logs: () => server.output() }
}

/** Записи ledger, которые оставила картинка предмета, — по метке, а не по счётчикам probe. */
function itemImageEntries(storage) {
  const file = join(storage, 'engine', 'llm-usage.json')
  if (!existsSync(file)) return []
  return Object.values(JSON.parse(readFileSync(file, 'utf8')).requests)
    .filter((entry) => entry.scope === 'item-image')
    .sort((left, right) => left.created_at_ms - right.created_at_ms)
}

test('картинка предмета идёт через проверяющий генератор и попадает в usage-ledger', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { providerBaseUrl, imageRequests } = await startProvider(t, [{ bytes: WEBP }, { bytes: NOT_AN_IMAGE }])
  const { storage, client, logs } = await bootServer(t, { providerBaseUrl, dailyTokenLimit: 2_000_000 })

  const generated = await client.post('/api/items/generate-image', { prompt: PROMPT, aspectRatio: '16:9' })
  assert.equal(generated.status, 200, logs())
  const result = generated.body
  assert.match(result.url, /^\/generated\/items\/[a-f0-9-]+\.webp$/u)
  assert.equal(result.model, 'test/item-image-v1')
  assert.equal(result.cost, 0.025)
  assert.equal(imageRequests.length, 1)
  assert.equal(imageRequests[0].model, 'test/item-image-v1')
  assert.equal(imageRequests[0].aspect_ratio, '16:9')
  assert.equal(imageRequests[0].output_format, 'webp')
  assert.match(imageRequests[0].prompt, /волчьей головой/u)

  const file = await client.fetch(result.url)
  assert.equal(file.status, 200)
  assert.equal(file.headers.get('content-type'), 'image/webp')
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), WEBP)

  let entries = itemImageEntries(storage)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].status, 'completed')
  assert.equal(entries[0].model, 'test/item-image-v1')
  assert.equal(entries[0].total_tokens, 12)
  assert.equal(entries[0].provider_cost, 0.025)

  // Поставщик вернул не картинку: файл не пишется, резерв закрыт отказом.
  const rejected = await client.post('/api/items/generate-image', { prompt: PROMPT })
  assert.equal(rejected.status, 502)
  assert.match(rejected.body.error, /неподдерживаемого формата/u)
  assert.equal(imageRequests.length, 2)
  assert.equal(imageRequests[1].aspect_ratio, '1:1')
  assert.equal(readdirSync(join(storage, 'generated', 'items')).length, 1, 'непроверенный файл не должен лечь на диск')
  entries = itemImageEntries(storage)
  assert.deepEqual(entries.map((entry) => entry.status), ['completed', 'failed'])
  assert.equal(entries[1].reserved_tokens, 0)
})

test('исчерпанная дневная квота отвечает 429 до запроса к генератору', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { providerBaseUrl, imageRequests } = await startProvider(t, [])
  const { storage, client, logs } = await bootServer(t, { providerBaseUrl, dailyTokenLimit: 1 })

  const response = await client.post('/api/items/generate-image', { prompt: PROMPT })
  assert.equal(response.status, 429, logs())
  assert.equal(response.body.code, 'LLM_QUOTA_EXCEEDED')
  assert.equal(imageRequests.length, 0)
  assert.deepEqual(itemImageEntries(storage), [])
  assert.deepEqual(readdirSync(join(storage, 'generated', 'items')), [])
})

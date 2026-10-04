// Аудит PR #131, AI-02: картинка предмета (`POST /api/items/generate-image`)
// идёт тем же путём, что портреты NPC и иллюстрации локаций, — через общий
// проверяющий генератор `image-generation.mjs` и резерв в общем usage-ledger.
// Раньше маршрут сам стучался в `/images`, не проверял формат файла и не
// попадал ни в дневную квоту, ни в отчёт расхода.
//
// Поставщик — локальная заглушка на 127.0.0.1: сеть не нужна.
import { freePort } from './free-port.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const WEBP = Buffer.from('524946460400000057454250', 'hex')
const NOT_AN_IMAGE = Buffer.from('<!doctype html><title>not an image</title>', 'utf8')
const PROMPT = 'Старый бронзовый ключ с волчьей головой на кольце'

function startServer({ port, storage, providerBaseUrl, dailyTokenLimit, appendLog }) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: 'item-image-api-test-key',
      ROUTERAI_BASE_URL: providerBaseUrl,
      DND_IMAGE_MODEL: 'test/item-image-v1',
      DND_RUNTIME_IMAGE_GENERATION: 'on',
      DND_AI_MODEL: 'test/text-model',
      DND_AI_FALLBACK_MODELS: '',
      DND_AI_DAILY_TOKEN_LIMIT: String(dailyTokenLimit),
      ADMIN_SETUP_TOKEN: 'item-image-api-setup',
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test server did not stop')), 5_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, log) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Test server exited with ${child.exitCode}\n${log()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return response
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Test server did not become healthy\n${log()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/**
 * Заглушка поставщика: `/images` отвечает из очереди, текстовая модель
 * недоступна (стартовый probe получает 503 и уходит в cooldown).
 */
async function startProvider(t, imageResponses) {
  const imageRequests = []
  const provider = createHttpServer(async (req, res) => {
    if (req.url !== '/api/v1/images' || req.method !== 'POST') {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      return res.end('{"error":"text model disabled in item image test"}')
    }
    let raw = ''
    for await (const chunk of req) raw += String(chunk)
    imageRequests.push(JSON.parse(raw))
    const next = imageResponses.shift()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({
      data: [{ b64_json: (next?.bytes ?? WEBP).toString('base64') }],
      usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
      cost: 0.025,
    }))
  })
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve) })
  const address = provider.address()
  const providerPort = typeof address === 'object' && address ? address.port : 0
  t.after(() => new Promise((resolve) => {
    provider.closeAllConnections()
    provider.close(() => resolve())
  }))
  const providerBaseUrl = `http://127.0.0.1:${providerPort}/api/v1`
  return { providerBaseUrl, imageRequests }
}

async function bootServer(t, { providerBaseUrl, dailyTokenLimit }) {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-item-image-api-'))
  let logs = ''
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const child = startServer({ port, storage, providerBaseUrl, dailyTokenLimit, appendLog: (chunk) => { logs += chunk } })
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })
  await waitForHealth(baseUrl, child, () => logs)
  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: {
      name: 'Item Image Admin',
      email: 'admin@item-image.test',
      password: 'very-secure-admin-password',
      setupToken: 'item-image-api-setup',
    },
  })
  assert.equal(setup.status, 201, logs)
  const cookie = setup.headers.get('set-cookie')?.split(';')[0]
  return { storage, baseUrl, cookie, logs: () => logs }
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
  const { storage, baseUrl, cookie, logs } = await bootServer(t, { providerBaseUrl, dailyTokenLimit: 2_000_000 })

  const generated = await request(baseUrl, '/api/items/generate-image', {
    method: 'POST',
    cookie,
    body: { prompt: PROMPT, aspectRatio: '16:9' },
  })
  assert.equal(generated.status, 200, logs())
  const result = await generated.json()
  assert.match(result.url, /^\/generated\/items\/[a-f0-9-]+\.webp$/u)
  assert.equal(result.model, 'test/item-image-v1')
  assert.equal(result.cost, 0.025)
  assert.equal(imageRequests.length, 1)
  assert.equal(imageRequests[0].model, 'test/item-image-v1')
  assert.equal(imageRequests[0].aspect_ratio, '16:9')
  assert.equal(imageRequests[0].output_format, 'webp')
  assert.match(imageRequests[0].prompt, /волчьей головой/u)

  const file = await request(baseUrl, result.url, { cookie })
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
  const rejected = await request(baseUrl, '/api/items/generate-image', {
    method: 'POST',
    cookie,
    body: { prompt: PROMPT },
  })
  assert.equal(rejected.status, 502)
  assert.match((await rejected.json()).error, /неподдерживаемого формата/u)
  assert.equal(imageRequests.length, 2)
  assert.equal(imageRequests[1].aspect_ratio, '1:1')
  assert.equal(readdirSync(join(storage, 'generated', 'items')).length, 1, 'непроверенный файл не должен лечь на диск')
  entries = itemImageEntries(storage)
  assert.deepEqual(entries.map((entry) => entry.status), ['completed', 'failed'])
  assert.equal(entries[1].reserved_tokens, 0)
})

test('исчерпанная дневная квота отвечает 429 до запроса к генератору', { timeout: runnerTimeout(40_000) }, async (t) => {
  const { providerBaseUrl, imageRequests } = await startProvider(t, [])
  const { storage, baseUrl, cookie, logs } = await bootServer(t, { providerBaseUrl, dailyTokenLimit: 1 })

  const response = await request(baseUrl, '/api/items/generate-image', {
    method: 'POST',
    cookie,
    body: { prompt: PROMPT },
  })
  assert.equal(response.status, 429, logs())
  assert.equal((await response.json()).code, 'LLM_QUOTA_EXCEEDED')
  assert.equal(imageRequests.length, 0)
  assert.deepEqual(itemImageEntries(storage), [])
  assert.deepEqual(readdirSync(join(storage, 'generated', 'items')), [])
})

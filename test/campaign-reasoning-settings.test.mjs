// Выбор модели и уровня рассуждений лидером кампании.
//
// Лидер (владелец кампании или администратор) выбирает в настройках модель и
// то, сколько она рассуждает перед ответом. Проверяется, что выбор доходит до
// поля `reasoning` запроса к провайдеру ровно для выбранной модели, что
// резервные модели остаются на своих профилях, и что права, валидация и
// перезапуск работают так же, как у остальных настроек ИИ.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  REASONING_LEVELS,
  campaignReasoningFor,
  normalizeReasoningLevel,
  runWithCampaignAiSettings,
} from '../server/campaign-ai-context.mjs'
import { FallbackLLMClient, RouterAIClient } from '../server/llm-client.mjs'
import {
  MODEL_OPTIONS,
  REASONING_PROFILES,
  modelOptionFor,
  reasoningLevelAllowedFor,
  reasoningProfileFor,
} from '../server/model-style-profiles.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

function recordingClient(model, sent) {
  return new RouterAIClient({
    apiKey: 'test-key', baseUrl: 'http://127.0.0.1:9', model, reasoning: reasoningProfileFor(model),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body)
      sent.push({ model: body.model, reasoning: body.reasoning ?? null })
      return new Response(JSON.stringify({ model, choices: [{ message: { role: 'assistant', content: 'Ответ.' } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    },
  })
}

test('профиль нормализуется к «авто», а у каждого профиля есть подпись и описание', () => {
  assert.deepEqual(Object.keys(REASONING_LEVELS), ['auto', 'thoughtful', 'deep'])
  assert.equal(normalizeReasoningLevel('DEEP'), 'deep')
  assert.equal(normalizeReasoningLevel('ultra'), 'auto')
  assert.equal(normalizeReasoningLevel(undefined), 'auto')
  for (const level of Object.values(REASONING_LEVELS)) {
    assert.ok(level.label && level.description, level.id)
  }
  // Вне запроса кампании выбора нет — работает профиль сервера.
  assert.equal(campaignReasoningFor('openai/gpt-6-luna'), null)
})

test('профиль лидера уходит провайдеру только для выбранной модели и только в творческих ролях', async () => {
  const sent = []
  const luna = recordingClient('openai/gpt-6-luna', sent)
  const glm = recordingClient('z-ai/glm-5.3-flash', sent)
  const ask = (client, extra = {}) => client.complete({ messages: [{ role: 'user', content: 'Привет' }], ...extra })

  await runWithCampaignAiSettings({ model: 'openai/gpt-6-luna', reasoningLevel: 'deep' }, async () => {
    await ask(luna, { role: 'narrator' })
    await ask(luna, { role: 'director' })
    await ask(luna, { role: 'npc' })
    // Арбитр и создание мира себя не помечают — на высоких уровнях они ломаются.
    await ask(luna)
    await ask(glm, { role: 'narrator' })
    // Явный reasoning в запросе важнее выбора кампании.
    await ask(luna, { role: 'narrator', reasoning: { enabled: false } })
  })
  await runWithCampaignAiSettings({ model: 'openai/gpt-6-luna', reasoningLevel: 'thoughtful' }, async () => {
    await ask(luna, { role: 'narrator' })
    await ask(luna, { role: 'director' })
  })
  await runWithCampaignAiSettings({ model: 'openai/gpt-6-luna', reasoningLevel: 'auto' }, async () => {
    await ask(luna, { role: 'narrator' })
  })

  assert.deepEqual(sent, [
    { model: 'openai/gpt-6-luna', reasoning: { effort: 'high' } },
    { model: 'openai/gpt-6-luna', reasoning: { effort: 'high' } },
    { model: 'openai/gpt-6-luna', reasoning: { effort: 'medium' } },
    { model: 'openai/gpt-6-luna', reasoning: { enabled: false } }, // непомеченная роль — профиль сервера
    { model: 'z-ai/glm-5.3-flash', reasoning: { effort: 'low' } }, // свой профиль GLM, а не выбор кампании
    { model: 'openai/gpt-6-luna', reasoning: { enabled: false } },
    { model: 'openai/gpt-6-luna', reasoning: { enabled: false } }, // «вдумчивее» рассказчика не трогает
    { model: 'openai/gpt-6-luna', reasoning: { effort: 'low' } },
    { model: 'openai/gpt-6-luna', reasoning: { enabled: false } }, // «авто» = профиль сервера
  ])
})

test('резервная модель цепочки не получает уровень, выбранный для основной', async () => {
  const sent = []
  const failing = new RouterAIClient({
    apiKey: 'test-key', baseUrl: 'http://127.0.0.1:9', model: 'openai/gpt-6-luna',
    fetchImpl: async (_url, init) => {
      sent.push({ model: JSON.parse(init.body).model, reasoning: JSON.parse(init.body).reasoning ?? null })
      return new Response('{}', { status: 503 })
    },
  })
  const fallback = recordingClient('google/gemini-2.5-flash-lite', sent)
  const chain = new FallbackLLMClient({ clients: [failing, fallback] })
  await runWithCampaignAiSettings({ model: 'openai/gpt-6-luna', reasoningLevel: 'deep' }, () => (
    chain.complete({ messages: [{ role: 'user', content: 'Привет' }], role: 'narrator' })
  ))
  assert.deepEqual(sent, [
    { model: 'openai/gpt-6-luna', reasoning: { effort: 'high' } },
    { model: 'google/gemini-2.5-flash-lite', reasoning: null },
  ])
})

test('карточки моделей описаны для игрока и знают допустимые уровни', () => {
  for (const id of Object.keys(MODEL_OPTIONS)) {
    const option = modelOptionFor(id)
    assert.ok(option.label && option.description, id)
    assert.ok(option.reasoningLevels.includes('auto'), `${id}: «авто» доступен всегда`)
    for (const level of option.reasoningLevels) assert.ok(Object.hasOwn(REASONING_LEVELS, level), `${id}: ${level}`)
  }
  assert.equal(modelOptionFor('openai/gpt-6-luna', { recommended: 'openai/gpt-6-luna' }).recommended, true)
  // Профили есть только у Luna: у остальных уровни на деле работают не так,
  // как названы (перебор 2026-10-01), и честного выбора нет.
  assert.deepEqual(modelOptionFor('openai/gpt-6-luna').reasoningLevels, ['auto', 'thoughtful', 'deep'])
  for (const id of ['z-ai/glm-5.3-flash', 'deepseek/deepseek-v4-flash', 'google/gemini-2.5-flash-lite', 'openai/gpt-6-luna-pro']) {
    assert.deepEqual(modelOptionFor(id).reasoningLevels, ['auto'], id)
  }
  // Ни один профиль не трогает арбитра и создание мира.
  for (const profiles of Object.values(REASONING_PROFILES)) {
    for (const roles of Object.values(profiles)) {
      assert.deepEqual(Object.keys(roles).filter((role) => !['narrator', 'director', 'npc'].includes(role)), [])
    }
  }
  assert.deepEqual(modelOptionFor('vendor/unknown-model'), {
    id: 'vendor/unknown-model', label: 'vendor/unknown-model', description: '', reasoningLevels: ['auto'], recommended: false,
  })
  assert.equal(reasoningLevelAllowedFor('vendor/unknown-model', 'auto'), true)
  assert.equal(reasoningLevelAllowedFor('vendor/unknown-model', 'high'), false)
})

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const address = probe.address()
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: 'reasoning-setup', GAME_ENGINE_MODE: 'enforce',
      COOKIE_SECURE: 'false', NODE_ENV: 'test',
      DND_AI_MODEL: 'z-ai/glm-5.3-flash', DND_AI_FALLBACK_MODELS: 'google/gemini-2.5-flash-lite',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve) => { child.once('exit', resolve); child.kill() })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Server exited\n${logs()}`)
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Server did not become healthy\n${logs()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { response, status: response.status, body: text ? JSON.parse(text) : null, text }
}

const sessionCookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0]

test('лидер выбирает модель и рассуждения; игрок — нет; выбор переживает перезапуск', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-reasoning-'))
  let logs = ''
  let child = null
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })
  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const owner = await request(baseUrl, '/api/auth/register', { method: 'POST', body: { name: 'Leader', email: 'leader@reasoning.test', password: 'secure-leader-password' } })
  const guest = await request(baseUrl, '/api/auth/register', { method: 'POST', body: { name: 'Guest', email: 'guest@reasoning.test', password: 'secure-guest-password' } })
  const ownerCookie = sessionCookie(owner)
  const guestCookie = sessionCookie(guest)
  assert.equal((await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: ownerCookie,
    body: { code: 'THINK', name: 'Рассуждения', bootstrap: { partyName: 'Двое', players: [{ id: 'hero-1' }, { id: 'hero-2' }] } },
  })).status, 201)
  const invite = await request(baseUrl, '/api/campaigns/THINK/invites', { method: 'POST', cookie: ownerCookie, body: { hero_ids: ['hero-2'] } })
  assert.equal((await request(baseUrl, '/api/campaigns/THINK/join', { method: 'POST', cookie: guestCookie, body: { invite_token: invite.body.token } })).status, 200)

  const initial = await request(baseUrl, '/api/campaigns/THINK/settings', { cookie: ownerCookie })
  assert.equal(initial.status, 200, initial.text)
  assert.equal(initial.body.settings.reasoningLevel, 'auto', 'новая кампания живёт на профиле сервера')
  assert.deepEqual(initial.body.reasoningLevels.map((level) => level.id), Object.keys(REASONING_LEVELS))
  const luna = initial.body.modelOptions.find((option) => option.id === 'openai/gpt-6-luna')
  assert.ok(luna, 'GPT-6 Luna можно выбрать, даже если её нет в цепочке .env')
  assert.equal(luna.recommended, true)
  assert.ok(luna.label && luna.description)

  // Игрок видит настройки, но не меняет их.
  const guestPatch = await request(baseUrl, '/api/campaigns/THINK/settings', { method: 'PATCH', cookie: guestCookie, body: { model: 'openai/gpt-6-luna', reasoningLevel: 'deep' } })
  assert.equal(guestPatch.status, 403, guestPatch.text)

  const saved = await request(baseUrl, '/api/campaigns/THINK/settings', { method: 'PATCH', cookie: ownerCookie, body: { model: 'openai/gpt-6-luna', reasoningLevel: 'deep' } })
  assert.equal(saved.status, 200, saved.text)
  assert.deepEqual([saved.body.settings.model, saved.body.settings.reasoningLevel], ['openai/gpt-6-luna', 'deep'])

  // Уровень, который модель не принимает, и мусор отвергаются своими кодами.
  const unsupported = await request(baseUrl, '/api/campaigns/THINK/settings', { method: 'PATCH', cookie: ownerCookie, body: { model: 'google/gemini-2.5-flash-lite', reasoningLevel: 'deep' } })
  assert.equal(unsupported.status, 400, unsupported.text)
  assert.equal(unsupported.body.code, 'REASONING_LEVEL_NOT_SUPPORTED')
  const garbage = await request(baseUrl, '/api/campaigns/THINK/settings', { method: 'PATCH', cookie: ownerCookie, body: { reasoningLevel: 'ultra' } })
  assert.equal(garbage.status, 400, garbage.text)
  assert.equal(garbage.body.code, 'REASONING_LEVEL_INVALID')
  const unchanged = await request(baseUrl, '/api/campaigns/THINK/settings', { cookie: ownerCookie })
  assert.deepEqual([unchanged.body.settings.model, unchanged.body.settings.reasoningLevel], ['openai/gpt-6-luna', 'deep'])

  // Смена модели без уровня сбрасывает неподдерживаемый уровень на «авто».
  const switched = await request(baseUrl, '/api/campaigns/THINK/settings', { method: 'PATCH', cookie: ownerCookie, body: { model: 'google/gemini-2.5-flash-lite' } })
  assert.equal(switched.status, 200, switched.text)
  assert.equal(switched.body.settings.reasoningLevel, 'auto')

  // Стол видит смену ведущего в летописи.
  const room = await request(baseUrl, '/api/rooms/THINK', { cookie: guestCookie })
  const notes = (room.body.state.messages ?? []).filter((message) => /^Ведущий ИИ:/u.test(message.text))
  assert.deepEqual(notes.map((message) => message.text), [
    'Ведущий ИИ: GPT-6 Luna, рассуждения — глубже.',
    'Ведущий ИИ: Gemini 2.5 Flash Lite, рассуждения — авто.',
  ])

  await request(baseUrl, '/api/campaigns/THINK/settings', { method: 'PATCH', cookie: ownerCookie, body: { model: 'openai/gpt-6-luna', reasoningLevel: 'thoughtful' } })
  await stopServer(child)
  child = null
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)
  const recovered = await request(baseUrl, '/api/campaigns/THINK/settings', { cookie: ownerCookie })
  assert.deepEqual([recovered.body.settings.model, recovered.body.settings.reasoningLevel], ['openai/gpt-6-luna', 'thoughtful'])
})

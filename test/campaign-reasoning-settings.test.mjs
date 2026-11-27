// Выбор модели и уровня рассуждений лидером кампании.
//
// Лидер (владелец кампании или администратор) выбирает в настройках модель и
// то, сколько она рассуждает перед ответом. Проверяется, что выбор доходит до
// поля `reasoning` запроса к провайдеру ровно для выбранной модели, что
// резервные модели остаются на своих профилях, и что права, валидация и
// перезапуск работают так же, как у остальных настроек ИИ.
import assert from 'node:assert/strict'
import test from 'node:test'

import { startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

// Уровни рассуждений по порядку: rust/crates/sk-narration-base/src/campaign_ai_context.rs
// (REASONING_LEVELS). Функции выбора уровня и клиент модели в процессе —
// campaign-reasoning-settings-library.test.mjs.
const REASONING_LEVEL_IDS = ['auto', 'thoughtful', 'deep']

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
  const server = await startTestServer(t, {
    storagePrefix: 'skazanie-reasoning-',
    setupToken: 'reasoning-setup',
    env: { DND_AI_MODEL: 'z-ai/glm-5.3-flash', DND_AI_FALLBACK_MODELS: 'google/gemini-2.5-flash-lite' },
  })
  // Адрес меняется после restart(): переменная обновляется ниже.
  let baseUrl = server.baseUrl

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
  assert.deepEqual(initial.body.reasoningLevels.map((level) => level.id), REASONING_LEVEL_IDS)
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
  await server.restart()
  baseUrl = server.baseUrl
  const recovered = await request(baseUrl, '/api/campaigns/THINK/settings', { cookie: ownerCookie })
  assert.deepEqual([recovered.body.settings.model, recovered.body.settings.reasoningLevel], ['openai/gpt-6-luna', 'thoughtful'])
})

// Выбор модели и уровня рассуждений лидером кампании — JS-библиотека в процессе.
//
// Проверяется, что выбор доходит до поля `reasoning` запроса к провайдеру ровно
// для выбранной модели и что резервные модели остаются на своих профилях.
// HTTP-сценарий настроек — campaign-reasoning-settings.test.mjs.
import assert from 'node:assert/strict'
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


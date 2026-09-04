import assert from 'node:assert/strict'
import test from 'node:test'

import { promptForModel, promptForModelRole, reasoningProfileFor, styleAddendumFor } from '../server/model-style-profiles.mjs'

/**
 * Добавка под Luna — компенсация замеренного провала, а не украшение: без неё
 * реплики сжимаются до одного факта и голоса NPC неразличимы
 * (`docs/model-benchmark-2026-07-31.md`). С ней — 100 % голосов и памяти в
 * четырёх прогонах подряд.
 */

test('добавка существует только у моделей, чей провал замерен', () => {
  assert.ok(styleAddendumFor('openai/gpt-5.6-luna').includes('2–4 полных предложения'))
  assert.ok(styleAddendumFor('openai/gpt-5.6-luna-pro').length > 0)
  assert.equal(styleAddendumFor('z-ai/glm-5.2'), '', 'поведение GLM меняться не должно')
  assert.equal(styleAddendumFor(undefined), '')
})

test('промпт незнакомой модели возвращается без изменений', () => {
  assert.equal(promptForModel('база', { model: 'z-ai/glm-5.2' }), 'база')
  assert.equal(promptForModel('база', null), 'база')
  assert.ok(promptForModel('база', { model: 'openai/gpt-5.6-luna' }).startsWith('база\n'))
})

test('добавка требует ровно того, что проваливалось: длину, манеру, память', () => {
  const addendum = styleAddendumFor('openai/gpt-5.6-luna')
  assert.match(addendum, /speech_profile/u)
  assert.match(addendum, /обещания,\s+прошлые разговоры/u)
  assert.match(addendum, /Однострочный ответ — ошибка/u)
})

test('у моделей горячего пути reasoning ограничен самым быстрым поддерживаемым режимом', () => {
  assert.deepEqual(reasoningProfileFor('z-ai/glm-5.3-flash'), { effort: 'low' })
  assert.deepEqual(reasoningProfileFor('openai/gpt-5.6-luna'), { enabled: false })
  assert.equal(reasoningProfileFor('unknown/model'), null)
})

test('строгий контракт GLM применяется только к Рассказчику', () => {
  const client = { model: 'z-ai/glm-5.3-flash' }
  const narratorPrompt = promptForModelRole('база', client, 'narrator')
  assert.match(narratorPrompt, /Не описывай процесс/u)
  assert.match(narratorPrompt, /ровно 1–2 предложения/u)
  assert.match(narratorPrompt, /open_promises/u)
  assert.match(narratorPrompt, /memory_focus/u)
  assert.match(narratorPrompt, /вообще не упоминай героя по имени/u)
  assert.equal(promptForModelRole('база', client, 'shared'), 'база')
  assert.equal(promptForModel('база', client), 'база')
})

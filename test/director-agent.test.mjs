import assert from 'node:assert/strict'
import test from 'node:test'

import { DirectorAgent, fallbackDirectorIntent } from '../server/director-agent.mjs'
import { FakeLLM } from '../server/llm-client.mjs'

function state(history = []) {
  return {
    scene: { title: 'Старая дорога', location: 'Старая дорога', objective: 'Найти пропавший караван', turn: 2 },
    adventure: { chapter: 1 },
    mechanics: { combat: { active: false }, encounter: null },
    autonomy: { director_history: history.map((intent) => ({ intent })), encounter_outcomes: [] },
    worldMemory: { quests: [{ id: 'quest-road', title: 'Пропавший караван', status: 'active', objectives: ['Найти след'], clock: { current: 0, max: 4 } }] },
    social: { npcs: [{ id: 'guide', name: 'Мира', role: 'проводница', location: 'Старая дорога', available: true }] },
  }
}

test('детерминированный Director проходит исследование, social, quest и встречу', () => {
  const history = []
  for (const expected of ['continue_exploration', 'open_social_scene', 'advance_quest_clock', 'request_encounter']) {
    const intent = fallbackDirectorIntent(state(history))
    assert.equal(intent.type, expected)
    history.push(intent)
  }
  assert.equal(history.at(-1).difficulty, 'medium')
})

test('невалидный ответ модели откатывается к безопасному server-owned намерению', async () => {
  const llm = new FakeLLM({ response: { hp: 1, damage: 999, type: 'request_encounter' } })
  const director = new DirectorAgent({ llmClient: llm })
  const result = await director.choose({ state: state(), playerAction: 'Продолжить' })
  assert.equal(result.intent.type, 'continue_exploration')
  assert.equal(result.trace.mode, 'deterministic-fallback')
  assert.equal(llm.requests.length, 1)
})

test('Director получает bounded-память незакрытых нитей и нарушенных обещаний как данные', async () => {
  const llm = new FakeLLM({ response: { type: 'continue_exploration', reason: 'Продолжить по сохранённой причинной линии.' } })
  const inputState = state()
  inputState.worldMemory.threads = [{
    id: 'thread:missing-caravan', title: 'След пропавшего каравана', summary: 'Последствия задержки ещё не разрешены.',
    status: 'active', visibility: 'party', entity_ids: [], quest_ids: [],
    clock: { current: 2, max: 4, triggered: false }, source_event_ids: ['event:caravan'],
  }]
  inputState.social = {
    npcs: [], relationships: {}, conversations: [], promises: [{
      id: 'promise:broken', npc_id: 'guide', hero_id: 'hero', direction: 'npc_to_party',
      text: 'Проводник должен был вернуться до заката.', due_hint: 'сегодня', status: 'broken', visibility: 'specific_player',
      resolution_reason: 'deadline', consequence_delta: -8,
    }],
  }

  await new DirectorAgent({ llmClient: llm }).choose({ state: inputState, playerAction: 'Продолжить поиск каравана' })
  const content = llm.requests[0].messages[1].content

  assert.match(content, /<<<UNTRUSTED_DATA:director_brief>>>/u)
  assert.match(content, /thread:missing-caravan/u)
  assert.match(content, /Последствия задержки ещё не разрешены/u)
  assert.match(content, /promise:broken/u)
  assert.match(content, /Проводник должен был вернуться до заката/u)
  assert.match(content, /"status":"broken"/u)
})

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

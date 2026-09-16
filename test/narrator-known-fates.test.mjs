import assert from 'node:assert/strict'
import test from 'node:test'

import { FakeLLM } from '../server/llm-client.mjs'
import { Narrator } from '../server/narrator.mjs'
import { buildNarrationBrief } from '../server/security.mjs'

function brief() {
  return buildNarrationBrief({
    visible_events: [{
      event_type: 'AbilityCheckResolved',
      payload: { ability: 'wis', success: true },
      visibility: 'party',
    }],
    known_environment: {
      location: 'Северные ворота',
      story_context: {
        heroes: [{ id: 'hero:ada', name: 'Ада', is_viewer: true }],
        present_npcs: [{ id: 'npc:orvin', name: 'Орвин' }],
        known_dead_npcs: [{ id: 'npc:mira', name: 'Мира' }],
        recent_summaries: [],
        recent_decisions: [],
        open_promises: [],
        recent_interactions: [],
      },
    },
    permitted_npc_reactions: [],
  })
}

async function render(text, input = brief()) {
  const llm = new FakeLLM([{ content: text }])
  const result = await new Narrator({ llmClient: llm, asyncFeedback: false }).render(input)
  return { llm, result }
}

test('Narrator отправляет в безопасный fallback настоящее действие погибшего NPC', async () => {
  const { llm, result } = await render('Мира ждёт у северных ворот.')

  assert.equal(llm.requests.length, 1)
  assert.equal(result.provider, 'deterministic-fallback')
  assert.ok(result.verification.repaired_from.some((entry) => entry.code === 'DEAD_NPC_CURRENT_ACTION_NOT_IN_BRIEF'))
  assert.doesNotMatch(result.narration, /Мира ждёт/u)
})

test('Narrator не запрещает тёзку живого NPC по судьбе другого NPC', async () => {
  const input = brief()
  input.known_environment.story_context.present_npcs.push({ id: 'npc:mira-alive', name: 'Мира' })
  const { result } = await render('Мира ждёт у северных ворот.', input)

  assert.equal(result.provider, 'FakeLLM', JSON.stringify(result.verification))
  assert.equal(result.narration, 'Мира ждёт у северных ворот.')
  assert.equal(result.verification.valid, true, JSON.stringify(result.verification))
})

for (const [kind, text] of [
  ['старой цитаты', 'В старой записи сохранилась фраза: «Мира ждёт у северных ворот».'],
  ['убеждения другого NPC', 'Орвин уверен, что Мира ждёт у северных ворот.'],
]) test(`Narrator не блокирует ${kind}`, async () => {
  const { result } = await render(text)

  assert.equal(result.provider, 'FakeLLM', JSON.stringify(result.verification))
  assert.equal(result.narration, text)
  assert.equal(result.verification.valid, true, JSON.stringify(result.verification))
})

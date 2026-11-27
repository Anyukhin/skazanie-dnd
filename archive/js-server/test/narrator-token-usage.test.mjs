import assert from 'node:assert/strict'
import test from 'node:test'

import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { Narrator } from '../server/narrator.mjs'

// До 2026-10-04 трасса хода писала `token_usage: {}`, хотя ответ провайдера
// нёс расход (исследование PR #136): цену законченного хода нельзя было
// восстановить из трассы.

const BRIEF = Object.freeze({
  visible_events: [{ event_type: 'ActorMoved', payload: { distance: 10 }, target_ids: ['hero'] }],
  visible_state_changes: [],
  known_environment: {},
  permitted_npc_reactions: [],
})
const USAGE = Object.freeze({ prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 })

test('расход модели остаётся в результате рассказчика — и принятом, и отклонённом', async () => {
  for (const content of ['Герой проходит десять футов вперёд.', '']) {
    const narrator = new Narrator({ llmClient: { complete: async () => ({ content, usage: USAGE, model: 'test' }) } })
    const result = await narrator.render(BRIEF)
    assert.deepEqual(result.token_usage, USAGE, content ? 'принятый текст' : 'пустой ответ ушёл в запасной текст, но оплачен')
  }
})

test('без модели расхода нет и поле не появляется', async () => {
  const result = await new Narrator().render(BRIEF)
  assert.equal(Object.hasOwn(result, 'token_usage'), false)
})

test('трасса хода сохраняет расход рассказчика', () => {
  const saved = []
  const orchestrator = new GameOrchestrator({ rulesEngine: {}, eventStore: {}, unknownActionHandler: {}, traceStore: { save: (record) => { saved.push(record); return record }, recent: () => [] } })
  orchestrator.saveTrace({
    turnId: 'turn-1', campaignId: 'C', mode: 'action', intent: {}, retrievalQueries: [], retrievedRules: {}, plan: {},
    stateBefore: 1, stateAfter: 2, latency: 5,
    narration: { narration: 'Текст.', token_usage: USAGE, verification: { valid: true } },
  })
  assert.deepEqual(saved[0].token_usage, USAGE)
  orchestrator.saveTrace({ turnId: 'turn-2', campaignId: 'C', mode: 'action', intent: {}, retrievalQueries: [], retrievedRules: {}, plan: {}, stateBefore: 2, stateAfter: 3, latency: 5 })
  assert.deepEqual(saved[1].token_usage, {})
})

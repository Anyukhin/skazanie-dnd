import assert from 'node:assert/strict'
import test from 'node:test'

import { FakeLLM } from '../server/llm-client.mjs'
import { Narrator, deterministicNarration } from '../server/narrator.mjs'
import { buildNarrationBrief } from '../server/security.mjs'

const brief = buildNarrationBrief({
  visible_events: [{ event_type: 'DamageApplied', payload: { applied_amount: 3, hp_before: 10, hp_after: 7 }, source_rule_ids: ['srd:test:damage'], visibility: 'public' }],
  visible_state_changes: [{ hp_before: 10, hp_after: 7, visibility: 'public' }],
  known_environment: { location: 'Зал' },
  permitted_npc_reactions: [],
})

test('deterministic narrator описывает только подтверждённые события', () => {
  const result = deterministicNarration(brief)
  assert.match(result.narration, /3/)
  assert.match(result.narration, /10 → 7/)
})

test('Narrator исправляет неподтверждённую механику или использует безопасный fallback', async () => {
  const llm = new FakeLLM([
    { content: JSON.stringify({ narration: 'Выпало 20, и герой получает 1000 HP.', suggestions: [] }) },
    { content: JSON.stringify({ narration: 'Удар причиняет 3 урона; здоровье цели меняется с 10 до 7.', suggestions: ['Продолжить'] }) },
  ])
  const result = await new Narrator({ llmClient: llm }).render(brief, { knownRuleIds: ['srd:test:damage'] })
  assert.equal(result.verification.valid, true)
  assert.doesNotMatch(result.narration, /1000/)
  assert.equal(llm.requests.length, 2)
})

test('Narrator превращает ошибку провайдера после commit в deterministic fallback', async () => {
  const llmClient = { completeJson: async () => { const error = new Error('timeout'); error.code = 'LLM_TIMEOUT'; throw error } }
  const result = await new Narrator({ llmClient }).render(brief, { knownRuleIds: ['srd:test:damage'] })
  assert.equal(result.provider, 'deterministic-provider-fallback')
  assert.equal(result.verification.valid, true)
  assert.equal(result.verification.provider_error, 'LLM_TIMEOUT')
  assert.match(result.narration, /3/u)
})

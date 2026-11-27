import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_IMPROV_MODE,
  IMPROV_MODES,
  currentImprovMode,
  normalizeImprovMode,
  runWithCampaignAiSettings,
} from '../server/campaign-ai-context.mjs'
import { DirectorAgent } from '../server/director-agent.mjs'

// Режим импровизации в JS-библиотеке: нормализация и передача Режиссёру в
// процессе. HTTP-сценарий настроек — campaign-improv-mode.test.mjs.

test('режим импровизации нормализуется к «сюжету» и доезжает до Режиссёра', async (t) => {
  assert.deepEqual(Object.keys(IMPROV_MODES).sort(), ['chaos', 'story'])
  assert.equal(DEFAULT_IMPROV_MODE, 'story')
  assert.equal(normalizeImprovMode('chaos'), 'chaos')
  assert.equal(normalizeImprovMode('CHAOS'), 'chaos')
  assert.equal(normalizeImprovMode('sandbox'), 'story')
  assert.equal(normalizeImprovMode(undefined), 'story')
  // Вне запроса контекста кампании нет — режим обязан оставаться дефолтным.
  assert.equal(currentImprovMode(), 'story')

  await runWithCampaignAiSettings({ model: 'primary', narratorStyle: 'neutral', improvMode: 'chaos' }, async () => {
    assert.equal(currentImprovMode(), 'chaos')
    // Значение только прокинуто в трассу: намерение и промпт от него не зависят.
    const decision = await new DirectorAgent().choose({ state: {}, playerAction: 'Осмотреться' })
    assert.equal(decision.trace.improv_mode, 'chaos')
    assert.equal(decision.intent.type, 'continue_exploration')
  })

  const explicit = await new DirectorAgent().choose({ state: {}, playerAction: 'Осмотреться', improvMode: 'мусор' })
  assert.equal(explicit.trace.improv_mode, 'story')
  t.diagnostic('режим импровизации пока не меняет решение Режиссёра — это следующая задача')
})


import assert from 'node:assert/strict'
import test from 'node:test'

import { CAMPAIGN_BOOTSTRAP_TIMEOUT_MS, CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'

const hero = { id: 'hero', character: 'Ада', backstory: 'Выросла в приграничье.' }

/**
 * Живой замер 2026-07-28: создание кампании просит до 3200 токенов и не
 * укладывается в общий боевой таймаут 9 секунд. Три модели подряд отвалились
 * по таймауту, прежде чем ответила четвёртая — 35 секунд ожидания игрока и
 * три сожжённые впустую попытки.
 */
test('создание кампании просит собственный, увеличенный таймаут', async () => {
  const requests = []
  const bootstrapper = new CampaignBootstrapper({
    llmClient: { completeJson: async (input) => { requests.push(input); return {} } },
  })
  await bootstrapper.create({ code: 'BOOT-TIMEOUT', name: 'Проверка', partyName: 'Отряд', world: {}, players: [hero] })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].timeoutMs, CAMPAIGN_BOOTSTRAP_TIMEOUT_MS)
  assert.ok(CAMPAIGN_BOOTSTRAP_TIMEOUT_MS >= 30_000, 'таймаут обязан быть заметно больше боевого хода')
})

test('отказ модели по-прежнему оставляет кампанию играбельной', async () => {
  const bootstrapper = new CampaignBootstrapper({
    llmClient: { completeJson: async () => { throw Object.assign(new Error('timeout'), { code: 'LLM_TIMEOUT' }) } },
  })
  const state = await bootstrapper.create({ code: 'BOOT-FAIL', name: 'Проверка', partyName: 'Отряд', world: {}, players: [hero] })

  assert.equal(state.campaignConcept.generatedBy, 'local-storyteller')
  assert.ok(state.scene.location.length > 2)
  assert.ok(state.messages[0].text.length > 20)
})

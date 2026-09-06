import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertDirectorTransitionResult,
  buildDirectorTransitionCommands,
  directorTransitionFingerprint,
} from '../server/director-scene-transition.mjs'

function state(overrides = {}) {
  return {
    sessionCode: 'DIRECTOR-1',
    state_version: 7,
    players: [{ id: 'hero', x: 1, y: 1 }],
    merchants: [],
    scene: { title: 'Склеп', location: 'Склеп Норвин', objective: 'Найти выход', turn: 3, cells: [] },
    adventure: { chapter: 1, history: [], visitedLocations: ['Склеп Норвин'] },
    agentInteraction: {
      id: 'decision-1', type: 'vote', status: 'resolved', resolvedOptionId: 'go',
      options: [{ id: 'go', label: 'Идём дальше' }], votes: { hero: 'go' },
    },
    ...overrides,
  }
}

const urbanScene = {
  title: 'Глава 2 · Город Норвин',
  location: 'Город Норвин',
  theme: 'городские улицы',
  objective: 'Найти архив гильдии',
  seed: 'director-city',
  map: { layout: 'streets', width: 11, height: 9 },
}

test('Director строит атомарный batch SceneAdvanced + catalog merchant для города', () => {
  const planned = buildDirectorTransitionCommands({
    campaignId: 'DIRECTOR-1', action: '[РЕШЕНИЕ ГРУППЫ] Идём в город', state: state(), sceneArgs: urbanScene,
  })
  assert.deepEqual(planned.commands.map((command) => command.command_type), ['AdvanceTime', 'AdvanceScene', 'CreateMerchant'])
  assert.equal(planned.commands[1].request_fingerprint, planned.commands[2].request_fingerprint)
  assert.deepEqual(planned.commands[1].party_decision, { interaction_id: 'decision-1', resolved_option_id: 'go' })
  assert.deepEqual(planned.partyDecision, planned.commands[1].party_decision)
  assert.equal(planned.commands[2].merchant.location, 'Город Норвин')
  assert.ok(planned.commands[2].merchant.stock.every((item) => item.catalog_id.startsWith('srd_5_2_1:')))
  assert.equal(planned.shopIntent.action, 'create')
  assert.equal(planned.shopIntent.settlement_type, 'city')
})

test('отказ от задания едет тем же пакетом и с тем же отпечатком, что и переход', () => {
  const planned = buildDirectorTransitionCommands({
    campaignId: 'DIRECTOR-1',
    action: '[РЕШЕНИЕ ГРУППЫ] Уходим в «Серая чаща» и бросаем задание «Найти выход»',
    state: state(),
    sceneArgs: { title: 'Чаща', location: 'Серая чаща', theme: 'дикая местность', objective: 'Осмотреться', seed: 'forest-abandon' },
    abandonQuest: { id: 'quest:main', title: 'Найти выход' },
  })
  assert.deepEqual(planned.commands.map((command) => command.command_type), ['AdvanceTime', 'AdvanceScene', 'ResolveQuest'])
  assert.equal(planned.abandonedQuestId, 'quest:main')
  const resolve = planned.commands[2]
  assert.equal(resolve.outcome, 'abandoned')
  assert.equal(resolve.request_fingerprint, planned.fingerprint)
  assert.match(resolve.summary, /Склеп Норвин/u)
  assert.ok(resolve.next_objective.length > 0, 'развязка обязана назвать следующую цель')

  // Отказ без указанного задания не появляется: решение уйти само по себе нить
  // не закрывает.
  const withoutAbandon = buildDirectorTransitionCommands({
    campaignId: 'DIRECTOR-1', action: '[РЕШЕНИЕ ГРУППЫ] Уходим в чащу', state: state(),
    sceneArgs: { title: 'Чаща', location: 'Серая чаща', theme: 'дикая местность', seed: 'forest-abandon' },
  })
  assert.deepEqual(withoutAbandon.commands.map((command) => command.command_type), ['AdvanceTime', 'AdvanceScene'])
  assert.equal(withoutAbandon.abandonedQuestId, null)
})

test('чужой отказ от задания в пакете отклоняется как конфликт идемпотентности', () => {
  const fingerprint = directorTransitionFingerprint({ campaignId: 'DIRECTOR-1', action: 'уходим' })
  assert.throws(() => assertDirectorTransitionResult({
    mechanics: [
      { event_type: 'SceneAdvanced', payload: { request_fingerprint: fingerprint } },
      { event_type: 'QuestResolved', payload: { outcome: 'abandoned', request_fingerprint: 'другой-запрос' } },
    ],
  }, fingerprint), (error) => error.code === 'IDEMPOTENCY_CONFLICT')

  // Развязка по заполненным часам приходит отдельным коммитом автономного
  // контура и отпечатка перехода не несёт — её проверка не касается.
  assert.doesNotThrow(() => assertDirectorTransitionResult({
    mechanics: [
      { event_type: 'SceneAdvanced', payload: { request_fingerprint: fingerprint } },
      { event_type: 'QuestResolved', payload: { outcome: 'success' } },
    ],
  }, fingerprint))
})

test('wilderness transition does not create a stationary shop', () => {
  const planned = buildDirectorTransitionCommands({
    campaignId: 'DIRECTOR-1', action: '[РЕШЕНИЕ ГРУППЫ] Идём в лес', state: state(),
    sceneArgs: { title: 'Чаща', location: 'Серая чаща', theme: 'дикая местность', seed: 'forest' },
  })
  assert.deepEqual(planned.commands.map((command) => command.command_type), ['AdvanceTime', 'AdvanceScene'])
  assert.equal(planned.shopProposal, null)
})

test('commerce action none with a city profile cannot reclassify a forest as settlement', () => {
  const planned = buildDirectorTransitionCommands({
    campaignId: 'DIRECTOR-1', action: '[РЕШЕНИЕ ГРУППЫ] Идём в чащу', state: state(),
    sceneArgs: { title: 'Чаща', location: 'Серая чаща', theme: 'дикая местность', seed: 'forest-none-city' },
    shopIntent: {
      action: 'none', settlement_type: 'city', theme: 'general', budget_cp: 50_000,
      reason: 'Торговая точка не запрашивается.',
    },
  })
  assert.deepEqual(planned.commands.map((command) => command.command_type), ['AdvanceTime', 'AdvanceScene'])
  assert.equal(planned.commands[1].scene_args.scene_kind, 'wilderness')
  assert.equal(planned.commands[1].scene_args.settlement_type, null)
  assert.equal(planned.commands[1].scene_commerce.action, 'none')
  assert.equal(planned.commands[1].scene_commerce.outcome, 'not-requested')
  assert.equal(planned.commands[1].scene_commerce.merchant_id, null)
})

test('inconsistent create intent cannot provision an outpost shop in a forest scene', () => {
  const planned = buildDirectorTransitionCommands({
    campaignId: 'DIRECTOR-1', action: '[РЕШЕНИЕ ГРУППЫ] Уходим в лес', state: state(),
    sceneArgs: { title: 'Лесная тропа', location: 'Серая чаща', theme: 'дикая местность', seed: 'forest-create-outpost' },
    shopIntent: {
      action: 'create', settlement_type: 'outpost', theme: 'provisions', budget_cp: 12_000,
      reason: 'Директор ошибочно запросил заставу.',
    },
  })
  assert.deepEqual(planned.commands.map((command) => command.command_type), ['AdvanceTime', 'AdvanceScene'])
  assert.equal(planned.shopIntent.action, 'none')
  assert.equal(planned.shopProposal, null)
  assert.equal(planned.commands[1].scene_args.scene_kind, 'wilderness')
  assert.equal(planned.commands[1].scene_args.settlement_type, null)
  assert.equal(planned.commands[1].scene_commerce.outcome, 'not-requested')
})

test('revisit reuses the merchant at that location without resetting stock', () => {
  const merchant = { id: 'norvin-shop', location: '  ГОРОД   НОРВИН  ', stock: [{ stock_id: 'rope', quantity: 1 }] }
  const planned = buildDirectorTransitionCommands({
    campaignId: 'DIRECTOR-1', action: '[РЕШЕНИЕ ГРУППЫ] Возвращаемся в город',
    state: state({ merchants: [merchant] }), sceneArgs: urbanScene,
  })
  assert.deepEqual(planned.commands.map((command) => command.command_type), ['AdvanceTime', 'AdvanceScene'])
  assert.equal(planned.existingMerchantId, merchant.id)
  assert.equal(planned.commands[1].scene_commerce.outcome, 'reused')
})

test('semantic fingerprint is stable for whitespace but changes with destination', () => {
  const first = directorTransitionFingerprint({ campaignId: 'DIRECTOR-1', action: '  Идём   в город ' })
  const retry = directorTransitionFingerprint({ campaignId: 'DIRECTOR-1', action: 'Идём в город' })
  const conflict = directorTransitionFingerprint({ campaignId: 'DIRECTOR-1', action: 'Идём в лес' })
  assert.equal(first, retry)
  assert.notEqual(first, conflict)
})

test('shop seed is bound to the resolved decision, not caller-controlled action suffixes', () => {
  const input = {
    campaignId: 'DIRECTOR-1',
    state: state(),
    sceneArgs: urbanScene,
    shopIntent: { action: 'create', settlement_type: 'city', theme: 'general', budget_cp: 20_000 },
    partyDecision: { interaction_id: 'vote-stable', resolved_option_id: 'city' },
  }
  const first = buildDirectorTransitionCommands({ ...input, action: '[РЕШЕНИЕ ГРУППЫ] Идём в город nonce-a' })
  const second = buildDirectorTransitionCommands({ ...input, action: '[РЕШЕНИЕ ГРУППЫ] Идём в город nonce-b' })
  assert.notEqual(first.fingerprint, second.fingerprint)
  assert.equal(first.decisionFingerprint, second.decisionFingerprint)
  assert.deepEqual(first.shopProposal, second.shopProposal)
})

test('result fingerprint rejects an idempotency collision', () => {
  const fingerprint = 'a'.repeat(64)
  assert.equal(assertDirectorTransitionResult({ mechanics: [{
    event_type: 'SceneAdvanced', payload: { request_fingerprint: fingerprint },
  }] }, fingerprint).mechanics.length, 1)
  assert.throws(() => assertDirectorTransitionResult({ mechanics: [{
    event_type: 'SceneAdvanced', payload: { request_fingerprint: 'b'.repeat(64) },
  }] }, fingerprint), (error) => error.code === 'IDEMPOTENCY_CONFLICT')
})

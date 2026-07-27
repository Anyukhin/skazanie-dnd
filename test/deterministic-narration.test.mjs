// Общий контракт детерминированных рассказчиков. До 2026-07-27 контракта не
// было вовсе: три модуля с разными сигнатурами, три обёртки в оркестраторе и
// дважды повторённая лестница `?:`, которую приходилось править в двух местах.
// AGENTS.md §4 держал это незакрытым долгом и просил не расширять.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NARRATOR_PRIORITY,
  assertNarratorContract,
  deterministicNarratorFor,
  deterministicNarrators,
  registerDeterministicNarrator,
  renderDeterministicNarration,
} from '../server/deterministic-narration.mjs'
import '../server/scene-narration.mjs'
import '../server/merchant-narration.mjs'
import '../server/encounter-narration.mjs'
import { combatNarrator } from '../server/combat-narration.mjs'

const event = (type, payload = {}) => ({ event_type: type, payload })

test('каждый зарегистрированный рассказчик удовлетворяет контракту', () => {
  const narrators = deterministicNarrators()
  assert.ok(narrators.length >= 3, `рассказчиков найдено ${narrators.length}`)
  for (const narrator of narrators) assertNarratorContract(narrator)
  assert.equal(new Set(narrators.map((narrator) => narrator.id)).size, narrators.length, 'идентификаторы обязаны быть уникальны')
})

test('приоритет задан числом, а не порядком импортов', () => {
  const order = deterministicNarrators().map((narrator) => narrator.id)
  assert.deepEqual(order, ['scene', 'merchant', 'encounter'])
  const priorities = deterministicNarrators().map((narrator) => narrator.priority)
  assert.deepEqual([...priorities].sort((left, right) => left - right), priorities)
})

test('выбор рассказчика повторяет прежнюю лестницу приоритетов', () => {
  assert.equal(deterministicNarratorFor([event('SceneAdvanced')])?.id, 'scene')
  assert.equal(deterministicNarratorFor([event('MerchantPurchaseCompleted')])?.id, 'merchant')
  assert.equal(deterministicNarratorFor([event('EncounterCreated')])?.id, 'encounter')
  // Смена сцены перекрывает торговлю — так было и до контракта.
  assert.equal(deterministicNarratorFor([event('MerchantPurchaseCompleted'), event('SceneAdvanced')])?.id, 'scene')
  assert.equal(deterministicNarratorFor([event('AttackResolved')]), null)
  assert.equal(deterministicNarratorFor([]), null)
})

test('контракт отвергает неполного рассказчика', () => {
  const valid = { id: 'x', priority: 1, promptVersion: 'x/v1', provider: 'x', matches: () => false, narrate: () => null }
  assertNarratorContract(valid)
  for (const [field, broken] of [
    ['id', { ...valid, id: '' }],
    ['priority', { ...valid, priority: 'высокий' }],
    ['matches', { ...valid, matches: 'да' }],
    ['suggestions', { ...valid, suggestions: [] }],
  ]) assert.throws(() => assertNarratorContract(broken), TypeError, `${field} должен проверяться`)

  assert.throws(() => registerDeterministicNarrator({ ...valid, id: 'scene' }), TypeError, 'повторный id обязан отвергаться')
})

test('рендер подставляет запасной текст и не выдумывает подсказок', () => {
  const narrator = { id: 'y', priority: 1, promptVersion: 'y/v1', provider: 'y', matches: () => true, narrate: () => null }
  const rendered = renderDeterministicNarration(narrator, { events: [], state: {}, fallbackNarration: 'запас' })
  assert.equal(rendered.narration, 'запас')
  assert.deepEqual(rendered.suggestions, [])
  assert.equal(rendered.prompt_version, 'y/v1')
  assert.equal(rendered.provider, 'y')
})

// Боевой текст объявлен по контракту, но в реестр не входит намеренно: реестром
// пользуется game-orchestrator, а боевой текст живут маршруты index.mjs.
test('боевой рассказчик соответствует контракту и в реестр не входит', () => {
  assertNarratorContract(combatNarrator)
  assert.equal(combatNarrator.priority, NARRATOR_PRIORITY.combat)
  assert.equal(deterministicNarrators().some((narrator) => narrator.id === 'combat'), false)
})

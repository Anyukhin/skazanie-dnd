import assert from 'node:assert/strict'
import test from 'node:test'
import { isAdventureContinuation, isDirectorPartyDecision } from '../src/director-continuation.mjs'

test('явная просьба продолжить историю доступна через свободный ввод', () => {
  for (const text of ['продолжим', 'Продолжим!', ' Продолжить  приключение. ', 'продолжаем историю', 'продолжить историю']) {
    assert.equal(isAdventureContinuation(text), true, text)
  }
})

test('Режиссёр не перехватывает действие героя, вопрос, обсуждение или реплику NPC', () => {
  for (const text of ['атакую гоблина', 'продолжим разговор с Аресом', 'продолжим идти на север', 'не продолжим', 'что дальше?', 'продолжим?', 'дальше', '', null]) {
    assert.equal(isAdventureContinuation(text), false, String(text))
  }
  assert.equal(isAdventureContinuation('продолжим', { npcId: 'ares' }), false)
  assert.equal(isAdventureContinuation('продолжим', { requestKind: 'question' }), false)
  assert.equal(isAdventureContinuation('продолжим', { requestKind: 'discussion' }), false)
})

test('маршрут продолжения различает обычное решение и голосование Режиссёра', () => {
  assert.equal(isDirectorPartyDecision({ id: 'autonomy-test', type: 'vote' }), true)
  assert.equal(isDirectorPartyDecision({ id: 'quest-acceptance-test', type: 'vote' }), false)
  assert.equal(isDirectorPartyDecision({ id: 'autonomy-test', type: 'roll' }), false)
  assert.equal(isDirectorPartyDecision(null), false)
})

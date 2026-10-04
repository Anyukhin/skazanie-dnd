import assert from 'node:assert/strict'
import test from 'node:test'
import { awaitsDecisionContinuation, continuesOnwardRoute, isAdventureContinuation, isDirectorPartyDecision } from '../src/director-continuation.mjs'

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

test('«продолжим» после принятого решения продолжает именно его, а не спрашивает Режиссёра', () => {
  // Плейтест 2026-10-03: отряд проголосовал за дамбу, «продолжим» в строке
  // ввода дало «пока ничего не меняется», а переход открывала только кнопка.
  assert.equal(awaitsDecisionContinuation({ status: 'resolved', resolvedOptionId: 'option-1' }), true)
  assert.equal(awaitsDecisionContinuation({ status: 'open', resolvedOptionId: null }), false)
  assert.equal(awaitsDecisionContinuation({ status: 'resolved', resolvedOptionId: null }), false)
  // Отказ от задания и её принятие исполняет сервер своим путём.
  assert.equal(awaitsDecisionContinuation({ status: 'resolved', resolvedOptionId: 'yes', questAbandonment: {} }), false)
  assert.equal(awaitsDecisionContinuation({ status: 'resolved', resolvedOptionId: 'yes', questAcceptance: {} }), false)
  // Исполненное решение сервер снимает: повторного перехода не будет.
  assert.equal(awaitsDecisionContinuation(null), false)
})

test('«продолжим» на промежуточной точке маршрута уходит заявкой, а не Режиссёру', () => {
  // Плейтест 2026-10-04, SE-11: в Айрской башне «продолжим» дало «Пока ничего
  // не меняется», путь продолжила только кнопка «Решение группы». Голосование
  // ухода к следующему пункту открывает сервер из обычной заявки.
  const tower = { location: 'Айрская башня', objective: 'Продолжить путь из Айрская башня к «Дормар»' }
  for (const text of ['продолжим', 'Продолжаем путь', 'идём дальше']) assert.equal(continuesOnwardRoute(text, tower), true, text)
  assert.equal(continuesOnwardRoute('продолжим приключение', tower), false, 'просьба к Режиссёру остаётся его')
  assert.equal(continuesOnwardRoute('продолжим', { location: 'Айрская башня', objective: 'Найти курьера' }), false)
  assert.equal(continuesOnwardRoute('продолжим', { ...tower, location: 'Дормар' }), false, 'устаревшая цель в конечной точке никуда не зовёт')
  assert.equal(continuesOnwardRoute('продолжим', tower, { requestKind: 'question' }), false)
  assert.equal(continuesOnwardRoute('продолжим', tower, { npcId: 'mira' }), false)
})

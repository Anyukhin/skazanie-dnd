import assert from 'node:assert/strict'
import test from 'node:test'

import { compileClientModules } from './kit/client-ts.mjs'

/**
 * Предпросмотр хода (`src/move-preview.ts`): нить маршрута вместо номера на
 * каждой клетке, контур досягаемости и место атаки по возможности. Модуль без
 * зависимостей, поэтому собирается в одиночку.
 */

const { modules: [preview] } = await compileClientModules(['src/move-preview.ts'])

/** Числа из строки пути, чтобы сверять точки, а не форматирование. */
const numbers = (d) => (d.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number)

test('нить идёт через центры клеток, прямые шаги сливаются, поворот скруглён', () => {
  const start = { x: 1, y: 1 }
  const path = [{ x: 2, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 2 }, { x: 3, y: 3 }]
  const d = preview.moveRoutePath({ start, path })
  assert.ok(d.startsWith('M1.5 1.5'), d)
  assert.ok(d.endsWith('L3.5 3.5'), d)
  // Один поворот — одна дуга; промежуточная клетка прямого участка не рвёт линию.
  assert.equal((d.match(/Q/gu) ?? []).length, 1, d)
  assert.doesNotMatch(d, /L2\.5 1\.5/u)
  assert.equal(preview.moveRoutePath({ start, path: [] }), '', 'без шагов нити нет')
})

test('трудная местность отмечает только шаги, которые в неё входят', () => {
  const d = preview.moveDifficultPath({ start: { x: 0, y: 0 }, path: [{ x: 1, y: 0 }, { x: 2, y: 0, difficult: true }, { x: 3, y: 0 }] })
  assert.deepEqual(numbers(d), [1.5, 0.5, 2.5, 0.5])
})

test('контур досягаемости обводит область вместе с клеткой фишки и только по краю', () => {
  // Крест вокруг (1,1): фишка в центре и четыре соседа.
  const reach = ['0,1', '2,1', '1,0', '1,2']
  const d = preview.moveReachOutline({ start: { x: 1, y: 1 }, reach })
  const segments = d.split('M').filter(Boolean)
  // У креста из пяти клеток 12 внешних рёбер; рёбра между центром и соседями внутренние.
  assert.equal(segments.length, 12, d)
  assert.equal(preview.moveReachOutline({ start: { x: 1, y: 1 }, reach: [] }), '', 'вне боя контура нет')
  assert.equal(preview.moveReachFill({ start: { x: 1, y: 1 }, reach }).split('Z').filter((part) => part.trim()).length, 5)
})

test('атака по возможности — на шаге, который уводит из досягаемости врага', () => {
  const enemy = { x: 3, y: 1 }
  const threatened = (point) => Math.max(Math.abs(point.x - enemy.x), Math.abs(point.y - enemy.y)) <= 1
  const start = { x: 2, y: 1 }
  const away = [{ x: 1, y: 1 }, { x: 0, y: 1 }]
  assert.deepEqual(preview.moveRiskPoint({ start, path: away }, threatened), { x: 1.5, y: 1 })
  // Обход вдоль врага: выход из угрозы случается позже, на третьем шаге.
  const around = [{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 3 }]
  assert.deepEqual(preview.moveRiskPoint({ start, path: around }, threatened), { x: 3, y: 2.5 })
  assert.equal(preview.moveRiskPoint({ start, path: [{ x: 2, y: 2 }] }, threatened), null, 'остался рядом — атаки нет')
})

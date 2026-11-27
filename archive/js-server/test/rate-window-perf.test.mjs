import test from 'node:test'
import assert from 'node:assert/strict'
import { RATE_WINDOW_MS, SlidingWindowCounter } from '../server/rate-window.mjs'

// Пределы частоты входа и дорогих запросов (`server/rate-window.mjs`): уборка
// истёкших ключей не меняет ни одного ответа «превышено / не превышено».

function clockCounter(options = {}) {
  let now = 1_000_000
  const counter = new SlidingWindowCounter({ now: () => now, ...options })
  return { counter, advance: (ms) => { now += ms } }
}

test('предел срабатывает внутри окна и отпускает после него', () => {
  const { counter, advance } = clockCounter()
  assert.equal(counter.hit('login:1.2.3.4', 2), false)
  assert.equal(counter.hit('login:1.2.3.4', 2), false)
  assert.equal(counter.hit('login:1.2.3.4', 2), true, 'третий запрос сверх предела 2')
  assert.equal(counter.hit('login:5.6.7.8', 2), false, 'ключи независимы')
  advance(RATE_WINDOW_MS - 1)
  assert.equal(counter.hit('login:1.2.3.4', 2), true, 'отметки ещё внутри окна')
  advance(RATE_WINDOW_MS)
  assert.equal(counter.hit('login:1.2.3.4', 2), false, 'окно прошло — счёт заново')
})

test('ключи с истёкшими отметками удаляются, живые — никогда', () => {
  const { counter, advance } = clockCounter()
  for (let index = 0; index < 50; index += 1) counter.hit(`old-${index}`, 10)
  assert.equal(counter.size, 50)
  advance(RATE_WINDOW_MS / 2)
  counter.hit('alive', 1)
  advance(RATE_WINDOW_MS / 2)
  // Окно прошло с последней уборки: следующий запрос убирает истёкшие ключи.
  assert.equal(counter.hit('alive', 1), true, 'живой ключ сохранил счёт')
  assert.equal(counter.size, 1)
})

test('карта, переросшая порог, убирается без ожидания окна и не обходится на каждом запросе', () => {
  const window = RATE_WINDOW_MS
  const { counter, advance } = clockCounter({ pruneAboveSize: 4 })
  advance(window * 0.9)
  for (let index = 0; index < 4; index += 1) counter.hit(`burst-${index}`, 5)
  advance(window * 0.1)
  // Уборка по времени: истёкших ещё нет, порог отодвигается до 2 × 4.
  counter.hit('tick', 5)
  assert.equal(counter.size, 5)
  assert.equal(counter.sizePruneAt, 8)
  advance(window * 0.95)
  for (let index = 0; index < 5; index += 1) counter.hit(`fresh-${index}`, 5)
  assert.equal(counter.size, 6, 'карта переросла порог раньше окна — истёкшие ключи убраны')
  assert.equal(counter.hit('tick', 5), false)
  assert.equal(counter.hit('tick', 1), true, 'живой ключ уборка не тронула')

  // Все ключи живые: уборка ничего не находит и отодвигает порог.
  const live = clockCounter({ pruneAboveSize: 4 })
  for (let index = 0; index < 6; index += 1) live.counter.hit(`live-${index}`, 5)
  assert.equal(live.counter.size, 6)
  assert.ok(live.counter.sizePruneAt >= 10, `порог ${live.counter.sizePruneAt}`)
})

test('уборка не выбрасывает отметки, живые для более широкого окна', () => {
  const { counter, advance } = clockCounter({ windowMs: 1_000 })
  advance(59_000)
  counter.hit('wide', 1, 60_000)
  advance(2_000)
  counter.hit('other', 1)
  assert.equal(counter.hit('wide', 1, 60_000), true, 'отметка широкого окна пережила уборку')
})

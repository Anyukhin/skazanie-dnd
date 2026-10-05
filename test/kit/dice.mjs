// Детерминированные кости для тестов движка. Сервер бросает только через
// `DiceService` (server/dice-service.mjs); тест подменяет у него генератор,
// фабрику id броска и часы.
//
// Основная форма повторяла себя почти в сотне файлов:
//   new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `x-${++id}`, now: () => '…' })
// `dice()` ниже — ровно она: последовательность кончилась — RangeError,
// значение вне диапазона кости — RangeError. Так тест видит лишний бросок,
// а не получает тихую подстановку.
import { DiceService, SequenceDiceRng } from '../../server/dice-service.mjs'

/** Момент по умолчанию для `now` у тестовых бросков. */
export const FIXED_NOW = '2026-07-26T12:00:00.000Z'

/**
 * Последовательная фабрика id: `prefix-1`, `prefix-2`, …
 *
 * @param {string} [prefix]
 * @returns {() => string}
 */
export function sequentialIds(prefix = 'test-roll') {
  let serial = 0
  return () => `${prefix}-${++serial}`
}

/**
 * Часы, которые всегда показывают один момент.
 *
 * @param {string} [iso]
 * @returns {() => string}
 */
export function fixedNow(iso = FIXED_NOW) {
  return () => iso
}

/**
 * @typedef {object} DiceOptions
 * @property {string} [prefix] префикс roll_id
 * @property {string} [now] ISO-время created_at
 * @property {() => string} [idFactory] своя фабрика id вместо `prefix-N`
 */

/**
 * @param {{ randint(minimum: number, maximum: number): number }} rng
 * @param {DiceOptions} options
 */
function service(rng, { prefix = 'test-roll', now = FIXED_NOW, idFactory } = {}) {
  return new DiceService({ rng, idFactory: idFactory ?? sequentialIds(prefix), now: fixedNow(now) })
}

/**
 * Броски строго по списку. Лишний бросок или значение вне грани — RangeError.
 *
 * @param {number[]} [values]
 * @param {DiceOptions} [options]
 * @returns {DiceService}
 */
export function dice(values = [], options = {}) {
  return service(new SequenceDiceRng(values), options)
}

/**
 * Каждая кость выпадает максимумом (d20 → 20, d6 → 6).
 *
 * @param {DiceOptions} [options]
 * @returns {DiceService}
 */
export function maxDice(options = {}) {
  return service({ randint: (_minimum, maximum) => maximum }, options)
}

/**
 * Каждая кость выпадает минимумом (1).
 *
 * @param {DiceOptions} [options]
 * @returns {DiceService}
 */
export function minDice(options = {}) {
  return service({ randint: (minimum) => minimum }, options)
}

/**
 * Каждая кость выпадает одним значением, прижатым к грани: `fixedDice(15)`
 * даёт 15 на d20 и 6 на d6.
 *
 * @param {number} value
 * @param {DiceOptions} [options]
 * @returns {DiceService}
 */
export function fixedDice(value, options = {}) {
  return service({ randint: (minimum, maximum) => Math.min(maximum, Math.max(minimum, value)) }, options)
}

/**
 * Как `dice()`, но после конца списка повторяет `fallback` (прижатый к грани)
 * вместо отказа. Для сценариев, где число бросков противника заранее неизвестно.
 *
 * @param {number[]} values
 * @param {number} fallback
 * @param {DiceOptions} [options]
 * @returns {DiceService}
 */
export function diceThen(values, fallback, options = {}) {
  const queue = [...values]
  return service({
    randint(minimum, maximum) {
      if (!queue.length) return Math.min(maximum, Math.max(minimum, fallback))
      const value = Number(queue.shift())
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(`Тестовое значение ${value} не входит в диапазон ${minimum}..${maximum}`)
      }
      return value
    },
  }, options)
}

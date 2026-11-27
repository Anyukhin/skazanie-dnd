/**
 * Сид для костей сервера в прогоне `eval/astohan-playthrough.mjs`.
 *
 * Подменяет только генератор `CryptoDiceRng` детерминированным mulberry32,
 * чтобы офлайн-прогон с тем же `--seed` повторял те же броски. Модель, время
 * запросов и порядок ходов NPC прогон не фиксирует, поэтому повтор точен лишь
 * без модели. Работает только в тестовом процессе на временном хранилище.
 */
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'

import { CryptoDiceRng } from '../server/dice-service.mjs'

const seed = Number(process.env.PLAYTEST_DICE_SEED)
const storageDir = resolve(String(process.env.DND_STORAGE_DIR ?? ''))
if (process.env.NODE_ENV !== 'test' || dirname(storageDir) !== resolve(tmpdir()) || !Number.isSafeInteger(seed)) {
  throw new Error('Сид костей допустим только с NODE_ENV=test, временным DND_STORAGE_DIR и целым PLAYTEST_DICE_SEED')
}

let stateValue = seed >>> 0
function next() {
  stateValue = (stateValue + 0x6D2B79F5) >>> 0
  let value = stateValue
  value = Math.imul(value ^ (value >>> 15), value | 1)
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}

CryptoDiceRng.prototype.randint = function seededRandint(minimum, maximum) {
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || maximum < minimum) {
    throw new RangeError('Некорректный диапазон генератора случайных чисел')
  }
  return minimum + Math.floor(next() * (maximum - minimum + 1))
}

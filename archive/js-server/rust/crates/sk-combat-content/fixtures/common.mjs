// Общие помощники генераторов эталонов sk-combat-content.
//
// Крупный выход (сотни карточек заклинаний с описаниями) хранится хешем:
// первые 16 hex-знаков SHA-256 от `JSON.stringify(value)` — Rust сравнивает
// тот же хеш от своей строки JSON, то есть вместе с порядком ключей и
// записью чисел. `undefined` записывается строкой UNDEFINED.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

export const UNDEFINED = '\u0000undefined'

export const encode = (value) => (value === undefined ? UNDEFINED : value)

/** Короткий хеш JSON-строки значения; `undefined` — UNDEFINED. */
export function hash(value) {
  if (value === undefined) return UNDEFINED
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

/** Список карточек как пары `[id, хеш]`: расхождение видно поштучно. */
export const cardHashes = (cards) => cards.map((card) => [card.id, hash(card)])

/** Вызов с записью исключения вместо результата. */
export function attempt(fn) {
  try {
    return { result: encode(fn()) }
  } catch (error) {
    return { error: { name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) } }
  }
}

/** Детерминированный ГПСЧ mulberry32. */
export function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Записать эталон: секции по случаю на строку, чтобы diff читался. */
export function writeFixture(url, sections) {
  const lines = Object.entries(sections).map(([key, value]) => (Array.isArray(value)
    ? `${JSON.stringify(key)}: [\n${value.map((item) => JSON.stringify(item)).join(',\n')}\n]`
    : `${JSON.stringify(key)}: ${JSON.stringify(value)}`))
  writeFileSync(url, `{\n${lines.join(',\n')}\n}\n`)
  const counts = Object.entries(sections).filter(([, value]) => Array.isArray(value)).map(([key, value]) => `${key} ${value.length}`)
  console.log(`${url.pathname.split('/').at(-1)}: ${counts.join(', ')}`)
}

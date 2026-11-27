// Общие помощники генераторов эталонов sk-buildings.
//
// Крупный выход (сериализованные карты) хранится хешем: SHA-256 строки
// `JSON.stringify(serializeTacticalMap(map))` — Rust сравнивает тот же хеш от
// своей строки JSON, то есть вместе с порядком ключей и записью чисел.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

/** SHA-256 строки `JSON.stringify(value)`. */
export function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Снимок значения через JSON: `undefined` выпадает, как на границе Rust. */
export const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

/** Исключение вызова в форме эталона. */
export const errorOf = (error) => ({ name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) })

/** Детерминированный ГПСЧ mulberry32 (тот же в тестах Rust). */
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

/** Помощники случайного выбора поверх ГПСЧ. */
export function picker(random) {
  const int = (n) => Math.floor(random() * n)
  return {
    int,
    pick: (items) => items[int(items.length)],
    chance: (p) => random() < p,
  }
}

/** Записать эталон: секции по случаю на строку, чтобы diff читался. */
export function writeFixture(url, sections, { gzip = false } = {}) {
  const lines = Object.entries(sections).map(([key, value]) => (Array.isArray(value)
    ? `${JSON.stringify(key)}: [\n${value.map((item) => JSON.stringify(item)).join(',\n')}\n]`
    : `${JSON.stringify(key)}: ${JSON.stringify(value)}`))
  const text = `{\n${lines.join(',\n')}\n}\n`
  writeFileSync(url, gzip ? gzipSync(text, { level: 9 }) : text)
  const counts = Object.entries(sections).filter(([, value]) => Array.isArray(value)).map(([key, value]) => `${key} ${value.length}`)
  console.log(`${url.pathname.split('/').at(-1)}: ${counts.join(', ')}`)
}

// Общие помощники генераторов эталонов sk-props.
//
// Карта на входе хранится сериализованной (`serializeTacticalMap`), на выходе —
// SHA-256 от `JSON.stringify(serializeTacticalMap(map))`: Rust сравнивает тот же
// хеш от своей строки JSON, то есть вместе с порядком ключей и записью чисел.
// Значения, которых нет в JSON (бесконечность, NaN, undefined), в аргументах
// пишутся объектом `{"$js": "Infinity"}` и т. п.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

import * as t from '../../../../server/tactical-map.mjs'

/** SHA-256 строки `JSON.stringify(value)`. */
export function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Хеш карты так, как его считает Rust: по сериализованной форме. */
export function mapHash(map) {
  return hash(t.serializeTacticalMap(map))
}

/** Карта, которую увидит Rust: чтение сериализованной формы. */
export function restore(serialized) {
  return t.deserializeTacticalMap(JSON.parse(JSON.stringify(serialized)))
}

/** Детерминированный ГПСЧ mulberry32. */
export function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export function encodeJs(value) {
  if (value === undefined) return { $js: 'undefined' }
  if (typeof value === 'number' && !Number.isFinite(value)) return { $js: String(value) }
  if (Array.isArray(value)) return value.map(encodeJs)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeJs(item)]))
  return value
}

export function decodeJs(value) {
  if (Array.isArray(value)) return value.map(decodeJs)
  if (value && typeof value === 'object') {
    if (typeof value.$js === 'string') return value.$js === 'undefined' ? undefined : Number(value.$js)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeJs(item)]))
  }
  return value
}

/** Вызов с записью исключения вместо результата. */
export function attempt(fn) {
  try {
    return { result: fn() }
  } catch (error) {
    return { error: { name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) } }
  }
}

/**
 * Прогон функции над картой: хеш карты после, ответ (без самой карты) и
 * отказ. `result === map` пишется строкой `$map`.
 */
export function runOn(map, fn) {
  const outcome = attempt(() => fn(map))
  const record = { hash: mapHash(map), props: map.props.length }
  if (outcome.error) record.error = outcome.error
  else record.result = outcome.result === map ? '$map' : encodeJs(outcome.result)
  return record
}

/** Записать эталон: секции по случаю на строку, чтобы diff читался. */
export function writeFixture(url, sections, { gzip = false } = {}) {
  const lines = Object.entries(sections).map(([key, value]) => (Array.isArray(value)
    ? `${JSON.stringify(key)}: [\n${value.map((item) => JSON.stringify(item)).join(',\n')}\n]`
    : `${JSON.stringify(key)}: ${JSON.stringify(value)}`))
  const text = `{\n${lines.join(',\n')}\n}\n`
  writeFileSync(url, gzip ? gzipSync(text, { level: 9 }) : text)
  const counts = Object.entries(sections).filter(([, value]) => Array.isArray(value)).map(([key, value]) => `${key} ${value.length}`)
  console.log(`${url.pathname.split('/').at(-1)}: ${counts.join(', ')} (${text.length} байт${gzip ? ' до сжатия' : ''})`)
}

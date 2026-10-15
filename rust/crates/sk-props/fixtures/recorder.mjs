// Запись вызовов расстановки внутри настоящих генераторов сцен.
//
// Генераторы JS (`building-generator`, `level-generator`, `scene-themes`,
// `scene-program-layout`) импортируют `prop-placement.mjs` и
// `scene-dressing.mjs`. Перехват разрешения модулей (`registerHooks`)
// подменяет эти два модуля обёртками `recorder-*.mjs`: обёртка снимает
// сериализованную карту до вызова, аргументы и карту после, а сам вызов
// отдаёт настоящему модулю (импорт с `?real`, его перехват не трогает).
//
// Так эталон проверяет ровно функции sk-props на тех картах, которые им
// дают генераторы, не перенося сами генераторы.
import { registerHooks } from 'node:module'

import { serializeTacticalMap } from '../../../../server/tactical-map.mjs'

/** @type {Array<{fn: string, before: object, args: unknown, after: object, result: unknown}>} */
export const calls = []

let recording = true

/** Включить или выключить запись (повторный прогон эталона пишет не нужно). */
export function setRecording(value) {
  recording = value
}

const REDIRECTS = {
  '/server/prop-placement.mjs': new URL('./recorder-prop-placement.mjs', import.meta.url).href,
  '/server/scene-dressing.mjs': new URL('./recorder-scene-dressing.mjs', import.meta.url).href,
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    for (const [suffix, target] of Object.entries(REDIRECTS)) {
      if (resolved.url.endsWith(suffix) && !String(context.parentURL ?? '').includes('/fixtures/')) return { ...resolved, url: target }
    }
    return resolved
  },
})

/**
 * Значения, которых нет в JSON: бесконечность, NaN, undefined и функции.
 * Пишутся объектом `{"$js": "Infinity"}` и т. п.
 */
export function encodeArgs(value) {
  if (value === undefined) return { $js: 'undefined' }
  if (typeof value === 'number' && !Number.isFinite(value)) return { $js: String(value) }
  if (typeof value === 'function') return { $js: 'function' }
  if (value instanceof RegExp) return { $js: `regexp:${value.source}` }
  if (value instanceof Set) return { $js: 'set', items: [...value].map(encodeArgs) }
  if (Array.isArray(value)) return value.map(encodeArgs)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeArgs(item)]))
  return value
}

/** Обратное к `encodeArgs` для повтора вызова в JS. */
export function decodeArgs(value) {
  if (Array.isArray(value)) return value.map(decodeArgs)
  if (value && typeof value === 'object') {
    if (typeof value.$js === 'string') {
      if (value.$js === 'undefined') return undefined
      if (value.$js === 'set') return new Set(value.items.map(decodeArgs))
      return Number(value.$js)
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeArgs(item)]))
  }
  return value
}

/**
 * Обернуть функцию модуля: снимок карты до и после.
 * @param {string} name
 * @param {Function} fn
 */
export function wrap(name, fn) {
  return (map, ...args) => {
    if (!recording) return fn(map, ...args)
    const before = serializeTacticalMap(map)
    const encoded = encodeArgs(args)
    const result = fn(map, ...args)
    calls.push({ fn: name, before, args: encoded, after: serializeTacticalMap(map), result: encodeArgs(result === map ? '$map' : result) })
    return result
  }
}

// Общие помощники генераторов эталонов sk-npc-world.
//
// Эталон — таблицы поддеревьев и состояний (каждое хранится один раз) и случаи
// `{ fn, args, retention?, result | sha256 | error }`. Аргумент-состояние
// пишется ссылкой `{ "$state": i }`, крупное поддерево (карта, профили, вещи) —
// `{ "$value": j }`; Rust подставляет их обратно. JS исполняется на входе,
// прошедшем JSON, — то есть ровно на том, что увидит Rust.
//
// Результат: `undefined` — строка UNDEFINED, функция (ключ прототипа как id) —
// FUNCTION, крупное — SHA-256 строки `JSON.stringify`. Исключение —
// `{ name, code, message }`.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

export const UNDEFINED = '\u0000undefined'
export const FUNCTION = '\u0000function'
const RESULT_LIMIT = 1_000
const COMPACT_KEYS = ['map', 'profiles', 'inventories', 'placements', 'npcs', 'mechanics']
const COMPACT_MIN = 400

export const PROTOTYPE_KEYS = Object.getOwnPropertyNames(Object.prototype)

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const jsonReplacer = (_key, value) => (value instanceof Set ? [...value] : value)

/** Вход через JSON: то, что увидит Rust. */
export function viaJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value, jsonReplacer))
}

export function encodeResult(value, limit = RESULT_LIMIT) {
  if (value === undefined) return { result: UNDEFINED }
  if (typeof value === 'function') return { result: FUNCTION }
  const text = JSON.stringify(value, jsonReplacer)
  if (text === undefined) return { result: UNDEFINED }
  return text.length > limit ? { sha256: sha256(text) } : { result: JSON.parse(text) }
}

export const errorOf = (error) => ({ name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) })

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

export function chooser(random) {
  const int = (min, max) => min + Math.floor(random() * (max - min + 1))
  const pick = (list) => list[Math.floor(random() * list.length)]
  const chance = (p) => random() < p
  return { int, pick, chance }
}

/**
 * Писатель эталона.
 * @param {string} module имя JS-модуля
 * @param {(name: string) => string | null} [retentionNow] режим удержания на момент вызова
 */
export function fixtureWriter(module, retentionNow = () => null) {
  const values = []
  const valueIndex = new Map()
  const states = []
  const stateIndex = new Map()
  const labels = {}
  const cases = []
  const seen = new Set()
  const perFn = new Map()

  function valueRef(value) {
    const text = JSON.stringify(value)
    let index = valueIndex.get(text)
    if (index === undefined) {
      index = values.length
      values.push(JSON.parse(text))
      valueIndex.set(text, index)
    }
    return { $value: index }
  }

  /** Крупные повторяющиеся поддеревья (карта, профили, вещи) — ссылкой в таблицу. */
  function compact(value) {
    if (Array.isArray(value)) return value.map(compact)
    if (!value || typeof value !== 'object') return value
    // `Object.fromEntries`, а не присваивание: ключ `__proto__` остаётся полем.
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      const inner = compact(child)
      return [key, COMPACT_KEYS.includes(key) && inner && typeof inner === 'object' && JSON.stringify(inner).length >= COMPACT_MIN ? valueRef(inner) : inner]
    }))
  }

  /** Ссылка на состояние в таблице. */
  function stateRef(state, label = null) {
    const copy = compact(viaJson(state))
    const text = JSON.stringify(copy)
    let index = stateIndex.get(text)
    if (index === undefined) {
      index = states.length
      states.push(copy)
      stateIndex.set(text, index)
    }
    if (label) labels[label] = index
    return { $state: index }
  }

  /**
   * Записать вызов `fn(...args)`. `stateArgs` — индексы аргументов-состояний.
   * Повтор того же входа не записывается; `cap` ограничивает случаи функции.
   */
  function call(name, fn, args, { stateArgs = [], cap = Infinity, retention = retentionNow(), limit } = {}) {
    const plain = args.map(viaJson)
    const recorded = plain.map((arg, index) => (stateArgs.includes(index) && arg && typeof arg === 'object' ? stateRef(arg) : (arg === undefined ? UNDEFINED : compact(arg))))
    const key = sha256(JSON.stringify([name, recorded, retention]))
    if (seen.has(key)) return false
    if ((perFn.get(name) ?? 0) >= cap) return false
    seen.add(key)
    perFn.set(name, (perFn.get(name) ?? 0) + 1)
    const entry = { fn: name, args: recorded }
    if (retention && retention !== 'current') entry.retention = retention
    try {
      Object.assign(entry, encodeResult(fn(...plain), limit))
    } catch (error) {
      entry.error = errorOf(error)
    }
    cases.push(entry)
    return true
  }

  return {
    call,
    stateRef,
    cases,
    counts: perFn,
    write(url) {
      const lines = [
        `"module": ${JSON.stringify(module)}`,
        `"labels": ${JSON.stringify(labels)}`,
        `"values": [\n${values.map((value) => JSON.stringify(value)).join(',\n')}\n]`,
        `"states": [\n${states.map((state) => JSON.stringify(state)).join(',\n')}\n]`,
        `"cases": [\n${cases.map((entry) => JSON.stringify(entry)).join(',\n')}\n]`,
      ]
      writeFileSync(url, `{\n${lines.join(',\n')}\n}\n`)
      const size = lines.reduce((total, line) => total + line.length, 0)
      console.log(`${url.pathname.split('/').at(-1)}: поддеревьев ${values.length}, состояний ${states.length}, случаев ${cases.length}, ${(size / 1024 / 1024).toFixed(2)} МБ`)
      console.log([...perFn.entries()].map(([name, count]) => `${name} ${count}`).join(', '))
    },
  }
}

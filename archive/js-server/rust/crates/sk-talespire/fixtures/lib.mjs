// Общая часть генераторов эталонов sk-world-story.
//
// Эталон — таблицы `values` (крупные повторяющиеся поддеревья: концепция
// кампании, карта мира) и `states` (состояния) и случаи
// `{ fn, args, result | sha256 | error }`. Аргумент-состояние пишется ссылкой
// `{ "$state": i }`, крупное поддерево — `{ "$value": j }`; Rust подставляет их
// обратно. JS исполняется на входе, прошедшем JSON, — ровно на том, что
// увидит Rust. `undefined` — строка UNDEFINED; длинный результат — SHA-256
// строки `JSON.stringify`.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

export const UNDEFINED = '\u0000undefined'
export const PROTOTYPE_KEYS = Object.getOwnPropertyNames(Object.prototype)
export const DEFAULT_CORPUS = 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'
const RESULT_LIMIT = 400
const COMPACT_MIN = 400

export const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const replacer = (_key, value) => (value instanceof Set ? [...value] : value)

/** Вход через JSON: то, что увидит Rust. */
export function viaJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value, replacer))
}

export const same = (left, right) => {
  try {
    return JSON.stringify(left, replacer) === JSON.stringify(right, replacer)
  } catch {
    return false
  }
}

export function pickKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const result = {}
  for (const key of keys) if (Object.hasOwn(value, key)) result[key] = value[key]
  return result
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

export function chooser(random) {
  const int = (min, max) => min + Math.floor(random() * (max - min + 1))
  const pick = (list) => list[Math.floor(random() * list.length)]
  const chance = (p) => random() < p
  return { int, pick, chance }
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u
/** Есть ли в значении половина суррогатной пары: такую строку Rust не представит. */
export function hasLoneSurrogate(value) {
  if (typeof value === 'string') return LONE_SURROGATE.test(value)
  if (Array.isArray(value)) return value.some(hasLoneSurrogate)
  if (value && typeof value === 'object') return Object.entries(value).some(([key, item]) => LONE_SURROGATE.test(key) || hasLoneSurrogate(item))
  return false
}

export function encodeResult(value, limit = RESULT_LIMIT) {
  if (value === undefined) return { result: UNDEFINED }
  const text = JSON.stringify(value, replacer)
  if (text === undefined) return { result: UNDEFINED }
  return text.length > limit ? { sha256: sha256(text) } : { result: JSON.parse(text) }
}

export const errorOf = (error) => ({ name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) })

/**
 * Писатель эталона. `compactKeys` — ключи, чьи крупные поддеревья уходят в
 * таблицу `values`.
 */
export function fixtureWriter(module, compactKeys = ['campaignConcept', 'worldMap']) {
  const values = []
  const valueIndex = new Map()
  const states = []
  const stateIndex = new Map()
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

  function compact(value, depth = 0) {
    if (Array.isArray(value)) return value.map((item) => compact(item, depth + 1))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
      depth < 3 && compactKeys.includes(key) && child && typeof child === 'object' && JSON.stringify(child).length >= COMPACT_MIN ? valueRef(child) : compact(child, depth + 1)]))
  }

  function stateRef(state) {
    const copy = compact(viaJson(state))
    const text = JSON.stringify(copy)
    let index = stateIndex.get(text)
    if (index === undefined) {
      index = states.length
      states.push(copy)
      stateIndex.set(text, index)
    }
    return { $state: index }
  }

  /** Записать вызов `fn(...args)`; `stateArgs` — индексы аргументов-состояний. */
  function call(name, fn, args, { stateArgs = [], cap = Infinity, limit } = {}) {
    const plain = args.map(viaJson)
    if (hasLoneSurrogate(plain)) return false
    const recorded = plain.map((arg, index) => (arg === undefined ? UNDEFINED : stateArgs.includes(index) && arg && typeof arg === 'object' ? stateRef(arg) : arg))
    const key = sha256(JSON.stringify([name, recorded]))
    if (seen.has(key)) return false
    if ((perFn.get(name) ?? 0) >= cap) return false
    seen.add(key)
    perFn.set(name, (perFn.get(name) ?? 0) + 1)
    const entry = { fn: name, args: recorded }
    try {
      const result = fn(...plain)
      if (hasLoneSurrogate(viaJson(result) ?? null)) {
        return false
      }
      Object.assign(entry, encodeResult(result, limit))
    } catch (error) {
      entry.error = errorOf(error)
    }
    cases.push(entry)
    return true
  }

  return {
    call,
    counts: perFn,
    cases,
    write(url, extra = {}) {
      const lines = [
        `"module": ${JSON.stringify(module)}`,
        ...Object.entries(extra).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`),
        `"values": [\n${values.map((value) => JSON.stringify(value)).join(',\n')}\n]`,
        `"states": [\n${states.map((state) => JSON.stringify(state)).join(',\n')}\n]`,
        `"cases": [\n${cases.map((entry) => JSON.stringify(entry)).join(',\n')}\n]`,
      ]
      const body = `{\n${lines.join(',\n')}\n}\n`
      // Эталон в git — gzip: бюджет крейта ~10 МБ (rust/PORTING.md §6).
      writeFileSync(url, url.pathname.endsWith('.gz') ? gzipSync(body, { level: 9 }) : body)
      const size = lines.reduce((total, line) => total + line.length, 0)
      console.log(`${url.pathname.split('/').at(-1)}: поддеревьев ${values.length}, состояний ${states.length}, случаев ${cases.length}, ${(size / 1024 / 1024).toFixed(2)} МБ`)
      console.log([...perFn.entries()].map(([name, count]) => `${name} ${count}`).join(', '))
    },
  }
}

// ---------------------------------------------------------------------------
// Корпус паритета

/** Каталог корпуса: аргумент, `SK_WORLD_STORY_CORPUS`, либо известный путь; `null` — корпуса нет. */
export function corpusDir(argument) {
  const dir = argument ?? process.env.SK_WORLD_STORY_CORPUS ?? DEFAULT_CORPUS
  return dir && existsSync(join(dir, 'states')) ? dir : null
}

/** Записи корпуса по порядку файлов (`state` — хеш состояния «до»). */
export function* corpusRecords(dir) {
  for (const file of readdirSync(dir).filter((name) => name.startsWith('corpus-') && name.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        yield { file, ...JSON.parse(line) }
      } catch { /* битая строка корпуса */ }
    }
  }
}

export function corpusStateText(dir, hash) {
  try {
    return readFileSync(join(dir, 'states', `${hash}.json`), 'utf8')
  } catch {
    return null
  }
}

/** Кости по записи корпуса: те же результаты в том же порядке. */
export function replayDice(dice) {
  const queue = Array.isArray(dice) ? dice.slice() : []
  const next = (method) => {
    const entry = queue.shift()
    if (!entry) throw new Error(`корпус: бросков не хватило (${method})`)
    return entry.result
  }
  return { roll: () => next('roll'), rollD20: () => next('rollD20'), rollCheck: () => next('rollCheck') }
}

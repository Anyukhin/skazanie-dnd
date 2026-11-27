// Общая часть генераторов эталонов sk-world-story: корпус паритета, урезание
// состояний с проверкой исхода и запись перехваченных вызовов.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { viaJson } from './common.mjs'

export const DEFAULT_CORPUS = 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'

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

export function corpusState(dir, hash) {
  try {
    return JSON.parse(readFileSync(join(dir, 'states', `${hash}.json`), 'utf8'))
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

export const pickKeys = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const result = {}
  for (const key of keys) if (Object.hasOwn(value, key)) result[key] = value[key]
  return result
}

export const mapList = (value, fn) => (Array.isArray(value) ? value.map(fn) : value)

const same = (left, right) => {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function outcome(fn, args) {
  try {
    return { value: viaJson(fn(...args.map(viaJson))) }
  } catch (error) {
    return { error: String(error?.name) + String(error?.message) }
  }
}

/**
 * Перехватчик одного модуля. `fns` — `{ name: { fn, states: [индексы] } }`,
 * `strips` — урезания состояния от сильного к слабому. Аргумент-состояние
 * урезается, и JS исполняется на урезанном и полном входе; если исход
 * разошёлся, берётся следующее (более полное) урезание, в конце — полное.
 */
export function moduleCapture({ module, fns, strips, retentionMode, withRetentionMode, writer, limit = 1_500 }) {
  const captured = []
  const perFn = new Map()
  const stats = { stripped: 0, widened: 0, full: 0 }

  function prepare(name, args) {
    const spec = fns[name]
    const plain = args.map((arg) => viaJson(arg))
    if (!spec.states.length) return plain
    const expected = outcome(spec.fn, plain)
    for (const [level, strip] of strips.entries()) {
      const candidate = plain.map((arg, index) => (spec.states.includes(index) ? strip(arg, name) : arg))
      if (same(outcome(spec.fn, candidate), expected)) {
        if (level === 0) stats.stripped += 1
        else stats.widened += 1
        return candidate
      }
    }
    stats.full += 1
    return plain
  }

  function capture(fromModule, name, args) {
    if (fromModule !== module || !fns[name]) return
    if ((perFn.get(name) ?? 0) >= limit) return
    perFn.set(name, (perFn.get(name) ?? 0) + 1)
    try {
      captured.push({ name, retention: retentionMode(), args: prepare(name, args) })
    } catch { /* вход не сериализуется */ }
  }

  function record(name, args, options = {}) {
    const spec = fns[name]
    const prepared = prepare(name, args)
    return writer.call(name, spec.fn, prepared, { stateArgs: [...spec.states, ...(spec.refs ?? [])], ...options })
  }

  function flush(cap = Infinity) {
    for (const entry of captured.splice(0)) {
      const spec = fns[entry.name]
      const call = () => writer.call(entry.name, spec.fn, entry.args, { stateArgs: [...spec.states, ...(spec.refs ?? [])], cap, retention: entry.retention })
      if (entry.retention === 'legacy') withRetentionMode('legacy', call)
      else call()
    }
  }

  return { capture, record, flush, stats, perFn }
}

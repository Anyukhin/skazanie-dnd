// Общие помощники генераторов эталонов sk-character.
//
// Эталон — таблица крупных аргументов (каждый хранится один раз) и случаи
// `{ fn, args, result | sha256 | undefined | error }`. Крупный аргумент
// (состояние, герой, документ) пишется ссылкой `{ "$v": i }`, герой уже
// записанного состояния — `{ "$v": i, "path": ["players", 0] }`; `undefined`
// — `{ "$undefined": true }`. Результат длиннее RESULT_LIMIT — SHA-256 строки
// `JSON.stringify`. Исключение — `{ name, code, message }`, у `TypeError` —
// только имя (текст V8 Rust не повторяет).
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const RESULT_LIMIT = 400
const VALUE_MIN = 300
export const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const jsonReplacer = (_key, value) => (value instanceof Set ? [...value] : value)

export const UNDEFINED = { $undefined: true }

/** Вход через JSON: то, что увидит Rust. */
export function viaJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value, jsonReplacer))
}

export function errorOf(error) {
  if (error instanceof TypeError) return { name: 'TypeError' }
  return { name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) }
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
  const shuffle = (list) => {
    const copy = [...list]
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1))
      ;[copy[index], copy[other]] = [copy[other], copy[index]]
    }
    return copy
  }
  return { int, pick, chance, shuffle }
}

/** Писатель эталона. */
export function fixtureWriter() {
  const values = []
  const valueIndex = new Map()
  const cases = []
  const seen = new Set()
  const perFn = new Map()
  const perOutcomeCount = new Map()
  const childIndex = new Map()

  function registerChildren(index, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.players)) return
    value.players.forEach((player, position) => {
      const text = JSON.stringify(player)
      if (text && text.length >= VALUE_MIN && !childIndex.has(text)) childIndex.set(text, { $v: index, path: ['players', position] })
    })
  }

  function ref(value) {
    if (value === undefined) return UNDEFINED
    const text = JSON.stringify(value)
    if (!value || typeof value !== 'object' || text.length < VALUE_MIN) return value
    const child = childIndex.get(text)
    if (child) return child
    let index = valueIndex.get(text)
    if (index === undefined) {
      index = values.length
      values.push(JSON.parse(text))
      valueIndex.set(text, index)
      registerChildren(index, value)
    }
    return { $v: index }
  }

  /**
   * Вызвать `fn(...args)` и записать случай. Повтор входа не пишется;
   * `perOutcome` ограничивает число случаев с тем же исходом (функция + код
   * отказа), чтобы частые отказы не вытесняли редкие ветки.
   */
  function call(name, fn, args, { cap = Infinity, perOutcome = Infinity } = {}) {
    const plain = args.map(viaJson)
    const key = sha256(JSON.stringify([name, plain], (_k, v) => (v === undefined ? '\u0000undefined' : v)))
    const skip = seen.has(key) || (perFn.get(name) ?? 0) >= cap
    seen.add(key)
    const entry = {}
    let value
    try {
      value = fn(...plain.map(viaJson))
      const text = value === undefined ? undefined : JSON.stringify(value, jsonReplacer)
      if (text === undefined) entry.undefined = true
      else if (text.length > RESULT_LIMIT) entry.sha256 = sha256(text)
      else entry.result = JSON.parse(text)
    } catch (error) {
      entry.error = errorOf(error)
      value = undefined
    }
    const outcomeKey = `${name}:${entry.error ? entry.error.code ?? entry.error.name : 'ok'}`
    const outcomeCount = perOutcomeCount.get(outcomeKey) ?? 0
    const limit = typeof perOutcome === 'function' ? perOutcome(outcomeKey) : perOutcome
    if (!skip && outcomeCount < limit) {
      perOutcomeCount.set(outcomeKey, outcomeCount + 1)
      perFn.set(name, (perFn.get(name) ?? 0) + 1)
      cases.push({ fn: name, args: plain.map(ref), ...entry })
    }
    return { recorded: true, value: value === undefined ? undefined : viaJson(value), error: entry.error }
  }

  return {
    call,
    cases,
    counts: perFn,
    write(url) {
      const text = `{\n"values": [\n${values.map((value) => JSON.stringify(value)).join(',\n')}\n],\n"cases": [\n${cases.map((entry) => JSON.stringify(entry)).join(',\n')}\n]\n}\n`
      writeFileSync(url, text)
      console.error(`${url.pathname.split('/').at(-1)}: аргументов в таблице ${values.length}, случаев ${cases.length}, ${(text.length / 1024 / 1024).toFixed(2)} МБ`)
      console.error([...perFn.entries()].map(([name, count]) => `${name} ${count}`).join(', '))
    },
  }
}

const pick = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const out = {}
  for (const key of keys) if (Object.hasOwn(value, key)) out[key] = value[key]
  return out
}

/**
 * Состояние кампании без того, чего character-lifecycle не читает: герои,
 * редакция, стартовый уровень, бой и веха прогресса.
 */
export function stripState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  const out = pick(state, ['ruleset_id', 'character_start_level', 'characterStartLevel', 'players'])
  if (Array.isArray(out.players)) out.players = out.players.map(stripActor)
  if (Object.hasOwn(state, 'mechanics')) {
    const mechanics = state.mechanics
    if (!mechanics || typeof mechanics !== 'object' || Array.isArray(mechanics)) out.mechanics = mechanics
    else {
      out.mechanics = {}
      if (Object.hasOwn(mechanics, 'combat')) out.mechanics.combat = pick(mechanics.combat, ['active'])
      if (Object.hasOwn(mechanics, 'progression')) out.mechanics.progression = pick(mechanics.progression, ['level_up_available'])
    }
  }
  return out
}

const ITEM_FIELDS = ['id', 'catalog_id', 'catalogId', 'equipped', 'quantity', 'passive_effects', 'attuned_to']
const HEAVY_ACTOR_FIELDS = new Set(['combatSpells', 'combatActions', 'characterSheet'])

/** Герой без производного листа движка; у вещей — только поля, которые читают КД и эффекты. */
export function stripActor(actor) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return actor
  const out = {}
  for (const [key, value] of Object.entries(actor)) {
    if (HEAVY_ACTOR_FIELDS.has(key)) continue
    out[key] = key === 'inventory' && Array.isArray(value) ? value.map((item) => pick(item, ITEM_FIELDS)) : value
  }
  return out
}

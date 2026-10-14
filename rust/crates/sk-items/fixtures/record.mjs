// Общая запись эталонов «вызов JS → результат» для Rust-тестов sk-items.
//
// Каждый случай — `{ fn, args, result }` или `{ fn, args, error }`. Аргумент
// или результат `undefined` записывается строкой UNDEFINED (в JSON его нет, а
// JS отличает его от `null`), функция (так `catalogItem('constructor')`
// находит свойство прототипа) — строкой FUNCTION. Файл пишется по случаю на
// строку, чтобы diff эталона читался.
import { writeFileSync } from 'node:fs'

export const UNDEFINED = '\u0000undefined'
export const FUNCTION = '\u0000function'

const encode = (value) => (value === undefined ? UNDEFINED : typeof value === 'function' ? FUNCTION : value)

export function recorder(module) {
  const cases = []
  return {
    cases,
    /** Вызвать `fn(...args)` и записать результат или исключение. */
    call(name, fn, ...args) {
      const entry = { fn: name, args: args.map(encode) }
      try {
        entry.result = encode(fn(...args))
      } catch (error) {
        entry.error = { name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) }
      }
      cases.push(entry)
    },
    /** Записать значение константы модуля. */
    constant(name, value) {
      cases.push({ fn: `const:${name}`, args: [], result: encode(value) })
    },
    write(file) {
      const lines = cases.map((entry) => JSON.stringify(entry))
      writeFileSync(new URL(file, import.meta.url), `{"module":${JSON.stringify(module)},"cases":[\n${lines.join(',\n')}\n]}\n`)
      console.log(`${file}: ${cases.length} случаев`)
    },
  }
}

/** Детерминированный генератор (mulberry32) — один и тот же набор входов на каждом прогоне. */
export function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Помощники выбора поверх генератора. */
export function chooser(random) {
  const pick = (list) => list[Math.floor(random() * list.length)]
  const int = (min, max) => min + Math.floor(random() * (max - min + 1))
  const chance = (p) => random() < p
  return { pick, int, chance }
}

/** Свойства `Object.prototype`, которые `obj[key]` находит у любого объекта. */
export const PROTOTYPE_KEYS = Object.getOwnPropertyNames(Object.prototype)

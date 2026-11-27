// Общая запись эталонов «вызов JS → результат» для Rust-тестов sk-heroes.
//
// Каждый случай — `{ fn, args, result }` или `{ fn, args, error }`. Аргумент
// или результат `undefined` записывается строкой UNDEFINED (в JSON его нет, а
// JS отличает его от `null`). У исключения — имя, код, текст и пометка
// `runtime`: `TypeError` рантайма V8 (обращение к полю `null`, распаковка
// неитерируемого, вызов не-функции). Его текст Rust не повторяет, сверяется
// сам факт; текст исключения, которое бросает модуль, сверяется точно. Файл
// пишется по случаю на строку, чтобы diff эталона читался.
import { writeFileSync } from 'node:fs'

export const UNDEFINED = '\u0000undefined'

const encode = (value) => (value === undefined ? UNDEFINED : value)
const RUNTIME = /is not iterable|Cannot read propert|is not a function|Spread syntax|Cannot destructure/u

function describeError(error) {
  const message = String(error?.message ?? error)
  return {
    name: error?.name ?? 'Error',
    code: error?.code ?? null,
    message,
    runtime: error instanceof TypeError && RUNTIME.test(message),
  }
}

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
        entry.error = describeError(error)
      }
      cases.push(entry)
      return entry
    },
    /** Записать значение константы модуля. */
    constant(name, value) {
      cases.push({ fn: `const:${name}`, args: [], result: encode(value) })
    },
    write(file) {
      const lines = cases.map((entry) => JSON.stringify(entry))
      writeFileSync(new URL(file, import.meta.url), `{"module":${JSON.stringify(module)},"cases":[\n${lines.join(',\n')}\n]}\n`)
      const errors = cases.filter((entry) => entry.error).length
      console.log(`${file}: ${cases.length} случаев (исключений ${errors})`)
    },
  }
}

/** Декартово произведение списков. */
export function product(...lists) {
  return lists.reduce((acc, list) => acc.flatMap((prefix) => list.map((item) => [...prefix, item])), [[]])
}

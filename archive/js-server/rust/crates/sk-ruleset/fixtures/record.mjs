// Общая запись эталонов «вызов JS → результат» для Rust-тестов sk-ruleset.
//
// Каждый случай — `{ fn, args, result }` или `{ fn, args, error }`. Аргумент
// `undefined` записывается строкой UNDEFINED (в JSON его нет, а JS отличает
// его от `null` параметрами по умолчанию). Файл пишется по случаю на строку,
// чтобы diff эталона читался.
import { writeFileSync } from 'node:fs'

export const UNDEFINED = '\u0000undefined'

const encode = (value) => (value === undefined ? UNDEFINED : value)

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

/** Декартово произведение списков. */
export function product(...lists) {
  return lists.reduce((acc, list) => acc.flatMap((prefix) => list.map((item) => [...prefix, item])), [[]])
}

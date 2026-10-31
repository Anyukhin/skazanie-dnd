// Общие помощники генераторов эталонов sk-society: детерминированный ГПСЧ,
// пулы «мусорных» значений и запись случаев в JSON.
//
// Случай — `{ fn, args, out }`: `args` — аргументы вызова JS, где `undefined`
// записан как `{ "$undefined": true }`; `out` — результат (`JSON.stringify`),
// отсутствует, если функция вернула `undefined`. Если JS бросил исключение,
// случай пишется с `throws: { code, message }` только для отказа с кодом там,
// где перенос обязан его повторить (`expectThrow`); иначе вызов пропускается и
// учитывается в `skipped` — эталон не требует от Rust повторять падения JS на
// мусоре.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `a.localeCompare(b)` без локали берёт локаль процесса: на Windows с русской
// системой это `ru-RU` (кириллица раньше латиницы), в контейнере Linux —
// `en-US`. `sk_core::text::locale_compare` повторяет корневую сортировку ICU,
// поэтому эталон снимается с ней же; вызовы с явной локалью не трогаются.
const rootCollator = new Intl.Collator('en')
const originalLocaleCompare = String.prototype.localeCompare
String.prototype.localeCompare = function localeCompare(that, locales, options) {
  if (locales === undefined && options === undefined) return rootCollator.compare(String(this), String(that))
  return originalLocaleCompare.call(this, that, locales, options)
}

export const here = dirname(fileURLToPath(import.meta.url))
export const server = (name) => new URL(`../../../../server/${name}.mjs`, import.meta.url).href

/** mulberry32: одинаковый сид — одинаковые эталоны. */
export function rng(seed) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
    some: (list, max = list.length) => {
      const count = Math.floor(next() * (max + 1))
      return Array.from({ length: count }, () => list[Math.floor(next() * list.length)])
    },
  }
}

const UNDEFINED = Object.freeze({ $undefined: true })

/** Глубокая копия через JSON: вход и эталон видят одно и то же. */
export const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

/**
 * Сборщик случаев. Крупные объекты (состояния, реестры) пишутся один раз в
 * таблицу `values`, а в случае стоит ссылка `{ "$ref": n }` — иначе одно и то
 * же состояние повторялось бы в каждом вызове.
 */
export function collector() {
  const cases = []
  const values = []
  const index = new Map()
  let skipped = 0
  const encode = (value) => {
    if (value === undefined) return UNDEFINED
    if (value === null || typeof value !== 'object') return value
    const json = JSON.stringify(value)
    if (json.length < 160) return value
    let ref = index.get(json)
    if (ref === undefined) {
      ref = values.length
      values.push(JSON.parse(json))
      index.set(json, ref)
    }
    return { $ref: ref }
  }
  return {
    cases,
    values,
    get skipped() { return skipped },
    /** Вызов `fn(...args)` над JSON-копией аргументов; результат — через JSON. */
    call(name, fn, args, { expectThrow = false } = {}) {
      const input = args.map(plain)
      let out
      try {
        out = fn(...input.map((arg) => (arg === undefined ? undefined : plain(arg))))
      } catch (error) {
        // Отказ с кодом — поведение, которое перенос обязан повторить; падение
        // JS на мусоре (`TypeError` без кода) — нет.
        if (expectThrow && error.code) {
          cases.push({ fn: name, args: input.map(encode), throws: { code: error.code ?? null, message: String(error.message) } })
        } else {
          skipped += 1
        }
        return undefined
      }
      const entry = { fn: name, args: input.map(encode) }
      const result = plain(out)
      if (result !== undefined) entry.out = encode(result)
      cases.push(entry)
      return out
    },
  }
}

export function write(file, payload) {
  const path = join(here, file)
  const json = JSON.stringify(payload)
  writeFileSync(path, `${json}\n`)
  console.log(`${file}: ${payload.cases?.length ?? 0} случаев, пропущено ${payload.skipped ?? 0}, ${Math.round(json.length / 1024)} КиБ`)
}

/** Значения, которыми JS-код встречает мусор в старых кампаниях. */
export const JUNK = [
  undefined, null, '', ' ', 0, -1, 1, 2, 3, 1.5, -0.5, 7, 12, 99, 2 ** 53, 2 ** 60, '7', ' 12 ', '0x10', '1e3', 'abc',
  true, false, [], [3], ['a', 'b'], {}, { id: 'x' }, 'Ｆｕｌｌ', ' Северный  край ', 'a b', 'ё',
]

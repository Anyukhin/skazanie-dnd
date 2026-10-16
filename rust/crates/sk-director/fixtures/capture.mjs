import '../../../fixtures-env.mjs'
// Перехват настоящих вызовов `server/adventure-director.mjs` из тестов JS:
//
//   SK_DIRECTOR_CAPTURE=<файл> node --import ./capture.mjs --test --test-isolation=none test/….test.mjs
//
// Хук загрузки модулей (`module.registerHooks`) дописывает в конец модуля
// переприсваивание экспортов обёрткой: привязка функции в модуле изменяема, и
// импортёры видят обёртку. Исходник на диске не меняется. Вложенные вызовы
// (переход зовёт свои помощники) не записываются — только внешние. По выходу
// процесса записи (аргументы снимком JSON) уходят строками в файл; генератор
// эталона сам урезает состояние и пересчитывает исход.
import { registerHooks } from 'node:module'
import { appendFileSync, writeFileSync } from 'node:fs'
import { argsOf } from './common.mjs'

const TARGET = '/server/adventure-director.mjs'
const WRAPPED = ['createSceneTransition', 'generateSceneGeometry', 'generateSceneCells', 'entrySideToward', 'openingEntrySide', 'levelKey']

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith(TARGET)) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    const wraps = WRAPPED.map((name) => `${name} = globalThis.__skDirectorWrap(${JSON.stringify(name)}, ${name})`).join('\n')
    return { ...result, source: `${source}\n;${wraps}\n` }
  },
})

const out = process.env.SK_DIRECTOR_CAPTURE
let depth = 0
let label = ''
if (out) writeFileSync(out, '')

globalThis.__skDirectorWrap = (name, fn) => function wrapped(...args) {
  if (depth > 0 || !out) return fn(...args)
  depth += 1
  try {
    // Снимок до вызова: функция может дополнить свои аргументы.
    let record
    try {
      record = { fn: name, test: label, ...argsOf(args) }
    } catch {
      record = null
    }
    if (record) appendFileSync(out, `${JSON.stringify(record)}\n`)
    return fn(...args)
  } finally {
    depth -= 1
  }
}

// Имя текущего теста — в метку записи.
const { default: test } = await import('node:test')
test.beforeEach?.((context) => { label = context?.name ?? '' })

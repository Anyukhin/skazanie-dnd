import '../../../fixtures-env.mjs'
// Перехват настоящих вызовов любых модулей `server/` из тестов JS:
//
//   SK_CAPTURE=<файл> SK_CAPTURE_TARGETS='{"/server/x.mjs":["fn"]}' \
//     node --import ./capture-modules.mjs --test --test-isolation=none test/….test.mjs
//
// Как `capture.mjs`: хук загрузки дописывает переприсваивание экспортов
// обёрткой, записываются только внешние вызовы — аргументы снимком JSON до
// вызова. Одинаковые записи пропускаются, на функцию — не больше
// `SK_CAPTURE_LIMIT` (по умолчанию 400).
import { registerHooks } from 'node:module'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { argsOf } from './common.mjs'

const targets = JSON.parse(process.env.SK_CAPTURE_TARGETS ?? '{}')
const out = process.env.SK_CAPTURE
const limit = Number(process.env.SK_CAPTURE_LIMIT ?? 400)

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    const target = Object.keys(targets).find((suffix) => url.endsWith(suffix))
    if (!target) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    const wraps = targets[target].map((name) => `${name} = globalThis.__skCaptureWrap(${JSON.stringify(name)}, ${name})`).join('\n')
    return { ...result, source: `${source}\n;${wraps}\n` }
  },
})

let depth = 0
let label = ''
const seen = new Set()
const counts = {}
if (out) writeFileSync(out, '')

globalThis.__skCaptureWrap = (name, fn) => function wrapped(...args) {
  if (depth > 0 || !out || (counts[name] ?? 0) >= limit) return fn(...args)
  depth += 1
  try {
    try {
      const record = { fn: name, test: label, ...argsOf(args) }
      const text = JSON.stringify(record)
      const key = createHash('sha256').update(JSON.stringify([name, record.args, record.undef])).digest('hex')
      if (!seen.has(key)) {
        seen.add(key)
        counts[name] = (counts[name] ?? 0) + 1
        appendFileSync(out, `${text}\n`)
      }
    } catch {
      // Аргумент без JSON-формы (функция, цикл) — вызов не записывается.
    }
    return fn(...args)
  } finally {
    depth -= 1
  }
}

const { default: test } = await import('node:test')
test.beforeEach?.((context) => { label = context?.name ?? '' })

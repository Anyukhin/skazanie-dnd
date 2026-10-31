// Перехват настоящих вызовов server/campaign-loop-policy.mjs при прогоне
// тестов JS. Подключается флагом `--import` после `rust/fixtures-env.mjs`:
//
//   node --import rust/fixtures-env.mjs --import <этот файл> --test --test-isolation=none test/x.test.mjs
//
// Хук загрузки (`module.registerHooks`) дописывает в конец модуля
// переприсваивание экспортов обёрткой (как `sk-world-life/fixtures/hook.mjs`);
// исходники `server/` на диске не меняются. Пишутся только верхние вызовы:
// аргументы уже урезаны и проверены исходом (`slimmedCase`), строка на вызов в
// файл `LOOP_POLICY_CAPTURE_OUT`.
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

import { FUNCTIONS, HOOKABLE, encodeArgs, outcome, slimmedCase } from './loop-policy-lib.mjs'

const OUT = process.env.LOOP_POLICY_CAPTURE_OUT
const LIMIT_PER_FUNCTION = Number(process.env.LOOP_POLICY_CAPTURE_LIMIT) || 400
const MAX_ARGS_BYTES = 4_000_000

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith('/server/campaign-loop-policy.mjs')) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    const wraps = HOOKABLE.map((name) => `${name} = globalThis.__loopPolicyWrap(${JSON.stringify(name)}, ${name})`).join('\n')
    return { ...result, source: `${source}\n;${wraps}\n` }
  },
})

let depth = 0
const counts = new Map()
const seen = new Set()
let dropped = 0

globalThis.__loopPolicyWrap = (name, fn) => function recorded(...args) {
  if (!OUT || depth > 0 || (counts.get(name) ?? 0) >= LIMIT_PER_FUNCTION) return fn(...args)
  let snapshot = null
  try {
    const text = JSON.stringify(encodeArgs(args))
    if (text.length < MAX_ARGS_BYTES) snapshot = JSON.parse(text)
  } catch { /* круговая ссылка — не пишем */ }
  depth += 1
  try {
    return fn(...args)
  } finally {
    if (snapshot) {
      try {
        const decoded = snapshot.map((arg) => (arg === '\u0000undefined' ? undefined : arg))
        const full = outcome(fn, structuredClone(decoded))
        const slim = slimmedCase(fn, decoded, FUNCTIONS[name], full)
        if (slim) {
          const line = JSON.stringify({ fn: name, args: encodeArgs(slim.args) })
          const key = createHash('sha256').update(line).digest('hex')
          if (!seen.has(key)) {
            seen.add(key)
            counts.set(name, (counts.get(name) ?? 0) + 1)
            appendFileSync(OUT, `${line}\n`)
          }
        } else {
          dropped += 1
        }
      } catch { dropped += 1 }
    }
    depth -= 1
  }
}

process.on('exit', () => {
  if (OUT && dropped) appendFileSync(OUT, `${JSON.stringify({ dropped })}\n`)
})

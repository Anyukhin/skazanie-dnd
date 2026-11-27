import '../../../fixtures-env.mjs'
import { startCapture, quietly } from './capture-hook.mjs'
// Запись настоящих вызовов диалогов и разбора намерения из тестов JS:
//
//   SK_STORY_CAPTURE=<файл.jsonl> node --import ./rust/crates/sk-story/fixtures/capture-tests.mjs \
//     --test --test-isolation=none test/campaign-dialogues.test.mjs …
//
// Каждый верхний вызов модуля урезается (`prepare`) и пишется строкой
// `{ fn, args }`; исход считает генератор эталона заново. Повторы и случаи
// сверх предела на функцию отбрасываются.
import { appendFileSync, writeFileSync } from 'node:fs'

const { prepare, captureArgs, sha256, stats } = await import('./story-fixtures.mjs')

const target = process.env.SK_STORY_CAPTURE
if (!target) throw new Error('capture-tests: нужен SK_STORY_CAPTURE')
writeFileSync(target, '')
const CAP = Number(process.env.SK_STORY_CAP ?? 1500)
const seen = new Set()
const perFn = new Map()

startCapture((module, name, args) => {
  try {
    const mapped = captureArgs(module, name, args)
    if (!mapped) return
    const [fn, input] = mapped
    if ((perFn.get(fn) ?? 0) >= CAP) return
    const prepared = prepare(fn, input, quietly)
    if (!prepared) return
    const line = JSON.stringify({ fn, args: prepared.map((arg) => (arg === undefined ? '\u0000undefined' : arg)) })
    const key = sha256(line)
    if (seen.has(key)) return
    seen.add(key)
    perFn.set(fn, (perFn.get(fn) ?? 0) + 1)
    appendFileSync(target, `${line}\n`)
  } catch { /* вход не сериализуется */ }
})

process.on('exit', () => {
  console.error(`capture: ${[...perFn.entries()].map(([fn, count]) => `${fn} ${count}`).join(', ')}; урезано ${stats.stripped}, расширено ${stats.widened}, отброшено ${stats.dropped}`)
})

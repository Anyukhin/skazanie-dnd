import '../../../fixtures-env.mjs'
// Сводки событий всего корпуса для сверки `eventSummary` (задача Р7).
//
// Для каждой записи корпуса с событиями пишет строку JSONL
// `{ file, row, plain, named }`: `plain` — `eventSummary(event)` без
// подстановки имён, `named` — с `actorNameResolver(состояние до команды)`.
// Файл большой и в git не кладётся: его читает `sk-corpus summary`.
//
// Запуск:
//   node rust/crates/sk-rules/fixtures/gen-summary-corpus.mjs <каталог корпуса> <выход.jsonl>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { actorNameResolver, eventSummary } from '../../../../server/rules-engine.mjs'

const corpusDir = process.argv[2] ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'
const output = process.argv[3] ?? join(tmpdir(), 'sk-rules-summary-corpus.jsonl')
const files = readdirSync(corpusDir).filter((name) => name.startsWith('corpus-') && name.endsWith('.jsonl')).sort()
const lines = []
let events = 0
for (const file of files) {
  let row = 0
  for (const line of readFileSync(join(corpusDir, file), 'utf8').split('\n')) {
    if (!line.trim()) continue
    row += 1
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const list = entry?.outcome?.events
    if (!Array.isArray(list) || !list.length) continue
    let state = null
    try { state = JSON.parse(readFileSync(join(corpusDir, 'states', `${entry.state}.json`), 'utf8')) } catch { state = null }
    const resolver = actorNameResolver(state)
    const text = (fn) => { try { const value = fn(); return value === undefined ? '__undefined__' : String(value) } catch (error) { return `__throw__:${error?.name}` } }
    lines.push(JSON.stringify({ file, row, plain: list.map((event) => text(() => eventSummary(event))), named: list.map((event) => text(() => eventSummary(event, resolver))) }))
    events += list.length
  }
}
writeFileSync(output, `${lines.join('\n')}\n`)
console.log(`${output}: записей ${lines.length}, событий ${events}`)

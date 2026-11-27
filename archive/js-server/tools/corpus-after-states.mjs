// Полные состояния «после» для корпуса переноса на Rust
// (`docs/rust-rewrite-plan.md`, §5; запись — `server/rules-corpus.mjs`).
//
// Для каждой записи `<dir>/corpus-*.jsonl` с удачным исходом JS-редьюсер
// применяет её события к состоянию «до»; итог без производных полей героя
// ложится в `<dir>/states/<sha>.json`, а `<dir>/after.jsonl` связывает строку
// корпуса с хешем. Так Rust-редьюсер сверяется со всем состоянием, а не только
// с выжимкой.
//
//   node tools/corpus-after-states.mjs tmp/corpus-v1
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

const dir = process.argv[2]
if (!dir) throw new Error('Укажите каталог корпуса')
const DERIVED = ['combatSpells', 'combatActions', 'characterSheet', 'inventoryLoad']
const strip = (state) => {
  const copy = JSON.parse(JSON.stringify(state))
  for (const player of copy.players ?? []) for (const field of DERIVED) delete player[field]
  return copy
}
const lines = []
let done = 0
let failed = 0
for (const file of readdirSync(dir).filter((name) => name.startsWith('corpus-') && name.endsWith('.jsonl')).sort()) {
  let row = 0
  for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
    if (!line) continue
    row += 1
    const entry = JSON.parse(line)
    if (!entry.outcome?.ok) continue
    try {
      const before = JSON.parse(readFileSync(join(dir, 'states', `${entry.state}.json`), 'utf8'))
      let state = normalizeCampaignState(before)
      for (const event of entry.outcome.events ?? []) state = applyGameEvent(state, event)
      const text = JSON.stringify(strip(state))
      const hash = createHash('sha256').update(text).digest('hex')
      const target = join(dir, 'states', `${hash}.json`)
      if (!existsSync(target)) writeFileSync(target, text)
      lines.push(JSON.stringify({ file, row, after: hash }))
      done += 1
    } catch (error) {
      failed += 1
      lines.push(JSON.stringify({ file, row, error: String(error?.message ?? error).slice(0, 300) }))
    }
  }
}
writeFileSync(join(dir, 'after.jsonl'), `${lines.join('\n')}\n`)
console.log(`состояний после: ${done}, ошибок: ${failed}`)

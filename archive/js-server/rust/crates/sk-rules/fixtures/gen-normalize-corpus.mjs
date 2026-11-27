import '../../../fixtures-env.mjs'
// Эталон нормализации `normalizeCampaignState` по всем состояниям корпуса
// паритета (задача Р4б).
//
// Для каждого `<корпус>/states/<sha>.json` JS нормализует состояние; эталон —
// sha256 `JSON.stringify` итога целиком и без производных полей героя
// (`combatSpells`, `combatActions`, `characterSheet`, `inventoryLoad`). Если JS
// бросает, записывается текст ошибки. Полные состояния в git не кладутся:
// корпус весит больше гигабайта.
//
//   node rust/crates/sk-rules/fixtures/gen-normalize-corpus.mjs <корпус>
//   node …/gen-normalize-corpus.mjs --dump <корпус> <sha состояния> <файл>   — полный итог JS
//
// Сверка — `cargo run --release -p sk-corpus -- normalize <корпус>`.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeCampaignState } from '../../../../server/rules-engine.mjs'
import { sourceSha256 } from './open-copy.mjs'

const DERIVED = ['combatSpells', 'combatActions', 'characterSheet', 'inventoryLoad']
const sha = (text) => createHash('sha256').update(text).digest('hex')
const stripped = (state) => {
  const copy = JSON.parse(JSON.stringify(state))
  for (const player of Array.isArray(copy.players) ? copy.players : []) {
    if (player && typeof player === 'object') for (const field of DERIVED) delete player[field]
  }
  return copy
}

const args = process.argv.slice(2)
if (args[0] === '--dump') {
  const [, corpus, hash, output] = args
  const state = JSON.parse(readFileSync(join(corpus, 'states', `${hash}.json`), 'utf8'))
  writeFileSync(output, JSON.stringify(normalizeCampaignState(state), null, 1))
  process.exit(0)
}
const [corpus] = args
if (!corpus) throw new Error('Укажите каталог корпуса')
const names = readdirSync(join(corpus, 'states')).filter((name) => name.endsWith('.json')).sort()
const cases = []
let done = 0
for (const name of names) {
  const hash = name.slice(0, -5)
  const state = JSON.parse(readFileSync(join(corpus, 'states', name), 'utf8'))
  try {
    const normalized = normalizeCampaignState(state)
    cases.push([hash, sha(JSON.stringify(normalized)), sha(JSON.stringify(stripped(normalized)))])
  } catch (error) {
    cases.push([hash, 'throws', String(error?.message ?? error).slice(0, 200)])
  }
  done += 1
  if (done % 500 === 0) console.error(`${done}/${names.length}`)
}
const output = new URL('./normalize-corpus.json', import.meta.url)
writeFileSync(output, `${JSON.stringify({ source_sha256: sourceSha256(), cases })}\n`)
console.log(`состояний: ${cases.length}, бросает: ${cases.filter((entry) => entry[1] === 'throws').length}`)

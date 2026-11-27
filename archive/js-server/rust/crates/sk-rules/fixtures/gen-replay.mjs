import '../../../fixtures-env.mjs'
// Эталон `applyGameEvent`, `replayEvents` и проектора команды
// `createCommandProjector` (задача Р4б).
//
// 1. Синтетика (лежит целиком): отказы версии редьюсера
//    (`INVALID_REDUCER_VERSION`, `UNSUPPORTED_REDUCER_VERSION`), режим
//    retention по `reducer_version` и `state_version_after` (legacy обрезает
//    социальный реестр до 500 NPC), замена состояния `LegacyStateImported` и
//    `CampaignRewound`.
// 2. Корпус (по sha состояния): потоки событий записей, чьи типы перенесены в
//    Rust; `replayEvents(before, events)` и проектор, которому события
//    подаются растущим списком, затем — с правленым первым событием (кэш
//    обязан сброситься). Эталон — sha256 `JSON.stringify` без производных
//    полей героя и без реестров-выводов, ещё не перенесённых в Rust
//    (`REGISTRIES`); записи с неперенесёнными событиями Rust пропускает.
//
//   node rust/crates/sk-rules/fixtures/gen-replay.mjs <корпус>
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadOpenCopy, sourceSha256 } from './open-copy.mjs'

const [corpus] = process.argv.slice(2)
if (!corpus) throw new Error('Укажите каталог корпуса')
const E = await loadOpenCopy()
const DERIVED = ['combatSpells', 'combatActions', 'characterSheet', 'inventoryLoad']
// Реестры-выводы, ещё не перенесённые в Rust (исключаются из сравнения). Все
// перенесены задачей Р4в-2.
const REGISTRIES = []
const strip = (state) => {
  const copy = JSON.parse(JSON.stringify(state))
  for (const player of Array.isArray(copy.players) ? copy.players : []) for (const field of DERIVED) delete player?.[field]
  for (const key of REGISTRIES) delete copy[key]
  return copy
}
const sha = (value) => createHash('sha256').update(JSON.stringify(strip(value))).digest('hex')
const attempt = (fn) => {
  try {
    return { sha: sha(fn()) }
  } catch (error) {
    return { throws: String(error?.message ?? error).slice(0, 200), code: error?.code ?? null }
  }
}

// --- синтетика ------------------------------------------------------------------
const base = {
  state_version: 3,
  players: [{ id: 'hero', name: 'Герой', class: 'fighter', level: 2, hp: 12, maxHp: 18 }],
  social: { npcs: Array.from({ length: 520 }, (_, index) => ({ id: `npc-${index}`, name: `NPC ${index}` })) },
}
const time = (extra) => ({ event_type: 'TimeAdvanced', actor_id: 'hero', target_ids: [], payload: { amount: 10, unit: 'minute', elapsed_minutes: 10 }, source_rule_ids: [], visibility: 'public', ...extra })
const synthetic = []
for (const marker of [undefined, null, 0, 3, 14, 15, '15', '7', 16, -1, 1.5, 'x', true, [], Number.MAX_SAFE_INTEGER]) {
  for (const after of [undefined, 9, 'x']) {
    const event = time({ ...(marker === undefined ? {} : { reducer_version: marker }), ...(after === undefined ? {} : { state_version_after: after }) })
    synthetic.push({ kind: 'apply', state: 0, event, ...attempt(() => E.applyGameEvent(base, event)) })
  }
}
const imported = { players: [{ id: 'other', name: 'Другой', class: 'wizard', level: 1, hp: 6, maxHp: 6 }], state_version: 40 }
for (const type of ['LegacyStateImported', 'CampaignRewound']) {
  for (const after of [undefined, 77]) {
    for (const payloadState of [imported, null, 'x']) {
      const event = { event_type: type, payload: { state: payloadState }, ...(after === undefined ? {} : { state_version_after: after }) }
      synthetic.push({ kind: 'apply', state: 0, event, ...attempt(() => E.applyGameEvent(base, event)) })
    }
  }
}
for (const stream of [[time({ reducer_version: 3 }), time({ reducer_version: 15 })], [time({ reducer_version: 15 }), time({})], [time({ state_version_after: 5 })], []]) {
  synthetic.push({ kind: 'replay', state: 0, events: stream, ...attempt(() => E.replayEvents(base, stream)) })
}

// --- корпус ------------------------------------------------------------------------
const corpusCases = []
const files = readdirSync(corpus).filter((name) => name.startsWith('corpus-') && name.endsWith('.jsonl')).sort()
const perType = new Map()
for (const file of files) {
  let row = 0
  for (const line of readFileSync(join(corpus, file), 'utf8').split('\n')) {
    if (!line) continue
    row += 1
    const entry = JSON.parse(line)
    const events = entry.outcome?.events ?? []
    if (!entry.outcome?.ok || events.length < 2 || events.length > 12 || JSON.stringify(events).length > 20_000) continue
    const type = entry.command?.command_type
    if ((perType.get(type) ?? 0) >= 3) continue
    perType.set(type, (perType.get(type) ?? 0) + 1)
    const before = JSON.parse(readFileSync(join(corpus, 'states', `${entry.state}.json`), 'utf8'))
    const replay = attempt(() => E.replayEvents(before, events))
    const projector = E.createCommandProjector(E.normalizeCampaignState(before))
    const steps = []
    for (let length = 1; length <= events.length; length += 1) steps.push(attempt(() => projector(events.slice(0, length))))
    const edited = events.map((event, index) => (index === 0 ? { ...event, payload: { ...(event.payload ?? {}), __edited: true } } : event))
    steps.push(attempt(() => projector(edited)))
    corpusCases.push({ file, row, state_hash: entry.state, events, edited_first: true, replay, steps })
  }
}
const output = new URL('./replay.json', import.meta.url)
writeFileSync(output, `${JSON.stringify({ source_sha256: sourceSha256(), registries_excluded: REGISTRIES, states: [base], synthetic, corpus: corpusCases })}\n`)
console.log(`replay.json: синтетика ${synthetic.length} (бросает ${synthetic.filter((c) => c.throws).length}), записей корпуса ${corpusCases.length}`)

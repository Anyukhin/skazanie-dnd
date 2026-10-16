import '../../../fixtures-env.mjs'
import { startCapture, quietly, fixtureWriter, outcomeOf, viaJson, mulberry32, chooser, pickKeys, mapList, corpusDir, corpusRecords, corpusState, runTestFiles } from './lib.mjs'
// Эталон server/scene-summary.mjs для Rust:
//
//   node rust/crates/sk-narration/fixtures/gen-scene-summary.mjs [каталог корпуса]
//
// Источники: настоящие вызовы при прогоне test/scene-summary.test.mjs (в том
// числе через Rules Engine и бриф Рассказчика), корпус паритета — история
// событий каждой кампании до хода с `SceneAdvanced` и состояние перед ним, как
// у `sceneSummaryFor` в `server/index.mjs`, — и случайные сцены с мусором.
const m = await import('../../../../server/scene-summary.mjs')

const writer = fixtureWriter('scene-summary')
const stats = {}

const FNS = {
  eventsSinceSceneStart: { fn: (...args) => m.eventsSinceSceneStart(...args), events: 0 },
  notableSceneMoments: { fn: (...args) => m.notableSceneMoments(...args), events: 0 },
  buildSceneSummaryText: { fn: (...args) => m.buildSceneSummaryText(...args), options: 0 },
  sceneSummaryFor: { fn: (...args) => m.sceneSummaryFor(...args), options: 0 },
}

function tightEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event
  const out = pickKeys(event, ['event_type', 'payload'])
  const payload = out.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return out
  const slim = pickKeys(payload, ['outcome', 'reason', 'summary', 'catalog_id', 'quantity'])
  if (Object.hasOwn(payload, 'fact')) slim.fact = pickKeys(payload.fact, ['predicate', 'summary', 'object'])
  if (Object.hasOwn(payload, 'ruling')) slim.ruling = pickKeys(payload.ruling, ['stakes', 'question', 'outcome'])
  if (Object.hasOwn(payload, 'promise')) slim.promise = pickKeys(payload.promise, ['text'])
  if (Object.hasOwn(payload, 'item')) slim.item = pickKeys(payload.item, ['name'])
  out.payload = slim
  return out
}

const tightEvents = (events) => mapList(events, tightEvent)

function slimOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return options
  const out = { ...options }
  if (Object.hasOwn(options, 'events')) out.events = tightEvents(options.events)
  const state = options.state
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    out.state = Object.hasOwn(state, 'scene') ? { scene: pickKeys(state.scene, ['location', 'title']) } : {}
  }
  return out
}

function record(name, rawArgs, source) {
  const spec = FNS[name]
  const args = rawArgs.map(viaJson)
  const expected = quietly(() => outcomeOf(spec.fn, args))
  const strip = (list) => list.map((arg, index) => (index === spec.events ? tightEvents(arg) : index === spec.options ? slimOptions(arg) : arg))
  const candidate = strip(args)
  const outcome = quietly(() => outcomeOf(spec.fn, candidate))
  // Результат eventsSinceSceneStart — сами события: у урезанного входа он свой.
  if (name === 'eventsSinceSceneStart' || JSON.stringify(outcome) === JSON.stringify(expected)) {
    stats.stripped = (stats.stripped ?? 0) + 1
    return writer.add(name, candidate, outcome, { source })
  }
  stats.full = (stats.full ?? 0) + 1
  return writer.add(name, args, expected, { source })
}

// 1. Настоящие вызовы при прогоне тестов JS.
const captured = []
const stop = startCapture((module, name, args) => {
  if (module !== 'server/scene-summary.mjs' || !FNS[name]) return undefined
  try {
    captured.push({ name, args: args.map(viaJson) })
  } catch { /* вход не сериализуется */ }
  return undefined
})
await runTestFiles(['scene-summary', 'scene-narration', 'deterministic-narration']
  .map((name) => new URL(`../../../../test/${name}.test.mjs`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')))
stop()
for (const entry of captured) record(entry.name, entry.args, 'tests')
console.log(`тесты JS: перехвачено ${captured.length} вызовов`)

// 2. Корпус паритета: история кампании до перехода.
const corpus = corpusDir(process.argv[2])
if (corpus) {
  let used = 0
  let file = null
  let history = []
  for (const row of corpusRecords(corpus)) {
    if (row.file !== file) {
      file = row.file
      history = []
    }
    if (row.events.some((event) => event?.event_type === 'SceneAdvanced') || row.events.some((event) => event?.event_type === 'EncounterEnded')) {
      const state = corpusState(corpus, row.before)
      if (state) {
        used += 1
        const args = row.command?.scene_args ?? {}
        record('sceneSummaryFor', [{ state, events: history, decision: args.outcome ?? row.command?.reason, destinationHint: args.title, destination: args.location }], 'corpus')
        record('notableSceneMoments', [m.eventsSinceSceneStart(history)], 'corpus')
        if (used % 3 === 0) record('buildSceneSummaryText', [{ state, events: m.eventsSinceSceneStart(history), decision: row.command?.reason }], 'corpus')
      }
    }
    history.push(...row.events.map(tightEvent))
  }
  console.log(`корпус: использовано переходов ${used}`)
}

// 3. Случайные сцены и мусор.
const random = mulberry32(2026_10_19)
const { int, pick, chance } = chooser(random)
const GARBAGE = [null, 0, 2, '', 'строка', '3', [], [2], ['x'], {}, { a: 1 }, true, false]
const garbage = () => pick(GARBAGE)
const maybe = (value, p = 0.1) => (chance(p) ? garbage() : value)
const TEXTS = ['Таверна сгорела дотла.', 'таверна сгорела дотла', 'Мост рухнул;', '  Ворота   заперты , ', 'Ｆｕｌｌｗｉｄｔｈ текст', '', 'Ключ у старосты...', `${'Длинно. '.repeat(40)}`, 'Тишина\u0085', 'Знак﻿']
const LOCATIONS = ['Норвин', 'Старый тракт', '', '  Таверна «Морской Змей»  ', 'Ｎｏｒｖｉｎ', `${'Л'.repeat(170)}`]

function randomEvent() {
  const roll = random()
  const type = pick(['WorldFactRecorded', 'EncounterOutcomeRecorded', 'EncounterEnded', 'RulingRecorded', 'NpcPromiseRecorded', 'QuestResolved', 'MerchantPurchaseCompleted', 'SceneAdvanced', 'DieRolled', 'ObjectiveUpdated'])
  if (roll < 0.03) return pick([null, 5, 'событие', [], {}])
  const payload = {
    WorldFactRecorded: () => ({ fact: maybe({ predicate: pick(['scene_change', 'scene_change', 'npc_status']), summary: maybe(pick(TEXTS)), object: maybe(pick(TEXTS)) }) }),
    EncounterOutcomeRecorded: () => ({ outcome: maybe(pick(['enemies_defeated', 'fled', 'truce', 'стороны разошлись', 'unknown'])) }),
    EncounterEnded: () => ({ reason: maybe(pick(['enemies_defeated', '', undefined])), outcome: maybe(pick(['party_defeated', undefined])) }),
    RulingRecorded: () => ({ ruling: maybe({ stakes: maybe(pick(['Падение', '', undefined])), question: maybe(pick(['Перепрыгнет ли герой пропасть?', '', 'Взлом'])), outcome: pick(['success', 'failure']) }) }),
    NpcPromiseRecorded: () => ({ promise: maybe({ text: maybe(pick(TEXTS)) }) }),
    QuestResolved: () => ({ summary: maybe(pick(['Старосту спасли', '', undefined])), outcome: maybe(pick(['completed', undefined, null])) }),
    MerchantPurchaseCompleted: () => ({ item: maybe({ name: maybe(pick(['Кинжал', '', 'Верёвка'])) }), catalog_id: maybe(pick(['srd:rope', undefined])), quantity: maybe(pick([1, 2, 5, '3', undefined])) }),
    SceneAdvanced: () => ({}),
    DieRolled: () => ({}),
    ObjectiveUpdated: () => ({}),
  }[type]()
  return { event_type: type, payload: maybe(payload, 0.03) }
}

for (let index = 0; index < 1_000; index += 1) {
  const events = Array.from({ length: int(0, 9) }, randomEvent)
  const state = chance(0.92) ? { scene: maybe({ location: maybe(pick(LOCATIONS)), title: maybe(pick(LOCATIONS)) }) } : pick([null, garbage(), undefined])
  const options = { events: maybe(events, 0.03) }
  if (state !== undefined) options.state = state
  if (chance(0.6)) options.decision = maybe(pick(['Отряд ищет старосту', '', `${'Причина. '.repeat(50)}`]))
  if (chance(0.5)) options.destinationHint = maybe(pick(LOCATIONS))
  if (chance(0.5)) options.destination = maybe(pick(LOCATIONS))
  const whole = chance(0.02) ? pick([null, undefined, 5, 'строка']) : options
  record(index % 2 ? 'sceneSummaryFor' : 'buildSceneSummaryText', whole === undefined ? [] : [whole], 'random')
  if (index % 3 === 0) record('notableSceneMoments', [events], 'random')
  if (index % 5 === 0) record('eventsSinceSceneStart', [chance(0.95) ? events : garbage()], 'random')
}

console.log('урезание:', stats)
writer.write(new URL('./scene-summary.json.gz', import.meta.url))

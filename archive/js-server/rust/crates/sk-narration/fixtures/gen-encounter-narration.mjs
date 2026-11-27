import '../../../fixtures-env.mjs'
import { startCapture, quietly, fixtureWriter, outcomeOf, viaJson, mulberry32, chooser, pickKeys, mapList, corpusDir, corpusRecords, corpusState, runTestFiles } from './lib.mjs'
// Эталон server/encounter-narration.mjs для Rust:
//
//   node rust/crates/sk-narration/fixtures/gen-encounter-narration.mjs [каталог корпуса]
//
// Источники: настоящие вызовы при прогоне тестов JS, корпус паритета (ходы с
// `EncounterCreated` и состояние после них) и случайные встречи с мусором.
const e = await import('../../../../server/encounter-narration.mjs')

const writer = fixtureWriter('encounter-narration')
const stats = {}

const FNS = {
  encounterNarration: { fn: (...args) => e.encounterNarration(...args), states: [1] },
  hasEncounterEvent: { fn: (...args) => e.hasEncounterEvent(...args), states: [] },
}

function tightEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event
  const out = pickKeys(event, ['event_id', 'event_type', 'actor_id', 'target_ids', 'command_id', 'state_version_after', 'payload'])
  const encounter = out.payload?.encounter
  if (out.event_type === 'EncounterCreated' && encounter && typeof encounter === 'object' && !Array.isArray(encounter)) {
    out.payload = { encounter: { ...pickKeys(encounter, ['theme', 'difficulty']), ...(Object.hasOwn(encounter, 'enemies') ? { enemies: mapList(encounter.enemies, (enemy) => pickKeys(enemy, ['name'])) } : {}) } }
  } else if (out.payload && typeof out.payload === 'object') {
    out.payload = {}
  }
  return out
}

function slimState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  const out = {}
  if (Object.hasOwn(state, 'scene')) {
    const scene = state.scene
    out.scene = scene && typeof scene === 'object' && !Array.isArray(scene)
      ? { ...pickKeys(scene, ['theme']), ...(Object.hasOwn(scene, 'map') ? { map: pickKeys(scene.map, ['theme']) } : {}) }
      : scene
  }
  if (Object.hasOwn(state, 'mechanics')) {
    const time = state.mechanics?.world_time
    out.mechanics = state.mechanics && typeof state.mechanics === 'object' && !Array.isArray(state.mechanics)
      ? (time !== undefined ? { world_time: time && typeof time === 'object' && !Array.isArray(time) ? pickKeys(time, ['elapsed_minutes']) : time } : {})
      : state.mechanics
  }
  return out
}

function record(name, rawArgs, source) {
  const spec = FNS[name]
  const args = rawArgs.map(viaJson)
  const expected = quietly(() => outcomeOf(spec.fn, args))
  const strips = [
    (list) => list.map((arg, index) => (index === 0 ? mapList(arg, tightEvent) : spec.states.includes(index) ? slimState(arg) : arg)),
    (list) => list.map((arg, index) => (spec.states.includes(index) ? slimState(arg) : arg)),
  ]
  for (const strip of strips) {
    const candidate = strip(args)
    const outcome = quietly(() => outcomeOf(spec.fn, candidate))
    if (JSON.stringify(outcome) === JSON.stringify(expected)) {
      stats.stripped = (stats.stripped ?? 0) + 1
      return writer.add(name, candidate, outcome, { stateArgs: spec.states, source })
    }
  }
  stats.full = (stats.full ?? 0) + 1
  return writer.add(name, args, expected, { stateArgs: spec.states, source })
}

// 1. Настоящие вызовы при прогоне тестов JS.
const captured = []
const stop = startCapture((module, name, args) => {
  if (module !== 'server/encounter-narration.mjs' || !FNS[name]) return undefined
  try {
    captured.push({ name, args: args.map(viaJson) })
  } catch { /* вход не сериализуется */ }
  return undefined
})
await runTestFiles(['encounter-deadly-tier', 'deterministic-narration', 'combat-narration', 'boss-mechanics']
  .map((name) => new URL(`../../../../test/${name}.test.mjs`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')))
stop()
for (const entry of captured) record(entry.name, entry.args, 'tests')
console.log(`тесты JS: перехвачено ${captured.length} вызовов`)

// 2. Корпус паритета.
const corpus = corpusDir(process.argv[2])
if (corpus) {
  let used = 0
  for (const row of corpusRecords(corpus)) {
    if (!row.events.some((event) => event?.event_type === 'EncounterCreated')) continue
    const state = corpusState(corpus, row.after)
    if (!state) continue
    used += 1
    record('encounterNarration', [row.events, state], 'corpus')
    record('hasEncounterEvent', [row.events], 'corpus')
  }
  console.log(`корпус: использовано ходов ${used}`)
}

// 3. Случайные встречи и мусор.
const random = mulberry32(2026_10_18)
const { int, pick, chance } = chooser(random)
const GARBAGE = [null, 0, '', 'строка', [], ['x'], {}, { a: 1 }, true, 'deadly', ['deadly']]
const garbage = () => pick(GARBAGE)
const maybe = (value, p = 0.08) => (chance(p) ? garbage() : value)
const NAMES = ['Волк', 'Гоблин', 'Гоблин 2', 'Огр', '  Тень  ', 'Скелет', '', 'Хобгоблин-капитан', 'Разбойник', 'Mimic', `${'Ю'.repeat(130)}`]
const THEMES = ['forest', 'road', 'settlement', 'graveyard', 'building', 'temple', 'crypt', 'cave', 'dungeon', '', 'swamp']

let serial = 0
function created() {
  serial += 1
  return {
    ...(chance(0.85) ? { event_id: `enc-${serial}` } : {}),
    event_type: 'EncounterCreated',
    actor_id: maybe(null),
    payload: maybe({
      encounter: maybe({
        theme: pick(['ambush', 'crypt', 'cave', 'forest', undefined, 'AMBUSH']),
        difficulty: pick(['easy', 'medium', 'hard', 'deadly', 'deadly', undefined, 'DEADLY']),
        enemies: maybe(Array.from({ length: int(0, 14) }, () => maybe({ name: maybe(pick(NAMES)) }))),
      }),
    }, 0.04),
  }
}

for (let index = 0; index < 900; index += 1) {
  const events = []
  for (let at = 0; at < int(1, 4); at += 1) {
    const roll = random()
    if (roll < 0.5) events.push(created())
    else if (roll < 0.7) events.push({ event_type: 'CombatStarted', payload: {} })
    else if (roll < 0.9) events.push({ event_type: pick(['TurnStarted', 'ObjectiveUpdated', ['EncounterCreated']]), payload: {} })
    else events.push(pick([5, 'событие', [], {}]))
  }
  const state = chance(0.95) ? {
    ...(chance(0.8) ? { scene: { ...(chance(0.7) ? { theme: pick(THEMES) } : {}), ...(chance(0.3) ? { map: { theme: pick(THEMES) } } : {}) } } : {}),
    ...(chance(0.6) ? { mechanics: { world_time: chance(0.9) ? { elapsed_minutes: int(0, 3000) } : garbage() } } : {}),
  } : garbage()
  record('encounterNarration', chance(0.05) ? [events] : [events, state], 'random')
  if (index % 3 === 0) record('hasEncounterEvent', [events], 'random')
}

console.log('урезание:', stats)
writer.write(new URL('./encounter-narration.json.gz', import.meta.url))

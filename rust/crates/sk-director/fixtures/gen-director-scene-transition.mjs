import '../../../fixtures-env.mjs'
// Эталон server/director-scene-transition.mjs для Rust:
//
//   node rust/crates/sk-director/fixtures/gen-director-scene-transition.mjs
//
// Секция `calls` (`director-scene-transition.json.gz`): вызовы экспортов —
//   - перехват тестов JS (переход Режиссёра, часы перехода, опознание места);
//   - переходы корпуса `Dnd-narrator-live/tmp/corpus-v1` (`AdvanceScene`:
//     состояние до команды, её `scene_args`, решение группы и торговый
//     замысел);
//   - случайные состояния, сцены, лавки, решения группы, отказы от задания,
//     пакеты событий и мусор.
// У `buildDirectorTransitionCommands` итог перехода и предложение лавки
// хранятся SHA-256 строки `JSON.stringify`. Крупные аргументы — один раз в
// секции `values`, в вызове — `{ $ref: n }`.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { argsFrom, argsOf, captureTests, errorOf, hash, mulberry32, picker, plain, writeFixture } from './common.mjs'

const root = new URL('../../../../', import.meta.url)
const ds = await import(new URL('server/director-scene-transition.mjs', root).href)

const FIXTURE = new URL('./director-scene-transition.json.gz', import.meta.url)
const CORPUS_DIR = 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'
const { int, pick, chance } = picker(mulberry32(2026_10_17_2))
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const isPlain = (value) => value && typeof value === 'object' && !Array.isArray(value)
const FNS = ['resolvedPartyDecisionReference', 'directorTransitionFingerprint', 'directorDecisionFingerprint', 'buildDirectorTransitionCommands', 'assertDirectorTransitionResult']
const STATE_KEYS = ['sessionCode', 'state_version', 'scene', 'adventure', 'worldMap', 'locationMaps', 'merchants', 'agentInteraction', 'mechanics', 'campaignConcept', 'worldMemory', 'scenario']

function run(fn, encoded) {
  try {
    const value = ds[fn](...argsFrom(encoded))
    let out = value === undefined ? null : plain(value)
    if (fn === 'buildDirectorTransitionCommands' && out) out = { ...out, transition: hash(out.transition), shopProposal: out.shopProposal == null ? null : hash(out.shopProposal) }
    return { out }
  } catch (error) {
    return { error: errorOf(error) }
  }
}

const calls = []
const seen = new Set()
const counts = {}
function add(fn, args, label, { limit = 500 } = {}) {
  if ((counts[fn] ?? 0) >= limit) return null
  let encoded = argsOf(args)
  const key = JSON.stringify([fn, encoded])
  if (seen.has(key)) return null
  seen.add(key)
  const outcome = run(fn, encoded)
  const input = encoded.args[0]
  if (fn === 'buildDirectorTransitionCommands' && isPlain(input) && isPlain(input.state)) {
    const trimmed = Object.fromEntries(Object.entries(input.state).filter(([field]) => STATE_KEYS.includes(field)))
    const candidate = { ...encoded, args: [{ ...input, state: trimmed }, ...encoded.args.slice(1)] }
    if (JSON.stringify(run(fn, candidate)) === JSON.stringify(outcome)) encoded = candidate
  }
  counts[fn] = (counts[fn] ?? 0) + 1
  calls.push({ fn, label, ...encoded, ...outcome })
  return outcome
}

// --- перехват тестов ---------------------------------------------------------------------

const captured = await captureTests(
  ['director-scene-transition', 'director-transition-clock', 'location-identity'],
  { '/server/director-scene-transition.mjs': FNS },
  { limit: 100 },
)
console.log(`перехвачено вызовов: ${captured.length}`)
for (const record of captured) add(record.fn, argsFrom(record), `test/${record.test}`)

// --- корпус --------------------------------------------------------------------------------

let corpusCases = 0
const corpusSeen = new Set()
if (existsSync(CORPUS_DIR)) {
  for (const file of readdirSync(CORPUS_DIR).filter((name) => name.startsWith('corpus-')).sort()) {
    for (const line of readFileSync(join(CORPUS_DIR, file), 'utf8').split('\n')) {
      if (!line.includes('"command_type":"AdvanceScene"') || corpusCases >= 60) continue
      const entry = JSON.parse(line)
      if (entry.command?.command_type !== 'AdvanceScene' || corpusSeen.has(entry.state)) continue
      const statePath = join(CORPUS_DIR, 'states', `${entry.state}.json`)
      if (!existsSync(statePath)) continue
      corpusSeen.add(entry.state)
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      // Карты в сотни килобайт эталон не украшают: берутся места поменьше.
      if (JSON.stringify(Object.fromEntries(Object.entries(state).filter(([field]) => STATE_KEYS.includes(field)))).length > 60_000) continue
      const sceneArgs = entry.command.scene_args ?? {}
      const commerce = entry.command.scene_commerce
      const shopIntent = isPlain(commerce) ? Object.fromEntries(Object.entries(commerce).filter(([field]) => ['action', 'settlement_type', 'theme', 'budget_cp', 'reason'].includes(field))) : undefined
      const label = `corpus/${file}/${entry.command.command_id}`
      add('buildDirectorTransitionCommands', [{
        campaignId: state.sessionCode ?? 'CORPUS', action: `[РЕШЕНИЕ ГРУППЫ] Идём: ${sceneArgs.location ?? sceneArgs.title ?? '?'}`, state, sceneArgs, shopIntent,
        partyDecision: entry.command.party_decision ?? { interaction_id: 'corpus-vote', resolved_option_id: 'go' },
        ...(chance(0.2) ? { abandonQuest: { id: 'quest:main', title: 'Главное задание' } } : {}),
      }], label)
      corpusCases += 1
    }
  }
}
console.log(`переходов корпуса: ${corpusCases}`)

// --- случайные входы ------------------------------------------------------------------------

const JUNK = [undefined, null, '', '  ', 'строка', 5, 0, true, [], {}, ['a'], 'constructor']
const junk = () => pick(JUNK)
const PLACES = [
  ['Город Норвин', 'городские улицы', 'streets'], ['Серая чаща', 'дикая местность', null], ['Склеп Норвин', 'склеп', 'rooms'], ['Старый тракт', 'дорога', null],
  ['Деревня Ольшанка', 'деревня', null], ['Портовый рынок', '', null], ['Пещера ветров', 'cave', null], ['Застава у брода', 'outpost', null],
  ['Twin Market', 'market', 'streets'], ['Тихий холм', '', null], ['Дальний рубеж', 'дорога', null], ['Храм луны', 'храм', null],
]
const DECISIONS = () => pick([
  undefined, null, junk(),
  { interaction_id: 'vote-1', resolved_option_id: 'go' },
  { interaction_id: ' vote-2 ', resolved_option_id: 'city' },
  { interaction_id: 'плохой id', resolved_option_id: 'go' },
  { interaction_id: 'vote-3' },
  { resolved_option_id: 5 },
  { id: 'decision-1', type: 'vote', status: 'resolved', resolvedOptionId: 'go', options: [{ id: 'go' }] },
  { id: 'decision-1', status: 'pending', resolvedOptionId: 'go', options: [{ id: 'go' }] },
  { id: 'decision-1', status: 'resolved', resolvedOptionId: 'other', options: [{ id: 'go' }] },
  { id: 'decision-1', status: 'resolved', resolvedOptionId: 'go', options: 'go' },
  { id: '', status: 'resolved', resolvedOptionId: 'go', options: [{ id: 'go' }] },
  { agentInteraction: { id: 'decision-4', status: 'resolved', resolvedOptionId: 'go', options: [null, { id: 'go' }] } },
  { agentInteraction: null, id: 'decision-5', status: 'resolved', resolvedOptionId: 'go', options: [{ id: 'go' }] },
])

function randomState() {
  const [location] = pick(PLACES)
  return {
    sessionCode: pick(['DIRECTOR-1', 'D2']),
    state_version: pick([7, 0, '3', undefined, 'x']),
    players: [{ id: 'hero', x: 1, y: 1 }],
    merchants: pick([[], [{ id: 'norvin-shop', location: '  ГОРОД   НОРВИН  ', stock: [] }], [{ id: 'east-shop', location: 'Twin Market', location_id: 'market-east', stock: [] }], [null], 'shops', undefined]),
    scene: pick([{ title: 'Склеп', location, objective: 'Найти выход', turn: 3, cells: [] }, { title: 'Глава 1', location: '', turn: 1, cells: [] }, { location: 'Тихая застава', location_id: 'start', turn: 1, cells: [] }]),
    adventure: { chapter: 1, history: [], visitedLocations: [location] },
    ...(chance(0.5) ? { worldMap: {
      version: 1, seed: 'W', name: 'Карта', width: 1000, height: 640, currentLocationId: 'start',
      regions: [{ id: 'plains', name: 'Равнины', biome: 'plains', x: 300, y: 300, radius: 200 }],
      locations: [
        { id: 'start', name: 'Тихая застава', kind: 'village', x: 200, y: 300, regionId: 'plains', known: true, visited: true },
        { id: 'target', name: 'Дальний рубеж', kind: 'landmark', x: 600, y: 300, regionId: 'plains', known: true, visited: false },
        { id: 'market-east', name: 'Twin Market', kind: 'town', x: 400, y: 200, regionId: 'plains', known: true, visited: false },
      ],
      routes: [{ id: 'r1', from: 'start', to: 'target', kind: 'road', distance: pick([4, 1, 12]), danger: 'низкая', discovered: true }],
    } } : {}),
    mechanics: { world_time: { elapsed_minutes: 5 }, combat: { active: false } },
    ...(chance(0.7) ? { agentInteraction: pick([
      { id: 'decision-1', type: 'vote', status: 'resolved', resolvedOptionId: 'go', options: [{ id: 'go', label: 'Идём' }], votes: { hero: 'go' } },
      { id: 'decision-1', status: 'open', options: [] },
    ]) } : {}),
  }
}

function randomSceneArgs(index) {
  if (chance(0.04)) return junk()
  const [location, theme, layout] = pick(PLACES)
  return {
    title: pick([`Глава 2 · ${location}`, location, '']),
    ...(chance(0.9) ? { location } : {}),
    ...(chance(0.3) ? { location_id: pick(['target', 'market-east', 'start', 'новое']) } : {}),
    ...(chance(0.8) ? { theme: pick([theme, theme, 'городские улицы', 'дикая местность', '']) } : {}),
    objective: pick(['Найти архив', '', 'Осмотреть следы']),
    seed: `director-${index % 20}`,
    ...(layout && chance(0.7) ? { map: { layout, width: 11, height: 9 } } : chance(0.1) ? { map: { layout: pick(['ROOMS', 'Streets', 'wild']) } } : {}),
  }
}

const SHOP_INTENTS = () => pick([
  undefined, null, junk(),
  { action: 'create', settlement_type: 'city', theme: 'general', budget_cp: 20_000 },
  { action: 'create', settlement_type: 'outpost', theme: 'provisions', budget_cp: 12_000, reason: 'Застава.' },
  { action: 'none', settlement_type: 'city', theme: 'general', budget_cp: 50_000, reason: 'Нет.' },
  { action: 'create', settlement_type: 'village', theme: 'smith', budget_cp: 5_000 },
  { action: 'create', extra: true },
])

for (let index = 0; index < 420; index += 1) {
  const state = chance(0.03) ? junk() : randomState()
  add('buildDirectorTransitionCommands', [chance(0.02) ? undefined : {
    campaignId: chance(0.9) ? pick(['DIRECTOR-1', '  D  ']) : pick(['', undefined]),
    action: chance(0.92) ? pick(['[РЕШЕНИЕ ГРУППЫ] Идём в город', '  Идём   в город ', `[РЕШЕНИЕ ГРУППЫ] nonce-${int(3)}`]) : pick(['', undefined]),
    state,
    sceneArgs: randomSceneArgs(index),
    shopIntent: SHOP_INTENTS(),
    ...(chance(0.7) ? { partyDecision: DECISIONS() } : {}),
    ...(chance(0.3) ? { abandonQuest: pick([{ id: 'quest:main', title: 'Найти выход' }, { id: 'quest:2' }, { id: '' }, null, { title: 'Без id' }]) } : {}),
  }], 'random/build')
}
for (let index = 0; index < 200; index += 1) {
  add('resolvedPartyDecisionReference', [DECISIONS(), pick([undefined, {}, { required: false }, { required: true }])], 'random/decision')
}
for (let index = 0; index < 60; index += 1) {
  add('directorTransitionFingerprint', [pick([{ campaignId: 'DIRECTOR-1', action: pick(['Идём в город', '  Идём   в город ', 'Идём в лес', '', 'x'.repeat(2100)]) }, { campaignId: '', action: 'a' }, {}])], 'random/fingerprint')
  add('directorDecisionFingerprint', [{ campaignId: pick(['DIRECTOR-1', '', 5]), partyDecision: DECISIONS() }], 'random/fingerprint')
}
const FP = 'a'.repeat(64)
const EVENTS = () => pick([
  { event_type: 'SceneAdvanced', payload: { request_fingerprint: FP } },
  { event_type: 'SceneAdvanced', payload: { request_fingerprint: 'b'.repeat(64) } },
  { event_type: 'MerchantCreated', payload: { request_fingerprint: pick([FP, 'other']) } },
  { event_type: 'QuestResolved', payload: { outcome: pick(['abandoned', 'success']), request_fingerprint: pick([FP, 'other', undefined]) } },
  { event_type: 'TimeAdvanced', payload: {} },
  null,
])
for (let index = 0; index < 120; index += 1) {
  add('assertDirectorTransitionResult', [pick([{ mechanics: Array.from({ length: int(4) }, EVENTS) }, { mechanics: [EVENTS(), EVENTS()] }, junk()]), pick([FP, FP, undefined, 'b'.repeat(64)])], 'random/assert')
}

const values = []
const refs = new Map()
for (const call of calls) {
  call.args = call.args.map((value) => {
    if (!isPlain(value) || !isPlain(value.state)) return value
    const text = JSON.stringify(value.state)
    if (text.length < 1500) return value
    if (!refs.has(text)) {
      refs.set(text, values.length)
      values.push(clone(value.state))
    }
    return { ...value, state: { $ref: refs.get(text) } }
  })
}
writeFixture(FIXTURE, { values, calls }, { gzip: true })
const byFn = {}
for (const call of calls) byFn[`${call.fn}${call.error ? ` ${call.error.code ?? call.error.name}` : ''}`] = (byFn[`${call.fn}${call.error ? ` ${call.error.code ?? call.error.name}` : ''}`] ?? 0) + 1
console.log(Object.entries(byFn).map(([fn, n]) => `${fn} ${n}`).join(', '))

import '../../../fixtures-env.mjs'
import { startCapture, quietly } from './story-hook.mjs'
// Эталон server/scene-canon.mjs для Rust:
//
//   node rust/crates/sk-world-story/fixtures/gen-scene-canon.mjs [каталог корпуса]
//
// Источники входов:
//
// - `test/scene-canon.test.mjs` целиком под перехватом: бутстрап кампании,
//   бриф Рассказчика, проверка повествования, готовые миры — каждый верхний
//   вызов модуля из конвейера записывается;
// - размеченный набор `eval/scene-canon-cases-2026-10-01.json` и сохранённые
//   тексты моделей `eval/*.json` — проверка противоречий и сенсорные якоря на
//   канонах всех фаз, погод и крыш;
// - корпус паритета: канон сцены по состояниям кампаний (`tmp/corpus-v1`) для
//   каждого героя;
// - случайные вводные владельца, сиды старта, окружения брифа и мусор.
//
// Состояние для `sceneCanonFor` урезается (без `locationMaps`, памяти мира,
// клеток сцены); JS исполняется заново на урезанном входе и сверяется с
// исходом на полном — Rust получает ровно его.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { fixtureWriter, mulberry32, chooser, viaJson, same, PROTOTYPE_KEYS, corpusDir, corpusStateText } from './story-lib.mjs'

const root = new URL('../../../../', import.meta.url)
const C = await import(new URL('server/scene-canon.mjs', root).href)
const W = await import(new URL('server/weather.mjs', root).href)

const writer = fixtureWriter('scene-canon', ['campaignConcept', 'worldMap', 'map', 'social', 'npc_world', 'locationMaps'])
const random = mulberry32(2026_10_16)
const { int, pick, chance } = chooser(random)

const FNS = {
  sceneCanonFor: { states: [0] },
  sceneCanonFromEnvironment: { states: [0] },
  requestedOpeningCanon: { states: [] },
  campaignStartCanon: { states: [] },
  sensoryAnchorConflicts: { states: [1] },
  sceneCanonContradictions: { states: [1] },
}

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)
const DROP = ['locationMaps', 'worldMemory', 'events', 'chronicle', 'history', 'transcript', 'narration_log', 'usage', 'rulings']
function slim(state) {
  if (!isObject(state)) return state
  const out = { ...state }
  for (const key of DROP) delete out[key]
  if (isObject(out.scene)) {
    out.scene = { ...out.scene }
    delete out.scene.cells
  }
  return out
}

const ACTOR_KEYS = ['id', 'actor_id', 'name', 'character', 'alive', 'hp', 'x', 'y', 'visibility', 'visibility_level', 'hidden', 'secret', 'reveal_on_presence', 'player_id', 'playerId', 'owner_id', 'visible_to', 'footprint', 'size', 'conditions']
const pickList = (list) => (Array.isArray(list) ? list.map((item) => (isObject(item) ? Object.fromEntries(ACTOR_KEYS.filter((key) => Object.hasOwn(item, key)).map((key) => [key, item[key]])) : item)) : list)
/** Сильное урезание: только то, что читают канон, часы мира и NPC сцены. */
function strict(state) {
  const out = slim(state)
  if (!isObject(out)) return out
  for (const key of ['autonomy', 'battleLog', 'merchants', 'scenario_attention', 'partyDecisionPolicy', 'worldMemory', 'world_deeds', 'captives', 'courier_letters', 'law', 'offscreen_world', 'campaignConcept']) delete out[key]
  if (out.players !== undefined) out.players = pickList(out.players)
  if (out.enemies !== undefined) out.enemies = pickList(out.enemies)
  return out
}

function outcome(name, args) {
  try {
    return { value: viaJson(C[name](...args)) }
  } catch (error) {
    return { error: String(error?.name) + String(error?.message) }
  }
}

const stats = { stripped: 0, full: 0 }
function prepare(name, args) {
  if (name !== 'sceneCanonFor') return args.map(viaJson)
  const expected = quietly(() => outcome(name, args.map(viaJson)))
  for (const strip of [strict, slim]) {
    const candidate = args.map((arg, index) => viaJson(index === 0 ? strip(arg) : arg))
    if (same(quietly(() => outcome(name, candidate)), expected)) {
      stats.stripped += 1
      return candidate
    }
  }
  stats.full += 1
  return args.map(viaJson)
}

function record(name, args, cap = Infinity) {
  if ((writer.counts.get(name) ?? 0) >= cap) return false
  return quietly(() => writer.call(name, (...input) => C[name](...input), prepare(name, args), { stateArgs: FNS[name].states, cap }))
}

function capture(module, name, args) {
  if (module !== 'server/scene-canon.mjs' || !FNS[name]) return
  try {
    record(name, args, 600)
  } catch { /* вход не сериализуется */ }
}

// ---------------------------------------------------------------------------
// 1. Тесты модуля под перехватом

const stop = startCapture(capture)
const finished = new Promise((resolve) => {
  process.once('beforeExit', resolve)
})
await import(new URL('test/scene-canon.test.mjs', root).href)
await finished
stop()
console.log('тесты:', JSON.stringify(stats), JSON.stringify(Object.fromEntries(writer.counts)))

// ---------------------------------------------------------------------------
// 2. Тексты: размеченный набор и сохранённые ответы моделей

const labelled = JSON.parse(readFileSync(new URL('eval/scene-canon-cases-2026-10-01.json', root), 'utf8')).cases
const texts = labelled.map((entry) => entry.text)
for (const file of readdirSync(new URL('eval/', root)).filter((name) => name.endsWith('.json')).sort()) {
  let data
  try { data = JSON.parse(readFileSync(new URL(`eval/${file}`, root), 'utf8')) } catch { continue }
  const walk = (value) => {
    if (texts.length > 1_400) return
    if (typeof value === 'string') {
      if (value.length >= 40 && /[а-яё]/iu.test(value)) texts.push(value)
    } else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(data)
}
const uniqueTexts = [...new Set(texts)]
console.log('текстов:', uniqueTexts.length)

const PHASES = ['morning', 'day', 'evening', 'night', '']
const WEATHERS = ['clear', 'overcast', 'rain', 'fog', 'storm', '']
const CLOCKS = { morning: ['08:00', '06:10', '05:30', '10:15'], day: ['13:00', '11:50', '16:40'], evening: ['19:00', '17:20', '21:30'], night: ['23:00', '02:00', '22:30', '04:50'], '': [''] }
function environmentCanon(phase = pick(PHASES), weather = pick(WEATHERS), indoors = chance(0.3)) {
  return C.sceneCanonFromEnvironment({
    world_clock: {
      day: 1, clock: pick(CLOCKS[phase]), time_of_day: phase || 'morning', time_of_day_label: phase ? W.dayPhaseLabel(phase) : '',
      weather, weather_label: W.weatherConditionLabel(weather), weather_summary: W.weatherConditionSummary(weather), indoors, effects: [],
    },
    scene: { location: pick(['Причал Аквилона', 'Таверна «Ночной якорь»', 'Лесная тропа', 'Склеп']) },
  })
}
const EVENTS = [
  [], [{ event_type: 'TimeAdvanced', payload: {} }], [{ event_type: 'WeatherChanged' }], [{ event_type: 'SpellCast', payload: { spell: 'Туманное облако' } }],
  [{ event_type: 'SpellCast', payload: { spell_id: 'call-lightning', name: 'Призыв молнии' } }], [{ eventType: 'TravelCompleted' }], [null, 5, 'x'],
  [{ event_type: 'DamageApplied', payload: { damage_type: 'radiant', source: 'sunbeam' } }],
]

// Каноны размеченного набора — как в тесте.
for (const entry of labelled) {
  const canon = C.sceneCanonFromEnvironment({
    world_clock: {
      day: 1, clock: entry.canon.clock, time_of_day: entry.canon.phase, time_of_day_label: W.dayPhaseLabel(entry.canon.phase),
      weather: entry.canon.weather, weather_label: W.weatherConditionLabel(entry.canon.weather), weather_summary: W.weatherConditionSummary(entry.canon.weather),
      indoors: entry.canon.indoors, effects: [],
    },
    scene: { location: entry.canon.location },
  })
  record('sceneCanonContradictions', [entry.text, canon])
}
for (const [index, narration] of uniqueTexts.entries()) {
  const canon = environmentCanon()
  record('sceneCanonContradictions', chance(0.1) ? [narration, canon, { events: pick(EVENTS) }] : [narration, canon], 6_000)
  if (index % 3 === 0) record('sensoryAnchorConflicts', [narration.slice(0, int(20, 200)), environmentCanon()], 3_000)
}
// Склейки фраз: каждая погода и фаза против каждого текста набора.
for (const phase of PHASES) {
  for (const weather of WEATHERS) {
    for (const indoors of [false, true]) {
      const canon = environmentCanon(phase, weather, indoors)
      for (let i = 0; i < 12; i += 1) record('sceneCanonContradictions', [`${pick(texts)} ${pick(texts)}`, canon], 9_000)
    }
  }
}
// Якоря и мусор.
const ANCHORS = ['сухой сквозняк у пола', 'пыль на досках причала', 'запах мокрого дерева', 'холод каменного свода', 'солнечные блики на воде', 'стук дождя по крыше', 'туман в голове', '']
const junk = () => pick([null, undefined, '', 0, 7, true, [], {}, 'строка', [1, 2], { time: 1 }, ...PROTOTYPE_KEYS.slice(0, 3)])
for (let i = 0; i < 600; i += 1) {
  const canon = chance(0.85) ? environmentCanon() : junk()
  record('sensoryAnchorConflicts', [chance(0.9) ? pick(ANCHORS) : junk(), canon], 4_000)
  record('sceneCanonContradictions', [chance(0.9) ? pick(texts) : junk(), canon, chance(0.2) ? junk() : { events: chance(0.5) ? pick(EVENTS) : junk() }], 10_000)
}
// Окружение брифа.
for (let i = 0; i < 700; i += 1) {
  const phase = pick([...PHASES, 'midnight', 'constructor', null])
  const weather = pick([...WEATHERS, 'snow', 7, null])
  const environment = chance(0.08) ? junk() : {
    ...(chance(0.1) ? { scene_canon: pick([{ time: { phase: 'day' }, weather: { id: 'rain' } }, { time: null, weather: {} }, [], 'x', { time: 1, weather: 1, extra: true }]) } : {}),
    ...(chance(0.93) ? { world_clock: chance(0.9) ? {
      ...(chance(0.8) ? { day: pick([1, 3, '2', null, undefined]) } : {}),
      clock: pick(['08:00', '23:59', '7:05', '', null, 800, '  12:00  ', '24:00:00']),
      time_of_day: phase, time_of_day_label: pick(['', 'Утро', null, '  Глубокая   ночь  ', 'ОЧЕНЬ ДЛИННАЯ ПОДПИСЬ ВРЕМЕНИ СУТОК ВЕЧЕР НОЧЬ УТРО']),
      weather, indoors: pick([true, false, 1, 0, 'yes', null, undefined]),
    } : junk() } : {}),
    ...(chance(0.8) ? { scene: chance(0.9) ? {
      location: pick(['Причал Аквилона', 'Берег реки', 'Таверна «Пирс»', '', null, 'Гавань', 'Мост над оврагом']),
      ...(chance(0.5) ? { title: pick(['Старый порт', 'Пещера', '']) } : {}),
      ...(chance(0.3) ? { theme: pick(['болото', 'harbor', 'пустыня']) } : {}),
      ...(chance(0.3) ? { mood: pick(['тревожно', 'у озера тихо']) } : {}),
      ...(chance(0.4) ? { spatial_context: { current_area: { indoors: pick([true, false, 'yes', null]) } } } : {}),
    } : junk() } : {}),
    ...(chance(0.6) ? { story_context: chance(0.9) ? {
      heroes: pick([[{ name: 'Ада' }, { name: '  Бран  ' }], [null, { name: '' }, 'x'], junk(), Array.from({ length: 12 }, (_, k) => ({ name: `Герой ${k}` }))]),
      present_npcs: pick([[{ name: 'Иара' }], [], junk()]),
    } : junk() } : {}),
  }
  record('sceneCanonFromEnvironment', chance(0.03) ? [] : [environment], 3_000)
}

// ---------------------------------------------------------------------------
// 3. Вводные владельца и старт кампании

const OPENINGS = [
  'Ночь, гроза.', 'Утро над причалом серое и тихое.', 'Таверна «Ночной якорь» в полдень.', 'Не ночь, а ясный день.', 'После грозы пахнет мокрой землёй.',
  'Вечером, в сумерках, отряд подходит к таверне.', 'В полночь бьёт колокол.', 'Ясно. Небо безоблачно.', 'Ясно, что дождя не будет.', 'Туман в голове после долгой ночи.',
  'Дождь кончился, и туман рассеивается.', 'Вчера ночью был ливень, сегодня солнечное утро.', 'Пасмурное небо, моросит.', 'Звёздная ночь над морем.',
  'Через час рассвет.', 'Каждую ночь сюда приходят волки.', 'Погожий день, жаркий день.', '“Ночь будет долгой”, — говорит он. Утром светает.',
  'Буря на горизонте. Ясное небо над головой.', 'Метель и снег.', 'Среди бела дня на рынке.', 'Если начнётся гроза — бегите.', 'Говорят, ночью тут видели призрака.',
]
for (let i = 0; i < 800; i += 1) {
  const value = () => (chance(0.85) ? `${pick(OPENINGS)}${chance(0.4) ? ` ${pick(OPENINGS)}` : ''}${chance(0.1) ? ` ${pick(texts)}` : ''}` : junk())
  const world = chance(0.05) ? junk() : {
    ...(chance(0.8) ? { openingSituation: value() } : {}),
    ...(chance(0.6) ? { premise: value() } : {}),
  }
  record('requestedOpeningCanon', chance(0.02) ? [] : [world], 2_000)
}
for (const text of [...uniqueTexts.slice(0, 400), ...labelled.map((entry) => entry.text)]) record('requestedOpeningCanon', [{ openingSituation: text }], 4_000)

const SEEDS = ['', 'astohan', 'CANON-PIER', '  сид  с пробелами  ', 'x'.repeat(200), null, undefined, 7, {}, ['a', 'b']]
for (let i = 0; i < 400; i += 1) {
  const request = chance(0.15) ? junk() : { phase: pick(['morning', 'day', 'evening', 'night', 'midnight', '', 'dawn', 'constructor', '__proto__', 'toString', null]), weather: pick([...WEATHERS, 'snow', 'constructor', null]) }
  record('campaignStartCanon', chance(0.05) ? [] : chance(0.05) ? [pick(SEEDS)] : [chance(0.5) ? pick(SEEDS) : `seed-${int(0, 10_000)}`, request], 1_000)
}

// ---------------------------------------------------------------------------
// 4. Корпус паритета: канон сцены по состояниям кампаний

const dir = corpusDir(process.argv[2])
if (dir) {
  let taken = 0
  for (const file of readdirSync(join(dir, 'states')).sort()) {
    if (taken >= 200) break
    if (!chance(0.06)) continue
    const text = corpusStateText(dir, file.replace(/\.json$/u, ''))
    if (!text || text.length > 900_000) continue
    let state
    try { state = JSON.parse(text) } catch { continue }
    taken += 1
    const heroes = (Array.isArray(state.players) ? state.players : []).map((hero) => hero?.id).filter(Boolean)
    const viewers = [{}, ...heroes.slice(0, 2).map((id) => ({ playerId: id, actorId: id })), { playerId: 'stranger' }]
    for (const viewer of viewers) record('sceneCanonFor', [state, viewer], 2_500)
  }
  console.log(`корпус: состояний ${taken}`)
} else {
  console.log('корпус не найден — пропущен')
}

console.log('итого:', JSON.stringify(stats))
writer.write(new URL('./scene-canon.json.gz', import.meta.url), {
  constants: { SCENE_CANON_VERSION: C.SCENE_CANON_VERSION, SCENE_CANON_CONTRADICTION: C.SCENE_CANON_CONTRADICTION },
})

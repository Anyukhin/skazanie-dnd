import '../../../fixtures-env.mjs'
// Эталон server/weather.mjs для Rust:
//
//   node rust/crates/sk-world-time/fixtures/gen-weather.mjs [--corpus <каталог states>]
//
// Пишет `weather.json.gz`.
//
// Секции:
// - `clock` — часы по минутам кампании, в том числе рыхлые значения JS;
// - `days` — погода дня по сидам, дням и климатам (сотни сидов);
// - `labels`, `pins`, `narration`, `scenes`, `effects` — подписи, закрепления,
//   строки летописи, «под крышей» по сцене и таблица эффектов;
// - `states` — урезанные состояния (корпус паритета, сцены всех тем из живого
//   генератора, смешанные карты крепости, мусор старых сохранений) и sha256
//   опроса `probe` (`weather-probe.mjs`). Урезание проверено: опрос полного и
//   урезанного состояния совпадает. Первые случаи хранят опрос целиком —
//   для отладки расхождения.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { mulberry32, picker, writeFixture } from '../../sk-buildings/fixtures/common.mjs'
import { probe, probeActorIds } from './weather-probe.mjs'
import { trimState } from './weather-trim.mjs'

const w = await import('../../../../server/weather.mjs')
const { SCENE_THEMES } = await import('../../../../server/scene-themes.mjs')
const { generateSceneCells } = await import('../../../../server/adventure-director.mjs')
const { normalizeCampaignState } = await import('../../../../server/rules-engine.mjs')
const t = await import('../../../../server/tactical-map.mjs')

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const plain = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)))
const { int, pick, chance } = picker(mulberry32(2026_10_16))

const corpusAt = process.argv.indexOf('--corpus')
const CORPUS = corpusAt > 0 ? process.argv[corpusAt + 1] : 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1/states'

// ---------------------------------------------------------------------------
// Чистые функции
// ---------------------------------------------------------------------------

const MINUTE_INPUTS = [0, 1, 299, 300, 301, 659, 660, 1_019, 1_020, 1_319, 1_320, 1_439, 1_440, 1_260, 1_261, 2_700, 2_701,
  -1, -1_440, 1.5, '30', '  45 ', '', 'x', null, true, false, [], [5], { a: 1 }, 5_000_000, 5_000_001, 9_007_199_254_740_991,
  9_007_199_254_740_992, 1e300, -0]
for (let index = 0; index < 120; index += 1) MINUTE_INPUTS.push(int(200_000))
const TARGETS = [0, 300, -1, -1_441, 1_439, 1_440, 2.7, -2.7, '600', null, 'x', true, 1e21]
const clock = MINUTE_INPUTS.map((minute) => ({
  minute,
  clock_minute: w.clockMinuteOf(minute),
  label: w.clockLabelOf(minute),
  day: w.campaignDayOf(minute),
  phase: w.timeOfDayOf(minute),
  until: TARGETS.map((target) => w.minutesUntilClock(minute, target)),
  elapsed: w.elapsedMinutesOf({ mechanics: { world_time: { elapsed_minutes: minute } } }),
}))

const BIOMES = [...Object.keys(w.BIOME_WEATHER_WEIGHTS), 'unknown', '', 'constructor', '__proto__', 'toString', 'Plains']
const SEEDS = ['weather-seed', 'иной-сид', '', 'WEATHER-1', 'astohan', '0', 'сид с пробелом', '🌧️ seed']
for (let index = 0; index < 200; index += 1) SEEDS.push(`seed-${int(1_000_000).toString(36)}-${index}`)
const days = []
for (const seed of SEEDS) {
  for (const biome of BIOMES) {
    const count = seed === 'weather-seed' ? 400 : 12
    const list = []
    for (let day = 0; day < count; day += 1) list.push(w.weatherOnDay({ seed, day, biome }))
    days.push({ seed, biome, from: 0, weather: list.join(',') })
  }
}
for (const day of [-1, -0.5, 0.9, 1.9, '3', 'x', null, 1e21, 2 ** 40, -(2 ** 40)]) {
  days.push({ seed: 'weather-seed', biome: 'marsh', day, weather: w.weatherOnDay({ seed: 'weather-seed', day, biome: 'marsh' }) })
}

const LABEL_IDS = [...w.DAY_PHASE_IDS, ...w.WEATHER_CONDITION_IDS, 'snow', '', 'constructor', null, 5, ['rain']]
const labels = LABEL_IDS.map((id) => ({
  id,
  phase: w.dayPhaseLabel(id),
  weather: w.weatherConditionLabel(id),
  summary: w.weatherConditionSummary(id),
}))

const PIN_LISTS = [
  [{ day: 0, weather: 'storm' }],
  [{ day: 0.5, weather: 'storm' }, { day: 0, weather: 'snow' }, null],
  [{ day: '0', weather: 'rain' }, { day: 0, weather: ['fog'] }],
  [{ day: 1, weather: 'clear' }, { day: 1, weather: 'rain' }],
  [{ day: -0, weather: 'overcast' }],
  [{ day: 2 ** 53, weather: 'rain' }, { day: 3, weather: 'Rain' }],
  'storm',
  { 0: { day: 0, weather: 'storm' } },
  [],
  null,
]
const pins = []
for (const list of PIN_LISTS) {
  for (const day of [0, 1, 3, -0.4, 0.7, '1', null, 2 ** 53]) {
    pins.push({ pins: list, day, weather: w.pinnedWeatherOn({ mechanics: { weather_pins: list } }, day) })
  }
}
pins.push({ state: null, day: 0, weather: w.pinnedWeatherOn(null, 0) })

const EVENTS = [
  ...w.DAY_PHASE_IDS.map((phase) => ({ event_type: 'TimeOfDayChanged', payload: { phase_after: phase } })),
  ...w.WEATHER_CONDITION_IDS.flatMap((weather) => [
    { event_type: 'WeatherChanged', payload: { weather_after: weather, reason: 'day' } },
    { event_type: 'WeatherChanged', payload: { weather_after: weather, reason: 'region' } },
  ]),
  { event_type: 'WeatherChanged', payload: { weather_after: 'snow', reason: 'region' } },
  { event_type: 'WeatherChanged', payload: { weather_after: 'snow' } },
  { event_type: 'WeatherChanged', payload: null },
  { event_type: 'WeatherChanged' },
  { event_type: 'TimeOfDayChanged', payload: { phase_after: 'dusk' } },
  { event_type: 'TimeOfDayChanged', payload: 'night' },
  { event_type: 'AttackResolved', payload: {} },
  { payload: { phase_after: 'night' } },
  null,
  // Ключи прототипа: JS находит функцию вместо строки и печатает её исходник.
  ...['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'].flatMap((key) => [
    { event_type: 'TimeOfDayChanged', payload: { phase_after: key } },
    { event_type: 'WeatherChanged', payload: { weather_after: key, reason: 'region' } },
  ]),
]
// Строка летописи; функция (ключ прототипа) — её `String(...)`.
const narration = EVENTS.map((event) => {
  const line = w.worldClockNarration(event)
  return { event, text: typeof line === 'string' ? line : String(line) }
})

const THEME_LOCATIONS = {
  building: 'Дом старосты', temple: 'Храм забытого света', crypt: 'Древний склеп', cave: 'Глубокая пещера', forest: 'Тёмный лес',
  road: 'Старый тракт', settlement: 'Деревня Пепел', dungeon: 'Темница под замком', graveyard: 'Старое кладбище',
}
const SCENES = [
  {}, { location: 'Безымянное место', scene_kind: 'dungeon' }, { location: 'Безымянное место', scene_kind: 'wilderness' },
  { map: { theme: 'crypt' } }, { map: { theme: 'castle' }, location: 'Дом старосты' }, { map: { theme: ' crypt ' } },
  { map: { theme: 'forest' }, location: 'Древний склеп' }, { location: 'Таверна «Пьяный гусь»' },
  { location: 'Таверна', scene_kind: 'wilderness' }, { theme: 'склеп', location: 'Поле' }, { location: 42, theme: ['пещера'] },
  { location: 'Крепость Ареса', scene_kind: 'other' }, { scene_kind: ' dungeon ' }, { location: 'Храм\u00a0  света' },
  ...Object.values(THEME_LOCATIONS).flatMap((location) => [{ location }, { location, scene_kind: 'wilderness' }, { theme: location }]),
  ...SCENE_THEMES.map((theme) => ({ map: { theme: theme.id } })),
]
const scenes = SCENES.map((scene) => ({ scene, indoor: w.isIndoorScene(scene) }))

const effects = []
for (const indoors of [false, true]) {
  for (const phase of [...w.DAY_PHASE_IDS, 'dusk']) {
    for (const weather of [...w.WEATHER_CONDITION_IDS, 'snow']) {
      effects.push({ indoors, phase, weather, ids: w.weatherEffectsUnder({ indoors, phase, weather }).map((effect) => effect.id) })
    }
  }
}

// ---------------------------------------------------------------------------
// Состояния
// ---------------------------------------------------------------------------

const states = []
const seenStates = new Set()
let mismatches = 0

function addState(label, full) {
  const fullProbe = probe(w, full)
  const ids = probeActorIds(full)
  const trimmed = trimState(full)
  if (trimmed?.mechanics?.positions && typeof trimmed.mechanics.positions === 'object' && !Array.isArray(trimmed.mechanics.positions)) {
    const positions = {}
    for (const id of ids) if (id && Object.hasOwn(trimmed.mechanics.positions, id)) positions[id] = trimmed.mechanics.positions[id]
    trimmed.mechanics = { ...trimmed.mechanics, positions }
  }
  const input = plain(trimmed)
  const trimmedProbe = probe(w, input)
  if (hash(trimmedProbe) !== hash(fullProbe)) {
    mismatches += 1
    console.error(`урезание меняет исход: ${label}`)
    return
  }
  const key = JSON.stringify(input)
  if (seenStates.has(key)) return
  seenStates.add(key)
  states.push({ label, state: input, probe: hash(trimmedProbe), ...(states.length < 40 ? { full: plain(trimmedProbe) } : {}) })
}

function worldMap(seed = 'weather-seed') {
  return {
    seed,
    currentLocationId: 'road',
    regions: [
      { id: 'north', name: 'Северный край', biome: 'plains', x: 200, y: 200, radius: 205 },
      { id: 'south', name: 'Южный край', biome: 'marsh', x: 200, y: 520, radius: 205 },
      { id: 'east', name: 'Восточный край', biome: 'coast', x: 820, y: 300, radius: 205 },
      { id: 'west', name: 'Западный край', biome: 'desert', x: 20, y: 300, radius: 205 },
    ],
    locations: [
      { id: 'road', name: 'Старый тракт', kind: 'landmark', x: 200, y: 200, regionId: 'north' },
      { id: 'fen', name: 'Гиблая топь', kind: 'wilds', x: 200, y: 520, regionId: 'south' },
      { id: 'shore', name: 'Берег', kind: 'wilds', x: 820, y: 300, regionId: 'east' },
      { id: 'dunes', name: 'Дюны', kind: 'wilds', x: 20, y: 300, regionId: 'west' },
      { id: 'lost', name: 'Нигде', kind: 'wilds', x: 0, y: 0, regionId: 'nowhere' },
    ],
  }
}

function field({ minutes = 0, sceneKind = null, locationId = 'road', cells = null, location = 'Старый тракт', seed = 'weather-seed' } = {}) {
  const grid = cells ?? Array.from({ length: 160 }, (_, index) => ({ x: index % 16, y: Math.floor(index / 16), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'WEATHER-1',
    campaign: 'Небо над трактом',
    partyMemberIds: ['scout'],
    activePlayerId: 'scout',
    players: [{ id: 'scout', character: 'Вельга', characterClass: 'ranger', level: 5, hp: 34, maxHp: 34, x: 1, y: 1 }],
    enemies: [{ id: 'foe', name: 'Разбойник', hp: 30, maxHp: 30, x: 5, y: 1, alive: true }],
    scene: { turn: 1, title: location, location, location_id: locationId, theme: location, cells: grid, ...(sceneKind ? { scene_kind: sceneKind } : {}) },
    worldMap: { ...worldMap(seed), currentLocationId: locationId },
    mechanics: { world_time: { elapsed_minutes: minutes } },
  })
}

function mixedFortress({ minutes, actorAt, locationId = 'road', fill = true }) {
  const state = field({ minutes, locationId, location: 'Крепость Ареса', sceneKind: 'other' })
  const map = t.createTacticalMap({ width: 8, height: 2, locationId: 'ares-fortress', theme: 'fortress', fill: { passable: true, revealed: true } })
  t.addZone(map, { id: 'courtyard', kind: 'exterior', material: 'grass', label: 'Двор' })
  t.addZone(map, { id: 'gallery', kind: 'interior', material: 'stone', label: 'Галерея' })
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (!fill && x === 7) continue
      if (x !== 6) t.setCell(map, x, y, { zone: x < 4 ? 'courtyard' : 'gallery' })
    }
  }
  const { cells: _legacy, ...scene } = state.scene
  return {
    ...state,
    scene: { ...scene, map: t.serializeTacticalMap(map) },
    mechanics: { ...state.mechanics, positions: { ...state.mechanics.positions, scout: actorAt, foe: { x: 6, y: 0 } } },
  }
}

const NOON = (day) => day * w.MINUTES_PER_DAY + (660 - w.CAMPAIGN_START_MINUTE_OF_DAY)
const MINUTE_SET = [0, 299, 300, 900, 1_259, 1_260, NOON(1), NOON(3), NOON(7), NOON(19), NOON(40) + 600]

for (const theme of SCENE_THEMES) {
  const location = THEME_LOCATIONS[theme.id] ?? theme.label
  const cells = generateSceneCells({ theme: location, location, sceneKind: 'other', seed: `weather:${theme.id}`, locationId: 'road', map: {} })
  for (const minutes of MINUTE_SET.slice(0, 6)) {
    addState(`theme:${theme.id}:${minutes}`, field({ minutes, cells, location }))
  }
}
for (const minutes of MINUTE_SET) {
  for (const locationId of ['road', 'fen', 'shore', 'dunes', 'lost', 'absent']) {
    addState(`field:${locationId}:${minutes}`, field({ minutes, locationId }))
  }
  for (const actorAt of [{ x: 1, y: 0 }, { x: 4, y: 0 }, { x: 6, y: 1 }, { x: 7, y: 1 }, { x: 40, y: 0 }, { x: 1.5, y: 0 }, { x: '2', y: 0 }]) {
    for (const fill of [true, false]) {
      addState(`fortress:${minutes}:${JSON.stringify(actorAt)}:${fill}`, mixedFortress({ minutes, actorAt, fill, locationId: chance(0.5) ? 'fen' : 'road' }))
    }
  }
}
// Закреплённое небо и смена края.
for (const minutes of [0, 900, 1_320, 1_500]) {
  const state = field({ minutes })
  state.mechanics.weather_pins = [{ day: 0, weather: 'storm' }, { day: 2, weather: 'fog' }]
  addState(`pins:${minutes}`, state)
}
// Мусор старых сохранений.
const JUNK = [
  {}, { mechanics: null }, { mechanics: { world_time: null } }, { mechanics: { world_time: { elapsed_minutes: '600' } } },
  { mechanics: { world_time: { elapsed_minutes: -5 } }, sessionCode: 'OLD' }, { sessionCode: '  OLD  SAVE ' },
  { worldMap: { seed: 7, currentLocationId: 'a', locations: [{ id: 'a', regionId: 'r' }], regions: [{ id: 'r', biome: 'tundra', name: 7 }] } },
  { worldMap: { seed: '', currentLocationId: 'a', locations: [{ id: 'a', regionId: 'r' }], regions: [{ id: 'r', biome: 'constructor' }] }, sessionCode: 'S' },
  { worldMap: { currentLocationId: ' a ', locations: [{ id: 'a', regionId: ' r ' }], regions: [{ id: 'r', biome: ' desert ' }] } },
  { worldMap: { currentLocationId: 'a', locations: 'x', regions: {} } },
  { worldMap: { currentLocationId: 'a', locations: [{ id: 'a', regionId: 'r' }], regions: [null, 5, { id: 'r', biome: 'mountains', name: 'Горы' }] } },
  { worldMap: [] }, { worldMap: 'map' },
  { scene: { map: { zones: [], layers: {} } }, players: [{ id: 'p', x: 0, y: 0 }] },
  { scene: { map: { zones: 'x', layers: {} } }, players: [{ id: 'p', x: 0, y: 0 }] },
  { scene: { map: { zones: [{ id: 'z', kind: 'interior' }], layers: { zoneId: 'AAAA' }, width: 2, height: 2 } }, players: [{ id: 'p', x: 0, y: 0 }] },
  { scene: { map: [] }, players: [{ id: 'p', x: 0, y: 0 }] },
  { scene: 'scene' }, { scene: null, scene_kind: 'dungeon' },
  { players: [null, 5, { actor_id: 'a', x: 1, y: 1 }], activePlayerId: '   ' },
  { players: [{ id: 7, x: 1, y: 1 }], mechanics: { positions: { 7: { x: 2, y: 2 } } } },
  { players: 'x', actors: [{ id: 'q', x: null, y: null }], activePlayerId: 'q' },
  { activePlayerId: 'constructor', mechanics: { positions: { } }, players: [{ id: 'constructor', x: 1 }] },
]
JUNK.forEach((state, index) => addState(`junk:${index}`, state))
for (let index = 0; index < 60; index += 1) {
  const state = mixedFortress({ minutes: int(40_000), actorAt: { x: int(9), y: int(3) }, fill: chance(0.7), locationId: pick(['road', 'fen', 'shore', 'dunes']) })
  if (chance(0.3)) state.activePlayerId = pick(['', 'foe', 'ghost'])
  if (chance(0.2)) state.mechanics.weather_pins = [{ day: int(30), weather: pick(w.WEATHER_CONDITION_IDS) }]
  addState(`random:${index}`, state)
}

// Корпус паритета: состояния настоящих кампаний.
let corpusCount = 0
try {
  const files = readdirSync(CORPUS).filter((name) => name.endsWith('.json')).sort()
  for (const name of files) {
    const full = JSON.parse(readFileSync(join(CORPUS, name), 'utf8'))
    corpusCount += 1
    addState(`corpus:${name.slice(0, 16)}`, full)
  }
} catch (error) {
  console.error(`корпус недоступен: ${error.message}`)
}

console.log(`корпус: ${corpusCount}, состояний после урезания и дедупликации: ${states.length}, расхождений урезания: ${mismatches}`)
// Тактические карты сцен повторяются от состояния к состоянию: они вынесены в
// таблицу `maps`, а сцена держит ссылку `{ "$map": номер }`. Файл сжат gzip.
const maps = []
const mapIndex = new Map()
for (const entry of states) {
  const map = entry.state?.scene?.map
  if (!map || typeof map !== 'object' || !Array.isArray(map.zones)) continue
  const key = JSON.stringify(map)
  if (!mapIndex.has(key)) {
    mapIndex.set(key, maps.length)
    maps.push(map)
  }
  entry.state.scene.map = { $map: mapIndex.get(key) }
}
writeFixture(new URL('./weather.json.gz', import.meta.url), { clock, days, labels, pins, narration, scenes, effects, maps, states }, { gzip: true })

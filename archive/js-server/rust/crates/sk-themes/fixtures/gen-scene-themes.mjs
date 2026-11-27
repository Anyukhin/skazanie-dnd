import '../../../fixtures-env.mjs'
// Эталон server/scene-themes.mjs для Rust:
//
//   node rust/crates/sk-themes/fixtures/gen-scene-themes.mjs
//   node rust/crates/sk-themes/fixtures/gen-scene-themes.mjs --dump <секция> <метка>
//
// Второй вид печатает полную сериализованную карту случая — для отладки
// расхождения (в эталоне карта хранится хешем).
//
// Секции `scene-themes.json`:
//
// - `meta` — каталог: темы (объект JS без `match`, исходник и флаги `match`),
//   `SCENE_THEME_IDS`, `FALLBACK_THEME`, `THEME_MIN_SIZE`, константы;
// - `select` — опознание темы (`matchTheme`, `themeFor`, `resolveSceneTheme`,
//   `fallbackThemeFor`, `themeFromMapRequest`, `isLiveTheme`): входы тестов,
//   вызовы конвейера и случайные — словарь всех корней тем, виды сцен и
//   точек карты мира, заявки картографа, ключи прототипа, рыхлые значения;
// - `graphs` — `sceneGraphForTheme`; `caves` — `layoutOrganicCave`;
//   `open` — `layoutOpenTerrain` по темам и их вариантам (река, пропасть,
//   пруд, болото, снег, ровный погост); `shortcuts` — `addShortcutLoops` над
//   картами `buildSceneFromGraph`; `water` — `dressWaterEdges`;
//   `settlements` — `layoutSettlement`;
// - `scenes` — `buildThemedScene`: входы тестов (`test/scene-themes.test.mjs`,
//   `test/map-quality.test.mjs`, `test/building-generator.test.mjs`), вызовы
//   настоящего конвейера (`generateSceneGeometry` по эталонным сценам,
//   корпусу программ сцен и местам тестов, `createSceneTransition`) и
//   случайные входы по всем темам, псевдонимам, видам сцен, типам поселений,
//   климатам, топологиям и размерам. Для каждой — хеш карты, тема,
//   предупреждения, этажи и коды `auditTacticalMap` (инвариант играбельности,
//   AGENTS.md §5).
//
// `scene-themes-relief.json.gz` — `applyOpenTerrainRelief` над синтетическими
// клетками (вход хранится целиком).
import { startRecording, stopRecording } from './capture.mjs'
import { errorOf, hash, mulberry32, picker, plain, writeFixture } from './common.mjs'

const t = await import('../../../../server/tactical-map.mjs')
const st = await import('../../../../server/scene-themes.mjs')
const { buildSceneFromGraph } = await import('../../../../server/graph-layout.mjs')
const { generateSceneGeometry, createSceneTransition } = await import('../../../../server/adventure-director.mjs')
const { auditTacticalMap, MAP_PREVIEW_PRESETS } = await import('../../../../server/map-quality.mjs')
const { sceneMapRequirementsFor, sceneRequirementsFromText } = await import('../../../../server/scene-requirements.mjs')
const { VIGNETTES } = await import('../../../../server/scene-dressing.mjs')
const { readFileSync } = await import('node:fs')

const { int, pick, chance } = picker(mulberry32(2026_10_15_7))
const serialize = (map) => t.serializeTacticalMap(map)
const mapHash = (map) => hash(serialize(map))
const ALL_THEMES = [...st.SCENE_THEMES, ...globalThis.__skAuthoredThemes]
const themeJson = (theme) => {
  const copy = plain({ ...theme })
  delete copy.match
  return copy
}
const themeOf = (id) => ALL_THEMES.find((theme) => theme.id === id)

// --- быстрый путь отладки ---------------------------------------------------------------

const dumpAt = process.argv.indexOf('--dump')
if (dumpAt > 0) {
  const [section, label] = process.argv.slice(dumpAt + 1)
  const fixture = JSON.parse(readFileSync(new URL('./scene-themes.json', import.meta.url), 'utf8'))
  const found = fixture[section].find((entry) => entry.label === label)
  if (!found) throw new Error(`нет случая ${section}/${label}`)
  console.log(JSON.stringify(serialize(rebuild(section, found))))
  process.exit(0)
}

function rebuild(section, entry) {
  if (section === 'scenes') return st.buildThemedScene(entry.options).map
  if (section === 'caves') return st.layoutOrganicCave(entry.theme, entry.options)
  if (section === 'open') return st.layoutOpenTerrain(entry.theme, entry.options)
  if (section === 'shortcuts') {
    const map = graphMap(entry)
    st.addShortcutLoops(map, entry.options)
    return map
  }
  if (section === 'water') {
    const map = waterBase(entry)
    st.dressWaterEdges(map, entry.seed)
    return map
  }
  if (section === 'settlements') return st.layoutSettlement(entry.theme, entry.options)
  throw new Error(`секция ${section}`)
}

function graphMap(entry) {
  const theme = themeOf(entry.theme)
  const graph = st.sceneGraphForTheme(theme, entry.seed)
  return buildSceneFromGraph(graph, { seed: entry.seed, width: entry.width, height: entry.height, theme: theme.id, material: theme.material }).map
}

function waterBase(entry) {
  return entry.base === 'settlement'
    ? st.layoutSettlement(entry.theme, entry.options)
    : st.layoutOpenTerrain(entry.theme, entry.options)
}

// --- каталог -------------------------------------------------------------------------------

const meta = {
  themes: ALL_THEMES.map((theme) => ({ id: theme.id, json: themeJson(theme), match: theme.match ? { source: theme.match.source, flags: theme.match.flags } : null })),
  ids: [...st.SCENE_THEME_IDS],
  fallback: st.FALLBACK_THEME.id,
  minSize: st.THEME_MIN_SIZE,
  constants: {
    OPEN_TERRAIN_LEVEL_FEET: st.OPEN_TERRAIN_LEVEL_FEET,
    OPEN_TERRAIN_MAX_STEP_FEET: st.OPEN_TERRAIN_MAX_STEP_FEET,
    OPEN_TERRAIN_MIN_PLATEAU: st.OPEN_TERRAIN_MIN_PLATEAU,
    OPEN_TERRAIN_GENERATOR_VERSION: st.OPEN_TERRAIN_GENERATOR_VERSION,
  },
}

// --- опознание -------------------------------------------------------------------------

const SELECT_FNS = {
  match: (input) => st.matchTheme(input)?.id ?? null,
  themeFor: (input) => st.themeFor(input).id,
  resolve: (input) => st.resolveSceneTheme(input).id,
  fallback: (input) => st.fallbackThemeFor(input).id,
  request: (input) => st.themeFromMapRequest(input)?.id ?? null,
  live: (input) => st.isLiveTheme(input === null ? null : themeOf(input) ?? input),
}
const select = []
function addSelect(fn, input) {
  let out
  try {
    out = { out: SELECT_FNS[fn](input) }
  } catch (error) {
    out = { error: errorOf(error) }
  }
  select.push({ fn, input: plain(input) ?? null, ...out })
}

// Тесты test/scene-themes.test.mjs.
for (const location of ['Таверна «Сломанное колесо»', 'Храм Утренней Звезды', 'Склеп Норвин', 'Пещера у водопада', 'Тёмный лес', 'Северный тракт', 'Деревня Заречье',
  'Заброшенный караван-сарай', 'Вход в древний караван-сарай на торговом пути', 'Подворье у переправы', 'Ночлежка на окраине', 'Особняк наместника', 'Терем воеводы',
  'Разграбленный караван', 'Дом травницы']) {
  addSelect('themeFor', { location })
  addSelect('match', { location })
}
addSelect('themeFor', { location: 'Дом у дороги', sceneKind: 'wilderness' })
addSelect('themeFor', { location: 'Безымянная пустошь', sceneKind: 'wilderness' })
for (const request of [{ pattern: 'crypt' }, { pattern: 'crypt', layout: 'cavern' }, { pattern: 'cave-cluster' }, { pattern: 'village' }, { pattern: 'bridge' }, { layout: 'cavern' }, { layout: 'streets' },
  { pattern: 'keep' }, { pattern: 'great-hall' }, { pattern: 'courtyard' }, { pattern: 'natural' }, { pattern: 'small-room' }, {}]) addSelect('request', request)
for (const input of [{ sceneKind: 'dungeon', request: { layout: 'rooms', pattern: 'natural' } }, { request: { layout: 'cavern', pattern: 'natural' } }, { request: { layout: 'streets', pattern: 'natural' } },
  { sceneKind: 'wilderness', request: { layout: 'open', pattern: 'natural' } }, { request: { layout: 'rooms', pattern: 'keep', material: 'stone' } },
  { request: { layout: 'rooms', pattern: 'small-room', material: 'wood' } }, { request: {} }]) addSelect('fallback', input)
for (const input of [
  { location: 'Тихий Брод' }, { location: 'Тихий Брод', worldKind: 'village' }, { location: 'Тихий Брод', worldKind: 'town' }, { location: 'Мормар', worldKind: 'port' },
  { location: 'Тихий Брод', sceneKind: 'settlement' }, { location: 'Тихий Брод', settlementType: 'village' }, { location: 'Тихий Брод', request: { layout: 'streets', pattern: 'village' } },
  { location: 'Таверна «Кабан»', worldKind: 'town' }, { location: 'Склеп под площадью', worldKind: 'city' }, { location: 'Роща у Эствуда', worldKind: 'village' },
  { location: 'Перевал Трёх Ветров', worldKind: 'town', sceneKind: 'wilderness' }, { location: 'Безымянная нора', worldKind: 'wilds', sceneKind: 'dungeon', request: { layout: 'cavern' } },
  { location: 'Керская пустошь', worldKind: 'wilds' }, { location: 'Норский провал', worldKind: 'dungeon' }, { location: 'Норская башня', worldKind: 'dungeon' },
  { location: 'Старый маяк', theme: 'берег реки', worldKind: 'landmark', request: { layout: 'winding', pattern: 'bridge' } }, { location: 'Маяково', worldKind: 'village' },
  { location: 'Кальская твердыня', worldKind: 'fortress' }, { location: 'Замок барона', theme: 'каменная крепость', worldKind: 'fortress', sceneKind: 'dungeon', request: { pattern: 'crypt' } },
  { location: 'Кальская твердыня', worldKind: 'fortress', sceneKind: 'dungeon' }, { location: 'Старое пепелище', worldKind: 'ruin' },
  { location: 'Кальмар', worldKind: 'landmark', request: { layout: 'cavern' } }, { location: 'Кальмар', worldKind: 'landmark' },
]) addSelect('resolve', input)
for (const theme of ALL_THEMES) addSelect('live', theme.id)
addSelect('live', null)
addSelect('live', { live: 1 })
addSelect('live', { live: 'yes' })

// Словарь опознания: корни всех тем с окончаниями, слова-ловушки и регистр.
const WORDS = [
  'таверна', 'Трактир', 'постоялый двор', 'корчма', 'харчевня', 'гостиница', 'караван-сарай', 'караван', 'подворье', 'ночлежка', 'особняк', 'терем', 'дом', 'Дом', 'домик', 'домовой',
  'изба', 'избу', 'избушка', 'хижина', 'усадьба', 'поместье', 'лавка', 'кузня', 'кузница', 'кузнец', 'мельница', 'башня', 'Башня', 'небашня', 'маяк', 'маяка', 'маяком', 'Маяково', 'маяки',
  'казарма', 'караульня', 'караульная', 'склад', 'складской', 'перескладка', 'амбар', 'конюшня', 'сторожка', 'библиотека', 'лаборатория', 'мастерская', 'пекарня', 'аптека', 'ратуша', 'кабак',
  'храм', 'Святилище', 'капище', 'алтарь', 'собор', 'монастырь', 'склеп', 'крипта', 'гробница', 'усыпальница', 'катакомбы', 'мавзолей', 'подземелье', 'темница', 'тюрьма', 'каземат',
  'застенок', 'узилище', 'пещера', 'грот', 'каверна', 'штольня', 'шахта', 'рудник', 'логово', 'нора', 'норы', 'Нору', 'норка', 'лес', 'леса', 'лесом', 'лесная', 'Лес', 'чаща', 'чащоба',
  'роща', 'рощица', 'бор', 'бора', 'боры', 'собор', 'дубрава', 'пуща', 'тайга', 'опушка', 'оазис', 'поляна', 'поляне', 'поляну', 'полянка', 'лагерь', 'стоянка', 'бивак', 'дорога',
  'тракт', 'путь', 'перекрёсток', 'перекресток', 'мост', 'брод', 'перевал', 'кладбище', 'погост', 'могильник', 'некрополь', 'деревня', 'поселение', 'село', 'села', 'Село', 'селение',
  'посад', 'хутор', 'город', 'города', 'городской', 'Город', 'столица', 'слобода', 'рынок', 'площадь', 'двор', 'двором', 'дворе', 'двору', 'двора', 'дворец', 'замок', 'замка', 'крепость',
  'цитадель', 'трон', 'кабинет', 'покои', 'покоя', 'военная галерея', 'военный зал', 'архив', 'зал', 'галерея', 'улица', 'пристань', 'гавань', 'порт', 'набережная', 'сад', 'переулок',
  'внешний', 'за воротами', 'перед воротами', 'бастион', 'ущелье', 'пропасть', 'пруд', 'озеро', 'руины', 'развалины', 'древний', 'пустошь', 'топь', 'провал', 'берег реки', 'у входа',
  '«Кабан»', 'Норвин', 'Эствуда', 'Трёх Ветров', 'у водопада', 'старый', 'Тихий', 'Северный', 'TAVERN', 'Crypt', '', '  ',
]
const SCENE_KINDS = ['', 'wilderness', 'Wilderness', 'road', 'dungeon', 'settlement', 'other', 'building', 'interior', null, 5, undefined]
const WORLD_KINDS = ['', 'capital', 'city', 'town', 'village', 'port', 'Port', 'wilds', 'dungeon', 'ruin', 'fortress', 'FORTRESS', 'landmark', 'inn', 'constructor', 'toString', '__proto__', 'hasOwnProperty', null, 7, undefined]
const LAYOUTS = ['', 'rooms', 'ruins', 'radial', 'open', 'cavern', 'streets', 'winding', 'Cavern', 'STREETS', 'constructor', 'valueOf', null, undefined]
const PATTERNS = ['', 'small-room', 'great-hall', 'keep', 'courtyard', 'crypt', 'cave-cluster', 'village', 'bridge', 'natural', 'temple', 'Crypt', 'VILLAGE', 'toString', '__proto__', null, undefined]
const MATERIALS = ['', 'stone', 'marble', 'earth', 'wood', 'Stone', 'grass', null, undefined]
const THEME_IDS = [...st.SCENE_THEME_IDS, '', ' crypt ', 'Crypt', 'unknown', 'constructor', 'toString', null, 5]
const SETTLEMENT_TYPES = ['', 'village', 'town', 'city', '  ', null, 0, undefined]
const name = () => {
  const count = 1 + int(3)
  return Array.from({ length: count }, () => pick(WORDS)).join(pick([' ', ' у ', ' за ', ', ', ' — ']))
}
const maybe = (p, value) => (chance(p) ? value() : undefined)
function randomRequest() {
  if (chance(0.06)) return pick([null, 'x', [], 5])
  const request = {}
  for (const [key, values, p] of [['layout', LAYOUTS, 0.5], ['pattern', PATTERNS, 0.5], ['material', MATERIALS, 0.3], ['theme_id', THEME_IDS, 0.12], ['themeId', THEME_IDS, 0.06]]) {
    if (chance(p)) request[key] = pick(values)
  }
  return request
}
function randomSelectInput() {
  if (chance(0.02)) return pick([{}, [], 'x', 5])
  const input = {}
  const set = (key, value) => { if (value !== undefined) input[key] = value }
  set('location', maybe(0.9, () => (chance(0.05) ? pick([null, 5, ['лес', 'дом']]) : name())))
  set('theme', maybe(0.4, () => (chance(0.05) ? pick([null, 3]) : name())))
  set('sceneKind', maybe(0.5, () => pick(SCENE_KINDS)))
  set('settlementType', maybe(0.25, () => pick(SETTLEMENT_TYPES)))
  set('worldKind', maybe(0.45, () => pick(WORLD_KINDS)))
  set('request', maybe(0.55, randomRequest))
  return input
}
for (let index = 0; index < 2400; index += 1) addSelect('resolve', randomSelectInput())
for (let index = 0; index < 1200; index += 1) addSelect(pick(['match', 'themeFor']), randomSelectInput())
for (let index = 0; index < 700; index += 1) {
  const drawn = randomSelectInput()
  const input = drawn && typeof drawn === 'object' && !Array.isArray(drawn) ? drawn : {}
  if (chance(0.8)) input.request = randomRequest()
  if (input.request === null) input.request = {}
  addSelect('fallback', input)
}
for (let index = 0; index < 500; index += 1) {
  const request = randomRequest()
  addSelect('request', request === null ? {} : request)
}

// --- граф, пещера, открытая местность --------------------------------------------------

const graphs = []
const graphThemes = [...ALL_THEMES, { id: 'custom', zones: ['Один', 'Два'], locked: true }, { id: 'long', zones: ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З'] }, { id: 'nozones' }, { id: 'nulls', zones: [null, 'Б', null, 'Г'], locked: 1 }]
for (const theme of graphThemes) {
  for (let index = 0; index < 24; index += 1) {
    const seed = pick([`g${index}`, `${index}`, 'locked', 'a', 'b', 'c', `seed ${index}`])
    graphs.push({ label: `${theme.id}/${index}`, theme: themeJson(theme), seed, graph: plain(st.sceneGraphForTheme(theme, seed)) })
  }
}

const caves = []
const CAVE_THEMES = ['cave', 'crypt', 'temple', 'dungeon', 'forest', 'authored-palace']
for (let index = 0; index < 220; index += 1) {
  const theme = index < 3 ? themeOf('cave') : chance(0.85) ? themeOf(pick(CAVE_THEMES)) : pick([{ id: 'x', material: 'stone', zones: ['A', 'B', 'C', 'D', 'E'] }, { id: 'y' }, { id: 'z', material: 'grass', locked: true }])
  const options = index < 3 ? { seed: ['organic-a', 'organic-b', 'organic-c'][index], width: 28, height: 24 } : { seed: pick([`cave-${index}`, `${index}`, 'organic-a']) }
  if (index >= 3) {
    if (chance(0.85)) options.width = pick([16, 18, 20, 22, 24, 26, 28, 30, 34, 40, 48, 60, 70, 12, 25.5, 30.4])
    if (chance(0.85)) options.height = pick([16, 18, 20, 22, 24, 26, 28, 30, 34, 40, 48, 60, 70, 12, 21.5])
    if (chance(0.2)) options.locationId = pick(['cave-loc', '', 5])
  }
  const map = st.layoutOrganicCave(theme, options)
  caves.push({ label: `cave/${index}`, theme: themeJson(theme), options, mapHash: mapHash(map), audit: auditTacticalMap(map).problems.map((problem) => problem.code) })
}

const open = []
const OPEN_BASES = ['forest', 'road', 'graveyard', 'settlement', 'building', 'cave']
for (let index = 0; index < 360; index += 1) {
  const base = themeJson(themeOf(index < 210 ? pick(['forest', 'road']) : pick(OPEN_BASES)))
  const theme = { ...base }
  if (chance(0.25)) theme.river = true
  if (chance(0.15)) theme.chasm = true
  if (chance(0.2)) theme.pond = true
  if (chance(0.15)) theme.flat = true
  if (chance(0.2)) theme.wetland = true
  if (chance(0.25)) theme.road = pick([true, false, 1])
  if (chance(0.3)) theme.bridgeMaterial = pick(['wood', 'stone', 'marble', 'metal'])
  if (chance(0.2)) theme.material = pick(['sand', 'ice', 'earth', 'grass', 'stone'])
  if (chance(0.15)) theme.surface = pick(['ice', 'none', 'mud', null])
  const options = { seed: pick([`open-${index}`, `${index}`, 'road', 'f', 'r', `forest-${index % 100}`, `road-${index % 100}`]) }
  if (chance(0.85)) options.width = pick([12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 34, 40, 48, 60, 64, 10, 27.5])
  if (chance(0.85)) options.height = pick([12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 34, 40, 48, 60, 10, 19.5])
  if (chance(0.2)) options.locationId = pick(['open-loc', 5])
  const map = st.layoutOpenTerrain(theme, options)
  open.push({ label: `open/${index}`, theme, options, mapHash: mapHash(map), audit: auditTacticalMap(map).problems.map((problem) => problem.code) })
}
// Тесты: дорога через всю карту, опушка, сто сидов контура.
open.push({ label: 'test/road', theme: themeJson(themeOf('road')), options: { seed: 'road', width: 30, height: 20 } })
open.push({ label: 'test/forest-f', theme: themeJson(themeOf('forest')), options: { seed: 'f', width: 20, height: 20 } })
open.push({ label: 'test/road-r', theme: themeJson(themeOf('road')), options: { seed: 'r', width: 20, height: 20 } })
for (const id of ['forest', 'road']) for (let index = 0; index < 100; index += 1) open.push({ label: `test/shape/${id}/${index}`, theme: themeJson(themeOf(id)), options: { seed: `${id}-${index}`, width: 30, height: 30 } })
for (const entry of open) {
  if (entry.mapHash) continue
  const map = st.layoutOpenTerrain(entry.theme, entry.options)
  entry.mapHash = mapHash(map)
  entry.audit = auditTacticalMap(map).problems.map((problem) => problem.code)
}

const shortcuts = []
for (let index = 0; index < 160; index += 1) {
  const theme = pick(['temple', 'crypt', 'dungeon', 'authored-palace', 'cave'])
  const entry = { label: `shortcut/${index}`, theme, seed: pick([`loop-${index}`, `${index}`, 'a', 'b']), width: pick([26, 28, 30, 34, 40, 48]), height: pick([26, 28, 30, 34, 40]) }
  const options = {}
  if (chance(0.5)) options.limit = pick([0, 1, 2, 3, 5])
  if (chance(0.5)) options.minDetour = pick([2, 4, 6, 10, 14, 20])
  if (chance(0.3)) options.exclude = [pick(['zone-0', 'zone-1', 'zone-2', 'zone-3', 'zone-9'])]
  if (chance(0.3)) options.only = pick(['zone-1', 'zone-2', 'zone-3', 'zone-4', 'zone-7'])
  if (chance(0.3)) options.idPrefix = pick(['second-entrance', 'loop', 'x'])
  if (chance(0.3)) options.locks = { [pick(['zone-1', 'zone-2', 'zone-3', 'zone-4'])]: pick([{ lockDc: 15, keyItemId: 'goal-key' }, { lockDc: 0, keyItemId: 'k' }, { keyItemId: null }, { lockDc: 12 }]) }
  entry.options = options
  const map = graphMap(entry)
  entry.opened = st.addShortcutLoops(map, options)
  entry.mapHash = mapHash(map)
  shortcuts.push(entry)
}

const water = []
for (let index = 0; index < 120; index += 1) {
  const settlement = chance(0.3)
  const entry = { label: `water/${index}`, base: settlement ? 'settlement' : 'open', seed: pick([`shore-${index}`, `${index}`, 7]) }
  if (settlement) {
    entry.theme = themeJson(themeOf(pick(['settlement', 'authored-harbor', 'authored-oasis'])))
    entry.options = { seed: `s-${index}`, width: pick([30, 36, 40, 48]), height: pick([30, 36, 40]), design: { topology: pick(['river', 'harbor', 'crossroads']), ...(chance(0.4) ? { scale: pick(['village', 'town', 'city']) } : {}) } }
  } else {
    entry.theme = { ...themeJson(themeOf(pick(['forest', 'road', 'graveyard']))), ...(chance(0.6) ? { river: true, road: true } : { pond: true }), bridgeMaterial: 'wood' }
    entry.options = { seed: `w-${index}`, width: pick([20, 26, 30, 40]), height: pick([20, 26, 30]) }
  }
  const map = waterBase(entry)
  entry.placed = st.dressWaterEdges(map, entry.seed)
  entry.mapHash = mapHash(map)
  water.push(entry)
}

const settlements = []
for (const seed of ['village-a', 'village-b']) {
  const options = { seed, width: 28, height: 24, design: { topology: 'crossroads' } }
  settlements.push({ label: `test/${seed}`, theme: themeJson(themeOf('settlement')), options, mapHash: mapHash(st.layoutSettlement(themeOf('settlement'), options)) })
}
for (let index = 0; index < 30; index += 1) {
  const theme = themeJson(themeOf(pick(['settlement', 'authored-harbor', 'authored-oasis', 'authored-caldera-port'])))
  const options = { seed: `layout-${index}` }
  if (chance(0.8)) options.width = pick([26, 30, 36, 44, 52])
  if (chance(0.8)) options.height = pick([26, 30, 36, 44])
  if (chance(0.7)) options.design = { topology: pick(['crossroads', 'river', 'harbor', 'market', '']), ...(chance(0.5) ? { scale: pick(['village', 'town', 'city']) } : {}) }
  settlements.push({ label: `layout/${index}`, theme, options, mapHash: mapHash(st.layoutSettlement(theme, options)) })
}

// --- сборка сцены ----------------------------------------------------------------------

const scenes = []
const labels = new Set()
function addScene(label, options, extra = {}) {
  if (labels.has(label)) throw new Error(`повтор метки ${label}`)
  labels.add(label)
  const input = options === null ? null : (plain(options) ?? {})
  let result
  try {
    const built = st.buildThemedScene(input)
    result = {
      mapHash: mapHash(built.map), theme: built.theme, warnings: built.warnings,
      ...(built.levels ? { levels: plain(built.levels) } : {}),
      audit: auditTacticalMap(built.map).problems.map((problem) => problem.code),
    }
  } catch (error) {
    result = { error: errorOf(error) }
  }
  scenes.push({ label, options: input, ...result, ...extra })
}

// Тесты test/scene-themes.test.mjs.
for (const theme of st.SCENE_THEMES) {
  addScene(`test/build/${theme.id}`, { location: theme.label, seed: `build-${theme.id}`, width: 28, height: 28 })
  addScene(`test/same/${theme.id}`, { location: theme.label, seed: 'same' })
}
addScene('test/village-props', { location: 'Деревня Заречье', seed: 'village-props', width: 28, height: 24 })
addScene('test/village-market', { location: 'Деревня Заречье', seed: 'village-props', width: 28, height: 24, design: { topology: 'market' } })
addScene('test/swing-tavern', { location: 'Таверна «Пустой кубок»', seed: 'swing-tavern', width: 28, height: 28 })
addScene('test/swing-palace', { themeId: 'authored-palace', location: 'Военная галерея', seed: 'swing-palace', width: 28, height: 28 })
for (const [location, themeId] of [['Склеп Норвин', 'crypt'], ['Храм Утренней Звезды', 'temple']]) addScene(`test/pierce/${themeId}`, { location, seed: `pierce-${themeId}`, width: 28, height: 28 })
addScene('test/leak/cave', { location: 'Пещера у водопада', seed: 'leak' })
addScene('test/leak/temple', { location: 'Храм Утренней Звезды', seed: 'leak' })
for (const climate of ['arid', 'cold', 'wetland']) addScene(`test/climate/${climate}`, { themeId: 'forest', seed: 'climate-check', width: 30, height: 24, design: { climate } })
for (const [themeId, seed] of [['forest', 'v3-forest'], ['road', 'v3-road'], ['forest', 'v3-pond-1'], ['forest', 'v3-pond-2']]) addScene(`test/v4/${seed}`, { themeId, location: themeId === 'forest' ? 'Лес' : 'Тракт', seed, width: 28, height: 24 })
for (const seed of ['relief-1', 'relief-2', 'relief-3', 'relief-4']) addScene(`test/relief/${seed}`, { themeId: 'forest', location: 'Лес', seed, width: 30, height: 24 })
for (const seed of ['prison-a', 'prison-b', 'prison-c', 'prison-d']) addScene(`test/prison/${seed}`, { themeId: 'dungeon', location: 'Темница', seed, width: 26, height: 26 })
addScene('test/min-size/crypt', { themeId: 'crypt', location: 'Склеп', seed: 'min-size', width: 15, height: 11 })
addScene('test/min-size/house', { themeId: 'building', location: 'Хижина', seed: 'min-size', width: 16, height: 14 })
addScene('test/min-size/temple', { themeId: 'temple', location: 'Храм', seed: 'min-size', width: 34, height: 30 })
for (const seed of ['dais-a', 'dais-b', 'dais-c']) addScene(`test/dais/${seed}`, { themeId: 'temple', location: 'Храм', seed, width: 30, height: 30 })
for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) addScene(`test/second/${seed}`, { themeId: 'dungeon', location: 'Темница', seed, width: 30, height: 30 })
// Рыхлые входы: `null` — TypeError чтения поля, прочее — как пустой объект.
addScene('edge/null', null)
addScene('edge/empty', {})
addScene('edge/number', 5)
addScene('edge/theme-id-number', { themeId: 5, seed: 'x' })
addScene('edge/theme-id-array', { themeId: ['crypt'], seed: 'x' })
addScene('edge/design-null-open', { themeId: 'road', seed: 'x', design: null })
addScene('edge/design-null-cave', { themeId: 'cave', seed: 'x', design: null })
addScene('edge/design-string', { themeId: 'forest', seed: 'x', design: 'arid' })
addScene('edge/seed-number', { themeId: 'forest', seed: 42 })
addScene('edge/seed-null', { themeId: 'crypt', seed: null })
addScene('edge/width-string', { themeId: 'road', seed: 'x', width: '30', height: '20' })
addScene('edge/width-null', { themeId: 'forest', seed: 'x', width: null })
addScene('edge/width-null-crypt', { themeId: 'crypt', seed: 'x', width: null, height: 'abc' })
addScene('edge/levels-object', { themeId: 'settlement', seed: 'x', levels: { length: 1 } })
addScene('edge/location-null', { location: null, seed: 'x' })

// Вызовы настоящего конвейера.
const captured = []
const resolved = []
function record(name, fn, args) {
  const input = plain(args[0]) ?? {}
  const result = fn(...args)
  if (name === 'buildThemedScene') captured.push(input)
  else if (name === 'resolveSceneTheme') resolved.push({ input, out: result.id })
  return result
}
function pipeline(label, run) {
  const before = captured.length
  startRecording(record)
  try {
    run()
  } catch (error) {
    console.log(`  конвейер отказал на ${label}: ${error.message}`)
  } finally {
    stopRecording()
  }
  const calls = captured.slice(before)
  calls.forEach((options, index) => addScene(`pipeline:${label}${calls.length > 1 ? `#${index}` : ''}`, options))
}
const scene = (label, input) => pipeline(label, () => generateSceneGeometry({ ...input, useLibrary: false }))

for (const preset of MAP_PREVIEW_PRESETS) {
  scene(`preset/${preset.id}/default`, { ...preset.input, seed: `preview:${preset.id}` })
  for (const size of [{ width: 16, height: 14 }, { width: 26, height: 26 }, { width: 36, height: 30 }, { width: 48, height: 40 }]) {
    for (const seed of ['s1', 's2']) scene(`preset/${preset.id}/${size.width}x${size.height}/${seed}`, { ...preset.input, map: { ...(preset.input.map ?? {}), ...size }, seed: `${preset.id}:${seed}` })
  }
}
const programCorpus = JSON.parse(readFileSync(new URL('../../../../test/fixtures/scene-programs/corpus.json', import.meta.url), 'utf8'))
for (const entry of programCorpus.scenes) {
  const program = sceneMapRequirementsFor([entry.location, entry.text], { npcs: entry.npcs })
  scene(`corpus/${entry.id}`, { location: entry.location, theme: entry.theme, settlementType: entry.settlementType ?? '', requirements: program?.items ?? [], program, seed: `corpus:${entry.id}` })
}
// Места test/map-quality.test.mjs.
for (const seed of ['q1', 'q2', 'q3', 'q4']) {
  for (const [location, theme] of [['Дом мельника', 'жилой дом'], ['Таверна «Рыжий рог»', 'таверна'], ['Храм Утренней звезды', 'храм'], ['Деревня Кленовка', 'деревня'], ['Фамильный склеп', 'склеп'], ['Темница', 'подземелье']]) {
    scene(`quality/${location}/${seed}`, { location, theme, seed: `${location}:${seed}` })
  }
  const requirements = sceneRequirementsFromText(['В зале очаг, четыре стола, у стойки две бочки и сундук хозяина.'])
  scene(`quality/promised/${seed}`, { location: 'Таверна «Рыжий рог»', theme: 'таверна', seed: `Таверна «Рыжий рог»:${seed}`, requirements })
}
for (const [location, theme] of [['Мост через ущелье', 'дорога'], ['Мост через реку', 'дорога'], ['Брод у мельницы', 'переправа'], ['Развалины у тракта', 'руины у дороги'],
  ['Разбойничий лагерь', 'лагерь'], ['Старое кладбище', 'кладбище'], ['Оазис в пустыне', 'оазис'], ['Город Вельдбург', 'город'], ['Торговая площадь', 'рынок'],
  ['Кузница Борга', 'кузница'], ['Казарма городской стражи', 'казарма'], ['Хутор у леса', 'хутор'], ['Логово дракона с золотом', 'пещера'], ['Заброшенная шахта', 'рудник'],
  ['Заброшенный храм', 'храм'], ['Склеп с решёткой', 'склеп'], ['Двор замка', 'крепость'], ['Тронный зал замка', 'замок']]) {
  for (const seed of ['p1', 'p2']) scene(`place/${location}/${seed}`, { location, theme, seed: `${location}:${seed}` })
}
// Сцены test/map-quality.test.mjs через конвейер: метки `mq/…` читает
// перенос этих тестов в Rust (`tests/scene_themes.rs`).
{
  const SEEDS = ['q1', 'q2', 'q3', 'q4']
  const SIZES = [{ width: 16, height: 14 }, { width: 26, height: 26 }, { width: 40, height: 32 }]
  const presetOf = (id) => MAP_PREVIEW_PRESETS.find((entry) => entry.id === id)
  for (const preset of MAP_PREVIEW_PRESETS) {
    for (const size of SIZES) for (const seed of SEEDS) scene(`mq/preset/${preset.id}/${size.width}x${size.height}/${seed}`, { ...preset.input, map: { ...(preset.input.map ?? {}), ...size }, seed: `${preset.id}:${seed}` })
  }
  for (const id of ['forest', 'road']) for (const seed of SEEDS) scene(`mq/terrace/${id}/${seed}`, { ...presetOf(id).input, map: { width: 26, height: 26 }, seed: `terrace:${seed}` })
  for (const size of SIZES.slice(1)) for (const seed of SEEDS) scene(`mq/ruins/${size.width}x${size.height}/${seed}`, { ...presetOf('ruins').input, map: size, seed: `ruins:${seed}` })
  for (const seed of SEEDS) {
    scene(`mq/village/${seed}`, { location: 'Деревня Кленовка', theme: 'деревня', settlementType: 'village', seed: `village:${seed}` })
    scene(`mq/temple/${seed}`, { location: 'Храм Утренней звезды', theme: 'храм', seed: `temple:${seed}` })
    scene(`mq/mix/${seed}`, { location: 'Деревня Кленовка', theme: 'деревня', settlementType: 'village', seed: `mix:${seed}`, map: { width: 36, height: 32 } })
    scene(`mq/town/${seed}`, { location: 'Город Вельдбург', theme: 'город', settlementType: 'town', seed: `town:${seed}` })
  }
  scene('mq/farm', { location: 'Хутор у леса', theme: 'хутор', settlementType: 'village', seed: 'farm:q1' })
  for (const [location, theme, extra] of [['Кузница Борга', 'кузница'], ['Казарма городской стражи', 'казарма'], ['Кладбище за часовней', 'кладбище'], ['Подземелье под замком', 'подземелье'],
    ['Хутор у леса', 'хутор', { settlementType: 'village' }], ['Логово дракона', 'пещера'], ['Лагерь бандитов', 'лесной лагерь'], ['Лесная поляна', 'лес'],
    ['Мост через ущелье', 'мост'], ['Тракт у старого моста', 'дорога'], ['Пустынный оазис', 'оазис']]) {
    scene(`mq/place/${location}`, { location, theme, seed: `fidelity:${location}`, ...(extra ?? {}) })
  }
  for (const [location, theme] of [['Подземелье под замком', 'подземелье'], ['Фамильный склеп', 'склеп']]) {
    for (let index = 0; index < 16; index += 1) scene(`mq/loops/${location}/${index}`, { location, theme, seed: `loops:${index}` })
  }
  for (const [location, theme] of [['Поляна в Чернолесье', 'лес'], ['Тракт у старого моста', 'дорога']]) scene(`mq/empty-graph/${location}`, { location, theme, seed: 'empty-graph' })
}

// Сцены test/scene-dressing.test.mjs, собранные `buildThemedScene` прямо.
{
  const tavern = { width: 36, height: 30, location: 'Трактир трёх дорог', theme: 'таверна', design: { building_use: 'tavern', architecture: 'wood' } }
  for (const seed of ['brawl-a', 'brawl-b']) {
    addScene(`dressing/brawl/${seed}/told`, { ...tavern, seed, description: 'После вчерашней драки трактирщик ещё не прибрался.' })
    addScene(`dressing/brawl/${seed}/silent`, { ...tavern, seed })
  }
  const temple = { width: 36, height: 30, location: 'Храм Утренней звезды', theme: 'храм', design: {} }
  for (const seed of ['temple-a', 'temple-b']) {
    addScene(`dressing/temple/${seed}`, { ...temple, seed })
    addScene(`dressing/temple/${seed}/ruined`, { ...temple, seed, description: 'Заброшенный храм, свод местами обвалился.' })
  }
  const village = { width: 44, height: 38, location: 'Деревня Кленовка', theme: 'деревня', design: { topology: 'organic', architecture: 'wood' } }
  for (const seed of ['village-a', 'village-b']) {
    addScene(`dressing/village/${seed}`, { ...village, seed })
    addScene(`dressing/village/${seed}/burned`, { ...village, seed, description: 'На краю деревни — пепелище сгоревшего двора.' })
  }
  addScene('dressing/village/winter', { ...village, seed: 'village-a', design: { ...village.design, climate: 'cold' } })
  const WILD = [
    ['quiet', { location: 'Поляна в Чернолесье', theme: 'лесная поляна' }],
    ['camp-lair', { location: 'Поляна в Чернолесье', theme: 'лесная поляна', description: 'Остывшее кострище, вокруг волчьи следы.' }],
    ['ruins', { location: 'Развалины старой заставы', theme: 'руины у дороги' }],
    ['graveyard', { location: 'Старое кладбище', theme: 'кладбище' }],
    ['cave', { location: 'Пещера контрабандистов', theme: 'пещера' }],
    ['crypt', { location: 'Фамильный склеп', theme: 'склеп', description: 'Сектанты проводили здесь обряд.' }],
    ['winter', { location: 'Снежный перевал', theme: 'зимний лес', design: { climate: 'cold' }, description: 'Древние руины сторожевой башни.' }],
    ['desert', { location: 'Красные барханы', theme: 'дорога через пустыню', design: { climate: 'arid' } }],
  ]
  for (const [name, scene] of WILD) {
    for (const seed of ['dress-a', 'dress-b']) addScene(`dressing/wild/${name}/${seed}`, { seed, width: 36, height: 30, location: scene.location, theme: scene.theme, design: scene.design ?? {}, description: scene.description ?? '' })
  }
}

// Редкие ветки сборки прямым вызовом: пропасть с мостом, логово с кладом и
// шахта, лагерь, развалины с воротами на дороге, оазис, болото у реки.
const TARGETED = [
  ['chasm', { themeId: 'road', location: 'Мост через ущелье', theme: 'дорога' }],
  ['chasm-forest', { themeId: 'forest', location: 'Лес у пропасти', theme: 'обрыв' }],
  ['hoard', { themeId: 'cave', location: 'Логово дракона', theme: 'сокровища и золото' }],
  ['mine', { themeId: 'cave', location: 'Старая шахта', theme: 'рудник' }],
  ['camp', { themeId: 'forest', location: 'Разбойничий лагерь', theme: 'стоянка бандитов' }],
  ['gate', { themeId: 'road', location: 'Развалины у тракта', theme: 'руины у дороги' }],
  ['oasis', { themeId: 'forest', location: 'Оазис', theme: 'пруд', design: { climate: 'arid' } }],
  ['river-swamp', { themeId: 'forest', location: 'Болото у реки', theme: 'топь', design: { climate: 'wetland', topology: 'river' } }],
  ['graves-cold', { themeId: 'graveyard', location: 'Старое кладбище', theme: 'погост', design: { climate: 'cold' } }],
  ['ruined-temple', { themeId: 'temple', location: 'Заброшенный храм', theme: 'руины' }],
]
for (const [name, base] of TARGETED) {
  for (let index = 0; index < 8; index += 1) {
    addScene(`targeted/${name}/${index}`, { ...base, seed: `${name}-${index}`, width: pick([20, 26, 30, 36, 44]), height: pick([20, 26, 30, 36]) })
  }
}
for (let index = 0; index < 12; index += 1) {
  scene(`storeyed/${index}`, { location: pick(['Деревня Кленовка', 'Город Вельдбург', 'Ольшанка', 'Торговый город', 'Портовый квартал']), theme: pick(['деревня', 'город', 'рынок', 'гавань у пристани']), settlementType: pick(['village', 'town', 'city']), seed: `storeyed:${index}`, ...(index % 2 ? { levels: [{ offset: pick([1, -1]), label: pick(['Чердак', 'Погреб', '']) }] } : {}) })
}
const WORLD = {
  seed: 'entry-road',
  currentLocationId: 'brod',
  locations: [
    { id: 'brod', name: 'Старый Брод', kind: 'village', x: 500, y: 120, known: true, visited: true },
    { id: 'inn', name: 'Трактир «Три гуся»', kind: 'inn', x: 500, y: 420, known: true },
    { id: 'east', name: 'Восточный хутор', kind: 'village', x: 820, y: 420, known: true },
    { id: 'woods', name: 'Чёрная пуща', kind: 'wilds', x: 200, y: 420, known: true },
  ],
}
const stateAt = (locationId, location) => ({
  sessionCode: 'ENTRY',
  worldMap: structuredClone({ ...WORLD, currentLocationId: locationId }),
  scene: { title: location, location, location_id: locationId, turn: 1 },
  adventure: { chapter: 1, history: [], visitedLocations: [location] },
})
for (const [from, fromName] of [['brod', 'Старый Брод'], ['east', 'Восточный хутор']]) {
  for (const [to, title, theme] of [['inn', 'Трактир «Три гуся»', 'таверна'], ['woods', 'Чёрная пуща', 'лес'], ['east', 'Восточный хутор', 'хутор']]) {
    if (to === from) continue
    pipeline(`transition/${from}/${to}`, () => createSceneTransition({
      title, location: title, location_id: to, theme, objective: 'Дойти', arrival: 'Дорога выводит отряд к месту.', objective_status: 'completed',
    }, stateAt(from, fromName)))
  }
}
for (const entry of resolved) addSelect('resolve', entry.input)

// Случайные входы по всем темам и признакам.
const CUES = Object.values(VIGNETTES).flat().flatMap((recipe) => (recipe.cue ? recipe.cue.source.split('|').filter((part) => /^[а-яё ]+$/u.test(part)) : []))
const DESCRIPTIONS = ['', 'Отряд входит в зал, у стойки хозяин.', 'Пьяная драка опрокинула столы.', 'Развалины старой заставы, древние камни.', 'Брошенный лагерь у ручья.', 'Здесь недавно был обряд.',
  'Заброшенный храм, своды осыпались.', 'Логово с золотом и сокровищами дракона.', 'Старая шахта, рельсы ржавые.', 'Пепелище сгоревшей деревни.']
const description = () => (chance(0.5) ? pick(DESCRIPTIONS) : Array.from({ length: 1 + int(3) }, () => pick(CUES)).join(', '))
const SIZES = [16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 40, 44, 48, 52, 60, 14, 10, 30.5, 25.4, '30', null]
const DESIGN = {
  climate: ['temperate', 'arid', 'cold', 'wetland'],
  topology: ['crossroads', 'river', 'harbor', 'market', 'courtyard', 'organic', ''],
  scale: ['village', 'town', 'city', 'hamlet'],
  density: ['sparse', 'mixed', 'dense'],
  architecture: ['wood', 'stone', 'marble', 'metal', 'sand', 'ice'],
  building_use: ['dwelling', 'tavern', 'shop', 'manor', 'barn', 'workshop', 'smithy', ''],
  square: [true, false],
  shape: ['rect', 'L', 'cross', 'round'],
}
function randomDesign() {
  if (chance(0.03)) return pick(['arid', [], 7])
  const design = {}
  for (const [key, values] of Object.entries(DESIGN)) if (chance(key === 'climate' || key === 'topology' ? 0.5 : 0.3)) design[key] = pick(values)
  return design
}
function randomLevels() {
  if (chance(0.05)) return pick([null, 'x', {}])
  return Array.from({ length: 1 + int(3) }, () => ({ offset: pick([1, -1, 2, -2, 0, '1', null, 1.5]), ...(chance(0.8) ? { label: pick(['Спальни', 'Погреб', '', 5, null]) } : {}), ...(chance(0.3) ? { hint: pick(['наверх', null, 3]) } : {}) }))
}
const RANDOM_THEMES = [...st.SCENE_THEME_IDS, '', '', '', 'unknown']
for (let index = 0; index < 1500; index += 1) {
  const options = { seed: pick([`r${index}`, `сцена ${index}`, `${index}`]) }
  const themeId = pick(RANDOM_THEMES)
  if (themeId) options.themeId = themeId
  if (chance(0.9)) options.location = name()
  if (chance(0.5)) options.theme = name()
  if (chance(0.4)) options.sceneKind = pick(SCENE_KINDS.filter((kind) => kind !== undefined))
  if (chance(0.85)) options.width = pick(SIZES)
  if (chance(0.85)) options.height = pick(SIZES)
  if (chance(0.8)) options.design = randomDesign()
  if (chance(0.2)) options.levels = randomLevels()
  if (chance(0.3)) options.entry = pick(['interior', 'exterior'])
  if (chance(0.55)) options.description = description()
  if (chance(0.15)) options.locationId = pick(['loc', 'таверна-1', 5, ''])
  addScene(`random/${index}`, options)
}

// --- рельеф над синтетическими клетками ----------------------------------------------------

const relief = []
for (let index = 0; index < 60; index += 1) {
  const width = 12 + int(30)
  const height = 12 + int(26)
  const entranceY = 3 + int(height - 6)
  const roadY = int(height)
  const roads = chance(0.6)
  const cells = new Map()
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (chance(0.06)) continue
    const roll = int(20)
    const patch = { passable: roll > 2, material: 'grass', surface: roll === 3 ? 'water' : 'none', moveCost: 1, zone: roll === 4 ? 'crossing' : 'field', revealed: true }
    if (roll === 3) patch.passable = false
    cells.set(`${x},${y}`, { x, y, patch })
  }
  const order = [...cells.values()].sort(() => (chance(0.5) ? -1 : 1))
  const terrainCells = new Map(order.map((cell) => [`${cell.x},${cell.y}`, cell]))
  const input = order.map((cell) => [cell.x, cell.y, cell.patch])
  const theme = { id: pick(['forest', 'road', 'graveyard', 'x']), ...(chance(0.3) ? { wetland: true } : {}) }
  const seed = pick([`relief-${index}`, `${index}`])
  st.applyOpenTerrainRelief(theme, seed, terrainCells, { width, height, entranceY, onRoadAt: (x, y) => roads && Math.abs(y - roadY) <= 1 })
  relief.push({ label: `relief/${index}`, theme, seed, width, height, entranceY, roadY: roads ? roadY : null, cells: input, elevation: [...terrainCells.values()].map((cell) => cell.patch.elevation) })
}

// --- запись ------------------------------------------------------------------------------

console.log(`  конвейер: ${scenes.filter((entry) => entry.label.startsWith('pipeline:')).length} сборок, ${resolved.length} опознаний; отказов ${scenes.filter((entry) => entry.error).length}`)
writeFixture(new URL('./scene-themes.json', import.meta.url), { meta: [meta], select, graphs: graphs.map((entry) => ({ ...entry, graph: hash(entry.graph) })), caves, open, shortcuts, water, settlements, scenes })
writeFixture(new URL('./scene-themes-relief.json.gz', import.meta.url), { relief }, { gzip: true })

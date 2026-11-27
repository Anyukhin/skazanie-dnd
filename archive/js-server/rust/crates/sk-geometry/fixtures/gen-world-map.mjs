// Эталон `server/world-map.mjs` для Rust-переноса
// (`rust/crates/sk-geometry/src/world_map.rs`).
//
// Запуск из корня репозитория:
//   node rust/crates/sk-geometry/fixtures/gen-world-map.mjs
// Пишет `world-map.json` рядом со скриптом. Входы — случайные с фиксированным
// сидом (mulberry32): авторские источники с мусором, сверки поверх уже
// собранных карт, состояния кампании. `{"$u":1}` — `undefined`.
//
// Карта сверяется по sha256 `JSON.stringify(карта)` (порядок полей тоже часть
// поведения), числу регионов/мест/дорог и текущей точке; первые карты каждого
// вида записаны целиком, чтобы расхождение было видно. Ссылка
// `{"$map": i}` / `{"$rec": i}` во входе — карта из i-го случая сборки или
// сверки: Rust подставляет туда свою карту того же случая. Отказ (`TypeError`)
// записан текстом сообщения V8. `Math.hypot` сверяется отдельно, побитно.

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CITY_OVERVIEW_IMAGE_URL_RE,
  WORLD_MAP_BACKGROUND_URL_RE,
  createCampaignWorldMap,
  ensureCampaignWorldMap,
  normalizeCityOverview,
  normalizeWorldMapBackground,
  normalizeWorldMapLocationLore,
  reconcileWorldMap,
  safeCityOverviewImageUrl,
  safeWorldMapBackgroundUrl,
  worldLocationById,
} from '../../../../server/world-map.mjs'

const UNDEFINED = Object.freeze({ $u: 1 })
const here = dirname(fileURLToPath(import.meta.url))
const FULL_OUTPUTS = 30

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = mulberry32(0x30a1d)
const int = (min, max) => min + Math.floor(random() * (max - min + 1))
const pick = (list) => list[Math.floor(random() * list.length)]
const chance = (probability) => random() < probability
const sha = (text) => createHash('sha256').update(text).digest('hex')
const js = (value) => value === UNDEFINED ? undefined : value
// Одинокий суррогат (JS режет строку посреди пары) в JSON не переносится.
const LONE_SURROGATE = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/iu
const portable = (value) => !LONE_SURROGATE.test(JSON.stringify(value) ?? '')

// --- Тексты --------------------------------------------------------------------
const NAMES = [
  'Норвин', 'Старый порт', 'Башня у перевала', 'Пепельный брод', 'Серебряный монастырь', 'Рыночная площадь',
  'Люмен', 'Чужой форт', 'Чужой порт', 'Ёлкин двор', 'Елкин двор', 'Kelvin Keep', 'ﬁнальный ﬁорд',
  'Ｍорской вал', 'Дом ①', 'Город 😀 смеха', 'Ꙋлица', 'ᲀал', 'İstanbul', 'Straße', 'ΣΟΦΙΑΣ',
  '  Норвин  ', 'НОРВИН', 'Норвин ', '﻿Норвин', 'нор\u0085вин', 'Нор\n\tвин', 'x'.repeat(150),
  'Место—с—тире', 'a/b?c#d', '---', '123', `Долгое ${'слово '.repeat(30)}`, 'Южный порт', 'ЮЖНЫЙ ПОРТ',
  'Башня Ёлки', '  БАШНЯ\nЁЛКИ ', 'Тихая заводь', 'Каменный мост', 'Gate of Dawn', 'Перевал Ветров',
]
const TEXTS = [
  'Город на месте древней обсерватории.', '  Пробелы　по краям  ', 'Строка с  неразрывным',
  '', 'ﬁ ① Ｍ', 'обычный текст',
]
// Длинные тексты упираются в пределы длины (в том числе по UTF-16) — редко,
// чтобы эталон оставался небольшим.
const LONG_TEXTS = [`История ${'долгая '.repeat(250)}`, '😀'.repeat(700), `${'а'.repeat(1198)}😀😀`, `${'б'.repeat(318)}😀😀`]
const SCENE_TEXTS = ['Зажечь маяк', 'Найти колокол', 'После пожара площадь стала непроходимой.', '', 0, null, '   ']
const TRANSITIONS = ['Дорога поднимается к перевалу.', 'Лодка идёт вниз по реке.', 'RIVER crossing', 'Через PASS', 'Пешком', '', null, 0, ['river'], UNDEFINED]

function textValue(pool = TEXTS) {
  if (chance(0.04)) return pick(LONG_TEXTS)
  return chance(0.9) ? pick(pool) : pick([null, 5, true, ['a', 'b'], { text: 'нет' }])
}

function name() {
  return chance(0.93) ? pick(NAMES) : pick(['', null, 42, ['Норвин'], { name: 'x' }])
}

function coordinate(max) {
  const kind = random()
  if (kind < 0.7) return int(-100, max + 200)
  if (kind < 0.8) return int(0, max) + 0.5
  if (kind < 0.85) return -int(1, 50) - 0.5
  return pick([String(int(0, max)), null, 'abc', 1e21, true, [int(0, max)], {}])
}

function setMaybe(target, key, probability, value) {
  if (chance(probability)) {
    const resolved = typeof value === 'function' ? value() : value
    if (resolved !== UNDEFINED) target[key] = resolved
  }
}

// --- Фоны и городской обзор ------------------------------------------------------------
const BACKGROUNDS = [
  '/assets/maps/world/skazanie/ashen-coast-v1.webp',
  '/assets/maps/world/skazanie/map-42-v12.webp',
  '  /assets/maps/world/skazanie/sea-of-glass-v2.webp  ',
  'https://example.test/assets/maps/world/skazanie/ashen-coast-v1.webp',
  '//cdn.example.test/map-v1.webp',
  '/assets/maps/world/skazanie/ashen-coast.webp',
  '/assets/maps/world/skazanie/ashen-coast-v1.png',
  '/assets/maps/world/skazanie/../secret-v1.webp',
  '/assets/maps/world/skazanie/Ashen-coast-v1.webp?cache=1',
  '/assets/maps/world/skazanie/ashen_coast-v1.webp',
  '/assets/maps/world/skazanie/ashen-coast-v0.webp',
  '/assets/maps/world/skazanie/ashen-coast-v1.webp\n',
  '/assets/maps/world/skazanie/ashen-coast-v1.webp\nx',
  '/assets/maps/world/skazanie/ａshen-v1.webp',
  '/assets/maps/city/skazanie/veld-burg-v1.webp',
  '/assets/maps/city/skazanie/city.png',
  '/assets/maps/city/skazanie/../city-v1.webp',
  '/assets/maps/city/skazanie/old-town-v3.webp',
  `/assets/maps/world/skazanie/${'a'.repeat(170)}-v1.webp`,
  null, 5, ['/assets/maps/world/skazanie/ashen-coast-v1.webp'],
]

const GOOD_CITY_IDS = ['old-quarter', 'harbor', 'market', 'ok-1', 'temple-hill', 'old-tower']
const CITY_IDS = [...GOOD_CITY_IDS, 'Old-Quarter', '-bad', 'a'.repeat(81), '', ' harbor ', 5]
const cityId = () => chance(0.85) ? pick(GOOD_CITY_IDS) : pick(CITY_IDS)

function district() {
  if (chance(0.05)) return pick([null, 'район', []])
  const value = {}
  setMaybe(value, 'id', 0.95, cityId)
  setMaybe(value, 'name', 0.95, () => chance(0.9) ? pick(['Старый квартал', 'Гавань', ' Рынок ', 'Храмовый холм']) : pick(['', 5]))
  setMaybe(value, 'x', 0.8, () => coordinate(1000))
  setMaybe(value, 'y', 0.8, () => coordinate(640))
  setMaybe(value, 'bounds', 0.7, () => chance(0.9)
    ? { x: coordinate(1000), y: coordinate(640), width: coordinate(600), height: coordinate(400) }
    : pick([null, [1, 2], 'bounds']))
  setMaybe(value, 'summary', 0.6, () => textValue())
  setMaybe(value, 'history', 0.4, () => textValue())
  setMaybe(value, 'storyHooks', 0.4, () => chance(0.8) ? [textValue(), textValue(), 42, textValue(), textValue()] : 'hook')
  setMaybe(value, 'secret', 0.2, 'не проецировать')
  return value
}

function place(districtIds) {
  if (chance(0.05)) return pick([null, 'место'])
  const value = {}
  setMaybe(value, 'id', 0.95, cityId)
  setMaybe(value, 'name', 0.95, () => chance(0.9) ? pick(['Старая башня', 'Причал', 'Ратуша']) : '')
  setMaybe(value, 'kind', 0.8, () => pick(['civic', 'harbor', 'market', 'temple', 'inn', 'tower', 'castle', null]))
  const districtId = () => districtIds.length && chance(0.85) ? pick(districtIds) : pick(CITY_IDS)
  if (chance(0.5)) setMaybe(value, 'districtId', 0.95, districtId)
  else setMaybe(value, 'district_id', 0.95, districtId)
  setMaybe(value, 'x', 0.8, () => coordinate(1000))
  setMaybe(value, 'y', 0.8, () => coordinate(640))
  setMaybe(value, 'summary', 0.6, () => textValue())
  setMaybe(value, 'history', 0.3, () => textValue())
  setMaybe(value, 'storyHooks', 0.3, () => [textValue(), textValue()])
  setMaybe(value, 'destinationLocationId', 0.2, 'forged')
  return value
}

function cityOverview() {
  if (chance(0.08)) return pick([null, 'план', [], 5])
  const value = {}
  setMaybe(value, 'version', 0.6, () => pick([1, 2, 0, 150, '3', null, 2.5]))
  setMaybe(value, 'name', 0.95, () => chance(0.9) ? pick(['План города', ' Столица ', 'Порт']) : pick(['', 5]))
  setMaybe(value, 'summary', 0.95, () => chance(0.9) ? pick(TEXTS.filter(Boolean)) : '')
  setMaybe(value, 'image', 0.95, () => chance(0.75) ? pick(['/assets/maps/city/skazanie/veld-burg-v1.webp', ' /assets/maps/city/skazanie/old-town-v3.webp']) : pick(BACKGROUNDS))
  if (chance(0.5)) setMaybe(value, 'imageAlt', 0.7, () => textValue())
  else setMaybe(value, 'image_alt', 0.5, () => textValue())
  setMaybe(value, 'width', 0.7, () => pick([1000, 333, 100, 5000, '800', null, 1999.5]))
  setMaybe(value, 'height', 0.7, () => pick([640, 241, 100, 3000, '700', null]))
  setMaybe(value, 'districts', 0.95, () => Array.from({ length: int(0, 10) }, district))
  const districtIds = (value.districts ?? []).filter((entry) => entry && typeof entry === 'object').map((entry) => entry.id).filter((id) => typeof id === 'string')
  setMaybe(value, 'places', 0.95, () => Array.from({ length: int(0, 14) }, () => place(districtIds)))
  setMaybe(value, 'routes', 0.2, [{ from: 'old-quarter', to: 'old-tower' }])
  setMaybe(value, 'currentLocationId', 0.2, 'old-tower')
  return value
}

// --- Авторский источник карты ----------------------------------------------------------
const BIOMES = ['plains', 'forest', 'mountains', 'marsh', 'desert', 'tundra', 'coast', 'wastes']
const KINDS = ['capital', 'city', 'town', 'village', 'port', 'fortress', 'ruin', 'dungeon', 'landmark', 'wilds']

function region() {
  if (chance(0.05)) return pick([null, 'регион', []])
  const value = {}
  setMaybe(value, 'id', 0.6, () => pick(['coast', 'Coast Line', 5, '', null, 'region-1', 'desert', 'coast']))
  setMaybe(value, 'name', 0.95, () => chance(0.9) ? pick(['Янтарный берег', 'Море стекла', 'Горный венец', ' Туманные  Леса ', 'Море стекла']) : name())
  setMaybe(value, 'biome', 0.8, () => chance(0.85) ? pick(BIOMES) : pick(['jungle', null, 'COAST']))
  setMaybe(value, 'x', 0.8, () => coordinate(1000))
  setMaybe(value, 'y', 0.8, () => coordinate(640))
  setMaybe(value, 'radius', 0.6, () => pick([180, 100, 400, 205.5, '250', null]))
  return value
}

function location(regionIds, regionNames) {
  if (chance(0.04)) return pick([null, 'место', [], 7])
  const value = {}
  setMaybe(value, 'id', 0.6, () => pick(['port', 'tower', 'city-lumen', 'capital', 'южный порт', 'Place One', 5, '', null, 'port']))
  setMaybe(value, 'name', 0.97, name)
  setMaybe(value, 'kind', 0.8, () => chance(0.85) ? pick(KINDS) : pick(['castle', null, 'CITY']))
  setMaybe(value, 'x', 0.8, () => coordinate(1000))
  setMaybe(value, 'y', 0.8, () => coordinate(640))
  setMaybe(value, 'regionId', 0.3, () => pick([...regionIds, 'region-2', 'nowhere', 5]))
  setMaybe(value, 'region', 0.3, () => pick([...regionNames, 'Неизвестный край', '  море  СТЕКЛА ']))
  setMaybe(value, 'summary', 0.5, () => textValue())
  setMaybe(value, 'description', 0.3, () => textValue())
  setMaybe(value, 'history', 0.3, () => textValue())
  setMaybe(value, 'storyHooks', 0.3, () => chance(0.85) ? [textValue(), 42, textValue(), textValue(), textValue()] : 'hook')
  if (chance(0.12)) value[chance(0.7) ? 'cityOverview' : 'city_overview'] = cityOverview()
  setMaybe(value, 'garrison', 0.2, () => pick([false, true, 'false', 0]))
  setMaybe(value, 'known', 0.3, () => pick([false, true, 0, null]))
  setMaybe(value, 'visited', 0.3, () => pick([true, false, 'true', 1]))
  return value
}

function endpoint(locations) {
  const named = locations.filter((entry) => entry && typeof entry === 'object')
  const kind = random()
  if (kind < 0.4 && named.length) return pick(named).id ?? 'port'
  if (kind < 0.8 && named.length) {
    const target = pick(named).name
    return typeof target === 'string' && chance(0.5) ? `  ${target.toUpperCase()}\n` : target
  }
  return pick(['нет такого места', null, 5, '', 'port', 'tower'])
}

function route(locations) {
  if (chance(0.04)) return pick([null, 'дорога', 3])
  const value = {}
  setMaybe(value, 'id', 0.4, () => pick(['road-1', '', '  north road ', 5, null]))
  setMaybe(value, 'from', 0.97, () => endpoint(locations))
  setMaybe(value, 'to', 0.97, () => endpoint(locations))
  setMaybe(value, 'kind', 0.6, () => pick(['road', 'trail', 'river', 'sea', 'pass', 'portal', null]))
  setMaybe(value, 'distance', 0.5, () => pick([1, 5, 31, 0, 2.5, '7', null, 'far']))
  setMaybe(value, 'danger', 0.5, () => pick(['низкая', 'средняя', 'высокая', 'смертельная', null]))
  setMaybe(value, 'discovered', 0.4, () => pick([false, true, 0]))
  return value
}

function authoredSource() {
  const value = {}
  const regions = chance(0.6) ? Array.from({ length: int(0, 14) }, region) : undefined
  if (regions) value.regions = regions
  const regionIds = (regions ?? []).filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string').map((entry) => entry.id)
  const regionNames = (regions ?? []).filter((entry) => entry && typeof entry === 'object' && typeof entry.name === 'string').map((entry) => entry.name)
  const locationCount = chance(0.05) ? int(38, 46) : int(0, 12)
  const locations = chance(0.8) ? Array.from({ length: locationCount }, () => location(regionIds, regionNames)) : undefined
  if (locations) value.locations = locations
  if (chance(0.5)) value.routes = Array.from({ length: int(0, 20) }, () => route(locations ?? []))
  setMaybe(value, 'routesComplete', 0.3, () => pick([true, true, 'true', 1, false]))
  setMaybe(value, 'backgroundImage', 0.3, () => pick(BACKGROUNDS))
  setMaybe(value, 'backgroundAlt', 0.25, () => textValue())
  setMaybe(value, 'name', 0.3, name)
  return value
}

const CONCEPTS = [
  UNDEFINED, {}, { genre: 'тёмное фэнтези' }, { preset: 'Пустынные земли' }, { worldSummary: 'Северные льды и тундра' },
  { genre: 'постапокалипсис' }, { preset: ['пустош', 2], genre: 1e21 }, { worldSummary: 'ЛЕДЯНОЙ край' }, 'концепт', 5, [],
  { preset: null, genre: { nested: true }, worldSummary: 'Арктика' },
]

function startingName(source) {
  const names = (source.locations ?? []).filter((entry) => entry && typeof entry === 'object').map((entry) => entry.name)
  if (names.length && chance(0.35)) {
    const chosen = pick(names)
    return typeof chosen === 'string' && chance(0.4) ? `  ${chosen.toUpperCase()} ` : chosen
  }
  return chance(0.85) ? pick(NAMES) : pick(['', null, UNDEFINED, 5])
}

function createInput() {
  if (chance(0.01)) return pick([null, UNDEFINED, 'карта', 5])
  const input = {}
  setMaybe(input, 'seed', 0.8, () => chance(0.85) ? `seed-${int(1, 1e6)}` : pick(['', null, 42, { seed: 1 }, '  ', 'x'.repeat(200)]))
  setMaybe(input, 'campaignName', 0.8, () => chance(0.9) ? pick(['Пепельный рубеж', 'Дороги', 'Стеклянный путь', '  ', 'x'.repeat(130)]) : pick([null, 7]))
  setMaybe(input, 'concept', 0.7, () => chance(0.97) ? pick(CONCEPTS) : null)
  const source = chance(0.85) ? authoredSource() : {}
  if (chance(0.97)) input.source = source
  else input.source = pick([null, 'источник', [], 3])
  setMaybe(input, 'startingLocation', 0.9, () => startingName(source))
  setMaybe(input, 'startingLocationId', 0.4, () => {
    const ids = (source.locations ?? []).filter((entry) => entry && typeof entry === 'object').map((entry) => entry.id)
    return ids.length && chance(0.6) ? pick(ids) ?? 'port' : pick(['port', '  port ', 'нет', null, 5, ''])
  })
  setMaybe(input, 'addMissingStartingLocation', 0.25, () => pick([false, 0, '', 'yes', true, null]))
  return input
}

// --- Сборка случаев --------------------------------------------------------------------------
function outcome(run) {
  try {
    const result = run()
    return { ok: true, result }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

function record(result, index) {
  const text = JSON.stringify(result)
  return {
    hash: sha(text),
    currentLocationId: result.currentLocationId,
    counts: [result.regions.length, result.locations.length, result.routes.length],
    ...(index < FULL_OUTPUTS ? { full: result } : {}),
  }
}

const createCases = []
const createdMaps = []
for (let attempt = 0; createCases.length < 160 && attempt < 1000; attempt += 1) {
  const input = createInput()
  const run = outcome(() => createCampaignWorldMap(resolve(input)))
  if (run.ok && !portable(run.result)) continue
  const index = createCases.length
  createCases.push({ input, ...(run.ok ? record(run.result, index) : { error: run.error }) })
  createdMaps.push(run.ok ? run.result : null)
}

const reconciledMaps = []
function mapReference() {
  const created = createdMaps.map((map, index) => map ? index : -1).filter((index) => index >= 0)
  const reconciled = reconciledMaps.map((map, index) => map ? index : -1).filter((index) => index >= 0)
  if (reconciled.length && chance(0.45)) {
    const index = pick(reconciled)
    return { ref: { $rec: index }, map: reconciledMaps[index] }
  }
  const index = pick(created)
  return { ref: { $map: index }, map: createdMaps[index] }
}

function nameFrom(map) {
  const names = map ? map.locations.map((entry) => entry.name) : []
  const kind = random()
  if (kind < 0.45 && names.length) {
    const chosen = pick(names)
    return chance(0.3) ? ` ${chosen.toLowerCase()}\t` : chosen
  }
  if (kind < 0.85) return pick(NAMES)
  return pick(['', null, UNDEFINED, 7])
}

function idFrom(map) {
  const ids = map ? map.locations.map((entry) => entry.id) : []
  return ids.length && chance(0.7) ? pick(ids) : pick(['нет', '', null, UNDEFINED, '  port '])
}

function sceneValue() {
  if (chance(0.05)) return pick([null, 'сцена', 3, UNDEFINED])
  const value = {}
  setMaybe(value, 'objective', 0.6, () => pick(SCENE_TEXTS))
  setMaybe(value, 'scene_kind', 0.5, () => pick(['settlement', 'dungeon', 'wilds', null]))
  setMaybe(value, 'danger', 0.5, () => pick(['высокая', 'низкая', 'средняя', 'смертельная', null]))
  setMaybe(value, 'location', 0.3, () => pick(NAMES))
  return value
}

function reconcileOptions(map) {
  if (chance(0.02)) return pick([null, UNDEFINED, 'опции'])
  const options = {}
  setMaybe(options, 'seed', 0.4, () => pick([`seed-${int(1, 1e6)}`, '', null]))
  setMaybe(options, 'campaignName', 0.6, () => pick(['Дороги', 'Хроника', null, '']))
  setMaybe(options, 'concept', 0.4, () => chance(0.95) ? pick(CONCEPTS) : null)
  setMaybe(options, 'currentLocation', 0.9, () => nameFrom(map))
  setMaybe(options, 'currentLocationId', 0.4, () => idFrom(map))
  setMaybe(options, 'previousLocation', 0.7, () => nameFrom(map))
  setMaybe(options, 'previousLocationId', 0.35, () => idFrom(map))
  setMaybe(options, 'knownLocations', 0.7, () => chance(0.95)
    ? Array.from({ length: int(0, 6) }, () => nameFrom(map))
    : pick([null, 'ab', '', 5, { a: 1 }]))
  setMaybe(options, 'transition', 0.6, () => pick(TRANSITIONS))
  setMaybe(options, 'scene', 0.8, sceneValue)
  return options
}

function resolve(value) {
  if (Array.isArray(value)) return value.map(resolve)
  if (value && typeof value === 'object') {
    if ('$map' in value) return structuredClone(createdMaps[value.$map])
    if ('$rec' in value) return structuredClone(reconciledMaps[value.$rec])
    if ('$u' in value) return undefined
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry)]))
  }
  return value
}

const reconcileCases = []
for (let attempt = 0; reconcileCases.length < 200 && attempt < 2000; attempt += 1) {
  const garbage = chance(0.06)
  const { ref, map } = garbage
    ? { ref: pick([null, UNDEFINED, 'карта', [], { seed: 'only-seed' }, {}]), map: null }
    : mapReference()
  const options = reconcileOptions(map)
  const run = outcome(() => reconcileWorldMap(resolve(ref), resolve(options)))
  if (run.ok && !portable(run.result)) continue
  const index = reconcileCases.length
  reconcileCases.push({ map: ref, options, ...(run.ok ? record(run.result, index) : { error: run.error }) })
  reconciledMaps.push(run.ok ? run.result : null)
}

// Концепт для отпечатка `JSON.stringify` (сид карты из состояния): ключи-
// индексы, экспоненты, `-0`, управляющие символы. Числа выбраны такими, что
// serde_json без `float_roundtrip` читает их точно: `123456789012345680000`
// он прочитал бы на один ulp иначе, чем JS.
const FINGERPRINT_CONCEPT = {
  b: 1, 10: 2, a: [1.5, 1e21, -0, null, 1e-7, 4.5e21, 12345678901234567000], 2: 'x',
  nested: { ' ': 'a"b\\c\n\u0001\u007f', ключ: true },
}

function ensureState() {
  if (chance(0.02)) return pick([null, UNDEFINED, 'состояние', []])
  const state = {}
  setMaybe(state, 'sessionCode', 0.8, () => pick(['LEGACY-MAP', 'ROOM-1', 42, null, '']))
  setMaybe(state, 'campaign', 0.8, () => pick(['Старая хроника', 'Пепельный рубеж', null, '', ['a', 1]]))
  setMaybe(state, 'campaignConcept', 0.7, () => chance(0.9) ? pick([...CONCEPTS, FINGERPRINT_CONCEPT]) : null)
  const base = chance(0.5) ? mapReference() : { ref: undefined, map: null }
  if (base.ref) state.worldMap = base.ref
  else setMaybe(state, 'worldMap', 0.1, () => pick([null, { seed: 'only-seed' }, { seed: '' }, 'карта', { seed: 5, locations: 'x' }]))
  setMaybe(state, 'scene', 0.9, () => {
    if (chance(0.05)) return pick([null, 'сцена'])
    const scene = sceneValue()
    if (scene && typeof scene === 'object' && !Array.isArray(scene) && scene !== UNDEFINED) {
      setMaybe(scene, 'location', 0.85, () => nameFrom(base.map))
      setMaybe(scene, chance(0.5) ? 'location_id' : 'locationId', 0.3, () => idFrom(base.map))
    }
    return scene
  })
  setMaybe(state, 'adventure', 0.85, () => {
    if (chance(0.05)) return pick([null, 'приключение', []])
    const adventure = {}
    setMaybe(adventure, 'visitedLocations', 0.7, () => chance(0.9) ? Array.from({ length: int(0, 5) }, () => nameFrom(base.map)) : 'Норвин')
    setMaybe(adventure, 'history', 0.7, () => chance(0.9)
      ? Array.from({ length: int(0, 4) }, () => chance(0.85)
        ? Object.fromEntries([
          ['location', nameFrom(base.map)],
          ...(chance(0.3) ? [[chance(0.5) ? 'location_id' : 'locationId', idFrom(base.map)]] : []),
        ].filter(([, entry]) => entry !== UNDEFINED))
        : pick([null, 'Норвин', 5]))
      : pick(['история', null]))
    setMaybe(adventure, 'lastTransition', 0.5, () => pick(TRANSITIONS))
    return adventure
  })
  return state
}

const ensureCases = []
for (let attempt = 0; ensureCases.length < 90 && attempt < 1000; attempt += 1) {
  const state = ensureState()
  const run = outcome(() => ensureCampaignWorldMap(resolve(state)))
  if (run.ok && !portable(run.result)) continue
  const index = ensureCases.length
  ensureCases.push({ state, ...(run.ok ? record(run.result, index) : { error: run.error }) })
}

// --- Мелкие функции ----------------------------------------------------------------------
const backgroundUrls = BACKGROUNDS.map((value) => ({ value, world: safeWorldMapBackgroundUrl(value), city: safeCityOverviewImageUrl(value) }))
const backgrounds = []
for (let index = 0; index < 120; index += 1) {
  const value = chance(0.9) ? {} : pick([null, 'фон', [], UNDEFINED])
  if (value && typeof value === 'object' && !Array.isArray(value) && !('$u' in value)) {
    setMaybe(value, 'backgroundImage', 0.85, () => pick(BACKGROUNDS))
    setMaybe(value, 'backgroundAlt', 0.6, () => textValue())
  }
  backgrounds.push({ value, expected: normalizeWorldMapBackground(js(value)) })
}
const lore = []
for (let index = 0; index < 150; index += 1) {
  const value = chance(0.92) ? {} : pick([null, 'лор', [], UNDEFINED])
  if (value && typeof value === 'object' && !Array.isArray(value) && !('$u' in value)) {
    setMaybe(value, 'history', 0.7, () => textValue())
    setMaybe(value, 'storyHooks', 0.7, () => chance(0.85) ? Array.from({ length: int(0, 6) }, () => textValue()) : pick(['hook', null]))
  }
  const expected = normalizeWorldMapLocationLore(js(value))
  if (portable(expected)) lore.push({ value, expected })
}
const cityOverviews = []
for (let attempt = 0; cityOverviews.length < 150 && attempt < 1000; attempt += 1) {
  const value = chance(0.97) ? cityOverview() : UNDEFINED
  const expected = normalizeCityOverview(js(value))
  if (!portable(expected)) continue
  cityOverviews.push({ value, expected })
}
const lookups = []
for (let index = 0; index < 200; index += 1) {
  const { ref, map } = chance(0.92) ? mapReference() : { ref: pick([null, UNDEFINED, {}, { locations: 'x' }, { locations: [5, 'a', { id: 'port' }] }]), map: null }
  const id = chance(0.6) && map ? pick(map.locations).id : pick(['port', ' port ', 'нет', '', 'tower', 'location-1-норвин'])
  const decorated = chance(0.2) ? `  ${id} ` : id
  const found = worldLocationById(resolve(ref), decorated)
  lookups.push({ map: ref, id: decorated, expected: found ?? null })
}

const hypot = []
for (let index = 0; index < 3000; index += 1) {
  const kind = random()
  const a = kind < 0.5 ? int(-1100, 1100) : kind < 0.8 ? int(-1100, 1100) + int(0, 15) / 16 : Math.round((random() - 0.5) * 2e6) / 1e3
  const b = kind < 0.5 ? int(-700, 700) : kind < 0.8 ? int(-700, 700) + int(0, 15) / 16 : Math.round((random() - 0.5) * 2e6) / 1e3
  hypot.push([a, b, String(Math.hypot(a, b))])
}

const fixture = {
  patterns: { world: WORLD_MAP_BACKGROUND_URL_RE.source, city: CITY_OVERVIEW_IMAGE_URL_RE.source },
  create: createCases,
  reconcile: reconcileCases,
  ensure: ensureCases,
  backgroundUrls,
  backgrounds,
  lore,
  cityOverviews,
  lookups,
  hypot,
}
const target = join(here, 'world-map.json')
writeFileSync(target, `${JSON.stringify(fixture)}\n`)
const failures = (list) => list.filter((entry) => entry.error).length
console.log(`world-map: сборок ${createCases.length} (отказов ${failures(createCases)}), сверок ${reconcileCases.length} (отказов ${failures(reconcileCases)}), состояний ${ensureCases.length} (отказов ${failures(ensureCases)}), мелких ${backgroundUrls.length + backgrounds.length + lore.length + cityOverviews.length + lookups.length}, hypot ${hypot.length} → ${target}`)

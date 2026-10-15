import '../../../fixtures-env.mjs'
// Эталон server/map-library.mjs для Rust:
//
//   node rust/crates/sk-story/fixtures/gen-map-library.mjs
//
// Постройки собирает JS: синтетические слэбы TaleSpire (кодировщик
// `test/talespire-fixtures.mjs`, дома разного размера, с дверью в разных
// стенах, с вторым и третьим этажом и без) импортируются `importTaleSpireSlab`,
// к ним добавлены карты генераторов (`generateSceneGeometry`). Чужих построек
// с TalesTavern здесь нет.
//
// Секции:
// - `placeKinds`, `climates`, `requests` — словари и заявка сцены;
// - `levels` — `libraryLevelProblems` на целых и испорченных этажах;
// - `entries` — паспорта записей: `libraryPlaceKinds`, `libraryAnchors`;
// - `choose` — `chooseLibraryMap` на сотнях наборов записей, заявок и сидов;
// - `idsInUse` — `libraryIdsInUse`;
// - `library` — сценарии `MapLibrary` во временном каталоге: запись, чтение,
//   подбор с проверкой программы; файлы на диске — хешем их текста.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hash, mulberry32, picker, plain, writeFixture } from './common.mjs'

const root = new URL('../../../../', import.meta.url)
const ml = await import(new URL('server/map-library.mjs', root).href)
const t = await import(new URL('server/tactical-map.mjs', root).href)
const { importTaleSpireSlab } = await import(new URL('server/talespire-import.mjs', root).href)
const { ASSETS, encodeSlabV2, HOUSE_SLAB } = await import(new URL('test/talespire-fixtures.mjs', root).href)
const { generateSceneGeometry } = await import(new URL('server/adventure-director.mjs', root).href)
const { SCENE_REQUIREMENT_KINDS } = await import(new URL('server/scene-requirements.mjs', root).href)

const { int, pick, chance } = picker(mulberry32(2026_10_15))
function hashText(text) {
  return createHash('sha256').update(text).digest('hex')
}

// --- постройки ---------------------------------------------------------------

/** Дом: пол, стены по краям, дверь, при желании второй и третий этаж с лестницей. */
function housePlacements({ width, depth, door, upper, third, table }) {
  const placements = []
  for (let x = 0; x < width; x += 1) for (let z = 0; z < depth; z += 1) placements.push({ asset: ASSETS.floor, x, y: 0, z })
  for (let z = 0; z < depth; z += 1) placements.push({ asset: ASSETS.wallAlongZ, x: 0, y: 0.5, z })
  for (let z = 0; z < depth; z += 1) {
    if (z === door) placements.push({ asset: ASSETS.door, x: width - 3.25, y: 0.5, z, rotation: 90 })
    else placements.push({ asset: ASSETS.wallAlongZ, x: width - 3.25, y: 0.5, z })
  }
  if (upper) {
    for (let x = 0; x < upper; x += 1) for (let z = depth - 4; z < depth; z += 1) placements.push({ asset: ASSETS.floor, x, y: 2.5, z })
    placements.push({ asset: ASSETS.stairs, x: upper, y: 0.5, z: depth - 7 })
    placements.push({ asset: ASSETS.stairs, x: upper, y: 1.0, z: depth - 6 })
    placements.push({ asset: ASSETS.stairs, x: upper, y: 1.5, z: depth - 5 })
  }
  if (upper && third) {
    for (let x = 0; x < 3; x += 1) for (let z = depth - 3; z < depth; z += 1) placements.push({ asset: ASSETS.floor, x, y: 5, z })
    placements.push({ asset: ASSETS.stairs, x: 3, y: 3.0, z: depth - 4 })
    placements.push({ asset: ASSETS.stairs, x: 3, y: 3.5, z: depth - 3 })
    placements.push({ asset: ASSETS.stairs, x: 3, y: 4.0, z: depth - 2 })
  }
  if (table) placements.push({ asset: ASSETS.table, x: 2, y: 0.5, z: 1 })
  return placements
}

/** @type {Array<{ id: string, levels: any[], passport: any }>} */
const buildings = []
const tryImport = (id, slab) => {
  try {
    const imported = importTaleSpireSlab(slab, { locationId: id })
    buildings.push({ id, levels: plain(imported.levels), passport: plain(imported.passport) })
  } catch (error) {
    console.log(`  импорт ${id} отказал: ${error.message}`)
  }
}
tryImport('tt-house', HOUSE_SLAB)
for (let index = 0; index < 14; index += 1) {
  const width = 8 + int(7)
  const depth = 8 + int(5)
  const options = { width, depth, door: 1 + int(depth - 2), upper: chance(0.7) ? 3 + int(2) : 0, third: chance(0.4), table: chance(0.6) }
  tryImport(`tt-variant-${index}`, encodeSlabV2(housePlacements(options)))
}
// Карты генераторов: одноэтажные, лестницы ведут на этажи, которых в записи нет.
for (const [id, input] of [
  ['gen-tavern', { location: 'Таверна', seed: 'lib:tavern', levels: [{ offset: 1 }, { offset: -1 }] }],
  ['gen-shop', { location: 'Лавка', seed: 'lib:shop' }],
  ['gen-village', { location: 'Деревня', seed: 'lib:village' }],
  ['gen-crypt', { location: 'Склеп', seed: 'lib:crypt' }],
  ['gen-temple', { location: 'Храм', seed: 'lib:temple' }],
]) {
  const { map } = generateSceneGeometry({ ...input, useLibrary: false })
  buildings.push({ id, levels: [{ index: 0, label: 'Этаж', map: plain(t.serializeTacticalMap(map)) }], passport: null })
}
console.log(`  построек ${buildings.length}: ${buildings.map((building) => `${building.id}×${building.levels.length}`).join(', ')}`)

// --- этажи ------------------------------------------------------------------------

const clone = (value) => JSON.parse(JSON.stringify(value))
const levelCases = []
const addLevels = (label, levels) => levelCases.push({ label, levels: plain(levels), problems: plain(ml.libraryLevelProblems(clone(levels))) })
const upperSpoilers = {
  'out-of-bounds': (map) => ({ ...map, props: [...map.props, { ...map.props[0], id: 'probe-out-of-bounds', x: -0.5, y: -0.5, footprint: [{ x: -1, y: -1 }] }] }),
  'walled-arrival': (map) => {
    const upper = t.deserializeTacticalMap(map)
    const stairs = upper.props.find((prop) => prop.transition)
    if (stairs) t.setCell(upper, stairs.footprint[0].x, stairs.footprint[0].y, { passable: false })
    return t.serializeTacticalMap(upper)
  },
  'no-return': (map) => ({ ...map, props: map.props.filter((prop) => !prop.transition) }),
  'arrival-without-footprint': (map) => ({ ...map, props: map.props.map((prop) => (prop.transition ? { ...prop, footprint: [] } : prop)) }),
  'prop-on-solid': (map) => {
    const upper = t.deserializeTacticalMap(map)
    const prop = upper.props.find((entry) => !entry.transition)
    if (prop?.footprint[0]) t.setCell(upper, prop.footprint[0].x, prop.footprint[0].y, { passable: false })
    return t.serializeTacticalMap(upper)
  },
}
const groundSpoilers = {
  'no-spawn': (map) => ({ ...map, spawnPoints: [] }),
  'spawn-in-wall': (map) => {
    const ground = t.deserializeTacticalMap(map)
    const spawn = ground.spawnPoints.find((point) => point.role === 'party')
    if (spawn) t.setCell(ground, spawn.x, spawn.y, { passable: false })
    return t.serializeTacticalMap(ground)
  },
  'out-of-bounds': (map) => ({ ...map, props: [...map.props, { ...(map.props[0] ?? { assetId: 'crate' }), id: 'probe', x: 99.5, y: 99.5, footprint: [{ x: 99, y: 99 }] }] }),
  'level-index-1': (map) => ({ ...map, levelIndex: 1 }),
}
for (const building of buildings) {
  addLevels(`${building.id}/whole`, building.levels)
  addLevels(`${building.id}/ground-only`, building.levels.filter((level) => level.index === 0))
  addLevels(`${building.id}/reversed`, [...building.levels].reverse())
  for (const [name, spoil] of Object.entries(groundSpoilers)) {
    addLevels(`${building.id}/ground-${name}`, building.levels.map((level) => (level.index === 0 ? { ...level, map: spoil(clone(level.map)) } : level)))
  }
  if (building.levels.length > 1) {
    for (const [name, spoil] of Object.entries(upperSpoilers)) {
      addLevels(`${building.id}/upper-${name}`, building.levels.map((level) => (level.index === 0 ? level : { ...level, map: spoil(clone(level.map)) })))
    }
    addLevels(`${building.id}/upper-only`, building.levels.filter((level) => level.index !== 0))
    addLevels(`${building.id}/index-mismatch`, building.levels.map((level) => (level.index === 1 ? { ...level, index: 2 } : level)))
    addLevels(`${building.id}/duplicate`, [...building.levels, building.levels[1]])
    addLevels(`${building.id}/string-index`, building.levels.map((level) => ({ ...level, index: String(level.index) })))
  }
}
const house = buildings[0]
addLevels('broken/not-array', null)
addLevels('broken/empty', [])
addLevels('broken/null-level', [null, ...house.levels])
addLevels('broken/fraction-index', [...house.levels, { index: 1.5, label: '', map: house.levels[1].map }])
addLevels('broken/bad-map', [house.levels[0], { index: 1, label: '', map: null }])
addLevels('broken/garbage-layers', [house.levels[0], { index: 1, label: '', map: { width: 4, height: 4, layers: { present: 'nope' } } }])
addLevels('broken/no-index', [{ label: 'без номера', map: house.levels[0].map }])

// --- словари и заявка ------------------------------------------------------------

const TYPES = ['inn', 'merchant', 'market', 'trade', 'blacksmith', 'warehouse', 'church', 'catacombs', 'caves', 'mine', 'maze', 'prison', 'lab', 'dungeon', 'underground', 'fortress', 'gatehouse', 'tower', 'castle', 'palace', 'home', 'single-structure', 'farm', 'village', 'multiple-structures', 'city', 'camp', 'ruins', 'nature', 'area', 'wilderness', 'woodland', 'jungle', 'swamp', 'mountain', 'docks', 'arena', 'bridge', 'unknown', 'toString', 'constructor-x']
const TERRAINS = ['desert', 'volcanic', 'tundra', 'swamp', 'jungle', 'woodland', 'dungeon', 'underground', 'docks', 'castle', 'nature', 'mountain', 'grassland', 'city']
const FEATURES = ['common_room', 'bedrooms', 'kitchen', 'storage', 'shop', 'shrine', 'crypt', 'cave', 'doors', 'barracks', 'throne', 'library', 'street', 'yard', 'grove', 'camp', 'cellar', 'upstairs', 'interior', 'exterior']
const TITLES = ['', 'Old Inn', 'Cog Small Ship Merchant', 'The Galleon', 'Shipwright house', 'USS Enterprise', 'airship dock', 'Boathouse', 'boat', 'Корабль', 'Village of Elm', 'HMS Victory', 'Spelljammer']
const MATERIALS = ['wood', 'stone', 'grass', 'sand', 'ice', 'marble', 'earth', 'metal']
const sample = (items, max) => Array.from({ length: int(max + 1) }, () => pick(items))
const randomPassport = () => ({
  features: [...new Set(sample(FEATURES, 6))],
  interior_share: pick([0, 0.05, 0.2, 0.3, 0.44, 0.45, 0.46, 0.5, 0.8, 1, undefined, '0.6']),
  material: pick(MATERIALS),
})

const placeKinds = []
for (let index = 0; index < 600; index += 1) {
  const types = sample(TYPES, 4)
  const terrains = sample(TERRAINS, 3)
  const passport = randomPassport()
  const title = pick(TITLES)
  placeKinds.push({ types, terrains, passport: plain(passport), title, kinds: ml.placeKindsFor(types, terrains, passport, title) })
}
const climates = []
for (let index = 0; index < 200; index += 1) {
  const terrains = sample(TERRAINS, 3)
  const passport = { material: pick(MATERIALS) }
  climates.push({ terrains, passport, climate: ml.climateFor(terrains, passport) })
}

const KIND_IDS = SCENE_REQUIREMENT_KINDS.map((kind) => kind.id)
const randomRequirements = () => (chance(0.5) ? [] : Array.from({ length: 1 + int(4) }, () => (chance(0.9) ? { id: pick([...KIND_IDS, 'dragon']), count: pick([1, 1, 2, 3, 0, 99, '2', null]) } : null)))
const randomProgram = () => (chance(0.6) ? null : {
  items: randomRequirements(),
  focus: chance(0.7) ? pick(KIND_IDS) : 'nothing',
  posts: chance(0.5) ? [{ npc: 'Терен', id: pick(KIND_IDS) }] : [],
  clues: chance(0.5) ? sample(KIND_IDS, 2) : [],
})
const THEMES = ['building', 'temple', 'crypt', 'cave', 'forest', 'road', 'settlement', 'dungeon', '']
const PLACES = ['', 'Таверна «Рог»', 'Палуба торгового корабля', 'Драккар у причала', 'Ладья купца', 'ладьи', 'Станция «Заря»', 'Деревня у реки', 'Шхуна', 'Корабельная верфь']
const WORLDS = ['', 'Киберпанк-мегаполис будущего', 'Королевство драконов', 'Орбитальная станция', 'sci-fi', 'Космос', 'роботы и магия']
function randomRequestInput() {
  const input = { themeId: pick(THEMES) }
  if (chance(0.7)) input.buildingUse = pick(['tavern', 'shop', 'manor', 'dwelling', ''])
  if (chance(0.6)) input.topology = pick(['harbor', 'market', 'gate', 'organic', 'river'])
  if (chance(0.6)) input.climate = pick(['temperate', 'arid', 'cold', 'wetland', ''])
  if (chance(0.5)) input.worldKind = pick(['dungeon', 'ruin', 'fortress', 'town', ''])
  if (chance(0.4)) input.levels = sample([{ offset: 1 }, { offset: -1 }, { offset: 2 }, { offset: '-1' }, {}], 2)
  if (chance(0.7)) input.width = pick([16, 20, 26, 30, 40, 48, 60, 10, 25.5])
  if (chance(0.7)) input.height = pick([16, 20, 22, 30, 44, 60, 8])
  if (chance(0.5)) input.place = pick(PLACES)
  if (chance(0.4)) input.world = pick(WORLDS)
  input.requirements = randomRequirements()
  input.program = randomProgram()
  return input
}
const requests = []
for (let index = 0; index < 600; index += 1) {
  const input = randomRequestInput()
  requests.push({ input: plain(input), request: plain(ml.libraryRequestFor(input)) })
}

// --- записи и подбор --------------------------------------------------------------

function randomEntry(index) {
  const passport = randomPassport()
  if (chance(0.15)) passport.genre = 'scifi'
  else if (chance(0.1)) passport.genre = 'fantasy'
  passport.floor_cells = pick([16, 64, 120, 200, 256, 300, 400, 420, 500, 600, 900, 1600, 0, undefined])
  if (chance(0.6)) {
    const side = pick([10, 16, 20, 24, 30, 40])
    passport.width = side
    passport.height = side
  }
  if (chance(0.6)) passport.levels = [{ index: 0, label: 'Земля', cells: pick([50, 120, 200, 300, 400, 600, 0, -5, '400']), rooms: [] }, ...(chance(0.4) ? [{ index: 1, label: 'Верх', cells: 40, rooms: [] }] : [])]
  if (chance(0.5)) passport.props = Object.fromEntries(sample(['well', 'campfire', 'market_awning', 'chest', 'haystack', 'crate', 'barrel', 'table_small', 'bed'], 4).map((id) => [id, 1 + int(3)]))
  if (chance(0.4)) passport.anchors = Object.fromEntries(sample(KIND_IDS, 4).map((id) => [id, int(3)]))
  if (chance(0.3)) passport.quality = { score: pick([0.3, 0.59, 0.6, 0.8, 1]) }
  const types = chance(0.85) ? sample(TYPES, 3) : undefined
  const entry = {
    id: chance(0.97) ? `e-${index}-${pick(['a', 'b', 'tavern', 'village'])}` : `Bad Id ${index}`,
    title: pick(TITLES),
    source: { site: 'TalesTavern', url: `https://example.invalid/${index}`, author: 'Автор', license: 'Attribution', downloads: pick([0, 1, 10, 42, 999, 15000, undefined]) },
    place_kinds: sample(['tavern', 'shop', 'temple', 'crypt', 'cave', 'dungeon', 'fortress', 'manor', 'house', 'village', 'camp', 'ruins', 'wilds', 'docks', 'ship', 'bridge'], 2),
    climate: pick(['', '', '', 'arid', 'cold', 'wetland']),
    terrains: sample(TERRAINS, 2),
    passport,
    levels: [{ index: 0, label: 'Первый этаж' }],
    slab_sha256: 'x',
    added_at: '2026-10-02T00:00:00.000Z',
  }
  if (types) entry.types = types
  return plain(entry)
}
const entryPool = Array.from({ length: 400 }, (_, index) => randomEntry(index))
const entries = entryPool.map((entry) => ({ entry, placeKinds: ml.libraryPlaceKinds(entry), anchors: ml.libraryAnchors(entry) }))
const choose = []
for (let index = 0; index < 1500; index += 1) {
  const pool = Array.from({ length: 1 + int(25) }, () => int(entryPool.length))
  const input = randomRequestInput()
  const request = ml.libraryRequestFor(input)
  // Заявку иногда правят руками, как тест (`{ ...tavern, climate: 'arid' }`).
  if (chance(0.15)) request.climate = pick(['arid', 'cold', 'wetland', ''])
  const seed = pick(['a', 'b', 's1', 's2', `seed-${index}`])
  const usedIds = chance(0.3) ? sample(pool.map((entryIndex) => entryPool[entryIndex].id), 3) : []
  const chosen = ml.chooseLibraryMap(pool.map((entryIndex) => entryPool[entryIndex]), request, { seed, usedIds })
  choose.push({ pool, request: plain(request), seed, usedIds, chosen: chosen?.id ?? null })
}

const idsInUse = []
for (let index = 0; index < 100; index += 1) {
  const locationMaps = {}
  for (let item = 0; item < int(6); item += 1) {
    const key = pick([`loc-${item}`, String(item), `loc-${item}::level:1`])
    locationMaps[key] = pick([
      { map: { seed: `library:${pick(['tt-a', 'tt-b', 'tt-c'])}:${int(3)}` } },
      { map: { seed: 'other' } },
      { map: {} },
      null,
      { map: { seed: 'library:' } },
      { map: { seed: 7 } },
    ])
  }
  idsInUse.push({ locationMaps, ids: [...ml.libraryIdsInUse(locationMaps)] })
}

// --- библиотека на диске ----------------------------------------------------------

function entryFor(id, overrides = {}) {
  return {
    id,
    title: `Карта ${id}`,
    source: { site: 'TalesTavern', url: `https://talestavern.com/slab/${id}/`, author: 'Автор', license: 'Attribution-NonCommercial', license_url: 'https://creativecommons.org/licenses/by-nc/4.0/', downloads: 10 },
    place_kinds: ['tavern'],
    climate: '',
    terrains: [],
    types: ['inn'],
    passport: { features: ['common_room', 'bedrooms', 'interior', 'upstairs'], interior_share: 0.8, floor_cells: 500, material: 'wood', summary: 'Двухэтажное строение.' },
    levels: [{ index: 0, label: 'Первый этаж' }],
    slab_sha256: 'x',
    added_at: '2026-10-02T00:00:00.000Z',
    ...overrides,
  }
}
const yard = (id, building, extra = {}) => entryFor(id, {
  place_kinds: ['village'],
  types: ['village'],
  passport: { features: ['exterior', 'street'], interior_share: 0.2, floor_cells: 600, width: 25, height: 25, levels: [{ index: 0, label: 'Земля', cells: 600, rooms: [] }], material: 'earth', summary: 'Открытая местность.', props: {}, ...extra },
})

/**
 * Сценарий: шаги над одной библиотекой. Шаг `put` — запись (этажи по id
 * постройки), `pick` — подбор (проверка программы — список ответов по
 * порядку вызовов), `levels`, `entries`. После каждой записи — хеши текста
 * `index.json` и файла этажей.
 */
function runScenario(label, steps) {
  const storage = mkdtempSync(join(tmpdir(), 'sk-story-map-library-'))
  const library = new ml.MapLibrary(storage)
  const results = []
  try {
    for (const step of steps) {
      if (step.op === 'put') {
        try {
          library.put(clone(step.entry), clone(buildings.find((building) => building.id === step.building)?.levels ?? step.levels ?? []))
          const index = readFileSync(join(storage, 'map-library', 'index.json'), 'utf8')
          const id = String(step.entry.id)
          const file = readFileSync(join(storage, 'map-library', 'maps', `${id}.json`), 'utf8')
          results.push({ index: hashText(index), file: hashText(file) })
        } catch (error) {
          results.push({ error: String(error.message) })
        }
      } else if (step.op === 'pick') {
        const answers = [...(step.answers ?? [])]
        let calls = 0
        const picked = library.pick(clone(step.request), {
          seed: step.seed,
          usedIds: step.usedIds ?? [],
          ...(step.answers ? { check: (map) => { calls += 1; return answers.length ? answers.shift() : true } } : {}),
        })
        results.push({ id: picked?.entry.id ?? null, levels: picked ? hash(picked.levels) : null, calls })
      } else if (step.op === 'levels') {
        const levels = library.levels(step.id)
        results.push({ levels: levels ? hash(levels) : null })
      } else if (step.op === 'entries') {
        results.push({ ids: library.entries().map((entry) => entry.id) })
      } else if (step.op === 'raw-index') {
        // Индекс, записанный руками: Rust читает его так же.
        writeFileSync(join(storage, 'map-library', 'index.json'), step.text)
        results.push({ ids: library.entries().map((entry) => entry.id) })
      }
    }
  } finally {
    rmSync(storage, { recursive: true, force: true })
  }
  return { label, steps: plain(steps), results }
}

const tavern = ml.libraryRequestFor({ themeId: 'building', buildingUse: 'tavern' })
const village = ml.libraryRequestFor({ themeId: 'settlement' })
const program = { items: [{ id: 'table', count: 1 }], focus: 'table', posts: [], clues: [] }
const withProgram = ml.libraryRequestFor({ themeId: 'building', buildingUse: 'tavern', requirements: program.items, program })
const library = []
library.push(runScenario('test/store', [
  { op: 'entries' },
  { op: 'put', entry: entryFor('tt-house', { passport: house.passport }), building: 'tt-house' },
  { op: 'entries' },
  { op: 'levels', id: 'tt-house' },
  { op: 'levels', id: '../etc/passwd' },
  { op: 'levels', id: 'missing' },
  { op: 'pick', request: tavern, seed: 'x' },
]))
const spoilt = (name) => house.levels.map((level) => (level.index === 0 ? level : { ...level, map: upperSpoilers[name](clone(level.map)) }))
library.push(runScenario('test/broken-then-whole', [
  { op: 'put', entry: entryFor('tt-broken', { passport: house.passport }), levels: house.levels.map((level) => (level.index === 0 ? { ...level, map: { ...level.map, spawnPoints: [] } } : level)) },
  { op: 'pick', request: tavern, seed: 'x' },
  { op: 'put', entry: entryFor('tt-house', { passport: house.passport }), building: 'tt-house' },
  ...['s1', 's2', 's3', 's4'].map((seed) => ({ op: 'pick', request: tavern, seed })),
]))
library.push(runScenario('test/upper', [
  { op: 'put', entry: entryFor('tt-bad-upper', { passport: house.passport }), levels: spoilt('out-of-bounds') },
  { op: 'put', entry: entryFor('tt-no-return', { passport: house.passport }), levels: spoilt('no-return') },
  ...['s1', 's2', 's3', 's4'].map((seed) => ({ op: 'pick', request: tavern, seed })),
  { op: 'put', entry: entryFor('tt-house', { passport: house.passport }), building: 'tt-house' },
  ...['s1', 's2', 's3', 's4'].map((seed) => ({ op: 'pick', request: tavern, seed })),
]))
library.push(runScenario('test/next', [
  { op: 'put', entry: yard('tt-first', 'tt-house'), building: 'tt-house' },
  { op: 'put', entry: yard('tt-second', 'tt-house'), building: 'tt-house' },
  { op: 'pick', request: village, seed: 'next', answers: [false, true] },
]))
library.push(runScenario('errors', [
  { op: 'put', entry: entryFor('Bad Id', { passport: house.passport }), building: 'tt-house' },
  { op: 'put', entry: { ...entryFor('x'), id: undefined }, building: 'tt-house' },
  { op: 'entries' },
  { op: 'raw-index', text: '{"schema_version":1,"entries":[{"id":"ok-1"},{"id":"Bad"},{"id":5},null,{"title":"без id"}]}' },
  { op: 'raw-index', text: '{"entries":"нет"}' },
]))
// Подбор по всем постройкам: случайные заявки, сиды, проверки программы.
for (let scenario = 0; scenario < 12; scenario += 1) {
  const steps = []
  const ids = []
  for (const building of buildings) {
    if (!chance(0.6)) continue
    const kind = pick(['tavern', 'shop', 'village', 'house', 'temple'])
    const passport = building.passport ?? { features: ['doors', 'interior'], interior_share: 0.7, floor_cells: 400, material: 'wood', summary: '' }
    const entry = kind === 'village'
      ? yard(`${building.id}-${scenario}`, building.id, { anchors: Object.fromEntries(sample(KIND_IDS, 3).map((id) => [id, 1])) })
      : entryFor(`${building.id}-${scenario}`, { place_kinds: [kind], types: [{ tavern: 'inn', shop: 'merchant', house: 'home', temple: 'church' }[kind]], passport: { ...passport, anchors: { table: 1, ...(passport.anchors ?? {}) } }, source: { ...entryFor('x').source, downloads: int(500) } })
    steps.push({ op: 'put', entry: plain(entry), building: building.id })
    ids.push(entry.id)
  }
  steps.push({ op: 'entries' })
  for (let index = 0; index < 25; index += 1) {
    const request = pick([tavern, village, withProgram, ml.libraryRequestFor({ themeId: 'building', buildingUse: pick(['shop', 'dwelling', 'manor']) }), ml.libraryRequestFor({ themeId: 'temple' })])
    steps.push({
      op: 'pick',
      request: plain(request),
      seed: `pick-${scenario}-${index}`,
      usedIds: chance(0.3) ? sample(ids, 2) : [],
      ...(chance(0.4) ? { answers: Array.from({ length: int(4) }, () => chance(0.5)) } : {}),
    })
  }
  for (const id of ids.slice(0, 3)) steps.push({ op: 'levels', id })
  library.push(runScenario(`random/${scenario}`, steps))
}

// Карты этажей — общим пулом по хешу: один и тот же этаж входит в десятки
// случаев. В эталоне карта этажа — `{ "$map": <хеш> }`, Rust подставляет её из пула.
const maps = {}
const pooled = (levels) => (Array.isArray(levels) ? levels.map((level) => {
  if (!level || typeof level !== 'object' || !level.map || typeof level.map !== 'object') return level
  const key = hash(level.map)
  maps[key] = level.map
  return { ...level, map: { $map: key } }
}) : levels)
for (const building of buildings) building.levels = pooled(building.levels)
for (const entry of levelCases) entry.levels = pooled(entry.levels)
for (const scenario of library) for (const step of scenario.steps) if (step.levels) step.levels = pooled(step.levels)
writeFixture(new URL('./map-library.json', import.meta.url), {
  constants: { MIN_LIBRARY_SCORE: ml.MIN_LIBRARY_SCORE, MIN_LIBRARY_QUALITY: ml.MIN_LIBRARY_QUALITY, MAP_LIBRARY_DIR: ml.MAP_LIBRARY_DIR, MAP_LIBRARY_SCHEMA_VERSION: ml.MAP_LIBRARY_SCHEMA_VERSION, LIBRARY_SEED_PREFIX: ml.LIBRARY_SEED_PREFIX },
  maps: Object.entries(maps).map(([key, map]) => ({ key, map })),
  buildings, placeKinds, climates, requests, levels: levelCases, entries, choose, idsInUse, library,
})

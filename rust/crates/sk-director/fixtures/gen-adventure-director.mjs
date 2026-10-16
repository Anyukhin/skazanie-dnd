import '../../../fixtures-env.mjs'
// Эталон server/adventure-director.mjs для Rust:
//
//   node rust/crates/sk-director/fixtures/gen-adventure-director.mjs
//   node rust/crates/sk-director/fixtures/gen-adventure-director.mjs --dump <секция> <метка>
//
// Второй вид печатает полный итог случая (карту — сериализованной) — для
// отладки расхождения: в эталоне крупное хранится хешем.
//
// Секции `adventure-director.json.gz`:
//
// - `memory` — память мест и мелкие помощники (`normalizeLocationMaps`,
//   `sceneMapForLocation`, `sceneTacticalMapForLocation`, `sceneLocationId`,
//   `rememberSceneMap`, `rememberCurrentSceneMap`, `sceneLevelIndex`,
//   `levelKey`, `levelSeed`, `knownWorldKind`, `stableLocationMapSeed`,
//   `publicAdventureMemory`, `entrySideToward`, `openingEntrySide`,
//   `librarySceneFields`): вызовы тестов JS (перехват) и случайные рыхлые
//   входы;
// - `geometry` — `generateSceneGeometry`/`generateSceneCells`: вызовы тестов
//   JS (перехват), корпус двадцати мест программ сцены по пяти сидам,
//   эталонные сцены `MAP_PREVIEW_PRESETS`, случайные входы и мусор. Для карты
//   — хеш, этажи, `missing`, библиотека, коды `auditTacticalMap`, точки входа
//   `entranceOnSide` по сторонам и `outsideEntranceFor` по пробам;
// - `transitions` — `createSceneTransition`: вызовы тестов JS (перехват),
//   переходы корпуса `Dnd-narrator-live/tmp/corpus-v1` (`AdvanceScene`:
//   `scene_args` над состоянием до команды) и мусор. Состояние урезано до
//   полей, которые читает переход; урезанное проверено тем же исходом, что и
//   полное;
// - `chains` — цепочки случайных переходов по карте мира с памятью мест
//   (`rememberCurrentSceneMap` после каждого шага, возвраты в знакомые места);
//   Rust ведёт состояние сам и сверяет каждый шаг;
// - `floors` — `refreshSceneFloors` над синтетическими картами (неф Stave
//   Temple, пороги, повторы зон);
// - `libraries` — библиотеки готовых карт: записи и этажи; Rust записывает их
//   во временный каталог (`MapLibrary.put`) и повторяет выбор.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { argsFrom, argsOf, errorOf, hash, mulberry32, picker, plain, writeFixture } from './common.mjs'

const root = new URL('../../../../', import.meta.url)
const ad = await import(new URL('server/adventure-director.mjs', root).href)
const t = await import(new URL('server/tactical-map.mjs', root).href)
const ml = await import(new URL('server/map-library.mjs', root).href)
const { auditTacticalMap, MAP_PREVIEW_PRESETS } = await import(new URL('server/map-quality.mjs', root).href)
const { sceneMapRequirementsFor } = await import(new URL('server/scene-requirements.mjs', root).href)
const { importTaleSpireSlab } = await import(new URL('server/talespire-import.mjs', root).href)
const { HOUSE_SLAB } = await import(new URL('test/talespire-fixtures.mjs', root).href)

const FIXTURE = new URL('./adventure-director.json.gz', import.meta.url)
const CORPUS_DIR = 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'
const { int, pick, chance } = picker(mulberry32(2026_10_16))
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

// --- итоги в форме эталона ------------------------------------------------------------

function entrancesOf(map) {
  const sides = Object.fromEntries(['west', 'east', 'north', 'south', 'up'].map((side) => [side, ad.entranceOnSide(map, side)]))
  const probes = map.spawnPoints.map((point) => [point.x, point.y])
  for (let index = 0; index < 6; index += 1) probes.push([int(map.width + 2) - 1, int(map.height + 2) - 1])
  probes.push([1.5, 2])
  const outside = probes.map(([x, y]) => ({ x, y, out: ad.outsideEntranceFor(map, { x, y }) }))
  return { sides, outside }
}

function geometryOut(geometry) {
  const { map } = geometry
  return {
    map: hash(t.serializeTacticalMap(map)),
    cells: hash(geometry.cells),
    count: geometry.cells.length,
    levels: 'levels' in geometry ? plain(geometry.levels) : null,
    missing: 'missing' in geometry ? plain(geometry.missing) : null,
    library: geometry.library ? { entry: geometry.library.entry.id, levels: hash(geometry.library.levels) } : null,
    audit: auditTacticalMap(map).problems.map((problem) => problem.code),
    ...entrancesOf(map),
  }
}

function transitionOut(result) {
  const { scene, worldMap, ...rest } = result
  const { cells, map, ...sceneRest } = scene
  return {
    hash: hash(result),
    scene: plain(sceneRest),
    cells: hash(cells),
    map: hash(map),
    worldMap: hash(worldMap),
    rest: plain({ ...rest, library_levels: rest.library_levels ? hash(rest.library_levels) : undefined }),
  }
}

/** Исход вызова: итог или исключение. */
function attempt(run, shape) {
  try {
    return { out: shape(run()) }
  } catch (error) {
    return { error: errorOf(error) }
  }
}

// --- библиотеки -------------------------------------------------------------------------

/** @type {Record<string, { entries: any[], levels: Record<string, any[]> }>} */
const libraries = {}
const libraryObjects = new Map()

function libraryFor(id) {
  if (!id) return null
  if (libraryObjects.has(id)) return libraryObjects.get(id)
  const storage = mkdtempSync(join(tmpdir(), 'sk-director-library-'))
  const library = new ml.MapLibrary(storage)
  for (const entry of libraries[id].entries) library.put(clone(entry), clone(libraries[id].levels[entry.id]))
  libraryObjects.set(id, { library, storage })
  return libraryObjects.get(id)
}

function withLibrary(id, run) {
  const found = libraryFor(id)
  ml.setActiveMapLibrary(found?.library ?? null)
  try {
    return run()
  } finally {
    ml.setActiveMapLibrary(null)
  }
}

// --- быстрый путь отладки --------------------------------------------------------------

const dumpAt = process.argv.indexOf('--dump')
if (dumpAt > 0) {
  const [section, label] = process.argv.slice(dumpAt + 1)
  const fixture = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString('utf8'))
  Object.assign(libraries, fixture.libraries)
  const found = fixture[section].find((entry) => entry.label === label)
  if (!found) throw new Error(`нет случая ${section}/${label}`)
  let result
  if (section === 'geometry') {
    result = withLibrary(found.library, () => (found.fn === 'cells' ? ad.generateSceneCells(found.input) : ad.generateSceneGeometry(found.input)))
    if (result.map) result = { ...result, map: t.serializeTacticalMap(result.map) }
  } else if (section === 'transitions') {
    result = withLibrary(found.library, () => ad.createSceneTransition(found.input, found.state))
  } else if (section === 'chains') {
    const step = Number(process.argv[dumpAt + 3] ?? 0)
    result = withLibrary(found.library, () => runChain(found.initial, found.steps.map((entry) => entry.input), step))
  } else throw new Error(`секция ${section}`)
  console.log(JSON.stringify(result))
  process.exit(0)
}

// --- перехват тестов JS -------------------------------------------------------------------

const TESTS = ['adventure-director', 'scene-transition-engine', 'director-three-scenes', 'scene-program-corpus', 'scene-entry-road']
const captureFile = join(mkdtempSync(join(tmpdir(), 'sk-director-capture-')), 'capture.jsonl')
execFileSync(process.execPath, [
  '--import', new URL('./capture.mjs', import.meta.url).href,
  '--test', '--test-isolation=none', '--test-reporter=dot',
  ...TESTS.map((name) => new URL(`test/${name}.test.mjs`, root).pathname.replace(/^\/([A-Za-z]:)/u, '$1')),
], { cwd: new URL('.', root), env: { ...process.env, SK_DIRECTOR_CAPTURE: captureFile }, stdio: ['ignore', 'ignore', 'inherit'] })
const captured = readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
console.log(`перехвачено вызовов: ${captured.length}`)

// --- урезание состояния -----------------------------------------------------------------

const SCENE_KEYS = ['title', 'location', 'location_id', 'locationId', 'objective', 'turn', 'cells', 'map']
const STATE_KEYS = ['sessionCode', 'campaign', 'campaignConcept', 'adventure', 'worldMap', 'locationMaps']
function trimState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  const out = {}
  for (const key of STATE_KEYS) if (key in state) out[key] = state[key]
  if ('scene' in state) {
    const scene = state.scene
    out.scene = scene && typeof scene === 'object' && !Array.isArray(scene)
      ? Object.fromEntries(SCENE_KEYS.filter((key) => key in scene).map((key) => [key, scene[key]]))
      : scene
  }
  if (state.social && typeof state.social === 'object' && Array.isArray(state.social.npcs)) out.social = { npcs: state.social.npcs }
  return plain(out)
}

/**
 * Глубже: из памяти мест остаётся запись места перехода, у прочих — только
 * сид библиотечной карты (его читает `libraryIdsInUse`); клетки и карта
 * прежней сцены — только если переход идёт в то же место.
 */
function trimDeep(state, locationId) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  const out = structuredClone(state)
  if (out.locationMaps && typeof out.locationMaps === 'object' && !Array.isArray(out.locationMaps)) {
    out.locationMaps = Object.fromEntries(Object.entries(out.locationMaps).flatMap(([key, record]) => {
      if (key === locationId) return [[key, record]]
      const seed = record?.map?.seed
      return typeof seed === 'string' && seed.startsWith(ml.LIBRARY_SEED_PREFIX) ? [[key, { map: { seed } }]] : []
    }))
  }
  if (out.scene && typeof out.scene === 'object' && !Array.isArray(out.scene) && ad.sceneLocationId(out) !== locationId) {
    delete out.scene.cells
    delete out.scene.map
  }
  return out
}

const transitions = []
const seenTransitions = new Set()
let trimmedFallbacks = 0
function addTransition(label, input, state, library = null) {
  const key = hash([input, state, library])
  if (seenTransitions.has(key)) return null
  seenTransitions.add(key)
  const run = (value) => withLibrary(library, () => attempt(() => ad.createSceneTransition(clone(input), clone(value)), transitionOut))
  const full = run(state)
  let kept = plain(state) ?? null
  for (const candidate of [trimState(state), full.out ? trimDeep(trimState(state), full.out.scene.location_id) : null]) {
    if (candidate !== null && JSON.stringify(run(candidate)) === JSON.stringify(full)) kept = plain(candidate) ?? null
  }
  if (kept !== null && typeof kept === 'object' && JSON.stringify(kept) === JSON.stringify(plain(state)) && state && typeof state === 'object' && Object.keys(state).some((field) => !STATE_KEYS.includes(field) && field !== 'scene' && field !== 'social')) trimmedFallbacks += 1
  const entry = { label, input: plain(input) ?? null, state: kept, ...(library ? { library } : {}), ...full }
  transitions.push(entry)
  return entry
}

const geometry = []
function addGeometry(label, fn, input, library = null) {
  const run = () => (fn === 'cells' ? ad.generateSceneCells(clone(input)) : ad.generateSceneGeometry(clone(input)))
  const shape = (value) => (fn === 'cells' ? { cells: hash(value), count: value.length } : geometryOut(value))
  geometry.push({ label, fn, input: plain(input) ?? null, ...(library ? { library } : {}), ...withLibrary(library, () => attempt(run, shape)) })
}

const memory = []
const MEMORY_FNS = {
  normalizeLocationMaps: (args) => ad.normalizeLocationMaps(...args),
  sceneMapForLocation: (args) => ad.sceneMapForLocation(...args),
  sceneTacticalMapForLocation: (args) => ad.sceneTacticalMapForLocation(...args),
  sceneLocationId: (args) => ad.sceneLocationId(...args),
  rememberSceneMap: (args) => ad.rememberSceneMap(...args),
  rememberCurrentSceneMap: (args) => ad.rememberCurrentSceneMap(...args),
  sceneLevelIndex: (args) => ad.sceneLevelIndex(...args),
  levelKey: (args) => ad.levelKey(...args),
  levelSeed: (args) => ad.levelSeed(...args),
  knownWorldKind: (args) => ad.knownWorldKind(...args),
  stableLocationMapSeed: (args) => ad.stableLocationMapSeed(...args),
  publicAdventureMemory: (args) => ad.publicAdventureMemory(...args),
  entrySideToward: (args) => ad.entrySideToward(...args),
  openingEntrySide: (args) => ad.openingEntrySide(...args),
  librarySceneFields: (args) => ad.librarySceneFields(...args),
}
const seenMemory = new Set()
function addMemory(fn, args, label = '') {
  const encoded = argsOf(args)
  const key = hash([fn, encoded])
  if (seenMemory.has(key)) return
  seenMemory.add(key)
  const call = argsFrom(encoded)
  memory.push({ fn, label, ...encoded, ...attempt(() => MEMORY_FNS[fn](call), (value) => (value === undefined ? null : plain(value))) })
}

for (const record of captured) {
  const label = `test/${record.test}`
  const args = argsFrom(record)
  if (record.fn === 'createSceneTransition') addTransition(label, args[0] ?? {}, args[1] ?? {})
  else if (record.fn === 'generateSceneGeometry') addGeometry(label, 'geometry', args[0] ?? {})
  else if (record.fn === 'generateSceneCells') addGeometry(label, 'cells', args[0] ?? {})
  else if (MEMORY_FNS[record.fn]) addMemory(record.fn, args, label)
}

// --- память мест и помощники ----------------------------------------------------------

const JUNK = [undefined, null, '', '  ', 'строка', 5, 0, 1.5, -3, true, false, [], {}, ['a'], { x: 1 }, 'constructor', '__proto__', 'toString', '7', 'a\u00a0 b\n']
const junk = () => pick(JUNK)
const LONG = 'Очень длинное название локации '.repeat(6)
const IDS = ['brod', 'olsh', 'east', 'hall', 'hall@L1', ' hall ', LONG, '0', '5', '01', 'constructor', '__proto__', '', 'a😀b']
const randomCell = () => {
  const cell = {}
  for (const [key, values, p] of [
    ['x', [0, 1, 2, 3, '2', 2.5, -1, null, 'x', 9e15], 0.97],
    ['y', [0, 1, 2, '1', 1.5, null, true], 0.97],
    ['type', ['floor', 'wall', 'water', 'door', 'lava', null, 5], 0.8],
    ['revealed', [true, false, 'true', 1], 0.6],
    ['feature', ['altar', '  chest  ', '', 'x'.repeat(50), 5, 'enemy', 'stairs_down'], 0.4],
    ['material', ['stone', 'wood', 'lava', null], 0.4],
    ['variant', [0, 3, 9, -2, '4', null, 1.5, true], 0.4],
    ['pattern', ['village', 'bridge', 'maze'], 0.3],
    ['edge_mask', ['nesw', 'ne', 'x', '', 'nnnnn', 5], 0.3],
    ['walls', ['e', 's', 'es', 'se', 'n', 1], 0.3],
    ['windows', ['e', 'es', 'x'], 0.2],
    ['door_dir', ['e', 's', 'n', null], 0.2],
    ['elevation', [0, 5, -5, 300, -300, '10', 2.5, null], 0.3],
    ['secret', ['CELL-SECRET'], 0.2],
  ]) if (chance(p)) cell[key] = pick(values)
  return cell
}
const randomCells = () => (chance(0.1) ? pick([null, 'клетки', 5, {}, { cells: 'x' }]) : Array.from({ length: int(6) }, () => (chance(0.08) ? pick([null, 5, 'x', []]) : randomCell())))
const randomRecord = () => {
  const roll = int(6)
  if (roll === 0) return junk()
  if (roll === 1) return randomCells()
  const record = { version: pick([1, 2, undefined]), cells: randomCells() }
  if (chance(0.6)) record.map = pick([{ seed: `library:tt-${int(3)}:0`, width: 3 }, { seed: 'x' }, null, 'карта', [1], {}])
  return record
}
const randomLocationMaps = () => {
  if (chance(0.15)) return junk()
  const maps = {}
  for (let index = 0; index < int(6); index += 1) maps[pick(IDS)] = randomRecord()
  return maps
}
const WORLD_NAMES = ['Старый Брод', 'Ольшанка', 'Восточный хутор', 'старый брод', ' Ольшанка ', 'Маяк']
const randomWorld = () => {
  if (chance(0.12)) return junk()
  const locations = Array.from({ length: int(5) }, (_, index) => {
    const location = {}
    if (chance(0.95)) location.id = chance(0.9) ? pick(['brod', 'olsh', 'east', 'hall', `loc-${index}`, ' brod ']) : junk()
    if (chance(0.9)) location.name = chance(0.9) ? pick(WORLD_NAMES) : junk()
    if (chance(0.8)) location.kind = pick(['village', 'town', 'wilds', 'ruin', 'dungeon', '', 5, null, 'x'.repeat(50)])
    if (chance(0.9)) location.x = pick([100, 500, 820, '300', 'x', null, 500.5, -40])
    if (chance(0.9)) location.y = pick([120, 420, 420, '200', undefined, null, 0])
    return location
  })
  const world = { locations }
  if (chance(0.7)) world.seed = pick(['entry-road', '', 5, null, 'мир'])
  if (chance(0.6)) world.currentLocationId = pick(['brod', 'olsh', '', 5, null])
  if (chance(0.6)) {
    world.routes = Array.from({ length: int(5) }, () => ({
      from: pick(['brod', 'olsh', 'east', 'hall', 5, undefined]),
      to: pick(['brod', 'olsh', 'east', 'hall', null]),
      kind: pick(['road', 'path', 'river', undefined]),
      distance: pick([1, 2, 6, '3', 'x', undefined, 0, 1e9]),
      discovered: pick([true, false, undefined, 0, null]),
    }))
  }
  return world
}
const randomState = () => {
  if (chance(0.05)) return pick([5, 'state', []])
  const state = {}
  if (chance(0.9)) {
    const scene = {}
    for (const [key, values, p] of [
      ['location_id', ['brod', '', null, 5, ' olsh ', LONG], 0.5],
      ['locationId', ['olsh', 'hall', null], 0.3],
      ['location', ['Старый Брод', 'ольшанка', 'Нигде', '', 5], 0.6],
      ['level', [{ index: 1 }, { index: '-2' }, { index: 1.5 }, { index: null }, 3, null, {}], 0.4],
      ['cells', [randomCells(), [], [{ x: 0, y: 0 }]], 0.7],
      ['map', [{ seed: 's', width: 3 }, null, 'карта', undefined], 0.5],
    ]) if (chance(p)) scene[key] = pick(values)
    state.scene = chance(0.95) ? scene : junk()
  }
  if (chance(0.6)) state.worldMap = randomWorld()
  if (chance(0.5)) state.locationMaps = randomLocationMaps()
  return state
}
const randomAdventure = () => {
  if (chance(0.1)) return junk()
  const value = {}
  for (const [key, make, p] of [
    ['chapter', () => pick([1, 2, '3', 0, 1000, 2.5, null, 'x']), 0.8],
    ['currentHook', () => pick(['нить', '  ', 5, 'x'.repeat(300), null]), 0.5],
    ['lastTransition', () => pick(['путь', '', 'я'.repeat(600)]), 0.4],
    ['unresolvedThreads', () => pick([['а', 'а', ' б ', 5, '', null], 'x', Array.from({ length: 25 }, (_, i) => `нить ${i}`)]), 0.5],
    ['visitedLocations', () => pick([['Брод', 'Брод', 7], Array.from({ length: 60 }, (_, i) => `место ${i}`), {}]), 0.5],
    ['visitedLocationIds', () => pick([['brod', 'brod'], null]), 0.4],
    ['history', () => Array.from({ length: pick([0, 2, 25]) }, (_, i) => (chance(0.1) ? junk() : {
      chapter: pick([i, '2', null, 1e4]), title: pick(['Сцена', '', 5]), location: pick(['Брод', undefined]),
      location_id: pick(['brod', null, undefined, 7]), locationId: pick(['olsh', undefined]), objective: pick(['цель', 5]),
      outcome: pick(['итог', 'я'.repeat(300)]), status: pick([...ad.OBJECTIVE_STATUSES, 'lost', 5, undefined]), gm_only: 'SECRET',
    })), 0.6],
    ['gm_only', () => 'SECRET', 0.3],
  ]) if (chance(p)) value[key] = make()
  return value
}

for (let index = 0; index < 150; index += 1) addMemory('normalizeLocationMaps', [randomLocationMaps()])
for (let index = 0; index < 150; index += 1) addMemory('sceneMapForLocation', [randomLocationMaps(), chance(0.8) ? pick(IDS) : junk()])
for (let index = 0; index < 150; index += 1) addMemory('sceneTacticalMapForLocation', [randomLocationMaps(), chance(0.8) ? pick(IDS) : junk()])
for (let index = 0; index < 200; index += 1) addMemory('sceneLocationId', [chance(0.95) ? randomState() : undefined])
for (let index = 0; index < 150; index += 1) {
  const state = randomState()
  if (!state || typeof state !== 'object' || Array.isArray(state)) continue
  const args = [state, chance(0.8) ? pick(IDS) : junk(), randomCells()]
  if (chance(0.6)) args.push(pick([undefined, null, { seed: 'm' }, 'карта', []]))
  addMemory('rememberSceneMap', args)
}
for (let index = 0; index < 150; index += 1) {
  const state = randomState()
  if (Array.isArray(state) || typeof state !== 'object') continue
  addMemory('rememberCurrentSceneMap', [state])
}
for (let index = 0; index < 80; index += 1) addMemory('sceneLevelIndex', [chance(0.9) ? randomState() : pick([null, undefined])])
for (let index = 0; index < 150; index += 1) {
  const args = [chance(0.7) ? pick(IDS) : junk()]
  if (chance(0.85)) args.push(pick([0, 1, -1, 3, -3, 12, '2', 1.5, null, 'x', true, 1e20, undefined]))
  addMemory('levelKey', args)
}
for (let index = 0; index < 100; index += 1) {
  const args = [chance(0.7) ? pick(['location-map:v1:a:b', '', '  ', LONG.repeat(2), 'seed']) : junk()]
  if (chance(0.85)) args.push(pick([0, 1, -2, '3', 2.5, null, undefined]))
  addMemory('levelSeed', args)
}
for (let index = 0; index < 150; index += 1) addMemory('knownWorldKind', [randomWorld(), chance(0.8) ? pick(IDS) : junk(), chance(0.8) ? pick(WORLD_NAMES) : junk()])
for (let index = 0; index < 100; index += 1) addMemory('stableLocationMapSeed', [chance(0.7) ? randomWorld() : junk(), chance(0.7) ? pick(IDS) : junk(), chance(0.7) ? pick(WORLD_NAMES) : junk()])
for (let index = 0; index < 150; index += 1) addMemory('publicAdventureMemory', chance(0.95) ? [randomAdventure()] : [])
for (let index = 0; index < 200; index += 1) addMemory('entrySideToward', [randomWorld(), chance(0.8) ? pick(IDS) : junk(), chance(0.8) ? pick(IDS) : junk()])
for (let index = 0; index < 150; index += 1) {
  const world = randomWorld()
  if (world && typeof world === 'object' && Array.isArray(world.routes) && world.routes.some((route) => route === null)) continue
  addMemory('openingEntrySide', [world, chance(0.85) ? pick(['brod', 'olsh', 'east', 'hall']) : junk()])
}
for (let index = 0; index < 60; index += 1) {
  const entry = { id: pick(['tt-house', 'gen-tavern', 5]), title: pick(['Таверна', '', 'T'.repeat(200), undefined]) }
  if (chance(0.8)) entry.source = { author: pick(['Автор', undefined, 5]), url: pick(['https://x', 'u'.repeat(400)]), license: 'CC', license_url: pick(['https://cc', undefined]), site: pick(['TalesTavern', null]) }
  if (chance(0.7)) entry.passport = pick([{ summary: 'Двухэтажное строение.' }, { summary: 'я'.repeat(500) }, {}, null])
  const levels = Array.from({ length: int(3) }, () => ({ index: pick([1, -1, 2]), label: pick(['Второй этаж', 'Подвал', '']), map: {} }))
  addMemory('librarySceneFields', [{ entry, levels }])
}

// --- геометрия --------------------------------------------------------------------------

const corpusScenes = JSON.parse(readFileSync(new URL('test/fixtures/scene-programs/corpus.json', root), 'utf8')).scenes
for (const scene of corpusScenes) {
  const program = sceneMapRequirementsFor([scene.location, scene.text], { npcs: scene.npcs })
  for (const suffix of ['', ':s1', ':s2', ':s3', ':s4']) {
    addGeometry(`corpus/${scene.id}${suffix}`, 'geometry', {
      location: scene.location, theme: scene.theme, settlementType: scene.settlementType ?? '',
      seed: `corpus:${scene.id}${suffix}`, useLibrary: false, requirements: program.items, program,
    })
  }
}
for (const preset of MAP_PREVIEW_PRESETS) {
  addGeometry(`preset/${preset.id}`, 'geometry', { ...preset.input, seed: `preset:${preset.id}`, useLibrary: false })
  addGeometry(`preset/${preset.id}/cells`, 'cells', { ...preset.input, seed: `preset:${preset.id}`, useLibrary: false })
}

const PLACES = [
  ['Таверна «Сломанное колесо»', 'уютная таверна'], ['Храм Утренней Звезды', 'храм'], ['Склеп Норвин', 'склеп'], ['Пещера у водопада', 'пещера'],
  ['Тёмный лес', 'лес'], ['Северный тракт', 'дорога'], ['Деревня Заречье', 'деревня'], ['Безымянная низина', 'новая местность'], ['Озеро Тихое', 'берег озера'],
  ['Переправа у мельницы', 'река'], ['Заброшенный маяк', 'маяк'], ['Маяк на скале', 'маяк'], ['Кузница Борна', 'кузница'], ['Рыночная площадь', 'город'],
  ['Подземелье замка', 'подземелье'], ['Кладбище у часовни', 'кладбище'], ['Лагерь разбойников', 'лагерь в лесу'], ['Усадьба Вельских', 'усадьба'],
  ['Портовый квартал', 'гавань у пристани'], ['Руины заставы', 'руины'], ['Стоянка у дороги', ''], ['', ''],
]
const DESCRIPTIONS = ['', 'Отряд стоит снаружи, у входа.', 'Герои уже внутри, за столом у очага.', 'В центре деревни — общий навес, под ним собираются жители.',
  'Путники входят в зал.', 'У колодца староста ждёт гостей; на площади статуя.', 'Тропа выводит отряд к двери маяка.', 'Вы у двери таверны.']
const REQUESTS = [
  {}, { layout: 'rooms', scale: 'room', pattern: 'small-room', material: 'wood', width: 9, height: 7, openness: 0.82, water: 0, featureCount: 9 },
  { layout: 'open', pattern: 'natural', material: 'earth', width: 15, height: 11 }, { layout: 'streets', pattern: 'village', width: 30, height: 24 },
  { layout: 'cavern', pattern: 'cave-cluster', width: 20, height: 18 }, { layout: 'winding', pattern: 'bridge', material: 'earth', width: 20, height: 16 },
  { water: 0.4 }, { water: '0.5', width: '22' }, { theme_id: 'crypt' }, { themeId: 'forest', width: 70, height: 5 }, { theme_id: 'authored-ares-fortress' },
  { design: { topology: 'river' } }, { design: { topology: 'harbor', climate: 'cold', building_use: 'tavern' } }, { design: { landmarks: [{ id: 'well' }] } },
  { width: 2.5, height: null }, { width: 'x', height: -40 }, { layout: 'rooms', pattern: 'temple' }, { pattern: 'crypt', layout: 'cavern', material: 'stone' },
]
const LEVELS = [[], [{ offset: 1 }], [{ offset: -1, hint: 'подвал' }, { offset: 1 }], [{ offset: 0 }, { offset: 9 }, { offset: 'x' }], null, 'x']
const REQUIREMENTS = [[], [{ id: 'well', count: 1 }], [{ id: 'shelter', count: 1 }, { id: 'platform', count: 2 }], [{ id: 'dragon', count: 1 }], 'x', null]
const PROGRAMS = [
  null, { items: [{ id: 'well', count: 1 }], focus: 'well' }, { items: [{ id: 'table', count: 2 }], focus: 'table', posts: [{ npc: 'Тарн', id: 'table' }] },
  { items: [{ id: 'shelter', count: 1 }, { id: 'threshold_stone', count: 2 }], focus: 'shelter' }, { items: [] }, [], 'программа', { items: [{ id: 'statue', count: 1 }], clues: ['statue'] },
]
for (let index = 0; index < 160; index += 1) {
  const [location, theme] = pick(PLACES)
  const input = { location, theme, seed: `random:${index}`, useLibrary: false }
  if (chance(0.6)) input.map = clone(pick(REQUESTS))
  if (chance(0.3)) input.sceneKind = pick(['settlement', 'wilderness', 'dungeon', 'road', 'other', 'interior'])
  if (chance(0.3)) input.settlementType = pick(['village', 'town', 'city', ''])
  if (chance(0.3)) input.worldKind = pick(['village', 'wilds', 'dungeon', 'ruin', 'fortress', 'landmark', 'port'])
  if (chance(0.3)) input.levels = clone(pick(LEVELS))
  if (chance(0.4)) input.description = pick(DESCRIPTIONS)
  if (chance(0.2)) input.worldDescription = pick(['Киберпанк-мегаполис будущего', 'Северное королевство', ''])
  if (chance(0.2)) input.biome = pick(['лес', 'пустыня', 'тундра'])
  if (chance(0.35)) input.requirements = clone(pick(REQUIREMENTS))
  if (chance(0.35)) input.program = clone(pick(PROGRAMS))
  if (chance(0.35)) input.entrySide = pick(['north', 'south', 'east', 'west', 'up', '', 5])
  if (chance(0.15)) input.danger = pick(['низкая', 'высокая', null])
  addGeometry(`random/${index}`, chance(0.2) ? 'cells' : 'geometry', input)
}
// Граница водоёма: доля воды 0.35 — уже водоём, 0.34 — ещё нет.
for (const water of [0.34, 0.35, '0.35', 0.36]) addGeometry(`random/water-${water}`, 'geometry', { location: 'Безымянная низина', theme: 'новая местность', seed: 'water-edge', useLibrary: false, map: { layout: 'open', pattern: 'natural', water } })
for (const [index, input] of [null, 5, 'x', [], {}, { map: null }, { map: [1] }, { seed: null, location: null, theme: null }].entries()) {
  addGeometry(`junk/explicit-${index}`, index % 2 ? 'cells' : 'geometry', input)
}
for (const [index, input] of [null, 'x', { map: null, seed: null }].entries()) addGeometry(`junk/cells-${index}`, 'cells', input)
// Программа, которую тема не держит: обязательное уходит в `missing`.
for (const [location, theme] of PLACES.slice(0, 12)) {
  for (const program of [{ items: [{ id: 'well', count: 3 }, { id: 'statue', count: 2 }], focus: 'well' }, { items: [{ id: 'shelter', count: 2 }, { id: 'platform', count: 3 }], focus: 'shelter' }, { items: [{ id: 'anvil', count: 2 }, { id: 'boat', count: 1 }], focus: 'boat' }]) {
    addGeometry(`missing/${location}/${program.focus}`, 'geometry', { location, theme, seed: `missing:${location}:${program.focus}`, useLibrary: false, requirements: program.items, program })
  }
}
// Мусор: рыхлые значения на месте полей.
for (let index = 0; index < 40; index += 1) {
  const input = {}
  for (const key of ['theme', 'location', 'sceneKind', 'settlementType', 'worldKind', 'seed', 'locationId', 'map', 'levels', 'description', 'worldDescription', 'biome', 'requirements', 'program', 'entrySide', 'danger']) {
    if (chance(0.3)) input[key] = junk()
  }
  input.useLibrary = false
  addGeometry(`junk/${index}`, chance(0.3) ? 'cells' : 'geometry', chance(0.1) ? pick([null, 5, 'x', []]) : input)
}

// --- пол храма ------------------------------------------------------------------------

function templeMap({ seed = 'library:tt-stave-temple:0', benches = 5, touch = false, duplicate = false, asset = 'bench' } = {}) {
  const map = t.createTacticalMap({ width: 14, height: 12, locationId: 'temple', seed, theme: 'temple' })
  t.addZone(map, { id: 'ground', kind: 'exterior', material: 'grass', label: 'Двор' })
  t.addZone(map, { id: 'nave', kind: 'exterior', material: 'grass', label: 'Двор' })
  t.addZone(map, { id: 'hall', kind: 'interior', material: 'wood', label: 'Притвор' })
  if (duplicate) t.addZone(map, { id: 'nave', kind: 'exterior', material: 'earth', label: 'Повтор' })
  for (let y = 0; y < 12; y += 1) for (let x = 0; x < 14; x += 1) {
    const inNave = x >= (touch ? 0 : 3) && x <= 10 && y >= 3 && y <= 8
    const inHall = x >= 11 && x <= 12 && y >= 1 && y <= 2
    t.setCell(map, x, y, { passable: true, revealed: true, material: 'grass', zone: inNave ? 'nave' : inHall ? 'hall' : 'ground' })
  }
  for (let index = 0; index < benches; index += 1) {
    t.addProp(map, { id: `bench-${index}`, assetId: index % 2 && asset === 'mixed' ? 'prayer_bench' : asset === 'mixed' ? 'bench' : asset, x: 4.5 + index, y: 4.5, footprint: [{ x: 4 + index, y: 4 }, { x: 4 + index, y: 5 }], blocksMove: true })
  }
  t.addSpawnPoint(map, { id: 'party', x: 1, y: 6, role: 'party' })
  map.overlays.roomLabels.push({ zoneId: 'nave', label: 'Двор' }, { zoneId: 'ground', label: 'Двор' })
  return map
}
const floors = []
for (const [label, options, theme] of [
  ['nave', {}, 'temple'], ['nave/word', {}, '  Храм у моря '], ['nave/crypt-theme', {}, 'склеп'], ['nave/empty-theme', {}, ''], ['few-benches', { benches: 3 }, 'temple'], ['four-benches', { benches: 4 }, 'temple'],
  ['touches-border', { touch: true }, 'temple'], ['duplicate-zone', { duplicate: true }, 'temple'], ['prayer', { asset: 'prayer_bench' }, 'temple'], ['mixed', { asset: 'mixed', benches: 6 }, 'монастырь'],
  ['other-seed', { seed: 'library:tt-house:0' }, 'temple'], ['tables', { asset: 'table' }, 'temple'], ['святилище', {}, 'Святилище'],
]) {
  const map = templeMap(options)
  const serialized = plain(t.serializeTacticalMap(map))
  const live = t.deserializeTacticalMap(clone(serialized))
  floors.push({ label, theme, map: serialized, ...attempt(() => {
    const count = ad.refreshSceneFloors(live, theme)
    return { count, map: hash(t.serializeTacticalMap(live)) }
  }, (value) => value) })
}

// --- библиотеки -----------------------------------------------------------------------

function entryFor(id, overrides = {}) {
  return {
    id,
    title: `Карта ${id}`,
    source: { site: 'TalesTavern', url: `https://talestavern.com/slab/${id}/`, author: 'Автор', license: 'Attribution-NonCommercial', license_url: 'https://creativecommons.org/licenses/by-nc/4.0/', downloads: 10 },
    place_kinds: ['tavern'], climate: '', terrains: [], types: ['inn'],
    passport: { features: ['common_room', 'bedrooms', 'interior', 'upstairs'], interior_share: 0.8, floor_cells: 500, material: 'wood', summary: 'Двухэтажное строение.' },
    levels: [{ index: 0, label: 'Первый этаж' }], slab_sha256: 'x', added_at: '2026-10-02T00:00:00.000Z',
    ...overrides,
  }
}
const house = importTaleSpireSlab(HOUSE_SLAB, { locationId: 'tt-house' })
const generatedLevels = (input) => [{ index: 0, label: 'Этаж', map: plain(t.serializeTacticalMap(ad.generateSceneGeometry({ ...input, useLibrary: false }).map)) }]
libraries.main = {
  entries: [
    entryFor('tt-house', { passport: { ...plain(house.passport), anchors: { table: 2, bed: 2 } } }),
    entryFor('gen-tavern', { passport: { features: ['common_room', 'interior'], interior_share: 0.7, floor_cells: 400, material: 'wood', summary: 'Трактир в один этаж.', anchors: { table: 4 } } }),
    entryFor('gen-village', { place_kinds: ['village'], types: ['village'], passport: { features: ['exterior', 'street'], interior_share: 0.2, floor_cells: 600, material: 'earth', summary: 'Деревня у дороги.', anchors: { well: 1 } } }),
    entryFor('tt-stave-temple', { place_kinds: ['temple'], types: ['church'], passport: { features: ['shrine', 'exterior'], interior_share: 0.3, floor_cells: 160, material: 'wood', summary: 'Деревянный храм с нефом.' } }),
    entryFor('gen-temple', { place_kinds: ['temple'], types: ['church'], passport: { features: ['shrine', 'interior'], interior_share: 0.8, floor_cells: 400, material: 'stone', summary: 'Каменный храм.' } }),
  ],
  levels: {
    'tt-house': plain(house.levels),
    'gen-tavern': generatedLevels({ location: 'Таверна', seed: 'lib:tavern' }),
    'gen-village': generatedLevels({ location: 'Деревня', seed: 'lib:village' }),
    'tt-stave-temple': [{ index: 0, label: 'Неф', map: plain(t.serializeTacticalMap(templeMap())) }],
    'gen-temple': generatedLevels({ location: 'Храм', seed: 'lib:temple' }),
  },
}
libraries.broken = {
  entries: [entryFor('tt-broken')],
  levels: { 'tt-broken': [{ index: 0, label: 'Этаж', map: { ...plain(house.levels[0].map), spawnPoints: [] } }] },
}
libraries.house = { entries: [libraries.main.entries[0]], levels: { 'tt-house': libraries.main.levels['tt-house'] } }
const LIBRARY_PLACES = [['Таверна «Рог»', 'таверна'], ['Трактир у моста', 'трактир'], ['Храм Утренней Звезды', 'храм'], ['Деревня Кленовка', 'деревня'], ['Дом мельника', 'жилой дом'], ['Святилище', 'храм']]
for (let index = 0; index < 40; index += 1) {
  const [location, theme] = pick(LIBRARY_PLACES)
  const input = { location, theme, seed: `library:${index}` }
  if (chance(0.3)) input.levels = clone(pick(LEVELS))
  if (chance(0.3)) input.program = clone(pick(PROGRAMS))
  if (chance(0.2)) input.requirements = clone(pick(REQUIREMENTS))
  if (chance(0.15)) input.useLibrary = false
  if (chance(0.15)) input.map = { theme_id: 'building' }
  if (chance(0.15)) input.settlementType = 'village'
  addGeometry(`library/${index}`, chance(0.2) ? 'cells' : 'geometry', input, pick(['main', 'main', 'house', 'house', 'broken']))
}
for (const [index, extra] of [{}, { levels: [{ offset: 1 }] }, { levels: [{ offset: -1 }] }, { map: { width: 40, height: 30 } }, { program: { items: [{ id: 'table', count: 1 }], focus: 'table' } }].entries()) {
  for (const [location, theme] of LIBRARY_PLACES.slice(0, 2)) addGeometry(`library/house-${index}/${location}`, 'geometry', { location, theme, seed: `house:${index}`, ...extra }, 'house')
}
console.log(`  с missing: ${geometry.filter((entry) => entry.out?.missing).length}`)
console.log(`  библиотека выбрана: ${geometry.filter((entry) => entry.out?.library).map((entry) => entry.out.library.entry).join(', ')}`)

// --- переходы корпуса ------------------------------------------------------------------

let corpusCases = 0
let corpusMatches = 0
if (existsSync(CORPUS_DIR)) {
  for (const file of readdirSync(CORPUS_DIR).filter((name) => name.startsWith('corpus-')).sort()) {
    for (const line of readFileSync(join(CORPUS_DIR, file), 'utf8').split('\n')) {
      if (!line.includes('"command_type":"AdvanceScene"')) continue
      const entry = JSON.parse(line)
      if (entry.command?.command_type !== 'AdvanceScene') continue
      const statePath = join(CORPUS_DIR, 'states', `${entry.state}.json`)
      if (!existsSync(statePath)) continue
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      const added = addTransition(`corpus/${file}/${entry.command.command_id}`, entry.command.scene_args ?? {}, state)
      if (!added) continue
      corpusCases += 1
      const event = entry.outcome?.events?.find((item) => item.event_type === 'SceneAdvanced')
      if (event && added.out && hash(event.payload.scene.map) === added.out.map && hash(event.payload.worldMap) === added.out.worldMap) corpusMatches += 1
    }
  }
}
console.log(`  переходов корпуса: ${corpusCases}, совпали с записанным SceneAdvanced: ${corpusMatches}`)

// Мусор на входе перехода.
for (let index = 0; index < 60; index += 1) {
  const input = {}
  for (const key of ['title', 'location', 'location_id', 'locationId', 'mood', 'objective', 'transition', 'arrival', 'hook', 'theme', 'danger', 'completed_objective', 'outcome',
    'objective_status', 'carry_unresolved', 'map', 'levels', 'scene_kind', 'settlement_type']) if (chance(0.25)) input[key] = junk()
  const state = randomState()
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    if (chance(0.5)) state.adventure = randomAdventure()
    if (chance(0.3)) state.sessionCode = junk()
    if (chance(0.2)) state.campaignConcept = pick([{ worldSummary: 'Мир', premise: 5 }, null, 'концепт'])
    if (chance(0.2)) state.social = { npcs: [{ name: 'Илва', role: 'староста', location: pick(['', 'Брод']) }, null, 5] }
    if (state.worldMap && typeof state.worldMap === 'object' && Array.isArray(state.worldMap.locations)) {
      state.worldMap.locations = state.worldMap.locations.filter((location) => typeof location.name !== 'number' && (location.name === undefined || typeof location.name === 'string' || !location.name))
    }
  }
  addTransition(`junk/${index}`, chance(0.05) ? pick([null, 5]) : input, chance(0.05) ? null : state)
}
// Имя места называет постройку, а карта — лес у воды: обещание уходит в `missing`.
for (const input of [
  { location: 'Маяк', theme: 'берег озера', map: { layout: 'open', water: 0.5 }, scene_kind: 'wilderness' },
  { location: 'Башня у переправы', theme: 'переправа', scene_kind: 'wilderness', arrival: 'Башня на скале темнеет над водой.' },
  { location: 'Маяк у залива', theme: 'залив', scene_kind: 'wilderness', transition: 'Отряд идёт к маяку и входит в дверь.' },
  { location: 'Таверна у озера', theme: 'берег озера', map: { layout: 'open', water: 0.5 } },
]) addTransition(`missing/${input.location}`, { title: input.location, objective: 'Осмотреться', ...input }, { scene: { title: 'Дорога' } })
addTransition('turn/negative', { title: 'Тракт' }, { scene: { title: 'Склеп', turn: -5 } })
addTransition('turn/fraction', { title: 'Тракт' }, { scene: { title: 'Склеп', turn: '2.5' } })
// Описание сцены режется до 2000 единиц: «отряд у входа» ровно на границе
// решает, начнётся ли таверна снаружи.
{
  const title = 'Таверна «Кабан»'
  const mood = 'Неизведанное место, полное новых возможностей'
  const prefix = ` ${title} ${mood} `.length
  const cue = 'отряд у входа'
  const arrival = `${'я'.repeat(2000 - prefix - cue.length - 1)}.${cue}`
  addTransition('description/long', { title, location: title, theme: 'таверна', arrival }, { scene: { title: 'Склеп' }, campaignConcept: { worldSummary: 'м'.repeat(2390) + ' край', premise: 'Печать пропала.' } })
}
addTransition('test/huge-fields', { title: 'я'.repeat(1000), location: 'я'.repeat(1000), objective: 'я'.repeat(1000), transition: 'я'.repeat(1000), arrival: 'я'.repeat(1000) }, { scene: {} })
addTransition('objective/null', { title: 'Тракт' }, { scene: { objective: null, title: 'Склеп' } })
addTransition('objective/number', { title: 'Тракт' }, { scene: { objective: 7 } })
addTransition('objective/array', { title: 'Тракт', carry_unresolved: true }, { scene: { objective: ['найти', 'печать'] } })
addTransition('same-place/empty-cells', { title: 'Брод', location_id: 'brod' }, { worldMap: { seed: 'w', currentLocationId: 'brod', locations: [{ id: 'brod', name: 'Брод', kind: 'village', x: 1, y: 1 }] }, scene: { location_id: 'brod', cells: [] } })
addTransition('same-place/string-map', { title: 'Брод', location_id: 'brod', map: { width: 12 } }, { worldMap: { seed: 'w', currentLocationId: 'brod', locations: [{ id: 'brod', name: 'Брод', kind: 'village', x: 1, y: 1 }] }, scene: { location_id: 'brod', cells: [{ x: 0, y: 0 }], map: 'карта' } })
addTransition('same-place/stored-height', { title: 'Брод', location_id: 'brod', map: { width: 12 } }, { worldMap: { seed: 'w', currentLocationId: 'brod', locations: [{ id: 'brod', name: 'Брод', kind: 'village', x: 1, y: 1 }] }, scene: { location_id: 'brod', cells: [{ x: 0, y: 0 }], map: { height: '9', spawnPoints: [{ role: 'party', x: '2' }] } } })
for (let index = 0; index < 20; index += 1) {
  const [location, theme] = pick(LIBRARY_PLACES)
  addTransition(`library/${index}`, { title: location, location, theme, objective: 'Осмотреться', arrival: pick(DESCRIPTIONS), ...(chance(0.3) ? { levels: [{ offset: 1 }] } : {}) },
    { sessionCode: `LIB-${index}`, scene: { title: 'Дорога', location: 'Дорога', turn: index }, adventure: { chapter: 1, visitedLocations: ['Дорога'], history: [] } }, index % 2 ? 'main' : 'house')
}

// --- цепочки переходов --------------------------------------------------------------------

function runChain(initial, inputs, stopAt = Infinity) {
  let state = clone(initial)
  const outs = []
  for (const [index, input] of inputs.entries()) {
    const result = ad.createSceneTransition(clone(input), state)
    if (index === stopAt) return result
    outs.push(result)
    state = { ...state, scene: result.scene, worldMap: result.worldMap, adventure: result.adventure }
    ad.rememberCurrentSceneMap(state)
  }
  return outs
}

const chains = []
const CHAIN_WORLD = {
  seed: 'chain-world', name: 'Край', width: 1000, height: 640, currentLocationId: 'brod',
  regions: [{ id: 'r', name: 'Долина', x: 500, y: 320, radius: 300, biome: 'лес' }],
  locations: [
    { id: 'brod', name: 'Старый Брод', kind: 'village', x: 500, y: 120, regionId: 'r', summary: 'Деревня у брода.', known: true, visited: true },
    { id: 'olsh', name: 'Ольшанка', kind: 'village', x: 500, y: 420, regionId: 'r', summary: '', known: true },
    { id: 'east', name: 'Восточный хутор', kind: 'village', x: 820, y: 420, regionId: 'r', summary: 'Хутор на холме.', known: true },
    { id: 'tower', name: 'Заброшенный маяк', kind: 'landmark', x: 200, y: 300, regionId: 'r', summary: '', known: true },
    { id: 'woods', name: 'Тёмный лес', kind: 'wilds', x: 700, y: 200, regionId: 'r', summary: 'Старый лес.', known: true },
    { id: 'crypt', name: 'Склеп Норвин', kind: 'ruin', x: 300, y: 500, regionId: 'r', summary: '', known: false },
  ],
  routes: [
    { id: 'r1', from: 'brod', to: 'olsh', kind: 'road', distance: 2, danger: 'низкая', discovered: true },
    { id: 'r2', from: 'olsh', to: 'east', kind: 'path', distance: 3, danger: 'низкая', discovered: true },
    { id: 'r3', from: 'brod', to: 'tower', kind: 'road', distance: 4, danger: 'средняя', discovered: true },
  ],
}
const CHAIN_TARGETS = [
  ['olsh', 'Ольшанка', 'деревня'], ['east', 'Восточный хутор', 'хутор'], ['tower', 'Заброшенный маяк', 'маяк'], ['woods', 'Тёмный лес', 'лес'], ['crypt', 'Склеп Норвин', 'склеп'],
  ['brod', 'Старый Брод', 'деревня'], [null, 'Таверна «Кабан»', 'таверна'], [null, 'Пещера у водопада', 'пещера'], [null, 'Озеро Тихое', 'берег озера'], [null, 'Храм Утренней Звезды', 'храм'],
  [null, 'Северный тракт', 'дорога'], [null, 'Кузница Борна', 'кузница'],
]
const ARRIVALS = [...DESCRIPTIONS, 'Отряд добирается до маяка на скале.', 'Дорога выводит отряд к деревне.', 'Мост через реку скрипит под ногами.', 'Башня на скале темнеет над дорогой.']
function chainInput(target) {
  const [id, location, theme] = target
  const input = { title: chance(0.8) ? location : '', location, theme, objective: pick(['Найти старосту', 'Осмотреться', 'Вернуть печать', '']), arrival: pick(ARRIVALS) }
  if (id && chance(0.85)) input.location_id = id
  if (chance(0.7)) input.objective_status = pick(ad.OBJECTIVE_STATUSES)
  if (chance(0.3)) input.carry_unresolved = true
  if (chance(0.4)) input.transition = pick(['Отряд идёт по дороге к мосту.', 'Путь лежит через лес.', ''])
  if (chance(0.3)) input.hook = 'Знак на воротах повторяет печать.'
  if (chance(0.3)) input.danger = pick(['низкая', 'высокая'])
  if (chance(0.25)) input.scene_kind = pick(['settlement', 'wilderness', 'dungeon'])
  if (chance(0.2)) input.settlement_type = pick(['village', 'town'])
  if (chance(0.35)) input.map = clone(pick(REQUESTS))
  if (chance(0.2)) input.levels = clone(pick(LEVELS))
  if (chance(0.2)) input.outcome = 'Дело сделано.'
  return input
}
for (let index = 0; index < 45; index += 1) {
  const initial = {
    sessionCode: `CHAIN-${index}`,
    campaign: chance(0.5) ? 'Сказание' : undefined,
    ...(chance(0.3) ? { campaignConcept: { worldSummary: pick(['Северное королевство', 'Пустынные земли']), premise: 'Печать пропала.' } } : {}),
    ...(chance(0.75) ? { worldMap: clone(CHAIN_WORLD) } : {}),
    scene: { title: 'Старый Брод', location: 'Старый Брод', ...(chance(0.8) ? { location_id: 'brod' } : {}), objective: 'Идти по следу', turn: int(5) },
    adventure: { chapter: 1, history: [], visitedLocations: ['Старый Брод'] },
    ...(chance(0.3) ? { social: { npcs: [{ name: 'Илва', role: 'староста', location: 'Ольшанка' }, { name: 'Борн', role: 'кузнец', location: 'Кузница Борна', public_summary: 'Куёт у наковальни.' }] } } : {}),
  }
  const inputs = []
  const visited = []
  for (let step = 0; step < 4 + int(4); step += 1) {
    const target = visited.length && chance(0.35) ? pick(visited) : pick(CHAIN_TARGETS)
    visited.push(target)
    inputs.push(chainInput(target))
  }
  const library = chance(0.25) ? pick(['main', 'house']) : null
  const outs = withLibrary(library, () => attempt(() => runChain(initial, inputs), (results) => results.map(transitionOut)))
  const steps = inputs.map((input, step) => ({ input: plain(input), ...(outs.out ? { out: outs.out[step] } : {}) }))
  chains.push({ label: `chain/${index}`, initial: plain(initial), steps, ...(library ? { library } : {}), ...(outs.error ? { error: outs.error } : {}) })
}

for (const { storage } of libraryObjects.values()) rmSync(storage, { recursive: true, force: true })
console.log(`  урезанное состояние дало другой исход (взято полное): ${trimmedFallbacks}`)
console.log(`  переходов с library_levels: ${transitions.filter((entry) => entry.out?.rest?.library_levels).length}, с map_requirements.missing: ${transitions.filter((entry) => entry.out?.scene?.map_requirements?.missing).length}, с ошибкой: ${transitions.filter((entry) => entry.error).length}`)
console.log(`  шагов цепочек с library_levels: ${chains.flatMap((chain) => chain.steps).filter((step) => step.out?.rest?.library_levels).length}, с возвратом на знакомую карту: ${chains.flatMap((chain) => chain.steps).filter((step) => step.out && step.out.scene.map_requirements === undefined).length}`)
for (const [name, section] of Object.entries({ libraries, memory, geometry, floors, transitions, chains })) console.log(`  ${name}: ${(JSON.stringify(section).length / 1e6).toFixed(1)} МБ`)
writeFixture(FIXTURE, { libraries, memory, geometry, floors, transitions, chains }, { gzip: true })

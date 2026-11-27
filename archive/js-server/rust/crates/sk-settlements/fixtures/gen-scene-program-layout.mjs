import '../../../fixtures-env.mjs'
// Эталон `server/scene-program-layout.mjs` → `fixtures/scene-program-layout.json`
// и `fixtures/scene-program-layout-corpus.json.gz`.
//
// - `scene-program-layout.json`: синтетические поля, деревни с площадью,
//   домами, дверями, окнами, склонами и водой, карты переносимых тестов
//   `test/scene-program-layout.test.mjs`; случаи `placeSceneFocus`,
//   `buildPlatforms`, `placeThresholdStones`, `applyScenePlan` (сотни
//   случайных программ) и `programFocusOutdoors`; хеш карты после
//   (SHA-256 `JSON.stringify(serializeTacticalMap(map))`), ответ, отказ и для
//   `applyScenePlan` — аудит `programReport` с умолчаниями и с меркой поселения;
// - `scene-program-layout-corpus.json.gz`: вызовы `applyScenePlan` и
//   `programFocusOutdoors`, сделанные настоящим конвейером сцены
//   (`generateSceneGeometry`) на корпусе `test/fixtures/scene-programs` и
//   случайных программах, — карта до вызова, программа, сид и тот же итог.
//   Сжат gzip: карты на входе крупные и сжимаются в десяток раз.
//
// Запуск: node rust/crates/sk-settlements/fixtures/gen-scene-program-layout.mjs
import { captured } from './scene-program-layout-capture.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { hash, mulberry32 } from './common.mjs'

const t = await import('../../../../server/tactical-map.mjs')
const spl = await import('../../../../server/scene-program-layout.mjs?real')
const mq = await import('../../../../server/map-quality.mjs')
const sr = await import('../../../../server/scene-requirements.mjs')
const { listAssets } = await import('../../../../server/asset-registry.mjs')
const { generateSceneGeometry } = await import('../../../../server/adventure-director.mjs')

const random = mulberry32(0x5c_e9e_1a7)
const int = (min, max) => min + Math.floor(random() * (max - min + 1))
const pick = (items) => items[Math.floor(random() * items.length)]
const chance = (p) => random() < p

const KINDS = sr.SCENE_REQUIREMENT_KINDS.map((kind) => kind.id)
const ASSETS = listAssets().filter((asset) => asset.kind === 'prop' || asset.kind === 'decal').map((asset) => asset.id)
const SETTLEMENT = { minSize: mq.SETTLEMENT_MIN_SIZE, openScene: true }

const restore = (serialized) => t.deserializeTacticalMap(JSON.parse(JSON.stringify(serialized)))
const mapHash = (map) => hash(t.serializeTacticalMap(map))
const errorOf = (error) => ({ name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) })

/** Прогон над картой: хеш после, ответ или отказ, и для программы — аудит. */
function runOn(map, fn, program) {
  const record = {}
  try {
    const result = fn(map)
    record.result = result === map ? '$map' : result ?? null
  } catch (error) {
    record.error = errorOf(error)
  }
  record.hash = mapHash(map)
  record.props = map.props.length
  if (program !== undefined) {
    record.report = mq.programReport(map, program)
    record.settlementReport = mq.programReport(map, program, SETTLEMENT)
  }
  return record
}

// --- карты ---------------------------------------------------------------------------

/** Поле теста: двор 12×10, вход отряда слева. */
function field({ width = 12, height = 10 } = {}) {
  const map = t.createTacticalMap({ width, height, locationId: 'field', seed: 'field' })
  t.addZone(map, { id: 'yard', kind: 'exterior', material: 'grass', lightLevel: 'bright', label: 'Двор' })
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) t.setCell(map, x, y, { passable: true, revealed: true, material: 'grass', zone: 'yard' })
  t.addSpawnPoint(map, { id: 'party', x: 1, y: Math.min(5, height - 1), role: 'party' })
  return map
}

/** Тупик теста: колодец в конце прохода в две клетки. */
function nook() {
  const map = field()
  for (let y = 0; y < 10; y += 1) for (let x = 8; x < 12; x += 1) if (!(y === 5 && x <= 10)) t.setCell(map, x, y, { passable: false })
  t.addProp(map, { id: 'prop-1-well', assetId: 'well', x: 10.5, y: 5.5, footprint: [{ x: 10, y: 5 }], blocksMove: true })
  return map
}

/**
 * Деревня: дворы, улица, тропы к дверям, площадь, дома со стенами, дверями и
 * окнами, склоны и вода, декор на площади (в том числе обещанное и утварь на
 * прилавке).
 */
function village(index) {
  const width = int(18, 44)
  const height = int(16, 38)
  const map = t.createTacticalMap({ width, height, locationId: `village-${index}`, seed: `village-${index}`, theme: 'settlement' })
  t.addZone(map, { id: 'common', kind: 'exterior', material: 'grass', label: 'Дворы' })
  t.addZone(map, { id: 'street', kind: 'exterior', material: 'earth', label: 'Улица' })
  t.addZone(map, { id: 'square', kind: 'exterior', material: 'stone', label: 'Площадь' })
  t.addZone(map, { id: 'path', kind: 'exterior', material: 'earth', label: 'Тропа' })
  const streetY = int(4, height - 5)
  const square = chance(0.8) ? { x0: int(6, Math.max(6, width - 10)), y0: Math.max(1, streetY - int(1, 3)), w: int(3, 7), h: int(3, 6) } : null
  const slope = chance(0.4)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const onStreet = y === streetY || y === streetY + 1
    const onSquare = square && x >= square.x0 && x < square.x0 + square.w && y >= square.y0 && y < square.y0 + square.h
    const water = !onStreet && !onSquare && chance(0.02)
    const zone = onSquare ? 'square' : onStreet ? 'street' : 'common'
    t.setCell(map, x, y, {
      passable: !(x === 0 || y === 0 || x === width - 1 || y === height - 1) || chance(0.6),
      revealed: true,
      zone,
      material: zone === 'square' ? 'stone' : zone === 'street' ? 'earth' : 'grass',
      surface: water ? 'water' : 'none',
      elevation: slope ? Math.floor(x / int(4, 9)) : chance(0.03) ? int(1, 7) : 0,
    })
  }
  // Дома: помещение в стенах с дверью к улице и тропой к двери.
  const houses = int(0, 4)
  for (let number = 0; number < houses; number += 1) {
    const w = int(3, 6)
    const h = int(3, 5)
    const x0 = int(2, Math.max(2, width - w - 3))
    const above = chance(0.5)
    const y0 = above ? Math.max(1, streetY - h - 2) : Math.min(height - h - 2, streetY + 3)
    if (y0 < 1 || y0 + h >= height - 1) continue
    const id = `house-${number}`
    t.addZone(map, { id, kind: 'interior', material: 'wood', label: `Дом ${number}` })
    for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) t.setCell(map, x, y, { passable: true, zone: id, material: 'wood', surface: 'none', elevation: 0 })
    for (let x = x0; x < x0 + w; x += 1) {
      t.setEdge(map, x, y0 - 1, x, y0, { kind: chance(0.15) ? 'window' : 'wall', blocksMove: true })
      t.setEdge(map, x, y0 + h - 1, x, y0 + h, { kind: chance(0.15) ? 'window' : 'wall', blocksMove: true })
    }
    for (let y = y0; y < y0 + h; y += 1) {
      t.setEdge(map, x0 - 1, y, x0, y, { kind: 'wall' })
      t.setEdge(map, x0 + w - 1, y, x0 + w, y, { kind: 'wall' })
    }
    const doorX = x0 + int(0, w - 1)
    const doorY = above ? y0 + h - 1 : y0 - 1
    t.setEdge(map, doorX, doorY, doorX, doorY + 1, { kind: 'none' })
    t.setDoor(map, { id: `door-${index}-${number}`, x: doorX, y: doorY, dir: 's', state: pick(['closed', 'open', 'locked']) })
    const pathY = above ? doorY + 1 : doorY
    if (t.cellAt(map, doorX, pathY)?.zone === 'common') t.setCell(map, doorX, pathY, { zone: 'path' })
  }
  // Декор и обещанное.
  const cells = []
  for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) if (t.cellAt(map, x, y)?.passable) cells.push({ x, y })
  const decor = int(0, 14)
  for (let number = 0; number < decor && cells.length; number += 1) {
    const cell = pick(cells)
    const assetId = pick(['market_stall', 'cart', 'well', 'barrel', 'crate', 'market_awning', 'campfire', 'statue', 'tree_oak', 'bush', 'flowers', 'table_small', 'haystack', pick(ASSETS)])
    const asset = listAssets().find((entry) => entry.id === assetId)
    const footprint = asset?.baseFootprint?.w ? Array.from({ length: asset.baseFootprint.w * asset.baseFootprint.h }, (_, k) => ({ x: cell.x + (k % asset.baseFootprint.w), y: cell.y + Math.floor(k / asset.baseFootprint.w) })) : []
    const id = pick([`prop-${number}-${assetId}`, `prop-${number}-${assetId}`, `required-${number}-${assetId}`, `program-x-${number}`])
    t.addProp(map, { id, assetId, x: cell.x + 0.5, y: cell.y + 0.5, footprint, blocksMove: asset?.blocksMove ?? false, blocksSight: asset?.blocksSight ?? false, cover: asset?.cover ?? 'none' })
    if (assetId === 'table_small' || assetId === 'market_stall') t.addProp(map, { id: `mug-${number}`, assetId: 'mug', x: cell.x + 0.5, y: cell.y + 0.5, footprint: [], mount: { kind: 'surface', propId: id } })
  }
  if (cells.length && chance(0.9)) {
    const spawn = chance(0.7) ? { x: 1, y: streetY } : pick(cells)
    t.setCell(map, spawn.x, spawn.y, { passable: true })
    t.addSpawnPoint(map, { id: 'party', x: spawn.x, y: spawn.y, role: 'party' })
  }
  return map
}

// --- программы -----------------------------------------------------------------------

function randomProgram() {
  const roll = random()
  if (roll < 0.04) return pick([null, [], {}, 'well', 42, { items: 'well' }])
  const items = Array.from({ length: int(1, 6) }, () => {
    const item = { id: chance(0.92) ? pick(KINDS) : pick(['spaceship', '', 'constructor']) }
    const count = random()
    if (count < 0.7) item.count = int(1, 4)
    else if (count < 0.8) item.count = pick([0, -2, 7, 2.5, '3'])
    return item
  })
  if (roll < 0.1) return items
  const program = { items }
  if (chance(0.8)) program.focus = chance(0.7) ? pick(items).id : pick([...KINDS, 'spaceship', 5])
  return program
}

function randomAssets() {
  const roll = random()
  if (roll < 0.6) return sr.requirementAssets(pick(KINDS))
  if (roll < 0.9) return [pick(ASSETS), ...(chance(0.5) ? [pick(ASSETS)] : [])]
  return [pick(['nope', 'zzz']), pick(['well', 'market_awning', 'fireplace', 'altar'])]
}

// --- случаи --------------------------------------------------------------------------

const maps = []
const cases = []
const outputs = []

const ops = {
  placeSceneFocus: (args) => (map) => spl.placeSceneFocus(map, args[0], args[1]),
  buildPlatforms: (args) => (map) => spl.buildPlatforms(map, args[0], args[1]),
  placeThresholdStones: (args) => (map) => spl.placeThresholdStones(map, args[0]),
  applyScenePlan: (args) => (map) => spl.applyScenePlan(map, args[0], args[1]),
}

function call(input, op, args) {
  const map = input.map !== undefined ? restore(maps[input.map]) : restore(outputs[input.from])
  const plain = JSON.parse(JSON.stringify(args))
  const program = op === 'applyScenePlan' ? plain[0] : undefined
  cases.push({ input, op, args: plain, ...runOn(map, ops[op](plain), program) })
  outputs.push(t.serializeTacticalMap(map))
  return cases.length - 1
}

function addMap(map) {
  maps.push(t.serializeTacticalMap(map))
  return maps.length - 1
}

for (let index = 0; index < 90; index += 1) {
  const input = { map: addMap(index % 6 === 0 ? field({ width: int(8, 30), height: int(8, 24) }) : village(index)) }
  for (let round = 0; round < 3; round += 1) {
    const seed = `seed-${index}-${round}`
    const focus = call(input, 'placeSceneFocus', [randomAssets(), { seed }])
    call({ from: focus }, 'buildPlatforms', [pick([1, 2, 3, 5]), { seed }])
    call(input, 'placeThresholdStones', [pick([0, 1, 2, 3, 6])])
    const planned = call(input, 'applyScenePlan', [randomProgram(), { seed }])
    if (chance(0.3)) call({ from: planned }, 'applyScenePlan', [randomProgram(), { seed: `again-${seed}` }])
  }
}

/**
 * Площадь, заставленная декором: свободного места на ней нет, и центр сцены
 * освобождает его (`roomOnSquare`), снимая декор вместе с утварью на нём;
 * колодец и обещанное (`required-*`, `program-*`) не трогаются. Тот же вид,
 * что у центра, иногда стоит в тесном тупике — он уступает место (`cramped`).
 */
function clutteredSquare(index, focusAsset) {
  const map = village(index + 500)
  const square = []
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if (t.cellAt(map, x, y)?.zone === 'square') square.push({ x, y })
  if (!square.length) {
    t.addZone(map, { id: 'square', kind: 'exterior', material: 'stone', label: 'Площадь' })
    for (let y = 3; y < 7 && y < map.height - 1; y += 1) for (let x = 3; x < 8 && x < map.width - 1; x += 1) {
      t.setCell(map, x, y, { passable: true, zone: 'square', material: 'stone', surface: 'none' })
      square.push({ x, y })
    }
  }
  const taken = new Set(map.props.flatMap((prop) => prop.footprint.map((cell) => `${cell.x},${cell.y}`)))
  let number = 0
  const density = chance(0.5) ? 1 : 0.85
  for (const cell of square) {
    if (taken.has(`${cell.x},${cell.y}`) || !chance(density)) continue
    const assetId = pick(['crate', 'barrel', 'cart', 'market_stall', 'haystack', 'flowers', 'well'])
    const kept = chance(0.08)
    const id = kept ? `required-${number}-${assetId}` : `prop-sq-${number}-${assetId}`
    t.addProp(map, { id, assetId, x: cell.x + 0.5, y: cell.y + 0.5, footprint: assetId === 'flowers' ? [] : [{ x: cell.x, y: cell.y }], blocksMove: assetId !== 'flowers' })
    if (chance(0.25)) t.addProp(map, { id: `mug-sq-${number}`, assetId: 'mug', x: cell.x + 0.5, y: cell.y + 0.5, footprint: [], mount: { kind: 'surface', propId: id } })
    taken.add(`${cell.x},${cell.y}`)
    number += 1
  }
  // Тесный предмет того же вида, что у центра, — в углу карты.
  if (chance(0.75)) {
    const assetId = chance(0.8) ? focusAsset : pick(['well', 'market_awning', 'campfire', 'statue'])
    const id = chance(0.8) ? `prop-nook-${assetId}` : `program-nook-${assetId}`
    // Глухо вокруг, кроме одной клетки подхода справа.
    const ny = map.height - 3
    for (let y = ny - 2; y <= ny + 2; y += 1) for (let x = 0; x <= 4; x += 1) {
      if (y < 0 || y >= map.height) continue
      const open = (y === ny && x >= 1 && x <= 4)
      t.setCell(map, x, y, { passable: open, zone: 'common', surface: 'none' })
    }
    t.addProp(map, { id, assetId, x: 1.5, y: ny + 0.5, footprint: [{ x: 1, y: ny }], blocksMove: assetId !== 'campfire' })
    if (chance(0.5)) t.addProp(map, { id: `cup-nook`, assetId: 'mug', x: 1.5, y: map.height - 2.5, footprint: [], mount: { kind: 'surface', propId: id } })
  }
  return map
}
const FOCI = [['well'], ['market_awning'], ['campfire'], ['statue'], ['roadside_shrine', 'altar'], ['cart'], ['market_stall'], ['lamp_post', 'lantern_wall']]
for (let index = 0; index < 60; index += 1) {
  const chosen = pick(FOCI)
  const input = { map: addMap(clutteredSquare(index, chosen[0])) }
  for (let round = 0; round < 2; round += 1) {
    const assets = round === 0 ? chosen : pick(FOCI)
    call(input, 'placeSceneFocus', [assets, { seed: `square-${index}-${round}` }])
    const kind = { well: 'well', market_awning: 'shelter', campfire: 'campfire', statue: 'statue', roadside_shrine: 'shrine', cart: 'cart', market_stall: 'market_stall', lamp_post: 'lantern' }[assets[0]]
    call(input, 'applyScenePlan', [{ items: [{ id: kind, count: 1 }, { id: pick(KINDS), count: int(1, 3) }], focus: kind }, { seed: `square-plan-${index}-${round}` }])
  }
}

// Сценарии переносимых тестов.
const scenarios = { field: addMap(field()), nook: addMap(nook()) }
call({ map: scenarios.nook }, 'applyScenePlan', [{ items: [{ id: 'well', count: 1 }], focus: 'well' }, { seed: 'field-nook' }])
call({ map: scenarios.field }, 'applyScenePlan', [{ items: [{ id: 'platform', count: 2 }], focus: 'platform' }, { seed: 'field-plan' }])
call({ map: scenarios.field }, 'applyScenePlan', [{ items: [{ id: 'well', count: 1 }, { id: 'barrels', count: 2 }], focus: 'well' }, { seed: 'field-well' }])

// `programFocusOutdoors` на всех видах и мусоре.
const outdoors = []
for (const focus of [...KINDS, 'spaceship', '', 'constructor']) outdoors.push([{ focus }, spl.programFocusOutdoors({ focus })])
for (const program of [null, [], {}, 'well', 42, { focus: 5 }, { focus: null }, [{ id: 'well' }], { items: [{ id: 'well' }] }]) outdoors.push([program, spl.programFocusOutdoors(program)])
for (let index = 0; index < 100; index += 1) {
  const program = randomProgram()
  outdoors.push([program, spl.programFocusOutdoors(program)])
}

const counts = cases.reduce((total, entry) => ({ ...total, [entry.op]: (total[entry.op] ?? 0) + 1 }), {})
writeFileSync(new URL('./scene-program-layout.json', import.meta.url), `{\n"version": ${JSON.stringify(spl.SCENE_PROGRAM_LAYOUT_VERSION)},\n"platformElevationFeet": ${spl.PLATFORM_ELEVATION_FEET},\n"scenarios": ${JSON.stringify(scenarios)},\n"outdoors": [\n${outdoors.map((row) => JSON.stringify(row)).join(',\n')}\n],\n"maps": [\n${maps.map((map) => JSON.stringify(map)).join(',\n')}\n],\n"cases": [\n${cases.map((entry) => JSON.stringify(entry)).join(',\n')}\n]\n}\n`)
console.log('scene-program-layout.json:', counts, 'outdoors', outdoors.length, 'с отказом', cases.filter((entry) => entry.error).length,
  'отчётов с провалом', cases.filter((entry) => entry.report?.problems.length).length)

// --- корпус конвейера сцены ------------------------------------------------------------

const corpus = JSON.parse(readFileSync(new URL('../../../../test/fixtures/scene-programs/corpus.json', import.meta.url), 'utf8'))
const failures = []
const scene = (input) => {
  try {
    generateSceneGeometry({ useLibrary: false, ...input })
  } catch (error) {
    failures.push(`${input.location}: ${error.message}`)
  }
}
for (const entry of corpus.scenes) {
  const program = sr.sceneMapRequirementsFor([entry.location, entry.text], { npcs: entry.npcs })
  for (const seed of [`corpus:${entry.id}`, `corpus-2:${entry.id}`, `corpus-3:${entry.id}`]) {
    scene({ location: entry.location, theme: entry.theme, settlementType: entry.settlementType ?? '', seed, requirements: program?.items ?? [], program })
  }
}
const SKIT = 'Скит Трёх Настилов. У ближайших домов на порогах лежат камни с чужих полей. '
  + 'В центре — общий навес, под ним староста Илва держит копию соглашения. '
  + 'Хранитель записей Терен стоит у запертого ящика для документов. Мастер настилов Вейра.'
const RESIDENTS = [{ name: 'Илва', role: 'староста' }, { name: 'Терен', role: 'хранитель записей' }, { name: 'Вейра', role: 'мастер настилов' }]
const skit = sr.sceneMapRequirementsFor([SKIT], { npcs: RESIDENTS })
for (const seed of ['skit-a', 'skit-b', 'skit-c', 'skit-det', 'skit-e']) scene({ location: 'Скит Трёх Настилов', theme: 'деревня', settlementType: 'village', seed, requirements: skit.items, program: skit })
const well = sr.sceneMapRequirementsFor(['Деревня: деревянные дома, колодец на площади, огороды и плетни.'], { npcs: [] })
for (const seed of ['well-a', 'well-b', 'well-c', 'well-d']) scene({ location: 'Деревня Кленовка', theme: 'деревня', settlementType: 'village', seed, requirements: well.items, program: well })
const PLACES = [
  { location: 'Деревня Кленовка', theme: 'деревня', settlementType: 'village' },
  { location: 'Торговый город', theme: 'город', settlementType: 'town' },
  { location: 'Трактир у дороги', theme: 'таверна' },
  { location: 'Лесная поляна', theme: 'лес' },
  { location: 'Старый тракт', theme: 'дорога' },
  { location: 'Храм', theme: 'храм' },
  { location: 'Кладбище', theme: 'кладбище' },
  { location: 'Лагерь', theme: 'лагерь в лесу' },
  { location: 'Причал', theme: 'гавань', settlementType: 'town' },
  { location: 'Хутор', theme: 'хутор', settlementType: 'hamlet' },
]
const ROLES = ['focus', 'npc_post', 'clue', 'dressing']
for (let index = 0; index < 70; index += 1) {
  const landmarks = Array.from({ length: int(1, 5) }, () => ({ kind: pick(KINDS), role: pick(ROLES), count: int(1, 4), ...(chance(0.3) ? { npc: pick(['Илва', 'Терен', 'Мира']) } : {}) }))
  const npcs = chance(0.5) ? [{ name: 'Илва', role: pick(['староста', 'кузнец', 'трактирщик', 'жрица']) }, { name: 'Мира', role: pick(['торговка', 'стражник']) }] : []
  const text = chance(0.5) ? pick(corpus.scenes).text : ''
  const program = sr.sceneMapRequirementsFor([text], { npcs, landmarks })
  if (!program) continue
  scene({ ...pick(PLACES), seed: `random-program-${index}`, requirements: program.items, program })
}
captured.recording = false

const calls = []
for (const entry of captured.apply) {
  const map = restore(entry.before)
  const record = runOn(map, (target) => spl.applyScenePlan(target, entry.program, { seed: entry.seed }), entry.program)
  // Карта генератора и прочитанная — через то же чтение: порядок ключей зон
  // у генератора и у прочитанной карты различается.
  record.stable = record.hash === mapHash(restore(entry.after))
  calls.push({ map: entry.before, program: entry.program, seed: entry.seed, ...record })
}
const unstable = calls.filter((entry) => !entry.stable).length
const text = `{\n"outdoors": [\n${captured.outdoors.map((row) => JSON.stringify([row.program, row.result])).join(',\n')}\n],\n"calls": [\n${calls.map((entry) => JSON.stringify(entry)).join(',\n')}\n]\n}\n`
writeFileSync(new URL('./scene-program-layout-corpus.json.gz', import.meta.url), gzipSync(text, { level: 9 }))
console.log('корпус: applyScenePlan', calls.length, 'programFocusOutdoors', captured.outdoors.length, 'расходятся с картой генератора', unstable,
  'с провалом проверки', calls.filter((entry) => entry.report.problems.length).length, `(${text.length} байт до сжатия)`)
if (failures.length) console.log('генератор отказал:', failures)

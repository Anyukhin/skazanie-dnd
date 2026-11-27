import '../../../fixtures-env.mjs'
// Эталон server/tactical-map.mjs для Rust:
//
//   node rust/crates/sk-tactical/fixtures/gen-tactical-map.mjs
//
// Пять источников карт:
//
// - корпус: 56 нарисованных карт `data/authored-location-maps-v1.json`
//   (Rust читает файл данных сам, здесь — только ожидаемые выходы);
// - генераторы: сцены `generateSceneGeometry` по темам, этажам, сторонам входа
//   и программам корпуса `test/fixtures/scene-programs/corpus.json`
//   (вход — сериализованная карта);
// - старые клетки `generateDynamicSceneMap` на восьми планировках;
// - программы: случайные последовательности операций API (`setCell`,
//   `setEdge`, `setDoor`, `addProp`, `addZone`, …) с отказами и частичными
//   правками, исполняемые одинаково в JS и Rust;
// - испорченные сериализованные карты и случайные старые клетки.
//
// Для каждой карты снимается разбор: сериализация, хеш, проверка, старые
// клетки, все клетки, рёбра, обход (с дверями и без, с занятыми клетками),
// сотни пар соседних клеток (ребро, преграда шага, дверь), проёмы, двери у
// клетки, круг через старые клетки и поворот к дороге. Крупное — SHA-256
// строки `JSON.stringify`.
import { readFileSync } from 'node:fs'
import * as t from '../../../../server/tactical-map.mjs'
import { generateDynamicSceneMap } from '../../../../server/dynamic-map.mjs'
import { generateSceneGeometry } from '../../../../server/adventure-director.mjs'
import { sceneMapRequirementsFor } from '../../../../server/scene-requirements.mjs'
import { attempt, encode, hash, mulberry32, writeFixture } from './common.mjs'

const random = mulberry32(2026_10_16)
const int = (n) => Math.floor(random() * n)
const pick = (items) => items[int(items.length)]
const chance = (p) => random() < p

const errorOf = (error) => ({ name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) })
// Снимок значения: запись, которую вернула операция, живёт в карте и меняется
// следующими шагами программы.
const snapshot = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const tryOr = (fn) => {
  try {
    return { ok: encode(snapshot(fn())) }
  } catch (error) {
    return { error: errorOf(error) }
  }
}

/** Входы разбора карты: стартовые клетки обхода, пары клеток, клетки проёмов. */
function probesFor(map) {
  const passable = []
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if (t.cellAt(map, x, y)?.passable) passable.push([x, y])
  const starts = []
  for (const point of map.spawnPoints.slice(0, 3)) starts.push([point.x, point.y, true, []])
  for (let index = 0; index < 5 && passable.length; index += 1) {
    const [x, y] = pick(passable)
    const blocked = chance(0.5) ? Array.from({ length: 1 + int(6) }, () => pick(passable)) : []
    starts.push([x, y, chance(0.7), blocked.map(([bx, by]) => `${bx},${by}`)])
  }
  starts.push([int(map.width + 2) - 1, int(map.height + 2) - 1, true, []])
  const pairs = []
  for (const door of map.doors.slice(0, 40)) {
    const [nx, ny] = door.dir === 'e' ? [door.x + 1, door.y] : [door.x, door.y + 1]
    pairs.push([door.x, door.y, nx, ny], [nx, ny, door.x, door.y])
  }
  for (const edge of t.edgeList(map).slice(0, 80)) {
    const [nx, ny] = edge.dir === 'e' ? [edge.x + 1, edge.y] : [edge.x, edge.y + 1]
    pairs.push(chance(0.5) ? [edge.x, edge.y, nx, ny] : [nx, ny, edge.x, edge.y])
  }
  for (let index = 0; index < 160; index += 1) {
    const x = int(map.width + 2) - 1
    const y = int(map.height + 2) - 1
    const [dx, dy] = pick([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 0], [0, 1], [2, 0], [1, 1], [0, 0]])
    pairs.push([x, y, x + dx, y + dy])
  }
  const cells = Array.from({ length: 80 }, () => [int(map.width + 2) - 1, int(map.height + 2) - 1])
  return { starts, pairs, cells }
}

/** Разбор карты; `full` — малые карты целиком, иначе крупное хешем. */
function analyze(map, probes, full) {
  // Через JSON: в Rust сериализованная карта — всегда JSON, и NaN-координата
  // предмета там уже null (см. отчёт).
  const serialized = JSON.parse(JSON.stringify(t.serializeTacticalMap(map)))
  const legacy = t.legacyCellsFromTacticalMap(map)
  const grid = []
  for (let y = -1; y <= map.height; y += 1) for (let x = -1; x <= map.width; x += 1) grid.push(t.cellAt(map, x, y))
  const pairs = probes.pairs.map(([ax, ay, bx, by]) => {
    try {
      return [t.edgeBetween(map, ax, ay, bx, by), t.movementStepBlocked(map, ax, ay, bx, by), t.doorBlocksStep(map, ax, ay, bx, by)]
    } catch (error) {
      return { error: error.code }
    }
  })
  const reachable = probes.starts.map(([x, y, throughDoors, blocked]) => {
    const set = t.reachableCells(map, x, y, { throughDoors, blockedCells: new Set(blocked) })
    return [set.size, hash([...set])]
  })
  const doorways = probes.cells.map(([x, y]) => t.doorwayEdgeAt(map, x, y))
  const doorsFrom = probes.cells.map(([x, y]) => t.doorsReachableFrom(map, x, y).map((door) => door.id))
  const masks = probes.cells.map(([x, y]) => t.legacyEdgeMask(map, x, y))
  const rebuilt = tryOr(() => {
    const back = t.tacticalMapFromLegacyCells(legacy, { locationId: map.locationId, seed: map.seed })
    return [hash(t.serializeTacticalMap(back)), hash(t.legacyCellsFromTacticalMap(back))]
  })
  const orient = ['east', 'north', 'south', 'west', 'up'].map((side) => tryOr(() => {
    const turned = t.orientTacticalMap(t.deserializeTacticalMap(serialized), side)
    return [hash(t.serializeTacticalMap(turned)), hash(t.legacyCellsFromTacticalMap(turned))]
  }))
  const attached = tryOr(() => {
    const copy = t.deserializeTacticalMap(serialized)
    const ids = t.attachLevelTransitions(copy, [{ offset: 1, label: 'Верхний этаж' }, { offset: -1 }, { offset: 2, label: 'Чердак' }]).map((prop) => prop.id)
    return [ids, hash(t.serializeTacticalMap(copy))]
  })
  return {
    serialized: full ? serialized : hash(serialized),
    mapHash: t.tacticalMapHash(map),
    legacy: full ? legacy : hash(legacy),
    validate: t.validateTacticalMap(map),
    cellCount: t.cellCount(map),
    bounds: map.bounds,
    edges: full ? t.edgeList(map) : hash(t.edgeList(map)),
    cells: hash(grid),
    pairs: hash(pairs),
    reachable,
    doorways: hash(doorways),
    doorsFrom: hash(doorsFrom),
    masks: hash(masks),
    rebuilt,
    orient,
    attached,
    stable: hash(t.serializeTacticalMap(t.deserializeTacticalMap(serialized))),
  }
}

// --- корпус -----------------------------------------------------------------

const catalog = JSON.parse(readFileSync(new URL('../../../../data/authored-location-maps-v1.json', import.meta.url), 'utf8'))
const corpus = catalog.maps.map((raw, index) => {
  const map = t.deserializeTacticalMap(raw)
  const probes = probesFor(map)
  return {
    index,
    sameAsSource: JSON.stringify(t.serializeTacticalMap(map)) === JSON.stringify(raw),
    sourceHash: t.serializedTacticalMapHash(raw),
    probes,
    analysis: analyze(map, probes, false),
  }
})

// --- генераторы -------------------------------------------------------------

const locations = ['Таверна', 'Храм', 'Склеп', 'Подземелье', 'Пещера', 'Тёмный лес', 'Дорога', 'Кладбище', 'Деревня', 'Город', 'Замок', 'Мост через ущелье', 'Порт', 'Кузница', 'Рынок', 'Руины', 'Болото']
const generatorInputs = []
for (const location of locations) {
  generatorInputs.push({ location, seed: `fixture:${location}` })
  generatorInputs.push({ location, seed: `fixture-2:${location}`, entrySide: pick(['east', 'north', 'south']) })
}
generatorInputs.push({ location: 'Таверна', seed: 'levels', locationId: 'loc-tavern', levels: [{ offset: 1, hint: 'спальни и кабинет хозяина' }, { offset: -1, hint: 'винный погреб' }] })
generatorInputs.push({ location: 'Башня мага', seed: 'tower', locationId: 'loc-tower', levels: [{ offset: 1, hint: 'кабинет' }, { offset: 2, hint: 'обсерватория' }] })
const programCorpus = JSON.parse(readFileSync(new URL('../../../../test/fixtures/scene-programs/corpus.json', import.meta.url), 'utf8'))
for (const scene of programCorpus.scenes) {
  const program = sceneMapRequirementsFor([scene.location, scene.text], { npcs: scene.npcs })
  generatorInputs.push({ location: scene.location, theme: scene.theme, settlementType: scene.settlementType ?? '', requirements: program?.items ?? [], program, seed: `corpus:${scene.id}` })
}
const generated = []
for (const input of generatorInputs) {
  let built
  try {
    built = generateSceneGeometry({ ...input, useLibrary: false })
  } catch (error) {
    console.log(`  генератор отказал на ${input.location}: ${error.message}`)
    continue
  }
  const map = built.map
  const serialized = t.serializeTacticalMap(map)
  const restored = t.deserializeTacticalMap(JSON.parse(JSON.stringify(serialized)))
  const probes = probesFor(restored)
  generated.push({
    input: { location: input.location, seed: input.seed },
    serialized,
    // Карта генератора в памяти и та же карта после чтения — совпадают ли
    // их сериализация и старые клетки (см. «Замечено в JS» отчёта).
    memoryStable: JSON.stringify(t.serializeTacticalMap(restored)) === JSON.stringify(serialized),
    memoryLegacy: hash(t.legacyCellsFromTacticalMap(map)),
    probes,
    analysis: analyze(restored, probes, false),
  })
}

// --- старые клетки генератора -------------------------------------------------

const shapes = [
  { seed: 'shape-cavern', layout: 'cavern', pattern: 'cave-cluster', theme: 'пещера' },
  { seed: 'shape-radial', layout: 'radial', pattern: 'courtyard', theme: 'храм' },
  { seed: 'shape-ruins', layout: 'ruins', pattern: 'keep', theme: 'руины' },
  { seed: 'shape-bridge', layout: 'open', pattern: 'bridge', theme: 'мост через ущелье' },
  { seed: 'shape-village', layout: 'streets', pattern: 'village', theme: 'деревня' },
  { seed: 'shape-room', layout: 'rooms', pattern: 'small-room', theme: 'таверна' },
  { seed: 'shape-hall', layout: 'rooms', pattern: 'great-hall', theme: 'дворец' },
  { seed: 'shape-crypt', layout: 'winding', pattern: 'crypt', theme: 'склеп' },
  { seed: 'valid', layout: 'rooms', pattern: 'small-room', theme: 'таверна' },
  { seed: 'hash', layout: 'rooms', pattern: 'small-room' },
  { seed: 'limit', width: 30, height: 30, layout: 'rooms', pattern: 'great-hall' },
]
const dynamic = shapes.map((shape) => {
  const cells = generateDynamicSceneMap({ danger: 'средняя', water: 0.08, featureCount: 8, ...shape })
  const map = t.tacticalMapFromLegacyCells(cells, { locationId: 'dyn', seed: shape.seed })
  const probes = probesFor(map)
  return {
    seed: shape.seed,
    cells,
    restoredEqual: JSON.stringify(t.legacyCellsFromTacticalMap(t.tacticalMapFromLegacyCells(cells))) === JSON.stringify(cells),
    probes,
    analysis: analyze(map, probes, false),
  }
})

// --- программы операций ----------------------------------------------------

const zoneIds = ['z1', 'z2', 'hall', '', ' z3 ']
const randomPatch = () => {
  const patch = {}
  if (chance(0.5)) patch.passable = pick([true, true, false, 1, null])
  if (chance(0.4)) patch.revealed = pick([true, false, 'да'])
  if (chance(0.2)) patch.moveCost = pick([1, 2, 1, 2, 3, '2', null, 0])
  if (chance(0.3)) patch.surface = pick([...t.SURFACES, 'lava', null])
  if (chance(0.4)) patch.material = pick([...t.MATERIALS, 'gold'])
  if (chance(0.4)) patch.variant = pick([0, 3, 5, 255, 300, -4, '7', 1.5, null])
  if (chance(0.3)) patch.elevation = pick([0, 5, -5, 200, -200, '10', null])
  if (chance(0.3)) patch.zone = pick([...zoneIds, 'nope', null])
  if (chance(0.2)) patch.hazardId = pick(['hz-1', '', null, 'fire', 7])
  return patch
}
const randomEdge = () => {
  const edge = {}
  if (chance(0.9)) edge.kind = pick(['wall', 'wall', 'door', 'window', 'rail', 'ledge', 'loophole', 'grate', 'none', 'lava', null])
  if (chance(0.4)) edge.blocksMove = pick([true, false, null])
  if (chance(0.4)) edge.blocksSight = pick([true, false, null])
  if (chance(0.3)) edge.cover = pick(['none', 'half', 'three_quarters', 'full', null])
  if (chance(0.2)) edge.doorId = pick(['d1', 'ghost', null, 5, ''])
  return edge
}
const randomDoor = (width, height) => {
  const door = { id: pick(['d1', 'd2', 'd3', '', '  d1 ', 'd4']), x: int(width + 1) - (chance(0.1) ? 1 : 0), y: int(height + 1), dir: pick(['e', 's']) }
  if (chance(0.8)) door.state = pick(['open', 'closed', 'locked', 'broken', 'ajar', null])
  if (chance(0.3)) door.lockDc = pick([12, 50, -3, '15', 1.5])
  if (chance(0.3)) door.keyItemId = pick([null, 'key-1', 7])
  if (chance(0.3)) door.barricade = pick([null, false, { material_item_id: 'plank', actor_id: 'hero', previous_state: 'closed', side_x: door.x, side_y: door.y }, { previous_state: 'weird', side_x: 1.5 }, []])
  if (chance(0.4)) door.blocksMove = pick([true, false])
  if (chance(0.4)) door.blocksSight = pick([true, false])
  return door
}
const assetPool = ['barrel', 'chest', 'table', 'stairs_up', 'stairs_down', 'trapdoor', 'rug', 'chair', 'altar', 'campfire', '', 'mug', 'bones', 'well', 'bookshelf', '  crate  ']
const randomProp = (width, height) => {
  const prop = { id: pick(['p1', 'p2', 'p3', 'p4', 'p5', '', ' p6 ', 5]), assetId: pick(assetPool), x: Math.round(random() * width * 4) / 4, y: Math.round(random() * height * 4) / 4 }
  if (chance(0.1)) delete prop.x
  if (chance(0.3)) prop.rotation = pick([0, 90, 45.5, 'x', -0, 400, -90])
  if (chance(0.2)) prop.scale = pick([1, 0.5, 0, -1, 'big', 2])
  if (chance(0.6)) prop.footprint = Array.from({ length: int(3) }, () => (chance(0.1) ? pick([null, { x: 'a' }, {}]) : { x: int(width + 1), y: int(height + 1) }))
  if (chance(0.2)) prop.zOrder = pick([0, 1, -5, 2000, 'x'])
  if (chance(0.15)) prop.mount = pick([{ kind: 'surface', propId: 'p1' }, { kind: 'surface', propId: '  ' }, { kind: 'wall', side: 'n' }, { kind: 'wall', side: 'w' }, { kind: 'wall', side: 'x' }, 'wall', null])
  if (chance(0.2)) prop.blocksMove = pick([true, false, 'yes'])
  if (chance(0.2)) prop.blocksSight = pick([true, false])
  if (chance(0.2)) prop.cover = pick(['none', 'half', 'three_quarters', 'full', null])
  if (chance(0.1)) prop.destructible = true
  if (chance(0.2)) prop.hp = pick([5, 2000, -1, '9'])
  if (chance(0.2)) prop.interactive = pick([true, 'yes', false])
  if (chance(0.2)) prop.state = pick(['open', '  ', 'x'.repeat(50)])
  if (chance(0.25)) prop.interaction = pick([{ pointOfInterest: true }, { pointOfInterest: true, detailKey: 'container:2', rewardKey: 'container:guard-cache' }, { pointOfInterest: false, detailKey: '  ' }, [], 'x', { pointOfInterest: true, detailKey: ' padded ', rewardKey: 5 }])
  if (chance(0.25)) prop.transition = pick([null, { toLevel: 1, label: 'Верх' }, { toLevel: -1 }, { toLevel: 0 }, { toLevel: 5 }, { toLevel: '1' }, { toLevel: 1.5 }, 'up', [1], { toLevel: 2, label: '  ' }])
  return prop
}
const randomZone = () => {
  const zone = { id: pick([...zoneIds, 'z1']) }
  if (chance(0.7)) zone.kind = pick(['interior', 'exterior', 'void', null])
  if (chance(0.5)) zone.material = pick(['wood', 'gold', 'grass'])
  if (chance(0.3)) zone.lightLevel = pick(['dim', '', '  ', 'dark'])
  if (chance(0.3)) zone.floorDirection = pick(['vertical', 'diagonal'])
  if (chance(0.4)) zone.label = pick(['Зал', '', 'Кухня'])
  if (chance(0.3)) zone.floor = pick(['parquet', 'lava', 'cave'])
  if (chance(0.3)) zone.wall = pick(['brick', 'glass', 'palisade'])
  return zone
}

function randomProgram() {
  const width = 2 + int(9)
  const height = 2 + int(9)
  const options = { width: chance(0.03) ? pick([0, -3, 150]) : width, height }
  if (chance(0.5)) options.locationId = pick(['', 'loc-1', '  spaced  ', 'л'.repeat(130)])
  if (chance(0.3)) options.levelIndex = pick([0, 1, -1, 2, 5, -7])
  if (chance(0.3)) options.levelLabel = pick(['', 'Подвал', '  Чердак  '])
  if (chance(0.7)) options.seed = pick(['', 'seed-1', 'карта', 'x'.repeat(220)])
  if (chance(0.2)) options.generator = pick([null, { id: 'gen', version: '2' }, { id: '', version: '' }])
  if (chance(0.4)) options.theme = pick(['', 'small-room', 'crypt', 'village', 'x'])
  if (chance(0.2)) options.tilesetId = pick(['', 'detail-v1'])
  if (chance(0.3)) options.sizeClass = pick(['', 'arena', 'area', 'region', 'constructor', 'bogus'])
  options.catalogRevision = pick(['current', 'current', 'omit', 'omit', 'pr79', 'Bad Rev!'])
  if (chance(0.5)) options.fill = chance(0.9) ? { passable: true, revealed: chance(0.5), ...(chance(0.3) ? { material: pick(t.MATERIALS) } : {}) } : randomPatch()
  const ops = [{ op: 'create', options }]
  const steps = 10 + int(50)
  for (let index = 0; index < steps; index += 1) {
    const roll = random()
    const x = int(width + 1) - (chance(0.05) ? 1 : 0)
    const y = int(height + 1)
    if (roll < 0.06) ops.push({ op: 'addZone', zone: randomZone() })
    else if (roll < 0.3) ops.push({ op: 'setCell', x, y, patch: randomPatch() })
    else if (roll < 0.45) {
      const [dx, dy] = pick([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 0], [0, 1], [2, 0], [1, 1]])
      ops.push({ op: 'setEdge', ax: x, ay: y, bx: x + dx, by: y + dy, edge: randomEdge() })
    } else if (roll < 0.55) ops.push({ op: 'setDoor', door: randomDoor(width, height) })
    else if (roll < 0.7) ops.push({ op: 'addProp', prop: randomProp(width, height) })
    else if (roll < 0.74) ops.push({ op: 'addSpawnPoint', point: { id: pick(['s1', '', ' s2 ']), x: pick([x, x, 500, -3, '4']), y, ...(chance(0.7) ? { role: pick(['party', 'enemy', 'neutral', 'boss']) } : {}) } })
    else if (roll < 0.77) ops.push({ op: 'attach', levels: pick([[{ offset: 1, label: 'Верх' }], [{ offset: -1 }, { offset: 1 }], 'x', [{ offset: 0 }], [{ offset: 9 }], [{ offset: '1', label: '  Чердак  ' }], [null, { offset: 1 }]]) })
    else if (roll < 0.79) ops.push({ op: 'setLevelIndex', value: int(7) - 3 })
    else if (roll < 0.82) ops.push({ op: 'setDoorState', index: int(4), state: pick(t.DOOR_STATES) })
    else if (roll < 0.84) ops.push({ op: 'removeEdge', x, y, dir: pick(['e', 's']) })
    else if (roll < 0.86) ops.push({ op: 'setEdgeKind', x, y, dir: pick(['e', 's']), kind: pick(['wall', 'door', 'window']) })
    else if (roll < 0.88) ops.push({ op: 'zoneStyle', index: int(3), key: pick(['floor', 'wall']), value: pick(['brick', 'parquet', null]) })
    else if (roll < 0.9) ops.push({ op: 'combatBounds', value: chance(0.7) ? { minX: int(width), minY: int(height), maxX: int(width), maxY: int(height) } : null })
    else if (roll < 0.91) ops.push({ op: 'surroundings', value: pick([{ biome: 'sea' }, { sides: { n: 'sea', w: 'forest' } }, { biome: 'forest', sides: { e: 'rock', s: 'lava' } }, null, 'x']) })
    else if (roll < 0.93) ops.push({ op: 'recompute' })
    else if (roll < 0.94) ops.push({ op: 'setBounds', value: { minX: 1, minY: 1, maxX: 2, maxY: 2 } })
    else if (roll < 0.96) ops.push({ op: 'orient', side: pick(['east', 'north', 'south', 'west', 'up']) })
    else if (roll < 0.985) ops.push({ op: 'roundtrip' })
    else ops.push({ op: 'setCatalogRevision', value: pick(['pr79', 'BAD!']) })
  }
  return ops
}

function runProgram(ops) {
  let map = null
  const results = []
  for (const step of ops) {
    if (!map && step.op !== 'create') break
    results.push(tryOr(() => {
      switch (step.op) {
        case 'create': {
          const { catalogRevision, ...rest } = step.options
          const revision = catalogRevision === 'current' ? undefined : catalogRevision === 'omit' ? null : catalogRevision
          map = t.createTacticalMap({ ...rest, ...(revision === undefined ? {} : { catalogRevision: revision }) })
          return undefined
        }
        case 'setCell': return t.setCell(map, step.x, step.y, step.patch)
        case 'setEdge': return t.setEdge(map, step.ax, step.ay, step.bx, step.by, step.edge)
        case 'setDoor': return t.setDoor(map, step.door)
        case 'addProp': return t.addProp(map, step.prop)
        case 'addZone': return t.addZone(map, step.zone)
        case 'addSpawnPoint': return t.addSpawnPoint(map, step.point)
        case 'attach': return t.attachLevelTransitions(map, step.levels).map((prop) => prop.id)
        case 'setLevelIndex': map.levelIndex = step.value; return undefined
        case 'setDoorState': if (map.doors.length) map.doors[step.index % map.doors.length].state = step.state; return undefined
        case 'removeEdge': delete map.edges[`${step.x},${step.y},${step.dir}`]; return undefined
        case 'setEdgeKind': { const edge = map.edges[`${step.x},${step.y},${step.dir}`]; if (edge) edge.kind = step.kind; return undefined }
        case 'zoneStyle': {
          const zone = map.zones[step.index]
          if (zone) { if (step.value === null) delete zone[step.key]; else zone[step.key] = step.value }
          return undefined
        }
        case 'combatBounds': map.combatBounds = step.value; return undefined
        case 'surroundings': map.surroundings = t.normalizeMapSurroundings(step.value) ?? undefined; return undefined
        case 'recompute': return t.recomputeBounds(map)
        case 'setBounds': map.bounds = { ...step.value }; return undefined
        case 'orient': map = t.orientTacticalMap(map, step.side); return undefined
        case 'roundtrip': map = t.deserializeTacticalMap(JSON.parse(JSON.stringify(t.serializeTacticalMap(map)))); return undefined
        case 'setCatalogRevision': map.catalogRevision = step.value; return undefined
        default: throw new Error(`операция ${step.op}`)
      }
    }))
    if (step.op === 'create' && !map) break
  }
  if (!map) return { results }
  let analysis
  try {
    const probes = probesFor(map)
    analysis = { probes, ok: analyze(map, probes, true) }
  } catch (error) {
    analysis = { error: errorOf(error), validate: t.validateTacticalMap(map) }
  }
  return { results, analysis }
}

const programs = []
for (let index = 0; index < 320; index += 1) {
  const ops = randomProgram()
  const { results, analysis } = runProgram(ops)
  programs.push({ ops, results, analysis: analysis ?? null })
}

// --- испорченные сериализованные карты ---------------------------------------

const baseMaps = [
  ...programs.filter((program) => program.analysis?.ok).slice(0, 16).map((program) => program.analysis.ok.serialized),
]
const junk = [null, 5, 'x', [], {}, true, -1, 1.5, 300]
const mutations = [
  (raw) => { delete raw[pick(Object.keys(raw))] },
  (raw) => { raw[pick(Object.keys(raw))] = pick(junk) },
  (raw) => { raw.layers = { ...raw.layers, [pick(Object.keys(raw.layers))]: pick([300, -1, 1.5, 'AAAA', null, {}, 'не base64 !!', 7, -129]) } },
  (raw) => { delete raw.layers[pick(Object.keys(raw.layers))] },
  (raw) => { raw.hazards = pick([{ 5: 'fire', __proto__x: 'x', abc: 'y', '007': 'z', 3: '', 1: 5 }, 'ab', ['a', 5, 'c'], 7, null, { 4294967295: 'big', 2: 'two' }]) },
  (raw) => { raw.hazards = JSON.parse('{"__proto__": "proto", "1": "one"}') },
  (raw) => { raw.edges = pick([{ cells: 'junk', attrs: 'x' }, [{ x: 0, y: 0, dir: 'e', kind: 'wall' }, { x: 1, y: 0, dir: 's', kind: 'window', cover: 'half' }, { x: 0, y: 1, kind: 'none' }], { ...raw.edges, doors: ['d1'] }, { ...raw.edges, doors: null }, 'x', [null], { cells: 'AAAA', attrs: 'AQ==' }]) },
  (raw) => { raw.doors = [...(raw.doors ?? []), ...pick([[{ id: 'dx', x: 1, y: 1, dir: 'e', state: 'ajar' }], [null], [{ x: 1, y: 1, dir: 's' }], [{ id: 'dy', x: 0, y: 0, dir: 'e', barricade: [] }], (raw.doors ?? []).slice(0, 1), [5], ['ab']])] },
  (raw) => { raw.props = [...(raw.props ?? []), ...pick([[null], [{ id: 'q', assetId: 'stairs_up', x: 1, y: 1, transition: { toLevel: 'x' } }], [{ id: 'q2', assetId: 'chest', x: 1, interaction: { pointOfInterest: true, detailKey: 'container:1' } }], [{ assetId: 'barrel' }], [{ id: 'q3', assetId: 'barrel', cover: 'full' }], [7]])] },
  (raw) => { raw.zones = pick([[null], Array.from({ length: 256 }, (_, index) => ({ id: `z${index}` })), [{ id: 'w', floor: 'parquet', wall: 'brick', extra: 1 }], [{ id: 'k', kind: 'void' }], 'x']) },
  (raw) => { raw.spawnPoints = pick([[{ id: 's', x: 1, y: 1, role: 'boss' }], [null], [{ x: 2 }], [{ id: 's', x: '3', y: 1.5 }]]) },
  (raw) => { raw.overlays = pick([{ compass: true, roomLabels: [{ zoneId: 5, label: '  Зал  ' }, null, 'x'] }, null, 'x', { scaleBar: 'yes', roomLabels: 'x' }]) },
  (raw) => { raw.combatBounds = pick([true, 'x', { minX: 5000, minY: -5000, maxX: '3', maxY: 1.5 }, [], 0, { minX: 1 }]) },
  (raw) => { raw.sizeClass = pick(['constructor', '__proto__', ['arena'], 5, 'toString', 'hasOwnProperty', 'area', null]) },
  (raw) => { raw.legacyShape = pick([['material', 5, 'pattern'], 'x', [], ['edge_mask', 'edge_mask']]) },
  (raw) => { raw.catalogRevision = pick(['BAD', null, 5, 'pr79', 'abc_def-1']) },
  (raw) => { raw.surroundings = pick([{ biome: 'sea' }, { biome: 'lava', sides: { n: 'sea', q: 'forest', w: ['rock'] } }, [], 'x', { sides: [] }]) },
  (raw) => { raw.version = pick([5, '  v  ', '', 'x'.repeat(70)]) },
  (raw) => { raw.width = pick([0, 'x', 1.5, 200, -4]); raw.layers = Object.fromEntries(Object.keys(raw.layers).map((key) => [key, 0])) },
  (raw) => { raw.levelIndex = pick([2, 9, -9, '1', 1.5]) },
  (raw) => { raw.generator = pick([null, 'x', { id: 5, version: '  ' }]) },
]
const garbage = []
for (let index = 0; index < 400; index += 1) {
  const raw = JSON.parse(JSON.stringify(pick(baseMaps)))
  const count = 1 + int(2)
  for (let step = 0; step < count; step += 1) pick(mutations)(raw)
  const outcome = tryOr(() => {
    const map = t.deserializeTacticalMap(raw)
    let serialized
    try {
      serialized = t.serializeTacticalMap(map)
    } catch (error) {
      return { serializeError: errorOf(error), validate: t.validateTacticalMap(map) }
    }
    return { serialized: hash(serialized), legacy: hash(t.legacyCellsFromTacticalMap(map)), validate: t.validateTacticalMap(map), sizeClass: map.sizeClass }
  })
  garbage.push({ raw, outcome })
}

// --- случайные старые клетки --------------------------------------------------

const legacyRandom = []
for (let index = 0; index < 160; index += 1) {
  const width = 1 + int(8)
  const height = 1 + int(8)
  const cells = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (chance(0.1)) continue
      const cell = { x, y, type: pick(['floor', 'floor', 'floor', 'wall', 'wall', 'water', 'door', undefined, 'lava']), revealed: pick([true, false, 'да']) }
      if (cell.type === undefined) delete cell.type
      if (chance(0.6)) cell.material = pick([...t.MATERIALS, 'gold', null])
      if (chance(0.6)) cell.variant = pick([0, 3, 5, 300, '2', null])
      if (chance(0.4)) cell.pattern = pick(['small-room', 'small-room', 'crypt', '', 'x', 5])
      if (chance(0.3)) cell.edge_mask = 'nesw'
      if (chance(0.2)) cell.feature = pick(['table', 'enemy', 'chest', '  barrel ', '', 'stairs_up', 5, 'altar', 'bones'])
      if (chance(0.15)) cell.elevation = pick([0, 5, -200, '3'])
      if (chance(0.15)) cell.walls = pick(['e', 's', 'es', 'x', ''])
      if (chance(0.1)) cell.windows = pick(['e', 's', 'se'])
      if (chance(0.1)) cell.door_dir = pick(['e', 's', 'n'])
      cells.push(cell)
    }
  }
  if (chance(0.2)) cells.push(pick([null, { x: 'a', y: 0 }, { x: -1, y: 0, type: 'floor' }, { x: 1.5, y: 0 }, 7, { ...cells[0] }]))
  if (chance(0.05)) cells.push({ x: 120, y: 0, type: 'floor', revealed: true })
  const options = {}
  if (chance(0.5)) options.locationId = pick(['', 'loc', '  x  '])
  if (chance(0.5)) options.seed = pick(['', 'legacy-seed', 'карта'])
  if (chance(0.2)) options.generator = { id: 'old', version: '3' }
  if (chance(0.2)) options.tilesetId = 'tiles'
  let outcome
  try {
    const map = t.tacticalMapFromLegacyCells(cells, options)
    const probes = probesFor(map)
    outcome = { probes, ok: analyze(map, probes, true) }
  } catch (error) {
    outcome = { error: errorOf(error) }
  }
  legacyRandom.push({ cells, options, outcome })
}

// --- мелочи -------------------------------------------------------------------

const variantSeeds = ['', 'seed', 'budget', 'карта-7', '12345', 'x'.repeat(300)]
const variants = []
for (let index = 0; index < 600; index += 1) {
  const seed = pick(variantSeeds)
  const x = pick([int(100), int(100), -int(50), 2 ** 31 + int(10), -(2 ** 31) - int(10), 4_294_967_296 + int(5)])
  const y = int(100)
  const span = pick([4, 4, 6, 1, 0, 13])
  variants.push([seed, x, y, span, t.floorVariantAt(seed, x, y, span)])
}
const surroundingsCases = [{ biome: 'sea' }, { biome: 'lava' }, { sides: { n: 'sea', e: 'forest', s: 'x', w: 'rock' } }, { biome: ['sea'], sides: { w: 'meadow', n: 'mountain' } }, null, 'x', [], {}, { sides: [] }, { biome: 'deadwood', sides: { q: 'sea' } }]
  .map((value) => [encode(value), encode(t.normalizeMapSurroundings(value))])
const sizeClasses = Array.from({ length: 200 }, () => {
  const width = int(120)
  const height = int(120)
  return [width, height, t.sizeClassFor(width, height)]
})
const canonical = Array.from({ length: 300 }, () => {
  const ax = int(10) - 2
  const ay = int(10) - 2
  const [dx, dy] = pick([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [0, 0], [2, 0]])
  return [ax, ay, ax + dx, ay + dy, tryOr(() => t.canonicalEdge(ax, ay, ax + dx, ay + dy))]
})

writeFixture(new URL('./tactical-map.json', import.meta.url), {
  constants: {
    version: t.TACTICAL_MAP_VERSION,
    surfaces: t.SURFACES,
    materials: t.MATERIALS,
    edgeKinds: t.EDGE_KINDS,
    coverLevels: t.COVER_LEVELS,
    doorStates: t.DOOR_STATES,
    zoneKinds: t.ZONE_KINDS,
    floorDirections: t.FLOOR_DIRECTIONS,
    spawnRoles: t.SPAWN_ROLES,
    floorStyles: t.FLOOR_STYLES,
    wallStyles: t.WALL_STYLES,
    surroundingsBiomes: t.SURROUNDINGS_BIOMES,
    maxLevelOffset: t.MAX_LEVEL_OFFSET,
    sizeClasses: t.SIZE_CLASSES,
    floorVariants: t.FLOOR_VARIANTS,
    entrySides: t.ENTRY_SIDES,
  },
  corpus,
  generated,
  dynamic,
  programs,
  garbage,
  legacyRandom,
  variants,
  surroundings: surroundingsCases,
  sizeClasses,
  canonical,
})

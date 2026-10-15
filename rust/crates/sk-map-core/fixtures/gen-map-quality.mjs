import '../../../fixtures-env.mjs'
import './recorder.mjs'
// Эталон server/map-quality.mjs для Rust:
//
//   node rust/crates/sk-map-core/fixtures/gen-map-quality.mjs
//
// Аудит готовых карт генераторов — в `generator-calls.json` (они проходят
// проверку чисто). Здесь — то, на чём проверка ловит плохие карты:
//
// - корпус: 56 нарисованных карт `data/authored-location-maps-v1.json`
//   (Rust читает файл данных сам) — аудит и проверка программы сцены;
// - порча: к карте корпуса, сгенерированной сцене или случайной планировке с
//   предметами применяется цепочка правок API — снять дверь, заложить проём,
//   поставить предмет в проём, за край, на глухую клетку, перед окном, кучку
//   одинаковых, окно между комнатами, стену, воду, уступ, настил, перенести
//   или убрать точку отряда — и снимаются оба отчёта;
// - программы сцен: корпус `test/fixtures/scene-programs/corpus.json` и
//   случайные (центр, посты, улики, количества), мусорные значения, мерка
//   масштаба и открытая сцена.
import { readFileSync } from 'node:fs'
import { hash, mulberry32, writeFixture } from './common.mjs'
import { randomLayout, sprinkleProps } from './layouts.mjs'

const t = await import('../../../../server/tactical-map.mjs')
const quality = await import('../../../../server/map-quality.mjs')
const { thinWalls } = await import('../../../../server/thin-walls.mjs')
const { generateSceneGeometry } = await import('../../../../server/adventure-director.mjs')
const { SCENE_REQUIREMENT_KINDS, sceneMapRequirementsFor } = await import('../../../../server/scene-requirements.mjs')

const random = mulberry32(2026_10_45)
const int = (n) => Math.floor(random() * n)
const pick = (items) => items[int(items.length)]
const chance = (p) => random() < p

// --- программы сцен -----------------------------------------------------------

const KIND_IDS = SCENE_REQUIREMENT_KINDS.map((kind) => kind.id)
const corpus = JSON.parse(readFileSync(new URL('../../../../test/fixtures/scene-programs/corpus.json', import.meta.url), 'utf8'))
const corpusPrograms = corpus.scenes.map((scene) => sceneMapRequirementsFor([scene.location, scene.text], { npcs: scene.npcs })).filter(Boolean)
function randomProgram() {
  if (chance(0.06)) return pick([null, 'x', [], { items: 'x' }, { focus: 5 }, [{ id: 'well' }, { id: 'well', count: 2 }]])
  if (chance(0.35)) return pick(corpusPrograms)
  const items = []
  for (let index = 0; index < int(6); index += 1) {
    const id = chance(0.1) ? 'nonsense' : pick(KIND_IDS)
    items.push(chance(0.3) ? { id, count: pick([1, 2, 3, 0, -1, 2.5, '2', 9]) } : { id })
  }
  const program = { version: 'scene-requirements/v3', items }
  if (chance(0.6)) program.focus = chance(0.8) && items.length ? pick(items).id : pick(KIND_IDS)
  if (chance(0.4)) program.posts = items.slice(0, 2).map((item, index) => ({ npc: `Житель ${index}`, id: item.id }))
  if (chance(0.4)) program.clues = items.slice(-2).map((item) => item.id)
  return program
}
const randomOptions = () => pick([
  undefined, {}, { minSize: quality.SETTLEMENT_MIN_SIZE, openScene: true }, { minSize: null, openScene: false },
  { minSize: { width: 10, height: 50 } }, { openScene: true }, { minSize: quality.SETTLEMENT_MIN_SIZE },
])

// --- порча карты ---------------------------------------------------------------

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
function randomOp(map) {
  const x = int(map.width)
  const y = int(map.height)
  const roll = random()
  const door = map.doors.length ? pick(map.doors) : null
  if (door && roll < 0.12) return { op: pick(['removeDoor', 'unhingeDoor']), index: map.doors.indexOf(door) }
  if (door && roll < 0.26) {
    const next = t.edgeNeighbor(door)
    const step = { x: next.x - door.x, y: next.y - door.y }
    const [px, py] = pick([[door.x, door.y], [next.x, next.y], [door.x - step.x, door.y - step.y], [next.x + step.x, next.y + step.y]])
    return { op: 'prop', prop: { id: `door-prop-${int(1000)}`, assetId: pick(['barrel', 'crate', 'table']), x: px + 0.5, y: py + 0.5, footprint: [{ x: px, y: py }], blocksMove: chance(0.85), cover: 'half' } }
  }
  if (roll < 0.34) {
    const [px, py] = pick([[-1, y], [map.width, y], [x, -1], [x, map.height], [map.width + 3, map.height + 3]])
    return { op: 'prop', prop: { id: `outside-${int(1000)}`, assetId: pick(['barrel', 'tree_oak', 'chest']), x: px + 0.5, y: py + 0.5, footprint: chance(0.8) ? [{ x: px, y: py }] : [], blocksMove: chance(0.7) } }
  }
  if (roll < 0.42) {
    const windows = t.edgeList(map).filter((edge) => edge.kind === 'window')
    const edge = windows.length && chance(0.8) ? pick(windows) : null
    const [px, py] = edge ? pick([[edge.x, edge.y], [t.edgeNeighbor(edge).x, t.edgeNeighbor(edge).y]]) : [x, y]
    return { op: 'prop', prop: { id: `blind-${int(1000)}`, assetId: pick(['wardrobe', 'bookshelf']), x: px + 0.5, y: py + 0.5, footprint: [{ x: px, y: py }], blocksMove: chance(0.8), blocksSight: true, cover: 'three_quarters', ...(chance(0.15) ? { mount: { kind: 'wall', side: 'n' } } : {}) } }
  }
  if (roll < 0.5) {
    const horizontal = chance(0.5)
    const asset = pick(['urn', 'barrel', 'tree_oak', 'bush', 'crate', 'statue', 'pillar', 'chair', 'brazier'])
    const props = Array.from({ length: 2 + int(4) }, (_, index) => {
      const px = x + (horizontal ? index : 0)
      const py = y + (horizontal ? 0 : index)
      return { id: `cluster-${int(1000)}-${index}`, assetId: asset, x: px + 0.5, y: py + 0.5, footprint: [{ x: px, y: py }], blocksMove: chance(0.5) }
    })
    return { op: 'props', props }
  }
  if (roll < 0.56) return { op: 'cell', x, y, patch: { passable: false } }
  if (roll < 0.6) return { op: 'cell', x, y, patch: chance(0.5) ? { surface: 'water', passable: false } : { surface: 'water' } }
  if (roll < 0.64) return { op: 'cell', x, y, patch: { moveCost: 2 } }
  if (roll < 0.69) return { op: 'cell', x, y, patch: { elevation: pick([5, 10, 15, -5, 3]) } }
  if (roll < 0.73) {
    // Настил: наружный деревянный пол выше земли.
    const cells = []
    const w = 1 + int(4)
    const h = 1 + int(3)
    for (let dy = 0; dy < h; dy += 1) for (let dx = 0; dx < w; dx += 1) if (x + dx < map.width && y + dy < map.height) cells.push({ x: x + dx, y: y + dy })
    return { op: 'cells', cells, patch: { material: 'wood', elevation: pick([2, 5]), passable: true } }
  }
  if (roll < 0.77) return { op: 'cell', x, y, patch: { zone: pick(['', ...map.zones.map((zone) => zone.id)]), passable: chance(0.7) } }
  if (roll < 0.85) {
    const [dx, dy] = pick(DIRS)
    const nx = x + dx
    const ny = y + dy
    return { op: 'edge', x, y, nx, ny, edge: pick([{ kind: 'window', blocksMove: true }, { kind: 'wall' }, { kind: 'none' }, { kind: 'door' }, { kind: 'ledge', blocksMove: false }]) }
  }
  if (roll < 0.9) return { op: 'spawn', x: pick([x, x, -1, map.width + 1]), y }
  if (roll < 0.92) return { op: 'dropSpawn' }
  if (roll < 0.95) return { op: 'prop', prop: { id: `nan-${int(1000)}`, assetId: 'barrel', y: y + 0.5, footprint: [], blocksMove: true } }
  if (roll < 0.97) return { op: 'prop', prop: { id: `float-${int(1000)}`, assetId: pick(['barrel', 'chair']), x: x + 0.75, y: y - 0.25, footprint: [], blocksMove: chance(0.5) } }
  return { op: 'prop', prop: { id: `stairs-${int(1000)}`, assetId: 'stairs_up', x: x + 0.5, y: y + 0.5, footprint: [{ x, y }], transition: { toLevel: 1 }, blocksMove: true } }
}

function applyOp(map, op) {
  switch (op.op) {
    case 'removeDoor':
    case 'unhingeDoor': {
      // Снять дверь и заложить проём стеной — или оставить пустой проём.
      const [door] = map.doors.splice(op.index, 1)
      const next = t.edgeNeighbor(door)
      t.setEdge(map, door.x, door.y, next.x, next.y, { kind: op.op === 'removeDoor' ? 'wall' : 'none' })
      return
    }
    case 'prop': t.addProp(map, op.prop); return
    case 'props': for (const prop of op.props) t.addProp(map, prop); return
    case 'cell': t.setCell(map, op.x, op.y, op.patch); return
    case 'cells': for (const cell of op.cells) t.setCell(map, cell.x, cell.y, op.patch); return
    case 'edge': t.setEdge(map, op.x, op.y, op.nx, op.ny, op.edge); return
    case 'spawn': {
      const party = map.spawnPoints.find((point) => point.role === 'party')
      if (party) Object.assign(party, { x: op.x, y: op.y })
      return
    }
    case 'dropSpawn': map.spawnPoints = map.spawnPoints.filter((point) => point.role !== 'party'); return
    default: throw new Error(`операция ${op.op}`)
  }
}

/** Оба отчёта и настилы карты; числа аудита после первой сотни — хешем. */
let reports = 0
function reportsOf(map, program, options) {
  const audit = quality.auditTacticalMap(map)
  reports += 1
  return {
    audit: reports <= 120 ? audit : { ...audit, stats: hash(audit.stats) },
    programReport: quality.programReport(map, program, options),
    platforms: [hash(quality.platformCells(map)), quality.countPlatforms(map)],
  }
}

function corrupt(base, label, count) {
  const cases = []
  for (let index = 0; index < count; index += 1) {
    const map = t.deserializeTacticalMap(base)
    const ops = []
    // Правки строятся в границах карты и по объявленным зонам: API их не
    // отвергает, и Rust повторяет их тем же порядком.
    for (let step = 0; step < 1 + int(4); step += 1) {
      const op = randomOp(map)
      applyOp(map, op)
      ops.push(op)
    }
    const program = randomProgram()
    const options = randomOptions()
    cases.push({ label: `${label}/${index}`, ops, program: program === undefined ? null : program, options: options ?? null, ...reportsOf(map, program, options) })
  }
  return cases
}

// --- корпус ---------------------------------------------------------------------

const catalog = JSON.parse(readFileSync(new URL('../../../../data/authored-location-maps-v1.json', import.meta.url), 'utf8'))
const authored = catalog.maps.map((raw, index) => {
  const map = t.deserializeTacticalMap(raw)
  const program = corpusPrograms[index % corpusPrograms.length]
  return { index, locationId: map.locationId, program, options: index % 3 ? null : { minSize: quality.SETTLEMENT_MIN_SIZE, openScene: true }, ...reportsOf(map, program, index % 3 ? undefined : { minSize: quality.SETTLEMENT_MIN_SIZE, openScene: true }) }
})
const authoredCases = catalog.maps.flatMap((raw, index) => corrupt(raw, `authored:${index}`, 7))

// --- сгенерированные сцены ----------------------------------------------------

const generated = []
for (const preset of quality.MAP_PREVIEW_PRESETS) {
  const { map } = generateSceneGeometry({ ...preset.input, map: { ...(preset.input.map ?? {}), width: 16, height: 14 }, seed: `${preset.id}:quality`, useLibrary: false })
  generated.push({ label: preset.id, map: JSON.parse(JSON.stringify(t.serializeTacticalMap(map))) })
}
const generatedCases = generated.flatMap((entry, index) => corrupt(entry.map, `generated:${index}`, 12))

// --- случайные планировки с предметами ----------------------------------------

const layouts = []
for (let index = 0; index < 160; index += 1) {
  const map = randomLayout(t, random, `quality:${index}`)
  if (chance(0.7)) thinWalls(map)
  sprinkleProps(t, map, random)
  if (chance(0.3)) t.addZone(map, { id: 'street', kind: 'exterior', material: 'stone' })
  if (chance(0.3)) t.addZone(map, { id: 'path', kind: 'exterior', material: 'earth' })
  for (const zone of ['street', 'path']) {
    if (!map.zones.some((entry) => entry.id === zone)) continue
    for (let cell = 0; cell < 4 + int(10); cell += 1) {
      const x = int(map.width)
      const y = int(map.height)
      if (t.cellAt(map, x, y)?.passable && t.cellAt(map, x, y)?.zone === 'yard') t.setCell(map, x, y, { zone })
    }
  }
  layouts.push(JSON.parse(JSON.stringify(t.serializeTacticalMap(map))))
}
const layoutCases = layouts.flatMap((raw, index) => {
  const map = t.deserializeTacticalMap(raw)
  const program = randomProgram()
  const options = randomOptions()
  return [
    { label: `layout:${index}`, ops: [], program: program ?? null, options: options ?? null, ...reportsOf(map, program, options) },
    ...corrupt(raw, `layout:${index}`, 2),
  ]
})

writeFixture(new URL('./map-quality.json', import.meta.url), {
  constants: {
    multiRoomMinCells: quality.MULTI_ROOM_MIN_CELLS,
    stepWithoutClimbFeet: quality.STEP_WITHOUT_CLIMB_FEET,
    settlementMinSize: quality.SETTLEMENT_MIN_SIZE,
    focusMinRoom: quality.FOCUS_MIN_ROOM,
    previewPresets: quality.MAP_PREVIEW_PRESETS,
  },
  authored,
  generated,
  layouts,
  cases: [...authoredCases, ...generatedCases, ...layoutCases],
})
const codes = {}
for (const entry of [...authored, ...authoredCases, ...generatedCases, ...layoutCases]) {
  for (const problem of [...entry.audit.problems, ...entry.audit.warnings, ...entry.programReport.problems, ...entry.programReport.warnings]) codes[problem.code] = (codes[problem.code] ?? 0) + 1
}
console.log(codes)

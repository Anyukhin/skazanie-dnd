import '../../../fixtures-env.mjs'
// Эталон server/talespire-import.mjs для Rust:
//
//   node rust/crates/sk-talespire/fixtures/gen-talespire-import.mjs
//
// Настоящие слэбы в репозиторий не кладутся (чужие постройки), поэтому слэбы
// собирает кодировщик `test/talespire-fixtures.mjs`:
//
// - дома и отказы из `test/talespire-import.test.mjs`;
// - сотни случайных построек из ассетов таблицы: пол разных размеров и
//   материалов, подвал и верхние этажи, марши ступеней и стремянки, тонкие и
//   толстые стены, двери, окна, ограды, «стена + пол», крыши, предметы,
//   камни, декор, незнакомые ассеты; v2, v1 и v1 «как есть», обрамление из
//   мессенджера и мусор вместо слэба;
// - паспорт, оценка качества и ремонт этажа на картах импорта и их правках,
//   подписи комнат на случайной обстановке.
//
// Карта в аргументах и итогах — сериализованная (`serializeTacticalMap`);
// крупный итог хранится SHA-256 строки `JSON.stringify`.
import { readFileSync } from 'node:fs'

import { fixtureWriter, mulberry32, chooser } from './lib.mjs'

const root = new URL('../../../../', import.meta.url)
const T = await import(new URL('server/talespire-import.mjs', root).href)
const { decodeSlab } = await import(new URL('server/talespire-slab.mjs', root).href)
const M = await import(new URL('server/tactical-map.mjs', root).href)
const Q = await import(new URL('server/map-quality.mjs', root).href)
const F = await import(new URL('test/talespire-fixtures.mjs', root).href)

const writer = fixtureWriter('talespire-import', [])
const random = mulberry32(2026_10_16)
const { int, pick, chance } = chooser(random)
const TABLE = JSON.parse(readFileSync(new URL('data/talespire-assets-v1.json', root), 'utf8')).assets
const ROWS = Object.entries(TABLE).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([id, row]) => ({ id, row }))
const byRole = (kind, role, predicate = () => true) => ROWS.filter(({ row }) => row[0] === kind && row[1] === role && predicate(row))
const near = (value, expected) => Math.abs(value - expected) < 0.01

const POOLS = {
  floor1: byRole('t', 'floor', (row) => near(row[5], 0.5) && near(row[7], 0.5) && row[6] <= 0.3),
  floorAny: byRole('t', 'floor'),
  wallThin: byRole('t', 'wall', (row) => near(row[5], 0.25) && near(row[7], 0.5) && row[6] >= 0.8),
  wallAny: byRole('t', 'wall'),
  door: byRole('t', 'door', (row) => near(row[5], 0.5) && near(row[7], 0.25) && row[6] >= 0.8),
  doorAny: byRole('t', 'door'),
  window: byRole('t', 'window'),
  fence: byRole('t', 'fence'),
  stairs: byRole('t', 'stairs', (row) => near(row[5], 0.5) && near(row[7], 0.5)),
  stairsAny: byRole('t', 'stairs'),
  roof: byRole('t', 'roof'),
  wallfloor: byRole('t', 'wallfloor'),
  hatch: byRole('t', 'hatch'),
  prop: byRole('p', 'prop'),
  decor: byRole('p', 'decor'),
  rock: byRole('p', 'rock'),
  ladder: byRole('p', 'ladder'),
}
for (const [name, pool] of Object.entries(POOLS)) if (!pool.length) throw new Error(`нет ассетов ${name}`)
const asset = (pool) => {
  const entry = pick(pool)
  return { id: entry.id, row: entry.row }
}
const UNKNOWN = { id: '00000000-0000-0000-0000-00000000beef', row: ['t', 'floor', 0.5, 0.25, 0.5, 0.5, 0.25, 0.5, 'stone', ''] }

// ---------------------------------------------------------------------------
// Случайная постройка

function building() {
  const placements = []
  // v2 пакует координаты без знака: отрицательное прижимается к нулю.
  const put = (entry, x, y, z, rotation = 0) => placements.push({ asset: entry, x: Math.max(0, Math.round(x * 100) / 100), y: Math.max(0, Math.round(y * 100) / 100), z: Math.max(0, Math.round(z * 100) / 100), rotation })
  const width = int(4, chance(0.1) ? 70 : 28)
  const depth = int(4, chance(0.1) ? 50 : 24)
  const floor = asset(chance(0.8) ? POOLS.floor1 : POOLS.floorAny)
  const holes = chance(0.3)
  const groundY = pick([0, 0, 0, 1, 2.5, 3, 7.25])
  for (let x = 0; x < width; x += 1) {
    for (let z = 0; z < depth; z += 1) {
      if (holes && chance(0.05)) continue
      put(chance(0.05) ? asset(POOLS.floor1) : floor, x, groundY + (chance(0.04) ? pick([0.25, 0.5, -0.25]) : 0), z)
    }
  }
  // Подложка под полом.
  if (chance(0.2)) for (let x = 0; x < width; x += 2) for (let z = 0; z < depth; z += 2) put(floor, x, groundY - 0.5, z)
  const top = groundY + 0.5
  // Помост.
  if (chance(0.3)) {
    const px = int(0, width - 2)
    const pz = int(0, depth - 2)
    for (let x = px; x < Math.min(width, px + int(2, 6)); x += 1) for (let z = pz; z < Math.min(depth, pz + int(2, 5)); z += 1) put(floor, x, groundY + pick([0.5, 1, 1.5, 3]), z)
  }
  // Верхние этажи и подвал.
  const storeys = []
  for (const shift of [2.5, 5, -2.5, 7.5, 10, 12.5]) {
    if (!chance(shift === 2.5 ? 0.6 : shift === -2.5 ? 0.3 : 0.15)) continue
    const sx = int(0, Math.max(0, width - 3))
    const sz = int(0, Math.max(0, depth - 3))
    const sw = int(2, Math.max(2, width - sx))
    const sd = int(2, Math.max(2, depth - sz))
    const storeyFloor = asset(POOLS.floor1)
    for (let x = sx; x < sx + sw; x += 1) for (let z = sz; z < sz + sd; z += 1) if (!chance(0.03)) put(storeyFloor, x, groundY + shift, z)
    storeys.push({ shift, sx, sz, sw, sd })
    // Марш ступеней или стремянка к этажу.
    if (chance(0.75)) {
      const stair = asset(chance(0.85) ? POOLS.stairs : POOLS.stairsAny)
      const steps = Math.round(Math.abs(shift) / 0.5)
      const along = chance(0.5)
      const bx = int(0, width - 1)
      const bz = int(0, depth - 1)
      const from = shift > 0 ? top : groundY + shift + 0.5
      for (let index = 0; index < Math.min(steps, int(2, 12)); index += 1) {
        put(stair, along ? bx : bx + index, from + index * 0.5, along ? bz + index : bz, along ? 0 : 90)
      }
    } else if (chance(0.7)) {
      const ladder = asset(POOLS.ladder)
      put(ladder, int(sx, sx + sw - 1), Math.min(top, groundY + shift), int(sz, sz + sd - 1), pick([0, 90, 180, 270]))
    }
    // Перекрытие над этажом.
    if (chance(0.4)) {
      const roof = asset(POOLS.roof)
      for (let x = sx; x < sx + sw; x += 2) for (let z = sz; z < sz + sd; z += 2) put(roof, x, groundY + shift + 2.5, z)
    }
  }
  // Стены: линии вдоль осей с дверями и окнами.
  const lines = int(0, 6)
  for (let line = 0; line < lines; line += 1) {
    const alongZ = chance(0.5)
    const wall = asset(chance(0.8) ? POOLS.wallThin : POOLS.wallAny)
    const at = int(0, alongZ ? width : depth)
    const span = alongZ ? depth : width
    const from = int(0, Math.max(0, span - 2))
    const to = int(from + 1, span)
    const level = chance(0.8) ? top : (storeys[0] ? groundY + storeys[0].shift + 0.5 : top)
    for (let along = from; along < to; along += 1) {
      const roll = random()
      const entry = roll < 0.08 ? asset(chance(0.8) ? POOLS.door : POOLS.doorAny) : roll < 0.14 ? asset(POOLS.window) : roll < 0.18 ? asset(POOLS.fence) : wall
      const rotation = alongZ ? (entry.row[1] === 'door' || entry.row[1] === 'window' ? 90 : 0) : (entry.row[1] === 'door' || entry.row[1] === 'window' ? 0 : 90)
      if (alongZ) put(entry, at - 0.25, level, along, chance(0.1) ? pick([0, 90, 180, 270]) : rotation)
      else put(entry, along, level, at - 0.25, chance(0.1) ? pick([0, 90, 180, 270]) : rotation)
    }
  }
  // Ограда по краю.
  if (chance(0.25)) {
    const fence = asset(POOLS.fence)
    for (let x = 0; x < width; x += 1) put(fence, x, top, -0.1, 90)
  }
  // Толстая стена и «стена + пол».
  if (chance(0.3)) put(asset(POOLS.wallAny), int(0, width - 1), top, int(0, depth - 1), pick([0, 90]))
  if (chance(0.3)) for (let i = 0; i < int(1, 8); i += 1) put(asset(POOLS.wallfloor), int(0, width - 1), groundY, int(0, depth - 1), pick([0, 90, 180, 270]))
  if (chance(0.15)) put(asset(POOLS.hatch), int(0, width - 1), top, int(0, depth - 1))
  // Предметы, камни, декор.
  for (let i = 0; i < int(0, chance(0.1) ? 300 : 40); i += 1) {
    const kind = random()
    const entry = kind < 0.6 ? asset(POOLS.prop) : kind < 0.8 ? asset(POOLS.decor) : asset(POOLS.rock)
    const level = chance(0.85) ? top : storeys.length ? groundY + pick(storeys).shift + 0.5 : top + 2
    put(entry, int(0, width - 1) + pick([0, 0.25, 0.5]), level + (chance(0.1) ? pick([0.5, 1.2, -0.7]) : 0), int(0, depth - 1) + pick([0, 0.25, 0.5]), int(0, 23) * 15)
  }
  if (chance(0.15)) put(UNKNOWN, int(0, width), top, int(0, depth))
  return placements
}

function wrap(text) {
  const roll = random()
  if (roll < 0.05) return `"""${text}"""`
  if (roll < 0.1) return `\`\`\`\n${text.replace(/(.{60})/gu, '$1\n')}\n\`\`\``
  if (roll < 0.13) return `  ${text}  `
  return text
}

const OPTIONS = [
  undefined, {}, { locationId: 'loc-house' }, { locationId: 'loc-crypt', underground: true }, { theme: 'tavern', levelLabels: { 1: 'Чердак', '-1': '  Погреб с бочками  ' } },
  { levelLabels: { 0: 'x'.repeat(80) } }, { underground: 1 }, { locationId: 'loc-ship', theme: 'harbor', levelLabels: { 2: '' } },
]

// ---------------------------------------------------------------------------
// Импорт

function importCase(text, options) {
  return writer.call('importTaleSpireSlab', (...args) => T.importTaleSpireSlab(...args), options === undefined ? [text] : [text, options])
}

const slabs = []
const remember = (text) => {
  if (typeof text === 'string' && slabs.length < 400) slabs.push(text)
}

// Тесты модуля.
const house = F.housePlacements()
importCase(F.HOUSE_SLAB)
importCase(F.HOUSE_SLAB, { locationId: 'loc-house' })
importCase(F.encodeSlabV1(house), { locationId: 'loc-house' })
importCase(F.encodeSlabV2(house.filter((placement) => placement.asset !== F.ASSETS.stairs)))
importCase(F.encodeSlabV2([...house, { asset: UNKNOWN, x: 20, y: 0, z: 0 }]))
importCase(F.encodeSlabV2([{ asset: UNKNOWN, x: 0, y: 0, z: 0 }]))
importCase(F.encodeSlabV2([{ asset: F.ASSETS.wallAlongZ, x: 0, y: 0, z: 0 }]))
importCase(F.encodeSlabV2(Array.from({ length: 101 }, (_, x) => ({ asset: F.ASSETS.floor, x, y: 0, z: 0 }))))
importCase(F.encodeSlabV1Raw([{ asset: F.ASSETS.floor, center: [5, 0.25, 5], extent: [900, 0.25, 900] }]))
importCase(F.encodeSlabV1Raw([{ asset: F.ASSETS.floor, center: [999_000, 0.25, -999_000], extent: [3, 0.25, 3] }]))
remember(F.HOUSE_SLAB)
for (const garbage of [undefined, null, '', '   ', 'не слэб', 'H4sI', 42, {}, 'A'.repeat(100), F.HOUSE_SLAB.slice(0, 40)]) importCase(garbage)

for (let index = 0; index < 340; index += 1) {
  const placements = building()
  const roll = random()
  let text
  if (roll < 0.15) text = F.encodeSlabV1(placements.map((placement) => ({ ...placement, rotation: Math.round(placement.rotation / 90) * 90 })))
  else if (roll < 0.2) text = F.encodeSlabV1Raw(placements.slice(0, 400).map((placement) => ({ asset: placement.asset, center: [placement.x + 0.5, placement.y + 0.25, placement.z + 0.5], extent: [Math.abs(placement.asset.row[5]) || 0.5, Math.abs(placement.asset.row[6]) || 0.25, Math.abs(placement.asset.row[7]) || 0.5] })))
  else text = F.encodeSlabV2(placements)
  const wrapped = wrap(text)
  importCase(wrapped, pick(OPTIONS))
  remember(wrapped)
}
console.log('импорт:', writer.counts.get('importTaleSpireSlab'))

// Коробки слэба.
const table = T.taleSpireAssetTable()
for (const text of slabs) {
  let slab
  try { slab = decodeSlab(text) } catch { continue }
  writer.call('worldBoxesForSlab', (value) => T.worldBoxesForSlab(decodeSlab(value), table), [text])
}

// ---------------------------------------------------------------------------
// Паспорт, качество, ремонт

const serialize = (map) => M.serializeTacticalMap(map)
const deserialize = (value) => M.deserializeTacticalMap(value)
const levelSets = []
for (const text of slabs) {
  let result
  try { result = T.importTaleSpireSlab(text) } catch { continue }
  levelSets.push({ maps: result.levels.map((level) => level.map), stats: result.stats })
}
for (const { maps } of levelSets) for (const map of maps) writer.call('auditTacticalMap', (value) => Q.auditTacticalMap(deserialize(value)), [map])
for (const { maps, stats } of levelSets.slice(0, 200)) {
  writer.call('mapPassport', (values) => T.mapPassport(values.map(deserialize)), [maps])
  if (maps.length > 1 && chance(0.3)) writer.call('mapPassport', (values) => T.mapPassport(values.map(deserialize)), [[...maps].reverse()])
  writer.call('importQuality', (value, counts) => T.importQuality(deserialize(value), counts), [maps[0], stats])
  if (chance(0.2)) writer.call('importQuality', (value, counts) => T.importQuality(deserialize(value), counts), [maps[0], { instances: pick([0, '7', null, 'x']), unknown: pick([1, '2', null]), propsSkipped: pick([3, undefined, 'y']) }])
}

const repair = (value, counts) => {
  const map = deserialize(value)
  const stats = { ...counts }
  T.repairImportedLevel(map, stats)
  return { map: serialize(map), stats }
}
function grassLevel(width = 10, height = 8) {
  const map = M.createTacticalMap({ width, height, locationId: 'repair', seed: 'repair' })
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) M.setCell(map, x, y, { passable: true, material: 'grass' })
  return map
}
{
  const ramp = grassLevel()
  for (const [x, y] of [[5, 3], [6, 3], [5, 4], [6, 4]]) M.setCell(ramp, x, y, { elevation: 5 })
  writer.call('repairImportedLevel', repair, [serialize(ramp), {}])
  const tower = grassLevel()
  for (const [x, y] of [[5, 3], [6, 3]]) M.setCell(tower, x, y, { elevation: 15 })
  writer.call('repairImportedLevel', repair, [serialize(tower), {}])
  const edge = grassLevel()
  M.addProp(edge, { id: 'barrel-edge', assetId: 'barrel', x: 0.5, y: 3.5, footprint: [{ x: 0, y: 3 }], blocksMove: true })
  M.addProp(edge, { id: 'statue-corner', assetId: 'statue', x: 9.5, y: 7.5, footprint: [{ x: 9, y: 7 }], blocksMove: true })
  M.addProp(edge, { id: 'crate-blocker', assetId: 'crate', x: 8.5, y: 6.5, footprint: [{ x: 8, y: 6 }], blocksMove: true })
  writer.call('repairImportedLevel', repair, [serialize(edge), {}])
}
const PROP_IDS = ['barrel', 'crate', 'statue', 'table_small', 'chair', 'bed', 'altar', 'bookshelf']
for (let index = 0; index < 260; index += 1) {
  const base = chance(0.5) && levelSets.length ? deserialize(pick(pick(levelSets).maps)) : grassLevel(int(4, 24), int(4, 20))
  for (let k = 0; k < int(0, 14); k += 1) {
    const x = int(0, base.width - 1)
    const y = int(0, base.height - 1)
    const cell = M.cellAt(base, x, y)
    if (!cell) continue
    const roll = random()
    if (roll < 0.5) for (let dx = 0; dx < int(1, 4); dx += 1) for (let dy = 0; dy < int(1, 4); dy += 1) { if (M.cellAt(base, x + dx, y + dy)) M.setCell(base, x + dx, y + dy, { elevation: pick([4, 5, 6, 10, 15, 20, -5, -10]) }) }
    else if (roll < 0.6) M.setCell(base, x, y, { surface: 'water' })
    else if (roll < 0.7) M.setCell(base, x, y, { passable: false })
    else if (roll < 0.8 && M.cellAt(base, x + 1, y)) M.setEdge(base, x, y, x + 1, y, { kind: 'wall' })
    else {
      const px = pick([0, base.width - 1, x])
      const py = pick([0, base.height - 1, y])
      if (!M.cellAt(base, px, py)) continue
      try {
        M.addProp(base, { id: `edge-${k}`, assetId: pick(PROP_IDS), x: px + 0.5, y: py + 0.5, footprint: [{ x: px, y: py }, ...(chance(0.3) && M.cellAt(base, px, py + 1) ? [{ x: px, y: py + 1 }] : [])], blocksMove: chance(0.6), ...(chance(0.05) ? { transition: { toLevel: 1, label: 'Верх' } } : {}) })
      } catch { /* предмет не встал */ }
    }
  }
  writer.call('repairImportedLevel', repair, [serialize(base), chance(0.3) ? { ramps: pick([1, '2', null]), sealedCells: pick([3, undefined]) } : {}])
}

// ---------------------------------------------------------------------------
// Подписи комнат

const ROOM_PROPS = ['chair', 'stool', 'bench', 'table_round', 'table_long', 'table_small', 'sarcophagus', 'crypt_niche', 'grave', 'bone_pile', 'market_stall',
  'stalagmite', 'mushroom_cluster', 'tree_oak', 'tree_pine', 'tree_birch', 'tree_dead', 'tree_spruce', 'campfire', 'woodpile', 'altar', 'statue', 'reliquary',
  'bed', 'bunk_bed', 'bar_counter', 'royal_throne', 'prayer_bench', 'fireplace', 'cauldron', 'pot', 'cutting_board', 'cupboard', 'bookshelf', 'barrel',
  'barrel_stack', 'keg', 'crate', 'crate_stack', 'sack', 'rug']
const MATERIALS = ['stone', 'wood', 'earth', 'grass', 'sand', 'marble', 'metal', 'ice', 'lava']
for (let index = 0; index < 1_500; index += 1) {
  const props = {}
  for (let k = 0; k < int(0, 6); k += 1) props[pick(ROOM_PROPS)] = int(0, 4)
  const room = { cells: pick([1, 4, 8, 9, 39, 40, 119, 120, 399, 400, int(1, 900)]), interior: chance(0.6), level: pick([0, 0, 1, -1, -2]), material: pick(MATERIALS), ...(chance(0.25) ? { underground: true } : {}) }
  writer.call('roomLabelFor', (...args) => T.roomLabelFor(...args), [props, room])
}

writer.write(new URL('./talespire-import.json.gz', import.meta.url), {
  constants: { TALESPIRE_IMPORT_VERSION: T.TALESPIRE_IMPORT_VERSION, TALESPIRE_MAX_SOURCE_CELLS: T.TALESPIRE_MAX_SOURCE_CELLS },
})

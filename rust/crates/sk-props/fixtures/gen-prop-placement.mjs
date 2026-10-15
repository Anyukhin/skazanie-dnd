import '../../../fixtures-env.mjs'
// Эталон `server/prop-placement.mjs` → `fixtures/prop-placement.json`.
//
// - `math`: `(n) ** 1.6` (веса добора) и `Math.hypot` на дробных разностях
//   (сортировка опор) — побитно, чтобы Rust считал так же, как V8;
// - `maps`: синтетические карты (`synthetic-maps.mjs`) — входы;
// - `cases`: вызовы `placeProps`, `ensurePropAccess`, `placeColonnade`,
//   `placeRequiredProps`, `attachPropSupports` над синтетическими картами,
//   нарисованными картами `data/authored-location-maps-v1.json` (Rust читает
//   их из файла данных) и над выходом прежних случаев (`from`) — хеш карты
//   после, ответ и отказ;
// - `scenarios`: карты переносимых тестов `test/prop-placement.test.mjs`,
//   `test/new-detail-props-placement.test.mjs`, `test/prop-supports.test.mjs`.
//
// Запуск: node rust/crates/sk-props/fixtures/gen-prop-placement.mjs
import { readFileSync } from 'node:fs'

import { listAssets } from '../../../../server/asset-registry.mjs'
import * as pp from '../../../../server/prop-placement.mjs'
import * as t from '../../../../server/tactical-map.mjs'
import { decodeJs, encodeJs, hash, mulberry32, restore, runOn, writeFixture } from './common.mjs'
import { ALL_ASSETS, ALL_THEMES, picker, syntheticMap } from './synthetic-maps.mjs'

const random = mulberry32(0x5eed_9a11)
const { pick, int, chance } = picker(random)

// --- математика ------------------------------------------------------------------

const bits = (value) => {
  const buffer = Buffer.alloc(8)
  buffer.writeDoubleLE(value)
  return buffer.readBigUInt64LE().toString(16)
}
const pow = []
for (let n = 1; n <= 2000; n += 1) pow.push([n, bits(n ** 1.6), bits(1 / (n ** 1.6))])
// Хвост до 20000 — одной строкой по 16 знаков: столько экземпляров одного
// вида бывает лишь на карте-регионе.
const powTail = { from: 2001, to: 20000, bits: Array.from({ length: 18000 }, (_, index) => bits((index + 2001) ** 1.6).padStart(16, "0")).join("") }
const hypot = []
for (let index = 0; index < 3000; index += 1) {
  const a = index < 1500 ? int(-16, 16) / 2 - (int(-8, 8) + random()) : (random() - 0.5) * 20
  const b = index < 1500 ? int(-16, 16) / 2 - (int(-8, 8) + 0.5) : (random() - 0.5) * 20
  hypot.push([bits(a), bits(b), bits(Math.hypot(a, b))])
}

// --- заявки ------------------------------------------------------------------------

const PURPOSES = ['gallery', 'barracks', 'mill', 'forge', 'cells', 'guardroom', 'torture', 'altar', 'nave', 'dining', 'study', 'shop', 'bedroom', 'living', 'kitchen', 'store', 'stable', 'workshop', 'courtyard', 'exterior', 'camp', 'winter', 'siege', 'harbor', 'desert', 'swamp', 'laboratory',
  'hall', 'main_hall', ' Main-Hall ', 'GREAT hall', 'war-room', 'sleeping', 'storage', 'warehouse', 'storehouse', 'stables', 'smithy', 'prison', 'sanctum', 'library', 'yard', 'lab', 'alchemy', 'encampment', 'docks', 'pier', 'marsh', 'bog', 'dunes',
  'castle', 'constructor', 'toString', '__proto__', '', '  ']
const TAGS = ['hall', 'throne', 'maps', 'military', 'sleeping', 'soldiers', 'beds', 'cooking', 'hearth', 'food', 'storage', 'supplies', 'crates', 'barrels', 'horses', 'animals', 'fodder', 'forge', 'tools', 'craft', 'courtyard', 'yard', 'outside', 'camp', 'winter', 'snow', 'siege', 'harbor', 'port', 'docks', 'desert', 'sand', 'dunes', 'swamp', 'marsh', 'bog', 'laboratory', 'lab', 'alchemy', 'arcane', 'wizard', 'Hall', 'unknown', 'constructor', 'war room']
const FAVOURITES = ['table_round', 'table_long', 'table_small', 'chair', 'stool', 'bench', 'bar_counter', 'fireplace', 'bed', 'bunk_bed', 'chest', 'barrel', 'crate', 'crate_stack', 'barrel_stack', 'tree_oak', 'tree_pine', 'bush', 'shrub', 'boulder', 'rock_small', 'well', 'cart', 'haystack', 'water_trough', 'hitching_post', 'market_stall', 'pillar', 'altar', 'statue', 'mug', 'candle', 'book_piles', 'alchemy_bottles', 'torch_wall', 'banner', 'wall_ivy', 'stairs_up', 'writing_desk', 'shop_counter', 'forge', 'anvil', 'quench_tub', 'coal_pile', 'kitchen_stove', 'prep_table', 'pantry_shelf', 'nope']

function assetList(max) {
  const list = []
  const count = int(0, max)
  for (let index = 0; index < count; index += 1) list.push(chance(0.6) ? pick(FAVOURITES) : pick(ALL_ASSETS))
  return list
}

function randomPlan(map) {
  const zone = map.zones.length && chance(0.95) ? pick(map.zones).id : pick(['nowhere', ''])
  const plan = { zoneId: zone }
  plan.theme = chance(0.9) ? pick(ALL_THEMES) : pick(['', 'unknown'])
  const densityRoll = random()
  if (densityRoll < 0.85) plan.density = int(0, 90)
  else if (densityRoll < 0.9) plan.density = -5
  else if (densityRoll < 0.95) plan.density = '25'
  // иначе плотности нет (`undefined`)
  if (chance(0.5)) plan.purpose = pick(PURPOSES)
  if (chance(0.2)) plan.tags = Array.from({ length: int(1, 3) }, () => pick(TAGS))
  if (chance(0.5)) plan.require = assetList(6)
  if (chance(0.3)) plan.prefer = assetList(9)
  if (chance(0.3)) {
    plan.caps = {}
    for (const id of assetList(4)) plan.caps[id] = pick([0, 1, 2, 3, 4, null, '2', Number.POSITIVE_INFINITY])
  }
  if (chance(0.25)) plan.extraThemes = Array.from({ length: int(1, 3) }, () => pick(ALL_THEMES))
  return plan
}

// --- случаи --------------------------------------------------------------------------

const maps = []
const cases = []
/** Выход случаев — для цепочек `from`. */
const outputs = []

function record(input, op, args, run) {
  const map = input.map !== undefined ? restore(maps[input.map]) : input.authored !== undefined ? t.deserializeTacticalMap(authored[input.authored]) : restore(outputs[input.from])
  const entry = { input, op, args: encodeJs(args), ...runOn(map, run) }
  cases.push(entry)
  outputs.push(t.serializeTacticalMap(map))
  return cases.length - 1
}

const ops = {
  placeProps: (args) => (map) => pp.placeProps(map, args[0]),
  ensurePropAccess: () => (map) => pp.ensurePropAccess(map),
  placeColonnade: (args) => (map) => pp.placeColonnade(map, args[0]),
  placeRequiredProps: (args) => (map) => pp.placeRequiredProps(map, args[0], args[1]),
  attachPropSupports: () => (map) => pp.attachPropSupports(map),
}

function call(input, op, args) {
  return record(input, op, args, ops[op](decodeJs(encodeJs(args))))
}

const authored = JSON.parse(readFileSync(new URL('../../../../data/authored-location-maps-v1.json', import.meta.url), 'utf8')).maps

for (let index = 0; index < 170; index += 1) {
  const map = syntheticMap(index, random)
  maps.push(t.serializeTacticalMap(map))
  const input = { map: index }
  const restored = restore(maps[index])
  for (let round = 0; round < 4; round += 1) {
    const options = { seed: `seed-${index}-${round}`, zones: Array.from({ length: int(1, 3) }, () => randomPlan(restored)) }
    if (chance(0.3)) options.maxProps = pick([1, 3, 5, 20, 60, 250, restored.props.length + 2])
    const placed = call(input, 'placeProps', [options])
    if (chance(0.6)) {
      const repaired = call({ from: placed }, 'ensurePropAccess', [])
      if (chance(0.3)) call({ from: repaired }, 'placeProps', [{ seed: `again-${index}-${round}`, zones: [randomPlan(restored)] }])
    }
  }
  call(input, 'ensurePropAccess', [])
  call(input, 'attachPropSupports', [])
  for (const zone of restored.zones) {
    if (chance(0.6)) call(input, 'placeColonnade', [{ zoneId: zone.id, ...(chance(0.7) ? {} : { assetId: pick(['pillar', 'statue', 'tree_oak', 'crate_stack', 'nope']) }), ...(chance(0.5) ? {} : { idPrefix: 'roof-post' }) }])
  }
  const wanted = Array.from({ length: int(1, 4) }, () => ({ assets: chance(0.8) ? [pick(FAVOURITES)] : [pick(['nope', 'zzz']), pick(ALL_ASSETS)], count: pick([1, 1, 2, 3, 0, -1]) }))
  call(input, 'placeRequiredProps', [wanted, { seed: `required-${index}` }])
}

// Нарисованные карты: ремонт, опоры, расстановка по всем зонам, колоннады,
// обещанное сценой.
const AUTHORED_THEMES = { building: ['interior', 'yard'], cave: ['cave', 'cave'], temple: ['temple', 'yard'], forest: ['forest', 'forest'], settlement: ['interior', 'settlement'], road: ['road', 'road'], crypt: ['crypt', 'graveyard'] }
authored.forEach((raw, index) => {
  const input = { authored: index }
  call(input, 'ensurePropAccess', [])
  call(input, 'attachPropSupports', [])
  const themes = AUTHORED_THEMES[raw.theme] ?? ['interior', 'yard']
  const zones = (raw.zones ?? []).map((zone) => ({ zoneId: zone.id, theme: zone.kind === 'interior' ? themes[0] : themes[1], density: int(5, 35), purpose: zone.id }))
  const placed = call(input, 'placeProps', [{ seed: `authored-${index}`, zones }])
  call({ from: placed }, 'ensurePropAccess', [])
  for (const zone of (raw.zones ?? []).slice(0, 6)) call(input, 'placeColonnade', [{ zoneId: zone.id }])
  call(input, 'placeRequiredProps', [[{ assets: ['well'], count: 1 }, { assets: ['altar', 'statue'], count: 2 }, { assets: ['cart'], count: 1 }, { assets: [pick(FAVOURITES)], count: 2 }], { seed: `authored-required-${index}` }])
})

// --- сценарии переносимых тестов --------------------------------------------------------

function tavernWithYard({ width = 16, height = 12 } = {}) {
  const map = t.createTacticalMap({ width, height, seed: 'tavern' })
  t.addZone(map, { id: 'hall', kind: 'interior', material: 'wood', label: 'Общий зал' })
  t.addZone(map, { id: 'yard', kind: 'exterior', material: 'grass', label: 'Участок' })
  const wallColumn = Math.floor(width / 2)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const border = x === 0 || y === 0 || x === width - 1 || y === height - 1
      const inside = x < wallColumn
      t.setCell(map, x, y, { passable: !border && x !== wallColumn, material: inside ? 'wood' : 'grass', zone: inside ? 'hall' : 'yard', revealed: true, variant: (x + y) % 6 })
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const own = t.cellAt(map, x, y)
      if (!own || own.passable) continue
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const neighbor = t.cellAt(map, x + dx, y + dy)
        if (neighbor?.passable) t.setEdge(map, x, y, x + dx, y + dy, { kind: 'wall', cover: 'three_quarters' })
      }
    }
  }
  return map
}

function tavernWithDoor() {
  const map = tavernWithYard()
  const wallColumn = Math.floor(map.width / 2)
  const y = Math.floor(map.height / 2)
  t.setCell(map, wallColumn, y, { passable: true, material: 'wood', zone: 'hall', revealed: true })
  t.setEdge(map, wallColumn - 1, y, wallColumn, y, { kind: 'none', blocksMove: false, blocksSight: false, cover: 'none' })
  t.setDoor(map, { id: 'yard-door', x: wallColumn, y, dir: 'e', state: 'closed' })
  return map
}

function gateWithFurnishedHall({ blockedCells = 1 } = {}) {
  const map = t.createTacticalMap({ width: 10, height: 7, seed: 'prop-access-gate' })
  t.addZone(map, { id: 'yard', kind: 'exterior', material: 'grass', label: 'Подход' })
  t.addZone(map, { id: 'hall', kind: 'interior', material: 'stone', label: 'Зал' })
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) t.setCell(map, x, y, { passable: false, material: x < 4 ? 'grass' : 'stone', zone: x < 4 ? 'yard' : 'hall', revealed: true })
  for (let x = 1; x <= 8; x += 1) t.setCell(map, x, 3, { passable: true, material: x < 4 ? 'grass' : 'stone', zone: x < 4 ? 'yard' : 'hall', revealed: true })
  t.addSpawnPoint(map, { id: 'party', x: 1, y: 3, role: 'party' })
  t.setDoor(map, { id: 'hall-gate', x: 4, y: 3, dir: 'e', state: 'open' })
  for (let index = 0; index < blockedCells; index += 1) {
    const x = 5 + index
    t.addProp(map, { id: `hall-table-${index}`, assetId: 'table_round', x: x + 0.5, y: 3.5, footprint: [{ x, y: 3 }], blocksMove: true, blocksSight: true })
    t.addProp(map, { id: `hall-mug-${index}`, assetId: 'mug', x: x + 0.5, y: 3.5, footprint: [], mount: { kind: 'surface', propId: `hall-table-${index}` } })
  }
  t.addProp(map, { id: 'outside-decoration', assetId: 'boulder', x: 0.5, y: 0.5, footprint: [{ x: 0, y: 0 }], blocksMove: true })
  return map
}

function stallsSquare() {
  const map = t.createTacticalMap({ width: 12, height: 12, seed: 'stalls' })
  t.addZone(map, { id: 'square', kind: 'exterior', material: 'stone', label: 'Площадь' })
  for (let y = 0; y < 12; y += 1) for (let x = 0; x < 12; x += 1) t.setCell(map, x, y, { passable: true, revealed: true, material: 'stone', zone: 'square' })
  t.addProp(map, { id: 'stall-old', assetId: 'market_stall', x: 6, y: 6, footprint: [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 5, y: 6 }, { x: 6, y: 6 }], blocksMove: true })
  return map
}

function detailRoom() {
  const map = t.createTacticalMap({ width: 8, height: 8, seed: 'new-detail-props' })
  t.addZone(map, { id: 'hall', kind: 'interior', material: 'wood', label: 'Зал' })
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) t.setCell(map, x, y, { passable: true, material: 'wood', zone: 'hall', revealed: true })
  return map
}

function supportsFixture() {
  const map = t.createTacticalMap({ width: 6, height: 6, seed: 'supports', catalogRevision: null })
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) t.setCell(map, x, y, { passable: true, revealed: true, elevation: 5 })
  t.addProp(map, { id: 'table', assetId: 'table_round', x: 2.5, y: 2.5, scale: 1.1, footprint: [{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 3 }], blocksMove: true })
  t.addProp(map, { id: 'mug', assetId: 'mug', x: 2.5, y: 2.5 })
  t.addProp(map, { id: 'plate', assetId: 'plate', x: 2.5, y: 2.5 })
  t.addProp(map, { id: 'candle', assetId: 'candle', x: 2.5, y: 2.5 })
  t.addProp(map, { id: 'lantern', assetId: 'lantern_wall', x: 2.5, y: 1.5, rotation: 180 })
  t.setEdge(map, 2, 1, 2, 0, { kind: 'wall', blocksMove: true, blocksSight: true })
  return map
}

const PLAN = [
  { zoneId: 'hall', theme: 'interior', density: 18, require: ['table_round', 'chair', 'bar_counter', 'fireplace'] },
  { zoneId: 'yard', theme: 'yard', density: 10, require: ['tree_oak', 'bush'] },
]
const scenarios = {
  tavernWithYard: t.serializeTacticalMap(tavernWithYard()),
  tavernWithYardWide: t.serializeTacticalMap(tavernWithYard({ width: 20, height: 14 })),
  tavernWithDoor: t.serializeTacticalMap(tavernWithDoor()),
  gate1: t.serializeTacticalMap(gateWithFurnishedHall()),
  gate2: t.serializeTacticalMap(gateWithFurnishedHall({ blockedCells: 2 })),
  stalls: t.serializeTacticalMap(stallsSquare()),
  detailRoom: t.serializeTacticalMap(detailRoom()),
  supports: t.serializeTacticalMap(supportsFixture()),
}
// Карты сценариев тоже входы: их случаи сверяются хешем, как прочие.
const scenarioIndex = {}
for (const [name, serialized] of Object.entries(scenarios)) {
  scenarioIndex[name] = maps.length
  maps.push(serialized)
}
for (const seed of ['same', 'other', 'seed-1', 'density', 'budget']) call({ map: scenarioIndex.tavernWithYard }, 'placeProps', [{ seed, zones: PLAN, maxProps: seed === 'budget' ? 5 : 250 }])
call({ map: scenarioIndex.tavernWithYard }, 'placeProps', [{ seed: 'density', zones: [{ zoneId: 'hall', theme: 'interior', density: 30 }, { zoneId: 'yard', theme: 'yard', density: 2 }] }])
call({ map: scenarioIndex.tavernWithYard }, 'placeProps', [{ seed: 'gallery-purpose', zones: [{ zoneId: 'hall', theme: 'interior', purpose: 'gallery', density: 55 }] }])
for (const purpose of ['kitchen', 'store', 'barracks']) call({ map: scenarioIndex.tavernWithYardWide }, 'placeProps', [{ seed: `${purpose}-purpose`, zones: [{ zoneId: 'hall', theme: 'interior', purpose, density: 45 }] }])
for (const purpose of ['stable', 'exterior']) call({ map: scenarioIndex.tavernWithYardWide }, 'placeProps', [{ seed: `${purpose}-purpose`, zones: [{ zoneId: 'yard', theme: 'yard', purpose, density: 32 }] }])
call({ map: scenarioIndex.tavernWithDoor }, 'placeProps', [{ seed: 'door-clearance', zones: [{ zoneId: 'hall', theme: 'interior', purpose: 'gallery', density: 70 }, { zoneId: 'yard', theme: 'yard', purpose: 'courtyard', density: 35 }] }])
call({ map: scenarioIndex.gate1 }, 'ensurePropAccess', [])
call({ map: scenarioIndex.gate2 }, 'ensurePropAccess', [])
call({ map: scenarioIndex.stalls }, 'placeProps', [{ seed: 'stalls', zones: [{ zoneId: 'square', theme: 'settlement', density: 40, require: Array(6).fill('market_stall'), caps: { market_stall: 6 } }] }])
call({ map: scenarioIndex.detailRoom }, 'placeProps', [{ seed: 'no-surface', zones: [{ zoneId: 'hall', theme: 'study', density: 40, prefer: ['book_piles', 'scroll_pile', 'single_book', 'desk_candlestick', 'globe'] }] }])
call({ map: scenarioIndex.supports }, 'attachPropSupports', [])

// Предмет без координаты: `Number(undefined)` — NaN. Настенный предмет с NaN
// роняет `attachPropSupports` (canonicalEdge не находит соседства).
for (const [index, prop] of [
  { id: 'nan-torch', assetId: 'torch_wall', footprint: [] },
  { id: 'nan-y-banner', assetId: 'banner', x: 2.5, footprint: [] },
  { id: 'nan-mug', assetId: 'mug', footprint: [] },
  { id: 'nan-book', assetId: 'book_piles', y: 3.5, footprint: [] },
  { id: 'far-torch', assetId: 'torch_wall', x: 1e300, y: 2.5, rotation: 270, footprint: [] },
  { id: 'neg-torch', assetId: 'lantern_wall', x: -0.5, y: 2.5, rotation: 90, footprint: [] },
].entries()) {
  const raw = structuredClone(scenarios.supports)
  raw.props.push(prop)
  maps.push(raw)
  call({ map: maps.length - 1 }, 'attachPropSupports', [])
  call({ map: maps.length - 1 }, 'placeProps', [{ seed: `nan-${index}`, zones: [{ zoneId: '', theme: 'interior', density: 30 }] }])
}

// Весь каталог: каждый вид каждой своей темой — обязательным и в добор, в
// помещении (стены, окно, дверь, стол) и под открытым небом (трава, земля,
// песок, лёд).
function catalogueRoom(exterior) {
  const map = t.createTacticalMap({ width: 16, height: 14, seed: exterior ? 'catalogue-out' : 'catalogue-in' })
  t.addZone(map, { id: 'z', kind: exterior ? 'exterior' : 'interior', material: exterior ? 'grass' : 'stone' })
  t.addZone(map, { id: 'side', kind: exterior ? 'interior' : 'exterior', material: 'earth' })
  for (let y = 0; y < 14; y += 1) for (let x = 0; x < 16; x += 1) {
    const material = exterior ? ['grass', 'earth', 'sand', 'ice'][(x >> 2) % 4] : 'stone'
    t.setCell(map, x, y, { passable: x !== 0 && y !== 0 && y !== 13, zone: x < 13 ? 'z' : 'side', material, surface: material === 'ice' ? 'ice' : 'none', revealed: true })
  }
  for (let y = 1; y < 13; y += 1) t.setEdge(map, 12, y, 13, y, { kind: y === 6 ? 'window' : 'wall', blocksMove: true, blocksSight: y !== 6 })
  t.setEdge(map, 12, 9, 13, 9, { kind: 'none' })
  t.setDoor(map, { id: 'side-door', x: 12, y: 9, dir: 'e', state: 'closed' })
  t.addProp(map, { id: 'table', assetId: 'table_long', x: 6.5, y: 7.5, footprint: [{ x: 5, y: 7 }, { x: 6, y: 7 }, { x: 7, y: 7 }], blocksMove: true })
  t.addSpawnPoint(map, { id: 'party', x: 2, y: 2, role: 'party' })
  return t.serializeTacticalMap(map)
}
const catalogueMaps = { interior: maps.length, exterior: maps.length + 1 }
maps.push(catalogueRoom(false), catalogueRoom(true))
let catalogueCases = 0
for (const asset of listAssets()) {
  for (const theme of asset.themes) {
    const exterior = !pp.INDOOR_THEMES.has(theme) || asset.themes.includes('exterior')
    const input = { map: exterior ? catalogueMaps.exterior : catalogueMaps.interior }
    const placed = call(input, 'placeProps', [{ seed: `catalogue:${asset.id}:${theme}`, zones: [{ zoneId: 'z', theme, density: 12, require: [asset.id] }] }])
    call(input, 'placeProps', [{ seed: `catalogue-fill:${asset.id}:${theme}`, zones: [{ zoneId: 'z', theme, density: 30, prefer: [asset.id, pick(ALL_ASSETS)] }] }])
    if (chance(0.3)) call({ from: placed }, 'ensurePropAccess', [])
    catalogueCases += 2
  }
}

writeFixture(new URL('./prop-placement.json', import.meta.url), {
  version: pp.PROP_PLACEMENT_VERSION,
  indoorThemes: [...pp.INDOOR_THEMES],
  pow,
  powTail,
  hypot,
  scenarios: scenarioIndex,
  maps,
  cases,
})
console.log('случаев каталога', catalogueCases, 'случаев с отказом', cases.filter((entry) => entry.error).length, 'хешей', new Set(cases.map((entry) => entry.hash)).size, 'ассетов в каталоге', listAssets().length, hash(maps).slice(0, 8))

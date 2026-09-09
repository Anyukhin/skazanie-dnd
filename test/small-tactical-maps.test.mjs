import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { assetById } from '../server/asset-registry.mjs'
import { sceneInteractionCatalogEntry } from '../server/scene-interactions.mjs'
import { buildSmallTacticalMap, buildSmallTacticalMaps, locationPresetFor } from '../tools/build-small-tactical-maps.mjs'
import { cellAt, deserializeTacticalMap, edgeList, edgeNeighbor, reachableCells, serializeTacticalMap, validateTacticalMap } from '../server/tactical-map.mjs'

const CATALOG_FILE = new URL('../data/authored-location-maps-v1.json', import.meta.url)
const BUILDER_FILE = new URL('../tools/build-small-tactical-maps.mjs', import.meta.url)
const MARKER = /^authored-tactical:[a-z0-9][a-z0-9_-]{0,119}:v1$/u
const pos = (x, y) => String(x) + ',' + String(y)

const SEMANTIC_EXPECTATIONS = Object.freeze({
  'tides-grunvik': { style: 'submerged-street', zones: ['street-crossing', 'sunken-square'], props: ['rubble_heap'], surface: 'water', forbidProps: ['market_stall', 'table_long'] },
  'tides-sisters-hallig': { style: 'cloister', zones: ['cloister-walk', 'chapel'], props: ['pillar', 'altar'], surface: 'water', forbidProps: ['market_stall'] },
  'tides-broken-stars-lighthouse': { style: 'lighthouse', zones: ['tower-room'], props: ['stairs_up'], surface: 'water', forbidProps: ['market_stall'] },
  'tides-cog-graveyard': { style: 'shipwreck', zones: ['shoal', 'wreck-hull'], props: ['woodpile', 'barrel_stack'], surface: 'water', forbidProps: ['tree_oak', 'tree_spruce'] },
  'tides-archive-rift': { style: 'rift-bridge', zones: ['bridge-head', 'rift'], props: ['rubble_heap'], surface: 'rubble', forbidProps: ['room-west', 'room-east'] },
  'tides-black-dike': { style: 'canal-gate', zones: ['gatehouse', 'gate-yard'], props: ['barrel_stack'], surface: 'water', forbidProps: ['room-west', 'room-east'] },
  'tides-drowned-bell': { style: 'shaft', zones: ['bell-chamber'], props: ['stairs_down'], surface: 'water' },
  'tides-southern-firth': { style: 'harbor', zones: ['dock', 'boathouse'], props: ['woodpile', 'barrel_stack'], surface: 'water' },
  'star-nur-kesh': { style: 'fountain-court', zones: ['arcade', 'fountain'], props: ['well'], surface: 'water' },
  'star-mirhad': { style: 'garden-canals', zones: ['garden-bed', 'canal'], props: ['tree_oak'], surface: 'water' },
  'star-meridian-rift': { style: 'observatory-ruins', zones: ['observatory-floor', 'arc-court'], props: ['pillar', 'rubble_heap'], forbidProps: ['room-west', 'room-east'] },
  'star-forty-wells': { style: 'well-court', zones: ['well-ring'], props: ['well'], minPropCount: { well: 4 } },
  'star-mirror-lake': { style: 'lake-shore', zones: ['lake-bank', 'water'], props: ['campfire', 'water_trough'], surface: 'water', forbidProps: ['room-a', 'room-b'] },
  'star-nameless-mausoleum': { style: 'mausoleum', zones: ['burial-hall', 'tomb-niches'], props: ['sarcophagus', 'grave', 'urn'], forbidProps: ['table_long', 'bookshelf'] },
  'star-old-river-ford': { style: 'dry-bridge', zones: ['riverbank-west', 'riverbank-east'], props: ['milestone'], surface: 'rubble', forbidProps: ['market_stall', 'well'] },
  'star-broken-star-observatory': { style: 'tower', zones: ['tower-floor'], props: ['stairs_up', 'pillar'], forbidProps: ['cave-chamber'] },
  'star-sky-steppe': { style: 'nomad-camp', zones: ['fire-circle', 'wagon-ring'], props: ['campfire', 'water_trough'], forbidProps: ['room-a', 'room-b'] },
  'star-red-caravanserai': { style: 'caravan-yard', zones: ['wagon-yard', 'caravan-house'], props: ['cart', 'well'], forbidProps: ['market_stall'] },
  'ash-talass-akr': { style: 'buried-quarter', zones: ['buried-house-west', 'buried-house-east'], props: ['rubble_heap', 'table_long'], forbidProps: ['room-west', 'room-east'] },
  'ash-elefra': { style: 'temple-court', zones: ['sanctuary', 'processional'], props: ['altar', 'statue'], forbidProps: ['crate_stack', 'barrel_stack'] },
  'ash-black-cone': { style: 'volcano', zones: ['caldera-rim', 'crater'], props: ['brazier', 'boulder'], blockedZone: 'crater', forbidProps: ['market_stall', 'well'] },
  'ash-first-grain-terraces': { style: 'terraces', zones: ['terrace-mid', 'terrace-high'], props: ['haystack', 'water_trough'], forbidProps: ['tree_oak', 'tree_spruce'] },
  'ash-pumice-quarries': { style: 'quarry', zones: ['quarry-bench', 'quarry-wall'], props: ['cart', 'stairs_down', 'boulder'], forbidProps: ['tree_oak', 'tree_spruce'] },
  'ash-underworld-cistern': { style: 'cistern', zones: ['cistern-hall', 'reservoir'], props: ['stairs_down'], surface: 'water' },
  'ash-three-sisters-isle': { style: 'lava-islets', zones: ['islet-east', 'islet-west', 'hot-spring'], props: ['brazier', 'cave_pool'], surface: 'water' },
  'ash-three-torches-grotto': { style: 'grotto', zones: ['black-pool'], props: ['brazier', 'stairs_down'], surface: 'water' },
  'ash-returning-spring': { style: 'spring', zones: ['spring-bank', 'spring-pool'], props: ['well'], surface: 'water' },
  'ash-cinder-monastery': { style: 'cloister', zones: ['cloister-walk', 'chapel'], props: ['altar', 'prayer_bench'], forbidProps: ['market_stall'] },
  'astohan-ash-watch': { style: 'burnt-watch', zones: ['burnt-yard', 'watch-house'], props: ['rubble_heap', 'chest'], forbidProps: ['room-west', 'room-east'] },
  'astohan-mirror-lake': { style: 'lake-shore', zones: ['lake-bank', 'water'], props: ['boulder', 'rock_small'], surface: 'water', forbidProps: ['room-west', 'room-east'] },
  'astohan-mittlayd': { style: 'mill-town', zones: ['mill-house', 'riverbank'], props: ['table_long', 'cart'], surface: 'water', forbidProps: ['room-west', 'room-east'] },
  'astohan-redstone': { style: 'street-village', zones: ['yard-west', 'yard-east'], props: ['cart', 'well'], forbidProps: ['room-west', 'room-east'] },
  'astohan-quiet-watch-camp': { style: 'camp', zones: ['fire-circle', 'wagon-ring'], props: ['campfire', 'cart'], forbidProps: ['room-a', 'room-b'] },
  'astohan-cursed-woods': { style: 'dead-grove', zones: ['dead-grove'], props: ['tree_dead', 'roadside_shrine'], forbidProps: ['tree_oak', 'tree_spruce'] },
  'astohan-obsidian-pass': { style: 'obsidian-pass', zones: ['cliff-pass'], props: ['boulder', 'stairs_down'], forbidProps: ['tree_oak', 'tree_spruce'] },
  'astohan-eldrin-heart': { style: 'great-tree', zones: ['tree-circle'], props: ['tree_oak', 'roadside_shrine'], minPropCount: { tree_oak: 2 } },
  'astohan-lomar-tower': { style: 'wizard-tower', zones: ['tower-room', 'burnt-yard'], props: ['stairs_up', 'chest'], forbidProps: ['wall-walk'] },
  'astohan-vulkanis-brazier': { style: 'volcanic-lair', zones: ['lair', 'fissure'], props: ['brazier', 'stairs_down'], blockedZone: 'fissure' },
})

function publicLocationIds() {
  const root = JSON.parse(readFileSync(new URL('../data/campaign-worlds-v1.json', import.meta.url), 'utf8'))
  return root.templates.flatMap((template) => template.world_map.locations.map((location) => location.id))
    .filter((id) => id !== 'astohan-stormberg')
    .sort()
}

function decodedCatalog() {
  assert.equal(existsSync(CATALOG_FILE), true, 'каталог малых карт должен быть собран')
  const root = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))
  assert.equal(root.schema_version, 1)
  return root.maps.map(deserializeTacticalMap)
}

test('каталог содержит ровно 56 compact native-grid карт для prebuilt-локаций и Ares', () => {
  const maps = decodedCatalog()
  assert.deepEqual(maps.map((map) => map.locationId), publicLocationIds().concat('astohan-stormberg').sort())
  for (const map of maps) {
    assert.ok(map.width >= 18 && map.width <= 30, map.locationId + ': ширина вне compact grid')
    assert.ok(map.height >= 16 && map.height <= 24, map.locationId + ': высота вне compact grid')
    assert.equal(map.sizeClass, 'arena')
    assert.equal(map.generator.id, 'authored-tactical-scene')
    assert.equal(map.generator.version, '1')
    assert.equal(map.tilesetId, 'authored-tactical:' + map.locationId + ':v1')
    assert.match(map.tilesetId, MARKER)
    const interiorZones = map.zones.filter((zone) => zone.kind === 'interior').length
    assert.ok(interiorZones <= (map.locationId === 'astohan-stormberg' ? 4 : 3), map.locationId + ': слишком много interior zones')
    assert.ok(map.props.length > 0, map.locationId + ': нет native props')
    assert.ok(map.doors.length > 0, map.locationId + ': нет native doors')
  }
  assert.equal(maps.find((map) => map.locationId === 'tides-veld-burg')?.zones.find((zone) => zone.id === 'ground')?.label, 'Высокая пристань')
  assert.equal(maps.find((map) => map.locationId === 'ash-limnara')?.zones.find((zone) => zone.id === 'ground')?.label, 'Причальная площадка')
  const ares = maps.find((map) => map.locationId === 'astohan-stormberg')
  assert.ok(ares)
  assert.ok(ares.doors.some((door) => door.state === 'closed'), 'Ares должен сохранять закрытые двери кабинетов')
  const table = ares.props.find((prop) => prop.assetId === 'table_royal')
  assert.equal(table?.rotation, 90)
  assert.deepEqual([new Set(table?.footprint.map((cell) => cell.x)).size, new Set(table?.footprint.map((cell) => cell.y)).size], [2, 5])
  assert.equal(ares.props.find((prop) => prop.assetId === 'royal_throne')?.footprint.length, 4)
  const overview = JSON.parse(readFileSync(new URL('../data/authored-location-overview-manifest-v1.json', import.meta.url), 'utf8'))
  assert.equal(overview.entries.find((entry) => entry.locationId === 'astohan-stormberg')?.firstPlayableZone, 'Королевская галерея и два боковых кабинета')
})

test('каждая малая карта валидна, связна, имеет настоящий вход, укрытия и непересекающиеся props', () => {
  for (const map of decodedCatalog()) {
    const report = validateTacticalMap(map)
    assert.equal(report.ok, true, map.locationId + ': ' + JSON.stringify(report.errors))
    const labels = map.zones.map((zone) => zone.label)
    assert.equal(new Set(labels).size, labels.length, map.locationId + ': повторяющиеся labels зон')
    const usedZones = new Set()
    let waterCells = 0
    let oilCells = 0
    let revealedPassable = 0
    const party = map.spawnPoints.find((point) => point.role === 'party')
    const enemy = map.spawnPoints.find((point) => point.role === 'enemy')
    assert.ok(party, map.locationId + ': нужен party spawn')
    if (map.locationId !== 'astohan-stormberg') assert.ok(enemy, map.locationId + ': нужен enemy spawn')
    const reached = reachableCells(map, party.x, party.y, { throughDoors: true })
    const propCells = new Set()
    let passable = 0
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell?.passable) {
        passable += 1
        assert.ok(reached.has(pos(x, y)), map.locationId + ': клетка ' + pos(x, y) + ' недостижима')
        assert.equal(cell.moveCost, 1, map.locationId + ': обычный пол не должен случайно получать moveCost=2')
        if (cell.revealed) {
          revealedPassable += 1
          assert.ok(Math.abs(x - party.x) + Math.abs(y - party.y) <= 8, map.locationId + ': стартовое раскрытие вышло за радиус 8')
        }
      }
      if (cell) {
        usedZones.add(cell.zone)
        if (cell.surface === 'water') waterCells += 1
        if (cell.surface === 'oil') oilCells += 1
      }
    }
    assert.ok(passable >= 12, map.locationId + ': слишком мало native floor')
    assert.equal(cellAt(map, party.x, party.y)?.revealed, true, map.locationId + ': клетка party должна быть раскрыта')
    assert.ok(revealedPassable < passable, map.locationId + ': вся карта раскрыта до начала сцены')
    for (const zone of map.zones) assert.ok(usedZones.has(zone.id), map.locationId + ': пустая зона ' + zone.id)
    const waterZone = map.zones.find((zone) => zone.id === 'water')
    if (waterZone) assert.ok(waterCells > 0, map.locationId + ': объявлена пустая water zone')
    assert.equal(oilCells, 0, map.locationId + ': малая карта не должна подменять лаву механикой oil')
    for (const prop of map.props) {
      const asset = assetById(prop.assetId)
      assert.ok(asset, map.locationId + ': неизвестный asset ' + prop.assetId)
      assert.ok(prop.footprint.length > 0, map.locationId + ': prop без footprint ' + prop.id)
      if (prop.interactive) assert.ok(sceneInteractionCatalogEntry(prop.assetId)?.verbs?.length || prop.transition, map.locationId + ': interactive prop без verbs/transition ' + prop.assetId)
      if (['well', 'stairs_up', 'stairs_down', 'trapdoor'].includes(prop.assetId)) assert.equal(prop.interactive, Boolean(prop.transition), map.locationId + ': prop без verbs/transition не должен быть interactive')
      for (const cell of prop.footprint) {
        assert.ok(cellAt(map, cell.x, cell.y)?.passable, map.locationId + ': prop ' + prop.id + ' стоит вне floor')
        assert.equal(propCells.has(pos(cell.x, cell.y)), false, map.locationId + ': props пересекаются')
        propCells.add(pos(cell.x, cell.y))
      }
      const xs = new Set(prop.footprint.map((cell) => cell.x))
      const ys = new Set(prop.footprint.map((cell) => cell.y))
      if (map.locationId !== 'astohan-stormberg') {
        if (xs.size > ys.size) assert.ok([0, 180].includes(prop.rotation), map.locationId + ': горизонтальный ' + prop.assetId + ' повернут неверно')
        if (ys.size > xs.size) assert.ok([90, 270].includes(prop.rotation), map.locationId + ': вертикальный ' + prop.assetId + ' повернут неверно')
      }
    }
    for (const spawn of map.spawnPoints) assert.equal(propCells.has(pos(spawn.x, spawn.y)), false, map.locationId + ': spawn на prop')
    for (const door of map.doors) {
      const neighbor = edgeNeighbor(door)
      assert.ok(cellAt(map, door.x, door.y)?.passable, map.locationId + ': дверь на стене')
      assert.ok(cellAt(map, neighbor.x, neighbor.y)?.passable, map.locationId + ': дверь ведёт в стену')
      const edge = edgeList(map).find((candidate) => candidate.x === door.x && candidate.y === door.y && candidate.dir === door.dir)
      assert.equal(edge?.kind, 'door', map.locationId + ': дверь не закреплена на door edge')
      if (map.locationId !== 'astohan-stormberg') assert.equal(door.state, 'open', map.locationId + ': стартовая дверь должна быть открыта')
    }
  }
})

test('каждая смысловая сцена выбирается адресным preset-ом и сохраняет главный признак места', () => {
  const root = JSON.parse(readFileSync(new URL('../data/campaign-worlds-v1.json', import.meta.url), 'utf8'))
  const locations = new Map(root.templates.flatMap((template) => template.world_map.locations.map((location) => [location.id, location])))
  for (const [locationId, expected] of Object.entries(SEMANTIC_EXPECTATIONS)) {
    const location = locations.get(locationId)
    assert.ok(location, locationId + ': location missing from campaign worlds')
    assert.equal(locationPresetFor(locationId)?.form, expected.style, locationId + ': wrong authored form')
    const map = buildSmallTacticalMap(location)
    const zoneIds = new Set(map.zones.map((zone) => zone.id))
    for (const zoneId of expected.zones) assert.ok(zoneIds.has(zoneId), locationId + ': missing semantic zone ' + zoneId)
    const propIds = map.props.map((prop) => prop.assetId)
    for (const propId of expected.props) assert.ok(propIds.includes(propId), locationId + ': missing semantic prop ' + propId)
    for (const propId of expected.forbidProps || []) {
      assert.equal(propIds.includes(propId) || zoneIds.has(propId), false, locationId + ': forbidden generic feature ' + propId)
    }
    for (const [propId, minimum] of Object.entries(expected.minPropCount || {})) {
      assert.ok(propIds.filter((value) => value === propId).length >= minimum, locationId + ': expected at least ' + minimum + ' ' + propId)
    }
    if (expected.surface) {
      let found = false
      for (let y = 0; y < map.height && !found; y += 1) for (let x = 0; x < map.width; x += 1) {
        if (cellAt(map, x, y)?.surface === expected.surface) { found = true; break }
      }
      assert.equal(found, true, locationId + ': missing semantic surface ' + expected.surface)
    }
    if (expected.blockedZone) {
      let found = false
      for (let y = 0; y < map.height && !found; y += 1) for (let x = 0; x < map.width; x += 1) {
        const cell = cellAt(map, x, y)
        if (cell?.zone === expected.blockedZone && !cell.passable) { found = true; break }
      }
      assert.equal(found, true, locationId + ': missing blocked semantic zone ' + expected.blockedZone)
    }
  }
  for (const locationId of publicLocationIds()) assert.ok(locationPresetFor(locationId), locationId + ': missing addressable location preset')
})

test('builder детерминирован, не вызывает LLM и не зависит от campaign seed', () => {
  const source = readFileSync(BUILDER_FILE, 'utf8')
  assert.doesNotMatch(source, /llm-client|completeJson|fetch\s*\(/u)
  const worlds = JSON.parse(readFileSync(new URL('../data/campaign-worlds-v1.json', import.meta.url), 'utf8'))
  const location = worlds.templates.flatMap((template) => template.world_map.locations).find((entry) => entry.id === 'astohan-mittlayd')
  assert.ok(location)
  const first = serializeTacticalMap(buildSmallTacticalMap(location))
  const second = serializeTacticalMap(buildSmallTacticalMap({ ...location, seed: 'different-campaign-seed', campaignId: 'other' }))
  assert.deepEqual(first, second)
  const temp = mkdtempSync(join(process.cwd(), 'tmp-small-tactical-test-'))
  try {
    const output = join(temp, 'catalog.json')
    const a = buildSmallTacticalMaps({ outputPath: output }).maps.map(serializeTacticalMap)
    const b = buildSmallTacticalMaps({ outputPath: output }).maps.map(serializeTacticalMap)
    assert.deepEqual(a, b)
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).maps.length, 56)
    const main = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).maps, main.maps, 'повторная сборка не должна дрейфовать относительно основного каталога')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

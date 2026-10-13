import assert from 'node:assert/strict'
import test from 'node:test'

import { generateSceneGeometry } from '../server/adventure-director.mjs'
import { buildSettlementScene, MARKET_STALLS_MAX, SETTLEMENT_GENERATOR } from '../server/settlement-generator.mjs'
import { auditTacticalMap } from '../server/map-quality.mjs'
import { cellAt, edgeNeighbor, reachableCells, serializeTacticalMap, validateTacticalMap } from '../server/tactical-map.mjs'

const theme = { id: 'settlement', label: 'Поселение', surfaceMaterial: 'grass', streetMaterial: 'earth', houseMaterial: 'wood' }
const topologies = ['organic', 'linear', 'crossroads', 'market', 'courtyard', 'harbor', 'river', 'terraced', 'gate']

function reachableBuildingZones(map) {
  const spawn = map.spawnPoints.find((point) => point.role === 'party')
  const reached = reachableCells(map, spawn.x, spawn.y, { throughDoors: true })
  return map.zones.filter((zone) => zone.id.startsWith('building-')).filter((zone) => {
    const interior = []
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell?.passable && cell.zone === zone.id) interior.push(`${x},${y}`)
    }
    return interior.length > 0 && interior.every((position) => reached.has(position))
  }).length
}

test('settlement topologies produce valid reachable v2 maps', () => {
  for (const topology of topologies) {
    const built = buildSettlementScene({ seed: `topology-${topology}`, width: 28, height: 28, locationId: topology, theme, design: { topology } })
    assert.deepEqual(validateTacticalMap(built.map).errors, [], topology)
    assert.equal(built.map.generator.id, SETTLEMENT_GENERATOR.id)
    assert.equal(built.map.generator.version, SETTLEMENT_GENERATOR.version)
    assert.ok(built.map.spawnPoints.some((point) => point.role === 'party'), topology)
    assert.equal(built.warnings.length, 0, topology)
    assert.equal(reachableBuildingZones(built.map), built.map.zones.filter((zone) => zone.id.startsWith('building-')).length, topology)
    const reached = reachableCells(built.map, built.map.spawnPoints[0].x, built.map.spawnPoints[0].y, { throughDoors: true })
    for (const door of built.map.doors) {
      const endpoints = [{ x: door.x, y: door.y }, edgeNeighbor(door)]
      assert.ok(endpoints.some((cell) => reached.has(`${cell.x},${cell.y}`)), `${topology}: дверь ${door.id} отрезана`)
    }
  }
})

test('settlement generation is deterministic and default seeds vary composition', () => {
  const first = buildSettlementScene({ seed: 'same-settlement', width: 30, height: 30, locationId: 'same', theme, design: {} }).map
  const second = buildSettlementScene({ seed: 'same-settlement', width: 30, height: 30, locationId: 'same', theme, design: {} }).map
  assert.deepEqual(serializeTacticalMap(first), serializeTacticalMap(second))
  const signatures = new Set(Array.from({ length: 12 }, (_, index) => {
    const map = buildSettlementScene({ seed: `varied-${index}`, width: 28, height: 28, locationId: `varied-${index}`, theme, design: {} }).map
    const bounds = map.zones.filter((zone) => zone.id.startsWith('building-')).map((zone) => {
      const cells = []
      for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if (cellAt(map, x, y)?.zone === zone.id) cells.push({ x, y })
      return [Math.min(...cells.map((cell) => cell.x)), Math.min(...cells.map((cell) => cell.y)), Math.max(...cells.map((cell) => cell.x)), Math.max(...cells.map((cell) => cell.y))]
    })
    return JSON.stringify({ bounds, doors: map.doors.map((door) => [door.x, door.y]) })
  }))
  assert.ok(signatures.size >= 8, `unique compositions: ${signatures.size}`)
})

test('river and harbor keep water crossing reachable', () => {
  for (const topology of ['river', 'harbor']) {
    const map = buildSettlementScene({ seed: `water-${topology}`, width: 30, height: 30, locationId: topology, theme, design: { topology } }).map
    const water = []
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell?.surface === 'water') water.push({ x, y, passable: cell.passable })
    }
    assert.ok(water.length > 0, topology)
    assert.ok(water.some((cell) => [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dy]) => cellAt(map, cell.x + dx, cell.y + dy))
      .some((neighbor) => neighbor?.passable)), `${topology}: нет моста или причала`)
  }
})

test('market, courtyard and gate carry their own topology', () => {
  const market = buildSettlementScene({ seed: 'market-topology', width: 30, height: 30, locationId: 'market', theme, design: { topology: 'market' } }).map
  const courtyard = buildSettlementScene({ seed: 'courtyard-topology', width: 30, height: 30, locationId: 'courtyard', theme, design: { topology: 'courtyard' } }).map
  const marketSquare = [...Array.from({ length: market.height }, (_, y) => y).flatMap((y) => Array.from({ length: market.width }, (_, x) => cellAt(market, x, y)))].filter((cell) => cell?.zone === 'square')
  const courtyardSquare = [...Array.from({ length: courtyard.height }, (_, y) => y).flatMap((y) => Array.from({ length: courtyard.width }, (_, x) => cellAt(courtyard, x, y)))].filter((cell) => cell?.zone === 'square')
  assert.ok(marketSquare.length >= 40, 'у рынка нет площади')
  assert.ok(courtyardSquare.length >= 30, 'у двора нет внутреннего двора')
  assert.notEqual(marketSquare.length, courtyardSquare.length, 'рынок и двор получили одну композицию')

  const gate = buildSettlementScene({ seed: 'gate-topology', width: 30, height: 30, locationId: 'gate', theme, design: { topology: 'gate' } }).map
  assert.equal(gate.doors.filter((door) => door.id === 'city-gate').length, 1, 'у крепостного входа нет ворот')
  assert.ok(Object.values(gate.edges).filter((edge) => edge.kind === 'wall').length >= gate.height - 6, 'у ворот нет стены города')
})

test('перекрёсток имеет две улицы, органическая деревня — связный изгиб без прямого дубля', () => {
  for (let index = 0; index < 12; index += 1) {
    const cross = buildSettlementScene({ seed: `streets-${index}`, width: 32, height: 30, theme, design: { topology: 'crossroads' } }).map
    const centerX = Math.floor(cross.width / 2)
    assert.ok(Array.from({ length: cross.height }, (_, y) => cellAt(cross, centerX, y)).every((cell) => cell?.zone === 'street' && cell.passable))
    const organic = buildSettlementScene({ seed: `streets-${index}`, width: 32, height: 30, theme, design: { topology: 'organic' } }).map
    const rows = Array.from({ length: organic.height }, (_, y) => Array.from({ length: organic.width }, (_, x) => cellAt(organic, x, y)))
    assert.equal(rows.some((row) => row.every((cell) => cell?.zone === 'street')), false, 'лишняя прямая дорога осталась в органической деревне')
    const spawn = organic.spawnPoints.find((point) => point.role === 'party')
    const reached = reachableCells(organic, spawn.x, spawn.y, { throughDoors: true })
    for (const row of rows) for (const cell of row) if (cell?.zone === 'street') assert.ok(reached.has(`${cell.x},${cell.y}`), 'изгиб улицы отрезан')
  }
})

test('organic buildings use real wings and dense gates are not one template', () => {
  let nonRectangular = 0
  for (let index = 0; index < 24; index += 1) {
    const map = buildSettlementScene({ seed: `organic-wing-${index}`, width: 30, height: 30, locationId: 'organic', theme, design: { topology: 'organic', density: 'mixed' } }).map
    for (const zone of map.zones.filter((entry) => entry.id.startsWith('building-'))) {
      const cells = []
      for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
        if (cellAt(map, x, y)?.passable && cellAt(map, x, y)?.zone === zone.id) cells.push({ x, y })
      }
      const minX = Math.min(...cells.map((cell) => cell.x))
      const maxX = Math.max(...cells.map((cell) => cell.x))
      const minY = Math.min(...cells.map((cell) => cell.y))
      const maxY = Math.max(...cells.map((cell) => cell.y))
      if (cells.length < (maxX - minX + 1) * (maxY - minY + 1)) nonRectangular += 1
    }
  }
  assert.ok(nonRectangular > 0, 'органический генератор не создал ни одного выступающего крыла')

  const denseGateShapes = new Set()
  for (let index = 0; index < 24; index += 1) {
    const map = buildSettlementScene({ seed: `dense-gate-${index}`, width: 30, height: 30, locationId: 'gate', theme, design: { topology: 'gate', density: 'dense' } }).map
    denseGateShapes.add(JSON.stringify(map.zones.filter((zone) => zone.id.startsWith('building-')).map((zone) => {
      const cells = []
      for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if (cellAt(map, x, y)?.passable && cellAt(map, x, y)?.zone === zone.id) cells.push({ x, y })
      return [cells.length, Math.min(...cells.map((cell) => cell.x)), Math.max(...cells.map((cell) => cell.x)), Math.min(...cells.map((cell) => cell.y)), Math.max(...cells.map((cell) => cell.y))]
    })))
  }
  assert.ok(denseGateShapes.size >= 4, `dense gate compositions: ${denseGateShapes.size}`)
})

test('деревенская река петляет и выходит к песчаному берегу, городской канал одет в набережную', async () => {
  const { edgeBetween } = await import('../server/tactical-map.mjs')
  for (const seed of ['bend-a', 'bend-b']) {
    const { map } = buildSettlementScene({ seed, width: 44, height: 38, theme: 'деревня у реки', design: { topology: 'river', scale: 'village' } })
    const water = map.zones.find((zone) => zone.id === 'water')
    assert.equal(water?.floor, 'river', `${seed}: у реки нет фактуры струй`)
    // Верхний край русла по столбцам: у петляющей реки он не один.
    const tops = new Set()
    let sand = 0
    for (let x = 0; x < map.width; x += 1) {
      for (let y = 0; y < map.height; y += 1) {
        const cell = cellAt(map, x, y)
        if (cell?.surface === 'water' && cell.zone === 'water') { tops.add(y); break }
      }
      for (let y = 0; y < map.height; y += 1) if (cellAt(map, x, y)?.passable && cellAt(map, x, y)?.material === 'sand') sand += 1
    }
    assert.ok(tops.size >= 3, `${seed}: река прямая, верх русла на ${[...tops]}`)
    assert.ok(sand >= map.width, `${seed}: песчаного берега ${sand} клеток`)
  }
  const { map: town } = buildSettlementScene({ seed: 'canal', width: 48, height: 44, theme: 'город у реки', design: { topology: 'river', scale: 'town' } })
  let quay = 0
  for (let y = 0; y < town.height; y += 1) for (let x = 0; x < town.width; x += 1) {
    if (edgeBetween(town, x, y, x, y + 1)?.kind === 'ledge') quay += 1
  }
  assert.ok(quay >= town.width, `набережной ${quay} рёбер`)
})

test('у каждой двери поселения есть дорога: дом в глубине получает тропу к улице', () => {
  // Замечание владельца 2026-10-03: «Дом 9» стоял в углу деревни, дверью в
  // чужой двор, и к нему не вела ни одна дорожка. Теперь дверь дома в
  // глубине выбирается по настоящей тропе до улицы, а тропа прокладывается.
  let paths = 0
  for (const topology of topologies) for (const scale of ['village', 'town']) for (const seed of ['a', 'b', 'c']) {
    const built = buildSettlementScene({ seed: `road-${topology}-${scale}-${seed}`, width: 48, height: 44, locationId: topology, theme, design: { topology, scale, density: 'dense' } })
    const problems = auditTacticalMap(built.map).problems.filter((problem) => ['DOOR_OFF_ROAD', 'PATH_BLOCKED'].includes(problem.code))
    assert.deepEqual(problems, [], `${topology}/${scale}/${seed}`)
    if (built.map.zones.some((zone) => zone.id === 'path')) paths += 1
  }
  assert.ok(paths > 0, 'хоть у одного поселения есть дома в глубине с тропой')
})

/** Клетки предметов, мешающих шагу. */
function blockingCells(map) {
  return new Set(map.props.filter((prop) => prop.blocksMove && !prop.mount).flatMap((prop) => prop.footprint.map((cell) => `${cell.x},${cell.y}`)))
}

test('рынок — ряды лотков с проходами, телеги и ящики, двери домов на дорогах', () => {
  // Обзор 2026-10-08: на «Суконной площади» стояло три навеса.
  assert.equal(SETTLEMENT_GENERATOR.version, '7', 'мебель не сквозь стену и гарнитуры — новая версия генератора')
  for (const scale of ['village', 'town', 'city']) for (const seed of ['a', 'b', 'c', 'd']) {
    const label = `${scale}/${seed}`
    const { map } = buildSettlementScene({ seed: `market-${scale}-${seed}`, width: 48, height: 44, theme, design: { topology: 'market', scale } })
    const stalls = map.props.filter((prop) => prop.assetId === 'market_stall')
    assert.ok(stalls.length >= 6 && stalls.length <= MARKET_STALLS_MAX, `${label}: лотков ${stalls.length}`)
    assert.ok(stalls.every((prop) => prop.footprint.every((cell) => cellAt(map, cell.x, cell.y)?.zone === 'square')), `${label}: лоток не на площади`)
    // Рядами: не меньше двух рядов, и лотки не сливаются в прилавок — между
    // соседними хотя бы клетка прохода.
    assert.ok(new Set(stalls.map((prop) => Math.min(...prop.footprint.map((cell) => cell.y)))).size >= 2, `${label}: лотки в один ряд`)
    for (const [index, left] of stalls.entries()) for (const right of stalls.slice(index + 1)) {
      const touching = left.footprint.some((a) => right.footprint.some((b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1))
      assert.equal(touching, false, `${label}: лотки ${left.id} и ${right.id} вплотную`)
    }
    assert.ok(map.props.some((prop) => /^market-(?:cart|goods)-/u.test(prop.id)), `${label}: на рынке ни телеги, ни ящика`)
    // Проходы между рядами свободны, к каждой двери ведёт дорога, площадь досягаема.
    const blocked = blockingCells(map)
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      if (cellAt(map, x, y)?.zone === 'path') assert.equal(blocked.has(`${x},${y}`), false, `${label}: проход занят в ${x},${y}`)
    }
    assert.deepEqual(auditTacticalMap(map).problems, [], label)
  }
})

test('рыночная сцена целиком: на площади 6–12 лотков, проходы и двери чисты', () => {
  for (const [label, input] of [
    ['деревня', { location: 'Торжок', theme: 'деревня рынок', settlementType: 'village', map: { design: { topology: 'market' } } }],
    ['город', { location: 'Суконная площадь', theme: 'город рынок', settlementType: 'town', map: { design: { topology: 'market' } } }],
  ]) {
    for (const seed of ['s1', 's2', 's3']) {
      const { map } = generateSceneGeometry({ ...input, seed: `market-scene:${label}:${seed}`, useLibrary: false })
      const onSquare = map.props.filter((prop) => prop.assetId === 'market_stall' && cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone === 'square')
      assert.ok(onSquare.length >= 6 && onSquare.length <= 12, `${label}/${seed}: на площади ${onSquare.length} лотков`)
      const problems = auditTacticalMap(map).problems
      assert.deepEqual(problems.filter((problem) => ['PATH_BLOCKED', 'DOOR_OFF_ROAD', 'DOORWAY_BLOCKED', 'UNREACHABLE_FLOOR'].includes(problem.code)), [], `${label}/${seed}`)
    }
  }
})

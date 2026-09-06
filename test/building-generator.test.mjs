import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ARES_FORTRESS_GENERATOR,
  ARES_FORTRESS_SIZE,
  REFERENCE_SIZE,
  buildAresFortressScene,
  buildBuildingScene,
  generateAresFortressScene,
  generateBuildingScene,
  reachabilityIssues,
  safeRoom,
  tacticalFitnessWarnings,
} from '../server/building-generator.mjs'
import {
  cellAt,
  edgeList,
  legacyCellsFromTacticalMap,
  reachableCells,
  serializeTacticalMap,
  validateTacticalMap,
} from '../server/tactical-map.mjs'

const scene = () => generateBuildingScene({ seed: 'reference' })

test('сцена-эталон имеет размер около 26×26', () => {
  const map = scene()
  assert.equal(map.width, REFERENCE_SIZE.width)
  assert.equal(map.height, REFERENCE_SIZE.height)
  assert.equal(map.width * map.height, 676)
})

test('генерация детерминирована от seed', () => {
  const first = JSON.stringify(serializeTacticalMap(generateBuildingScene({ seed: 'same' })))
  const second = JSON.stringify(serializeTacticalMap(generateBuildingScene({ seed: 'same' })))
  assert.equal(first, second)
  assert.notEqual(first, JSON.stringify(serializeTacticalMap(generateBuildingScene({ seed: 'other' }))))
})

test('карта проходит структурную валидацию', () => {
  const report = validateTacticalMap(scene())
  assert.deepEqual(report.errors, [])
})

test('здание состоит из трёх помещений и внешней зоны', () => {
  const map = scene()
  const labelled = map.zones.filter((zone) => zone.label).map((zone) => zone.id).sort()
  assert.deepEqual(labelled, ['hall', 'kitchen', 'store', 'yard'])
  assert.equal(map.zones.find((zone) => zone.id === 'yard')?.kind, 'exterior')

  const counts = new Map()
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (!cell || !cell.passable) continue
      counts.set(cell.zone, (counts.get(cell.zone) ?? 0) + 1)
    }
  }
  for (const zone of ['hall', 'kitchen', 'store', 'yard']) {
    assert.ok((counts.get(zone) ?? 0) > 4, `в зоне ${zone} всего ${counts.get(zone) ?? 0} проходимых клеток`)
  }
  assert.ok(counts.get('hall') > counts.get('kitchen'), 'общий зал обязан быть крупнее кухни')
})

test('от точки появления снаружи есть путь в каждое помещение', () => {
  const map = scene()
  assert.deepEqual(reachabilityIssues(map), [])

  const spawn = map.spawnPoints.find((point) => point.role === 'party')
  assert.ok(spawn, 'точка появления отряда обязана существовать')
  const reached = reachableCells(map, spawn.x, spawn.y)
  for (const zone of ['hall', 'kitchen', 'store']) {
    let found = false
    for (let y = 0; y < map.height && !found; y += 1) {
      for (let x = 0; x < map.width && !found; x += 1) {
        const cell = cellAt(map, x, y)
        if (cell?.passable && cell.zone === zone && reached.has(`${x},${y}`)) found = true
      }
    }
    assert.ok(found, `в помещение ${zone} нет пути снаружи`)
  }
})

test('двери стоят на рёбрах, а окна не пропускают, но не слепят', () => {
  const map = scene()
  assert.equal(map.doors.length, 3, 'вход плюс две внутренние двери')
  for (const door of map.doors) {
    const edge = map.edges[`${door.x},${door.y},${door.dir}`]
    assert.ok(edge, `у двери ${door.id} нет ребра`)
    assert.equal(edge.kind, 'door')
    assert.equal(cellAt(map, door.x, door.y)?.passable, true, 'проём обязан быть проходим')
  }

  const windows = edgeList(map).filter((edge) => edge.kind === 'window')
  assert.ok(windows.length >= 4, `окон слишком мало: ${windows.length}`)
  for (const edge of windows) {
    assert.equal(edge.blocksMove, true, 'через окно нельзя пройти')
    assert.equal(edge.blocksSight, false, 'окно не должно перекрывать обзор')
  }
})

test('стены здания выражены и клетками, и рёбрами', () => {
  const map = scene()
  const walls = edgeList(map).filter((edge) => edge.kind === 'wall')
  assert.ok(walls.length > 30, `рёбер-стен всего ${walls.length}`)

  // Пока правила движения читают клетку, стена обязана быть непроходимой и как
  // клетка — иначе герой пройдёт сквозь неё.
  for (const edge of walls.slice(0, 20)) {
    const owner = cellAt(map, edge.x, edge.y)
    const neighbor = edge.dir === 'e' ? cellAt(map, edge.x + 1, edge.y) : cellAt(map, edge.x, edge.y + 1)
    assert.ok(owner && neighbor, 'ребро между существующими клетками')
    assert.ok(!owner.passable || !neighbor.passable, 'стена обязана отделять непроходимую клетку')
  }
})

test('ограда участка имеет проход у тропы', () => {
  const map = scene()
  const rails = edgeList(map).filter((edge) => edge.kind === 'rail')
  assert.ok(rails.length > 20, `ограда слишком короткая: ${rails.length}`)
  const spawn = map.spawnPoints.find((point) => point.role === 'party')
  assert.ok(spawn)
  // Проход существует: от точки появления достижимы клетки внутри участка.
  assert.ok(reachableCells(map, spawn.x, spawn.y).size > 50)
})

test('тропа ведёт от края карты ко входу', () => {
  const map = scene()
  let earth = 0
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (cellAt(map, x, y)?.material === 'earth') earth += 1
    }
  }
  assert.ok(earth >= 8, `тропа слишком короткая: ${earth} клеток`)
})

test('деревья только снаружи, мебель только внутри', () => {
  const map = scene()
  assert.ok(map.props.length > 20, `предметов всего ${map.props.length}`)
  for (const prop of map.props) {
    const cell = cellAt(map, Math.floor(prop.x), Math.floor(prop.y))
    assert.ok(cell, `предмет ${prop.id} стоит вне карты`)
    if (prop.assetId.startsWith('tree_') || prop.assetId === 'bush' || prop.assetId === 'well') {
      assert.equal(cell.zone, 'yard', `${prop.assetId} оказался в помещении`)
    }
    if (['bar_counter', 'fireplace', 'table_round', 'table_long'].includes(prop.assetId)) {
      assert.notEqual(cell.zone, 'yard', `${prop.assetId} оказался во дворе`)
    }
  }
})

test('оверлеи заполнены: компас, легенда масштаба и подписи помещений', () => {
  const map = scene()
  assert.equal(map.overlays.compass, true)
  assert.equal(map.overlays.scaleBar, true)
  assert.deepEqual(
    map.overlays.roomLabels.map((label) => label.zoneId).sort(),
    ['hall', 'kitchen', 'store', 'yard'],
  )
})

test('карта совместима со старым представлением клеток', () => {
  const map = scene()
  const cells = legacyCellsFromTacticalMap(map)
  assert.equal(cells.length, map.width * map.height)
  assert.ok(cells.some((cell) => cell.type === 'wall'), 'стены обязаны читаться старым кодом')
  assert.ok(cells.some((cell) => cell.type === 'door'), 'двери обязаны читаться старым кодом')
  assert.ok(cells.some((cell) => cell.feature), 'предметы обязаны читаться старым кодом')
})

test('проверка пригодности предупреждает, но не отклоняет', () => {
  const warnings = tacticalFitnessWarnings(scene())
  assert.ok(Array.isArray(warnings))
  const report = validateTacticalMap(scene())
  assert.equal(report.ok, true, 'предупреждения не должны превращаться в отказ')
})

test('сборка со ступенями отката всегда отдаёт играбельную карту', () => {
  const normal = buildBuildingScene({ seed: 'ladder' })
  assert.equal(normal.fallback, 'none')
  assert.deepEqual(reachabilityIssues(normal.map), [])

  // Слишком тесная сцена: генератор обязан не упасть, а откатиться.
  const tiny = buildBuildingScene({ seed: 'tiny', width: 16, height: 16 })
  assert.ok(['none', 'no_props', 'safe_room'].includes(tiny.fallback))
  assert.deepEqual(validateTacticalMap(tiny.map).errors, [])
  assert.deepEqual(reachabilityIssues(tiny.map), [])
})

test('минимальная безопасная комната валидна и связна', () => {
  const map = safeRoom({ seed: 'fallback' })
  assert.deepEqual(validateTacticalMap(map).errors, [])
  assert.deepEqual(reachabilityIssues(map), [])
  assert.equal(map.overlays.compass, true)
})

test('крепость Ареса имеет стабильный большой двор и один owner-генератор', () => {
  const first = generateAresFortressScene({ seed: 'ares-stable', width: 17, height: 11 })
  const second = generateAresFortressScene({ seed: 'ares-stable', width: 17, height: 11 })
  assert.deepEqual(serializeTacticalMap(first), serializeTacticalMap(second))
  assert.equal(first.generator.id, ARES_FORTRESS_GENERATOR.id)
  assert.equal(first.generator.version, ARES_FORTRESS_GENERATOR.version)
  assert.ok(first.width >= ARES_FORTRESS_SIZE.width - 4, 'крепость не должна сжимать двор до комнаты')
  assert.ok(first.height >= ARES_FORTRESS_SIZE.height, 'крепость должна оставаться глубокой картой')
  assert.deepEqual(validateTacticalMap(first).errors, [])
  assert.deepEqual(reachabilityIssues(first), [])
})

test('из военной галереи открыты двор и все функциональные корпуса через двери', () => {
  const map = generateAresFortressScene({ seed: 'ares-connectivity' })
  const spawn = map.spawnPoints.find((point) => point.id === 'party-war-gallery')
  assert.deepEqual(spawn?.role, 'party')
  const reached = reachableCells(map, spawn.x, spawn.y)
  for (const zone of ['courtyard', 'gallery', 'barracks', 'stables', 'storehouse', 'workshop']) {
    assert.ok([...reached].some((key) => cellAt(map, ...key.split(',').map(Number))?.zone === zone),
      `из галереи недостижима зона ${zone}`)
  }
  assert.equal(map.doors.length, 10, 'ворота, межкомнатные и корпусные двери должны быть явными')
  for (const door of map.doors) {
    const edge = map.edges[`${door.x},${door.y},${door.dir}`]
    assert.equal(edge?.kind, 'door', `${door.id}: дверь не закреплена на ребре`)
    const target = door.dir === 'e' ? { x: door.x + 1, y: door.y } : { x: door.x, y: door.y + 1 }
    assert.equal(cellAt(map, door.x, door.y)?.passable, true, `${door.id}: первая сторона непроходима`)
    assert.equal(cellAt(map, target.x, target.y)?.passable, true, `${door.id}: вторая сторона непроходима`)
  }
})

test('крепость наполнена по назначению зон, а пролог начинается у стола', () => {
  const map = buildAresFortressScene({ seed: 'ares-prologue' }).map
  const party = map.spawnPoints.find((point) => point.id === 'party-war-gallery')
  const king = map.spawnPoints.find((point) => point.id === 'king-war-gallery')
  assert.ok(party && king)
  assert.equal(cellAt(map, party.x, party.y)?.zone, 'gallery')
  assert.equal(cellAt(map, king.x, king.y)?.zone, 'gallery')
  assert.notDeepEqual(party, king, 'король и партия должны иметь разные стартовые клетки')

  const propsIn = (zoneId) => new Set(map.props
    .filter((prop) => cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone === zoneId)
    .map((prop) => prop.assetId))
  for (const [zone, required] of [
    ['gallery', ['table_small', 'candelabra', 'banner', 'chandelier']],
    ['barracks', ['bunk_bed', 'chest']],
    ['stables', ['haystack', 'water_trough', 'hitching_post']],
    ['storehouse', ['crate_stack', 'barrel_stack', 'chest']],
    ['workshop', ['table_long', 'crate', 'barrel', 'firewood_stack']],
    ['courtyard', ['well', 'water_trough', 'woodpile']],
  ]) {
    const assets = propsIn(zone)
    for (const asset of required) assert.ok(assets.has(asset), `${zone}: отсутствует ${asset}`)
  }
})

test('двор имеет травяные и земляные карманы, а внешний пояс — свою семантическую зону', () => {
  const map = generateAresFortressScene({ seed: 'ares-surface' })
  const exterior = map.zones.find((zone) => zone.id === 'exterior')
  assert.equal(exterior?.kind, 'exterior')
  const materials = new Set()
  let exteriorCells = 0
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell?.zone === 'courtyard') materials.add(cell.material)
      if (cell?.zone === 'exterior') exteriorCells += 1
    }
  }
  assert.ok(materials.has('grass'))
  assert.ok(materials.has('earth'))
  assert.ok(materials.has('stone'))
  assert.ok(exteriorCells > 3, 'за внешней стеной должен оставаться настоящий пояс местности')

  const exteriorProps = map.props.filter((prop) => cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone === 'exterior')
  assert.ok(exteriorProps.some((prop) => prop.assetId.startsWith('tree_') || ['bush', 'shrub', 'boulder', 'rock_small'].includes(prop.assetId)))

  const centerX = Math.floor((2 + map.width - 3) / 2)
  for (let y = 14; y <= 25; y += 1) {
    assert.equal(cellAt(map, centerX, y)?.material, 'stone', `главная дорожка прервана в ${centerX},${y}`)
  }
})

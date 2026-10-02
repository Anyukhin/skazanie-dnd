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
  planRooms,
  reachabilityIssues,
  safeRoom,
  tacticalFitnessWarnings,
} from '../server/building-generator.mjs'
import {
  cellAt,
  edgeList,
  legacyCellsFromTacticalMap,
  movementStepBlocked,
  reachableCells,
  serializeTacticalMap,
  validateTacticalMap,
} from '../server/tactical-map.mjs'

const scene = () => generateBuildingScene({ seed: 'reference' })

test('плотность обстановки меняет число предметов при той же планировке', () => {
  const options = { seed: 'density-building', width: 40, height: 36 }
  const sparse = generateBuildingScene({ ...options, design: { building_use: 'dwelling', density: 'sparse' } })
  const dense = generateBuildingScene({ ...options, design: { building_use: 'dwelling', density: 'dense' } })
  assert.deepEqual(sparse.zones, dense.zones)
  assert.ok(dense.props.length > sparse.props.length, `${sparse.props.length} против ${dense.props.length}`)
})

test('сцена-эталон имеет размер около 26×26', () => {
  const map = scene()
  assert.equal(map.width, REFERENCE_SIZE.width)
  assert.equal(map.height, REFERENCE_SIZE.height)
  assert.equal(map.width * map.height, 676)
})

test('planRooms без design сохраняет прежнюю трёхкомнатную схему', () => {
  const plan = planRooms({ minX: 4, minY: 4, maxX: 20, maxY: 20 })
  assert.deepEqual(plan.rooms.map((room) => room.zoneId), ['hall', 'kitchen', 'store'])
  assert.equal(plan.partitionX, 14)
  assert.equal(plan.partitionY, 12)
})

test('генерация детерминирована от seed', () => {
  const first = JSON.stringify(serializeTacticalMap(generateBuildingScene({ seed: 'same' })))
  const second = JSON.stringify(serializeTacticalMap(generateBuildingScene({ seed: 'same' })))
  assert.equal(first, second)
  assert.notEqual(first, JSON.stringify(serializeTacticalMap(generateBuildingScene({ seed: 'other' }))))
})

test('обычный вызов выбирает таверну, а тема магазина — магазин', () => {
  const tavern = generateBuildingScene({ seed: 'theme-default' })
  const shop = generateBuildingScene({ seed: 'theme-shop', theme: 'market-shop' })
  const assetsIn = (map, zoneId) => new Set(map.props
    .filter((prop) => cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone === zoneId)
    .map((prop) => prop.assetId))
  assert.equal(assetsIn(tavern, 'hall').has('bar_counter'), true)
  assert.equal(assetsIn(shop, 'hall').has('bar_counter'), false)
  assert.equal(assetsIn(shop, 'workshop').has('table_long'), true)
})

test('entry управляет точкой появления и раскрытием зала, сохраняя реквизит', () => {
  const exterior = generateBuildingScene({ seed: 'entry-contract' })
  const interior = generateBuildingScene({ seed: 'entry-contract', entry: 'interior' })
  const party = (map) => map.spawnPoints.find((point) => point.role === 'party')
  const revealedIn = (map, zoneId) => {
    let count = 0
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell?.zone === zoneId && cell.revealed) count += 1
    }
    return count
  }
  const outsideSpawn = party(exterior)
  const insideSpawn = party(interior)
  assert.equal(cellAt(exterior, outsideSpawn.x, outsideSpawn.y)?.zone, 'yard')
  assert.equal(cellAt(interior, insideSpawn.x, insideSpawn.y)?.zone, 'hall')
  assert.ok(revealedIn(interior, 'hall') > 0)
  for (const zoneId of ['kitchen', 'store']) assert.equal(revealedIn(interior, zoneId), 0)
  assert.ok(interior.props.length > 0, 'внутренний вход не должен отключать реквизит')
  assert.equal(interior.props.some((prop) => prop.footprint.some((cell) => cell.x === insideSpawn.x && cell.y === insideSpawn.y)), false)
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
  assert.equal(map.doors.length, 4, 'вход, задняя дверь кухни и две внутренние двери')
  assert.ok(map.doors.some((door) => door.id === 'back-door'), 'у кухни есть своя дверь во двор')
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

test('стены здания — тонкие рёбра, и сквозь них не пройти и не увидеть', () => {
  const map = scene()
  const walls = edgeList(map).filter((edge) => edge.kind === 'wall')
  assert.ok(walls.length > 30, `рёбер-стен всего ${walls.length}`)

  // Стена лежит на ребре между двумя клетками пола (server/thin-walls.mjs):
  // клетка остаётся полом, а шаг и взгляд через ребро закрыты.
  let thin = 0
  for (const edge of walls) {
    const owner = cellAt(map, edge.x, edge.y)
    const nx = edge.dir === 'e' ? edge.x + 1 : edge.x
    const ny = edge.dir === 'e' ? edge.y : edge.y + 1
    const neighbor = cellAt(map, nx, ny)
    assert.ok(owner && neighbor, 'ребро между существующими клетками')
    assert.equal(edge.blocksMove && edge.blocksSight, true, 'стена держит и шаг, и взгляд')
    if (!owner.passable || !neighbor.passable) continue
    thin += 1
    assert.equal(movementStepBlocked(map, edge.x, edge.y, nx, ny), true, 'сквозь тонкую стену не пройти')
  }
  assert.ok(thin > 20, `тонких стен всего ${thin}`)
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
  assert.ok(cells.some((cell) => cell.type === 'wall' || cell.walls), 'стены обязаны читаться старым кодом')
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
  assert.ok(['none', 'rect', 'no_props', 'safe_room'].includes(tiny.fallback), tiny.fallback)
  assert.deepEqual(validateTacticalMap(tiny.map).errors, [])
  assert.deepEqual(reachabilityIssues(tiny.map), [])
})

test('design меняет настоящую планировку, размер и мебель по назначению', () => {
  const dwelling = generateBuildingScene({ seed: 'design-dwelling', design: { building_use: 'dwelling', climate: 'cold', architecture: 'stone' } })
  const tavern = generateBuildingScene({ seed: 'design-tavern', design: { building_use: 'tavern', climate: 'temperate', architecture: 'wood' } })
  const shop = generateBuildingScene({ seed: 'design-shop', design: { building_use: 'shop', climate: 'arid', architecture: 'sand' } })
  const manor = generateBuildingScene({ seed: 'design-manor', design: { building_use: 'manor', climate: 'wetland', architecture: 'marble' } })
  const assetsIn = (map, zoneId) => new Set(map.props
    .filter((prop) => cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone === zoneId)
    .map((prop) => prop.assetId))
  assert.ok(dwelling.zones.some((zone) => zone.id === 'bedroom'))
  assert.equal([...assetsIn(dwelling, 'hall')].some((asset) => asset === 'bar_counter' || asset === 'bar_shelf'), false)
  assert.ok(tavern.zones.some((zone) => zone.id === 'hall') && tavern.zones.some((zone) => zone.id === 'kitchen') && tavern.zones.some((zone) => zone.id === 'store'))
  assert.ok(assetsIn(tavern, 'hall').has('bar_counter'))
  assert.ok(shop.zones.some((zone) => zone.id === 'workshop'))
  assert.ok(assetsIn(shop, 'workshop').has('table_long'))
  assert.ok(manor.zones.some((zone) => zone.id === 'salon'))
  assert.equal(cellAt(dwelling, 0, 0)?.material, 'ice')
  assert.equal(cellAt(shop, 0, 0)?.material, 'sand')
  assert.notDeepEqual(
    JSON.stringify(serializeTacticalMap(generateBuildingScene({ seed: 'layout-a', design: { building_use: 'tavern', climate: 'temperate', architecture: 'wood' } }))),
    JSON.stringify(serializeTacticalMap(generateBuildingScene({ seed: 'layout-b', design: { building_use: 'tavern', climate: 'temperate', architecture: 'wood' } }))),
  )
})

test('100 сидов спроектированных зданий валидны, связны и заметно различаются', () => {
  const uses = ['dwelling', 'tavern', 'shop', 'manor']
  const climates = ['temperate', 'arid', 'cold', 'wetland']
  const architectures = ['wood', 'stone', 'sand', 'metal', 'marble', 'ice']
  const signatures = new Set()
  let shaped = 0
  for (let index = 0; index < 100; index += 1) {
    const design = { building_use: uses[index % uses.length], climate: climates[index % climates.length], architecture: architectures[index % architectures.length] }
    const built = buildBuildingScene({ seed: `design-${index}`, design })
    // Фигурный корпус, срезавший комнату целиком, уступает прямоугольнику:
    // потерять кухню хуже, чем потерять Г-образность.
    assert.ok(['none', 'rect'].includes(built.fallback), `design-${index}: unexpected fallback ${built.fallback}`)
    if (built.fallback === 'none') shaped += 1
    const filled = new Set()
    for (let y = 0; y < built.map.height; y += 1) for (let x = 0; x < built.map.width; x += 1) {
      const cell = cellAt(built.map, x, y)
      if (cell?.passable) filled.add(cell.zone)
    }
    const empty = built.map.zones.filter((zone) => zone.kind === 'interior' && zone.id !== 'walls' && !filled.has(zone.id)).map((zone) => zone.id)
    assert.deepEqual(empty, [], `design-${index}: помещения без пола`)
    assert.deepEqual(validateTacticalMap(built.map).errors, [], `design-${index}: invalid map`)
    assert.deepEqual(reachabilityIssues(built.map), [], `design-${index}: unreachable zone`)
    signatures.add(JSON.stringify({ width: built.map.width, height: built.map.height, zones: built.map.zones.map((zone) => zone.id), doors: built.map.doors.map((door) => door.id) }))
  }
  assert.ok(signatures.size >= 8, `layout diversity too low: ${signatures.size}`)
  assert.ok(shaped >= 80, `первая попытка удалась лишь ${shaped} раз из 100`)
})

test('схемы здания меняют геометрию, а двор остаётся exterior и достижимым', () => {
  const samples = new Map()
  const boundsFor = (map, zoneId) => {
    const cells = []
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      if (cellAt(map, x, y)?.zone === zoneId) cells.push({ x, y })
    }
    assert.ok(cells.length, `${zoneId}: зона должна иметь клетки`)
    return {
      minX: Math.min(...cells.map((cell) => cell.x)),
      minY: Math.min(...cells.map((cell) => cell.y)),
      maxX: Math.max(...cells.map((cell) => cell.x)),
      maxY: Math.max(...cells.map((cell) => cell.y)),
    }
  }
  const classify = (map) => {
    if (map.zones.some((zone) => zone.id === 'courtyard')) return 'courtyard'
    const hall = boundsFor(map, 'hall')
    return hall.maxX - hall.minX > hall.maxY - hall.minY ? 'long-hall' : 'wing'
  }
  for (let index = 0; index < 200 && samples.size < 3; index += 1) {
    const map = generateBuildingScene({ seed: `geometry-${index}`, design: { building_use: 'dwelling' } })
    samples.set(classify(map), map)
  }
  assert.deepEqual([...samples.keys()].sort(), ['courtyard', 'long-hall', 'wing'])
  const geometry = new Set([...samples.values()].map((map) => JSON.stringify(boundsFor(map, 'hall'))))
  assert.equal(geometry.size, 3, 'три схемы должны различаться геометрией зала')

  const courtyard = samples.get('courtyard')
  assert.ok(courtyard)
  assert.equal(courtyard.zones.find((zone) => zone.id === 'courtyard')?.kind, 'exterior')
  const courtyardCells = []
  for (let y = 0; y < courtyard.height; y += 1) for (let x = 0; x < courtyard.width; x += 1) {
    if (cellAt(courtyard, x, y)?.zone === 'courtyard') courtyardCells.push({ x, y })
  }
  assert.ok(courtyardCells.length >= 9, 'внутренний двор должен быть настоящей площадкой')
  const spawn = courtyard.spawnPoints.find((point) => point.role === 'party')
  assert.ok(spawn)
  const reached = reachableCells(courtyard, spawn.x, spawn.y)
  assert.ok(courtyardCells.some((cell) => reached.has(`${cell.x},${cell.y}`)), 'во двор должен вести проход')
})

test('спроектированное здание сохраняет двери и объявленные переходы этажей', () => {
  const map = generateBuildingScene({
    seed: 'design-levels',
    design: { building_use: 'tavern', climate: 'temperate', architecture: 'wood' },
    levels: [{ offset: 1, label: 'Спальни' }, { offset: -1, label: 'Погреб' }],
  })
  assert.ok(map.doors.some((door) => door.id === 'front-door'))
  assert.ok(map.doors.some((door) => door.id === 'kitchen-door'))
  assert.ok(map.doors.some((door) => door.id === 'store-door'))
  assert.ok(map.props.some((prop) => prop.transition?.toLevel === 1))
  assert.ok(map.props.some((prop) => prop.transition?.toLevel === -1))
  assert.deepEqual(validateTacticalMap(map).errors, [])
  assert.deepEqual(reachabilityIssues(map), [])
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
    ['workshop', ['workbench', 'crate', 'barrel', 'firewood_stack']],
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

test('коридорная планировка: зал по фасаду, коридор и отдельные комнаты с дверью в коридор', () => {
  for (const [use, expected] of [['dwelling', /^bedroom/u], ['tavern', /^guest-/u], ['manor', /^(?:salon|study)$/u]]) {
    const built = buildBuildingScene({ seed: `corridor-${use}`, width: 44, height: 40, design: { building_use: use, scheme: 'corridor', shape: 'rect' } })
    const map = built.map
    assert.equal(built.fallback, 'none', `${use}: откат`)
    assert.ok(map.zones.some((zone) => zone.id === 'corridor' && zone.label === 'Коридор'), `${use}: нет коридора`)
    const rooms = map.zones.filter((zone) => zone.kind === 'interior' && !['hall', 'corridor', 'walls'].includes(zone.id))
    assert.ok(rooms.length >= 3, `${use}: за коридором ${rooms.length} комнат`)
    assert.ok(rooms.some((zone) => expected.test(zone.id)), `${use}: нет ${expected}`)
    // Каждая комната за коридором входит через коридор, а не через зал.
    for (const room of rooms) {
      const door = map.doors.find((entry) => entry.id === `${room.id}-door`)
      assert.ok(door, `${use}/${room.id}: нет двери`)
      const sides = [cellAt(map, door.x, door.y), cellAt(map, door.dir === 'e' ? door.x + 1 : door.x, door.dir === 's' ? door.y + 1 : door.y)].map((cell) => cell?.zone)
      assert.ok(sides.includes('corridor') && sides.includes(room.id), `${use}/${room.id}: дверь ведёт в ${sides}`)
    }
    assert.deepEqual(reachabilityIssues(map), [], `${use}: недоступные помещения`)
  }
})

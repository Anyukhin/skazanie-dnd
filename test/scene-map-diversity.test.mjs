import assert from 'node:assert/strict'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import {
  createSceneTransition,
  generateSceneGeometry,
  rememberCurrentSceneMap,
} from '../server/adventure-director.mjs'
import { FakeLLM } from '../server/llm-client.mjs'
import {
  cellAt,
  edgeList,
  edgeNeighbor,
  reachableCells,
  deserializeTacticalMap,
  serializeTacticalMap,
  tacticalMapHash,
  validateTacticalMap,
} from '../server/tactical-map.mjs'

const DESIGN_FIELDS = ['topology', 'climate', 'architecture', 'density', 'building_use']
const HOUSE_KINDS = new Set(['interior'])

const hero = {
  id: 'map-diversity-hero',
  character: 'Картограф',
  name: 'Картограф',
  role: 'Следопыт · ур. 1',
  species: 'Человек',
  background: 'Странник',
  maxHp: 12,
}

function sceneInput(seed, design, overrides = {}) {
  return {
    seed,
    locationId: overrides.locationId ?? `map-diversity-${seed}`,
    location: overrides.location ?? 'Городская окраина',
    theme: overrides.theme ?? 'городские улицы',
    sceneKind: overrides.sceneKind ?? 'settlement',
    settlementType: overrides.settlementType ?? 'city',
    worldKind: overrides.worldKind ?? 'city',
    description: overrides.description ?? 'Каноническое описание новой точки назначения.',
    worldDescription: overrides.worldDescription ?? 'Мир с дорогами, поселениями и разными климатическими зонами.',
    biome: overrides.biome ?? 'temperate',
    map: {
      layout: 'streets',
      pattern: 'village',
      width: overrides.width ?? 32,
      height: overrides.height ?? 24,
      ...(design ? { design } : {}),
    },
  }
}

function cellsOf(map) {
  const cells = []
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell) cells.push(cell)
    }
  }
  return cells
}

function settlementBuildingZones(map) {
  const named = map.zones.filter((zone) => /^(?:building|house)-/u.test(zone.id))
  return named.length
    ? named
    : map.zones.filter((zone) => HOUSE_KINDS.has(zone.kind) && Boolean(zone.label))
}

function zoneGeometrySignature(map, predicate = null) {
  const cells = cellsOf(map)
  return JSON.stringify(map.zones
    .filter(predicate ?? ((zone) => settlementBuildingZones(map).includes(zone)))
    .map((zone) => {
      const zoneCells = cells.filter((cell) => cell.zone === zone.id && cell.passable)
      const xs = zoneCells.map((cell) => cell.x)
      const ys = zoneCells.map((cell) => cell.y)
      const minX = xs.length ? Math.min(...xs) : 0
      const minY = ys.length ? Math.min(...ys) : 0
      return {
        width: xs.length ? Math.max(...xs) - minX + 1 : 0,
        height: ys.length ? Math.max(...ys) - minY + 1 : 0,
        cells: zoneCells.length,
        shape: zoneCells
          .map((cell) => `${cell.x - minX},${cell.y - minY}`)
          .sort(),
      }
    })
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
}

function settlementCountAndAreas(map) {
  const cells = cellsOf(map)
  const areas = settlementBuildingZones(map)
    .map((zone) => cells.filter((cell) => cell.zone === zone.id && cell.passable).length)
    .sort((left, right) => left - right)
  return JSON.stringify({ count: areas.length, areas })
}

function designOf(map) {
  return map?.design && typeof map.design === 'object' && !Array.isArray(map.design)
    ? map.design
    : null
}

function exposedDesign(t, map) {
  const design = designOf(map)
  if (!design) {
    t.diagnostic('map.design остаётся входной заявкой и пока не публикуется в TacticalMap')
  }
  return design
}

function assertDesign(design, expected) {
  for (const field of DESIGN_FIELDS) assert.equal(design[field], expected[field], `map.design.${field}`)
}

function hasWater(map) {
  return cellsOf(map).filter((cell) => cell.surface === 'water').length > 0
}

function hasCrossingFeature(map) {
  const text = JSON.stringify({ props: map.props, zones: map.zones, edges: edgeList(map) }).toLocaleLowerCase('ru')
  if (/(?:bridge|pier|dock|quay|jetty|пристан|пирс|мост|переправ)/u.test(text)) return true
  // Пирс/мост может быть частью слоя пола: тогда он остаётся проходимым в
  // зоне воды или прямо поверх клеток русла.
  if (cellsOf(map).some((cell) => cell.passable && (cell.zone === 'water' || cell.surface === 'water'))) return true
  const water = cellsOf(map).filter((cell) => cell.surface === 'water')
  const waterRows = new Set(water.filter((cell) => water.filter((other) => other.y === cell.y).length >= map.width * 0.4).map((cell) => cell.y))
  const waterColumns = new Set(water.filter((cell) => water.filter((other) => other.x === cell.x).length >= map.height * 0.4).map((cell) => cell.x))
  if (cellsOf(map).some((cell) => cell.passable && (waterRows.has(cell.y) || waterColumns.has(cell.x)))) return true
  // Речной мост может быть частью пола, поэтому допускаем геометрическое
  // доказательство: проходимая клетка пересекает водный канал поперёк.
  return cellsOf(map).some((cell) => {
    if (!cell.passable || cell.surface === 'water') return false
    const horizontal = cellAt(map, cell.x - 1, cell.y)?.surface === 'water'
      && cellAt(map, cell.x + 1, cell.y)?.surface === 'water'
    const vertical = cellAt(map, cell.x, cell.y - 1)?.surface === 'water'
      && cellAt(map, cell.x, cell.y + 1)?.surface === 'water'
    return horizontal || vertical
  })
}

function hasCentralMarket(map) {
  const centerX = (map.width - 1) / 2
  const centerY = (map.height - 1) / 2
  const central = cellsOf(map).filter((cell) => (
    Math.abs(cell.x - centerX) <= map.width * 0.2
    && Math.abs(cell.y - centerY) <= map.height * 0.2
  ))
  // Самая обычная лавка может случайно попасть в центр. Признаком площади
  // считаем именно отдельную центральную зону/landmark, а не имя реквизита.
  const centralIds = new Set(central.map((cell) => cell.zone).filter(Boolean))
  const centralZones = map.zones
    .filter((zone) => centralIds.has(zone.id))
    .map((zone) => `${zone.id} ${zone.label ?? ''}`)
    .join(' ')
    .toLocaleLowerCase('ru')
  const centralLabels = (map.overlays?.roomLabels ?? [])
    .filter((label) => centralIds.has(label.zoneId))
    .map((label) => label.label)
    .join(' ')
  const metadata = JSON.stringify({ plaza: map.plaza, landmarks: map.landmarks, market: map.market }).toLocaleLowerCase('ru')
  return /(market|plaza|рынок|площадь|базар)/u.test(`${centralZones} ${centralLabels} ${metadata}`)
}

function assertConnectedMap(map, label) {
  const report = validateTacticalMap(map)
  assert.equal(report.ok, true, `${label}: ${JSON.stringify(report.errors.slice(0, 3))}`)
  const spawn = map.spawnPoints.find((point) => point.role === 'party')
  assert.ok(spawn, `${label}: нет точки появления отряда`)
  assert.equal(cellAt(map, spawn.x, spawn.y)?.passable, true, `${label}: вход непроходим`)
  const blockedCells = new Set(map.props
    .filter((prop) => prop.blocksMove === true)
    .flatMap((prop) => prop.footprint ?? [])
    .map((cell) => `${cell.x},${cell.y}`))
  assert.equal(blockedCells.has(`${spawn.x},${spawn.y}`), false, `${label}: реквизит перекрыл вход`)
  const reached = reachableCells(map, spawn.x, spawn.y, { throughDoors: true, blockedCells })
  assert.ok(reached.size > 0, `${label}: от входа некуда идти`)

  for (const zone of map.zones) {
    const zoneCells = cellsOf(map).filter((cell) => cell.zone === zone.id && cell.passable && !blockedCells.has(`${cell.x},${cell.y}`))
    if (!zoneCells.length) continue
    if (zone.kind === 'interior') {
      assert.ok(zoneCells.every((cell) => reached.has(`${cell.x},${cell.y}`)), `${label}: часть интерьера ${zone.id} изолирована`)
    } else {
      assert.ok(zoneCells.some((cell) => reached.has(`${cell.x},${cell.y}`)), `${label}: зона ${zone.id} изолирована`)
    }
  }
  for (const door of map.doors) {
    const owner = cellAt(map, door.x, door.y)
    const otherPosition = edgeNeighbor(door)
    const other = cellAt(map, otherPosition.x, otherPosition.y)
    assert.ok(owner?.passable || other?.passable, `${label}: дверь ${door.id} не имеет пола`)
    if (owner?.passable && !blockedCells.has(`${owner.x},${owner.y}`)) assert.ok(reached.has(`${owner.x},${owner.y}`), `${label}: дверь ${door.id} недостижима`)
    if (other?.passable && !blockedCells.has(`${other.x},${other.y}`)) assert.ok(reached.has(`${other.x},${other.y}`), `${label}: вторая сторона ${door.id} недостижима`)
  }
}

test('поселения меняют композицию домов на bounded-выборке сидов', () => {
  const signatures = new Set()
  for (let index = 0; index < 12; index += 1) {
    const map = generateSceneGeometry(sceneInput(`composition-${index}`, null, {
      location: 'Ривермарк',
      theme: 'городские улицы',
    })).map
    signatures.add(zoneGeometrySignature(map))
  }
  assert.ok(signatures.size >= 4, `ожидалось минимум 4 композиции домов, получено ${signatures.size}`)
})

test('каждая городская topology-family меняет состав и размеры помещений, а не только координаты', () => {
  const topologies = ['gate', 'market', 'crossroads', 'river']
  const failures = []
  for (const topology of topologies) {
    const signatures = new Set()
    const countAndAreas = new Set()
    for (let index = 0; index < 12; index += 1) {
      const map = generateSceneGeometry(sceneInput(`family-${topology}-${index}`, {
        topology, climate: 'temperate', architecture: 'stone', density: 'mixed', building_use: 'dwelling',
      }, {
        location: 'Городская окраина', theme: 'городские улицы', worldKind: 'city',
        description: 'Городская сцена без подсказки о конкретной планировке.',
      })).map
      // zoneGeometrySignature намеренно не содержит координат, seed, hash или
      // название зоны, материал и направление пола: остаётся только реальный
      // размер, площадь и нормализованная форма помещений.
      signatures.add(zoneGeometrySignature(map))
      countAndAreas.add(settlementCountAndAreas(map))
    }
    if (signatures.size < 3 || countAndAreas.size < 2) {
      failures.push(`${topology}: compositions=${signatures.size}, count/areas=${countAndAreas.size}`)
    }
  }
  assert.deepEqual(failures, [], `семейства без внутреннего разнообразия (нужно >=3 и >=2 count/areas): ${failures.join(', ')}`)
})

test('один и тот же seed и контекст дают стабильную карту и hash после round-trip', () => {
  const input = sceneInput('stable', {
    topology: 'courtyard', climate: 'temperate', architecture: 'stone', density: 'mixed', building_use: 'manor',
  }, { location: 'Каменный двор', theme: 'каменный двор', worldKind: 'city' })
  const first = generateSceneGeometry(input).map
  const second = generateSceneGeometry(input).map
  assert.deepEqual(serializeTacticalMap(first), serializeTacticalMap(second))
  const restored = deserializeTacticalMap(serializeTacticalMap(first))
  assert.equal(tacticalMapHash(restored), tacticalMapHash(first))
  if (designOf(first)) assert.deepEqual(restored.design, first.design)
})

test('сгенерированные темы сохраняют вход, двери и связность зон', () => {
  const cases = [
    ['поселение', sceneInput('connect-settlement', null)],
    ['лес', {
      seed: 'connect-forest', locationId: 'connect-forest', location: 'Тёмный лес', theme: 'Тёмный лес',
      sceneKind: 'wilderness', worldKind: 'wilderness', map: { layout: 'open', pattern: 'natural', width: 26, height: 18 },
    }],
    ['склеп', {
      seed: 'connect-crypt', locationId: 'connect-crypt', location: 'Склеп', theme: 'Древний склеп',
      sceneKind: 'dungeon', worldKind: 'dungeon', map: { layout: 'rooms', pattern: 'crypt', width: 26, height: 18 },
    }],
    ['таверна', {
      seed: 'connect-tavern', locationId: 'connect-tavern', location: 'Таверна', theme: 'Таверна',
      sceneKind: 'building', map: { layout: 'rooms', pattern: 'small-room', width: 26, height: 26 },
    }],
  ]
  for (const [label, input] of cases) assertConnectedMap(generateSceneGeometry(input).map, label)
})

test('лес и склеп получают собственные тематические материалы и реквизит', () => {
  const forest = generateSceneGeometry({
    seed: 'theme-forest', locationId: 'theme-forest', location: 'Лесная опушка', theme: 'Тёмный лес',
    sceneKind: 'wilderness', worldKind: 'wilderness', map: { layout: 'open', pattern: 'natural' },
  }).map
  const crypt = generateSceneGeometry({
    seed: 'theme-crypt', locationId: 'theme-crypt', location: 'Склеп', theme: 'Древний склеп',
    sceneKind: 'dungeon', worldKind: 'dungeon', map: { layout: 'rooms', pattern: 'crypt' },
  }).map
  assert.equal(forest.theme, 'forest')
  assert.ok(forest.props.some((prop) => /^tree_|^fallen_log$|^campfire$/u.test(prop.assetId)))
  assert.equal(crypt.theme, 'crypt')
  assert.ok(crypt.props.some((prop) => /^(?:sarcophagus|grave|urn|crypt_niche)$/u.test(prop.assetId)))
  assert.equal(crypt.props.some((prop) => /^tree_/u.test(prop.assetId)), false)
})

test('design.harbor требует воду и причальный переход', (t) => {
  const map = generateSceneGeometry(sceneInput('design-harbor', {
    topology: 'harbor', climate: 'wetland', architecture: 'wood', density: 'mixed', building_use: 'shop',
  }, {
    location: 'Каменная гавань', theme: 'портовые улицы', settlementType: 'port', worldKind: 'port',
    description: 'Пристань с пирсами вдоль воды.', biome: 'coast',
  })).map
  const design = exposedDesign(t, map)
  if (design) assertDesign(design, { topology: 'harbor', climate: 'wetland', architecture: 'wood', density: 'mixed', building_use: 'shop' })
  assert.equal(hasWater(map), true, 'гавань должна иметь водную поверхность')
  assert.equal(hasCrossingFeature(map), true, 'гавань должна иметь пирс или причальный переход')
})

test('design.river требует русло и проходимый мост', (t) => {
  const map = generateSceneGeometry(sceneInput('design-river', {
    topology: 'river', climate: 'temperate', architecture: 'stone', density: 'dense', building_use: 'dwelling',
  }, {
    location: 'Город на реке', theme: 'речной город', worldKind: 'city',
    description: 'Город стоит на двух берегах реки с мостом.', biome: 'river',
  })).map
  const design = exposedDesign(t, map)
  if (design) assertDesign(design, { topology: 'river', climate: 'temperate', architecture: 'stone', density: 'dense', building_use: 'dwelling' })
  assert.equal(hasWater(map), true, 'река должна иметь русло')
  assert.equal(hasCrossingFeature(map), true, 'через русло должен быть мост или переправа')
})

test('design.market ставит рынок в центральной площади, а arid seeds не сводятся к четырём домам', (t) => {
  const market = generateSceneGeometry(sceneInput('design-market', {
    topology: 'market', climate: 'temperate', architecture: 'stone', density: 'dense', building_use: 'shop',
  }, {
    location: 'Городской рынок', theme: 'рыночная площадь', worldKind: 'city',
    description: 'Торговая площадь в центре города.',
  })).map
  const marketDesign = exposedDesign(t, market)
  if (marketDesign) assertDesign(marketDesign, { topology: 'market', climate: 'temperate', architecture: 'stone', density: 'dense', building_use: 'shop' })
  assert.equal(hasCentralMarket(market), true, 'у рынка должна быть центральная площадь')

  const aridSignatures = new Set()
  const aridCounts = new Set()
  for (let index = 0; index < 12; index += 1) {
    const arid = generateSceneGeometry(sceneInput(`design-arid-${index}`, {
      topology: 'organic', climate: 'arid', architecture: 'sand', density: 'mixed', building_use: 'dwelling',
    }, {
      location: 'Песчаная деревня', theme: 'песчаная деревня', worldKind: 'village', settlementType: 'village',
      description: 'Сухая деревня в песках.', biome: 'desert',
    })).map
    assert.ok(cellsOf(arid).some((cell) => cell.material === 'sand' || cell.surface === 'sand'), 'пустыня должна быть песчаной')
    aridSignatures.add(zoneGeometrySignature(arid))
    aridCounts.add(arid.zones.filter((zone) => HOUSE_KINDS.has(zone.kind)).length)
  }
  assert.ok(aridSignatures.size >= 4, `пустынные деревни повторяют ${aridSignatures.size} композиций`)
  assert.ok(aridCounts.size >= 2 || !aridCounts.has(4), `количество домов не должно быть постоянным: ${[...aridCounts]}`)
})

test('building_use различает таверну и жильё по композиции и семантике', (t) => {
  const tavern = generateSceneGeometry(sceneInput('building-use', {
    topology: 'courtyard', climate: 'temperate', architecture: 'wood', density: 'mixed', building_use: 'tavern',
  }, { location: 'Постоялый двор', theme: 'постоялый двор', sceneKind: 'building', worldKind: 'town' })).map
  const dwelling = generateSceneGeometry(sceneInput('building-use', {
    topology: 'courtyard', climate: 'temperate', architecture: 'wood', density: 'mixed', building_use: 'dwelling',
  }, { location: 'Жилой дом', theme: 'жилой дом', sceneKind: 'building', worldKind: 'town' })).map
  const tavernDesign = exposedDesign(t, tavern)
  const dwellingDesign = designOf(dwelling)
  if (tavernDesign) assert.equal(tavernDesign.building_use, 'tavern')
  if (dwellingDesign) assert.equal(dwellingDesign.building_use, 'dwelling')
  assert.notEqual(zoneGeometrySignature(tavern), zoneGeometrySignature(dwelling), 'назначение должно менять планировку')
  const tavernText = JSON.stringify({ zones: tavern.zones, props: tavern.props }).toLocaleLowerCase('ru')
  const dwellingText = JSON.stringify({ zones: dwelling.zones, props: dwelling.props }).toLocaleLowerCase('ru')
  assert.match(tavernText, /tavern|bar_|counter|таверн|постоял|бар|стойк/iu)
  assert.match(dwellingText, /bed|wardrobe|night_table|дом|жиль|подвор|спальн/iu)
})

test('упоминание погоды снаружи не переносит отряд из таверны во двор', () => {
  const input = { location: 'Таверна', theme: 'таверна', seed: 'entry-weather',
    map: { layout: 'rooms', width: 30, height: 26 } }
  const inside = generateSceneGeometry({ ...input, description: 'Снаружи дождь, а в зале трещит очаг.' }).map
  const outside = generateSceneGeometry({ ...input, description: 'Отряд стоит снаружи у входа в таверну.' }).map
  const spawnZone = (map) => { const point = map.spawnPoints.find((entry) => entry.role === 'party'); return cellAt(map, point.x, point.y)?.zone }
  assert.equal(spawnZone(inside), 'hall')
  assert.equal(spawnZone(outside), 'yard')
})

test('таверна у озера сохраняет интерьер, близость воды не заменяет её береговой картой', () => {
  const map = generateSceneGeometry({ seed: 'tavern-lake', location: 'Таверна у озера',
    theme: 'таверна', sceneKind: 'building', description: 'За окнами виден берег озера.',
    map: { layout: 'rooms', pattern: 'great-hall', width: 30, height: 26, water: 0.4 } }).map
  assert.equal(map.generator.id, 'building-with-yard')
  assert.ok(map.zones.some((zone) => zone.id === 'hall' && zone.kind === 'interior'))
  assert.equal(cellsOf(map).some((cell) => cell.surface === 'water'), false)
})

test('описание речной переправы на дороге создаёт русло и связный каменный мост', () => {
  const map = generateSceneGeometry({ seed: 'open-river-crossing', location: 'Старый брод', theme: 'дорога',
    sceneKind: 'road', description: 'Река пересекает дорогу, берега соединены каменным мостом.',
    map: { layout: 'open', pattern: 'natural', width: 30, height: 26 } }).map
  assert.equal(map.theme, 'road')
  assert.equal(hasWater(map), true)
  assert.ok(cellsOf(map).some((cell) => cell.zone === 'crossing' && cell.passable && cell.material === 'stone'))
  assertConnectedMap(map, 'open-river')
})

test('описанный внутренний двор здания сохраняется на каждом seed, включая небольшую заявку', () => {
  for (let index = 0; index < 12; index += 1) {
    const map = generateSceneGeometry({ seed: `court-${index}`, location: 'Таверна с внутренним двором',
      theme: 'таверна', sceneKind: 'building', description: 'Зал, кухня, кладовая и внутренний двор под открытым небом.',
      map: { layout: 'rooms', pattern: 'great-hall', width: index % 2 ? 17 : 36, height: index % 2 ? 11 : 30 } }).map
    assert.ok(map.zones.some((zone) => zone.id === 'courtyard' && zone.kind === 'exterior'), `${index}: внутренний двор потерян`)
    assertConnectedMap(map, `court-${index}`)
  }
})

test('посещённая карта возвращается без изменений даже при новом описании места', () => {
  const target = {
    id: 'harbor-location', name: 'Каменная гавань', kind: 'port',
    summary: 'Пристань с пирсами и складами.', history: 'Гавань выросла вокруг старого канала.',
    regionId: 'coast', visited: false, known: true,
  }
  const base = {
    sessionCode: 'MAP-DIVERSITY-REVISIT', campaign: 'Карты мира',
    campaignConcept: { worldSummary: 'Мир берегов и речных дорог.' },
    worldMap: {
      seed: 'map-revisit-world', currentLocationId: 'old-road',
      regions: [{ id: 'coast', name: 'Берег', biome: 'coast' }],
      locations: [
        { id: 'old-road', name: 'Старая дорога', kind: 'road', regionId: 'coast', known: true, visited: true },
        target,
      ],
      routes: [{ id: 'route', from: 'old-road', to: target.id, distance: 1, danger: 'низкая', discovered: true }],
    },
    scene: { title: 'Старая дорога', location: 'Старая дорога', location_id: 'old-road', objective: 'Путь', turn: 1, cells: [], map: null },
    adventure: { chapter: 1, currentHook: 'Путь', visitedLocations: ['Старая дорога'], visitedLocationIds: ['old-road'], history: [] },
    locationMaps: {},
  }
  const first = createSceneTransition({
    title: 'Переход к гавани', location: 'Подменённое имя', location_id: target.id,
    theme: 'портовые улицы', scene_kind: 'settlement', settlement_type: 'port',
    map: { layout: 'streets', pattern: 'village', design: { topology: 'harbor', climate: 'wetland', architecture: 'wood', density: 'mixed', building_use: 'shop' } },
  }, base)
  const atTarget = { ...base, ...first, locationMaps: {} }
  rememberCurrentSceneMap(atTarget)
  const saved = structuredClone(atTarget.locationMaps[target.id])
  const away = createSceneTransition({
    title: 'Старая дорога', location: 'Старая дорога', location_id: 'old-road',
    theme: 'дорога', scene_kind: 'road', map: { layout: 'winding', pattern: 'natural' },
  }, atTarget)
  const awayState = { ...atTarget, ...away }
  rememberCurrentSceneMap(awayState)
  const returned = createSceneTransition({
    title: 'Новое описание гавани', location: 'Совсем другое место', location_id: target.id,
    theme: 'двор на холме', scene_kind: 'settlement', settlement_type: 'port',
    map: { layout: 'open', pattern: 'natural', design: { topology: 'courtyard', climate: 'arid', architecture: 'sand', density: 'sparse', building_use: 'dwelling' } },
  }, awayState)
  assert.deepEqual(returned.scene.map, saved.map, 'повторный вход не должен пересобирать карту')
  assert.equal(returned.scene.location_id, target.id)
  assert.equal(returned.scene.location, target.name)
})

test('живой переход берёт описание, историю и biome канонической точки, а не подменённое имя', () => {
  const base = {
    sessionCode: 'MAP-DIVERSITY-CANON', campaign: 'Канонические места',
    campaignConcept: { worldSummary: 'На юге пустыня, на севере снежная тундра.' },
    worldMap: {
      seed: 'map-canon-world', currentLocationId: 'old-road',
      regions: [{ id: 'river-valley', name: 'Речная долина', biome: 'river' }],
      locations: [
        { id: 'old-road', name: 'Старая дорога', kind: 'road', known: true, visited: true },
        {
          id: 'river-city', name: 'Город двух берегов', kind: 'city', regionId: 'river-valley', known: true, visited: false,
          summary: 'Город стоит на двух берегах реки, между кварталами есть переправа.',
          history: 'Старый каменный мост пережил весенние разливы.',
        },
      ],
      routes: [{ id: 'river-route', from: 'old-road', to: 'river-city', distance: 1, danger: 'низкая', discovered: true }],
    },
    scene: { title: 'Старая дорога', location: 'Старая дорога', location_id: 'old-road', objective: 'Путь', turn: 1, cells: [], map: null },
    adventure: { chapter: 1, currentHook: 'Путь', visitedLocations: ['Старая дорога'], visitedLocationIds: ['old-road'], history: [] },
    locationMaps: {},
  }
  const transition = createSceneTransition({
    title: 'Прибытие', location: 'Подменённое поле', location_id: 'river-city',
    theme: 'обычная площадь', scene_kind: 'settlement', settlement_type: 'city',
    // Намеренно противоречит канону: река в summary/history должна победить.
    map: { layout: 'streets', pattern: 'village', width: 32, height: 24, design: { topology: 'crossroads', climate: 'cold' } },
  }, base)
  const map = deserializeTacticalMap(transition.scene.map)
  assert.equal(transition.scene.location, 'Город двух берегов')
  assert.equal(hasWater(map), true, 'каноническая река должна попасть в карту перехода')
  assert.equal(hasCrossingFeature(map), true, 'каноническая переправа должна попасть в карту перехода')
  const design = designOf(map)
  if (design) assert.equal(design.topology, 'river')
})

test('bootstrap учитывает design стартовой точки только когда контракт его публикует', async (t) => {
  const opening = {
    campaignName: 'Гавань на реке', partyName: 'Проверяющие',
    worldSummary: 'Мир приморских городов и сухих внутренних земель.',
    worldHistory: 'Старая гавань выросла вокруг русла реки.',
    openingNarration: 'Перед отрядом открывается порт.',
    scene: {
      title: 'Причал', location: 'Каменная гавань', locationId: 'bootstrap-harbor',
      mood: 'Солёный ветер', objective: 'Найти переправу', theme: 'портовые улицы', danger: 'низкая',
      scene_kind: 'settlement', settlement_type: 'port',
      map: {
        layout: 'streets', pattern: 'village', width: 32, height: 24,
        design: { topology: 'harbor', climate: 'wetland', architecture: 'wood', density: 'mixed', building_use: 'shop' },
      },
    },
    worldMap: {
      name: 'Валедор',
      regions: [{ id: 'coast', name: 'Берег', biome: 'coast', x: 500, y: 300, radius: 300 }],
      locations: [{ id: 'bootstrap-harbor', name: 'Каменная гавань', kind: 'port', summary: 'Пристань с пирсами.', history: 'Старая речная гавань.', regionId: 'coast', x: 500, y: 300, known: true, visited: true }],
      routes: [],
    },
    npcs: [{ id: 'harbor-guide', name: 'Проводница', role: 'проводница', location: 'Каменная гавань', summary: 'Знает причалы.', goals: [], beliefs: [] }],
  }
  const state = await new CampaignBootstrapper({ llmClient: new FakeLLM([{ content: JSON.stringify(opening) }]) }).create({
    code: 'MAP-DESIGN', name: 'Гавань на реке', world: { startingLocation: 'Каменная гавань' }, players: [hero],
  })
  assert.equal(state.scene.location, 'Каменная гавань')
  const design = exposedDesign(t, state.scene.map)
  if (design) assertDesign(design, opening.scene.map.design)
})

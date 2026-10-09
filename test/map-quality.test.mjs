import assert from 'node:assert/strict'
import test from 'node:test'

import { generateSceneGeometry } from '../server/adventure-director.mjs'
import { MAP_PREVIEW_PRESETS, auditTacticalMap } from '../server/map-quality.mjs'
import { requirementsCoverage, sceneRequirementsFromText } from '../server/scene-requirements.mjs'
import { addProp, addSpawnPoint, addZone, cellAt, createTacticalMap, edgeList, edgeNeighbor, setCell, setDoor, setEdge } from '../server/tactical-map.mjs'

/**
 * Качество сгенерированных карт для игры за столом: у дома есть дверь и
 * окна, просторная постройка поделена на комнаты, до каждой клетки можно
 * дойти, предметы не стоят в проёмах и не вылезают за край, а ходы не
 * обрываются в никуда. Эталонные сцены — те же, что печатает
 * `node tools/map-preview.mjs --preset all`.
 */

const SEEDS = ['q1', 'q2', 'q3', 'q4']

/** Размеры прогона: хижина, обычная сцена и большая карта. */
const SIZES = [{ width: 16, height: 14 }, { width: 26, height: 26 }, { width: 40, height: 32 }]

for (const preset of MAP_PREVIEW_PRESETS) {
  test(`эталонная сцена «${preset.id}» проходит проверку качества в трёх размерах на ${SEEDS.length} сидах`, () => {
    for (const size of SIZES) {
      for (const seed of SEEDS) {
        const { map } = generateSceneGeometry({ ...preset.input, map: { ...(preset.input.map ?? {}), ...size }, seed: `${preset.id}:${seed}`, useLibrary: false })
        const report = auditTacticalMap(map)
        const label = `${preset.id}/${size.width}×${size.height}/${seed}`
        assert.deepEqual(report.problems, [], `${label}: ${JSON.stringify(report.problems.slice(0, 5))}`)
        // Однообразие — замечание, но эталонные сцены держатся без него.
        assert.deepEqual(report.warnings, [], `${label}: ${JSON.stringify(report.warnings)}`)
      }
    }
  })
}

/**
 * Природа под стандарты боевой карты D&D (`docs/maps-dnd-standards-plan.md`,
 * задачи 1, 2, 6, 7): трудная местность пятнами, рельеф террасами, за чем
 * встать посреди поля. Доли — в процентах свободных клеток.
 */
const NATURE_TARGETS = Object.freeze({
  forest: { difficult: [10, 20], cover: 25 },
  swamp: { difficult: [10, 20], cover: 20 },
  road: { difficult: [5, 12], cover: 20 },
  ruins: { difficult: [5, 12], cover: 20 },
})

for (const [id, target] of Object.entries(NATURE_TARGETS)) {
  test(`природная сцена «${id}»: трудная местность ${target.difficult.join('–')}%, 2–4 уровня высоты, укрытие сбоку у ${target.cover}% клеток`, () => {
    const preset = MAP_PREVIEW_PRESETS.find((entry) => entry.id === id)
    assert.ok(preset, `нет эталонной сцены ${id}`)
    for (const size of SIZES) {
      for (const seed of SEEDS) {
        const { map } = generateSceneGeometry({ ...preset.input, map: { ...(preset.input.map ?? {}), ...size }, seed: `${preset.id}:${seed}`, useLibrary: false })
        const { stats } = auditTacticalMap(map)
        const label = `${id}/${size.width}×${size.height}/${seed}`
        assert.equal(map.generator.version, '4', label)
        // Доли — для поля, о котором есть что сказать: на крохотном тракте у
        // моста почти всё — дорога, река и место отряда у входа.
        if (stats.cells >= 150) {
          assert.ok(stats.difficult_pct >= target.difficult[0] && stats.difficult_pct <= target.difficult[1], `${label}: трудной местности ${stats.difficult_pct}%`)
          assert.ok(stats.cover_side_pct >= target.cover, `${label}: укрытие сбоку у ${stats.cover_side_pct}%`)
        }
        assert.ok(stats.elevation_levels >= 1 && stats.elevation_levels <= 4, `${label}: уровней высоты ${stats.elevation_levels}`)
        assert.ok(stats.smallest_plateau === 0 || stats.smallest_plateau >= 6, `${label}: площадка в ${stats.smallest_plateau} кл.`)
        // Каждая площадка досягаема шагом хотя бы с одной стороны.
        assert.equal(stats.climb_cells, 0, `${label}: ${stats.climb_cells} клеток только лазанием`)
        // Дорога и вход остаются ровными: ни трудной местности, ни укрытий на них.
        const entrance = map.spawnPoints.find((point) => point.role === 'party')
        for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
          assert.ok((cellAt(map, entrance.x + dx, entrance.y + dy)?.moveCost ?? 1) === 1, `${label}: трудная клетка у входа ${entrance.x + dx},${entrance.y + dy}`)
        }
        for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
          const cell = cellAt(map, x, y)
          if (cell?.zone === 'crossing') assert.equal(cell.moveCost, 1, `${label}: трудный мост ${x},${y}`)
        }
      }
    }
  })
}

test('рельеф природы — террасы: высоты кратны пяти футам, бывают возвышенности, перепад соседей — шаг', () => {
  let raised = 0
  for (const id of ['forest', 'road']) {
    const preset = MAP_PREVIEW_PRESETS.find((entry) => entry.id === id)
    for (const seed of SEEDS) {
      const { map } = generateSceneGeometry({ ...preset.input, map: { width: 26, height: 26 }, seed: `terrace:${seed}`, useLibrary: false })
      const { stats } = auditTacticalMap(map)
      if (stats.elevation_levels >= 2) raised += 1
      for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
        const cell = cellAt(map, x, y)
        if (!cell?.passable || cell.surface === 'water') continue
        assert.equal(cell.elevation % 5, 0, `${id}/${seed}: высота ${cell.elevation} фт в ${x},${y}`)
        for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
          const next = cellAt(map, x + dx, y + dy)
          if (next?.passable && next.surface !== 'water') assert.ok(Math.abs(next.elevation - cell.elevation) <= 5, `${id}/${seed}: обрыв ${x},${y} → ${x + dx},${y + dy}`)
        }
      }
    }
  }
  assert.ok(raised >= 6, `возвышенность только на ${raised} картах из 8`)
})

/**
 * Группы стен развалин: грани, чьи клетки соседствуют (и по диагонали),
 * — один фрагмент.
 */
function wallFragments(map) {
  const walls = edgeList(map).filter((edge) => edge.kind === 'wall').map((edge) => ({ a: { x: edge.x, y: edge.y }, b: edgeNeighbor(edge) }))
  const near = (left, right) => [left.a, left.b].some((p) => [right.a, right.b].some((q) => Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)) <= 1))
  const groups = []
  const seen = new Set()
  for (let start = 0; start < walls.length; start += 1) {
    if (seen.has(start)) continue
    const group = [start]
    seen.add(start)
    for (let cursor = 0; cursor < group.length; cursor += 1) {
      for (let other = 0; other < walls.length; other += 1) {
        if (seen.has(other) || !near(walls[group[cursor]], walls[other])) continue
        seen.add(other)
        group.push(other)
      }
    }
    const cells = group.flatMap((index) => [walls[index].a, walls[index].b])
    groups.push({ x: cells.reduce((sum, cell) => sum + cell.x, 0) / cells.length, y: cells.reduce((sum, cell) => sum + cell.y, 0) / cells.length })
  }
  return groups
}

test('руины у дороги — фрагменты стен в разных частях карты, обломки и остатки ворот', () => {
  const preset = MAP_PREVIEW_PRESETS.find((entry) => entry.id === 'ruins')
  for (const size of SIZES.slice(1)) {
    for (const seed of SEEDS) {
      const { map } = generateSceneGeometry({ ...preset.input, map: size, seed: `ruins:${seed}`, useLibrary: false })
      const label = `${size.width}×${size.height}/${seed}`
      const fragments = wallFragments(map)
      assert.ok(fragments.length >= 3, `${label}: фрагментов стен ${fragments.length}`)
      // Разные части карты: фрагменты не жмутся в одну треть по обеим осям.
      const spreadX = Math.max(...fragments.map((entry) => entry.x)) - Math.min(...fragments.map((entry) => entry.x))
      const spreadY = Math.max(...fragments.map((entry) => entry.y)) - Math.min(...fragments.map((entry) => entry.y))
      assert.ok(spreadX >= map.width / 3 || spreadY >= map.height / 3, `${label}: фрагменты в одном углу`)
      let rubble = 0
      for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if (cellAt(map, x, y)?.surface === 'rubble') rubble += 1
      assert.ok(rubble >= 6, `${label}: обломков ${rubble}`)
      assert.equal(map.props.filter((prop) => prop.id.startsWith('ruins-gate-pillar-')).length, 2, `${label}: нет остатков ворот`)
    }
  }
})

/** Здание вида «назначение» на нескольких сидах. */
function buildings(location, theme) {
  return SEEDS.map((seed) => generateSceneGeometry({ location, theme, seed: `${location}:${seed}`, useLibrary: false }).map)
}

/** Сколько окон выходит из помещения зоны наружу. */
function windowsOf(map, zoneId) {
  return edgeList(map).filter((edge) => {
    if (edge.kind !== 'window') return false
    const near = [cellAt(map, edge.x, edge.y), cellAt(map, edge.dir === 'e' ? edge.x + 1 : edge.x, edge.dir === 's' ? edge.y + 1 : edge.y)]
    return near.some((cell) => cell?.zone === zoneId)
  }).length
}

test('жилой дом: горница с очагом, спальня с кроватью, окна во всех жилых комнатах', () => {
  for (const map of buildings('Дом мельника', 'жилой дом')) {
    const hall = map.zones.find((zone) => zone.id === 'hall')
    assert.equal(hall?.label, 'Горница', 'главная комната жилого дома — не «общий зал» трактира')
    for (const zoneId of ['hall', 'bedroom', 'kitchen']) {
      if (!map.zones.some((zone) => zone.id === zoneId)) continue
      assert.ok(windowsOf(map, zoneId) > 0, `в комнате ${zoneId} нет окна`)
    }
    const inZone = (zoneId) => map.props.filter((prop) => cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone === zoneId).map((prop) => prop.assetId)
    assert.ok(inZone('bedroom').includes('bed'), 'в спальне нет кровати')
    assert.equal(inZone('bedroom').filter((id) => id === 'bunk_bed').length, 0, 'спальня дома — не казарма')
    assert.ok(inZone('hall').filter((id) => id === 'table_long').length === 0, 'в горнице не трактирные длинные столы')
    assert.ok(inZone('yard').length > 0, 'двор вокруг дома пустой')
  }
})

test('вход здания смотрит к месту появления отряда, у кухни есть задняя дверь', () => {
  for (const map of buildings('Таверна «Рыжий рог»', 'таверна')) {
    const front = map.doors.find((door) => door.id === 'front-door')
    const spawnY = map.height - 2
    // Отряд снаружи появляется у южного края; парадная дверь — на южной стене.
    const hallCells = []
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if (cellAt(map, x, y)?.zone === 'hall') hallCells.push(y)
    assert.ok(front, 'нет парадной двери')
    assert.ok(front.y >= Math.max(...hallCells) - 1, `дверь на y=${front.y} не на южной стене зала`)
    assert.ok(spawnY > front.y)
    assert.ok(map.doors.some((door) => door.id === 'back-door'), 'у таверны нет задней двери')
  }
})

test('дома деревни поделены на комнаты, у каждого есть окна и обстановка', () => {
  for (const seed of SEEDS) {
    const { map } = generateSceneGeometry({ location: 'Деревня Кленовка', theme: 'деревня', settlementType: 'village', seed: `village:${seed}`, useLibrary: false })
    const houses = map.zones.filter((zone) => /^building-\d+$/u.test(zone.id))
    assert.ok(houses.length >= 3)
    assert.ok(map.zones.some((zone) => zone.id.endsWith('-back')), `${seed}: ни один дом не поделён на комнаты`)
    assert.ok(edgeList(map).some((edge) => edge.kind === 'window'), `${seed}: в деревне нет окон`)
    for (const house of houses) {
      const props = map.props.filter((prop) => cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone?.startsWith(house.id)).map((prop) => prop.assetId)
      assert.ok(props.length >= 2, `${seed}/${house.id}: пустой дом`)
    }
  }
})

test('неф храма делится колоннадой, алтарь стоит только в алтарной', () => {
  for (const seed of SEEDS) {
    const { map } = generateSceneGeometry({ location: 'Храм Утренней звезды', theme: 'храм', seed: `temple:${seed}`, useLibrary: false })
    const zoneOf = (prop) => map.zones.find((zone) => zone.id === cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone)?.label
    const altars = map.props.filter((prop) => prop.assetId === 'altar').map(zoneOf)
    assert.ok(altars.length >= 1 && altars.every((label) => label === 'Алтарная'), `${seed}: алтари в ${altars}`)
    // Колоннада бывает в нескольких залах (просторный зал получает опоры
    // ради укрытий); в каждом зале колонны стоят ровными рядами: двумя, а в
    // нефе шире 15 клеток — ещё и средними, не больше четырёх.
    const colonnades = new Map()
    for (const prop of map.props.filter((entry) => entry.id.startsWith('colonnade-'))) {
      const hall = prop.id.replace(/-\d+$/u, '')
      colonnades.set(hall, [...(colonnades.get(hall) ?? []), prop])
    }
    for (const [hall, colonnade] of colonnades) {
      const lines = new Set(colonnade.map((prop) => `${Math.floor(prop.x)}`))
      const rows = new Set(colonnade.map((prop) => `${Math.floor(prop.y)}`))
      assert.ok(Math.min(lines.size, rows.size) <= 4, `${seed}/${hall}: колонны не рядами`)
    }
    assert.ok(map.props.filter((prop) => prop.assetId === 'statue').length <= 5, `${seed}: статуй больше пяти`)
  }
})

// --- сама проверка ловит плохие карты ---------------------------------------

/**
 * Дом 6×5 на лугу 12×9: стены клетками, внутри 4×3. Опции ломают его по
 * одному признаку.
 */
function sampleHouse({ door = true, windows = true, prop = null, cutByEdge = false } = {}) {
  const map = createTacticalMap({ width: 12, height: 9, seed: 'sample', generator: { id: 'manual', version: '1' } })
  addZone(map, { id: 'yard', kind: 'exterior', material: 'grass', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Двор' })
  addZone(map, { id: 'room', kind: 'interior', material: 'wood', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Комната' })
  const left = cutByEdge ? 0 : 3
  for (let y = 0; y < 9; y += 1) for (let x = 0; x < 12; x += 1) setCell(map, x, y, { passable: true, material: 'grass', zone: 'yard', revealed: true })
  for (let y = 2; y <= 6; y += 1) for (let x = left; x <= 8; x += 1) {
    const wall = (x === left && !cutByEdge) || x === 8 || y === 2 || y === 6
    setCell(map, x, y, { passable: !wall, material: 'wood', zone: wall ? '' : 'room', revealed: true })
  }
  for (let y = 2; y <= 6; y += 1) for (let x = left; x <= 8; x += 1) {
    if (cellAt(map, x, y)?.passable) continue
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (cellAt(map, x + dx, y + dy)?.passable) setEdge(map, x, y, x + dx, y + dy, { kind: 'wall' })
    }
  }
  if (door) {
    setCell(map, 5, 6, { passable: true, zone: 'room' })
    setEdge(map, 5, 6, 5, 5, { kind: 'none' })
    setDoor(map, { id: 'door', x: 5, y: 6, dir: 's', state: 'closed', blocksMove: false, blocksSight: false })
  }
  if (windows) setEdge(map, 7, 2, 7, 1, { kind: 'window', blocksMove: true, blocksSight: false })
  if (prop) addProp(map, { id: 'p', assetId: prop.assetId, x: prop.x + 0.5, y: prop.y + 0.5, rotation: 0, scale: 1, footprint: [{ x: prop.x, y: prop.y }], zOrder: 0, blocksMove: true, blocksSight: false, cover: 'half', destructible: false, hp: 0, interactive: false })
  addSpawnPoint(map, { id: 'party', x: 10, y: 8, role: 'party' })
  return map
}

const codes = (map) => auditTacticalMap(map).problems.map((problem) => problem.code)

test('проверка ловит дом без двери, без окон, обрезанный краем и с мебелью в проёме', () => {
  assert.deepEqual(codes(sampleHouse()), [], 'исправный дом — чист')
  assert.ok(codes(sampleHouse({ door: false })).includes('BUILDING_WITHOUT_EXIT'))
  assert.ok(codes(sampleHouse({ door: false })).includes('UNREACHABLE_FLOOR'))
  assert.ok(codes(sampleHouse({ cutByEdge: true })).includes('BUILDING_CUT_BY_EDGE'))
  assert.ok(codes(sampleHouse({ prop: { assetId: 'barrel', x: 5, y: 5 } })).includes('DOORWAY_BLOCKED'))
  // Окно в толстой стене стоит на грани клетки кладки, и проверка видит его
  // сквозь кладку; дом без единого окна — замечание.
  assert.ok(codes(sampleHouse({ windows: false })).includes('BUILDING_WITHOUT_WINDOWS'))
})

test('проверка ловит предмет за краем карты', () => {
  const map = sampleHouse()
  map.props.push({ id: 'ghost', assetId: 'barrel', x: 12.5, y: 4.5, rotation: 0, scale: 1, footprint: [{ x: 12, y: 4 }], zOrder: 0, blocksMove: true, blocksSight: false, cover: 'half', destructible: false, hp: 0, interactive: false, state: 'intact', interaction: null, transition: null })
  assert.ok(codes(map).includes('PROP_OUT_OF_BOUNDS'))
})

/**
 * Есть ли внутри рамки корпуса клетки двора — форма не прямоугольник. Корпус —
 * клетки кладки и помещений: тонкие стены оставляют от кладки лишь углы.
 */
function shapedOutline(map) {
  const interior = new Set(map.zones.filter((zone) => zone.kind === 'interior').map((zone) => zone.id))
  const walls = []
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const zone = cellAt(map, x, y)?.zone
    if (zone === 'walls' || interior.has(zone)) walls.push({ x, y })
  }
  const minX = Math.min(...walls.map((cell) => cell.x))
  const maxX = Math.max(...walls.map((cell) => cell.x))
  const minY = Math.min(...walls.map((cell) => cell.y))
  const maxY = Math.max(...walls.map((cell) => cell.y))
  let yard = 0
  for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) if (cellAt(map, x, y)?.zone === 'yard') yard += 1
  return yard
}

test('корпус бывает Г-образным, крестом и круглым: двери, окна, зал крупнее служебных', () => {
  for (const shape of ['L', 'cross', 'round']) {
    for (const seed of SEEDS) {
      const { map } = generateSceneGeometry({ location: 'Усадьба Вельских', theme: 'усадьба', seed: `shape:${shape}:${seed}`, map: { width: 30, height: 28, design: { shape } }, useLibrary: false })
      const label = `${shape}/${seed}`
      assert.ok(shapedOutline(map) > 0, `${label}: форма не применилась`)
      assert.deepEqual(auditTacticalMap(map).problems, [], label)
      assert.ok(map.doors.some((door) => door.id === 'front-door'), `${label}: нет парадной двери`)
      assert.ok(edgeList(map).some((edge) => edge.kind === 'window'), `${label}: нет окон`)
      const sizes = new Map()
      for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
        const cell = cellAt(map, x, y)
        if (cell?.passable && !['yard', 'courtyard'].includes(cell.zone)) sizes.set(cell.zone, (sizes.get(cell.zone) ?? 0) + 1)
      }
      const hall = sizes.get('hall') ?? 0
      assert.ok([...sizes].every(([zone, size]) => zone === 'hall' || size <= hall), `${label}: зал не самое большое помещение`)
    }
  }
  // Форму можно и назвать словами места.
  const tower = generateSceneGeometry({ location: 'Круглая башня мага', theme: 'усадьба', seed: 'tower', map: { width: 30, height: 28 }, useLibrary: false }).map
  assert.ok(shapedOutline(tower) > 0, 'круглая башня осталась прямоугольной')
})

test('деревня — не ряд одинаковых жилищ: есть таверна и лавка, у амбара сено', () => {
  let barns = 0
  for (const seed of SEEDS) {
    const { map } = generateSceneGeometry({ location: 'Деревня Кленовка', theme: 'деревня', settlementType: 'village', seed: `mix:${seed}`, map: { width: 36, height: 32 }, useLibrary: false })
    const labels = map.zones.map((zone) => zone.label)
    assert.ok(labels.some((label) => /Таверна|Постоялый|Питейный|Гостевой/u.test(label)), `${seed}: в деревне нет таверны: ${labels}`)
    assert.ok(labels.some((label) => /Лавка|Склад|Торговый|Мастерская/u.test(label)), `${seed}: в деревне нет лавки`)
    // Крупный амбар поделён на стойла и сеновал: сено ищется во всей
    // постройке, а не в каждой её комнате.
    for (const zone of map.zones.filter((entry) => /^building-\d+$/u.test(entry.id) && /Амбар|Конюшня|Скотный|Сарай/u.test(entry.label))) {
      barns += 1
      const inside = map.props.filter((prop) => (cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone ?? '').replace(/-(?:back|side)$/u, '') === zone.id).map((prop) => prop.assetId)
      assert.ok(inside.includes('haystack'), `${seed}: в амбаре нет сена`)
    }
  }
  assert.ok(barns > 0, 'ни в одной деревне нет амбара')
})

test('одинаковые предметы не стоят кучкой: проверка ловит три урны вплотную', () => {
  const map = sampleHouse()
  for (const [index, x] of [4, 5, 6].entries()) {
    addProp(map, { id: `urn-${index}`, assetId: 'urn', x: x + 0.5, y: 3.5, rotation: 0, scale: 1, footprint: [{ x, y: 3 }], zOrder: 0, blocksMove: false, blocksSight: false, cover: 'none', destructible: false, hp: 0, interactive: false })
  }
  assert.ok(codes(map).includes('REPEATED_CLUSTER'))
})

// --- ревью соответствия: место по названию получает свою карту ---------------

/** Карта места и её предметы. */
function place(location, theme, extra = {}) {
  const { map } = generateSceneGeometry({ location, theme, seed: `fidelity:${location}`, useLibrary: false, ...extra })
  const assets = new Set(map.props.map((prop) => prop.assetId))
  return { map, assets, labels: map.zones.map((zone) => zone.label) }
}

test('места узнаются по главному слову названия и строятся по назначению', () => {
  const smithy = place('Кузница Борга', 'кузница')
  assert.equal(smithy.map.generator.id, 'building-with-yard', 'кузница — здание, а не лес')
  assert.ok(smithy.labels.includes('Кузня') && smithy.assets.has('forge') && smithy.assets.has('anvil'), 'в кузне нет горна и наковальни')
  const barracks = place('Казарма городской стражи', 'казарма')
  assert.equal(barracks.map.generator.id, 'building-with-yard', '«городской» не делает казарму городом')
  assert.ok(barracks.labels.includes('Спальня стражи') && barracks.assets.has('bunk_bed'))
  const graveyard = place('Кладбище за часовней', 'кладбище')
  assert.ok(graveyard.map.props.filter((prop) => prop.assetId === 'grave').length >= 6, 'на кладбище нет рядов могил')
  const dungeon = place('Подземелье под замком', 'подземелье')
  assert.ok(dungeon.labels.includes('Караульная'), 'подземелье — не пещера')
  const hamlet = place('Хутор у леса', 'хутор', { settlementType: 'village' })
  assert.equal(hamlet.map.generator.id, 'settlement-layout', 'хутор у леса — поселение, а не лес')
  const lair = place('Логово дракона', 'пещера')
  assert.ok(lair.assets.has('coin_pile'), 'у дракона нет золота')
  const camp = place('Лагерь бандитов', 'лесной лагерь')
  assert.ok(camp.assets.has('campfire') && camp.assets.has('crate'), 'в лагере нет костра и добычи')
  assert.ok(camp.map.props.filter((prop) => prop.assetId === 'campfire').length <= 2, 'костров больше двух')
  const forest = place('Лесная поляна', 'лес')
  assert.ok(forest.map.props.filter((prop) => prop.assetId === 'campfire').length <= 1, 'в лесу больше одного костра')
})

test('мост через ущелье — провал без клеток, а через реку — вода под мостом', () => {
  const chasm = place('Мост через ущелье', 'мост')
  let missing = 0
  for (let y = 2; y < chasm.map.height - 2; y += 1) for (let x = 2; x < chasm.map.width - 2; x += 1) if (!cellAt(chasm.map, x, y)) missing += 1
  assert.ok(missing > 20, 'пропасти нет')
  assert.ok(chasm.labels.includes('Мост'))
  const ford = place('Тракт у старого моста', 'дорога')
  assert.ok(ford.labels.includes('Река') && ford.labels.includes('Мост'), 'у моста нет реки')
  const oasis = place('Пустынный оазис', 'оазис')
  assert.ok(oasis.labels.includes('Пруд'), 'в оазисе нет воды')
})

test('город — двенадцать и больше домов вдоль улиц с площадью, деревня — восемь и больше дворов', () => {
  for (const seed of SEEDS) {
    const { map } = generateSceneGeometry({ location: 'Город Вельдбург', theme: 'город', settlementType: 'town', seed: `town:${seed}`, useLibrary: false })
    const houses = map.zones.filter((zone) => /^building-\d+$/u.test(zone.id))
    assert.ok(map.width >= 48 && map.height >= 44, `${seed}: город тесный — ${map.width}×${map.height}`)
    assert.ok(houses.length >= 12, `${seed}: в городе ${houses.length} домов`)
    assert.ok(map.zones.some((zone) => zone.id === 'square' && zone.label === 'Торговая площадь'))
    const square = map.props.filter((prop) => cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone === 'square').map((prop) => prop.assetId)
    // Вода на площади города — фонтан, в деревне и на рынке — колодец.
    assert.ok((square.includes('fountain') || square.includes('well')) && square.includes('market_stall'), `${seed}: на площади нет воды и прилавков`)
  }
  // Деревня — не хутор: улица с переулками и второй ряд дворов дают
  // девять-двенадцать домов на 40×34; хутор остаётся редким.
  for (const seed of SEEDS) {
    const { map: village } = generateSceneGeometry({ location: 'Деревня Кленовка', theme: 'деревня', settlementType: 'village', seed: `village:${seed}`, useLibrary: false })
    const houses = village.zones.filter((zone) => /^building-\d+$/u.test(zone.id)).length
    assert.ok(houses >= 8, `${seed}: в деревне ${houses} дворов`)
  }
  const { map: farmstead } = generateSceneGeometry({ location: 'Хутор у леса', theme: 'хутор', settlementType: 'village', seed: 'farm:q1', useLibrary: false })
  assert.ok(farmstead.zones.filter((zone) => /^building-\d+$/u.test(zone.id)).length <= 6, 'хутор застроен как деревня')
})

test('климат не угадывается по кускам слова: Вельдбург — не ледяной город', () => {
  const { map } = generateSceneGeometry({ location: 'Город Вельдбург', theme: 'город', settlementType: 'town', seed: 'climate', useLibrary: false })
  let ice = 0
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if (cellAt(map, x, y)?.material === 'ice') ice += 1
  assert.equal(ice, 0, 'в «Вельдбурге» нашёлся «льд»')
})

test('генератор ставит то, что пообещал текст сцены, и карта остаётся играбельной', () => {
  const cases = [
    ['Таверна «Рыжий рог»', 'таверна', 'В зале очаг, четыре стола, у стойки две бочки и сундук хозяина.'],
    ['Лесная поляна', 'лес', 'Костёр, старый дуб и телега торговца.'],
    ['Пещера контрабандистов', 'пещера', 'Ящики, три бочки, сундук и костёр в глубине.'],
    ['Храм Утренней звезды', 'храм', 'Две статуи у алтаря, жаровни горят, у стены котёл.'],
  ]
  for (const [location, theme, text] of cases) {
    const requirements = sceneRequirementsFromText([text])
    for (const seed of SEEDS) {
      const { map } = generateSceneGeometry({ location, theme, seed: `${location}:${seed}`, useLibrary: false, requirements })
      /** @type {Record<string, number>} */
      const counts = {}
      for (const prop of map.props) counts[prop.assetId] = (counts[prop.assetId] ?? 0) + 1
      assert.deepEqual(requirementsCoverage(requirements, counts).missing, [], `${location}/${seed}: не встало обещанное`)
      assert.deepEqual(auditTacticalMap(map).problems, [], `${location}/${seed}: обещанное сломало карту`)
    }
  }
  // Котла в теме храма нет — его приносит только обещание сцены.
  const { map: temple } = generateSceneGeometry({ location: 'Храм Утренней звезды', theme: 'храм', seed: 'cauldron', useLibrary: false, requirements: [{ id: 'cauldron', count: 1 }] })
  assert.ok(temple.props.some((prop) => prop.assetId === 'cauldron'), 'котёл не встал')
})

test('подземелье и склеп получают петли, а второй вход в запертую комнату заперт тем же ключом', () => {
  for (const [location, theme, minimum] of [['Подземелье под замком', 'подземелье', 10], ['Фамильный склеп', 'склеп', 5]]) {
    let looped = 0
    for (let index = 0; index < 16; index += 1) {
      const { map } = generateSceneGeometry({ location, theme, seed: `loops:${index}`, useLibrary: false })
      const report = auditTacticalMap(map)
      assert.deepEqual(report.problems, [], `${location}/${index}: ${JSON.stringify(report.problems.slice(0, 3))}`)
      if (report.stats.loops > 0) looped += 1
      // Все запертые двери — под один ключ цели: петля не обходит замок.
      const keys = new Set(map.doors.filter((door) => door.state === 'locked').map((door) => door.keyItemId))
      assert.ok(keys.size <= 1, `${location}/${index}: замки под разные ключи ${[...keys]}`)
      for (const door of map.doors.filter((entry) => entry.id.startsWith('loop-door-') && entry.state === 'locked')) {
        assert.ok(door.keyItemId, `${location}/${index}: запертая петля без ключа`)
      }
    }
    assert.ok(looped >= minimum, `${location}: петли только у ${looped} карт из 16`)
  }
})

test('голый просторный зал — замечание: укрыться можно только у стены', () => {
  const map = createTacticalMap({ width: 18, height: 16, seed: 'hall', generator: { id: 'manual', version: '1' } })
  addZone(map, { id: 'hall', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Зал' })
  for (let y = 0; y < 16; y += 1) for (let x = 0; x < 18; x += 1) {
    const wall = x === 0 || y === 0 || x === 17 || y === 15
    setCell(map, x, y, { passable: !wall, material: 'stone', zone: wall ? '' : 'hall', revealed: true })
  }
  addSpawnPoint(map, { id: 'party', x: 2, y: 2, role: 'party' })
  const bare = auditTacticalMap(map)
  assert.ok(bare.warnings.some((warning) => warning.code === 'HALL_NO_COVER'), JSON.stringify(bare.warnings))
  // Две колонны посреди зала — уже есть за чем встать.
  for (const [index, [x, y]] of [[5, 5], [5, 10], [12, 5], [12, 10], [8, 7], [9, 8]].entries()) {
    addProp(map, { id: `pillar-${index}`, assetId: 'pillar', x: x + 0.5, y: y + 0.5, rotation: 0, scale: 1, footprint: [{ x, y }], zOrder: 0, blocksMove: true, blocksSight: true, cover: 'three_quarters', destructible: false, hp: 0, interactive: false })
  }
  assert.ok(!auditTacticalMap(map).warnings.some((warning) => warning.code === 'HALL_NO_COVER'))
})

test('шкаф перед окном — ошибка проверки, а генератор окна не заслоняет', () => {
  const map = sampleHouse()
  const window = edgeList(map).find((edge) => edge.kind === 'window')
  assert.ok(window, 'в образце нет окна')
  const inside = [{ x: window.x, y: window.y }, edgeNeighbor(window)].find((point) => cellAt(map, point.x, point.y)?.passable)
  map.props.push({ id: 'blind', assetId: 'wardrobe', x: inside.x + 0.5, y: inside.y + 0.5, rotation: 0, scale: 1, footprint: [inside], zOrder: 0, blocksMove: true, blocksSight: true, cover: 'three_quarters', destructible: false, hp: 0, interactive: false, state: 'intact', interaction: null, transition: null })
  assert.ok(codes(map).includes('PROP_BLOCKS_WINDOW'))
  for (const seed of SEEDS) {
    for (const [location, theme] of [['Дом мельника', 'жилой дом'], ['Таверна «Рыжий рог»', 'таверна'], ['Усадьба Вельских', 'усадьба']]) {
      const { map: built } = generateSceneGeometry({ location, theme, seed: `window:${seed}`, useLibrary: false })
      assert.deepEqual(auditTacticalMap(built).problems.filter((problem) => problem.code === 'PROP_BLOCKS_WINDOW'), [], `${location}/${seed}`)
    }
  }
})

test('у карты без комнат и дверей петель нет: пустой граф не даёт «одну петлю»', () => {
  // Формула E − V + 1 считала граф связным и давала лесу и дороге loops=1
  // (исследование PR #136). Теперь E − V + C.
  for (const [location, theme] of [['Поляна в Чернолесье', 'лес'], ['Тракт у старого моста', 'дорога']]) {
    const { map } = generateSceneGeometry({ location, theme, seed: 'empty-graph', useLibrary: false })
    const report = auditTacticalMap(map)
    assert.equal(report.stats.rooms, 0, location)
    assert.equal(report.stats.loops, 0, location)
  }
})

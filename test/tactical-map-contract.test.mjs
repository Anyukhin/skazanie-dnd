import assert from 'node:assert/strict'
import test from 'node:test'

import { generateDynamicSceneMap } from '../server/dynamic-map.mjs'
import { levelKey, normalizeLocationMaps } from '../server/adventure-director.mjs'
import {
  EDGE_KINDS,
  MATERIALS,
  MAX_LEVEL_OFFSET,
  SIZE_CLASSES,
  SURFACES,
  TacticalMapError,
  addProp,
  addSpawnPoint,
  addZone,
  cellAt,
  cellCount,
  createTacticalMap,
  edgeBetween,
  edgeList,
  deserializeTacticalMap,
  legacyCellsFromTacticalMap,
  reachableCells,
  recomputeBounds,
  serializeTacticalMap,
  serializedTacticalMapHash,
  setCell,
  setDoor,
  setEdge,
  tacticalMapFromLegacyCells,
  tacticalMapHash,
  validateTacticalMap,
} from '../server/tactical-map.mjs'

/** Восемь разных сочетаний планировки и паттерна — карта должна пережить каждое. */
const LEGACY_SHAPES = Object.freeze([
  { seed: 'shape-cavern', layout: 'cavern', pattern: 'cave-cluster', theme: 'пещера' },
  { seed: 'shape-radial', layout: 'radial', pattern: 'courtyard', theme: 'храм' },
  { seed: 'shape-ruins', layout: 'ruins', pattern: 'keep', theme: 'руины' },
  { seed: 'shape-bridge', layout: 'open', pattern: 'bridge', theme: 'мост через ущелье' },
  { seed: 'shape-village', layout: 'streets', pattern: 'village', theme: 'деревня' },
  { seed: 'shape-room', layout: 'rooms', pattern: 'small-room', theme: 'таверна' },
  { seed: 'shape-hall', layout: 'rooms', pattern: 'great-hall', theme: 'дворец' },
  { seed: 'shape-crypt', layout: 'winding', pattern: 'crypt', theme: 'склеп' },
])

function legacyMap(options) {
  return generateDynamicSceneMap({ danger: 'средняя', water: 0.08, featureCount: 8, ...options })
}

test('карта переживает сборку, сериализацию и чтение обратно', () => {
  const map = createTacticalMap({ width: 4, height: 3, locationId: 'loc-1', seed: 'seed-1' })
  addZone(map, { id: 'hall', kind: 'interior', material: 'wood', floorDirection: 'vertical', label: 'Общий зал' })
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      setCell(map, x, y, {
        passable: !(x === 3 && y === 0),
        material: x % 2 ? 'wood' : 'stone',
        variant: (x + y) % 6,
        revealed: y === 0,
        zone: 'hall',
        moveCost: x === 1 ? 2 : 1,
        elevation: y === 2 ? -1 : 0,
      })
    }
  }
  setCell(map, 2, 2, { surface: 'water', hazardId: 'hz-1' })
  setEdge(map, 0, 0, 1, 0, { kind: 'wall', cover: 'three_quarters' })
  setDoor(map, { id: 'd1', x: 1, y: 1, dir: 'e', state: 'closed', blocksMove: true, blocksSight: true })

  const restored = deserializeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(map))))
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 4; x += 1) assert.deepEqual(cellAt(restored, x, y), cellAt(map, x, y), `клетка ${x},${y}`)
  }
  assert.deepEqual(edgeList(restored), edgeList(map))
  assert.deepEqual(restored.doors, map.doors)
  assert.deepEqual(restored.zones, map.zones)
  assert.equal(restored.zones[0].floorDirection, 'vertical', 'направление настила теряется при сериализации')
  assert.deepEqual(restored.bounds, map.bounds)
  assert.equal(cellAt(restored, 2, 2)?.hazardId, 'hz-1')
  assert.equal(cellAt(restored, 1, 0)?.moveCost, 2)
  assert.equal(cellAt(restored, 0, 2)?.elevation, -1)
})

// --- этажи (этап L1 плана многоуровневых карт) ---------------------------

/** Карта одной клетки, на которой можно поставить лестницу. */
function levelMap({ levelIndex = 0, levelLabel = '' } = {}) {
  const map = createTacticalMap({ width: 2, height: 1, locationId: 'tavern', levelIndex, levelLabel })
  setCell(map, 0, 0, { passable: true })
  setCell(map, 1, 0, { passable: true })
  return map
}

test('этаж и переход переживают сериализацию и чтение обратно', () => {
  const map = levelMap({ levelIndex: -1, levelLabel: 'Винный погреб' })
  addProp(map, {
    id: 'stairs-1',
    assetId: 'stairs_up',
    x: 0.5,
    y: 0.5,
    footprint: [{ x: 0, y: 0 }],
    transition: { toLevel: 0, label: 'Общий зал' },
  })

  const restored = deserializeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(map))))
  assert.equal(restored.levelIndex, -1)
  assert.equal(restored.levelLabel, 'Винный погреб')
  assert.deepEqual(restored.props[0].transition, { toLevel: 0, label: 'Общий зал' })
  assert.equal(restored.props[0].interactive, true, 'переход обязан делать предмет интерактивным')
  assert.equal(tacticalMapHash(restored), tacticalMapHash(map), 'новые поля обязаны участвовать в хеше')
})

test('переход без подписи не тащит пустое поле через сериализацию', () => {
  const map = levelMap()
  addProp(map, { id: 'hatch', assetId: 'trapdoor', x: 0.5, y: 0.5, footprint: [], transition: { toLevel: -1 } })
  const raw = serializeTacticalMap(map)
  assert.deepEqual(raw.props[0].transition, { toLevel: -1 })
  assert.equal(deserializeTacticalMap(raw).props[0].transition.label, '')
})

test('карта без этажей сериализуется как прежде, байт в байт', () => {
  // Единственная гарантия обратной совместимости, которую видно из кода: если
  // новых полей нет, записи не появляется вовсе, и старая карта не меняется.
  const map = levelMap()
  addProp(map, { id: 'barrel', assetId: 'barrel', x: 0.5, y: 0.5, footprint: [{ x: 0, y: 0 }] })
  const raw = serializeTacticalMap(map)
  assert.equal('levelIndex' in raw, false, 'этаж входа в записи не появляется')
  assert.equal('levelLabel' in raw, false)
  assert.equal('transition' in raw.props[0], false, 'обычный предмет записи о переходе не несёт')
  assert.equal(map.levelIndex, 0, 'в памяти этаж входа — это ноль, а не отсутствие поля')
  assert.equal(map.props[0].transition, null)
})

test('карта, сохранённая до появления этажей, читается как этаж входа', () => {
  const map = levelMap()
  addProp(map, { id: 'barrel', assetId: 'barrel', x: 0.5, y: 0.5, footprint: [{ x: 0, y: 0 }] })
  const raw = serializeTacticalMap(map)
  delete raw.levelIndex
  delete raw.levelLabel
  const restored = deserializeTacticalMap(raw)
  assert.equal(restored.levelIndex, 0)
  assert.equal(restored.levelLabel, '')
  assert.equal(restored.props[0].transition, null)
  assert.equal(JSON.stringify(serializeTacticalMap(restored)), JSON.stringify(raw),
    'круговое преобразование старой карты обязано совпасть байт в байт')
})

test('мусорный переход отвергается на входе, а не молча портит карту', () => {
  /** @param {unknown} transition @param {string} code @param {string} [assetId] */
  const rejected = (transition, code, assetId = 'stairs_up') => {
    const map = levelMap()
    assert.throws(
      () => addProp(map, { id: 'p', assetId, x: 0.5, y: 0.5, footprint: [], transition }),
      (error) => error instanceof TacticalMapError && error.code === code,
      `${JSON.stringify(transition)} на ${assetId}: ожидался отказ ${code}`,
    )
  }

  rejected('вверх', 'TRANSITION_NOT_OBJECT')
  rejected([1], 'TRANSITION_NOT_OBJECT')
  rejected({ toLevel: 1.5 }, 'TRANSITION_LEVEL_NOT_INTEGER')
  rejected({ toLevel: 'один' }, 'TRANSITION_LEVEL_NOT_INTEGER')
  rejected({ toLevel: MAX_LEVEL_OFFSET + 1 }, 'TRANSITION_LEVEL_OUT_OF_RANGE')
  rejected({ toLevel: -MAX_LEVEL_OFFSET - 1 }, 'TRANSITION_LEVEL_OUT_OF_RANGE')
  // Этаж карты — ноль, значит переход на ноль ведёт сам в себя.
  rejected({ toLevel: 0 }, 'TRANSITION_LEVEL_SAME')
  // Бочка интерактивной в реестре не объявлена — нажать на неё нечем.
  rejected({ toLevel: 1 }, 'TRANSITION_ASSET_NOT_INTERACTIVE', 'barrel')
  rejected({ toLevel: 1 }, 'TRANSITION_ASSET_NOT_INTERACTIVE', 'нет-такого-ассета')
})

test('крючками перехода служат ровно интерактивные ассеты реестра', () => {
  for (const assetId of ['stairs_up', 'stairs_down', 'trapdoor']) {
    const map = levelMap()
    const prop = addProp(map, { id: assetId, assetId, x: 0.5, y: 0.5, footprint: [], transition: { toLevel: 1 } })
    assert.equal(prop.transition.toLevel, 1, `${assetId} обязан принимать переход`)
  }
})

test('этаж, изменённый после расстановки, ловится проверкой карты', () => {
  const map = levelMap({ levelIndex: 1 })
  addProp(map, { id: 'stairs', assetId: 'stairs_down', x: 0.5, y: 0.5, footprint: [], transition: { toLevel: 0 } })
  assert.equal(validateTacticalMap(map).ok, true)
  map.levelIndex = 0
  const report = validateTacticalMap(map)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((issue) => issue.code === 'TRANSITION_LEVEL_SAME'), JSON.stringify(report.errors))
})

test('ключ этажа не меняет прежние ключи и разводит этажи', () => {
  // Этаж входа обязан сохранить прежний ключ: иначе все сохранённые кампании
  // потеряли бы свои карты и потребовали миграции.
  assert.equal(levelKey('tavern'), 'tavern')
  assert.equal(levelKey('tavern', 0), 'tavern')
  assert.equal(levelKey('tavern', 1), 'tavern@L1')
  assert.equal(levelKey('tavern', -1), 'tavern@L-1')
  assert.equal(levelKey('tavern', 3), 'tavern@L3')
  assert.notEqual(levelKey('tavern', 1), levelKey('tavern', -1))
  // Мусор вместо этажа — это этаж входа, а не сломанный ключ.
  assert.equal(levelKey('tavern', Number.NaN), 'tavern')
  assert.equal(levelKey('tavern', 1.5), 'tavern')
  assert.equal(levelKey(''), '')
  assert.equal(levelKey('', 2), '', 'без локации ключа этажа не существует')
})

test('длинный идентификатор локации не съедает номер этажа', () => {
  // `normalizeLocationMaps` режет ключ до 120 символов. Если бы суффикс не
  // помещался заранее, два этажа схлопнулись бы в одну запись.
  const long = 'л'.repeat(130)
  const first = levelKey(long, 1)
  const second = levelKey(long, 2)
  assert.ok(first.length <= 120, `ключ длиной ${first.length} не переживёт нормализацию`)
  assert.ok(first.endsWith('@L1'))
  assert.notEqual(first, second)
  assert.deepEqual(
    Object.keys(normalizeLocationMaps({ [first]: { version: 1, cells: [{ x: 0, y: 0, type: 'floor', revealed: true }] } })),
    [first],
    'нормализация обязана переварить составной ключ как есть',
  )
})

test('нормализация памяти локаций принимает ключи этажей рядом со старыми', () => {
  const cells = [{ x: 0, y: 0, type: 'floor', revealed: true }]
  const normalized = normalizeLocationMaps({
    tavern: { version: 1, cells },
    'tavern@L1': { version: 1, cells },
    'tavern@L-1': { version: 1, cells },
  })
  assert.deepEqual(Object.keys(normalized).sort(), ['tavern', 'tavern@L-1', 'tavern@L1'])
  for (const record of Object.values(normalized)) assert.equal(record.cells.length, 1)
})

test('старая зона без направления настила получает совместимое горизонтальное значение', () => {
  const map = createTacticalMap({ width: 1, height: 1, fill: { passable: true } })
  addZone(map, { id: 'legacy', kind: 'interior', material: 'wood' })
  const raw = serializeTacticalMap(map)
  delete raw.zones[0].floorDirection
  const restored = deserializeTacticalMap(raw)
  assert.equal(restored.zones[0].floorDirection, 'horizontal')
})

test('старые клетки восстанавливаются из карты побайтово на восьми планировках', () => {
  for (const shape of LEGACY_SHAPES) {
    const cells = legacyMap(shape)
    assert.ok(cells.length > 10, `${shape.seed}: генератор вернул слишком мало клеток`)
    const map = tacticalMapFromLegacyCells(cells)
    const restored = legacyCellsFromTacticalMap(map)
    assert.equal(
      JSON.stringify(restored),
      JSON.stringify(cells),
      `${shape.seed} (${shape.layout}/${shape.pattern}): обратное преобразование разошлось`,
    )
  }
})

test('вода остаётся непроходимой и получает поверхность', () => {
  const cells = [
    { x: 0, y: 0, type: 'floor', revealed: true, material: 'stone', variant: 0, pattern: 'natural' },
    { x: 1, y: 0, type: 'water', revealed: true, material: 'stone', variant: 0, pattern: 'natural' },
  ]
  const map = tacticalMapFromLegacyCells(cells)
  const water = cellAt(map, 1, 0)
  assert.equal(water?.passable, false)
  assert.equal(water?.surface, 'water')
  assert.equal(legacyCellsFromTacticalMap(map)[1].type, 'water')
})

test('сущность из feature отбрасывается, декор становится предметом', () => {
  const cells = [
    { x: 0, y: 0, type: 'floor', revealed: true, material: 'wood', variant: 1, pattern: 'small-room', feature: 'table' },
    { x: 1, y: 0, type: 'floor', revealed: true, material: 'wood', variant: 2, pattern: 'small-room', feature: 'enemy' },
  ]
  const map = tacticalMapFromLegacyCells(cells)
  assert.equal(map.props.length, 1)
  assert.equal(map.props[0].assetId, 'table')
  assert.deepEqual(map.props[0].footprint, [{ x: 0, y: 0 }])
  assert.equal(map.props[0].x, 0.5)
  assert.equal(map.props[0].rotation, 0)
  const restored = legacyCellsFromTacticalMap(map)
  assert.equal(restored[0].feature, 'table')
  assert.equal('feature' in restored[1], false, 'сущность не должна вернуться в клетку')
})

test('непрямоугольная форма сохраняется: пропуски остаются пропусками', () => {
  const cells = legacyMap({ seed: 'shape-cavern', layout: 'cavern', pattern: 'cave-cluster', theme: 'пещера' })
  const map = tacticalMapFromLegacyCells(cells)
  assert.equal(cellCount(map), cells.length)
  assert.ok(cellCount(map) < map.width * map.height, 'у пещеры обязаны быть пропуски')
  const missing = []
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) if (!cellAt(map, x, y)) missing.push(`${x},${y}`)
  }
  const present = new Set(cells.map((cell) => `${cell.x},${cell.y}`))
  for (const key of missing) assert.equal(present.has(key), false, `клетка ${key} не должна существовать`)
})

test('ребро канонизируется и не существует между несоседними клетками', () => {
  const map = createTacticalMap({ width: 4, height: 4, fill: { passable: true } })
  setEdge(map, 1, 1, 2, 1, { kind: 'wall' })
  const forward = edgeBetween(map, 1, 1, 2, 1)
  const backward = edgeBetween(map, 2, 1, 1, 1)
  assert.ok(forward)
  assert.deepEqual(forward, backward)
  assert.equal(forward.dir, 'e')
  assert.equal(edgeList(map).length, 1, 'одно ребро не должно записаться дважды')
  assert.throws(() => edgeBetween(map, 1, 1, 3, 1), (error) => (
    error instanceof TacticalMapError && error.code === 'EDGE_CELLS_NOT_ADJACENT'
  ))
  setEdge(map, 1, 1, 2, 1, { kind: 'none' })
  assert.equal(edgeBetween(map, 1, 1, 2, 1), null)
})

test('бойница и решётка дополняют старые коды рёбер и несут проверяемую механику проёма', () => {
  assert.deepEqual(
    EDGE_KINDS.slice(0, 6),
    ['none', 'wall', 'door', 'window', 'rail', 'ledge'],
    'индексы старых рёбер нельзя сдвигать в сохранённых картах',
  )
  assert.deepEqual(EDGE_KINDS.slice(6), ['loophole', 'grate'])
  const map = createTacticalMap({ width: 3, height: 2, fill: { passable: true } })
  const loophole = setEdge(map, 0, 0, 1, 0, { kind: 'loophole' })
  const grate = setEdge(map, 1, 1, 2, 1, { kind: 'grate' })
  assert.deepEqual(
    { blocksMove: loophole.blocksMove, blocksSight: loophole.blocksSight, cover: loophole.cover },
    { blocksMove: true, blocksSight: false, cover: 'three_quarters' },
    'бойница должна останавливать движение, пропускать взгляд и давать укрытие',
  )
  assert.deepEqual(
    { blocksMove: grate.blocksMove, blocksSight: grate.blocksSight, cover: grate.cover },
    { blocksMove: true, blocksSight: false, cover: 'half' },
    'решётка должна останавливать движение, пропускать взгляд и давать укрытие',
  )
  const restored = deserializeTacticalMap(serializeTacticalMap(map))
  assert.deepEqual(edgeList(restored), edgeList(map), 'новые проёмы теряются в упакованном контракте')
})

test('валидация ловит каждый структурный отказ', () => {
  const base = () => {
    const map = createTacticalMap({ width: 4, height: 4, fill: { passable: true } })
    addZone(map, { id: 'z', kind: 'interior' })
    return map
  }

  const cases = [
    ['LAYER_LENGTH_MISMATCH', () => {
      const map = base()
      map.layers.material = new Uint8Array(3)
      return map
    }],
    ['ENUM_CODE_OUT_OF_RANGE', () => {
      const map = base()
      map.layers.surface[0] = SURFACES.length + 1
      return map
    }],
    ['MOVE_COST_NOT_ALLOWED', () => {
      const map = base()
      map.layers.moveCost[0] = 7
      return map
    }],
    ['DOOR_EDGE_MISSING', () => {
      const map = base()
      setDoor(map, { id: 'd', x: 1, y: 1, dir: 'e' })
      delete map.edges['1,1,e']
      return map
    }],
    ['DOOR_EDGE_KIND_MISMATCH', () => {
      const map = base()
      setDoor(map, { id: 'd', x: 1, y: 1, dir: 'e' })
      map.edges['1,1,e'].kind = 'wall'
      return map
    }],
    ['DOOR_ID_NOT_UNIQUE', () => {
      const map = base()
      setDoor(map, { id: 'd', x: 1, y: 1, dir: 'e' })
      map.doors.push({ ...map.doors[0] })
      return map
    }],
    ['EDGE_DOOR_ID_DANGLING', () => {
      const map = base()
      setEdge(map, 1, 1, 2, 1, { kind: 'door', doorId: 'ghost' })
      return map
    }],
    ['PROP_FOOTPRINT_ON_MISSING_CELL', () => {
      const map = createTacticalMap({ width: 4, height: 4 })
      setCell(map, 0, 0, { passable: true })
      addProp(map, { id: 'p', assetId: 'table', x: 2.5, y: 2.5, footprint: [{ x: 2, y: 2 }] })
      return map
    }],
    ['PROP_FOOTPRINT_ON_IMPASSABLE', () => {
      const map = base()
      setCell(map, 2, 2, { passable: false })
      addProp(map, { id: 'p', assetId: 'table', x: 2.5, y: 2.5, footprint: [{ x: 2, y: 2 }] })
      return map
    }],
    ['PROP_FOOTPRINT_OVERLAP', () => {
      const map = base()
      addProp(map, { id: 'p1', assetId: 'table', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })
      addProp(map, { id: 'p2', assetId: 'chair', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] })
      return map
    }],
    ['PROP_ID_NOT_UNIQUE', () => {
      const map = base()
      addProp(map, { id: 'p', assetId: 'table', x: 1.5, y: 1.5, footprint: [] })
      addProp(map, { id: 'p', assetId: 'chair', x: 2.5, y: 2.5, footprint: [] })
      return map
    }],
    ['ZONE_ID_NOT_UNIQUE', () => {
      const map = base()
      map.zones.push({ ...map.zones[0] })
      return map
    }],
    ['SPAWN_POINT_IMPASSABLE', () => {
      const map = base()
      setCell(map, 3, 3, { passable: false })
      addSpawnPoint(map, { id: 's', x: 3, y: 3, role: 'party' })
      return map
    }],
    ['CELL_BUDGET_EXCEEDED', () => {
      const map = createTacticalMap({ width: 40, height: 40, fill: { passable: true }, sizeClass: 'arena' })
      return map
    }],
    ['PROP_BUDGET_EXCEEDED', () => {
      const map = createTacticalMap({ width: 30, height: 30, fill: { passable: true }, sizeClass: 'arena' })
      for (let index = 0; index <= SIZE_CLASSES.arena.maxProps; index += 1) {
        addProp(map, { id: `p${index}`, assetId: 'mug', x: 0.5, y: 0.5, footprint: [] })
      }
      return map
    }],
    ['BOUNDS_MISMATCH', () => {
      const map = base()
      map.bounds = { minX: 1, minY: 1, maxX: 2, maxY: 2 }
      return map
    }],
  ]

  for (const [code, build] of cases) {
    const report = validateTacticalMap(build())
    assert.equal(report.ok, false, `${code}: карта должна быть отклонена`)
    assert.ok(report.errors.some((issue) => issue.code === code), `${code}: не найден среди ${report.errors.map((issue) => issue.code).join(', ')}`)
  }
})

test('валидная карта проходит проверку без замечаний', () => {
  const cells = legacyMap({ seed: 'valid', layout: 'rooms', pattern: 'small-room', theme: 'таверна' })
  const report = validateTacticalMap(tacticalMapFromLegacyCells(cells))
  assert.deepEqual(report.errors, [])
  assert.equal(report.ok, true)
})

test('бюджет стен ловит генератор, поставивший стену на каждое ребро', () => {
  const map = createTacticalMap({ width: 30, height: 30, fill: { passable: true }, sizeClass: 'arena' })
  for (let y = 0; y < 30; y += 1) {
    for (let x = 0; x < 30; x += 1) {
      if (x + 1 < 30) setEdge(map, x, y, x + 1, y, { kind: 'wall' })
      if (y + 1 < 30) setEdge(map, x, y, x, y + 1, { kind: 'wall' })
    }
  }
  const report = validateTacticalMap(map)
  assert.ok(report.errors.some((issue) => issue.code === 'WALL_EDGE_BUDGET_EXCEEDED'))
})

test('хеш детерминирован и чувствителен к содержимому', () => {
  const build = () => tacticalMapFromLegacyCells(legacyMap({ seed: 'hash', layout: 'rooms', pattern: 'small-room' }))
  const first = build()
  const second = build()
  assert.equal(tacticalMapHash(first), tacticalMapHash(second))
  assert.equal(tacticalMapHash(deserializeTacticalMap(serializeTacticalMap(first))), tacticalMapHash(first))
  assert.equal(serializedTacticalMapHash(serializeTacticalMap(first)), tacticalMapHash(first))

  const changedCell = build()
  const target = [...Array(changedCell.width).keys()]
    .flatMap((x) => [...Array(changedCell.height).keys()].map((y) => ({ x, y })))
    .find((point) => cellAt(changedCell, point.x, point.y)?.passable)
  assert.ok(target)
  setCell(changedCell, target.x, target.y, { variant: 42 })
  assert.notEqual(tacticalMapHash(changedCell), tacticalMapHash(first))

  const changedEdge = build()
  setEdge(changedEdge, 0, 0, 1, 0, { kind: 'rail', blocksMove: false, blocksSight: false })
  assert.notEqual(tacticalMapHash(changedEdge), tacticalMapHash(first))
})

test('карта 100×100 сериализуется в пределах порога плана', () => {
  const map = createTacticalMap({ width: 100, height: 100, sizeClass: 'region' })
  addZone(map, { id: 'inside', kind: 'interior', material: 'wood' })
  addZone(map, { id: 'outside', kind: 'exterior', material: 'grass' })
  // Правдоподобный интерьер: комнаты со стенами, вода у края, разный материал.
  for (let y = 0; y < 100; y += 1) {
    for (let x = 0; x < 100; x += 1) {
      const insideBuilding = x > 8 && x < 92 && y > 8 && y < 92
      const wall = insideBuilding && (x % 14 === 0 || y % 14 === 0)
      setCell(map, x, y, {
        passable: !wall,
        material: insideBuilding ? MATERIALS[(x * 7 + y * 3) % 3] : 'grass',
        variant: (x * 5 + y * 11) % 6,
        revealed: y < 20,
        zone: insideBuilding ? 'inside' : 'outside',
        surface: !insideBuilding && x < 4 ? 'water' : 'none',
      })
    }
  }
  for (let y = 0; y < 100; y += 1) {
    for (let x = 0; x < 100; x += 1) {
      const own = cellAt(map, x, y)
      if (!own || own.passable) continue
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const neighbor = cellAt(map, x + dx, y + dy)
        if (neighbor?.passable) setEdge(map, x, y, x + dx, y + dy, { kind: 'wall', cover: 'three_quarters' })
      }
    }
  }
  for (let index = 0; index < 200; index += 1) {
    addProp(map, { id: `p${index}`, assetId: 'barrel', x: index % 90 + 0.5, y: Math.floor(index / 90) + 20.5, footprint: [] })
  }

  const serialized = JSON.stringify(serializeTacticalMap(map))
  const kilobytes = Buffer.byteLength(serialized) / 1024
  console.log(`  карта 100×100: ${kilobytes.toFixed(1)} КБ, рёбер со стенами ${edgeList(map).length}, предметов ${map.props.length}`)
  assert.ok(kilobytes <= 100, `сериализованная карта ${kilobytes.toFixed(1)} КБ, порог плана — 100 КБ`)

  // Честный замер верхней границы: класс region допускает 2000 предметов
  // (docs/tactical-map-plan.md, 11.3), а порог размера — 100 КБ (13). Обе
  // границы одновременно держатся не всегда, и число обязано быть видно.
  for (let index = map.props.length; index < SIZE_CLASSES.region.maxProps; index += 1) {
    addProp(map, {
      id: `q${index}`,
      assetId: 'barrel',
      x: index % 90 + 0.5,
      y: Math.floor(index / 90) + 20.5,
      rotation: index % 360,
      footprint: [],
    })
  }
  const fullKilobytes = Buffer.byteLength(JSON.stringify(serializeTacticalMap(map))) / 1024
  const perProp = (fullKilobytes - kilobytes) * 1024 / (SIZE_CLASSES.region.maxProps - 200)
  const affordable = Math.floor((100 - kilobytes) * 1024 / perProp) + 200
  console.log(`  полный бюджет предметов (${SIZE_CLASSES.region.maxProps}): ${fullKilobytes.toFixed(1)} КБ`)
  console.log(`  ${perProp.toFixed(0)} байт на предмет, в 100 КБ помещается около ${affordable} предметов`)
  assert.ok(perProp < 80, `предмет стоит ${perProp.toFixed(0)} байт — сериализация раздулась`)

  const restored = deserializeTacticalMap(JSON.parse(serialized))
  assert.equal(cellCount(restored), cellCount(map))
  assert.deepEqual(cellAt(restored, 50, 50), cellAt(map, 50, 50))
  assert.equal(edgeList(restored).length, edgeList(map).length)
})

test('обход уважает рёбра и состояние двери', () => {
  const map = createTacticalMap({ width: 3, height: 1, fill: { passable: true } })
  assert.equal(reachableCells(map, 0, 0).size, 3)

  setEdge(map, 1, 0, 2, 0, { kind: 'wall', blocksMove: true, blocksSight: true })
  assert.deepEqual([...reachableCells(map, 0, 0)].sort(), ['0,0', '1,0'])

  setDoor(map, { id: 'gate', x: 1, y: 0, dir: 'e', state: 'closed', blocksMove: true, blocksSight: true })
  assert.equal(reachableCells(map, 0, 0).size, 2, 'закрытая дверь не пропускает')

  map.doors[0].state = 'open'
  assert.equal(reachableCells(map, 0, 0).size, 3, 'открытая дверь пропускает')
  assert.equal(reachableCells(map, 0, 0, { throughDoors: false }).size, 2, 'обход без дверей их не открывает')

  map.doors[0].state = 'broken'
  assert.equal(reachableCells(map, 0, 0).size, 3, 'выбитая дверь пропускает')

  map.doors[0].state = 'locked'
  assert.equal(reachableCells(map, 0, 0).size, 2, 'запертая дверь не пропускает')
})

test('несуществующая клетка отличается от непроходимой', () => {
  const map = createTacticalMap({ width: 3, height: 1 })
  setCell(map, 0, 0, { passable: true })
  setCell(map, 1, 0, { passable: false })
  assert.equal(cellAt(map, 1, 0)?.passable, false)
  assert.equal(cellAt(map, 2, 0), null)
  recomputeBounds(map)
  assert.deepEqual(map.bounds, { minX: 0, minY: 0, maxX: 1, maxY: 0 })
})

test('повреждённый слой отклоняется при чтении, а не молча дополняется', () => {
  const map = createTacticalMap({ width: 4, height: 4, fill: { passable: true, variant: 3 } })
  const serialized = serializeTacticalMap(map)
  const layers = /** @type {Record<string, unknown>} */ (serialized.layers)
  layers.variant = Buffer.from(new Uint8Array(3)).toString('base64')
  assert.throws(() => deserializeTacticalMap(serialized), (error) => (
    error instanceof TacticalMapError && error.code === 'LAYER_LENGTH_MISMATCH'
  ))
})

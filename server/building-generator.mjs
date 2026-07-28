// @ts-check
import { createHash } from 'node:crypto'

import { placeProps } from './prop-placement.mjs'
import {
  SIZE_CLASSES,
  addZone,
  cellAt,
  createTacticalMap,
  doorwayEdgeAt,
  edgeBetween,
  reachableCells,
  setCell,
  setDoor,
  setEdge,
  validateTacticalMap,
} from './tactical-map.mjs'

/**
 * Тема «здание с участком» — сцена-эталон из раздела 1
 * `docs/tactical-map-plan.md`: здание из трёх помещений, внешняя территория с
 * деревьями и тропой, мебель, расставленная осмысленно, стены с дверными и
 * оконными проёмами, около 26×26 клеток.
 *
 * **Про толщину стен.** Стена живёт на ребре (решение Р2), и рендер рисует её
 * именно так. Но правила движения в Rules Engine пока читают проходимость
 * клетки, а не ребро, поэтому стена обязана дополнительно занимать клетку:
 * иначе герой пройдёт сквозь неё. Когда движение переедет на рёбра, клетки
 * стены можно будет убрать, а рёбра останутся на месте.
 */

export const BUILDING_GENERATOR = Object.freeze({ id: 'building-with-yard', version: '1' })

/** Размер сцены-эталона. */
export const REFERENCE_SIZE = Object.freeze({ width: 26, height: 26 })

/**
 * @param {string|number} seed
 * @returns {() => number}
 */
function randomFor(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/**
 * @typedef {object} RoomPlan
 * @property {string} zoneId
 * @property {number} minX
 * @property {number} minY
 * @property {number} maxX
 * @property {number} maxY
 */

/**
 * Планировка здания: общий зал плюс два меньших помещения.
 *
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} interior
 * @returns {{rooms: RoomPlan[], partitionX: number, partitionY: number}}
 */
function planRooms(interior) {
  // Зал занимает примерно две трети ширины: за стойкой и столами нужно место,
  // а подсобка и кладовая мелкие по назначению.
  const partitionX = Math.round(interior.minX + (interior.maxX - interior.minX) * 0.62)
  const partitionY = Math.round(interior.minY + (interior.maxY - interior.minY) * 0.5)
  return {
    partitionX,
    partitionY,
    rooms: [
      { zoneId: 'hall', minX: interior.minX, minY: interior.minY, maxX: partitionX - 1, maxY: interior.maxY },
      { zoneId: 'kitchen', minX: partitionX + 1, minY: interior.minY, maxX: interior.maxX, maxY: partitionY - 1 },
      { zoneId: 'store', minX: partitionX + 1, minY: partitionY + 1, maxX: interior.maxX, maxY: interior.maxY },
    ],
  }
}

/**
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {number} x
 * @param {number} y
 * @param {string} kind
 * @param {{blocksMove?: boolean, blocksSight?: boolean, cover?: string}} [options]
 */
function edgesAround(map, x, y, kind, options = {}) {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const neighbor = cellAt(map, x + dx, y + dy)
    if (!neighbor || !neighbor.passable) continue
    setEdge(map, x, y, x + dx, y + dy, {
      kind,
      blocksMove: options.blocksMove !== false,
      blocksSight: options.blocksSight !== false,
      cover: options.cover ?? 'three_quarters',
    })
  }
}

/**
 * Собирает карту здания с участком. Детерминирована от `seed`.
 *
 * @param {object} [options]
 * @param {string} [options.seed]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {string} [options.locationId]
 * @param {string} [options.theme]
 * @param {boolean} [options.withProps] расставлять ли предметы
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function generateBuildingScene({
  seed = 'building',
  width = REFERENCE_SIZE.width,
  height = REFERENCE_SIZE.height,
  locationId = '',
  theme = 'tavern',
  withProps = true,
} = {}) {
  const safeWidth = Math.max(16, Math.min(SIZE_CLASSES.area.maxWidth, Math.round(width)))
  const safeHeight = Math.max(16, Math.min(SIZE_CLASSES.area.maxHeight, Math.round(height)))
  const random = randomFor(`${BUILDING_GENERATOR.id}:${BUILDING_GENERATOR.version}:${seed}`)

  const map = createTacticalMap({
    width: safeWidth,
    height: safeHeight,
    locationId,
    seed: String(seed),
    generator: { ...BUILDING_GENERATOR },
    theme,
    tilesetId: 'building',
    sizeClass: safeWidth * safeHeight <= SIZE_CLASSES.arena.maxCells ? 'arena' : 'area',
  })
  addZone(map, { id: 'yard', kind: 'exterior', material: 'grass', lightLevel: 'bright', label: 'Участок' })
  addZone(map, { id: 'hall', kind: 'interior', material: 'wood', lightLevel: 'dim', label: 'Общий зал' })
  addZone(map, { id: 'kitchen', kind: 'interior', material: 'stone', lightLevel: 'dim', label: 'Кухня' })
  addZone(map, { id: 'store', kind: 'interior', material: 'wood', lightLevel: 'dark', label: 'Кладовая' })
  addZone(map, { id: 'walls', kind: 'interior', material: 'stone', lightLevel: 'dark', label: '' })

  // --- участок --------------------------------------------------------
  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      setCell(map, x, y, {
        passable: true,
        material: 'grass',
        zone: 'yard',
        variant: Math.floor(random() * 6),
        revealed: false,
        moveCost: 1,
      })
    }
  }

  // --- здание ----------------------------------------------------------
  const building = {
    minX: Math.max(2, Math.round(safeWidth * 0.22)),
    minY: Math.max(2, Math.round(safeHeight * 0.18)),
    maxX: Math.min(safeWidth - 3, Math.round(safeWidth * 0.78)),
    maxY: Math.min(safeHeight - 4, Math.round(safeHeight * 0.72)),
  }
  const interior = { minX: building.minX + 1, minY: building.minY + 1, maxX: building.maxX - 1, maxY: building.maxY - 1 }
  const { rooms, partitionX, partitionY } = planRooms(interior)

  /** @param {number} x @param {number} y */
  const roomAt = (x, y) => rooms.find((room) => x >= room.minX && x <= room.maxX && y >= room.minY && y <= room.maxY)
  for (let y = building.minY; y <= building.maxY; y += 1) {
    for (let x = building.minX; x <= building.maxX; x += 1) {
      const perimeter = x === building.minX || x === building.maxX || y === building.minY || y === building.maxY
      const partition = x === partitionX || (x > partitionX && y === partitionY)
      const room = roomAt(x, y)
      if (perimeter || partition || !room) {
        setCell(map, x, y, { passable: false, material: 'stone', zone: 'walls', variant: Math.floor(random() * 6) })
        continue
      }
      const zone = map.zones.find((entry) => entry.id === room.zoneId)
      setCell(map, x, y, {
        passable: true,
        material: zone?.material ?? 'wood',
        zone: room.zoneId,
        variant: Math.floor(random() * 6),
      })
    }
  }

  // --- стены на рёбрах --------------------------------------------------
  for (let y = building.minY; y <= building.maxY; y += 1) {
    for (let x = building.minX; x <= building.maxX; x += 1) {
      const own = cellAt(map, x, y)
      if (own && !own.passable) edgesAround(map, x, y, 'wall')
    }
  }

  // --- проёмы ------------------------------------------------------------
  const hall = rooms[0]
  const entranceX = Math.round((hall.minX + hall.maxX) / 2)
  openDoorway(map, entranceX, building.maxY, 'front-door')
  openDoorway(map, partitionX, Math.round((interior.minY + partitionY) / 2), 'kitchen-door')
  openDoorway(map, partitionX, Math.round((partitionY + interior.maxY) / 2), 'store-door')

  // Окна: два на северной стене зала, одно на западной. Окно оставляет стену
  // непроходимой, но перестаёт перекрывать обзор.
  openWindow(map, Math.round(hall.minX + (hall.maxX - hall.minX) * 0.3), building.minY)
  openWindow(map, Math.round(hall.minX + (hall.maxX - hall.minX) * 0.7), building.minY)
  openWindow(map, building.minX, Math.round((interior.minY + interior.maxY) / 2))

  // --- тропа от края карты ко входу ------------------------------------
  for (let y = building.maxY + 1; y < safeHeight; y += 1) {
    const drift = Math.round(Math.sin((y - building.maxY) * 0.6) * 1.4)
    for (const x of [entranceX + drift, entranceX + drift + 1]) {
      if (cellAt(map, x, y)) setCell(map, x, y, { material: 'earth', variant: Math.floor(random() * 6) })
    }
  }

  // --- ограда участка ---------------------------------------------------
  const plot = { minX: 1, minY: 1, maxX: safeWidth - 2, maxY: safeHeight - 2 }
  for (let x = plot.minX; x < plot.maxX; x += 1) {
    if (Math.abs(x - entranceX) <= 1) continue
    railBetween(map, x, plot.maxY, x, plot.maxY + 1)
    railBetween(map, x, plot.minY - 1, x, plot.minY)
  }
  for (let y = plot.minY; y < plot.maxY; y += 1) {
    railBetween(map, plot.minX - 1, y, plot.minX, y)
    railBetween(map, plot.maxX, y, plot.maxX + 1, y)
  }

  // --- точки появления и оверлеи ----------------------------------------
  map.spawnPoints.push({ id: 'party-entrance', x: entranceX, y: safeHeight - 2, role: 'party' })
  map.overlays = {
    compass: true,
    scaleBar: true,
    roomLabels: map.zones.filter((zone) => zone.label).map((zone) => ({ zoneId: zone.id, label: zone.label })),
  }

  // Отряд видит участок и подход к дому; внутренности — нет.
  for (let y = building.maxY; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell) setCell(map, x, y, { revealed: true })
    }
  }

  if (withProps) {
    placeProps(map, {
      seed: `${seed}:props`,
      maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (map.sizeClass)].maxProps,
      zones: [
        { zoneId: 'hall', theme: 'interior', density: 22, require: ['bar_counter', 'fireplace', 'table_round', 'table_long', 'stairs_up'] },
        { zoneId: 'kitchen', theme: 'interior', density: 26, require: ['cupboard', 'barrel', 'crate', 'shelf_wall'] },
        { zoneId: 'store', theme: 'interior', density: 30, require: ['crate_stack', 'barrel_stack', 'sack', 'chest'] },
        // Двор наполняется крупным и узнаваемым: деревья, кусты, поленница,
        // телега. Мелочь вроде цветов и колёс приходит только спутником и не
        // участвует в случайном доборе — иначе двор превращается в россыпь
        // непонятных значков вместо участка с деревьями.
        {
          zoneId: 'yard',
          theme: 'yard',
          density: 6,
          require: ['tree_oak', 'tree_birch', 'tree_pine', 'well', 'cart', 'woodpile'],
          prefer: ['tree_oak', 'tree_birch', 'tree_pine', 'tree_dead', 'bush', 'shrub', 'boulder', 'haystack', 'woodpile'],
        },
      ],
    })
  }
  return map
}

/**
 * Превращает клетку стены в проход: клетка становится проходимой, а дверь
 * встаёт на её собственное ребро — то же соглашение, что при преобразовании
 * старых карт, поэтому обратная совместимость сохраняется.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {number} x
 * @param {number} y
 * @param {string} id
 */
function openDoorway(map, x, y, id) {
  const cell = cellAt(map, x, y)
  if (!cell) return
  setCell(map, x, y, { passable: true, material: 'wood' })
  // Рёбра-стены вокруг будущего проёма были построены, пока он сам был стеной.
  // Проём обязан их снять, иначе клетка станет проходимой, но окружённой
  // стенами — и внутрь здания пути не будет. Рёбра к соседям-стенам остаются:
  // это косяки.
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const neighbor = cellAt(map, x + dx, y + dy)
    if (!neighbor || !neighbor.passable) continue
    setEdge(map, x, y, x + dx, y + dy, { kind: 'none' })
  }
  // Дверь встаёт поперёк прохода. Прежде направление угадывалось условием
  // «восток проходим, а юг нет», и на проходе вдоль вертикальной стены полотно
  // садилось на глухое ребро: дверь была, а перекрывать ей было нечего.
  const edge = doorwayEdgeAt(map, x, y)
  if (!edge) return
  setDoor(map, {
    id,
    x: edge.x,
    y: edge.y,
    dir: edge.dir,
    state: 'closed',
    // Признаки стены — про сам проём: он открыт. Проход перекрывает полотно
    // двери, и спрашивают о нём отдельно (`doorBlocksStep`).
    blocksMove: false,
    blocksSight: false,
  })
}

/**
 * Окно: стена остаётся непроходимой, но её рёбра перестают перекрывать обзор.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {number} x
 * @param {number} y
 */
function openWindow(map, x, y) {
  const cell = cellAt(map, x, y)
  if (!cell || cell.passable) return
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const neighbor = cellAt(map, x + dx, y + dy)
    if (!neighbor || !neighbor.passable) continue
    setEdge(map, x, y, x + dx, y + dy, { kind: 'window', blocksMove: true, blocksSight: false, cover: 'three_quarters' })
  }
}

/**
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 */
function railBetween(map, ax, ay, bx, by) {
  if (!cellAt(map, ax, ay) || !cellAt(map, bx, by)) return
  if (edgeBetween(map, ax, ay, bx, by)) return
  setEdge(map, ax, ay, bx, by, { kind: 'rail', blocksMove: true, blocksSight: false, cover: 'half' })
}

/**
 * Сборка с проверкой и тремя ступенями отката (`docs/tactical-map-plan.md`,
 * раздел 10): ослабить необязательные требования, затем упростить планировку,
 * затем отдать минимальную безопасную комнату. Игра не останавливается никогда.
 *
 * @param {{seed?: string, width?: number, height?: number, locationId?: string, theme?: string, withProps?: boolean}} [options]
 * @returns {{map: import('./tactical-map.mjs').TacticalMap, fallback: string, warnings: string[]}}
 */
export function buildBuildingScene(options = {}) {
  const attempts = [
    { fallback: 'none', build: () => generateBuildingScene(options) },
    { fallback: 'no_props', build: () => generateBuildingScene({ ...options, withProps: false }) },
    { fallback: 'safe_room', build: () => safeRoom(options) },
  ]
  /** @type {string[]} */
  let lastErrors = []
  for (const attempt of attempts) {
    let map
    try {
      map = attempt.build()
    } catch (error) {
      lastErrors = [String(error instanceof Error ? error.message : error)]
      continue
    }
    const report = validateTacticalMap(map)
    const reachability = reachabilityIssues(map)
    if (report.ok && !reachability.length) {
      return { map, fallback: attempt.fallback, warnings: tacticalFitnessWarnings(map) }
    }
    lastErrors = [...report.errors.map((issue) => issue.code), ...reachability]
  }
  // Последняя ступень обязана быть валидной по построению; если и она нет —
  // отдаём её всё равно, но с честным предупреждением.
  const map = safeRoom(options)
  return { map, fallback: 'safe_room', warnings: [`не удалось собрать сцену: ${lastErrors.join(', ')}`] }
}

/**
 * Все помещения обязаны быть достижимы от точки появления отряда.
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @returns {string[]}
 */
export function reachabilityIssues(map) {
  const spawn = map.spawnPoints.find((point) => point.role === 'party') ?? map.spawnPoints[0]
  if (!spawn) return ['SPAWN_POINT_MISSING']
  const reached = reachableCells(map, spawn.x, spawn.y)
  /** @type {string[]} */
  const issues = []
  for (const zone of map.zones) {
    if (!zone.label) continue
    let total = 0
    let seen = 0
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const cell = cellAt(map, x, y)
        if (!cell || !cell.passable || cell.zone !== zone.id) continue
        total += 1
        if (reached.has(`${x},${y}`)) seen += 1
      }
    }
    if (total && !seen) issues.push(`ZONE_UNREACHABLE:${zone.id}`)
  }
  return issues
}

/**
 * Проверка тактической пригодности — предупреждением, а не отказом
 * (`docs/tactical-map-plan.md`, раздел 10, последний абзац).
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @returns {string[]}
 */
export function tacticalFitnessWarnings(map) {
  /** @type {string[]} */
  const warnings = []
  let passable = 0
  let covered = 0
  let open = 0
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (!cell || !cell.passable) continue
      passable += 1
      const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .filter(([dx, dy]) => cellAt(map, x + dx, y + dy)?.passable).length
      if (neighbours >= 4) open += 1
      if (neighbours <= 2) covered += 1
    }
  }
  if (!passable) return ['NO_PASSABLE_CELLS']
  const coverShare = covered / passable
  const openShare = open / passable
  if (coverShare > 0.6) warnings.push('TOO_MANY_CORRIDORS: карта из коридоров обесценивает дальний бой')
  if (openShare > 0.9) warnings.push('TOO_OPEN: пустой зал обесценивает укрытия')
  const props = map.props.filter((prop) => prop.cover !== 'none').length
  if (props < 4) warnings.push('LOW_COVER: укрытий почти нет')
  return warnings
}

/**
 * Минимальная безопасная комната — последняя ступень отката.
 * @param {{seed?: string, locationId?: string, theme?: string}} [options]
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function safeRoom({ seed = 'safe', locationId = '', theme = 'tavern' } = {}) {
  const map = createTacticalMap({
    width: 11,
    height: 9,
    locationId,
    seed: String(seed),
    generator: { ...BUILDING_GENERATOR },
    theme,
    sizeClass: 'arena',
  })
  addZone(map, { id: 'hall', kind: 'interior', material: 'wood', lightLevel: 'dim', label: 'Комната' })
  for (let y = 0; y < 9; y += 1) {
    for (let x = 0; x < 11; x += 1) {
      const border = x === 0 || y === 0 || x === 10 || y === 8
      setCell(map, x, y, {
        passable: !border,
        material: border ? 'stone' : 'wood',
        zone: 'hall',
        revealed: true,
        variant: (x + y) % 6,
      })
    }
  }
  for (let y = 0; y < 9; y += 1) {
    for (let x = 0; x < 11; x += 1) {
      const own = cellAt(map, x, y)
      if (own && !own.passable) edgesAround(map, x, y, 'wall')
    }
  }
  map.spawnPoints.push({ id: 'party-entrance', x: 1, y: 4, role: 'party' })
  map.overlays = { compass: true, scaleBar: true, roomLabels: [{ zoneId: 'hall', label: 'Комната' }] }
  return map
}

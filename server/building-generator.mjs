// @ts-check
import { ensurePropAccess, placeProps } from './prop-placement.mjs'
import {
  SIZE_CLASSES,
  addProp,
  addZone,
  attachLevelTransitions,
  cellAt,
  createTacticalMap,
  doorwayEdgeAt,
  edgeBetween,
  floorVariantAt,
  reachableCells,
  setCell,
  setDoor,
  setEdge,
  validateTacticalMap,
} from './tactical-map.mjs'

/**
 * Тема «здание с участком» — сцена-эталон из раздела 1
 * `docs/tactical-map-plan.md`: вариативное здание с функциональными
 * помещениями, внешняя территория с деревьями и тропой, мебель,
 * расставленная осмысленно, стены с дверными и оконными проёмами,
 * около 26×26 клеток.
 *
 * **Про толщину стен.** Стена живёт на ребре (решение Р2), и рендер рисует её
 * именно так. Но правила движения в Rules Engine пока читают проходимость
 * клетки, а не ребро, поэтому стена обязана дополнительно занимать клетку:
 * иначе герой пройдёт сквозь неё. Когда движение переедет на рёбра, клетки
 * стены можно будет убрать, а рёбра останутся на месте.
 */

export const BUILDING_GENERATOR = Object.freeze({ id: 'building-with-yard', version: '4' })

/** Генератор authored-крепости: геометрия одна на все столы, seed меняет только отделку. */
export const ARES_FORTRESS_GENERATOR = Object.freeze({ id: 'ares-fortress', version: '1' })

/** Крепость занимает карту класса `area`, чтобы двор не сжимался до нескольких клеток. */
export const ARES_FORTRESS_SIZE = Object.freeze({ width: 40, height: 36 })

/** Размер сцены-эталона. */
export const REFERENCE_SIZE = Object.freeze({ width: 26, height: 26 })

/** @typedef {'dwelling'|'tavern'|'shop'|'manor'} BuildingUse */
/** @typedef {'temperate'|'arid'|'cold'|'wetland'} BuildingClimate */
/** @typedef {'wood'|'stone'|'sand'|'metal'|'marble'|'ice'} BuildingArchitecture */
/** @typedef {object} BuildingDesign
 * @property {BuildingUse} [building_use]
 * @property {BuildingClimate} [climate]
 * @property {BuildingArchitecture} [architecture]
 * @property {string} [topology]
 * @property {'sparse'|'mixed'|'dense'} [density]
 */
/** @typedef {object} BuildingSceneOptions
 * @property {string} [seed]
 * @property {number} [width]
 * @property {number} [height]
 * @property {string} [locationId]
 * @property {string} [theme]
 * @property {boolean} [withProps]
 * @property {Array<{offset?: number, label?: string}>} [levels]
 * @property {BuildingDesign} [design]
 * @property {'interior'|'exterior'} [entry] где появляется отряд; по умолчанию снаружи
 */

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
 * Экспортируется ради `server/level-generator.mjs`: верхний этаж нарезается той
 * же логикой, что и первый, и второй копии этого правила быть не должно.
 *
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} interior
 * @returns {{rooms: RoomPlan[], partitionX: number, partitionY: number}}
 */
export function planRooms(interior) {
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
export function edgesAround(map, x, y, kind, options = {}) {
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
 * Старые темы получают осмысленный дизайн по умолчанию, чтобы каждый новый
 * вызов шёл через один вариативный генератор. Сохранённые карты читаются из
 * данных и сюда не попадают.
 * @param {unknown} theme
 * @returns {{building_use: 'dwelling'|'tavern'|'shop'|'manor', climate: 'temperate', architecture: 'wood'}}
 */
function defaultBuildingDesignForTheme(theme) {
  const value = String(theme ?? '').toLocaleLowerCase('ru-RU')
  const building_use = /shop|market|merchant|store|магазин|рынок/u.test(value)
    ? 'shop'
    : /manor|estate|palace|усадь|помест|дворец/u.test(value)
      ? 'manor'
      : /house|home|dwelling|cottage|дом|жилищ/u.test(value)
        ? 'dwelling'
        : 'tavern'
  return { building_use, climate: 'temperate', architecture: 'wood' }
}

/**
 * Собирает карту здания с участком. Детерминирована от `seed`.
 *
 * @param {BuildingSceneOptions} [options]
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function generateBuildingScene(options = {}) {
  return generateDesignedBuildingScene({
    ...options,
    design: options.design ?? defaultBuildingDesignForTheme(options.theme),
  })
}

/** @type {Set<BuildingUse>} */
const BUILDING_USES = new Set(['dwelling', 'tavern', 'shop', 'manor'])
/** @type {Set<BuildingClimate>} */
const BUILDING_CLIMATES = new Set(['temperate', 'arid', 'cold', 'wetland'])
/** @type {Set<BuildingArchitecture>} */
const BUILDING_ARCHITECTURES = new Set(['wood', 'stone', 'sand', 'metal', 'marble', 'ice'])
/** @type {ReadonlyArray<'wing'|'long-hall'|'courtyard'>} */
const BUILDING_SCHEMES = Object.freeze(['wing', 'long-hall', 'courtyard'])

/** @param {unknown} value @returns {number} */
function buildingSeedHash(value) {
  let hash = 2166136261
  for (const character of String(value ?? '')) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * @param {unknown} design
 * @returns {BuildingDesign & {building_use: BuildingUse, climate: BuildingClimate, architecture: BuildingArchitecture}}
 */
function normalizeBuildingDesign(design) {
  const source = /** @type {Record<string, unknown>} */ (design && typeof design === 'object' ? design : {})
  /** @param {string} key @param {Set<string>} allowed @param {string} fallback @returns {string} */
  const pick = (key, allowed, fallback) => allowed.has(String(source[key] ?? '')) ? String(source[key]) : fallback
  return {
    building_use: /** @type {'dwelling'|'tavern'|'shop'|'manor'} */ (pick('building_use', BUILDING_USES, 'tavern')),
    climate: /** @type {'temperate'|'arid'|'cold'|'wetland'} */ (pick('climate', BUILDING_CLIMATES, 'temperate')),
    architecture: /** @type {'wood'|'stone'|'sand'|'metal'|'marble'|'ice'} */ (pick('architecture', BUILDING_ARCHITECTURES, 'wood')),
    density: /** @type {'sparse'|'mixed'|'dense'} */ (pick('density', new Set(['sparse', 'mixed', 'dense']), 'mixed')),
  }
}

/** @param {number} value @param {number} minimum @param {number} maximum @returns {number} */
function clampBuilding(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

/** @param {number} minX @param {number} minY @param {number} maxX @param {number} maxY @param {string} zoneId */
function designRoom(minX, minY, maxX, maxY, zoneId) {
  return { zoneId, minX, minY, maxX, maxY }
}

/** @param {RoomPlan} room @returns {boolean} */
function designRoomIsUsable(room) {
  return room.maxX - room.minX >= 2 && room.maxY - room.minY >= 2
}

/**
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} interior
 * @param {'dwelling'|'tavern'|'shop'|'manor'} buildingUse
 * @param {'wing'|'long-hall'|'courtyard'} scheme
 * @returns {RoomPlan[]}
 */
function designRoomsFor(interior, buildingUse, scheme) {
  const { minX, minY, maxX, maxY } = interior
  const width = maxX - minX + 1
  const height = maxY - minY + 1
  const extraIds = buildingUse === 'dwelling'
    ? ['bedroom', 'kitchen', 'store']
    : buildingUse === 'manor'
      ? ['salon', 'kitchen', 'store']
      : buildingUse === 'shop'
        ? ['store', 'workshop']
        : ['kitchen', 'store']

  /**
   * Делит ось на комнаты с одноклеточной стеной между ними. Небольшая карта
   * может не вместить все крылья; тогда схема сообщает об этом и выбирается
   * следующая, а не создаёт комнаты размером в одну клетку.
   * @param {number} start
   * @param {number} end
   * @param {number} count
   * @returns {Array<{min:number,max:number}>|null}
   */
  const splitAxis = (start, end, count) => {
    const span = end - start + 1
    const gap = count - 1
    const roomSize = Math.floor((span - gap) / count)
    if (roomSize < 3) return null
    const result = []
    let cursor = start
    for (let index = 0; index < count; index += 1) {
      const roomEnd = index === count - 1 ? end : cursor + roomSize - 1
      result.push({ min: cursor, max: roomEnd })
      cursor = roomEnd + 2
    }
    return result
  }

  // Боковое крыло: зал занимает основной корпус, а служебные комнаты идут
  // отдельной вертикальной цепочкой сбоку. Для дома и усадьбы это спальня или
  // салон плюс кухня и кладовая; для таверны и лавки — их штатные помещения.
  const sideWidth = Math.max(3, Math.floor(width * 0.42))
  const sideMinX = maxX - sideWidth + 1
  const hallMaxX = sideMinX - 2
  const wingRooms = splitAxis(minY, maxY, extraIds.length)
  if (scheme === 'wing' && wingRooms && hallMaxX - minX >= 2) {
    return [
      designRoom(minX, minY, hallMaxX, maxY, 'hall'),
      ...wingRooms.map((room, index) => designRoom(sideMinX, room.min, maxX, room.max, extraIds[index])),
    ]
  }

  // Длинный зал: зал тянется вдоль всего фасада, а комнаты образуют задний
  // ряд. Это другая топология, а не перестановка подписей квадрантов.
  const hallHeight = Math.max(4, Math.floor(height * 0.38))
  const rearMinY = minY + hallHeight + 1
  const rearRooms = splitAxis(minX, maxX, extraIds.length)
  if (scheme === 'long-hall' && rearMinY <= maxY - 2 && rearRooms) {
    return [
      designRoom(minX, minY, maxX, rearMinY - 2, 'hall'),
      ...rearRooms.map((room, index) => designRoom(room.min, rearMinY, room.max, maxY, extraIds[index])),
    ]
  }

  // Настоящий внутренний двор: он сам является проходной exterior-зоной, а
  // зал, два служебных помещения и (у дома/усадьбы) третья комната окружают
  // его с четырёх сторон через одноклеточные стены и двери.
  const courtyardWidth = clampBuilding(Math.floor(width * 0.25), 3, 5)
  const courtyardHeight = clampBuilding(Math.floor(height * 0.28), 3, 5)
  const horizontalRoomSpan = width - courtyardWidth - 2
  const hallWidth = Math.floor(horizontalRoomSpan * 0.58)
  const rightWidth = horizontalRoomSpan - hallWidth
  const courtyardMinX = minX + hallWidth + 1
  const courtyardMaxX = courtyardMinX + courtyardWidth - 1
  const courtyardTop = minY + Math.max(4, Math.floor((height - courtyardHeight - 2) * 0.45))
  const courtyardMinY = courtyardTop
  const courtyardMaxY = courtyardMinY + courtyardHeight - 1
  const topHeight = courtyardMinY - minY - 1
  const bottomHeight = maxY - courtyardMaxY - 1
  const topRoom = { min: minY, max: courtyardMinY - 2 }
  const bottomRoom = { min: courtyardMaxY + 2, max: maxY }
  const courtyardRooms = [
    designRoom(minX, minY, courtyardMinX - 2, maxY, 'hall'),
    designRoom(courtyardMinX, topRoom.min, courtyardMaxX, topRoom.max, extraIds[0]),
    designRoom(courtyardMinX, bottomRoom.min, courtyardMaxX, bottomRoom.max, extraIds[1]),
    designRoom(courtyardMinX, courtyardMinY, courtyardMaxX, courtyardMaxY, 'courtyard'),
  ]
  if (extraIds.length > 2) courtyardRooms.push(
    designRoom(courtyardMaxX + 2, courtyardMinY, maxX, courtyardMaxY, extraIds[2]),
  )
  const courtyardFits = hallWidth >= 3 && rightWidth >= (extraIds.length > 2 ? 3 : 0)
    && topHeight >= 3 && bottomHeight >= 3 && courtyardRooms.every(designRoomIsUsable)
  if (scheme === 'courtyard' && courtyardFits) return courtyardRooms

  // На минимальной карте сохраняем семантические помещения, даже если
  // выбранная схема не вместилась: длинный зал с доступным числом задних
  // комнат всё ещё лучше, чем молча потерять назначение здания.
  const fallbackRooms = splitAxis(minX, maxX, Math.min(extraIds.length, 2))
  if (fallbackRooms) {
    const fallbackMinY = minY + Math.max(4, Math.floor(height * 0.42))
    return [
      designRoom(minX, minY, maxX, fallbackMinY - 2, 'hall'),
      ...fallbackRooms.map((room, index) => designRoom(room.min, fallbackMinY, room.max, maxY, extraIds[index])),
    ].filter(designRoomIsUsable)
  }
  return [designRoom(minX, minY, maxX, maxY, 'hall')]
}

/** @type {Readonly<Record<string, string>>} */
const DESIGN_ROOM_LABELS = Object.freeze({
  hall: 'Общий зал', kitchen: 'Кухня', store: 'Кладовая', bedroom: 'Спальня',
  salon: 'Салон', workshop: 'Мастерская', courtyard: 'Внутренний двор',
})

/** @param {BuildingArchitecture} architecture @param {string} roomId @param {string} yardMaterial @returns {string} */
function designMaterialFor(architecture, roomId, yardMaterial) {
  if (roomId === 'courtyard') return yardMaterial
  return BUILDING_ARCHITECTURES.has(architecture) ? architecture : 'wood'
}

/**
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {RoomPlan[]} rooms
 * @param {string} firstId
 * @param {string} secondId
 * @param {string} doorId
 * @returns {boolean}
 */
function connectDesignRooms(map, rooms, firstId, secondId, doorId) {
  const first = rooms.find((room) => room.zoneId === firstId)
  const second = rooms.find((room) => room.zoneId === secondId)
  if (!first || !second) return false
  const overlapY = Math.min(first.maxY, second.maxY) - Math.max(first.minY, second.minY)
  if (first.maxX + 2 === second.minX || second.maxX + 2 === first.minX) {
    const wallX = first.maxX + 2 === second.minX ? first.maxX + 1 : second.maxX + 1
    const y = Math.floor((Math.max(first.minY, second.minY) + Math.min(first.maxY, second.maxY)) / 2)
    if (overlapY >= 0) {
      openDoorway(map, wallX, y, doorId)
      return true
    }
    return false
  }
  const overlapX = Math.min(first.maxX, second.maxX) - Math.max(first.minX, second.minX)
  if (first.maxY + 2 === second.minY || second.maxY + 2 === first.minY) {
    const wallY = first.maxY + 2 === second.minY ? first.maxY + 1 : second.maxY + 1
    const x = Math.floor((Math.max(first.minX, second.minX) + Math.min(first.maxX, second.maxX)) / 2)
    if (overlapX >= 0) {
      openDoorway(map, x, wallY, doorId)
      return true
    }
  }
  return false
}

/** @param {import('./tactical-map.mjs').TacticalMap} map @param {RoomPlan[]} rooms @param {{minX:number,minY:number,maxX:number,maxY:number}} building @param {string} id */
function openDesignExteriorDoor(map, rooms, building, id) {
  const room = rooms.find((candidate) => candidate.zoneId === 'hall') ?? rooms[0]
  if (!room) return Math.floor((building.minX + building.maxX) / 2)
  if (room.minY === building.minY + 1) {
    const x = Math.floor((room.minX + room.maxX) / 2)
    openDoorway(map, x, building.minY, id)
    return x
  }
  if (room.maxY === building.maxY - 1) {
    const x = Math.floor((room.minX + room.maxX) / 2)
    openDoorway(map, x, building.maxY, id)
    return x
  }
  if (room.minX === building.minX + 1) {
    openDoorway(map, building.minX, Math.floor((room.minY + room.maxY) / 2), id)
    return Math.max(1, building.minX - 1)
  }
  openDoorway(map, building.maxX, Math.floor((room.minY + room.maxY) / 2), id)
  return Math.min(map.width - 2, building.maxX + 1)
}

/**
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {RoomPlan} hall
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} building
 */
function openDesignWindows(map, hall, building) {
  const candidates = [
    [hall.minX + 1, building.minY], [hall.maxX - 1, building.minY],
    [hall.minX + 1, building.maxY], [hall.maxX - 1, building.maxY],
    [building.minX, hall.minY + 1], [building.minX, hall.maxY - 1],
    [building.maxX, hall.minY + 1], [building.maxX, hall.maxY - 1],
  ]
  const seen = new Set()
  for (const [x, y] of candidates) {
    const key = `${x},${y}`
    if (seen.has(key)) continue
    seen.add(key)
    openWindow(map, x, y)
  }
}

/**
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {string} zoneId
 * @returns {{x: number, y: number}|null}
 */
function interiorEntryPoint(map, zoneId) {
  /** @type {Array<{x: number, y: number}>} */
  const cells = []
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (cell?.passable && cell.zone === zoneId) cells.push({ x, y })
  }
  if (!cells.length) return null
  const centerX = Math.round(cells.reduce((sum, cell) => sum + cell.x, 0) / cells.length)
  const centerY = Math.round(cells.reduce((sum, cell) => sum + cell.y, 0) / cells.length)
  cells.sort((left, right) => Math.abs(left.x - centerX) + Math.abs(left.y - centerY)
    - Math.abs(right.x - centerX) - Math.abs(right.y - centerY)
    || left.y - right.y || left.x - right.x)
  return cells[0]
}

/** @param {import('./tactical-map.mjs').TacticalMap} map @param {string} zoneId */
function revealDesignZone(map, zoneId) {
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    if (cellAt(map, x, y)?.zone === zoneId) setCell(map, x, y, { revealed: true })
  }
}

/** @param {import('./tactical-map.mjs').TacticalMap} map @param {{x:number,y:number}} point @returns {boolean} */
function reserveDesignSpawn(map, point) {
  if (cellAt(map, point.x, point.y)?.passable !== true) return false
  setCell(map, point.x, point.y, { passable: false })
  return true
}

/** @param {import('./tactical-map.mjs').TacticalMap} map @param {{x:number,y:number}} point */
function releaseDesignSpawn(map, point) {
  setCell(map, point.x, point.y, { passable: true })
}

/** @param {BuildingDesign & {building_use: BuildingUse, climate: BuildingClimate, architecture: BuildingArchitecture}} design @param {RoomPlan[]} rooms @param {boolean} includeDecorativeTransition */
function designPropPlans(design, rooms, includeDecorativeTransition = true) {
  /** @param {string} zoneId @returns {boolean} */
  const has = (zoneId) => rooms.some((room) => room.zoneId === zoneId)
  /** @type {Array<{zoneId: string, purpose: string, theme: string, density: number, require: string[], prefer: string[]}>} */
  const plans = []
  /** @param {string} zoneId @param {string} purpose @param {string[]} require @param {string[]} prefer @param {string} theme @param {number} density */
  const add = (zoneId, purpose, require, prefer = [], theme = 'interior', density = 22) => {
    const factor = design.density === 'sparse' ? 0.65 : design.density === 'dense' ? 1.3 : 1
    if (has(zoneId)) plans.push({ zoneId, purpose, theme, density: Math.round(density * factor), require, prefer })
  }
  if (design.building_use === 'tavern') {
    const hallRequired = ['bar_counter', 'bar_shelf', 'fireplace', 'table_round', 'table_small', 'table_long', 'chandelier', 'lantern_wall']
    if (includeDecorativeTransition) hallRequired.push('stairs_up')
    add('hall', 'hall', hallRequired, ['table_round', 'table_small', 'table_long', 'fireplace', 'bar_counter', 'bar_shelf'], 'interior', 26)
    add('kitchen', 'kitchen', ['cupboard', 'barrel', 'crate', 'shelf_wall'], ['cupboard', 'barrel', 'crate', 'shelf_wall'], 'interior', 24)
    add('store', 'store', ['crate_stack', 'barrel_stack', 'sack', 'chest'], ['crate_stack', 'barrel_stack', 'sack', 'chest'], 'interior', 28)
  } else if (design.building_use === 'shop') {
    add('hall', 'hall', ['table_long', 'shelf_wall', 'chest', 'lantern_wall'], ['table_small', 'chair', 'shelf_wall', 'counter'], 'interior', 25)
    add('store', 'store', ['crate_stack', 'barrel_stack', 'sack', 'chest'], ['crate_stack', 'barrel_stack', 'sack', 'chest'], 'interior', 30)
    add('workshop', 'workshop', ['table_long', 'shelf_wall', 'crate'], ['table_long', 'shelf_wall', 'crate', 'barrel', 'chest'], 'interior', 28)
  } else if (design.building_use === 'dwelling') {
    add('hall', 'hall', ['fireplace', 'table_small', 'chair', 'lantern_wall'], ['table_small', 'chair', 'fireplace', 'rug'], 'interior', 23)
    add('bedroom', 'sleeping', ['bed', 'wardrobe', 'night_table', 'chest'], ['bed', 'wardrobe', 'night_table', 'chest', 'candle'], 'interior', 28)
    add('kitchen', 'kitchen', ['fireplace', 'cupboard', 'crate'], ['fireplace', 'cupboard', 'cauldron', 'crate', 'shelf_wall'], 'interior', 25)
    add('store', 'store', ['crate_stack', 'barrel_stack', 'sack', 'chest'], ['crate_stack', 'barrel_stack', 'sack', 'chest'], 'interior', 25)
  } else {
    add('hall', 'hall', ['fireplace', 'table_long', 'candelabra', 'chair', 'chandelier'], ['table_long', 'table_small', 'chair', 'candelabra', 'chandelier'], 'interior', 25)
    add('salon', 'hall', ['table_small', 'chair', 'candelabra'], ['table_small', 'chair', 'candelabra', 'rug'], 'interior', 22)
    add('kitchen', 'kitchen', ['fireplace', 'cupboard', 'crate'], ['fireplace', 'cupboard', 'cauldron', 'crate', 'shelf_wall'], 'interior', 25)
    add('store', 'store', ['crate_stack', 'barrel_stack', 'chest'], ['crate_stack', 'barrel_stack', 'sack', 'chest'], 'interior', 28)
  }
  add('courtyard', 'courtyard', ['well', 'cart'], ['well', 'cart', 'woodpile', 'bush', 'tree_oak', 'tree_birch'], 'yard', 14)
  add('yard', 'exterior', [], ['tree_oak', 'tree_birch', 'tree_pine', 'bush', 'boulder', 'woodpile'], 'yard', design.climate === 'arid' ? 7 : 10)
  return plans
}

/**
 * Сидированный путь для каждого вновь создаваемого обычного здания.
 * `planRooms` выше остаётся узким совместимым ABI для level-generator.
 *
 * @param {BuildingSceneOptions} options
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
function generateDesignedBuildingScene({
  seed = 'building', width = REFERENCE_SIZE.width, height = REFERENCE_SIZE.height,
  locationId = '', theme = 'tavern', withProps = true, levels = [], design, entry = 'exterior',
} = {}) {
  const normalized = normalizeBuildingDesign(design)
  const courtyardRequested = design?.topology === 'courtyard'
  // Явный двор должен помещаться вместе с комнатами и стенами. Размер из
  // заявки модели — ориентир, потеря названного помещения недопустима.
  const minimumSize = courtyardRequested ? 20 : 16
  const minimumBuilding = courtyardRequested ? 15 : 12
  const safeWidth = Math.max(minimumSize, Math.min(SIZE_CLASSES.area.maxWidth, Math.round(width)))
  const safeHeight = Math.max(minimumSize, Math.min(SIZE_CLASSES.area.maxHeight, Math.round(height)))
  const scheme = courtyardRequested ? 'courtyard' : BUILDING_SCHEMES[buildingSeedHash(`${seed}:scheme`) % BUILDING_SCHEMES.length]
  const buildingWidth = Math.max(minimumBuilding, Math.min(safeWidth - 4, Math.round(safeWidth * (0.52 + (buildingSeedHash(`${seed}:width`) % 4) * 0.05))))
  const buildingHeight = Math.max(minimumBuilding, Math.min(safeHeight - 4, Math.round(safeHeight * (0.52 + (buildingSeedHash(`${seed}:height`) % 4) * 0.05))))
  const maxMinX = Math.max(2, safeWidth - buildingWidth - 2)
  const maxMinY = Math.max(2, safeHeight - buildingHeight - 3)
  const building = {
    minX: 2 + buildingSeedHash(`${seed}:x`) % Math.max(1, maxMinX - 1),
    minY: 2 + buildingSeedHash(`${seed}:y`) % Math.max(1, maxMinY - 1),
    maxX: 0,
    maxY: 0,
  }
  building.maxX = Math.min(safeWidth - 3, building.minX + buildingWidth - 1)
  building.maxY = Math.min(safeHeight - 3, building.minY + buildingHeight - 1)
  const interior = { minX: building.minX + 1, minY: building.minY + 1, maxX: building.maxX - 1, maxY: building.maxY - 1 }
  const rooms = designRoomsFor(interior, normalized.building_use, scheme)
  const yardMaterial = normalized.climate === 'arid' ? 'sand' : normalized.climate === 'cold' ? 'ice' : 'grass'
  const yardSurface = normalized.climate === 'wetland' ? 'mud' : normalized.climate === 'cold' ? 'ice' : 'none'
  const wallMaterial = ['stone', 'marble', 'metal', 'ice'].includes(normalized.architecture) ? normalized.architecture : 'stone'
  const map = createTacticalMap({
    width: safeWidth, height: safeHeight, locationId, seed: String(seed),
    generator: { ...BUILDING_GENERATOR }, theme, tilesetId: 'building',
    sizeClass: safeWidth * safeHeight <= SIZE_CLASSES.arena.maxCells ? 'arena' : 'area',
  })
  addZone(map, { id: 'yard', kind: 'exterior', material: yardMaterial, lightLevel: normalized.climate === 'cold' ? 'dim' : 'bright', floorDirection: 'horizontal', label: 'Участок' })
  for (const room of rooms) addZone(map, {
    id: room.zoneId,
    kind: room.zoneId === 'courtyard' ? 'exterior' : 'interior',
    material: designMaterialFor(normalized.architecture, room.zoneId, yardMaterial),
    lightLevel: room.zoneId === 'store' ? 'dark' : 'dim',
    floorDirection: buildingSeedHash(`${seed}:${room.zoneId}:floor`) % 2 ? 'vertical' : 'horizontal',
    label: DESIGN_ROOM_LABELS[room.zoneId] ?? room.zoneId,
  })
  addZone(map, { id: 'walls', kind: 'interior', material: wallMaterial, lightLevel: 'dark', floorDirection: 'horizontal', label: '' })
  /** @param {number} x @param {number} y */
  const variantAt = (x, y) => floorVariantAt(seed, x, y)
  for (let y = 0; y < safeHeight; y += 1) for (let x = 0; x < safeWidth; x += 1) {
    setCell(map, x, y, { passable: true, material: yardMaterial, surface: yardSurface, zone: 'yard', variant: variantAt(x, y), revealed: false, moveCost: normalized.climate === 'wetland' ? 2 : 1 })
  }
  /** @param {number} x @param {number} y */
  const roomAt = (x, y) => rooms.find((room) => x >= room.minX && x <= room.maxX && y >= room.minY && y <= room.maxY)
  for (let y = building.minY; y <= building.maxY; y += 1) for (let x = building.minX; x <= building.maxX; x += 1) {
    const perimeter = x === building.minX || x === building.maxX || y === building.minY || y === building.maxY
    const room = roomAt(x, y)
    if (perimeter || !room) {
      setCell(map, x, y, { passable: false, material: wallMaterial, zone: 'walls', variant: variantAt(x, y) })
      continue
    }
    setCell(map, x, y, { passable: true, material: designMaterialFor(normalized.architecture, room.zoneId, yardMaterial), zone: room.zoneId, variant: variantAt(x, y), surface: room.zoneId === 'courtyard' ? yardSurface : 'none' })
  }
  for (let y = building.minY; y <= building.maxY; y += 1) for (let x = building.minX; x <= building.maxX; x += 1) if (!cellAt(map, x, y)?.passable) edgesAround(map, x, y, 'wall')
  const entranceX = openDesignExteriorDoor(map, rooms, building, 'front-door')
  const connected = new Set(['hall'])
  if (rooms.some((room) => room.zoneId === 'courtyard') && connectDesignRooms(map, rooms, 'hall', 'courtyard', 'courtyard-door')) connected.add('courtyard')
  for (const zoneId of ['kitchen', 'store', 'bedroom', 'salon', 'workshop']) {
    if (!rooms.some((room) => room.zoneId === zoneId)) continue
    const doorId = `${zoneId}-door`
    let linked = false
    for (const source of [...connected]) {
      if (!connectDesignRooms(map, rooms, source, zoneId, doorId)) continue
      connected.add(zoneId)
      linked = true
      break
    }
    // Соседние корпуса могут примыкать не к залу, а друг к другу. Повторяем
    // попытку через все уже связанные комнаты, прежде чем оставить крыло без пути.
    if (!linked) for (const source of rooms.map((room) => room.zoneId).filter((id) => connected.has(id))) {
      if (!connectDesignRooms(map, rooms, source, zoneId, doorId)) continue
      connected.add(zoneId)
      break
    }
  }
  const hall = rooms.find((room) => room.zoneId === 'hall') ?? rooms[0]
  if (hall) openDesignWindows(map, hall, building)
  for (let y = building.maxY + 1; y < safeHeight; y += 1) {
    const drift = Math.round(Math.sin((y - building.maxY) * 0.6 + buildingSeedHash(seed) % 5) * 1.4)
    for (const x of [entranceX + drift, entranceX + drift + 1]) if (cellAt(map, x, y)) setCell(map, x, y, { material: 'earth', surface: 'none', variant: variantAt(x, y) })
  }
  const plot = { minX: 1, minY: 1, maxX: safeWidth - 2, maxY: safeHeight - 2 }
  for (let x = plot.minX; x < plot.maxX; x += 1) {
    if (Math.abs(x - entranceX) <= 1) continue
    railBetween(map, x, plot.maxY, x, plot.maxY + 1); railBetween(map, x, plot.minY - 1, x, plot.minY)
  }
  for (let y = plot.minY; y < plot.maxY; y += 1) {
    railBetween(map, plot.minX - 1, y, plot.minX, y); railBetween(map, plot.maxX, y, plot.maxX + 1, y)
  }
  const startsInside = entry === 'interior'
  const exteriorSpawn = { x: clampBuilding(entranceX, 1, safeWidth - 2), y: safeHeight - 2 }
  const partySpawn = startsInside ? (interiorEntryPoint(map, 'hall') ?? exteriorSpawn) : exteriorSpawn
  map.spawnPoints.push({ id: 'party-entrance', ...partySpawn, role: 'party' })
  map.overlays = { compass: true, scaleBar: true, roomLabels: map.zones.filter((zone) => zone.label).map((zone) => ({ zoneId: zone.id, label: zone.label })) }
  for (let y = building.maxY; y < safeHeight; y += 1) for (let x = 0; x < safeWidth; x += 1) if (cellAt(map, x, y)) setCell(map, x, y, { revealed: true })
  if (startsInside) revealDesignZone(map, 'hall')
  const spawnReserved = startsInside && partySpawn !== exteriorSpawn && reserveDesignSpawn(map, partySpawn)
  if (withProps) {
    try {
      placeProps(map, {
        seed: `${seed}:props`,
        maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (map.sizeClass)].maxProps,
        zones: designPropPlans(normalized, rooms, levels.length === 0),
      })
    } finally {
      if (spawnReserved) releaseDesignSpawn(map, partySpawn)
    }
  } else if (spawnReserved) {
    releaseDesignSpawn(map, partySpawn)
  }
  ensureDeclaredTransitions(map, levels, 'hall')
  ensurePropAccess(map)
  return map
}

/**
 * Рисует прямоугольный корпус комнаты. Периметр остаётся клетками стены, а
 * соседние проходы потом получают настоящие двери на рёбрах.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} rect
 * @param {string} zoneId
 * @param {string} material
 */
function paintFortressRoom(map, rect, zoneId, material) {
  for (let y = rect.minY; y <= rect.maxY; y += 1) {
    for (let x = rect.minX; x <= rect.maxX; x += 1) {
      const border = x === rect.minX || x === rect.maxX || y === rect.minY || y === rect.maxY
      setCell(map, x, y, {
        passable: !border,
        material: border ? 'stone' : material,
        zone: border ? 'walls' : zoneId,
        variant: floorVariantAt(map.seed, x, y),
      })
    }
  }
}

/**
 * Внешние стены и корпуса имеют одну серверную границу: непроходимая клетка
 * плюс ребро-стена. Поэтому старый `scene.cells` и TacticalMap совпадают.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 */
function outlineFortressWalls(map) {
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell?.passable) continue
      edgesAround(map, x, y, 'wall')
    }
  }
}

/**
 * Ставит дверь по уже выбранному ребру. `setDoor` остаётся единственным
 * владельцем согласования записи двери и ребра.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {{id: string, x: number, y: number, dir: 'e'|'s'}} door
 */
function addFortressDoor(map, door) {
  setDoor(map, {
    ...door,
    state: 'closed',
    blocksMove: false,
    blocksSight: false,
  })
}

/**
 * Смысловой план предметов крепости. `purpose` не расширяет схему зоны: это
 * подсказка владельцу расстановки, чтобы склад и казарма не получали один
 * случайный каталог.
 *
 * @param {string} seed
 * @param {import('./tactical-map.mjs').TacticalMap} map
 */
function placeAresFortressProps(seed, map) {
  placeProps(map, {
    seed: `${seed}:props`,
    maxProps: SIZE_CLASSES.area.maxProps,
    zones: [
      {
        zoneId: 'gallery', purpose: 'hall', theme: 'building', density: 22,
        require: ['table_small', 'candelabra', 'banner', 'chair', 'chandelier'],
        prefer: ['table_small', 'candelabra', 'banner', 'chair', 'chandelier', 'bookshelf'],
      },
      {
        zoneId: 'barracks', purpose: 'barracks', theme: 'building', density: 24,
        require: ['bunk_bed', 'bunk_bed', 'chest', 'table_long', 'bench'],
        prefer: ['bunk_bed', 'bed', 'chest', 'table_long', 'bench', 'bookshelf', 'lantern_wall'],
      },
      {
        zoneId: 'stables', purpose: 'stable', theme: 'yard', density: 22,
        require: ['haystack', 'water_trough', 'hitching_post'],
        prefer: ['haystack', 'water_trough', 'hitching_post', 'woodpile', 'lamp_post'],
      },
      {
        zoneId: 'storehouse', purpose: 'store', theme: 'building', density: 30,
        require: ['crate_stack', 'barrel_stack', 'chest', 'shelf_wall'],
        prefer: ['crate_stack', 'barrel_stack', 'crate', 'barrel', 'sack', 'chest', 'shelf_wall'],
      },
      {
        zoneId: 'workshop', purpose: 'workshop', theme: 'building', density: 32,
        // `workshop` уже добавляет стол и полку через semantic_props; здесь
        // закрепляем снабжение и топливо, чтобы мастерская не стала вторым
        // залом даже при малом бюджете зоны.
        require: ['crate', 'barrel', 'firewood_stack'],
        prefer: ['crate', 'barrel', 'firewood_stack', 'chest', 'cauldron'],
      },
      {
        zoneId: 'exterior', purpose: 'exterior', theme: 'yard', density: 6,
        require: ['tree_oak', 'bush', 'boulder'],
        prefer: ['tree_oak', 'tree_pine', 'tree_dead', 'bush', 'shrub', 'boulder', 'rock_small'],
      },
      {
        zoneId: 'courtyard', purpose: 'courtyard', theme: 'yard', density: 8,
        require: ['well', 'water_trough', 'woodpile', 'lamp_post'],
        prefer: ['well', 'water_trough', 'woodpile', 'lamp_post', 'campfire', 'bush'],
      },
    ],
  })
}

/**
 * Авторская «Крепость Ареса»: внешний двор с тремя воротами и пять
 * функциональных корпусов вокруг него. В отличие от общего генератора здания
 * здесь seed не меняет топологию: повторный вход возвращает тот же двор,
 * двери и комнаты, а меняется только порядок вариантов пола и предметов.
 *
 * @param {object} [options]
 * @param {string} [options.seed]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {string} [options.locationId]
 * @param {string} [options.theme]
 * @param {boolean} [options.withProps]
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function generateAresFortressScene({
  seed = 'ares-fortress',
  width = ARES_FORTRESS_SIZE.width,
  height = ARES_FORTRESS_SIZE.height,
  locationId = '',
  theme = 'authored-palace',
  withProps = true,
} = {}) {
  const safeWidth = Math.max(36, Math.min(SIZE_CLASSES.area.maxWidth, Math.round(width)))
  const safeHeight = Math.max(36, Math.min(SIZE_CLASSES.area.maxHeight, Math.round(height)))
  const map = createTacticalMap({
    width: safeWidth,
    height: safeHeight,
    locationId,
    seed: String(seed),
    generator: { ...ARES_FORTRESS_GENERATOR },
    theme,
    tilesetId: 'fortress',
    sizeClass: 'area',
  })

  addZone(map, { id: 'courtyard', kind: 'exterior', material: 'grass', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Большой внутренний двор' })
  addZone(map, { id: 'exterior', kind: 'exterior', material: 'grass', lightLevel: 'bright', floorDirection: 'horizontal', label: '' })
  addZone(map, { id: 'gallery', kind: 'interior', material: 'stone', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Военная галерея' })
  addZone(map, { id: 'barracks', kind: 'interior', material: 'wood', lightLevel: 'dim', floorDirection: 'vertical', label: 'Казарма' })
  addZone(map, { id: 'stables', kind: 'interior', material: 'earth', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Конюшня' })
  addZone(map, { id: 'storehouse', kind: 'interior', material: 'wood', lightLevel: 'dark', floorDirection: 'vertical', label: 'Военный склад' })
  addZone(map, { id: 'workshop', kind: 'interior', material: 'stone', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Мастерская' })
  addZone(map, { id: 'walls', kind: 'interior', material: 'stone', lightLevel: 'dark', floorDirection: 'horizontal', label: '' })

  // Трёхклеточный внешний пояс даёт место крупным деревьям и камням. Один
  // срезанный угол с каждой диагонали делает контур крепости менее коробочным,
  // но диагональный срез не открывает ортогональный проход во двор.
  const outer = { minX: 3, minY: 3, maxX: safeWidth - 4, maxY: safeHeight - 4 }
  const courtyard = { minX: outer.minX + 1, minY: outer.minY + 1, maxX: outer.maxX - 1, maxY: outer.maxY - 1 }
  const centerX = Math.floor((outer.minX + outer.maxX) / 2)

  // Внешняя площадка остаётся клетками карты: через ворота можно выйти за
  // стену, а не упереться в край прямоугольника.
  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      setCell(map, x, y, {
        passable: true,
        material: 'grass',
        zone: x < outer.minX || x > outer.maxX || y < outer.minY || y > outer.maxY ? 'exterior' : '',
        variant: floorVariantAt(seed, x, y),
        revealed: false,
      })
    }
  }
  for (let y = courtyard.minY; y <= courtyard.maxY; y += 1) {
    for (let x = courtyard.minX; x <= courtyard.maxX; x += 1) {
      setCell(map, x, y, { passable: true, material: 'grass', zone: 'courtyard' })
    }
  }

  // Основа двора — трава. Позже в нём появятся earth-карманы и каменные
  // дорожки; так покрытие различается даже без растрового арта.

  // Наружная стена крепости.
  for (let x = outer.minX; x <= outer.maxX; x += 1) {
    for (const y of [outer.minY, outer.maxY]) setCell(map, x, y, { passable: false, material: 'stone', zone: 'walls' })
  }
  for (let y = outer.minY; y <= outer.maxY; y += 1) {
    for (const x of [outer.minX, outer.maxX]) setCell(map, x, y, { passable: false, material: 'stone', zone: 'walls' })
  }

  const gallery = { minX: Math.round(safeWidth * 0.28), minY: 5, maxX: Math.round(safeWidth * 0.72), maxY: 13 }
  const barracks = { minX: 5, minY: 16, maxX: Math.round(safeWidth * 0.28), maxY: Math.min(courtyard.maxY - 3, Math.round(safeHeight * 0.82)) }
  const stables = { minX: Math.round(safeWidth * 0.72), minY: 16, maxX: safeWidth - 6, maxY: barracks.maxY }
  const workshopTop = Math.min(courtyard.maxY - 5, Math.round(safeHeight * 0.72))
  // Оставляем полосу перед главными воротами свободной: южная дверь мастерской
  // не должна занять сам проезд во двор.
  const workshopBottom = courtyard.maxY - 1
  const storehouse = { minX: Math.round(safeWidth * 0.33), minY: workshopTop, maxX: centerX, maxY: workshopBottom }
  const workshop = { minX: centerX, minY: workshopTop, maxX: Math.round(safeWidth * 0.67), maxY: workshopBottom }
  const galleryEastDoorY = gallery.minY + 4
  const barracksDoorY = Math.floor((barracks.minY + barracks.maxY) / 2)
  const stablesDoorY = Math.floor((stables.minY + stables.maxY) / 2)
  const storehouseDoorX = storehouse.minX + 2
  const workshopDoorX = workshop.minX + 2
  const storeWorkshopDoorY = Math.floor((workshopTop + workshopBottom) / 2)
  paintFortressRoom(map, gallery, 'gallery', 'stone')
  paintFortressRoom(map, barracks, 'barracks', 'wood')
  paintFortressRoom(map, stables, 'stables', 'earth')
  paintFortressRoom(map, storehouse, 'storehouse', 'wood')
  paintFortressRoom(map, workshop, 'workshop', 'stone')

  // Проёмы в корпусах. Дверь — проход в стене, а не декоративная клетка:
  // вокруг неё остаются косяки и стены, соседняя зона достижима по ребру.
  setCell(map, centerX, gallery.maxY, { passable: true, material: 'stone', zone: 'gallery' })
  setCell(map, gallery.maxX, galleryEastDoorY, { passable: true, material: 'stone', zone: 'gallery' })
  setCell(map, barracks.maxX, barracksDoorY, { passable: true, material: 'wood', zone: 'barracks' })
  setCell(map, stables.minX, stablesDoorY, { passable: true, material: 'earth', zone: 'stables' })
  setCell(map, storehouseDoorX, storehouse.minY, { passable: true, material: 'wood', zone: 'storehouse' })
  setCell(map, workshopDoorX, workshop.minY, { passable: true, material: 'stone', zone: 'workshop' })
  setCell(map, centerX, storeWorkshopDoorY, { passable: true, material: 'wood', zone: 'storehouse' })

  // Ворота оставляют внешний двор частью той же карты и дают три реальные
  // входа: главный проезд и две боковые калитки.
  const sideGateY = gallery.maxY + 1
  setCell(map, centerX, outer.maxY, { passable: true, material: 'stone', zone: 'courtyard' })
  setCell(map, outer.minX, sideGateY, { passable: true, material: 'stone', zone: 'courtyard' })
  setCell(map, outer.maxX, sideGateY, { passable: true, material: 'stone', zone: 'courtyard' })
  for (const corner of [
    { x: outer.minX, y: outer.minY },
    { x: outer.maxX, y: outer.maxY },
  ]) {
    setCell(map, corner.x, corner.y, { passable: true, material: 'grass', zone: 'exterior' })
  }

  /** @param {number} x @param {number} fromY @param {number} toY @param {number} [halfWidth] */
  const paintVerticalPath = (x, fromY, toY, halfWidth = 0) => {
    const low = Math.min(fromY, toY)
    const high = Math.max(fromY, toY)
    for (let y = low; y <= high; y += 1) {
      for (let dx = -halfWidth; dx <= halfWidth; dx += 1) {
        const cell = cellAt(map, x + dx, y)
        if (cell?.passable && cell.zone === 'courtyard') setCell(map, x + dx, y, { material: 'stone' })
      }
    }
  }
  /** @param {number} y @param {number} fromX @param {number} toX @param {number} [halfWidth] */
  const paintHorizontalPath = (y, fromX, toX, halfWidth = 0) => {
    const low = Math.min(fromX, toX)
    const high = Math.max(fromX, toX)
    for (let x = low; x <= high; x += 1) {
      for (let dy = -halfWidth; dy <= halfWidth; dy += 1) {
        const cell = cellAt(map, x, y + dy)
        if (cell?.passable && cell.zone === 'courtyard') setCell(map, x, y + dy, { material: 'stone' })
      }
    }
  }

  // Земляные карманы остаются между дорожками: это место для дворовой жизни,
  // а не единая каменная площадка.
  const earthPockets = [
    { minX: courtyard.minX + 2, maxX: courtyard.minX + 6, minY: courtyard.minY + 2, maxY: courtyard.minY + 6 },
    { minX: courtyard.maxX - 6, maxX: courtyard.maxX - 2, minY: courtyard.maxY - 6, maxY: courtyard.maxY - 2 },
  ]
  for (const pocket of earthPockets) {
    for (let y = pocket.minY; y <= pocket.maxY; y += 1) {
      for (let x = pocket.minX; x <= pocket.maxX; x += 1) {
        if (cellAt(map, x, y)?.zone === 'courtyard') setCell(map, x, y, { material: 'earth' })
      }
    }
  }
  // Главная ось идёт от ворот к галерее, а короткие ответвления — к каждому
  // корпусу. Проверка зоны не даёт дорожке прорезать стены зданий.
  paintVerticalPath(centerX, gallery.maxY + 1, courtyard.maxY, 1)
  paintHorizontalPath(galleryEastDoorY, centerX, gallery.maxX + 1)
  paintHorizontalPath(barracksDoorY, barracks.maxX + 1, centerX)
  paintHorizontalPath(stablesDoorY, centerX, stables.minX - 1)
  const workshopPathY = workshopTop - 1
  paintHorizontalPath(workshopPathY, storehouseDoorX, workshopDoorX)
  paintVerticalPath(storehouseDoorX, workshopPathY, storehouse.minY - 1)
  paintVerticalPath(workshopDoorX, workshopPathY, workshop.minY - 1)

  outlineFortressWalls(map)
  addFortressDoor(map, { id: 'gallery-courtyard-door', x: centerX, y: gallery.maxY, dir: 's' })
  addFortressDoor(map, { id: 'gallery-east-door', x: gallery.maxX, y: galleryEastDoorY, dir: 'e' })
  addFortressDoor(map, { id: 'barracks-door', x: barracks.maxX, y: barracksDoorY, dir: 'e' })
  addFortressDoor(map, { id: 'stables-door', x: stables.minX - 1, y: stablesDoorY, dir: 'e' })
  addFortressDoor(map, { id: 'storehouse-door', x: storehouseDoorX, y: storehouse.minY, dir: 's' })
  addFortressDoor(map, { id: 'workshop-door', x: workshopDoorX, y: workshop.minY, dir: 's' })
  addFortressDoor(map, { id: 'storehouse-workshop-door', x: centerX, y: storeWorkshopDoorY, dir: 'e' })
  addFortressDoor(map, { id: 'main-gate', x: centerX, y: outer.maxY - 1, dir: 's' })
  addFortressDoor(map, { id: 'west-sally', x: outer.minX, y: sideGateY, dir: 'e' })
  addFortressDoor(map, { id: 'east-sally', x: outer.maxX - 1, y: sideGateY, dir: 'e' })

  if (withProps) placeAresFortressProps(seed, map)

  // Авторский пролог начинается в галерее. Выбираем свободную клетку рядом с
  // картографическим столом, чтобы партия и король действительно стояли в
  // одной функциональной комнате, а не на случайном дворе.
  const table = map.props.find((prop) => prop.assetId === 'table_long' && prop.footprint.some((cell) => cellAt(map, cell.x, cell.y)?.zone === 'gallery'))
    ?? map.props.find((prop) => prop.assetId === 'table_small' && prop.footprint.some((cell) => cellAt(map, cell.x, cell.y)?.zone === 'gallery'))
  if (table) table.id = 'war-table'
  const occupied = new Set(map.props.flatMap((prop) => prop.footprint.map((cell) => `${cell.x},${cell.y}`)))
  /** @type {Array<{x: number, y: number}>} */
  const galleryCells = []
  for (let y = gallery.minY + 1; y < gallery.maxY; y += 1) {
    for (let x = gallery.minX + 1; x < gallery.maxX; x += 1) {
      if (cellAt(map, x, y)?.passable && !occupied.has(`${x},${y}`)) galleryCells.push({ x, y })
    }
  }
  /** @param {{x: number, y: number}} cell @param {{x: number, y: number}} anchor @returns {number} */
  const distance = (cell, anchor) => Math.abs(cell.x - anchor.x) + Math.abs(cell.y - anchor.y)
  const tableAnchor = table?.footprint[0] ?? { x: centerX, y: gallery.minY + 3 }
  galleryCells.sort((left, right) => distance(left, tableAnchor) - distance(right, tableAnchor) || left.x - right.x || left.y - right.y)
  const partyStart = galleryCells[0] ?? { x: centerX, y: gallery.minY + 2 }
  map.spawnPoints.push({ id: 'party-war-gallery', x: partyStart.x, y: partyStart.y, role: 'party' })
  const kingStart = galleryCells.find((cell) => cell !== partyStart && distance(cell, tableAnchor) > 0) ?? partyStart
  map.spawnPoints.push({ id: 'king-war-gallery', x: kingStart.x, y: kingStart.y, role: 'neutral' })

  // Общий план королевской крепости известен приглашённой партии. Двери и
  // непроходимые стены всё равно проверяются при каждом физическом переходе.
  for (let y = courtyard.minY; y <= courtyard.maxY; y += 1) {
    for (let x = courtyard.minX; x <= courtyard.maxX; x += 1) {
      if (cellAt(map, x, y)) setCell(map, x, y, { revealed: true })
    }
  }
  for (let y = gallery.minY; y <= gallery.maxY; y += 1) {
    for (let x = gallery.minX; x <= gallery.maxX; x += 1) {
      if (cellAt(map, x, y)) setCell(map, x, y, { revealed: true })
    }
  }
  map.overlays = {
    compass: true,
    scaleBar: true,
    roomLabels: map.zones.filter((zone) => zone.label).map((zone) => ({ zoneId: zone.id, label: zone.label })),
  }
  return map
}

/**
 * Сборка authored-крепости с тем же отчётом, что и общий building-generator.
 *
 * @param {Parameters<typeof generateAresFortressScene>[0]} [options]
 * @returns {{map: import('./tactical-map.mjs').TacticalMap, fallback: string, warnings: string[]}}
 */
export function buildAresFortressScene(options = {}) {
  const map = generateAresFortressScene(options)
  const report = validateTacticalMap(map)
  const reachability = reachabilityIssues(map)
  return {
    map,
    fallback: 'none',
    warnings: [...report.errors.map((issue) => issue.code), ...reachability, ...tacticalFitnessWarnings(map)],
  }
}

/**
 * Привязывает объявленные этажи к лестницам зала и достраивает недостающие.
 *
 * Одной привязки мало: `placeProps` ставит лестницу наравне с мебелью, и на
 * части сидов она не помещается — `stairs_up` занимает две клетки у стены.
 * Пока лестница была декором, это ничего не значило; с объявленным вторым
 * этажом это дыра: этаж есть, а подняться нечем. Поэтому недостающий крючок
 * ставится явно, по первой свободной внутренней клетке зала.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {Array<{offset?: number, label?: string}>} levels
 * @param {string} zoneId зона, в которой ищется место под лестницу
 */
function ensureDeclaredTransitions(map, levels, zoneId) {
  const declared = Array.isArray(levels) ? levels : []
  if (!declared.length) return
  const attached = attachLevelTransitions(map, declared)
  const covered = new Set(attached.map((prop) => prop.transition?.toLevel))
  /** @type {Set<string>} */
  const occupied = new Set()
  for (const prop of map.props) for (const cell of prop.footprint) occupied.add(`${cell.x},${cell.y}`)
  for (const spawn of map.spawnPoints) occupied.add(`${spawn.x},${spawn.y}`)
  for (const level of declared) {
    const toLevel = Number(level?.offset)
    if (!Number.isSafeInteger(toLevel) || toLevel === map.levelIndex || covered.has(toLevel)) continue
    const spot = freeWallCellIn(map, zoneId, occupied)
    if (!spot) continue
    addProp(map, {
      id: `level-transition-${toLevel}`,
      assetId: toLevel > map.levelIndex ? 'stairs_up' : 'stairs_down',
      x: spot.x + 0.5,
      y: spot.y + 0.5,
      rotation: 0,
      scale: 1,
      // Одна клетка, а не штатный след 2×1: лестница обязана встать даже в
      // тесном зале, а её точные координаты нужны парному переходу этажом выше.
      footprint: [{ x: spot.x, y: spot.y }],
      zOrder: 0,
      blocksMove: false,
      blocksSight: false,
      cover: 'none',
      interactive: true,
      transition: { toLevel, label: String(level?.label ?? '') },
    })
    covered.add(toLevel)
    occupied.add(`${spot.x},${spot.y}`)
  }
}

/**
 * Первая свободная внутренняя клетка зоны. Сначала ищется место без соседней
 * стены: такой переход остаётся достижимым и после сжатия контура подвала.
 * Если зал слишком тесен, берётся клетка у кладки. Обход по y, затем x —
 * результат детерминирован.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {string} zoneId
 * @param {Set<string>} occupied
 * @returns {{x: number, y: number}|null}
 */
function freeWallCellIn(map, zoneId, occupied) {
  /** @type {{x: number, y: number}|null} */
  let anywhere = null
  /** @type {{x: number, y: number}|null} */
  let nearWall = null
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (!cell || !cell.passable || cell.zone !== zoneId || occupied.has(`${x},${y}`)) continue
      if (!anywhere) anywhere = { x, y }
      const touchesWall = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .some(([dx, dy]) => cellAt(map, x + dx, y + dy)?.passable !== true)
      if (touchesWall) {
        if (!nearWall) nearWall = { x, y }
        continue
      }
      return { x, y }
    }
  }
  return nearWall ?? anywhere
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
export function openDoorway(map, x, y, id) {
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
export function openWindow(map, x, y) {
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
 * @param {BuildingSceneOptions} [options]
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
  addZone(map, { id: 'hall', kind: 'interior', material: 'wood', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Комната' })
  for (let y = 0; y < 9; y += 1) {
    for (let x = 0; x < 11; x += 1) {
      const border = x === 0 || y === 0 || x === 10 || y === 8
      setCell(map, x, y, {
        passable: !border,
        material: border ? 'stone' : 'wood',
        zone: 'hall',
        revealed: true,
        variant: floorVariantAt(seed, x, y),
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

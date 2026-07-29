// @ts-check
import { createHash } from 'node:crypto'

/**
 * Контракт тактической карты: клетки хранятся типизированными слоями, стены
 * живут на рёбрах, предметы отвязаны от клетки. См. `docs/tactical-map-plan.md`,
 * разделы 4 и 5.
 *
 * Модуль намеренно не знает ни о состоянии кампании, ни о событиях, ни о
 * генераторе: он описывает данные и умеет превращать их в старый разреженный
 * массив клеток и обратно без потерь.
 */

export const TACTICAL_MAP_VERSION = 'skazanie:tactical-map-v1'

/**
 * Порядок значений — часть формата хранения: код равен индексу в массиве.
 * Перестановка или вставка в середину ломает уже сохранённые слои, поэтому
 * новые значения добавляются только в конец.
 */
export const SURFACES = Object.freeze(['none', 'water', 'ice', 'oil', 'mud', 'rubble'])
export const MATERIALS = Object.freeze(['stone', 'wood', 'earth', 'grass', 'sand', 'marble', 'metal', 'ice'])
export const EDGE_KINDS = Object.freeze(['none', 'wall', 'door', 'window', 'rail', 'ledge', 'loophole', 'grate'])
export const COVER_LEVELS = Object.freeze(['none', 'half', 'three_quarters'])
export const DOOR_STATES = Object.freeze(['open', 'closed', 'locked', 'broken'])
export const ZONE_KINDS = Object.freeze(['interior', 'exterior'])
export const FLOOR_DIRECTIONS = Object.freeze(['horizontal', 'vertical'])
export const SPAWN_ROLES = Object.freeze(['party', 'enemy', 'neutral'])

/**
 * Классы размеров карты (`docs/tactical-map-plan.md`, 11.3). Бюджет предметов
 * взят из плана.
 *
 * Бюджет стен равен числу клеток. У сетки W×H всего `2·W·H − W − H` рёбер, то
 * есть чуть меньше двух на клетку, поэтому «удвоенное число клеток» было бы
 * недостижимой границей и не поймало бы ничего. Одна стена на клетку — это уже
 * лабиринт, а не помещение: замеренный правдоподобный интерьер 100×100 даёт
 * около 950 рёбер со стенами, то есть под 10 % бюджета.
 */
export const SIZE_CLASSES = Object.freeze({
  arena: Object.freeze({ maxWidth: 30, maxHeight: 30, maxCells: 900, maxProps: 250, maxWallEdges: 900 }),
  area: Object.freeze({ maxWidth: 60, maxHeight: 60, maxCells: 3_600, maxProps: 800, maxWallEdges: 3_600 }),
  region: Object.freeze({ maxWidth: 100, maxHeight: 100, maxCells: 10_000, maxProps: 2_000, maxWallEdges: 10_000 }),
})

/** Паттерны старого генератора. Нужны только для обратного преобразования. */
const LEGACY_PATTERNS = Object.freeze([
  'small-room', 'great-hall', 'keep', 'courtyard', 'crypt', 'cave-cluster', 'village', 'bridge', 'natural',
])

/**
 * Необязательные поля старой клетки. Карта помнит, какие из них несли исходные
 * данные, чтобы обратное преобразование не добавляло полей, которых там не
 * было: пока `scene.cells` остаётся производной read-моделью, любое новое поле
 * в ней — это внешнее изменение поведения.
 */
const LEGACY_OPTIONAL_FIELDS = Object.freeze(['material', 'variant', 'pattern', 'edge_mask'])

export class TacticalMapError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'TacticalMapError'
    this.code = code
  }
}

/**
 * @typedef {object} TacticalCell
 * @property {number} x
 * @property {number} y
 * @property {boolean} passable можно ли войти
 * @property {number} moveCost 1 или 2; 2 — труднопроходимая местность
 * @property {string} surface значение из SURFACES
 * @property {string|null} hazardId ссылка на persistent-hazards
 * @property {string} material значение из MATERIALS
 * @property {number} elevation шаг 5 футов
 * @property {string} zone id зоны, пустая строка если зоны нет
 * @property {number} variant детерминированный выбор варианта тайла
 * @property {boolean} revealed
 */

/**
 * @typedef {object} TacticalLayers
 * @property {Uint8Array} present битсет: клетка существует
 * @property {Uint8Array} passable битсет
 * @property {Uint8Array} revealed битсет
 * @property {Uint8Array} moveCost
 * @property {Uint8Array} surface код в SURFACES
 * @property {Uint8Array} material код в MATERIALS
 * @property {Uint8Array} variant
 * @property {Int8Array} elevation
 * @property {Uint8Array} zoneId индекс в zones[] со сдвигом на единицу; 0 — зоны нет
 */

/** @typedef {'e'|'s'} EdgeDirection */

/**
 * @typedef {object} TacticalEdge
 * @property {number} x координата клетки-владельца ребра
 * @property {number} y
 * @property {EdgeDirection} dir
 * @property {string} kind значение из EDGE_KINDS, в хранилище никогда не 'none'
 * @property {boolean} blocksMove
 * @property {boolean} blocksSight
 * @property {string} cover значение из COVER_LEVELS
 * @property {string|null} doorId
 */

/**
 * @typedef {object} TacticalDoor
 * @property {string} id
 * @property {number} x ребро, на котором стоит дверь: клетка-владелец
 * @property {number} y
 * @property {EdgeDirection} dir
 * @property {string} state значение из DOOR_STATES; это НАЧАЛЬНОЕ состояние
 * @property {number} lockDc
 * @property {string|null} keyItemId
 */

/**
 * @typedef {object} TacticalProp
 * @property {string} id
 * @property {string} assetId
 * @property {number} x дробная координата в клетках
 * @property {number} y
 * @property {number} rotation градусы
 * @property {number} scale
 * @property {Array<{x: number, y: number}>} footprint занимаемые клетки, может быть пустым
 * @property {number} zOrder
 * @property {boolean} blocksMove
 * @property {boolean} blocksSight
 * @property {string} cover
 * @property {boolean} destructible
 * @property {number} hp
 * @property {boolean} interactive
 * @property {string} state
 */

/**
 * @typedef {object} TacticalZone
 * @property {string} id
 * @property {string} kind значение из ZONE_KINDS
 * @property {string} material
 * @property {string} lightLevel
 * @property {string} floorDirection значение из FLOOR_DIRECTIONS
 * @property {string} label
 */

/**
 * @typedef {object} TacticalSpawnPoint
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {string} role значение из SPAWN_ROLES
 */

/**
 * @typedef {object} TacticalBounds
 * @property {number} minX
 * @property {number} minY
 * @property {number} maxX
 * @property {number} maxY
 */

/**
 * @typedef {object} TacticalMap
 * @property {string} version
 * @property {string} locationId
 * @property {string} seed
 * @property {{id: string, version: string}} generator
 * @property {number} width
 * @property {number} height
 * @property {TacticalBounds} bounds охват существующих клеток
 * @property {TacticalLayers} layers
 * @property {Record<string, string>} hazards индекс клетки → hazardId
 * @property {Record<string, TacticalEdge>} edges только непустые рёбра
 * @property {TacticalDoor[]} doors
 * @property {TacticalProp[]} props
 * @property {TacticalZone[]} zones
 * @property {TacticalSpawnPoint[]} spawnPoints
 * @property {TacticalBounds|null} combatBounds
 * @property {string} theme
 * @property {string} tilesetId
 * @property {{compass: boolean, scaleBar: boolean, roomLabels: Array<{zoneId: string, label: string}>}} overlays
 * @property {string} sizeClass ключ SIZE_CLASSES
 * @property {string[]} legacyShape какие необязательные поля несли исходные клетки
 */

/**
 * @typedef {object} ValidationIssue
 * @property {string} code
 * @property {string} message
 * @property {string} [at]
 */

// --- битсеты -------------------------------------------------------------

/**
 * @param {number} length
 * @returns {Uint8Array}
 */
function allocateBitset(length) {
  return new Uint8Array(Math.ceil(length / 8))
}

/**
 * @param {Uint8Array} bits
 * @param {number} index
 * @returns {boolean}
 */
function bitAt(bits, index) {
  return (bits[index >> 3] & (1 << (index & 7))) !== 0
}

/**
 * @param {Uint8Array} bits
 * @param {number} index
 * @param {boolean} value
 */
function setBitAt(bits, index, value) {
  if (value) bits[index >> 3] |= 1 << (index & 7)
  else bits[index >> 3] &= ~(1 << (index & 7)) & 0xff
}

// --- создание ------------------------------------------------------------

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number}
 */
function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback
}

/**
 * @param {unknown} value
 * @param {number} maximum
 * @param {string} fallback
 * @returns {string}
 */
function boundedText(value, maximum, fallback = '') {
  if (typeof value !== 'string') return fallback
  const result = value.trim().slice(0, maximum)
  return result || fallback
}

/**
 * Выбирает наименьший класс размера, в который помещается карта.
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
export function sizeClassFor(width, height) {
  const cells = width * height
  for (const [name, limits] of Object.entries(SIZE_CLASSES)) {
    if (width <= limits.maxWidth && height <= limits.maxHeight && cells <= limits.maxCells) return name
  }
  return 'region'
}

/**
 * Создаёт пустую карту заданного размера. По умолчанию клеток нет ни одной:
 * форма карты набирается вызовами `setCell`, поэтому непрямоугольный контур
 * выражается сам собой.
 *
 * @param {object} options
 * @param {number} options.width
 * @param {number} options.height
 * @param {string} [options.locationId]
 * @param {string} [options.seed]
 * @param {{id: string, version: string}} [options.generator]
 * @param {string} [options.theme]
 * @param {string} [options.tilesetId]
 * @param {string} [options.sizeClass]
 * @param {Partial<TacticalCell>} [options.fill] если задано, все координаты становятся существующими клетками с этими значениями
 * @returns {TacticalMap}
 */
export function createTacticalMap({
  width,
  height,
  locationId = '',
  seed = '',
  generator = { id: 'manual', version: '1' },
  theme = '',
  tilesetId = '',
  sizeClass = '',
  fill,
} = /** @type {any} */ ({})) {
  const safeWidth = boundedInteger(width, 1, 1, SIZE_CLASSES.region.maxWidth)
  const safeHeight = boundedInteger(height, 1, 1, SIZE_CLASSES.region.maxHeight)
  const length = safeWidth * safeHeight
  /** @type {TacticalMap} */
  const map = {
    version: TACTICAL_MAP_VERSION,
    locationId: boundedText(locationId, 120),
    seed: boundedText(seed, 200),
    generator: {
      id: boundedText(generator?.id, 60, 'manual'),
      version: boundedText(generator?.version, 20, '1'),
    },
    width: safeWidth,
    height: safeHeight,
    bounds: { minX: 0, minY: 0, maxX: -1, maxY: -1 },
    layers: {
      present: allocateBitset(length),
      passable: allocateBitset(length),
      revealed: allocateBitset(length),
      moveCost: new Uint8Array(length),
      surface: new Uint8Array(length),
      material: new Uint8Array(length),
      variant: new Uint8Array(length),
      elevation: new Int8Array(length),
      zoneId: new Uint8Array(length),
    },
    hazards: {},
    edges: {},
    doors: [],
    props: [],
    zones: [],
    spawnPoints: [],
    combatBounds: null,
    theme: boundedText(theme, 60),
    tilesetId: boundedText(tilesetId, 60),
    overlays: { compass: false, scaleBar: false, roomLabels: [] },
    sizeClass: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (sizeClass)]
      ? sizeClass
      : sizeClassFor(safeWidth, safeHeight),
    legacyShape: [...LEGACY_OPTIONAL_FIELDS],
  }
  map.layers.moveCost.fill(1)
  if (fill) {
    for (let y = 0; y < safeHeight; y += 1) {
      for (let x = 0; x < safeWidth; x += 1) setCell(map, x, y, fill)
    }
  }
  return map
}

// --- аксессоры клеток ----------------------------------------------------

/**
 * @param {TacticalMap} map
 * @param {number} x
 * @param {number} y
 * @returns {number} -1 для координат вне сетки
 */
export function cellIndex(map, x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return -1
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return -1
  return y * map.width + x
}

/**
 * @param {TacticalMap} map
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function cellExists(map, x, y) {
  const index = cellIndex(map, x, y)
  return index >= 0 && bitAt(map.layers.present, index)
}

/**
 * Логическое представление клетки. Весь остальной код работает именно с ним и
 * о слоях не знает.
 *
 * @param {TacticalMap} map
 * @param {number} x
 * @param {number} y
 * @returns {TacticalCell|null} null, если клетки нет — это единственный способ
 *   отличить «клетки нет» от «клетка есть, но она стена»
 */
export function cellAt(map, x, y) {
  const index = cellIndex(map, x, y)
  if (index < 0 || !bitAt(map.layers.present, index)) return null
  const zoneCode = map.layers.zoneId[index]
  return {
    x,
    y,
    passable: bitAt(map.layers.passable, index),
    moveCost: map.layers.moveCost[index] || 1,
    surface: SURFACES[map.layers.surface[index]] ?? 'none',
    hazardId: Object.prototype.hasOwnProperty.call(map.hazards, String(index)) ? map.hazards[String(index)] : null,
    material: MATERIALS[map.layers.material[index]] ?? 'stone',
    elevation: map.layers.elevation[index],
    zone: zoneCode > 0 ? (map.zones[zoneCode - 1]?.id ?? '') : '',
    variant: map.layers.variant[index],
    revealed: bitAt(map.layers.revealed, index),
  }
}

/**
 * Частичное обновление клетки. Клетка становится существующей: карта набирает
 * форму именно этим вызовом.
 *
 * @param {TacticalMap} map
 * @param {number} x
 * @param {number} y
 * @param {Partial<TacticalCell>} patch
 */
export function setCell(map, x, y, patch) {
  const index = cellIndex(map, x, y)
  if (index < 0) throw new TacticalMapError(`Клетка ${x},${y} вне границ карты`, 'CELL_OUT_OF_BOUNDS')
  const layers = map.layers
  const fresh = !bitAt(layers.present, index)
  setBitAt(layers.present, index, true)
  if (fresh) layers.moveCost[index] = 1
  if (patch.passable !== undefined) setBitAt(layers.passable, index, patch.passable === true)
  if (patch.revealed !== undefined) setBitAt(layers.revealed, index, patch.revealed === true)
  if (patch.moveCost !== undefined) {
    const cost = Number(patch.moveCost)
    if (cost !== 1 && cost !== 2) throw new TacticalMapError('moveCost допускает только 1 или 2', 'MOVE_COST_NOT_ALLOWED')
    layers.moveCost[index] = cost
  }
  if (patch.surface !== undefined) layers.surface[index] = enumCode(SURFACES, patch.surface, 'surface')
  if (patch.material !== undefined) layers.material[index] = enumCode(MATERIALS, patch.material, 'material')
  if (patch.variant !== undefined) layers.variant[index] = boundedInteger(patch.variant, 0, 0, 255)
  if (patch.elevation !== undefined) layers.elevation[index] = boundedInteger(patch.elevation, 0, -128, 127)
  if (patch.zone !== undefined) {
    const zone = String(patch.zone ?? '')
    if (!zone) layers.zoneId[index] = 0
    else {
      const zoneIndex = map.zones.findIndex((entry) => entry.id === zone)
      if (zoneIndex < 0) throw new TacticalMapError(`Зона ${zone} не объявлена в карте`, 'ZONE_NOT_FOUND')
      layers.zoneId[index] = zoneIndex + 1
    }
  }
  if (patch.hazardId !== undefined) {
    const hazard = patch.hazardId == null ? '' : String(patch.hazardId)
    if (hazard) map.hazards[String(index)] = hazard
    else delete map.hazards[String(index)]
  }
  if (fresh) expandBounds(map, x, y)
}

/**
 * @param {readonly string[]} table
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function enumCode(table, value, label) {
  const code = table.indexOf(String(value))
  if (code < 0) throw new TacticalMapError(`Недопустимое значение ${label}: ${String(value)}`, 'ENUM_VALUE_NOT_ALLOWED')
  return code
}

/**
 * @param {TacticalMap} map
 * @param {number} x
 * @param {number} y
 */
function expandBounds(map, x, y) {
  const bounds = map.bounds
  if (bounds.maxX < bounds.minX) {
    map.bounds = { minX: x, minY: y, maxX: x, maxY: y }
    return
  }
  bounds.minX = Math.min(bounds.minX, x)
  bounds.minY = Math.min(bounds.minY, y)
  bounds.maxX = Math.max(bounds.maxX, x)
  bounds.maxY = Math.max(bounds.maxY, y)
}

/**
 * Пересчитывает охват существующих клеток заново. Нужен после массовых правок
 * слоёв и при десериализации.
 * @param {TacticalMap} map
 */
export function recomputeBounds(map) {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (!bitAt(map.layers.present, y * map.width + x)) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  map.bounds = Number.isFinite(minX)
    ? { minX, minY, maxX, maxY }
    : { minX: 0, minY: 0, maxX: -1, maxY: -1 }
  return map.bounds
}

/**
 * Обходит все существующие клетки в порядке y, затем x.
 * @param {TacticalMap} map
 * @param {(cell: TacticalCell) => void} visit
 */
export function forEachCell(map, visit) {
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell) visit(cell)
    }
  }
}

/**
 * @param {TacticalMap} map
 * @returns {number}
 */
export function cellCount(map) {
  let total = 0
  const length = map.width * map.height
  for (let index = 0; index < length; index += 1) if (bitAt(map.layers.present, index)) total += 1
  return total
}

// --- рёбра ---------------------------------------------------------------

/**
 * Канонизация ребра: каждое ребро принадлежит клетке с меньшим индексом и
 * смотрит на восток или на юг. Без этого одно и то же ребро получило бы два
 * ключа.
 *
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @returns {{x: number, y: number, dir: EdgeDirection}}
 */
export function canonicalEdge(ax, ay, bx, by) {
  if (ay === by && bx === ax + 1) return { x: ax, y: ay, dir: 'e' }
  if (ay === by && bx === ax - 1) return { x: bx, y: by, dir: 'e' }
  if (ax === bx && by === ay + 1) return { x: ax, y: ay, dir: 's' }
  if (ax === bx && by === ay - 1) return { x: bx, y: by, dir: 's' }
  throw new TacticalMapError(
    `Клетки ${ax},${ay} и ${bx},${by} не соседние — ребра между ними не существует`,
    'EDGE_CELLS_NOT_ADJACENT',
  )
}

/**
 * @param {number} x
 * @param {number} y
 * @param {EdgeDirection} dir
 * @returns {string}
 */
function edgeKey(x, y, dir) {
  return `${x},${y},${dir}`
}

/**
 * Вторая клетка ребра — та, на которую ребро смотрит.
 * @param {{x: number, y: number, dir: EdgeDirection}} edge
 * @returns {{x: number, y: number}}
 */
export function edgeNeighbor(edge) {
  return edge.dir === 'e' ? { x: edge.x + 1, y: edge.y } : { x: edge.x, y: edge.y + 1 }
}

/**
 * @param {TacticalMap} map
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @returns {TacticalEdge|null}
 */
export function edgeBetween(map, ax, ay, bx, by) {
  const canonical = canonicalEdge(ax, ay, bx, by)
  return map.edges[edgeKey(canonical.x, canonical.y, canonical.dir)] ?? null
}

/**
 * Записывает ребро. `kind: 'none'` удаляет запись — пустые рёбра не хранятся.
 *
 * @param {TacticalMap} map
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {Partial<TacticalEdge>} edge
 * @returns {TacticalEdge|null}
 */
export function setEdge(map, ax, ay, bx, by, edge) {
  const canonical = canonicalEdge(ax, ay, bx, by)
  const key = edgeKey(canonical.x, canonical.y, canonical.dir)
  const kind = String(edge.kind ?? 'wall')
  if (!EDGE_KINDS.includes(kind)) {
    throw new TacticalMapError(`Недопустимый тип ребра: ${kind}`, 'EDGE_KIND_NOT_ALLOWED')
  }
  if (kind === 'none') {
    delete map.edges[key]
    return null
  }
  const defaultCover = kind === 'loophole' ? 'three_quarters' : kind === 'grate' ? 'half' : 'none'
  const cover = String(edge.cover ?? defaultCover)
  if (!COVER_LEVELS.includes(cover)) {
    throw new TacticalMapError(`Недопустимое укрытие: ${cover}`, 'COVER_NOT_ALLOWED')
  }
  /** @type {TacticalEdge} */
  const record = {
    x: canonical.x,
    y: canonical.y,
    dir: canonical.dir,
    kind,
    blocksMove: edge.blocksMove !== undefined ? edge.blocksMove === true : ['wall', 'loophole', 'grate'].includes(kind),
    blocksSight: edge.blocksSight !== undefined ? edge.blocksSight === true : kind === 'wall',
    cover,
    doorId: edge.doorId == null ? null : String(edge.doorId),
  }
  map.edges[key] = record
  return record
}

/**
 * Рёбра в детерминированном порядке: y, затем x, затем направление.
 * @param {TacticalMap} map
 * @returns {TacticalEdge[]}
 */
export function edgeList(map) {
  return Object.values(map.edges).sort((left, right) => (
    left.y - right.y || left.x - right.x || (left.dir === right.dir ? 0 : left.dir === 'e' ? -1 : 1)
  ))
}

// --- двери, предметы, зоны ----------------------------------------------

/**
 * Ставит дверь и приводит ребро под ней в согласованный вид. Двух источников
 * истины про дверь быть не должно, поэтому ребро правится здесь же.
 *
 * @param {TacticalMap} map
 * @param {object} door
 * @param {string} door.id
 * @param {number} door.x
 * @param {number} door.y
 * @param {EdgeDirection} door.dir
 * @param {string} [door.state]
 * @param {number} [door.lockDc]
 * @param {string|null} [door.keyItemId]
 * @param {boolean} [door.blocksMove]
 * @param {boolean} [door.blocksSight]
 * @returns {TacticalDoor}
 */
export function setDoor(map, door) {
  const state = String(door.state ?? 'closed')
  if (!DOOR_STATES.includes(state)) throw new TacticalMapError(`Недопустимое состояние двери: ${state}`, 'DOOR_STATE_NOT_ALLOWED')
  const id = boundedText(door.id, 120)
  if (!id) throw new TacticalMapError('У двери должен быть идентификатор', 'DOOR_ID_REQUIRED')
  /** @type {TacticalDoor} */
  const record = {
    id,
    x: door.x,
    y: door.y,
    dir: door.dir,
    state,
    lockDc: boundedInteger(door.lockDc, 0, 0, 40),
    keyItemId: door.keyItemId == null ? null : String(door.keyItemId),
  }
  const existing = map.doors.findIndex((entry) => entry.id === id)
  if (existing >= 0) map.doors[existing] = record
  else map.doors.push(record)
  const neighbor = edgeNeighbor(record)
  setEdge(map, record.x, record.y, neighbor.x, neighbor.y, {
    kind: 'door',
    blocksMove: door.blocksMove === true,
    blocksSight: door.blocksSight === true,
    cover: 'none',
    doorId: id,
  })
  return record
}

/**
 * @param {TacticalMap} map
 * @param {Partial<TacticalProp> & {id: string, assetId: string, x: number, y: number}} prop
 * @returns {TacticalProp}
 */
export function addProp(map, prop) {
  const cover = String(prop.cover ?? 'none')
  if (!COVER_LEVELS.includes(cover)) throw new TacticalMapError(`Недопустимое укрытие предмета: ${cover}`, 'COVER_NOT_ALLOWED')
  /** @type {TacticalProp} */
  const record = {
    id: boundedText(prop.id, 120),
    assetId: boundedText(prop.assetId, 120),
    x: Number(prop.x),
    y: Number(prop.y),
    rotation: Number.isFinite(Number(prop.rotation)) ? Number(prop.rotation) : 0,
    scale: Number.isFinite(Number(prop.scale)) && Number(prop.scale) > 0 ? Number(prop.scale) : 1,
    footprint: (Array.isArray(prop.footprint) ? prop.footprint : []).map((cell) => ({
      x: boundedInteger(cell?.x, 0, -1_000, 1_000),
      y: boundedInteger(cell?.y, 0, -1_000, 1_000),
    })),
    zOrder: boundedInteger(prop.zOrder, 0, -1_000, 1_000),
    blocksMove: prop.blocksMove === true,
    blocksSight: prop.blocksSight === true,
    cover,
    destructible: prop.destructible === true,
    hp: boundedInteger(prop.hp, 0, 0, 1_000),
    interactive: prop.interactive === true,
    state: boundedText(prop.state, 40),
  }
  if (!record.id) throw new TacticalMapError('У предмета должен быть идентификатор', 'PROP_ID_REQUIRED')
  map.props.push(record)
  return record
}

/**
 * @param {TacticalMap} map
 * @param {Partial<TacticalZone> & {id: string}} zone
 * @returns {TacticalZone}
 */
export function addZone(map, zone) {
  const kind = String(zone.kind ?? 'interior')
  if (!ZONE_KINDS.includes(kind)) throw new TacticalMapError(`Недопустимый вид зоны: ${kind}`, 'ZONE_KIND_NOT_ALLOWED')
  if (map.zones.length >= 254) throw new TacticalMapError('Слой зон вмещает не больше 254 зон', 'ZONE_BUDGET_EXCEEDED')
  /** @type {TacticalZone} */
  const record = {
    id: boundedText(zone.id, 120),
    kind,
    material: MATERIALS.includes(String(zone.material)) ? String(zone.material) : 'stone',
    lightLevel: boundedText(zone.lightLevel, 40, 'bright'),
    floorDirection: FLOOR_DIRECTIONS.includes(String(zone.floorDirection)) ? String(zone.floorDirection) : 'horizontal',
    label: boundedText(zone.label, 120),
  }
  if (!record.id) throw new TacticalMapError('У зоны должен быть идентификатор', 'ZONE_ID_REQUIRED')
  map.zones.push(record)
  return record
}

/**
 * @param {TacticalMap} map
 * @param {Partial<TacticalSpawnPoint> & {id: string, x: number, y: number}} point
 * @returns {TacticalSpawnPoint}
 */
export function addSpawnPoint(map, point) {
  const role = String(point.role ?? 'party')
  if (!SPAWN_ROLES.includes(role)) throw new TacticalMapError(`Недопустимая роль точки появления: ${role}`, 'SPAWN_ROLE_NOT_ALLOWED')
  /** @type {TacticalSpawnPoint} */
  const record = {
    id: boundedText(point.id, 120),
    x: boundedInteger(point.x, 0, 0, SIZE_CLASSES.region.maxWidth),
    y: boundedInteger(point.y, 0, 0, SIZE_CLASSES.region.maxHeight),
    role,
  }
  if (!record.id) throw new TacticalMapError('У точки появления должен быть идентификатор', 'SPAWN_ID_REQUIRED')
  map.spawnPoints.push(record)
  return record
}

// --- обход ---------------------------------------------------------------

/**
 * Ортогональный обход по проходимым клеткам с учётом рёбер. Открытая и выбитая
 * дверь не мешает; закрытая и запертая перекрывают проход по `blocksMove`
 * своего ребра.
 *
 * @param {TacticalMap} map
 * @param {number} fromX
 * @param {number} fromY
 * @param {{throughDoors?: boolean}} [options]
 * @returns {Set<string>} ключи вида "x,y"
 */
export function reachableCells(map, fromX, fromY, { throughDoors = true } = {}) {
  /** @type {Set<string>} */
  const reached = new Set()
  const start = cellAt(map, fromX, fromY)
  if (!start || !start.passable) return reached
  const doorState = new Map(map.doors.map((door) => [door.id, door.state]))
  /** @type {Array<{x: number, y: number}>} */
  const queue = [{ x: fromX, y: fromY }]
  reached.add(`${fromX},${fromY}`)
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nextX = current.x + dx
      const nextY = current.y + dy
      const key = `${nextX},${nextY}`
      if (reached.has(key)) continue
      const next = cellAt(map, nextX, nextY)
      if (!next || !next.passable) continue
      if (edgeBlocksMove(map, current.x, current.y, nextX, nextY, doorState, throughDoors)) continue
      reached.add(key)
      queue.push({ x: nextX, y: nextY })
    }
  }
  return reached
}

/**
 * Мешает ли полотно двери шагнуть между двумя соседними клетками **прямо
 * сейчас**. Ответ словом, а не признаком: движку нужно объяснить игроку, что
 * именно случилось, и «закрыта» отличается от «заперта».
 *
 * Отличие от `reachableCells`: та отвечает на вопрос «дойдёт ли отряд когда-
 * нибудь» и закрытую дверь считает проходимой — её ведь можно открыть. Здесь
 * вопрос другой, поэтому и правило другое.
 *
 * Спрашивается **только дверь**. Стены на рёбрах движению по-прежнему не
 * мешают: проходимость считается по клетке, и это отдельная незакрытая задача.
 * Смешивать их здесь нельзя — рёбра со стенами строятся вокруг каждой
 * непроходимой клетки, и существо, оказавшееся на такой клетке (герой в воде),
 * не смогло бы с неё сойти.
 *
 * Полотно двери и стена вокруг него — разные вещи. `edge.blocksMove` описывает
 * стену: у проёма между двумя проходимыми клетками он ложен, и по нему нельзя
 * судить о самой двери.
 *
 * @param {TacticalMap} map
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @returns {'closed'|'locked'|null} null — дверь не мешает
 */
export function doorBlocksStep(map, ax, ay, bx, by) {
  const edge = edgeBetween(map, ax, ay, bx, by)
  if (!edge || edge.kind !== 'door') return null
  const door = edge.doorId ? map.doors.find((entry) => entry.id === edge.doorId) : null
  const state = String(door?.state ?? 'closed')
  if (state === 'open' || state === 'broken') return null
  return state === 'locked' ? 'locked' : 'closed'
}

/**
 * Дверь по её клетке-владельцу и направлению ребра.
 *
 * @param {TacticalMap} map
 * @param {string} doorId
 * @returns {TacticalDoor|null}
 */
export function doorById(map, doorId) {
  const id = String(doorId ?? '')
  return map.doors.find((entry) => entry.id === id) ?? null
}

/**
 * На какое ребро вешать дверь в прорубленном проёме. Полотно обязано встать
 * поперёк прохода, иначе оно ничего не перекрывает: дверь на глухом ребре —
 * украшение, а отряд обходит её по соседней клетке.
 *
 * Сначала ищется ось, по которой проход идёт насквозь — обе противоположные
 * клетки проходимы. Если насквозь не выходит (проём в тупике или у края),
 * берётся любой проходимый сосед. Владельцем ребра всегда является верхняя или
 * левая из двух клеток, поэтому для запада и севера владелец — сам сосед.
 *
 * @param {TacticalMap} map
 * @param {number} x
 * @param {number} y
 * @returns {{x: number, y: number, dir: EdgeDirection}|null}
 */
export function doorwayEdgeAt(map, x, y) {
  /** @param {number} cx @param {number} cy */
  const passable = (cx, cy) => cellAt(map, cx, cy)?.passable === true
  if (passable(x - 1, y) && passable(x + 1, y)) return { x, y, dir: 'e' }
  if (passable(x, y - 1) && passable(x, y + 1)) return { x, y, dir: 's' }
  if (passable(x + 1, y)) return { x, y, dir: 'e' }
  if (passable(x - 1, y)) return { x: x - 1, y, dir: 'e' }
  if (passable(x, y + 1)) return { x, y, dir: 's' }
  if (passable(x, y - 1)) return { x, y: y - 1, dir: 's' }
  return null
}

/**
 * Двери, к которым можно дотянуться из клетки: рукой достаётся дверь на любом
 * из четырёх её рёбер, с любой стороны полотна.
 *
 * @param {TacticalMap} map
 * @param {number} x
 * @param {number} y
 * @returns {TacticalDoor[]}
 */
export function doorsReachableFrom(map, x, y) {
  return map.doors.filter((door) => {
    const neighbor = edgeNeighbor(door)
    return (door.x === x && door.y === y) || (neighbor.x === x && neighbor.y === y)
  })
}

/**
 * @param {TacticalMap} map
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {Map<string, string>} doorState
 * @param {boolean} throughDoors
 * @returns {boolean}
 */
function edgeBlocksMove(map, ax, ay, bx, by, doorState, throughDoors) {
  const edge = edgeBetween(map, ax, ay, bx, by)
  if (!edge) return false
  if (edge.kind === 'door') {
    if (!throughDoors) return true
    const state = edge.doorId ? doorState.get(edge.doorId) : undefined
    if (state === 'open' || state === 'broken') return false
  }
  return edge.blocksMove
}

// --- сериализация --------------------------------------------------------

/**
 * Однородный слой хранится одним числом, а не строкой base64. В реальном
 * интерьере однородны сразу несколько слоёв — стоимость перемещения, высота,
 * зона, — и без этого карта 100×100 не укладывается в порог 100 КБ из плана.
 *
 * @param {Uint8Array|Int8Array} array
 * @returns {string|number}
 */
function encodeLayer(array) {
  const first = array[0]
  let uniform = true
  for (let index = 1; index < array.length; index += 1) {
    if (array[index] !== first) { uniform = false; break }
  }
  if (uniform) return array.length ? first : 0
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64')
}

/**
 * @param {unknown} value
 * @param {number} expectedLength
 * @param {string} label
 * @returns {Uint8Array}
 */
function decodeUnsignedLayer(value, expectedLength, label) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    const filled = new Uint8Array(expectedLength)
    filled.fill(value & 0xff)
    return filled
  }
  if (typeof value !== 'string') throw new TacticalMapError(`Слой ${label} должен быть строкой base64 или числом`, 'LAYER_NOT_ENCODED')
  const bytes = Uint8Array.from(Buffer.from(value, 'base64'))
  if (bytes.length !== expectedLength) {
    throw new TacticalMapError(
      `Длина слоя ${label} равна ${bytes.length}, ожидалось ${expectedLength}`,
      'LAYER_LENGTH_MISMATCH',
    )
  }
  return bytes
}

/**
 * @param {unknown} value
 * @param {number} expectedLength
 * @param {string} label
 * @returns {Int8Array}
 */
function decodeSignedLayer(value, expectedLength, label) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    const filled = new Int8Array(expectedLength)
    filled.fill((value << 24) >> 24)
    return filled
  }
  const bytes = decodeUnsignedLayer(value, expectedLength, label)
  return Int8Array.from(bytes, (byte) => (byte << 24) >> 24)
}

/**
 * Рёбра пакуются в два массива вместо массива объектов: у карты 100×100 их
 * двадцать тысяч, и объектная запись стоит на порядок дороже упакованной.
 * Байт признаков: тип 0–2, blocksMove 3, blocksSight 4, укрытие 5–6,
 * направление 7.
 *
 * @param {TacticalMap} map
 * @returns {{cells: string, attrs: string, doors: Record<string, string>}}
 */
function encodeEdges(map) {
  const list = edgeList(map)
  const cells = new Uint8Array(list.length * 2)
  const attrs = new Uint8Array(list.length)
  /** @type {Record<string, string>} */
  const doors = {}
  for (let index = 0; index < list.length; index += 1) {
    const edge = list[index]
    const owner = edge.y * map.width + edge.x
    cells[index * 2] = owner & 0xff
    cells[index * 2 + 1] = (owner >> 8) & 0xff
    attrs[index] = (EDGE_KINDS.indexOf(edge.kind) & 0b111)
      | (edge.blocksMove ? 1 << 3 : 0)
      | (edge.blocksSight ? 1 << 4 : 0)
      | ((COVER_LEVELS.indexOf(edge.cover) & 0b11) << 5)
      | (edge.dir === 's' ? 1 << 7 : 0)
    if (edge.doorId) doors[String(index)] = edge.doorId
  }
  return {
    cells: Buffer.from(cells).toString('base64'),
    attrs: Buffer.from(attrs).toString('base64'),
    doors,
  }
}

/**
 * @param {TacticalMap} map
 * @param {unknown} value
 */
function decodeEdges(map, value) {
  if (!value || typeof value !== 'object') return
  const packed = /** @type {Record<string, any>} */ (value)
  // Совместимость: первая редакция писала рёбра массивом объектов.
  if (Array.isArray(packed)) {
    for (const edge of packed) {
      const neighbor = edgeNeighbor(edge)
      setEdge(map, edge.x, edge.y, neighbor.x, neighbor.y, edge)
    }
    return
  }
  const cells = Uint8Array.from(Buffer.from(String(packed.cells ?? ''), 'base64'))
  const attrs = Uint8Array.from(Buffer.from(String(packed.attrs ?? ''), 'base64'))
  if (cells.length !== attrs.length * 2) {
    throw new TacticalMapError('Упакованные рёбра повреждены: длины массивов не согласованы', 'EDGE_LAYER_LENGTH_MISMATCH')
  }
  const doors = packed.doors && typeof packed.doors === 'object' ? packed.doors : {}
  for (let index = 0; index < attrs.length; index += 1) {
    const owner = cells[index * 2] | (cells[index * 2 + 1] << 8)
    const x = owner % map.width
    const y = Math.floor(owner / map.width)
    const attribute = attrs[index]
    /** @type {EdgeDirection} */
    const dir = (attribute & (1 << 7)) ? 's' : 'e'
    const neighbor = edgeNeighbor({ x, y, dir })
    setEdge(map, x, y, neighbor.x, neighbor.y, {
      kind: EDGE_KINDS[attribute & 0b111] ?? 'wall',
      blocksMove: (attribute & (1 << 3)) !== 0,
      blocksSight: (attribute & (1 << 4)) !== 0,
      cover: COVER_LEVELS[(attribute >> 5) & 0b11] ?? 'none',
      doorId: typeof doors[String(index)] === 'string' ? doors[String(index)] : null,
    })
  }
}

/**
 * Предмет пишется без полей, равных значению по умолчанию. При чтении их
 * восстанавливает `addProp`, поэтому потери нет, а объём падает вчетверо:
 * на карте класса `region` предметов до двух тысяч, и полная запись каждого
 * съедала бы весь бюджет размера.
 *
 * @param {TacticalProp} prop
 * @returns {Record<string, unknown>}
 */
function compactProp(prop) {
  /** @type {Record<string, unknown>} */
  const result = { id: prop.id, assetId: prop.assetId, x: prop.x, y: prop.y }
  if (prop.rotation !== 0) result.rotation = prop.rotation
  if (prop.scale !== 1) result.scale = prop.scale
  if (prop.footprint.length) result.footprint = prop.footprint.map((cell) => ({ ...cell }))
  if (prop.zOrder !== 0) result.zOrder = prop.zOrder
  if (prop.blocksMove) result.blocksMove = true
  if (prop.blocksSight) result.blocksSight = true
  if (prop.cover !== 'none') result.cover = prop.cover
  if (prop.destructible) result.destructible = true
  if (prop.hp !== 0) result.hp = prop.hp
  if (prop.interactive) result.interactive = true
  if (prop.state) result.state = prop.state
  return result
}

/**
 * Простой объект, пригодный для JSON и для снимка состояния.
 * @param {TacticalMap} map
 * @returns {Record<string, unknown>}
 */
export function serializeTacticalMap(map) {
  return {
    version: map.version,
    locationId: map.locationId,
    seed: map.seed,
    generator: { id: map.generator.id, version: map.generator.version },
    width: map.width,
    height: map.height,
    bounds: { ...map.bounds },
    layers: {
      present: encodeLayer(map.layers.present),
      passable: encodeLayer(map.layers.passable),
      revealed: encodeLayer(map.layers.revealed),
      moveCost: encodeLayer(map.layers.moveCost),
      surface: encodeLayer(map.layers.surface),
      material: encodeLayer(map.layers.material),
      variant: encodeLayer(map.layers.variant),
      elevation: encodeLayer(map.layers.elevation),
      zoneId: encodeLayer(map.layers.zoneId),
    },
    hazards: { ...map.hazards },
    edges: encodeEdges(map),
    doors: map.doors.map((door) => ({ ...door })),
    props: map.props.map(compactProp),
    zones: map.zones.map((zone) => ({ ...zone })),
    spawnPoints: map.spawnPoints.map((point) => ({ ...point })),
    combatBounds: map.combatBounds ? { ...map.combatBounds } : null,
    theme: map.theme,
    tilesetId: map.tilesetId,
    overlays: {
      compass: map.overlays.compass,
      scaleBar: map.overlays.scaleBar,
      roomLabels: map.overlays.roomLabels.map((label) => ({ ...label })),
    },
    sizeClass: map.sizeClass,
    legacyShape: [...map.legacyShape],
  }
}

/**
 * @param {unknown} value
 * @returns {TacticalMap}
 */
export function deserializeTacticalMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TacticalMapError('Карта должна быть объектом', 'MAP_NOT_OBJECT')
  }
  const raw = /** @type {Record<string, any>} */ (value)
  const width = boundedInteger(raw.width, 0, 1, SIZE_CLASSES.region.maxWidth)
  const height = boundedInteger(raw.height, 0, 1, SIZE_CLASSES.region.maxHeight)
  const length = width * height
  const bitsetLength = Math.ceil(length / 8)
  const layers = raw.layers ?? {}
  /** @type {TacticalMap} */
  const map = {
    version: boundedText(raw.version, 60, TACTICAL_MAP_VERSION),
    locationId: boundedText(raw.locationId, 120),
    seed: boundedText(raw.seed, 200),
    generator: {
      id: boundedText(raw.generator?.id, 60, 'manual'),
      version: boundedText(raw.generator?.version, 20, '1'),
    },
    width,
    height,
    bounds: { minX: 0, minY: 0, maxX: -1, maxY: -1 },
    layers: {
      present: decodeUnsignedLayer(layers.present, bitsetLength, 'present'),
      passable: decodeUnsignedLayer(layers.passable, bitsetLength, 'passable'),
      revealed: decodeUnsignedLayer(layers.revealed, bitsetLength, 'revealed'),
      moveCost: decodeUnsignedLayer(layers.moveCost, length, 'moveCost'),
      surface: decodeUnsignedLayer(layers.surface, length, 'surface'),
      material: decodeUnsignedLayer(layers.material, length, 'material'),
      variant: decodeUnsignedLayer(layers.variant, length, 'variant'),
      elevation: decodeSignedLayer(layers.elevation, length, 'elevation'),
      zoneId: decodeUnsignedLayer(layers.zoneId, length, 'zoneId'),
    },
    hazards: {},
    edges: {},
    doors: [],
    props: [],
    zones: [],
    spawnPoints: [],
    combatBounds: null,
    theme: boundedText(raw.theme, 60),
    tilesetId: boundedText(raw.tilesetId, 60),
    overlays: { compass: raw.overlays?.compass === true, scaleBar: raw.overlays?.scaleBar === true, roomLabels: [] },
    sizeClass: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (raw.sizeClass)] ? String(raw.sizeClass) : sizeClassFor(width, height),
    legacyShape: Array.isArray(raw.legacyShape)
      ? LEGACY_OPTIONAL_FIELDS.filter((field) => raw.legacyShape.includes(field))
      : [...LEGACY_OPTIONAL_FIELDS],
  }
  for (const [index, hazard] of Object.entries(raw.hazards ?? {})) {
    if (typeof hazard === 'string' && hazard) map.hazards[String(index)] = hazard
  }
  for (const zone of Array.isArray(raw.zones) ? raw.zones : []) addZone(map, zone)
  decodeEdges(map, raw.edges)
  for (const door of Array.isArray(raw.doors) ? raw.doors : []) {
    const edge = map.edges[edgeKey(door.x, door.y, door.dir)]
    setDoor(map, { ...door, blocksMove: edge?.blocksMove === true, blocksSight: edge?.blocksSight === true })
  }
  for (const prop of Array.isArray(raw.props) ? raw.props : []) addProp(map, prop)
  for (const point of Array.isArray(raw.spawnPoints) ? raw.spawnPoints : []) addSpawnPoint(map, point)
  for (const label of Array.isArray(raw.overlays?.roomLabels) ? raw.overlays.roomLabels : []) {
    map.overlays.roomLabels.push({ zoneId: boundedText(label?.zoneId, 120), label: boundedText(label?.label, 120) })
  }
  if (raw.combatBounds) {
    map.combatBounds = {
      minX: boundedInteger(raw.combatBounds.minX, 0, -1_000, 1_000),
      minY: boundedInteger(raw.combatBounds.minY, 0, -1_000, 1_000),
      maxX: boundedInteger(raw.combatBounds.maxX, 0, -1_000, 1_000),
      maxY: boundedInteger(raw.combatBounds.maxY, 0, -1_000, 1_000),
    }
  }
  recomputeBounds(map)
  return map
}

/**
 * Детерминированная сериализация: ключи объектов отсортированы, массивы — в
 * каноническом порядке. Нужна только для хеша.
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(/** @type {Record<string, unknown>} */ (value)).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

/**
 * Хеш содержимого карты. Используется как ключ кэша рендера и как адрес карты
 * в хранилище.
 * @param {TacticalMap} map
 * @returns {string}
 */
export function tacticalMapHash(map) {
  return createHash('sha256').update(stableStringify(serializeTacticalMap(map))).digest('hex')
}

// --- валидация -----------------------------------------------------------

/**
 * Структурная валидация. Возвращает список замечаний, а не бросает: план
 * требует при отказе ослабить требования и повторить, а не останавливать игру.
 *
 * Проверки достижимости цели, ключей за запертой дверью и минимального
 * расстояния до героя здесь отсутствуют — они требуют графа зон и состояния
 * боя, это отдельный этап.
 *
 * @param {TacticalMap} map
 * @returns {{ok: boolean, errors: ValidationIssue[]}}
 */
export function validateTacticalMap(map) {
  /** @type {ValidationIssue[]} */
  const errors = []
  /** @param {string} code @param {string} message @param {string} [at] */
  const fail = (code, message, at) => errors.push(at ? { code, message, at } : { code, message })

  const length = map.width * map.height
  const bitsetLength = Math.ceil(length / 8)
  /** @type {Array<[string, {length: number}, number]>} */
  const expected = [
    ['present', map.layers.present, bitsetLength],
    ['passable', map.layers.passable, bitsetLength],
    ['revealed', map.layers.revealed, bitsetLength],
    ['moveCost', map.layers.moveCost, length],
    ['surface', map.layers.surface, length],
    ['material', map.layers.material, length],
    ['variant', map.layers.variant, length],
    ['elevation', map.layers.elevation, length],
    ['zoneId', map.layers.zoneId, length],
  ]
  for (const [name, layer, size] of expected) {
    if (layer.length !== size) fail('LAYER_LENGTH_MISMATCH', `Слой ${name}: длина ${layer.length}, ожидалось ${size}`, name)
  }

  for (let index = 0; index < length; index += 1) {
    if (!bitAt(map.layers.present, index)) continue
    if (map.layers.surface[index] >= SURFACES.length) fail('ENUM_CODE_OUT_OF_RANGE', `surface вне перечисления в клетке ${index}`, String(index))
    if (map.layers.material[index] >= MATERIALS.length) fail('ENUM_CODE_OUT_OF_RANGE', `material вне перечисления в клетке ${index}`, String(index))
    if (map.layers.zoneId[index] > map.zones.length) fail('ENUM_CODE_OUT_OF_RANGE', `zoneId вне перечисления в клетке ${index}`, String(index))
    const cost = map.layers.moveCost[index]
    if (cost !== 1 && cost !== 2) fail('MOVE_COST_NOT_ALLOWED', `moveCost=${cost} в клетке ${index}`, String(index))
  }

  const actualBounds = { ...map.bounds }
  recomputeBounds(map)
  const recomputed = map.bounds
  map.bounds = actualBounds
  if (actualBounds.minX !== recomputed.minX || actualBounds.minY !== recomputed.minY
    || actualBounds.maxX !== recomputed.maxX || actualBounds.maxY !== recomputed.maxY) {
    fail('BOUNDS_MISMATCH', 'bounds не совпадает с фактическим охватом слоя present')
  }

  /** @type {Set<string>} */
  const doorIds = new Set()
  for (const door of map.doors) {
    if (doorIds.has(door.id)) fail('DOOR_ID_NOT_UNIQUE', `Дверь ${door.id} объявлена дважды`, door.id)
    doorIds.add(door.id)
    const edge = map.edges[edgeKey(door.x, door.y, door.dir)]
    if (!edge) fail('DOOR_EDGE_MISSING', `Дверь ${door.id} стоит на ребре, которого нет`, door.id)
    else if (edge.kind !== 'door') fail('DOOR_EDGE_KIND_MISMATCH', `Ребро под дверью ${door.id} имеет тип ${edge.kind}`, door.id)
  }
  for (const edge of edgeList(map)) {
    if (edge.doorId && !doorIds.has(edge.doorId)) {
      fail('EDGE_DOOR_ID_DANGLING', `Ребро ссылается на дверь ${edge.doorId}, которой нет`, edgeKey(edge.x, edge.y, edge.dir))
    }
  }

  /** @type {Map<string, string>} */
  const occupied = new Map()
  /** @type {Set<string>} */
  const propIds = new Set()
  for (const prop of map.props) {
    if (propIds.has(prop.id)) fail('PROP_ID_NOT_UNIQUE', `Предмет ${prop.id} объявлен дважды`, prop.id)
    propIds.add(prop.id)
    for (const cell of prop.footprint) {
      const key = `${cell.x},${cell.y}`
      const target = cellAt(map, cell.x, cell.y)
      if (!target) fail('PROP_FOOTPRINT_ON_MISSING_CELL', `Предмет ${prop.id} занимает несуществующую клетку ${key}`, prop.id)
      else if (!target.passable) fail('PROP_FOOTPRINT_ON_IMPASSABLE', `Предмет ${prop.id} занимает непроходимую клетку ${key}`, prop.id)
      const previous = occupied.get(key)
      if (previous) fail('PROP_FOOTPRINT_OVERLAP', `Предметы ${previous} и ${prop.id} занимают клетку ${key}`, prop.id)
      else occupied.set(key, prop.id)
    }
  }

  /** @type {Set<string>} */
  const zoneIds = new Set()
  for (const zone of map.zones) {
    if (zoneIds.has(zone.id)) fail('ZONE_ID_NOT_UNIQUE', `Зона ${zone.id} объявлена дважды`, zone.id)
    zoneIds.add(zone.id)
  }

  for (const point of map.spawnPoints) {
    const cell = cellAt(map, point.x, point.y)
    if (!cell || !cell.passable) {
      fail('SPAWN_POINT_IMPASSABLE', `Точка появления ${point.id} стоит на непроходимой клетке`, point.id)
    }
  }

  const limits = SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (map.sizeClass)] ?? SIZE_CLASSES.region
  if (length > limits.maxCells) fail('CELL_BUDGET_EXCEEDED', `Клеток ${length}, бюджет класса ${map.sizeClass} — ${limits.maxCells}`)
  if (map.props.length > limits.maxProps) fail('PROP_BUDGET_EXCEEDED', `Предметов ${map.props.length}, бюджет — ${limits.maxProps}`)
  const wallEdges = edgeList(map).filter((edge) => edge.kind === 'wall').length
  if (wallEdges > limits.maxWallEdges) fail('WALL_EDGE_BUDGET_EXCEEDED', `Рёбер со стенами ${wallEdges}, бюджет — ${limits.maxWallEdges}`)

  return { ok: errors.length === 0, errors }
}

// --- преобразование из старой формы и обратно ---------------------------

/**
 * @typedef {object} LegacyCell
 * @property {number} x
 * @property {number} y
 * @property {string} type 'floor' | 'wall' | 'water' | 'door'
 * @property {boolean} revealed
 * @property {string} [material]
 * @property {number} [variant]
 * @property {string} [pattern]
 * @property {string} [edge_mask]
 * @property {string} [feature]
 * @property {number} [elevation] высота площадки в футах; отсутствие означает уровень земли
 */

const LEGACY_WALKABLE = Object.freeze(['floor', 'door'])

/**
 * Превращает старый разреженный массив клеток в карту. Правила ровно те, что в
 * `docs/tactical-map-plan.md`, раздел 9.
 *
 * Осторожно с водой: сейчас проходимой считается только `floor` и `door`, то
 * есть вода непроходима. Преобразование обязано это сохранить, иначе изменится
 * проходимость уже сыгранных карт.
 *
 * @param {LegacyCell[]} cells
 * @param {object} [options]
 * @param {string} [options.locationId]
 * @param {string} [options.seed]
 * @param {{id: string, version: string}} [options.generator]
 * @param {string} [options.tilesetId]
 * @returns {TacticalMap}
 */
export function tacticalMapFromLegacyCells(cells, options = {}) {
  const source = (Array.isArray(cells) ? cells : []).filter((cell) => (
    cell && Number.isSafeInteger(Number(cell.x)) && Number.isSafeInteger(Number(cell.y))
    && Number(cell.x) >= 0 && Number(cell.y) >= 0
  ))
  let width = 0
  let height = 0
  for (const cell of source) {
    width = Math.max(width, Number(cell.x) + 1)
    height = Math.max(height, Number(cell.y) + 1)
  }
  /** @type {Set<string>} */
  const patterns = new Set()
  for (const cell of source) if (typeof cell.pattern === 'string' && cell.pattern) patterns.add(cell.pattern)
  const map = createTacticalMap({
    width: Math.max(1, width),
    height: Math.max(1, height),
    locationId: options.locationId ?? '',
    seed: options.seed ?? '',
    generator: options.generator ?? { id: 'dynamic-map', version: '1' },
    theme: patterns.size === 1 ? [...patterns][0] : '',
    tilesetId: options.tilesetId ?? '',
  })
  map.legacyShape = LEGACY_OPTIONAL_FIELDS.filter((field) => source.some((cell) => (
    Object.prototype.hasOwnProperty.call(cell, field) && /** @type {any} */ (cell)[field] != null
  )))

  /** @type {Map<string, LegacyCell>} */
  const byPosition = new Map()
  for (const cell of source) {
    const x = Number(cell.x)
    const y = Number(cell.y)
    byPosition.set(`${x},${y}`, cell)
    const type = String(cell.type ?? 'floor')
    setCell(map, x, y, {
      passable: LEGACY_WALKABLE.includes(type),
      surface: type === 'water' ? 'water' : 'none',
      material: MATERIALS.includes(String(cell.material)) ? String(cell.material) : 'stone',
      variant: boundedInteger(cell.variant, 0, 0, 255),
      revealed: cell.revealed === true,
      moveCost: 1,
      // Высота уже есть в модели тактической клетки; здесь она только не теряется
      // при переносе из legacy-представления, иначе обратное преобразование
      // разошлось бы на любой поднятой площадке.
      elevation: boundedInteger(cell.elevation, 0, -100, 100),
    })
  }

  // Стены: клетка-стена даёт ребро-стену на каждой границе с проходимым соседом.
  for (const cell of source) {
    const x = Number(cell.x)
    const y = Number(cell.y)
    const own = cellAt(map, x, y)
    if (!own || own.passable) continue
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const neighbor = cellAt(map, x + dx, y + dy)
      if (!neighbor || !neighbor.passable) continue
      setEdge(map, x, y, x + dx, y + dy, {
        kind: 'wall',
        blocksMove: true,
        blocksSight: true,
        // Полное перекрытие выражено через blocksSight; cover описывает стрельбу
        // мимо угла и потому берёт сильнейшее доступное значение.
        cover: 'three_quarters',
      })
    }
  }

  // Двери: старая дверь — это проходимая клетка. Чтобы обратное преобразование
  // однозначно её узнало, дверь ставится на ребро, ВЛАДЕЛЬЦЕМ которого является
  // сама клетка-дверь ('e' или 's'). Предпочитается сторона, за которой стена.
  let doorNumber = 0
  for (const cell of source) {
    if (String(cell.type) !== 'door') continue
    const x = Number(cell.x)
    const y = Number(cell.y)
    const east = cellAt(map, x + 1, y)
    const south = cellAt(map, x, y + 1)
    /** @type {EdgeDirection} */
    let dir = 'e'
    if (!east || east.passable) {
      if (!south || !south.passable) dir = 's'
    }
    const neighbor = dir === 'e' ? east : south
    doorNumber += 1
    setDoor(map, {
      id: `door-${x}-${y}`,
      x,
      y,
      dir,
      state: 'closed',
      blocksMove: !neighbor || !neighbor.passable,
      blocksSight: !neighbor || !neighbor.passable,
    })
  }
  void doorNumber

  // Декор: любое значение feature, кроме сущности, становится предметом в
  // центре клетки. 'enemy' отбрасывается — сущности живут в состоянии боя.
  for (const cell of source) {
    const feature = typeof cell.feature === 'string' ? cell.feature.trim() : ''
    if (!feature || feature === 'enemy') continue
    const x = Number(cell.x)
    const y = Number(cell.y)
    addProp(map, {
      id: `prop-${x}-${y}`,
      assetId: feature,
      x: x + 0.5,
      y: y + 0.5,
      rotation: 0,
      scale: 1,
      footprint: [{ x, y }],
      zOrder: 0,
    })
  }

  recomputeBounds(map)
  return map
}

/**
 * Обратное преобразование. Порядок ключей и порядок клеток повторяют выход
 * `generateDynamicSceneMap`, поэтому результат сравним с исходным массивом
 * побайтово.
 *
 * @param {TacticalMap} map
 * @returns {LegacyCell[]}
 */
export function legacyCellsFromTacticalMap(map) {
  /** @type {Set<string>} */
  const doorCells = new Set(map.doors.map((door) => `${door.x},${door.y}`))
  /** @type {Map<string, TacticalProp>} */
  const propByCell = new Map()
  for (const prop of map.props) {
    if (prop.footprint.length !== 1) continue
    const key = `${prop.footprint[0].x},${prop.footprint[0].y}`
    const previous = propByCell.get(key)
    if (!previous || prop.zOrder < previous.zOrder || (prop.zOrder === previous.zOrder && prop.id < previous.id)) {
      propByCell.set(key, prop)
    }
  }
  const pattern = LEGACY_PATTERNS.includes(map.theme) ? map.theme : ''
  const shape = new Set(Array.isArray(map.legacyShape) ? map.legacyShape : LEGACY_OPTIONAL_FIELDS)

  /** @type {LegacyCell[]} */
  const result = []
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (!cell) continue
      const key = `${x},${y}`
      const type = !cell.passable
        ? (cell.surface === 'water' ? 'water' : 'wall')
        : doorCells.has(key) ? 'door' : 'floor'
      /** @type {LegacyCell} */
      const legacy = { x, y, type, revealed: cell.revealed }
      if (shape.has('material')) legacy.material = cell.material
      if (shape.has('variant')) legacy.variant = cell.variant
      if (shape.has('pattern') && pattern) legacy.pattern = pattern
      // Высота переносится только когда она есть: плоские карты сохраняют
      // прежнюю форму клетки байт в байт.
      if (cell.elevation) legacy.elevation = cell.elevation
      const prop = propByCell.get(key)
      if (prop) legacy.feature = prop.assetId
      if (shape.has('edge_mask')) legacy.edge_mask = legacyEdgeMask(map, x, y)
      result.push(legacy)
    }
  }
  return result
}

/**
 * Подсказка о краях клетки. Производная величина: буква добавляется, если
 * соседа нет или текущая клетка проходима, а сосед — нет. Правило повторяет
 * `generateDynamicSceneMap`.
 *
 * @param {TacticalMap} map
 * @param {number} x
 * @param {number} y
 * @returns {string}
 */
export function legacyEdgeMask(map, x, y) {
  const own = cellAt(map, x, y)
  if (!own) return ''
  const edges = []
  /** @type {Array<[string, number, number]>} */
  const sides = [['n', x, y - 1], ['e', x + 1, y], ['s', x, y + 1], ['w', x - 1, y]]
  for (const [label, nx, ny] of sides) {
    const neighbor = cellAt(map, nx, ny)
    if (!neighbor || (own.passable && !neighbor.passable)) edges.push(label)
  }
  return edges.join('')
}

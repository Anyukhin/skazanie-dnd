/**
 * Детерминированный растризатор круговой области для клеточной сетки D&D 2014.
 *
 * Начало круга лежит на пересечении сетки. Клетка с координатами (x, y)
 * занимает прямоугольник [x, x + 1] × [y, y + 1]. Она входит в область,
 * когда круг покрывает не менее половины её площади.
 */

export const CIRCULAR_AREA_GEOMETRY_VERSION = 'circle-grid-v2'

const CELL_AREA = 1
const COVERAGE_THRESHOLD = 0.5
const EPSILON = 1e-9

// Rules Engine ограничивает радиусы заклинаний 600 футами. Запас до 128
// клеток оставляет API безопасным даже при ошибочном внешнем вводе.
const MAX_RADIUS_CELLS = 128
const MAX_GRID_COORDINATE = 1_000_000

/** @param {unknown} value @param {number} fallback */
function finiteNumber(value, fallback) {
  try {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
  } catch {
    return fallback
  }
}

/** @param {unknown} value */
function radiusCells(value) {
  const radius = finiteNumber(value, 0)
  if (radius <= 0) return 0
  return Math.min(MAX_RADIUS_CELLS, radius)
}

/** @param {unknown} value */
function gridCoordinate(value) {
  const number = finiteNumber(value, 0)
  return Math.max(-MAX_GRID_COORDINATE, Math.min(MAX_GRID_COORDINATE, Math.floor(number)))
}

/**
 * Первообразная sqrt(radius² - x²) для -radius <= x <= radius.
 * Постоянная слагаемого не важна: используются только разности значений.
 *
 * @param {number} radius
 * @param {number} x
 */
function circleHeightPrimitive(radius, x) {
  if (!(radius > 0)) return 0
  const boundedX = Math.max(-radius, Math.min(radius, x))
  const ratio = Math.max(-1, Math.min(1, boundedX / radius))
  const root = Math.sqrt(Math.max(0, radius * radius - boundedX * boundedX))
  return 0.5 * (boundedX * root + radius * radius * Math.asin(ratio))
}

/** @param {number} radius @param {number} x */
function circleHeight(radius, x) {
  return Math.sqrt(Math.max(0, radius * radius - x * x))
}

/**
 * Возвращает координаты x, где меняется формула вертикального среза. В этих
 * точках круг встречает горизонтальное ребро клетки. Разбиение позволяет
 * интегрировать площадь элементарной первообразной круга и не зависеть от
 * плотности выборки.
 *
 * @param {number} left
 * @param {number} right
 * @param {number} y0
 * @param {number} y1
 * @param {number} radius
 */
function integrationBreakpoints(left, right, y0, y1, radius) {
  const values = [left, right, 0]
  for (const edge of [y0, y1]) {
    const edgeDistance = Math.abs(edge)
    if (edgeDistance > radius) continue
    const x = Math.sqrt(Math.max(0, radius * radius - edgeDistance * edgeDistance))
    values.push(-x, x)
  }
  return [...new Set(values
    .filter((value) => value >= left && value <= right)
    .map((value) => Object.is(value, -0) ? 0 : value))]
    .sort((a, b) => a - b)
}

/**
 * Точная (с погрешностью числа с плавающей точкой) площадь пересечения круга
 * и клетки. Клетка задана относительно начала круга и имеет площадь одну
 * квадратную клетку.
 *
 * @param {{x: number, y: number}} cell
 * @param {number} radiusValue
 * @returns {number}
 */
export function circularCellCoverage(cell, radiusValue) {
  const radius = radiusCells(radiusValue)
  if (!(radius > 0)) return 0

  const x0 = finiteNumber(cell?.x, Number.NaN)
  const y0 = finiteNumber(cell?.y, Number.NaN)
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return 0
  const x1 = x0 + 1
  const y1 = y0 + 1
  const left = Math.max(x0, -radius)
  const right = Math.min(x1, radius)
  if (!(left < right)) return 0

  // Проверка ближайшей точки отбрасывает клетки вне круга до тригонометрии.
  // Проверка дальней вершины за O(1) обрабатывает обычные полностью покрытые
  // внутренние клетки.
  const nearestX = x0 > 0 ? x0 : x1 < 0 ? x1 : 0
  const nearestY = y0 > 0 ? y0 : y1 < 0 ? y1 : 0
  if (nearestX * nearestX + nearestY * nearestY >= radius * radius - EPSILON) return 0
  const farthestX = Math.max(Math.abs(x0), Math.abs(x1))
  const farthestY = Math.max(Math.abs(y0), Math.abs(y1))
  if (farthestX * farthestX + farthestY * farthestY <= radius * radius + EPSILON) return CELL_AREA

  const points = integrationBreakpoints(left, right, y0, y1, radius)
  let area = 0
  for (let index = 1; index < points.length; index += 1) {
    const segmentLeft = points[index - 1]
    const segmentRight = points[index]
    if (!(segmentLeft < segmentRight)) continue

    const midpoint = (segmentLeft + segmentRight) / 2
    const halfHeight = circleHeight(radius, midpoint)
    const upperIsCircle = halfHeight < y1
    const lowerIsCircle = -halfHeight > y0
    let circleCoefficient = 0
    let constant = 0
    if (upperIsCircle) circleCoefficient += 1
    else constant += y1
    if (lowerIsCircle) circleCoefficient += 1
    else constant -= y0

    const midpointLength = Math.min(y1, halfHeight) - Math.max(y0, -halfHeight)
    if (!(midpointLength > 0)) continue

    area += circleCoefficient * (
      circleHeightPrimitive(radius, segmentRight)
      - circleHeightPrimitive(radius, segmentLeft)
    ) + constant * (segmentRight - segmentLeft)
  }
  return Math.max(0, Math.min(CELL_AREA, area))
}

/**
 * @param {{x: number, y: number}} cell
 * @param {number} radiusValue
 * @returns {boolean}
 */
export function circularCellCovered(cell, radiusValue) {
  return circularCellCoverage(cell, radiusValue) >= COVERAGE_THRESHOLD - EPSILON
}

/**
 * Переводит выбранную клетку в её северо-западное пересечение сетки.
 * Координаты намеренно округляются вниз: ошибочная дробная цель не может
 * сдвинуть начало круга в произвольную точку внутри клетки.
 *
 * @param {{x: number, y: number}} target
 * @returns {{x: number, y: number}}
 */
export function gridOriginForTargetCell(target) {
  return { x: gridCoordinate(target?.x), y: gridCoordinate(target?.y) }
}

/**
 * @typedef {{x: number, y: number}} GridCell
 * @typedef {{minX: number, minY: number, maxX: number, maxY: number}} GridBounds
 * @typedef {{origin: GridCell, radiusFeet: number, cellFeet?: number, bounds?: GridBounds}} CircularAreaOptions
 */

/** @param {unknown} bounds @returns {GridBounds|null} */
function normalizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null
  const value = /** @type {Record<string, unknown>} */ (bounds)
  const minX = Math.ceil(finiteNumber(value.minX, Number.NaN))
  const minY = Math.ceil(finiteNumber(value.minY, Number.NaN))
  const maxX = Math.floor(finiteNumber(value.maxX, Number.NaN))
  const maxY = Math.floor(finiteNumber(value.maxY, Number.NaN))
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null
  return { minX, minY, maxX, maxY }
}

/** @param {unknown} point @returns {GridCell|null} */
function safeGridPoint(point) {
  if (!point || typeof point !== 'object') return null
  const value = /** @type {Record<string, unknown>} */ (point)
  const x = finiteNumber(value.x, Number.NaN)
  const y = finiteNumber(value.y, Number.NaN)
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return null
  if (Math.abs(x) > MAX_GRID_COORDINATE || Math.abs(y) > MAX_GRID_COORDINATE) return null
  return { x, y }
}

/** @param {GridCell} point */
function cellKey(point) {
  return `${point.x},${point.y}`
}

/** @param {GridCell} point @param {number} dx @param {number} dy */
function offsetCell(point, dx, dy) {
  return { x: point.x + dx, y: point.y + dy }
}

const CARDINAL_OFFSETS = Object.freeze([
  [1, 0], [-1, 0], [0, 1], [0, -1],
])

/**
 * Начало — пересечение сетки, поэтому к нему примыкают четыре клетки.
 * Выбранная клетка находится в юго-восточном квадранте (`origin.x`,
 * `origin.y`). Началом можно считать только часть этого кольца, связанную с
 * данным квадрантом. Так закрытое ребро у начала не превращается в случайный
 * портал во вторую комнату.
 *
 * @param {GridCell} origin
 * @param {number} radius
 * @param {(cell: GridCell) => boolean} isOpenCell
 * @param {(from: GridCell, to: GridCell) => boolean} isBlockedEdge
 * @returns {GridCell[]}
 */
function accessibleOriginSeeds(origin, radius, isOpenCell, isBlockedEdge) {
  const selected = { x: origin.x, y: origin.y }
  const seedCells = [
    selected,
    { x: origin.x, y: origin.y - 1 },
    { x: origin.x - 1, y: origin.y },
    { x: origin.x - 1, y: origin.y - 1 },
  ].filter((cell) => circularCellCovered({ x: cell.x - origin.x, y: cell.y - origin.y }, radius))
  const seedKeys = new Set(seedCells.map(cellKey))
  if (!seedKeys.has(cellKey(selected)) || !isOpenCell(selected)) return []

  const queue = [selected]
  const visited = new Set([cellKey(selected)])
  while (queue.length) {
    const current = queue.shift()
    if (!current) break
    for (const [dx, dy] of CARDINAL_OFFSETS) {
      const next = offsetCell(current, dx, dy)
      const nextKey = cellKey(next)
      if (!seedKeys.has(nextKey) || visited.has(nextKey) || !isOpenCell(next)) continue
      if (isBlockedEdge(current, next)) continue
      visited.add(nextKey)
      queue.push(next)
    }
  }
  return seedCells.filter((cell) => visited.has(cellKey(cell)))
}

/**
 * Обходит отрезок от пересечения начала до центра целевой клетки. Обход идёт
 * точным grid DDA, а не линией Bresenham между центрами клеток. В точном
 * пересечении угла обе соседние клетки и оба входящих ребра должны быть
 * открыты, поэтому диагональный луч не проскальзывает через закрытый угол.
 * У origin нет flood-компоненты: SE — стартовая клетка, NE/SW требуют
 * открытого первого ребра, а NW проходит ту же проверку четырёх рёбер, что и
 * обычная вершина DDA. Обход через соседний квадрант принадлежит только
 * `spreadsAroundCorners`.
 *
 * @param {GridCell} origin
 * @param {GridCell} target
 * @param {number} radius
 * @param {(cell: GridCell) => boolean} isOpenCell
 * @param {(from: GridCell, to: GridCell) => boolean} isBlockedEdge
 * @returns {boolean}
 */
function directGridRayClear(origin, target, radius, isOpenCell, isBlockedEdge) {
  const relativeTarget = { x: target.x - origin.x, y: target.y - origin.y }
  if (!circularCellCovered(relativeTarget, radius)) return false
  if (!isOpenCell(origin)) return false

  const targetCenterX = target.x + 0.5
  const targetCenterY = target.y + 0.5
  const deltaX = targetCenterX - origin.x
  const deltaY = targetCenterY - origin.y
  if (!(Number.isFinite(deltaX) && Number.isFinite(deltaY))) return false

  const stepX = Math.sign(deltaX)
  const stepY = Math.sign(deltaY)
  if (!stepX || !stepY) return false
  let current = {
    x: origin.x + (stepX > 0 ? 0 : -1),
    y: origin.y + (stepY > 0 ? 0 : -1),
  }
  if (!isOpenCell(current)) return false
  if (current.x === origin.x && current.y === origin.y - 1
    || current.x === origin.x - 1 && current.y === origin.y) {
    if (isBlockedEdge(origin, current)) return false
  } else if (current.x === origin.x - 1 && current.y === origin.y - 1) {
    const sideX = offsetCell(origin, stepX, 0)
    const sideY = offsetCell(origin, 0, stepY)
    if (!isOpenCell(sideX) || !isOpenCell(sideY)) return false
    if (isBlockedEdge(origin, sideX)
      || isBlockedEdge(origin, sideY)
      || isBlockedEdge(sideX, current)
      || isBlockedEdge(sideY, current)) return false
  }

  const deltaAbsX = Math.abs(deltaX)
  const deltaAbsY = Math.abs(deltaY)
  let nextVertical = 1 / deltaAbsX
  let nextHorizontal = 1 / deltaAbsY
  const stepParameterX = nextVertical
  const stepParameterY = nextHorizontal

  for (let steps = 0; steps <= MAX_RADIUS_CELLS * 3; steps += 1) {
    if (!isOpenCell(current)) return false
    if (current.x === target.x && current.y === target.y) return true
    if (nextVertical < nextHorizontal - EPSILON) {
      const next = offsetCell(current, stepX, 0)
      if (isBlockedEdge(current, next)) return false
      current = next
      nextVertical += stepParameterX
      continue
    }
    if (nextHorizontal < nextVertical - EPSILON) {
      const next = offsetCell(current, 0, stepY)
      if (isBlockedEdge(current, next)) return false
      current = next
      nextHorizontal += stepParameterY
      continue
    }

    // Луч попал в вершину сетки. Проверяются обе боковые клетки и все четыре
    // ребра вокруг вершины: два входящих из current и два входящих в diagonal.
    const sideX = offsetCell(current, stepX, 0)
    const sideY = offsetCell(current, 0, stepY)
    const diagonal = offsetCell(current, stepX, stepY)
    if (!isOpenCell(sideX) || !isOpenCell(sideY)) return false
    if (isBlockedEdge(current, sideX)
      || isBlockedEdge(current, sideY)
      || isBlockedEdge(sideX, diagonal)
      || isBlockedEdge(sideY, diagonal)) return false
    current = diagonal
    nextVertical += stepParameterX
    nextHorizontal += stepParameterY
  }
  return false
}

/**
 * Заполняет покрытую часть круга, когда заклинание может обходить углы.
 * Компонента со стороны начала строится отдельно, чтобы непрозрачное ребро
 * ровно у начала не открыло путь во вторую комнату.
 *
 * @param {GridCell} origin
 * @param {GridCell} target
 * @param {number} radius
 * @param {(cell: GridCell) => boolean} isOpenCell
 * @param {(from: GridCell, to: GridCell) => boolean} isBlockedEdge
 * @returns {boolean}
 */
function cornerFloodReaches(origin, target, radius, isOpenCell, isBlockedEdge) {
  if (!circularCellCovered({ x: target.x - origin.x, y: target.y - origin.y }, radius)) return false
  const seeds = accessibleOriginSeeds(origin, radius, isOpenCell, isBlockedEdge)
  const queue = [...seeds]
  const visited = new Set(seeds.map(cellKey))
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const current = queue[queueIndex]
    if (current.x === target.x && current.y === target.y) return true
    for (const [dx, dy] of CARDINAL_OFFSETS) {
      const next = offsetCell(current, dx, dy)
      const nextKey = cellKey(next)
      if (visited.has(nextKey)
        || !circularCellCovered({ x: next.x - origin.x, y: next.y - origin.y }, radius)
        || !isOpenCell(next)
        || isBlockedEdge(current, next)) continue
      visited.add(nextKey)
      queue.push(next)
    }
  }
  return false
}

/**
 * Проверяет line-of-effect от пересечения начала до целевой клетки.
 * `radiusFeet` трактуется через стандартную клетку 5 футов. Коллбэки для
 * геометрических тестов необязательны; при наличии они получают соседние
 * клетки при каждом решении о клетке или ребре.
 *
 * @param {GridCell} origin
 * @param {GridCell} targetCell
 * @param {{radiusFeet: number, spreadsAroundCorners?: boolean, isOpenCell?: (cell: GridCell) => boolean, isBlockedEdge?: (from: GridCell, to: GridCell) => boolean}} [options]
 * @returns {boolean}
 */
export function circularAreaLineOfEffect(origin, targetCell, options = {}) {
  const safeOrigin = safeGridPoint(origin)
  const safeTarget = safeGridPoint(targetCell)
  if (!safeOrigin || !safeTarget || !options || typeof options !== 'object') return false
  const radiusFeet = finiteNumber(options.radiusFeet, 0)
  if (!(radiusFeet > 0)) return false
  const radius = radiusCells(radiusFeet / 5)
  if (!(radius > 0)) return false

  const openCallback = typeof options.isOpenCell === 'function' ? options.isOpenCell : null
  const edgeCallback = typeof options.isBlockedEdge === 'function' ? options.isBlockedEdge : null
  /** @param {GridCell} cell */
  const isOpenCell = (cell) => {
    if (!openCallback) return true
    try { return Boolean(openCallback(cell)) } catch { return false }
  }
  /** @param {GridCell} from @param {GridCell} to */
  const isBlockedEdge = (from, to) => {
    if (!edgeCallback) return false
    try { return Boolean(edgeCallback(from, to)) } catch { return true }
  }

  return options.spreadsAroundCorners === true
    ? cornerFloodReaches(safeOrigin, safeTarget, radius, isOpenCell, isBlockedEdge)
    : directGridRayClear(safeOrigin, safeTarget, radius, isOpenCell, isBlockedEdge)
}

/**
 * Строит растр круговой области вокруг пересечения сетки.
 *
 * Bounds включаются и применяются после проверки круга. Неположительный или
 * нечисловой радиус даёт пустой список. Вход выше безопасного радиуса
 * ограничивается 128 клетками, поэтому ошибочное значение не создаёт
 * бесконечный цикл или неограниченное выделение памяти.
 *
 * @param {CircularAreaOptions} options
 * @returns {GridCell[]}
 */
export function circularAreaCells(options = {}) {
  if (!options || typeof options !== 'object') return []
  const { origin, radiusFeet, cellFeet = 5, bounds } = options
  if (!origin || typeof origin !== 'object') return []
  const originValue = /** @type {Record<string, unknown>} */ (origin)
  const originX = finiteNumber(originValue.x, Number.NaN)
  const originY = finiteNumber(originValue.y, Number.NaN)
  if (!Number.isFinite(originX) || !Number.isFinite(originY)
    || Math.abs(originX) > MAX_GRID_COORDINATE || Math.abs(originY) > MAX_GRID_COORDINATE) return []
  const feet = finiteNumber(cellFeet, 5)
  const radiusInFeet = finiteNumber(radiusFeet, 0)
  if (!(feet > 0) || !(radiusInFeet > 0)) return []

  const radius = radiusCells(radiusInFeet / feet)
  if (!(radius > 0)) return []
  const center = gridOriginForTargetCell(origin)
  const normalizedBounds = bounds == null ? null : normalizeBounds(bounds)
  if (bounds != null && !normalizedBounds) return []
  if (normalizedBounds && (
    normalizedBounds.minX > normalizedBounds.maxX
    || normalizedBounds.minY > normalizedBounds.maxY
  )) return []

  const reach = Math.ceil(radius)
  const result = []
  for (let y = center.y - reach; y < center.y + reach; y += 1) {
    for (let x = center.x - reach; x < center.x + reach; x += 1) {
      if (normalizedBounds && (
        x < normalizedBounds.minX || x > normalizedBounds.maxX
        || y < normalizedBounds.minY || y > normalizedBounds.maxY
      )) continue
      if (circularCellCovered({ x: x - center.x, y: y - center.y }, radius)) {
        result.push({ x, y })
      }
    }
  }
  return result
}

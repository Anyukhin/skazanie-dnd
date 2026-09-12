// Чистая геометрия площади существа. Модуль намеренно не знает о состоянии,
// событиях и карте: Rules Engine решает, можно ли поставить уже рассчитанную
// площадь в конкретную сцену.

export const ACTOR_FOOTPRINT_VERSION = 1

/** Размеры существ, из которых сервер получает сторону квадратной площади. */
export const ACTOR_SIZE_SIDES = Object.freeze({
  tiny: 1,
  small: 1,
  medium: 1,
  large: 2,
  huge: 3,
  gargantuan: 4,
})

const MIN_FOOTPRINT_SIDE = 1
const MAX_FOOTPRINT_SIDE = 4

/**
 * @param {unknown} value
 * @returns {number}
 */
function sideFromSize(value) {
  const text = String(value ?? '').trim().toLocaleLowerCase('ru')
  for (const [name, side] of Object.entries(ACTOR_SIZE_SIDES)) {
    if (text === name || text === ({ large: 'большой', huge: 'огромный', gargantuan: 'громадный' }[name] ?? '')) return side
  }
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= MIN_FOOTPRINT_SIDE && number <= MAX_FOOTPRINT_SIDE
    ? number
    : 1
}

/**
 * Метадата, которую сервер ставит новым акторам. Текстовый размер принимается
 * потому, что именно так его записывают каталог и профиль; в сохранённую форму
 * попадает только ограниченная сторона квадрата.
 *
 * @param {unknown} size
 * @returns {{version: 1, size: number}}
 */
export function footprintMetadataForSize(size) {
  return { version: ACTOR_FOOTPRINT_VERSION, size: sideFromSize(size) }
}

/**
 * @param {unknown} value
 * @returns {{version: 1, size: number}|null}
 */
export function normalizeFootprintMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (Number(value.version) !== ACTOR_FOOTPRINT_VERSION) return null
  const size = Number(value.size)
  return Number.isSafeInteger(size) && size >= MIN_FOOTPRINT_SIDE && size <= MAX_FOOTPRINT_SIDE
    ? { version: ACTOR_FOOTPRINT_VERSION, size }
    : null
}

/**
 * Читает только версионированный контракт площади. Старые актёры могут всё
 * ещё нести `size: 'large'`, но без этой метадаты намеренно считаются одной
 * клеткой, чтобы старые снимки и replay не получали занятость при чтении.
 *
 * @param {unknown} actor
 * @returns {number}
 */
export function footprintSizeFor(actor) {
  const metadata = actor && typeof actor === 'object' && !Array.isArray(actor)
    ? /** @type {{footprint?: {version?: unknown, size?: unknown}}} */ (actor).footprint
    : null
  return normalizeFootprintMetadata(metadata)?.size ?? 1
}

/**
 * Абсолютные клетки, занятые актёром. `x/y` — верхний левый anchor.
 * Некорректные координаты дают пустой список, чтобы правило карты само
 * отклонило расстановку и не придумало координату.
 *
 * @param {unknown} actor
 * @param {{x?: unknown, y?: unknown}|null} [anchor]
 * @returns {Array<{x: number, y: number}>}
 */
export function footprintCellsFor(actor, anchor = null) {
  const position = anchor ?? (actor && typeof actor === 'object' && !Array.isArray(actor) ? actor : null)
  const x = Number(position?.x)
  const y = Number(position?.y)
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return []
  const side = footprintSizeFor(actor)
  const cells = []
  for (let dy = 0; dy < side; dy += 1) {
    for (let dx = 0; dx < side; dx += 1) cells.push({ x: x + dx, y: y + dy })
  }
  return cells
}

/**
 * @param {unknown} value
 * @param {{x?: unknown, y?: unknown}|null} [anchor]
 * @returns {Array<{x: number, y: number}>}
 */
function cellsFrom(value, anchor = null) {
  if (Array.isArray(value)) return value
    .map((cell) => ({ x: Number(cell?.x), y: Number(cell?.y) }))
    .filter((cell) => Number.isSafeInteger(cell.x) && Number.isSafeInteger(cell.y))
  return footprintCellsFor(value, anchor)
}

/**
 * Минимальная клеточная дистанция между двумя занятыми площадями. Расстояние
 * Чебышёва — та же метрика квадратной сетки, что уже использует ruleset;
 * соседние площади разделяют пять футов, пересекающиеся дают ноль.
 *
 * Принимаются и актёры, и заранее рассчитанные массивы клеток: геометрия
 * остаётся чистой, а горячие пути могут переиспользовать раскрытую площадь.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @param {{x?: unknown, y?: unknown}|null} [leftAnchor]
 * @param {{x?: unknown, y?: unknown}|null} [rightAnchor]
 * @returns {number|null}
 */
export function footprintDistanceFeet(left, right, leftAnchor = null, rightAnchor = null) {
  const leftCells = cellsFrom(left, leftAnchor)
  const rightCells = cellsFrom(right, rightAnchor)
  if (!leftCells.length || !rightCells.length) return null
  let distance = Number.POSITIVE_INFINITY
  for (const first of leftCells) {
    for (const second of rightCells) {
      distance = Math.min(distance, Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y)))
    }
  }
  return Number.isFinite(distance) ? distance * 5 : null
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @param {{x?: unknown, y?: unknown}|null} [leftAnchor]
 * @param {{x?: unknown, y?: unknown}|null} [rightAnchor]
 * @returns {boolean}
 */
export function footprintOverlap(left, right, leftAnchor = null, rightAnchor = null) {
  const rightKeys = new Set(cellsFrom(right, rightAnchor).map((cell) => `${cell.x},${cell.y}`))
  return cellsFrom(left, leftAnchor).some((cell) => rightKeys.has(`${cell.x},${cell.y}`))
}

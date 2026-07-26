// @ts-check
import { cellAt } from './tactical-map.mjs'

/**
 * Бой в подрайоне большой карты (`docs/tactical-map-plan.md`, раздел 11.4).
 *
 * Сто клеток — это 500 футов. Скорость героя 30 футов, то есть шесть клеток за
 * ход; пересечь такую карту — около семнадцати ходов рывком. Дальность
 * большинства заклинаний 60–120 футов, то есть 12–24 клетки. Участники,
 * разошедшиеся дальше, не взаимодействуют вообще, и бой вырождается в долгую
 * ходьбу.
 *
 * Поэтому у встречи есть подрайон: прямоугольник вокруг участников с запасом на
 * манёвр и отступление. Камера по умолчанию показывает его целиком.
 *
 * **Выход за границу разрешён и расширяет её, а не блокируется.** Иначе
 * получается невидимая стена, запрещённая `docs/product-principles.md`.
 */

/** Запас вокруг участников: два хода героя со скоростью 30 футов. */
export const COMBAT_BOUNDS_MARGIN_CELLS = 12

/**
 * @typedef {{minX: number, minY: number, maxX: number, maxY: number}} Bounds
 */

/**
 * @param {Bounds} bounds
 * @param {number} width
 * @param {number} height
 * @returns {Bounds}
 */
function clampToMap(bounds, width, height) {
  return {
    minX: Math.max(0, Math.min(width - 1, Math.floor(bounds.minX))),
    minY: Math.max(0, Math.min(height - 1, Math.floor(bounds.minY))),
    maxX: Math.max(0, Math.min(width - 1, Math.ceil(bounds.maxX))),
    maxY: Math.max(0, Math.min(height - 1, Math.ceil(bounds.maxY))),
  }
}

/**
 * Прямоугольник вокруг участников встречи.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {Array<{x: number, y: number}>} participants
 * @param {{margin?: number}} [options]
 * @returns {Bounds|null} null, если участников нет — подрайон не из чего строить
 */
export function computeCombatBounds(map, participants, { margin = COMBAT_BOUNDS_MARGIN_CELLS } = {}) {
  const points = (Array.isArray(participants) ? participants : []).filter((point) => (
    Number.isSafeInteger(Number(point?.x)) && Number.isSafeInteger(Number(point?.y))
  ))
  if (!points.length) return null
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    minX = Math.min(minX, Number(point.x))
    minY = Math.min(minY, Number(point.y))
    maxX = Math.max(maxX, Number(point.x))
    maxY = Math.max(maxY, Number(point.y))
  }
  const safeMargin = Math.max(0, Math.floor(margin))
  return clampToMap(
    { minX: minX - safeMargin, minY: minY - safeMargin, maxX: maxX + safeMargin, maxY: maxY + safeMargin },
    map.width,
    map.height,
  )
}

/**
 * @param {Bounds|null} bounds
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function combatBoundsContain(bounds, x, y) {
  if (!bounds) return true
  return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY
}

/**
 * Расширяет подрайон так, чтобы он включал точку с тем же запасом. Ничего не
 * запрещает: выход за границу — это повод раздвинуть её, а не отказ.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {Bounds|null} bounds
 * @param {number} x
 * @param {number} y
 * @param {{margin?: number}} [options]
 * @returns {Bounds} новый прямоугольник; прежний не трогается
 */
export function expandCombatBounds(map, bounds, x, y, { margin = COMBAT_BOUNDS_MARGIN_CELLS } = {}) {
  const safeMargin = Math.max(0, Math.floor(margin))
  if (!bounds) {
    return clampToMap({ minX: x - safeMargin, minY: y - safeMargin, maxX: x + safeMargin, maxY: y + safeMargin }, map.width, map.height)
  }
  if (combatBoundsContain(bounds, x, y)) return { ...bounds }
  return clampToMap({
    minX: Math.min(bounds.minX, x - safeMargin),
    minY: Math.min(bounds.minY, y - safeMargin),
    maxX: Math.max(bounds.maxX, x + safeMargin),
    maxY: Math.max(bounds.maxY, y + safeMargin),
  }, map.width, map.height)
}

/**
 * Сколько клеток подрайона проходимо. Нужно, чтобы понять, не выродился ли он в
 * коридор: подрайон вокруг двух участников по разные стороны стены бесполезен.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {Bounds|null} bounds
 * @returns {{cells: number, passable: number}}
 */
export function combatBoundsCoverage(map, bounds) {
  if (!bounds) return { cells: 0, passable: 0 }
  let cells = 0
  let passable = 0
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const cell = cellAt(map, x, y)
      if (!cell) continue
      cells += 1
      if (cell.passable) passable += 1
    }
  }
  return { cells, passable }
}

/**
 * Ставит подрайон на карту. Возвращает карту же — удобно в цепочке.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {Array<{x: number, y: number}>} participants
 * @param {{margin?: number}} [options]
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function applyCombatBounds(map, participants, options = {}) {
  map.combatBounds = computeCombatBounds(map, participants, options)
  return map
}

/**
 * Нужен ли подрайон вообще. На маленькой карте он бессмыслен: если вся карта
 * помещается в область досягаемости, ограничивать нечего.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @returns {boolean}
 */
export function combatBoundsUseful(map) {
  // Две стороны запаса плюс сами участники: меньше этого — подрайон совпадёт с
  // картой и только запутает.
  const threshold = COMBAT_BOUNDS_MARGIN_CELLS * 2 + 4
  return map.width > threshold || map.height > threshold
}

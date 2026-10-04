/**
 * Какими клетками площадей можно соединить стрелка и цель-существо.
 *
 * Сервер (`actorTrajectoryDetails`, server/rules/tactical-geometry.mjs) ведёт
 * линию огня между существами только через **раскрытые** клетки их площадей:
 * из тумана не стреляют и в туман не целятся. Без этой проверки доска
 * подсвечивала цель, а сервер отказывал с `TRAJECTORY_BLOCKED` — так было на
 * стенде, где герой стоял в нераскрытой клетке. Колонна и другой реквизит
 * линию не режут ни здесь, ни на сервере: они дают укрытие (`TERRAIN_COVER`).
 *
 * Правило то же, что у сервера: если у сцены нет клеток, фильтра нет; если
 * клетки есть, а раскрытых в площади нет — пар нет, линия закрыта. Модуль
 * чистый, поэтому его сверяет с сервером `test/line-of-fire.test.mjs`.
 *
 * Линии в клетку (бросок, точка заклинания) сервер берёт без этого фильтра,
 * и сюда они не относятся.
 *
 * @param {Array<{x: number, y: number, revealed?: boolean}>} sceneCells
 * @param {Array<{x: number, y: number}>} starts
 * @param {Array<{x: number, y: number}>} ends
 * @returns {{ starts: Array<{x: number, y: number}>, ends: Array<{x: number, y: number}> }}
 */
export function revealedLineOfFireCells(sceneCells, starts, ends) {
  const cells = Array.isArray(sceneCells) ? sceneCells : []
  if (!cells.length) return { starts, ends }
  const revealed = new Set(cells.filter((cell) => cell?.revealed === true).map((cell) => `${cell.x},${cell.y}`))
  const visible = (cell) => revealed.has(`${cell.x},${cell.y}`)
  return { starts: starts.filter(visible), ends: ends.filter(visible) }
}

export const HIDDEN_LINE_OF_FIRE_REASON = 'Стрелок или цель в нераскрытой части карты'

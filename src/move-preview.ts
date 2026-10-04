/**
 * Предпросмотр хода на доске: нить маршрута, контур досягаемости и итог у
 * цели. Раньше на каждой клетке маршрута стоял номер шага — игроку он ничего
 * не говорил, а карту закрывал. Вместо номеров одна линия и одно число у
 * курсора, а куда вообще хватает движения — показывает контур (макет:
 * канва «Путь персонажа на карте», варианты A и D).
 *
 * Модуль без зависимостей: геометрия строится в единицах клетки строкой пути
 * SVG. Её одинаково понимают `<path d>` двумерной доски и `Path2D` холста,
 * который лежит на объёмной карте, — поэтому оба вида рисуют одно и то же.
 */

export type MovePreviewPoint = { x: number; y: number }

export type BoardMovePreview = {
  /** Клетка фишки, с которой начинается маршрут. */
  start: MovePreviewPoint
  /** Шаги маршрута без стартовой клетки; `difficult` — шаг в трудную местность. */
  path: Array<MovePreviewPoint & { difficult?: boolean }>
  /** Клетки, куда хватает движения этого хода, ключами `x,y`; пусто — контура нет. */
  reach: readonly string[]
  /**
   * Итог у цели: цена, остаток движения, доплата за трудную местность и
   * предупреждение об атаке по возможности — каждое своей строкой.
   */
  label?: { main: string; sub?: string; note?: string; risk?: string }
  /**
   * Где маршрут выходит из досягаемости врага — середина шага, в долях
   * клетки. Там встаёт метка атаки по возможности.
   */
  risk?: MovePreviewPoint | null
}

/** Радиус скругления поворота нити, в клетках. */
const CORNER = 0.32

const fmt = (value: number) => String(Math.round(value * 1000) / 1000)

function centers(preview: Pick<BoardMovePreview, 'start' | 'path'>) {
  return [preview.start, ...preview.path].map((point) => ({ x: point.x + 0.5, y: point.y + 0.5 }))
}

/**
 * Нить маршрута через центры клеток. Шаги ортогональные, поэтому на каждом
 * повороте угол срезается дугой — ломаная из прямых углов читалась как
 * лесенка, а не как путь.
 */
export function moveRoutePath(preview: Pick<BoardMovePreview, 'start' | 'path'>): string {
  const points = centers(preview)
  if (points.length < 2) return ''
  // Подряд идущие шаги в одну сторону сливаются: дугу ставят только повороты.
  const turns = [points[0]]
  for (let index = 1; index < points.length - 1; index += 1) {
    const before = turns[turns.length - 1]
    const here = points[index]
    const after = points[index + 1]
    const sameLine = (here.x - before.x) * (after.y - here.y) === (here.y - before.y) * (after.x - here.x)
    if (!sameLine) turns.push(here)
  }
  turns.push(points[points.length - 1])
  let d = `M${fmt(turns[0].x)} ${fmt(turns[0].y)}`
  for (let index = 1; index < turns.length - 1; index += 1) {
    const before = turns[index - 1]
    const here = turns[index]
    const after = turns[index + 1]
    const inLength = Math.hypot(here.x - before.x, here.y - before.y)
    const outLength = Math.hypot(after.x - here.x, after.y - here.y)
    const radius = Math.min(CORNER, inLength / 2, outLength / 2)
    const entry = { x: here.x - (here.x - before.x) / inLength * radius, y: here.y - (here.y - before.y) / inLength * radius }
    const exit = { x: here.x + (after.x - here.x) / outLength * radius, y: here.y + (after.y - here.y) / outLength * radius }
    d += ` L${fmt(entry.x)} ${fmt(entry.y)} Q${fmt(here.x)} ${fmt(here.y)} ${fmt(exit.x)} ${fmt(exit.y)}`
  }
  const last = turns[turns.length - 1]
  return `${d} L${fmt(last.x)} ${fmt(last.y)}`
}

/** Отрезки маршрута, которые входят в трудную местность: по ним нить в крапинку. */
export function moveDifficultPath(preview: Pick<BoardMovePreview, 'start' | 'path'>): string {
  const points = centers(preview)
  let d = ''
  preview.path.forEach((step, index) => {
    if (!step.difficult) return
    const from = points[index]
    const to = points[index + 1]
    d += `M${fmt(from.x)} ${fmt(from.y)} L${fmt(to.x)} ${fmt(to.y)} `
  })
  return d.trim()
}

/**
 * Контур досягаемости: рёбра между клетками, куда хватает движения, и
 * остальными. Клетка фишки входит в область, иначе вокруг героя оставалась бы
 * дыра.
 */
export function moveReachOutline(preview: Pick<BoardMovePreview, 'start' | 'reach'>): string {
  if (!preview.reach.length) return ''
  const inside = new Set(preview.reach)
  inside.add(`${preview.start.x},${preview.start.y}`)
  let d = ''
  for (const key of inside) {
    const [x, y] = key.split(',').map(Number)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (!inside.has(`${x},${y - 1}`)) d += `M${x} ${y} H${x + 1} `
    if (!inside.has(`${x},${y + 1}`)) d += `M${x} ${y + 1} H${x + 1} `
    if (!inside.has(`${x - 1},${y}`)) d += `M${x} ${y} V${y + 1} `
    if (!inside.has(`${x + 1},${y}`)) d += `M${x + 1} ${y} V${y + 1} `
  }
  return d.trim()
}

/** Заливка области досягаемости — едва заметная, чтобы контур читался как граница, а не как рамка. */
export function moveReachFill(preview: Pick<BoardMovePreview, 'start' | 'reach'>): string {
  if (!preview.reach.length) return ''
  const inside = new Set(preview.reach)
  inside.add(`${preview.start.x},${preview.start.y}`)
  let d = ''
  for (const key of inside) {
    const [x, y] = key.split(',').map(Number)
    if (Number.isFinite(x) && Number.isFinite(y)) d += `M${x} ${y} h1 v1 h-1 Z `
  }
  return d.trim()
}

/**
 * Где маршрут выходит из досягаемости врага. `threatened(point)` — стоит ли
 * клетка в чьей-то досягаемости; ответ — середина первого шага, который
 * уводит из неё, в долях клетки (`null` — маршрут угрозы не покидает).
 */
export function moveRiskPoint(
  preview: Pick<BoardMovePreview, 'start' | 'path'>,
  threatened: (point: MovePreviewPoint) => boolean,
): MovePreviewPoint | null {
  const points = [preview.start, ...preview.path]
  for (let index = 1; index < points.length; index += 1) {
    if (threatened(points[index - 1]) && !threatened(points[index])) {
      return { x: (points[index - 1].x + points[index].x) / 2, y: (points[index - 1].y + points[index].y) / 2 }
    }
  }
  return null
}

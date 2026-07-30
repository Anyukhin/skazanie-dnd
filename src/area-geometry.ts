/**
 * Общая клеточная геометрия областей. Сервер остаётся источником истины для
 * применения заклинания; эти функции дают доске тот же детерминированный
 * предпросмотр до отправки команды и служат общей основой для эффектов.
 */

export type AreaPoint = { x: number; y: number }
export type AreaShape = 'sphere' | 'cylinder' | 'cone' | 'cube' | 'line'
export type AreaBounds = { minX: number; minY: number; maxX: number; maxY: number }

export type AreaGeometry = {
  shape: AreaShape
  /** Для конуса, линии и направленного куба — клетка заклинателя. */
  origin: AreaPoint
  /** Точка прицеливания; для сферы, цилиндра и point-cube это центр области. */
  target?: AreaPoint
  /**
   * `self` делает куб направленным от заклинателя и трактует размер как ребро.
   * `point` делает куб центрированным в target и трактует размер как радиус.
   */
  originMode?: 'self' | 'point'
  /** Радиус либо длина/ребро области — в футах, как в серверном профиле. */
  sizeFeet: number
  cellFeet?: number
  bounds?: AreaBounds
  /** Та же проверка проходимости, которую сервер применяет к клеткам луча/стены. */
  isWalkable?: (point: AreaPoint) => boolean
}

export type AreaActor<TTeam extends string = 'ally' | 'enemy'> = AreaPoint & {
  id: string
  team: TTeam
  alive?: boolean
}

const key = (point: AreaPoint) => `${point.x},${point.y}`

function inBounds(point: AreaPoint, bounds?: AreaBounds) {
  return !bounds || (
    point.x >= bounds.minX && point.x <= bounds.maxX
    && point.y >= bounds.minY && point.y <= bounds.maxY
  )
}

function directionFrom(origin: AreaPoint, target?: AreaPoint) {
  if (!target) return null
  const x = Number(target.x) - Number(origin.x)
  const y = Number(target.y) - Number(origin.y)
  return x || y ? { x, y } : null
}

function coneContains(point: AreaPoint, origin: AreaPoint, target: AreaPoint | undefined, lengthCells: number) {
  const direction = directionFrom(origin, target)
  if (!direction) return false
  const x = point.x - origin.x
  const y = point.y - origin.y
  if ((!x && !y) || Math.max(Math.abs(x), Math.abs(y)) > lengthCells) return false
  const dot = direction.x * x + direction.y * y
  const cross = Math.abs(direction.x * y - direction.y * x)
  return dot > 0 && cross * 2 <= dot
}

function directedCubeContains(point: AreaPoint, origin: AreaPoint, target: AreaPoint | undefined, edgeCells: number) {
  const direction = directionFrom(origin, target)
  if (!direction) return false
  const x = point.x - origin.x
  const y = point.y - origin.y
  const halfWidth = Math.floor((edgeCells - 1) / 2)
  if (Math.abs(direction.x) >= Math.abs(direction.y)) {
    const forward = x * Math.sign(direction.x)
    return forward >= 1 && forward <= edgeCells && Math.abs(y) <= halfWidth
  }
  const forward = y * Math.sign(direction.y)
  return forward >= 1 && forward <= edgeCells && Math.abs(x) <= halfWidth
}

function lineCells(
  origin: AreaPoint,
  target: AreaPoint | undefined,
  lengthCells: number,
  originMode: 'self' | 'point',
  isWalkable: (point: AreaPoint) => boolean,
) {
  const direction = directionFrom(origin, target)
  if (!direction) return []
  const stepX = Math.sign(direction.x)
  const stepY = Math.sign(direction.y)
  if (originMode === 'self') {
    const result: AreaPoint[] = []
    for (let step = 1; step <= lengthCells; step += 1) {
      const point = { x: origin.x + stepX * step, y: origin.y + stepY * step }
      if (!isWalkable(point)) break
      result.push(point)
    }
    return result
  }

  const acrossX = -stepY || 0
  const acrossY = stepX || 0
  const half = Math.floor(lengthCells / 2)
  const result: AreaPoint[] = []
  for (let offset = -half; offset <= half; offset += 1) {
    const point = {
      x: (target?.x ?? origin.x) + acrossX * offset,
      y: (target?.y ?? origin.y) + acrossY * offset,
    }
    if (isWalkable(point)) result.push(point)
  }
  return result
}

/**
 * Возвращает уникальные клетки в стабильном порядке: сверху вниз, слева
 * направо. Клетка источника не входит в конус, линию и направленный куб —
 * это совпадает с серверными `positionInCone`, `wallCells` и
 * `positionInDirectedCube`.
 */
export function areaCells(geometry: AreaGeometry): AreaPoint[] {
  const cellFeet = Math.max(1, Number(geometry.cellFeet) || 5)
  const sizeFeet = Math.max(0, Number(geometry.sizeFeet) || 0)
  if (sizeFeet <= 0) return []
  const cells = Math.max(0, Math.floor(sizeFeet / cellFeet))

  let result: AreaPoint[] = []
  if (geometry.shape === 'line') {
    result = lineCells(
      geometry.origin,
      geometry.target,
      cells,
      geometry.originMode ?? 'point',
      geometry.isWalkable ?? ((point) => inBounds(point, geometry.bounds)),
    )
  } else {
    const selfCube = geometry.shape === 'cube' && geometry.originMode === 'self'
    const directedCube = selfCube
      && Boolean(geometry.target && key(geometry.target) !== key(geometry.origin))
    if (selfCube && !directedCube) return []
    const center = geometry.shape === 'sphere' || geometry.shape === 'cylinder'
      || geometry.shape === 'cube' && !selfCube
      ? geometry.target ?? geometry.origin
      : geometry.origin
    for (let y = center.y - cells; y <= center.y + cells; y += 1) {
      for (let x = center.x - cells; x <= center.x + cells; x += 1) {
        const point = { x, y }
        if (geometry.shape === 'cone' && !coneContains(point, geometry.origin, geometry.target, cells)) continue
        if (directedCube) {
          if (!directedCubeContains(point, geometry.origin, geometry.target, Math.max(1, cells))) continue
        } else if (Math.max(Math.abs(x - center.x), Math.abs(y - center.y)) > cells) {
          continue
        }
        result.push(point)
      }
    }
  }

  const unique = new Map(result.filter((point) => inBounds(point, geometry.bounds)).map((point) => [key(point), point]))
  return [...unique.values()].sort((left, right) => left.y - right.y || left.x - right.x)
}

/** Все живые существа в области, без фильтра по стороне — дружественный огонь виден заранее. */
export function affectedAreaActors<TTeam extends string>(
  cells: readonly AreaPoint[],
  actors: readonly AreaActor<TTeam>[],
): Array<AreaActor<TTeam>> {
  const occupied = new Set(cells.map(key))
  return actors.filter((actor) => actor.alive !== false && occupied.has(key(actor)))
}

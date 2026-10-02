import type { BoardEffectRenderer } from './board-render'
import type { BoardPoint } from './combat-animation'
import { circularAreaLineOfEffect } from '../server/circular-area-geometry.mjs'
import type { ActorFootprint, AreaGeometryVersion, TacticalMap } from './types'
import { cellAt, revealedAt, sightEdgeBlocked } from './tactical-map-client'
import { actorFootprintCells, actorPresentationSize } from './tactical-ui'

const key = (point: BoardPoint) => `${point.x},${point.y}`

export type SpellTargetingActor = {
  id: string
  x: number
  y: number
  kind?: string
  defeated?: boolean
  footprint?: ActorFootprint
}

export type SpellLineOfEffectOptions = {
  origins: readonly BoardPoint[]
  /** Для large/huge целей проверяется каждая клетка их площади. */
  targetCells?: (cell: BoardPoint) => readonly BoardPoint[]
  spreadsAroundCorners?: boolean
  radiusFeet?: number
  /** Версионированная область использует общий обход от origin до клетки. */
  geometryVersion?: AreaGeometryVersion
  gridOrigin?: BoardPoint
}

/** Клиентский адаптер общей проверки линии действия от точки области. */
export function circularGridPointLineOfEffect(
  map: TacticalMap,
  origin: BoardPoint,
  target: BoardPoint,
  options: { radiusFeet: number; spreadsAroundCorners?: boolean },
) {
  return circularAreaLineOfEffect(origin, target, {
    radiusFeet: Number(options.radiusFeet) || 0,
    spreadsAroundCorners: options.spreadsAroundCorners === true,
    isOpenCell: (candidate) => openCell(map, candidate),
    isBlockedEdge: (from, to) => sightEdgeBlocked(map, from, to),
  })
}

function lineCells(from: BoardPoint, to: BoardPoint): BoardPoint[] {
  const result: BoardPoint[] = []
  let x = from.x
  let y = from.y
  const dx = Math.abs(to.x - x), sx = x < to.x ? 1 : -1
  const dy = -Math.abs(to.y - y), sy = y < to.y ? 1 : -1
  let error = dx + dy
  while (x !== to.x || y !== to.y) {
    const twice = 2 * error
    if (twice >= dy) { error += dy; x += sx }
    if (twice <= dx) { error += dx; y += sy }
    result.push({ x, y })
  }
  return result
}

/**
 * Прозрачна ли клетка для обзора и заклинания. Вода непроходима, но не
 * закрывает линию действия — то же правило, что серверный
 * `isTransparentMapCell` в `server/rules/tactical-geometry.mjs`.
 */
function openCell(map: TacticalMap, point: BoardPoint) {
  const cell = cellAt(map, point.x, point.y)
  return Boolean(cell && (cell.passable === true || cell.surface === 'water'))
}

function clearStraightLoE(map: TacticalMap, origin: BoardPoint, target: BoardPoint) {
  if (!openCell(map, target)) return false
  let previous = origin
  for (const point of lineCells(origin, target)) {
    if (!openCell(map, point) || sightEdgeBlocked(map, previous, point)) return false
    previous = point
  }
  return true
}

function canFloodTo(map: TacticalMap, origin: BoardPoint, target: BoardPoint, radiusFeet: number) {
  const radius = Math.max(0, Math.floor(Number(radiusFeet) / 5))
  if (!openCell(map, origin) || !openCell(map, target)) return false
  const queue = [origin]
  const visited = new Set([key(origin)])
  while (queue.length) {
    const current = queue.shift()!
    if (current.x === target.x && current.y === target.y) return true
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: current.x + dx, y: current.y + dy }
      const nextKey = key(next)
      if (visited.has(nextKey) || Math.max(Math.abs(next.x - origin.x), Math.abs(next.y - origin.y)) > radius) continue
      if (!openCell(map, next) || sightEdgeBlocked(map, current, next)) continue
      visited.add(nextKey)
      queue.push(next)
    }
  }
  return false
}

/** Оставляет только клетки, до которых production targeting допускает LoE. */
export function maskSpellAreaCells(
  map: TacticalMap,
  cells: readonly BoardPoint[],
  options: SpellLineOfEffectOptions,
): ReadonlySet<string> {
  const origins = options.origins.filter((origin) => Number.isSafeInteger(origin.x) && Number.isSafeInteger(origin.y))
  const targetCells = options.targetCells ?? ((cell: BoardPoint) => [cell])
  const areaKeys = new Set(cells.map(key))
  const spreads = options.spreadsAroundCorners === true
  const circleGridLoE = options.geometryVersion === 'circle-grid-v2'
    && options.gridOrigin
    && Number.isSafeInteger(options.gridOrigin.x)
    && Number.isSafeInteger(options.gridOrigin.y)
    ? options.gridOrigin
    : null
  const result = new Set<string>()
  for (const cell of cells) {
    // Большая цель может занимать соседние клетки, но LoE проверяется только
    // по её части, попавшей в исходную геометрию области. Иначе footprint
    // способен «спасти» клетку, которую сама область не покрывает.
    const targets = targetCells(cell).filter((target) => areaKeys.has(key(target)))
    const reaches = circleGridLoE
      ? targets.some((target) => circularGridPointLineOfEffect(map, circleGridLoE, target, {
        radiusFeet: Number(options.radiusFeet) || 0,
        spreadsAroundCorners: spreads,
      }))
      : targets.some((target) => origins.some((origin) => spreads
        ? canFloodTo(map, origin, target, Number(options.radiusFeet) || 0)
        : clearStraightLoE(map, origin, target)))
    if (reaches) result.add(key(cell))
  }
  return result
}

/** Предпросмотр использует только раскрытую проекцию и видимую площадь фигурки. */
export function spellPreviewActors(map: TacticalMap | null, cells: ReadonlySet<string>, actors: readonly SpellTargetingActor[]) {
  if (!map) return []
  return actors.filter((actor) => !actor.defeated && revealedAt(map, actor.x, actor.y)
    && actorFootprintCells(actorPresentationSize(map, actor) > 1 ? actor : { ...actor, footprint: undefined })
      .some((point) => cells.has(key(point)) && revealedAt(map, point.x, point.y)))
}

export type SpellTargetPreview = {
  cells: ReadonlySet<string>
  origin: BoardPoint
  target: BoardPoint
  targetAnchor?: 'cell-center' | 'grid-intersection'
  color: string
  blocked: boolean
}

/** Общий наземный прицел для 2D и 3D. Контур обводит точные клетки правил. */
export function createSpellTargetRenderer(preview: SpellTargetPreview): BoardEffectRenderer {
  return (context, scene) => {
    const { cellSize: size, map } = scene
    const visible = new Set([...preview.cells].filter((entry) => {
      const [x, y] = entry.split(',').map(Number)
      return revealedAt(map, x, y)
    }))
    const color = preview.blocked ? '#ed7771' : preview.color
    context.save()
    // Прямая и метки тоже обрезаются туманом, даже если оба конца видимы.
    context.beginPath()
    for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
      if (revealedAt(map, x, y)) context.rect(x * size, y * size, size, size)
    }
    context.clip()
    context.fillStyle = color
    context.globalAlpha = preview.blocked ? .09 : .24
    for (const entry of visible) {
      const [x, y] = entry.split(',').map(Number)
      context.fillRect(x * size, y * size, size, size)
    }
    context.globalAlpha = 1
    context.strokeStyle = color
    context.lineWidth = Math.max(1.5, size * .045)
    context.setLineDash(preview.blocked ? [size * .16, size * .12] : [])
    context.beginPath()
    for (const entry of visible) {
      const [x, y] = entry.split(',').map(Number)
      // Внутренние границы убраны: область читается единым силуэтом.
      for (const [dx, dy, ax, ay, bx, by] of [[0, -1, 0, 0, 1, 0], [1, 0, 1, 0, 1, 1], [0, 1, 1, 1, 0, 1], [-1, 0, 0, 1, 0, 0]]) {
        if (visible.has(`${x + dx},${y + dy}`)) continue
        context.moveTo((x + ax) * size, (y + ay) * size)
        context.lineTo((x + bx) * size, (y + by) * size)
      }
    }
    context.strokeStyle = '#30221d'
    context.lineWidth = Math.max(3.5, size * .09)
    context.stroke()
    context.strokeStyle = color
    context.lineWidth = Math.max(1.8, size * .05)
    context.stroke()
    context.setLineDash([size * .16, size * .12])
    context.globalAlpha = .8
    context.beginPath()
    const targetOffset = preview.targetAnchor === 'grid-intersection' ? 0 : .5
    context.moveTo((preview.origin.x + .5) * size, (preview.origin.y + .5) * size)
    context.lineTo((preview.target.x + targetOffset) * size, (preview.target.y + targetOffset) * size)
    context.stroke()
    context.setLineDash([])
    context.globalAlpha = 1
    const tx = (preview.target.x + targetOffset) * size, ty = (preview.target.y + targetOffset) * size
    context.beginPath()
    context.arc(tx, ty, size * .28, 0, Math.PI * 2)
    context.moveTo(tx - size * .44, ty); context.lineTo(tx + size * .44, ty)
    context.moveTo(tx, ty - size * .44); context.lineTo(tx, ty + size * .44)
    context.strokeStyle = '#2a201b'
    context.lineWidth = Math.max(3.5, size * .085)
    context.globalAlpha = .8
    context.stroke()
    context.strokeStyle = color
    context.lineWidth = Math.max(1.5, size * .045)
    context.globalAlpha = 1
    context.stroke()
    context.restore()
  }
}

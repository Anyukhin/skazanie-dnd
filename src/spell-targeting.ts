import type { BoardEffectRenderer } from './board-render'
import type { BoardPoint } from './combat-animation'
import type { ActorFootprint, TacticalMap } from './types'
import { cellAt, edgeBetween, movementStepBlocked, revealedAt } from './tactical-map-client'
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

function sightEdgeBlocked(map: TacticalMap, from: BoardPoint, to: BoardPoint) {
  const dx = Math.sign(to.x - from.x)
  const dy = Math.sign(to.y - from.y)
  const candidates = Math.abs(dx) + Math.abs(dy) === 1
    ? [[from, to] as const]
    : dx && dy
      ? [[from, { x: from.x + dx, y: from.y }] as const, [from, { x: from.x, y: from.y + dy }] as const]
      : []
  return candidates.some(([start, end]) => {
    const edge = edgeBetween(map, start.x, start.y, end.x, end.y)
    return edge?.blocksSight === true
      || edge?.kind === 'door' && movementStepBlocked(map, start.x, start.y, end.x, end.y)
  })
}

function openCell(map: TacticalMap, point: BoardPoint) {
  return cellAt(map, point.x, point.y)?.passable === true
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
  const result = new Set<string>()
  for (const cell of cells) {
    // Большая цель может занимать соседние клетки, но LoE проверяется только
    // по её части, попавшей в исходную геометрию области. Иначе footprint
    // способен «спасти» клетку, которую сама область не покрывает.
    const targets = targetCells(cell).filter((target) => areaKeys.has(key(target)))
    if (targets.some((target) => origins.some((origin) => spreads
      ? canFloodTo(map, origin, target, Number(options.radiusFeet) || 0)
      : clearStraightLoE(map, origin, target)))) result.add(key(cell))
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
    context.moveTo((preview.origin.x + .5) * size, (preview.origin.y + .5) * size)
    context.lineTo((preview.target.x + .5) * size, (preview.target.y + .5) * size)
    context.stroke()
    context.setLineDash([])
    context.globalAlpha = 1
    const tx = (preview.target.x + .5) * size, ty = (preview.target.y + .5) * size
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

// @ts-check
import { createHash } from 'node:crypto'

import { progressionWaves, reachableZones, validateSceneGraph } from './scene-graph.mjs'
import {
  SIZE_CLASSES,
  addZone,
  cellAt,
  createTacticalMap,
  doorwayEdgeAt,
  floorVariantAt,
  reachableCells,
  setCell,
  setDoor,
  setEdge,
  validateTacticalMap,
} from './tactical-map.mjs'

/**
 * Стадия 2 генератора сцены — граф превращается в клетки, рёбра и зоны
 * (`docs/tactical-map-plan.md`, раздел 8).
 *
 * Топология уже проверена стадией 1: достижимость цели и порядок ключей
 * разобраны на графе. Здесь решается только геометрия, и её задача —
 * **не потерять** проверенную топологию: связь графа обязана стать настоящим
 * проходом между двумя помещениями, а запертая связь — запертой дверью.
 *
 * Помещения нарезаются двоичным разбиением прямоугольника. Соседние листья
 * разбиения смежны по построению, поэтому зоны раскладываются по листьям в
 * порядке волн из стадии 1: связанные зоны попадают рядом, и связь становится
 * проёмом в общей стене, а не коридором через полкарты.
 */

export const GRAPH_LAYOUT = Object.freeze({ id: 'graph-layout', version: '1' })

/**
 * @param {string|number} seed
 * @returns {() => number}
 */
function randomFor(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/**
 * @typedef {object} LeafRect
 * @property {number} minX
 * @property {number} minY
 * @property {number} maxX
 * @property {number} maxY
 */

/**
 * Двоичное разбиение прямоугольника на нужное число листьев. Режется всегда
 * самый большой лист — так помещения получаются соизмеримыми, а не одно во всю
 * карту и щель рядом.
 *
 * @param {LeafRect} area
 * @param {number} count
 * @param {() => number} random
 * @param {number} minimum минимальная сторона помещения вместе со стенами
 * @returns {LeafRect[]}
 */
export function splitArea(area, count, random, minimum = 5) {
  /** @type {LeafRect[]} */
  let leaves = [{ ...area }]
  let guard = 0
  while (leaves.length < count && guard < count * 8) {
    guard += 1
    leaves.sort((left, right) => (
      (right.maxX - right.minX) * (right.maxY - right.minY) - (left.maxX - left.minX) * (left.maxY - left.minY)
    ))
    const target = leaves.shift()
    if (!target) break
    const width = target.maxX - target.minX + 1
    const height = target.maxY - target.minY + 1
    const canSplitX = width >= minimum * 2 + 1
    const canSplitY = height >= minimum * 2 + 1
    if (!canSplitX && !canSplitY) {
      leaves.push(target)
      break
    }
    const vertical = canSplitX && (!canSplitY || (width >= height ? random() < 0.8 : random() < 0.2))
    if (vertical) {
      const low = target.minX + minimum
      const high = target.maxX - minimum
      const cut = low + Math.floor(random() * Math.max(1, high - low + 1))
      leaves.push({ ...target, maxX: cut }, { ...target, minX: cut })
    } else {
      const low = target.minY + minimum
      const high = target.maxY - minimum
      const cut = low + Math.floor(random() * Math.max(1, high - low + 1))
      leaves.push({ ...target, maxY: cut }, { ...target, minY: cut })
    }
  }
  // Порядок обязан быть детерминированным и предсказуемым: сверху вниз, слева
  // направо — тогда вход оказывается у края карты.
  return leaves.sort((left, right) => left.minY - right.minY || left.minX - right.minX)
}

/**
 * Смежны ли два прямоугольника по стене, и где именно.
 *
 * @param {LeafRect} a
 * @param {LeafRect} b
 * @returns {{axis: 'x'|'y', at: number, from: number, to: number}|null}
 */
export function sharedWall(a, b) {
  // Общая вертикальная стена: правый край одного совпадает с левым краем другого.
  for (const [left, right] of [[a, b], [b, a]]) {
    if (left.maxX === right.minX) {
      const from = Math.max(left.minY, right.minY) + 1
      const to = Math.min(left.maxY, right.maxY) - 1
      if (to >= from) return { axis: 'x', at: left.maxX, from, to }
    }
  }
  for (const [top, bottom] of [[a, b], [b, a]]) {
    if (top.maxY === bottom.minY) {
      const from = Math.max(top.minX, bottom.minX) + 1
      const to = Math.min(top.maxX, bottom.maxX) - 1
      if (to >= from) return { axis: 'y', at: top.maxY, from, to }
    }
  }
  return null
}

/**
 * Раскладывает зоны графа по листьям так, чтобы связанные зоны оказались
 * рядом. Порядок обхода — волны стадии 1: вход первым, за ним то, что от него
 * открывается.
 *
 * @param {import('./scene-graph.mjs').SceneGraph} graph
 * @param {LeafRect[]} leaves
 * @returns {Map<string, LeafRect>}
 */
export function assignZonesToLeaves(graph, leaves) {
  const order = progressionWaves(graph).flatMap((wave) => wave.zones)
  for (const zone of graph.zones) if (!order.includes(zone.id)) order.push(zone.id)
  /** @type {Map<string, LeafRect>} */
  const placed = new Map()
  const free = [...leaves]
  for (const zoneId of order) {
    if (!free.length) break
    // Ищем лист, смежный с уже размещённым соседом по графу: тогда связь
    // станет проёмом в общей стене.
    const neighbours = graph.links
      .filter((link) => link.from === zoneId || link.to === zoneId)
      .map((link) => (link.from === zoneId ? link.to : link.from))
      .map((id) => placed.get(id))
      .filter(Boolean)
    let index = 0
    if (neighbours.length) {
      const found = free.findIndex((leaf) => neighbours.some((neighbour) => sharedWall(leaf, /** @type {LeafRect} */ (neighbour))))
      if (found >= 0) index = found
    }
    placed.set(zoneId, free.splice(index, 1)[0])
  }
  return placed
}

/**
 * @typedef {object} GraphLayoutResult
 * @property {import('./tactical-map.mjs').TacticalMap} map
 * @property {Map<string, LeafRect>} rooms
 * @property {string[]} warnings
 */

/**
 * Собирает карту по графу зон.
 *
 * @param {import('./scene-graph.mjs').SceneGraph} graph
 * @param {object} [options]
 * @param {string} [options.seed]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {string} [options.locationId]
 * @param {string} [options.theme]
 * @param {string} [options.material] материал пола помещений
 * @returns {GraphLayoutResult}
 */
export function layoutSceneGraph(graph, {
  seed = 'graph',
  width = 26,
  height = 26,
  locationId = '',
  theme = 'dungeon',
  material = 'stone',
} = {}) {
  const safeWidth = Math.max(12, Math.min(SIZE_CLASSES.area.maxWidth, Math.round(width)))
  const safeHeight = Math.max(12, Math.min(SIZE_CLASSES.area.maxHeight, Math.round(height)))
  const random = randomFor(`${GRAPH_LAYOUT.id}:${GRAPH_LAYOUT.version}:${seed}`)
  /** @type {string[]} */
  const warnings = []

  const map = createTacticalMap({
    width: safeWidth,
    height: safeHeight,
    locationId,
    seed: String(seed),
    generator: { ...GRAPH_LAYOUT },
    theme,
    sizeClass: safeWidth * safeHeight <= SIZE_CLASSES.arena.maxCells ? 'arena' : 'area',
  })
  for (const [zoneIndex, zone] of graph.zones.entries()) {
    addZone(map, {
      id: zone.id,
      kind: zone.kind === 'exterior' ? 'exterior' : 'interior',
      material: zone.kind === 'exterior' ? 'grass' : material,
      lightLevel: zone.kind === 'exterior' ? 'bright' : 'dim',
      floorDirection: zoneIndex % 2 === 0 ? 'horizontal' : 'vertical',
      label: zone.label || zone.id,
    })
  }
  addZone(map, { id: 'rock', kind: 'interior', material, lightLevel: 'dark', floorDirection: 'horizontal', label: '' })

  // Всё, что не помещение, — сплошная порода: карта заведомо непроходима, и
  // проходимость появляется только внутри комнат.
  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      setCell(map, x, y, { passable: false, material, zone: 'rock', variant: floorVariantAt(seed, x, y), revealed: false })
    }
  }

  const leaves = splitArea({ minX: 0, minY: 0, maxX: safeWidth - 1, maxY: safeHeight - 1 }, graph.zones.length, random)
  if (leaves.length < graph.zones.length) {
    warnings.push(`карта вмещает ${leaves.length} помещений, а зон ${graph.zones.length}`)
  }
  const rooms = assignZonesToLeaves(graph, leaves)

  for (const [zoneId, rect] of rooms) {
    const zone = graph.zones.find((entry) => entry.id === zoneId)
    for (let y = rect.minY + 1; y <= rect.maxY - 1; y += 1) {
      for (let x = rect.minX + 1; x <= rect.maxX - 1; x += 1) {
        setCell(map, x, y, {
          passable: true,
          material: zone?.kind === 'exterior' ? 'grass' : material,
          zone: zoneId,
          variant: floorVariantAt(seed, x, y),
        })
      }
    }
  }

  // Стены на рёбрах: граница между проходимой клеткой и породой.
  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      const own = cellAt(map, x, y)
      if (!own || own.passable) continue
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (cellAt(map, x + dx, y + dy)?.passable) {
          setEdge(map, x, y, x + dx, y + dy, { kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' })
        }
      }
    }
  }

  // Связи графа становятся проёмами. Без этого проверенная стадией 1
  // достижимость не доживает до геометрии.
  for (const link of graph.links) {
    const a = rooms.get(link.from)
    const b = rooms.get(link.to)
    if (!a || !b) { warnings.push(`связь ${link.id}: одна из зон не размещена`); continue }
    const wall = sharedWall(a, b)
    if (!wall) { warnings.push(`связь ${link.id}: помещения не смежны, проход не построен`); continue }
    const middle = Math.floor((wall.from + wall.to) / 2)
    const x = wall.axis === 'x' ? wall.at : middle
    const y = wall.axis === 'x' ? middle : wall.at
    carveDoorway(map, x, y, link, material)
  }

  const spawn = rooms.get(graph.entranceZoneId)
  if (spawn) {
    const point = { x: Math.floor((spawn.minX + spawn.maxX) / 2), y: Math.floor((spawn.minY + spawn.maxY) / 2) }
    map.spawnPoints.push({ id: 'party-entrance', x: point.x, y: point.y, role: 'party' })
    // Отряд видит помещение, в которое вошёл.
    for (let y = spawn.minY; y <= spawn.maxY; y += 1) {
      for (let x = spawn.minX; x <= spawn.maxX; x += 1) if (cellAt(map, x, y)) setCell(map, x, y, { revealed: true })
    }
  } else {
    warnings.push('зона входа не размещена, точки появления нет')
  }

  map.overlays = {
    compass: true,
    scaleBar: true,
    roomLabels: graph.zones.filter((zone) => zone.label).map((zone) => ({ zoneId: zone.id, label: zone.label })),
  }
  return { map, rooms, warnings }
}

/**
 * Прорубает проём в стене между двумя помещениями и ставит на него дверь по
 * виду связи. Открытая связь остаётся просто проходом.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {number} x
 * @param {number} y
 * @param {import('./scene-graph.mjs').SceneLink} link
 * @param {string} material
 */
function carveDoorway(map, x, y, link, material) {
  if (!cellAt(map, x, y)) return
  setCell(map, x, y, { passable: true, material, zone: '' })
  // Рёбра-стены вокруг проёма были построены, пока он был породой. Проём
  // обязан их снять, иначе клетка станет проходимой, но окружённой стенами.
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const neighbor = cellAt(map, x + dx, y + dy)
    if (!neighbor || !neighbor.passable) continue
    setEdge(map, x, y, x + dx, y + dy, { kind: 'none' })
  }
  if (link.kind === 'open') return

  // Ребро выбирается поперёк прохода. Прежде направление угадывалось условием
  // «восток проходим, а юг нет», и на вертикальном проходе дверь садилась на
  // глухое ребро в породу: полотно было, а перекрывать ему было нечего.
  const edge = doorwayEdgeAt(map, x, y)
  if (!edge) return
  setDoor(map, {
    id: `door-${link.id}`,
    x: edge.x,
    y: edge.y,
    dir: edge.dir,
    // Состояние двери — начальное; дальше оно живёт в состоянии сцены.
    state: link.kind === 'locked' ? 'locked' : 'closed',
    lockDc: link.kind === 'locked' ? 15 : 0,
    keyItemId: link.keyId,
    // Признаки стены — про сам проём: он открыт. Перекрывает проход полотно
    // двери, и спрашивают о нём отдельно (`doorBlocksStep`).
    blocksMove: false,
    blocksSight: false,
  })
}

/**
 * Собирает карту и проверяет, что геометрия не потеряла топологию: каждая
 * зона, достижимая на графе, обязана быть достижима и по клеткам.
 *
 * @param {import('./scene-graph.mjs').SceneGraph} graph
 * @param {object} [options]
 * @returns {{map: import('./tactical-map.mjs').TacticalMap, warnings: string[], errors: Array<{code: string, message: string, at?: string}>}}
 */
export function buildSceneFromGraph(graph, options = {}) {
  const graphReport = validateSceneGraph(graph)
  if (!graphReport.ok) {
    return { map: layoutSceneGraph(graph, options).map, warnings: [], errors: graphReport.errors }
  }
  const built = layoutSceneGraph(graph, options)
  const errors = [...validateTacticalMap(built.map).errors]

  const spawn = built.map.spawnPoints.find((point) => point.role === 'party')
  if (!spawn) errors.push({ code: 'SPAWN_POINT_MISSING', message: 'Точка появления отряда не построена' })
  else {
    // Двери, запертые по построению, при обходе не открываются — поэтому
    // достижимость по клеткам сравнивается с достижимостью по графу, где ключи
    // уже учтены.
    const reachedCells = reachableCells(built.map, spawn.x, spawn.y, { throughDoors: true })
    const reachedZones = reachableZones(graph).zones
    for (const zoneId of reachedZones) {
      const rect = built.rooms.get(zoneId)
      if (!rect) continue
      let found = false
      for (let y = rect.minY + 1; y <= rect.maxY - 1 && !found; y += 1) {
        for (let x = rect.minX + 1; x <= rect.maxX - 1 && !found; x += 1) {
          if (reachedCells.has(`${x},${y}`)) found = true
        }
      }
      if (!found) {
        errors.push({
          code: 'GEOMETRY_LOST_TOPOLOGY',
          message: `Зона ${zoneId} достижима на графе, но не по клеткам`,
          at: zoneId,
        })
      }
    }
  }
  return { map: built.map, warnings: built.warnings, errors }
}

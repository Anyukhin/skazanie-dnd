#!/usr/bin/env node
// @ts-check
/**
 * Сборщик authored tactical maps из pixel-layout contract.
 *
 * Layout описывает рисунок карты в координатах исходного изображения. Сборщик
 * переводит его в клетки, строит server-owned floors/walls/doors/props/spawns,
 * проверяет связность и пишет как общий catalog, так и отдельные JSON-файлы для
 * ImageGen/ручной проверки.
 *
 * Пример:
 *   node tools/build-authored-location-maps.mjs \
 *     --layout data/authored-location-layouts-ares-v1.json \
 *     --out data/authored-location-maps-v1.json \
 *     --export-dir tmp/authored-maps
 *
 * Несколько --layout объединяются. Существующий catalog в --out сохраняется:
 * карта с тем же locationId заменяется новой версией, остальные записи остаются.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assetById } from '../server/asset-registry.mjs'
import { sceneInteractionCatalogEntry } from '../server/scene-interactions.mjs'
import { AUTHORED_LOCATION_MAP_MARKER } from '../server/authored-location-maps.mjs'
import {
  addProp,
  addSpawnPoint,
  addZone,
  cellAt,
  edgeBetween,
  edgeNeighbor,
  edgeList,
  createTacticalMap,
  deserializeTacticalMap,
  reachableCells,
  serializeTacticalMap,
  setCell,
  setDoor,
  setEdge,
  validateTacticalMap,
  movementStepBlocked,
} from '../server/tactical-map.mjs'

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const DEFAULT_CATALOG = resolve(ROOT, 'data/authored-location-maps-v1.json')
const DEFAULT_EXPORT_DIR = resolve(ROOT, 'tmp/authored-maps')
const CATALOG_VERSION = 1
const MAP_MARKER_VERSION = 1
const LOCATION_ID = /^[a-z0-9][a-z0-9_-]{0,119}$/u
const MATERIALS = new Set(['stone', 'wood', 'earth', 'grass', 'sand', 'metal', 'marble', 'ice'])
const SURFACES = new Set(['none', 'water', 'ice', 'oil', 'mud', 'rubble'])

/** @typedef {import('../server/tactical-map.mjs').TacticalMap} TacticalMap */

/**
 * @typedef {{
 *   kind?: string,
 *   x?: number,
 *   y?: number,
 *   w?: number,
 *   h?: number,
 *   cx?: number,
 *   cy?: number,
 *   rx?: number,
 *   ry?: number,
 *   r?: number,
 *   points?: number[][],
 *   polygon?: number[][],
 *   rect?: number[],
 *   ellipse?: number[],
 *   circle?: number[],
 * }} Shape
 */

/**
 * @typedef {{
 *   id: string,
 *   label?: string,
 *   kind: 'interior'|'exterior',
 *   material?: string,
 *   lightLevel?: string,
 *   shape?: Shape,
 * }} LayoutZone
 */

/**
 * @typedef {{
 *   location_id: string,
 *   name?: string,
 *   template_id?: string,
 *   width: number,
 *   height: number,
 *   source_width: number,
 *   source_height: number,
 *   seed?: string,
 *   theme?: string,
 *   generator?: { id?: string, version?: string },
 *   default_material?: string,
 *   default_zone?: string,
 *   zones: LayoutZone[],
 *   terrain?: Array<Record<string, any>>,
 *   walls?: Array<Record<string, any>>,
   *   doors?: Array<Record<string, any>>,
 *   props?: Array<Record<string, any>>,
 *   spawns?: Array<Record<string, any>>,
 *   spawn_points?: Array<Record<string, any>>,
 *   checks?: Array<Record<string, any>>,
 * }} LocationLayout
 */

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} должен быть объектом`)
  return /** @type {Record<string, any>} */ (value)
}

function finite(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback
}

function integer(value, fallback, minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback
}

function point(value, path) {
  if (!Array.isArray(value) || value.length < 2 || !Number.isFinite(Number(value[0])) || !Number.isFinite(Number(value[1]))) {
    throw new Error(`${path} должен быть парой координат`)
  }
  return [Number(value[0]), Number(value[1])]
}

function shapeKind(shape) {
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) return 'full'
  if (shape.kind) return String(shape.kind).toLocaleLowerCase('en')
  if (shape.polygon || shape.points) return 'polygon'
  if (shape.rect) return 'rect'
  if (shape.ellipse) return 'ellipse'
  if (shape.circle) return 'circle'
  return 'full'
}

/** @param {Shape|undefined} raw @param {number} sx @param {number} sy */
function containsShape(raw, sx, sy) {
  const shape = raw ?? {}
  const kind = shapeKind(shape)
  if (kind === 'full') return true
  if (kind === 'rect') {
    const rect = Array.isArray(shape.rect) ? shape.rect : [shape.x, shape.y, shape.w, shape.h]
    const [x, y, w, h] = rect.map((value, index) => finite(value, index < 2 ? 0 : 1))
    return sx >= x && sx < x + w && sy >= y && sy < y + h
  }
  if (kind === 'circle') {
    const circle = Array.isArray(shape.circle) ? shape.circle : [shape.cx, shape.cy, shape.r]
    const [cx, cy, r] = circle.map((value, index) => finite(value, index === 2 ? 1 : 0))
    return Math.hypot(sx - cx, sy - cy) <= Math.max(0, r)
  }
  if (kind === 'ellipse') {
    const ellipse = Array.isArray(shape.ellipse) ? shape.ellipse : [shape.cx, shape.cy, shape.rx, shape.ry]
    const [cx, cy, rx, ry] = ellipse.map((value, index) => finite(value, index < 2 ? 0 : 1))
    if (rx <= 0 || ry <= 0) return false
    return ((sx - cx) ** 2) / (rx ** 2) + ((sy - cy) ** 2) / (ry ** 2) <= 1
  }
  if (kind === 'polygon') {
    const source = shape.polygon ?? shape.points
    if (!Array.isArray(source) || source.length < 3) return false
    const points = source.map((entry, index) => point(entry, `shape.points[${index}]`))
    let inside = false
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
      const [x, y] = points[index]
      const [px, py] = points[previous]
      const crosses = ((y > sy) !== (py > sy)) && sx < ((px - x) * (sy - y)) / ((py - y) || Number.EPSILON) + x
      if (crosses) inside = !inside
    }
    return inside
  }
  return false
}

/** @param {LocationLayout} definition @param {Shape|undefined} shape @param {number} x @param {number} y */
function containsCell(definition, shape, x, y) {
  const cellWidth = definition.source_width / definition.width
  const cellHeight = definition.source_height / definition.height
  const left = x * cellWidth
  const top = y * cellHeight
  const samples = [
    [left + cellWidth * .5, top + cellHeight * .5],
    [left + cellWidth * .08, top + cellHeight * .08],
    [left + cellWidth * .92, top + cellHeight * .08],
    [left + cellWidth * .08, top + cellHeight * .92],
    [left + cellWidth * .92, top + cellHeight * .92],
  ]
  const inside = samples.filter(([sx, sy]) => containsShape(shape, sx, sy)).length
  // A single sample is enough for a deliberate narrow floor/round tower edge:
  // props are measured from the same source pixels, and dropping that sliver
  // would put the authoritative footprint on a wall one cell too early.
  return inside >= 1
}

/** @param {LocationLayout} definition @param {number[]} sourcePoint */
function cellForPoint(definition, sourcePoint) {
  const [sx, sy] = point(sourcePoint, `${definition.location_id}.point`)
  const x = Math.floor(sx * definition.width / definition.source_width)
  const y = Math.floor(sy * definition.height / definition.source_height)
  if (x < 0 || y < 0 || x >= definition.width || y >= definition.height) throw new Error(`${definition.location_id}: точка вне карты`)
  return { x, y }
}

/** @param {Record<string, any>} terrain */
function terrainShape(terrain) {
  return terrain.shape ?? terrain.geometry ?? terrain
}

function mapMaterial(value, fallback) {
  const material = String(value ?? fallback)
  return MATERIALS.has(material) ? material : fallback
}

function mapSurface(value) {
  const surface = String(value ?? 'none')
  return SURFACES.has(surface) ? surface : 'none'
}

/** @param {TacticalMap} map @param {{x:number,y:number}} spawn @param {number} maximum */
export function revealInitialArea(map, spawn, maximum = 8) {
  const distances = new Map([[`${spawn.x},${spawn.y}`, 0]])
  const queue = [{ x: spawn.x, y: spawn.y }]
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    const distance = distances.get(`${current.x},${current.y}`) ?? 0
    const cell = cellAt(map, current.x, current.y)
    if (!cell?.passable) continue
    setCell(map, current.x, current.y, { revealed: true })
    if (distance >= maximum) continue
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const next = { x: current.x + dx, y: current.y + dy }
      const nextCell = cellAt(map, next.x, next.y)
      const key = `${next.x},${next.y}`
      if (!nextCell?.passable || movementStepBlocked(map, current.x, current.y, next.x, next.y) || distances.has(key)) continue
      distances.set(key, distance + 1)
      queue.push(next)
    }
  }
}

/**
 * @param {LocationLayout} definition
 * @returns {TacticalMap}
 */
export function buildAuthoredLocationMap(definition) {
  const source = object(definition, 'layout')
  const locationId = String(source.location_id ?? '')
  if (!LOCATION_ID.test(locationId)) throw new Error('layout.location_id имеет неверный идентификатор')
  const width = integer(source.width, 0, 1, 100)
  const height = integer(source.height, 0, 1, 100)
  const sourceWidth = finite(source.source_width, 0)
  const sourceHeight = finite(source.source_height, 0)
  if (!width || !height || sourceWidth <= 0 || sourceHeight <= 0) throw new Error(`${locationId}: неверный размер карты или исходника`)
  const zones = Array.isArray(source.zones) ? source.zones : []
  if (!zones.length) throw new Error(`${locationId}: zones не должен быть пустым`)
  const defaultMaterial = mapMaterial(source.default_material, 'stone')
  const defaultZone = String(source.default_zone ?? zones[0].id ?? '')
  const zoneIds = new Set()
  for (const [index, zone] of zones.entries()) {
    const id = String(zone?.id ?? '')
    if (!id || zoneIds.has(id)) throw new Error(`${locationId}: повтор зоны в zones[${index}]`)
    zoneIds.add(id)
  }
  const seed = String(source.seed ?? `authored-location:${locationId}:v${MAP_MARKER_VERSION}`)
  const marker = `authored-${source.native_grid ? 'tactical' : 'location'}:${locationId}:v${MAP_MARKER_VERSION}`
  const map = createTacticalMap({
    width,
    height,
    locationId,
    seed,
    generator: { id: String(source.generator?.id ?? 'authored-location-map'), version: String(source.generator?.version ?? '1') },
    theme: String(source.theme ?? 'authored-location'),
    tilesetId: marker,
    sizeClass: width * height > 3_600 ? 'region' : width * height > 900 ? 'area' : 'arena',
  })
  for (const zone of zones) {
    addZone(map, {
      id: String(zone.id),
      kind: zone.kind === 'exterior' ? 'exterior' : 'interior',
      material: mapMaterial(zone.material, defaultMaterial),
      lightLevel: String(zone.lightLevel ?? 'bright'),
      floorDirection: String(zone.floorDirection ?? 'horizontal'),
      label: String(zone.label ?? zone.id),
    })
  }
  const zoneById = new Map(map.zones.map((zone) => [zone.id, zone]))
  if (defaultZone && !zoneById.has(defaultZone)) throw new Error(`${locationId}: default_zone не объявлена`)

  /** @typedef {{ present: boolean, passable: boolean, zone: string, material: string, surface: string, elevation: number, moveCost: number, revealed: boolean, hazardId?: string }} CellDraft */
  /** @type {CellDraft[][]} */
  const drafts = Array.from({ length: height }, () => Array.from({ length: width }, () => ({
    present: true,
    passable: false,
    zone: defaultZone,
    material: defaultMaterial,
    surface: 'none',
    elevation: 0,
    moveCost: 1,
    revealed: false,
  })))
  const terrain = Array.isArray(source.terrain) ? source.terrain : []
  for (const rawTerrain of terrain) {
    const terrainEntry = object(rawTerrain, `${locationId}.terrain`)
    const shape = terrainShape(terrainEntry)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!containsCell({ ...source, width, height, source_width: sourceWidth, source_height: sourceHeight }, shape, x, y)) continue
        const draft = drafts[y][x]
        if (terrainEntry.present !== undefined) draft.present = terrainEntry.present !== false
        if (terrainEntry.passable !== undefined) draft.passable = terrainEntry.passable === true
        if (terrainEntry.zone !== undefined) {
          const zone = String(terrainEntry.zone)
          if (zone && !zoneById.has(zone)) throw new Error(`${locationId}: terrain ссылается на неизвестную зону ${zone}`)
          draft.zone = zone
        }
        if (terrainEntry.material !== undefined) draft.material = mapMaterial(terrainEntry.material, draft.material)
        if (terrainEntry.surface !== undefined) draft.surface = mapSurface(terrainEntry.surface)
        if (terrainEntry.elevation !== undefined) draft.elevation = integer(terrainEntry.elevation, draft.elevation, -128, 127)
        if (terrainEntry.moveCost !== undefined) draft.moveCost = integer(terrainEntry.moveCost, draft.moveCost, 1, 2)
        if (terrainEntry.revealed !== undefined) draft.revealed = terrainEntry.revealed === true
        if (terrainEntry.hazardId !== undefined) draft.hazardId = String(terrainEntry.hazardId)
        if (draft.surface === 'water') draft.passable = false
      }
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const draft = drafts[y][x]
      if (!draft.present) continue
      setCell(map, x, y, {
        passable: draft.passable,
        zone: draft.zone,
        material: draft.material,
        surface: draft.surface,
        elevation: draft.elevation,
        moveCost: draft.moveCost,
        revealed: draft.revealed,
        hazardId: draft.hazardId,
      })
    }
  }

  const layoutForShape = { ...source, width, height, source_width: sourceWidth, source_height: sourceHeight }
  const edgeFromSegment = (rawSegment) => {
    const segment = object(rawSegment, `${locationId}.wall_segment`)
    if (segment.dir) {
      const cell = segment.point ? cellForPoint(layoutForShape, segment.point) : { x: integer(segment.x, 0), y: integer(segment.y, 0) }
      const neighbor = segment.dir === 'e' ? { x: cell.x + 1, y: cell.y } : { x: cell.x, y: cell.y + 1 }
      return { ...cell, neighbor, kind: String(segment.kind ?? 'wall'), blocksMove: segment.blocksMove !== false, blocksSight: segment.blocksSight !== false, cover: segment.cover ?? 'three_quarters' }
    }
    const from = cellForPoint(layoutForShape, segment.from)
    const to = cellForPoint(layoutForShape, segment.to)
    if (Math.abs(from.x - to.x) + Math.abs(from.y - to.y) !== 1) throw new Error(`${locationId}: wall_segment должен соединять соседние клетки`)
    return { ...from, neighbor: to, kind: String(segment.kind ?? 'wall'), blocksMove: segment.blocksMove !== false, blocksSight: segment.blocksSight !== false, cover: segment.cover ?? 'three_quarters' }
  }
  const writeWall = (segment) => {
    const edge = edgeFromSegment(segment)
    if (edge.neighbor.x < 0 || edge.neighbor.y < 0 || edge.neighbor.x >= width || edge.neighbor.y >= height) return
    if (!cellAt(map, edge.x, edge.y) && !cellAt(map, edge.neighbor.x, edge.neighbor.y)) return
    setEdge(map, edge.x, edge.y, edge.neighbor.x, edge.neighbor.y, {
      kind: edge.kind,
      blocksMove: edge.blocksMove,
      blocksSight: edge.blocksSight,
      cover: edge.cover,
    })
  }
  for (const wall of (Array.isArray(source.walls) ? source.walls : [])) writeWall(wall)
  // Paint-order terrain creates walls wherever a floor meets a solid/absent
  // cell. Это сохраняет блокировку и линию взгляда без native wall sprite.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const own = cellAt(map, x, y)
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const next = cellAt(map, x + dx, y + dy)
        if (!own && !next) continue
        if (next && own && own.passable === next.passable) continue
        if (!next || !own || !own.passable || !next.passable) {
          if (!edgeBetween(map, x, y, x + dx, y + dy)) {
            const shore = own?.surface === 'water' || next?.surface === 'water'
            setEdge(map, x, y, x + dx, y + dy, { kind: shore ? 'rail' : 'wall', blocksMove: !shore, blocksSight: !shore, cover: shore ? 'half' : 'three_quarters' })
          }
        }
      }
    }
  }
  const rawDoors = Array.isArray(source.doors) ? source.doors : []
  for (const rawDoor of rawDoors) {
    const door = object(rawDoor, `${locationId}.door`)
    let from
    let to
    if (door.from && door.to) { from = cellForPoint(layoutForShape, door.from); to = cellForPoint(layoutForShape, door.to) }
    else {
      from = door.point ? cellForPoint(layoutForShape, door.point) : { x: integer(door.x, 0), y: integer(door.y, 0) }
      to = door.dir === 'e' ? { x: from.x + 1, y: from.y } : { x: from.x, y: from.y + 1 }
    }
    if (Math.abs(from.x - to.x) + Math.abs(from.y - to.y) !== 1) throw new Error(`${locationId}: дверь ${String(door.id)} должна соединять соседние клетки (${from.x},${from.y})-(${to.x},${to.y})`)
    if (!cellAt(map, from.x, from.y)?.passable || !cellAt(map, to.x, to.y)?.passable) throw new Error(`${locationId}: дверь ${String(door.id)} стоит не между двумя проходимыми клетками (${from.x},${from.y})-(${to.x},${to.y})`)
    setDoor(map, { id: String(door.id), x: from.x, y: from.y, dir: to.x !== from.x ? 'e' : 's', state: ['open', 'closed', 'locked', 'broken'].includes(String(door.state)) ? String(door.state) : 'open', lockDc: integer(door.lockDc, 0, 0, 40), keyItemId: door.keyItemId ?? null })
  }

  const rawProps = Array.isArray(source.props) ? source.props : []
  for (const rawProp of rawProps) {
    const prop = object(rawProp, `${locationId}.prop`)
    const id = String(prop.id ?? '')
    if (!id) throw new Error(`${locationId}: prop.id обязателен`)
    const assetId = String(prop.assetId ?? prop.asset ?? '')
    if (!assetId) throw new Error(`${locationId}: ${id} без assetId`)
    const registry = assetById(assetId.replace(/^painted:/u, ''))
    const rawRect = prop.rect
    const footprint = Array.isArray(prop.footprint)
      ? prop.footprint.map((entry, index) => {
        const [x, y] = Array.isArray(entry) ? entry : [entry?.x, entry?.y]
        return { x: integer(x, 0), y: integer(y, 0) }
      })
      : Array.isArray(rawRect)
        ? (() => {
          const [sx, sy, sw, sh] = rawRect.map((value, index) => finite(value, index < 2 ? 0 : 1))
          const x0 = Math.floor(sx * width / sourceWidth)
          const y0 = Math.floor(sy * height / sourceHeight)
          const x1 = Math.max(x0 + 1, Math.ceil((sx + sw) * width / sourceWidth))
          const y1 = Math.max(y0 + 1, Math.ceil((sy + sh) * height / sourceHeight))
          return Array.from({ length: Math.max(0, x1 - x0) * Math.max(0, y1 - y0) }, (_, index) => ({ x: x0 + index % Math.max(1, x1 - x0), y: y0 + Math.floor(index / Math.max(1, x1 - x0)) }))
        })()
        : []
    const position = prop.point ? cellForPoint(layoutForShape, prop.point) : rawRect ? cellForPoint(layoutForShape, [finite(rawRect[0], 0) + finite(rawRect[2], 0) / 2, finite(rawRect[1], 0) + finite(rawRect[3], 0) / 2]) : { x: integer(prop.x, 0), y: integer(prop.y, 0) }
    const defaults = registry ?? {}
    const interactionAssetId = assetId.replace(/^painted:/u, '')
    const hasSupportedVerbs = Boolean(sceneInteractionCatalogEntry(interactionAssetId)?.verbs?.length)
    const hasTransition = prop.transition !== undefined && prop.transition !== null
    addProp(map, {
      id,
      assetId,
      x: position.x + .5,
      y: position.y + .5,
      rotation: finite(prop.rotation, 0),
      scale: finite(prop.scale, 1),
      footprint,
      zOrder: integer(prop.zOrder, 0, -1_000, 1_000),
      blocksMove: prop.blocksMove ?? prop.blocks_move ?? defaults.blocksMove ?? false,
      blocksSight: prop.blocksSight ?? prop.blocks_sight ?? defaults.blocksSight ?? false,
      cover: prop.cover ?? defaults.cover ?? 'none',
      destructible: prop.destructible ?? defaults.destructible ?? false,
      hp: prop.hp ?? defaults.hp ?? 0,
      interactive: hasTransition || ((prop.interactive ?? defaults.interactive ?? false) === true && hasSupportedVerbs),
      state: prop.state,
      ...(hasTransition ? { transition: prop.transition } : {}),
    })
  }

  const rawSpawns = Array.isArray(source.spawns) ? source.spawns : (Array.isArray(source.spawn_points) ? source.spawn_points : [])
  for (const rawSpawn of rawSpawns) {
    const spawn = object(rawSpawn, `${locationId}.spawn`)
    const position = spawn.point ? cellForPoint(layoutForShape, spawn.point) : { x: integer(spawn.x, 0), y: integer(spawn.y, 0) }
    addSpawnPoint(map, { id: String(spawn.id), x: position.x, y: position.y, role: ['party', 'enemy', 'neutral'].includes(String(spawn.role)) ? String(spawn.role) : 'party' })
  }
  map.overlays = { compass: false, scaleBar: false, roomLabels: [] }
  const party = map.spawnPoints.find((spawn) => spawn.role === 'party')
  if (!party) throw new Error(`${locationId}: party spawn обязателен`)
  revealInitialArea(map, party, integer(source.reveal_distance, 8, 1, 30))
  const reached = reachableCells(map, party.x, party.y, { throughDoors: true })
  const passable = []
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (cellAt(map, x, y)?.passable) passable.push(`${x},${y}`)
  const disconnected = passable.filter((key) => !reached.has(key))
  if (disconnected.length) throw new Error(`${locationId}: недостижимы ${disconnected.length} клеток: ${disconnected.slice(0, 24).join(' ')}`)
  for (const rawCheck of Array.isArray(source.checks) ? source.checks : []) {
    const check = object(rawCheck, `${locationId}.check`)
    const position = check.point ? cellForPoint(layoutForShape, check.point) : { x: integer(check.x, 0), y: integer(check.y, 0) }
    const cell = cellAt(map, position.x, position.y)
    if (!cell?.passable || !reached.has(`${position.x},${position.y}`)) throw new Error(`${locationId}: check «${String(check.name ?? 'point')}» недостижим`)
  }
  const report = validateTacticalMap(map)
  if (!report.ok) throw new Error(`${locationId}: ${report.errors.map((error) => `${error.code}${error.at ? `(${error.at})` : ''}`).join(', ')}`)
  return map
}

/** @param {string} path */
function readLayoutFile(path) {
  const raw = JSON.parse(readFileSync(resolve(path), 'utf8'))
  const root = object(raw, path)
  if (root.schema_version !== 1) throw new Error(`${path}: schema_version должен быть 1`)
  const layouts = Array.isArray(root.layouts) ? root.layouts : []
  if (!layouts.length) throw new Error(`${path}: layouts не должен быть пустым`)
  return layouts.map((layout) => ({ ...layout, template_id: layout.template_id ?? root.template_id }))
}

/** @param {string} path */
function readExistingCatalog(path) {
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return (Array.isArray(raw?.maps) ? raw.maps : []).map((entry, index) => {
      const source = object(entry, `${path}.maps[${index}]`)
      const map = deserializeTacticalMap(source.map && typeof source.map === 'object' && !Array.isArray(source.map) ? source.map : source)
      const report = validateTacticalMap(map)
      if (!report.ok) throw new Error(`${path}.maps[${index}] невалидна: ${report.errors.map((error) => error.code).join(', ')}`)
      if (!AUTHORED_LOCATION_MAP_MARKER.test(map.tilesetId)) throw new Error(`${path}.maps[${index}] имеет неверный authored tilesetId`)
      return serializeTacticalMap(map)
    })
  } catch (error) {
    throw new Error(`Не удалось прочитать существующий catalog ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * @param {{layoutPaths: string[], outputPath?: string, exportDir?: string}} options
 */
export function buildAuthoredLocationMaps({ layoutPaths, outputPath = DEFAULT_CATALOG, exportDir = DEFAULT_EXPORT_DIR } = {}) {
  const layouts = (layoutPaths ?? []).flatMap(readLayoutFile)
  if (resolve(outputPath) === DEFAULT_CATALOG && layouts.some((layout) => layout.native_grid !== true)) {
    throw new Error('Основной authored-location catalog принимает только layout с native_grid=true; legacy layout экспортируйте в отдельный --out')
  }
  const byId = new Map(readExistingCatalog(outputPath).map((map) => [String(map.locationId), map]))
  for (const layout of layouts) {
    const map = buildAuthoredLocationMap(layout)
    const serialized = serializeTacticalMap(map)
    byId.set(map.locationId, serialized)
  }
  const maps = [...byId.values()].sort((left, right) => String(left.locationId).localeCompare(String(right.locationId)))
  mkdirSync(resolve(exportDir), { recursive: true })
  for (const map of maps.filter((entry) => layouts.some((layout) => layout.location_id === entry.locationId))) {
    writeFileSync(resolve(exportDir, `${map.locationId}.json`), `${JSON.stringify(map)}\n`)
  }
  mkdirSync(dirname(resolve(outputPath)), { recursive: true })
  writeFileSync(resolve(outputPath), `${JSON.stringify({ schema_version: CATALOG_VERSION, maps }, null, 2)}\n`)
  return { maps, layouts, outputPath: resolve(outputPath), exportDir: resolve(exportDir) }
}

/** @param {string[]} argv @param {string} name */
function optionValues(argv, name) {
  const values = []
  for (let index = 0; index < argv.length; index += 1) if (argv[index] === name && argv[index + 1] && !argv[index + 1].startsWith('--')) values.push(argv[++index])
  return values
}

if (process.argv[1] && process.argv[1].endsWith('build-authored-location-maps.mjs')) {
  try {
    const argv = process.argv.slice(2)
    const layoutPaths = [...optionValues(argv, '--layout'), ...optionValues(argv, '--input')]
    if (!layoutPaths.length) throw new Error('Укажите хотя бы один --layout <file>')
    const [outputPath] = optionValues(argv, '--out')
    const [exportDir] = optionValues(argv, '--export-dir')
    const result = buildAuthoredLocationMaps({ layoutPaths, outputPath, exportDir })
    process.stdout.write(`${JSON.stringify({ ok: true, maps: result.maps.length, layouts: result.layouts.length, output: result.outputPath, exportDir: result.exportDir }, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`)
    process.exitCode = 1
  }
}

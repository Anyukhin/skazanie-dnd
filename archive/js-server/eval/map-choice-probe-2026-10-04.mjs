// Исследовательский измеритель: читает генераторы, выводит синтетический JSON,
// не загружает кампании и не пишет файлы. Это не расчёт доступного хода героя.
// baseline_reference — ревизия первого замера, не автоматически определённый HEAD.
import { MAP_PREVIEW_PRESETS, auditTacticalMap } from '../server/map-quality.mjs'
import { generateSceneGeometry } from '../server/adventure-director.mjs'
import { cellAt, edgeBetween, edgeNeighbor } from '../server/tactical-map.mjs'

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const key = (x, y) => `${x},${y}`
const pointOf = (value) => { const [x, y] = value.split(',').map(Number); return { x, y } }

function blockedProps(map) {
  const blocked = new Set()
  for (const prop of map.props ?? []) {
    if (!prop.blocksMove || prop.mount) continue
    const cells = prop.footprint?.length ? prop.footprint : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]
    for (const cell of cells) blocked.add(key(cell.x, cell.y))
  }
  return blocked
}

function edgeAllowed(map, from, to, skipDoorId = null) {
  const edge = edgeBetween(map, from.x, from.y, to.x, to.y)
  if (!edge) return true
  if (edge.doorId && edge.doorId === skipDoorId) return false
  if (edge.kind === 'door') return true
  return edge.blocksMove !== true
}

function routeSearch(map, start, targets, { skipDoorId = null, weighted = false } = {}) {
  const blocked = blockedProps(map)
  const startKey = key(start.x, start.y)
  if (!cellAt(map, start.x, start.y)?.passable || blocked.has(startKey)) return null
  const dist = new Map([[startKey, 0]])
  const prev = new Map()
  const frontier = [{ k: startKey, d: 0 }]
  const pop = () => {
    frontier.sort((a, b) => a.d - b.d || a.k.localeCompare(b.k))
    return frontier.shift()
  }
  while (frontier.length) {
    const current = pop()
    if (!current || current.d !== dist.get(current.k)) continue
    if (targets.has(current.k)) {
      const path = []
      for (let cursor = current.k; cursor && cursor !== startKey; cursor = prev.get(cursor)) path.unshift(pointOf(cursor))
      return { cost: current.d, path, reached: current.k }
    }
    const from = pointOf(current.k)
    for (const [dx, dy] of DIRS) {
      const to = { x: from.x + dx, y: from.y + dy }
      const toKey = key(to.x, to.y)
      const cell = cellAt(map, to.x, to.y)
      if (!cell?.passable || blocked.has(toKey) || !edgeAllowed(map, from, to, skipDoorId)) continue
      const weight = weighted ? 5 * Math.max(1, Number(cell.moveCost) || 1) : 1
      const next = current.d + weight
      if (next >= (dist.get(toKey) ?? Number.POSITIVE_INFINITY)) continue
      dist.set(toKey, next)
      prev.set(toKey, current.k)
      frontier.push({ k: toKey, d: next })
    }
  }
  return null
}

function zoneTarget(map, zoneId) {
  const blocked = blockedProps(map)
  const targets = new Set()
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (cell?.passable && cell.zone === zoneId && !blocked.has(key(x, y))) targets.add(key(x, y))
  }
  return targets
}

function doorIngress(map, zoneId) {
  const ingress = []
  for (const door of map.doors ?? []) {
    const a = { x: door.x, y: door.y }
    const b = edgeNeighbor(door)
    const za = cellAt(map, a.x, a.y)?.zone ?? ''
    const zb = cellAt(map, b.x, b.y)?.zone ?? ''
    if ((za === zoneId && zb !== zoneId) || (zb === zoneId && za !== zoneId)) ingress.push({ id: door.id, state: door.state, other: za === zoneId ? zb : za })
  }
  return ingress
}

function coverProbe(map) {
  const coverAt = new Set()
  for (const prop of map.props ?? []) {
    if (!prop.cover || prop.cover === 'none') continue
    const cells = prop.footprint?.length ? prop.footprint : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]
    for (const cell of cells) for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) coverAt.add(key(cell.x + dx, cell.y + dy))
  }
  return (x, y) => {
    if (coverAt.has(key(x, y))) return true
    for (const [dx, dy] of DIRS) {
      const cell = cellAt(map, x + dx, y + dy)
      if (cell && !cell.passable) return true
      const edge = edgeBetween(map, x, y, x + dx, y + dy)
      if (edge?.blocksMove || edge?.blocksSight) return true
    }
    return false
  }
}

function zoneMetrics(map, party) {
  const hasCover = coverProbe(map)
  const zones = []
  for (const zone of (map.zones ?? []).filter((entry) => entry.kind === 'interior' && entry.id !== 'rock')) {
    const targets = zoneTarget(map, zone.id)
    if (!targets.size) continue
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity
    for (const raw of targets) { const p = pointOf(raw); minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y) }
    const route = routeSearch(map, party, targets, { weighted: true })
    const ingress = doorIngress(map, zone.id)
    let alternativeIngress = 0
    // Для стартовой зоны сама точка появления уже внутри цели: удаление двери
    // не является альтернативным подходом к ней.
    if (route && route.cost > 0) for (const door of ingress) if (routeSearch(map, party, targets, { skipDoorId: door.id })) alternativeIngress += 1
    if (!route) {
      zones.push({ id: zone.id, label: zone.label, area: targets.size, bbox: [maxX - minX + 1, maxY - minY + 1], path_ft: null, turns_30ft: null, exposed_steps: null, exposed_share: null, ingress_doors: ingress.length, alternative_ingress: alternativeIngress })
      continue
    }
    const routeCells = [{ ...party }, ...route.path]
    const approach = routeCells.slice(0, -1)
    const exposedSteps = approach.filter((p) => !hasCover(p.x, p.y)).length
    zones.push({ id: zone.id, label: zone.label, area: targets.size, bbox: [maxX - minX + 1, maxY - minY + 1], path_ft: route.cost, turns_30ft: Math.ceil(route.cost / 30), exposed_steps: exposedSteps, exposed_share: Number((exposedSteps / Math.max(1, approach.length)).toFixed(2)), ingress_doors: ingress.length, alternative_ingress: alternativeIngress })
  }
  const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null }
  const routes = zones.filter((z) => z.path_ft != null).map((z) => z.path_ft)
  const exposed = zones.filter((z) => z.exposed_steps != null).map((z) => z.exposed_steps)
  const alternatives = zones.map((z) => z.alternative_ingress)
  const areas = zones.map((z) => z.area)
  return {
    room_zones: zones.length,
    room_area_min: areas.length ? Math.min(...areas) : null,
    room_area_median: median(areas),
    room_area_max: areas.length ? Math.max(...areas) : null,
    path_ft_median: median(routes),
    path_ft_max: routes.length ? Math.max(...routes) : null,
    rooms_over_30ft: zones.filter((z) => z.path_ft != null && z.path_ft > 30).length,
    rooms_over_60ft: zones.filter((z) => z.path_ft != null && z.path_ft > 60).length,
    alternative_rooms: zones.filter((z) => z.alternative_ingress >= 1).length,
    max_alternative_ingress: alternatives.length ? Math.max(...alternatives) : 0,
    exposed_path_median_steps: median(exposed),
    exposed_path_max_steps: exposed.length ? Math.max(...exposed) : 0,
    zones,
  }
}

function measure(map, report, id, seed) {
  const party = map.spawnPoints.find((point) => point.role === 'party')
  const target = party ? zoneMetrics(map, party) : {
    room_zones: 0, room_area_min: null, room_area_median: null, room_area_max: null,
    path_ft_median: null, path_ft_max: null, rooms_over_30ft: 0, rooms_over_60ft: 0,
    alternative_rooms: 0, max_alternative_ingress: 0, exposed_path_median_steps: null,
    exposed_path_max_steps: 0, zones: [],
  }
  const lockedDoors = (map.doors ?? []).filter((door) => door.state === 'locked')
  const lockedTouchingZones = new Set()
  const lockedBehindZones = new Set()
  for (const door of lockedDoors) {
    const next = edgeNeighbor(door)
    const sides = [{ x: door.x, y: door.y }, next]
    for (const p of sides) {
      const zone = cellAt(map, p.x, p.y)?.zone
      if (zone && zone !== 'rock') lockedTouchingZones.add(zone)
    }
    if (party) {
      const distances = sides.map((p) => routeSearch(map, party, new Set([key(p.x, p.y)]), { weighted: true })?.cost ?? Number.POSITIVE_INFINITY)
      const behind = distances[0] >= distances[1] ? cellAt(map, sides[0].x, sides[0].y)?.zone : cellAt(map, sides[1].x, sides[1].y)?.zone
      if (behind && behind !== 'rock') lockedBehindZones.add(behind)
    }
  }
  return {
    id, seed, generator: map.generator?.id ?? null, size: [map.width, map.height],
    audit: { problems: report.problems.length, warnings: report.warnings.length, ...report.stats },
    metric: { physical_locked_doors: lockedDoors.length, locked_touching_zones: lockedTouchingZones.size, locked_behind_zones: lockedBehindZones.size, ...target },
  }
}

const results = []
for (const scene of MAP_PREVIEW_PRESETS) for (const seed of ['s1', 's2', 's3']) {
  const input = { ...scene.input, seed: `${scene.id}:${seed}`, useLibrary: false }
  const { map } = generateSceneGeometry(input)
  results.push(measure(map, auditTacticalMap(map), scene.id, seed))
}
const compact = results.map(({ id, seed, generator, size, audit, metric }) => ({
  id, seed, generator, size, audit,
  metric: {
    physical_locked_doors: metric.physical_locked_doors,
    locked_touching_zones: metric.locked_touching_zones,
    locked_behind_zones: metric.locked_behind_zones,
    room_zones: metric.room_zones,
    room_area: [metric.room_area_min, metric.room_area_median, metric.room_area_max],
    path_ft: [metric.path_ft_median, metric.path_ft_max],
    rooms_over_30ft: metric.rooms_over_30ft,
    rooms_over_60ft: metric.rooms_over_60ft,
    alternative_rooms: metric.alternative_rooms,
    max_alternative_ingress: metric.max_alternative_ingress,
    exposed_path_steps: [metric.exposed_path_median_steps, metric.exposed_path_max_steps],
  },
}))
const pilotKeys = new Set(['tavern:s2', 'crypt:s2', 'village:s2'])
const pilots = results.filter((entry) => pilotKeys.has(`${entry.id}:${entry.seed}`)).map(({ id, seed, generator, size, audit, metric }) => ({
  id, seed, generator, size, audit, metric: { ...compact.find((entry) => entry.id === id && entry.seed === seed).metric, zones: metric.zones },
}))
console.log(JSON.stringify({
  experiment: 'map-choice-baseline-v1',
  baseline_reference: 'cb045a84',
  node: process.version,
  command: 'node eval/map-choice-probe-2026-10-04.mjs',
  preview_command: 'pnpm maps:preview -- --preset all --audit',
  presets: MAP_PREVIEW_PRESETS.length,
  seeds: ['s1', 's2', 's3'],
  method: {
    target: 'interior zone reachable from party spawn',
    path_ft: 'Dijkstra over passable cells; 5 ft per step, map cell.moveCost multiplier when present; doors passable as future physical routes; blocking props excluded',
    neighbors: 'orthogonal four-neighbor grid only; no diagonals',
    alternative_ingress: 'for each target-zone ingress door, remove that door and retest reachability; count doors whose removal still leaves the target reachable',
    exposed_steps: 'steps on the canonical minimum movement-cost path with no adjacent wall/edge cover and no prop cover; static proxy only',
    action_economy: '30 ft baseline is a comparison bucket, not a combat outcome; no actor speed, Dash, action, LOS target, spell, or reaction is modeled',
  },
  results: compact,
  pilots,
}, null, 2))

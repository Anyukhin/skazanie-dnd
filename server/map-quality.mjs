// @ts-check
/**
 * Проверка качества тактической карты: годится ли она для игры за столом.
 *
 * Валидатор `validateTacticalMap` отвечает на вопрос «цела ли структура»
 * (ключи рёбер, ссылки дверей, границы). Этот модуль отвечает на другой —
 * «можно ли на этой карте играть в D&D»:
 *
 * - у каждой постройки есть дверь наружу, а в просторной постройке — больше
 *   одной комнаты, и в стенах, выходящих на улицу, есть окна;
 * - каждая проходимая клетка досягаема от входа отряда (двери открываются,
 *   мебель обходится);
 * - предметы не вылезают за край карты, не стоят на глухих клетках, не
 *   перегораживают дверной проём и не налезают друг на друга;
 * - дверь ведёт с проходимой клетки на проходимую, окно смотрит наружу;
 * - постройка не обрезана краем карты: помещение у края закрыто стеной.
 *
 * Модуль — лист: читает только саму карту, ничего не меняет и не знает,
 * каким генератором она построена. Поэтому одна проверка годится и для
 * процедурных карт, и для импортированных из TaleSpire. Проверка по программе
 * сцены (`programReport`) берёт словарь обещанного у `scene-requirements.mjs` —
 * такого же листа.
 */
import { normalizeSceneRequirements, requiredProgramKinds, requirementAssets, requirementTerrain, requirementsCoverage } from './scene-requirements.mjs'
import { cellAt, edgeBetween, edgeList, edgeNeighbor, reachableCells } from './tactical-map.mjs'

/** @typedef {import('./tactical-map.mjs').TacticalMap} TacticalMap */

/**
 * @typedef {object} MapProblem
 * @property {string} code
 * @property {string} [detail]
 */

/** Постройка от этой площади (клеток пола) обязана делиться на комнаты. Изба
 * 7×6 с тонкими стенами — 42 клетки в одну комнату, и это нормальное жильё. */
export const MULTI_ROOM_MIN_CELLS = 48

/** Доля клеток просторного зала (от сотни клеток), где есть укрытие рядом. */
const HALL_COVER_SHARE = 0.3

/**
 * Внутренние дворы: наружные зоны, со всех сторон окружённые постройкой. Ни
 * одна их клетка не выходит без стены к другой наружной зоне и к краю карты.
 *
 * @param {TacticalMap} map
 * @param {Map<string, string>} zoneKind
 * @returns {Set<string>}
 */
function enclosedCourtyards(map, zoneKind) {
  /** @type {Set<string>} */
  const open = new Set()
  /** @type {Set<string>} */
  const seen = new Set()
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (!cell?.passable || zoneKind.get(cell.zone) !== 'exterior') continue
    seen.add(cell.zone)
    if (open.has(cell.zone)) continue
    // Поле, обнесённое скалой края карты, — не двор: двор стоит внутри дома.
    if (x <= 1 || y <= 1 || x >= map.width - 2 || y >= map.height - 2) { open.add(cell.zone); continue }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = cellAt(map, x + dx, y + dy)
      if (!next) { open.add(cell.zone); break }
      if (!next.passable || next.zone === cell.zone || zoneKind.get(next.zone) !== 'exterior') continue
      const edge = edgeBetween(map, x, y, x + dx, y + dy)
      if (!edge || !edge.blocksMove || edge.kind === 'door') { open.add(cell.zone); break }
    }
  }
  return new Set([...seen].filter((zone) => !open.has(zone)))
}

/**
 * Помещения — связные области клеток зон `interior`, разделённые стенами.
 * Возвращаются как компоненты связности по рёбрам без стен (двери соединяют).
 *
 * @param {TacticalMap} map
 * @param {(edge: any) => boolean} joins соединяет ли ребро две клетки
 */
function interiorComponents(map, joins) {
  const zoneKind = new Map(map.zones.map((zone) => [zone.id, zone.kind]))
  const courtyards = enclosedCourtyards(map, zoneKind)
  // Проём между помещениями графовой планировки — проходимая клетка без
  // зоны. Она соединяет комнаты, а не отделяет их. Внутренний двор — часть
  // постройки: кладовая с дверью только во двор не отдельный дом.
  const inside = (/** @type {any} */ cell) => cell.passable && (zoneKind.get(cell.zone) === 'interior' || cell.zone === '' || courtyards.has(cell.zone))
  /** @type {Map<string, number>} */
  const component = new Map()
  /** @type {Array<Array<{x: number, y: number}>>} */
  const components = []
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (!cell || !inside(cell) || cell.zone === '' || component.has(`${x},${y}`)) continue
      const id = components.length
      /** @type {Array<{x: number, y: number}>} */
      const cells = []
      const queue = [{ x, y }]
      component.set(`${x},${y}`, id)
      for (let index = 0; index < queue.length; index += 1) {
        const current = queue[index]
        cells.push(current)
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = current.x + dx
          const ny = current.y + dy
          const key = `${nx},${ny}`
          if (component.has(key)) continue
          const next = cellAt(map, nx, ny)
          if (!next || !inside(next)) continue
          if (!joins(edgeBetween(map, current.x, current.y, nx, ny))) continue
          component.set(key, id)
          queue.push({ x: nx, y: ny })
        }
      }
      components.push(cells)
    }
  }
  return { components, component }
}

/**
 * @param {TacticalMap} map
 * @returns {{ problems: MapProblem[], warnings: MapProblem[], stats: Record<string, number> }}
 */
export function auditTacticalMap(map) {
  /** @type {MapProblem[]} */
  const problems = []
  const add = (/** @type {string} */ code, /** @type {string} */ detail = '') => problems.push(detail ? { code, detail } : { code })
  const zoneKind = new Map(map.zones.map((zone) => [zone.id, zone.kind]))
  const kindAt = (/** @type {number} */ x, /** @type {number} */ y) => {
    const cell = cellAt(map, x, y)
    if (!cell) return null
    if (cell.zone === '' && cell.passable) return 'interior'
    return zoneKind.get(cell.zone) ?? 'exterior'
  }

  // --- предметы -------------------------------------------------------------
  /** @type {Map<string, string>} */
  const blockingAt = new Map()
  let propsOutside = 0
  for (const prop of map.props) {
    const footprint = prop.footprint?.length ? prop.footprint : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]
    for (const point of footprint) {
      const cell = cellAt(map, point.x, point.y)
      if (point.x < 0 || point.y < 0 || point.x >= map.width || point.y >= map.height || !cell) {
        propsOutside += 1
        add('PROP_OUT_OF_BOUNDS', `${prop.assetId}@${point.x},${point.y}`)
        continue
      }
      if (!prop.transition && !prop.mount && !cell.passable && prop.blocksMove) add('PROP_ON_SOLID_CELL', `${prop.assetId}@${point.x},${point.y}`)
      // Высокая мебель перед окном заслоняет и свет, и обзор наружу.
      if (!prop.transition && !prop.mount && prop.blocksSight && [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .some(([dx, dy]) => edgeBetween(map, point.x, point.y, point.x + dx, point.y + dy)?.kind === 'window')) {
        add('PROP_BLOCKS_WINDOW', `${prop.assetId}@${point.x},${point.y}`)
      }
      if (prop.blocksMove && !prop.mount) {
        const key = `${point.x},${point.y}`
        if (blockingAt.has(key)) add('PROPS_OVERLAP', `${blockingAt.get(key)}+${prop.assetId}@${key}`)
        else blockingAt.set(key, prop.assetId)
      }
    }
  }

  // --- рёбра: двери и окна --------------------------------------------------
  let windows = 0
  let exteriorDoors = 0
  for (const edge of edgeList(map)) {
    const next = edgeNeighbor(edge)
    const a = cellAt(map, edge.x, edge.y)
    const b = cellAt(map, next.x, next.y)
    if (edge.kind === 'door') {
      if (!a || !b || !a.passable || !b.passable) add('DOOR_TO_NOWHERE', `${edge.x},${edge.y},${edge.dir}`)
      // Порог с обеих сторон и клетка сразу за проёмом в толстой стене:
      // бочка вплотную к порогу перекрывает вход так же, как бочка на нём.
      const step = { x: next.x - edge.x, y: next.y - edge.y }
      const approach = [{ x: edge.x, y: edge.y }, next, { x: edge.x - step.x, y: edge.y - step.y }, { x: next.x + step.x, y: next.y + step.y }]
      for (const point of approach) {
        if (blockingAt.has(`${point.x},${point.y}`)) add('DOORWAY_BLOCKED', `${blockingAt.get(`${point.x},${point.y}`)}@${point.x},${point.y}`)
      }
      if (kindAt(edge.x, edge.y) !== kindAt(next.x, next.y)) exteriorDoors += 1
    }
    if (edge.kind === 'window') {
      windows += 1
      // Окно в толстой стене смотрит из зала в клетку кладки — это нормально;
      // плохо окно между двумя проходимыми помещениями.
      if (a?.passable && b?.passable && kindAt(edge.x, edge.y) === 'interior' && kindAt(next.x, next.y) === 'interior') add('WINDOW_BETWEEN_ROOMS', `${edge.x},${edge.y},${edge.dir}`)
    }
  }

  // --- двери поселения выходят к дороге -------------------------------------
  // В поселении (у карты есть зона улицы) дверь дома ведёт на улицу, площадь
  // или тропу, а не в чужой двор: «Дом 9» стоял в углу деревни дверью в поле,
  // без единой дорожки (замечание владельца 2026-10-03).
  if (map.zones.some((zone) => zone.id === 'street')) {
    const road = (/** @type {number} */ x, /** @type {number} */ y) => ['street', 'square', 'path'].includes(cellAt(map, x, y)?.zone ?? '')
    for (const door of map.doors) {
      const next = edgeNeighbor(door)
      const sides = [{ x: door.x, y: door.y }, next]
      const outside = sides.find((point) => kindAt(point.x, point.y) === 'exterior' && cellAt(map, point.x, point.y)?.passable)
      if (!outside || !sides.some((point) => kindAt(point.x, point.y) === 'interior')) continue
      const touches = road(outside.x, outside.y) || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => road(outside.x + dx, outside.y + dy))
      if (!touches) add('DOOR_OFF_ROAD', `${door.id}@${outside.x},${outside.y}`)
    }
    // Тропа — проход: предмет, мешающий шагу, на ней перекрыл бы путь к двери.
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      if (cellAt(map, x, y)?.zone === 'path' && blockingAt.has(`${x},${y}`)) add('PATH_BLOCKED', `${blockingAt.get(`${x},${y}`)}@${x},${y}`)
    }
  }

  // --- постройки и комнаты --------------------------------------------------
  // Постройка — помещения, связанные любым ребром, кроме глухой стены и окна.
  const buildings = interiorComponents(map, (edge) => !edge || edge.kind === 'door' || edge.kind === 'none')
  // Комната — помещения, связанные только ребром без стены и без двери.
  const rooms = interiorComponents(map, (edge) => !edge || edge.kind === 'none')
  const party = map.spawnPoints.find((point) => point.role === 'party')
  let multiRoomBuildings = 0
  for (const cells of buildings.components) {
    const roomIds = new Set(cells.map((cell) => rooms.component.get(`${cell.x},${cell.y}`)))
    if (roomIds.size > 1) multiRoomBuildings += 1
    const label = `${cells[0].x},${cells[0].y}`
    // Дверь наружу: ребро-дверь между помещением постройки и улицей или краем.
    let hasExit = false
    let outerWalls = 0
    let outerWindows = 0
    // Постройка под открытым небом граничит с улицей. Подземелье, пещера и
    // храм-комплекс улицы не видят — окна и выход наружу с них не спрашиваются.
    let openAir = false
    /** @type {string[]} */
    const offMap = []
    for (const cell of cells) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cell.x + dx
        const ny = cell.y + dy
        if (buildings.component.get(`${nx},${ny}`) === buildings.component.get(`${cell.x},${cell.y}`)) continue
        const edge = edgeBetween(map, cell.x, cell.y, nx, ny)
        const outside = kindAt(nx, ny)
        const neighbor = cellAt(map, nx, ny)
        if (outside === null && (!edge || edge.kind === 'none')) offMap.push(`${cell.x},${cell.y}`)
        if (outside === 'exterior' && neighbor?.passable) {
          openAir = true
          if (edge?.kind === 'door' || !edge) hasExit = true
          if (edge?.kind === 'wall') outerWalls += 1
          if (edge?.kind === 'window') outerWindows += 1
        }
        // Толстая стена — клетка кладки между комнатой и улицей. Окно в ней
        // стоит на одной из её граней, поэтому смотрим сквозь кладку.
        if (neighbor && !neighbor.passable) {
          const through = cellAt(map, nx + dx, ny + dy)
          if (through?.passable && kindAt(nx + dx, ny + dy) === 'exterior') {
            openAir = true
            const far = edgeBetween(map, nx, ny, nx + dx, ny + dy)
            if (edge?.kind === 'window' || far?.kind === 'window') outerWindows += 1
            else outerWalls += 1
          }
        }
        if (outside === null && edge?.kind === 'door') hasExit = true
      }
    }
    // Помещение, упёртое в край карты без стены, — обрезанная постройка. Для
    // подземного комплекса край у входа отряда допустим: это устье, откуда
    // отряд пришёл; остальное — ход в никуда.
    const nearEntrance = (/** @type {string} */ point) => {
      const [px, py] = point.split(',').map(Number)
      return party ? Math.abs(px - party.x) + Math.abs(py - party.y) <= 3 : false
    }
    for (const point of offMap) {
      if (openAir) add('BUILDING_CUT_BY_EDGE', point)
      else if (!nearEntrance(point)) add('PASSAGE_OFF_MAP', point)
    }
    if (openAir) {
      if (!hasExit) add('BUILDING_WITHOUT_EXIT', label)
      if (cells.length >= MULTI_ROOM_MIN_CELLS && roomIds.size < 2) add('BUILDING_SINGLE_ROOM', `${label} (${cells.length} кл.)`)
      if (outerWalls >= 8 && outerWindows === 0) add('BUILDING_WITHOUT_WINDOWS', label)
    }
  }

  // --- досягаемость ---------------------------------------------------------
  let unreachable = 0
  let passable = 0
  if (!party) add('NO_PARTY_SPAWN')
  else {
    const start = cellAt(map, party.x, party.y)
    if (!start || !start.passable || blockingAt.has(`${party.x},${party.y}`)) add('PARTY_SPAWN_BLOCKED', `${party.x},${party.y}`)
    const reached = reachableCells(map, party.x, party.y, { blockedCells: new Set(blockingAt.keys()) })
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const cell = cellAt(map, x, y)
        if (!cell || !cell.passable || blockingAt.has(`${x},${y}`) || cell.surface === 'water') continue
        passable += 1
        if (!reached.has(`${x},${y}`)) unreachable += 1
      }
    }
    if (passable && unreachable / passable > 0.03) add('UNREACHABLE_FLOOR', `${unreachable}/${passable}`)
  }

  // Петли (цикломатика графа комнат): ребро — дверь или проём между двумя
  // помещениями или помещением и улицей. Ноль петель — всё одной ниткой.
  /** @type {Set<string>} */
  const links = new Set()
  const nodeOf = (/** @type {number} */ x, /** @type {number} */ y) => {
    const id = rooms.component.get(`${x},${y}`)
    if (id != null) return `r${id}`
    return cellAt(map, x, y)?.passable ? 'out' : null
  }
  for (const edge of edgeList(map)) {
    if (edge.kind !== 'door') continue
    const next = edgeNeighbor(edge)
    const a = nodeOf(edge.x, edge.y)
    const b = nodeOf(next.x, next.y)
    if (a && b && a !== b) links.add([a, b].sort().join('|'))
  }
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (!cell?.passable || cell.zone !== '') continue
    const around = [...new Set([[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => nodeOf(x + dx, y + dy)).filter(Boolean))]
    for (let i = 0; i < around.length; i += 1) for (let j = i + 1; j < around.length; j += 1) links.add([around[i], around[j]].sort().join('|'))
  }
  // Цикломатическое число E − V + C, где C — число компонент связности. Прежняя
  // формула E − V + 1 считала граф связным, и у леса или дороги без комнат и
  // дверей (E = V = 0) получалась «одна петля» (исследование PR #136).
  /** @type {Map<string, string>} */
  const parent = new Map()
  const root = (/** @type {string} */ node) => {
    let current = node
    while (parent.get(current) !== current) current = /** @type {string} */ (parent.get(current))
    return current
  }
  for (const link of links) {
    const [a, b] = link.split('|')
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    parent.set(root(a), root(b))
  }
  const components = new Set([...parent.keys()].map(root)).size
  const loops = Math.max(0, links.size - parent.size + components)
  const richness = richnessReport(map)
  const play = playabilityReport(map, blockingAt)
  problems.push(...richness.problems, ...play.problems)
  return {
    problems,
    warnings: [...richness.warnings, ...play.warnings],
    stats: {
      ...richness.stats,
      ...play.stats,
      cells: passable,
      buildings: buildings.components.length,
      multi_room: multiRoomBuildings,
      rooms: rooms.components.length,
      exterior_doors: exteriorDoors,
      loops,
      doors: map.doors.length,
      windows,
      props: map.props.length,
      props_outside: propsOutside,
      unreachable,
    },
  }
}

/**
 * Предметы, которые и должны стоять рядом одинаковыми: забор тянется
 * линией, скамьи храма — рядами, ниши склепа — вдоль стены, штабели склада —
 * группой, стулья — вокруг стола. Остальное, поставленное кучкой по три
 * одинаковых вплотную, выглядит как ошибка штампа, а не как обстановка.
 */
const ROW_ASSETS = new Set(['village_fence', 'rail_fence', 'prayer_bench', 'crypt_niche', 'crate_stack', 'barrel_stack', 'crate', 'barrel', 'bunk_bed', 'grave', 'chair', 'stool', 'bench', 'hitching_post', 'shelf_wall', 'bookshelf', 'sack', 'pillar'])

/** Деревья образуют рощу, но четыре одинаковых дерева вплотную — уже штамп. */
const TREE_CLUSTER_LIMIT = 4

/**
 * Богатство обстановки: кучки одинаковых предметов вплотную, доля самого
 * частого предмета и число разных предметов.
 *
 * @param {TacticalMap} map
 * @returns {{ problems: MapProblem[], warnings: MapProblem[], stats: Record<string, number> }}
 */
export function richnessReport(map) {
  /** @type {MapProblem[]} */
  const problems = []
  /** @type {MapProblem[]} */
  const warnings = []
  const placed = map.props.filter((prop) => !prop.mount && !prop.transition)
  const cellsOf = (/** @type {any} */ prop) => prop.footprint?.length ? prop.footprint : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]
  /** @type {Map<string, number[]>} */
  const byAsset = new Map()
  placed.forEach((prop, index) => byAsset.set(prop.assetId, [...(byAsset.get(prop.assetId) ?? []), index]))
  let clusters = 0
  let largestCluster = 0
  for (const [assetId, indices] of byAsset) {
    if (indices.length < 3) continue
    // Связность по соседству футпринтов, в том числе по диагонали. Соседи по
    // разные стороны тонкой стены — это две комнаты, а не одна куча.
    const zoneOf = (/** @type {number} */ index) => cellAt(map, Math.floor(placed[index].x), Math.floor(placed[index].y))?.zone
    const near = (/** @type {number} */ a, /** @type {number} */ b) => zoneOf(a) === zoneOf(b) && cellsOf(placed[a]).some((/** @type {any} */ left) => cellsOf(placed[b])
      .some((/** @type {any} */ right) => Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y)) <= 1))
    const seen = new Set()
    for (const start of indices) {
      if (seen.has(start)) continue
      const group = [start]
      seen.add(start)
      for (let cursor = 0; cursor < group.length; cursor += 1) {
        for (const other of indices) {
          if (seen.has(other) || !near(group[cursor], other)) continue
          seen.add(other)
          group.push(other)
        }
      }
      largestCluster = Math.max(largestCluster, group.length)
      const tree = assetId.startsWith('tree_') || assetId === 'bush' || assetId === 'shrub'
      const limit = ROW_ASSETS.has(assetId) ? Number.POSITIVE_INFINITY : tree ? TREE_CLUSTER_LIMIT : 3
      if (group.length >= limit) {
        clusters += 1
        const first = cellsOf(placed[group[0]])[0]
        problems.push({ code: 'REPEATED_CLUSTER', detail: `${assetId}×${group.length}@${first.x},${first.y}` })
      }
    }
  }
  // Ряды задуманы (ниши вдоль стены, скамьи храма), поэтому однообразие
  // считается по остальным предметам.
  const solo = [...byAsset].filter(([assetId]) => !ROW_ASSETS.has(assetId))
  const total = placed.length
  const top = solo.length ? Math.max(...solo.map(([, list]) => list.length)) : 0
  const topAsset = solo.find(([, list]) => list.length === top)?.[0] ?? ''
  // Один предмет больше чем на четверть карты — однообразие: храм из
  // жаровен, лес из одних берёз.
  if (total >= 16 && top / total > 0.28) warnings.push({ code: 'MONOTONOUS_PROPS', detail: `${topAsset} ${top}/${total}` })
  return {
    problems,
    warnings,
    stats: { kinds: byAsset.size, top_share: total ? Math.round((top / total) * 100) : 0, clusters, largest_cluster: largestCluster },
  }
}

/**
 * Играбельность за персонажа D&D: место для отряда у входа, укрытия на
 * открытом месте, дальность прямого обзора (дальний бой).
 *
 * @param {TacticalMap} map
 * @param {Map<string, string>} blockingAt клетки под мешающими предметами
 * @returns {{ problems: MapProblem[], warnings: MapProblem[], stats: Record<string, number> }}
 */
export function playabilityReport(map, blockingAt) {
  /** @type {MapProblem[]} */
  const problems = []
  /** @type {MapProblem[]} */
  const warnings = []
  const free = (/** @type {number} */ x, /** @type {number} */ y) => {
    const cell = cellAt(map, x, y)
    return Boolean(cell?.passable) && cell?.surface !== 'water' && !blockingAt.has(`${x},${y}`)
  }
  // Отряд из четырёх-шести героев встаёт у входа: нужно хотя бы шесть
  // свободных клеток в двух шагах, связанных со входом.
  const party = map.spawnPoints.find((point) => point.role === 'party')
  let spawnRoom = 0
  if (party) {
    const reached = reachableCells(map, party.x, party.y, { blockedCells: new Set(blockingAt.keys()) })
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
      if (reached.has(`${party.x + dx},${party.y + dy}`) && free(party.x + dx, party.y + dy)) spawnRoom += 1
    }
    if (spawnRoom < 6) problems.push({ code: 'SPAWN_CRAMPED', detail: `${spawnRoom} кл.` })
  }
  // Стена рядом — глухая клетка или ребро-стена: после тонких стен
  // (`server/thin-walls.mjs`) кладка живёт на рёбрах, и клетка у стены
  // соседей-стен не имеет.
  const wallBeside = (/** @type {number} */ x, /** @type {number} */ y) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
    const neighbor = cellAt(map, x + dx, y + dy)
    if (neighbor && !neighbor.passable) return true
    const edge = neighbor ? edgeBetween(map, x, y, x + dx, y + dy) : null
    return Boolean(edge && edge.kind !== 'door' && edge.blocksMove)
  })
  // Укрытие на открытом месте: рядом предмет с укрытием или глухая клетка.
  /** @type {Set<string>} */
  const coverAt = new Set()
  for (const prop of map.props) {
    if (!prop.cover || prop.cover === 'none') continue
    for (const cell of prop.footprint ?? []) for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) coverAt.add(`${cell.x + dx},${cell.y + dy}`)
  }
  const zoneKind = new Map(map.zones.map((zone) => [zone.id, zone.kind]))
  let open = 0
  let covered = 0
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    if (!free(x, y) || zoneKind.get(cellAt(map, x, y)?.zone ?? '') === 'interior') continue
    open += 1
    const wallNear = wallBeside(x, y)
    if (coverAt.has(`${x},${y}`) || wallNear) covered += 1
  }
  const coverShare = open ? covered / open : 1
  if (open >= 150 && coverShare < 0.3) warnings.push({ code: 'OPEN_GROUND_NO_COVER', detail: `${Math.round(coverShare * 100)}%` })
  // Укрытие в просторном зале: та же мерка по каждой комнате от сотни клеток.
  // У стены укрытие есть всегда, поэтому голый зал 12×16 даёт около четверти.
  /** @type {Map<string, {cells: number, covered: number}>} */
  const halls = new Map()
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const zone = cellAt(map, x, y)?.zone ?? ''
    if (!free(x, y) || zoneKind.get(zone) !== 'interior') continue
    const hall = halls.get(zone) ?? { cells: 0, covered: 0 }
    hall.cells += 1
    const wallNear = wallBeside(x, y)
    if (coverAt.has(`${x},${y}`) || wallNear) hall.covered += 1
    halls.set(zone, hall)
  }
  let barestHall = 1
  for (const [zone, hall] of halls) {
    if (hall.cells < 100) continue
    const share = hall.covered / hall.cells
    barestHall = Math.min(barestHall, share)
    if (share < HALL_COVER_SHARE) warnings.push({ code: 'HALL_NO_COVER', detail: `${zone} ${Math.round(share * 100)}%` })
  }
  // Прямой обзор: самая длинная непрерывная линия по строке или столбцу без
  // стен, окон и предметов, закрывающих обзор.
  let sightline = 0
  const sightBlocked = new Set(map.props.filter((prop) => prop.blocksSight).flatMap((prop) => (prop.footprint ?? []).map((cell) => `${cell.x},${cell.y}`)))
  for (const [dx, dy] of [[1, 0], [0, 1]]) {
    for (let start = 0; start < (dx ? map.height : map.width); start += 1) {
      let run = 0
      for (let step = 0; step < (dx ? map.width : map.height); step += 1) {
        const x = dx ? step : start
        const y = dx ? start : step
        const cell = cellAt(map, x, y)
        const edge = step > 0 ? edgeBetween(map, x - dx, y - dy, x, y) : null
        const clear = Boolean(cell?.passable) && !sightBlocked.has(`${x},${y}`)
        run = !clear ? 0 : edge?.blocksSight ? 1 : run + 1
        sightline = Math.max(sightline, run)
      }
    }
  }
  return {
    problems,
    warnings,
    stats: { spawn_room: spawnRoom, cover_pct: Math.round(coverShare * 100), hall_cover_pct: Math.round(barestHall * 100), sightline_ft: sightline * 5 },
  }
}

/**
 * Клетки настилов: наружный деревянный пол выше земли. Настил узнаётся по
 * самой карте, а не по пометке генератора, поэтому мостки готовой карты
 * считаются так же.
 *
 * @param {TacticalMap} map
 * @returns {Array<{x: number, y: number}>}
 */
export function platformCells(map) {
  const kind = new Map(map.zones.map((zone) => [zone.id, zone.kind]))
  /** @type {Array<{x: number, y: number}>} */
  const cells = []
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (cell?.passable && cell.material === 'wood' && cell.elevation > 0 && kind.get(cell.zone) !== 'interior') cells.push({ x, y })
  }
  return cells
}

/**
 * Сколько настилов на карте: связные пятна из `platformCells`.
 * @param {TacticalMap} map
 * @returns {number}
 */
export function countPlatforms(map) {
  const raised = new Set(platformCells(map).map((point) => `${point.x},${point.y}`))
  /** @type {Set<string>} */
  const seen = new Set()
  let count = 0
  for (const start of raised) {
    if (seen.has(start)) continue
    count += 1
    const queue = [start]
    seen.add(start)
    for (let index = 0; index < queue.length; index += 1) {
      const [x, y] = queue[index].split(',').map(Number)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const key = `${x + dx},${y + dy}`
        if (seen.has(key) || !raised.has(key)) continue
        seen.add(key)
        queue.push(key)
      }
    }
  }
  return count
}

/**
 * Наименьшая карта под масштаб поселения: деревня из четырёх домов на поле
 * 16×16 деревней не выглядит (этап 4 `docs/map-generation-plan.md`).
 */
export const SETTLEMENT_MIN_SIZE = Object.freeze({ width: 24, height: 20 })

/** Доля глухого в сцене под открытым небом, после которой площадь — не площадь. */
const OPEN_SCENE_BLOCKED_SHARE = 0.35

/** Закуток недосягаемых клеток больше этого — уже не огрех, а потерянная часть карты. */
const POCKET_LIMIT = 4

/** Простор у центра сцены: свободных досягаемых клеток в двух шагах вокруг предмета. */
const FOCUS_RADIUS = 2
export const FOCUS_MIN_ROOM = 6

/**
 * Простор у предмета центра сцены: свободные досягаемые клетки в двух шагах
 * вокруг его следа. Одна мерка для проверки программы и для расстановки
 * центра (`placeSceneFocus`), иначе расстановка засчитывает предмет, который
 * проверка потом назовёт зажатым.
 *
 * @param {Array<{x: number, y: number}>} footprint
 * @param {Set<string>} reached клетки, досягаемые от входа отряда
 * @param {Set<string>} blocked клетки под глухими предметами
 * @returns {number}
 */
export function focusRoom(footprint, reached, blocked) {
  const own = new Set(footprint.map((point) => `${point.x},${point.y}`))
  /** @type {Set<string>} */
  const around = new Set()
  for (const point of footprint) {
    for (let dy = -FOCUS_RADIUS; dy <= FOCUS_RADIUS; dy += 1) for (let dx = -FOCUS_RADIUS; dx <= FOCUS_RADIUS; dx += 1) {
      const at = `${point.x + dx},${point.y + dy}`
      if (!own.has(at) && reached.has(at) && !blocked.has(at)) around.add(at)
    }
  }
  return around.size
}

/**
 * Проверка карты против программы сцены (`scene.map_requirements`): обещанное
 * стоит на карте и до него можно дойти от входа отряда. Одна мерка для
 * сгенерированной и для библиотечной карты.
 *
 * Провал (`problems`): нет обязательного якоря — центра, поста жителя или
 * улики; якорь не досягаем от входа; карта меньше минимума масштаба; открытая
 * сцена глуха больше чем на треть; потерян закуток больше четырёх клеток.
 * Остальное обещанное и предмет на крайней клетке — предупреждения: лишняя
 * бочка не повод строить карту заново.
 *
 * Досягаемость — тем же поиском, что у аудита: перепад высот правила шага не
 * трогают, поэтому настил в два фута проходим, а глухая клетка — нет.
 *
 * @param {TacticalMap} map
 * @param {unknown} program
 * @param {{ minSize?: { width: number, height: number }|null, openScene?: boolean }} [options]
 *   `openScene` — место, где собираются люди (поселение, площадь с центром):
 *   там глухое больше трети — провал. Лес густ по природе и под мерку не идёт.
 * @returns {{ problems: MapProblem[], warnings: MapProblem[], missing: string[], stats: Record<string, number> }}
 */
export function programReport(map, program, { minSize = null, openScene = false } = {}) {
  /** @type {MapProblem[]} */
  const problems = []
  /** @type {MapProblem[]} */
  const warnings = []
  const items = normalizeSceneRequirements(program)
  const required = new Set(requiredProgramKinds(program))
  /** @type {Record<string, number>} */
  const props = {}
  for (const prop of map.props) props[prop.assetId] = (props[prop.assetId] ?? 0) + 1
  const platforms = countPlatforms(map)
  const coverage = requirementsCoverage(items, props, { platform: platforms })
  /** @type {string[]} */
  const missing = []
  for (const id of coverage.missing) {
    if (required.has(id)) {
      missing.push(id)
      problems.push({ code: 'PROGRAM_ANCHOR_MISSING', detail: id })
    } else warnings.push({ code: 'PROGRAM_ITEM_MISSING', detail: id })
  }

  /** @type {Set<string>} */
  const blocked = new Set()
  for (const prop of map.props) {
    if (!prop.blocksMove || prop.mount) continue
    for (const point of prop.footprint?.length ? prop.footprint : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]) blocked.add(`${point.x},${point.y}`)
  }
  const party = map.spawnPoints.find((point) => point.role === 'party')
  const reached = party ? reachableCells(map, party.x, party.y, { blockedCells: blocked }) : new Set()
  // Якорь досягаем, если отряд встаёт на его клетку или рядом с ней.
  const near = (/** @type {Array<{x: number, y: number}>} */ cells) => cells.some((point) => [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]
    .some(([dx, dy]) => reached.has(`${point.x + dx},${point.y + dy}`)))
  for (const id of coverage.met) {
    if (!required.has(id)) continue
    const assets = new Set(requirementAssets(id))
    const anchors = requirementTerrain(id) === 'platform'
      ? platformCells(map).map((point) => [point])
      : map.props.filter((prop) => assets.has(prop.assetId))
        .map((prop) => (prop.footprint?.length ? prop.footprint : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]))
    if (!anchors.some(near)) problems.push({ code: 'PROGRAM_ANCHOR_UNREACHABLE', detail: id })
  }

  // Центр сцены — место, где стоят люди: вокруг него нужен простор. Лагерь в
  // лесу густ, но у костра — поляна; навес не втиснут между сараями.
  const focus = typeof (/** @type {any} */ (program)?.focus) === 'string' ? /** @type {any} */ (program).focus : ''
  if (focus && coverage.met.includes(focus) && !requirementTerrain(focus)) {
    const assets = new Set(requirementAssets(focus))
    let roomiest = 0
    for (const prop of map.props) {
      if (!assets.has(prop.assetId)) continue
      roomiest = Math.max(roomiest, focusRoom(prop.footprint?.length ? prop.footprint : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }], reached, blocked))
    }
    if (roomiest < FOCUS_MIN_ROOM) problems.push({ code: 'FOCUS_CRAMPED', detail: `${focus}: ${roomiest} кл.` })
  }

  let edgeProps = 0
  for (const prop of map.props) {
    if (prop.transition || prop.mount) continue
    const cells = prop.footprint?.length ? prop.footprint : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]
    if (cells.some((point) => point.x <= 0 || point.y <= 0 || point.x >= map.width - 1 || point.y >= map.height - 1)) {
      edgeProps += 1
      warnings.push({ code: 'PROP_ON_EDGE', detail: `${prop.assetId}@${Math.floor(prop.x)},${Math.floor(prop.y)}` })
    }
  }

  if (minSize && (map.width < minSize.width || map.height < minSize.height)) {
    problems.push({ code: 'SCENE_TOO_SMALL', detail: `${map.width}×${map.height} < ${minSize.width}×${minSize.height}` })
  }

  // Глухое и потерянное считаются по суше: вода гавани — часть места, а не помеха.
  const zoneKind = new Map(map.zones.map((zone) => [zone.id, zone.kind]))
  const outdoors = party ? zoneKind.get(cellAt(map, party.x, party.y)?.zone ?? '') !== 'interior' : false
  let land = 0
  let solid = 0
  /** @type {Set<string>} */
  const lost = new Set()
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (!cell || cell.surface === 'water') continue
    land += 1
    if (!cell.passable || blocked.has(`${x},${y}`)) solid += 1
    else if (party && !reached.has(`${x},${y}`)) lost.add(`${x},${y}`)
  }
  const blockedShare = land ? solid / land : 0
  if (openScene && outdoors && blockedShare > OPEN_SCENE_BLOCKED_SHARE) problems.push({ code: 'OPEN_SCENE_CLUTTERED', detail: `${Math.round(blockedShare * 100)}%` })
  let largestPocket = 0
  /** @type {Set<string>} */
  const seen = new Set()
  for (const start of lost) {
    if (seen.has(start)) continue
    const queue = [start]
    seen.add(start)
    for (let index = 0; index < queue.length; index += 1) {
      const [x, y] = queue[index].split(',').map(Number)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const key = `${x + dx},${y + dy}`
        if (!lost.has(key) || seen.has(key)) continue
        // Закуток — то, что связано шагом; стена на ребре делит его на части.
        if (edgeBetween(map, x, y, x + dx, y + dy)?.blocksMove) continue
        seen.add(key)
        queue.push(key)
      }
    }
    largestPocket = Math.max(largestPocket, queue.length)
  }
  if (largestPocket > POCKET_LIMIT) problems.push({ code: 'UNREACHABLE_POCKET', detail: `${largestPocket} кл.` })

  return {
    problems,
    warnings,
    missing,
    stats: {
      program_items: items.length,
      program_required: required.size,
      program_met: coverage.met.length,
      platforms,
      edge_props: edgeProps,
      blocked_pct: Math.round(blockedShare * 100),
      largest_pocket: largestPocket,
    },
  }
}

/**
 * Эталонные сцены для просмотра и тестов качества: по одной на каждую тему
 * генератора и назначение здания. Описания — как их пишет архитектор карты.
 */
export const MAP_PREVIEW_PRESETS = Object.freeze([
  { id: 'tavern', input: { location: 'Таверна «Рыжий рог»', theme: 'таверна' } },
  { id: 'shop', input: { location: 'Лавка травника', theme: 'лавка' } },
  { id: 'house', input: { location: 'Дом мельника', theme: 'жилой дом' } },
  { id: 'manor', input: { location: 'Усадьба Вельских', theme: 'усадьба' } },
  { id: 'temple', input: { location: 'Храм Утренней звезды', theme: 'храм' } },
  { id: 'crypt', input: { location: 'Фамильный склеп', theme: 'склеп' } },
  { id: 'cave', input: { location: 'Пещера контрабандистов', theme: 'пещера' } },
  { id: 'forest', input: { location: 'Поляна в Чернолесье', theme: 'лес' } },
  { id: 'road', input: { location: 'Тракт у старого моста', theme: 'дорога' } },
  { id: 'village', input: { location: 'Деревня Кленовка', theme: 'деревня', settlementType: 'village' } },
  { id: 'town', input: { location: 'Город Вельдбург', theme: 'город', settlementType: 'town' } },
  { id: 'harbor', input: { location: 'Портовый квартал', theme: 'гавань у пристани', settlementType: 'town' } },
])

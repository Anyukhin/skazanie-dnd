/**
 * Тактическая геометрия сцены: проходимость клеток, кратчайший путь с учётом
 * размеров и рёбер, линия обзора, укрытие и высота.
 *
 * Чистые функции состояния — без костей и событий. Вынесено из
 * `rules-engine.mjs` первым шагом его разделения; движок и соседние модули
 * импортируют отсюда, а `rules-engine.mjs` реэкспортирует прежний публичный
 * API (`shortestTacticalPath`, `coverBetween`, `highGroundBetween`,
 * `hasClearTrajectory`).
 */
import { footprintCellsFor, footprintDistanceFeet, footprintSizeFor } from '../actor-footprint.mjs'
import { sceneNpcOccupiedCells, sceneNpcTransitCells } from '../npc-positioning.mjs'
import { cellAt, deserializeTacticalMap, edgeBetween, movementStepBlocked } from '../tactical-map.mjs'
import { actorId, actorPosition, findActor, isLivingActor, listActors } from './actors.mjs'
import { RulesValidationError, safeInteger, usesDnd2014 } from './core.mjs'

export function positionKey(position) {
  return `${position.x},${position.y}`
}

/**
 * Служебный адаптер между состоянием и чистой геометрией footprint. Размер
 * читается только из `actor.footprint.version === 1`; старые актёры остаются
 * одной клеткой даже при сохранённом текстовом `size`.
 */
export function actorFootprintCellsAt(state, id, position = actorPosition(state, id)) {
  return footprintCellsFor(findActor(state, id), position)
}

/**
 * Карта сцены как объект. Каноническое представление лежит в `scene.map`
 * сериализованным, чтобы переживать clone и снимок состояния без отдельного
 * кода.
 */
/**
 * Разобранные карты по объекту сериализованной карты.
 *
 * Без кэша reducer разбирал карту заново на каждом событии: replay кампании из
 * 52 событий занимал 261 мс, то есть около 5 мс на событие, и это чувствовалось
 * при открытии кампании. Ключ — сам объект `scene.map`; запись карты создаёт
 * новый объект, поэтому устаревшее значение из кэша прийти не может.
 *
 * @type {WeakMap<object, import('../tactical-map.mjs').TacticalMap>}
 */
export const sceneTacticalMapCache = new WeakMap()

export function sceneTacticalMap(state) {
  const raw = state?.scene?.map
  if (!raw || typeof raw !== 'object') return null
  const cached = sceneTacticalMapCache.get(raw)
  if (cached) return cached
  try {
    const map = deserializeTacticalMap(raw)
    sceneTacticalMapCache.set(raw, map)
    return map
  } catch {
    // Повреждённая карта не должна останавливать игру: сцена продолжит жить на
    // старых клетках, а следующая нормализация соберёт карту заново.
    return null
  }
}

export function tacticalCellMap(state) {
  return new Map((Array.isArray(state?.scene?.cells) ? state.scene.cells : [])
    .filter((cell) => Number.isSafeInteger(Number(cell?.x)) && Number.isSafeInteger(Number(cell?.y)))
    .map((cell) => [`${Number(cell.x)},${Number(cell.y)}`, cell]))
}

export function isWalkableCell(cell) {
  // Нераскрытая клетка проходима: иначе исследование невозможно в принципе.
  // Прежняя проверка `revealed === false` запирала отряд в том пятне, которое
  // досталось ему при создании сцены — шагнуть в темноту было нельзя, а
  // раскрывалась она только шагом в неё же. Стены и вода остаются
  // непроходимыми независимо от тумана, поэтому сквозь них путь всё равно не
  // построится, а само содержимое клетки игрок увидит, только дойдя до него.
  if (!cell) return false
  return ['floor', 'door'].includes(String(cell.type || 'floor').toLowerCase())
}

/**
 * Единое правило прозрачности клетки для линии обзора и линии действия.
 *
 * Проходимость и прозрачность — разные вопросы. В D&D 5e 2014 линию действия
 * перекрывает только полное укрытие — сплошное препятствие (PHB, гл. 9
 * «Укрытие»; гл. 10 «Области действия»: область распространяется по прямым от
 * точки начала, и клетка без незаслонённой прямой в область не входит). Вода,
 * яма или иная непроходимая, но открытая местность не заслоняют ни взгляда, ни
 * заклинания. Поэтому непрозрачны только стена и клетка вне карты; дверь и
 * тонкая стена живут на рёбрах и проверяются `sightEdgeBlocked`.
 *
 * Правило одно для всех серверных путей: атака (`assertClearTrajectory`),
 * прямая и обходящая углы область, круговая область `circle-grid-v2`, линия и
 * стена заклинания, раскрытие тумана при шаге и открытии двери.
 */
export function isTransparentCell(cell) {
  if (!cell) return false
  return String(cell.type ?? 'floor').toLowerCase() !== 'wall'
}

/**
 * То же правило для клетки слоя тактической карты. Соответствие типам
 * `scene.cells` задаёт `legacyCellsFromTacticalMap`: непроходимая клетка с
 * поверхностью `water` — это `water`, любая другая непроходимая — `wall`.
 */
export function isTransparentMapCell(cell) {
  if (!cell) return false
  return cell.passable === true || cell.surface === 'water'
}

/** Дальность обзора, на которую распахнутая дверь открывает соседнее помещение. */
export const DOORWAY_SIGHT_CELLS = 9

/**
 * Дальность разведки при перемещении. Меньше дверной: дверь открывает целое
 * помещение разом, а шаг — только то, что вокруг героя, иначе карта
 * раскрывалась бы вперёд отряда и исследовать было бы нечего.
 */
export const MOVEMENT_SIGHT_CELLS = 6

/**
 * Клетки, которые видны от `origin` после того, как проём открылся: обход в
 * ширину по проходимым клеткам, не пересекающий ни глухие рёбра, ни закрытые
 * двери. Это не полноценный расчёт линии обзора — он и не нужен: задача узкая,
 * открыть игроку ровно то помещение, куда теперь ведёт открытая дверь, вместо
 * чёрного пятна, в которое нельзя даже шагнуть (`isWalkableCell` считает
 * нераскрытую клетку непроходимой).
 *
 * Вынесено из `rules-engine.mjs` 2026-10-03: тем же правилом импорт карты
 * TaleSpire раскрывает то, что видно от входа сквозь окна и открытые двери.
 *
 * @param {import('../tactical-map.mjs').TacticalMap} map
 * @param {{x: number, y: number}} origin
 * @param {{ radius?: number, openedDoorId?: string|null }} [options]
 * @returns {Array<{x: number, y: number}>}
 */
export function cellsVisibleFrom(map, origin, { radius = DOORWAY_SIGHT_CELLS, openedDoorId = null } = {}) {
  const opened = openedDoorId == null ? '' : String(openedDoorId)
  const start = { x: Math.floor(Number(origin?.x)), y: Math.floor(Number(origin?.y)) }
  if (!Number.isSafeInteger(start.x) || !Number.isSafeInteger(start.y)) return []
  if (!cellAt(map, start.x, start.y)) return []
  const seen = new Map([[`${start.x},${start.y}`, 0]])
  const queue = [start]
  const found = [start]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]
    const distance = seen.get(`${current.x},${current.y}`) ?? 0
    if (distance >= radius) continue
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: current.x + dx, y: current.y + dy }
      const key = `${next.x},${next.y}`
      if (seen.has(key)) continue
      const cell = cellAt(map, next.x, next.y)
      if (!cell) continue
      const edge = edgeBetween(map, current.x, current.y, next.x, next.y)
      // Дверь, которую открывают прямо сейчас, ещё числится закрытой: событие
      // состояния применится позже, а раскрытие считается по будущей карте.
      const justOpened = opened && String(edge?.doorId ?? '') === opened
      if (edge?.blocksSight === true && !justOpened) continue
      seen.set(key, distance + 1)
      found.push(next)
      // Стену видно, но сквозь неё не смотрят: дальше обход не идёт. Воду —
      // смотрят: правило прозрачности то же, что у линии действия.
      if (isTransparentMapCell(cell)) queue.push(next)
    }
  }
  return found
}

/**
 * Перекрыт ли шаг линии обзора ребром: стеной или иной кромкой с
 * `blocksSight`, либо закрытой дверью. Диагональный шаг перекрыт, если
 * перекрыта хотя бы одна из двух ортогональных кромок угла — заклинание не
 * просачивается в щель между стеной и дверью. Клиентский двойник —
 * `sightEdgeBlocked` в `src/spell-targeting.ts`.
 */
export function sightEdgeBlocked(map, from, to) {
  if (!map) return false
  const dx = Math.sign(to.x - from.x)
  const dy = Math.sign(to.y - from.y)
  const candidates = Math.abs(dx) + Math.abs(dy) === 1
    ? [[from, to]]
    : dx && dy
      ? [[from, { x: from.x + dx, y: from.y }], [from, { x: from.x, y: from.y + dy }]]
      : []
  return candidates.some(([start, end]) => {
    const edge = edgeBetween(map, start.x, start.y, end.x, end.y)
    return edge?.blocksSight === true || edge?.kind === 'door' && movementStepBlocked(map, start.x, start.y, end.x, end.y)
  })
}

/**
 * Герой на нуле хитов, пока он не погиб, — всё ещё существо на своей клетке:
 * закончить на ней ход нельзя. Прежде клетка умирающего считалась свободной,
 * враг вставал на неё, и поднятый лечением герой делил клетку с врагом
 * (массовый прогон боевого стенда 2026-10-04, сценарий «healing»). Пройти
 * сквозь клетку недееспособного можно — набор для прохода просит
 * `includeDowned: false`.
 */
function occupiesSpace(state, actor, includeDowned) {
  if (isLivingActor(actor)) return true
  if (!includeDowned) return false
  const id = actorId(actor)
  return actor?.alive !== false
    && (state?.players ?? []).some((player) => actorId(player) === id)
    && state?.mechanics?.death?.heroes?.[id]?.status !== 'dead'
}

/**
 * Клетки умирающих героев (на нуле хитов, но не погибших): на них нельзя
 * остановиться, но сквозь них можно пройти. Отдельно — чтобы поиск пути не
 * обходил участников второй раз.
 */
export function downedHeroPositions(state, exceptActorId = null) {
  const cells = new Set()
  for (const actor of state?.players ?? []) {
    if (actorId(actor) === String(exceptActorId ?? '') || isLivingActor(actor) || !occupiesSpace(state, actor, true)) continue
    for (const cell of actorFootprintCellsAt(state, actorId(actor))) cells.add(positionKey(cell))
  }
  return cells
}

export function occupiedPositions(state, exceptActorId = null, { includeDowned = true } = {}) {
  const occupied = new Set()
  for (const actor of listActors(state)) {
    if (actorId(actor) === String(exceptActorId ?? '') || !occupiesSpace(state, actor, includeDowned)) continue
    for (const cell of actorFootprintCellsAt(state, actorId(actor))) occupied.add(positionKey(cell))
  }
  // Социальные NPC не входят в listActors, но их сохранённые посты занимают
  // клетки. Перемещение, принудительное движение и прыжки используют один
  // набор занятых клеток, чтобы герой не завершал движение поверх NPC.
  if (state?.npc_world?.placements?.length || state?.scene_npcs?.length) {
    for (const key of sceneNpcOccupiedCells(state)) occupied.add(key)
  }
  return occupied
}

/** Внутренние рёбра площади тоже должны быть проходимыми для тела. */
export function footprintPlacementEdgesBlocked(map, actor, anchor) {
  if (!map) return false
  if (footprintSizeFor(actor) <= 1) return false
  const cells = footprintCellsFor(actor, anchor)
  const keys = new Set(cells.map(positionKey))
  for (const cell of cells) {
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const next = { x: cell.x + dx, y: cell.y + dy }
      if (keys.has(positionKey(next)) && movementStepBlocked(map, cell.x, cell.y, next.x, next.y)) return true
    }
  }
  return false
}

/** Проверяет каждый пересечённый край при сдвиге anchor на одну клетку. */
export function footprintStepBlocked(map, actor, from, to) {
  if (!map) return false
  if (footprintSizeFor(actor) <= 1) return movementStepBlocked(map, from.x, from.y, to.x, to.y)
  if (footprintPlacementEdgesBlocked(map, actor, from) || footprintPlacementEdgesBlocked(map, actor, to)) return true
  const cells = footprintCellsFor(actor, from)
  for (const cell of cells) {
    const next = { x: cell.x + (to.x - from.x), y: cell.y + (to.y - from.y) }
    if (movementStepBlocked(map, cell.x, cell.y, next.x, next.y)) return true
  }
  return false
}

/**
 * Клетки, занятые server-owned реквизитом. `blocksMove` — часть TacticalProp,
 * поэтому она действует одинаково для игрока, NPC, forced movement и прыжка.
 * Состояние пропса не подменяет этот server-owned флаг: если `blocksMove`
 * установлен, клетка остаётся занятой до явного изменения самого флага в
 * карте.
 */
export function movementBlockedProp(prop) {
  return prop?.blocksMove === true
}

/** @param {any} map @returns {Set<string>} */
export function propMovementPositions(map) {
  const blocked = new Set()
  for (const prop of map?.props ?? []) {
    if (!movementBlockedProp(prop)) continue
    const cells = Array.isArray(prop.footprint) && prop.footprint.length
      ? prop.footprint
      : [{ x: Math.floor(Number(prop.x)), y: Math.floor(Number(prop.y)) }]
    for (const cell of cells) {
      if (Number.isSafeInteger(Number(cell?.x)) && Number.isSafeInteger(Number(cell?.y))) blocked.add(`${Number(cell.x)},${Number(cell.y)}`)
    }
  }
  return blocked
}

/**
 * Returns the shortest orthogonal path, excluding the starting square.
 * `stepCost` switches the search to a weighted path without changing the
 * step-count semantics used by NPC planning and other existing callers.
 */
export function shortestTacticalPath(state, actorIdValue, destination, {
  allowOccupiedDestination = false,
  stepCost = null,
  tacticalMap = undefined,
} = {}) {
  const from = actorPosition(state, actorIdValue)
  const to = { x: Number(destination?.x), y: Number(destination?.y) }
  if (!from || !Number.isSafeInteger(to.x) || !Number.isSafeInteger(to.y)) return null
  if (from.x === to.x && from.y === to.y) return []
  const cells = tacticalCellMap(state)
  const fromCell = cells.get(positionKey(from))
  if (!cells.size || !fromCell || fromCell.revealed === false) return null
  // Decode the map once for both doors and prop occupancy. Props with a
  // `blocksMove` footprint are obstacles, even when their art is painted into
  // a full-map background.
  const map = tacticalMap === undefined ? sceneTacticalMap(state) : tacticalMap
  const propOccupied = map ? propMovementPositions(map) : new Set()
  const occupied = occupiedPositions(state, actorIdValue)
  // Сквозь умирающего героя проходят, остановиться на нём — нельзя.
  const downed = downedHeroPositions(state, actorIdValue)
  const passOccupied = downed.size ? new Set([...occupied].filter((key) => !downed.has(key))) : occupied
  const hasSceneNpcs = Boolean(state?.npc_world?.placements?.length || state?.scene_npcs?.length)
  const npcTransit = hasSceneNpcs ? sceneNpcTransitCells(state) : new Set()
  const npcOccupied = hasSceneNpcs ? sceneNpcOccupiedCells(state) : new Set()
  const start = positionKey(from)
  const target = positionKey(to)
  const mover = findActor(state, actorIdValue)
  const canMoveThroughLarger = mover?.speciesBenefits?.mechanics?.move_through_larger === true
  const occupiedActors = canMoveThroughLarger ? new Map() : null
  if (occupiedActors) {
    for (const candidate of listActors(state)) {
      if (actorId(candidate) === String(actorIdValue) || !isLivingActor(candidate)) continue
      for (const cell of actorFootprintCellsAt(state, actorId(candidate))) {
        const key = positionKey(cell)
        const occupants = occupiedActors.get(key) ?? []
        occupants.push(candidate)
        occupiedActors.set(key, occupants)
      }
    }
  }
  const moverFootprintSide = footprintSizeFor(mover)
  const canPassOccupied = (position) => {
    if (positionKey(position) === target || !canMoveThroughLarger || !occupiedActors) return false
    if (moverFootprintSide === 1) {
      const occupants = occupiedActors.get(positionKey(position)) ?? []
      return occupants.length > 0 && occupants.every((occupant) => creatureSizeRank(occupant) > creatureSizeRank(mover))
    }
    const occupants = new Map()
    for (const cell of footprintCellsFor(mover, position)) {
      for (const occupant of occupiedActors.get(positionKey(cell)) ?? []) occupants.set(actorId(occupant), occupant)
    }
    return occupants.size > 0 && [...occupants.values()].every((occupant) => creatureSizeRank(occupant) > creatureSizeRank(mover))
  }
  // Закрытая и запертая дверь останавливают шаг. Карта может отсутствовать у
  // состояния, сохранённого до перехода на слои, — тогда путь считается по
  // клеткам, как раньше.
  // Weighted search may inspect thousands of candidate steps. Decode the map
  // once before the loop (or reuse the caller's decoded instance), never from
  // the per-step cost predicate.
  const canOccupyAnchor = (position, { allowTarget = false } = {}) => {
    if (moverFootprintSide === 1) {
      const key = positionKey(position)
      if (!isWalkableCell(cells.get(key)) || propOccupied.has(key)) return false
      if (npcOccupied.has(key) && (key === target || !npcTransit.has(key))) return false
      if (allowTarget) return true
      if (key === target && occupied.has(key)) return false
      return !passOccupied.has(key) || npcTransit.has(key) || canPassOccupied(position)
    }
    const footprint = footprintCellsFor(mover, position)
    if (!footprint.length) return false
    if (map && footprintPlacementEdgesBlocked(map, mover, position)) return false
    const passThroughLarger = canPassOccupied(position)
    const blocking = positionKey(position) === target ? occupied : passOccupied
    for (const cell of footprint) {
      const key = positionKey(cell)
      if (!isWalkableCell(cells.get(key)) || propOccupied.has(key)) return false
      if (npcOccupied.has(key) && (key === target || !npcTransit.has(key))) return false
      if (!blocking.has(key)) continue
      if (npcTransit.has(key)) continue
      if (allowTarget) continue
      if (!passThroughLarger) return false
    }
    return true
  }
  if (!canOccupyAnchor(to, { allowTarget: allowOccupiedDestination })) return null
  const previous = new Map([[start, null]])
  if (typeof stepCost !== 'function') {
    const queue = [start]
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor]
      if (current === target) break
      const [x, y] = current.split(',').map(Number)
      for (const [nextX, nextY] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        const next = `${nextX},${nextY}`
        const nextPosition = { x: nextX, y: nextY }
        if (previous.has(next) || !canOccupyAnchor(nextPosition, { allowTarget: allowOccupiedDestination && next === target })) continue
        if (map && (moverFootprintSide > 1
          ? footprintStepBlocked(map, mover, { x, y }, nextPosition)
          : movementStepBlocked(map, x, y, nextX, nextY))) continue
        previous.set(next, current)
        queue.push(next)
      }
    }
  } else {
    const costs = new Map([[start, 0]])
    const frontier = [{ key: start, cost: 0 }]
    const pushFrontier = (entry) => {
      frontier.push(entry)
      let child = frontier.length - 1
      while (child > 0) {
        const parent = Math.floor((child - 1) / 2)
        if (frontier[parent].cost <= frontier[child].cost) break
        ;[frontier[parent], frontier[child]] = [frontier[child], frontier[parent]]
        child = parent
      }
    }
    const popFrontier = () => {
      const first = frontier[0]
      const last = frontier.pop()
      if (frontier.length && last) {
        frontier[0] = last
        let parent = 0
        while (true) {
          const left = parent * 2 + 1
          const right = left + 1
          let smallest = parent
          if (left < frontier.length && frontier[left].cost < frontier[smallest].cost) smallest = left
          if (right < frontier.length && frontier[right].cost < frontier[smallest].cost) smallest = right
          if (smallest === parent) break
          ;[frontier[parent], frontier[smallest]] = [frontier[smallest], frontier[parent]]
          parent = smallest
        }
      }
      return first
    }

    while (frontier.length) {
      const current = popFrontier()
      if (!current || current.cost !== costs.get(current.key)) continue
      if (current.key === target) break
      const [x, y] = current.key.split(',').map(Number)
      for (const [nextX, nextY] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        const next = `${nextX},${nextY}`
        const nextPosition = { x: nextX, y: nextY }
        if (!canOccupyAnchor(nextPosition, { allowTarget: allowOccupiedDestination && next === target })) continue
        if (map && (moverFootprintSide > 1
          ? footprintStepBlocked(map, mover, { x, y }, nextPosition)
          : movementStepBlocked(map, x, y, nextX, nextY))) continue
        const weight = Math.max(1, Number(stepCost({ x: nextX, y: nextY }, map)) || 1)
        const nextCost = current.cost + weight
        if (nextCost >= (costs.get(next) ?? Number.POSITIVE_INFINITY)) continue
        costs.set(next, nextCost)
        previous.set(next, current.key)
        pushFrontier({ key: next, cost: nextCost })
      }
    }
  }
  if (!previous.has(target)) return null
  const path = []
  for (let cursor = target; cursor && cursor !== start; cursor = previous.get(cursor)) {
    const [x, y] = cursor.split(',').map(Number)
    path.unshift({ x, y })
  }
  return path
}

export function lineCells(from, to) {
  const result = []
  let x = from.x; let y = from.y
  const dx = Math.abs(to.x - x); const sx = x < to.x ? 1 : -1
  const dy = -Math.abs(to.y - y); const sy = y < to.y ? 1 : -1
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
 * Последний шаг линии — в клетку цели. Клетку цели проверяют отдельно, а
 * кромку перед ней — здесь: соседа за тонкой стеной не бьют ни выстрелом,
 * ни клинком.
 *
 * @param {Record<string, any>|null} map
 * @param {{x: number, y: number}} from
 * @param {Array<{x: number, y: number}>} trajectory
 */
function finalStepBlocked(map, from, trajectory) {
  if (!map || !trajectory.length) return false
  const previous = trajectory.length > 1 ? trajectory[trajectory.length - 2] : from
  return sightEdgeBlocked(map, previous, trajectory[trajectory.length - 1])
}

export function assertClearTrajectory(state, from, to) {
  const cells = tacticalCellMap(state)
  const trajectory = lineCells(from, to)
  const map = sceneTacticalMap(state)
  const endpoint = cells.get(positionKey(to))
  if (!isTransparentCell(endpoint)) {
    throw new RulesValidationError('Траектория заканчивается за стеной или краем карты', 'TRAJECTORY_BLOCKED')
  }
  if (trajectory.slice(0, -1).some((point, index) => {
    const cell = cells.get(positionKey(point))
    const previous = index === 0 ? from : trajectory[index - 1]
    // Диагональный шаг проверяет обе кромки угла, как и линия заклинания:
    // тонкую стену на ребре (`server/thin-walls.mjs`) иначе прошивал бы
    // выстрел наискось.
    return !isTransparentCell(cell) || sightEdgeBlocked(map, previous, point)
  }) || finalStepBlocked(map, from, trajectory)) {
    throw new RulesValidationError('Траекторию перекрывает стена или граница карты', 'TRAJECTORY_BLOCKED')
  }
  return trajectory
}

/** Подробности одной линии: нужна для выбора свободного края большой цели. */
export function trajectoryDetails(state, from, to) {
  const cells = tacticalCellMap(state)
  const map = sceneTacticalMap(state)
  const trajectory = lineCells(from, to)
  const endpoint = cells.get(positionKey(to))
  const blocked = !isTransparentCell(endpoint) || trajectory.slice(0, -1).some((point, index) => {
    const cell = cells.get(positionKey(point))
    const previous = index === 0 ? from : trajectory[index - 1]
    // Диагональный шаг проверяет обе кромки угла, как и линия заклинания:
    // тонкую стену на ребре (`server/thin-walls.mjs`) иначе прошивал бы
    // выстрел наискось.
    return !isTransparentCell(cell) || sightEdgeBlocked(map, previous, point)
  }) || finalStepBlocked(map, from, trajectory)
  return { trajectory, blocked }
}

/** Все пары клеток, которыми можно соединить площади двух существ. */
export function actorTrajectoryDetails(state, attackerId, targetId, from, to, { allowHiddenTarget = false } = {}) {
  const starts = footprintCellsFor(findActor(state, attackerId), from)
  const ends = footprintCellsFor(findActor(state, targetId), to)
  const cells = tacticalCellMap(state)
  const visibleStarts = cells.size ? starts.filter((cell) => cells.get(positionKey(cell))?.revealed === true) : starts
  const visibleEnds = cells.size ? ends.filter((cell) => cells.get(positionKey(cell))?.revealed === true) : ends
  const sourceCells = visibleStarts.length ? visibleStarts : allowHiddenTarget ? starts : []
  const targetCells = visibleEnds.length ? visibleEnds : allowHiddenTarget ? ends : []
  return sourceCells.flatMap((start) => targetCells.map((end) => ({
    start,
    end,
    ...trajectoryDetails(state, start, end),
  })))
}

/**
 * Server-owned reading of the scenery: which map features are big enough to
 * hide behind, and how much of the target they hide.  The ruleset leaves this
 * to a judgement call, so the judgement is made once, here, instead of being
 * re-invented per spell.  A wall is absent on purpose — it stops the shot
 * outright, which `assertClearTrajectory` already enforces as total cover.
 */
export const TERRAIN_COVER = Object.freeze({
  pillar: 'three-quarters', statue: 'three-quarters', tree: 'three-quarters',
  altar: 'half', barrel: 'half', bed: 'half', bookshelf: 'half', bush: 'half',
  chest: 'half', console: 'half', crate: 'half', fireplace: 'half', grave: 'half',
  rock: 'half', table: 'half', well: 'half',
})

export const COVER_BONUS = Object.freeze({ none: 0, half: 2, 'three-quarters': 5 })

/** Высота площадки под клеткой в футах; отсутствие поля означает уровень земли. */
export function elevationAt(state, position) {
  if (!position) return 0
  const cell = tacticalCellMap(state).get(positionKey(position))
  return safeInteger(cell?.elevation, 0)
}

/**
 * Преимущество с возвышенности. Это **не правило SRD** — редакция про высоту
 * молчит, — а тактическое правило в духе Baldur's Gate 3, объявленное здесь
 * явно и целиком для прежнего профиля: стрелок сверху бьёт с преимуществом,
 * снизу — с помехой. В профиле D&D 2014 это домашнее правило не применяется.
 * В ближнем бою высота не считается: на соседней клетке разница в пару футов
 * ничего не решает. Генератор карт расставляет уступы в 5 и 10 футов
 * (`generateDynamicSceneMap`), поэтому правило работает и на сгенерированных
 * картах, а не только на заданных вручную.
 */
export function highGroundBetween(state, from, to, distanceFeet) {
  if (usesDnd2014(state)) return 'level'
  if (distanceFeet == null || distanceFeet <= 5) return 'level'
  const difference = elevationAt(state, from) - elevationAt(state, to)
  if (difference >= 5) return 'higher'
  if (difference <= -5) return 'lower'
  return 'level'
}

/**
 * Cover between a shooter and its target: bodies and scenery in the line of
 * fire.  The ruleset takes the best cover available rather than adding them up,
 * so a creature behind a pillar gets three-quarters, not seven.
 */
export function coverBetween(state, attackerId, targetId, from, to) {
  const none = { level: 'none', armorClassBonus: 0, blockers: [] }
  if (!from || !to) return none
  const distance = footprintDistanceFeet(findActor(state, attackerId), findActor(state, targetId), from, to)
  if (distance == null || distance <= 5) return none
  const candidates = actorTrajectoryDetails(state, attackerId, targetId, from, to)
    .filter((entry) => !entry.blocked)
    .map((entry) => {
      const line = entry.trajectory.slice(0, -1)
      if (!line.length) return { level: 'none', armorClassBonus: 0, blockers: [], scenery: [] }
      const inLine = new Set(line.map(positionKey))
      const blockers = listActors(state)
        .filter((candidate) => {
          const id = actorId(candidate)
          if (id === String(attackerId) || id === String(targetId) || !isLivingActor(candidate)) return false
          return actorFootprintCellsAt(state, id).some((cell) => inLine.has(positionKey(cell)))
        })
        .map(actorId)
      const cells = tacticalCellMap(state)
      const scenery = line
        .map((point) => cells.get(positionKey(point)))
        .filter((cell) => cell && TERRAIN_COVER[String(cell.feature ?? '')])
      const bestScenery = scenery.some((cell) => TERRAIN_COVER[String(cell.feature)] === 'three-quarters')
        ? 'three-quarters'
        : scenery.length ? 'half' : 'none'
      const level = bestScenery === 'three-quarters' ? 'three-quarters' : blockers.length || bestScenery === 'half' ? 'half' : 'none'
      return {
        level,
        armorClassBonus: COVER_BONUS[level],
        blockers,
        scenery: [...new Set(scenery.map((cell) => String(cell.feature)))],
      }
    })
  const best = candidates.sort((left, right) => left.armorClassBonus - right.armorClassBonus)[0]
  if (!best || best.level === 'none') return none
  return {
    level: best.level,
    armorClassBonus: best.armorClassBonus,
    blockers: best.blockers,
    ...(best.scenery.length ? { scenery: best.scenery } : {}),
  }
}

export function hasClearTrajectory(state, from, to) {
  try { assertClearTrajectory(state, from, to); return true } catch (error) {
    if (error instanceof RulesValidationError && error.code === 'TRAJECTORY_BLOCKED') return false
    throw error
  }
}

export function creatureSizeRank(actor) {
  const declared = actor?.size ?? actor?.creature_size ?? actor?.creatureSize
  if (declared == null && footprintSizeFor(actor) > 1) return footprintSizeFor(actor) + 1
  const raw = String(declared ?? 'medium').toLocaleLowerCase('ru')
  if (raw.includes('gargantuan') || raw.includes('громад')) return 5
  if (raw.includes('huge') || raw.includes('огром')) return 4
  if (raw.includes('large') || raw.includes('больш')) return 3
  if (raw.includes('small') || raw.includes('мал')) return 1
  if (raw.includes('tiny') || raw.includes('крош')) return 0
  return 2
}

// @ts-check
import { cellAt, edgeBetween, edgeNeighbor, setCell, setDoor, setEdge } from './tactical-map.mjs'

/**
 * Тонкие стены: стена живёт на ребре клетки, а не занимает клетку.
 *
 * Генераторы строят стены клетками: дом 9×6 давал внутри 7×4, перегородка
 * съедала целый ряд, а на рисованных боевых картах стена — линия на границе
 * клеток. Этот проход берёт готовую планировку и отдаёт каждую клетку стены
 * соседнему помещению, а на границе ставит ребро-стену. Движок уже
 * понимает такие стены: шаг через ребро с `blocksMove` запрещён
 * (`movementStepBlocked`), взгляд через ребро с `blocksSight` — тоже
 * (`cellsVisibleFrom`, траектории), а доски — и 2D, и 3D — рисуют стену на
 * ребре полосой кладки.
 *
 * Как отдаётся клетка:
 * - стена между помещением и улицей уходит помещению — дом растёт наружу на
 *   толщину кладки;
 * - перегородка между двумя комнатами уходит меньшей: тесной спальне клетка
 *   нужнее, чем залу;
 * - угол и стык, у которых комната только по диагонали, уходят той комнате,
 *   которой отошло больше соседних клеток стены;
 * - толстая кладка и скала, не граничащие с помещением, остаются клетками, как
 *   и край карты (`keepBorder`).
 *
 * Двери и окна сохраняются: проём, оказавшийся внутри своей стены, переезжает
 * на новую границу вместе с полотном, чтобы комната не получила зубец.
 *
 * Модуль — лист поверх `tactical-map.mjs`, состояния не хранит. Карта,
 * уже записанная в событие, не перестраивается: проход меняет только новые.
 */

export const THIN_WALLS_VERSION = 'thin-walls/v1'

/** Рёбра-проёмы, которые проход не заменяет глухой стеной. */
const OPENINGS = new Set(['door', 'window', 'loophole', 'grate', 'rail'])

/** @type {ReadonlyArray<[number, number]>} */
const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

/**
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {{keepBorder?: boolean, wallMaterial?: string}} [options]
 * @returns {{converted: number}} сколько клеток стены отдано помещениям
 */
export function thinWalls(map, { keepBorder = true } = {}) {
  const zoneById = new Map(map.zones.map((zone) => [zone.id, zone]))
  const key = (/** @type {number} */ x, /** @type {number} */ y) => `${x},${y}`
  const onBorder = (/** @type {number} */ x, /** @type {number} */ y) => x === 0 || y === 0 || x === map.width - 1 || y === map.height - 1
  /** Комната — проходимая клетка помещения; служебная зона `walls` комнатой не считается. */
  const roomZone = (/** @type {number} */ x, /** @type {number} */ y) => {
    const cell = cellAt(map, x, y)
    if (!cell?.passable || cell.zone === 'walls') return ''
    return zoneById.get(cell.zone)?.kind === 'interior' ? cell.zone : ''
  }
  const isWall = (/** @type {number} */ x, /** @type {number} */ y) => {
    const cell = cellAt(map, x, y)
    return Boolean(cell) && !cell?.passable && cell?.surface !== 'water' && !(keepBorder && onBorder(x, y))
  }
  /** @type {Map<string, number>} */
  const roomSize = new Map()
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const zone = roomZone(x, y)
    if (zone) roomSize.set(zone, (roomSize.get(zone) ?? 0) + 1)
  }
  const preferred = (/** @type {string[]} */ zones) => [...new Set(zones)]
    .sort((left, right) => (roomSize.get(left) ?? 0) - (roomSize.get(right) ?? 0) || left.localeCompare(right))[0]

  /** @type {Map<string, {x: number, y: number, zone: string, source: {x: number, y: number}}>} */
  const owner = new Map()
  // Проход 1: клетка стены рядом с комнатой.
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    if (!isWall(x, y)) continue
    const rooms = DIRECTIONS.map(([dx, dy]) => ({ x: x + dx, y: y + dy, zone: roomZone(x + dx, y + dy) })).filter((entry) => entry.zone)
    if (!rooms.length) continue
    const zone = preferred(rooms.map((entry) => entry.zone))
    const source = /** @type {{x: number, y: number}} */ (rooms.find((entry) => entry.zone === zone))
    owner.set(key(x, y), { x, y, zone, source })
  }
  // Проход 1б: второй слой толстой стены между комнатой и улицей (двор
  // внутри корпуса, утолщённая наружная стена). Слой, отделяющий комнату от
  // скалы или другой толщи, не трогается: улица должна быть по другую сторону.
  const outside = (/** @type {number} */ x, /** @type {number} */ y) => {
    const cell = cellAt(map, x, y)
    return Boolean(cell?.passable) && zoneById.get(cell?.zone ?? '')?.kind !== 'interior'
  }
  const firstPass = new Map(owner)
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    if (!isWall(x, y) || owner.has(key(x, y))) continue
    // Сквозь стену: отданная клетка первого прохода и улица — строго по разные
    // стороны, а не вдоль стены.
    const inner = DIRECTIONS.map(([dx, dy]) => ({ entry: firstPass.get(key(x + dx, y + dy)), dx, dy }))
      .find(({ entry, dx, dy }) => entry && outside(x - dx, y - dy))
    if (!inner?.entry) continue
    owner.set(key(x, y), { x, y, zone: inner.entry.zone, source: inner.entry.source })
  }
  // Проход 2: углы и стыки. Клетка уходит комнате, которой отошло больше
  // соседних клеток стены, если эта комната видна по диагонали между ними —
  // иначе это толща кладки, и она остаётся клеткой.
  for (let round = 0; round < 2; round += 1) {
    /** @type {Array<{x: number, y: number, zone: string, source: {x: number, y: number}}>} */
    const found = []
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      if (!isWall(x, y) || owner.has(key(x, y))) continue
      /** @type {Map<string, Array<[number, number]>>} */
      const byZone = new Map()
      for (const [dx, dy] of DIRECTIONS) {
        const entry = owner.get(key(x + dx, y + dy))
        if (entry) byZone.set(entry.zone, [...(byZone.get(entry.zone) ?? []), [dx, dy]])
      }
      const ranked = [...byZone].sort((left, right) => right[1].length - left[1].length
        || (roomSize.get(left[0]) ?? 0) - (roomSize.get(right[0]) ?? 0) || left[0].localeCompare(right[0]))
      for (const [zone, sides] of ranked) {
        if (sides.length < 2) continue
        // Диагональ между двумя перпендикулярными соседями — комната той же зоны.
        const diagonal = sides.flatMap(([ax, ay]) => sides.filter(([bx, by]) => ax * bx + ay * by === 0).map(([bx, by]) => ({ x: x + ax + bx, y: y + ay + by })))
          .find((cell) => roomZone(cell.x, cell.y) === zone)
        if (!diagonal) continue
        found.push({ x, y, zone, source: diagonal })
        break
      }
    }
    for (const entry of found) owner.set(key(entry.x, entry.y), entry)
    if (!found.length) break
  }

  // Клетки стены становятся полом своей комнаты.
  for (const { x, y, zone, source } of owner.values()) {
    const floor = cellAt(map, source.x, source.y)
    setCell(map, x, y, {
      passable: true,
      zone,
      material: floor?.material ?? zoneById.get(zone)?.material ?? 'stone',
      surface: 'none',
      ...(floor?.elevation !== undefined ? { elevation: floor.elevation } : {}),
    })
  }
  // Границы: внутри комнаты рёбер нет, на границе — стена, если там не проём.
  for (const { x, y, zone } of owner.values()) {
    for (const [dx, dy] of DIRECTIONS) {
      const nx = x + dx
      const ny = y + dy
      const neighbor = cellAt(map, nx, ny)
      if (!neighbor?.passable) continue
      const existing = edgeBetween(map, x, y, nx, ny)
      if (neighbor.zone === zone) {
        if (existing && existing.kind !== 'door') setEdge(map, x, y, nx, ny, { kind: 'none' })
        continue
      }
      if (existing && OPENINGS.has(existing.kind)) continue
      setEdge(map, x, y, nx, ny, { kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' })
    }
  }
  absorbDoorCells(map, zoneById)
  realignDoorways(map, owner, key)
  return { converted: owner.size }
}

/**
 * Клетка проёма, оставшаяся за служебной зоной (`walls`) или без зоны, —
 * ниша в одну клетку посреди новой тонкой стены. Она отходит комнате по ту
 * сторону, где полотна нет, а полотно остаётся на своём ребре.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {Map<string, Record<string, any>>} zoneById
 */
function absorbDoorCells(map, zoneById) {
  const isRoom = (/** @type {Record<string, any>|null|undefined} */ cell) => Boolean(cell?.passable)
    && cell?.zone !== 'walls' && zoneById.get(cell?.zone ?? '')?.kind === 'interior'
  // Проход без двери, прорубленный в стене (петля, связка графа), — та же
  // ниша: отходит соседней комнате, рёбра пересчитываются.
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (!cell?.passable || isRoom(cell) || zoneById.get(cell.zone ?? '')?.kind === 'exterior') continue
    if (map.doors.some((door) => [{ x: door.x, y: door.y }, edgeNeighbor(door)].some((end) => end.x === x && end.y === y))) continue
    const room = DIRECTIONS.map(([dx, dy]) => cellAt(map, x + dx, y + dy)).find(isRoom)
    if (!room) continue
    setCell(map, x, y, { zone: room.zone, material: room.material })
    for (const [dx, dy] of DIRECTIONS) {
      const neighbor = cellAt(map, x + dx, y + dy)
      if (!neighbor?.passable) continue
      const existing = edgeBetween(map, x, y, x + dx, y + dy)
      if (neighbor.zone === room.zone || !isRoom(neighbor)) { if (existing && existing.kind === 'wall') setEdge(map, x, y, x + dx, y + dy, { kind: 'none' }) }
    }
  }
  for (const door of map.doors) {
    const ends = [{ x: door.x, y: door.y }, edgeNeighbor(door)]
    for (const [index, doorway] of ends.entries()) {
      const cell = cellAt(map, doorway.x, doorway.y)
      if (!cell?.passable || isRoom(cell) || zoneById.get(cell.zone ?? '')?.kind === 'exterior') continue
      const across = ends[1 - index]
      const beyond = { x: doorway.x * 2 - across.x, y: doorway.y * 2 - across.y }
      const room = cellAt(map, beyond.x, beyond.y)
      if (!isRoom(room)) continue
      setCell(map, doorway.x, doorway.y, { zone: room?.zone, material: room?.material })
      for (const [dx, dy] of DIRECTIONS) {
        const nx = doorway.x + dx
        const ny = doorway.y + dy
        if (nx === across.x && ny === across.y) continue
        const neighbor = cellAt(map, nx, ny)
        if (!neighbor?.passable) continue
        const existing = edgeBetween(map, doorway.x, doorway.y, nx, ny)
        if (neighbor.zone === room?.zone) { if (existing && existing.kind !== 'door') setEdge(map, doorway.x, doorway.y, nx, ny, { kind: 'none' }) }
        else if (!existing || !OPENINGS.has(existing.kind)) setEdge(map, doorway.x, doorway.y, nx, ny, { kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' })
      }
      break
    }
  }
}

/**
 * Проём двери в перегородке был клеткой одной комнаты, а соседние клетки той
 * же стены могли отойти другой — у комнаты появлялся зубец с дверью на
 * конце. Проём переходит к той же комнате, что и стена вокруг него, а полотно
 * двери — на его дальнее ребро, то есть на новую границу.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {Map<string, {zone: string}>} owner
 * @param {(x: number, y: number) => string} key
 */
function realignDoorways(map, owner, key) {
  for (const door of [...map.doors]) {
    const ends = [{ x: door.x, y: door.y }, edgeNeighbor(door)]
    for (const [index, doorway] of ends.entries()) {
      const across = ends[1 - index]
      const doorwayCell = cellAt(map, doorway.x, doorway.y)
      const acrossCell = cellAt(map, across.x, across.y)
      if (!doorwayCell?.passable || !acrossCell?.passable || owner.has(key(doorway.x, doorway.y))) continue
      const step = { x: doorway.x - across.x, y: doorway.y - across.y }
      // Соседи проёма вдоль стены — перпендикулярно направлению двери.
      const along = [{ x: doorway.x + step.y, y: doorway.y + step.x }, { x: doorway.x - step.y, y: doorway.y - step.x }]
      const wallZones = along.map((cell) => owner.get(key(cell.x, cell.y))?.zone).filter(Boolean)
      if (!wallZones.length || wallZones.some((zone) => zone !== acrossCell.zone) || doorwayCell.zone === acrossCell.zone) continue
      const beyond = { x: doorway.x + step.x, y: doorway.y + step.y }
      const beyondCell = cellAt(map, beyond.x, beyond.y)
      if (!beyondCell?.passable || beyondCell.zone !== doorwayCell.zone) continue
      // Проём — пол комнаты за ним, полотно — на ребре к его прежней комнате.
      // Закрыта ли дверь, хранит ребро, а не запись двери: флаги переносятся.
      const leaf = edgeBetween(map, doorway.x, doorway.y, across.x, across.y)
      setCell(map, doorway.x, doorway.y, { zone: acrossCell.zone, material: acrossCell.material })
      setEdge(map, doorway.x, doorway.y, across.x, across.y, { kind: 'none' })
      for (const cell of along) {
        if (cellAt(map, cell.x, cell.y)?.zone === acrossCell.zone) setEdge(map, doorway.x, doorway.y, cell.x, cell.y, { kind: 'none' })
      }
      const edge = beyond.x > doorway.x || beyond.y > doorway.y
        ? { x: doorway.x, y: doorway.y, dir: /** @type {'e'|'s'} */ (beyond.x > doorway.x ? 'e' : 's') }
        : { x: beyond.x, y: beyond.y, dir: /** @type {'e'|'s'} */ (beyond.x < doorway.x ? 'e' : 's') }
      setDoor(map, { ...door, ...edge, blocksMove: leaf?.blocksMove === true, blocksSight: leaf?.blocksSight === true })
      break
    }
  }
}

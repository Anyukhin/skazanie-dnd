// @ts-check
import { cellAt, edgeBetween, setCell, setEdge } from './tactical-map.mjs'

/**
 * Приёмы Жакейс для собранной сцены: второй вход в дальнюю комнату и перепад
 * высот. Модуль детерминирован и модели не зовёт.
 *
 * - `deepestRoom` — самое дальнее от входа помещение и число дверей в него.
 *   Сцена тем (`scene-themes.mjs`) прорубает ему второй вход, если дверь
 *   одна: подземелье перестаёт быть цепочкой, у засады появляется тыл, у
 *   отряда — путь отступления.
 * - `raiseDais` — помост вдоль дальней стены зала на пять футов: алтарь,
 *   саркофаг или высокий стол стоят выше пола, и стрелок на помосте получает
 *   высоту (`highGroundBetween`). Ступени — проход в середине кромки.
 *
 * Помост поднимает окончательный пол, поэтому идёт после `thinWalls` и до
 * расстановки предметов: это геометрия, а не мебель.
 */

export const SCENE_FEATURES_VERSION = 'scene-features/v1'

const DIRECTIONS = Object.freeze([[1, 0], [0, 1], [-1, 0], [0, -1]])

/** @param {number} x @param {number} y */
const key = (x, y) => `${x},${y}`

/**
 * Самое дальнее от точки появления отряда помещение — по шагам через двери —
 * и сколько дверей в него ведёт.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @returns {{zoneId: string, steps: number, doors: number}|null}
 */
export function deepestRoom(map) {
  const spawn = map.spawnPoints.find((point) => point.role === 'party')
  if (!spawn) return null
  const interior = new Set(map.zones.filter((zone) => zone.kind === 'interior').map((zone) => zone.id))
  /** @type {Map<string, number>} */
  const depths = new Map()
  const queue = [{ x: spawn.x, y: spawn.y, steps: 0 }]
  const seen = new Set([key(spawn.x, spawn.y)])
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    const zone = cellAt(map, current.x, current.y)?.zone ?? ''
    if (!depths.has(zone)) depths.set(zone, current.steps)
    for (const [dx, dy] of DIRECTIONS) {
      const nx = current.x + dx
      const ny = current.y + dy
      if (seen.has(key(nx, ny)) || !cellAt(map, nx, ny)?.passable) continue
      const edge = edgeBetween(map, current.x, current.y, nx, ny)
      if (edge && edge.kind !== 'door' && edge.blocksMove) continue
      seen.add(key(nx, ny))
      queue.push({ x: nx, y: ny, steps: current.steps + 1 })
    }
  }
  const entrance = cellAt(map, spawn.x, spawn.y)?.zone ?? ''
  const [deepest] = [...depths]
    .filter(([zone]) => zone && zone !== entrance && interior.has(zone))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  if (!deepest) return null
  const [zoneId, steps] = deepest
  const doors = map.doors.filter((door) => [
    cellAt(map, door.x, door.y)?.zone,
    cellAt(map, door.dir === 'e' ? door.x + 1 : door.x, door.dir === 's' ? door.y + 1 : door.y)?.zone,
  ].includes(zoneId)).length
  return { zoneId, steps, doors }
}

/**
 * Помост вдоль дальней от входа стены помещения: полоса глубиной \`depth\`
 * клеток поднимается на \`height\` футов, кромка помоста — уступ (\`ledge\`),
 * в середине кромки — ступени без уступа. Клетки у дверей не поднимаются:
 * дверной проём не встаёт на ступеньку.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {string} zoneId
 * @param {{height?: number, depth?: number}} [options]
 * @returns {number} сколько клеток поднято
 */
export function raiseDais(map, zoneId, { height = 5, depth = 2 } = {}) {
  /** @type {Array<{x: number, y: number}>} */
  const cells = []
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (cell?.passable && cell.zone === zoneId) cells.push({ x, y })
  }
  if (cells.length < 40) return 0
  const inZone = new Set(cells.map((cell) => key(cell.x, cell.y)))
  const doorCells = new Set()
  for (const door of map.doors) {
    const ends = [{ x: door.x, y: door.y }, { x: door.dir === 'e' ? door.x + 1 : door.x, y: door.dir === 's' ? door.y + 1 : door.y }]
    for (const end of ends) for (const [dx, dy] of [[0, 0], ...DIRECTIONS]) doorCells.add(key(end.x + dx, end.y + dy))
  }
  const spawn = map.spawnPoints.find((point) => point.role === 'party')
  const minX = Math.min(...cells.map((cell) => cell.x))
  const maxX = Math.max(...cells.map((cell) => cell.x))
  const minY = Math.min(...cells.map((cell) => cell.y))
  const maxY = Math.max(...cells.map((cell) => cell.y))
  // Сторона помоста — дальняя от входа в помещение: от двери, через которую
  // в него попадают, или от точки появления отряда.
  const doorsHere = map.doors.filter((door) => inZone.has(key(door.x, door.y))
    || inZone.has(key(door.dir === 'e' ? door.x + 1 : door.x, door.dir === 's' ? door.y + 1 : door.y)))
  const anchor = doorsHere[0] ?? spawn ?? { x: (minX + maxX) / 2, y: maxY }
  const sides = [
    { side: 'n', distance: anchor.y - minY },
    { side: 's', distance: maxY - anchor.y },
    { side: 'w', distance: anchor.x - minX },
    { side: 'e', distance: maxX - anchor.x },
  ].sort((left, right) => right.distance - left.distance)
  const side = sides[0].side
  const onDais = (/** @type {{x: number, y: number}} */ cell) => side === 'n' ? cell.y < minY + depth
    : side === 's' ? cell.y > maxY - depth
      : side === 'w' ? cell.x < minX + depth
        : cell.x > maxX - depth
  const raised = cells.filter((cell) => onDais(cell) && !doorCells.has(key(cell.x, cell.y)))
  if (raised.length < 6) return 0
  const raisedKeys = new Set(raised.map((cell) => key(cell.x, cell.y)))
  for (const cell of raised) setCell(map, cell.x, cell.y, { elevation: height })
  // Кромка — уступ; ступени — две клетки в середине кромки.
  const horizontal = side === 'n' || side === 's'
  const middle = horizontal ? Math.floor((minX + maxX) / 2) : Math.floor((minY + maxY) / 2)
  for (const cell of raised) {
    for (const [dx, dy] of DIRECTIONS) {
      const near = { x: cell.x + dx, y: cell.y + dy }
      if (!inZone.has(key(near.x, near.y)) || raisedKeys.has(key(near.x, near.y))) continue
      const along = horizontal ? cell.x : cell.y
      if (along === middle || along === middle + 1) continue
      setEdge(map, cell.x, cell.y, near.x, near.y, { kind: 'ledge', blocksMove: false, blocksSight: false, cover: 'half' })
    }
  }
  return raised.length
}

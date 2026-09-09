import {
  addSpawnPoint,
  cellAt,
  createTacticalMap,
  forEachCell,
  legacyCellsFromTacticalMap,
  reachableCells,
  serializeTacticalMap,
  setCell,
  setEdge,
  validateTacticalMap,
} from './tactical-map.mjs'

/** Версия независимого от кампании набора арен боевого стенда. */
export const COMBAT_LAB_MAPS_VERSION = 'skazanie:combat-lab-maps-v1'

const clone = (value) => structuredClone(value)

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function mapCells(map) {
  return legacyCellsFromTacticalMap(map).map((raw) => {
    const cell = cellAt(map, raw.x, raw.y)
    return {
      x: raw.x,
      y: raw.y,
      type: raw.type,
      passable: Boolean(cell?.passable),
      ...(cell?.moveCost > 1 ? { difficult: true } : {}),
    }
  })
}

function pointKey(point) {
  return `${point.x},${point.y}`
}

function uniquePoints(points) {
  const seen = new Set()
  return (Array.isArray(points) ? points : []).filter((point) => {
    const key = pointKey(point)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function obstacle(map, x, y, surface = 'none') {
  setCell(map, x, y, { passable: false, revealed: true, surface })
}

function difficult(map, points, surface = null) {
  for (const point of points) setCell(map, point.x, point.y, {
    moveCost: 2,
    ...(surface ? { surface } : {}),
  })
}

function difficultRect(width, height, x0, y0, x1, y1, surface = null) {
  const points = []
  for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y += 1) {
    for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x += 1) points.push({ x, y })
  }
  return points
}

// Карточки используют непроходимые клетки как физические препятствия, но
// линии обзора также должны видеть их как стены. Рёбра строятся одним проходом
// после всех layout-правок, поэтому здесь нет дублирования по соседним стенам.
function wallEdgesAroundObstacles(map) {
  forEachCell(map, (cell) => {
    if (cell.passable) return
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const neighbour = cellAt(map, cell.x + dx, cell.y + dy)
      if (!neighbour?.passable) continue
      setEdge(map, cell.x, cell.y, neighbour.x, neighbour.y, {
        kind: 'wall',
        blocksMove: true,
        blocksSight: true,
        cover: 'three_quarters',
      })
    }
  })
}

function addSpawns(map, role, points) {
  for (const [index, point] of uniquePoints(points).entries()) addSpawnPoint(map, {
    id: `${role}-${index + 1}`,
    x: point.x,
    y: point.y,
    role,
  })
}

function createMap({
  id,
  name,
  description,
  width,
  height,
  material = 'stone',
  theme,
  build,
  partySpawns,
  enemySpawns,
  neutralSpawns = [],
  recommendedEnemyTypes,
}) {
  const map = createTacticalMap({
    width,
    height,
    locationId: `combat-lab:${id}`,
    seed: `combat-lab:${id}`,
    generator: { id: 'combat-lab-library', version: COMBAT_LAB_MAPS_VERSION },
    theme,
    tilesetId: 'skazanie-combat-lab',
    fill: { passable: true, revealed: true, material },
  })
  build(map, width, height)
  wallEdgesAroundObstacles(map)
  addSpawns(map, 'party', partySpawns)
  addSpawns(map, 'enemy', enemySpawns)
  addSpawns(map, 'neutral', neutralSpawns)

  const validation = validateTacticalMap(map)
  if (!validation.ok) throw new Error(`Некорректная карта ${id}: ${JSON.stringify(validation.errors)}`)

  const partyStart = uniquePoints(partySpawns)[0]
  const reachable = partyStart ? reachableCells(map, partyStart.x, partyStart.y) : new Set()
  for (const point of [...uniquePoints(partySpawns), ...uniquePoints(enemySpawns), ...uniquePoints(neutralSpawns)]) {
    if (!reachable.has(pointKey(point))) throw new Error(`Точка ${id} ${pointKey(point)} недостижима от отряда`)
  }

  const serialized = serializeTacticalMap(map)
  return deepFreeze({
    id,
    name,
    description,
    width,
    height,
    theme: map.theme,
    cells: mapCells(map),
    map: serialized,
    spawnPoints: clone(map.spawnPoints),
    recommended_enemy_types: [...recommendedEnemyTypes],
    obstacle_count: [...mapCells(map)].filter((cell) => cell.type === 'wall' || cell.type === 'water').length,
    terrain_features: {
      difficult_cells: mapCells(map).filter((cell) => cell.difficult).length,
      wall_edges: Object.values(map.edges).filter((edge) => edge.kind === 'wall').length,
    },
  })
}

const OPEN_PARTY = [
  { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 },
  { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 },
]

const OPEN_ENEMIES = [
  { x: 8, y: 0 }, { x: 9, y: 0 }, { x: 8, y: 1 }, { x: 9, y: 1 },
  { x: 8, y: 2 }, { x: 9, y: 2 }, { x: 8, y: 3 }, { x: 9, y: 3 },
  { x: 8, y: 4 }, { x: 9, y: 4 }, { x: 8, y: 5 }, { x: 9, y: 5 },
]

const HALL_PARTY = [
  { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 },
  { x: 1, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 },
]

const HALL_ENEMIES = [
  { x: 10, y: 0 }, { x: 11, y: 0 }, { x: 10, y: 1 }, { x: 11, y: 1 },
  { x: 10, y: 2 }, { x: 11, y: 2 }, { x: 10, y: 4 }, { x: 11, y: 4 },
  { x: 10, y: 5 }, { x: 11, y: 5 }, { x: 10, y: 6 }, { x: 11, y: 6 },
]

const MARSH_PARTY = [
  { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 },
  { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 },
]

const MARSH_ENEMIES = [
  { x: 9, y: 0 }, { x: 10, y: 0 }, { x: 9, y: 1 }, { x: 10, y: 1 },
  { x: 9, y: 2 }, { x: 10, y: 2 }, { x: 9, y: 5 }, { x: 10, y: 5 },
  { x: 9, y: 6 }, { x: 10, y: 6 }, { x: 9, y: 7 }, { x: 10, y: 7 },
]

const PILLAR_PARTY = [
  { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 },
  { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 },
]

const PILLAR_ENEMIES = [
  { x: 12, y: 0 }, { x: 13, y: 0 }, { x: 12, y: 1 }, { x: 13, y: 1 },
  { x: 12, y: 2 }, { x: 13, y: 2 }, { x: 12, y: 6 }, { x: 13, y: 6 },
  { x: 12, y: 7 }, { x: 13, y: 7 }, { x: 10, y: 7 }, { x: 11, y: 7 },
]

const FOREST_PARTY = [
  { x: 0, y: 3 }, { x: 0, y: 4 }, { x: 0, y: 5 },
  { x: 1, y: 3 }, { x: 1, y: 4 }, { x: 1, y: 5 },
]

const FOREST_ENEMIES = [
  { x: 14, y: 3 }, { x: 15, y: 3 }, { x: 14, y: 4 }, { x: 15, y: 4 },
  { x: 14, y: 5 }, { x: 15, y: 5 }, { x: 14, y: 6 }, { x: 15, y: 6 },
  { x: 13, y: 2 }, { x: 14, y: 2 }, { x: 13, y: 7 }, { x: 14, y: 7 },
]

const BRIDGE_PARTY = [
  { x: 0, y: 2 }, { x: 0, y: 3 }, { x: 0, y: 4 },
  { x: 1, y: 2 }, { x: 1, y: 3 }, { x: 1, y: 4 },
]

const BRIDGE_ENEMIES = [
  { x: 13, y: 2 }, { x: 14, y: 2 }, { x: 13, y: 3 }, { x: 14, y: 3 },
  { x: 13, y: 4 }, { x: 14, y: 4 }, { x: 13, y: 5 }, { x: 14, y: 5 },
  { x: 12, y: 1 }, { x: 13, y: 1 }, { x: 12, y: 6 }, { x: 13, y: 6 },
]

const TOWER_PARTY = [
  { x: 1, y: 7 }, { x: 2, y: 7 }, { x: 1, y: 8 },
  { x: 2, y: 8 }, { x: 3, y: 7 }, { x: 3, y: 8 },
]

const TOWER_ENEMIES = [
  { x: 8, y: 1 }, { x: 9, y: 1 }, { x: 10, y: 1 }, { x: 8, y: 2 },
  { x: 9, y: 2 }, { x: 10, y: 2 }, { x: 8, y: 3 }, { x: 9, y: 3 },
  { x: 10, y: 3 }, { x: 7, y: 1 }, { x: 7, y: 2 }, { x: 7, y: 3 },
]

export const COMBAT_LAB_MAPS = deepFreeze([
  createMap({
    id: 'open-courtyard',
    name: 'Открытый двор',
    description: 'Каменный двор с полосой осыпавшейся плитки: местность замедляет шаг, но не перекрывает обзор.',
    width: 10,
    height: 6,
    theme: 'courtyard',
    build: (map) => {
      difficult(map, difficultRect(10, 6, 3, 2, 6, 2), 'rubble')
      for (const [x, y] of [[4, 1], [5, 1], [4, 4], [5, 4]]) obstacle(map, x, y)
    },
    partySpawns: OPEN_PARTY,
    enemySpawns: OPEN_ENEMIES,
    recommendedEnemyTypes: ['humanoid', 'beast'],
  }),
  createMap({
    id: 'ruined-hall',
    name: 'Разрушенный зал',
    description: 'Обвалившаяся перегородка оставляет один проход в центре; полоса щебня на дальней стороне требует двойного движения.',
    width: 12,
    height: 7,
    theme: 'ruins',
    build: (map, width, height) => {
      for (let y = 0; y < height; y += 1) if (y !== Math.floor(height / 2)) obstacle(map, 5, y)
      difficult(map, difficultRect(width, height, 2, 4, 9, 4), 'rubble')
    },
    partySpawns: HALL_PARTY,
    enemySpawns: HALL_ENEMIES,
    recommendedEnemyTypes: ['humanoid', 'undead'],
  }),
  createMap({
    id: 'marsh-crossing',
    name: 'Болотная переправа',
    description: 'Топкая низина с двумя затопленными карманами и сухой центральной тропой, ведущей к противнику.',
    width: 11,
    height: 8,
    material: 'earth',
    theme: 'marsh',
    build: (map, width, height) => {
      difficult(map, difficultRect(width, height, 2, 2, width - 3, height - 3), 'mud')
      for (const [x, y] of [[2, 2], [3, 2], [2, 3], [7, 4], [8, 4], [8, 5]]) obstacle(map, x, y, 'water')
      for (let y = 0; y < height; y += 1) setCell(map, Math.floor(width / 2), y, { moveCost: 1, surface: 'none', material: 'wood' })
    },
    partySpawns: MARSH_PARTY,
    enemySpawns: MARSH_ENEMIES,
    recommendedEnemyTypes: ['beast', 'monstrosity', 'humanoid'],
  }),
  createMap({
    id: 'pillar-chamber',
    name: 'Зал колонн',
    description: 'Прямоугольная палата с колоннами и поперечной полосой скользкого камня; укрытия меняют выгодную линию атаки.',
    width: 14,
    height: 8,
    theme: 'chamber',
    build: (map) => {
      for (const [x, y] of [[3, 2], [3, 5], [6, 2], [6, 5], [9, 2], [9, 5], [11, 3], [11, 4]]) obstacle(map, x, y)
      difficult(map, difficultRect(14, 8, 1, 3, 12, 3), 'rubble')
    },
    partySpawns: PILLAR_PARTY,
    enemySpawns: PILLAR_ENEMIES,
    recommendedEnemyTypes: ['humanoid', 'giant'],
  }),
  createMap({
    id: 'forest-clearing',
    name: 'Лесная поляна',
    description: 'Заросшая поляна с мокрой травой и группами деревьев: дальние атаки прерываются плотными стволами.',
    width: 16,
    height: 10,
    material: 'grass',
    theme: 'forest',
    build: (map) => {
      difficult(map, difficultRect(16, 10, 2, 4, 13, 6), 'mud')
      for (const [x, y] of [
        [4, 2], [5, 2], [4, 3], [10, 7], [11, 7], [10, 8],
        [7, 4], [7, 5], [12, 2], [12, 3],
      ]) obstacle(map, x, y)
    },
    partySpawns: FOREST_PARTY,
    enemySpawns: FOREST_ENEMIES,
    recommendedEnemyTypes: ['beast', 'monstrosity', 'humanoid'],
  }),
  createMap({
    id: 'cavern-bridge',
    name: 'Пещерный мост',
    description: 'Глубокая вода разрезает пещеру; узкий каменный мост остаётся единственным проходом между берегами.',
    width: 15,
    height: 9,
    material: 'earth',
    theme: 'cave',
    build: (map) => {
      for (let x = 2; x <= 12; x += 1) for (let y = 3; y <= 5; y += 1) obstacle(map, x, y, 'water')
      for (let y = 3; y <= 5; y += 1) setCell(map, 7, y, { passable: true, material: 'stone', surface: 'none', moveCost: 1 })
      for (let y = 3; y <= 5; y += 1) {
        setEdge(map, 6, y, 7, y, { kind: 'ledge', blocksMove: false, blocksSight: false, cover: 'half' })
        setEdge(map, 7, y, 8, y, { kind: 'ledge', blocksMove: false, blocksSight: false, cover: 'half' })
      }
    },
    partySpawns: BRIDGE_PARTY,
    enemySpawns: BRIDGE_ENEMIES,
    recommendedEnemyTypes: ['ooze', 'undead', 'monstrosity'],
  }),
  createMap({
    id: 'watchtower-terrace',
    name: 'Терраса дозорной башни',
    description: 'Каменная башня с поднятой площадкой и обходной лестницей; высота видна в карте, но не отменяет обычную проверку шага.',
    width: 12,
    height: 10,
    theme: 'fortress',
    build: (map) => {
      const terrace = difficultRect(12, 10, 4, 1, 10, 3)
      for (const point of terrace) setCell(map, point.x, point.y, { elevation: 1, moveCost: 1 })
      for (const [x, y] of [[4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 0], [4, 4], [10, 4]]) obstacle(map, x, y)
      difficult(map, difficultRect(12, 10, 4, 5, 10, 5), 'rubble')
      // Лестничный пролёт остаётся проходимым между террасой и нижним двором.
      for (const x of [5, 6, 7]) setCell(map, x, 4, { passable: true, moveCost: 1, material: 'stone' })
    },
    partySpawns: TOWER_PARTY,
    enemySpawns: TOWER_ENEMIES,
    recommendedEnemyTypes: ['humanoid', 'undead', 'dragon'],
  }),
])

const MAP_BY_ID = new Map(COMBAT_LAB_MAPS.map((map) => [map.id, map]))

/** Возвращает копию карты, чтобы сборка боя не могла изменить библиотеку. */
export function combatLabMapById(id) {
  const map = MAP_BY_ID.get(String(id))
  return map ? clone(map) : null
}

/** Каталог копий для API и UI; сериализация остаётся чистым JSON-объектом. */
export function combatLabMapCatalog() {
  return COMBAT_LAB_MAPS.map(clone)
}

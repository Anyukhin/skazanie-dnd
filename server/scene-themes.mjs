// @ts-check
import { createHash } from 'node:crypto'

import { buildBuildingScene } from './building-generator.mjs'
import { buildSceneFromGraph } from './graph-layout.mjs'
import { addSceneLink, addSceneZone, createSceneGraph } from './scene-graph.mjs'
import { placeProps } from './prop-placement.mjs'
import {
  SIZE_CLASSES,
  addSpawnPoint,
  addZone,
  cellAt,
  createTacticalMap,
  edgeList,
  edgeNeighbor,
  setCell,
  setDoor,
  setEdge,
} from './tactical-map.mjs'

/**
 * Каталог тем сцены — этап M6 (`docs/tactical-map-plan.md`, раздел 12).
 *
 * Тема = набор материалов, набор предметов и правила расстановки. Геометрия
 * берётся одним из трёх способов, и выбор способа — часть темы:
 *
 * - `building` — здание с участком, отдельный генератор планировки;
 * - `graph` — сначала граф зон с проверкой ключей, затем подходящая теме
 *   геометрия. Храм и склеп получают помещения, пещера — органическую полость;
 * - `open` — открытая местность без помещений: лес и дорога;
 * - `settlement` — открытая местность с улицей и отдельными домами.
 *
 * Опознание темы идёт по названию локации и по виду сцены. Это единственное
 * место, где такое опознание живёт: раньше оно было размазано регулярками по
 * `dynamic-map.mjs`.
 */

/**
 * `live` — отдаётся ли тема живой игре. Сейчас готовы все семь; флаг остаётся
 * явным предохранителем для будущих тем, которые ещё хуже структурированного
 * fallback.
 *
 * Сравнение обеих карт на одном seed, 2026-07-29:
 *
 * | Тема | Тематический генератор | Итог |
 * | --- | --- | --- |
 * | building | дом из трёх помещений, окна, проёмы, двор, 21 предмет | лучше |
 * | temple | четыре палаты с алтарём и колоннами, 25 предметов | лучше |
 * | crypt | четыре палаты, запертая дверь с ключом, 27 предметов | лучше |
 * | forest | поле с опушкой, 22 дерева и куста | лучше |
 * | road | поле с полосой утоптанной земли поперёк карты | лучше |
 * | cave | связная извилистая полость с неровными залами | лучше |
 * | settlement | четыре дома, улица, площадь и проходы к дверям | лучше |
 */
export const SCENE_THEMES = Object.freeze([
  {
    id: 'building',
    label: 'Здание с участком',
    kind: 'building',
    live: true,
    material: 'wood',
    // `\b` в JavaScript опирается на латиницу и с кириллицей не работает.
    // Караван-сарай, подворье и ночлежка — те же постоялые дворы: здание с
    // двором, ровно то, что строит генератор. «Караван» без дефисной части не
    // берём: торговый караван в пути — это не постройка.
    match: /таверн|трактир|постоял|корчм|харчевн|гостиниц|караван-сара|подворь|ночлежк|особняк|терем|(?<![а-яё])дом(?![а-яё])|(?<![а-яё])изб[аеуы](?![а-яё])|хижин|усадьб|поместь|лавк/iu,
  },
  {
    id: 'temple',
    label: 'Храм',
    kind: 'graph',
    live: true,
    material: 'marble',
    match: /храм|святилищ|капищ|алтар|собор|монастыр/iu,
    zones: ['Притвор', 'Неф', 'Алтарная', 'Ризница'],
    density: 14,
    require: ['altar', 'pillar', 'statue', 'brazier'],
    prefer: ['pillar', 'statue', 'brazier', 'prayer_bench', 'reliquary', 'mosaic', 'temple_banner'],
  },
  {
    id: 'crypt',
    label: 'Склеп',
    kind: 'graph',
    live: true,
    material: 'stone',
    match: /склеп|крипт|гробниц|усыпальниц|катакомб|мавзоле/iu,
    zones: ['Вход', 'Галерея', 'Погребальная', 'Тайник'],
    density: 16,
    require: ['sarcophagus', 'grave', 'urn', 'brazier'],
    prefer: ['grave', 'urn', 'crypt_niche', 'bone_pile', 'cobweb', 'statue'],
    locked: true,
  },
  {
    id: 'cave',
    label: 'Пещера',
    kind: 'graph',
    live: true,
    material: 'earth',
    match: /пещер|грот|каверн|штольн|шахт|подземель|нора/iu,
    zones: ['Устье', 'Штрек', 'Зал', 'Тупик'],
    density: 18,
    require: ['stalagmite', 'cave_pool', 'rubble_heap'],
    prefer: ['stalagmite', 'rubble_heap', 'mushroom_cluster', 'bone_pile', 'ore_vein', 'cobweb'],
  },
  {
    id: 'forest',
    label: 'Лес',
    kind: 'open',
    live: true,
    material: 'grass',
    match: /лес|чащ|рощ|бор|дубрав|пущ|тайг/iu,
    density: 16,
    require: ['tree_oak', 'tree_spruce', 'tree_birch', 'fallen_log', 'campfire'],
    prefer: ['tree_oak', 'tree_spruce', 'tree_birch', 'tree_pine', 'tree_dead', 'tree_stump', 'bush', 'shrub', 'boulder', 'fern', 'campfire'],
  },
  {
    id: 'road',
    label: 'Дорога',
    kind: 'open',
    live: true,
    // Обочины — луг, а не голая земля: с материалом `earth` вся карта сливалась
    // в одну коричневую плоскость, и сама дорога на ней не читалась. Полосу
    // утоптанной земли рисует layoutOpenTerrain поверх травы.
    material: 'grass',
    match: /дорог|тракт|путь|перекрёст|перекрест|мост|брод|перевал/iu,
    density: 12,
    require: ['milestone', 'tree_birch', 'cart', 'roadside_shrine'],
    prefer: ['tree_birch', 'tree_dead', 'bush', 'boulder', 'fern', 'path_stone', 'milestone'],
    road: true,
  },
  {
    id: 'settlement',
    label: 'Поселение',
    kind: 'settlement',
    live: true,
    material: 'earth',
    match: /деревн|поселен|село|посад|хутор|город|слобод|рынок|площад/iu,
    density: 14,
    require: ['market_stall', 'well', 'cart', 'village_fence'],
    // Одноклеточный `campfire` сохраняется и в legacy-клетках под известным
    // движку feature. `hitching_post` намеренно не здесь: старый контракт
    // encounter-cell такого идентификатора не знает.
    prefer: ['market_stall', 'village_fence', 'cart', 'haystack', 'woodpile', 'tree_birch', 'campfire'],
    road: true,
  },
])

/** Тема по умолчанию, когда ничто не опознано. */
export const FALLBACK_THEME = SCENE_THEMES[0]

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
 * Опознаёт тему сцены. Дикая местность никогда не становится зданием, даже если
 * в названии есть «дом»: «Дом у дороги» в лесу — это всё-таки лес.
 *
 * @param {object} input
 * @param {string} [input.location]
 * @param {string} [input.theme]
 * @param {string} [input.sceneKind]
 * @returns {typeof SCENE_THEMES[number]}
 */
export function themeFor(input = {}) {
  const matched = matchTheme(input)
  if (matched) return matched
  // Для прямого вызова без карты дикая местность всё равно безопасно
  // показывается лесом. Живой выбор генератора получает `null` от matchTheme и
  // успевает учесть layout/pattern до такого fallback.
  if (String(input.sceneKind) === 'wilderness') {
    return SCENE_THEMES.find((candidate) => candidate.id === 'forest') ?? FALLBACK_THEME
  }
  return FALLBACK_THEME
}

/**
 * То же опознание, но без подстановки темы по умолчанию: `null` означает «не
 * узнал». Вызывающий после этого выбирает структурированный fallback по виду
 * сцены и заявленной планировке.
 *
 * @param {object} input
 * @param {string} [input.location]
 * @param {string} [input.theme]
 * @param {string} [input.sceneKind]
 * @returns {typeof SCENE_THEMES[number]|null}
 */
export function matchTheme({ location = '', theme = '', sceneKind = '' } = {}) {
  const haystack = `${location} ${theme}`
  const wilderness = String(sceneKind) === 'wilderness'
  for (const candidate of SCENE_THEMES) {
    if (wilderness && candidate.kind === 'building') continue
    if (candidate.match.test(haystack)) return candidate
  }
  return null
}

/**
 * Узор и планировка из заявки картографа — тоже его слова, а не догадка по
 * названию. Часть значений называет тему однозначно: `crypt` — это склеп, а не
 * «что-то каменное». Остальные (`keep`, `great-hall`, `courtyard`, `bridge`,
 * `radial`, `ruins`, `natural`) своей темы не имеют и достаются безопасному
 * тематическому fallback по планировке.
 *
 * Сознательно не сопоставляется `small-room`: комната бывает в любом здании, и
 * по одному этому слову нельзя ставить дом с двором, оградой и деревьями.
 *
 * @param {{layout?: string, pattern?: string}} [request]
 * @returns {typeof SCENE_THEMES[number]|null}
 */
export function themeFromMapRequest({ pattern = '', layout = '' } = {}) {
  /** @type {Record<string, string>} */
  const byPattern = {
    crypt: 'crypt',
    'cave-cluster': 'cave',
    village: 'settlement',
    bridge: 'road',
  }
  /** @type {Record<string, string>} */
  const byLayout = { cavern: 'cave', streets: 'settlement', winding: 'road' }
  const id = byPattern[String(pattern).toLocaleLowerCase('en')]
    ?? byLayout[String(layout).toLocaleLowerCase('en')]
    ?? ''
  return id ? SCENE_THEMES.find((candidate) => candidate.id === id) ?? null : null
}

/**
 * Безопасная тема для неопознанной локации. Это последний выбор геометрии, а
 * не попытка угадать художественный смысл: он сохраняет заявленную топологию
 * и всегда отдаёт структурированную, связную карту.
 *
 * @param {object} [input]
 * @param {string} [input.sceneKind]
 * @param {{layout?: string, pattern?: string, material?: string}} [input.request]
 * @returns {typeof SCENE_THEMES[number]}
 */
export function fallbackThemeFor({ sceneKind = '', request = {} } = {}) {
  const requested = themeFromMapRequest(request)
  if (requested) return requested

  const kind = String(sceneKind).toLocaleLowerCase('en')
  const layout = String(request?.layout ?? '').toLocaleLowerCase('en')
  const pattern = String(request?.pattern ?? '').toLocaleLowerCase('en')
  const material = String(request?.material ?? '').toLocaleLowerCase('en')
  let id = ''
  if (kind === 'settlement') id = 'settlement'
  else if (kind === 'road') id = 'road'
  else if (kind === 'wilderness') id = layout === 'winding' || pattern === 'bridge' ? 'road' : 'forest'
  else if (kind === 'dungeon') id = layout === 'cavern' ? 'cave' : 'crypt'
  else if (layout === 'open' || pattern === 'natural') id = 'forest'
  else if (layout === 'rooms' || layout === 'ruins' || layout === 'radial'
    || ['small-room', 'great-hall', 'keep', 'courtyard'].includes(pattern)) {
    const masonry = ['stone', 'marble', 'earth'].includes(material)
      || ['keep', 'great-hall'].includes(pattern)
      || ['ruins', 'radial'].includes(layout)
    id = masonry ? 'crypt' : 'building'
  }
  else id = 'road'
  return SCENE_THEMES.find((candidate) => candidate.id === id) ?? FALLBACK_THEME
}

/**
 * Готова ли тема к живой игре. Отдельная функция, а не чтение поля на месте:
 * вызывающему не нужно знать, чем именно выражена готовность.
 *
 * @param {typeof SCENE_THEMES[number]|null} theme
 * @returns {boolean}
 */
export function isLiveTheme(theme) {
  return Boolean(theme?.live)
}

/**
 * Граф зон под тему: цепочка помещений, последнее — цель. У склепа последняя
 * дверь заперта, а ключ лежит в предыдущей зоне — проверку порядка ключей
 * делает стадия 1.
 *
 * @param {typeof SCENE_THEMES[number]} theme
 * @param {string} seed
 * @returns {import('./scene-graph.mjs').SceneGraph}
 */
export function sceneGraphForTheme(theme, seed) {
  const random = randomFor(`${theme.id}:${seed}`)
  const labels = theme.zones ?? ['Вход', 'Зал', 'Дальняя']
  const count = Math.max(3, Math.min(labels.length, 3 + Math.floor(random() * (labels.length - 2))))
  const graph = createSceneGraph({ entranceZoneId: 'zone-0', goalZoneId: `zone-${count - 1}` })
  for (let index = 0; index < count; index += 1) {
    addSceneZone(graph, {
      id: `zone-${index}`,
      kind: 'interior',
      required: index < count - 1,
      label: labels[index] ?? `Помещение ${index + 1}`,
      keys: theme.locked && index === count - 2 ? ['goal-key'] : [],
    })
  }
  for (let index = 1; index < count; index += 1) {
    const lockLast = theme.locked && index === count - 1
    addSceneLink(graph, {
      id: `link-${index}`,
      from: `zone-${index - 1}`,
      to: `zone-${index}`,
      kind: lockLast ? 'locked' : (random() < 0.5 ? 'door' : 'open'),
      keyId: lockLast ? 'goal-key' : null,
    })
  }
  return graph
}

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/**
 * Заменяет часть глухих стен узкими проёмами — решёткой или бойницей.
 *
 * Меняется **только вид ребра**: `blocksMove` у стены, бойницы и решётки один
 * и тот же, поэтому проходимость сцены остаётся ровно прежней и связность,
 * проверенная сборкой, сломаться не может. Разница в другом — сквозь проём
 * видно (`blocksSight` снимается) и укрытие слабее сплошной кладки: три
 * четверти у бойницы, половина у решётки.
 *
 * Выбор идёт по отсортированному списку рёбер с постоянным шагом, поэтому тот
 * же seed даёт ту же карту — как и вся остальная сборка темы.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {{kind: 'loophole' | 'grate', stride: number, limit: number}} options
 * @returns {number} сколько стен заменено
 */
function pierceWalls(map, { kind, stride, limit }) {
  const walls = edgeList(map).filter((edge) => edge.kind === 'wall')
  let pierced = 0
  for (let index = Math.floor(stride / 2); index < walls.length && pierced < limit; index += stride) {
    const wall = walls[index]
    const neighbor = edgeNeighbor(wall)
    setEdge(map, wall.x, wall.y, neighbor.x, neighbor.y, { kind })
    pierced += 1
  }
  return pierced
}

/**
 * Ставит стены на границе пола и непроходимой породы. Клеточная форма нужна
 * старому представлению сцены, рёбра — структурированной карте; оба вида
 * описывают одну и ту же границу.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 */
function outlineImpassableCells(map) {
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const own = cellAt(map, x, y)
      if (!own || own.passable) continue
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (cellAt(map, x + dx, y + dy)?.passable) {
          setEdge(map, x, y, x + dx, y + dy, {
            kind: 'wall',
            blocksMove: true,
            blocksSight: true,
            cover: 'three_quarters',
          })
        }
      }
    }
  }
}

/**
 * Органическая геометрия пещеры. Граф зон остаётся стадией 1, но вместо
 * двоичного разбиения на прямоугольные комнаты его узлы становятся неровными
 * залами, соединёнными вырубленным извилистым ходом.
 *
 * Полость строится только добавлением пересекающихся дисков. Поэтому она
 * связна по построению, а не благодаря ремонту после случайной генерации.
 *
 * @param {typeof SCENE_THEMES[number]} theme
 * @param {{seed?: string, width?: number, height?: number, locationId?: string}} [options]
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function layoutOrganicCave(theme, {
  seed = 'cave', width = 26, height = 26, locationId = '',
} = {}) {
  const safeWidth = Math.max(16, Math.min(SIZE_CLASSES.area.maxWidth, Math.round(width)))
  const safeHeight = Math.max(16, Math.min(SIZE_CLASSES.area.maxHeight, Math.round(height)))
  const random = randomFor(`cave:${theme.id}:${seed}`)
  const graph = sceneGraphForTheme(theme, String(seed))
  const map = createTacticalMap({
    width: safeWidth,
    height: safeHeight,
    locationId,
    seed: String(seed),
    generator: { id: 'theme-cave-organic', version: '1' },
    theme: theme.id,
    sizeClass: safeWidth * safeHeight <= SIZE_CLASSES.arena.maxCells ? 'arena' : 'area',
  })

  for (let index = 0; index < graph.zones.length; index += 1) {
    const zone = graph.zones[index]
    addZone(map, {
      id: zone.id,
      kind: 'interior',
      material: theme.material,
      lightLevel: index === 0 ? 'dim' : index === graph.zones.length - 1 ? 'dark' : 'dim',
      // У породы нет настила, и разворачивать её фактуру нечему.
      floorDirection: 'horizontal',
      label: zone.label,
    })
  }

  // Порода существует на всей сетке; игровая форма задаётся вырубленным полом.
  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      setCell(map, x, y, {
        passable: false,
        material: theme.material,
        variant: Math.floor(random() * 6),
        revealed: true,
      })
    }
  }

  /** @type {Set<string>} */
  const floor = new Set()
  /**
   * Неровность радиуса считается внутри фиксированного обхода, поэтому не
   * нарушает детерминизм. Ядро радиусом `radius - 0.45` остаётся сплошным.
   * @param {number} cx
   * @param {number} cy
   * @param {number} radius
   */
  const carveDisc = (cx, cy, radius) => {
    const reach = Math.ceil(radius + 0.5)
    for (let dy = -reach; dy <= reach; dy += 1) {
      for (let dx = -reach; dx <= reach; dx += 1) {
        const x = Math.round(cx + dx)
        const y = Math.round(cy + dy)
        const raggedRadius = radius + random() * 0.9 - 0.45
        if (x < 0 || y < 1 || x >= safeWidth || y >= safeHeight - 1) continue
        if (Math.hypot(dx, dy) <= raggedRadius) floor.add(`${x},${y}`)
      }
    }
  }

  const count = graph.zones.length
  const verticalRoom = Math.max(2, Math.min(5, Math.floor(safeHeight * 0.2)))
  /** @type {Array<{x: number, y: number}>} */
  const centers = []
  for (let index = 0; index < count; index += 1) {
    const progress = count <= 1 ? 0 : index / (count - 1)
    const x = Math.round(2 + progress * (safeWidth - 5))
    const wave = Math.sin(progress * Math.PI * 2 + random() * 0.8) * verticalRoom
    const y = clamp(Math.round(safeHeight / 2 + wave + (random() - 0.5) * 3), 3, safeHeight - 4)
    centers.push({ x, y })
    const chamberRadius = clamp(Math.min(safeWidth, safeHeight) * (0.115 + random() * 0.035), 2.5, 5)
    carveDisc(x, y, chamberRadius)
    // Боковая ниша ломает круглую симметрию зала, но пересекается с ним.
    const side = random() < 0.5 ? -1 : 1
    carveDisc(x + side * Math.max(1, Math.floor(chamberRadius * 0.65)), y + (random() < 0.5 ? -1 : 1), chamberRadius * 0.62)
  }

  // Последовательные узлы графа соединяются одной гарантированной полостью.
  for (let index = 1; index < centers.length; index += 1) {
    const target = centers[index]
    let x = centers[index - 1].x
    let y = centers[index - 1].y
    let guard = safeWidth * safeHeight
    while ((x !== target.x || y !== target.y) && guard > 0) {
      carveDisc(x, y, 1.45 + random() * 0.65)
      const dx = target.x - x
      const dy = target.y - y
      const horizontalChance = Math.abs(dx) / Math.max(1, Math.abs(dx) + Math.abs(dy))
      if (dx && (!dy || random() < horizontalChance)) x += Math.sign(dx)
      else if (dy) y += Math.sign(dy)
      guard -= 1
    }
    carveDisc(target.x, target.y, 1.8)
  }

  // Устье до края карты — настоящий вход, а не точка появления внутри скалы.
  const entranceY = centers[0]?.y ?? Math.floor(safeHeight / 2)
  for (let x = 0; x <= (centers[0]?.x ?? 2); x += 1) carveDisc(x, entranceY, 1.35)

  for (const key of floor) {
    const [x, y] = key.split(',').map(Number)
    let zoneIndex = 0
    let nearest = Number.POSITIVE_INFINITY
    for (let index = 0; index < centers.length; index += 1) {
      const distance = Math.abs(centers[index].x - x) + Math.abs(centers[index].y - y)
      if (distance < nearest) {
        nearest = distance
        zoneIndex = index
      }
    }
    setCell(map, x, y, {
      passable: true,
      material: theme.material,
      zone: graph.zones[zoneIndex]?.id ?? graph.zones[0].id,
      variant: Math.floor(random() * 6),
      revealed: true,
    })
  }

  outlineImpassableCells(map)
  addSpawnPoint(map, { id: 'party-entrance', x: 1, y: entranceY, role: 'party' })
  map.overlays = {
    compass: true,
    scaleBar: true,
    roomLabels: graph.zones.map((zone) => ({ zoneId: zone.id, label: zone.label })),
  }
  return map
}

/**
 * Открытая местность: помещений нет, есть проходимая площадка с опушкой по
 * краю. У дороги и поселения через карту идёт полоса утоптанной земли.
 *
 * @param {typeof SCENE_THEMES[number]} theme
 * @param {{seed?: string, width?: number, height?: number, locationId?: string}} [options]
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function layoutOpenTerrain(theme, { seed = 'open', width = 26, height = 26, locationId = '' } = {}) {
  const safeWidth = Math.max(12, Math.min(SIZE_CLASSES.area.maxWidth, Math.round(width)))
  const safeHeight = Math.max(12, Math.min(SIZE_CLASSES.area.maxHeight, Math.round(height)))
  const random = randomFor(`open:${theme.id}:${seed}`)
  const map = createTacticalMap({
    width: safeWidth,
    height: safeHeight,
    locationId,
    seed: String(seed),
    generator: { id: `theme-${theme.id}`, version: '1' },
    theme: theme.id,
    sizeClass: safeWidth * safeHeight <= SIZE_CLASSES.arena.maxCells ? 'arena' : 'area',
  })
  addZone(map, {
    id: 'field',
    kind: 'exterior',
    material: theme.material,
    lightLevel: 'bright',
    floorDirection: 'horizontal',
    label: theme.label,
  })

  const roadY = Math.floor(safeHeight / 2)
  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      // Дорога вьётся, а не идёт по линейке: прямая полоса читается как шов.
      const drift = Math.round(Math.sin((x / Math.max(1, safeWidth - 1)) * Math.PI * 2) * Math.max(1, safeHeight * 0.08))
      const onRoad = theme.road && Math.abs(y - (roadY + drift)) <= 1
      setCell(map, x, y, {
        passable: true,
        material: onRoad ? 'earth' : theme.material,
        zone: 'field',
        variant: Math.floor(random() * 6),
        revealed: true,
      })
    }
  }
  // Край карты — непроходимая опушка: иначе отряд уходит в пустоту.
  for (let x = 0; x < safeWidth; x += 1) {
    for (const y of [0, safeHeight - 1]) {
      if (theme.road && Math.abs(y - roadY) <= 1) continue
      setCell(map, x, y, { passable: false, material: theme.material })
    }
  }
  for (let y = 0; y < safeHeight; y += 1) {
    for (const x of [0, safeWidth - 1]) {
      // У дороги края открыты: она обязана вести за пределы карты.
      if (theme.road) continue
      setCell(map, x, y, { passable: false, material: theme.material })
    }
  }
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
  map.spawnPoints.push({ id: 'party-entrance', x: 1, y: roadY, role: 'party' })
  map.overlays = { compass: true, scaleBar: true, roomLabels: [{ zoneId: 'field', label: theme.label }] }
  return map
}

/**
 * Поселение с улицей и домами. Дом — не картинка под сеткой: это отдельная
 * зона с деревянным полом, непроходимой стеной и дверью. Поэтому геометрия
 * остаётся играбельной без растрового арта и переживает legacy-проекцию.
 *
 * @param {typeof SCENE_THEMES[number]} theme
 * @param {{seed?: string, width?: number, height?: number, locationId?: string}} [options]
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function layoutSettlement(theme, {
  seed = 'settlement', width = 26, height = 26, locationId = '',
} = {}) {
  const safeWidth = Math.max(20, Math.min(SIZE_CLASSES.area.maxWidth, Math.round(width)))
  const safeHeight = Math.max(20, Math.min(SIZE_CLASSES.area.maxHeight, Math.round(height)))
  const random = randomFor(`settlement:${theme.id}:${seed}`)
  const map = createTacticalMap({
    width: safeWidth,
    height: safeHeight,
    locationId,
    seed: String(seed),
    generator: { id: 'theme-settlement', version: '1' },
    theme: theme.id,
    sizeClass: safeWidth * safeHeight <= SIZE_CLASSES.arena.maxCells ? 'arena' : 'area',
  })
  addZone(map, { id: 'common', kind: 'exterior', material: 'grass', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Поселение' })
  addZone(map, { id: 'street', kind: 'exterior', material: 'earth', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Главная улица' })

  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      setCell(map, x, y, {
        passable: true,
        material: 'grass',
        zone: 'common',
        variant: Math.floor(random() * 6),
        revealed: true,
      })
    }
  }

  /** @param {number} x */
  const roadYAt = (x) => (
    Math.floor(safeHeight / 2)
    + Math.round(Math.sin((x / Math.max(1, safeWidth - 1)) * Math.PI * 2) * Math.max(1, safeHeight * 0.045))
  )
  for (let x = 0; x < safeWidth; x += 1) {
    const roadY = roadYAt(x)
    for (let dy = -1; dy <= 1; dy += 1) {
      setCell(map, x, roadY + dy, { passable: true, material: 'earth', zone: 'street' })
    }
  }
  // Площадь и поперечный переулок не дают деревне читаться одной полосой.
  const crossX = Math.floor(safeWidth / 2)
  for (let y = 0; y < safeHeight; y += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      setCell(map, crossX + dx, y, { passable: true, material: 'earth', zone: 'street' })
    }
  }

  const houseWidth = clamp(Math.round(safeWidth * 0.24), 5, 7)
  const houseHeight = clamp(Math.round(safeHeight * 0.22), 5, 6)
  const leftX = 2
  const rightX = safeWidth - houseWidth - 2
  const topY = 1
  const bottomY = safeHeight - houseHeight - 1
  const houses = [
    { x: leftX, y: topY, side: 'top', label: 'Дом ремесленника' },
    { x: rightX, y: topY, side: 'top', label: 'Дом травницы' },
    { x: leftX, y: bottomY, side: 'bottom', label: 'Амбар' },
    { x: rightX, y: bottomY, side: 'bottom', label: 'Дом старосты' },
  ]
  /** @type {Array<{id: string, x: number, y: number, dir: 's'}>} */
  const doors = []

  for (let index = 0; index < houses.length; index += 1) {
    const house = houses[index]
    const zoneId = `house-${index + 1}`
    addZone(map, {
      id: zoneId,
      kind: 'interior',
      material: 'wood',
      lightLevel: 'dim',
      floorDirection: index % 2 === 0 ? 'horizontal' : 'vertical',
      label: house.label,
    })
    for (let dy = 0; dy < houseHeight; dy += 1) {
      for (let dx = 0; dx < houseWidth; dx += 1) {
        const boundary = dx === 0 || dy === 0 || dx === houseWidth - 1 || dy === houseHeight - 1
        setCell(map, house.x + dx, house.y + dy, boundary
          ? { passable: false, material: 'wood', zone: '' }
          : { passable: true, material: 'wood', zone: zoneId })
      }
    }

    const doorX = house.x + Math.floor(houseWidth / 2)
    const doorY = house.side === 'top' ? house.y + houseHeight - 1 : house.y
    setCell(map, doorX, doorY, { passable: true, material: 'wood', zone: zoneId })
    doors.push({ id: `house-door-${index + 1}`, x: doorX, y: doorY, dir: 's' })

    // От каждой двери до главной улицы лежит отдельный проход.
    const streetY = roadYAt(doorX)
    const fromY = Math.min(doorY, streetY)
    const toY = Math.max(doorY, streetY)
    for (let y = fromY; y <= toY; y += 1) {
      if (y === doorY) continue
      setCell(map, doorX, y, { passable: true, material: 'earth', zone: 'street' })
    }
  }

  outlineImpassableCells(map)
  for (const door of doors) {
    setDoor(map, { ...door, state: 'closed', blocksMove: false, blocksSight: false })
  }
  addSpawnPoint(map, { id: 'party-entrance', x: 0, y: roadYAt(0), role: 'party' })
  map.overlays = {
    compass: true,
    scaleBar: true,
    roomLabels: [
      { zoneId: 'street', label: 'Главная улица' },
      ...map.zones
        .filter((zone) => zone.id.startsWith('house-'))
        .map((zone) => ({ zoneId: zone.id, label: zone.label })),
    ],
  }
  return map
}

/**
 * Собирает сцену по теме. Единая точка входа: вызывающему не нужно знать, каким
 * способом строится геометрия.
 *
 * @param {object} options
 * @param {string} [options.location]
 * @param {string} [options.theme]
 * @param {string} [options.sceneKind]
 * @param {string} [options.seed]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {string} [options.locationId]
 * @param {string} [options.themeId] уже опознанная тема; сильнее названия
 * @returns {{map: import('./tactical-map.mjs').TacticalMap, theme: string, warnings: string[]}}
 */
export function buildThemedScene({
  location = '', theme = '', sceneKind = '', seed = 'scene', width = 26, height = 26, locationId = '', themeId = '',
} = {}) {
  // Тему могли опознать не по названию, а по узору из заявки картографа. Тогда
  // повторное опознание здесь её потеряет: `themeFor` читает только слова.
  const chosen = themeId ? SCENE_THEMES.find((candidate) => candidate.id === themeId) : null
  const definition = chosen ?? themeFor({ location, theme, sceneKind })

  if (definition.kind === 'building') {
    const built = buildBuildingScene({ seed, width, height, locationId, theme: definition.id })
    return { map: built.map, theme: definition.id, warnings: built.warnings }
  }

  if (definition.kind === 'graph') {
    if (definition.id === 'cave') {
      const map = layoutOrganicCave(definition, { seed, width, height, locationId })
      placeProps(map, {
        seed: `${seed}:props`,
        maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (map.sizeClass)].maxProps,
        zones: map.zones.map((zone) => ({
          zoneId: zone.id,
          theme: definition.id,
          density: definition.density ?? 12,
          require: definition.require,
          prefer: definition.prefer,
        })),
      })
      return { map, theme: definition.id, warnings: [] }
    }
    const graph = sceneGraphForTheme(definition, seed)
    const built = buildSceneFromGraph(graph, {
      seed, width, height, locationId, theme: definition.id, material: definition.material,
    })
    // Каменная тема получает узкие проёмы в кладке: склеп перегорожен
    // решётками, храм смотрит наружу щелями под сводом. Это те же стены —
    // пройти сквозь них нельзя, но видно и укрытие слабее.
    if (definition.id === 'crypt') pierceWalls(built.map, { kind: 'grate', stride: 13, limit: 3 })
    if (definition.id === 'temple') pierceWalls(built.map, { kind: 'loophole', stride: 11, limit: 4 })
    const map = placeProps(built.map, {
      seed: `${seed}:props`,
      maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (built.map.sizeClass)].maxProps,
      zones: built.map.zones
        .filter((zone) => zone.label)
        .map((zone) => ({
          zoneId: zone.id,
          theme: definition.id,
          density: definition.density ?? 12,
          require: definition.require,
          prefer: definition.prefer,
        })),
    })
    return {
      map,
      theme: definition.id,
      warnings: [...built.warnings, ...built.errors.map((issue) => issue.code)],
    }
  }

  if (definition.kind === 'settlement') {
    const map = layoutSettlement(definition, { seed, width, height, locationId })
    placeProps(map, {
      seed: `${seed}:props`,
      maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (map.sizeClass)].maxProps,
      zones: [{
        zoneId: 'common',
        theme: definition.id,
        density: definition.density ?? 10,
        require: definition.require,
        prefer: definition.prefer,
      }],
    })
    return { map, theme: definition.id, warnings: [] }
  }

  const map = layoutOpenTerrain(definition, { seed, width, height, locationId })
  placeProps(map, {
    seed: `${seed}:props`,
    maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (map.sizeClass)].maxProps,
    zones: [{
      zoneId: 'field',
      theme: definition.id,
      density: definition.density ?? 10,
      require: definition.require,
      prefer: definition.prefer,
    }],
  })
  return { map, theme: definition.id, warnings: [] }
}

// @ts-check
import { createHash } from 'node:crypto'

import { assetById, assetsForTheme } from './asset-registry.mjs'
import { addProp, cellAt, edgeBetween, edgeNeighbor } from './tactical-map.mjs'

/**
 * Расстановка предметов по правилам (`docs/tactical-map-plan.md`, стадия 3).
 *
 * Развитие `featureCellScore` из `server/dynamic-map.mjs`: там тоже считается
 * оценка клетки под предмет, притяжение к стене и к столу. Здесь та же идея
 * доведена до якорей, поворота, масштаба и плотности на зону.
 *
 * Всё детерминировано от `seed`: тот же seed даёт ту же расстановку, включая
 * повороты и масштабы.
 */

export const PROP_PLACEMENT_VERSION = 'skazanie:prop-placement-v2'

/**
 * Ограниченный словарь назначений комнаты. Это намеренно не новый формат карты:
 * `purpose` живёт только в заявке на расстановку, а на карту попадают обычные
 * props. Если назначение неизвестно, сохраняется прежняя расстановка по теме.
 *
 * @type {Record<string, {require: string[], prefer: string[], caps?: Record<string, number>, arrangement?: 'rows'|'gathered'|'stalls'}>}
 */
const SEMANTIC_PROFILES = Object.freeze({
  // «Галерея» — общий/военный зал: поверхности для карт, места вокруг них и
  // подвешенный свет из уже зарегистрированных предметов.
  gallery: {
    require: ['table_long'],
    prefer: ['table_long', 'table_small', 'chair', 'bench', 'chandelier', 'banner', 'candelabra', 'rug'],
    caps: { table_long: 2, table_small: 2, chandelier: 1 },
    arrangement: 'gathered',
  },
  barracks: {
    require: ['bunk_bed', 'bunk_bed', 'bunk_bed', 'bunk_bed'],
    prefer: ['bunk_bed', 'bed', 'night_table', 'chest', 'wardrobe', 'washbasin'],
    caps: { bunk_bed: 8, bed: 8, table_long: 0, bench: 0, chair: 0 },
    arrangement: 'rows',
  },
  kitchen: {
    require: ['fireplace', 'cupboard'],
    prefer: ['fireplace', 'cupboard', 'cauldron', 'barrel', 'crate', 'shelf_wall', 'cutting_board', 'pot', 'bucket'],
    arrangement: 'gathered',
  },
  store: {
    require: ['crate_stack', 'barrel_stack'],
    prefer: ['crate_stack', 'barrel_stack', 'crate', 'barrel', 'sack', 'chest', 'shelf_wall'],
    arrangement: 'stalls',
  },
  stable: {
    require: ['haystack', 'water_trough', 'hitching_post'],
    prefer: ['haystack', 'water_trough', 'hitching_post', 'cart', 'sack'],
    caps: { haystack: 1, water_trough: 1, cart: 2, hitching_post: 4, woodpile: 0 },
    arrangement: 'stalls',
  },
  workshop: {
    require: ['table_long', 'shelf_wall'],
    prefer: ['table_long', 'shelf_wall', 'crate', 'barrel', 'chest', 'firewood_stack', 'candle'],
    arrangement: 'gathered',
  },
  courtyard: {
    require: ['well', 'cart'],
    prefer: ['well', 'cart', 'hitching_post', 'water_trough', 'woodpile', 'haystack', 'tree_oak', 'tree_birch', 'bush'],
    caps: { well: 1, cart: 2, water_trough: 1, haystack: 1, hitching_post: 4, woodpile: 1, campfire: 1 },
    arrangement: 'gathered',
  },
  exterior: {
    require: [],
    prefer: ['tree_oak', 'tree_birch', 'tree_pine', 'bush', 'shrub', 'rock_small', 'boulder'],
    arrangement: 'gathered',
  },
})

/** Псевдонимы назначения сохраняют короткий и понятный словарь генератора. */
const PURPOSE_ALIASES = Object.freeze({
  hall: 'gallery',
  main_hall: 'gallery',
  great_hall: 'gallery',
  war_room: 'gallery',
  gallery: 'gallery',
  barracks: 'barracks',
  sleeping: 'barracks',
  kitchen: 'kitchen',
  store: 'store',
  storage: 'store',
  warehouse: 'store',
  storehouse: 'store',
  stable: 'stable',
  stables: 'stable',
  workshop: 'workshop',
  courtyard: 'courtyard',
  yard: 'courtyard',
  exterior: 'exterior',
})

/**
 * Теги — необязательное сокращение для вызывающих модулей, у которых уже есть
 * метки комнаты. План расстановки остаётся публичным стыком: теги в карту не
 * записываются.
 *
 * @type {Record<string, string>}
 */
const TAG_PURPOSES = Object.freeze({
  hall: 'gallery', throne: 'gallery', maps: 'gallery', military: 'gallery',
  sleeping: 'barracks', soldiers: 'barracks', beds: 'barracks',
  cooking: 'kitchen', hearth: 'kitchen', food: 'kitchen',
  storage: 'store', supplies: 'store', crates: 'store', barrels: 'store',
  horses: 'stable', animals: 'stable', fodder: 'stable',
  forge: 'workshop', tools: 'workshop', craft: 'workshop',
  courtyard: 'courtyard', yard: 'courtyard', outside: 'exterior',
})

/**
 * Что тянется за предметом. Это связи, а не украшение: без них у стола не будет
 * стульев, а на столе — посуды, и расстановка выглядит случайной
 * (`docs/tactical-map-plan.md`, раздел 14, соответствующий риск).
 *
 * @type {Record<string, Array<[string, number]>>}
 */
const COMPANIONS = Object.freeze({
  table_round: [['chair', 4], ['mug', 2], ['plate', 1]],
  table_long: [['bench', 2], ['chair', 2], ['jug', 1], ['bread_loaf', 1]],
  table_small: [['chair', 2], ['candle', 1]],
  bar_counter: [['stool', 3], ['mug', 2], ['bottle', 1]],
  fireplace: [['cauldron', 1], ['firewood_stack', 1]],
  bed: [['night_table', 1]],
  bunk_bed: [['night_table', 1], ['chest', 1]],
  cart: [['wagon_wheel', 1]],
  tree_oak: [['bush', 1]],
})

/** Четыре стороны в порядке n, e, s, w. Поворот 0° смотрит на север. */
const SIDES = Object.freeze([
  { dx: 0, dy: -1, facing: 180 },
  { dx: 1, dy: 0, facing: 270 },
  { dx: 0, dy: 1, facing: 0 },
  { dx: -1, dy: 0, facing: 90 },
])

/**
 * @param {string} seed
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
 * Стены вокруг клетки. Стена — это ребро, а не соседняя клетка: низкая ограда
 * между двумя проходимыми клетками тоже держит якорь `wall`.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {number} x
 * @param {number} y
 * @returns {Array<{dx: number, dy: number, facing: number}>}
 */
function wallSidesAt(map, x, y) {
  return SIDES.filter((side) => {
    const edge = edgeBetween(map, x, y, x + side.dx, y + side.dy)
    if (edge && (edge.kind === 'wall' || edge.kind === 'rail')) return true
    const neighbor = cellAt(map, x + side.dx, y + side.dy)
    return !neighbor || !neighbor.passable
  })
}

/** Сколько клеток-кандидатов пробуем, прежде чем отказаться от предмета. */
const PLACEMENT_ATTEMPTS = 16

/** Обязательный предмет получает расширенный, но всё ещё ограниченный поиск. */
const REQUIRED_PLACEMENT_ATTEMPTS = 64

/** Вторая bounded-попытка required после неудачи первых кандидатов. */
const REQUIRED_RETRY_ATTEMPTS = 128

/**
 * Сколько клеток зоны просматривается под один предмет. Ограничение делает
 * стоимость расстановки линейной по числу клеток вместо квадратичной: замер до
 * него давал 821 мс на карте 60×60, после — десятки миллисекунд. Четырёхсот
 * кандидатов хватает, чтобы найти клетку у стены или рядом со столом.
 */
const CANDIDATE_SCAN_LIMIT = 400

/**
 * Подбирает положение прямоугольника футпринта так, чтобы он накрывал выбранную
 * клетку и целиком помещался на проходимых свободных клетках.
 *
 * Прямоугольник не привязан к верхнему левому углу: стойка 4×1 у стены обязана
 * лечь **вдоль** стены, а не упереться в неё. Поэтому перебираются все сдвиги,
 * при которых выбранная клетка остаётся внутри прямоугольника.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {Set<string>} blocked занятые предметами или зарезервированные под проход клетки
 * @param {{x: number, y: number}} anchor
 * @param {{w: number, h: number}} footprint
 * @param {number} rotation
 * @returns {Array<{x: number, y: number}>|null} null, если положения нет
 */
function fittingFootprint(map, blocked, anchor, footprint, rotation) {
  if (!footprint.w || !footprint.h) return []
  // Плоское освещение позволяет вращать предмет свободно, но занимаемые клетки
  // считаются по прямоугольнику: поворот на 90° меняет ширину и высоту местами.
  const quarter = Math.round(((rotation % 360) + 360) % 360 / 90) % 4
  const width = quarter % 2 === 0 ? footprint.w : footprint.h
  const height = quarter % 2 === 0 ? footprint.h : footprint.w
  for (let offsetY = 0; offsetY < height; offsetY += 1) {
    for (let offsetX = 0; offsetX < width; offsetX += 1) {
      /** @type {Array<{x: number, y: number}>} */
      const cells = []
      let fits = true
      for (let dy = 0; dy < height && fits; dy += 1) {
        for (let dx = 0; dx < width && fits; dx += 1) {
          const x = anchor.x - offsetX + dx
          const y = anchor.y - offsetY + dy
          const target = cellAt(map, x, y)
          if (!target || !target.passable || blocked.has(`${x},${y}`)) fits = false
          else cells.push({ x, y })
        }
      }
      if (fits) return cells
    }
  }
  return null
}

/**
 * Оценка клетки под конкретный ассет. Прямое развитие `featureCellScore`.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {import('./asset-registry.mjs').AssetEntry} asset
 * @param {{x: number, y: number}} cell
 * @param {Array<{assetId: string, x: number, y: number, zoneId?: string}>} placed
 * @param {{zoneId?: string, arrangement?: 'rows'|'gathered'|'stalls', zoneBounds?: {minX: number, maxX: number, minY: number, maxY: number}}} context
 * @param {() => number} random
 * @returns {number}
 */
function scoreCellForAsset(map, asset, cell, placed, context = {}, random = () => 0) {
  const walls = wallSidesAt(map, cell.x, cell.y).length
  let score = random() * 2
  const localPlaced = context.zoneId
    ? placed.filter((record) => record.zoneId === context.zoneId)
    : placed

  if (asset.anchor === 'wall') score += walls * 6
  else if (asset.anchor === 'corner') score += walls >= 2 ? 14 : walls * 2
  else score -= walls * 1.5

  // Стул тянется к столу — правило, ради которого расстановка вообще перестаёт
  // выглядеть случайной.
  if (asset.id === 'chair' || asset.id === 'stool' || asset.id === 'bench') {
    const nearestTable = nearestPlaced(localPlaced, cell, (id) => id.startsWith('table_'))
    score += nearestTable == null ? -8 : nearestTable <= 1 ? 16 : nearestTable === 2 ? 6 : -nearestTable
  }
  // В казарме койки образуют ряды, а не равномерный случайный шум. Ось ряда
  // выбирается по форме зоны; соседняя койка получает заметный бонус по той же
  // линии, сохраняя прежний якорь стены и детерминированный перебор.
  if (context.arrangement === 'rows' && (asset.id === 'bed' || asset.id === 'bunk_bed')) {
    const beds = localPlaced.filter((record) => (
      record.zoneId === context.zoneId && (record.assetId === 'bed' || record.assetId === 'bunk_bed')
    ))
    const nearestBed = closestRecord(beds, cell, () => true)
    if (nearestBed) {
      const minX = context.zoneBounds?.minX ?? cell.x
      const maxX = context.zoneBounds?.maxX ?? cell.x
      const minY = context.zoneBounds?.minY ?? cell.y
      const maxY = context.zoneBounds?.maxY ?? cell.y
      const horizontal = maxX - minX >= maxY - minY
      const lineDistance = horizontal
        ? Math.abs(nearestBed.y - cell.y)
        : Math.abs(nearestBed.x - cell.x)
      score += lineDistance === 0 ? 14 : lineDistance === 1 ? 4 : -lineDistance
    }
  }
  // Стойла и склад предпочитают повторяющиеся группы вдоль стен. Это намеренно
  // небольшой дополнительный балл: главным правилом остаётся якорь реестра.
  if (context.arrangement === 'stalls' && ['crate', 'crate_stack', 'barrel', 'barrel_stack', 'haystack', 'water_trough', 'hitching_post'].includes(asset.id)) {
    const sameKind = nearestPlaced(localPlaced, cell, (id) => id === asset.id)
    if (sameKind != null) score += sameKind <= 2 ? 8 : -sameKind
  }
  // Мелкая утварь ложится поверх столов и стойки.
  if (!asset.baseFootprint.w) {
    const nearestSurface = nearestPlaced(localPlaced, cell, (id) => id.startsWith('table_') || id === 'bar_counter')
    score += nearestSurface == null ? -4 : nearestSurface === 0 ? 12 : nearestSurface <= 1 ? 5 : -nearestSurface
  }
  // Деревья и кусты только на траве. Это запрет, а не малый вес.
  if (asset.id.startsWith('tree_') || asset.id === 'bush' || asset.id === 'shrub') {
    const material = cellAt(map, cell.x, cell.y)?.material
    if (material !== 'grass' && material !== 'earth') return Number.NEGATIVE_INFINITY
    score += material === 'grass' ? 8 : 2
    // Деревья не жмутся друг к другу вплотную.
    const nearestTree = nearestPlaced(localPlaced, cell, (id) => id.startsWith('tree_'))
    if (nearestTree != null && nearestTree <= 1) score -= 12
  }
  return score
}

/**
 * @param {Array<{assetId: string, x: number, y: number}>} placed
 * @param {{x: number, y: number}} cell
 * @param {(assetId: string) => boolean} match
 * @returns {number|null}
 */
function nearestPlaced(placed, cell, match) {
  let best = null
  for (const record of placed) {
    if (!match(record.assetId)) continue
    const distance = Math.max(Math.abs(record.x - cell.x), Math.abs(record.y - cell.y))
    if (best == null || distance < best) best = distance
  }
  return best
}

/**
 * Поворот предмета. Якорь `wall` разворачивает лицом внутрь помещения; стул
 * поворачивается к ближайшему столу; остальное получает свободный угол.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {import('./asset-registry.mjs').AssetEntry} asset
 * @param {{x: number, y: number}} cell
 * @param {Array<{assetId: string, x: number, y: number, zoneId?: string}>} placed
 * @param {string} zoneId
 * @param {() => number} random
 * @returns {number}
 */
function rotationFor(map, asset, cell, placed, zoneId, random) {
  if (asset.anchor === 'wall' || asset.anchor === 'corner') {
    const walls = wallSidesAt(map, cell.x, cell.y)
    if (walls.length) return walls[Math.floor(random() * walls.length) % walls.length].facing
  }
  if (asset.id === 'chair' || asset.id === 'stool' || asset.id === 'bench') {
    const localPlaced = zoneId ? placed.filter((record) => record.zoneId === zoneId) : placed
    const table = closestRecord(localPlaced, cell, (id) => id.startsWith('table_') || id === 'bar_counter')
    if (table) return angleTowards(cell, table)
  }
  if (asset.id.startsWith('tree_') || asset.id === 'bush' || asset.id === 'rock_small' || asset.id === 'boulder') {
    // У кроны нет лица, поэтому угол свободный — именно он и создаёт
    // впечатление разных деревьев из одного рисунка.
    return Math.floor(random() * 360)
  }
  return Math.round(random() * 4) % 4 * 90
}

/**
 * @param {Array<{assetId: string, x: number, y: number}>} placed
 * @param {{x: number, y: number}} cell
 * @param {(assetId: string) => boolean} match
 * @returns {{x: number, y: number}|null}
 */
function closestRecord(placed, cell, match) {
  let best = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const record of placed) {
    if (!match(record.assetId)) continue
    const distance = Math.max(Math.abs(record.x - cell.x), Math.abs(record.y - cell.y))
    if (distance < bestDistance) {
      bestDistance = distance
      best = record
    }
  }
  return best
}

/**
 * Угол от клетки к цели, кратный 90°, где 0 смотрит на север.
 * @param {{x: number, y: number}} from
 * @param {{x: number, y: number}} to
 * @returns {number}
 */
function angleTowards(from, to) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 270 : 90
  return dy >= 0 ? 0 : 180
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizedPurpose(value) {
  const key = String(value ?? '').trim().toLocaleLowerCase('en').replace(/[-\s]+/gu, '_')
  return (/** @type {Record<string, string>} */ (PURPOSE_ALIASES))[key] ?? key
}

/**
 * Разбирает необязательные purpose/tags, не меняя схему карты. Явное назначение
 * имеет приоритет; первым безопасным запасным вариантом служит известный тег.
 *
 * @param {{purpose?: unknown, tags?: unknown}} plan
 * @returns {{purpose: string, require: string[], prefer: string[], caps?: Record<string, number>, arrangement?: 'rows'|'gathered'|'stalls'}|null}
 */
function semanticProfileFor(plan) {
  const explicit = normalizedPurpose(plan?.purpose)
  const fromPurpose = (/** @type {Record<string, any>} */ (SEMANTIC_PROFILES))[explicit]
  if (fromPurpose) return { purpose: explicit, ...fromPurpose }
  for (const rawTag of Array.isArray(plan?.tags) ? plan.tags : []) {
    const purpose = (/** @type {Record<string, string>} */ (TAG_PURPOSES))[String(rawTag ?? '').trim().toLocaleLowerCase('en').replace(/[-\s]+/gu, '_')]
    if (purpose && SEMANTIC_PROFILES[purpose]) return { purpose, ...SEMANTIC_PROFILES[purpose] }
  }
  return null
}

/**
 * @param {{x: number, y: number}} cell
 * @returns {string}
 */
function cellKey(cell) {
  return `${cell.x},${cell.y}`
}

/**
 * Запись двери указывает на одно ребро проёма. В графовой планировке проём
 * может иметь проходимую клетку без зоны, поэтому учитываются и её проходимые соседи.
 * Эти соседи — первые клетки, которые нужно оставить свободными у двери комнаты.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {string} zoneId
 * @param {Set<string>} allowed
 * @returns {Array<{x: number, y: number}>}
 */
function doorwayApproaches(map, zoneId, allowed) {
  /** @type {Map<string, {x: number, y: number}>} */
  const found = new Map()
  /** @param {number} x @param {number} y */
  const add = (x, y) => {
    const cell = cellAt(map, x, y)
    if (!cell || !cell.passable || cell.zone !== zoneId || !allowed.has(`${x},${y}`)) return
    found.set(`${x},${y}`, { x, y })
  }
  for (const door of Array.isArray(map.doors) ? map.doors : []) {
    const first = { x: door.x, y: door.y }
    const second = edgeNeighbor(door)
    for (const endpoint of [first, second]) {
      add(endpoint.x, endpoint.y)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) add(endpoint.x + dx, endpoint.y + dy)
    }
  }
  // Открытая связь графа или старая дверь могут оставить проходимый порог без
  // записи в `doors`. Граница зоны всё равно считается дверным проёмом для расстановки.
  for (const candidate of allowed) {
    const [x, y] = candidate.split(',').map(Number)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const neighbor = cellAt(map, x + dx, y + dy)
      if (neighbor?.passable && neighbor.zone !== zoneId) {
        found.set(candidate, { x, y })
        break
      }
    }
  }
  return [...found.values()].sort((left, right) => left.y - right.y || left.x - right.x)
}

/**
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {Set<string>} allowed
 * @param {{x: number, y: number}} start
 * @param {{x: number, y: number}} target
 * @returns {Array<{x: number, y: number}>}
 */
function corridorPath(map, allowed, start, target) {
  const startKey = cellKey(start)
  const targetKey = cellKey(target)
  if (!allowed.has(startKey) || !allowed.has(targetKey)) return []
  /** @type {Array<{x: number, y: number}>} */
  const queue = [{ x: start.x, y: start.y }]
  /** @type {Map<string, string|null>} */
  const previous = new Map([[startKey, null]])
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    const currentKey = cellKey(current)
    if (currentKey === targetKey) break
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const next = { x: current.x + dx, y: current.y + dy }
      const nextKey = cellKey(next)
      if (previous.has(nextKey) || !allowed.has(nextKey)) continue
      // Стена внутри некорректной комнаты не должна превращать путь очистки в
      // обещание прохода, которого не сможет обеспечить само движение.
      const edge = edgeBetween(map, current.x, current.y, next.x, next.y)
      if (edge && edge.kind !== 'door' && edge.blocksMove) continue
      previous.set(nextKey, currentKey)
      queue.push(next)
    }
  }
  if (!previous.has(targetKey)) return []
  /** @type {Array<{x: number, y: number}>} */
  const path = []
  let cursor = targetKey
  while (cursor) {
    const [x, y] = cursor.split(',').map(Number)
    path.push({ x, y })
    cursor = previous.get(cursor) ?? ''
  }
  return path.reverse()
}

/**
 * Резервирует одноклеточный путь от каждого дверного проёма комнаты к другим
 * проёмам (или к центру комнаты, если проём один). Так мебель остаётся
 * читаемой, а существующий валидатор движения получает настоящий маршрут.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {string} zoneId
 * @param {Array<{x: number, y: number}>} cells
 * @returns {Set<string>}
 */
function passageClearance(map, zoneId, cells) {
  const allowed = new Set(cells.map(cellKey))
  const approaches = doorwayApproaches(map, zoneId, allowed)
  const clear = new Set(approaches.map(cellKey))
  if (!approaches.length) return clear

  const targets = approaches.length > 1 ? approaches.slice(1) : [
    [...cells].sort((left, right) => left.y - right.y || left.x - right.x)[Math.floor(cells.length / 2)],
  ]
  let from = approaches[0]
  for (const target of targets) {
    const path = corridorPath(map, allowed, from, target)
    for (const cell of path) clear.add(cellKey(cell))
    from = target
  }
  return clear
}

/**
 * @typedef {object} ZonePlacementPlan
 * @property {string} zoneId
 * @property {string} theme тема, по которой отбираются ассеты реестра
 * @property {number} density предметов на 100 клеток зоны
 * @property {string} [purpose] назначение комнаты: gallery, barracks, kitchen, store, stable, workshop, courtyard, exterior
 * @property {string[]} [tags] необязательные теги; первый известный тег задаёт то же назначение
 * @property {string[]} [require] идентификаторы, которые обязаны появиться
 * @property {string[]} [prefer] из чего добирать остальное; без него — весь каталог темы
 */

/**
 * Раскладывает предметы по карте. Мутирует карту и возвращает её же.
 *
 * Плотность задаётся зоной, а не общим счётчиком (`docs/tactical-map-plan.md`,
 * стадия 3): иначе двор и общий зал получают поровну, хотя наполнены по-разному.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {object} options
 * @param {string} options.seed
 * @param {ZonePlacementPlan[]} options.zones
 * @param {number} [options.maxProps] бюджет класса размера
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function placeProps(map, { seed, zones, maxProps = 250 } = /** @type {any} */ ({})) {
  const random = randomFor(`${PROP_PLACEMENT_VERSION}:${seed}`)
  /** @type {Set<string>} */
  const occupied = new Set()
  for (const prop of map.props) for (const cell of prop.footprint) occupied.add(`${cell.x},${cell.y}`)
  /** @type {Array<{assetId: string, x: number, y: number, zoneId?: string}>} */
  const placed = map.props.map((prop) => ({
    assetId: prop.assetId,
    x: Math.floor(prop.x),
    y: Math.floor(prop.y),
    zoneId: cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone,
  }))
  let counter = map.props.length

  for (const plan of zones ?? []) {
    const cells = zoneCells(map, plan.zoneId)
    if (!cells.length) continue
    const semantic = semanticProfileFor(plan)
    const keepClear = passageClearance(map, plan.zoneId, cells)
    const zoneBounds = cells.reduce((bounds, cell) => ({
      minX: Math.min(bounds.minX, cell.x),
      maxX: Math.max(bounds.maxX, cell.x),
      minY: Math.min(bounds.minY, cell.y),
      maxY: Math.max(bounds.maxY, cell.y),
    }), { minX: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY })
    const budget = Math.max(0, Math.round(cells.length * Math.max(0, plan.density) / 100))
    const catalogue = assetsForTheme(plan.theme)
    if (!catalogue.length) continue

    // Сначала набирается список того, что вообще ставим, и лишь потом он
    // сортируется по размеру. Перебор каталога по размеру давал бы одни
    // крупные предметы: до стульев очередь не доходила бы никогда.
    /** @type {import('./asset-registry.mjs').AssetEntry[]} */
    const wanted = []
    // Список темы — единственный источник допустимого. Раньше `require` брал
    // предмет по идентификатору мимо фильтра, и в пещеру могла попасть барная
    // стойка: обязательность не отменяет принадлежность теме.
    const allowed = new Set(catalogue.map((record) => record.id))
    const profileCaps = semantic?.caps ?? {}
    /** @type {Map<string, number>} */
    const counts = new Map()
    /** @type {Map<string, number>} */
    const requiredCounts = new Map()
    /** @type {import('./asset-registry.mjs').AssetEntry[]} */
    const requiredAssets = []
    /** @param {import('./asset-registry.mjs').AssetEntry|null} asset @param {boolean} [withCompanions] @param {boolean} [required] */
    const enqueue = (asset, withCompanions = true, required = false) => {
      // Required ассеты резервируются до companions и не вытесняются плотностью
      // зоны. Общий cap `maxProps` остаётся последним ограничителем уже при
      // фактической расстановке.
      if (!asset || !allowed.has(asset.id) || (!required && wanted.length >= budget)) return false
      const cap = profileCaps[asset.id]
      const current = counts.get(asset.id) ?? 0
      if (Number.isFinite(cap) && current >= cap) return false
      wanted.push(asset)
      counts.set(asset.id, current + 1)
      if (required) {
        requiredAssets.push(asset)
        requiredCounts.set(asset.id, (requiredCounts.get(asset.id) ?? 0) + 1)
      }
      if (withCompanions) {
        for (const [companionId, count] of COMPANIONS[asset.id] ?? []) {
          for (let index = 0; index < count && wanted.length < budget; index += 1) {
            enqueue(assetById(companionId), false, false)
          }
        }
      }
      return true
    }
    // Явные требования плана имеют приоритет: профиль добавляет недостающие
    // роли, но не вытесняет ключевой предмет компаньонами из повторного стола.
    const required = [...(plan.require ?? [])]
    for (const id of semantic?.require ?? []) {
      const requiredCount = (semantic?.require ?? []).filter((candidate) => candidate === id).length
      const currentCount = required.filter((candidate) => candidate === id).length
      for (let index = currentCount; index < requiredCount; index += 1) required.push(id)
    }
    for (const id of required) enqueue(assetById(id), false, true)
    // Companions заполняют только оставшийся budget и никогда не занимают
    // слоты обязательных предметов.
    for (const asset of requiredAssets) {
      for (const [companionId, count] of COMPANIONS[asset.id] ?? []) {
        for (let index = 0; index < count && wanted.length < budget; index += 1) {
          enqueue(assetById(companionId), false, false)
        }
      }
    }
    // Случайный добор идёт из `prefer`, если он задан, и только иначе из всего
    // каталога темы. Без этого мелочь вытесняет крупное: во дворе таверны
    // оказывалось по четыре костра и по три коновязи, а деревьев — одно, и
    // двор переставал читаться как двор.
    const pool = [...(semantic?.prefer ?? []), ...(plan.prefer ?? [])]
      .map((id) => assetById(id))
      .filter((asset) => asset && allowed.has(asset.id)
        && !(Number.isFinite(profileCaps[asset.id]) && profileCaps[asset.id] <= 0))
    const source = pool.length ? pool : catalogue
    const maxFillAttempts = Math.max(32, budget * 8)
    for (let attempt = 0; wanted.length < budget && attempt < maxFillAttempts; attempt += 1) {
      const pick = source[Math.floor(random() * source.length) % source.length]
      if (!pick) break
      enqueue(pick)
    }

    // Крупные предметы ставятся первыми, мелкая утварь — поверх и рядом.
    const requiredRemaining = new Map(requiredCounts)
    // Обязательность принадлежит конкретному экземпляру. Дополнительный
    // сундук того же вида не должен опережать обязательный штабель бочек.
    const order = wanted.map((asset) => {
      const required = (requiredRemaining.get(asset.id) ?? 0) > 0
      if (required) requiredRemaining.set(asset.id, /** @type {number} */ (requiredRemaining.get(asset.id)) - 1)
      return { asset, required }
    }).sort((leftEntry, rightEntry) => {
      const { asset: left, required: leftRequired } = leftEntry
      const { asset: right, required: rightRequired } = rightEntry
      if (leftRequired !== rightRequired) return leftRequired ? -1 : 1
      if (leftRequired) {
        // Сначала ставим поверхности, которые тянут companions (столы,
        // очаги), затем малые required: так стул получает якорь, а сундук
        // успевает занять единственную свободную клетку до штабелей.
        const leftHasCompanions = (COMPANIONS[left.id]?.length ?? 0) > 0
        const rightHasCompanions = (COMPANIONS[right.id]?.length ?? 0) > 0
        if (leftHasCompanions !== rightHasCompanions) return leftHasCompanions ? -1 : 1
        const leftArea = left.baseFootprint.w * left.baseFootprint.h
        const rightArea = right.baseFootprint.w * right.baseFootprint.h
        return leftHasCompanions ? rightArea - leftArea : leftArea - rightArea
      }
      return (right.baseFootprint.w * right.baseFootprint.h) - (left.baseFootprint.w * left.baseFootprint.h)
    })

    for (let index = 0; index < order.length && counter < maxProps; index += 1) {
      const { asset, required } = order[index]
      if (!asset) break
      // Кандидаты по убыванию оценки, а не один лучший: широкий предмет у стены
      // часто не помещается именно в самой удачной клетке, и одна неудача
      // раньше выбрасывала его целиком — вместе со стойкой и очагом.
      // Просматривается не вся зона, а ограниченная выборка. Полный перебор
      // давал квадратичную стоимость: предметов примерно столько же, сколько
      // клеток, и на 60×60 сборка занимала 0.8 секунды. Шаг выборки смещается
      // от номера предмета, поэтому разные предметы видят разные клетки, а
      // детерминизм сохраняется.
      const stride = cells.length > CANDIDATE_SCAN_LIMIT ? Math.ceil(cells.length / CANDIDATE_SCAN_LIMIT) : 1
      const offset = stride > 1 ? index % stride : 0
      const candidates = []
      for (let position = offset; position < cells.length; position += stride) {
        const cell = cells[position]
        if (occupied.has(`${cell.x},${cell.y}`) || keepClear.has(`${cell.x},${cell.y}`)) continue
        const score = scoreCellForAsset(map, asset, cell, placed, {
          zoneId: plan.zoneId,
          arrangement: semantic?.arrangement,
          zoneBounds,
        }, random)
        if (score === Number.NEGATIVE_INFINITY) continue
        candidates.push({ cell, score })
      }
      if (!candidates.length) continue
      candidates.sort((left, right) => right.score - left.score)

      let chosen = null
      const candidateLimit = required ? REQUIRED_PLACEMENT_ATTEMPTS : PLACEMENT_ATTEMPTS
      for (const candidate of candidates.slice(0, candidateLimit)) {
        const rotation = rotationFor(map, asset, candidate.cell, placed, plan.zoneId, random)
        const blocked = new Set([...occupied, ...keepClear])
        const footprint = fittingFootprint(map, blocked, candidate.cell, asset.baseFootprint, rotation)
        if (footprint) {
          chosen = { cell: candidate.cell, rotation, footprint }
          break
        }
      }
      // Если required не поместился в первых лучших позициях, bounded retry
      // проверяет следующий детерминированный слой кандидатов до отказа от
      // предмета. Optional props остаются на коротком пути.
      if (!chosen && required) {
        for (const candidate of candidates.slice(candidateLimit, candidateLimit + REQUIRED_RETRY_ATTEMPTS)) {
          const rotation = rotationFor(map, asset, candidate.cell, placed, plan.zoneId, random)
          const blocked = new Set([...occupied, ...keepClear])
          const footprint = fittingFootprint(map, blocked, candidate.cell, asset.baseFootprint, rotation)
          if (footprint) {
            chosen = { cell: candidate.cell, rotation, footprint }
            break
          }
        }
      }
      if (!chosen) continue

      const span = asset.scaleRange.max - asset.scaleRange.min
      counter += 1
      addProp(map, {
        id: `prop-${counter}-${asset.id}`,
        assetId: asset.id,
        x: chosen.cell.x + 0.5,
        y: chosen.cell.y + 0.5,
        rotation: chosen.rotation,
        scale: Number((asset.scaleRange.min + random() * span).toFixed(3)),
        footprint: chosen.footprint,
        zOrder: asset.baseFootprint.w ? 0 : 1,
        blocksMove: asset.blocksMove,
        blocksSight: asset.blocksSight,
        cover: asset.cover,
        destructible: asset.destructible,
        hp: asset.hp,
        interactive: asset.interactive,
      })
      for (const cell of chosen.footprint) occupied.add(`${cell.x},${cell.y}`)
      placed.push({ assetId: asset.id, x: chosen.cell.x, y: chosen.cell.y, zoneId: plan.zoneId })
    }
  }
  return map
}

/**
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {string} zoneId
 * @returns {Array<{x: number, y: number}>}
 */
function zoneCells(map, zoneId) {
  /** @type {Array<{x: number, y: number}>} */
  const cells = []
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell && cell.passable && cell.zone === zoneId) cells.push({ x, y })
    }
  }
  return cells
}

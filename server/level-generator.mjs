import { createHash } from 'node:crypto'

import { edgesAround, openDoorway, openWindow, planRooms } from './building-generator.mjs'
import { placeProps } from './prop-placement.mjs'
import { SCENE_THEMES, layoutOrganicCave } from './scene-themes.mjs'
import {
  MAX_LEVEL_OFFSET,
  SIZE_CLASSES,
  addProp,
  addSpawnPoint,
  addZone,
  cellAt,
  createTacticalMap,
  floorVariantAt,
  reachableCells,
  setCell,
  setEdge,
  validateTacticalMap,
} from './tactical-map.mjs'

/**
 * Генератор этажей локации (`docs/multilevel-map-plan.md`, раздел 5).
 *
 * Этаж — отдельная `TacticalMap` той же локации, а не второй слой внутри одной
 * сетки. Строится он не «с нуля по теме», а **от этажа, откуда идёт переход**:
 * второй этаж обязан стоять ровно на контуре первого, погреб — не вылезать
 * из-под здания, а лестница вниз — оказаться там же, где лестница вверх.
 * Поэтому вход у генератора не «тема и размер», а `baseMap` плюс предмет-
 * переход на ней.
 *
 * Всё детерминировано от `seed`: тот же `(locationId, level, seed)` при том же
 * `baseMap` даёт байт в байт ту же сериализованную карту. Это условие честного
 * replay — событие несёт готовую карту, но и повторная сборка обязана сойтись.
 */

export const LEVEL_GENERATOR = Object.freeze({ id: 'level-generator', version: '1' })

/** Сколько дополнительных этажей может объявить архитектор (раздел 5.1 плана). */
export const MAX_DECLARED_LEVELS = 3

/** Сколько соседних сидов пробуем, прежде чем признать пещеру непригодной. */
const CAVE_SEED_ATTEMPTS = 6

/**
 * Какая доля пола обязана быть достижима от точки прибытия, чтобы полость
 * считалась основной, а не случайным карманом рядом с лестницей.
 */
const CAVE_MAIN_CHAMBER_SHARE = 0.6

/**
 * @typedef {object} DeclaredLevel
 * @property {number} offset смещение от этажа входа; ноль запрещён
 * @property {string} hint назначение этажа словами архитектора
 * @property {string} label подпись этажа для игрока
 */

/**
 * @typedef {object} LevelGenerationResult
 * @property {import('./tactical-map.mjs').TacticalMap|null} map null при отказе
 * @property {number} levelIndex
 * @property {string} levelLabel
 * @property {{x: number, y: number}|null} arrival точка прибытия на новом этаже
 * @property {string} transitionPropId предмет обратного перехода
 * @property {string[]} warnings
 * @property {Array<{code: string, message: string, at?: string}>} errors
 */

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

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/**
 * @param {unknown} value
 * @param {number} maximum
 * @returns {string}
 */
function cleanText(value, maximum) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, maximum) : ''
}

/** Подписи по умолчанию. Этаж входа назван явно: на него ведут переходы сверху и снизу. */
const DEFAULT_LEVEL_LABELS = Object.freeze({
  0: 'Первый этаж',
  1: 'Второй этаж',
  2: 'Третий этаж',
  3: 'Четвёртый этаж',
  '-1': 'Подвал',
  '-2': 'Нижний подвал',
  '-3': 'Глубокий подвал',
})

/**
 * Подпись этажа для игрока.
 *
 * Наверху подпись всегда порядковая: «спальни и кабинет хозяина» — это задание
 * генератору, а не название яруса в указателе этажей. Внизу, наоборот, слова
 * архитектора обычно и есть название: «винный погреб» читается лучше, чем
 * «Подвал».
 *
 * @param {number} offset
 * @param {string} [hint]
 * @returns {string}
 */
export function levelLabelFor(offset, hint = '') {
  const index = Number.isSafeInteger(Number(offset)) ? Number(offset) : 0
  const fallback = DEFAULT_LEVEL_LABELS[/** @type {keyof typeof DEFAULT_LEVEL_LABELS} */ (String(index))]
    ?? (index > 0 ? `Этаж ${index + 1}` : `Ярус ${index}`)
  const text = cleanText(hint, 60)
  if (index >= 0 || !text) return fallback
  return text.charAt(0).toLocaleUpperCase('ru') + text.slice(1)
}

/**
 * Приводит заявку архитектора на этажи к тому, с чем работает генератор.
 *
 * Мусор отбрасывается, а не чинится: если `offset` не целое или равно нулю,
 * этаж просто не объявлен — придумывать за модель, куда она хотела вести
 * лестницу, нельзя. Диапазон, наоборот, зажимается: смысл «глубоко вниз»
 * понятен и при `offset = -7`, а предел ±3 — наше решение, а не её ошибка.
 *
 * @param {unknown} value
 * @returns {DeclaredLevel[]}
 */
export function normalizeDeclaredLevels(value) {
  /** @type {DeclaredLevel[]} */
  const result = []
  /** @type {Set<number>} */
  const seen = new Set()
  for (const raw of Array.isArray(value) ? value : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const declared = Number(/** @type {any} */ (raw).offset)
    if (!Number.isSafeInteger(declared) || declared === 0) continue
    const offset = clamp(declared, -MAX_LEVEL_OFFSET, MAX_LEVEL_OFFSET)
    if (seen.has(offset)) continue
    seen.add(offset)
    const hint = cleanText(/** @type {any} */ (raw).hint, 120)
    result.push({ offset, hint, label: levelLabelFor(offset, hint) })
    if (result.length >= MAX_DECLARED_LEVELS) break
  }
  return result
}

/**
 * @param {string} code
 * @param {string} message
 * @param {number} levelIndex
 * @param {string} levelLabel
 * @returns {LevelGenerationResult}
 */
function refusal(code, message, levelIndex, levelLabel) {
  return { map: null, levelIndex, levelLabel, arrival: null, transitionPropId: '', warnings: [], errors: [{ code, message }] }
}

/**
 * Клетка, в которой стоит предмет-переход на исходном этаже. Лестницы стоят
 * «стопкой», поэтому именно она становится точкой прибытия.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} baseMap
 * @param {{x?: number, y?: number, footprint?: Array<{x: number, y: number}>}|null} sourceProp
 * @returns {{x: number, y: number}|null}
 */
function arrivalPointOf(baseMap, sourceProp) {
  if (!sourceProp || typeof sourceProp !== 'object') return null
  const footprint = Array.isArray(sourceProp.footprint) ? sourceProp.footprint : []
  // `x/y` — это anchor предмета, а не обязательно первая клетка его
  // footprint. Для лестницы 2×1 порядок footprint может начинаться с верхней
  // клетки, тогда как переход должен прибывать в клетку под anchor игрока.
  // Старые/повреждённые записи без согласованного anchor сохраняют прежний
  // запасной путь через первую клетку footprint.
  const anchor = { x: Math.floor(Number(sourceProp.x)), y: Math.floor(Number(sourceProp.y)) }
  const anchorInFootprint = footprint.some((cell) => Number(cell?.x) === anchor.x && Number(cell?.y) === anchor.y)
  const cell = anchorInFootprint || !footprint.length
    ? anchor
    : { x: Number(footprint[0].x), y: Number(footprint[0].y) }
  if (!Number.isSafeInteger(cell.x) || !Number.isSafeInteger(cell.y)) return null
  if (cell.x < 0 || cell.y < 0 || cell.x >= baseMap.width || cell.y >= baseMap.height) return null
  return cell
}

/**
 * Контур здания на этаже: клетки, принадлежащие interior-зонам. Стены здания в
 * `building-generator` тоже лежат в interior-зоне, поэтому контур получается
 * вместе с кладкой, а не по одному лишь полу.
 *
 * Зон может не быть **ни одной**, и это не открытая местность, а потеря на
 * дороге: карта сцены доезжает до состояния старыми клетками, а те несут только
 * тип, материал и предмет — пересобранная из них карта помнит стены и двери, но
 * не зоны. Тогда контур берётся от самой лестницы: помещение, из которого
 * партия поднимается, плюс его кладка.
 *
 * Разделены именно эти два случая: «зон нет вообще» — карта прошла круг через
 * старые клетки, «есть зоны, но ни одной interior» — картограф действительно
 * нарисовал опушку, и подниматься там некуда. Волна вдобавок обязана упереться
 * в кладку со всех сторон: пятно, вышедшее на край карты, — это улица, а не
 * помещение, и второй этаж над ней не строится.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {{x: number, y: number}|null} [arrival] клетка перехода на этом этаже
 * @returns {Set<string>}
 */
export function interiorOutline(map, arrival = null) {
  const interiorZones = new Set(map.zones.filter((zone) => zone.kind === 'interior').map((zone) => zone.id))
  /** @type {Set<string>} */
  const outline = new Set()
  if (!interiorZones.size) return !map.zones.length && arrival ? enclosureAround(map, arrival) : outline
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell && interiorZones.has(cell.zone)) outline.add(`${x},${y}`)
    }
  }
  return outline
}

/**
 * Здание вокруг точки, восстановленное по одной геометрии.
 *
 * Правило одно: **двор — это то, что выходит на край участка.** Помещения
 * нарезаются кладкой, дверные клетки их разделяют; от лестницы волна идёт по
 * комнатам и переходит в соседнюю только через дверь и только если та комната
 * не касается границы карты. Двор и улица границы касаются всегда, потому что
 * участок и есть карта, — и внутрь контура не попадают.
 *
 * Дверь после круга через старые клетки шаг не держит
 * (`tacticalMapFromLegacyCells` ставит `blocksMove` только у проёма в стену),
 * поэтому обычная волна `reachableCells` растеклась бы по всему участку. Здесь
 * дверь — граница помещения, а не препятствие.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {{x: number, y: number}} arrival
 * @returns {Set<string>}
 */
function enclosureAround(map, arrival) {
  const doorCells = new Set(map.doors.map((door) => `${door.x},${door.y}`))
  /** @type {Map<string, number>} */
  const regionOf = new Map()
  /** @type {Array<{cells: string[], onBorder: boolean}>} */
  const regions = []
  const walkable = (x, y) => {
    const cell = cellAt(map, x, y)
    return Boolean(cell?.passable) && !doorCells.has(`${x},${y}`)
  }
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const start = `${x},${y}`
      if (regionOf.has(start) || !walkable(x, y)) continue
      const id = regions.length
      const region = { cells: [start], onBorder: false }
      regions.push(region)
      regionOf.set(start, id)
      const queue = [{ x, y }]
      for (let index = 0; index < queue.length; index += 1) {
        const current = queue[index]
        if (current.x === 0 || current.y === 0 || current.x === map.width - 1 || current.y === map.height - 1) {
          region.onBorder = true
        }
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nextX = current.x + dx
          const nextY = current.y + dy
          const key = `${nextX},${nextY}`
          if (regionOf.has(key) || !walkable(nextX, nextY)) continue
          regionOf.set(key, id)
          region.cells.push(key)
          queue.push({ x: nextX, y: nextY })
        }
      }
    }
  }

  const startRegion = regionOf.get(`${arrival.x},${arrival.y}`)
  if (startRegion == null || regions[startRegion].onBorder) return new Set()
  /** @type {Set<number>} */
  const taken = new Set([startRegion])
  for (let changed = true; changed;) {
    changed = false
    for (const door of map.doors) {
      const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .map(([dx, dy]) => regionOf.get(`${door.x + dx},${door.y + dy}`))
        .filter((id) => id != null)
      if (!sides.some((id) => taken.has(/** @type {number} */ (id)))) continue
      for (const side of sides) {
        const id = /** @type {number} */ (side)
        if (taken.has(id) || regions[id].onBorder) continue
        taken.add(id)
        changed = true
      }
    }
  }

  /** @type {Set<string>} */
  const outline = new Set()
  for (const id of taken) for (const key of regions[id].cells) outline.add(key)
  for (const door of map.doors) {
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dy]) => regionOf.get(`${door.x + dx},${door.y + dy}`))
      .filter((id) => id != null)
    if (sides.some((id) => taken.has(/** @type {number} */ (id)))) outline.add(`${door.x},${door.y}`)
  }
  // Кладка: непроходимые соседи получившегося пятна. Контур обязан идти вместе
  // со стенами — по нему выкраивается коробка этажа выше.
  for (const key of [...outline]) {
    const [x, y] = key.split(',').map(Number)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const neighbor = cellAt(map, x + dx, y + dy)
      if (neighbor && !neighbor.passable) outline.add(`${x + dx},${y + dy}`)
    }
  }
  return outline
}

/**
 * @param {Set<string>} outline
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}|null}
 */
function outlineBounds(outline) {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const key of outline) {
    const [x, y] = key.split(',').map(Number)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

/**
 * Клетка контура, у которой есть сосед вне контура, — внешняя стена этажа.
 *
 * @param {Set<string>} outline
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function onOutlineEdge(outline, x, y) {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !outline.has(`${x + dx},${y + dy}`))
}

/**
 * Сжимает контур на одну клетку: подвал не должен вылезать из-под здания.
 *
 * @param {Set<string>} outline
 * @returns {Set<string>}
 */
function erodeOutline(outline) {
  /** @type {Set<string>} */
  const result = new Set()
  for (const key of outline) {
    const [x, y] = key.split(',').map(Number)
    if (!onOutlineEdge(outline, x, y)) result.add(key)
  }
  return result
}

/**
 * Планировка этажа: тот же «зал плюс два помещения», что и на первом этаже, но
 * перегородки сдвинуты от сида. Топология берётся у `building-generator`, чтобы
 * второго правила нарезки в проекте не появилось; сид отвечает только за сдвиг.
 *
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} interior
 * @param {() => number} random
 * @param {[string, string, string]} zoneIds
 * @returns {{rooms: Array<{zoneId: string, minX: number, minY: number, maxX: number, maxY: number}>, partitionX: number, partitionY: number}}
 */
function planLevelRooms(interior, random, zoneIds) {
  const base = planRooms(interior)
  const partitionX = clamp(base.partitionX + Math.floor(random() * 3) - 1, interior.minX + 2, interior.maxX - 2)
  const partitionY = clamp(base.partitionY + Math.floor(random() * 3) - 1, interior.minY + 2, interior.maxY - 2)
  return {
    partitionX,
    partitionY,
    rooms: [
      { zoneId: zoneIds[0], minX: interior.minX, minY: interior.minY, maxX: partitionX - 1, maxY: interior.maxY },
      { zoneId: zoneIds[1], minX: partitionX + 1, minY: interior.minY, maxX: interior.maxX, maxY: partitionY - 1 },
      { zoneId: zoneIds[2], minX: partitionX + 1, minY: partitionY + 1, maxX: interior.maxX, maxY: interior.maxY },
    ],
  }
}

/**
 * Прорубает клетку под лестничный проём. Отличие от `openDoorway`: полотна
 * двери здесь не появляется — лестница не запирается, и дверь поперёк неё
 * означала бы, что переход можно заблокировать снаружи.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {number} x
 * @param {number} y
 * @param {string} zoneId
 * @param {string} material
 */
function carveStairwell(map, x, y, zoneId, material) {
  if (!cellAt(map, x, y)) return
  setCell(map, x, y, { passable: true, material, zone: zoneId })
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const neighbor = cellAt(map, x + dx, y + dy)
    if (!neighbor || !neighbor.passable) continue
    setEdge(map, x, y, x + dx, y + dy, { kind: 'none' })
  }
}

/**
 * Достижим ли хоть один переход от точки прибытия. Инвариант каждого этажа,
 * кроме нулевого: лестница, по которой пришли, обязана быть под ногами, а не за
 * глухой стеной (`docs/multilevel-map-plan.md`, 5.2).
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {{x: number, y: number}} arrival
 * @returns {boolean}
 */
export function transitionReachableFrom(map, arrival) {
  const reached = reachableCells(map, arrival.x, arrival.y)
  if (!reached.size) return false
  return map.props.some((prop) => prop.transition && prop.footprint.some((cell) => reached.has(`${cell.x},${cell.y}`)))
}

/**
 * Ставит парный переход обратно и проверяет собранный этаж.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {object} options
 * @param {{x: number, y: number}} options.arrival
 * @param {string} options.assetId
 * @param {number} options.toLevel
 * @param {string} options.label
 * @returns {string} идентификатор поставленного предмета
 */
function placePairedTransition(map, { arrival, assetId, toLevel, label }) {
  const id = `level-transition-${toLevel}`
  addProp(map, {
    id,
    assetId,
    x: arrival.x + 0.5,
    y: arrival.y + 0.5,
    rotation: 0,
    scale: 1,
    // Одна клетка, а не штатный след 2×1: у лестницы «в стопке» координата
    // обязана совпасть с исходной точно, и вторая клетка только мешала бы
    // упереться в стену на непрямоугольном контуре.
    footprint: [{ x: arrival.x, y: arrival.y }],
    zOrder: 0,
    blocksMove: false,
    blocksSight: false,
    cover: 'none',
    interactive: true,
    transition: { toLevel, label },
  })
  return id
}

/**
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {{x: number, y: number}} arrival
 * @returns {Array<{code: string, message: string, at?: string}>}
 */
function levelInvariantErrors(map, arrival) {
  const report = validateTacticalMap(map)
  const errors = [...report.errors]
  if (!map.props.some((prop) => prop.transition)) {
    errors.push({ code: 'LEVEL_TRANSITION_MISSING', message: 'На этаже нет ни одного перехода' })
  } else if (!transitionReachableFrom(map, arrival)) {
    errors.push({ code: 'LEVEL_TRANSITION_UNREACHABLE', message: 'Переход недостижим от точки прибытия' })
  }
  return errors
}

/**
 * Верхний этаж: контур наследуется, комнаты нарезаются заново.
 *
 * @param {object} options
 * @returns {LevelGenerationResult}
 */
function buildUpperLevel({ baseMap, locationId, index, fromLevel, seed, label, arrival }) {
  const outline = interiorOutline(baseMap, arrival)
  if (!outline.size) {
    return refusal(
      'LEVEL_OUTLINE_MISSING',
      'На этаже ниже нет interior-зон: наследовать контур здания не от чего',
      index,
      label,
    )
  }
  if (!outline.has(`${arrival.x},${arrival.y}`)) {
    return refusal(
      'LEVEL_ARRIVAL_OUTSIDE_OUTLINE',
      `Точка прибытия ${arrival.x},${arrival.y} лежит вне контура здания`,
      index,
      label,
    )
  }
  const bounds = outlineBounds(outline)
  const interior = {
    minX: (bounds?.minX ?? 0) + 1,
    minY: (bounds?.minY ?? 0) + 1,
    maxX: (bounds?.maxX ?? 0) - 1,
    maxY: (bounds?.maxY ?? 0) - 1,
  }
  if (interior.maxX - interior.minX < 4 || interior.maxY - interior.minY < 4) {
    return refusal('LEVEL_OUTLINE_TOO_SMALL', 'Контур здания слишком мал для второго этажа', index, label)
  }

  // Две ступени: сначала этаж с перегородками, затем — открытый ярус без них.
  // Ломаный контур может отрезать комнату от лестницы, и лучше отдать честный
  // открытый этаж, чем отказ.
  for (const partitioned of [true, false]) {
    const map = paintUpperLevel({
      baseMap, locationId, index, seed, label, arrival, outline, interior, partitioned,
    })
    const transitionPropId = placePairedTransition(map, {
      arrival,
      assetId: 'stairs_down',
      toLevel: fromLevel,
      label: levelLabelFor(fromLevel),
    })
    placeProps(map, {
      seed: `${seed}:props`,
      maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (map.sizeClass)].maxProps,
      zones: map.zones
        .filter((zone) => zone.label)
        .map((zone) => ({
          zoneId: zone.id,
          theme: 'interior',
          density: 18,
          require: ['bed', 'wardrobe', 'night_table', 'chest'],
          prefer: ['bed', 'night_table', 'washbasin', 'wardrobe', 'cupboard', 'chest', 'table_small', 'chair', 'candle', 'rug'],
        })),
    })
    const errors = levelInvariantErrors(map, arrival)
    if (!errors.length) {
      return {
        map,
        levelIndex: index,
        levelLabel: label,
        arrival,
        transitionPropId,
        warnings: partitioned ? [] : ['LEVEL_PARTITIONS_DROPPED: перегородки отрезали лестницу'],
        errors: [],
      }
    }
  }
  return refusal('LEVEL_GEOMETRY_LOST_TOPOLOGY', 'Верхний этаж не собрался связным ни с перегородками, ни без них', index, label)
}

/**
 * @param {object} options
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
function paintUpperLevel({ baseMap, locationId, index, seed, label, arrival, outline, interior, partitioned }) {
  const random = randomFor(`${LEVEL_GENERATOR.id}:${LEVEL_GENERATOR.version}:${seed}:up`)
  // Свой ключ шума на этаж: иначе подвал и первый этаж получили бы в одних и
  // тех же координатах один и тот же вариант тайла.
  /** @param {number} x @param {number} y */
  const variantAt = (x, y) => floorVariantAt(`${seed}:L${index}`, x, y)
  const map = createTacticalMap({
    width: baseMap.width,
    height: baseMap.height,
    locationId,
    levelIndex: index,
    levelLabel: label,
    seed: String(seed),
    generator: { ...LEVEL_GENERATOR },
    theme: baseMap.theme,
    tilesetId: baseMap.tilesetId,
    sizeClass: baseMap.sizeClass,
  })
  addZone(map, { id: 'walls', kind: 'interior', material: 'stone', lightLevel: 'dark', floorDirection: 'horizontal', label: '' })
  addZone(map, { id: 'landing', kind: 'interior', material: 'wood', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Площадка' })
  if (partitioned) {
    addZone(map, { id: 'bedroom', kind: 'interior', material: 'wood', lightLevel: 'dim', floorDirection: 'vertical', label: 'Спальня' })
    addZone(map, { id: 'study', kind: 'interior', material: 'wood', lightLevel: 'dark', floorDirection: 'vertical', label: 'Кабинет' })
  }
  const plan = partitioned
    ? planLevelRooms(interior, random, ['landing', 'bedroom', 'study'])
    : { partitionX: -1, partitionY: -1, rooms: [{ zoneId: 'landing', ...interior }] }

  /** @param {number} x @param {number} y */
  const roomAt = (x, y) => plan.rooms.find((room) => x >= room.minX && x <= room.maxX && y >= room.minY && y <= room.maxY)
  for (const key of [...outline].sort()) {
    const [x, y] = key.split(',').map(Number)
    const perimeter = onOutlineEdge(outline, x, y)
    const partition = partitioned && (x === plan.partitionX || (x > plan.partitionX && y === plan.partitionY))
    const room = roomAt(x, y)
    if (perimeter || partition || !room) {
      setCell(map, x, y, { passable: false, material: 'stone', zone: 'walls', variant: variantAt(x, y) })
      continue
    }
    const zone = map.zones.find((entry) => entry.id === room.zoneId)
    setCell(map, x, y, {
      passable: true,
      material: zone?.material ?? 'wood',
      zone: room.zoneId,
      variant: variantAt(x, y),
    })
  }

  for (const key of [...outline].sort()) {
    const [x, y] = key.split(',').map(Number)
    const own = cellAt(map, x, y)
    if (own && !own.passable) edgesAround(map, x, y, 'wall')
  }

  if (partitioned) {
    openDoorway(map, plan.partitionX, Math.round((interior.minY + plan.partitionY) / 2), 'upper-north-door')
    openDoorway(map, plan.partitionX, Math.round((plan.partitionY + interior.maxY) / 2), 'upper-south-door')
  }
  // Лестница обязана оказаться на полу, даже если перегородка легла ровно на
  // неё: прибытие в стену — не «редкий случай», а сломанный этаж.
  if (cellAt(map, arrival.x, arrival.y)?.passable === false) {
    carveStairwell(map, arrival.x, arrival.y, 'landing', 'wood')
  }

  // Окна по внешним стенам: середина каждой стороны плюс четверти длинных сторон.
  const bounds = outlineBounds(outline) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  const midX = Math.round((bounds.minX + bounds.maxX) / 2)
  const midY = Math.round((bounds.minY + bounds.maxY) / 2)
  for (const [x, y] of [
    [Math.round(bounds.minX + (bounds.maxX - bounds.minX) * 0.3), bounds.minY],
    [Math.round(bounds.minX + (bounds.maxX - bounds.minX) * 0.7), bounds.minY],
    [midX, bounds.maxY],
    [bounds.minX, midY],
    [bounds.maxX, midY],
  ]) {
    if (outline.has(`${x},${y}`)) openWindow(map, x, y)
  }

  addSpawnPoint(map, { id: 'level-arrival', x: arrival.x, y: arrival.y, role: 'party' })
  map.overlays = {
    compass: true,
    scaleBar: true,
    roomLabels: map.zones.filter((zone) => zone.label).map((zone) => ({ zoneId: zone.id, label: zone.label })),
  }
  return map
}

/**
 * Подвал: контур не больше контура этажа выше, кладка и земля вместо настила,
 * от одного до трёх помещений.
 *
 * @param {object} options
 * @returns {LevelGenerationResult}
 */
function buildCellarLevel({ baseMap, locationId, index, fromLevel, seed, label, arrival, sourceProp }) {
  const random = randomFor(`${LEVEL_GENERATOR.id}:${LEVEL_GENERATOR.version}:${seed}:down`)
  /** @param {number} x @param {number} y */
  const variantAt = (x, y) => floorVariantAt(`${seed}:L${index}`, x, y)
  const interiorCells = interiorOutline(baseMap, arrival)
  const outline = interiorCells.size ? cellarOutline(interiorCells, arrival) : rectangleAround(baseMap, arrival)
  if (!outline.has(`${arrival.x},${arrival.y}`)) {
    return refusal('LEVEL_ARRIVAL_OUTSIDE_OUTLINE', `Точка спуска ${arrival.x},${arrival.y} лежит вне контура подвала`, index, label)
  }
  const bounds = outlineBounds(outline)
  if (!bounds || bounds.maxX - bounds.minX < 4 || bounds.maxY - bounds.minY < 4) {
    return refusal('LEVEL_OUTLINE_TOO_SMALL', 'Контур этажа выше слишком мал для подвала', index, label)
  }

  const map = createTacticalMap({
    width: baseMap.width,
    height: baseMap.height,
    locationId,
    levelIndex: index,
    levelLabel: label,
    seed: String(seed),
    generator: { ...LEVEL_GENERATOR },
    theme: baseMap.theme,
    tilesetId: baseMap.tilesetId,
    sizeClass: baseMap.sizeClass,
  })
  addZone(map, { id: 'walls', kind: 'interior', material: 'stone', lightLevel: 'dark', floorDirection: 'horizontal', label: '' })
  addZone(map, { id: 'cellar', kind: 'interior', material: 'stone', lightLevel: 'dark', floorDirection: 'horizontal', label })

  // Помещений от одного до трёх: погреб — это не анфилада, перегородки здесь
  // нужны ради укрытий, а не ради планировки.
  const roomCount = 1 + Math.floor(random() * 3)
  const inner = { minX: bounds.minX + 1, minY: bounds.minY + 1, maxX: bounds.maxX - 1, maxY: bounds.maxY - 1 }
  /** @type {number[]} */
  const partitions = []
  for (let room = 1; room < roomCount; room += 1) {
    const share = room / roomCount
    partitions.push(clamp(Math.round(inner.minX + (inner.maxX - inner.minX) * share), inner.minX + 2, inner.maxX - 2))
  }

  for (const key of [...outline].sort()) {
    const [x, y] = key.split(',').map(Number)
    const perimeter = onOutlineEdge(outline, x, y)
    if (perimeter || partitions.includes(x)) {
      setCell(map, x, y, { passable: false, material: 'stone', zone: 'walls', variant: variantAt(x, y) })
      continue
    }
    setCell(map, x, y, {
      passable: true,
      // Пол погреба — утоптанная земля между каменной кладкой; однородный
      // камень читается как склеп, а не как подсобное помещение.
      material: (x + y) % 3 === 0 ? 'stone' : 'earth',
      zone: 'cellar',
      variant: variantAt(x, y),
    })
  }

  for (const key of [...outline].sort()) {
    const [x, y] = key.split(',').map(Number)
    const own = cellAt(map, x, y)
    if (own && !own.passable) edgesAround(map, x, y, 'wall')
  }
  for (let position = 0; position < partitions.length; position += 1) {
    openDoorway(map, partitions[position], Math.round((inner.minY + inner.maxY) / 2), `cellar-door-${position + 1}`)
  }
  if (cellAt(map, arrival.x, arrival.y)?.passable === false) {
    carveStairwell(map, arrival.x, arrival.y, 'cellar', 'earth')
  }

  addSpawnPoint(map, { id: 'level-arrival', x: arrival.x, y: arrival.y, role: 'party' })
  map.overlays = {
    compass: true,
    scaleBar: true,
    roomLabels: [{ zoneId: 'cellar', label }],
  }

  const transitionPropId = placePairedTransition(map, {
    arrival,
    // Спустились по люку — по нему же и поднимаемся: игрок ищет глазами тот же
    // предмет, которым воспользовался.
    assetId: String(sourceProp?.assetId ?? '') === 'trapdoor' ? 'trapdoor' : 'stairs_up',
    toLevel: fromLevel,
    label: levelLabelFor(fromLevel),
  })
  placeProps(map, {
    seed: `${seed}:props`,
    maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (map.sizeClass)].maxProps,
    zones: [{
      zoneId: 'cellar',
      theme: 'interior',
      density: 20,
      require: ['barrel_stack', 'crate_stack', 'shelf_wall', 'sack'],
      prefer: ['barrel', 'barrel_stack', 'crate', 'crate_stack', 'sack', 'shelf_wall', 'chest', 'bottle', 'pot'],
    }],
  })

  const errors = levelInvariantErrors(map, arrival)
  if (errors.length) {
    return { map: null, levelIndex: index, levelLabel: label, arrival: null, transitionPropId: '', warnings: [], errors }
  }
  return { map, levelIndex: index, levelLabel: label, arrival, transitionPropId, warnings: [], errors: [] }
}

/**
 * Контур подвала: сжатый контур здания сверху. Клетка спуска возвращается в
 * контур принудительно — лестница обязана быть, даже если она стояла вплотную к
 * внешней стене.
 *
 * @param {Set<string>} interiorCells
 * @param {{x: number, y: number}} arrival
 * @returns {Set<string>}
 */
function cellarOutline(interiorCells, arrival) {
  const eroded = erodeOutline(interiorCells)
  if (eroded.has(`${arrival.x},${arrival.y}`)) return eroded
  for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const key = `${arrival.x + dx},${arrival.y + dy}`
    if (interiorCells.has(key)) eroded.add(key)
  }
  return eroded
}

/**
 * Подвал под локацией без interior-зон: прямоугольник вокруг точки спуска,
 * заведомо помещающийся в сетку.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} baseMap
 * @param {{x: number, y: number}} arrival
 * @returns {Set<string>}
 */
function rectangleAround(baseMap, arrival) {
  const halfWidth = Math.max(3, Math.min(7, Math.floor(baseMap.width / 3)))
  const halfHeight = Math.max(3, Math.min(6, Math.floor(baseMap.height / 3)))
  const minX = clamp(arrival.x - halfWidth, 0, Math.max(0, baseMap.width - 1))
  const maxX = clamp(arrival.x + halfWidth, 0, Math.max(0, baseMap.width - 1))
  const minY = clamp(arrival.y - halfHeight, 0, Math.max(0, baseMap.height - 1))
  const maxY = clamp(arrival.y + halfHeight, 0, Math.max(0, baseMap.height - 1))
  /** @type {Set<string>} */
  const outline = new Set()
  for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) outline.add(`${x},${y}`)
  return outline
}

/**
 * Пещерный ярус. Полость строится теми же примитивами, что и обычная пещера, но
 * с дополнительным условием: точка прибытия обязана быть проходимой и связанной
 * с основной полостью. Нарушение чинится не правкой геометрии, а соседним
 * сидом — иначе «починенная» пещера перестала бы быть детерминированной.
 *
 * @param {object} options
 * @returns {LevelGenerationResult}
 */
function buildCaveLevel({ baseMap, locationId, index, fromLevel, seed, label, arrival, sourceProp }) {
  const definition = SCENE_THEMES.find((candidate) => candidate.id === 'cave')
  if (!definition) return refusal('LEVEL_THEME_MISSING', 'Тема пещеры не объявлена в каталоге', index, label)
  const goingUp = index > fromLevel
  for (let attempt = 0; attempt < CAVE_SEED_ATTEMPTS; attempt += 1) {
    const attemptSeed = attempt === 0 ? String(seed) : `${seed}#${attempt}`
    const map = layoutOrganicCave(definition, {
      seed: attemptSeed,
      width: baseMap.width,
      height: baseMap.height,
      locationId,
    })
    // Этаж проставляется до расстановки перехода: `addProp` сверяет `toLevel`
    // именно с ним, и на не заполненном поле сверка была бы ложной.
    map.levelIndex = index
    map.levelLabel = label
    if (cellAt(map, arrival.x, arrival.y)?.passable !== true) continue
    const reached = reachableCells(map, arrival.x, arrival.y)
    let walkable = 0
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) if (cellAt(map, x, y)?.passable) walkable += 1
    }
    if (!walkable || reached.size < walkable * CAVE_MAIN_CHAMBER_SHARE) continue

    addSpawnPoint(map, { id: 'level-arrival', x: arrival.x, y: arrival.y, role: 'party' })
    const transitionPropId = placePairedTransition(map, {
      arrival,
      assetId: goingUp ? 'stairs_down' : (String(sourceProp?.assetId ?? '') === 'trapdoor' ? 'trapdoor' : 'stairs_up'),
      toLevel: fromLevel,
      label: levelLabelFor(fromLevel),
    })
    placeProps(map, {
      seed: `${attemptSeed}:props`,
      maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (map.sizeClass)].maxProps,
      zones: map.zones.map((zone) => ({
        zoneId: zone.id,
        theme: definition.id,
        density: definition.density ?? 12,
        require: definition.require,
        prefer: definition.prefer,
      })),
    })
    const errors = levelInvariantErrors(map, arrival)
    if (!errors.length) {
      return {
        map,
        levelIndex: index,
        levelLabel: label,
        arrival,
        transitionPropId,
        warnings: attempt ? [`LEVEL_SEED_RETRIED: ${attempt}`] : [],
        errors: [],
      }
    }
  }
  return refusal(
    'LEVEL_ARRIVAL_UNREACHABLE',
    `Точка прибытия ${arrival.x},${arrival.y} не попала в основную полость за ${CAVE_SEED_ATTEMPTS} сидов`,
    index,
    label,
  )
}

/**
 * @param {string} theme
 * @returns {boolean}
 */
function isCaveTheme(theme) {
  return /^cave$|пещер|грот|каверн|штольн/iu.test(String(theme ?? ''))
}

/**
 * Собирает карту этажа локации.
 *
 * @param {object} options
 * @param {string} [options.locationId]
 * @param {number} options.level этаж, который строим
 * @param {string} [options.seed] сид этажа (`levelSeed` в `adventure-director.mjs`)
 * @param {import('./tactical-map.mjs').TacticalMap} options.baseMap карта этажа, откуда идёт переход
 * @param {{assetId?: string, x?: number, y?: number, footprint?: Array<{x: number, y: number}>}} options.sourceProp предмет-переход на исходном этаже
 * @param {string} [options.hint] назначение этажа из заявки архитектора
 * @param {string} [options.theme] тема локации
 * @returns {LevelGenerationResult}
 */
export function generateLevelMap({
  locationId = '', level, seed = 'level', baseMap, sourceProp, hint = '', theme = '',
} = /** @type {any} */ ({})) {
  const index = Number(level)
  const label = levelLabelFor(Number.isSafeInteger(index) ? index : 0, hint)
  if (!Number.isSafeInteger(index) || index === 0 || Math.abs(index) > MAX_LEVEL_OFFSET) {
    return refusal(
      'LEVEL_INDEX_NOT_ALLOWED',
      `Этаж ${String(level)} не строится: нужен ненулевой целый номер в пределах ±${MAX_LEVEL_OFFSET}`,
      Number.isSafeInteger(index) ? index : 0,
      label,
    )
  }
  if (!baseMap || typeof baseMap !== 'object' || !Array.isArray(baseMap.zones)) {
    return refusal('LEVEL_BASE_MAP_MISSING', 'Не передана карта этажа, откуда идёт переход', index, label)
  }
  const fromLevel = Number.isSafeInteger(Number(baseMap.levelIndex)) ? Number(baseMap.levelIndex) : 0
  if (fromLevel === index) {
    return refusal('LEVEL_INDEX_SAME_AS_BASE', `Этаж ${index} совпадает с этажом исходной карты`, index, label)
  }
  const arrival = arrivalPointOf(baseMap, sourceProp ?? null)
  if (!arrival) {
    return refusal('LEVEL_SOURCE_PROP_MISSING', 'У перехода на исходном этаже нет координат внутри карты', index, label)
  }

  const shared = { baseMap, locationId, index, fromLevel, seed, label, arrival, hint, sourceProp }
  if (isCaveTheme(theme) || isCaveTheme(baseMap.theme)) return buildCaveLevel(shared)
  return index > fromLevel ? buildUpperLevel(shared) : buildCellarLevel(shared)
}

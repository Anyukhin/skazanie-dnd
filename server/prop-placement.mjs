// @ts-check
import { createHash } from 'node:crypto'

import { assetById, assetsForTheme } from './asset-registry.mjs'
import { addProp, cellAt, edgeBetween } from './tactical-map.mjs'

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

export const PROP_PLACEMENT_VERSION = 'skazanie:prop-placement-v1'

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
 * @param {Set<string>} occupied
 * @param {{x: number, y: number}} anchor
 * @param {{w: number, h: number}} footprint
 * @param {number} rotation
 * @returns {Array<{x: number, y: number}>|null} null, если положения нет
 */
function fittingFootprint(map, occupied, anchor, footprint, rotation) {
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
          if (!target || !target.passable || occupied.has(`${x},${y}`)) fits = false
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
 * @param {Array<{assetId: string, x: number, y: number}>} placed
 * @param {() => number} random
 * @returns {number}
 */
function scoreCellForAsset(map, asset, cell, placed, random) {
  const walls = wallSidesAt(map, cell.x, cell.y).length
  let score = random() * 2

  if (asset.anchor === 'wall') score += walls * 6
  else if (asset.anchor === 'corner') score += walls >= 2 ? 14 : walls * 2
  else score -= walls * 1.5

  // Стул тянется к столу — правило, ради которого расстановка вообще перестаёт
  // выглядеть случайной.
  if (asset.id === 'chair' || asset.id === 'stool' || asset.id === 'bench') {
    const nearestTable = nearestPlaced(placed, cell, (id) => id.startsWith('table_'))
    score += nearestTable == null ? -8 : nearestTable <= 1 ? 16 : nearestTable === 2 ? 6 : -nearestTable
  }
  // Мелкая утварь ложится поверх столов и стойки.
  if (!asset.baseFootprint.w) {
    const nearestSurface = nearestPlaced(placed, cell, (id) => id.startsWith('table_') || id === 'bar_counter')
    score += nearestSurface == null ? -4 : nearestSurface === 0 ? 12 : nearestSurface <= 1 ? 5 : -nearestSurface
  }
  // Деревья и кусты только на траве. Это запрет, а не малый вес.
  if (asset.id.startsWith('tree_') || asset.id === 'bush' || asset.id === 'shrub') {
    const material = cellAt(map, cell.x, cell.y)?.material
    if (material !== 'grass' && material !== 'earth') return Number.NEGATIVE_INFINITY
    score += material === 'grass' ? 8 : 2
    // Деревья не жмутся друг к другу вплотную.
    const nearestTree = nearestPlaced(placed, cell, (id) => id.startsWith('tree_'))
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
 * @param {Array<{assetId: string, x: number, y: number}>} placed
 * @param {() => number} random
 * @returns {number}
 */
function rotationFor(map, asset, cell, placed, random) {
  if (asset.anchor === 'wall' || asset.anchor === 'corner') {
    const walls = wallSidesAt(map, cell.x, cell.y)
    if (walls.length) return walls[Math.floor(random() * walls.length) % walls.length].facing
  }
  if (asset.id === 'chair' || asset.id === 'stool' || asset.id === 'bench') {
    const table = closestRecord(placed, cell, (id) => id.startsWith('table_') || id === 'bar_counter')
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
 * @typedef {object} ZonePlacementPlan
 * @property {string} zoneId
 * @property {string} theme тема, по которой отбираются ассеты реестра
 * @property {number} density предметов на 100 клеток зоны
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
  /** @type {Array<{assetId: string, x: number, y: number}>} */
  const placed = map.props.map((prop) => ({ assetId: prop.assetId, x: Math.floor(prop.x), y: Math.floor(prop.y) }))
  let counter = map.props.length

  for (const plan of zones ?? []) {
    const cells = zoneCells(map, plan.zoneId)
    if (!cells.length) continue
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
    /** @param {import('./asset-registry.mjs').AssetEntry|null} asset */
    const enqueue = (asset) => {
      if (!asset || !allowed.has(asset.id) || wanted.length >= budget) return
      wanted.push(asset)
      for (const [companionId, count] of COMPANIONS[asset.id] ?? []) {
        for (let index = 0; index < count && wanted.length < budget; index += 1) {
          const companion = assetById(companionId)
          if (companion) wanted.push(companion)
        }
      }
    }
    for (const id of plan.require ?? []) enqueue(assetById(id))
    // Случайный добор идёт из `prefer`, если он задан, и только иначе из всего
    // каталога темы. Без этого мелочь вытесняет крупное: во дворе таверны
    // оказывалось по четыре костра и по три коновязи, а деревьев — одно, и
    // двор переставал читаться как двор.
    const pool = (plan.prefer ?? []).map((id) => assetById(id)).filter(Boolean)
    const source = pool.length ? pool : catalogue
    while (wanted.length < budget) {
      const pick = source[Math.floor(random() * source.length) % source.length]
      if (!pick) break
      enqueue(pick)
    }

    // Крупные предметы ставятся первыми, мелкая утварь — поверх и рядом.
    const order = wanted.sort((left, right) => (
      (right.baseFootprint.w * right.baseFootprint.h) - (left.baseFootprint.w * left.baseFootprint.h)
    ))

    for (let index = 0; index < order.length && counter < maxProps; index += 1) {
      const asset = order[index]
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
        if (occupied.has(`${cell.x},${cell.y}`)) continue
        const score = scoreCellForAsset(map, asset, cell, placed, random)
        if (score === Number.NEGATIVE_INFINITY) continue
        candidates.push({ cell, score })
      }
      if (!candidates.length) continue
      candidates.sort((left, right) => right.score - left.score)

      let chosen = null
      for (const candidate of candidates.slice(0, PLACEMENT_ATTEMPTS)) {
        const rotation = rotationFor(map, asset, candidate.cell, placed, random)
        const footprint = fittingFootprint(map, occupied, candidate.cell, asset.baseFootprint, rotation)
        if (footprint) {
          chosen = { cell: candidate.cell, rotation, footprint }
          break
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
      placed.push({ assetId: asset.id, x: chosen.cell.x, y: chosen.cell.y })
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

// @ts-check
import { createHash } from 'node:crypto'

import { progressionWaves, reachableZones, validateSceneGraph } from './scene-graph.mjs'
import {
  SIZE_CLASSES,
  addZone,
  cellAt,
  createTacticalMap,
  doorwayEdgeAt,
  floorVariantAt,
  reachableCells,
  setCell,
  setDoor,
  setEdge,
  validateTacticalMap,
} from './tactical-map.mjs'

/**
 * Стадия 2 генератора сцены — граф превращается в клетки, рёбра и зоны
 * (`docs/tactical-map-plan.md`, раздел 8).
 *
 * Топология уже проверена стадией 1: достижимость цели и порядок ключей
 * разобраны на графе. Здесь решается только геометрия, и её задача —
 * **не потерять** проверенную топологию: связь графа обязана стать настоящим
 * проходом между двумя помещениями, а запертая связь — запертой дверью.
 *
 * Помещения нарезаются двоичным разбиением прямоугольника. Соседние листья
 * разбиения смежны по построению, поэтому зоны раскладываются по листьям в
 * порядке волн из стадии 1: связанные зоны попадают рядом, и связь становится
 * проёмом в общей стене, а не коридором через полкарты.
 *
 * Склеп устроен иначе (версия 2): камеры 225–625 фт², вырубленные в скале, и
 * ходы в клетку шириной между ними (`planChambers`). Разбиение отдавало склепу
 * всю карту: «фамильный склеп» выходил залом 180×150 футов с рядами колонн.
 */

export const GRAPH_LAYOUT = Object.freeze({ id: 'graph-layout', version: '2' })

/**
 * Соль случайности разбиения залами. Версия 2 изменила только склеп; храм и
 * подземелье с тем же сидом обязаны выйти прежними, поэтому их поток
 * случайности по-прежнему от версии 1.
 */
const SPLIT_RANDOM_SALT = `${GRAPH_LAYOUT.id}:1`

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
 * @typedef {object} LeafRect
 * @property {number} minX
 * @property {number} minY
 * @property {number} maxX
 * @property {number} maxY
 */

/**
 * Двоичное разбиение прямоугольника на нужное число листьев. Режется всегда
 * самый большой лист — так помещения получаются соизмеримыми, а не одно во всю
 * карту и щель рядом.
 *
 * @param {LeafRect} area
 * @param {number} count
 * @param {() => number} random
 * @param {number} minimum минимальная сторона помещения вместе со стенами
 * @returns {LeafRect[]}
 */
export function splitArea(area, count, random, minimum = 5) {
  /** @type {LeafRect[]} */
  let leaves = [{ ...area }]
  let guard = 0
  while (leaves.length < count && guard < count * 8) {
    guard += 1
    leaves.sort((left, right) => (
      (right.maxX - right.minX) * (right.maxY - right.minY) - (left.maxX - left.minX) * (left.maxY - left.minY)
    ))
    const target = leaves.shift()
    if (!target) break
    const width = target.maxX - target.minX + 1
    const height = target.maxY - target.minY + 1
    const canSplitX = width >= minimum * 2 + 1
    const canSplitY = height >= minimum * 2 + 1
    if (!canSplitX && !canSplitY) {
      leaves.push(target)
      break
    }
    const vertical = canSplitX && (!canSplitY || (width >= height ? random() < 0.8 : random() < 0.2))
    if (vertical) {
      const low = target.minX + minimum
      const high = target.maxX - minimum
      const cut = low + Math.floor(random() * Math.max(1, high - low + 1))
      leaves.push({ ...target, maxX: cut }, { ...target, minX: cut })
    } else {
      const low = target.minY + minimum
      const high = target.maxY - minimum
      const cut = low + Math.floor(random() * Math.max(1, high - low + 1))
      leaves.push({ ...target, maxY: cut }, { ...target, minY: cut })
    }
  }
  // Порядок обязан быть детерминированным и предсказуемым: сверху вниз, слева
  // направо — тогда вход оказывается у края карты.
  return leaves.sort((left, right) => left.minY - right.minY || left.minX - right.minX)
}

/**
 * Смежны ли два прямоугольника по стене, и где именно.
 *
 * @param {LeafRect} a
 * @param {LeafRect} b
 * @returns {{axis: 'x'|'y', at: number, from: number, to: number}|null}
 */
export function sharedWall(a, b) {
  // Общая вертикальная стена: правый край одного совпадает с левым краем другого.
  for (const [left, right] of [[a, b], [b, a]]) {
    if (left.maxX === right.minX) {
      const from = Math.max(left.minY, right.minY) + 1
      const to = Math.min(left.maxY, right.maxY) - 1
      if (to >= from) return { axis: 'x', at: left.maxX, from, to }
    }
  }
  for (const [top, bottom] of [[a, b], [b, a]]) {
    if (top.maxY === bottom.minY) {
      const from = Math.max(top.minX, bottom.minX) + 1
      const to = Math.min(top.maxX, bottom.maxX) - 1
      if (to >= from) return { axis: 'y', at: top.maxY, from, to }
    }
  }
  return null
}

/**
 * Раскладывает зоны графа по листьям так, чтобы связанные зоны оказались
 * рядом. Порядок обхода — волны стадии 1: вход первым, за ним то, что от него
 * открывается.
 *
 * @param {import('./scene-graph.mjs').SceneGraph} graph
 * @param {LeafRect[]} leaves
 * @returns {Map<string, LeafRect>}
 */
export function assignZonesToLeaves(graph, leaves) {
  const order = progressionWaves(graph).flatMap((wave) => wave.zones)
  for (const zone of graph.zones) if (!order.includes(zone.id)) order.push(zone.id)
  // Сначала — раскладка, где каждая связь графа становится общей стеной.
  // Жадный выбор ниже брал первый свободный лист, если смежного не было, и
  // запертый тайник склепа оказывался за глухой стеной: комната без входа.
  const exact = exactLeafAssignment(graph, order, leaves)
  if (exact) return exact
  /** @type {Map<string, LeafRect>} */
  const placed = new Map()
  const free = [...leaves]
  for (const zoneId of order) {
    if (!free.length) break
    // Ищем лист, смежный с уже размещённым соседом по графу: тогда связь
    // станет проёмом в общей стене.
    const neighbours = graph.links
      .filter((link) => link.from === zoneId || link.to === zoneId)
      .map((link) => (link.from === zoneId ? link.to : link.from))
      .map((id) => placed.get(id))
      .filter(Boolean)
    let index = 0
    if (neighbours.length) {
      const found = free.findIndex((leaf) => neighbours.some((neighbour) => sharedWall(leaf, /** @type {LeafRect} */ (neighbour))))
      if (found >= 0) index = found
    }
    placed.set(zoneId, free.splice(index, 1)[0])
  }
  return placed
}

/**
 * Раскладка с возвратом: зона встаёт только в лист, смежный со всеми уже
 * размещёнными соседями по графу. Зон немного (до шести), листьев чуть
 * больше, поэтому перебор ограничен; при неудаче — `null`, и работает
 * прежний жадный выбор.
 *
 * @param {import('./scene-graph.mjs').SceneGraph} graph
 * @param {string[]} order
 * @param {LeafRect[]} leaves
 * @returns {Map<string, LeafRect>|null}
 */
function exactLeafAssignment(graph, order, leaves) {
  /** @type {Map<string, LeafRect>} */
  const placed = new Map()
  const used = new Set()
  let budget = 5000
  /** @param {number} position @returns {boolean} */
  const place = (position) => {
    if (position >= order.length) return true
    const zoneId = order[position]
    const neighbours = graph.links
      .filter((link) => link.from === zoneId || link.to === zoneId)
      .map((link) => placed.get(link.from === zoneId ? link.to : link.from))
      .filter(Boolean)
    for (let index = 0; index < leaves.length; index += 1) {
      if (used.has(index) || (budget -= 1) <= 0) continue
      const leaf = leaves[index]
      if (!neighbours.every((neighbour) => sharedWall(leaf, /** @type {LeafRect} */ (neighbour)))) continue
      placed.set(zoneId, leaf)
      used.add(index)
      if (place(position + 1)) return true
      placed.delete(zoneId)
      used.delete(index)
    }
    return false
  }
  return order.length <= leaves.length && place(0) ? placed : null
}

/**
 * @typedef {object} ChamberMouth
 * @property {number} x клетка стены камеры, через которую в неё входит ход
 * @property {number} y
 * @property {boolean} door стоит ли в этом устье дверь связи
 */

/**
 * @typedef {object} ChamberPassage
 * @property {import('./scene-graph.mjs').SceneLink} link
 * @property {Array<{x: number, y: number}>} cells клетки хода от устья до устья
 * @property {ChamberMouth[]} mouths
 */

/**
 * Стороны камеры, откуда выходит ход. Открытое устье (без двери) — только на
 * северной и западной стене. Тонкие стены (`server/thin-walls.mjs`) отдают
 * проём без двери камере обходом сверху вниз и слева направо: клетка хода
 * южнее или восточнее такого проёма шла следом за ним, и ход по цепочке
 * становился полом камеры. Устье с дверью цепочку останавливает на любой
 * стене.
 */
const CHAMBER_SIDES = Object.freeze([
  { id: 'n', dx: 0, dy: -1, open: true },
  { id: 'w', dx: -1, dy: 0, open: true },
  { id: 's', dx: 0, dy: 1, open: false },
  { id: 'e', dx: 1, dy: 0, open: false },
])

/**
 * Размеры камеры вместе с кладкой, в клетках. Тонкие стены отдают кладку
 * камере, поэтому на доске камера ровно такого размера: 15–30 футов по
 * стороне и 225–625 фт² по площади. Галерея вытянута — ниши с урнами вдоль
 * длинных стен — и шире прочих: в ней встаёт место обряда (4×3 клетки,
 * `server/scene-dressing.mjs`), а вход для него занят точкой появления
 * отряда. Тайник теснее. Устья — только на сторонах от четырёх клеток
 * (`mouthsOf`), поэтому у каждой камеры такая сторона есть.
 *
 * @param {import('./scene-graph.mjs').SceneZone} zone
 * @param {string} goalZoneId
 * @returns {Array<[number, number]>}
 */
function chamberSizes(zone, goalZoneId) {
  if (/галере/iu.test(zone.label ?? '')) return [[6, 4], [4, 6]]
  if (zone.id === goalZoneId) return [[5, 3], [3, 5]]
  return [[5, 4], [4, 5]]
}

/**
 * Сколько клеток породы оставить между камерами. Одна клетка — стена,
 * которую потом прорубает петля (`addShortcutLoops` в
 * `server/scene-themes.mjs`); лаз в три клетки отходит камере, и камера
 * больше двадцати клеток (500 фт²) вышла бы за 625 фт². Такие камеры
 * держатся через две клетки — лаз до них не дотягивается.
 *
 * @param {LeafRect} a
 * @param {LeafRect} b
 */
function minimumGap(a, b) {
  const area = (/** @type {LeafRect} */ rect) => (rect.maxX - rect.minX + 1) * (rect.maxY - rect.minY + 1)
  return area(a) > 20 || area(b) > 20 ? 2 : 1
}

/**
 * Склеп: камеры, вырубленные в скале, и ходы в клетку между ними. Камера —
 * прямоугольник с кладкой по краю (как лист разбиения); ход — клетки без
 * зоны. Порода остаётся сплошной.
 *
 * Ход держится не ближе трёх клеток к чужой камере по прямой, а из своей
 * выходит прямо на две клетки: иначе тонкие стены отдали бы камере породу
 * между нею и ходом, и ход слился бы с полом камеры.
 *
 * @param {import('./scene-graph.mjs').SceneGraph} graph
 * @param {number} width
 * @param {number} height
 * @param {() => number} random
 * @returns {{rooms: Map<string, LeafRect>, passages: ChamberPassage[]}|null}
 */
export function planChambers(graph, width, height, random) {
  const order = progressionWaves(graph).flatMap((wave) => wave.zones)
  for (const zone of graph.zones) if (!order.includes(zone.id)) order.push(zone.id)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const plan = tryPlanChambers(graph, order, width, height, random)
    if (plan) return plan
  }
  return null
}

/**
 * Одна попытка раскладки камер; `null`, если какая-то камера не встала.
 *
 * @param {import('./scene-graph.mjs').SceneGraph} graph
 * @param {string[]} order
 * @param {number} width
 * @param {number} height
 * @param {() => number} random
 * @returns {{rooms: Map<string, LeafRect>, passages: ChamberPassage[]}|null}
 */
function tryPlanChambers(graph, order, width, height, random) {
  const at = (/** @type {number} */ x, /** @type {number} */ y) => y * width + x
  const inside = (/** @type {number} */ x, /** @type {number} */ y) => x >= 1 && y >= 1 && x <= width - 2 && y <= height - 2
  // 1 — клетка хода, 2 — её сосед: второй ход рядом не идёт, ходы не сливаются.
  let taken = new Uint8Array(width * height)
  /** @type {Map<string, LeafRect>} */
  const rooms = new Map()
  /** @type {ChamberPassage[]} */
  const passages = []
  /** Клетка в двух шагах по прямой от камеры (или в ней самой). */
  const nearRect = (/** @type {LeafRect} */ rect, /** @type {number} */ x, /** @type {number} */ y) => (
    (x >= rect.minX && x <= rect.maxX && y >= rect.minY - 2 && y <= rect.maxY + 2)
    || (y >= rect.minY && y <= rect.maxY && x >= rect.minX - 2 && x <= rect.maxX + 2)
  )
  const free = (/** @type {number} */ x, /** @type {number} */ y) => inside(x, y) && !taken[at(x, y)]
    && [...rooms.values()].every((rect) => !nearRect(rect, x, y))
  const gap = (/** @type {LeafRect} */ a, /** @type {LeafRect} */ b) => Math.max(
    b.minX - a.maxX - 1, a.minX - b.maxX - 1, b.minY - a.maxY - 1, a.minY - b.maxY - 1,
  )
  const farthest = Math.max(3, Math.min(9, Math.round(Math.min(width, height) / 4)))

  /**
   * Устья камеры на разрешённых сторонах: клетка кладки (не угол), две клетки
   * хода прямо наружу и третья — уже свободная порода. Открытое устье
   * (`openOnly`) — только там, где ему не нужна дверь (`CHAMBER_SIDES`).
   * @param {LeafRect} rect
   * @param {boolean} openOnly
   */
  const mouthsOf = (rect, openOnly) => {
    /** @type {Array<{x: number, y: number, dx: number, dy: number, open: boolean}>} */
    const found = []
    for (const side of CHAMBER_SIDES) {
      if (openOnly && !side.open) continue
      const along = side.dx === 0
      // Угол кладки тонкие стены отдают камере по двум соседям-стенам, а
      // проём соседом-стеной не считается: у устья рядом с углом угол
      // остаётся породой — косяк у проёма. На стороне в три клетки устье
      // соседствует с обоими углами, и камера теряла всю стену — там его нет.
      const from = along ? rect.minX + 1 : rect.minY + 1
      const to = along ? rect.maxX - 1 : rect.maxY - 1
      if (to - from < 1) continue
      for (let step = from; step <= to; step += 1) {
        const x = along ? step : (side.dx < 0 ? rect.minX : rect.maxX)
        const y = along ? (side.dy < 0 ? rect.minY : rect.maxY) : step
        const line = [1, 2].map((distance) => ({ x: x + side.dx * distance, y: y + side.dy * distance }))
        const others = [...rooms.values()].filter((other) => other !== rect)
        const clear = line.every((cell) => inside(cell.x, cell.y) && !taken[at(cell.x, cell.y)]
          && others.every((other) => !nearRect(other, cell.x, cell.y)))
        if (clear && free(x + side.dx * 3, y + side.dy * 3)) found.push({ x, y, dx: side.dx, dy: side.dy, open: side.open })
      }
    }
    return found
  }

  /**
   * Ход между двумя размещёнными камерами: поиск в ширину по свободной
   * породе от третьих клеток устьев одной камеры до третьих клеток другой.
   * @param {LeafRect} fromRect
   * @param {LeafRect} toRect
   * @param {import('./scene-graph.mjs').SceneLink} link
   * @returns {ChamberPassage|null}
   */
  const route = (fromRect, toRect, link) => {
    // Дверь связи — в устье дальней камеры; если там устье не встаёт, — в
    // устье ближней. Открытой связи двери не нужно, и оба устья открытые.
    const options = link.kind === 'open'
      ? [{ door: '', fromOpen: true, toOpen: true }]
      : [{ door: 'to', fromOpen: true, toOpen: false }, { door: 'from', fromOpen: false, toOpen: true }]
    for (const option of options) {
      const sources = shuffle(mouthsOf(fromRect, option.fromOpen), random)
      const targets = mouthsOf(toRect, option.toOpen)
      if (!sources.length || !targets.length) continue
      /** @type {Map<number, typeof targets[number]>} */
      const targetAt = new Map(targets.map((mouth) => [at(mouth.x + mouth.dx * 3, mouth.y + mouth.dy * 3), mouth]))
      /** @type {Map<number, number>} */
      const parent = new Map()
      /** @type {Map<number, typeof sources[number]>} */
      const sourceAt = new Map()
      /** @type {number[]} */
      const queue = []
      for (const mouth of sources) {
        const start = at(mouth.x + mouth.dx * 3, mouth.y + mouth.dy * 3)
        if (parent.has(start)) continue
        parent.set(start, -1)
        sourceAt.set(start, mouth)
        queue.push(start)
      }
      const directions = shuffle([[1, 0], [-1, 0], [0, 1], [0, -1]], random)
      let reached = -1
      for (let head = 0; head < queue.length && reached < 0; head += 1) {
        const current = queue[head]
        if (targetAt.has(current)) { reached = current; break }
        const x = current % width
        const y = Math.floor(current / width)
        for (const [dx, dy] of directions) {
          const next = at(x + dx, y + dy)
          if (parent.has(next) || !free(x + dx, y + dy)) continue
          parent.set(next, current)
          queue.push(next)
        }
      }
      if (reached < 0) continue
      /** @type {number[]} */
      const middle = []
      for (let cursor = reached; cursor >= 0; cursor = parent.get(cursor) ?? -1) middle.unshift(cursor)
      const source = /** @type {typeof sources[number]} */ (sourceAt.get(middle[0]))
      const target = /** @type {typeof targets[number]} */ (targetAt.get(reached))
      const cells = [
        ...[1, 2].map((distance) => ({ x: source.x + source.dx * distance, y: source.y + source.dy * distance })),
        ...middle.map((cell) => ({ x: cell % width, y: Math.floor(cell / width) })),
        ...[2, 1].map((distance) => ({ x: target.x + target.dx * distance, y: target.y + target.dy * distance })),
      ]
      return {
        link,
        cells,
        mouths: [
          { x: source.x, y: source.y, door: option.door === 'from' },
          { x: target.x, y: target.y, door: option.door === 'to' },
        ],
      }
    }
    return null
  }

  /**
   * Камера вплотную к соседней: между ними одна клетка породы и общий отрезок
   * стены. Такую стену потом прорубает петля (`addShortcutLoops` в
   * `server/scene-themes.mjs`) — лаз в три клетки вместо обхода ходом.
   * @param {LeafRect} rect
   */
  const snug = (rect) => [...rooms.values()].some((other) => {
    if (gap(rect, other) !== 1 || minimumGap(rect, other) > 1) return false
    const rows = Math.min(rect.maxY, other.maxY) - Math.max(rect.minY, other.minY) - 1
    const columns = Math.min(rect.maxX, other.maxX) - Math.max(rect.minX, other.minX) - 1
    return rows >= 1 || columns >= 1
  })
  /** Клетки хода заняты, их соседи закрыты для следующего хода. @param {ChamberPassage} passage */
  const occupy = (passage) => {
    for (const cell of passage.cells) {
      taken[at(cell.x, cell.y)] = 1
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (inside(cell.x + dx, cell.y + dy) && !taken[at(cell.x + dx, cell.y + dy)]) taken[at(cell.x + dx, cell.y + dy)] = 2
      }
    }
  }
  for (const zoneId of order) {
    const zone = graph.zones.find((entry) => entry.id === zoneId)
    if (!zone) return null
    const links = graph.links.filter((link) => (link.from === zoneId && rooms.has(link.to)) || (link.to === zoneId && rooms.has(link.from)))
    const anchor = links.length ? rooms.get(links[0].from === zoneId ? links[0].to : links[0].from) : null
    const target = 1 + Math.floor(random() * farthest)
    // Половина камер ложится вплотную к уже стоящей: склеп получает петли.
    const preferSnug = random() < 0.5
    /** @type {Array<{rect: LeafRect, score: number}>} */
    const candidates = []
    for (const [w, h] of chamberSizes(zone, graph.goalZoneId)) {
      for (let y = 1; y + h - 1 <= height - 2; y += 1) {
        for (let x = 1; x + w - 1 <= width - 2; x += 1) {
          const rect = { minX: x, minY: y, maxX: x + w - 1, maxY: y + h - 1 }
          if ([...rooms.values()].some((other) => gap(rect, other) < minimumGap(rect, other))) continue
          if (anchor && gap(rect, anchor) > farthest) continue
          if (touchesPassage(rect, taken, width, height)) continue
          const closeness = anchor ? Math.abs(gap(rect, anchor) - target) : 0
          candidates.push({ rect, score: closeness + random() * 2 - (preferSnug && snug(rect) ? 6 : 0) })
        }
      }
    }
    candidates.sort((left, right) => left.score - right.score)
    let placed = false
    for (const { rect } of candidates.slice(0, 80)) {
      const saved = taken.slice()
      rooms.set(zoneId, rect)
      /** @type {ChamberPassage[]} */
      const routed = []
      for (const link of links) {
        const other = /** @type {LeafRect} */ (rooms.get(link.from === zoneId ? link.to : link.from))
        const passage = link.from === zoneId ? route(rect, other, link) : route(other, rect, link)
        if (!passage) break
        routed.push(passage)
        occupy(passage)
      }
      if (routed.length === links.length) {
        passages.push(...routed)
        placed = true
        break
      }
      rooms.delete(zoneId)
      taken = saved
    }
    if (!placed) return null
  }

  // Обходной ход от входа к дальней камере, не связанной со входом напрямую:
  // в склепе появляется петля (Жакейс), отряд выбирает путь, а бой не идёт
  // одной ниткой. За запертую связь обход ведёт той же запертой дверью на тот
  // же ключ — иначе замок терял бы смысл. Не проложился — склеп без обхода.
  for (const bypass of bypassLinks(graph)) {
    const passage = route(/** @type {LeafRect} */ (rooms.get(bypass.from)), /** @type {LeafRect} */ (rooms.get(bypass.to)), bypass)
    if (!passage) continue
    passages.push(passage)
    occupy(passage)
    break
  }
  return { rooms, passages }
}

/**
 * Возможные связи обходного хода — от входа к зоне, со входом не связанной,
 * лучшие первыми. Зона, достижимая без замков, получает обычную дверь; зона
 * за единственной запертой связью — запертую дверь на ключ этой связи;
 * остальные не годятся.
 *
 * Лучше та зона, до которой больше дверей: открытый проём сливает две камеры
 * в одно помещение, и обход к соседу по проёму — лишь вторая дверь между
 * теми же двумя помещениями, а не петля.
 *
 * @param {import('./scene-graph.mjs').SceneGraph} graph
 * @returns {import('./scene-graph.mjs').SceneLink[]}
 */
function bypassLinks(graph) {
  const entrance = graph.entranceZoneId
  // Сколько дверей от входа до зоны (открытая связь — ноль) и нужен ли замок.
  /** @type {Map<string, {doors: number, locked: boolean}>} */
  const reach = new Map([[entrance, { doors: 0, locked: false }]])
  for (let grown = true; grown;) {
    grown = false
    for (const link of graph.links) {
      for (const [a, b] of [[link.from, link.to], [link.to, link.from]]) {
        const from = reach.get(a)
        if (!from) continue
        const next = { doors: from.doors + (link.kind === 'open' ? 0 : 1), locked: from.locked || link.kind === 'locked' }
        const known = reach.get(b)
        // Лучше путь без замка, при равенстве — с меньшим числом дверей.
        if (known && (known.locked < next.locked || (known.locked === next.locked && known.doors <= next.doors))) continue
        reach.set(b, next)
        grown = true
      }
    }
  }
  /** @type {Array<{link: import('./scene-graph.mjs').SceneLink, doors: number}>} */
  const found = []
  for (const zone of graph.zones) {
    const way = reach.get(zone.id)
    if (!way || zone.id === entrance || way.doors < 1) continue
    if (graph.links.some((link) => (link.from === entrance && link.to === zone.id) || (link.to === entrance && link.from === zone.id))) continue
    const base = { id: `bypass-${zone.id}`, from: entrance, to: zone.id, bidirectional: true }
    if (!way.locked) {
      found.push({ link: { ...base, kind: 'door', keyId: null }, doors: way.doors })
      continue
    }
    // Цель за единственной запертой связью: обход — та же дверь на тот же ключ.
    const touching = graph.links.filter((link) => link.from === zone.id || link.to === zone.id)
    const lock = touching.length === 1 && touching[0].kind === 'locked' && touching[0].to === zone.id ? touching[0] : null
    if (lock?.keyId) found.push({ link: { ...base, kind: 'locked', keyId: lock.keyId }, doors: way.doors })
  }
  return found
    .sort((left, right) => right.doors - left.doors || Number(left.link.kind === 'locked') - Number(right.link.kind === 'locked') || left.link.id.localeCompare(right.link.id))
    .map((entry) => entry.link)
}

/**
 * Лежит ли клетка хода ближе трёх клеток по прямой к будущей камере.
 *
 * @param {LeafRect} rect
 * @param {Uint8Array} taken
 * @param {number} width
 * @param {number} height
 */
function touchesPassage(rect, taken, width, height) {
  for (let y = Math.max(0, rect.minY - 2); y <= Math.min(height - 1, rect.maxY + 2); y += 1) {
    for (let x = Math.max(0, rect.minX - 2); x <= Math.min(width - 1, rect.maxX + 2); x += 1) {
      const straight = (x >= rect.minX && x <= rect.maxX) || (y >= rect.minY && y <= rect.maxY)
      if (straight && taken[y * width + x] === 1) return true
    }
  }
  return false
}

/**
 * Перемешивание Фишера — Йетса на детерминированном генераторе.
 *
 * @template T
 * @param {T[]} items
 * @param {() => number} random
 * @returns {T[]}
 */
function shuffle(items, random) {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    ;[result[index], result[swap]] = [result[swap], result[index]]
  }
  return result
}

/**
 * @typedef {object} GraphLayoutResult
 * @property {import('./tactical-map.mjs').TacticalMap} map
 * @property {Map<string, LeafRect>} rooms
 * @property {string[]} warnings
 */

/**
 * Собирает карту по графу зон.
 *
 * @param {import('./scene-graph.mjs').SceneGraph} graph
 * @param {object} [options]
 * @param {string} [options.seed]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {string} [options.locationId]
 * @param {string} [options.theme]
 * @param {string} [options.material] материал пола помещений
 * @returns {GraphLayoutResult}
 */
export function layoutSceneGraph(graph, {
  seed = 'graph',
  width = 26,
  height = 26,
  locationId = '',
  theme = 'dungeon',
  material = 'stone',
} = {}) {
  const safeWidth = Math.max(12, Math.min(SIZE_CLASSES.area.maxWidth, Math.round(width)))
  const safeHeight = Math.max(12, Math.min(SIZE_CLASSES.area.maxHeight, Math.round(height)))
  const random = randomFor(`${SPLIT_RANDOM_SALT}:${seed}`)
  /** @type {string[]} */
  const warnings = []

  const map = createTacticalMap({
    width: safeWidth,
    height: safeHeight,
    locationId,
    seed: String(seed),
    generator: { ...GRAPH_LAYOUT },
    theme,
    sizeClass: safeWidth * safeHeight <= SIZE_CLASSES.arena.maxCells ? 'arena' : 'area',
  })
  for (const [zoneIndex, zone] of graph.zones.entries()) {
    addZone(map, {
      id: zone.id,
      kind: zone.kind === 'exterior' ? 'exterior' : 'interior',
      material: zone.kind === 'exterior' ? 'grass' : material,
      lightLevel: zone.kind === 'exterior' ? 'bright' : 'dim',
      floorDirection: zoneIndex % 2 === 0 ? 'horizontal' : 'vertical',
      label: zone.label || zone.id,
    })
  }
  addZone(map, { id: 'rock', kind: 'interior', material, lightLevel: 'dark', floorDirection: 'horizontal', label: '' })

  // Всё, что не помещение, — сплошная порода: карта заведомо непроходима, и
  // проходимость появляется только внутри комнат.
  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      setCell(map, x, y, { passable: false, material, zone: 'rock', variant: floorVariantAt(seed, x, y), revealed: false })
    }
  }

  // Склеп — камеры в скале и ходы между ними. Если камеры не уместились
  // (карту заказали слишком тесной), склеп строится прежним разбиением:
  // лучше просторный склеп, чем склеп без помещения.
  const planned = theme === 'crypt'
    ? planChambers(graph, safeWidth, safeHeight, randomFor(`${GRAPH_LAYOUT.id}:${GRAPH_LAYOUT.version}:${seed}`))
    : null
  /** @type {Map<string, LeafRect>} */
  let rooms
  if (planned) {
    rooms = planned.rooms
  } else {
    const leaves = splitArea({ minX: 0, minY: 0, maxX: safeWidth - 1, maxY: safeHeight - 1 }, graph.zones.length, random)
    if (leaves.length < graph.zones.length) {
      warnings.push(`карта вмещает ${leaves.length} помещений, а зон ${graph.zones.length}`)
    }
    rooms = assignZonesToLeaves(graph, leaves)
  }

  for (const [zoneId, rect] of rooms) {
    const zone = graph.zones.find((entry) => entry.id === zoneId)
    for (let y = rect.minY + 1; y <= rect.maxY - 1; y += 1) {
      for (let x = rect.minX + 1; x <= rect.maxX - 1; x += 1) {
        setCell(map, x, y, {
          passable: true,
          material: zone?.kind === 'exterior' ? 'grass' : material,
          zone: zoneId,
          variant: floorVariantAt(seed, x, y),
        })
      }
    }
  }
  // Ходы склепа — клетки без зоны: обстановка их не занимает, а стены по
  // бокам — те же рёбра в породу, что и у камер.
  for (const passage of planned?.passages ?? []) {
    for (const cell of passage.cells) {
      setCell(map, cell.x, cell.y, { passable: true, material, zone: '', variant: floorVariantAt(seed, cell.x, cell.y) })
    }
  }

  // Стены на рёбрах: граница между проходимой клеткой и породой.
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

  // Связи графа становятся проёмами. Без этого проверенная стадией 1
  // достижимость не доживает до геометрии.
  for (const passage of planned?.passages ?? []) {
    // У хода два устья; дверь связи — на одном из них, второе — открытый проём.
    for (const mouth of passage.mouths) {
      carveDoorway(map, mouth.x, mouth.y, mouth.door ? passage.link : { ...passage.link, kind: 'open' }, material)
    }
  }
  // Связь без хода — проём в общей стене смежных помещений.
  const routed = new Set((planned?.passages ?? []).map((passage) => passage.link.id))
  for (const link of graph.links.filter((entry) => !routed.has(entry.id))) {
    const a = rooms.get(link.from)
    const b = rooms.get(link.to)
    if (!a || !b) { warnings.push(`связь ${link.id}: одна из зон не размещена`); continue }
    const wall = sharedWall(a, b)
    if (!wall) { warnings.push(`связь ${link.id}: помещения не смежны, проход не построен`); continue }
    const middle = Math.floor((wall.from + wall.to) / 2)
    const x = wall.axis === 'x' ? wall.at : middle
    const y = wall.axis === 'x' ? middle : wall.at
    carveDoorway(map, x, y, link, material)
  }

  const spawn = rooms.get(graph.entranceZoneId)
  if (spawn) {
    const point = { x: Math.floor((spawn.minX + spawn.maxX) / 2), y: Math.floor((spawn.minY + spawn.maxY) / 2) }
    map.spawnPoints.push({ id: 'party-entrance', x: point.x, y: point.y, role: 'party' })
    // Отряд видит помещение, в которое вошёл.
    for (let y = spawn.minY; y <= spawn.maxY; y += 1) {
      for (let x = spawn.minX; x <= spawn.maxX; x += 1) if (cellAt(map, x, y)) setCell(map, x, y, { revealed: true })
    }
  } else {
    warnings.push('зона входа не размещена, точки появления нет')
  }

  map.overlays = {
    compass: true,
    scaleBar: true,
    roomLabels: graph.zones.filter((zone) => zone.label).map((zone) => ({ zoneId: zone.id, label: zone.label })),
  }
  return { map, rooms, warnings }
}

/**
 * Прорубает проём в стене между двумя помещениями и ставит на него дверь по
 * виду связи. Открытая связь остаётся просто проходом.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {number} x
 * @param {number} y
 * @param {import('./scene-graph.mjs').SceneLink} link
 * @param {string} material
 */
function carveDoorway(map, x, y, link, material) {
  if (!cellAt(map, x, y)) return
  setCell(map, x, y, { passable: true, material, zone: '' })
  // Рёбра-стены вокруг проёма были построены, пока он был породой. Проём
  // обязан их снять, иначе клетка станет проходимой, но окружённой стенами.
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const neighbor = cellAt(map, x + dx, y + dy)
    if (!neighbor || !neighbor.passable) continue
    setEdge(map, x, y, x + dx, y + dy, { kind: 'none' })
  }
  if (link.kind === 'open') return

  // Ребро выбирается поперёк прохода. Прежде направление угадывалось условием
  // «восток проходим, а юг нет», и на вертикальном проходе дверь садилась на
  // глухое ребро в породу: полотно было, а перекрывать ему было нечего.
  const edge = doorwayEdgeAt(map, x, y)
  if (!edge) return
  setDoor(map, {
    id: `door-${link.id}`,
    x: edge.x,
    y: edge.y,
    dir: edge.dir,
    // Состояние двери — начальное; дальше оно живёт в состоянии сцены.
    state: link.kind === 'locked' ? 'locked' : 'closed',
    lockDc: link.kind === 'locked' ? 15 : 0,
    keyItemId: link.keyId,
    // Признаки стены — про сам проём: он открыт. Перекрывает проход полотно
    // двери, и спрашивают о нём отдельно (`doorBlocksStep`).
    blocksMove: false,
    blocksSight: false,
  })
}

/**
 * Собирает карту и проверяет, что геометрия не потеряла топологию: каждая
 * зона, достижимая на графе, обязана быть достижима и по клеткам.
 *
 * @param {import('./scene-graph.mjs').SceneGraph} graph
 * @param {object} [options]
 * @returns {{map: import('./tactical-map.mjs').TacticalMap, warnings: string[], errors: Array<{code: string, message: string, at?: string}>}}
 */
export function buildSceneFromGraph(graph, options = {}) {
  const graphReport = validateSceneGraph(graph)
  if (!graphReport.ok) {
    return { map: layoutSceneGraph(graph, options).map, warnings: [], errors: graphReport.errors }
  }
  const built = layoutSceneGraph(graph, options)
  const errors = [...validateTacticalMap(built.map).errors]

  const spawn = built.map.spawnPoints.find((point) => point.role === 'party')
  if (!spawn) errors.push({ code: 'SPAWN_POINT_MISSING', message: 'Точка появления отряда не построена' })
  else {
    // Двери, запертые по построению, при обходе не открываются — поэтому
    // достижимость по клеткам сравнивается с достижимостью по графу, где ключи
    // уже учтены.
    const reachedCells = reachableCells(built.map, spawn.x, spawn.y, { throughDoors: true })
    const reachedZones = reachableZones(graph).zones
    for (const zoneId of reachedZones) {
      const rect = built.rooms.get(zoneId)
      if (!rect) continue
      let found = false
      for (let y = rect.minY + 1; y <= rect.maxY - 1 && !found; y += 1) {
        for (let x = rect.minX + 1; x <= rect.maxX - 1 && !found; x += 1) {
          if (reachedCells.has(`${x},${y}`)) found = true
        }
      }
      if (!found) {
        errors.push({
          code: 'GEOMETRY_LOST_TOPOLOGY',
          message: `Зона ${zoneId} достижима на графе, но не по клеткам`,
          at: zoneId,
        })
      }
    }
  }
  return { map: built.map, warnings: built.warnings, errors }
}

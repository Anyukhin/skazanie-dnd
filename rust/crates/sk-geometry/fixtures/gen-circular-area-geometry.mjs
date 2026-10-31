// Эталон `server/circular-area-geometry.mjs` для Rust-переноса
// (`rust/crates/sk-geometry/src/circular_area_geometry.rs`).
//
// Запуск из корня репозитория:
//   node rust/crates/sk-geometry/fixtures/gen-circular-area-geometry.mjs
// Пишет `circular-area-geometry.json` рядом со скриптом. Входы — случайные с
// фиксированным сидом (mulberry32), поэтому эталон воспроизводим.
//
// Формат: входы — JSON-значения, которые JS получает как есть (Rust приводит их
// `Number()`); `{"$u":1}` — `undefined`. Дробные результаты записаны строкой
// `String(x)`: так Rust разбирает их без потери точности. Растр сверяется по
// числу клеток и sha256 строки `x,y;x,y;…`, короткий — ещё и целиком. Для
// line-of-effect записан журнал вызовов коллбэков (sha256 и длина): порядок
// обращений к карте тоже часть поведения.

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CIRCULAR_AREA_GEOMETRY_VERSION,
  circularAreaCells,
  circularAreaLineOfEffect,
  circularCellCoverage,
  circularCellCovered,
  gridOriginForTargetCell,
} from '../../../../server/circular-area-geometry.mjs'

const UNDEFINED = Object.freeze({ $u: 1 })
const here = dirname(fileURLToPath(import.meta.url))

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = mulberry32(0x5eed2026)
const int = (min, max) => min + Math.floor(random() * (max - min + 1))
const pick = (list) => list[Math.floor(random() * list.length)]
// Дробное с короткой записью: такое число одинаково читают JS и serde_json.
const fraction = (min, max, step = 1 / 16) => min + Math.round((random() * (max - min)) / step) * step
const sha = (text) => createHash('sha256').update(text).digest('hex')
const raw = (value) => value === undefined ? UNDEFINED : value

function numberLike() {
  return pick([
    () => int(-20, 20),
    () => fraction(-20, 20),
    () => String(int(-9, 9)),
    () => `${fraction(-5, 5)}`,
    () => null,
    () => undefined,
    () => 'NaN',
    () => 'Infinity',
    () => '-Infinity',
    () => 'abc',
    () => true,
    () => [int(-5, 5)],
    () => ({}),
  ])()
}

// --- Покрытие клетки ---------------------------------------------------------
const coverage = []
const radii = [0.5, 1, 1.5, 2, 2.5, 3, 4, 6, 7.5, 12, 0.75, 1.25, 5.5]
for (let index = 0; index < 1600; index += 1) {
  const radius = index < 1400 ? pick([...radii, fraction(0, 14, 1 / 8)]) : numberLike()
  const reach = typeof radius === 'number' ? Math.ceil(Math.abs(radius)) + 1 : 4
  const cell = index % 13 === 0
    ? { x: numberLike(), y: numberLike() }
    : index % 5 === 0
      ? { x: fraction(-reach, reach, 1 / 4), y: fraction(-reach, reach, 1 / 4) }
      : { x: int(-reach, reach), y: int(-reach, reach) }
  const cellInput = index % 97 === 0 ? pick([null, 'клетка', [1, 2], UNDEFINED]) : cell
  const jsCell = cellInput === UNDEFINED ? undefined : cellInput
  const value = circularCellCoverage(jsCell, radius === UNDEFINED ? undefined : radius)
  coverage.push({
    cell: raw(cellInput),
    radius: raw(radius),
    coverage: String(value),
    covered: circularCellCovered(jsCell, radius),
  })
}

// --- Начало круга от целевой клетки --------------------------------------------
const origins = []
for (let index = 0; index < 300; index += 1) {
  const target = index % 10 === 0
    ? pick([null, UNDEFINED, 'x', { x: 2_000_000, y: -3_000_000.5 }, { x: -0.5, y: 0.5 }])
    : { x: numberLike(), y: numberLike() }
  const jsTarget = target === UNDEFINED ? undefined : target
  origins.push({ target, origin: gridOriginForTargetCell(jsTarget) })
}

// --- Растр области ---------------------------------------------------------------
function rasterKey(cells) {
  return cells.map((cell) => `${cell.x},${cell.y}`).join(';')
}

const areas = []
const feetChoices = [5, 10, 15, 20, 25, 30, 35, 40, 7.5, 12.5, 2.5, 17.5, 22.5]
for (let index = 0; index < 420; index += 1) {
  const options = {}
  const originKind = random()
  if (originKind < 0.7) options.origin = { x: int(-30, 30), y: int(-30, 30) }
  else if (originKind < 0.85) options.origin = { x: fraction(-10, 10, 1 / 8), y: fraction(-10, 10, 1 / 8) }
  else if (originKind < 0.95) options.origin = { x: numberLike(), y: numberLike() }
  else options.origin = pick([null, 'начало', [1, 2], { x: 1_000_001, y: 0 }, { x: -1_000_000, y: 1_000_000 }])
  options.radiusFeet = random() < 0.85 ? pick([...feetChoices, fraction(0, 45, 1 / 4)]) : numberLike()
  const cellFeetKind = random()
  if (cellFeetKind < 0.6) { /* по умолчанию */ } else if (cellFeetKind < 0.8) options.cellFeet = pick([5, 10, 2.5, 7.5])
  else options.cellFeet = numberLike()
  const boundsKind = random()
  if (boundsKind < 0.2) {
    const base = options.origin && typeof options.origin === 'object' ? Number(options.origin.x) || 0 : 0
    const minX = base - int(-2, 8)
    const minY = base - int(-2, 8)
    options.bounds = { minX, minY, maxX: minX + int(-1, 12), maxY: minY + int(-1, 12) }
  } else if (boundsKind < 0.27) {
    options.bounds = { minX: fraction(-8, 0, 1 / 4), minY: fraction(-8, 0, 1 / 4), maxX: fraction(0, 8, 1 / 4), maxY: fraction(0, 8, 1 / 4) }
  } else if (boundsKind < 0.32) {
    options.bounds = pick([null, 0, 'границы', { minX: 1 }, { minX: 'a', minY: 0, maxX: 1, maxY: 1 }, []])
  }
  const input = index % 61 === 0 ? pick([null, 'опции', 5, []]) : options
  const cells = circularAreaCells(input)
  areas.push({
    options: input,
    count: cells.length,
    hash: sha(rasterKey(cells)),
    ...(cells.length <= 150 ? { cells: cells.flatMap((cell) => [cell.x, cell.y]) } : {}),
  })
}
// Большой радиус: 600 футов ограничивается 128 клетками.
for (const options of [
  { origin: { x: 300, y: 300 }, radiusFeet: 600 },
  { origin: { x: 0, y: 0 }, radiusFeet: 10 ** 12 },
  { origin: { x: 12, y: -7 }, radiusFeet: 37.5 },
]) {
  const cells = circularAreaCells(options)
  areas.push({ options, count: cells.length, hash: sha(rasterKey(cells)) })
}

// --- Line-of-effect ---------------------------------------------------------------
const edgeKey = (from, to) => [`${from.x},${from.y}`, `${to.x},${to.y}`].sort().join('|')
const lines = []
for (let index = 0; index < 900; index += 1) {
  const origin = { x: int(-6, 26), y: int(-6, 26) }
  const radiusFeet = random() < 0.9 ? pick([5, 10, 10, 15, 15, 20, 20, 30, 40, 60, 12.5, 7.5]) : numberLike()
  const reach = typeof radiusFeet === 'number' ? Math.ceil(Math.abs(radiusFeet) / 5) + 2 : 5
  const inner = Math.max(1, reach - 2)
  let target = random() < 0.75
    ? { x: origin.x + int(-inner, inner - 1), y: origin.y + int(-inner, inner - 1) }
    : { x: origin.x + int(-reach, reach), y: origin.y + int(-reach, reach) }
  if (index % 37 === 0) target = pick([{ x: origin.x + 0.5, y: origin.y }, { x: 'Infinity', y: 1 }, null, { x: 1_000_001, y: 0 }, { x: String(origin.x + 1), y: origin.y }])
  const spreadsAroundCorners = random() < 0.4 ? true : pick([false, false, 'true', 1, UNDEFINED])
  const span = reach + 1
  const cellDensity = pick([0, 0.02, 0.05, 0.1, 0.2])
  const edgeDensity = pick([0, 0.02, 0.05, 0.1])
  const closedCells = []
  const blockedEdges = []
  for (let y = origin.y - span; y <= origin.y + span; y += 1) {
    for (let x = origin.x - span; x <= origin.x + span; x += 1) {
      if (random() < cellDensity && !(x === origin.x && y === origin.y && random() < 0.7)) closedCells.push(x, y)
      if (random() < edgeDensity) blockedEdges.push(x, y, x + 1, y)
      if (random() < edgeDensity) blockedEdges.push(x, y, x, y + 1)
    }
  }
  const callbacks = pick(['both', 'both', 'both', 'open', 'edge', 'none'])
  const closed = new Set()
  for (let i = 0; i < closedCells.length; i += 2) closed.add(`${closedCells[i]},${closedCells[i + 1]}`)
  const blocked = new Set()
  for (let i = 0; i < blockedEdges.length; i += 4) {
    blocked.add(edgeKey({ x: blockedEdges[i], y: blockedEdges[i + 1] }, { x: blockedEdges[i + 2], y: blockedEdges[i + 3] }))
  }
  const log = []
  const options = { radiusFeet }
  if (spreadsAroundCorners !== UNDEFINED) options.spreadsAroundCorners = spreadsAroundCorners
  if (callbacks === 'both' || callbacks === 'open') {
    options.isOpenCell = (cell) => {
      log.push(`o:${cell.x},${cell.y}`)
      return !closed.has(`${cell.x},${cell.y}`)
    }
  }
  if (callbacks === 'both' || callbacks === 'edge') {
    options.isBlockedEdge = (from, to) => {
      log.push(`e:${from.x},${from.y}>${to.x},${to.y}`)
      return blocked.has(edgeKey(from, to))
    }
  }
  const result = circularAreaLineOfEffect(origin, target, options)
  lines.push({
    origin,
    target,
    radiusFeet: raw(radiusFeet),
    spreadsAroundCorners: raw(spreadsAroundCorners),
    callbacks,
    closedCells,
    blockedEdges,
    result,
    calls: log.length,
    log: sha(log.join('|')),
  })
}

const fixture = {
  version: CIRCULAR_AREA_GEOMETRY_VERSION,
  coverage,
  origins,
  areas,
  lines,
}
const target = join(here, 'circular-area-geometry.json')
writeFileSync(target, `${JSON.stringify(fixture)}\n`)
console.log(`circular-area-geometry: ${coverage.length} покрытий, ${origins.length} начал, ${areas.length} растров, ${lines.length} линий → ${target}`)

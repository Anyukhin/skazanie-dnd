// Эталон `server/actor-footprint.mjs` для Rust-переноса
// (`rust/crates/sk-geometry/src/actor_footprint.rs`).
//
// Запуск из корня репозитория:
//   node rust/crates/sk-geometry/fixtures/gen-actor-footprint.mjs
// Пишет `actor-footprint.json` рядом со скриптом. Входы — случайные с
// фиксированным сидом (mulberry32) плюс ручной список размеров; `{"$u":1}` —
// `undefined`.

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ACTOR_FOOTPRINT_VERSION,
  ACTOR_SIZE_SIDES,
  footprintCellsFor,
  footprintDistanceFeet,
  footprintMetadataForSize,
  footprintOverlap,
  footprintSizeFor,
  normalizeFootprintMetadata,
} from '../../../../server/actor-footprint.mjs'

const UNDEFINED = Object.freeze({ $u: 1 })
const here = dirname(fileURLToPath(import.meta.url))
const js = (value) => value === UNDEFINED ? undefined : value

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

const random = mulberry32(0xf007f1)
const int = (min, max) => min + Math.floor(random() * (max - min + 1))
const pick = (list) => list[Math.floor(random() * list.length)]

const SIZES = [
  'tiny', 'small', 'medium', 'large', 'huge', 'gargantuan',
  'Tiny', 'LARGE', ' huge ', '\tgargantuan\n', 'большой', 'Огромный', 'ГРОМАДНЫЙ', ' большой ',
  'крошечный', 'средний', 'Large creature', 'larg', '', '   ', ' large', '﻿huge', '　large　',
  '\u0085large', 'large\u0085', '2', ' 3 ', '4.0', '1e0', '0x2', '0b11', '5', '0', '-1', '2.5', 'Infinity',
  0, 1, 2, 3, 4, 5, -2, 2.5, 4.0, 1e0, null, UNDEFINED, true, false, [], [3], ['large'], [2, 3], {}, { size: 'large' },
]

const metadataForSize = SIZES.map((size) => ({ size, expected: footprintMetadataForSize(js(size)) }))

function numberish() {
  return pick([1, 2, 3, 4, 0, 5, -1, 2.5, '2', ' 3 ', '4.0', 'large', null, UNDEFINED, true, [2], [], {}, 'x', 1.0])
}

function footprintValue() {
  const kind = random()
  if (kind < 0.55) return { version: 1, size: int(1, 4) }
  if (kind < 0.85) {
    const value = {}
    const version = numberish()
    const size = numberish()
    if (version !== UNDEFINED) value.version = pick([version, 1, '1', 1.0])
    if (size !== UNDEFINED) value.size = size
    return value
  }
  return pick([null, 'large', 2, [1, 2], true, { version: 1 }, { size: 2 }])
}

const normalizeCases = []
for (let index = 0; index < 300; index += 1) {
  const value = index % 25 === 0 ? UNDEFINED : footprintValue()
  normalizeCases.push({ value, expected: normalizeFootprintMetadata(js(value)) })
}

function coordinate() {
  const kind = random()
  if (kind < 0.75) return int(-6, 12)
  return pick([1.5, '3', ' 4 ', null, UNDEFINED, 'abc', true, [5], -0, 9007199254740991, 9007199254740990, 'Infinity', 1e21])
}

function position() {
  const kind = random()
  if (kind < 0.85) {
    const value = {}
    const x = coordinate()
    const y = coordinate()
    if (x !== UNDEFINED) value.x = x
    if (y !== UNDEFINED) value.y = y
    return value
  }
  return pick([null, UNDEFINED, 'позиция', 7, [1, 2]])
}

function actor() {
  const kind = random()
  if (kind < 0.8) {
    const value = { id: `actor-${int(1, 99)}` }
    if (random() < 0.85) value.footprint = footprintValue()
    if (random() < 0.3) value.size = pick(['large', 'huge', 'medium'])
    const at = position()
    if (at && typeof at === 'object' && !Array.isArray(at)) Object.assign(value, at)
    return value
  }
  return pick([null, UNDEFINED, 'актёр', 3, [1, 2]])
}

const sizeCases = []
for (let index = 0; index < 300; index += 1) {
  const value = actor()
  sizeCases.push({ actor: value, expected: footprintSizeFor(js(value)) })
}

const cellsCases = []
for (let index = 0; index < 600; index += 1) {
  const value = actor()
  const anchor = random() < 0.5 ? UNDEFINED : position()
  cellsCases.push({ actor: value, anchor, expected: footprintCellsFor(js(value), js(anchor)) })
}

function cellList() {
  const cells = []
  for (let index = int(0, 5); index > 0; index -= 1) {
    cells.push(random() < 0.85 ? { x: int(-2, 9), y: int(-2, 9) } : pick([{ x: '2', y: 3 }, { x: 1.5, y: 0 }, null, 'клетка', { x: null, y: 4 }, {}]))
  }
  return cells
}

function geometry() {
  const kind = random()
  if (kind < 0.3) return cellList()
  if (kind < 0.75) return { id: `actor-${int(1, 99)}`, footprint: { version: 1, size: int(1, 4) }, x: int(0, 6), y: int(0, 6) }
  return actor()
}

const pairCases = []
for (let index = 0; index < 900; index += 1) {
  const left = geometry()
  const right = geometry()
  const leftAnchor = random() < 0.5 ? UNDEFINED : position()
  const rightAnchor = random() < 0.5 ? UNDEFINED : position()
  pairCases.push({
    left, right, leftAnchor, rightAnchor,
    distance: footprintDistanceFeet(js(left), js(right), js(leftAnchor), js(rightAnchor)),
    overlap: footprintOverlap(js(left), js(right), js(leftAnchor), js(rightAnchor)),
  })
}

const fixture = {
  version: ACTOR_FOOTPRINT_VERSION,
  sizeSides: Object.entries(ACTOR_SIZE_SIDES),
  metadataForSize,
  normalize: normalizeCases,
  sizeFor: sizeCases,
  cells: cellsCases,
  pairs: pairCases,
}
const target = join(here, 'actor-footprint.json')
writeFileSync(target, `${JSON.stringify(fixture)}\n`)
console.log(`actor-footprint: ${metadataForSize.length + normalizeCases.length + sizeCases.length + cellsCases.length + pairCases.length} случаев → ${target}`)

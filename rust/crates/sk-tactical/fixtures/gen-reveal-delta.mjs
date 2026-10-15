import '../../../fixtures-env.mjs'
// Эталон server/reveal-delta.mjs для Rust:
//
//   node rust/crates/sk-tactical/fixtures/gen-reveal-delta.mjs
//
// Пары состояний одной карты (раскрытие кругом и полосами, скрытие, смена
// материала, варианта и поверхности, клетки-пропуски, карты разного размера),
// дельта между ними, её наложение на прежнюю карту, испорченные дельты,
// пустота и размер дельты, выбор `revealUpdateFor`.
import * as d from '../../../../server/reveal-delta.mjs'
import * as t from '../../../../server/tactical-map.mjs'
import { encode, hash, mulberry32, writeFixture } from './common.mjs'

const random = mulberry32(2026_10_18)
const int = (n) => Math.floor(random() * n)
const pick = (items) => items[int(items.length)]
const chance = (p) => random() < p
const errorOf = (error) => ({ name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) })
const attempt = (fn) => {
  try {
    return { ok: encode(fn()) }
  } catch (error) {
    return { error: errorOf(error) }
  }
}

function randomMap(width, height) {
  const map = t.createTacticalMap({ width, height, seed: `reveal-${width}x${height}`, catalogRevision: null })
  const banded = chance(0.5)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (chance(0.05)) continue
      const material = banded ? (y < height / 2 ? 'grass' : 'earth') : pick(t.MATERIALS)
      t.setCell(map, x, y, { passable: !chance(0.1), revealed: chance(0.2), material, variant: banded ? 0 : int(6), surface: chance(0.05) ? pick(t.SURFACES) : 'none' })
    }
  }
  return map
}

function reveal(map, mode) {
  const cx = int(map.width)
  const cy = int(map.height)
  const radius = 1 + int(Math.max(map.width, map.height))
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (!t.cellAt(map, x, y)) continue
      if (mode === 'circle' && Math.hypot(x - cx, y - cy) <= radius) t.setCell(map, x, y, { revealed: true })
      else if (mode === 'band' && y === cy) t.setCell(map, x, y, { revealed: true })
      else if (mode === 'hide' && chance(0.2)) t.setCell(map, x, y, { revealed: false })
      else if (mode === 'mixed' && chance(0.15)) t.setCell(map, x, y, { revealed: chance(0.5) })
      if (chance(0.05)) t.setCell(map, x, y, { material: pick(t.MATERIALS), variant: int(6), surface: pick(t.SURFACES) })
    }
  }
}

const pairs = []
for (let index = 0; index < 260; index += 1) {
  const width = index === 0 ? 100 : 1 + int(40)
  const height = index === 0 ? 100 : 1 + int(40)
  const before = randomMap(width, height)
  const serializedBefore = t.serializeTacticalMap(before)
  const after = chance(0.04) ? randomMap(width + 1, height) : t.deserializeTacticalMap(serializedBefore)
  if (after.width === width) reveal(after, pick(['circle', 'band', 'hide', 'mixed', 'none']))
  const serializedAfter = t.serializeTacticalMap(after)
  const baseHash = chance(0.9) ? t.tacticalMapHash(before) : ''
  const delta = attempt(() => d.revealDelta(before, after, baseHash))
  let applied = null
  if (delta.ok) {
    applied = attempt(() => {
      const rebuilt = d.applyRevealDelta(t.deserializeTacticalMap(serializedBefore), delta.ok)
      const grid = []
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) grid.push(t.cellAt(rebuilt, x, y))
      return { serialized: hash(t.serializeTacticalMap(rebuilt)), equalsAfter: JSON.stringify(t.serializeTacticalMap(rebuilt)) === JSON.stringify(serializedAfter), cells: hash(grid) }
    })
  }
  pairs.push({
    before: serializedBefore,
    after: serializedAfter,
    baseHash,
    delta,
    empty: delta.ok ? d.revealDeltaEmpty(delta.ok) : null,
    size: delta.ok ? d.revealDeltaSize(delta.ok) : null,
    applied,
  })
}

// --- испорченные дельты -------------------------------------------------------

const bases = pairs.filter((pair) => pair.delta.ok && !pair.empty && pair.before.width <= 20).slice(0, 25)
const corruptions = [
  (delta) => { delta.version = 'skazanie:reveal-delta-v1' },
  (delta) => { delta.width = String(delta.width) },
  (delta) => { delta.width += 1 },
  (delta) => { delta.revealed = [[-1, 2]] },
  (delta) => { delta.revealed = [[0, 100_000]] },
  (delta) => { delta.revealed = ['12'] },
  (delta) => { delta.revealed = [{ 0: 1, 1: 2 }] },
  (delta) => { delta.revealed = [[1.5, 1]] },
  (delta) => { delta.revealed = 'x'; delta.hidden = 5 },
  (delta) => { delta.revealed = [[0, 1], [0, 1]] },
  (delta) => { delete delta.values },
  (delta) => { delta.values = 'x' },
  (delta) => { delta.values = { ...delta.values, material: 200 } },
  (delta) => { delta.values = { ...delta.values, surface: 'AAAAAAAA' } },
  (delta) => { delta.values = { ...delta.values, variant: 1.5 } },
  (delta) => { delta.values = { ...delta.values, material: -1 } },
  (delta) => { delta.values = { ...delta.values, variant: 'не base64' } },
  (delta) => { delta.values = { ...delta.values, surface: null } },
]
const corrupted = []
for (let index = 0; index < 260; index += 1) {
  const base = int(bases.length)
  const delta = JSON.parse(JSON.stringify(bases[base].delta.ok))
  pick(corruptions)(delta)
  if (chance(0.3)) pick(corruptions)(delta)
  const outcome = attempt(() => hash(t.serializeTacticalMap(d.applyRevealDelta(t.deserializeTacticalMap(bases[base].before), delta))))
  corrupted.push({ base: pairs.indexOf(bases[base]), delta, outcome })
}
for (const delta of [null, undefined, 5, 'x', [], {}, { version: d.REVEAL_DELTA_VERSION, width: bases[0].before.width, revealed: [], hidden: [] }]) {
  corrupted.push({ base: pairs.indexOf(bases[0]), delta: encode(delta), outcome: attempt(() => hash(t.serializeTacticalMap(d.applyRevealDelta(t.deserializeTacticalMap(bases[0].before), delta)))) })
}

const emptiness = [null, undefined, 0, '', {}, [], { revealed: [] }, { revealed: [[1, 2]] }, { hidden: 'ab' }, { revealed: 'x', hidden: [] }, { revealed: {}, hidden: 5 }, 'x', 7]
  .map((delta) => [encode(delta), d.revealDeltaEmpty(delta)])
const sizes = [null, undefined, {}, { revealed: [[1, 2], [5, 3]] }, { revealed: [[1, 2]], hidden: [[0, 4]] }, { revealed: [[1]] }, { hidden: [[0, null]] }, { revealed: [[0, true]] }]
  .map((delta) => {
    const size = d.revealDeltaSize(delta)
    return [encode(delta), Number.isNaN(size) ? 'NaN' : size]
  })

// --- revealUpdateFor ------------------------------------------------------------

const updates = []
for (let index = 0; index < 120; index += 1) {
  const pair = pick(pairs.filter((candidate) => candidate.delta.ok))
  const currentHash = pick(['h1', 'h2', ''])
  const clientHash = pick([currentHash, currentHash, 'другой', '', undefined])
  const marker = pick(['before', 'before', 'none', 'null', 'junk', 'first'])
  const clientMap = { before: pair.before, none: undefined, null: null, junk: { width: 'x' }, first: pairs[0].before }[marker]
  const input = { serializedMap: pair.after, currentHash, clientHash, clientMap }
  const result = attempt(() => hash(d.revealUpdateFor(input)))
  updates.push({ pair: pairs.indexOf(pair), currentHash, clientHash: encode(clientHash), clientMap: marker, result })
}

writeFixture(new URL('./reveal-delta.json', import.meta.url), {
  version: d.REVEAL_DELTA_VERSION,
  pairs,
  corrupted,
  emptiness,
  sizes,
  updates,
})

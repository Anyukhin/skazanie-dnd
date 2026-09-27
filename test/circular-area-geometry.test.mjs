import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import test from 'node:test'

import {
  CIRCULAR_AREA_GEOMETRY_VERSION,
  circularAreaCells,
  circularCellCoverage,
  circularCellCovered,
  circularAreaLineOfEffect,
  gridOriginForTargetCell,
} from '../server/circular-area-geometry.mjs'

const keys = (cells) => cells.map((cell) => `${cell.x},${cell.y}`)
const relativeKeys = (cells, origin = { x: 0, y: 0 }) => cells.map((cell) => `${cell.x - origin.x},${cell.y - origin.y}`)
const pointKey = (point) => `${point.x},${point.y}`
const edgeKey = (from, to) => [pointKey(from), pointKey(to)].sort().join('|')
const callbacks = ({ closedCells = [], blockedEdges = [] } = {}) => {
  const closed = new Set(closedCells.map(pointKey))
  const blocked = new Set(blockedEdges.map(([from, to]) => edgeKey(from, to)))
  return {
    isOpenCell: (cell) => !closed.has(pointKey(cell)),
    isBlockedEdge: (from, to) => blocked.has(edgeKey(from, to)),
  }
}

// Независимые эталоны составлены вручную по правилу DMG 2014: origin лежит
// на пересечении, клетка входит при покрытии круга >= 50%.
const EXPECTED = new Map([
  [5, ['##', '##']],
  [10, ['.##.', '####', '####', '.##.']],
  [20, ['..####..', '.######.', '########', '########', '########', '########', '.######.', '..####..']],
  [30, ['....####....', '..########..', '.##########.', '.##########.', '############', '############', '############', '############', '.##########.', '.##########.', '..########..', '....####....']],
])

const cellsFromRows = (rows) => rows.flatMap((row, rowIndex) => (
  [...row].flatMap((mark, column) => mark === '#'
    ? [{ x: column - Math.floor(row.length / 2), y: rowIndex - Math.floor(rows.length / 2) }]
    : [])
))

test('публичная версия геометрии зафиксирована как circle-grid-v2', () => {
  assert.equal(CIRCULAR_AREA_GEOMETRY_VERSION, 'circle-grid-v2')
})

for (const [radiusFeet, rows] of EXPECTED) {
  test(`circle-grid-v2 радиус ${radiusFeet} футов совпадает с независимым растром на ${rows.join('').split('#').length - 1} клеток`, () => {
    const actual = circularAreaCells({ origin: { x: 0, y: 0 }, radiusFeet })
    assert.deepEqual(relativeKeys(actual), keys(cellsFromRows(rows)))
  })
}

test('круг симметричен относительно обеих осей origin-пересечения', () => {
  const cells = circularAreaCells({ origin: { x: 12, y: -7 }, radiusFeet: 37.5 })
  const set = new Set(keys(cells))
  for (const cell of cells) {
    assert.ok(set.has(`${23 - cell.x},${cell.y}`))
    assert.ok(set.has(`${cell.x},${-15 - cell.y}`))
    assert.ok(set.has(`${23 - cell.x},${-15 - cell.y}`))
  }
})

test('площадь проверяет точный порог половины клетки и отбрасывает внешнюю клетку', () => {
  const quadrant = circularCellCoverage({ x: 0, y: 0 }, 1)
  assert.ok(Math.abs(quadrant - Math.PI / 4) < 1e-12)
  assert.equal(circularCellCovered({ x: 0, y: 0 }, 1), true)
  assert.equal(circularCellCovered({ x: 1, y: 0 }, 1), false)
  assert.ok(circularCellCoverage({ x: 1, y: 0 }, 1) < 1e-12)
})

test('сопоставление origin округляет цель вниз и сохраняет растр при переносе', () => {
  assert.deepEqual(gridOriginForTargetCell({ x: 7.9, y: -2.1 }), { x: 7, y: -3 })
  const origin = gridOriginForTargetCell({ x: 7, y: 4 })
  assert.deepEqual(relativeKeys(circularAreaCells({ origin, radiusFeet: 5 }), origin), ['-1,-1', '0,-1', '-1,0', '0,0'])
})

test('границы включаются, дробный радиус остаётся детерминированным', () => {
  const bounded = circularAreaCells({
    origin: { x: 5, y: 6 }, radiusFeet: 7.5,
    bounds: { minX: 4, minY: 5, maxX: 5, maxY: 6 },
  })
  assert.deepEqual(keys(bounded), ['4,5', '5,5', '4,6', '5,6'])
  const unbounded = circularAreaCells({ origin: { x: 5, y: 6 }, radiusFeet: 7.5 })
  assert.equal(unbounded.length, 4)
})

test('ошибочные значения безопасны, а слишком большой радиус ограничен', () => {
  assert.deepEqual(circularAreaCells(null), [])
  assert.deepEqual(circularAreaCells({ origin: { x: 0, y: 0 }, radiusFeet: 0 }), [])
  assert.deepEqual(circularAreaCells({ origin: { x: 0, y: 0 }, radiusFeet: Number.NaN }), [])
  assert.deepEqual(circularAreaCells({ origin: { x: 0, y: 0 }, radiusFeet: Number.POSITIVE_INFINITY }), [])
  assert.deepEqual(circularAreaCells({ origin: { x: Number.POSITIVE_INFINITY, y: 0 }, radiusFeet: 5 }), [])
  assert.deepEqual(circularAreaCells({ origin: { x: 1_000_001, y: 0 }, radiusFeet: 5 }), [])
  assert.deepEqual(circularAreaCells({ origin: { x: 0, y: 0 }, radiusFeet: 10, cellFeet: 0 }), [])
  const cells = circularAreaCells({ origin: { x: 0, y: 0 }, radiusFeet: 10 ** 12 })
  assert.ok(cells.length <= (2 * 128) ** 2)
})

test('растр 600 футов укладывается в ограниченный аналитический проход', () => {
  const started = performance.now()
  const cells = circularAreaCells({ origin: { x: 300, y: 300 }, radiusFeet: 600 })
  const elapsedMs = performance.now() - started
  assert.ok(cells.length > 40_000)
  assert.ok(elapsedMs < 2_000, `600-foot raster took ${elapsedMs.toFixed(1)}ms`)
})

test('прямая LoE идёт дробным лучом до центра целевой клетки', () => {
  const origin = { x: 0, y: 0 }
  const target = { x: 5, y: 2 }
  const blocked = callbacks({ closedCells: [{ x: 2, y: 0 }] })
  assert.equal(circularAreaLineOfEffect(origin, target, { radiusFeet: 60, ...blocked }), false)
  assert.equal(circularAreaLineOfEffect(origin, target, { radiusFeet: 60 }), true)
})

test('прямая LoE останавливается на стене и закрытом дверном ребре', () => {
  const origin = { x: 1, y: 2 }
  const target = { x: 7, y: 2 }
  assert.equal(circularAreaLineOfEffect(origin, target, {
    radiusFeet: 60,
    ...callbacks({ closedCells: [{ x: 4, y: 2 }] }),
  }), false)
  assert.equal(circularAreaLineOfEffect(origin, target, {
    radiusFeet: 60,
    ...callbacks({ blockedEdges: [[{ x: 4, y: 2 }, { x: 5, y: 2 }]] }),
  }), false)
  assert.equal(circularAreaLineOfEffect(origin, target, { radiusFeet: 60 }), true)
})

test('диагональная LoE проверяет обе клетки закрытого угла', () => {
  const origin = { x: 1, y: 1 }
  const target = { x: 5, y: 5 }
  const closedCorner = callbacks({
    blockedEdges: [
      [{ x: 1, y: 1 }, { x: 2, y: 1 }],
      [{ x: 1, y: 1 }, { x: 1, y: 2 }],
    ],
  })
  assert.equal(circularAreaLineOfEffect(origin, target, { radiusFeet: 60, ...closedCorner }), false)
  assert.equal(circularAreaLineOfEffect(origin, target, { radiusFeet: 60 }), true)
})

test('диагональная LoE проверяет все четыре ребра вершины', () => {
  const origin = { x: 1, y: 1 }
  const target = { x: 3, y: 3 }
  const current = { x: 1, y: 1 }
  const sideX = { x: 2, y: 1 }
  const sideY = { x: 1, y: 2 }
  const diagonal = { x: 2, y: 2 }
  const edges = [
    [current, sideX],
    [current, sideY],
    [sideX, diagonal],
    [sideY, diagonal],
  ]
  for (const blockedEdge of edges) {
    assert.equal(circularAreaLineOfEffect(origin, target, {
      radiusFeet: 60,
      ...callbacks({ blockedEdges: [blockedEdge] }),
    }), false, `закрытое ребро ${pointKey(blockedEdge[0])}—${pointKey(blockedEdge[1])} пропустило луч`)
  }
  assert.equal(circularAreaLineOfEffect(origin, target, { radiusFeet: 60 }), true)
})

test('граница начала не выпускает луч из SE через закрытую перегородку', () => {
  const origin = { x: 2, y: 2 }
  const target = { x: 2, y: 1 }
  const closedOriginDoor = callbacks({
    // Одно дверное ребро не объявляется всей стеной: закрываем и боковой
    // обход, чтобы тестировать действительно замкнутую комнату.
    blockedEdges: [
      [origin, target],
      [{ x: 1, y: 2 }, { x: 1, y: 1 }],
    ],
  })
  assert.equal(circularAreaLineOfEffect(origin, target, { radiusFeet: 10, ...closedOriginDoor }), false)
  assert.equal(circularAreaLineOfEffect(origin, origin, { radiusFeet: 10, ...closedOriginDoor }), true)
  assert.equal(circularAreaLineOfEffect(origin, target, { radiusFeet: 10 }), true)
})

test('прямой луч проверяет origin-door, а обход углов использует открытый путь', () => {
  const origin = { x: 2, y: 2 }
  const target = { x: 2, y: 1 }
  const closedOrigin = callbacks({ closedCells: [origin] })
  assert.equal(circularAreaLineOfEffect(origin, target, {
    radiusFeet: 10, ...closedOrigin,
  }), false)
  assert.equal(circularAreaLineOfEffect(origin, target, {
    radiusFeet: 10, spreadsAroundCorners: true, ...closedOrigin,
  }), false)

  const originDoor = callbacks({
    blockedEdges: [[origin, target]],
  })
  assert.equal(circularAreaLineOfEffect(origin, target, {
    radiusFeet: 10, ...originDoor,
  }), false)
  assert.equal(circularAreaLineOfEffect(origin, target, {
    radiusFeet: 10, spreadsAroundCorners: true, ...originDoor,
  }), true)

  const fullBarrier = callbacks({
    blockedEdges: Array.from({ length: 13 }, (_, index) => [
      { x: origin.x + index - 6, y: origin.y },
      { x: origin.x + index - 6, y: origin.y - 1 },
    ]),
  })
  assert.equal(circularAreaLineOfEffect(origin, target, {
    radiusFeet: 10, ...fullBarrier,
  }), false)
  assert.equal(circularAreaLineOfEffect(origin, target, {
    radiusFeet: 10, spreadsAroundCorners: true, ...fullBarrier,
  }), false)
})

test('диагональный луч из origin проверяет четыре ребра начальной вершины', () => {
  const origin = { x: 2, y: 2 }
  const target = { x: 1, y: 1 }
  const sideX = { x: 1, y: 2 }
  const sideY = { x: 2, y: 1 }
  const edges = [
    [origin, sideX],
    [origin, sideY],
    [sideX, target],
    [sideY, target],
  ]
  assert.equal(circularAreaLineOfEffect(origin, target, { radiusFeet: 10 }), true)
  for (const blockedEdge of edges) {
    assert.equal(circularAreaLineOfEffect(origin, target, {
      radiusFeet: 10, ...callbacks({ blockedEdges: [blockedEdge] }),
    }), false, `закрытое origin-ребро ${pointKey(blockedEdge[0])}—${pointKey(blockedEdge[1])} пропустило луч`)
  }
})

test('обход угла обходит стену, а прямая LoE остаётся заблокированной', () => {
  const origin = { x: 1, y: 2 }
  const target = { x: 7, y: 2 }
  const wall = callbacks({ closedCells: [{ x: 4, y: 2 }] })
  assert.equal(circularAreaLineOfEffect(origin, target, { radiusFeet: 60, ...wall }), false)
  assert.equal(circularAreaLineOfEffect(origin, target, {
    radiusFeet: 60, spreadsAroundCorners: true, ...wall,
  }), true)
})

test('обход угла не входит в комнату с полной перегородкой у начала', () => {
  const origin = { x: 2, y: 2 }
  const target = { x: 5, y: 1 }
  const sealed = callbacks({
    // Перегородка продолжается до цели: закрытие только одного края origin
    // не выдаётся за замкнутую комнату, если вокруг него есть путь.
    blockedEdges: Array.from({ length: 13 }, (_, index) => [
      { x: origin.x + index - 6, y: origin.y },
      { x: origin.x + index - 6, y: origin.y - 1 },
    ]),
  })
  assert.equal(circularAreaLineOfEffect(origin, target, {
    radiusFeet: 30, spreadsAroundCorners: true, ...sealed,
  }), false)
})

test('LoE безопасно отклоняет дробные, бесконечные и слишком далёкие координаты', () => {
  const origin = { x: 0, y: 0 }
  assert.equal(circularAreaLineOfEffect(origin, { x: 1.5, y: 1 }, { radiusFeet: 60 }), false)
  assert.equal(circularAreaLineOfEffect(origin, { x: Number.POSITIVE_INFINITY, y: 1 }, { radiusFeet: 60 }), false)
  assert.equal(circularAreaLineOfEffect(origin, { x: 1_000_000, y: 1_000_000 }, { radiusFeet: 600 }), false)
  assert.equal(circularAreaLineOfEffect(origin, { x: 1, y: 1 }, { radiusFeet: Number.NaN }), false)
})

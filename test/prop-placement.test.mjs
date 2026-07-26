import assert from 'node:assert/strict'
import test from 'node:test'

import { placeProps } from '../server/prop-placement.mjs'
import {
  addZone,
  cellAt,
  createTacticalMap,
  serializeTacticalMap,
  setCell,
  setEdge,
  validateTacticalMap,
} from '../server/tactical-map.mjs'

/** Комната с внешним двором: слева здание, справа трава за стеной. */
function tavernWithYard({ width = 16, height = 12 } = {}) {
  const map = createTacticalMap({ width, height, seed: 'tavern' })
  addZone(map, { id: 'hall', kind: 'interior', material: 'wood', label: 'Общий зал' })
  addZone(map, { id: 'yard', kind: 'exterior', material: 'grass', label: 'Участок' })
  const wallColumn = Math.floor(width / 2)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const border = x === 0 || y === 0 || x === width - 1 || y === height - 1
      const inside = x < wallColumn
      setCell(map, x, y, {
        passable: !border && x !== wallColumn,
        material: inside ? 'wood' : 'grass',
        zone: inside ? 'hall' : 'yard',
        revealed: true,
        variant: (x + y) % 6,
      })
    }
  }
  // Стены по рёбрам: внешний контур и перегородка здания.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const own = cellAt(map, x, y)
      if (!own || own.passable) continue
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const neighbor = cellAt(map, x + dx, y + dy)
        if (neighbor?.passable) setEdge(map, x, y, x + dx, y + dy, { kind: 'wall', cover: 'three_quarters' })
      }
    }
  }
  return map
}

const PLAN = [
  { zoneId: 'hall', theme: 'interior', density: 18, require: ['table_round', 'chair', 'bar_counter', 'fireplace'] },
  { zoneId: 'yard', theme: 'yard', density: 10, require: ['tree_oak', 'bush'] },
]

function place(seed = 'seed-1') {
  return placeProps(tavernWithYard(), { seed, zones: PLAN, maxProps: 250 })
}

test('расстановка детерминирована от seed', () => {
  const first = JSON.stringify(serializeTacticalMap(place('same')))
  const second = JSON.stringify(serializeTacticalMap(place('same')))
  assert.equal(first, second)
  assert.notEqual(first, JSON.stringify(serializeTacticalMap(place('other'))))
})

test('расставленная карта проходит структурную валидацию', () => {
  const report = validateTacticalMap(place())
  assert.deepEqual(report.errors, [])
})

test('футпринты не пересекаются и не лезут в стены', () => {
  const map = place()
  const seen = new Set()
  for (const prop of map.props) {
    for (const cell of prop.footprint) {
      const key = `${cell.x},${cell.y}`
      assert.equal(seen.has(key), false, `клетка ${key} занята дважды`)
      seen.add(key)
      assert.equal(cellAt(map, cell.x, cell.y)?.passable, true, `предмет ${prop.id} стоит в стене`)
    }
  }
})

test('деревья и кусты не появляются в интерьере', () => {
  const map = place()
  for (const prop of map.props) {
    if (!prop.assetId.startsWith('tree_') && prop.assetId !== 'bush' && prop.assetId !== 'shrub') continue
    const cell = cellAt(map, Math.floor(prop.x), Math.floor(prop.y))
    assert.equal(cell?.zone, 'yard', `${prop.assetId} оказался в зоне ${cell?.zone}`)
    assert.equal(cell?.material, 'grass')
  }
})

test('мебель зала не выходит во двор', () => {
  const map = place()
  for (const prop of map.props) {
    if (!['bar_counter', 'fireplace', 'table_round', 'chair'].includes(prop.assetId)) continue
    assert.equal(cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone, 'hall',
      `${prop.assetId} оказался вне зала`)
  }
})

test('стулья стоят рядом со столом и повёрнуты к нему', () => {
  const map = place()
  const tables = map.props.filter((prop) => prop.assetId.startsWith('table_') || prop.assetId === 'bar_counter')
  const chairs = map.props.filter((prop) => prop.assetId === 'chair' || prop.assetId === 'stool')
  assert.ok(tables.length > 0, 'на сцене обязан быть стол')
  assert.ok(chairs.length > 0, 'на сцене обязан быть стул')

  for (const chair of chairs) {
    const distance = Math.min(...tables.map((table) => Math.max(
      Math.abs(Math.floor(table.x) - Math.floor(chair.x)),
      Math.abs(Math.floor(table.y) - Math.floor(chair.y)),
    )))
    assert.ok(distance <= 2, `стул ${chair.id} стоит в ${distance} клетках от ближайшего стола`)

    // Поворот обязан указывать в сторону стола: 0 — на юг, 90 — на запад,
    // 180 — на север, 270 — на восток.
    const table = tables.reduce((best, candidate) => {
      const measure = (prop) => Math.max(Math.abs(prop.x - chair.x), Math.abs(prop.y - chair.y))
      return measure(candidate) < measure(best) ? candidate : best
    })
    const dx = Math.floor(table.x) - Math.floor(chair.x)
    const dy = Math.floor(table.y) - Math.floor(chair.y)
    const expected = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 270 : 90) : (dy >= 0 ? 0 : 180)
    assert.equal(chair.rotation, expected, `стул ${chair.id} повёрнут не к столу`)
  }
})

test('предметы с якорем у стены стоят у стены и смотрят внутрь помещения', () => {
  const map = place()
  const anchored = map.props.filter((prop) => ['barrel', 'crate', 'bar_counter', 'fireplace', 'bookshelf'].includes(prop.assetId))
  assert.ok(anchored.length > 0)
  for (const prop of anchored) {
    const x = Math.floor(prop.x)
    const y = Math.floor(prop.y)
    const sides = [[0, -1, 180], [1, 0, 270], [0, 1, 0], [-1, 0, 90]]
    const walls = sides.filter(([dx, dy]) => {
      const neighbor = cellAt(map, x + dx, y + dy)
      return !neighbor || !neighbor.passable
    })
    assert.ok(walls.length > 0, `${prop.id} стоит не у стены`)
    assert.ok(walls.some(([, , facing]) => facing === prop.rotation),
      `${prop.id} повёрнут на ${prop.rotation}°, но стена не с той стороны`)
  }
})

test('одинаковые деревья отличаются поворотом или масштабом', () => {
  const map = place()
  const trees = map.props.filter((prop) => prop.assetId.startsWith('tree_'))
  if (trees.length < 2) return
  const signatures = new Set(trees.map((tree) => `${tree.rotation}:${tree.scale}`))
  assert.ok(signatures.size > 1, 'все деревья нарисованы одинаково — карта будет выглядеть штампованной')
})

test('плотность задаётся зоной, а не общим счётчиком', () => {
  const dense = placeProps(tavernWithYard(), {
    seed: 'density',
    zones: [{ zoneId: 'hall', theme: 'interior', density: 30 }, { zoneId: 'yard', theme: 'yard', density: 2 }],
  })
  const inHall = dense.props.filter((prop) => cellAt(dense, Math.floor(prop.x), Math.floor(prop.y))?.zone === 'hall').length
  const inYard = dense.props.filter((prop) => cellAt(dense, Math.floor(prop.x), Math.floor(prop.y))?.zone === 'yard').length
  assert.ok(inHall > inYard * 2, `в зале ${inHall}, во дворе ${inYard} — плотность зон не различается`)
})

test('бюджет предметов соблюдается', () => {
  const map = placeProps(tavernWithYard(), { seed: 'budget', zones: PLAN, maxProps: 5 })
  assert.ok(map.props.length <= 5, `расставлено ${map.props.length} предметов при бюджете 5`)
})

test('мелкая утварь ничего не занимает и лежит поверх', () => {
  const map = place()
  for (const prop of map.props) {
    if (!['mug', 'plate', 'bottle', 'candle', 'jug', 'bowl_stew'].includes(prop.assetId)) continue
    assert.deepEqual(prop.footprint, [])
    assert.equal(prop.zOrder, 1, 'утварь обязана рисоваться поверх мебели')
  }
})

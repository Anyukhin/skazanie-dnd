import assert from 'node:assert/strict'
import test from 'node:test'

import { assetById } from '../server/asset-registry.mjs'
import { attachPropSupports } from '../server/prop-placement.mjs'
import { addProp, addZone, createTacticalMap, setCell } from '../server/tactical-map.mjs'

function room() {
  const map = createTacticalMap({ width: 8, height: 8, seed: 'new-detail-props' })
  addZone(map, { id: 'hall', kind: 'interior', material: 'wood', label: 'Зал' })
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    setCell(map, x, y, { passable: true, material: 'wood', zone: 'hall', revealed: true })
  }
  return map
}

const surfaceItems = ['cutlery_set', 'book_piles', 'arcane_coil', 'alchemy_bottles', 'desk_candlestick', 'ceremonial_chalice', 'book_row', 'scroll_pile']

test('новая мелкая утварь крепится к столу и не занимает клетку', () => {
  const map = room()
  addProp(map, {
    id: 'surface-table', assetId: 'table_round', x: 3.5, y: 3.5,
    footprint: [{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 3 }],
    blocksMove: true, blocksSight: false,
  })
  surfaceItems.forEach((assetId, index) => addProp(map, {
    id: `surface-item-${index}`, assetId, x: 3.5, y: 3.5, footprint: [], blocksMove: false, blocksSight: false,
  }))

  attachPropSupports(map)

  const mounted = map.props.filter((prop) => surfaceItems.includes(prop.assetId))
  assert.equal(mounted.length, surfaceItems.length)
  for (const prop of mounted) {
    assert.deepEqual(prop.footprint, [])
    assert.deepEqual(prop.mount?.kind, 'surface')
    assert.equal(prop.mount?.propId, 'surface-table')
    assert.equal(prop.zOrder, 1)
  }
})

test('новая мелкая утварь без поверхности не размещается', () => {
  const map = room()
  addProp(map, { id: 'orphan-bottles', assetId: 'alchemy_bottles', x: 3.5, y: 3.5, footprint: [], blocksMove: false, blocksSight: false })
  addProp(map, { id: 'orphan-keys', assetId: 'key_bundle', x: 4.5, y: 3.5, footprint: [], blocksMove: false, blocksSight: false })

  attachPropSupports(map)

  assert.equal(map.props.some((prop) => prop.id === 'orphan-bottles'), false)
  assert.equal(map.props.some((prop) => prop.id === 'orphan-keys'), false)
})

test('плющ получает wall mount, а шахтные рельсы остаются ground decal', () => {
  const map = room()
  addProp(map, { id: 'ivy', assetId: 'wall_ivy', x: 0.5, y: 3.5, footprint: [], blocksMove: false, blocksSight: false })
  attachPropSupports(map)

  const ivy = map.props.find((prop) => prop.id === 'ivy')
  assert.deepEqual(ivy?.mount?.kind, 'wall')
  const rails = assetById('mine_rail')
  assert.ok(rails)
  assert.equal(rails.kind, 'decal')
  assert.deepEqual(rails.baseFootprint, { w: 0, h: 0 })
  assert.equal(rails.blocksMove, false)
  assert.equal(rails.blocksSight, false)
})

test('встроенные колбы алхимического стола не становятся опорой для новых вещей', () => {
  const map = room()
  addProp(map, { id: 'busy-table', assetId: 'alchemy_table', x: 3.5, y: 3.5,
    footprint: [{ x: 3, y: 3 }, { x: 4, y: 3 }], blocksMove: true })
  addProp(map, { id: 'loose-book', assetId: 'single_book', x: 3.5, y: 3.5, footprint: [] })
  attachPropSupports(map)
  assert.equal(map.props.some(prop => prop.id === 'busy-table'), true)
  assert.equal(map.props.some(prop => prop.id === 'loose-book'), false)
})

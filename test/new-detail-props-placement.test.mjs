import assert from 'node:assert/strict'
import test from 'node:test'

import { assetById } from '../server/asset-registry.mjs'
import { attachPropSupports, placeProps } from '../server/prop-placement.mjs'
import { generateSceneGeometry } from '../server/adventure-director.mjs'
import { sceneMapDesignFor } from '../server/scene-map-design.mjs'
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

test('письменный стол служит опорой: стопка книг встаёт на него, а не исчезает', () => {
  const map = room()
  addProp(map, { id: 'desk', assetId: 'writing_desk', x: 3, y: 3.5,
    footprint: [{ x: 2, y: 3 }, { x: 3, y: 3 }], blocksMove: true })
  addProp(map, { id: 'books', assetId: 'book_piles', x: 3.5, y: 4.5, footprint: [] })
  attachPropSupports(map)
  const books = map.props.find((prop) => prop.id === 'books')
  assert.equal(books?.mount?.kind, 'surface')
  assert.equal(books?.mount?.propId, 'desk')
})

test('без стола в зоне новая утварь не берётся в добор и не съедает бюджет', () => {
  const map = room()
  placeProps(map, {
    seed: 'no-surface',
    zones: [{ zoneId: 'hall', theme: 'study', density: 40, prefer: ['book_piles', 'scroll_pile', 'single_book', 'desk_candlestick', 'globe'] }],
  })
  const tableware = ['book_piles', 'scroll_pile', 'single_book', 'desk_candlestick']
  assert.deepEqual(map.props.filter((prop) => tableware.includes(prop.assetId)).map((prop) => prop.assetId), [])
  assert.ok(map.props.some((prop) => prop.assetId === 'globe'), 'бюджет достался предметам, которые встают')
})

/** Сколько предметов каждого вида на сгенерированной сцене. */
function sceneCounts(input) {
  const scene = generateSceneGeometry(input)
  const map = scene.map ?? scene
  const counts = new Map()
  for (const prop of map.props) counts.set(prop.assetId, (counts.get(prop.assetId) ?? 0) + 1)
  return counts
}

test('климат открытой местности открывает свой набор: снег, пустыня, болото', () => {
  const cold = sceneCounts({ location: 'Заснеженный лес', theme: 'зимний лес в глубоком снегу', seed: 'climate-cold' })
  assert.ok(cold.get('snowy_boulder') > 0 && cold.get('snowdrift') > 0, 'снежные валуны и сугробы')
  assert.ok((cold.get('ice_pillars') ?? 0) <= 3, 'лёд не вытесняет лес')
  const arid = sceneCounts({ location: 'Пустынная дорога', theme: 'дорога через пустыню, барханы', seed: 'climate-arid' })
  assert.ok(arid.get('cactus_cluster') > 0 && arid.get('sand_dune') > 0, 'кактусы и барханы')
  const wet = sceneCounts({ location: 'Гнилое болото', theme: 'топкое болото с камышом', seed: 'climate-wet' })
  assert.ok(wet.get('reed_cluster') > 0 && wet.get('mud_patch') > 0, 'камыш и грязь')
  const temperate = sceneCounts({ location: 'Лесная опушка', theme: 'светлый лес', seed: 'climate-temperate' })
  for (const id of ['snowy_boulder', 'cactus_cluster', 'reed_cluster', 'scout_tent', 'command_tent', 'dock_crane', 'ballista']) {
    assert.equal(temperate.get(id) ?? 0, 0, `${id} не попадает в обычный лес`)
  }
})

test('лагерь, гавань и дом мага получают свои предметы', () => {
  const camp = sceneCounts({ location: 'Лагерь разбойников', theme: 'лесной лагерь разбойников', seed: 'camp-set' })
  assert.ok(camp.get('scout_tent') > 0 && camp.get('bedroll_cluster') > 0, 'палатка и скатки')
  const harbor = sceneCounts({ location: 'Портовый квартал', theme: 'гавань у пристани', settlementType: 'town', seed: 'harbor-set' })
  assert.ok(harbor.get('mooring_bollard') > 0 && harbor.get('cargo_net') > 0, 'тумбы и сети с грузом')
  const tower = sceneCounts({ location: 'Дом мага', theme: 'башня мага с лабораторией', seed: 'mage-set' })
  assert.ok(tower.get('alchemy_cauldron') > 0 && tower.get('potion_cabinet') > 0, 'котёл и шкаф с зельями')
})

test('«магазин» не делает дом магическим, а «маг» и «алхимик» делают', () => {
  assert.equal(sceneMapDesignFor({ location: 'Магазин специй', theme: 'лавка' }).arcane, undefined)
  assert.equal(sceneMapDesignFor({ location: 'Башня мага', theme: '' }).arcane, true)
  assert.equal(sceneMapDesignFor({ location: 'Дом алхимика', theme: '' }).arcane, true)
})

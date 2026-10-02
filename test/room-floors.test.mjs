import assert from 'node:assert/strict'
import test from 'node:test'

import { generateSceneGeometry } from '../server/adventure-director.mjs'
import { applyRoomFloors, buildingWallStyleFor, roomFloorFor } from '../server/room-floors.mjs'
import {
  addZone, cellAt, createTacticalMap, deserializeTacticalMap, edgeBetween, serializeTacticalMap, setCell,
} from '../server/tactical-map.mjs'

/** Материал и рисунок пола каждой комнаты карты. */
function floorsOf(map) {
  const result = new Map()
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    const zone = map.zones.find((entry) => entry.id === cell?.zone)
    if (!cell?.passable || zone?.kind !== 'interior') continue
    const floors = result.get(zone.id) ?? { label: zone.label, floor: zone.floor ?? null, wallMaterial: zone.material, materials: new Set() }
    floors.materials.add(cell.material)
    result.set(zone.id, floors)
  }
  return result
}

test('комнаты трактира получают пол по назначению: зал в досках, кухня в камне, кладовая на земле', () => {
  for (const seed of ['a', 'b', 'c', 'd']) {
    const { map } = generateSceneGeometry({ location: 'Таверна «Рыжий рог»', theme: 'таверна', seed: `floors:${seed}`, useLibrary: false })
    const floors = floorsOf(map)
    assert.deepEqual([...floors.get('hall').materials], ['wood'], `${seed}: зал`)
    assert.equal(floors.get('hall').floor, 'planks-dark')
    // Фигурный корпус иногда съедает кухню целиком — тогда проверять нечего.
    if (!floors.has('kitchen')) continue
    assert.deepEqual([...floors.get('kitchen').materials], ['stone'], `${seed}: у кухни не каменный пол`)
    assert.equal(floors.get('kitchen').floor, 'flagstone')
    // Стены кухни остаются стенами постройки: материал зоны не тронут.
    assert.equal(floors.get('kitchen').wallMaterial, floors.get('hall').wallMaterial)
    if (floors.has('store')) assert.ok(['earth', 'stone'].includes([...floors.get('store').materials][0]))
  }
})

test('усадьба: зал в паркете, салон в мраморной шашке; склеп — в истёртой кладке целиком', () => {
  const manor = floorsOf(generateSceneGeometry({ location: 'Усадьба Вельских', theme: 'усадьба', seed: 'floors:manor', useLibrary: false }).map)
  assert.equal(manor.get('hall').floor, 'parquet')
  if (manor.has('salon')) {
    assert.equal(manor.get('salon').floor, 'checker')
    assert.deepEqual([...manor.get('salon').materials], ['marble'])
  }
  const crypt = floorsOf(generateSceneGeometry({ location: 'Старый склеп', theme: 'склеп', seed: 'floors:crypt', useLibrary: false }).map)
  for (const [zoneId, floors] of crypt) {
    // «Погребальная» — не «бальный зал»: подпись не уводит склеп в мрамор.
    assert.equal(floors.floor, 'dungeon', `${zoneId} (${floors.label})`)
  }
})

test('правила назначения: камера на соломе, экзотический материал не перекрашивается', () => {
  assert.deepEqual(roomFloorFor({ id: 'zone-3', label: 'Камеры' }, { use: 'dungeon', architecture: 'stone' }), { material: 'earth', floor: 'straw' })
  assert.deepEqual(roomFloorFor({ id: 'kitchen', label: 'Кухня' }, { architecture: 'wood' }), { material: 'stone', floor: 'flagstone' })
  assert.equal(roomFloorFor({ id: 'kitchen', label: 'Кухня' }, { architecture: 'ice' }), null, 'ледяной дворец не мостят')
  assert.deepEqual(roomFloorFor({ id: 'store', label: 'Кладовая' }, { architecture: 'stone' }), { material: 'stone', floor: 'flagstone' })
  assert.equal(roomFloorFor({ id: 'cellar', label: 'Погреб' })?.floor, 'flagstone', '«cellar» — не тюремная камера')
  assert.equal(buildingWallStyleFor({ use: 'tavern', architecture: 'wood', urban: true }), 'fachwerk')
  assert.equal(buildingWallStyleFor({ use: 'dwelling', architecture: 'wood', urban: true }), null)
  assert.equal(buildingWallStyleFor({ use: 'workshop', architecture: 'stone' }), 'brick')
})

test('пол и кладка — только отрисовка: правила видят материал, а сериализация сохраняет рисунок', () => {
  const map = createTacticalMap({ width: 3, height: 1, fill: { passable: true, revealed: true, material: 'wood' } })
  addZone(map, { id: 'hall', kind: 'interior', material: 'wood', label: 'Общий зал' })
  addZone(map, { id: 'kitchen', kind: 'interior', material: 'wood', label: 'Кухня' })
  setCell(map, 0, 0, { zone: 'hall' })
  setCell(map, 1, 0, { zone: 'kitchen' })
  setCell(map, 2, 0, { zone: 'kitchen', passable: false })
  assert.equal(applyRoomFloors(map, { use: 'tavern', wall: 'fachwerk' }), 2)
  assert.equal(cellAt(map, 1, 0).material, 'stone')
  assert.equal(cellAt(map, 2, 0).material, 'wood', 'непроходимая клетка — кладка, её пол не красится')
  const restored = deserializeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(map))))
  assert.deepEqual(restored.zones.map((zone) => [zone.id, zone.floor, zone.wall]), [['hall', 'planks-dark', 'fachwerk'], ['kitchen', 'flagstone', 'fachwerk']])
  assert.equal(edgeBetween(restored, 0, 0, 1, 0), null, 'пол не ставит стен')
  // Незнакомый рисунок карта не принимает.
  const strange = createTacticalMap({ width: 1, height: 1 })
  addZone(strange, { id: 'x', kind: 'interior', floor: 'lava', wall: 'glass' })
  assert.equal('floor' in strange.zones[0] || 'wall' in strange.zones[0], false)
})

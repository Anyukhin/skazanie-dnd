// Окрестности 3D-доски (`src/board3d-surroundings.ts`): земля, деревья и
// камни за краем карты вместо пустоты. Только представление — клеток и
// механики в них нет.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Matrix4 } from 'three'

import { compileClientModules } from './kit/client-ts.mjs'
import { addZone, createTacticalMap, deserializeTacticalMap, normalizeMapSurroundings, orientTacticalMap, serializeTacticalMap, setCell } from '../server/tactical-map.mjs'

const build = await compileClientModules(['src/board3d-surroundings.ts', 'src/tactical-map-client.ts', 'src/board3d-scene.ts'])
const [surroundings, mapClient, scene3d] = build.modules

function mapWith({ theme = 'forest', kind = 'exterior', material = 'grass', extra = {} } = {}) {
  const map = createTacticalMap({ width: 12, height: 10, seed: 'surroundings-test', theme })
  addZone(map, { id: 'ground', kind, material, label: 'Поляна' })
  for (let y = 0; y < 10; y += 1) for (let x = 0; x < 12; x += 1) setCell(map, x, y, { passable: true, material, zone: 'ground', revealed: true })
  Object.assign(map, extra)
  return mapClient.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(map))))
}

test('биом: помещение без окрестностей, лес — лес, пещера — толща камня', () => {
  assert.equal(surroundings.surroundingsBiome(mapWith({ kind: 'interior', material: 'wood', theme: 'building' })), 'indoor')
  assert.equal(surroundings.createSurroundings(mapWith({ kind: 'interior', material: 'wood', theme: 'building' })), null)
  assert.equal(surroundings.surroundingsBiome(mapWith()), 'forest')
  assert.equal(surroundings.surroundingsBiome(mapWith({ theme: 'cave', material: 'stone' })), 'rock')
  assert.equal(surroundings.surroundingsBiome(mapWith({ theme: 'road', material: 'stone' })), 'mountain')
})

test('лес вокруг карты: земля и деревья только за её краем', () => {
  const map = mapWith()
  const built = surroundings.createSurroundings(map, 'reduced')
  assert.ok(built)
  const names = built.group.children.map((child) => child.name)
  assert.ok(names.includes('surroundings-ground'))
  const trees = built.group.children.filter((child) => /trees|conifers/u.test(child.name))
  assert.ok(trees.reduce((sum, mesh) => sum + mesh.count, 0) > 50, 'лес вокруг лесной карты')
  const matrix = new (trees[0].matrix.constructor)()
  for (const mesh of trees) {
    for (let index = 0; index < mesh.count; index += 1) {
      mesh.getMatrixAt(index, matrix)
      const x = matrix.elements[12]
      const z = matrix.elements[14]
      assert.ok(x < -.9 || z < -.9 || x > map.width + .9 || z > map.height + .9, `дерево (${x.toFixed(1)}, ${z.toFixed(1)}) стоит на карте`)
    }
  }
  built.dispose()
})

test('авторская подсказка: море к северу — без деревьев, с камнями прибоя у края', () => {
  const map = mapWith({ theme: 'building', extra: { surroundings: { biome: 'meadow', sides: { n: 'sea' } } } })
  assert.equal(surroundings.surroundingsBiome(map), 'meadow')
  const built = surroundings.createSurroundings(map, 'reduced')
  const matrix = new (built.group.children[0].matrix.constructor)()
  for (const mesh of built.group.children.filter((child) => /trees|conifers|bushes/u.test(child.name))) {
    for (let index = 0; index < mesh.count; index += 1) {
      mesh.getMatrixAt(index, matrix)
      const z = matrix.elements[14]
      const x = matrix.elements[12]
      const north = z < 0 && -z > -x && -z > x - map.width
      assert.equal(north, false, 'в море деревья не растут')
    }
  }
  built.dispose()
})

test('море качается волнами: гладь только на стороне моря, у утёса пена, время двигает волны', () => {
  const meadow = surroundings.createSurroundings(mapWith({ theme: 'building', extra: { surroundings: { biome: 'meadow' } } }), 'reduced')
  assert.equal(meadow.group.getObjectByName('surroundings-sea'), undefined, 'у луга моря нет')
  assert.equal(meadow.animated, false)
  meadow.dispose()

  const map = mapWith({ theme: 'building', extra: { surroundings: { biome: 'meadow', sides: { n: 'sea' } } } })
  const built = surroundings.createSurroundings(map, 'reduced')
  const sea = built.group.getObjectByName('surroundings-sea')
  assert.ok(sea, 'гладь моря на северной стороне')
  assert.equal(built.animated, true)
  const position = sea.geometry.getAttribute('position')
  const coast = sea.geometry.getAttribute('coast')
  let nearCliff = false
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index), z = position.getZ(index)
    // Вода только снаружи карты и только с севера (с углами полосы).
    assert.ok(z <= 0 || x <= 0 || x >= map.width, `вода (${x}, ${z}) заходит на карту или на сушу юга`)
    if (z === 0 && x > 2 && x < map.width - 2 && coast.getX(index) === 0) nearCliff = true
  }
  assert.ok(nearCliff, 'у подножия утёса вода касается берега — там пена')
  const time = sea.material.userData.time
  built.animate(12.5)
  assert.equal(time.value, 12.5)
  built.dispose()
})

test('поле окрестностей: проверка, сериализация и поворот вместе с картой', () => {
  assert.equal(normalizeMapSurroundings({ biome: 'lava', sides: { n: 'ocean' } }), null)
  assert.deepEqual(normalizeMapSurroundings({ biome: 'meadow', sides: { n: 'sea', x: 'sea', e: 'forest' } }), { biome: 'meadow', sides: { n: 'sea', e: 'forest' } })
  const map = createTacticalMap({ width: 6, height: 4, seed: 'surroundings-field', theme: 'building' })
  map.surroundings = { biome: 'meadow', sides: { n: 'sea' } }
  const round = deserializeTacticalMap(serializeTacticalMap(map))
  assert.deepEqual(round.surroundings, { biome: 'meadow', sides: { n: 'sea' } })
  const turned = orientTacticalMap(round, 'east')
  assert.deepEqual(turned.surroundings, { biome: 'meadow', sides: { n: 'sea' } }, 'зеркало по востоку оставляет север')
  const north = orientTacticalMap(round, 'north')
  assert.notDeepEqual(north.surroundings?.sides, { n: 'sea' }, 'поворот уводит море к другой стороне')
})

test('земля за краем берёт рисунок пакета: газон у леса и луга, грунт у гор и камня, у помещения — ничего', () => {
  assert.equal(surroundings.surroundingsGroundFloor(mapWith()), 'grass')
  assert.equal(surroundings.surroundingsGroundFloor(mapWith({ theme: 'building', extra: { surroundings: { biome: 'meadow' } } })), 'grass')
  assert.equal(surroundings.surroundingsGroundFloor(mapWith({ theme: 'cave', material: 'stone' })), 'earth')
  assert.equal(surroundings.surroundingsGroundFloor(mapWith({ theme: 'road', material: 'stone' })), 'earth')
  assert.equal(surroundings.surroundingsGroundFloor(mapWith({ kind: 'interior', material: 'wood', theme: 'building' })), null)
})

test('ландшафт и атлас окружают поле; горизонт со стороны моря остаётся водой', () => {
  const map = mapWith({ extra: { surroundings: { biome: 'forest', sides: { n: 'sea' } } } })
  const landscape = surroundings.createSurroundings(map, 'reduced', {}, 'landscape')
  const atlas = surroundings.createSurroundings(map, 'reduced', {}, 'atlas')
  try {
    const hills = landscape.group.getObjectByName('surroundings-hills')
    const paper = atlas.group.getObjectByName('surroundings-atlas')
    assert.ok(hills && paper)
    for (const obj of [hills, paper]) {
      const pos = obj.geometry.getAttribute('position')
      for (let i=0; i<pos.count; i++) {
        const x=pos.getX(i), z=pos.getZ(i)
        assert.ok(Number.isFinite(pos.getY(i)) && (x < 0 || x > map.width || z < 0 || z > map.height))
      }
      obj.geometry.computeBoundingBox()
    }
    assert.ok(hills.geometry.boundingBox.max.y - hills.geometry.boundingBox.min.y > 1)
    assert.equal(paper.geometry.boundingBox.min.y, paper.geometry.boundingBox.max.y)
    assert.ok(!atlas.group.getObjectByName('surroundings-distant-groves'))
    const trees = hills.getObjectByName('surroundings-distant-groves')
    const matrix = new Matrix4()
    assert.ok(trees.count > 0)
    for (let i=0; i<trees.count; i++) {
      trees.getMatrixAt(i,matrix)
      const x = matrix.elements[12]
      const z = matrix.elements[14]
      assert.ok(!(z < 0 && x > 0 && x < map.width), 'дальняя роща стоит на суше')
    }
  } finally { landscape.dispose(); atlas.dispose() }
})

test('смена вида окрестностей сохраняет игровую геометрию и освобождает предыдущий фон', () => {
  const scene = scene3d.createBoard3DScene(mapWith())
  try {
    const targets = scene.getPropPickTargets()
    const hills = scene.group.getObjectByName('surroundings-hills')
    assert.ok(hills)
    let released = 0
    hills.geometry.addEventListener('dispose', () => released++)
    scene.setBackdropStyle('landscape')
    assert.equal(scene.group.getObjectByName('surroundings-hills'), hills)
    scene.setBackdropStyle('atlas')
    assert.equal(released, 1)
    assert.ok(scene.group.getObjectByName('surroundings-atlas'))
    assert.equal(scene.getPropPickTargets(), targets)
    scene.setBackdropStyle('classic')
    assert.ok(!scene.group.getObjectByName('surroundings-atlas'))
    assert.ok(scene.group.getObjectByName('surroundings-ground'))
  } finally { scene.dispose() }
})

test('скрытый материал не задаёт тип и облик дальнего пейзажа', () => {
  const raw = createTacticalMap({ width:12,height:10,seed:'same-seed',theme:'road' })
  addZone(raw,{id:'yard',kind:'exterior',label:'Двор',material:'grass'})
  for (let y=0;y<10;y++) for(let x=0;x<12;x++) setCell(raw,x,y,{zone:'yard',material:'grass',passable:true,revealed:x===0})
  const build = () => surroundings.createSurroundings(mapClient.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(raw)))), 'minimal')
  const before = build()
  for (let y=0;y<10;y++) for(let x=1;x<12;x++) setCell(raw,x,y,{material:'stone'})
  const after = build()
  try {
    assert.equal(before.group.userData.biome, 'meadow')
    assert.equal(after.group.userData.biome, 'meadow')
    const vertices = s => s.group.getObjectByName('surroundings-hills').geometry.attributes.position.array
    assert.deepEqual(vertices(before), vertices(after))
  } finally { before.dispose(); after.dispose() }
})

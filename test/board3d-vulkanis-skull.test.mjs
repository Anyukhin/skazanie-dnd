import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { compileClientModules } from './kit/client-ts.mjs'

const { modules: [skull, resources] } = await compileClientModules([
  'src/board3d-vulkanis-skull.ts',
  'src/board3d-prop-resources.ts',
])

test('череп Вулканиса имеет реальные просветы, анатомичную челюсть, зубные ряды и сломанный рог', () => {
  const owned = resources.resources()
  const parent = new THREE.Group()
  skull.buildVulkanisSkull(owned, parent, 3, 3)
  const built = parent.getObjectByName('vulkanis-dragon-skull')
  assert.ok(built)
  const plates = built.children.filter(child => child.name === 'skull-side-plate')
  assert.equal(plates.length, 2)
  parent.updateMatrixWorld(true)
  const through = (x, y) => {
    const origin = built.localToWorld(new THREE.Vector3(x,y,2))
    const forward = new THREE.Vector3(0,0,-1).transformDirection(built.matrixWorld)
    return new THREE.Raycaster(origin,forward).intersectObject(built).length
  }
  assert.equal(through(.05,.74), 0, 'глазницы с обеих сторон сквозные')
  assert.equal(through(-.89,.58), 0, 'носовая полость открыта')
  assert.ok(through(.12,.98) > 0, 'над отверстием есть надглазничная дуга')
  assert.equal(built.children.filter(child => child.name === 'skull-jaw-branch').length, 2)
  assert.equal(built.children.filter(c => c.name === 'skull-teeth').length, 2)
  assert.ok(built.getObjectByName('skull-broken-horn'))
  const bounds = new THREE.Box3().setFromObject(built, true).getSize(new THREE.Vector3())
  assert.ok(bounds.x > 2.4 && bounds.x < 2.9 && bounds.z > .6 && bounds.y > .8 && bounds.y < 1.4)
  const horn = new THREE.Box3().setFromObject(built.getObjectByName('skull-horn')).getSize(new THREE.Vector3())
  const broken = new THREE.Box3().setFromObject(built.getObjectByName('skull-broken-horn')).getSize(new THREE.Vector3())
  assert.ok(broken.y < horn.y, 'сломанный рог короче целого')
  for (const item of owned.geometries) item.dispose()
  for (const item of owned.materials) item.dispose()
})

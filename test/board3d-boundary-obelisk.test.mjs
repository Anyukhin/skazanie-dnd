import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { compileClientModules } from './kit/client-ts.mjs'

const { modules: [marker, resourcesModule] } = await compileClientModules([
  'src/board3d-boundary-obelisk.ts',
  'src/board3d-prop-resources.ts',
])

test('старый межевой камень получает многогранный скол и потёртые зарубки', () => {
  const resources = resourcesModule.resources()
  const parent = new THREE.Group()
  marker.addOldBoundaryStone(resources, parent, .8)
  const built = parent.getObjectByName('old-boundary-stone')
  assert.ok(built)
  const shaft = built.getObjectByName('boundary-shaft')
  assert.ok(shaft)
  const { position,normal,color } = shaft.geometry.attributes
  const crown = []
  for (let i=0; i<position.count; i++) if (normal.getY(i) > .5 && position.getY(i) > .8) crown.push(position.getY(i))
  assert.ok(crown.length && Math.max(...crown) - Math.min(...crown) > .2, 'верхний скол имеет видимую снаружи наклонную грань')
  assert.equal(color.count, position.count)
  const bounds = new THREE.Box3().setFromObject(built)
  assert.ok(bounds.max.y - bounds.min.y > .8)
  assert.ok(bounds.max.x - bounds.min.x < 1)
  assert.equal(shaft.material.emissive.getHex(), 0)
  for (const geometry of resources.geometries) geometry.dispose()
  for (const material of resources.materials) material.dispose()
})

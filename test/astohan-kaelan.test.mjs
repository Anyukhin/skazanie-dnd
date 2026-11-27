import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { compileClientModules } from './kit/client-ts.mjs'

const { modules: [kaelan, resourcesModule] } = await compileClientModules([
  'src/astohan-kaelan.ts',
  'src/board3d-prop-resources.ts',
])

test('Каэлан имеет коня, чёрные латы, призрачное лицо и клинок «Лунный Судья»', () => {
  const owned = resourcesModule.resources()
  const parent = new THREE.Group()
  const model = kaelan.buildAstohanKaelan(parent)
  parent.add(model)
  const names = new Set()
  model.traverse(object => names.add(object.name))
  assert.ok(names.has('kaelan-horse-body'))
  assert.ok(names.has('kaelan-horse-leg'))
  assert.ok(names.has('kaelan-armor-skirt'))
  assert.ok(names.has('kaelan-ghost-collar'))
  assert.ok(names.has('empty-neck'))
  assert.ok(names.has('kaelan-floating-head'))
  assert.ok(names.has('kaelan-moon-judge'))
  assert.equal(model.userData.astohanKaelan, true)
  assert.equal(model.userData.recommendedHeight, 2.05)
  assert.equal(model.userData.board3dPickable, undefined)
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  assert.ok(box.min.y >= -.08, 'копыта не проваливаются в грунт')
  assert.ok(size.x > .2 && size.x < 1.4)
  assert.ok(size.z > 1 && size.z < 2.4)
  assert.ok(size.y > 1.4 && size.y < 2.4)
  for (const geometry of owned.geometries) geometry.dispose()
  for (const material of owned.materials) material.dispose()
})

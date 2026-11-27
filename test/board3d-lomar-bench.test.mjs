import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'

import { compileClientModules } from './kit/client-ts.mjs'

const { modules: [lomar, resourcesModule] } = await compileClientModules([
  'src/board3d-lomar-bench.ts',
  'src/board3d-prop-resources.ts',
])

test('рабочее место Ломара добавляет инструменты и колбы в габарит стола', () => {
  const owned = resourcesModule.resources()
  const parent = new THREE.Group()
  const detail = lomar.buildLomarBench(owned, parent, 2.8, 1.3)
  try {
    assert.equal(detail.name, 'lomar-alchemy-bench-detail')
    for (const name of ['workbench-top', 'workbench-leg', 'workbench-lower-shelf', 'workbench-drawer', 'burner-flame', 'crucible', 'flask-red-glass', 'flask-blue-glass', 'flask-amber-glass', 'tool-tongs-left', 'tool-tongs-right', 'parchment']) {
      assert.ok(detail.getObjectByName(name), name + ': деталь стола')
    }
    assert.equal(parent.userData.surfaceHeight, detail.userData.surfaceHeight)
    const surface = Number(parent.userData.surfaceHeight)
    for (const name of ['burner-ring', 'burner-foot', 'crucible', 'crucible-rim', 'flask-red-glass', 'flask-blue-glass', 'flask-amber-glass', 'parchment', 'stirring-rod', 'tool-tongs-left', 'tool-tongs-right']) {
      const object = detail.getObjectByName(name)
      const itemBounds = new THREE.Box3().setFromObject(object)
      assert.ok(itemBounds.min.y >= surface - .012, name + ': предмет не должен проваливаться в стол')
    }
    const bounds = new THREE.Box3().setFromObject(detail)
    assert.ok(bounds.max.x - bounds.min.x <= 2.4)
    assert.ok(bounds.max.z - bounds.min.z <= 1.15)
    assert.ok(bounds.max.y < 1.3, 'детали не превращают рабочий стол в башню')
    let pickable = false
    detail.traverse(object => { if (object.userData.board3dPickable !== false) pickable = true })
    assert.equal(pickable, false)
  } finally {
    detail.removeFromParent()
    for (const geometry of owned.geometries) geometry.dispose()
    for (const mat of owned.materials) mat.dispose()
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'

import { compileClientModules } from './kit/client-ts.mjs'

const { modules: [table, resources] } = await compileClientModules([
  'src/board3d-gedrik-table.ts',
  'src/board3d-prop-resources.ts',
])

test('походный стол Гедрика имеет карту, маршрутные метки и пригодную высоту поверхности', () => {
  const owned = resources.resources()
  const parent = new THREE.Group()
  const built = table.buildGedrikTable(owned, parent, 2, 2)
  try {
    assert.equal(built.userData.gedrikTable, true)
    assert.equal(built.userData.surfaceHeight, table.GEDRIK_TABLE_SURFACE_HEIGHT)
    assert.ok(built.getObjectByName('table-map'))
    assert.ok(built.getObjectByName('route-line'))
    assert.ok(built.getObjectsByProperty('type', 'Mesh').length >= 20)
    assert.ok(owned.textures.size <= 1, 'карта освобождается вместе с ресурсами')
    const map = built.getObjectByName('table-map')
    const clamps = built.children.filter((child) => child.name === 'map-clamp')
    assert.equal(clamps.length, 4)
    assert.ok(clamps.every((clamp) => clamp.position.y < map.position.y + .08), 'прижимы лежат на бумаге')
    const legs = built.children.filter((child) => child.name === 'trestle-leg')
    const topBottom = built.getObjectByName('table-top').position.y - .06
    assert.ok(legs.every((leg) => new THREE.Box3().setFromObject(leg).max.y >= topBottom - .01), 'козлы касаются столешницы')
    const bounds = new THREE.Box3().setFromObject(built)
    assert.ok(bounds.max.y > .85 && bounds.max.y < 1.1)
    assert.ok(bounds.min.y >= 0)
  } finally {
    built.removeFromParent()
    for (const value of owned.geometries) value.dispose()
    for (const value of owned.materials) value.dispose()
    for (const value of owned.textures) value.dispose()
  }
})

test('стол масштабируется под четырёхклеточную площадку без выхода за футпринт', () => {
  const owned = resources.resources()
  const parent = new THREE.Group()
  const built = table.buildGedrikTable(owned, parent, 2, 2)
  const bounds = new THREE.Box3().setFromObject(built)
  assert.ok(bounds.max.x - bounds.min.x <= 1.72)
  assert.ok(bounds.max.z - bounds.min.z <= 1.72)
  built.removeFromParent()
  for (const value of owned.geometries) value.dispose()
  for (const value of owned.materials) value.dispose()
  for (const value of owned.textures) value.dispose()
})

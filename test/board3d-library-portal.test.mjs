import assert from 'node:assert/strict'
import test from 'node:test'

import { compileClientModules } from './kit/client-ts.mjs'
import { addZone, createTacticalMap, serializeTacticalMap, setCell, setDoor } from '../server/tactical-map.mjs'

const { modules: [walls, mapClient] } = await compileClientModules(['src/board3d-walls.ts', 'src/tactical-map-client.ts'])

function portalMap({ doorId = 'astohan-forgotten-cliffs:door-5', libraryRevealed = true, state = 'closed' } = {}) {
  const source = createTacticalMap({ width: 3, height: 2, locationId: 'astohan-forgotten-cliffs', theme: 'building', seed: 'library-portal-context' })
  addZone(source, { id: 'library', kind: 'interior', material: 'wood', lightLevel: 'dim' })
  addZone(source, { id: 'courtyard', kind: 'exterior', material: 'stone', lightLevel: 'dim' })
  for (let y = 0; y < 2; y += 1) for (let x = 0; x < 3; x += 1) {
    const library = x === 1 && y === 0
    setCell(source, x, y, { passable: true, material: library ? 'wood' : 'stone', zone: library ? 'library' : 'courtyard', revealed: library ? libraryRevealed : true })
  }
  setDoor(source, { id: doorId, x: 1, y: 0, dir: 's', state })
  return mapClient.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(source))))
}

test('портал определяется статическим door id и соседними зонами, а чужая дверь не получает его', () => {
  const edge = (map) => map.edges['1,0,s']
  assert.equal(walls.libraryPortalContext(portalMap(), edge(portalMap())), true)
  const foreign = portalMap({ doorId: 'astohan-forgotten-cliffs:door-6' })
  assert.equal(walls.libraryPortalContext(foreign, edge(foreign)), false)
  const hidden = portalMap({ libraryRevealed: false })
  assert.equal(walls.libraryPortalContext(hidden, edge(hidden)), true, 'видимая сторона двери достаточно открыта')
  const open = portalMap({ state: 'open', libraryRevealed: false })
  assert.equal(walls.libraryPortalContext(open, edge(open)), true, 'состояние открытой створки не меняет фасад')
  const dark = portalMap({ libraryRevealed: false })
  dark.layers.revealed.fill(0)
  assert.equal(walls.libraryPortalContext(dark, edge(dark)), false, 'полностью скрытое ребро не создаёт фасад')
})

test('клинья портала имеют радиальный профиль и компактную раскладку', () => {
  const geometry = walls.createPortalWedgeGeometry()
  assert.equal(geometry.userData.portalWedge, true)
  assert.ok(geometry.index.count >= 72 && geometry.index.count <= 96)
  geometry.dispose()
  const blocks = walls.libraryPortalBlocks(.95)
  const metrics = walls.libraryPortalMetrics(.95)
  assert.equal(blocks.length, 9)
  assert.equal(blocks.filter((block) => block.keystone).length, 1)
  assert.ok(metrics.centerY + metrics.radius - blocks[4].size[1] / 2 >= 1.4, 'внутренний просвет выше головы героя')
  assert.ok(blocks.every((block) => block.position[1] <= metrics.centerY + metrics.radius))
})

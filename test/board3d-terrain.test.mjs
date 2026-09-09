import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import test from 'node:test'

import { addProp, createTacticalMap, serializeTacticalMap, setCell } from '../server/tactical-map.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const buildDir = mkdtempSync(join(root, 'tmp', 'board3d-terrain-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sources = ['../src/board3d-terrain.ts', '../src/tactical-map-client.ts'].map((relative) => fileURLToPath(new URL(relative, import.meta.url)))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', buildDir, ...sources,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
for (const name of readdirSync(buildDir)) {
  if (!name.endsWith('.js')) continue
  const path = join(buildDir, name)
  const source = readFileSync(path, 'utf8').replace(/(from\s+["'])(\.\/[^"']+)(["'])/g, '$1$2.mjs$3')
  writeFileSync(path.replace(/\.js$/u, '.mjs'), source)
  rmSync(path)
}
const terrain = await import(pathToFileURL(join(buildDir, 'board3d-terrain.mjs')).href)
const client = await import(pathToFileURL(join(buildDir, 'tactical-map-client.mjs')).href)
const THREE = await import('three')
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

function decodedMap() {
  const map = createTacticalMap({ width: 4, height: 3, seed: 'terrain-test', fill: { passable: true, revealed: true, material: 'stone', elevation: 0 } })
  setCell(map, 1, 0, { elevation: 2 })
  setCell(map, 2, 0, { elevation: -1 })
  setCell(map, 3, 0, { elevation: 9, revealed: false })
  return client.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(map))))
}

test('высота читается только с раскрытой клетки и переводит футы в мировые клетки', () => {
  const map = decodedMap()
  assert.equal(terrain.terrainHeightAt(map, 1.9, 0.8), 0.4)
  assert.equal(terrain.terrainHeightAt(map, 3, 0), 0, 'скрытая высота не попадает в проекцию')
  assert.deepEqual(terrain.visibleTerrainHeightRange(map), { min: -0.2, max: 0.4 })
  assert.equal(terrain.terrainHeightAt(null, 1, 1), 0)
})

test('поверхность имеет поднятый пол, правильные UV и нормали вверх', () => {
  const map = decodedMap()
  const geometry = terrain.createTerrainSurfaceGeometry(map, .25)
  const positions = geometry.getAttribute('position')
  const uvs = geometry.getAttribute('uv')
  const normals = geometry.getAttribute('normal')
  assert.equal(positions.count, 44, '11 раскрытых клеток дают 44 вершины')
  let raised = false
  for (let index = 0; index < positions.count; index += 1) {
    if (positions.getX(index) === 1 && positions.getZ(index) === 0) {
      if (Math.abs(positions.getY(index) - 0.65) < 1e-6) raised = true
    }
    assert.ok(Math.abs(normals.getX(index)) < 1e-6 && Math.abs(normals.getZ(index)) < 1e-6 && normals.getY(index) > .99, 'каждая поверхность смотрит вверх')
  }
  assert.equal(raised, true)
  const firstTopLeft = [...Array(positions.count).keys()].find((index) => positions.getX(index) === 0 && positions.getZ(index) === 0)
  assert.equal(firstTopLeft, 0)
  assert.equal(uvs.getX(firstTopLeft), 0)
  assert.equal(uvs.getY(firstTopLeft), 1)
})

test('raycaster выбирает поднятую клетку, а боковые грани не читают туман', () => {
  const map = decodedMap()
  const surface = terrain.createTerrainSurfaceGeometry(map)
  const mesh = new THREE.Mesh(surface, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  mesh.updateMatrixWorld(true)
  const hits = new THREE.Raycaster(new THREE.Vector3(1.5, 10, .5), new THREE.Vector3(0, -1, 0)).intersectObject(mesh)
  assert.ok(hits.length > 0)
  assert.ok(Math.abs(hits[0].point.y - 0.4) < 1e-6)

  const sides = terrain.createTerrainSideGeometry(map)
  assert.equal(sides.getAttribute('position').count, 64, 'четыре внутренние и двенадцать внешних граней строятся один раз')
  const sidePositions = sides.getAttribute('position')
  for (let index = 0; index < sidePositions.count; index += 1) {
    assert.ok(Math.abs(sidePositions.getY(index) - 1.8) > 1e-6, 'высота скрытого соседа не вытекает в стенку')
  }
  assert.equal(sides.getAttribute('normal').count, 64)
  const sideNormals = sides.getAttribute('normal')
  for (let index = 0; index < sideNormals.count; index += 1) assert.ok(Math.abs(sideNormals.getY(index)) < 1e-6, 'боковая грань вертикальна')
  const sideMesh = new THREE.Mesh(sides, new THREE.MeshBasicMaterial())
  sideMesh.updateMatrixWorld(true)
  const rays = [
    { origin: [-5, .2, .5], direction: [1, 0, 0], edge: 'x=1' },
    { origin: [5, .1, .5], direction: [-1, 0, 0], edge: 'x=2' },
    { origin: [1.5, .2, 5], direction: [0, 0, -1], edge: 'z=1 south' },
    { origin: [2.5, -.1, -5], direction: [0, 0, 1], edge: 'z=1 north' },
  ]
  for (const ray of rays) {
    const hits = new THREE.Raycaster(new THREE.Vector3(...ray.origin), new THREE.Vector3(...ray.direction)).intersectObject(sideMesh)
    assert.ok(hits.length > 0, `FrontSide raycast видит вертикальную грань ${ray.edge} со стороны низкой клетки`)
  }
  let raisedBoundary = false
  for (let offset = 0; offset < sidePositions.count; offset += 4) {
    const z = [0, 1, 2, 3].map((index) => sidePositions.getZ(offset + index))
    const ys = [0, 1, 2, 3].map((index) => sidePositions.getY(offset + index))
    if (z.every((value) => value === 0) && Math.abs(Math.max(...ys) - 0.4) < 1e-6 && Math.abs(Math.min(...ys) + .32) < 1e-5) raisedBoundary = true
  }
  assert.equal(raisedBoundary, true, 'внешняя грань поднятой клетки опускается до общего основания')
})

test('высота предмета берётся с максимальной видимой клетки футпринта', () => {
  const map = decodedMap()
  addProp(map, { id: 'visible-prop', assetId: 'crate', x: 1.5, y: .5, footprint: [{ x: 0, y: 0 }, { x: 1, y: 0 }] })
  addProp(map, { id: 'hidden-prop', assetId: 'crate', x: 3.5, y: .5, footprint: [{ x: 3, y: 0 }] })
  assert.equal(terrain.propTerrainHeight(map, map.props[0]), 0.4)
  assert.equal(terrain.propTerrainHeight(map, { ...map.props[1], footprint: [] }), 0)
  assert.equal(terrain.propTerrainHeight(map, { ...map.props[0], footprint: [] }), 0.4)
})

test('100×100 поверхность остаётся в предсказуемом CPU-буфере', () => {
  const source = createTacticalMap({ width: 100, height: 100, seed: 'terrain-budget', fill: { passable: true, revealed: true, material: 'stone', elevation: 0 } })
  const map = client.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(source))))
  const geometry = terrain.createTerrainSurfaceGeometry(map)
  assert.equal(geometry.getAttribute('position').count, 40_000)
  assert.equal(geometry.getIndex().count, 60_000)
  assert.ok(Number.isFinite(geometry.boundingSphere.radius))
  const empty = terrain.createTerrainSurfaceGeometry(createTacticalMap({ width: 1, height: 1 }))
  assert.equal(empty.getAttribute('position').count, 0)
  assert.ok(empty.boundingBox.min.toArray().every(Number.isFinite), 'пустая поверхность имеет конечные границы')
})

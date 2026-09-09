import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { buildThemedScene } from '../server/scene-themes.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'tmp'), { recursive: true })
const buildDir = mkdtempSync(join(root, 'tmp', 'board3d-batching-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sources = ['../src/board3d-batching.ts', '../src/board3d-props.ts', '../src/board-render.ts']
  .map((relative) => fileURLToPath(new URL(relative, import.meta.url)))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', buildDir, ...sources,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
for (const name of readdirSync(buildDir)) {
  const path = join(buildDir, name)
  if (statSync(path).isDirectory() || !name.endsWith('.js')) continue
  const source = readFileSync(path, 'utf8').replace(/(from\s+["'])(\.\/[^"']+)(["'])/g, '$1$2.mjs$3')
  writeFileSync(path, source)
  renameSync(path, path.replace(/\.js$/u, '.mjs'))
}
const batch = await import(pathToFileURL(join(buildDir, 'board3d-batching.mjs')).href)
const props3d = await import(pathToFileURL(join(buildDir, 'board3d-props.mjs')).href)
const render = await import(pathToFileURL(join(buildDir, 'board-render.mjs')).href)
const THREE = await import('three')
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

function visibleIn(rootGroup, object) {
  for (let current = object; current && current !== rootGroup; current = current.parent) if (!current.visible) return false
  return rootGroup.visible
}

function matrixValues(rootGroup, expanded = false) {
  rootGroup.updateMatrixWorld(true)
  const result = []
  rootGroup.traverse((object) => {
    if (!object.visible || !visibleIn(rootGroup, object)) return
    if (expanded && object.isInstancedMesh) {
      const local = new THREE.Matrix4()
      for (let index = 0; index < object.count; index += 1) {
        object.getMatrixAt(index, local)
        result.push(new THREE.Matrix4().multiplyMatrices(object.matrixWorld, local).elements.slice())
      }
    } else if (!expanded && object.isMesh) result.push(object.matrixWorld.elements.slice())
    else if (expanded && object.isMesh && !object.isInstancedMesh) result.push(object.matrixWorld.elements.slice())
  })
  return result.sort((left, right) => left.join(',').localeCompare(right.join(',')))
}

function assertSameMatrices(before, after) {
  assert.equal(after.length, before.length, 'число исходных и итоговых экземпляров совпадает')
  for (let index = 0; index < before.length; index += 1) for (let part = 0; part < 16; part += 1) {
    assert.ok(Math.abs(before[index][part] - after[index][part]) < 1e-5, `матрица ${index}, элемент ${part} изменился`)
  }
}

test('batch сохраняет матрицы мира и пропускает небезопасные материалы/меши', () => {
  const rootGroup = new THREE.Group()
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const opaque = new THREE.MeshStandardMaterial({ color: '#ffffff' })
  const make = (name, material = opaque) => { const mesh = new THREE.Mesh(geometry, material); mesh.name = name; rootGroup.add(mesh); return mesh }
  const first = make('eligible-a'); first.position.set(2, 0, 1)
  const second = make('eligible-b'); second.position.set(-1, 0, 3); second.rotation.y = .4
  const transparent = make('transparent', new THREE.MeshStandardMaterial({ transparent: true, opacity: .5 }))
  const array = make('array', [opaque, opaque])
  const hidden = make('hidden'); hidden.visible = false
  const negative = make('negative'); negative.scale.x = -1
  const animated = make('animated'); animated.userData.animated = true
  const skinned = new THREE.SkinnedMesh(geometry, opaque); skinned.name = 'skinned'; rootGroup.add(skinned)
  const before = matrixValues(rootGroup)
  const result = batch.batchEnvironmentMeshes(rootGroup)
  assert.equal(result.batches.length, 1)
  assert.equal(result.batches[0].count, 2)
  assert.ok(result.batchedDrawCalls < result.originalDrawCalls)
  assertSameMatrices(before, matrixValues(rootGroup, true))
  for (const name of ['transparent', 'array', 'hidden', 'negative', 'animated', 'skinned']) assert.ok(rootGroup.getObjectByName(name), `${name} не должен удаляться`)
  assert.equal(rootGroup.getObjectByName('eligible-a'), undefined)
  assert.equal(rootGroup.getObjectByName('eligible-b'), undefined)
  let geometryDisposals = 0, materialDisposals = 0
  geometry.addEventListener('dispose', () => geometryDisposals += 1)
  opaque.addEventListener('dispose', () => materialDisposals += 1)
  result.dispose()
  assert.equal(geometryDisposals, 0, 'batch не владеет общей геометрией')
  assert.equal(materialDisposals, 0, 'batch не владеет общим материалом')
  assert.equal(result.batches[0].parent, null)
})

test('лесная сцена получает существенное сокращение draw calls', () => {
  const environment = props3d.createEnvironmentModels(render.DEFAULT_BOARD_PALETTE)
  try {
    const scene = buildThemedScene({ themeId: 'forest', seed: 'realforest26x26', locationId: 'board3d-batching', width: 26, height: 26 })
    const rootGroup = new THREE.Group()
    for (const prop of scene.map.props) rootGroup.add(environment.create(prop))
    const before = matrixValues(rootGroup)
    const result = batch.batchEnvironmentMeshes(rootGroup)
    assert.ok(scene.map.props.length >= 80, `лесная сцена должна быть достаточно плотной: ${scene.map.props.length}`)
    assert.ok(result.batches.length > 0)
    assert.ok(result.batchedDrawCalls <= result.originalDrawCalls / 4, `${result.originalDrawCalls} → ${result.batchedDrawCalls} draw calls`)
    assertSameMatrices(before, matrixValues(rootGroup, true))
    result.dispose()
  } finally {
    environment.dispose()
  }
})

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { listAssets } from '../server/asset-registry.mjs'
import { buildThemedScene } from '../server/scene-themes.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'tmp'), { recursive: true })
const buildDir = mkdtempSync(join(root, 'tmp', 'board3d-generation-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sources = ['../src/board3d-props.ts', '../src/board-render.ts']
  .map((relative) => fileURLToPath(new URL(relative, import.meta.url)))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', buildDir, ...sources,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
for (const name of readdirSync(buildDir)) {
  if (!name.endsWith('.js')) continue
  const source = readFileSync(join(buildDir, name), 'utf8')
    .replace(/(from\s+["'])(\.\/[^"']+)(["'])/g, '$1$2.mjs$3')
  writeFileSync(join(buildDir, name.replace(/\.js$/, '.mjs')), source)
  rmSync(join(buildDir, name))
}
const props3d = await import(pathToFileURL(join(buildDir, 'board3d-props.mjs')).href)
const render = await import(pathToFileURL(join(buildDir, 'board-render.mjs')).href)
const THREE = await import('three')
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

const CANONICAL_ASSETS = listAssets().filter((asset) => asset.kind === 'prop' || asset.kind === 'decal')
const GENERATOR_THEMES = ['building', 'temple', 'crypt', 'cave', 'forest', 'road', 'settlement', 'ares-fortress']
const SEEDS = ['board3d-generation-a', 'board3d-generation-b', 'board3d-generation-c']

function propFor(asset, index, rotation = [0, 90, 180, 270][index % 4], scale = 1) {
  const width = asset.baseFootprint.w
  const depth = asset.baseFootprint.h
  const quarter = Math.round((((rotation % 360) + 360) % 360) / 90) % 4
  const footprintWidth = quarter % 2 ? depth : width
  const footprintDepth = quarter % 2 ? width : depth
  const footprint = width > 0
    ? Array.from({ length: footprintDepth }, (_, y) => Array.from({ length: footprintWidth }, (_, x) => ({ x: 4 + x, y: 5 + y }))).flat()
    : []
  return {
    id: `board3d-generation-${asset.id}-${index}`,
    assetId: asset.id,
    x: 4 + (footprintWidth || 1) / 2,
    y: 5 + (footprintDepth || 1) / 2,
    rotation,
    scale,
    footprint,
    zOrder: 0,
    blocksMove: asset.blocksMove,
    blocksSight: asset.blocksSight,
    cover: asset.cover,
    destructible: asset.destructible,
    hp: asset.hp,
    interactive: asset.interactive,
    state: '',
    interaction: null,
  }
}

function round(value) {
  return Number(value.toFixed(6))
}

function finiteBox(group) {
  group.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(group)
  const values = [...box.min.toArray(), ...box.max.toArray()]
  assert.equal(values.every(Number.isFinite), true, `${group.name}: невырожденный конечный габарит`)
  assert.ok(box.max.x > box.min.x || box.max.y > box.min.y || box.max.z > box.min.z, `${group.name}: геометрия модели вырождена`)
  return box
}

function descriptor(env, prop) {
  const group = env.create(prop)
  const layout = render.propVisualLayout(prop)
  const box = finiteBox(group)
  return {
    id: prop.id,
    assetId: prop.assetId,
    modelKind: group.userData.modelKind,
    position: [round(group.position.x), round(group.position.y), round(group.position.z)],
    rotation: round(group.rotation.y),
    layout: [layout.x, layout.y, layout.width, layout.depth, layout.scale, layout.rotation, layout.fromFootprint],
    footprint: prop.footprint.map((cell) => [cell.x, cell.y]),
    bounds: [
      round(box.min.x), round(box.min.y), round(box.min.z),
      round(box.max.x), round(box.max.y), round(box.max.z),
    ],
  }
}

function sceneDescriptor(scene, env) {
  return scene.map.props.map((prop) => descriptor(env, prop))
}

function assertPositionAndRotation(group, prop) {
  const layout = render.propVisualLayout(prop)
  assert.equal(group.position.x, layout.x, `${prop.id}: координата X потеряна`)
  assert.equal(group.position.z, layout.y, `${prop.id}: координата Y карты не попала в Z`)
  assert.ok(Math.abs(group.rotation.y + prop.rotation * Math.PI / 180) < 1e-9, `${prop.id}: поворот потерян`)
  assert.equal(group.userData.assetId, prop.assetId, `${prop.id}: assetId потерян`)
  assert.equal(group.userData.modelKind, props3d.environmentModelKind(prop.assetId), `${prop.id}: вид модели расходится с каталогом`)
}

test('каждый canonical prop/decal из реестра получает известный вид 3D-модели', () => {
  assert.equal(CANONICAL_ASSETS.length, 105, 'ожидались все 90 prop и 15 decal')
  const unknown = CANONICAL_ASSETS.filter((asset) => {
    const kind = props3d.environmentModelKind(asset.id)
    return !kind || kind === 'generic' || kind === 'unknown'
  }).map((asset) => asset.id)
  assert.deepEqual(unknown, [], 'часть каталога не имеет 3D-представления')
})

test('все canonical prop/decal создаются с идентичностью, координатами и конечной геометрией', () => {
  const env = props3d.createEnvironmentModels(render.DEFAULT_BOARD_PALETTE)
  try {
    for (const [index, asset] of CANONICAL_ASSETS.entries()) {
      const prop = propFor(asset, index)
      const group = env.create(prop)
      assert.equal(group.name, `prop:${prop.id}`)
      assertPositionAndRotation(group, prop)
      finiteBox(group)
    }
  } finally {
    env.dispose()
  }
})

test('пустой футпринт сохраняет визуальный размер 2D, включая поворот', () => {
  const env = props3d.createEnvironmentModels(render.DEFAULT_BOARD_PALETTE)
  try {
    const rug = CANONICAL_ASSETS.find((asset) => asset.id === 'rug')
    assert.ok(rug)
    const straight = propFor(rug, 0, 0)
    const turned = propFor(rug, 1, 90)
    const straightBox = finiteBox(env.create(straight))
    const turnedBox = finiteBox(env.create(turned))
    assert.equal(render.propVisualLayout(straight).fromFootprint, false)
    assert.equal(render.propVisualLayout(turned).fromFootprint, false)
    assert.ok(straightBox.max.x - straightBox.min.x > (straightBox.max.z - straightBox.min.z) * 1.15, 'ковёр 3D потерял ширину 3×2')
    assert.ok(turnedBox.max.z - turnedBox.min.z > (turnedBox.max.x - turnedBox.min.x) * 1.15, 'поворот ковра не развернул его визуальный габарит')
  } finally {
    env.dispose()
  }
})

test('генераторы тем дают детерминированные props и совместимые 3D-дескрипторы', () => {
  const env = props3d.createEnvironmentModels(render.DEFAULT_BOARD_PALETTE)
  try {
    for (const themeId of GENERATOR_THEMES) {
      for (const seed of SEEDS) {
        const options = {
          themeId,
          seed,
          locationId: `board3d-generation-${themeId}`,
          width: themeId === 'ares-fortress' ? 36 : 26,
          height: themeId === 'ares-fortress' ? 36 : 26,
        }
        const first = buildThemedScene(options)
        const second = buildThemedScene(options)
        assert.ok(first.map.props.length > 0, `${themeId}/${seed}: генератор не создал реквизит`)
        assert.deepEqual(first.map.props, second.map.props, `${themeId}/${seed}: props недетерминированы`)
        assert.deepEqual(sceneDescriptor(first, env), sceneDescriptor(second, env), `${themeId}/${seed}: 3D-дескрипторы недетерминированы`)
        for (const prop of first.map.props) {
          const group = env.create(prop)
          assertPositionAndRotation(group, prop)
          finiteBox(group)
        }
      }
    }
  } finally {
    env.dispose()
  }
})

test('общая библиотека освобождает разделяемые ресурсы ровно один раз', () => {
  const env = props3d.createEnvironmentModels(render.DEFAULT_BOARD_PALETTE)
  const groups = CANONICAL_ASSETS.map((asset, index) => env.create(propFor(asset, index)))
  const resources = new Set()
  for (const group of groups) group.traverse((object) => {
    if (object.geometry) resources.add(object.geometry)
    if (object.material) {
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      materials.forEach((material) => {
        resources.add(material)
        for (const value of Object.values(material)) if (value?.isTexture) resources.add(value)
      })
    }
  })
  assert.ok(resources.size > 0)
  const disposed = new Map([...resources].map((resource) => [resource, 0]))
  for (const resource of resources) resource.addEventListener('dispose', () => disposed.set(resource, disposed.get(resource) + 1))
  env.dispose()
  env.dispose()
  assert.ok([...disposed.values()].every((count) => count === 1), 'разделяемый ресурс освобождён не ровно один раз')
})

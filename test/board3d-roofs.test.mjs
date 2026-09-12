import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { addZone, cellAt as serverCellAt, createTacticalMap, serializeTacticalMap, setCell, setEdge } from '../server/tactical-map.mjs'
import { buildThemedScene } from '../server/scene-themes.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const buildDir = mkdtempSync(join(root, 'tmp', 'board3d-roofs-test-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sources = ['../src/board3d-roofs.ts', '../src/board3d-scene.ts', '../src/board-render.ts', '../src/tactical-map-client.ts']
  .map((relative) => fileURLToPath(new URL(relative, import.meta.url)))
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
const roofs3d = await import(pathToFileURL(join(buildDir, 'board3d-roofs.mjs')).href)
const scene3d = await import(pathToFileURL(join(buildDir, 'board3d-scene.mjs')).href)
const mapClient = await import(pathToFileURL(join(buildDir, 'tactical-map-client.mjs')).href)
const render = await import(pathToFileURL(join(buildDir, 'board-render.mjs')).href)
const THREE = await import('three')
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

function mapFor({ theme = 'building', levelIndex = 0, hidden = null, seed = `roof-${theme}` } = {}) {
  const map = createTacticalMap({ width: 8, height: 7, seed, theme, levelIndex })
  addZone(map, { id: 'room', kind: 'interior', material: theme === 'crypt' ? 'stone' : 'wood', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Комната' })
  addZone(map, { id: 'walls', kind: 'interior', material: 'stone', lightLevel: 'dark', floorDirection: 'horizontal', label: '' })
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    setCell(map, x, y, { passable: false, material: 'stone', zone: 'walls', revealed: false })
  }
  for (let y = 1; y <= 5; y += 1) for (let x = 1; x <= 6; x += 1) {
    const isHidden = hidden?.x === x && hidden?.y === y
    setCell(map, x, y, { passable: true, material: theme === 'crypt' ? 'stone' : 'wood', zone: 'room', revealed: !isHidden })
  }
  for (let x = 1; x <= 6; x += 1) {
    setEdge(map, x, 1, x, 0, { kind: 'wall', blocksMove: true, blocksSight: true })
    setEdge(map, x, 5, x, 6, { kind: 'wall', blocksMove: true, blocksSight: true })
  }
  for (let y = 1; y <= 5; y += 1) {
    setEdge(map, 1, y, 0, y, { kind: 'wall', blocksMove: true, blocksSight: true })
    setEdge(map, 6, y, 7, y, { kind: 'wall', blocksMove: true, blocksSight: true })
  }
  return mapClient.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(map))))
}

function meshesNamed(root, prefix) {
  const matches = []
  root.traverse((object) => { if (object.name.startsWith(prefix)) matches.push(object) })
  return matches
}

function resourcesIn(root) {
  const resources = new Set()
  root.traverse((object) => {
    if (object.geometry) resources.add(object.geometry)
    if (object.material) {
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) resources.add(material)
    }
  })
  return resources
}

test('скатная крыша строится из видимой interior-zone и канонического контура стен', () => {
  const controller = roofs3d.createBoard3DRoofs(mapFor(), render.DEFAULT_BOARD_PALETTE, { wallHeight: .68 })
  try {
    const shell = controller.group.getObjectByName('roof-shells')
    const structure = controller.group.getObjectByName('roof-structures')
    const upperWalls = controller.group.getObjectByName('roof-upper-walls')
    assert.ok(shell && structure)
    assert.ok(upperWalls)
    assert.ok(meshesNamed(shell, 'roof-slope:').length >= 2, 'у скатной крыши должны быть два наклонных полотна')
    assert.ok(meshesNamed(structure, 'roof-ridge').length > 0, 'у крыши должен быть конёк')
    assert.ok(meshesNamed(structure, 'roof-eave:').length > 0, 'карниз следует контуру рёбер')
    assert.ok(meshesNamed(structure, 'roof-rafter:').length >= 2, 'в срезе должны оставаться узкие стропила')
    assert.ok(meshesNamed(upperWalls, 'roof-wall-upper:').length > 0, 'полная высота стены строится по рёбрам')
    const ridge = meshesNamed(structure, 'roof-ridge')[0]
    const rafter = meshesNamed(structure, 'roof-rafter:')[0]
    assert.equal(ridge.material.color.getHexString(), '594630', 'деревянный конёк приглушён')
    assert.equal(ridge.geometry.parameters.height, .095, 'конёк не выглядит debug-line')
    assert.equal(ridge.geometry.parameters.depth, .095, 'конёк имеет плотное сечение')
    assert.equal(rafter.material.color.getHexString(), '594630', 'стропила приглушены тёмным деревом')
    assert.equal(rafter.geometry.parameters.width, .09, 'стропило имеет плотное сечение по X')
    assert.equal(rafter.geometry.parameters.height, .09, 'стропило имеет плотное сечение по Y')
    const bounds = new THREE.Box3().setFromObject(shell)
    assert.ok(bounds.max.y - bounds.min.y > .2, 'скат не должен быть плоской заглушкой')
    shell.traverse((object) => {
      if (!object.isMesh) return
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      assert.ok(materials.every((material) => material.fog === true), `${object.name}: материал крыши обязан учитывать туман`)
      assert.equal(object.userData.board3dRoof, true, `${object.name}: mesh помечен как крыша`)
      assert.equal(object.userData.board3dPickable, false, `${object.name}: отдельная крыша не выбирается picker-ом`)
    })
    const far = controller.group.getObjectByName('roof-shell:far')
    const near = controller.group.getObjectByName('roof-shell:near')
    assert.equal(controller.getMode(), 'cutaway')
    assert.equal(shell.visible, false, 'непрозрачная оболочка крыши скрыта в срезе')
    assert.equal(far.visible, false, 'дальний скат тоже скрыт в срезе')
    assert.equal(near.visible, false, 'ближний скат скрыт в срезе')
    assert.equal(upperWalls.visible, false, 'верхняя часть стены скрыта в срезе')
    assert.equal(structure.visible, true, 'узкая конструкция крыши остаётся в срезе')
    controller.setMode('full')
    assert.equal(shell.visible, true)
    assert.equal(near.visible, true)
    assert.equal(upperWalls.visible, true)
    assert.ok(new THREE.Box3().setFromObject(upperWalls).max.y >= 1.8, 'полная стена доходит до карниза выше героя')
    controller.setMode('hidden')
    assert.equal(controller.group.visible, false)
    controller.setMode('cutaway')
    assert.equal(controller.group.visible, true)
  } finally {
    controller.dispose()
  }
})

test('обычные генераторы building, temple и crypt получают крыши из тех же зон и рёбер', () => {
  for (const themeId of ['building', 'temple', 'crypt']) {
    const generated = buildThemedScene({ themeId, seed: `roof-generator-${themeId}`, locationId: `roof-generator-${themeId}`, width: 26, height: 26 }).map
    for (let y = 0; y < generated.height; y += 1) for (let x = 0; x < generated.width; x += 1) {
      if (serverCellAt(generated, x, y)) setCell(generated, x, y, { revealed: true })
    }
    const map = mapClient.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(generated))))
    const controller = roofs3d.createBoard3DRoofs(map, render.DEFAULT_BOARD_PALETTE, { mode: 'full' })
    try {
      const roofs = meshesNamed(controller.group, 'roof-slope:').length + meshesNamed(controller.group, 'vault-shell').length
      assert.ok(roofs > 0, `${themeId}: генератор с каноническими зонами не получил крышу`)
      assert.ok(new THREE.Box3().setFromObject(controller.group).max.y > .6, `${themeId}: крыша не поднята над срезом стены`)
    } finally { controller.dispose() }
  }
})

test('полный вид и cutaway держат героя ростом 1.25 при камере 45° на трёх seed', () => {
  for (const seed of ['roof-seed-a', 'roof-seed-b', 'roof-seed-c']) {
    const generated = buildThemedScene({ themeId: 'building', seed, locationId: `roof-camera-${seed}`, width: 26, height: 26 }).map
    for (let y = 0; y < generated.height; y += 1) for (let x = 0; x < generated.width; x += 1) {
      if (serverCellAt(generated, x, y)) setCell(generated, x, y, { revealed: true })
    }
    const map = mapClient.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(generated))))
    const controller = roofs3d.createBoard3DRoofs(map, render.DEFAULT_BOARD_PALETTE, { mode: 'full' })
    try {
      const target = new THREE.Vector3(map.width / 2, 1.25, map.height / 2)
      const camera = new THREE.PerspectiveCamera(45, 1, .1, 200)
      camera.position.set(target.x + 12, target.y + 16, target.z + 12)
      camera.lookAt(target)
      camera.updateProjectionMatrix()
      const projected = target.clone().project(camera)
      assert.equal(projected.toArray().every(Number.isFinite), true, `${seed}: камера 45° не видит точку героя`)
      assert.ok(new THREE.Box3().setFromObject(controller.group).max.y > target.y, `${seed}: полный карниз должен быть выше героя`)
      const shells = controller.group.getObjectByName('roof-shells')
      assert.equal(shells.visible, true, `${seed}: полный вид показывает оболочку`)
      controller.setMode('cutaway')
      assert.equal(shells.visible, false, `${seed}: cutaway не закрывает игровое поле сплошным скатом`)
      assert.equal(controller.group.getObjectByName('roof-upper-walls')?.visible, false, `${seed}: cutaway скрывает верхние панели стен`)
      assert.equal(controller.group.getObjectByName('roof-structures')?.visible, true, `${seed}: cutaway сохраняет стропила`)
    } finally { controller.dispose() }
  }
})

test('свод склепа имеет криволинейную оболочку и каменные рёбра', () => {
  const controller = roofs3d.createBoard3DRoofs(mapFor({ theme: 'crypt', levelIndex: -1 }), render.DEFAULT_BOARD_PALETTE)
  try {
    const shell = controller.group.getObjectByName('vault-shell')
    const ribs = meshesNamed(controller.group, 'vault-rib:')
    assert.ok(shell, 'для crypt строится оболочка свода')
    assert.ok(ribs.length >= 2, 'свод получает поперечные каменные рёбра')
    assert.ok(shell.geometry.getAttribute('position').count >= 12 * 4 * 6, 'свод имеет сегментированную криволинейную форму')
    const bounds = new THREE.Box3().setFromObject(controller.group)
    assert.ok(bounds.max.y - bounds.min.y > .35, 'свод должен иметь подъём')
    const farShell = controller.group.getObjectByName('roof-vault:room:1,1,6,5')
    assert.equal(farShell?.visible, false, 'в cutaway оболочка свода скрывается, структура остаётся')
    assert.equal(ribs.every((mesh) => mesh.userData.board3dRoof === true), true)
  } finally {
    controller.dispose()
  }
})

test('скрытая клетка не порождает крышу и туман не раскрывается геометрией', () => {
  const hidden = { x: 3, y: 3 }
  const map = mapFor({ hidden })
  const controller = roofs3d.createBoard3DRoofs(map, render.DEFAULT_BOARD_PALETTE, { mode: 'full' })
  try {
    const hiddenPoint = new THREE.Vector3(hidden.x + .5, .72, hidden.y + .5)
    const roofObjects = []
    controller.group.traverse((object) => {
      if (object.isMesh && object.name.startsWith('roof-slope:')) roofObjects.push(object)
    })
    assert.ok(roofObjects.length > 0)
    assert.equal(roofObjects.some((object) => new THREE.Box3().setFromObject(object).containsPoint(hiddenPoint)), false, 'скат не должен закрывать туманную клетку')
    const scene = scene3d.createBoard3DScene(map, { roofMode: 'full' })
    try {
      assert.equal(scene.getRoofMode(), 'full')
      assert.equal(scene.getPropPickTargets().some((target) => target.object.userData.board3dRoof === true), false, 'крыши не попадают в picker')
    } finally { scene.dispose() }
  } finally {
    controller.dispose()
  }
})

test('освобождение крыш идемпотентно и не оставляет детей', () => {
  const controller = roofs3d.createBoard3DRoofs(mapFor(), render.DEFAULT_BOARD_PALETTE)
  const resources = resourcesIn(controller.group)
  const disposed = new Map([...resources].map((resource) => [resource, 0]))
  for (const resource of resources) resource.addEventListener('dispose', () => disposed.set(resource, disposed.get(resource) + 1))
  controller.dispose()
  controller.dispose()
  assert.equal(controller.group.children.length, 0)
  assert.ok([...disposed.values()].every((count) => count === 1), 'каждый ресурс крыши освобождён ровно один раз')
})

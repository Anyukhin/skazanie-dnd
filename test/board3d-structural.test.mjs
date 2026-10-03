import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { addZone, createTacticalMap, serializeTacticalMap, setCell, setEdge } from '../server/tactical-map.mjs'
import { createModel as createMineModel } from '../tools/map-detail-models-mine-camp.mjs'
import { createModel as createWildModel } from '../tools/map-detail-models-urban-wilderness.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const buildDir = mkdtempSync(join(root, 'tmp', 'board3d-structural-test-'))
const outputDir = join(buildDir, 'src')
mkdirSync(outputDir, { recursive: true })
mkdirSync(join(buildDir, 'server'), { recursive: true })
copyFileSync(join(root, 'server', 'circular-area-geometry.mjs'), join(buildDir, 'server', 'circular-area-geometry.mjs'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sources = [
  '../src/board3d-structural.ts', '../src/board3d-landscape.ts', '../src/board3d-walls.ts',
  '../src/board3d-style.ts', '../src/tactical-map-client.ts', '../src/board-render.ts',
].map((relative) => fileURLToPath(new URL(relative, import.meta.url)))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--rootDir', root, '--outDir', buildDir, ...sources,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
for (const name of readdirSync(outputDir)) {
  if (!name.endsWith('.js')) continue
  const path = join(outputDir, name)
  const source = readFileSync(path, 'utf8').replace(/(from\s+["'])(\.\/[^"']+)(["'])/g, '$1$2.mjs$3')
  writeFileSync(path.replace(/\.js$/u, '.mjs'), source)
  rmSync(path)
}
const structural = await import(pathToFileURL(join(outputDir, 'board3d-structural.mjs')).href)
const landscape = await import(pathToFileURL(join(outputDir, 'board3d-landscape.mjs')).href)
const walls = await import(pathToFileURL(join(outputDir, 'board3d-walls.mjs')).href)
const mapClient = await import(pathToFileURL(join(outputDir, 'tactical-map-client.mjs')).href)
const THREE = await import('three')
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

function structuralAssets(roles) {
  const models = new Map()
  const entries = roles.map((role) => ({
    key: `extra-${role}`, label: role, category: 'style-stylized', url: `props/extra_${role}.glb`,
    assetIds: [role], yaw: 0, source: 'style',
  }))
  for (const role of roles) {
    const root = new THREE.Group()
    // Реальные extra GLB имеют длинную собственную X-ось: мост 2.8×1×1.3,
    // настил 2.8×0.35×1.3. Асимметрия ловит случайный swap осей.
    const height = role === 'swamp_boardwalk' ? .35 : role === 'rope_bridge' ? 1 : 2
    root.add(new THREE.Mesh(new THREE.BoxGeometry(2.8, height, 1.3), new THREE.MeshBasicMaterial()))
    models.set(`extra-${role}`, root)
  }
  return { catalog: { version: 1, models: entries }, models }
}

function mapWithEdges({ theme = 'building', reveal = true } = {}) {
  const map = createTacticalMap({ width: 5, height: 4, theme, catalogRevision: null })
  addZone(map, { id: 'room', kind: 'interior', material: 'stone', wall: 'brick', floorDirection: 'horizontal', label: 'Кирпичная комната' })
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    setCell(map, x, y, { passable: true, material: 'stone', zone: 'room', revealed: reveal })
  }
  setEdge(map, 1, 1, 1, 0, { kind: 'door', doorId: 'door-1' })
  setEdge(map, 2, 1, 2, 0, { kind: 'window' })
  setEdge(map, 3, 1, 3, 0, { kind: 'rail', blocksMove: true })
  setEdge(map, 0, 0, 1, 0, { kind: 'wall' })
  setEdge(map, 0, 0, 0, 1, { kind: 'wall' })
  return mapClient.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(map))))
}

function stylePack() {
  const materials = Object.fromEntries(['stone', 'brick', 'plaster', 'planks', 'timber', 'log', 'metal'].map((key) => [key, {
    color: `materials/${key}/color.jpg`, metalness: 0, roughness: 1, doubleSided: true, aspect: 1,
  }]))
  const walls = Object.fromEntries(['stone', 'brick', 'plaster', 'planks', 'timber', 'log', 'iron'].map((key) => [key, { material: key === 'iron' ? 'metal' : key, cells: 1 }]))
  return { style: 'stylized', revision: '12345678', floors: {}, materials, walls, props: {} }
}

function loadTexture(_url, done) {
  const texture = new THREE.Texture()
  done()
  return texture
}

function packWithStructuralProps() {
  return {
    ...stylePack(),
    props: Object.fromEntries(structural.STRUCTURAL_ROLES.map((role) => [role, [{ key: `extra-${role}`, url: `props/extra_${role}.glb`, yaw: 0 }]])),
  }
}

test('структурный шаблон вписывается в якорь, поворачивается и не меняет shared template', () => {
  const assets = structuralAssets(['rope_bridge'])
  const template = assets.models.get('extra-rope_bridge')
  const instance = structural.structuralInstance(assets, {
    role: 'rope_bridge', x: 3, y: 4, z: 5, yaw: Math.PI / 2, width: 1, height: .5, depth: 2,
  })
  assert.ok(instance)
  assert.equal(instance.userData.board3dStructural, true)
  assert.equal(instance.userData.structuralRole, 'rope_bridge')
  assert.equal(template.children.length, 1)
  const bounds = new THREE.Box3().setFromObject(instance)
  const size = bounds.getSize(new THREE.Vector3())
  assert.ok(Math.abs(size.x - 2) < 1e-6 && Math.abs(size.z - 1) < 1e-6, 'поворот сохраняет целевые мировые оси')
  assert.ok(Math.abs(bounds.min.y - 4) < 1e-6 && Math.abs(bounds.max.y - 4.5) < 1e-6, 'основание модели совпадает с уровнем клетки')
})

function bridgeMap({ span, theme }) {
  const raw = createTacticalMap({ width: span === 'x' ? 7 : 4, height: span === 'x' ? 4 : 7, theme, catalogRevision: null })
  for (let y = 0; y < raw.height; y += 1) for (let x = 0; x < raw.width; x += 1) {
    const water = span === 'x'
      ? x >= 2 && x <= 4 && y !== 1 && y !== 2
      : (x === 0 || x === 3) && y >= 2 && y <= 4
    setCell(raw, x, y, { passable: !water, surface: water ? 'water' : 'none', material: water ? 'stone' : 'wood', revealed: true })
  }
  return mapClient.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(raw))))
}

test('мост использует собственные GLB-оси для обоих span и не меняет passability', () => {
  const cases = [
    { span: 'x', theme: 'swamp', role: 'swamp_boardwalk', yaw: 0, world: [0.98, 2] },
    { span: 'y', theme: 'swamp', role: 'swamp_boardwalk', yaw: Math.PI / 2, world: [2, 0.98] },
    { span: 'x', theme: 'building', role: 'rope_bridge', yaw: Math.PI / 2, world: [0.98, 2] },
    { span: 'y', theme: 'building', role: 'rope_bridge', yaw: 0, world: [2, 0.98] },
  ]
  for (const item of cases) {
    const map = bridgeMap(item)
    const before = map.layers.passable.slice()
    const assets = structuralAssets([item.role])
    assets.models.set(`extra-${item.role}`, item.role === 'rope_bridge' ? createMineModel(item.role) : createWildModel(item.role))
    const bridge = landscape.createBridgeRails(map, null, assets)
    assert.ok(bridge)
    assert.equal(bridge.group.userData.bridgeSource, 'style-models')
    const models = []
    bridge.group.traverse((object) => { if (object.name === `structural:${item.role}`) models.push(object) })
    assert.equal(models.length, landscape.bridgeModelStrips(map).length)
    assert.ok(models.every((model) => Math.abs(model.rotation.y - item.yaw) < 1e-6))
    const size = new THREE.Box3().setFromObject(models[0]).getSize(new THREE.Vector3())
    assert.ok(Math.abs(size.x - item.world[0]) < 1e-6 && Math.abs(size.z - item.world[1]) < 1e-6, 'модель не растягивается поперёк пролёта')
    const beam = models[0].getObjectByName(item.role === 'rope_bridge' ? 'bridge-upper-rope' : 'boardwalk-lag')
    assert.ok(beam, 'проверяется продольная деталь настоящего рецепта модели')
    const beamSize = new THREE.Box3().setFromObject(beam).getSize(new THREE.Vector3())
    assert.ok(item.span === 'x' ? beamSize.x > beamSize.z * 3 : beamSize.z > beamSize.x * 3,
      `${item.role}/${item.span}: канат или лага должны идти вдоль движения по мосту`)
    assert.deepEqual([...map.layers.passable], [...before])
    bridge.dispose()
    assert.equal(bridge.group.children.length, 0)
  }
})

test('служебная загрузка ограничивается ролями, у которых есть опора на карте', () => {
  const swamp = bridgeMap({ span: 'x', theme: 'swamp' })
  assert.deepEqual(landscape.structuralBridgeRolesForMap(swamp), ['swamp_boardwalk'])
  assert.deepEqual(landscape.structuralBridgeRolesForMap(mapWithEdges()), [])
  const edgeRoles = walls.structuralEdgeRolesForMap(mapWithEdges())
  assert.ok(edgeRoles.includes('ruin_wall_arch'))
  assert.ok(edgeRoles.includes('round_window_brick'))
  assert.ok(edgeRoles.includes('ornate_iron_fence'))
  const props = structural.structuralLoadProps(packWithStructuralProps(), edgeRoles)
  assert.deepEqual(props.map((prop) => prop.assetId), edgeRoles)
  assert.deepEqual(structural.structuralLoadProps(packWithStructuralProps(), []), [])
})

test('стены привязывают арку, окно, угол и ограду к раскрытым рёбрам, а hidden edge не даёт модели', () => {
  const assets = structuralAssets(['ruin_wall_arch', 'ruin_corner_brick', 'round_window_brick', 'ornate_iron_fence'])
  const map = mapWithEdges()
  const snapshot = () => JSON.stringify({ edges: map.edges, passable: [...map.layers.passable], revealed: [...map.layers.revealed] })
  const before = snapshot()
  const styled = walls.buildStyledEdges(map, stylePack(), {
    wallHeight: .95, thickness: 1 / 6, structuralAssets: assets, loadTexture,
  })
  const roles = []
  styled.group.traverse((object) => { if (object.userData.structuralRole) roles.push(object.userData.structuralRole) })
  assert.ok(roles.includes('ruin_wall_arch'))
  assert.ok(roles.includes('ruin_corner_brick'))
  assert.ok(roles.includes('round_window_brick'))
  assert.ok(roles.includes('ornate_iron_fence'))
  assert.equal(snapshot(), before, 'визуальный слой не меняет карту')
  styled.dispose()
  assert.equal(styled.group.children.length, 0)

  const hidden = walls.buildStyledEdges(mapWithEdges({ reveal: false }), stylePack(), {
    wallHeight: .95, thickness: 1 / 6, structuralAssets: assets, loadTexture,
  })
  assert.equal(hidden.group.getObjectByName('structural-edges'), undefined)
  hidden.dispose()
})

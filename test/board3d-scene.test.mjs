import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { addProp, createTacticalMap, serializeTacticalMap, setCell, setDoor, setEdge } from '../server/tactical-map.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const buildDir = mkdtempSync(join(root, 'tmp', 'board3d-scene-test-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sources = ['../src/board3d-scene.ts', '../src/board-render.ts', '../src/tactical-map-client.ts']
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
const scene3d = await import(pathToFileURL(join(buildDir, 'board3d-scene.mjs')).href)
const mapClient = await import(pathToFileURL(join(buildDir, 'tactical-map-client.mjs')).href)
const render = await import(pathToFileURL(join(buildDir, 'board-render.mjs')).href)
const THREE = await import('three')
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

function mapOf({ width = 4, height = 3, revealed = [], elevationAt = () => 0 } = {}) {
  const map = createTacticalMap({ width, height, seed: 'board3d-test', theme: 'building' })
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      setCell(map, x, y, {
        passable: true,
        material: (x + y) % 2 ? 'wood' : 'stone',
        elevation: elevationAt(x, y),
        revealed: revealed.some((point) => point.x === x && point.y === y),
      })
    }
  }
  return mapClient.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(map))))
}

function objectsNamed(root, prefix) {
  const matches = []
  root.traverse((object) => { if (object.name.startsWith(prefix)) matches.push(object) })
  return matches
}

test('3D-сцена создаёт пол только для раскрытых клеток', () => {
  const map = mapOf({ revealed: [{ x: 1, y: 1 }, { x: 2, y: 1 }] })
  const scene = scene3d.createBoard3DScene(map)
  const ground = scene.group.getObjectByName('ground-plane')
  assert.ok(ground, 'у сцены должен быть плоский грунт')
  assert.equal(ground.geometry.getAttribute('position').count, 8, 'две раскрытые клетки дают восемь вершин')
  assert.equal(ground.geometry.getAttribute('position').getY(0), 0, 'пол лежит на Y=0')
  assert.equal(ground.geometry.getAttribute('position').getX(0), 1, 'X карты сохраняется в мировом X')
  assert.equal(ground.geometry.getAttribute('position').getZ(0), 1, 'Y карты переводится в мировой Z')
  assert.ok(Math.abs(ground.geometry.getAttribute('uv').getY(0) - 2 / 3) < 1e-6, 'верх клетки карты использует верх текстуры')
  assert.ok(Math.abs(ground.geometry.getAttribute('uv').getY(1) - 1 / 3) < 1e-6, 'низ клетки карты продолжает ориентацию overlay')
  scene.dispose()
})

test('поверхность и обрывы используют высоту раскрытых клеток', () => {
  const map = mapOf({
    width: 3,
    height: 1,
    revealed: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
    elevationAt: (x) => [-2, 3, 1][x],
  })
  const scene = scene3d.createBoard3DScene(map)
  const ground = scene.group.getObjectByName('ground-plane')
  assert.ok(ground)
  const positions = ground.geometry.getAttribute('position')
  assert.ok([positions.getY(0), positions.getY(4), positions.getY(8)].every((value, index) => Math.abs(value - [-0.4, 0.6, 0.2][index]) < 1e-6))
  const sides = scene.group.getObjectByName('terrain-sides')
  assert.ok(sides, 'между клетками разной высоты нужен вертикальный обрыв')
  const sidePositions = sides.geometry.getAttribute('position')
  const sideHeights = Array.from({ length: sidePositions.count }, (_, index) => sidePositions.getY(index))
  assert.ok(Math.abs(Math.min(...sideHeights) + 0.52) < 1e-5)
  assert.ok(Math.abs(Math.max(...sideHeights) - 0.6) < 1e-6)
  scene.dispose()
})

test('дверь и предмет получают основание по высоте футпринта, включая отрицательный уровень', () => {
  const map = mapOf({
    width: 3,
    height: 1,
    revealed: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    elevationAt: (x) => x === 0 ? -2 : 5,
  })
  setDoor(map, { id: 'raised-door', x: 0, y: 0, dir: 'e', state: 'closed' })
  addProp(map, { id: 'raised-prop', assetId: 'crate', x: 0.5, y: 0.5, footprint: [{ x: 0, y: 0 }] })
  const scene = scene3d.createBoard3DScene(map)
  const ground = scene.group.getObjectByName('ground-plane')
  assert.ok(Math.abs(ground.geometry.getAttribute('position').getY(0) + 0.4) < 1e-6)
  const leaf = objectsNamed(scene.group, 'door-leaf:0,0,e:closed')[0]
  assert.ok(Math.abs(leaf.position.y - (1 + 0.58 / 2)) < 1e-6, 'дверь стоит на максимуме двух раскрытых сторон ребра')
  const prop = scene.group.getObjectByName('prop:raised-prop')
  assert.ok(Math.abs(prop.position.y + 0.4) < 1e-6, 'опора следует за видимой клеткой футпринта')
  scene.dispose()
})

test('высота скрытого соседа не поднимает видимое ребро', () => {
  const map = mapOf({
    width: 3,
    height: 1,
    revealed: [{ x: 1, y: 0 }],
    elevationAt: (x) => x === 2 ? 99 : x === 1 ? 2 : -4,
  })
  setDoor(map, { id: 'hidden-high-door', x: 1, y: 0, dir: 'e', state: 'closed' })
  const scene = scene3d.createBoard3DScene(map)
  const leaf = objectsNamed(scene.group, 'door-leaf:1,0,e:closed')[0]
  assert.ok(Math.abs(leaf.position.y - (0.4 + 0.58 / 2)) < 1e-6, 'туманная клетка не участвует в основании двери')
  const ground = scene.group.getObjectByName('ground-plane')
  assert.equal(ground.geometry.getAttribute('position').count, 4, 'скрытая высокая клетка не появляется на поверхности')
  scene.dispose()
})

test('граница появляется по раскрытой стороне, а скрытая стена и реквизит отсутствуют', () => {
  const map = mapOf({ revealed: [{ x: 1, y: 1 }] })
  setEdge(map, 0, 0, 1, 0, { kind: 'wall', blocksMove: true, blocksSight: true })
  setEdge(map, 1, 1, 2, 1, { kind: 'wall', blocksMove: true, blocksSight: true })
  addProp(map, { id: 'hidden-crate', assetId: 'crate', x: 0.5, y: 0.5 })
  addProp(map, { id: 'visible-barrel', assetId: 'barrel', x: 1.5, y: 1.5 })
  const scene = scene3d.createBoard3DScene(map)
  const wallMeshes = objectsNamed(scene.group, 'wall-segments:')
  assert.equal(wallMeshes.length, 1, 'стена у двух скрытых клеток не должна попасть в сцену')
  assert.equal(wallMeshes[0].count, 1, 'стена по раскрытой клетке видна целиком')
  assert.equal(objectsNamed(scene.group, 'prop:hidden-crate').length, 0)
  assert.ok(objectsNamed(scene.group, 'prop:visible-barrel').length > 0)
  scene.dispose()
})

test('дверь в открытом состоянии уходит в сторону, закрытая перекрывает проём', () => {
  const closedMap = mapOf({ revealed: [{ x: 1, y: 1 }, { x: 2, y: 1 }] })
  setDoor(closedMap, { id: 'door-closed', x: 1, y: 1, dir: 'e', state: 'closed' })
  const closed = scene3d.createBoard3DScene(closedMap)
  const closedLeaf = objectsNamed(closed.group, 'door-leaf:1,1,e:closed')[0]
  assert.ok(closedLeaf)
  assert.equal(closedLeaf.position.x, 2, 'закрытая створка стоит на границе клеток')
  const eastLintel = objectsNamed(closed.group, 'door-lintel:1,1,e')[0]
  assert.equal(eastLintel.geometry.parameters.width, 0.12, 'притолока восточной двери узкая по нормали')
  assert.equal(eastLintel.geometry.parameters.depth, 0.64, 'притолока восточной двери идёт вдоль Z')
  assert.equal(closedLeaf.geometry.parameters.width, 0.1, 'закрытое восточное полотно узкое по X')
  assert.equal(closedLeaf.geometry.parameters.depth, 0.58, 'закрытое восточное полотно идёт вдоль Z')

  const openMap = mapOf({ revealed: [{ x: 1, y: 1 }, { x: 2, y: 1 }] })
  setDoor(openMap, { id: 'door-open', x: 1, y: 1, dir: 'e', state: 'open' })
  const open = scene3d.createBoard3DScene(openMap)
  const openLeaf = objectsNamed(open.group, 'door-leaf:1,1,e:open')[0]
  assert.ok(openLeaf)
  assert.ok(openLeaf.position.x > 2, 'открытая створка отходит в соседнюю клетку')
  assert.ok(openLeaf.geometry.parameters.depth < openLeaf.geometry.parameters.width, 'открытая створка лежит вдоль стены')

  const southMap = mapOf({ revealed: [{ x: 1, y: 1 }, { x: 1, y: 2 }] })
  setDoor(southMap, { id: 'door-south', x: 1, y: 1, dir: 's', state: 'locked' })
  const south = scene3d.createBoard3DScene(southMap)
  const southLintel = objectsNamed(south.group, 'door-lintel:1,1,s')[0]
  const southLeaf = objectsNamed(south.group, 'door-leaf:1,1,s:locked')[0]
  const southLock = objectsNamed(south.group, 'door-lock:1,1,s')[0]
  assert.equal(southLintel.geometry.parameters.width, 0.64, 'притолока южной двери идёт вдоль X')
  assert.equal(southLintel.geometry.parameters.depth, 0.12, 'притолока южной двери узкая по нормали')
  assert.equal(southLeaf.geometry.parameters.width, 0.58, 'закрытое южное полотно идёт вдоль X')
  assert.equal(southLeaf.geometry.parameters.depth, 0.1, 'закрытое южное полотно узкое по Z')
  assert.equal(southLock.position.x, 1.5, 'замок южной двери не смещается вдоль полотна')
  assert.equal(southLock.position.z, 2.06, 'замок южной двери смещён по нормали')

  const brokenMap = mapOf({ revealed: [{ x: 1, y: 1 }, { x: 1, y: 2 }] })
  setDoor(brokenMap, { id: 'door-broken', x: 1, y: 1, dir: 's', state: 'broken' })
  const broken = scene3d.createBoard3DScene(brokenMap)
  const debris = objectsNamed(broken.group, 'door-debris:1,1,s')
  assert.equal(debris.length, 2)
  assert.ok(debris.every((piece) => piece.geometry.parameters.width > piece.geometry.parameters.depth), 'обломки южной двери идут вдоль X')
  assert.ok(debris.every((piece) => piece.position.z === 2), 'обломки южной двери остаются на ребре')
  closed.dispose()
  open.dispose()
  south.dispose()
  broken.dispose()
})

test('распознаваемый реквизит и локальный свет создаются только для видимой опоры', () => {
  const map = mapOf({ revealed: [{ x: 1, y: 1 }] })
  addProp(map, { id: 'crate', assetId: 'crate', x: 1.5, y: 1.5 })
  addProp(map, { id: 'tree', assetId: 'tree_oak', x: 1.5, y: 1.5 })
  addProp(map, { id: 'fire', assetId: 'campfire', x: 1.5, y: 1.5 })
  const scene = scene3d.createBoard3DScene(map, { lighting: true })
  assert.equal(scene.group.getObjectByName('prop:crate')?.userData.modelKind, 'crate')
  assert.equal(scene.group.getObjectByName('prop:tree')?.userData.modelKind, 'tree-oak')
  assert.equal(scene.group.getObjectByName('prop:fire')?.userData.modelKind, 'campfire')
  assert.ok(objectsNamed(scene.group, 'campfire-flame').length > 0)
  assert.equal(objectsNamed(scene.group, 'fire-light').length, 1)
  assert.ok(scene.group.getObjectByName('local-lights')?.children.every((light) => light instanceof THREE.PointLight))
  const fireLight = objectsNamed(scene.group, 'fire-light')[0]
  assert.equal(fireLight.position.x, 1.5, 'локальный свет стоит над костром по X')
  assert.ok(fireLight.position.y > 0 && fireLight.position.y < 1, 'локальный свет поднят над костром')
  assert.equal(fireLight.position.z, 1.5, 'локальный свет стоит над костром по Z')
  scene.dispose()
})

test('палитра темы проходит в 3D-пол, стены и двери', () => {
  const map = mapOf({ revealed: [{ x: 1, y: 1 }, { x: 2, y: 1 }] })
  setDoor(map, { id: 'palette-door', x: 1, y: 1, dir: 'e', state: 'closed' })
  const palette = { ...render.DEFAULT_BOARD_PALETTE, floor: '#102030', floorAlt: '#203040', wall: '#304050', door: '#405060', doorFrame: '#506070', lock: '#607080', rail: '#708090', ledge: '#8090a0' }
  const scene = scene3d.createBoard3DScene(map, { palette })
  const ground = scene.group.getObjectByName('ground-plane')
  const colors = ground.geometry.getAttribute('color')
  const groundColor = new THREE.Color(colors.getX(0), colors.getY(0), colors.getZ(0)).getHexString()
  const leaf = objectsNamed(scene.group, 'door-leaf:1,1,e:closed')[0]
  const frame = objectsNamed(scene.group, 'door-frame:1,1,e')[0]
  assert.notEqual(groundColor, new THREE.Color(render.DEFAULT_BOARD_PALETTE.floor).getHexString(), 'тема меняет цвет грунта')
  assert.equal(leaf.material.color.getHexString(), '405060', 'тема меняет полотно двери')
  assert.equal(frame.material.color.getHexString(), '506070', 'тема меняет раму двери')
  scene.dispose()
})

test('поворот крупного реквизита совпадает с 2D и применяется один раз', () => {
  const footprint = [1, 2, 3, 4].map((y) => ({ x: 2, y }))
  const map = mapOf({ width: 6, height: 6, revealed: footprint })
  addProp(map, {
    id: 'counter-rotated', assetId: 'bar_counter', x: 2.5, y: 1.5, rotation: 90, scale: 1,
    footprint,
  })
  const scene = scene3d.createBoard3DScene(map)
  const prop = scene.group.getObjectByName('prop:counter-rotated')
  assert.ok(prop)
  assert.equal(prop.position.x, 2.5, 'центр стойки совпадает с центром футпринта по X')
  assert.equal(prop.position.z, 3, 'центр стойки совпадает с центром футпринта по Z')
  assert.ok(Math.abs(prop.rotation.y + Math.PI / 2) < 1e-9, 'поворот Three.js учитывает направление оси карты')
  const geometry = new THREE.Box3().setFromObject(scene.group.getObjectByName('props'))
  assert.ok(geometry.max.z - geometry.min.z > (geometry.max.x - geometry.min.x) * 2, 'после поворота длинная стойка идёт вдоль вертикального футпринта')
  scene.dispose()
})

test('3D-фактура пола загружается по ключу и кэшируется между сценами', async () => {
  const previousDocument = globalThis.document
  const previousImage = globalThis.Image
  const previousFetch = globalThis.fetch
  let fetches = 0
  let images = 0
  const context = new Proxy({ globalAlpha: 1 }, {
    get(target, key) {
      if (key in target) return target[key]
      return () => undefined
    },
    set(target, key, value) {
      target[key] = value
      return true
    },
  })
  const canvas = () => ({ width: 1, height: 1, getContext: () => context })
  class FakeImage {
    naturalWidth = 512
    naturalHeight = 512
    decoding = 'async'
    onload
    onerror
    set src(value) {
      this.url = value
      images += 1
      queueMicrotask(() => this.onload?.())
    }
  }
  globalThis.document = { createElement: (name) => { assert.equal(name, 'canvas'); return canvas() } }
  globalThis.Image = FakeImage
  globalThis.fetch = async (url) => {
    fetches += 1
    assert.equal(url, '/assets/maps/terrain/terrain-tiles.json')
    return { ok: true, json: async () => ({ version: 'test', cellsPerTile: 8, floors: { stone: 'maps/terrain/floor-stone.png' }, surfaces: {}, walls: {} }) }
  }
  try {
    const map = mapOf({ width: 1, height: 1, revealed: [{ x: 0, y: 0 }] })
    const first = scene3d.createBoard3DScene(map)
    const firstGround = first.group.getObjectByName('ground-plane')
    const initialImage = firstGround.material.map.image
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.notEqual(firstGround.material.map.image, initialImage, 'загруженная фактура заменяет плоскую подложку')
    first.dispose()

    const second = scene3d.createBoard3DScene(map)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(fetches, 1, 'манифест читается один раз')
    assert.equal(images, 1, 'картинка фактуры читается один раз')
    second.dispose()
  } finally {
    globalThis.document = previousDocument
    globalThis.Image = previousImage
    globalThis.fetch = previousFetch
  }
})

test('3D-фактура не печатает высоту на уже поднятом полу, 2D сохраняет подпись', () => {
  const map = mapOf({ revealed: [{ x: 1, y: 1 }], elevationAt: (x, y) => x === 1 && y === 1 ? 2 : 0 })
  const calls = []
  const context = new Proxy({ fillText: (...args) => calls.push(args) }, {
    get(target, key) { return key in target ? target[key] : () => undefined },
    set(target, key, value) { target[key] = value; return true },
  })
  const base = { map, palette: render.DEFAULT_BOARD_PALETTE, cellSize: 32 }
  render.drawCellFeatures(context, base, { tileX: 0, tileY: 0 })
  assert.equal(calls.length, 1, 'обычная 2D-доска подписывает высоту')
  calls.length = 0
  render.drawCellFeatures(context, { ...base, showElevationLabels: false }, { tileX: 0, tileY: 0 })
  assert.equal(calls.length, 0, '3D-текстура не дублирует высоту текстом')
})

test('dispose освобождает созданные ресурсы и отменяет готовность поздней текстуры', () => {
  const map = mapOf({ revealed: [{ x: 1, y: 1 }] })
  const scene = scene3d.createBoard3DScene(map)
  const resources = []
  scene.group.traverse((object) => {
    if (object.geometry && !resources.includes(object.geometry)) resources.push(object.geometry)
    if (object.material && !resources.includes(object.material)) resources.push(object.material)
  })
  const disposed = new Map(resources.map((resource) => [resource, 0]))
  for (const resource of resources) resource.dispose = () => disposed.set(resource, disposed.get(resource) + 1)
  scene.dispose()
  assert.equal(scene.group.children.length, 0)
  assert.ok([...disposed.values()].every((count) => count === 1), 'каждый ресурс освобождается ровно один раз')
  scene.dispose()
})

test('поздняя загрузка artUrl после dispose не вызывает onReady и не добавляет mesh', () => {
  const previousDocument = globalThis.document
  let image
  const listeners = new Map()
  const fakeImage = {
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type) { listeners.delete(type) },
    set src(value) { this.url = value },
    width: 128,
    height: 128,
  }
  globalThis.document = {
    createElementNS(_namespace, name) {
      assert.equal(name, 'img')
      image = fakeImage
      return image
    },
  }
  let ready = 0
  try {
    const scene = scene3d.createBoard3DScene(mapOf({ revealed: [{ x: 1, y: 1 }] }), {
      artUrl: '/late-art.webp',
      onReady: () => { ready += 1 },
    })
    assert.equal(image.url, '/late-art.webp')
    scene.dispose()
    listeners.get('load')?.call(image)
    assert.equal(ready, 0)
    assert.equal(scene.group.children.length, 0)
  } finally {
    globalThis.document = previousDocument
  }
})

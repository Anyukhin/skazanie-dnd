import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { addProp, createTacticalMap, serializeTacticalMap, setCell, setDoor, setEdge } from '../server/tactical-map.mjs'
import { publicTacticalMapFor } from '../server/viewer-projection.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const buildDir = mkdtempSync(join(root, 'tmp', 'board3d-scene-test-'))
const outputDir = join(buildDir, 'src')
mkdirSync(outputDir, { recursive: true })
mkdirSync(join(buildDir, 'server'), { recursive: true })
copyFileSync(join(root, 'server', 'circular-area-geometry.mjs'), join(buildDir, 'server', 'circular-area-geometry.mjs'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sources = ['../src/board3d-scene.ts', '../src/board-render.ts', '../src/tactical-map-client.ts']
  .map((relative) => fileURLToPath(new URL(relative, import.meta.url)))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--rootDir', root, '--outDir', buildDir, ...sources,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
for (const name of readdirSync(outputDir)) {
  if (!name.endsWith('.js')) continue
  const source = readFileSync(join(outputDir, name), 'utf8')
    .replace(/(from\s+["'])(\.\/[^"']+)(["'])/g, '$1$2.mjs$3')
  writeFileSync(join(outputDir, name.replace(/\.js$/, '.mjs')), source)
  rmSync(join(outputDir, name))
}
const scene3d = await import(pathToFileURL(join(outputDir, 'board3d-scene.mjs')).href)
const mapClient = await import(pathToFileURL(join(outputDir, 'tactical-map-client.mjs')).href)
const render = await import(pathToFileURL(join(outputDir, 'board-render.mjs')).href)
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

/** Наибольший подъём верха плитки (`TILE_JITTER` в src/board3d-landscape.ts). */
const TILE_JITTER = 0.012
/** Высота дверного полотна: стена 0.95 минус притолока (`board3d-scene.ts`). */
const DOOR_LEAF_HEIGHT = 0.82

test('3D-сцена создаёт пол только для раскрытых клеток', () => {
  const map = mapOf({ revealed: [{ x: 1, y: 1 }, { x: 2, y: 1 }] })
  const scene = scene3d.createBoard3DScene(map)
  const ground = scene.group.getObjectByName('ground-plane')
  assert.ok(ground, 'у сцены должен быть грунт')
  const positions = ground.geometry.getAttribute('position')
  const uvs = ground.geometry.getAttribute('uv')
  // Плитка: четыре вершины плоского верха и восемь — кольцо фаски до шва.
  assert.equal(positions.count, 24, 'две раскрытые клетки дают по двенадцать вершин плитки')
  const top = positions.getY(0)
  assert.ok(top >= 0 && top <= TILE_JITTER, 'верх плитки лежит на уровне клетки с допуском на подъём')
  assert.ok(positions.getX(0) > 1 && positions.getX(0) < 1.1, 'X карты сохраняется в мировом X, верх отступает на фаску')
  assert.ok(positions.getZ(0) > 1 && positions.getZ(0) < 1.1, 'Y карты переводится в мировой Z')
  for (let index = 0; index < positions.count; index += 1) {
    assert.ok(Math.abs(uvs.getX(index) - positions.getX(index) / 4) < 1e-6, 'UV по мировому X: рисунок пола ложится непрерывно')
    assert.ok(Math.abs(uvs.getY(index) - (1 - positions.getZ(index) / 3)) < 1e-6, 'UV по мировому Z сохраняет ориентацию overlay')
    assert.ok(positions.getX(index) >= 1 - 1e-9 && positions.getX(index) <= 3 + 1e-9, 'скрытые клетки не дают вершин')
  }
  assert.ok(Math.min(...Array.from({ length: positions.count }, (_, index) => positions.getY(index))) < 0, 'кромка плитки опущена в шов')
  scene.dispose()
})

test('нераскрытые клетки накрыты плитой тумана, а не дырой в столе', () => {
  const map = mapOf({ revealed: [{ x: 1, y: 1 }, { x: 2, y: 1 }] })
  const scene = scene3d.createBoard3DScene(map)
  const fog = scene.group.getObjectByName('fog-cap')
  assert.ok(fog, 'у нераскрытой области нет плиты тумана')
  const positions = fog.geometry.getAttribute('position')
  const present = map.width * map.height
  assert.equal(positions.count, (present - 2) * 4, 'по квадрату на каждую существующую нераскрытую клетку')
  for (let index = 0; index < positions.count; index += 1) {
    assert.equal(positions.getY(index), 0, 'плита ровная: туман не выдаёт высоты и планировку')
    const x = positions.getX(index)
    const z = positions.getZ(index)
    assert.ok(!(x > 1 && x < 3 && z > 1 && z < 2), 'раскрытые клетки туманом не накрываются')
  }
  scene.dispose()
  const open = scene3d.createBoard3DScene(mapOf({ revealed: Array.from({ length: map.width * map.height }, (_, index) => ({ x: index % map.width, y: Math.floor(index / map.width) })) }))
  assert.equal(open.group.getObjectByName('fog-cap'), undefined, 'раскрытая карта тумана не получает')
  open.dispose()
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
  assert.ok([positions.getY(0), positions.getY(12), positions.getY(24)].every((value, index) => value - [-0.4, 0.6, 0.2][index] >= 0 && value - [-0.4, 0.6, 0.2][index] <= TILE_JITTER))
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
  const groundTop = ground.geometry.getAttribute('position').getY(0)
  assert.ok(groundTop + 0.4 >= 0 && groundTop + 0.4 <= TILE_JITTER)
  const leaf = objectsNamed(scene.group, 'door-leaf:0,0,e:closed')[0]
  assert.ok(Math.abs(leaf.position.y - (1 + DOOR_LEAF_HEIGHT / 2)) < 1e-6, 'дверь стоит на максимуме двух раскрытых сторон ребра')
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
  assert.ok(Math.abs(leaf.position.y - (0.4 + DOOR_LEAF_HEIGHT / 2)) < 1e-6, 'туманная клетка не участвует в основании двери')
  const ground = scene.group.getObjectByName('ground-plane')
  assert.equal(ground.geometry.getAttribute('position').count, 12, 'скрытая высокая клетка не появляется на поверхности')
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

test('отделка среза есть только у видимых стен и не закрывает дверной проём', () => {
  const map = mapOf({ revealed: [{ x: 1, y: 1 }, { x: 2, y: 1 }] })
  setEdge(map, 1, 1, 2, 1, { kind: 'wall', blocksMove: true, blocksSight: true })
  setEdge(map, 1, 1, 1, 0, { kind: 'wall', blocksMove: true, blocksSight: true })
  setEdge(map, 0, 0, 1, 0, { kind: 'wall', blocksMove: true, blocksSight: true })
  setDoor(map, { id: 'trim-door', x: 2, y: 1, dir: 'e', state: 'open' })
  const scene = scene3d.createBoard3DScene(map)
  try {
    const caps = objectsNamed(scene.group, 'wall-cap:')
    const posts = objectsNamed(scene.group, 'corner-post:')
    const beams = objectsNamed(scene.group, 'wall-beam:')
    const cuts = objectsNamed(scene.group, 'wall-cut:')
    assert.equal(caps.reduce((sum, mesh) => sum + mesh.count, 0), 2, 'срезы видимых стен получают верхние caps')
    assert.ok(posts.length > 0, 'стык видимой стены получает corner post')
    assert.equal(beams.reduce((sum, mesh) => sum + mesh.count, 0), 1, 'ограниченная балка появляется на открытом срезе')
    assert.equal(cuts.reduce((sum, mesh) => sum + mesh.count, 0), 1, 'лицевой срез появляется на открытом срезе')
    assert.equal(objectsNamed(scene.group, 'door-trim:').length, 3, 'дверная отделка состоит из двух стоек и притолоки')
    assert.ok(objectsNamed(scene.group, 'door-leaf:2,1,e:open').length > 0, 'открытый проём сохраняет створку вне прохода')
  } finally { scene.dispose() }
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

test('pointLightShadows управляет только тенями локальных PointLight', () => {
  const map = mapOf({ revealed: [{ x: 1, y: 1 }] })
  addProp(map, { id: 'shadow-fire', assetId: 'campfire', x: 1.5, y: 1.5 })
  const enabled = scene3d.createBoard3DScene(map, { lighting: true })
  const disabled = scene3d.createBoard3DScene(map, { lighting: true, pointLightShadows: false })
  try {
    const on = objectsNamed(enabled.group, 'fire-light')[0]
    const off = objectsNamed(disabled.group, 'fire-light')[0]
    assert.equal(on.castShadow, true)
    assert.equal(off.castShadow, false)
    assert.ok(on.shadow.bias < 0 && on.shadow.normalBias > 0, 'тень огня смещена против самозатенения на карте 256')
    assert.equal(enabled.group.getObjectByName('ground-plane').castShadow, false)
    assert.equal(disabled.group.getObjectByName('ground-plane').castShadow, false)
  } finally { enabled.dispose(); disabled.dispose() }
})

test('picker возвращает propId ближайшего интерактивного реквизита и скрытый не выбирается', () => {
  const source = createTacticalMap({ width: 4, height: 2, seed: 'prop-picker' })
  for (let y = 0; y < 2; y += 1) for (let x = 0; x < 4; x += 1) setCell(source, x, y, { passable: true, revealed: true })
  setCell(source, 3, 0, { revealed: false })
  addProp(source, { id: 'visible-chest', assetId: 'chest', x: 1.5, y: .5, footprint: [{ x: 1, y: 0 }] })
  addProp(source, { id: 'hidden-chest', assetId: 'chest', x: 3.5, y: .5, footprint: [{ x: 3, y: 0 }] })
  const map = mapClient.decodeTacticalMap(publicTacticalMapFor(serializeTacticalMap(source)))
  assert.ok(map)
  const scene = scene3d.createBoard3DScene(map)
  try {
    const targets = scene.getPropPickTargets()
    assert.deepEqual(targets.map((target) => target.propId), ['visible-chest'])
    const ray = new THREE.Ray(new THREE.Vector3(1.5, 10, .5), new THREE.Vector3(0, -1, 0))
    assert.equal(scene3d.nearestPropPickTarget(ray, targets)?.propId, 'visible-chest')
    assert.equal(targets[0].object.userData.propId, 'visible-chest')
  } finally { scene.dispose() }
})

test('процедурные chest и sarcophagus показывают open/taken как откинутую крышку', () => {
  const map = mapOf({ width: 4, height: 2, revealed: [{ x: 1, y: 0 }, { x: 2, y: 0 }] })
  addProp(map, { id: 'closed-chest', assetId: 'chest', x: 1.5, y: .5, footprint: [{ x: 1, y: 0 }], state: 'closed' })
  addProp(map, { id: 'open-sarcophagus', assetId: 'sarcophagus', x: 2.5, y: .5, footprint: [{ x: 2, y: 0 }], state: 'taken' })
  const scene = scene3d.createBoard3DScene(map)
  try {
    const closedHinge = scene.group.getObjectByName('prop:closed-chest')?.getObjectByName('hinge-lid')
    const openHinge = scene.group.getObjectByName('prop:open-sarcophagus')?.getObjectByName('hinge-lid')
    assert.ok(closedHinge && openHinge)
    assert.equal(closedHinge.rotation.x, 0)
    assert.equal(openHinge.rotation.x, -Math.PI / 2)
  } finally { scene.dispose() }
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
  setEdge(map, 1, 1, 1, 0, { kind: 'wall', blocksMove: true, blocksSight: true })
  setDoor(map, { id: 'dispose-door', x: 1, y: 1, dir: 'e', state: 'open' })
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

const landscape = await import(pathToFileURL(join(outputDir, 'board3d-landscape.mjs')).href)

function terrainMap({ width, height, cell }) {
  const map = createTacticalMap({ width, height, seed: 'landscape-test', theme: 'forest' })
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    setCell(map, x, y, { passable: true, material: 'grass', revealed: true, ...cell(x, y) })
  }
  return mapClient.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(map))))
}

test('вода: дно опущено, гладь — отдельной прозрачной поверхностью, пена только у берега', () => {
  const water = { passable: false, surface: 'water' }
  const map = terrainMap({ width: 5, height: 3, cell: (x) => x >= 1 && x <= 3 ? water : {} })
  const scene = scene3d.createBoard3DScene(map)
  const ground = scene.group.getObjectByName('ground-plane')
  const positions = ground.geometry.getAttribute('position')
  // Клетка (1,0) — вторая по обходу: двенадцать вершин на плитку.
  assert.ok(Math.abs(positions.getY(12) + landscape.WATER_BED_DEPTH) < 1e-6, 'дно воды ниже уровня клетки')
  const surface = scene.group.getObjectByName('water-surface')
  assert.ok(surface, 'над водой есть гладь')
  assert.ok(surface.material.transparent, 'гладь полупрозрачна')
  assert.equal(surface.geometry.getAttribute('position').count, 9 * 4)
  const shore = surface.geometry.getAttribute('shore')
  const shoreAt = (cx, cz) => {
    for (let index = 0; index < shore.count; index += 1) {
      const p = surface.geometry.getAttribute('position')
      if (p.getX(index) === cx && p.getZ(index) === cz) return shore.getX(index)
    }
    return null
  }
  assert.equal(shoreAt(1, 1), 1, 'угол у суши — берег')
  assert.equal(shoreAt(2, 1), 0, 'середина русла — без пены')
  assert.equal(scene.animated, true, 'вода рябит, пока доска её рисует')
  scene.dispose()
  const calm = scene3d.createBoard3DScene(map, { landscapeDetail: 'minimal' })
  assert.equal(calm.animated, false, 'на «Экономном» вода стоит')
  calm.dispose()
})

test('скала, кладка и стена: порода пещеры — скала, тонкая стена дома — кладка', () => {
  // Пещера: проход по средней строке, вокруг порода; зоны пещеры — interior.
  const cave = terrainMap({ width: 6, height: 5, cell: (x, y) => y === 2 ? { material: 'earth' } : { passable: false, material: 'earth' } })
  assert.equal(landscape.isRockCell(cave, 2, 1), true)
  assert.equal(landscape.isRockCore(cave, 2, 0), true, 'толща — все соседи камень')
  assert.equal(landscape.isRockCore(cave, 2, 1), false, 'кромка — рядом проход')
  // Дом: помещение 1×1, кольцо стен, снаружи улица.
  const raw = createTacticalMap({ width: 5, height: 5, seed: 'house', theme: 'building' })
  raw.zones.push({ id: 'home', kind: 'interior', material: 'wood', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Дом' })
  for (let y = 0; y < 5; y += 1) for (let x = 0; x < 5; x += 1) {
    const ring = x >= 1 && x <= 3 && y >= 1 && y <= 3 && !(x === 2 && y === 2)
    setCell(raw, x, y, { passable: !ring, material: 'wood', revealed: true, zone: x === 2 && y === 2 ? 'home' : '' })
  }
  const house = mapClient.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(raw))))
  assert.equal(landscape.isMasonryCell(house, 1, 2), true, 'стена дома — кладка')
  assert.equal(landscape.isMasonryCell(house, 1, 1), true, 'угол дома касается помещения по диагонали')
  assert.equal(landscape.isRockCell(house, 1, 2), false)
  const rocks = landscape.createRockClusters(cave, 'full')
  assert.ok(rocks.group.children.length > 0)
  const again = landscape.createRockClusters(cave, 'full')
  const matrix = (group) => Array.from(group.children[0].instanceMatrix.array).slice(0, 16).join(',')
  assert.equal(matrix(rocks.group), matrix(again.group), 'раскладка камня детерминирована')
  rocks.dispose(); again.dispose()
})

test('стена вдоль скалы не рисуется тонкой стенкой: её роль играет порода', () => {
  const raw = createTacticalMap({ width: 4, height: 3, seed: 'cave-wall', theme: 'cave' })
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 4; x += 1) setCell(raw, x, y, { passable: y === 1, material: 'stone', revealed: true })
  setEdge(raw, 1, 0, 1, 1, { kind: 'wall', blocksMove: true, blocksSight: true })
  const map = mapClient.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(raw))))
  const scene = scene3d.createBoard3DScene(map)
  const wallInstances = objectsNamed(scene.group, 'wall-segments:').reduce((sum, mesh) => sum + (mesh.count ?? 1), 0)
  assert.equal(wallInstances, 0)
  assert.ok(scene.group.getObjectByName('landscape-rocks'))
  scene.dispose()
})

test('мост: полоса настила через воду получает перила, берег — нет', () => {
  // Река по x=2..4, мост в две строки (y=1..2) поперёк неё.
  const map = terrainMap({ width: 7, height: 4, cell: (x, y) => x >= 2 && x <= 4 && !(y === 1 || y === 2) ? { passable: false, surface: 'water' } : x >= 2 && x <= 4 ? { material: 'wood' } : {} })
  assert.equal(landscape.bridgeSpan(map, 3, 1), 'x')
  assert.equal(landscape.bridgeSpan(map, 3, 2), 'x')
  assert.equal(landscape.bridgeSpan(map, 1, 0), null, 'берег не мост')
  const rails = landscape.createBridgeRails(map)
  assert.ok(rails && rails.group.children[0].count > 0)
  rails.dispose()
})

test('трава только на свободных травяных клетках и не на «Экономном»', () => {
  const map = terrainMap({ width: 4, height: 2, cell: (x) => x === 3 ? { material: 'stone' } : {} })
  assert.equal(landscape.createGrassTufts(map, [], 'minimal'), null)
  const full = landscape.createGrassTufts(map, [{ x: 0.5, y: 0.5, footprint: [{ x: 0, y: 0 }] }], 'full')
  const mesh = full.group.children[0]
  const position = new THREE.Vector3()
  for (let index = 0; index < mesh.count; index += 1) {
    mesh.getMatrixAt(index, new THREE.Matrix4()).decompose(position, new THREE.Quaternion(), new THREE.Vector3())
    assert.ok(Math.floor(position.x) < 3, 'на камне травы нет')
    assert.ok(!(Math.floor(position.x) === 0 && Math.floor(position.z) === 0), 'под предметом травы нет')
  }
  full.dispose()
})

const masonry = await import(pathToFileURL(join(outputDir, 'board3d-masonry.mjs')).href)

test('кладка: камни вразбежку в пределах прогона, плахи у дерева, без теней от камней', () => {
  const run = { x: 2, z: 3.5, y: 0, length: 1, thickness: 1 / 6, height: .95, alongX: true, color: '#8a8378', seed: 7 }
  const stone = masonry.createMasonryDressing([{ ...run, style: 'stone' }])
  const mesh = stone.group.children[0]
  assert.ok(stone.count >= 10, 'стена в клетку сложена из рядов камней')
  assert.equal(mesh.castShadow, false, 'тень даёт тело стены, камни в карты теней не идут')
  const position = new THREE.Vector3(), scale = new THREE.Vector3()
  for (let index = 0; index < mesh.count; index += 1) {
    mesh.getMatrixAt(index, new THREE.Matrix4()).decompose(position, new THREE.Quaternion(), scale)
    assert.ok(position.x - scale.x / 2 >= 1.5 - .03 && position.x + scale.x / 2 <= 2.5 + .03, 'камень не выходит за ребро клетки')
    assert.ok(position.y > 0 && position.y < .95, 'камень в пределах высоты стены')
  }
  const again = masonry.createMasonryDressing([{ ...run, style: 'stone' }])
  assert.deepEqual(Array.from(again.group.children[0].instanceMatrix.array), Array.from(mesh.instanceMatrix.array), 'рисунок кладки детерминирован')
  const wood = masonry.createMasonryDressing([{ ...run, style: 'wood' }])
  assert.equal(wood.group.children[0].name, 'masonry:wood')
  stone.dispose(); again.dispose(); wood.dispose()
  assert.equal(masonry.masonryStyleFor('wood'), 'wood')
  assert.equal(masonry.masonryStyleFor('marble'), 'stone')
})

test('«Экономное»: стены без отдельных камней кладки', () => {
  const map = mapOf({ revealed: [{ x: 1, y: 1 }, { x: 2, y: 1 }] })
  setEdge(map, 1, 1, 2, 1, { kind: 'wall', blocksMove: true, blocksSight: true })
  const full = scene3d.createBoard3DScene(map, { landscapeDetail: 'full' })
  const low = scene3d.createBoard3DScene(map, { landscapeDetail: 'minimal' })
  assert.ok(full.group.getObjectByName('wall-masonry'))
  assert.equal(low.group.getObjectByName('wall-masonry'), undefined)
  full.dispose(); low.dispose()
})

// Набор моделей местности: tools/build-landscape-kit.mjs → public/assets/models/landscape.
const landscapeAssets = await import(pathToFileURL(join(outputDir, 'landscape-model-assets.mjs')).href)
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
const { createHash } = await import('node:crypto')
const { existsSync, statSync } = await import('node:fs')
const landscapeRoot = join(root, 'public', 'assets', 'models', 'landscape')

function landscapeManifest() {
  return landscapeAssets.validateLandscapeManifest(JSON.parse(readFileSync(join(landscapeRoot, 'manifest.json'), 'utf8')))
}

/** Собирает набор из GLB на диске так же, как клиент: узел по имени, приведение к клетке. */
async function landscapeKitFromDisk() {
  const manifest = landscapeManifest()
  const previousSelf = globalThis.self
  const previousCreateImageBitmap = globalThis.createImageBitmap
  // Node не декодирует PNG: геометрии хватает заглушки ImageBitmap.
  globalThis.self = globalThis
  globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} })
  try {
    const scenes = new Map()
    const models = []
    for (const entry of manifest.models) {
      if (!scenes.has(entry.url)) {
        const bytes = readFileSync(join(root, 'public', entry.url))
        const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
        scenes.set(entry.url, gltf.scene)
      }
      const node = scenes.get(entry.url).getObjectByName(entry.node)
      assert.ok(node, `${entry.key}: в ${entry.url} нет узла ${entry.node}`)
      const normalized = landscapeAssets.normalizeLandscapeNode(node)
      assert.ok(normalized, `${entry.key}: модель не приводится к клетке`)
      models.push({ key: entry.key, role: entry.role, parts: normalized.parts, size: normalized.size })
    }
    return { revision: manifest.revision, models }
  } finally {
    if (previousSelf === undefined) delete globalThis.self
    else globalThis.self = previousSelf
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap
    else globalThis.createImageBitmap = previousCreateImageBitmap
  }
}

test('набор местности: манифест валиден, файлы на месте, хеши и происхождение совпадают', () => {
  const manifest = landscapeManifest()
  const directory = join(landscapeRoot, manifest.revision)
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')), JSON.parse(readFileSync(join(landscapeRoot, 'manifest.json'), 'utf8')),
    'активный манифест совпадает с манифестом неизменяемой ревизии')
  const roles = new Set(manifest.models.map((entry) => entry.role))
  for (const role of ['rock', 'cliff', 'lily', 'reed', 'bridge']) assert.ok(roles.has(role), `в наборе есть роль ${role}`)
  const notice = JSON.parse(readFileSync(join(directory, 'NOTICE.json'), 'utf8'))
  assert.equal(notice.revision, manifest.revision)
  assert.ok(notice.sources.every((source) => source.license === 'CC0-1.0' && /^[a-f0-9]{64}$/.test(source.archiveSha256)), 'источники — CC0 с хешем архива')
  let total = 0
  for (const url of new Set(manifest.models.map((entry) => entry.url))) {
    const file = join(root, 'public', url)
    assert.ok(existsSync(file), `${url} существует`)
    const bytes = readFileSync(file)
    total += bytes.length
    const sha = createHash('sha256').update(bytes).digest('hex')
    assert.ok(manifest.models.filter((entry) => entry.url === url).every((entry) => entry.sha256 === sha), `${url}: SHA-256 в манифесте совпадает`)
    assert.ok(notice.files.some((item) => url.endsWith(`/${item.path}`) && item.sha256 === sha && item.bytes === statSync(file).size), `${url}: записан в NOTICE`)
    const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'))
    assert.ok(!JSON.stringify(json).includes('"uri"'), `${url}: без внешних ссылок`)
  }
  assert.ok(total <= 4 * 1024 * 1024, `набор не больше 4 МБ (${total})`)
  assert.throws(() => landscapeAssets.validateLandscapeManifest({ ...manifest, models: [{ ...manifest.models[0], url: '/assets/models/landscape/other/rocks.glb' }] }),
    'файл вне объявленной ревизии отвергается')
  assert.throws(() => landscapeAssets.validateLandscapeManifest({ ...manifest, models: [{ ...manifest.models[0], role: 'tree' }] }), 'неизвестная роль отвергается')
})

test('набор местности: модели приводятся к клетке, вариант выбирается детерминированно', async () => {
  const kit = await landscapeKitFromDisk()
  for (const model of kit.models) {
    assert.ok(Math.abs(Math.max(model.size.x, model.size.z) - 1) < 1e-6, `${model.key}: большая сторона основания — одна клетка`)
    const bottom = Math.min(...model.parts.map((part) => part.geometry.boundingBox.min.y))
    assert.ok(Math.abs(bottom) < 1e-6, `${model.key}: низ модели на y = 0`)
  }
  assert.equal(landscapeAssets.pickLandscapeVariant([], .3), null)
  assert.equal(landscapeAssets.pickLandscapeVariant(['a', 'b', 'c'], .99), 'c')
  assert.equal(landscapeAssets.pickLandscapeVariant(['a', 'b', 'c'], .34), 'b')
  const rocks = landscape.landscapeRockModels(kit)
  assert.ok(rocks.boulders.length >= 3 && rocks.slabs.length >= 1 && rocks.cliffs.length >= 2, 'глыбы, плиты и толща различаются по форме и роли')
})

test('скалы и мост из моделей набора; без набора — процедурный запасной вариант', async () => {
  const kit = await landscapeKitFromDisk()
  const cave = terrainMap({ width: 8, height: 7, cell: (x, y) => y === 3 ? { material: 'stone' } : { passable: false, material: 'stone' } })
  const procedural = landscape.createRockClusters(cave, 'full')
  assert.equal(procedural.group.userData.rockSource, 'procedural')
  const modelled = landscape.createRockClusters(cave, 'full', .95, kit)
  assert.equal(modelled.group.userData.rockSource, 'models')
  const meshes = objectsNamed(modelled.group, 'landscape-model')
  assert.ok(meshes.length > 0 && meshes.every((mesh) => mesh.isInstancedMesh && mesh.castShadow), 'камни — InstancedMesh с тенью')
  const kitGeometries = new Set(kit.models.flatMap((model) => model.parts.map((part) => part.geometry)))
  assert.ok(meshes.every((mesh) => kitGeometries.has(mesh.geometry)), 'геометрия общая с набором, не копируется на экземпляр')
  const again = landscape.createRockClusters(cave, 'full', .95, kit)
  const layout = (group) => objectsNamed(group, 'landscape-model')
    .map((mesh) => `${mesh.geometry.uuid}:${Array.from(mesh.instanceMatrix.array).map((value) => value.toFixed(5)).join(',')}`).sort().join('|')
  assert.equal(layout(modelled.group), layout(again.group), 'выбор варианта и поворот детерминированы шумом клетки')
  // dispose освобождает производные материалы слоя, но не геометрию набора.
  let disposedGeometry = 0
  for (const geometry of kitGeometries) geometry.addEventListener('dispose', () => { disposedGeometry += 1 })
  let disposedMaterials = 0
  for (const mesh of meshes) mesh.material.addEventListener('dispose', () => { disposedMaterials += 1 })
  modelled.dispose(); again.dispose(); procedural.dispose()
  assert.equal(disposedGeometry, 0, 'геометрии набора живут, пока набор взят')
  assert.ok(disposedMaterials > 0, 'производные материалы слоя освобождены')
  // Валун кромки и глыба толщи вписаны в одну-две клетки.
  const edge = landscape.createRockClusters(cave, 'minimal', .95, kit)
  const position = new THREE.Vector3(), scale = new THREE.Vector3()
  for (const mesh of objectsNamed(edge.group, 'landscape-model')) {
    for (let index = 0; index < mesh.count; index += 1) {
      mesh.getMatrixAt(index, new THREE.Matrix4()).decompose(position, new THREE.Quaternion(), scale)
      assert.ok(scale.x >= .9 && scale.x <= 2.3, 'валун кромки или глыба толщи вписаны в клетку-две')
    }
  }
  edge.dispose()

  // Мост: река по x=2..4, мост в две строки поперёк — одна секция Kenney на столбец.
  const river = terrainMap({ width: 7, height: 4, cell: (x, y) => x >= 2 && x <= 4 && !(y === 1 || y === 2) ? { passable: false, surface: 'water' } : x >= 2 && x <= 4 ? { material: 'wood' } : {} })
  const strips = landscape.bridgeModelStrips(river)
  assert.deepEqual(strips.map((strip) => [strip.x, strip.y, strip.span, strip.width]), [[2, 1, 'x', 2], [3, 1, 'x', 2], [4, 1, 'x', 2]])
  const bridge = landscape.createBridgeRails(river, kit)
  assert.equal(bridge.group.userData.bridgeSource, 'models')
  assert.ok(objectsNamed(bridge.group, 'landscape-model').reduce((sum, mesh) => sum + mesh.count, 0) > 0)
  bridge.dispose()
  // Клетки полосы на разной высоте модель не покрывает: остаются бруски.
  const uneven = terrainMap({ width: 7, height: 4, cell: (x, y) => x >= 2 && x <= 4 && !(y === 1 || y === 2) ? { passable: false, surface: 'water' } : x >= 2 && x <= 4 ? { material: 'wood', elevation: y === 2 ? 1 : 0 } : {} })
  assert.deepEqual(landscape.bridgeModelStrips(uneven), [])
  const fallback = landscape.createBridgeRails(uneven, kit)
  assert.equal(fallback.group.userData.bridgeSource, 'procedural')
  fallback.dispose()

  // Кувшинки и тростник: только с набором и не на «Экономном».
  const pond = terrainMap({ width: 8, height: 8, cell: (x, y) => x >= 2 && x <= 5 && y >= 2 && y <= 5 ? { passable: false, surface: 'water' } : {} })
  assert.equal(landscape.createWaterPlants(pond, 'full', null), null)
  assert.equal(landscape.createWaterPlants(pond, 'minimal', kit), null)
  const plants = landscape.createWaterPlants(pond, 'full', kit)
  assert.ok(plants && objectsNamed(plants.group, 'landscape-model').every((mesh) => !mesh.castShadow), 'растения у воды не идут в карты теней')
  const plantLayout = (group) => objectsNamed(group, 'landscape-model').map((mesh) => Array.from(mesh.instanceMatrix.array).join(',')).sort().join('|')
  const plantsAgain = landscape.createWaterPlants(pond, 'full', kit)
  assert.equal(plantLayout(plants.group), plantLayout(plantsAgain.group))
  plants.dispose(); plantsAgain.dispose()
})

test('сцена без window не ждёт набор местности и рисует процедурные скалы', async () => {
  assert.equal(await landscapeAssets.acquireLandscapeKit(new AbortController().signal), null, 'в тестах и SSR набор не загружается')
  const raw = createTacticalMap({ width: 5, height: 4, seed: 'cave-kit', theme: 'cave' })
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 5; x += 1) setCell(raw, x, y, { passable: y === 1, material: 'stone', revealed: true })
  const map = mapClient.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(raw))))
  assert.equal(landscape.landscapeWantsModels(map), true)
  const scene = scene3d.createBoard3DScene(map)
  assert.equal(scene.group.getObjectByName('landscape-rocks').userData.rockSource, 'procedural')
  scene.dispose()
})

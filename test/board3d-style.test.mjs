import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { compileClientModules } from './kit/client-ts.mjs'

import { addZone, canonicalEdge, createTacticalMap, serializeTacticalMap, setCell, setDoor, setEdge } from '../server/tactical-map.mjs'
import { DETAIL_PROPS } from '../server/detail-props.mjs'
import { GRAPHICS_STYLE_SOURCES, STYLE_RELEASE } from '../tools/graphics-style-sources.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const build = await compileClientModules([
  'src/board3d-style.ts', 'src/board3d-floor-tiles.ts', 'src/board3d-walls.ts', 'src/tactical-map-client.ts',
])
const [style, floors, walls, mapClient] = build.modules
const landscape = await build.load('src/board3d-landscape.ts')
const landscapeTerrain = await build.load('src/board3d-terrain.ts')
const THREE = await import('three')

const STYLE_ROOT = join(root, 'public', 'assets', 'styles', 'stylized')
const manifest = () => JSON.parse(readFileSync(join(STYLE_ROOT, 'manifest.json'), 'utf8'))

/** Таблица GLB: JSON-чанк без разбора бинарной части. */
function glbJson(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'не GLB')
  const length = bytes.readUInt32LE(12)
  return JSON.parse(bytes.subarray(20, 20 + length).toString('utf8'))
}

test('стиль один — рисованный; реалистичного пакета больше нет', () => {
  assert.equal(style.GRAPHICS_STYLE, 'stylized')
  assert.deepEqual(Object.keys(GRAPHICS_STYLE_SOURCES), ['stylized'])
  assert.deepEqual(readdirSync(join(root, 'public', 'assets', 'styles')), ['stylized'])
})

test('опубликованный пакет проходит проверку клиента, а пути ведут внутрь пакета или к моделям Quaternius выпуска', () => {
  const pack = style.validateGraphicsStylePack(manifest())
  assert.ok(Object.keys(pack.floors).length >= 20)
  for (const floor of Object.values(pack.floors)) {
    for (const url of [floor.color, floor.normal, floor.orm, floor.height]) assert.ok(url.startsWith('/assets/styles/stylized/floors/'), url)
  }
  for (const material of Object.values(pack.materials)) {
    for (const url of [material.color, material.normal, material.orm].filter(Boolean)) assert.ok(url.startsWith('/assets/styles/stylized/materials/'), url)
  }
  for (const list of Object.values(pack.props)) for (const prop of list) {
    assert.ok(prop.url.startsWith('/assets/styles/stylized/props/') || prop.url.startsWith(`/assets/models/environment/releases/${STYLE_RELEASE}/quaternius`), prop.url)
  }
})

test('каждый файл пакета лежит на месте с объявленным хешем, и всё, на что ссылается манифест, объявлено', () => {
  const data = manifest()
  const declared = new Set(data.files.map((file) => file.file))
  for (const file of data.files) {
    const bytes = readFileSync(join(STYLE_ROOT, file.file))
    assert.equal(bytes.length, file.bytes, file.file)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.file)
  }
  for (const floor of Object.values(data.floors)) for (const map of ['color', 'normal', 'orm', 'height']) assert.ok(declared.has(floor[map]), floor[map])
  for (const material of Object.values(data.materials)) for (const map of ['color', 'normal', 'orm']) if (material[map]) assert.ok(declared.has(material[map]), material[map])
  for (const list of Object.values(data.props)) for (const prop of list) {
    if (prop.url.startsWith('/')) assert.ok(existsSync(join(root, 'public', prop.url)), prop.url)
    else assert.ok(declared.has(prop.url), prop.url)
  }
  // Лишних файлов в каталоге стиля нет: всё, что лежит, объявлено.
  const walk = (folder, prefix = '') => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? walk(join(folder, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`])
  for (const file of walk(STYLE_ROOT)) if (file !== 'manifest.json') assert.ok(declared.has(file), `не объявлен ${file}`)
})

test('модели пакета без своих текстур: каждый материал skz:* есть среди общих материалов пакета', () => {
  const data = manifest()
  // Материалы видов стен берут стены доски, а не модели.
  const used = new Set(Object.values(data.walls).map((look) => look.material))
  for (const list of Object.values(data.props)) for (const prop of list) {
    if (prop.url.startsWith('/')) continue
    const json = glbJson(readFileSync(join(STYLE_ROOT, prop.url)))
    assert.equal(json.images?.length ?? 0, 0, `${prop.url}: встроенные картинки`)
    for (const material of json.materials ?? []) if (material.name?.startsWith('skz:')) used.add(material.name.slice(4))
  }
  for (const key of used) assert.ok(data.materials[key], `нет общего материала ${key}`)
  for (const key of Object.keys(data.materials)) assert.ok(used.has(key), `материал ${key} никем не используется`)
})

test('пакет собран из текущих источников: каждый пол и предмет из graphics-style-sources попал в манифест', () => {
  const data = manifest()
  const source = GRAPHICS_STYLE_SOURCES.stylized
  for (const [key, floor] of Object.entries(source.floors)) {
    assert.ok(data.floors[key], `нет пола ${key}`)
    assert.equal(data.floors[key].cells, floor.cells, `${key}: масштаб`)
    assert.equal(data.floors[key].relief, floor.relief, `${key}: рельеф`)
  }
  for (const [assetId, list] of Object.entries(source.props)) assert.equal(data.props[assetId]?.length, list.length, `предмет ${assetId}`)
  assert.ok(existsSync(join(root, 'tools', 'build-graphics-styles-page.js')))
})

test('у каждого предмета набора детализации есть модель стиля, кроме плоских наклеек', () => {
  const data = manifest()
  for (const prop of DETAIL_PROPS) {
    if (prop.kind === 'decal') continue
    assert.ok(data.props[prop.id]?.length, `нет модели стиля для ${prop.id}`)
  }
})

test('проверка пакета отклоняет чужой стиль, выход из каталога, чужие адреса и бессмысленный масштаб', () => {
  const good = manifest()
  assert.throws(() => style.validateGraphicsStylePack({ ...good, style: 'realistic' }))
  assert.throws(() => style.validateGraphicsStylePack({ ...good, schema: 'graphics-style/v0' }))
  const escape = structuredClone(good)
  escape.floors.stone.color = 'floors/../../../index.html'
  assert.throws(() => style.validateGraphicsStylePack(escape))
  const remote = structuredClone(good)
  remote.props.chest[0].url = 'https://example.com/chest.glb'
  assert.throws(() => style.validateGraphicsStylePack(remote))
  const foreignFamily = structuredClone(good)
  foreignFamily.props.chest[0].url = `/assets/models/environment/releases/${STYLE_RELEASE}/kenney/log.glb`
  assert.throws(() => style.validateGraphicsStylePack(foreignFamily))
  const materialEscape = structuredClone(good)
  materialEscape.materials.wood.color = '../wood.jpg'
  assert.throws(() => style.validateGraphicsStylePack(materialEscape))
  const flat = structuredClone(good)
  flat.floors.stone.cells = 0
  assert.throws(() => style.validateGraphicsStylePack(flat))
})

test('style atlas, preview, maxHeight и alphaTest валидируются и остаются optional для старого пакета', () => {
  const good = manifest()
  delete good.atlas
  for (const list of Object.values(good.props)) for (const prop of list) {
    delete prop.preview
    delete prop.size
    delete prop.maxHeight
  }
  const rich = structuredClone(good)
  rich.atlas = { image: 'topdown.png', key: 'a'.repeat(16) }
  const firstAsset = Object.keys(rich.props)[0]
  rich.props[firstAsset][0].preview = { x: 1, y: 2, w: 3, h: 4 }
  rich.props[firstAsset][0].maxHeight = 2
  rich.props[firstAsset][0].size = [.8, 3, .2]
  const materialKey = Object.keys(rich.materials)[0]
  rich.materials[materialKey].alphaTest = .5
  const parsed = style.validateGraphicsStylePack(rich)
  assert.equal(parsed.atlas?.image, '/assets/styles/stylized/topdown.png')
  assert.deepEqual(parsed.props[firstAsset][0].preview, { x: 1, y: 2, w: 3, h: 4 })
  assert.equal(parsed.props[firstAsset][0].maxHeight, 2)
  assert.deepEqual(parsed.props[firstAsset][0].size, [.8, 3, .2])
  assert.equal(parsed.materials[materialKey].alphaTest, .5)
  assert.equal(style.validateGraphicsStylePack(good).atlas, undefined, 'старый manifest без atlas остаётся совместимым')
  const webp = structuredClone(rich)
  webp.atlas.image = 'topdown.webp'
  assert.equal(style.validateGraphicsStylePack(webp).atlas?.image, '/assets/styles/stylized/topdown.webp', 'атлас стиля — WebP')
  const foreign = structuredClone(rich)
  foreign.atlas.image = 'atlas.gif'
  assert.throws(() => style.validateGraphicsStylePack(foreign), /атлас/u)
  const noAtlasPreview = structuredClone(good)
  noAtlasPreview.props[firstAsset][0].preview = { x: 0, y: 0, w: 1, h: 1 }
  assert.throws(() => style.validateGraphicsStylePack(noAtlasPreview), /preview/u)
  const badBounds = structuredClone(rich)
  badBounds.props[firstAsset][0].preview = { x: 16_384, y: 0, w: 1, h: 1 }
  assert.throws(() => style.validateGraphicsStylePack(badBounds), /preview/u)
  const badAlpha = structuredClone(rich)
  badAlpha.materials[materialKey].alphaTest = 1.1
  assert.throws(() => style.validateGraphicsStylePack(badAlpha), /альфа/u)
  const badSize = structuredClone(rich)
  badSize.props[firstAsset][0].size = [.8, 0, .2]
  assert.throws(() => style.validateGraphicsStylePack(badSize), /габарит/u)
})

test('вариант модели выбирается по id предмета: повторяемо и с разнообразием', () => {
  const pack = style.validateGraphicsStylePack(manifest())
  assert.equal(style.stylePropFor(pack, 'barrel', 'barrel-1')?.key, style.stylePropFor(pack, 'barrel', 'barrel-1')?.key)
  const variants = new Set(Array.from({ length: 24 }, (_, index) => style.stylePropFor(pack, 'barrel', `barrel-${index}`)?.key))
  assert.ok(variants.size > 1)
  assert.equal(style.stylePropFor(pack, 'sack', 'sack-1'), null, 'мешок Quaternius остаётся моделью выпуска')
  // Стул получил варианты KayKit, а модель Quaternius осталась среди них ссылкой на выпуск.
  assert.ok(pack.props.chair.some((entry) => entry.key === 'ref-quaternius-chair-1'))
  assert.equal(style.stylePropFor(null, 'barrel', 'barrel-1'), null)
})

test('материалы skz:* заменяются общими материалами пакета, один экземпляр на ключ и вид вершин', async () => {
  const pack = style.validateGraphicsStylePack(manifest())
  const requested = []
  const binder = style.createStyleMaterialBinder(pack, (url, done) => { requested.push(url); queueMicrotask(done); return new THREE.Texture() })
  const geometry = (withColor) => {
    const result = new THREE.BoxGeometry()
    if (withColor) result.setAttribute('color', new THREE.BufferAttribute(new Float32Array(result.attributes.position.count * 3).fill(1), 3))
    return result
  }
  const model = (withColor) => {
    const group = new THREE.Group()
    group.add(new THREE.Mesh(geometry(withColor), new THREE.MeshStandardMaterial({ name: 'skz:wood' })))
    group.add(new THREE.Mesh(geometry(withColor), new THREE.MeshStandardMaterial({ name: 'flat-flame' })))
    group.add(new THREE.Mesh(geometry(withColor), new THREE.MeshStandardMaterial({ name: 'skz:unknown' })))
    return group
  }
  const first = model(true), second = model(true), plain = model(false)
  assert.equal(binder.bind(first), 1)
  assert.equal(binder.bind(second), 1)
  assert.equal(binder.bind(plain), 1)
  const wood = first.children[0].material
  assert.equal(second.children[0].material, wood, 'общий материал на все модели')
  assert.notEqual(plain.children[0].material, wood, 'без цветов вершин — свой экземпляр')
  assert.equal(wood.vertexColors, true)
  assert.equal(plain.children[0].material.vertexColors, false)
  assert.equal(wood.map.flipY, false)
  assert.equal(wood.map.colorSpace, THREE.SRGBColorSpace)
  assert.equal(first.children[1].material.name, 'flat-flame', 'обычный материал не трогается')
  assert.equal(first.children[2].material.name, 'skz:unknown', 'неизвестный ключ остаётся материалом файла')
  assert.equal(new Set(requested).size, requested.length, 'каждая текстура запрошена один раз')
  await binder.ready()
})

function mapWith(cells) {
  const map = createTacticalMap({ width: 4, height: 2, seed: 'style-floor', theme: 'building' })
  for (let y = 0; y < 2; y += 1) for (let x = 0; x < 4; x += 1) setCell(map, x, y, { passable: true, revealed: true, material: 'stone' })
  for (const [x, y, patch] of cells) setCell(map, x, y, patch)
  return mapClient.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(map))))
}

test('покрытие клетки: материал, грязь — свой пол, вода, стены и нераскрытое остаются на прежнем полу', () => {
  const map = mapWith([[1, 0, { material: 'grass' }], [2, 0, { surface: 'mud' }], [3, 0, { surface: 'water' }], [0, 1, { passable: false }], [1, 1, { revealed: false }]])
  const key = (x, y) => floors.floorKeyForCell(map, mapClient.cellAt(map, x, y))
  assert.equal(key(0, 0), 'stone')
  assert.equal(key(1, 0), 'grass')
  assert.equal(key(2, 0), 'mud')
  assert.equal(key(3, 0), null)
  assert.equal(key(0, 1), null)
  assert.equal(key(1, 1), null)
})

test('плитки пола режутся по покрытию, а UV считаются в повторах на клетку', () => {
  const map = mapWith([[1, 0, { material: 'grass' }]])
  const all = landscape.createTileGroundGeometry(map)
  const grass = landscape.createTileGroundGeometry(map, { include: (_x, _y, cell) => cell.material === 'grass', uvCells: 2 })
  assert.equal(grass.attributes.position.count, 12)
  assert.ok(all.attributes.position.count > grass.attributes.position.count)
  const positions = grass.attributes.position, uv = grass.attributes.uv
  for (let index = 0; index < positions.count; index += 1) {
    assert.ok(Math.abs(uv.getX(index) - positions.getX(index) / 2) < 1e-6)
    assert.ok(Math.abs(uv.getY(index) - positions.getZ(index) / 2) < 1e-6)
  }
})

test('пол стиля — по сетке на покрытие из пакета; покрытия без пакета не строятся, ресурсы освобождаются', () => {
  const map = mapWith([[1, 0, { material: 'grass' }], [2, 0, { material: 'grass' }], [3, 0, { material: 'metal' }]])
  const pack = style.validateGraphicsStylePack(manifest())
  delete pack.floors.metal
  const loaded = []
  const built = floors.buildStyledFloors(map, pack, { parallax: true, loadTexture: (url) => { loaded.push(url); return new THREE.Texture() } })
  assert.deepEqual(built.keys, ['grass', 'stone'])
  assert.deepEqual(built.group.children.map((mesh) => mesh.name), ['styled-floor:grass', 'styled-floor:stone'])
  for (const mesh of built.group.children) {
    assert.equal(mesh.receiveShadow, true)
    assert.equal(mesh.material.polygonOffset, true)
    assert.equal(typeof mesh.material.onBeforeCompile, 'function')
    assert.ok(mesh.geometry.attributes.uv1)
  }
  assert.equal(loaded.length, 8)
  assert.ok(loaded.every((url) => url.startsWith('/assets/styles/stylized/floors/')))
  let disposed = 0
  for (const mesh of built.group.children) mesh.geometry.addEventListener('dispose', () => { disposed += 1 })
  built.dispose()
  assert.equal(disposed, 2)
  const flat = floors.buildStyledFloors(map, pack, { parallax: false, loadTexture: () => new THREE.Texture() })
  assert.ok(flat.group.children.every((mesh) => mesh.material.customProgramCacheKey() !== 'board3d-floor-parallax-v1'))
  flat.dispose()
})

test('листва пакета: материал с вырезом по альфе сглаживает край, остальные — нет', () => {
  const pack = style.validateGraphicsStylePack(manifest())
  const cutoutKey = Object.keys(pack.materials).find((key) => pack.materials[key].alphaTest > 0)
  assert.ok(cutoutKey, 'в пакете есть листва с альфа-тестом')
  const binder = style.createStyleMaterialBinder(pack, (url, done) => { queueMicrotask(done); return new THREE.Texture() })
  const group = new THREE.Group()
  group.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial({ name: `skz:${cutoutKey}` })))
  group.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'skz:wood' })))
  assert.equal(binder.bind(group), 2)
  assert.equal(group.children[0].material.alphaToCoverage, true)
  assert.equal(group.children[1].material.alphaToCoverage, false)
})

function terraceMap() {
  const map = createTacticalMap({ width: 4, height: 3, seed: 'style-sides', fill: { passable: true, revealed: true, material: 'grass', elevation: 0 } })
  setCell(map, 1, 1, { elevation: 5 })
  setCell(map, 2, 1, { elevation: 5, material: 'stone' })
  setCell(map, 3, 2, { revealed: false })
  return mapClient.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(map))))
}

test('боковины уступов и края доски — фактурой пакета: грунт под газоном, камень под камнем, UV по миру', () => {
  const map = terraceMap()
  const pack = style.validateGraphicsStylePack(manifest())
  const loaded = []
  const built = floors.buildStyledTerrainSides(map, pack, { loadTexture: (url) => { loaded.push(url); return new THREE.Texture() } })
  assert.deepEqual(built.keys, ['earth', 'stone'])
  assert.deepEqual(built.group.children.map((mesh) => mesh.name), ['styled-terrain-sides:earth', 'styled-terrain-sides:stone'])
  assert.deepEqual(loaded, ['earth', 'stone'].flatMap((key) => [pack.floors[key].color, pack.floors[key].normal]))
  const total = built.group.children.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0)
  const plain = landscapeTerrain.createTerrainSideGeometry(map)
  assert.equal(total, plain.attributes.position.count, 'та же геометрия, что у прежних боковин')
  for (const mesh of built.group.children) {
    assert.equal(mesh.castShadow, true)
    assert.equal(mesh.material.vertexColors, true)
    assert.equal(mesh.material.map.colorSpace, THREE.SRGBColorSpace)
    const cells = pack.floors[mesh.name.split(':')[1]].cells
    const { position, uv, normal } = mesh.geometry.attributes
    for (let index = 0; index < position.count; index += 1) {
      assert.ok(Math.abs(normal.getY(index)) < 1e-6, 'боковина вертикальна')
      const along = Math.abs(normal.getX(index)) > .5 ? position.getZ(index) : position.getX(index)
      assert.ok(Math.abs(uv.getX(index) - along / cells) < 1e-6, 'рисунок идёт вдоль грани без шва')
      assert.ok(Math.abs(uv.getY(index) - position.getY(index) / cells) < 1e-6)
    }
  }
  let disposed = 0
  for (const mesh of built.group.children) mesh.geometry.addEventListener('dispose', () => { disposed += 1 })
  built.dispose()
  assert.equal(disposed, 2)
  delete pack.floors.stone
  const partial = floors.buildStyledTerrainSides(map, pack, { loadTexture: () => new THREE.Texture() })
  assert.deepEqual(partial.keys, ['earth'], 'покрытие без пакета остаётся на прежних боковинах')
  partial.dispose()
})

// --------------------------------------------------------------- стены

function wallMap() {
  const map = createTacticalMap({ width: 8, height: 6, seed: 'style-walls', theme: 'building' })
  addZone(map, { id: 'yard', kind: 'exterior', material: 'grass' })
  addZone(map, { id: 'hall', kind: 'interior', material: 'wood', wall: 'fachwerk' })
  addZone(map, { id: 'keep', kind: 'interior', material: 'stone' })
  for (let y = 0; y < 6; y += 1) for (let x = 0; x < 8; x += 1) setCell(map, x, y, { passable: true, revealed: true, material: 'grass', zone: 'yard' })
  for (let y = 1; y < 4; y += 1) for (let x = 1; x < 3; x += 1) setCell(map, x, y, { material: 'wood', zone: 'hall' })
  for (let y = 1; y < 4; y += 1) for (let x = 4; x < 6; x += 1) setCell(map, x, y, { material: 'stone', zone: 'keep' })
  for (let x = 1; x < 3; x += 1) setEdge(map, x, 0, x, 1, { kind: 'wall' })
  for (let x = 4; x < 6; x += 1) setEdge(map, x, 0, x, 1, { kind: 'wall' })
  setEdge(map, 0, 2, 1, 2, { kind: 'window' })
  setEdge(map, 3, 2, 4, 2, { kind: 'grate' })
  setDoor(map, { id: 'hall-door', ...canonicalEdge(1, 3, 1, 4), state: 'closed' })
  setDoor(map, { id: 'keep-door', ...canonicalEdge(4, 3, 4, 4), state: 'open' })
  // Ребро между двумя туманными клетками не рисуется.
  setCell(map, 7, 4, { revealed: false })
  setCell(map, 7, 5, { revealed: false })
  setEdge(map, 7, 4, 7, 5, { kind: 'wall' })
  return mapClient.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(map))))
}

test('вид стены: кладка помещения главнее материала, непостроенный материал — камень с оттенком', () => {
  const map = wallMap()
  const at = (x, y) => mapClient.cellAt(map, x, y)
  assert.deepEqual(walls.wallLookFor(map, at(1, 1)), { kind: 'fachwerk', body: 'plaster', tint: '#f4efe6' })
  assert.equal(walls.wallLookFor(map, at(4, 1)).body, 'stone')
  assert.equal(walls.wallLookFor(map, { ...at(4, 1), zone: undefined, material: 'wood' }).kind, 'planks')
  assert.equal(walls.wallLookFor(map, { ...at(4, 1), zone: undefined, material: 'marble' }).body, 'plaster')
  assert.notEqual(walls.wallLookFor(map, { ...at(4, 1), zone: undefined, material: 'earth' }).tint, '#ffffff')
})

test('пакет несёт все обязательные виды стен; без бруса или железа стиль стен не включается', () => {
  const pack = style.validateGraphicsStylePack(manifest())
  assert.equal(walls.packHasWallLooks(pack), true)
  for (const key of ['stone', 'planks', 'timber', 'iron']) {
    const broken = structuredClone(pack)
    delete broken.walls[key]
    assert.equal(walls.packHasWallLooks(broken), false, key)
  }
  assert.equal(walls.packHasWallLooks(null), false)
  const bad = structuredClone(manifest())
  bad.walls.stone.material = 'nonexistent'
  assert.throws(() => style.validateGraphicsStylePack(bad))
})

test('стены стиля: прежние имена групп, двери отдельно, туман и фактуры пакета соблюдены', () => {
  const pack = style.validateGraphicsStylePack(manifest())
  const map = wallMap()
  const requested = []
  const built = walls.buildStyledEdges(map, pack, { wallHeight: .95, thickness: 1 / 6, loadTexture: (url, done) => { requested.push(url); done(); return new THREE.Texture() } })
  const wallsGroup = built.group.getObjectByName('cutaway-walls')
  const doors = built.group.getObjectByName('doors')
  assert.ok(wallsGroup && doors)
  const names = (group) => group.children.map((mesh) => mesh.name).sort()
  // Фахверк: штукатурка и брус; каменная комната — камень; решётка — железо.
  for (const name of ['wall-box:plaster', 'wall-box:timber', 'wall-box:stone', 'wall-box:iron']) assert.ok(names(wallsGroup).includes(name), name)
  // Доски створки повёрнуты рисунком вдоль (swap), кольца — отдельная форма.
  assert.ok(names(doors).includes('wall-box:planks:swap'))
  assert.ok(names(doors).includes('wall-ring:iron'))
  for (const mesh of [...wallsGroup.children, ...doors.children]) {
    assert.ok(mesh.isInstancedMesh)
    assert.equal(mesh.castShadow, true)
    assert.ok(mesh.instanceColor, mesh.name)
  }
  // Ни один экземпляр не стоит на ребре в тумане (x = 7..8, z = 5).
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3()
  for (const mesh of wallsGroup.children) for (let index = 0; index < mesh.count; index += 1) {
    mesh.getMatrixAt(index, matrix)
    position.setFromMatrixPosition(matrix)
    assert.ok(!(position.x > 7 && position.z > 4.5), `${mesh.name} в тумане`)
  }
  assert.ok(requested.length > 0)
  assert.ok(requested.every((url) => url.startsWith('/assets/styles/stylized/materials/')))
  assert.equal(new Set(requested).size, requested.length, 'текстура запрошена один раз')
  let disposed = 0
  for (const mesh of [...wallsGroup.children, ...doors.children]) mesh.geometry.addEventListener('dispose', () => { disposed += 1 })
  built.dispose()
  assert.ok(disposed > 0)
  assert.equal(built.group.parent, null)
})

test('открытая дверь уходит створкой в соседнюю клетку, закрытая стоит в проёме', () => {
  const pack = style.validateGraphicsStylePack(manifest())
  const map = wallMap()
  const built = walls.buildStyledEdges(map, pack, { wallHeight: .95, thickness: 1 / 6, loadTexture: (_url, done) => { done(); return new THREE.Texture() } })
  const planks = built.group.getObjectByName('doors').children.find((mesh) => mesh.name === 'wall-box:planks:swap')
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3()
  const leaves = []
  for (let index = 0; index < planks.count; index += 1) { planks.getMatrixAt(index, matrix); leaves.push(position.setFromMatrixPosition(matrix).clone()) }
  // Двери на рёбрах (1,3)-(1,4) и (4,3)-(4,4): граница z = 4.
  const closed = leaves.filter((point) => point.x < 3)
  const open = leaves.filter((point) => point.x > 3)
  assert.equal(closed.length, 4)
  assert.equal(open.length, 4)
  assert.ok(closed.every((point) => Math.abs(point.z - 4) < .01), 'закрытая створка в проёме')
  assert.ok(open.every((point) => point.z > 4.01 && Math.abs(point.x - 4.25) < .01), 'открытая створка у петли и в соседней клетке')
  assert.ok(Math.max(...open.map((point) => point.z)) > 4.4, 'створка развёрнута поперёк проёма')
  built.dispose()
})

test('материал стены кладёт фактуру по мировым координатам во всех картах', () => {
  const pack = style.validateGraphicsStylePack(manifest())
  const spec = pack.materials[pack.walls.stone.material]
  const material = walls.createTriplanarMaterial(spec, 1.2, { color: new THREE.Texture(), normal: new THREE.Texture(), orm: new THREE.Texture() })
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader }
  material.onBeforeCompile(shader, null)
  assert.ok(shader.uniforms.skzScale.value.y > 0)
  assert.match(shader.vertexShader, /vSkzWorld = skzWorld\.xyz/u)
  assert.match(shader.fragmentShader, /vec2 skzUv = skzTriplanarUv\(\)/u)
  for (const chunk of ['map_fragment', 'normal_fragment_begin', 'normal_fragment_maps', 'roughnessmap_fragment', 'aomap_fragment']) {
    assert.ok(!shader.fragmentShader.includes(`#include <${chunk}>`), chunk)
  }
  assert.ok(!/texture2D\(\s*map\s*,\s*vMapUv/u.test(shader.fragmentShader))
  assert.equal(material.customProgramCacheKey(), 'board3d-wall-triplanar-v1')
  material.dispose()
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { createTacticalMap, serializeTacticalMap, setCell } from '../server/tactical-map.mjs'
import { DETAIL_PROPS } from '../server/detail-props.mjs'
import { GRAPHICS_STYLE_SOURCES, STYLE_RELEASE } from '../tools/graphics-style-sources.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'tmp'), { recursive: true })
const buildDir = mkdtempSync(join(root, 'tmp', 'board3d-style-test-'))
const outputDir = join(buildDir, 'src')
mkdirSync(join(buildDir, 'server'), { recursive: true })
copyFileSync(join(root, 'server', 'circular-area-geometry.mjs'), join(buildDir, 'server', 'circular-area-geometry.mjs'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sources = ['../src/board3d-style.ts', '../src/board3d-floor-tiles.ts', '../src/tactical-map-client.ts']
  .map((relative) => fileURLToPath(new URL(relative, import.meta.url)))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--rootDir', root, '--outDir', buildDir, ...sources,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
for (const name of readdirSync(outputDir)) {
  if (!name.endsWith('.js')) continue
  const source = readFileSync(join(outputDir, name), 'utf8').replace(/(from\s+["'])(\.\/[^"']+)(["'])/g, '$1$2.mjs$3')
  writeFileSync(join(outputDir, name.replace(/\.js$/, '.mjs')), source)
  rmSync(join(outputDir, name))
}
const style = await import(pathToFileURL(join(outputDir, 'board3d-style.mjs')).href)
const floors = await import(pathToFileURL(join(outputDir, 'board3d-floor-tiles.mjs')).href)
const landscape = await import(pathToFileURL(join(outputDir, 'board3d-landscape.mjs')).href)
const mapClient = await import(pathToFileURL(join(outputDir, 'tactical-map-client.mjs')).href)
const THREE = await import('three')
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

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
  const used = new Set()
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

test('вариант модели выбирается по id предмета: повторяемо и с разнообразием', () => {
  const pack = style.validateGraphicsStylePack(manifest())
  assert.equal(style.stylePropFor(pack, 'barrel', 'barrel-1')?.key, style.stylePropFor(pack, 'barrel', 'barrel-1')?.key)
  const variants = new Set(Array.from({ length: 24 }, (_, index) => style.stylePropFor(pack, 'barrel', `barrel-${index}`)?.key))
  assert.ok(variants.size > 1)
  assert.equal(style.stylePropFor(pack, 'chair', 'chair-1'), null, 'стул Quaternius остаётся моделью выпуска')
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

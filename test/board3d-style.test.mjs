import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { createTacticalMap, serializeTacticalMap, setCell } from '../server/tactical-map.mjs'
import { GRAPHICS_STYLE_SOURCES } from '../tools/graphics-style-sources.mjs'

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

const STYLES_ROOT = join(root, 'public', 'assets', 'styles')
const manifestOf = (name) => JSON.parse(readFileSync(join(STYLES_ROOT, name, 'manifest.json'), 'utf8'))

test('настройка стиля: по умолчанию рисованный, мусор из хранилища не ломает выбор', () => {
  assert.equal(style.board3DGraphicsStyle('realistic'), 'realistic')
  assert.equal(style.board3DGraphicsStyle('stylized'), 'stylized')
  for (const value of [null, '', 'photo', 42, undefined]) assert.equal(style.board3DGraphicsStyle(value), 'stylized')
  assert.deepEqual(Object.keys(style.BOARD3D_GRAPHICS_STYLES), ['stylized', 'realistic'])
})

test('опубликованные пакеты стилей проходят проверку клиента, а пути ведут внутрь своего стиля', () => {
  for (const name of ['stylized', 'realistic']) {
    const pack = style.validateGraphicsStylePack(manifestOf(name), name)
    assert.ok(Object.keys(pack.floors).length >= 20, name)
    for (const floor of Object.values(pack.floors)) {
      for (const url of [floor.color, floor.normal, floor.orm, floor.height]) assert.ok(url.startsWith(`/assets/styles/${name}/floors/`), url)
    }
    for (const list of Object.values(pack.props)) for (const prop of list) assert.ok(prop.url.startsWith(`/assets/styles/${name}/props/`), prop.url)
  }
})

test('каждый файл пакета лежит на месте с объявленным хешем, и всё, на что ссылается манифест, объявлено', () => {
  for (const name of ['stylized', 'realistic']) {
    const manifest = manifestOf(name)
    const declared = new Set(manifest.files.map((file) => file.file))
    for (const file of manifest.files) {
      const bytes = readFileSync(join(STYLES_ROOT, name, file.file))
      assert.equal(bytes.length, file.bytes, file.file)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.file)
    }
    for (const floor of Object.values(manifest.floors)) for (const map of ['color', 'normal', 'orm', 'height']) assert.ok(declared.has(floor[map]), floor[map])
    for (const list of Object.values(manifest.props)) for (const prop of list) assert.ok(declared.has(prop.url), prop.url)
    // Лишних файлов в каталоге стиля нет: всё, что лежит, объявлено.
    const walk = (folder, prefix = '') => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
      ? walk(join(folder, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`])
    for (const file of walk(join(STYLES_ROOT, name))) if (file !== 'manifest.json') assert.ok(declared.has(file), `не объявлен ${file}`)
  }
})

test('пакеты собраны из текущих источников: каждый пол и предмет из graphics-style-sources попал в манифест', () => {
  for (const [name, source] of Object.entries(GRAPHICS_STYLE_SOURCES)) {
    const manifest = manifestOf(name)
    for (const [key, floor] of Object.entries(source.floors)) {
      assert.ok(manifest.floors[key], `${name}: нет пола ${key}`)
      assert.equal(manifest.floors[key].cells, floor.cells, `${name}/${key}: масштаб`)
      assert.equal(manifest.floors[key].relief, floor.relief, `${name}/${key}: рельеф`)
    }
    for (const assetId of Object.keys(source.props)) assert.ok(manifest.props[assetId]?.length, `${name}: нет предмета ${assetId}`)
  }
  assert.ok(existsSync(join(root, 'tools', 'build-graphics-styles-page.js')))
})

test('проверка пакета отклоняет чужой стиль, выход из каталога и бессмысленный масштаб', () => {
  const good = manifestOf('realistic')
  assert.throws(() => style.validateGraphicsStylePack(good, 'stylized'))
  assert.throws(() => style.validateGraphicsStylePack({ ...good, schema: 'graphics-style/v0' }, 'realistic'))
  const escape = structuredClone(good)
  escape.floors.stone.color = 'floors/../../../index.html'
  assert.throws(() => style.validateGraphicsStylePack(escape, 'realistic'))
  const remote = structuredClone(good)
  remote.props.chair[0].url = 'https://example.com/chair.glb'
  assert.throws(() => style.validateGraphicsStylePack(remote, 'realistic'))
  const flat = structuredClone(good)
  flat.floors.stone.cells = 0
  assert.throws(() => style.validateGraphicsStylePack(flat, 'realistic'))
})

test('вариант модели выбирается по id предмета: повторяемо и с разнообразием', () => {
  const pack = style.validateGraphicsStylePack(manifestOf('realistic'), 'realistic')
  assert.equal(style.stylePropFor(pack, 'chair', 'chair-1')?.key, style.stylePropFor(pack, 'chair', 'chair-1')?.key)
  const variants = new Set(Array.from({ length: 24 }, (_, index) => style.stylePropFor(pack, 'chair', `chair-${index}`)?.key))
  assert.ok(variants.size > 1)
  assert.equal(style.stylePropFor(pack, 'market_stall', 'stall-1'), null)
  assert.equal(style.stylePropFor(null, 'chair', 'chair-1'), null)
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
  const pack = style.validateGraphicsStylePack(manifestOf('stylized'), 'stylized')
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

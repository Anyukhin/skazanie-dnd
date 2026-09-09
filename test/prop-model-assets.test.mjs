import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { addProp, createTacticalMap } from '../server/tactical-map.mjs'
import { assetById } from '../server/asset-registry.mjs'
import { decodePng } from '../tools/png-codec.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'tmp'), { recursive: true })
const buildDir = mkdtempSync(join(root, 'tmp', 'prop-model-assets-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sources = ['../src/prop-model-catalog.ts', '../src/prop-model-assets.ts', '../src/board3d-props.ts', '../src/board3d-batching.ts', '../src/board-render.ts']
  .map((relative) => fileURLToPath(new URL(relative, import.meta.url)))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--resolveJsonModule', '--esModuleInterop', '--outDir', buildDir, ...sources,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
function emittedFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? emittedFiles(path) : [path]
  })
}
for (const path of emittedFiles(buildDir).filter((candidate) => candidate.endsWith('.js'))) {
  const source = readFileSync(path, 'utf8')
    .replace(/(from\s+["'])(\.\.?\/[^"']+\.json)(["'])/gu, '$1$2$3 with { type: "json" }')
    .replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/gu, (match, before, specifier, after) => /\.(json|mjs|js)$/u.test(specifier) ? match : `${before}${specifier}.mjs${after}`)
  writeFileSync(path, source)
  renameSync(path, path.replace(/\.js$/u, '.mjs'))
}
const catalogModule = await import(pathToFileURL(join(buildDir, 'prop-model-catalog.mjs')).href)
const assetsModule = await import(pathToFileURL(join(buildDir, 'prop-model-assets.mjs')).href)
const propsModule = await import(pathToFileURL(join(buildDir, 'board3d-props.mjs')).href)
const batchModule = await import(pathToFileURL(join(buildDir, 'board3d-batching.mjs')).href)
const render = await import(pathToFileURL(join(buildDir, 'board-render.mjs')).href)
const actorModels = await import(pathToFileURL(join(buildDir, 'actor-models.mjs')).href)
const THREE = await import('three')
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

function entry(key, assetIds, previewX = 0, yaw = 0) {
  return { key, label: key, category: 'test', url: `/assets/models/environment/${key}.glb`, assetIds, yaw, preview: { x: previewX, y: 0, w: 64, h: 64 } }
}

function validCatalog(models = [entry('counter-a', ['bar_counter'])]) {
  return { version: 1, models, atlas: { image: '/assets/models/environment/atlas.png', key: 'test-atlas' } }
}

function prop(overrides = {}) {
  return {
    id: 'counter-prop', assetId: 'bar_counter', x: 10.5, y: 20.5, rotation: 0, scale: 1,
    footprint: [{ x: 10, y: 20 }], zOrder: 0, blocksMove: false, blocksSight: false,
    cover: 'none', destructible: false, hp: 0, interactive: false, state: '', ...overrides,
  }
}

function fakeTemplate(width = 2, height = 1, depth = 1, material = new THREE.MeshStandardMaterial({ color: '#c59a62' })) {
  const root = new THREE.Group()
  root.add(new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material))
  return root
}

test('catalog валидирует локальные GLB и детерминированно выбирает вариант', () => {
  const source = validCatalog([entry('counter-a', ['bar_counter', 'bar_counter']), entry('counter-b', ['bar_counter'])])
  const catalog = catalogModule.validatePropModelCatalog(source)
  assert.deepEqual(catalog.models[0].assetIds, ['bar_counter'])
  assert.equal(catalog.atlas.key, 'test-atlas')
  const first = catalogModule.propModelFor(catalog, 'bar_counter', 'counter-prop')
  assert.equal(first?.key, catalogModule.propModelFor(catalog, 'bar_counter', 'counter-prop')?.key)
  assert.equal(catalogModule.propModelFor(catalog, 'unknown', 'counter-prop'), null)
  for (const invalid of [
    [{ ...entry('bad', ['bar_counter']), url: 'https://cdn.invalid/model.glb' }],
    [entry('duplicate', ['bar_counter']), entry('duplicate', ['bar_counter'])],
    [{ ...entry('bad-asset', ['bar_counter']), assetIds: ['BAD'] }],
  ]) {
    assert.throws(() => catalogModule.validatePropModelCatalog({ version: 1, models: invalid }), /Некорректная|запись/u)
  }
})

test('2D preview и 3D GLB используют один детерминированный выбор', () => {
  const catalog = catalogModule.validatePropModelCatalog(validCatalog([entry('counter-a', ['bar_counter'], 11), entry('counter-b', ['bar_counter'], 77)]))
  const selected = catalogModule.propModelFor(catalog, 'bar_counter', 'shared-choice')
  const templates = new Map(catalog.models.map((model) => [model.key, fakeTemplate()]))
  const environment = propsModule.createEnvironmentModels(render.DEFAULT_BOARD_PALETTE, { catalog, models: templates })
  const model = environment.create(prop({ id: 'shared-choice' }))
  assert.equal(model.userData.modelKey, selected.key)

  const map = createTacticalMap({ width: 12, height: 22, fill: { passable: true, revealed: true, material: 'stone' } })
  addProp(map, prop({ id: 'shared-choice' }))
  const calls = []
  const context = new Proxy({ drawImage: (...args) => calls.push(args) }, {
    get(target, key) { return key in target ? target[key] : () => undefined },
    set(target, key, value) { target[key] = value; return true },
  })
  render.drawProps(context, { map, palette: render.DEFAULT_BOARD_PALETTE, cellSize: 32, modelPropAtlas: { catalog, texture: { image: {}, width: 512, height: 512 }, key: 'test' } }, { tileX: 0, tileY: 1 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], selected.preview.x)
  environment.dispose()
})

test('GLB-шаблон сохраняет неравный footprint, поворот и масштаб', () => {
  const catalog = catalogModule.validatePropModelCatalog(validCatalog([entry('counter-a', ['bar_counter'])]))
  const geometry = new THREE.BoxGeometry(2, 1, 1)
  const material = new THREE.MeshStandardMaterial({ color: '#c59a62' })
  const template = new THREE.Group(); template.add(new THREE.Mesh(geometry, material))
  const environment = propsModule.createEnvironmentModels(render.DEFAULT_BOARD_PALETTE, { catalog, models: new Map([['counter-a', template]]) })
  const footprint = [20, 21, 22].flatMap((y) => [10, 11].map((x) => ({ x, y })))
  const value = prop({ id: 'unequal-counter', x: 11, y: 21.5, rotation: 90, scale: 1.6, footprint })
  const layout = render.propVisualLayout(value)
  const model = environment.create(value)
  model.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(model)
  const size = bounds.getSize(new THREE.Vector3())
  const center = bounds.getCenter(new THREE.Vector3())
  assert.equal(model.position.x, layout.x)
  assert.equal(model.position.z, layout.y)
  assert.ok(Math.abs(model.rotation.y + Math.PI / 2) < 1e-9)
  assert.equal(model.scale.x, layout.scale)
  assert.ok(Math.abs(center.x - layout.x) < 1e-6 && Math.abs(center.z - layout.y) < 1e-6)
  assert.ok(size.z > size.x * 1.8, 'поворот оставляет длинную ось вдоль футпринта')
  assert.ok(bounds.min.y >= -.0001 && Number.isFinite(size.y), 'GLB имеет конечное основание')
  environment.dispose()
})

test('клоны GLB участвуют в batching, но не освобождают ресурсы владельца', () => {
  const catalog = catalogModule.validatePropModelCatalog(validCatalog())
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const material = new THREE.MeshStandardMaterial({ color: '#c59a62' })
  const template = new THREE.Group(); template.add(new THREE.Mesh(geometry, material))
  const environment = propsModule.createEnvironmentModels(render.DEFAULT_BOARD_PALETTE, { catalog, models: new Map([['counter-a', template]]) })
  const rootGroup = new THREE.Group()
  rootGroup.add(environment.create(prop({ id: 'batch-a', x: 1.5, y: 1.5 })))
  rootGroup.add(environment.create(prop({ id: 'batch-b', x: 4.5, y: 3.5 })))
  const result = batchModule.batchEnvironmentMeshes(rootGroup)
  assert.equal(result.batches.length, 1)
  assert.equal(result.batches[0].count, 2)
  assert.ok(result.batchedDrawCalls < result.originalDrawCalls)
  let geometryDisposed = 0, materialDisposed = 0
  geometry.addEventListener('dispose', () => geometryDisposed += 1)
  material.addEventListener('dispose', () => materialDisposed += 1)
  result.dispose(); result.dispose(); environment.dispose()
  assert.equal(geometryDisposed, 0)
  assert.equal(materialDisposed, 0)
})

test('загрузка ассетов без browser window безопасно возвращает fallback', async () => {
  assert.equal(await assetsModule.loadPropModelAssets([], new AbortController().signal), null)
})

test('готовая библиотека содержит самодостаточные GLB и непустые парные 2D-кадры', () => {
  const input = JSON.parse(readFileSync(join(root, 'public/assets/models/environment/manifest.json'), 'utf8'))
  const catalog = catalogModule.validatePropModelCatalog(input)
  assert.ok(catalog.models.length >= 94, 'полный выбранный набор предметов сохранён')
  assert.ok(catalog.atlas, 'общий 2D-атлас построен')
  const atlas = decodePng(readFileSync(join(root, 'public', catalog.atlas.image)))
  let bytes = 0
  const mapped = new Set()
  for (const entry of catalog.models) {
    const binary = readFileSync(join(root, 'public', entry.url))
    const glb = actorModels.validateGlbContainer(binary, 8_000_000)
    assert.ok(glb.json.meshes?.length > 0, `${entry.key}: есть геометрия`)
    bytes += binary.length
    for (const id of entry.assetIds) { assert.ok(assetById(id), `${entry.key}: существующий assetId ${id}`); mapped.add(id) }
    const frame = entry.preview
    assert.ok(frame, `${entry.key}: есть вид сверху`)
    assert.ok(frame.x + frame.w <= atlas.width && frame.y + frame.h <= atlas.height, `${entry.key}: кадр внутри атласа`)
    let visible = false
    for (let y = frame.y; y < frame.y + frame.h && !visible; y += 1) for (let x = frame.x; x < frame.x + frame.w; x += 1) {
      if (atlas.data[(y * atlas.width + x) * 4 + 3] > 8) { visible = true; break }
    }
    assert.ok(visible, `${entry.key}: кадр не пустой`)
  }
  assert.ok(mapped.size >= 30, 'готовые модели подключены к существующему генератору')
  assert.ok(bytes < 64 * 1024 * 1024, 'модели остаются в бюджете библиотеки 64 МиБ')
})

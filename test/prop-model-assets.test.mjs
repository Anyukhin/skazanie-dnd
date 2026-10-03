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
const sources = ['../src/prop-model-catalog.ts', '../src/prop-model-assets.ts', '../src/model-assets.ts', '../src/actor-models.ts', '../src/board3d-props.ts', '../src/board3d-batching.ts', '../src/board-render.ts']
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
    .replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/gu, (match, before, specifier, after) => {
      if (specifier.startsWith('../server/') && specifier.endsWith('.mjs')) return `${before}${new URL(specifier, new URL('../src/', import.meta.url)).href}${after}`
      return /\.(json|mjs|js)$/u.test(specifier) ? match : `${before}${specifier}.mjs${after}`
    })
  writeFileSync(path, source)
  renameSync(path, path.replace(/\.js$/u, '.mjs'))
}
const catalogModule = await import(pathToFileURL(join(buildDir, 'prop-model-catalog.mjs')).href)
const assetsModule = await import(pathToFileURL(join(buildDir, 'prop-model-assets.mjs')).href)
const styleModule = await import(pathToFileURL(join(buildDir, 'board3d-style.mjs')).href)
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
  assert.ok(catalogModule.ENVIRONMENT_MODEL_FAMILIES.includes('kenney-dungeon'))
  const dungeon = catalogModule.validatePropModelCatalog({
    version: 1,
    models: [{ ...entry('dungeon-stairs', ['stairs_up', 'stairs_down']), url: '/assets/models/environment/kenney-dungeon/stairs.glb' }],
  })
  assert.equal(dungeon.models[0].url, '/assets/models/environment/kenney-dungeon/stairs.glb')
  const releasedDungeon = catalogModule.validatePropModelCatalog({
    version: 1,
    release: { id: 'release-1' },
    models: [{ ...entry('released-dungeon-stairs', ['stairs_up']), url: '/assets/models/environment/releases/release-1/kenney-dungeon/stairs.glb' }],
    atlas: { image: '/assets/models/environment/releases/release-1/topdown.png', key: '0'.repeat(64) },
  }, 'release-1')
  assert.equal(releasedDungeon.models[0].url, '/assets/models/environment/releases/release-1/kenney-dungeon/stairs.glb')
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

test('style catalog, 2D preview и 3D выбирают один style-вариант по prop id', () => {
  const base = catalogModule.validatePropModelCatalog(validCatalog([entry('barrel-base', ['barrel'], 11)]))
  const stylePack = {
    style: 'stylized', revision: 'a'.repeat(16), floors: {}, materials: {}, walls: {},
    atlas: { image: '/assets/styles/stylized/topdown.png', key: 'b'.repeat(16) },
    props: { barrel: [
      { key: 'style-barrel-a', url: '/assets/styles/stylized/props/barrel_a.glb', yaw: 0, preview: { x: 17, y: 19, w: 23, h: 29 }, maxHeight: .75 },
      { key: 'style-barrel-b', url: '/assets/styles/stylized/props/barrel_b.glb', yaw: 90, preview: { x: 43, y: 47, w: 31, h: 37 } },
    ] },
  }
  const value = prop({ id: 'shared-style-choice', assetId: 'barrel' })
  const styled = render.withStyleProps(base, stylePack, [value])
  const chosenBy3d = catalogModule.propModelFor(styled, 'barrel', value.id)
  const chosenByStyle = styleModule.stylePropFor(stylePack, 'barrel', value.id)
  assert.equal(chosenBy3d?.source, 'style')
  assert.equal(chosenBy3d?.key, chosenByStyle?.key)
  assert.deepEqual(chosenBy3d?.preview, chosenByStyle?.preview)
})

test('2D берёт style atlas для style preview и не берёт базовый model atlas без frame', () => {
  const base = catalogModule.validatePropModelCatalog(validCatalog([entry('barrel-base', ['barrel'], 11)]))
  const value = prop({ id: 'style-preview-choice', assetId: 'barrel' })
  const stylePack = {
    style: 'stylized', revision: 'c'.repeat(16), floors: {}, materials: {}, walls: {},
    props: { barrel: [{ key: 'style-barrel', url: '/assets/styles/stylized/props/barrel.glb', yaw: 0, preview: { x: 17, y: 19, w: 23, h: 29 } }] },
  }
  const styled = render.withStyleProps(base, stylePack, [value])
  const atlas = (catalog, image, key) => ({ catalog, texture: { image, width: 128, height: 128 }, key })
  const map = createTacticalMap({ width: 12, height: 22, fill: { passable: true, revealed: true, material: 'stone' } })
  addProp(map, value)
  const trace = () => {
    const calls = []
    const context = new Proxy({ drawImage: (...args) => calls.push(args) }, {
      get(target, key) { return key in target ? target[key] : () => undefined },
      set(target, key, next) { target[key] = next; return true },
    })
    render.drawProps(context, {
      map, palette: render.DEFAULT_BOARD_PALETTE, cellSize: 32,
      propAtlas: { texture: { image: 'fallback-preview', width: 256, height: 256 }, frames: { barrel: { x: 1, y: 2, w: 30, h: 31 } }, key: 'fallback' },
      modelPropAtlas: atlas(base, 'base-model-preview', 'base'), styleModelPropAtlas: atlas(styled, 'style-model-preview', 'style'),
    }, { tileX: 0, tileY: 1 })
    return calls.find((args) => args[0] === 'style-model-preview' || args[0] === 'base-model-preview' || args[0] === 'fallback-preview')
  }
  assert.equal(trace()?.[0], 'style-model-preview')
  const withoutPreview = structuredClone(stylePack)
  withoutPreview.props.barrel[0] = { key: 'style-barrel-no-preview', url: '/assets/styles/stylized/props/barrel.glb', yaw: 0 }
  const noPreviewCatalog = render.withStyleProps(base, withoutPreview, [value])
  const calls = []
  const context = new Proxy({ drawImage: (...args) => calls.push(args) }, {
    get(target, key) { return key in target ? target[key] : () => undefined },
    set(target, key, next) { target[key] = next; return true },
  })
  render.drawProps(context, {
    map, palette: render.DEFAULT_BOARD_PALETTE, cellSize: 32,
    propAtlas: { texture: { image: 'fallback-preview', width: 256, height: 256 }, frames: { barrel: { x: 1, y: 2, w: 30, h: 31 } }, key: 'fallback' },
    modelPropAtlas: atlas(base, 'base-model-preview', 'base'), styleModelPropAtlas: atlas(noPreviewCatalog, 'style-model-preview', 'style'),
  }, { tileX: 0, tileY: 1 })
  assert.equal(calls.find((args) => args[0] === 'base-model-preview')?.[0], undefined)
  assert.equal(calls.find((args) => args[0] === 'fallback-preview')?.[0], 'fallback-preview')
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

test('владелец prop GLB освобождает boneTexture skinned-модели ровно один раз', () => {
  const bone = new THREE.Bone()
  const skeleton = new THREE.Skeleton([bone])
  skeleton.computeBoneTexture()
  const boneTexture = skeleton.boneTexture
  let boneTextureDisposals = 0
  const dispose = boneTexture.dispose.bind(boneTexture)
  boneTexture.dispose = () => { boneTextureDisposals += 1; return dispose() }
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const material = new THREE.MeshStandardMaterial({ color: '#c59a62' })
  const root = new THREE.Group()
  const skinned = new THREE.SkinnedMesh(geometry, material)
  skinned.bind(skeleton, new THREE.Matrix4())
  root.add(skinned)
  const clone = root.clone(true)
  assert.equal(clone.getObjectByProperty('isSkinnedMesh', true).skeleton, skeleton)
  assetsModule.disposePropModelAssets(new Map([['skinned', root], ['shared', clone]]))
  assert.equal(boneTextureDisposals, 1)
  assert.equal(skeleton.boneTexture, null)
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

const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
const libraryManifest = JSON.parse(readFileSync(join(root, 'public/assets/models/environment/manifest.json'), 'utf8'))

/** Реальный GLB библиотеки, разобранный как в браузере; текстуры в node не нужны. */
async function realTemplate(key) {
  const model = libraryManifest.models.find((item) => item.key === key)
  assert.ok(model, `${key}: есть в манифесте`)
  const binary = readFileSync(join(root, 'public', model.url))
  const loader = new GLTFLoader()
  loader.register(() => ({ name: 'test-no-textures', loadTexture: () => Promise.resolve(new THREE.Texture()) }))
  const gltf = await loader.parseAsync(binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength), '')
  const template = new THREE.Group()
  template.add(gltf.scene)
  return { model, template }
}

function skinnedCount(rootObject) {
  let count = 0
  rootObject.traverse((object) => { if (object.isSkinnedMesh) count += 1 })
  return count
}

test('skinned-сундук запекается в статичный меш и стоит в своей клетке, а не в начале карты', async () => {
  const { template } = await realTemplate('q-chest_wood')
  assert.equal(skinnedCount(template), 4, 'исходный сундук Quaternius собран из SkinnedMesh')
  template.updateMatrixWorld(true)
  const before = new THREE.Box3().setFromObject(template)
  assert.equal(assetsModule.bakeSkinnedMeshes(template), 4)
  assert.equal(skinnedCount(template), 0)
  const after = new THREE.Box3().setFromObject(template)
  for (const [a, b] of [[before.min, after.min], [before.max, after.max]]) {
    assert.ok(a.distanceTo(b) < 1e-3, 'поза запечённого сундука совпадает с позой файла')
  }
  template.traverse((object) => {
    if (object.isMesh) assert.equal(object.geometry.getAttribute('skinIndex'), undefined)
  })

  const catalog = catalogModule.validatePropModelCatalog(validCatalog([entry('q-chest_wood', ['chest'])]))
  const environment = propsModule.createEnvironmentModels(render.DEFAULT_BOARD_PALETTE, { catalog, models: new Map([['q-chest_wood', template]]) })
  const chest = environment.create(prop({ id: 'chest-far', assetId: 'chest', x: 10.5, y: 7.5, footprint: [{ x: 10, y: 7 }] }))
  assert.equal(chest.userData.modelSource, 'glb')
  const scene = new THREE.Group()
  scene.add(chest)
  scene.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(chest)
  const center = bounds.getCenter(new THREE.Vector3())
  assert.ok(Math.abs(center.x - 10.5) < .05 && Math.abs(center.z - 7.5) < .05, `сундук в клетке (10, 7), а центр ${center.toArray()}`)
  assert.ok(bounds.min.y > -1e-3 && bounds.max.y <= catalogModule.PROP_MODEL_MAX_HEIGHTS.chest + 1e-3)
  scene.add(environment.create(prop({ id: 'chest-near', assetId: 'chest', x: 2.5, y: 3.5, footprint: [{ x: 2, y: 3 }] })))
  const batched = batchModule.batchEnvironmentMeshes(scene)
  assert.ok(batched.batches.length > 0 && batched.batches.every((batch) => batch.count === 2), 'запечённые сундуки участвуют в batching')
  scene.updateMatrixWorld(true)
  const batchedCenter = new THREE.Box3().setFromObject(scene).getCenter(new THREE.Vector3())
  assert.ok(Math.abs(batchedCenter.x - 6.5) < .1 && Math.abs(batchedCenter.z - 5.5) < .1, 'после batching сундуки остаются в своих клетках')
  batched.dispose()
  environment.dispose()
  assetsModule.disposePropModelAssets(new Map([['q-chest_wood', template]]))
})

test('запекание повторяет линейную смесь костей и сохраняет порядок детей', () => {
  const rootGroup = new THREE.Group()
  const before = new THREE.Mesh(new THREE.BoxGeometry(.1, .1, .1)); before.name = 'before'
  const after = new THREE.Mesh(new THREE.BoxGeometry(.1, .1, .1)); after.name = 'after'
  const bone = new THREE.Bone()
  bone.position.set(0, 2, 0)
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const count = geometry.getAttribute('position').count
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(count * 4).fill(0), 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: count * 4 }, (_, index) => index % 4 === 0 ? 1 : 0), 4))
  const skinned = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial())
  skinned.name = 'skinned-lid'
  skinned.position.set(3, 0, 0)
  rootGroup.add(before, skinned, after, bone)
  rootGroup.updateMatrixWorld(true)
  // Поза файла отличается от bind-позы: кость поднята и повёрнута после привязки.
  skinned.bind(new THREE.Skeleton([bone]), skinned.matrixWorld)
  bone.position.set(0, 3, 0)
  bone.rotation.z = Math.PI / 2
  rootGroup.updateMatrixWorld(true)
  const expected = new THREE.Vector3().fromBufferAttribute(geometry.getAttribute('position'), 0)
  skinned.applyBoneTransform(0, expected)
  const firstNormal = new THREE.Vector3().fromBufferAttribute(geometry.getAttribute('normal'), 0)
  const expectedNormal = firstNormal.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
  assert.equal(assetsModule.bakeSkinnedMeshes(rootGroup), 1)
  assert.deepEqual(rootGroup.children.map((child) => child.name), ['before', 'skinned-lid', 'after', ''])
  const baked = rootGroup.getObjectByName('skinned-lid')
  assert.notEqual(baked.isSkinnedMesh, true)
  assert.equal(baked.position.x, 3)
  const actual = new THREE.Vector3().fromBufferAttribute(baked.geometry.getAttribute('position'), 0)
  assert.ok(actual.distanceTo(expected) < 1e-6, `${actual.toArray()} ≈ ${expected.toArray()}`)
  const normal = new THREE.Vector3().fromBufferAttribute(baked.geometry.getAttribute('normal'), 0)
  assert.ok(normal.distanceTo(expectedNormal) < 1e-6, 'нормаль повёрнута вместе с костью')
  // Клон запечённого шаблона не ссылается на скелет и остаётся у точки установки.
  const placed = new THREE.Group(); placed.position.set(10, 0, 7)
  placed.add(rootGroup.clone(true)); placed.updateMatrixWorld(true)
  const center = new THREE.Box3().setFromObject(placed.getObjectByName('skinned-lid')).getCenter(new THREE.Vector3())
  const local = new THREE.Box3().setFromObject(baked).getCenter(new THREE.Vector3())
  assert.ok(center.distanceTo(local.add(new THREE.Vector3(10, 0, 7))) < 1e-6, 'клон в (10, 0, 7) сдвинут ровно на точку установки')
})

test('высота GLB ограничена пределом вида, а не только футпринтом', () => {
  const kinds = [
    ['broom', [.19, 1.31, .19]], ['lamp_post', [.34, 1.71, .36]], ['tree_pine', [.39, 1.53, .39]],
    ['bottle', [.11, .36, .11]], ['night_table', [.69, 1.22, .39]], ['lute', [.44, 1.11, .27]],
  ]
  const catalog = catalogModule.validatePropModelCatalog(validCatalog(kinds.map(([assetId]) => entry(`m-${assetId}`, [assetId]))))
  const environment = propsModule.createEnvironmentModels(render.DEFAULT_BOARD_PALETTE, {
    catalog, models: new Map(kinds.map(([assetId, size]) => [`m-${assetId}`, fakeTemplate(...size)])),
  })
  for (const [assetId, size] of kinds) {
    const model = environment.create(prop({ id: `tall-${assetId}`, assetId, x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] }))
    model.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3())
    const limit = catalogModule.PROP_MODEL_MAX_HEIGHTS[assetId]
    assert.ok(Math.abs(bounds.y - limit) < 1e-6, `${assetId}: тонкая модель упирается в предел ${limit}, а высота ${bounds.y.toFixed(2)}`)
    assert.ok(Math.abs(bounds.x / bounds.y - size[0] / size[1]) < 1e-6, `${assetId}: пропорции модели сохранены`)
  }
  assert.ok(catalogModule.PROP_MODEL_MAX_HEIGHTS.broom >= .85 && catalogModule.PROP_MODEL_MAX_HEIGHTS.broom <= .95, 'метла по грудь герою 1.25–1.4')
  assert.ok(catalogModule.PROP_MODEL_MAX_HEIGHTS.bottle < .73, 'бутылка ниже столешницы')
  environment.dispose()
})

test('широкий низкий GLB по-прежнему вписывается по футпринту', () => {
  const catalog = catalogModule.validatePropModelCatalog(validCatalog([entry('round-table', ['table_round'])]))
  const environment = propsModule.createEnvironmentModels(render.DEFAULT_BOARD_PALETTE, { catalog, models: new Map([['round-table', fakeTemplate(1.56, .74, 1.56)]]) })
  const model = environment.create(prop({ id: 'low-table', assetId: 'table_round', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }] }))
  model.updateMatrixWorld(true)
  const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3())
  assert.ok(Math.abs(size.x - render.PROP_FOOTPRINT_FILL) < 1e-6, 'ширина задана клеткой')
  assert.ok(size.y < catalogModule.PROP_MODEL_MAX_HEIGHTS.table_round)
  environment.dispose()
})

test('предел высоты: запись манифеста перекрывает таблицу, ключи таблицы — существующие asset id', () => {
  const catalog = catalogModule.validatePropModelCatalog(validCatalog([{ ...entry('custom-broom', ['broom']), maxHeight: .5 }, { ...entry('bad-limit', ['mug']), maxHeight: -1 }]))
  assert.equal(catalog.models[0].maxHeight, .5)
  assert.equal(catalog.models[1].maxHeight, undefined)
  assert.equal(catalogModule.propModelMaxHeight('broom', catalog.models[0]), .5)
  assert.equal(catalogModule.propModelMaxHeight('mug', catalog.models[1]), catalogModule.PROP_MODEL_MAX_HEIGHTS.mug)
  assert.equal(catalogModule.propModelMaxHeight('stairs_up'), null)
  assert.equal(catalogModule.propModelMaxHeight('toString'), null)
  for (const [assetId, limit] of Object.entries(catalogModule.PROP_MODEL_MAX_HEIGHTS)) {
    assert.ok(assetById(assetId), `${assetId}: существующий asset id`)
    assert.ok(limit > 0 && limit <= 3, `${assetId}: предел ${limit} в разумных границах`)
  }
})

test('bbox и maxHeight дают одинаковый tall-thin fit в 2D и 3D после поворота footprint', () => {
  const tall = {
    key: 'bottle-tall', label: 'Tall bottle', category: 'test', url: '/assets/models/environment/bottle-tall.glb',
    assetIds: ['bottle'], yaw: 0, maxHeight: .6, size: [.8, 3, .2], preview: { x: 0, y: 0, w: 80, h: 20 },
  }
  const catalog = catalogModule.validatePropModelCatalog({ version: 1, models: [tall] })
  assert.ok(Math.abs(catalogModule.propModelFit('bottle', catalog.models[0], 1, 2, render.PROP_FOOTPRINT_FILL) - .2) < 1e-12)
  const template = fakeTemplate(.8, 3, .2)
  const environment = propsModule.createEnvironmentModels(render.DEFAULT_BOARD_PALETTE, { catalog, models: new Map([['bottle-tall', template]]) })
  const value = prop({ id: 'tall-bottle', assetId: 'bottle', rotation: 90, footprint: [{ x: 10, y: 20 }, { x: 11, y: 20 }] })
  const model = environment.create(value)
  model.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(model)
  const modelSize = bounds.getSize(new THREE.Vector3())
  assert.ok(Math.abs(modelSize.z / modelSize.x - 4) < .01, '3D сохраняет повернутый узкий footprint')
  assert.ok(Math.abs(modelSize.y - .6) < 1e-6, '3D применяет maxHeight')

  const calls = []
  const context = new Proxy({ drawImage: (...args) => calls.push(args) }, {
    get(target, key) { return key in target ? target[key] : () => undefined },
    set(target, key, next) { target[key] = next; return true },
  })
  const map = createTacticalMap({ width: 12, height: 22, fill: { passable: true, revealed: true, material: 'stone' } })
  addProp(map, value)
  render.drawProps(context, {
    map, palette: render.DEFAULT_BOARD_PALETTE, cellSize: 48,
    modelPropAtlas: { catalog, texture: { image: 'model-preview', width: 256, height: 256 }, key: 'model-atlas' },
  }, { tileX: 0, tileY: 1 })
  const image = calls.find((args) => args[0] === 'model-preview')
  assert.ok(image, '2D использует preview модели')
  assert.ok(Math.abs(image[7] / image[8] - 4) < .01, '2D сохраняет тот же узкий габарит после поворота')
  assert.ok(Math.abs(image[7] - 7.68) < .05 && Math.abs(image[8] - 1.92) < .05, '2D применяет тот же maxHeight fit')
  environment.dispose()
})

test('реальные тонкие GLB библиотеки не вырастают выше предела вида', async () => {
  const cases = [['sk-household-broom', 'broom'], ['sk-lamp-post', 'lamp_post'], ['qn-pine_4', 'tree_pine'], ['q-bottle_1', 'bottle']]
  for (const [key, assetId] of cases) {
    const { model, template } = await realTemplate(key)
    assetsModule.bakeSkinnedMeshes(template)
    template.rotation.y = model.yaw * Math.PI / 180
    template.updateMatrixWorld(true)
    const catalog = catalogModule.validatePropModelCatalog(validCatalog([entry(key, [assetId])]))
    const environment = propsModule.createEnvironmentModels(render.DEFAULT_BOARD_PALETTE, { catalog, models: new Map([[key, template]]) })
    const placed = environment.create(prop({ id: `real-${key}`, assetId, x: 4.5, y: 4.5, footprint: [{ x: 4, y: 4 }] }))
    placed.updateMatrixWorld(true)
    const height = new THREE.Box3().setFromObject(placed).getSize(new THREE.Vector3()).y
    assert.ok(height <= catalogModule.PROP_MODEL_MAX_HEIGHTS[assetId] + 1e-3, `${key}: ${height.toFixed(2)} клетки`)
    environment.dispose()
    assetsModule.disposePropModelAssets(new Map([[key, template]]))
  }
})

test('настенная модель, собранная висящей, не садится на пол, а повисает у верха стены', () => {
  const catalog = catalogModule.validatePropModelCatalog({ version: 1, models: [entry('peg-rack', ['tool_peg_rack'])] })
  // Как стойка с крюками из пакета стиля: деталь поднята над нулём ещё в GLB.
  const hung = fakeTemplate(1.2, .35, .1)
  hung.children[0].position.y = 1.1
  const environment = propsModule.createEnvironmentModels(render.DEFAULT_BOARD_PALETTE, { catalog, models: new Map([['peg-rack', hung]]) })
  const onWall = environment.create(prop({ id: 'rack-wall', assetId: 'tool_peg_rack', footprint: [{ x: 10, y: 20 }, { x: 11, y: 20 }], mount: { kind: 'wall', side: 'n' } }))
  onWall.updateMatrixWorld(true)
  const wallBounds = new THREE.Box3().setFromObject(onWall)
  assert.ok(wallBounds.min.y > .3, 'висящая вещь поднята над полом')
  assert.ok(Math.abs(wallBounds.max.y - .8) < 1e-6, 'верх — у кромки стены доски')
  // Та же модель без крепления к стене стоит на полу, как и прежде.
  const loose = environment.create(prop({ id: 'rack-floor', assetId: 'tool_peg_rack', footprint: [{ x: 10, y: 20 }, { x: 11, y: 20 }] }))
  loose.updateMatrixWorld(true)
  assert.ok(Math.abs(new THREE.Box3().setFromObject(loose).min.y) < 1e-6)
  environment.dispose()
})

test('2D-каталог из всего пакета выбирает тот же style-вариант, что 3D для предметов сцены', () => {
  const base = catalogModule.validatePropModelCatalog(validCatalog([entry('barrel-base', ['barrel'], 11), entry('crate-base', ['crate'], 12)]))
  const stylePack = {
    style: 'stylized', revision: 'd'.repeat(16), floors: {}, materials: {}, walls: {},
    atlas: { image: '/assets/styles/stylized/topdown.webp', key: 'e'.repeat(16) },
    props: {
      barrel: [
        { key: 'style-barrel-a', url: '/assets/styles/stylized/props/barrel_a.glb', yaw: 0, preview: { x: 1, y: 1, w: 8, h: 8 } },
        { key: 'style-barrel-b', url: '/assets/styles/stylized/props/barrel_b.glb', yaw: 0, preview: { x: 9, y: 1, w: 8, h: 8 } },
      ],
      crate: [{ key: 'style-crate', url: '/assets/styles/stylized/props/crate.glb', yaw: 0, preview: { x: 17, y: 1, w: 8, h: 8 } }],
    },
  }
  const props = ['b-1', 'b-2', 'b-3', 'b-4'].map((id) => prop({ id, assetId: 'barrel' }))
  const scene = render.withStyleProps(base, stylePack, props)
  const whole = render.withStyleAssets(base, stylePack, Object.keys(stylePack.props))
  for (const value of props) assert.equal(catalogModule.propModelFor(whole, 'barrel', value.id)?.key, catalogModule.propModelFor(scene, 'barrel', value.id)?.key, value.id)
  assert.equal(catalogModule.propModelFor(whole, 'crate', 'c-1')?.source, 'style', 'вид, ещё не раскрытый на сцене, уже в каталоге 2D')
})

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { Box3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

// Сборка должна жить внутри репозитория: с временным каталогом за его
// пределами Node не видит bare-import `three` из `actor-models.mjs`.
const testTempRoot = fileURLToPath(new URL('../tmp/', import.meta.url))
mkdirSync(testTempRoot, { recursive: true })
const buildDir = mkdtempSync(join(testTempRoot, 'actor-models-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const source = fileURLToPath(new URL('../src/actor-models.ts', import.meta.url))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', buildDir, source,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
renameSync(join(buildDir, 'actor-models.js'), join(buildDir, 'actor-models.mjs'))
const models = await import(pathToFileURL(join(buildDir, 'actor-models.mjs')).href)
const manifest = JSON.parse(readFileSync(new URL('../public/assets/models/manifest.json', import.meta.url), 'utf8'))
const kaykitRoot = fileURLToPath(new URL('../public/assets/models/kaykit/', import.meta.url))
const kaykitAssets = [
  { key: 'warrior', file: 'knight.glb' },
  { key: 'mage', file: 'mage.glb' },
  { key: 'rogue', file: 'rogue.glb' },
  { key: 'skeleton', file: 'skeleton-warrior.glb' },
]
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

test('каталог фигурок содержит шесть профилей с правами и локальными путями', () => {
  const validated = models.validateModelManifest(manifest)
  assert.equal(validated.version, 1)
  for (const profile of ['warrior', 'mage', 'rogue', 'goblin', 'skeleton', 'beast']) assert.ok(validated.models.some((entry) => entry.profile === profile), `${profile}: базовый профиль отсутствует`)
  assert.ok(validated.models.every((entry) => entry.rights.source && entry.rights.license))
  assert.deepEqual(models.availableActorModels(validated).map((entry) => entry.key), validated.models.map((entry) => entry.key))
})

test('разрешение уважает override, точный actor id и архетип', () => {
  const catalog = {
    version: 1,
    models: [
      { key: 'custom-hero', profile: 'warrior', actorIds: ['hero-7'], archetypes: ['fighter'], rights: { source: 'test', license: 'original' } },
      { key: 'custom-enemy', profile: 'goblin', actorIds: [], archetypes: ['goblin'], rights: { source: 'test', license: 'original' } },
    ],
  }
  assert.equal(models.resolveModelProfile({ id: 'hero-7', label: 'Кто-то', kind: 'hero', modelKey: 'custom-enemy' }, catalog).key, 'custom-enemy')
  assert.equal(models.resolveModelProfile({ id: 'hero-7', label: 'Кто-то', kind: 'hero' }, catalog).key, 'custom-hero')
  assert.equal(models.resolveModelProfile({ id: 'enemy-1', label: 'Гоблин', kind: 'enemy' }, catalog).key, 'custom-enemy')
})

test('точный архетип имеет приоритет над fuzzy-профилем, неизвестный гуманоид — воин', () => {
  const catalog = {
    version: 1,
    models: [
      { key: 'generic-warrior', profile: 'warrior', actorIds: [], archetypes: [], rights: { source: 'test', license: 'original' } },
      { key: 'fighter-rogue', profile: 'rogue', actorIds: [], archetypes: ['fighter'], rights: { source: 'test', license: 'original' } },
    ],
  }
  assert.equal(models.resolveModelProfile({ id: 'hero-8', label: 'Кто-то', kind: 'hero', archetype: 'fighter' }, catalog).key, 'fighter-rogue')
  assert.equal(models.resolveModelProfile({ id: 'bandit-1', label: 'Разбойник', kind: 'enemy', archetype: 'humanoid' }, manifest).profile, 'warrior')
})

test('пути GLB ограничены локальным каталогом', () => {
  assert.equal(models.safeModelUrl('/assets/models/warrior.glb'), '/assets/models/warrior.glb')
  assert.equal(models.safeModelUrl('warrior.glb'), '/assets/models/warrior.glb')
  for (const value of ['https://cdn.example/x.glb', '//cdn.example/x.glb', '/assets/models/../x.glb', '/assets/models/x.bin', 'data:model/gltf-binary;base64,abc']) {
    assert.equal(models.safeModelUrl(value), null, value)
  }
})

test('процедурные фигурки различимы, стоят на y=0 и освобождают ресурсы', () => {
  for (const profile of ['warrior', 'mage', 'rogue', 'goblin', 'skeleton', 'beast']) {
    const actor = models.createProceduralActorModel({ id: `actor-${profile}`, label: profile, kind: 'enemy', archetype: profile }, manifest)
    assert.equal(actor.source, 'procedural')
    assert.equal(actor.profile, profile)
    assert.ok(Math.abs(actor.modelHeight - (profile === 'goblin' || profile === 'beast' ? 1.18 : 1.4)) < 1e-8)
    assert.ok(actor.children.length > 0)
    const bounds = new Box3().setFromObject(actor)
    assert.ok(bounds.min.y >= -.0001, `${profile}: feet должны начинаться на y=0`)
    assert.ok(bounds.max.y > 1, `${profile}: фигурка должна быть объёмной`)
    for (const pose of ['idle', 'walk', 'attack', 'cast', 'hit', 'death']) actor[pose]?.(.5)
    actor.dispose()
    actor.dispose()
    assert.equal(actor.children.length, 0)
  }
})

function glbWithJson(json, binary = new Uint8Array()) {
  const encoded = new TextEncoder().encode(JSON.stringify(json))
  const jsonChunkLength = Math.ceil(encoded.length / 4) * 4
  const binaryChunkLength = binary.length ? Math.ceil(binary.length / 4) * 4 : 0
  const bytes = new Uint8Array(12 + 8 + jsonChunkLength + (binaryChunkLength ? 8 + binaryChunkLength : 0))
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, bytes.byteLength, true)
  view.setUint32(12, jsonChunkLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  bytes.set(encoded, 20)
  // GLB JSON padding is spaces; GLTFLoader passes the chunk directly to
  // JSON.parse, where NUL padding would be an invalid trailing character.
  bytes.fill(0x20, 20 + encoded.length, 20 + jsonChunkLength)
  if (binaryChunkLength) {
    const offset = 20 + jsonChunkLength
    view.setUint32(offset, binaryChunkLength, true)
    view.setUint32(offset + 4, 0x004e4942, true)
    bytes.set(binary, offset + 8)
  }
  return bytes.buffer
}

test('GLB с embedded JSON проходит, внешняя uri-ссылка отклоняется', () => {
  const valid = models.validateGlbContainer(glbWithJson({ asset: { version: '2.0' }, scenes: [{ nodes: [] }] }))
  assert.equal(valid.hasBinaryChunk, false)
  assert.throws(() => models.validateGlbContainer(glbWithJson({ asset: { version: '2.0' }, buffers: [{ uri: 'mesh.bin', byteLength: 0 }] })), /внешние ресурсы/u)
})

test('подготовленные KayKit GLB проходят локальную проверку контейнера', () => {
  for (const { file } of kaykitAssets) {
    const report = models.validateGlbContainer(readFileSync(join(kaykitRoot, file)))
    assert.equal(report.hasBinaryChunk, true, `${file}: отсутствует BIN chunk`)
    assert.deepEqual(report.json.animations?.map((animation) => animation.name), ['idle', 'walk', 'attack', 'cast', 'hit', 'death'], `${file}: должен содержать шесть подготовленных клипов`)
    assert.ok(Array.isArray(report.json.images) && report.json.images.every((image) => image && image.bufferView != null), `${file}: изображение не встроено bufferView`)
  }
})

test('все KayKit GLB проходят loader lifecycle, позы, тени и disposal', async () => {
  const previousSelf = globalThis.self
  const previousCreateImageBitmap = globalThis.createImageBitmap
  // Node не умеет декодировать PNG, поэтому возвращаем минимальный ImageBitmap
  // только для проверки геометрии/клипов. В браузере это делает нативный API.
  globalThis.self = globalThis
  globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} })
  try {
    for (const { key, file } of kaykitAssets) {
      const bytes = readFileSync(join(kaykitRoot, file))
      const actor = await models.createActorModel({ id: `kaykit-${key}`, label: key, kind: key === 'skeleton' ? 'enemy' : 'hero', modelKey: key }, {
        manifest,
        fetcher: async () => new Response(bytes, { status: 200, headers: { 'content-type': 'model/gltf-binary' } }),
      })
      assert.equal(actor.source, 'glb', `${file}: должен загрузиться GLB, а не fallback`)
      assert.equal(actor.modelHeight, 1.4)
      assert.ok(Math.abs(actor.position.x) < 1e-8 && Math.abs(actor.position.z) < 1e-8, `${file}: GLB origin rig-а не должен съезжать из-за оружия/накидки`)
      const bounds = new Box3().setFromObject(actor)
      assert.ok(Number.isFinite(bounds.min.x) && Number.isFinite(bounds.min.y) && Number.isFinite(bounds.min.z), `${file}: bounds должны быть конечными`)
      assert.ok(bounds.min.y >= -.0001 && bounds.max.y <= 1.4001, `${file}: GLB должен стоять в нормализованном диапазоне высоты`)
      const bones = []
      const renderables = []
      actor.traverse((object) => {
        if (object.isBone) bones.push(object)
        if (object.isMesh) renderables.push(object)
      })
      assert.ok(bones.length > 0, `${file}: должен содержать скелет`)
      assert.ok(renderables.length > 0 && renderables.every((object) => object.castShadow && object.receiveShadow), `${file}: mesh должен отбрасывать и принимать тени`)
      const poseSignature = () => {
        actor.updateMatrixWorld(true)
        return JSON.stringify(bones.map((bone) => ({ position: bone.position.toArray(), quaternion: bone.quaternion.toArray() })))
      }
      actor.idle?.(0)
      actor.update(.001)
      const idleStart = poseSignature()
      actor.idle?.(.5)
      actor.update(.001)
      assert.notEqual(poseSignature(), idleStart, `${file}: idle должен менять кости`)
      actor.idle?.()
      actor.update(.001)
      const idlePlaybackStart = poseSignature()
      actor.update(.2)
      assert.notEqual(poseSignature(), idlePlaybackStart, `${file}: idle() без progress должен проигрываться через update`)
      for (const pose of ['walk', 'attack', 'cast', 'hit']) {
        assert.equal(typeof actor[pose], 'function', `${file}: отсутствует поза ${pose}`)
        actor[pose](.5)
        actor.update(.001)
      }
      actor.death?.(1)
      actor.update(.001)
      const deathEnd = poseSignature()
      actor.update(.5)
      assert.equal(poseSignature(), deathEnd, `${file}: конечная поза death должна сохраняться`)
      actor.dispose()
      assert.equal(actor.children.length, 0, `${file}: dispose должен очистить Group`)
    }
  } finally {
    if (previousSelf === undefined) delete globalThis.self
    else globalThis.self = previousSelf
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap
    else globalThis.createImageBitmap = previousCreateImageBitmap
  }
})

test('embedded-текстура GLB в браузерном пути идёт через HTML Image, а не fetch(blob:)', async () => {
  const previousSelf = globalThis.self
  const previousCreateImageBitmap = globalThis.createImageBitmap
  const previousDocument = globalThis.document
  let imageBitmapCalls = 0
  const makeImage = () => {
    const listeners = new Map()
    const image = { width: 4, height: 4, complete: false, addEventListener(type, listener) { listeners.set(type, listener) }, removeEventListener(type) { listeners.delete(type) } }
    Object.defineProperty(image, 'src', { set(value) { image.url = value; image.complete = true; queueMicrotask(() => listeners.get('load')?.call(image)) }, get() { return image.url } })
    return image
  }
  globalThis.self = globalThis
  globalThis.createImageBitmap = async () => { imageBitmapCalls += 1; throw new Error('CSP ImageBitmap path must not run') }
  globalThis.document = { createElementNS(_namespace, name) { assert.equal(name, 'img'); return makeImage() } }
  try {
    const bytes = readFileSync(join(kaykitRoot, 'knight.glb'))
    const actor = await models.createActorModel({ id: 'csp-knight', label: 'Рыцарь', kind: 'hero', modelKey: 'warrior' }, {
      manifest,
      fetcher: async () => new Response(bytes, { status: 200, headers: { 'content-type': 'model/gltf-binary' } }),
    })
    assert.equal(actor.source, 'glb', 'HTML Image path должен позволить загрузку GLB при заблокированном fetch(blob:)')
    let texturedMeshes = 0
    actor.traverse((object) => {
      const surfaces = Array.isArray(object.material) ? object.material : object.material ? [object.material] : []
      if (surfaces.some((surface) => surface.map)) texturedMeshes += 1
    })
    assert.ok(texturedMeshes > 0, 'после CSP-safe загрузки материалы GLB должны иметь map')
    assert.equal(imageBitmapCalls, 0)
    actor.dispose()
  } finally {
    if (previousSelf === undefined) delete globalThis.self
    else globalThis.self = previousSelf
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap
    else globalThis.createImageBitmap = previousCreateImageBitmap
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})

test('self-contained GLB загружается через loader и освобождается как ActorModel', async () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 1])
  const indices = new Uint16Array([0, 1, 2])
  const binary = new Uint8Array(44)
  binary.set(new Uint8Array(positions.buffer), 0)
  binary.set(new Uint8Array(indices.buffer), 36)
  const glb = glbWithJson({
    asset: { version: '2.0', generator: 'actor-models-test' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: 42 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR', min: [0], max: [2] },
    ],
  }, binary)
  const catalog = {
    version: 1,
    models: [{ key: 'triangle-glb', profile: 'warrior', actorIds: [], archetypes: [], url: '/assets/models/triangle.glb', rights: { source: 'test', license: 'original' } }],
  }
  await new Promise((resolve, reject) => new GLTFLoader().parse(glb, '/assets/models/', () => resolve(), reject))
  const actor = await models.createActorModel({ id: 'glb-1', label: 'Треугольник', kind: 'hero', modelKey: 'triangle-glb' }, {
    manifest: catalog,
    fetcher: async () => new Response(glb, { status: 200, headers: { 'content-type': 'model/gltf-binary' } }),
  })
  assert.equal(actor.source, 'glb')
  assert.equal(actor.profile, 'warrior')
  assert.ok(actor.getObjectByName('Mesh_0') || actor.children.length > 0)
  const renderables = []
  actor.traverse((object) => { if (object.isMesh) renderables.push(object) })
  assert.ok(renderables.length > 0)
  assert.ok(renderables.every((object) => object.castShadow && object.receiveShadow), 'GLB mesh должен отбрасывать и принимать тени')
  assert.equal(typeof actor.idle, 'undefined', 'у GLB без idle-клипа метод не обязан появляться')
  actor.dispose()
  assert.equal(actor.children.length, 0)
})

test('ошибка отсутствующего GLB откатывает создание к procedural fallback', async () => {
  const catalog = {
    version: 1,
    models: [{ key: 'local-beast', profile: 'beast', actorIds: [], archetypes: [], url: '/assets/models/missing.glb', rights: { source: 'test', license: 'original' } }],
  }
  const actor = await models.createActorModel({ id: 'missing', label: 'Зверь', kind: 'enemy', modelKey: 'local-beast' }, {
    manifest: catalog,
    fetcher: async () => new Response('нет', { status: 404 }),
  })
  assert.equal(actor.source, 'procedural')
  assert.equal(actor.profile, 'beast')
  actor.dispose()
})

test('отмена до загрузки не вызывает fetch, испорченный каталог даёт fallback', async () => {
  const controller = new AbortController()
  controller.abort(new Error('test abort'))
  let called = false
  await assert.rejects(
    models.createActorModel({ id: 'cancelled', label: 'Воин', kind: 'hero' }, {
      signal: controller.signal,
      fetcher: async () => { called = true; return Response.json(manifest) },
    }),
    /test abort/u,
  )
  assert.equal(called, false)

  const actor = await models.createActorModel({ id: 'bad-catalog', label: 'Гоблин', kind: 'enemy', modelKey: 'goblin' }, {
    manifest: { broken: true },
    fetcher: async () => { throw new Error('не должен вызываться') },
  })
  assert.equal(actor.source, 'procedural')
  assert.equal(actor.profile, 'goblin')
  actor.dispose()
})

test('обновление каталога и GLB перепроверяет HTTP-кеш файлов с постоянным именем', async () => {
  const requests = []
  const catalog = await models.loadActorModelManifest({
    fetcher: async (url, init) => {
      requests.push({ url, cache: init?.cache })
      return Response.json(manifest)
    },
  })
  const actor = await models.createActorModel({ id: 'fresh', label: 'Рыцарь', kind: 'hero', modelKey: 'warrior' }, {
    manifest: catalog,
    fetcher: async (url, init) => {
      requests.push({ url, cache: init?.cache })
      return new Response('нет файла', { status: 404 })
    },
  })
  assert.equal(requests.length, 2)
  assert.ok(requests.every((request) => request.cache === 'no-cache'))
  actor.dispose()
})

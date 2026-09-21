import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const root = fileURLToPath(new URL('../', import.meta.url))
mkdirSync(join(root, 'tmp'), { recursive: true })
const buildDir = mkdtempSync(join(root, 'tmp', 'equipment-models-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const sources = ['equipment-models.ts', 'equipment-rig.ts', 'model-assets.ts'].map((name) => fileURLToPath(new URL(`../src/${name}`, import.meta.url)))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', buildDir, ...sources,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
const serverModule = pathToFileURL(join(root, 'server/equipment-visuals.mjs')).href
for (const name of ['equipment-models.js', 'equipment-rig.js', 'model-assets.js']) {
  const path = join(buildDir, name)
  const source = readFileSync(path, 'utf8')
    .replaceAll('../server/equipment-visuals.mjs', serverModule)
    .replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/gu, (match, before, specifier, after) => /\.(json|mjs|js)$/u.test(specifier) ? match : `${before}${specifier}.mjs${after}`)
  writeFileSync(path, source)
  renameSync(path, path.replace(/\.js$/u, '.mjs'))
}
const models = await import(pathToFileURL(join(buildDir, 'equipment-models.mjs')).href)
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

function glbWithJson(tag, padding = 0) {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0', extras: { tag: `${tag}${'x'.repeat(padding)}` } }, scenes: [{ nodes: [] }] }))
  const chunkLength = (json.length + 3) & ~3
  const bytes = new Uint8Array(20 + chunkLength)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, bytes.byteLength, true)
  view.setUint32(12, chunkLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  bytes.set(json, 20)
  return bytes
}

function baseRig() {
  const root = new THREE.Group()
  const armature = new THREE.Group()
  root.add(armature)
  const bones = new Map()
  const add = (name, parent = armature) => {
    const bone = new THREE.Bone()
    bone.name = name
    parent.add(bone)
    bones.set(name, bone)
    return bone
  }
  const pelvis = add('pelvis')
  const spine = add('spine_03', pelvis)
  add('neck_01', spine)
  add('Head', spine)
  for (const side of ['l', 'r']) {
    const suffix = side === 'l' ? 'left' : 'right'
    const upper = add(`upperarm_${side}`, spine)
    const lower = add(`lowerarm_${side}`, upper)
    add(`hand_${side}`, lower)
    const thigh = add(`thigh_${side}`, pelvis)
    const shin = add(`calf_${side}`, thigh)
    add(`foot_${side}`, shin)
    void suffix
  }
  const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(.45, .7, .24), new THREE.MeshStandardMaterial({ color: '#80654f' }))
  bodyMesh.name = 'base-body'
  spine.add(bodyMesh)
  root.updateMatrixWorld(true)
  return root
}

function modelScene(tag, counters) {
  const scene = new THREE.Group()
  if (tag.startsWith('body')) {
    const chest = new THREE.Group(); chest.name = 'partchest'
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(.5, .35, .3), new THREE.MeshStandardMaterial({ color: '#798b9b' }))
    mesh.name = 'armor-chest'; chest.add(mesh); scene.add(chest)
  } else {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(.12, .65, .08), new THREE.MeshStandardMaterial({ color: '#77838b' }))
    mesh.name = tag.includes('flaming') ? 'flaming-blade' : 'held-model'
    scene.add(mesh)
  }
  scene.traverse((object) => {
    if (!object.isMesh) return
    object.geometry.addEventListener('dispose', () => { counters.geometry += 1 })
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) material?.addEventListener('dispose', () => { counters.material += 1 })
  })
  return scene
}

function fixture({ delay = {}, includeBad = false } = {}) {
  const counters = { geometry: 0, material: 0 }
  const buffers = {
    body: glbWithJson('body', 1),
    sword: glbWithJson('sword', 2),
    flaming: glbWithJson('flaming', 3),
    bad: glbWithJson('bad', 4),
  }
  const manifest = {
    version: 1,
    models: [
      { key: 'armor-plate', url: 'body.glb', parts: ['part:chest'], coverage: ['chest'] },
      { key: 'longsword', url: 'sword.glb', kind: 'blade', variants: { default: 'sword.glb', flaming: 'flaming.glb' } },
      ...(includeBad ? [{ key: 'shield', url: 'bad.glb', kind: 'shield' }] : []),
    ],
  }
  const byUrl = { body: buffers.body, sword: buffers.sword, flaming: buffers.flaming, bad: buffers.bad }
  const calls = []
  const fetcher = async (url, init = {}) => {
    calls.push(url)
    const key = url.endsWith('body.glb') ? 'body' : url.endsWith('sword.glb') ? 'sword' : url.endsWith('flaming.glb') ? 'flaming' : url.endsWith('bad.glb') ? 'bad' : null
    const wait = delay[key] ?? 0
    if (wait) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, wait)
      init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason) }, { once: true })
    })
    if (url.endsWith('manifest.json')) return new Response(JSON.stringify(manifest), { status: 200 })
    if (!key || key === 'bad') return new Response('missing', { status: 404 })
    return new Response(byUrl[key], { status: 200, headers: { 'content-length': String(byUrl[key].byteLength) } })
  }
  const loader = {
    register() {},
    parse(buffer, _path, onLoad) {
      const tag = buffer.byteLength === buffers.body.byteLength ? 'body' : buffer.byteLength === buffers.flaming.byteLength ? 'flaming' : buffer.byteLength === buffers.bad.byteLength ? 'bad' : 'sword'
      queueMicrotask(() => onLoad({ scene: modelScene(tag, counters), animations: [] }))
    },
  }
  return { counters, fetcher, loader, calls }
}

test('manifest принимает server allowlist, монтирует body и held model, а variant виден', async () => {
  const fixture = fixtureForTest()
  const actor = baseRig()
  let changes = 0
  const controller = models.createEquipmentController(actor, {
    height: 1.4, profile: 'warrior', fetcher: fixture.fetcher, loader: fixture.loader,
    onChange: () => { changes += 1 },
  })
  await controller.setLoadout({
    body: { model_key: 'armor-plate' },
    main_hand: { model_key: 'longsword', variant: 'flaming' },
  })
  assert.equal(controller.status, 'ready')
  assert.equal(controller.error, null)
  assert.equal(controller.loadout.main_hand.variant, 'flaming')
  assert.equal(actor.getObjectByName('partchest')?.parent?.type, 'Bone')
  assert.equal(controller.rig.getGrip('right')?.getObjectByName('equipment-main_hand-longsword-flaming')?.userData.visualVariantApplied, 'flaming')
  assert.equal(fixture.calls.filter((url) => url.endsWith('manifest.json')).length, 1)
  assert.equal(changes, 1)
  controller.dispose()
})

test('публичный equipment manifest выводит слоты из server allowlist и покрывает 12 body armor', () => {
  const source = JSON.parse(readFileSync(join(root, 'public/assets/models/equipment/manifest.json'), 'utf8'))
  const manifest = models.validateEquipmentModelManifest(source)
  assert.deepEqual([...new Set(manifest.models.filter((entry) => entry.slot === 'body').map((entry) => entry.key))], [
    'armor-padded', 'armor-leather', 'armor-studded', 'armor-hide', 'armor-chainshirt', 'armor-scalemail',
    'armor-breastplate', 'armor-halfplate', 'armor-ringmail', 'armor-chainmail', 'armor-splint', 'armor-plate',
  ])
  assert.ok(manifest.models.some((entry) => entry.key === 'armor-chainmail' && entry.variant === 'adamantine'))
  assert.ok(manifest.models.some((entry) => entry.key === 'longsword' && entry.slot === 'main_hand'))
  assert.ok(manifest.models.some((entry) => entry.key === 'ring' && entry.slot === 'ring-protection'))
  assert.ok(manifest.models.some((entry) => entry.key === 'ring' && entry.slot === 'ring-fire-resistance'))
  assert.ok(manifest.models.some((entry) => entry.key === 'net' && entry.slot === 'main_hand'))
  assert.ok(manifest.models.some((entry) => entry.key === 'holy-amulet' && entry.slot === 'focus'))
  assert.ok(manifest.models.some((entry) => entry.key === 'holy-emblem' && entry.slot === 'off_hand'))
  assert.ok(manifest.models.some((entry) => entry.key === 'lute' && entry.slot === 'main_hand'))
  assert.ok(manifest.models.every((entry) => entry.url.startsWith('/assets/models/equipment/')))
})

test('все 12 body armor GLB проходят реальный loader и монтируются по sanitized part names', { timeout: 120_000 }, async () => {
  const previousSelf = globalThis.self
  const previousProgressEvent = globalThis.ProgressEvent
  const previousCreateImageBitmap = globalThis.createImageBitmap
  globalThis.self = globalThis
  globalThis.ProgressEvent ??= class { constructor(type, values) { this.type = type; Object.assign(this, values) } }
  globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} })
  try {
    const source = JSON.parse(readFileSync(join(root, 'public/assets/models/equipment/manifest.json'), 'utf8'))
    const manifest = models.validateEquipmentModelManifest(source)
    const keys = [...new Set(manifest.models.filter((entry) => entry.slot === 'body' && entry.variant === 'default').map((entry) => entry.key))]
    assert.equal(keys.length, 12)
    const fetcher = async (url, init = {}) => {
      const file = url.endsWith('manifest.json')
        ? join(root, 'public/assets/models/equipment/manifest.json')
        : join(root, 'public', url.slice(1))
      const bytes = readFileSync(file)
      if (init.signal?.aborted) throw init.signal.reason
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } })
    }
    const actor = baseRig()
    const controller = models.createEquipmentController(actor, { height: 1.4, profile: 'warrior', fetcher, loader: new GLTFLoader() })
    for (const key of keys) {
      await controller.setLoadout({ body: { model_key: key } })
      assert.equal(controller.status, 'ready', key)
      assert.ok(actor.getObjectByName('partchest')?.parent?.isBone, `${key}: грудь не смонтирована в bone`)
      assert.ok(actor.getObjectByName('partwaist')?.parent?.isBone, `${key}: пояс не смонтирован в bone`)
    }
    await controller.setLoadout({
      main_hand: { model_key: 'longsword', variant: 'flaming' },
      off_hand: { model_key: 'shield' },
      'ring-protection': { model_key: 'ring', variant: 'enchanted' },
      'ring-fire-resistance': { model_key: 'ring', variant: 'enchanted' },
      cloak: { model_key: 'cloak', variant: 'enchanted' },
      brooch: { model_key: 'brooch', variant: 'enchanted' },
    })
    assert.equal(controller.status, 'ready')
    assert.ok(actor.getObjectByName('equipment-main_hand-longsword-flaming'))
    assert.ok(actor.getObjectByName('equipment-off_hand-shield-default'))
    assert.ok(actor.getObjectByName('equipment-ring-protection-ring-enchanted'))
    assert.ok(actor.getObjectByName('equipment-ring-fire-resistance-ring-enchanted'))
    assert.ok(actor.getObjectByName('partback')?.parent?.isBone)
    assert.ok(actor.getObjectByName('partcollar')?.parent?.isBone)
    assert.ok(actor.getObjectByName('equipment-brooch-brooch-enchanted'))
    assert.equal(actor.getObjectByName('equipment-main_hand-longsword-flaming')?.userData.visualVariantApplied, 'flaming')
    assert.equal(actor.getObjectByName('equipment-ring-protection-ring-enchanted')?.userData.visualVariantApplied, 'protection')
    assert.equal(actor.getObjectByName('equipment-ring-fire-resistance-ring-enchanted')?.userData.visualVariantApplied, 'fire-resistance')
    await controller.setLoadout({ focus: { model_key: 'holy-amulet' } })
    assert.equal(controller.status, 'ready')
    assert.ok(actor.getObjectByName('partbrooch')?.parent?.isBone, 'носимый фокус не закреплён на груди')
    assert.ok(actor.getObjectByName('amulet-medallion'))
    await controller.setLoadout({ body: { model_key: 'armor-chainmail', variant: 'adamantine' } })
    assert.equal(controller.status, 'ready')
    assert.equal(controller.rig.diagnostics.bodyMask.meshes, 0)
    controller.dispose()
  } finally {
    if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf
    if (previousProgressEvent === undefined) delete globalThis.ProgressEvent; else globalThis.ProgressEvent = previousProgressEvent
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previousCreateImageBitmap
  }
})

test('повторный pending loadout дедуплицируется, новая цель отменяет старую, поздний GLB освобождается', async () => {
  const fixture = fixtureForTest({ delay: { body: 35, sword: 1 } })
  const actor = baseRig()
  const controller = models.createEquipmentController(actor, { height: 1.4, profile: 'warrior', fetcher: fixture.fetcher, loader: fixture.loader })
  const first = controller.setLoadout({ body: { model_key: 'armor-plate' } })
  const duplicate = controller.setLoadout({ body: { model_key: 'armor-plate' } })
  assert.equal(first, duplicate)
  await new Promise((resolve) => setImmediate(resolve))
  const second = controller.setLoadout({ main_hand: { model_key: 'longsword' } })
  await Promise.all([first, second])
  assert.equal(controller.status, 'ready')
  assert.equal(controller.loadout.main_hand.model_key, 'longsword')
  assert.equal(actor.getObjectByName('equipment-body-armor-plate-default'), undefined)
  assert.ok(actor.getObjectByName('equipment-main_hand-longsword-default'))
  assert.equal(fixture.calls.filter((url) => url.endsWith('body.glb')).length, 1)
  controller.dispose()
})

test('A → pending B → A отменяет старый запрос и не перезапускает уже активный A', async () => {
  const fixture = fixtureForTest({ delay: { body: 28, sword: 28 } })
  const actor = baseRig()
  const controller = models.createEquipmentController(actor, { height: 1.4, profile: 'warrior', fetcher: fixture.fetcher, loader: fixture.loader })
  const loadoutA = { body: { model_key: 'armor-plate' } }
  const loadoutB = { main_hand: { model_key: 'longsword' } }
  await controller.setLoadout(loadoutA)
  const pendingB = controller.setLoadout(loadoutB)
  await new Promise((resolve) => setImmediate(resolve))
  const backToA = controller.setLoadout(loadoutA)
  assert.equal(backToA, controller.ready)
  await Promise.all([pendingB, backToA])
  assert.equal(controller.status, 'ready')
  assert.equal(controller.loadout.body.model_key, 'armor-plate')
  assert.equal(actor.getObjectByName('equipment-body-armor-plate-default')?.parent, undefined)
  assert.ok(actor.getObjectByName('partchest')?.parent?.isBone)
  assert.equal(fixture.calls.filter((url) => url.endsWith('body.glb')).length, 1)
  assert.equal(fixture.calls.filter((url) => url.endsWith('sword.glb')).length, 1)
  controller.dispose()
})

test('ошибка замены очищает старое снаряжение и не оставляет частично загруженные ресурсы', async () => {
  const fixture = fixtureForTest({ includeBad: true })
  const actor = baseRig()
  const controller = models.createEquipmentController(actor, { height: 1.4, profile: 'warrior', fetcher: fixture.fetcher, loader: fixture.loader })
  await controller.setLoadout({ main_hand: { model_key: 'longsword' } })
  await controller.setLoadout({ off_hand: { model_key: 'shield' } })
  assert.equal(controller.status, 'error')
  assert.equal(controller.loadout.off_hand.model_key, 'shield')
  assert.equal(controller.rig.getGrip('right')?.getObjectByName('equipment-main_hand-longsword-default'), undefined)
  assert.ok(fixture.counters.geometry >= 1)
  controller.dispose()
})

test('зверь принимает loadout без manifest и не получает floating weapon', async () => {
  const fixture = fixtureForTest()
  const actor = baseRig()
  const controller = models.createEquipmentController(actor, { height: 1.2, profile: 'beast', fetcher: fixture.fetcher, loader: fixture.loader })
  await controller.setLoadout({ main_hand: { model_key: 'longsword' }, body: { model_key: 'armor-plate' } })
  assert.equal(controller.status, 'ready')
  assert.equal(fixture.calls.length, 0)
  assert.equal(controller.rig.getGrip('right'), null)
  controller.dispose()
})

function fixtureForTest(options) {
  return fixture(options)
}

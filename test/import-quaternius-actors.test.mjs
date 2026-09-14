import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { importQuaterniusActors } from '../tools/import-quaternius-actors.mjs'
import { inspectModelFile } from '../tools/import-environment-models.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const TMP_ROOT = join(ROOT, 'tmp')
const SOURCE_ROOT = join(TMP_ROOT, 'quaternius-actors-standard-20260911')
const BASE_DIR = join(SOURCE_ROOT, 'extracted', 'Universal-Base-Characters-Standard', 'Universal Base Characters[Standard]', 'Base Characters', 'Godot - UE')
const OUTFIT_DIR = join(SOURCE_ROOT, 'extracted', 'Modular-Character-Outfits-Fantasy-Standard', 'Modular Character Outfits - Fantasy[Standard]', 'Exports', 'glTF (Godot-Unreal)', 'Outfits')
const UAL_FILE = join(SOURCE_ROOT, 'extracted', 'Universal-Animation-Library-Standard', 'Universal Animation Library[Standard]', 'Unreal-Godot', 'UAL1_Standard.glb')
const SOURCE_READY = [
  join(BASE_DIR, 'Superhero_Male_FullBody.gltf'),
  join(OUTFIT_DIR, 'Male_Peasant.gltf'),
  join(OUTFIT_DIR, 'Male_Ranger.gltf'),
  UAL_FILE,
  join(SOURCE_ROOT, 'Universal-Base-Characters-Standard.zip'),
  join(SOURCE_ROOT, 'Modular-Character-Outfits-Fantasy-Standard.zip'),
  join(SOURCE_ROOT, 'Universal-Animation-Library-Standard.zip'),
].every((file) => existsSync(file))

const CLIPS = ['Idle_Loop', 'Walk_Loop', 'Sword_Attack', 'Spell_Simple_Shoot', 'Hit_Chest', 'Death01']
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

function parseWithLoader(bytes) {
  const previousSelf = globalThis.self
  const previousProgressEvent = globalThis.ProgressEvent
  const previousCreateImageBitmap = globalThis.createImageBitmap
  globalThis.self = globalThis
  globalThis.ProgressEvent ??= class { constructor(type, values) { this.type = type; Object.assign(this, values) } }
  globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} })
  const restore = () => {
    if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf
    if (previousProgressEvent === undefined) delete globalThis.ProgressEvent; else globalThis.ProgressEvent = previousProgressEvent
    if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previousCreateImageBitmap
  }
  return new Promise((resolve, reject) => new GLTFLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '', (gltf) => {
    restore(); resolve(gltf)
  }, (error) => { restore(); reject(error) }))
}

function resourceSets(scene) {
  const result = { geometry: new Set(), material: new Set(), texture: new Set() }
  scene.traverse((object) => {
    if (object.geometry) result.geometry.add(object.geometry)
    const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : []
    for (const material of materials) {
      result.material.add(material)
      for (const value of Object.values(material)) if (value?.isTexture) result.texture.add(value)
    }
  })
  return result
}

function finiteBounds(scene) {
  scene.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(scene)
  assert.equal(box.isEmpty(), false)
  assert.ok([...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite))
}

function playAll(gltf) {
  const root = gltf.scene.getObjectByName('root')
  assert.ok(root)
  for (const clip of gltf.animations) {
    const mixer = new THREE.AnimationMixer(gltf.scene)
    mixer.clipAction(clip).play()
    mixer.update(Math.min(Math.max(1 / 60, clip.duration * .37), .25))
    assert.ok(root.position.toArray().every(Number.isFinite))
    assert.ok(root.position.length() <= 1e-6, `${clip.name}: root motion`)
    finiteBounds(gltf.scene)
    mixer.stopAllAction()
    mixer.uncacheRoot(gltf.scene)
  }
}

function dispose(scene) {
  const resources = resourceSets(scene)
  for (const geometry of resources.geometry) geometry.dispose()
  for (const material of resources.material) material.dispose()
  for (const texture of resources.texture) texture.dispose()
}

test('импорт акторов даёт воспроизводимые самодостаточные GLB с настоящими клипами', { skip: !SOURCE_READY, timeout: 120_000 }, async (t) => {
  const firstDir = await mkdtemp(join(TMP_ROOT, 'quaternius-actor-test-'))
  const secondDir = await mkdtemp(join(TMP_ROOT, 'quaternius-actor-test-'))
  t.after(async () => {
    await Promise.all([rm(firstDir, { recursive: true, force: true }), rm(secondDir, { recursive: true, force: true })])
  })
  const options = { baseDir: BASE_DIR, outfitDir: OUTFIT_DIR, ualFile: UAL_FILE,
    baseArchive: join(SOURCE_ROOT, 'Universal-Base-Characters-Standard.zip'),
    outfitArchive: join(SOURCE_ROOT, 'Modular-Character-Outfits-Fantasy-Standard.zip'),
    animationArchive: join(SOURCE_ROOT, 'Universal-Animation-Library-Standard.zip') }
  await importQuaterniusActors({ ...options, out: firstDir })
  await importQuaterniusActors({ ...options, out: secondDir })
  assert.deepEqual(await readFile(join(firstDir, 'traveler.glb')), await readFile(join(secondDir, 'traveler.glb')))
  assert.deepEqual(await readFile(join(firstDir, 'ranger.glb')), await readFile(join(secondDir, 'ranger.glb')))
  assert.deepEqual(await readFile(join(firstDir, 'manifest.json')), await readFile(join(secondDir, 'manifest.json')))

  const manifest = JSON.parse(await readFile(join(firstDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schema, 'skazanie-actor-candidate/v1')
  assert.equal(manifest.sources.length, 3)
  assert.ok(manifest.sources.every((source) => source.author === 'Quaternius' && source.license === 'CC0-1.0' && /^[a-f0-9]{64}$/u.test(source.archiveSha256)))
  assert.deepEqual(manifest.build.rig, { root: 'root', head: 'Head', handSockets: ['hand_l', 'hand_r'], forwardAxis: '+Z' })
  assert.equal(manifest.build.rootMotion, false)
  assert.deepEqual(manifest.build.sourceInputs, [...manifest.build.sourceInputs].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)))
  assert.ok(manifest.build.sourceInputs.length >= 4)
  assert.ok(manifest.build.sourceInputs.every((input) => !/^[A-Za-z]:|\\/u.test(input.path) && /^[a-f0-9]{64}$/u.test(input.sha256) && input.bytes > 0))
  assert.deepEqual(manifest.profiles.map((profile) => profile.key), ['traveler', 'ranger'])
  assert.ok(manifest.profiles.every((profile) => profile.head.source === 'SuperHero_Male' && profile.head.triangles === 2478 && profile.head.weight === '>0.5'))

  for (const profile of manifest.profiles) {
    const file = join(firstDir, profile.file)
    const inspected = await inspectModelFile(file)
    const bytes = await readFile(file)
    assert.equal(inspected.sha256, digest(bytes))
    assert.ok(inspected.json.images.every((image) => !image.uri && image.bufferView != null))
    const firstGltf = await parseWithLoader(bytes)
    const secondGltf = await parseWithLoader(bytes)
    assert.deepEqual(firstGltf.animations.map((clip) => clip.name), CLIPS)
    assert.ok(firstGltf.animations.every((clip) => clip.duration > 0 && clip.tracks.length > 0))
    assert.ok(firstGltf.scene.getObjectByName('Head'))
    assert.ok(firstGltf.scene.getObjectByName('hand_l'))
    assert.ok(firstGltf.scene.getObjectByName('hand_r'))
    const firstResources = resourceSets(firstGltf.scene)
    const secondResources = resourceSets(secondGltf.scene)
    for (const kind of Object.keys(firstResources)) for (const resource of firstResources[kind]) assert.equal(secondResources[kind].has(resource), false)
    playAll(firstGltf)
    dispose(firstGltf.scene)
    finiteBounds(secondGltf.scene)
    playAll(secondGltf)
    dispose(secondGltf.scene)
  }
})

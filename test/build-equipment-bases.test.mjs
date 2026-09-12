import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { importQuaterniusEquipmentBases } from '../tools/import-quaternius-actors.mjs'
import { inspectModelFile } from '../tools/import-environment-models.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const TMP_ROOT = join(ROOT, 'tmp')
const SOURCE_ROOT = join(TMP_ROOT, 'quaternius-actors-standard-20260911')
const BASE_ROOT = join(SOURCE_ROOT, 'extracted', 'Universal-Base-Characters-Standard', 'Universal Base Characters[Standard]')
const OUTFIT_ROOT = join(SOURCE_ROOT, 'extracted', 'Modular-Character-Outfits-Fantasy-Standard', 'Modular Character Outfits - Fantasy[Standard]')
const SOURCE_READY = [
  join(BASE_ROOT, 'Base Characters', 'Godot - UE', 'Superhero_Male_FullBody.gltf'),
  join(BASE_ROOT, 'Base Characters', 'Godot - UE', 'Superhero_Female_FullBody.gltf'),
  join(OUTFIT_ROOT, 'Exports', 'glTF (Godot-Unreal)', 'Outfits', 'Male_Peasant.gltf'),
  join(OUTFIT_ROOT, 'Exports', 'glTF (Godot-Unreal)', 'Outfits', 'Female_Peasant.gltf'),
  join(SOURCE_ROOT, 'extracted', 'Universal-Animation-Library-Standard', 'Universal Animation Library[Standard]', 'Unreal-Godot', 'UAL1_Standard.glb'),
  join(SOURCE_ROOT, 'Universal-Base-Characters-Standard.zip'),
  join(SOURCE_ROOT, 'Modular-Character-Outfits-Fantasy-Standard.zip'),
  join(SOURCE_ROOT, 'Universal-Animation-Library-Standard.zip'),
].every((file) => existsSync(file))

const CLIPS = ['Idle_Loop', 'Walk_Loop', 'Sword_Attack', 'Spell_Simple_Shoot', 'Hit_Chest', 'Death01']
const REGIONS = ['Arms', 'Body', 'Feet', 'Legs', 'Head_Face', 'Head_Eyes', 'Head_Eyebrows']
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
  return new Promise((resolve, reject) => new GLTFLoader().parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '',
    (gltf) => { restore(); resolve(gltf) },
    (error) => { restore(); reject(error) },
  ))
}

function dispose(scene) {
  const geometries = new Set()
  const materials = new Set()
  const textures = new Set()
  scene.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry)
    const values = Array.isArray(object.material) ? object.material : object.material ? [object.material] : []
    for (const material of values) {
      materials.add(material)
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value)
    }
  })
  for (const texture of textures) texture.dispose()
  for (const material of materials) material.dispose()
  for (const geometry of geometries) geometry.dispose()
}

test('gear-ready bases воспроизводимы, нейтральны и сохраняют 65-bone contract', { skip: !SOURCE_READY, timeout: 180_000 }, async (t) => {
  const firstDir = await mkdtemp(join(TMP_ROOT, 'equipment-base-test-'))
  const secondDir = await mkdtemp(join(TMP_ROOT, 'equipment-base-test-'))
  t.after(async () => Promise.all([
    rm(firstDir, { recursive: true, force: true }),
    rm(secondDir, { recursive: true, force: true }),
  ]))

  await importQuaterniusEquipmentBases({ out: firstDir })
  await importQuaterniusEquipmentBases({ out: secondDir })

  const manifest = JSON.parse(await readFile(join(firstDir, 'manifest.json'), 'utf8'))
  const notice = JSON.parse(await readFile(join(firstDir, 'NOTICE.json'), 'utf8'))
  assert.equal(manifest.schema, 'skazanie-equipment-base-candidate/v1')
  assert.equal(manifest.build.packer, 'tools/import-quaternius-actors.mjs')
  assert.deepEqual(manifest.profiles.map((profile) => profile.key), ['human-male', 'human-female'])
  assert.deepEqual(manifest.build.rig, { root: 'root', head: 'Head', handSockets: ['hand_l', 'hand_r'], bones: 65, forwardAxis: '+Z' })
  assert.equal(manifest.build.feetOrigin, 'minY=0')
  assert.deepEqual(manifest.build.regions, { arms: 'Arms', body: 'Body', legs: 'Legs', feet: 'Feet', head: 'Head_Face' })
  assert.equal(manifest.sources.length, 3)
  assert.ok(manifest.sources.every((source) => source.author === 'Quaternius' && source.license === 'CC0-1.0' && /^[a-f0-9]{64}$/u.test(source.archiveSha256)))
  assert.deepEqual(manifest.build.sourceInputs, [...manifest.build.sourceInputs].sort((left, right) => left.path.localeCompare(right.path)))
  assert.ok(manifest.build.sourceInputs.every((input) => /^[a-f0-9]{64}$/u.test(input.sha256) && input.bytes > 0 && !/^[A-Za-z]:|\\/u.test(input.path)))

  assert.equal(notice.bakedArmor, false)
  assert.deepEqual(notice.stableRegions, { arms: 'Arms', body: 'Body', legs: 'Legs', feet: 'Feet', head: 'Head_Face' })
  assert.equal(notice.rig.bones, 65)
  assert.ok(notice.safeHideableAccessories.quaterniusRanger.includes('Male_Ranger_Head_Hood'))
  assert.ok(notice.neverHide.includes('Head_Face'))

  for (const profile of manifest.profiles) {
    const file = join(firstDir, profile.file)
    const twin = join(secondDir, profile.file)
    const bytes = await readFile(file)
    assert.deepEqual(bytes, await readFile(twin), `${profile.key}: сборка должна быть детерминированной`)
    const inspected = await inspectModelFile(file)
    assert.equal(inspected.sha256, digest(bytes))
    assert.ok(inspected.json.buffers.every((buffer) => !buffer.uri))
    assert.ok(inspected.json.images.every((image) => !image.uri && image.bufferView != null))
    assert.deepEqual(inspected.json.animations.map((animation) => animation.name), CLIPS)
    const meshNodeNames = inspected.json.nodes.filter((node) => Number.isInteger(node.mesh)).map((node) => node.name)
    for (const name of REGIONS) assert.ok(meshNodeNames.includes(name), `${profile.key}: отсутствует стабильный mesh region ${name}`)
    assert.ok(meshNodeNames.every((name) => !/(?:armor|plate|chain|mail|helmet|shield)/iu.test(name)), `${profile.key}: в основе не должно быть baked armor`)
    assert.equal(inspected.json.skins[0].joints.length, 65)
    assert.equal(inspected.json.extras.skazanie.gearBase.armor, 'none-baked')
    assert.equal(inspected.json.extras.skazanie.gearBase.forwardAxis, '+Z')
    assert.equal(inspected.json.extras.skazanie.gearBase.feetOrigin, 'minY=0')

    const first = await parseWithLoader(bytes)
    const second = await parseWithLoader(bytes)
    assert.ok(first.scene.getObjectByName('root'))
    assert.ok(first.scene.getObjectByName('Head'))
    for (const name of ['Arms', 'Body', 'Feet', 'Legs', 'Head_Face']) {
      const region = first.scene.getObjectByName(name)
      assert.ok(region, `${profile.key}: runtime region ${name}`)
      let skinned = 0
      region.traverse((object) => { if (object.isSkinnedMesh) skinned += 1 })
      assert.ok(skinned > 0, `${profile.key}/${name}: region must be skinned`)
    }
    first.scene.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(first.scene)
    assert.ok(Math.abs(box.min.y) < 1e-5, `${profile.key}: feet origin ${box.min.y}`)
    assert.ok([...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite))
    for (const clip of first.animations) {
      const mixer = new THREE.AnimationMixer(first.scene)
      mixer.clipAction(clip).play()
      mixer.update(Math.min(Math.max(1 / 60, clip.duration * .37), .25))
      const root = first.scene.getObjectByName('root')
      assert.ok(root.position.toArray().every(Number.isFinite))
      assert.ok(root.position.length() <= 1e-6, `${profile.key}/${clip.name}: root motion`)
      mixer.stopAllAction()
      mixer.uncacheRoot(first.scene)
    }
    assert.notEqual(first.scene, second.scene)
    dispose(first.scene)
    dispose(second.scene)
  }
})

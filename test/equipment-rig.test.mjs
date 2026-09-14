import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(rootDir, 'tmp'), { recursive: true })
const buildDir = mkdtempSync(join(rootDir, 'tmp', 'equipment-rig-'))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
const source = fileURLToPath(new URL('../src/equipment-rig.ts', import.meta.url))
const compiled = spawnSync(process.execPath, [
  compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2022,DOM', '--strict', '--skipLibCheck', '--outDir', buildDir, source,
], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
renameSync(join(buildDir, 'equipment-rig.js'), join(buildDir, 'equipment-rig.mjs'))
const { createEquipmentRig } = await import(pathToFileURL(join(buildDir, 'equipment-rig.mjs')).href)
process.on('exit', () => rmSync(buildDir, { recursive: true, force: true }))

globalThis.self = globalThis
globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() {} })

const assetRoot = join(rootDir, 'public', 'assets', 'models')
const actorFiles = {
  quaternius: join(assetRoot, 'quaternius', 'traveler-77c0b0bb.glb'),
  kaykit: join(assetRoot, 'kaykit', 'knight.glb'),
  goblin: join(assetRoot, 'quaternius', 'actors-b892de8fd4f015796032', 'goblin.glb'),
  skeleton: join(assetRoot, 'quaternius', 'actors-b892de8fd4f015796032', 'skeleton.glb'),
  beast: join(assetRoot, 'quaternius', 'actors-b892de8fd4f015796032', 'beast.glb'),
}
const swordFile = join(assetRoot, 'environment', 'quaternius', 'sword_bronze.glb')
const equipmentDir = join(assetRoot, 'equipment', 'equipment-974d74b8011cdec3a3e9b593')
const armorFile = join(equipmentDir, 'armor-plate.glb')
const humanBaseDir = join(assetRoot, 'quaternius', 'equipment-bases-40520897dfea4af085180fc82b0083baa')

function parseGlb(file) {
  const bytes = readFileSync(file)
  return new Promise((resolve, reject) => new GLTFLoader().parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '', resolve, reject,
  ))
}

async function normalizedActor(file, profile, height = 1.4) {
  const gltf = await parseGlb(file)
  const actor = new THREE.Group()
  actor.name = `test-${profile}`
  actor.add(gltf.scene)
  actor.updateMatrixWorld(true)
  const before = new THREE.Box3().setFromObject(actor)
  const currentHeight = before.max.y - before.min.y
  actor.scale.setScalar(height / currentHeight)
  actor.position.y = -before.min.y * height / currentHeight
  actor.updateMatrixWorld(true)
  const idle = gltf.animations.find((clip) => /idle|stand/iu.test(clip.name))
  if (idle) {
    const mixer = new THREE.AnimationMixer(actor)
    const action = mixer.clipAction(idle).reset().setLoop(THREE.LoopOnce, 1).play()
    action.paused = true
    action.time = 0
    mixer.update(0)
    actor.updateMatrixWorld(true)
    action.stop()
    mixer.uncacheRoot(actor)
  }
  return actor
}

function disposeGraph(root) {
  const geometries = new Set()
  const materials = new Set()
  const skeletons = new Set()
  root.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry)
    for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) materials.add(material)
    if (object.isSkinnedMesh && object.skeleton) skeletons.add(object.skeleton)
  })
  for (const material of materials) material.dispose()
  for (const geometry of geometries) geometry.dispose()
  for (const skeleton of skeletons) skeleton.dispose()
  root.clear()
}

function finiteGraph(root) {
  root.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(root)
  assert.equal(bounds.isEmpty(), false, `${root.name}: пустые границы`)
  assert.ok([...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite), `${root.name}: нечисловые границы`)
  root.traverse((object) => assert.ok(object.matrixWorld.elements.every(Number.isFinite), `${root.name}/${object.name}: нечисловая матрица`))
  return bounds
}

test('Quaternius 65-bone GLB получает броню по реальным Bone, а часть следует за позой', async () => {
  const actor = await normalizedActor(actorFiles.quaternius, 'warrior')
  // Одноимённый Mesh не должен затенить настоящий hand_r Bone.
  const impostor = new THREE.Mesh(new THREE.BoxGeometry(.1, .1, .1), new THREE.MeshBasicMaterial())
  impostor.name = 'hand_r'
  actor.add(impostor)
  const rig = createEquipmentRig(actor, { height: 1.4, profile: 'warrior' })
  assert.equal(rig.family, 'quaternius')
  assert.equal(rig.diagnostics.aliases['chest'], 'spine_03')
  assert.equal(rig.diagnostics.aliases['hand-right'], 'hand_r')
  assert.equal(rig.handBones.right?.isBone, true)

  const sourceArmor = (await parseGlb(armorFile)).scene
  const sourcePart = sourceArmor.getObjectByName('partchest')
  assert.ok(sourcePart)
  const part = sourcePart.clone(true)
  const sourcePositions = []
  sourcePart.traverse((object) => { if (object.isMesh) sourcePositions.push([...object.geometry.getAttribute('position').array]) })
  assert.equal(rig.mountPart(part, 'chest'), part)
  assert.equal(part.parent?.name, 'spine_03')
  assert.equal(part.matrixAutoUpdate, false)
  assert.deepEqual(part.position.toArray(), [0, 0, 0], 'каноническая позиция part-группы не должна протечь в кость')
  finiteGraph(part)
  part.traverse((object) => {
    if (!object.isMesh) return
    const before = sourcePositions.shift()
    assert.deepEqual([...object.geometry.getAttribute('position').array], before, 'mount не мутирует исходную геометрию')
  })
  const before = part.getWorldPosition(new THREE.Vector3())
  const chestBone = actor.getObjectByName('spine_03')
  assert.ok(chestBone?.isBone)
  chestBone.rotation.z += .23
  actor.updateMatrixWorld(true)
  assert.ok(part.getWorldPosition(new THREE.Vector3()).distanceTo(before) > 1e-4, 'часть должна следовать за движущейся костью')
  rig.clear()
  assert.equal(part.parent, null)
  assert.deepEqual(part.position.toArray(), [0, .91, 0], 'clear восстанавливает исходную каноническую позицию clone')
  rig.dispose()
  disposeGraph(part)
  disposeGraph(sourceArmor)
  disposeGraph(actor)
})

test('экспортированные human-male/female bases принимают полный plate без раздувания силуэта', async () => {
  const sourceArmor = (await parseGlb(armorFile)).scene
  let armorRoot
  sourceArmor.traverse((object) => { if (object.userData.key === 'armor-plate') armorRoot = object })
  assert.ok(armorRoot)
  const groups = armorRoot.children.filter((object) => typeof object.userData.armorPart === 'string')
  assert.equal(groups.length, 15)
  for (const [file, label] of [['human-male.glb', 'male'], ['human-female.glb', 'female']]) {
    const actor = await normalizedActor(join(humanBaseDir, file), 'warrior')
    const rig = createEquipmentRig(actor, { height: 1.4, profile: 'warrior' })
    let mounted = 0
    for (const group of groups) {
      const part = group.clone(true)
      if (rig.mountPart(part, group.userData.armorPart)) { mounted += 1; finiteGraph(part) }
    }
    assert.equal(mounted, 15, `${label}: полный plate должен закрепиться на всех частях`)
    const bounds = finiteGraph(actor)
    assert.ok(bounds.min.y > -.05 && bounds.max.y < 1.55, `${label}: шлем с гребнем вышел за допустимый рост фигурки`)
    assert.ok(bounds.getSize(new THREE.Vector3()).x < 1.5, `${label}: plate раздувает силуэт по X`)
    rig.clear()
    rig.dispose()
    disposeGraph(actor)
  }
  disposeGraph(sourceArmor)
})

test('оружие из реального GLB крепится в grip0 с canonical world scale и освобождается без общей геометрии', async () => {
  const actor = await normalizedActor(actorFiles.kaykit, 'warrior')
  const rig = createEquipmentRig(actor, { height: 1.4, profile: 'warrior' })
  assert.equal(rig.family, 'kaykit')
  assert.equal(rig.diagnostics.aliases['grip-right'], 'handslotr')
  assert.equal(rig.handBones.right?.isBone, true)
  const gltf = await parseGlb(swordFile)
  const weapon = gltf.scene
  const mesh = weapon.getObjectByProperty('isMesh', true)
  assert.ok(mesh)
  const originalPositions = [...mesh.geometry.getAttribute('position').array]
  assert.equal(rig.mountHeld(weapon, 'right', { kind: 'longsword', handedness: 'one-handed' }), weapon)
  assert.equal(weapon.parent?.name, 'grip0')
  const bounds = finiteGraph(weapon)
  assert.ok(bounds.max.y - bounds.min.y < 2.5, 'оружие не должно разрастись при нормализации руки')
  assert.deepEqual([...mesh.geometry.getAttribute('position').array], originalPositions, 'крепление не мутирует vertices GLB')
  const before = weapon.getWorldPosition(new THREE.Vector3())
  const hand = rig.getHandBone('right')
  assert.ok(hand)
  hand.rotation.x += .18
  actor.updateMatrixWorld(true)
  assert.ok(weapon.getWorldPosition(new THREE.Vector3()).distanceTo(before) > 1e-4, 'оружие должно следовать за handslot')
  rig.clear()
  const staff = (await parseGlb(join(equipmentDir, 'quarterstaff.glb'))).scene
  assert.equal(rig.mountHeld(staff, 'right', { kind: 'quarterstaff', handedness: 'two-handed' }), staff)
  const staffSize = finiteGraph(staff).getSize(new THREE.Vector3())
  assert.ok(staffSize.y > staffSize.x * 3 && staffSize.y > staffSize.z * 3, 'посох должен оставаться вертикальным')
  rig.clear()
  disposeGraph(staff)
  const bow = (await parseGlb(join(equipmentDir, 'longbow.glb'))).scene
  rig.mountHeld(bow, 'right', { kind: 'bow', handedness: 'two-handed' })
  const bowSize = finiteGraph(bow).getSize(new THREE.Vector3())
  assert.ok(bowSize.y > bowSize.z * 2, 'лук должен стоять вертикально, а не лежать в горизонтальной плоскости')
  rig.clear()
  disposeGraph(bow)
  assert.equal(weapon.parent, null)
  rig.dispose()
  disposeGraph(weapon)
  disposeGraph(actor)
})

test('нативные aliases Goblin23/Skeleton17, procedural rig-* и отсутствие рук у зверя ограничены', async () => {
  const cases = [
    ['goblin', 'goblin', 'Torso', 'FistR'],
    ['skeleton', 'skeleton', 'Torso', 'RDownLeg001_end'],
  ]
  for (const [key, profile, chest, rightHand] of cases) {
    const actor = await normalizedActor(actorFiles[key], profile)
    const rig = createEquipmentRig(actor, { height: 1.4, profile })
    assert.equal(rig.family, profile)
    assert.equal(rig.diagnostics.aliases.chest, chest)
    if (profile === 'skeleton') {
      const armor = (await parseGlb(armorFile)).scene
      let armorRoot
      armor.traverse((object) => { if (object.userData.key === 'armor-plate') armorRoot = object })
      assert.ok(armorRoot)
      const groups = armorRoot.children.filter((object) => typeof object.userData.armorPart === 'string')
      assert.equal(groups.length, 15)
      let mounted = 0
      for (const group of groups) {
        const part = group.clone(true)
        if (rig.mountPart(part, group.userData.armorPart)) { mounted += 1; finiteGraph(part) }
      }
      assert.equal(mounted, 15, 'Skeleton17 должен принять все rig-compatible части plate')
      rig.clear()
      disposeGraph(armor)
    }
    if (rightHand) {
      assert.equal(rig.diagnostics.aliases['upper-arm-left'], profile === 'goblin' ? 'UpperArmL' : 'LUpperLeg001')
      assert.equal(rig.diagnostics.aliases['hand-right'], rightHand)
      const gltf = await parseGlb(swordFile)
      assert.equal(rig.mountHeld(gltf.scene, 'right', { kind: 'sword' }), gltf.scene)
      assert.equal(gltf.scene.parent?.name, 'grip0')
      rig.clear()
      disposeGraph(gltf.scene)
    } else {
      assert.equal(rig.getHandBone('right'), null)
      const weapon = new THREE.Group()
      assert.equal(rig.mountHeld(weapon, 'right', { kind: 'sword' }), null)
      assert.equal(weapon.parent, null, 'у скелета без рук оружие не должно плавать рядом')
    }
    rig.dispose()
    disposeGraph(actor)
  }

  const procedural = new THREE.Group()
  for (const name of ['rig-torso', 'rig-pelvis', 'rig-head', 'rig-leftArm', 'rig-rightArm', 'rig-leftLeg', 'rig-rightLeg']) {
    const node = new THREE.Group(); node.name = name; procedural.add(node)
  }
  const proceduralRig = createEquipmentRig(procedural, { height: 1.4, profile: 'warrior' })
  assert.equal(proceduralRig.family, 'procedural')
  assert.equal(proceduralRig.diagnostics.aliases['hand-right'], 'rig-rightArm')
  assert.ok(proceduralRig.getGrip('right'))
  proceduralRig.dispose()
  disposeGraph(procedural)

  const beast = await normalizedActor(actorFiles.beast, 'beast', 1.18)
  const beastRig = createEquipmentRig(beast, { height: 1.18, profile: 'beast' })
  const weapon = new THREE.Group()
  assert.equal(beastRig.family, 'unknown')
  assert.equal(beastRig.mountHeld(weapon, 'right', { kind: 'sword' }), null)
  assert.equal(weapon.parent, null)
  beastRig.dispose()
  disposeGraph(beast)
})

test('coverage заменяет только skinned triangles, сохраняет лицо и восстанавливает исходные meshes', async () => {
  const actor = await normalizedActor(actorFiles.quaternius, 'warrior')
  const rig = createEquipmentRig(actor, { height: 1.4, profile: 'warrior' })
  const original = []
  actor.traverse((object) => {
    if (!object.isSkinnedMesh) return
    original.push({ object, geometry: object.geometry, visible: object.visible, positions: [...object.geometry.getAttribute('position').array] })
  })
  assert.ok(original.length > 0)
  rig.setCoverage(['chest', 'head'])
  assert.ok(rig.diagnostics.bodyMask.masked > 0, 'хотя бы один body mesh должен получить masked clone')
  const clones = []
  actor.traverse((object) => { if (object.userData.equipmentCoverageClone) clones.push(object) })
  assert.equal(clones.length, rig.diagnostics.bodyMask.masked)
  for (const item of original) assert.deepEqual([...item.geometry.getAttribute('position').array], item.positions, `${item.object.name}: исходные vertices не меняются`)
  const maskedSources = new Set(clones.map((clone) => clone.name.replace(/:coverage$/u, '')))
  for (const item of original) if (maskedSources.has(item.object.name)) assert.equal(item.object.visible, false, `${item.object.name}: source скрыт только заменой clone`)
  rig.clear()
  assert.equal(actor.getObjectByName(clones[0].name), undefined)
  for (const item of original) assert.equal(item.object.visible, item.visible, `${item.object.name}: clear восстанавливает видимость`)
  rig.dispose()
  disposeGraph(actor)
})

test('полностью покрытый skinned body получает пустой clone, а после clear исходный mesh возвращается', () => {
  const actor = new THREE.Group()
  const bone = new THREE.Bone(); bone.name = 'spine_03'; bone.position.y = .7
  actor.add(bone)
  const geometry = new THREE.BoxGeometry(.4, .4, .2)
  const vertices = geometry.getAttribute('position').count
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(vertices * 4), 4))
  const weights = new Float32Array(vertices * 4)
  for (let index = 0; index < vertices; index += 1) weights[index * 4] = 1
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
  mesh.bind(new THREE.Skeleton([bone]), new THREE.Matrix4())
  actor.add(mesh)
  const rig = createEquipmentRig(actor, { height: 1.4, profile: 'warrior' })
  rig.setCoverage(['chest'])
  let clone
  actor.traverse((object) => { if (object.userData.equipmentCoverageClone) clone = object })
  assert.ok(clone)
  assert.equal(clone.geometry.index?.count, 0)
  assert.equal(mesh.visible, false)
  rig.clear()
  assert.equal(mesh.visible, true)
  let restoredClone
  actor.traverse((object) => { if (object.userData.equipmentCoverageClone) restoredClone = object })
  assert.equal(restoredClone, undefined)
  rig.dispose()
  disposeGraph(actor)
})

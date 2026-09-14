import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'

import {
  ARMOR_MODELS,
  ARMOR_PART_POSES,
  SHIELD_MODEL,
  armorModelForCatalogId,
  createArmorModel,
} from '../tools/equipment-armor-models.mjs'

const EXPECTED_KEYS = [
  'armor-padded', 'armor-leather', 'armor-studded', 'armor-hide',
  'armor-chainshirt', 'armor-scalemail', 'armor-breastplate', 'armor-halfplate',
  'armor-ringmail', 'armor-chainmail', 'armor-splint', 'armor-plate',
]

function dispose(root) {
  const geometries = new Set()
  const materials = new Set()
  root.traverse((object) => {
    if (!object.isMesh) return
    geometries.add(object.geometry)
    for (const value of Array.isArray(object.material) ? object.material : [object.material]) if (value) materials.add(value)
  })
  for (const value of materials) value.dispose()
  for (const value of geometries) value.dispose()
}

function finiteGeometry(root) {
  let meshes = 0
  const materialNames = new Set()
  root.traverse((object) => {
    assert.ok(object.matrixWorld.elements.every(Number.isFinite), `${object.name}: нечисловая матрица`)
    if (!object.isMesh) return
    meshes += 1
    const positions = object.geometry.getAttribute('position')
    assert.ok(positions && positions.count > 0, `${object.name}: пустая геометрия`)
    assert.ok([...positions.array].every(Number.isFinite), `${object.name}: нечисловая геометрия`)
    for (const value of Array.isArray(object.material) ? object.material : [object.material]) if (value) materialNames.add(value.name)
  })
  return { meshes, materialNames }
}

test('каталог содержит ровно 12 видов брони с полными catalogIds', () => {
  assert.deepEqual(ARMOR_MODELS.map((item) => item.key), EXPECTED_KEYS)
  const keys = new Set()
  const catalogIds = new Set()
  for (const item of ARMOR_MODELS) {
    assert.match(item.key, /^armor-[a-z-]+$/u)
    assert.ok(item.label.length > 2)
    assert.equal(item.source, 'original')
    assert.ok(item.parts.length > 0)
    assert.deepEqual(item.occludes, item.parts.map((part) => part.slice('part:'.length)))
    assert.equal(keys.has(item.key), false)
    keys.add(item.key)
    assert.equal(item.catalogIds.length, 1)
    for (const catalogId of item.catalogIds) {
      assert.match(catalogId, /^srd_5_2_1:[a-z0-9-]+$/u)
      assert.equal(catalogIds.has(catalogId), false)
      catalogIds.add(catalogId)
      assert.equal(armorModelForCatalogId(catalogId)?.key, item.key)
    }
    assert.ok(Object.isFrozen(item))
    assert.ok(Object.isFrozen(item.catalogIds))
    assert.ok(Object.isFrozen(item.parts))
    assert.ok(Object.isFrozen(item.occludes))
  }
  assert.equal(catalogIds.size, 12)
  assert.equal(SHIELD_MODEL.catalogIds[0], 'srd_5_2_1:shield')
  assert.equal(armorModelForCatalogId('srd_5_2_1:shield'), SHIELD_MODEL)
})

test('все комплекты непустые, конечные и сохраняют канонические part-позиции', () => {
  for (const spec of ARMOR_MODELS) {
    const model = createArmorModel(spec.key)
    assert.ok(model, `${spec.key}: фабрика вернула пустой результат`)
    const { meshes, materialNames } = finiteGeometry(model)
    assert.ok(meshes >= spec.parts.length, `${spec.key}: не каждая часть содержит геометрию`)
    assert.ok(materialNames.has('cloth') || materialNames.has('leather') || materialNames.has('steel') || materialNames.has('fur'), `${spec.key}: нет PBR-материала доспеха`)
    for (const partName of spec.parts) {
      const part = model.getObjectByName(partName)
      assert.ok(part, `${spec.key}: отсутствует ${partName}`)
      assert.equal(part.userData.armorPart, partName.slice('part:'.length))
      assert.deepEqual(part.position.toArray(), ARMOR_PART_POSES[part.userData.armorPart])
      assert.ok(part.children.some((child) => child.isMesh || child.children.some((nested) => nested.isMesh)), `${spec.key}/${partName}: пустая часть`)
      const bounds = new THREE.Box3().setFromObject(part)
      assert.equal(bounds.isEmpty(), false, `${spec.key}/${partName}: пустые границы`)
      assert.ok(bounds.min.y < bounds.max.y && bounds.min.x < bounds.max.x && bounds.min.z < bounds.max.z, `${spec.key}/${partName}: вырожденная часть`)
    }
    const bounds = new THREE.Box3().setFromObject(model)
    const size = bounds.getSize(new THREE.Vector3())
    assert.ok(bounds.min.y > -0.02, `${spec.key}: провалился под пол`)
    assert.ok(bounds.max.y < 1.5, `${spec.key}: вышел за канонический рост`)
    assert.ok(size.x > 0.25 && size.z > 0.1, `${spec.key}: слишком тонкий силуэт`)
    dispose(model)
  }
})

test('детали отличают ткань, кожу, кольца, чешую, ламели и полные латы', () => {
  const requiredNodes = new Map([
    ['armor-padded', 'quilt-seam-front'],
    ['armor-leather', 'leather-cuirass-front'],
    ['armor-studded', 'armor-rivet'],
    ['armor-hide', 'hide-fur-front'],
    ['armor-chainshirt', 'chainmail-ring'],
    ['armor-scalemail', 'scale-overlap'],
    ['armor-breastplate', 'breastplate-front'],
    ['armor-halfplate', 'articulated-faulds'],
    ['armor-ringmail', 'ringmail-ring'],
    ['armor-chainmail', 'chainmail-side-ring'],
    ['armor-splint', 'splint-chest-strip-front'],
    ['armor-plate', 'face-opening'],
  ])
  const signatures = new Set()
  for (const spec of ARMOR_MODELS) {
    const model = createArmorModel(spec.key)
    const names = []
    model.traverse((object) => { if (object.name) names.push(object.name) })
    assert.ok(names.includes(requiredNodes.get(spec.key)), `${spec.key}: нет узнаваемой детали`)
    const signature = names.filter((name) => !name.startsWith('part:')).sort().join('|')
    signatures.add(signature)
    dispose(model)
  }
  assert.equal(signatures.size, ARMOR_MODELS.length, 'комплекты не должны быть копиями с другой палитрой')
})

test('щит отдельный, плоский по XY, с лицом +Z и нулевым grip', () => {
  const shield = createArmorModel('shield')
  assert.ok(shield)
  const { meshes, materialNames } = finiteGeometry(shield)
  assert.ok(meshes >= 7)
  assert.ok(materialNames.has('steel') && materialNames.has('brass') && materialNames.has('leather'))
  const grip = shield.getObjectByName('grip')
  assert.ok(grip)
  assert.deepEqual(grip.position.toArray(), [0, 0, 0])
  assert.equal(shield.userData.plane, 'XY')
  assert.equal(shield.userData.faceDirection, '+Z')
  const face = shield.getObjectByName('shield-face')
  assert.ok(face)
  const faceBounds = new THREE.Box3().setFromObject(face)
  assert.ok(faceBounds.max.z > 0 && faceBounds.min.z < 0)
  assert.equal(createArmorModel('unknown'), null)
  dispose(shield)
})

test('части одного комплекта имеют перекрывающиеся канонические якоря', () => {
  const plate = createArmorModel('armor-plate')
  const chest = plate.getObjectByName('part:chest')
  const waist = plate.getObjectByName('part:waist')
  const upperArm = plate.getObjectByName('part:upper-arm-left')
  const forearm = plate.getObjectByName('part:forearm-left')
  const head = plate.getObjectByName('part:head')
  for (const part of [chest, waist, upperArm, forearm, head]) {
    assert.ok(part && part.userData.canonicalPose === true)
    assert.ok(part.children.length > 0)
  }
  const chestBounds = new THREE.Box3().setFromObject(chest)
  const waistBounds = new THREE.Box3().setFromObject(waist)
  const upperArmBounds = new THREE.Box3().setFromObject(upperArm)
  const forearmBounds = new THREE.Box3().setFromObject(forearm)
  assert.ok(chestBounds.max.y >= waistBounds.min.y, 'грудь и пояс не должны разрываться')
  assert.ok(upperArmBounds.min.y <= chestBounds.max.y, 'наплечник должен заходить на плечо')
  assert.ok(forearmBounds.max.y >= upperArmBounds.min.y, 'наруч должен быть связан с плечом')
  dispose(plate)
})

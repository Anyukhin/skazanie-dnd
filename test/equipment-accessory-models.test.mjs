import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'

import { ITEM_CATALOG } from '../server/item-catalog.mjs'
import {
  ACCESSORY_MODELS,
  ACCESSORY_RING_VARIANTS,
  accessoryModelForCatalogId,
  createAccessoryModel,
} from '../tools/equipment-accessory-models.mjs'

const EXPECTED_KEYS = [
  'wand', 'cloak', 'brooch', 'ring',
  'arcane-crystal', 'arcane-orb', 'arcane-rod', 'druidic-mistletoe', 'druidic-totem',
  'holy-amulet', 'holy-emblem', 'holy-reliquary',
  'bagpipes', 'drum', 'dulcimer', 'flute', 'lute', 'lyre', 'horn', 'pan-flute', 'shawm', 'viol',
]
const EXPECTED_CATALOG_IDS = [
  'srd_5_2_1:wand-of-magic-missiles',
  'srd_5_2_1:cloak-of-protection',
  'srd_5_2_1:brooch-of-shielding',
  'srd_5_2_1:ring-of-protection',
  'srd_5_2_1:ring-of-fire-resistance',
  'srd_5_2_1:arcane-focus-crystal',
  'srd_5_2_1:arcane-focus-orb',
  'srd_5_2_1:arcane-focus-rod',
  'srd_5_2_1:druidic-focus-mistletoe',
  'srd_5_2_1:druidic-focus-totem',
  'srd_5_2_1:holy-symbol-amulet',
  'srd_5_2_1:holy-symbol-emblem',
  'srd_5_2_1:holy-symbol-reliquary',
  'srd_5_2_1:bagpipes',
  'srd_5_2_1:drum',
  'srd_5_2_1:dulcimer',
  'srd_5_2_1:flute',
  'srd_5_2_1:lute',
  'srd_5_2_1:lyre',
  'srd_5_2_1:horn',
  'srd_5_2_1:pan-flute',
  'srd_5_2_1:shawm',
  'srd_5_2_1:viol',
]
const MATERIALS = new Set(['cloth', 'leather', 'steel', 'wood', 'bone', 'brass', 'gem'])

function nodesOf(root) {
  const names = new Set()
  root.traverse((object) => { if (object.name) names.add(object.name) })
  return names
}

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

test('реестр содержит 22 ключа и все 23 accessory catalogId', () => {
  assert.deepEqual(ACCESSORY_MODELS.map((item) => item.key), EXPECTED_KEYS)
  const catalogIds = ACCESSORY_MODELS.flatMap((item) => item.catalogIds)
  assert.deepEqual([...catalogIds].sort(), [...EXPECTED_CATALOG_IDS].sort())
  assert.equal(new Set(catalogIds).size, 23)
  for (const item of ACCESSORY_MODELS) {
    assert.equal(item.source, 'original')
    assert.ok(item.label.length > 2)
    assert.ok(item.parts.length > 0)
    assert.ok(item.variants.length > 0)
    assert.ok(Object.isFrozen(item) && Object.isFrozen(item.catalogIds) && Object.isFrozen(item.parts) && Object.isFrozen(item.variants))
    for (const catalogId of item.catalogIds) {
      assert.ok(ITEM_CATALOG[catalogId], `${catalogId}: нет каталожной записи`)
      assert.equal(accessoryModelForCatalogId(catalogId)?.key, item.key)
    }
  }
})

test('кольца используют одну geometry key, но имеют два материальных варианта', () => {
  const ring = ACCESSORY_MODELS.find((item) => item.key === 'ring')
  assert.ok(ring)
  assert.deepEqual(ring.catalogIds, EXPECTED_CATALOG_IDS.slice(3, 5))
  assert.deepEqual(ACCESSORY_RING_VARIANTS.map((item) => item.key), ['protection', 'fire-resistance'])
  assert.deepEqual(ring.variants.map((item) => item.key), ['protection', 'fire-resistance'])
  assert.notEqual(ring.variants[0].materialVariant, ring.variants[1].materialVariant)
  assert.equal(accessoryModelForCatalogId(EXPECTED_CATALOG_IDS[3])?.variant, 'protection')
  assert.equal(accessoryModelForCatalogId(EXPECTED_CATALOG_IDS[4])?.variant, 'fire-resistance')
  const protection = createAccessoryModel('ring', 'protection')
  const fire = createAccessoryModel('ring', 'fire-resistance')
  assert.equal(protection.userData.materialVariant, 'protection')
  assert.equal(fire.userData.materialVariant, 'fire-resistance')
  const protectionColor = protection.getObjectByName('ring-gem').material.color.getHex()
  const fireColor = fire.getObjectByName('ring-gem').material.color.getHex()
  assert.notEqual(protectionColor, fireColor)
  dispose(protection)
  dispose(fire)
})

test('жезл, плащ, брошь и кольцо имеют конечную геометрию и подходящие PBR-материалы', () => {
  const required = new Map([
    ['wand', ['grip', 'wand-shaft', 'wand-focus']],
    ['cloak', ['part:back', 'part:collar', 'cloak-contoured-body', 'cloak-soft-fold-1', 'cloak-hem']],
    ['brooch', ['part:front', 'part:pin', 'brooch-medallion', 'brooch-center-stone']],
    ['ring', ['part:band', 'part:stone', 'ring-band', 'ring-gem']],
  ])
  for (const spec of ACCESSORY_MODELS) {
    const variant = spec.key === 'ring' ? 'protection' : 'default'
    const model = createAccessoryModel(spec.key, variant)
    assert.ok(model, `${spec.key}: фабрика вернула null`)
    model.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(model)
    const size = bounds.getSize(new THREE.Vector3())
    assert.equal(bounds.isEmpty(), false, `${spec.key}: пустые границы`)
    assert.ok([...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite), `${spec.key}: нечисловые границы`)
    assert.ok(size.x > 0 && size.y > 0 && size.z > 0, `${spec.key}: вырожденный размер`)
    let meshCount = 0
    const materialNames = new Set()
    model.traverse((object) => {
      assert.ok(object.matrixWorld.elements.every(Number.isFinite), `${spec.key}/${object.name}: нечисловая матрица`)
      if (!object.isMesh) return
      meshCount += 1
      const values = Array.isArray(object.material) ? object.material : [object.material]
      for (const value of values) {
        if (!value) continue
        assert.equal(MATERIALS.has(value.name), true, `${spec.key}: недопустимый материал ${value.name}`)
        materialNames.add(value.name)
      }
      const position = object.geometry.getAttribute('position')
      assert.ok(position && position.count > 0, `${spec.key}/${object.name}: нет vertex position`)
      assert.ok([...position.array].every(Number.isFinite), `${spec.key}/${object.name}: нечисловая геометрия`)
    })
    assert.ok(meshCount >= 4, `${spec.key}: силуэт слишком простой`)
    assert.ok(materialNames.size >= 1)
    for (const name of required.get(spec.key) ?? spec.parts) {
      const bare = name.replace(/^part:/u, '')
      assert.ok(nodesOf(model).has(name) || nodesOf(model).has(bare), `${spec.key}: отсутствует ${name}`)
    }
    dispose(model)
  }
})

test('ориентация и точки крепления аксессуаров соблюдают контракт', () => {
  const wand = createAccessoryModel('wand')
  const grip = wand.getObjectByName('grip')
  assert.deepEqual(grip.position.toArray(), [0, 0, 0])
  assert.equal(grip.userData.axis, '+Y')
  const wandBounds = new THREE.Box3().setFromObject(wand)
  assert.ok(wandBounds.min.y >= -0.02 && wandBounds.max.y >= 0.38 && wandBounds.max.y <= 0.52)

  const cloak = createAccessoryModel('cloak')
  assert.equal(cloak.userData.canonicalHeight, 1.4)
  const cloakBounds = new THREE.Box3().setFromObject(cloak)
  assert.ok(cloakBounds.getSize(new THREE.Vector3()).z > 0.08, 'плащ должен иметь объём по Z')
  assert.ok(cloak.getObjectByName('part:back').position.z < 0, 'спина плаща должна находиться за персонажем')

  const brooch = createAccessoryModel('brooch')
  assert.equal(brooch.userData.plane, 'XY')
  assert.equal(brooch.userData.faceDirection, '+Z')
  assert.equal(brooch.getObjectByName('part:front').userData.faceDirection, '+Z')

  const ring = createAccessoryModel('ring', 'fire-resistance')
  assert.equal(ring.userData.plane, 'XZ')
  assert.equal(ring.userData.faceDirection, '+Y')
  assert.deepEqual(ring.getObjectByName('part:band').position.toArray(), [0, 0, 0])
  dispose(wand)
  dispose(cloak)
  dispose(brooch)
  dispose(ring)
})

test('неизвестные ключи и варианты не маскируются рабочей моделью', () => {
  assert.equal(createAccessoryModel('unknown'), null)
  assert.equal(createAccessoryModel('ring', 'unknown'), null)
  assert.equal(createAccessoryModel('srd_5_2_1:ring-of-protection'), null)
})

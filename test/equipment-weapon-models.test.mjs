import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'

import { ITEM_CATALOG } from '../server/item-catalog.mjs'
import { createWeaponModel, WEAPON_MODELS } from '../tools/equipment-weapon-models.mjs'

const BASE_WEAPONS = Object.values(ITEM_CATALOG).filter((item) => item.category === 'weapon' && !item.magic_item?.base_item_catalog_id)
const MATERIALS = new Set(['steel', 'wood', 'leather', 'cloth', 'bone'])
const RANGED = new Set(['bow', 'crossbow', 'sling', 'net', 'dart', 'blowgun', 'firearm'])

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

test('модели покрывают каждое базовое оружие каталога и сохраняют ключи', () => {
  assert.equal(WEAPON_MODELS.length, BASE_WEAPONS.length + 1)
  const covered = new Set(WEAPON_MODELS.flatMap((item) => item.catalogIds))
  for (const item of BASE_WEAPONS) assert.equal(covered.has(item.catalog_id), true, `${item.catalog_id}: нет модели`)
  const keys = new Set()
  for (const item of WEAPON_MODELS) {
    assert.equal(keys.has(item.key), false, `дублирующийся key ${item.key}`)
    keys.add(item.key)
    assert.equal(item.source, 'original')
    assert.equal(item.label, ITEM_CATALOG[item.catalogIds[0]]?.name ?? (item.key === 'net' ? 'Сеть' : null))
    assert.ok(['blade', 'club', 'axe', 'hammer', 'mace', 'staff', 'polearm', 'flail', 'bow', 'crossbow', 'sling', 'net', 'whip', 'dart', 'blowgun', 'firearm'].includes(item.kind))
    assert.ok(['one-handed', 'two-handed', 'variable'].includes(item.handedness))
    assert.ok(Object.isFrozen(item) && Object.isFrozen(item.catalogIds) && Object.isFrozen(item.grip))
    assert.deepEqual(item.grip.primary, [0, 0, 0])
    if (item.handedness === 'two-handed' || item.handedness === 'variable') assert.ok(item.grip.offHand)
  }
  const longsword = WEAPON_MODELS.find((item) => item.key === 'longsword')
  assert.deepEqual(longsword.catalogIds.slice(1), [
    'srd_5_2_1:longsword-plus-1',
    'srd_5_2_1:weapon-of-warning-longsword',
    'srd_5_2_1:vicious-longsword',
    'srd_5_2_1:flame-tongue-longsword',
  ])
  const net = WEAPON_MODELS.find((item) => item.key === 'net')
  assert.deepEqual(net.catalogIds, [])
  assert.equal(net.label, 'Сеть')
})

test('каждая модель конечна, имеет геометрию и допустимые PBR материалы', () => {
  const canonicalHeights = new Map([
    ['longsword', 0.72], ['greatsword', 1.0], ['spear', 1.3],
  ])
  for (const spec of WEAPON_MODELS) {
    const model = createWeaponModel(spec.key)
    assert.ok(model, `${spec.key}: фабрика вернула null`)
    model.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(model)
    const size = bounds.getSize(new THREE.Vector3())
    assert.equal(bounds.isEmpty(), false, `${spec.key}: пустые границы`)
    assert.ok([...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite), `${spec.key}: нечисловые границы`)
    assert.ok(size.x > 0 && size.y > 0 && size.z > 0, `${spec.key}: вырожденный размер`)
    if (canonicalHeights.has(spec.key)) assert.ok(Math.abs(size.y - canonicalHeights.get(spec.key)) < 0.012, `${spec.key}: нарушен canonical height`)
    const grip = model.getObjectByName('hand-grip')
    assert.ok(grip, `${spec.key}: нет primary grip`)
    assert.deepEqual(grip.position.toArray(), [...spec.grip.primary])
    if (spec.grip.offHand) assert.ok(model.getObjectByName('off-hand-grip'), `${spec.key}: нет off-hand-grip`)
    if (RANGED.has(spec.kind)) assert.ok(model.getObjectByName('muzzle'), `${spec.key}: нет muzzle`)

    let meshes = 0
    const materialNames = new Set()
    model.traverse((object) => {
      assert.ok(object.matrixWorld.elements.every(Number.isFinite), `${spec.key}/${object.name}: нечисловая матрица`)
      if (!object.isMesh) return
      meshes += 1
      const values = Array.isArray(object.material) ? object.material : [object.material]
      for (const value of values) {
        if (!value) continue
        materialNames.add(value.name)
        assert.equal(MATERIALS.has(value.name), true, `${spec.key}: недопустимый материал ${value.name}`)
      }
      const position = object.geometry.getAttribute('position')
      assert.ok(position && position.count > 0, `${spec.key}/${object.name}: нет vertex position`)
      assert.ok([...position.array].every(Number.isFinite), `${spec.key}/${object.name}: нечисловая геометрия`)
    })
    assert.ok(meshes >= 3, `${spec.key}: силуэт слишком простой (${meshes} meshes)`)
    assert.ok(meshes <= 32, `${spec.key}: слишком много мелких деталей (${meshes} meshes)`)
    assert.ok(materialNames.size >= 1)
    dispose(model)
  }
})

test('силуэты сохраняют семантические детали по типам', () => {
  const required = new Map([
    ['blade', ['blade']], ['club', ['head']], ['axe', ['haft', 'blade|beak|head']], ['hammer', ['grip', 'head']],
    ['mace', ['head|striker', 'flange|spike']], ['staff', ['shaft']], ['polearm', ['shaft|pole', 'blade|head|prong']], ['flail', ['chain', 'striker']],
    ['bow', ['limb', 'string']], ['crossbow', ['stock', 'prod', 'string', 'trigger']], ['sling', ['pouch', 'cord']], ['net', ['handle', 'mesh', 'weight']],
    ['whip', ['handle', 'thong']], ['dart', ['shaft', 'tip', 'fletching']], ['blowgun', ['tube', 'muzzle']],
    ['firearm', ['barrel', 'trigger', 'muzzle']],
  ])
  for (const spec of WEAPON_MODELS) {
    const names = nodesOf(createWeaponModel(spec.key))
    for (const token of required.get(spec.kind)) {
      const alternatives = token.split('|')
      assert.ok(alternatives.some((alternative) => [...names].some((name) => name.includes(alternative))), `${spec.key}: отсутствует semantic part ${token}`)
    }
  }
  const signatures = WEAPON_MODELS.map((spec) => {
    const model = createWeaponModel(spec.key)
    const names = [...nodesOf(model)].filter((name) => !['hand-grip', 'off-hand-grip', 'muzzle'].includes(name))
    dispose(model)
    return names.sort().join('|')
  })
  assert.ok(new Set(signatures).size >= 34, 'модели типов не должны сводиться к одному перекрашенному оружию')
})

test('неизвестные ключи не маскируются и графы независимы', () => {
  assert.equal(createWeaponModel('unknown'), null)
  assert.equal(createWeaponModel('srd_5_2_1:longsword'), null)
  const first = createWeaponModel('longsword')
  const second = createWeaponModel('longsword')
  assert.notEqual(first, second)
  assert.notEqual(first.getObjectByName('longsword-blade'), second.getObjectByName('longsword-blade'))
  assert.notEqual(first.getObjectByName('longsword-blade').geometry, second.getObjectByName('longsword-blade').geometry)
  assert.notEqual(first.getObjectByName('longsword-blade').material, second.getObjectByName('longsword-blade').material)
  first.position.x = 4
  assert.equal(second.position.x, 0)
  dispose(first)
  dispose(second)
})

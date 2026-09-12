import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'

import { createExtraModel, EXTRA_MODELS } from '../tools/household-prop-models.mjs'

const EXPECTED_ASSETS = [
  'table_royal', 'royal_throne', 'wardrobe', 'bunk_bed', 'washbasin', 'barrel_stack', 'crate_stack', 'basket', 'broom',
  'bowl_stew', 'jug', 'bread_loaf', 'cheese_wheel', 'dice_cup', 'lute', 'cutting_board', 'offering_bowl', 'urn',
]

const REQUIRED_DETAILS = new Map([
  ['table_royal', ['table-royal-top', 'table-royal-leg', 'table-royal-plank-seam', 'surface-top']],
  ['royal_throne', ['throne-back', 'throne-seat-cushion', 'throne-arm-rest', 'throne-carving-crossbar']],
  ['wardrobe', ['wardrobe-case', 'wardrobe-door-left', 'wardrobe-door-right', 'wardrobe-handle-left', 'hinge-lid']],
  ['bunk_bed', ['bunk-bed-post', 'bunk-bed-mattress', 'bunk-bed-ladder-rung']],
  ['washbasin', ['washbasin-basin', 'washbasin-rim', 'washbasin-faucet', 'surface-top']],
  ['barrel_stack', ['barrel-stack-body', 'barrel-stack-hoop', 'barrel-stack-top-body']],
  ['crate_stack', ['crate-stack-body', 'crate-stack-front-plank', 'crate-stack-top-corner']],
  ['basket', ['basket-body', 'basket-rim', 'basket-weave-stave', 'basket-handle']],
  ['broom', ['broom-handle', 'broom-bristles', 'broom-binding']],
  ['bowl_stew', ['bowl-stew-vessel', 'bowl-stew-surface', 'bowl-stew-garnish', 'bowl-stew-rim']],
  ['jug', ['jug-body', 'jug-rim', 'jug-handle', 'jug-spout']],
  ['bread_loaf', ['bread-loaf-body', 'bread-score']],
  ['cheese_wheel', ['cheese-wheel-body', 'cheese-wheel-rim', 'cheese-wheel-hole']],
  ['dice_cup', ['dice-cup-body', 'dice-cup-rim', 'dice-cup-die']],
  ['lute', ['lute-body-lower', 'lute-neck', 'lute-soundhole-rim', 'lute-string']],
  ['cutting_board', ['cutting-board-body', 'cutting-board-plank-seam', 'cutting-board-handle-hole']],
  ['offering_bowl', ['offering-bowl-vessel', 'offering-bowl-stem', 'offering-bowl-rim', 'offering-bowl-carving']],
  ['urn', ['urn-body', 'urn-neck', 'urn-rim', 'urn-handle']],
])

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

test('каталог домашнего реквизита содержит ровно 18 авторских записей', () => {
  assert.deepEqual(EXTRA_MODELS.map((item) => item.assetId), EXPECTED_ASSETS)
  const keys = new Set()
  const files = new Set()
  for (const item of EXTRA_MODELS) {
    assert.match(item.key, /^sk-[a-z0-9-]+$/u)
    assert.match(item.file, /^sk-[a-z0-9-]+\.glb$/u)
    assert.equal(item.file, `${item.key}.glb`)
    assert.equal(item.yaw, 0)
    assert.ok(item.label.length > 2)
    assert.ok(item.category.length > 2)
    assert.ok(item.footprint.w > 0 && item.footprint.h > 0)
    assert.ok(item.textures.length > 0)
    assert.ok(item.textures.every((value) => ['wood', 'stone', 'metal', 'fabric', 'food', 'water'].includes(value)))
    assert.equal(keys.has(item.key), false)
    assert.equal(files.has(item.file), false)
    keys.add(item.key)
    files.add(item.file)
    assert.ok(Object.isFrozen(item))
    assert.ok(Object.isFrozen(item.textures))
  }
})

test('все модели конечны, центрированы и сохраняют предметные детали', () => {
  for (const item of EXTRA_MODELS) {
    const model = createExtraModel(item.assetId)
    assert.ok(model, `${item.assetId}: фабрика вернула пустой результат`)
    model.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(model)
    const size = bounds.getSize(new THREE.Vector3())
    const center = bounds.getCenter(new THREE.Vector3())
    assert.equal(bounds.isEmpty(), false, `${item.assetId}: модель пустая`)
    assert.ok([...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite), `${item.assetId}: нечисловые границы`)
    assert.ok(bounds.min.y >= -0.001, `${item.assetId}: предмет провалился под пол`)
    assert.ok(Math.abs(center.x) <= 0.001, `${item.assetId}: смещение центра по X`)
    assert.ok(Math.abs(center.z) <= 0.001, `${item.assetId}: смещение центра по Z`)
    assert.ok(size.x <= item.footprint.w + 0.012, `${item.assetId}: ширина вышла за footprint`)
    assert.ok(size.z <= item.footprint.h + 0.012, `${item.assetId}: глубина вышла за footprint`)
    const names = nodesOf(model)
    for (const name of REQUIRED_DETAILS.get(item.assetId)) assert.equal(names.has(name), true, `${item.assetId}: отсутствует ${name}`)
    let meshCount = 0
    const materialNames = new Set()
    model.traverse((object) => {
      assert.ok(object.matrixWorld.elements.every(Number.isFinite), `${item.assetId}/${object.name}: нечисловая матрица`)
      if (!object.isMesh) return
      meshCount += 1
      for (const value of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!value) continue
        materialNames.add(value.name)
        assert.ok(item.textures.includes(value.name), `${item.assetId}: материал ${value.name} не заявлен в textures`)
      }
      const positions = object.geometry.getAttribute('position')
      assert.ok(positions && [...positions.array].every(Number.isFinite), `${item.assetId}/${object.name}: нечисловая геометрия`)
    })
    assert.ok(meshCount <= 48, `${item.assetId}: слишком много мелких мешей (${meshCount})`)
    assert.ok(item.textures.every((kind) => materialNames.has(kind)), `${item.assetId}: текстурный канал не представлен материалом`)
    dispose(model)
  }
})

test('поверхности и створки имеют устойчивые семантические узлы', () => {
  for (const assetId of ['table_royal', 'washbasin']) {
    const model = createExtraModel(assetId)
    const surface = model.getObjectByName('surface-top')
    assert.ok(surface)
    assert.equal(surface.children.length, 0)
    assert.equal(surface.userData.role, 'support-surface')
    assert.equal(surface.userData.clearForProps, true)
    assert.ok(surface.position.y > 0.5)
    dispose(model)
  }
  const wardrobe = createExtraModel('wardrobe')
  const doors = wardrobe.getObjectByName('hinge-lid')
  assert.ok(doors)
  assert.equal(doors.userData.animated, true)
  assert.equal(doors.children.filter((child) => child.userData.animated === true).length, 2)
  assert.equal(createExtraModel('pot'), null, 'урна/чаша не маскируются неподходящим alias')
  assert.equal(createExtraModel('unknown'), null)
  dispose(wardrobe)
})

test('мебель сохраняет canonical footprint и ориентацию длинной кровати', () => {
  assert.deepEqual(EXTRA_MODELS.find((item) => item.assetId === 'table_royal')?.footprint, { w: 5, h: 2 })
  assert.deepEqual(EXTRA_MODELS.find((item) => item.assetId === 'bunk_bed')?.footprint, { w: 2, h: 1 })
  const bed = createExtraModel('bunk_bed')
  bed.updateMatrixWorld(true)
  const size = new THREE.Box3().setFromObject(bed).getSize(new THREE.Vector3())
  assert.ok(size.x > size.z * 1.5, 'кровать должна быть ориентирована длинной осью X')
  dispose(bed)
})

test('трон имеет четыре соединённые с полом опоры и навершия на подлокотниках', () => {
  const throne = createExtraModel('royal_throne')
  throne.updateMatrixWorld(true)
  const legs = []
  const finials = []
  throne.traverse((object) => {
    if (object.name === 'throne-leg') legs.push(object)
    if (object.name === 'throne-front-finial') finials.push(object)
  })
  assert.equal(legs.length, 4)
  for (const leg of legs) {
    const bounds = new THREE.Box3().setFromObject(leg)
    assert.ok(Math.abs(bounds.min.y - 0.1) < 0.002)
    assert.ok(Math.abs(bounds.max.y - 0.52) < 0.002)
  }
  assert.equal(finials.length, 2)
  const armrest = throne.getObjectByName('throne-arm-rest')
  const armBounds = new THREE.Box3().setFromObject(armrest)
  for (const finial of finials) {
    const bounds = new THREE.Box3().setFromObject(finial)
    assert.ok(Math.abs(bounds.min.y - armBounds.max.y) < 0.002, 'навершие касается подлокотника')
  }
  dispose(throne)
})

test('каждый вызов фабрики создаёт независимый граф', () => {
  const first = createExtraModel('urn')
  const second = createExtraModel('urn')
  assert.notEqual(first, second)
  const firstMesh = first.getObjectByName('urn-body')
  const secondMesh = second.getObjectByName('urn-body')
  assert.notEqual(firstMesh, secondMesh)
  assert.notEqual(firstMesh.geometry, secondMesh.geometry)
  assert.notEqual(firstMesh.material, secondMesh.material)
  first.position.x = 12
  assert.equal(second.position.x, 0)
  dispose(first)
  dispose(second)
})

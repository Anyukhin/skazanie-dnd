import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'

import { createExtraModel, EXTRA_MODELS } from '../tools/settlement-prop-models.mjs'

const ASSET_IDS = [
  'tree_dead', 'wagon_wheel', 'hitching_post', 'water_trough', 'well', 'lamp_post',
  'haystack', 'milestone', 'roadside_shrine', 'grave', 'bone_pile', 'rubble_heap',
]

function namesOf(root) {
  const names = []
  root.traverse((object) => { if (object.name) names.push(object.name) })
  return names
}

function meshesOf(root) {
  const meshes = []
  root.traverse((object) => { if (object instanceof THREE.Mesh) meshes.push(object) })
  return meshes
}

function dispose(root) {
  const geometries = new Set()
  const materials = new Set()
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    geometries.add(object.geometry)
    for (const value of Array.isArray(object.material) ? object.material : [object.material]) materials.add(value)
  })
  for (const value of materials) value.dispose()
  for (const value of geometries) value.dispose()
}

test('каталог дополнительных моделей содержит все 12 авторских записей', () => {
  assert.deepEqual(EXTRA_MODELS.map((item) => item.assetId), ASSET_IDS)
  assert.equal(new Set(EXTRA_MODELS.map((item) => item.key)).size, ASSET_IDS.length)
  for (const item of EXTRA_MODELS) {
    assert.match(item.key, /^sk-[a-z0-9-]+$/u)
    assert.equal(item.file, `${item.key}.glb`)
    assert.equal(item.yaw, 0)
    assert.ok(item.label.length > 2)
    assert.ok(item.category.length > 2)
    assert.ok(item.footprint.w > 0 && item.footprint.h > 0)
    assert.ok(item.textures.length > 0)
    assert.ok(item.textures.every((value) => /^[a-z][a-z0-9-]*$/u.test(value)))
  }
})
test('каждый рецепт конечен, центрирован и сохраняет семантический footprint', () => {
  for (const item of EXTRA_MODELS) {
    const model = createExtraModel(item.assetId)
    assert.ok(model, `${item.assetId}: рецепт должен вернуть Group`)
    model.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(model)
    const size = bounds.getSize(new THREE.Vector3())
    const center = bounds.getCenter(new THREE.Vector3())
    assert.ok(!bounds.isEmpty(), `${item.assetId}: модель не должна быть пустой`)
    assert.ok([...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite), `${item.assetId}: bounds конечен`)
    assert.ok(bounds.min.y >= -0.001, `${item.assetId}: геометрия под полом`)
    assert.ok(Math.abs(center.x) <= 0.001 && Math.abs(center.z) <= 0.001, `${item.assetId}: bounds не центрирован`)
    assert.ok(size.x <= item.footprint.w + 0.012, `${item.assetId}: ширина вышла за footprint`)
    assert.ok(size.z <= item.footprint.h + 0.012, `${item.assetId}: глубина вышла за footprint`)
    assert.ok(meshesOf(model).every((mesh) => mesh.material?.name), `${item.assetId}: материал без стабильного имени`)
    const textures = new Set(item.textures)
    for (const mesh of meshesOf(model)) assert.ok(textures.has(mesh.material.name), `${item.assetId}: материал ${mesh.material.name} не заявлен в textures`)
    dispose(model)
  }
})

test('силуэты сохраняют детали, которые отличают предметы друг от друга', () => {
  const model = (assetId) => createExtraModel(assetId)
  const wheelNames = namesOf(model('wagon_wheel'))
  assert.ok(wheelNames.includes('wagon-wheel-rim'))
  assert.equal(wheelNames.filter((name) => name.startsWith('wagon-wheel-spoke-')).length, 8)
  const wheel = model('wagon_wheel')
  assert.equal(wheel.getObjectByName('wagon-wheel-rim')?.rotation.x, 0, 'обод должен быть вертикальным вместе со спицами')
  assert.equal(wheel.getObjectByName('wagon-wheel-tread')?.rotation.x, 0, 'металлический обод должен быть вертикальным')

  const troughNames = namesOf(model('water_trough'))
  assert.ok(troughNames.includes('trough-water'))
  assert.ok(troughNames.filter((name) => name === 'trough-side-wall').length >= 2)
  assert.ok(troughNames.filter((name) => name === 'trough-end-wall').length >= 2)

  const wellNames = namesOf(model('well'))
  assert.ok(wellNames.includes('well-opening'))
  assert.ok(wellNames.filter((name) => name === 'well-masonry-block').length >= 16)
  assert.ok(wellNames.includes('well-roof-board-left'))
  assert.ok(wellNames.includes('well-roof-board-right'))
  assert.ok(wellNames.includes('well-winch-axle'))
  const well = model('well')
  const leftRoof = well.getObjectByName('well-roof-board-left')
  const rightRoof = well.getObjectByName('well-roof-board-right')
  assert.ok(leftRoof && rightRoof && leftRoof.rotation.z > 0 && rightRoof.rotation.z < 0, 'скаты крыши должны сходиться к коньку')
  assert.ok(Math.abs((leftRoof?.rotation.z ?? 0) + (rightRoof?.rotation.z ?? 0)) < 0.001)
  for (const post of well.children.filter((child) => child.name === 'well-post')) {
    assert.ok(post instanceof THREE.Mesh)
    assert.ok(post.geometry.boundingBox === null || (post.geometry.computeBoundingBox(), post.geometry.boundingBox.max.y - post.geometry.boundingBox.min.y <= 0.841), 'стойки не должны торчать над крышей')
  }

  const shrine = model('roadside_shrine')
  assert.ok(namesOf(shrine).includes('shrine-niche'))
  const shrineArch = shrine.getObjectByName('shrine-arch')
  assert.equal(shrineArch?.geometry.type, 'ExtrudeGeometry')

  for (const assetId of ['tree_dead', 'bone_pile']) {
    const subject = model(assetId)
    const names = namesOf(subject)
    const types = new Set(meshesOf(subject).map((mesh) => mesh.geometry.type))
    assert.ok(!types.has('SphereGeometry'), `${assetId}: нельзя заменять форму случайными шарами`)
    assert.ok(names.some((name) => name.includes(assetId === 'tree_dead' ? 'branch' : 'rib')),
      `${assetId}: отсутствует характерная анатомическая деталь`)
  }

  const rubble = model('rubble_heap')
  assert.ok(meshesOf(rubble).some((mesh) => mesh.geometry.type === 'DodecahedronGeometry'))
  for (const value of [shrine, wheel, well, ...['water_trough', 'tree_dead', 'bone_pile', 'rubble_heap'].map(model)]) dispose(value)
})

test('рецепты детерминированы и неизвестный assetId не маскируется моделью', () => {
  assert.equal(createExtraModel('does-not-exist'), null)
  const signature = (assetId) => {
    const root = createExtraModel(assetId)
    root.updateMatrixWorld(true)
    return meshesOf(root).map((mesh) => ({
      name: mesh.name,
      type: mesh.geometry.type,
      material: mesh.material.name,
      position: mesh.position.toArray(),
      quaternion: mesh.quaternion.toArray(),
      scale: mesh.scale.toArray(),
    }))
  }
  for (const assetId of ASSET_IDS) assert.deepEqual(signature(assetId), signature(assetId), `${assetId}: рецепт недетерминирован`)
})

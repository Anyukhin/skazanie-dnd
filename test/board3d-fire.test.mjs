// Видимый огонь у источников света (`src/board3d-fire.ts`): ядро пламени,
// ореол и искры. Только представление — свет и правила не затрагиваются.
import assert from 'node:assert/strict'
import test from 'node:test'

import { compileClientModules } from './kit/client-ts.mjs'

const build = await compileClientModules(['src/board3d-fire.ts'])
const [fire] = build.modules
const THREE = await import('three')

const alphaAt = (texture, x, y) => texture.image.data[(y * texture.image.width + x) * 4 + 3]

test('ореол — мягкое пятно: ярко в центре, пусто в углах; язык пламени шире внизу, острый сверху', () => {
  const glow = fire.createGlowTexture(32)
  assert.ok(alphaAt(glow, 16, 16) > 200)
  assert.equal(alphaAt(glow, 0, 0), 0)
  const flame = fire.createFlameTexture(32, 64)
  const width = (row) => Array.from({ length: 32 }, (_, x) => alphaAt(flame, x, row)).filter((alpha) => alpha > 40).length
  assert.ok(width(16) > width(50), 'язык сужается кверху')
  assert.equal(width(63), 0, 'верхушка прозрачна')
})

test('искры: поднимаются над огнём и гаснут, детерминированно, у каждой своя фаза', () => {
  const samples = Array.from({ length: 240 }, (_, frame) => fire.emberAt(frame / 60, 3, 2))
  for (const ember of samples) {
    assert.ok(ember.dy >= 0 && ember.dy <= fire.BOARD3D_FIRE_GLOW.emberRise + 1e-9)
    assert.ok(ember.glow >= 0 && ember.glow <= 1)
  }
  assert.ok(Math.max(...samples.map((ember) => ember.dy)) > .5 * fire.BOARD3D_FIRE_GLOW.emberRise, 'искра заметно поднимается')
  assert.deepEqual(fire.emberAt(1.5, 3, 2), fire.emberAt(1.5, 3, 2))
  assert.notDeepEqual(fire.emberAt(1.5, 3, 2), fire.emberAt(1.5, 3, 4))
})

test('огни: ядро ярче единицы под свечение, ореол и искры не пишут глубину, на «Экономном» искр нет', () => {
  const points = [{ x: 2, y: .6, z: 3, share: 1 }, { x: 5, y: .9, z: 1, share: .37 }]
  const full = fire.createFireGlow(points, 'full', 1)
  assert.equal(full.count, 2)
  const sprites = full.group.children.filter((child) => child.isSprite)
  assert.equal(sprites.length, 4)
  for (const sprite of sprites) {
    assert.equal(sprite.material.depthWrite, false)
    assert.equal(sprite.material.blending, THREE.AdditiveBlending)
  }
  const cores = sprites.filter((sprite) => sprite.name === 'fire-core')
  assert.ok(cores.every((core) => Math.max(core.material.color.r, core.material.color.g) > 1), 'ядро ярче единицы')
  const [bigHalo, smallHalo] = sprites.filter((sprite) => sprite.name === 'fire-halo')
  assert.ok(bigHalo.scale.x > smallHalo.scale.x, 'ореол жаровни шире ореола свечи')
  const embers = full.group.getObjectByName('fire-embers')
  assert.equal(embers.geometry.getAttribute('position').count, 2 * fire.BOARD3D_FIRE_GLOW.embers.full)
  assert.equal(embers.material.depthWrite, false)
  const before = bigHalo.scale.x
  full.animate(1.37)
  assert.notEqual(bigHalo.scale.x, before, 'огонь дышит')
  const day = fire.createFireGlow(points, 'minimal', 0)
  assert.equal(day.group.getObjectByName('fire-embers'), undefined)
  const dayHalo = day.group.children.find((child) => child.name === 'fire-halo')
  const nightHalo = fire.createFireGlow(points, 'minimal', 1).group.children.find((child) => child.name === 'fire-halo')
  assert.ok(nightHalo.material.opacity > dayHalo.material.opacity, 'в подземелье ореол ярче, чем днём')
  let disposed = 0
  for (const sprite of sprites) sprite.material.addEventListener('dispose', () => { disposed += 1 })
  full.dispose()
  assert.equal(disposed, 4)
  assert.equal(full.group.parent, null)
  day.dispose()
})

test('ореол выдвигается к ортокамере: место на экране то же, пол под огнём его не срезает', () => {
  const glow = fire.createFireGlow([{ x: 4, y: .5, z: 4, share: 1 }], 'minimal', 1)
  const halo = glow.group.children.find((child) => child.name === 'fire-halo')
  const camera = new THREE.OrthographicCamera(-8, 8, 6, -6, .1, 500)
  camera.position.set(14, 18, 14)
  camera.lookAt(4, 0, 4)
  camera.updateMatrixWorld(true)
  glow.group.updateMatrixWorld(true)
  halo.onBeforeRender(null, null, camera, null, null, null)
  const moved = new THREE.Vector3().setFromMatrixPosition(halo.matrixWorld)
  const offset = moved.clone().sub(new THREE.Vector3(4, .5, 4))
  assert.ok(Math.abs(offset.length() - fire.BOARD3D_FIRE_GLOW.haloLift) < 1e-6)
  const toCamera = new THREE.Vector3().subVectors(camera.position, new THREE.Vector3(4, 0, 4)).normalize()
  assert.ok(offset.normalize().dot(toCamera) > .999, 'сдвиг — строго к камере')
  glow.dispose()
})

test('огонь за стеклом: у фонаря только ореол, без языка и искр', () => {
  const glow = fire.createFireGlow([{ x: 1, y: 1.4, z: 1, share: .86, enclosed: true }, { x: 4, y: .6, z: 4, share: 1 }], 'full', .5)
  assert.equal(glow.group.children.filter((child) => child.name === 'fire-core').length, 1, 'язык только у открытого огня')
  assert.equal(glow.group.children.filter((child) => child.name === 'fire-halo').length, 2)
  assert.equal(glow.group.getObjectByName('fire-embers').geometry.getAttribute('position').count, fire.BOARD3D_FIRE_GLOW.embers.full)
  glow.dispose()
})

test('место огня: светящаяся деталь модели, иначе верх модели', () => {
  const group = new THREE.Group()
  const pole = new THREE.Mesh(new THREE.BoxGeometry(.1, 2, .1), new THREE.MeshStandardMaterial())
  pole.position.set(3, 1, 5)
  group.add(pole)
  const top = fire.flameAnchor(group)
  assert.ok(Math.abs(top.x - 3) < 1e-6 && Math.abs(top.z - 5) < 1e-6)
  assert.ok(top.y > 1.8 && top.y <= 2, 'без светящейся детали — у верха модели, а не на середине столба')
  const ember = new THREE.Mesh(new THREE.BoxGeometry(.4, .2, .4), new THREE.MeshStandardMaterial({ emissive: '#ff6020', emissiveIntensity: 1 }))
  ember.position.set(3.2, .5, 5)
  group.add(ember)
  const lit = fire.flameAnchor(group)
  assert.ok(Math.abs(lit.x - 3.2) < 1e-6, 'огонь — над светящейся деталью')
  assert.ok(lit.y > .4 && lit.y < .6)
  assert.equal(fire.flameAnchor(new THREE.Group()), null)
})

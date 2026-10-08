import assert from 'node:assert/strict'
import test from 'node:test'

import { compileClientModules } from './kit/client-ts.mjs'

const build = await compileClientModules(['src/board3d-cutout.ts'])
const [cutout] = build.modules
const THREE = await import('three')

/** RGBA-картинка width×height: пиксели задаются функцией (x, y) → [r, g, b, a]. */
function image(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data.set(pixel(x, y), (y * width + x) * 4)
  return data
}

const at = (data, width, x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]

test('пустые пиксели листа получают цвет листа: мипмапы больше не смешивают зелень с чёрным', () => {
  const data = image(8, 8, (x, y) => (x === 2 && y === 5 ? [88, 123, 0, 255] : [0, 0, 0, 0]))
  assert.equal(cutout.bleedTransparentTexels(data, 8, 8), 63)
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) {
    const [r, g, b, a] = at(data, 8, x, y)
    assert.deepEqual([r, g, b], [88, 123, 0], `пиксель ${x},${y}`)
    assert.equal(a, x === 2 && y === 5 ? 255 : 0, 'альфа, а с ней и вырез листа, не меняется')
  }
})

test('пустой пиксель берёт цвет ближнего листа, а не среднего по картинке', () => {
  // Слева красный лист, справа синий, между ними пусто.
  const data = image(16, 4, (x) => (x < 3 ? [200, 20, 20, 255] : x > 12 ? [20, 20, 200, 255] : [0, 0, 0, 0]))
  cutout.bleedTransparentTexels(data, 16, 4)
  const [nearRedR, , nearRedB] = at(data, 16, 3, 1)
  const [nearBlueR, , nearBlueB] = at(data, 16, 12, 1)
  assert.ok(nearRedR > nearRedB, 'у красного края — красный')
  assert.ok(nearBlueB > nearBlueR, 'у синего края — синий')
  assert.deepEqual(at(data, 16, 0, 0), [200, 20, 20, 255], 'непрозрачные пиксели не трогаются')
  assert.deepEqual(at(data, 16, 15, 3), [20, 20, 200, 255])
})

test('полупрозрачный край листа сохраняет свой цвет, а вес в усреднении — по альфе', () => {
  const data = image(4, 1, (x) => [[100, 0, 0, 255], [0, 100, 0, 128], [0, 0, 0, 0], [0, 0, 0, 0]][x])
  cutout.bleedTransparentTexels(data, 4, 1)
  assert.deepEqual(at(data, 4, 1, 0), [0, 100, 0, 128])
  const [r, g] = at(data, 4, 2, 0)
  assert.ok(r > 0 && g > 0, 'пустой пиксель смешивает оба соседних цвета')
})

test('картинка без пустых или без непрозрачных пикселей остаётся как была', () => {
  const opaque = image(4, 4, () => [10, 20, 30, 255])
  assert.equal(cutout.bleedTransparentTexels(opaque, 4, 4), 0)
  assert.ok(opaque.every((value, index) => value === [10, 20, 30, 255][index % 4]))
  const empty = image(4, 4, () => [0, 0, 0, 0])
  assert.equal(cutout.bleedTransparentTexels(empty, 4, 4), 0)
  assert.ok(empty.every((value) => value === 0))
  assert.equal(cutout.bleedTransparentTexels(new Uint8ClampedArray(3), 4, 4), 0, 'короткий буфер не читается за край')
})

test('листва модели: край выреза сглаживается, стекло и непрозрачное не трогаются', () => {
  const map = new THREE.Texture()
  const leaves = new THREE.MeshStandardMaterial({ name: 'Leaves', map, alphaTest: .2, side: THREE.DoubleSide })
  const glass = new THREE.MeshStandardMaterial({ name: 'Glass', map, alphaTest: .2, transparent: true })
  const wood = new THREE.MeshStandardMaterial({ name: 'Wood', map })
  const bare = new THREE.MeshStandardMaterial({ name: 'Bare', alphaTest: .5 })
  const root = new THREE.Group()
  for (const material of [leaves, leaves, glass, wood, bare]) root.add(new THREE.Mesh(new THREE.PlaneGeometry(), material))
  assert.equal(cutout.prepareCutoutMaterials(root), 1)
  assert.equal(leaves.alphaToCoverage, true)
  assert.equal(glass.alphaToCoverage, false)
  assert.equal(wood.alphaToCoverage, false)
  assert.equal(bare.alphaToCoverage, false)
  assert.equal(cutout.isCutoutMaterial(leaves), true)
  assert.equal(cutout.isCutoutMaterial(glass), false)
  // Без DOM картинку не прочитать: листвой материал не считается, и затенение
  // (GTAO) его по-прежнему учитывает.
  assert.equal(cutout.isFoliageMaterial(leaves), false)
  assert.equal(cutout.bleedCutoutTexture(map), false)
})

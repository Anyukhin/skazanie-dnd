// Объёмный пол (`src/board3d-floor-relief.ts`, рельеф в `createTileGroundGeometry`)
// и трава ковром (`createGrassTufts`, стиль `carpet`). Только представление:
// высота клетки для правил не меняется.
import assert from 'node:assert/strict'
import test from 'node:test'

import { compileClientModules } from './kit/client-ts.mjs'
import { createTacticalMap, serializeTacticalMap, setCell } from '../server/tactical-map.mjs'

const build = await compileClientModules(['src/board3d-floor-relief.ts', 'src/board3d-landscape.ts', 'src/tactical-map-client.ts'])
const [relief, landscape, mapClient] = build.modules
const THREE = await import('three')

function mapWith(cells, { width = 4, height = 3 } = {}) {
  const map = createTacticalMap({ width, height, seed: 'floor-relief', theme: 'building' })
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) setCell(map, x, y, { passable: true, revealed: true, material: 'stone' })
  for (const [x, y, patch] of cells) setCell(map, x, y, patch)
  return mapClient.decodeTacticalMap(JSON.parse(JSON.stringify(serializeTacticalMap(map))))
}

/** Карта высот: полосы-«швы» по X через каждые 0,25 повтора, камень между ними. */
const seams = (u) => (Math.abs((u * 4) % 1 - .5) < .1 ? 0 : 1)

const topHeights = (geometry) => {
  const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal')
  const result = []
  for (let index = 0; index < position.count; index += 1) if (normal.getY(index) > .5) result.push(position.getY(index))
  return result
}

test('карта высот: усреднение до частоты сетки, билинейная выборка и заворот повтора', () => {
  const width = 8, height = 8
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data[(y * width + x) * 4] = x < 4 ? 0 : 255
  const sample = relief.createHeightSampler(data, width, height, 2)
  assert.ok(sample(.25, .5) < .1, 'левая половина — впадина')
  assert.ok(sample(.75, .5) > .9, 'правая — камень')
  assert.ok(Math.abs(sample(1.25, .5) - sample(.25, .5)) < 1e-9, 'повтор заворачивается')
  assert.ok(sample(.5, .5) > .3 && sample(.5, .5) < .7, 'между ними — плавный переход')
  assert.equal(relief.reliefSubdivisions(10, 12), 12)
  // Карта 84×70 — самая большая из нарисованных.
  const cells = 84 * 70
  assert.ok(relief.reliefSubdivisions(cells, 12) < 12, 'большая карта получает меньше делений')
  assert.ok(cells * (relief.reliefSubdivisions(cells, 12) + 1) ** 2 <= relief.FLOOR_RELIEF_MAX_VERTICES)
})

test('рельеф мощёного пола: швы опускаются ниже верха, камни остаются на верху, ничего не поднимается', () => {
  const map = mapWith([])
  const surfaceKey = (cell) => cell.material
  const flat = landscape.createTileGroundGeometry(map, { uvCells: 1, neutralShade: true })
  const depth = .1
  const raised = landscape.createTileGroundGeometry(map, { uvCells: 1, neutralShade: true, relief: { subdivisions: 8, depth, height: (u) => seams(u), surfaceKey } })
  const flatTop = Math.max(...topHeights(flat))
  const tops = topHeights(raised)
  assert.ok(tops.length > flat.getAttribute('position').count, 'верх клетки разбит сеткой')
  assert.ok(Math.min(...tops) < flatTop - depth * .5, 'швы провалились')
  assert.ok(Math.max(...tops) <= flatTop + 1e-6 + landscape.TILE_JITTER, 'мощёная плитка не поднимается над верхом')
  const normals = raised.getAttribute('normal')
  let tilted = 0
  for (let index = 0; index < normals.count; index += 1) if (normals.getY(index) > .5 && normals.getY(index) < .995) tilted += 1
  assert.ok(tilted > 0, 'нормали следуют рельефу: камни ловят свет')
})

test('рельеф: плитки одного покрытия смыкаются без бортика, у другого покрытия и у края — ноль смещения', () => {
  const map = mapWith([[3, 0, { material: 'wood' }], [3, 1, { material: 'wood' }], [3, 2, { material: 'wood' }]])
  const surfaceKey = (cell) => cell.material
  const options = (material) => ({
    include: (_x, _y, cell) => cell.material === material, uvCells: 1, neutralShade: true,
    relief: { subdivisions: 6, depth: .1, height: () => 0, surfaceKey },
  })
  const stone = landscape.createTileGroundGeometry(map, options('stone'))
  const position = stone.getAttribute('position'), normal = stone.getAttribute('normal')
  const levelAt = (x, z) => {
    let best = null
    for (let index = 0; index < position.count; index += 1) {
      if (normal.getY(index) < .5) continue
      if (Math.abs(position.getX(index) - x) < 1e-6 && Math.abs(position.getZ(index) - z) < 1e-6) best = position.getY(index)
    }
    return best
  }
  // Карта высот целиком впадина: в середине каменного поля пол опущен на всю глубину,
  // на границе двух каменных клеток — тоже (бортика между ними нет).
  const middle = levelAt(1.5, 1.5)
  const seam = levelAt(1, 1.5)
  assert.ok(middle !== null && seam !== null)
  assert.ok(Math.abs(middle - seam) < 1e-6, 'граница клеток одного покрытия опущена так же, как середина')
  // У дерева (другое покрытие) и у края карты верх не опущен: стык без щели.
  const nearWood = levelAt(3 - landscape.TILE_BEVEL, 1.5) ?? levelAt(3, 1.5)
  assert.ok(nearWood !== null && nearWood > middle + .09, 'у чужого покрытия смещение гаснет')
  const atMapEdge = levelAt(0, 1.5)
  assert.ok(atMapEdge !== null && atMapEdge > middle + .09, 'у края карты смещение гаснет')
})

test('рельеф газона только опускает впадины: наклейки пола не тонут, без рельефа геометрия прежняя', () => {
  const map = mapWith([[0, 0, { material: 'grass' }], [1, 0, { material: 'grass' }]])
  const natural = (cell) => cell.material === 'grass'
  const base = { include: (_x, _y, cell) => cell.material === 'grass', uvCells: 1, seamless: natural, neutralShade: true }
  const plain = landscape.createTileGroundGeometry(map, base)
  const same = landscape.createTileGroundGeometry(map, { ...base, relief: null })
  assert.deepEqual([...same.getAttribute('position').array], [...plain.getAttribute('position').array], 'relief: null ничего не меняет')
  const bumpy = landscape.createTileGroundGeometry(map, { ...base, relief: { subdivisions: 6, depth: .05, height: () => 0, surfaceKey: (cell) => cell.material } })
  assert.ok(Math.max(...topHeights(bumpy)) <= Math.max(...topHeights(plain)) + 1e-9, 'ковёр не поднимается над прежним верхом')
  assert.ok(Math.min(...topHeights(bumpy)) < Math.max(...topHeights(plain)) - .04, 'впадины опускаются')
})

test('ковёр пучков: трава по всей клетке газона, а не пятнами', () => {
  const map = mapWith(Array.from({ length: 12 }, (_, index) => [index % 4, Math.floor(index / 4), { material: 'grass' }]))
  const count = (style) => {
    const built = landscape.createGrassTufts(map, [], 'full', style)
    const mesh = built.group.children.find((child) => child.name !== 'landscape-flowers')
    const cells = new Set()
    const matrix = new THREE.Matrix4()
    for (let index = 0; index < mesh.count; index += 1) {
      mesh.getMatrixAt(index, matrix)
      cells.add(`${Math.floor(matrix.elements[12])},${Math.floor(matrix.elements[14])}`)
    }
    built.dispose()
    return { tufts: mesh.count, cells: cells.size }
  }
  const carpet = count('carpet')
  assert.equal(carpet.cells, 12, 'пучки в каждой клетке газона')
  assert.ok(carpet.tufts >= 12 * 16, 'не меньше 4×4 пучков на клетку')
})

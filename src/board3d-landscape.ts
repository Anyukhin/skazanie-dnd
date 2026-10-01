import * as THREE from 'three'

import { cellAt } from './tactical-map-client'
import { terrainHeightAt } from './board3d-terrain'
import type { TacticalMap, TacticalProp } from './types'

/**
 * Объёмная местность доски в духе настольных диорам (TaleSpire): пол
 * плитками с фаской, вода над опущенным дном, скалы на непроходимых клетках и
 * трава. Только представление: клетки, проходимость и высоты берутся из той же
 * TacticalMap, что и у правил, ничего нового модуль не решает.
 */

export type LandscapeDetail = 'full' | 'reduced' | 'minimal'

/** Ширина фаски плитки и глубина шва между соседями, в клетках. */
export const TILE_BEVEL = .045
export const TILE_SEAM_DEPTH = .035
/** Наибольший подъём плитки над уровнем клетки: меньше лифта оверлеев (.022). */
export const TILE_JITTER = .012
/** Дно водоёма и уровень воды относительно клетки. */
export const WATER_BED_DEPTH = .24
export const WATER_SURFACE_DEPTH = .07
/** Ширина берегового откоса внутри клетки воды. */
export const WATER_BANK_INSET = .2

/** Детерминированный шум клетки: тот же рисунок при каждой пересборке. */
export function cellNoise(x: number, y: number, salt = 0): number {
  const value = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453
  return value - Math.floor(value)
}

function isWaterCell(map: TacticalMap, x: number, y: number) {
  const cell = cellAt(map, x, y)
  return Boolean(cell?.revealed && cell.surface === 'water')
}

function zoneKindAt(map: TacticalMap, zoneId: string) {
  return zoneId ? map.zones.find((zone) => zone.id === zoneId)?.kind ?? 'exterior' : 'exterior'
}

function isSolidCell(map: TacticalMap, x: number, y: number) {
  const cell = cellAt(map, x, y)
  return Boolean(cell?.revealed && !cell.passable && cell.surface !== 'water')
}

/**
 * Стена дома тонкая: с одной стороны помещение, с другой — улица. Порода
 * пещеры тоже граничит с «помещением» (зоны пещеры interior), но снаружи у неё
 * только камень. Поэтому кладка — касание и помещения, и проходимой клетки
 * снаружи (по диагонали тоже: угол дома касается их только вершиной).
 */
function touchesInterior(map: TacticalMap, x: number, y: number) {
  let interior = false, exterior = false
  for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
    const cell = cellAt(map, x + dx, y + dy)
    if (!cell?.revealed || !cell.passable) continue
    if (zoneKindAt(map, cell.zone) === 'interior') interior = true
    else exterior = true
  }
  return interior && exterior
}

/**
 * Непроходимая клетка помещения или стены дома — кладка высотой со стену.
 * Стена здания в генераторе поселений — такая же непроходимая клетка, как
 * порода пещеры; различает их только соседство с помещением.
 */
export function isMasonryCell(map: TacticalMap, x: number, y: number): boolean {
  return isSolidCell(map, x, y) && touchesInterior(map, x, y)
}

/** Клетка-скала: непроходимая, не вода и не кладка. */
export function isRockCell(map: TacticalMap, x: number, y: number): boolean {
  return isSolidCell(map, x, y) && !touchesInterior(map, x, y)
}

/**
 * Толща скалы: все восемь соседей — тоже камень или край карты. Такие клетки
 * рисуются сплошным блоком, валуны — только по кромке, где порода видна.
 */
export function isRockCore(map: TacticalMap, x: number, y: number): boolean {
  if (!isRockCell(map, x, y)) return false
  for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
    if (!dx && !dy) continue
    const cell = cellAt(map, x + dx, y + dy)
    if (cell?.revealed && !isSolidCell(map, x + dx, y + dy)) return false
  }
  return true
}

/** Подъём верха плитки: детерминированный и меньше лифта оверлеев. */
export function tileLift(x: number, y: number): number {
  return cellNoise(x, y, 3) * TILE_JITTER
}

type Side = 'n' | 'e' | 's' | 'w'

/**
 * Пол плитками. Каждая клетка — плоский верх и кольцо фаски вниз к шву;
 * у воды верх — опущенное дно, а сторона к суше — пологий берег до кромки
 * соседней плитки. UV — по мировым координатам, поэтому рисунок пола с
 * canvas ложится непрерывно, как и раньше. Цвет вершин затемняет дно и
 * чуть разнит плитки между собой.
 */
export function createTileGroundGeometry(map: TacticalMap): THREE.BufferGeometry {
  const positions: number[] = [], uvs: number[] = [], colors: number[] = [], indices: number[] = []
  const width = Math.max(1, map.width), height = Math.max(1, map.height)
  let vertex = 0
  const push = (x: number, y: number, z: number, shade: [number, number, number]) => {
    positions.push(x, y, z)
    uvs.push(x / width, 1 - z / height)
    colors.push(...shade)
    return vertex++
  }
  const quad = (a: number, b: number, c: number, d: number) => { indices.push(a, b, c, a, c, d) }
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (!cell?.revealed) continue
    const level = terrainHeightAt(map, x, y)
    const water = cell.surface === 'water'
    const tint = 1 - cellNoise(x, y, 7) * .08
    const top = water ? level - WATER_BED_DEPTH : level + tileLift(x, y)
    const border = level - TILE_SEAM_DEPTH
    const topShade: [number, number, number] = water ? [.42, .5, .48] : [tint, tint, tint]
    const edgeShade: [number, number, number] = water ? [.6, .62, .55] : [tint * .82, tint * .8, tint * .76]
    // Отступ верха и высота внешнего края по каждой стороне.
    const neighborWater: Record<Side, boolean> = {
      n: isWaterCell(map, x, y - 1), e: isWaterCell(map, x + 1, y), s: isWaterCell(map, x, y + 1), w: isWaterCell(map, x - 1, y),
    }
    const inset = (side: Side) => water ? (neighborWater[side] ? 0 : WATER_BANK_INSET) : TILE_BEVEL
    const edgeHeight = (side: Side) => water && neighborWater[side] ? top : border
    const inN = inset('n'), inE = inset('e'), inS = inset('s'), inW = inset('w')
    // Верх: свои четыре вершины, нормаль строго вверх.
    const t0 = push(x + inW, top, y + inN, topShade)
    const t1 = push(x + inW, top, y + 1 - inS, topShade)
    const t2 = push(x + 1 - inE, top, y + 1 - inS, topShade)
    const t3 = push(x + 1 - inE, top, y + inN, topShade)
    quad(t0, t1, t2, t3)
    // Кольцо фаски: внутренняя кромка совпадает с верхом, внешняя — с краем клетки.
    const cornerHeight = (a: Side, b: Side) => Math.max(edgeHeight(a), edgeHeight(b))
    const i0 = push(x + inW, top, y + inN, edgeShade)
    const i1 = push(x + inW, top, y + 1 - inS, edgeShade)
    const i2 = push(x + 1 - inE, top, y + 1 - inS, edgeShade)
    const i3 = push(x + 1 - inE, top, y + inN, edgeShade)
    const o0 = push(x, cornerHeight('n', 'w'), y, edgeShade)
    const o1 = push(x, cornerHeight('s', 'w'), y + 1, edgeShade)
    const o2 = push(x + 1, cornerHeight('s', 'e'), y + 1, edgeShade)
    const o3 = push(x + 1, cornerHeight('n', 'e'), y, edgeShade)
    // Порядок обхода — против часовой при взгляде сверху, как у верха.
    if (inW || edgeHeight('w') !== top) quad(o0, o1, i1, i0)
    if (inS || edgeHeight('s') !== top) quad(i1, o1, o2, i2)
    if (inE || edgeHeight('e') !== top) quad(i3, i2, o2, o3)
    if (inN || edgeHeight('n') !== top) quad(o0, i0, i3, o3)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.setIndex(vertex > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * Поверхность воды: квад над каждой клеткой воды и признак берега в вершине
 * (1 — вершина касается суши). Шейдер рисует по нему пену, а рябь — от
 * мировых координат и времени.
 */
export function createWaterSurfaceGeometry(map: TacticalMap): THREE.BufferGeometry | null {
  const positions: number[] = [], shore: number[] = [], indices: number[] = []
  let vertex = 0
  const touchesLand = (cx: number, cy: number) => {
    // Угол (cx, cy) общий для четырёх клеток вокруг него.
    for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
      const cell = cellAt(map, cx + dx, cy + dy)
      if (cell?.revealed && cell.surface !== 'water') return 1
    }
    return 0
  }
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    if (!isWaterCell(map, x, y)) continue
    const level = terrainHeightAt(map, x, y) - WATER_SURFACE_DEPTH
    const corners: Array<[number, number]> = [[x, y], [x, y + 1], [x + 1, y + 1], [x + 1, y]]
    for (const [cx, cy] of corners) {
      positions.push(cx, level, cy)
      shore.push(touchesLand(cx, cy))
    }
    indices.push(vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3)
    vertex += 4
  }
  if (!vertex) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('shore', new THREE.Float32BufferAttribute(shore, 1))
  geometry.setIndex(vertex > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1))
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * Материал воды: бирюзовая полупрозрачная гладь, отражение окружения, рябь
 * и пена у берега. Анимация — одна униформа времени; без неё вода стоит.
 */
export function createWaterMaterial(color = '#3c9a9a'): THREE.MeshStandardMaterial & { userData: { time: { value: number } } } {
  const material = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: .62, roughness: .12, metalness: 0, depthWrite: false })
  const time = { value: 0 }
  material.userData.time = time
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterTime = time
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float shore;\nvarying float vShore;\nvarying vec2 vWaterXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShore = shore;\nvWaterXZ = position.xz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWaterTime;\nvarying float vShore;\nvarying vec2 vWaterXZ;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 p = vWaterXZ * 2.1;
          float t = uWaterTime;
          vec2 ripple = vec2(sin(p.x * 1.7 + t * 1.3) + sin(p.y * 2.3 - t * .9 + p.x * .6),
                             cos(p.y * 1.9 + t * 1.1) + cos(p.x * 2.6 + t * .7 - p.y * .4));
          normal = normalize(normal + vec3(ripple * .06, 0.));
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float foam = smoothstep(.55, 1., vShore);
          float wave = .5 + .5 * sin(vWaterXZ.x * 5.3 + vWaterXZ.y * 4.1 + uWaterTime * 1.6);
          foam *= .55 + .45 * wave;
          // У берега вода светлее и прозрачнее, к середине — глубже и плотнее.
          float depth = 1. - vShore;
          diffuseColor.rgb *= mix(1.18, .78, depth);
          diffuseColor.a = mix(.5, .78, depth);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.9, .97, .94), foam * .7);
          diffuseColor.a = mix(diffuseColor.a, .92, foam);
        }`)
  }
  material.customProgramCacheKey = () => 'board3d-water-v1'
  return material as THREE.MeshStandardMaterial & { userData: { time: { value: number } } }
}

/** Гранёный валун: икосаэдр со сдвинутыми вершинами, детерминированно по seed. */
export function createBoulderGeometry(seed: number): THREE.BufferGeometry {
  const base = new THREE.IcosahedronGeometry(.5, 0)
  const position = base.getAttribute('position') as THREE.BufferAttribute
  // Совпадающие вершины соседних граней сдвигаются одинаково: валун без щелей.
  const offsets = new Map<string, number>()
  for (let index = 0; index < position.count; index += 1) {
    const key = `${position.getX(index).toFixed(3)}:${position.getY(index).toFixed(3)}:${position.getZ(index).toFixed(3)}`
    if (!offsets.has(key)) offsets.set(key, .78 + cellNoise(index, seed, 11) * .38)
    const scale = offsets.get(key)!
    position.setXYZ(index, position.getX(index) * scale, position.getY(index) * scale * .82, position.getZ(index) * scale)
  }
  base.computeVertexNormals()
  return base
}

export type LandscapeInstances = {
  group: THREE.Group
  dispose: () => void
}

/** Камень по материалу клетки: серый гранит пещер и песчаник открытых мест. */
const ROCK_PALETTES: Record<string, THREE.Color[]> = {
  stone: ['#7d776d', '#6f695f', '#8a8377', '#625d55'].map((value) => new THREE.Color(value)),
  sand: ['#b39b78', '#a38b69', '#bfa883', '#97815f'].map((value) => new THREE.Color(value)),
  earth: ['#7a6e60', '#6c6154', '#85796a', '#5f554a'].map((value) => new THREE.Color(value)),
  grass: ['#8a8a74', '#7b7c66', '#97967f', '#6d6e5b'].map((value) => new THREE.Color(value)),
}
function rockPalette(material: string | undefined) {
  if (material === 'sand') return ROCK_PALETTES.sand
  if (material === 'earth') return ROCK_PALETTES.earth
  if (material === 'grass') return ROCK_PALETTES.grass
  return ROCK_PALETTES.stone
}
const MASONRY_COLORS: Record<string, string> = { wood: '#6d5238', stone: '#8d8478', marble: '#b9b2a6', earth: '#8a6f52', sand: '#a8916f' }

/**
 * Скалы: на каждой непроходимой клетке снаружи — груда из двух-трёх валунов,
 * в помещении — блок кладки. Груды соседних клеток срастаются в гряду.
 */
export function createRockClusters(map: TacticalMap, detail: LandscapeDetail, wallHeight = .68): LandscapeInstances {
  const group = new THREE.Group()
  group.name = 'landscape-rocks'
  const geometries = [0, 1, 2].map((seed) => createBoulderGeometry(seed))
  const material = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .92, metalness: 0, flatShading: true })
  const blockGeometry = new THREE.BoxGeometry(1, 1, 1)
  const blockMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .9, metalness: 0, flatShading: true })
  const rocks: Array<{ variant: number; matrix: THREE.Matrix4; color: THREE.Color }> = []
  const blocks: Array<{ matrix: THREE.Matrix4; color: THREE.Color }> = []
  const perCell = detail === 'minimal' ? 1 : detail === 'reduced' ? 2 : 3
  const object = new THREE.Object3D()
  const block = (x: number, y: number, base: number, height: number, color: THREE.Color, inset = 0) => {
    object.position.set(x + .5, base + height / 2, y + .5)
    object.rotation.set(0, 0, 0)
    object.scale.set(1 - inset, height, 1 - inset)
    object.updateMatrix()
    blocks.push({ matrix: object.matrix.clone(), color })
  }
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (!cell) continue
    const level = terrainHeightAt(map, x, y)
    if (isMasonryCell(map, x, y)) {
      block(x, y, level, wallHeight, new THREE.Color(MASONRY_COLORS[cell.material] ?? MASONRY_COLORS.stone).multiplyScalar(.9 + cellNoise(x, y, 31) * .1))
      continue
    }
    if (!isRockCell(map, x, y)) continue
    const palette = rockPalette(cell.material)
    const pick = (salt: number) => palette[Math.floor(cellNoise(x, y, salt) * palette.length) % palette.length]
    if (isRockCore(map, x, y)) {
      // Толща: блок неровной высоты; соседние блоки разной высоты дают
      // ступенчатую гряду, как у сложенных плиток диорамы.
      // Толща темнее кромки: свет падает на верх массива, и светлый камень
      // читался бы полем кубиков, а не скалой.
      const coreHeight = 1 + cellNoise(x, y, 41) * .3
      block(x, y, level, coreHeight, pick(42).clone().multiplyScalar(.62))
      // Каждый третий блок толщи несёт валун: верх массива неровный, как у
      // сложенной скалы, а не ровное поле кубиков.
      if (detail !== 'minimal' && cellNoise(x, y, 45) < .34) {
        const n = (salt: number) => cellNoise(x, y, salt)
        object.position.set(x + .5 + (n(46) - .5) * .3, level + coreHeight + .12, y + .5 + (n(47) - .5) * .3)
        object.rotation.set((n(48) - .5) * .5, n(49) * Math.PI * 2, (n(50) - .5) * .5)
        object.scale.set(.7 + n(51) * .3, .45 + n(52) * .3, .7 + n(53) * .3)
        object.updateMatrix()
        rocks.push({ variant: Math.floor(n(54) * geometries.length) % geometries.length, matrix: object.matrix.clone(), color: pick(55).clone().multiplyScalar(.72) })
      }
      continue
    }
    // Кромка: крупные валуны, сросшиеся с соседними клетками в гряду.
    for (let index = 0; index < perCell; index += 1) {
      const n = (salt: number) => cellNoise(x, y, salt + index * 13)
      const size = index === 0 ? 1.15 + n(1) * .3 : .65 + n(1) * .35
      const tall = index === 0 ? 1.05 + n(2) * .5 : .6 + n(2) * .5
      const spread = index === 0 ? .08 : .28
      object.position.set(x + .5 + (n(3) - .5) * spread * 2, level + tall * .3, y + .5 + (n(4) - .5) * spread * 2)
      object.rotation.set((n(5) - .5) * .4, n(6) * Math.PI * 2, (n(7) - .5) * .4)
      object.scale.set(size, tall, size * (.85 + n(8) * .3))
      object.updateMatrix()
      rocks.push({ variant: Math.floor(n(9) * geometries.length) % geometries.length, matrix: object.matrix.clone(), color: pick(10 + index) })
    }
  }
  geometries.forEach((geometry, variant) => {
    const list = rocks.filter((rock) => rock.variant === variant)
    if (!list.length) return
    const mesh = new THREE.InstancedMesh(geometry, material, list.length)
    list.forEach((rock, index) => { mesh.setMatrixAt(index, rock.matrix); mesh.setColorAt(index, rock.color) })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.computeBoundingSphere()
    group.add(mesh)
  })
  if (blocks.length) {
    const mesh = new THREE.InstancedMesh(blockGeometry, blockMaterial, blocks.length)
    blocks.forEach((entry, index) => { mesh.setMatrixAt(index, entry.matrix); mesh.setColorAt(index, entry.color) })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.computeBoundingSphere()
    group.add(mesh)
  }
  return {
    group,
    dispose() {
      group.removeFromParent()
      group.clear()
      geometries.forEach((geometry) => geometry.dispose())
      material.dispose()
      blockGeometry.dispose()
      blockMaterial.dispose()
    },
  }
}

/** Пучок травы: несколько узких лезвий-конусов в одной геометрии. */
export function createGrassTuftGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const blades = 6
  for (let index = 0; index < blades; index += 1) {
    const blade = new THREE.ConeGeometry(.035, .24 + cellNoise(index, 1, 5) * .12, 3, 1)
    const angle = index / blades * Math.PI * 2
    blade.rotateZ((cellNoise(index, 2, 5) - .5) * .7)
    blade.rotateY(angle)
    blade.translate(Math.cos(angle) * .05, .12, Math.sin(angle) * .05)
    parts.push(blade)
  }
  const positions: number[] = [], colors: number[] = [], indices: number[] = []
  let offset = 0
  for (const part of parts) {
    const position = part.getAttribute('position') as THREE.BufferAttribute
    for (let index = 0; index < position.count; index += 1) {
      positions.push(position.getX(index), position.getY(index), position.getZ(index))
      // Основание темнее, кончики светлее — пучок объёмный и без текстуры.
      const lift = Math.min(1, Math.max(0, position.getY(index) / .36))
      colors.push(.28 + lift * .3, .48 + lift * .34, .16 + lift * .1)
    }
    const index = part.getIndex()!
    for (let item = 0; item < index.count; item += 1) indices.push(index.getX(item) + offset)
    offset += position.count
    part.dispose()
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/**
 * Трава на проходимых травяных клетках без предметов. Густота по детализации:
 * на «Экономном» травы нет вовсе.
 */
export function createGrassTufts(map: TacticalMap, props: readonly TacticalProp[], detail: LandscapeDetail): LandscapeInstances | null {
  if (detail === 'minimal') return null
  const occupied = new Set<string>()
  for (const prop of props) {
    for (const point of prop.footprint.length ? prop.footprint : [{ x: prop.x, y: prop.y }]) occupied.add(`${Math.floor(point.x)},${Math.floor(point.y)}`)
  }
  const perCell = detail === 'full' ? 3 : 1.5
  const matrices: THREE.Matrix4[] = []
  const object = new THREE.Object3D()
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (!cell?.revealed || !cell.passable || cell.material !== 'grass' || cell.surface !== 'none' || occupied.has(`${x},${y}`)) continue
    const count = Math.floor(perCell + cellNoise(x, y, 21))
    for (let index = 0; index < count; index += 1) {
      const n = (salt: number) => cellNoise(x, y, salt + index * 17)
      object.position.set(x + .12 + n(1) * .76, terrainHeightAt(map, x, y) + tileLift(x, y), y + .12 + n(2) * .76)
      object.rotation.set(0, n(3) * Math.PI * 2, 0)
      const size = .7 + n(4) * .6
      object.scale.set(size, .8 + n(5) * .6, size)
      object.updateMatrix()
      matrices.push(object.matrix.clone())
    }
  }
  if (!matrices.length) return null
  const group = new THREE.Group()
  group.name = 'landscape-grass'
  const geometry = createGrassTuftGeometry()
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .95, metalness: 0 })
  const mesh = new THREE.InstancedMesh(geometry, material, matrices.length)
  matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix))
  mesh.instanceMatrix.needsUpdate = true
  mesh.receiveShadow = true
  mesh.computeBoundingSphere()
  group.add(mesh)
  return {
    group,
    dispose() {
      group.removeFromParent()
      group.clear()
      geometry.dispose()
      material.dispose()
    },
  }
}

/** Наибольшая ширина мостика поперёк пролёта, в клетках. */
const BRIDGE_MAX_WIDTH = 4

function isDeckCell(map: TacticalMap, x: number, y: number) {
  const cell = cellAt(map, x, y)
  return Boolean(cell?.revealed && cell.passable && cell.surface !== 'water')
}

/** Короткая полоса настила через клетку вдоль оси упирается в воду с обеих сторон. */
function spansWater(map: TacticalMap, x: number, y: number, dx: number, dy: number) {
  let length = 1
  const end = (sign: number) => {
    let cx = x + dx * sign, cy = y + dy * sign
    while (isDeckCell(map, cx, cy)) {
      length += 1
      if (length > BRIDGE_MAX_WIDTH) return false
      cx += dx * sign; cy += dy * sign
    }
    return isWaterCell(map, cx, cy)
  }
  return end(-1) && end(1)
}

/**
 * Мост: проходимая клетка, через которую короткая полоса настила упирается в
 * воду с обеих сторон. Генератор не ставит для моста отдельного предмета —
 * переправа задана материалом клеток, — поэтому перила вдоль воды и балки
 * достраивает представление. Берег под правило не попадает: его полоса
 * уходит на сушу.
 */
export function bridgeSpan(map: TacticalMap, x: number, y: number): 'x' | 'y' | null {
  if (!isDeckCell(map, x, y)) return null
  // Вода сверху и снизу полосы — настил идёт вдоль x.
  if (spansWater(map, x, y, 0, 1)) return 'x'
  if (spansWater(map, x, y, 1, 0)) return 'y'
  return null
}

export function createBridgeRails(map: TacticalMap): LandscapeInstances | null {
  const pieces: THREE.Matrix4[] = []
  const object = new THREE.Object3D()
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    object.position.set(x, y, z)
    object.rotation.set(0, 0, 0)
    object.scale.set(sx, sy, sz)
    object.updateMatrix()
    pieces.push(object.matrix.clone())
  }
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const span = bridgeSpan(map, x, y)
    if (!span) continue
    const level = terrainHeightAt(map, x, y)
    // Перила — только по сторонам, обращённым к воде.
    const sides: Array<[number, number]> = span === 'x' ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]]
    for (const [dx, dy] of sides) {
      if (!isWaterCell(map, x + dx, y + dy)) continue
      if (span === 'x') {
        const z = y + .5 + dy * .44
        box(x + .5, level + .36, z, 1.02, .06, .07)
        box(x + .14, level + .19, z, .08, .38, .08)
        box(x + .86, level + .19, z, .08, .38, .08)
      } else {
        const px = x + .5 + dx * .44
        box(px, level + .36, y + .5, .07, .06, 1.02)
        box(px, level + .19, y + .14, .08, .38, .08)
        box(px, level + .19, y + .86, .08, .38, .08)
      }
    }
    // Балка под настилом видна над водой и держит мост визуально.
    if (span === 'x') box(x + .5, level - .1, y + .5, 1, .1, .86)
    else box(x + .5, level - .1, y + .5, .86, .1, 1)
  }
  if (!pieces.length) return null
  const group = new THREE.Group()
  group.name = 'landscape-bridges'
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const material = new THREE.MeshStandardMaterial({ color: '#6b4b30', roughness: .85, metalness: 0 })
  const mesh = new THREE.InstancedMesh(geometry, material, pieces.length)
  pieces.forEach((matrix, index) => mesh.setMatrixAt(index, matrix))
  mesh.instanceMatrix.needsUpdate = true
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.computeBoundingSphere()
  group.add(mesh)
  return {
    group,
    dispose() {
      group.removeFromParent()
      group.clear()
      geometry.dispose()
      material.dispose()
    },
  }
}

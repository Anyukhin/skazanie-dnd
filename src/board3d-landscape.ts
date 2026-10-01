import * as THREE from 'three'

import { cellAt } from './tactical-map-client'
import { terrainHeightAt } from './board3d-terrain'
import { createMasonryDressing, masonryStyleFor, MASONRY_COLORS, type MasonryRun } from './board3d-masonry'
import { landscapeModelsOf, pickLandscapeVariant, type LandscapeKit, type LandscapeModel } from './landscape-model-assets'
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
  if (!isSolidCell(map, x, y)) return false
  const kind = themeSolidKind(map)
  return kind === 'masonry' || kind === 'mixed' && touchesInterior(map, x, y)
}

/** Клетка-скала: непроходимая, не вода и не кладка. */
export function isRockCell(map: TacticalMap, x: number, y: number): boolean {
  if (!isSolidCell(map, x, y)) return false
  const kind = themeSolidKind(map)
  return kind === 'rock' || kind === 'mixed' && !touchesInterior(map, x, y)
}

/** Рукотворные темы: природной породы в них нет, непроходимое — кладка. */
const BUILT_THEMES = new Set(['building', 'temple', 'crypt', 'palace', 'castle', 'fortress', 'dungeon', 'tower', 'authored-palace', 'interior'])
/** Природные темы: непроходимое — порода и валуны. */
const NATURAL_THEMES = new Set(['cave', 'forest', 'road', 'mine', 'wilderness', 'swamp', 'mountain'])

/**
 * Чем считать непроходимую клетку по теме карты. Поселение и карты без темы
 * (в том числе импортированные) решают по соседству: стена дома — кладка,
 * остальное — камень.
 */
export function themeSolidKind(map: TacticalMap): 'masonry' | 'rock' | 'mixed' {
  const theme = String(map.theme ?? '').toLowerCase()
  if (BUILT_THEMES.has(theme)) return 'masonry'
  if (NATURAL_THEMES.has(theme)) return 'rock'
  return 'mixed'
}

/** Все восемь соседей непроходимы или за краем карты. */
function isSolidMass(map: TacticalMap, x: number, y: number) {
  for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
    if (!dx && !dy) continue
    const cell = cellAt(map, x + dx, y + dy)
    if (cell?.revealed && cell.passable) return false
  }
  return true
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
    // Трава диорамы сочнее рисунка 2D: зелёный сдвиг верха плитки.
    const grass = !water && cell.material === 'grass'
    const topShade: [number, number, number] = water ? [.42, .5, .48] : grass ? [tint * .96, tint * 1.12, tint * .78] : [tint, tint, tint]
    const edgeShade: [number, number, number] = water ? [.6, .62, .55] : grass ? [tint * .72, tint * .84, tint * .58] : [tint * .82, tint * .8, tint * .76]
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
  // Икосаэдр второго уровня с сильным разбросом — округлая глыба, а не кристалл.
  const base = new THREE.IcosahedronGeometry(.5, 1)
  const position = base.getAttribute('position') as THREE.BufferAttribute
  // Совпадающие вершины соседних граней сдвигаются одинаково: валун без щелей.
  const offsets = new Map<string, number>()
  for (let index = 0; index < position.count; index += 1) {
    const key = `${position.getX(index).toFixed(3)}:${position.getY(index).toFixed(3)}:${position.getZ(index).toFixed(3)}`
    if (!offsets.has(key)) offsets.set(key, .8 + cellNoise(index * 1.7, seed, 11) * .34)
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
  // Открытые места: тёплый кремовый песчаник, как у берегов диорамы.
  grass: ['#c4ad86', '#b49c76', '#d0bb94', '#a58c67'].map((value) => new THREE.Color(value)),
}
function rockPalette(material: string | undefined) {
  if (material === 'sand') return ROCK_PALETTES.sand
  if (material === 'earth') return ROCK_PALETTES.earth
  if (material === 'grass') return ROCK_PALETTES.grass
  return ROCK_PALETTES.stone
}

/**
 * Тон камня-модели: мшистый — родная фактура Quaternius (лес, луг), голый —
 * та же фактура, обесцвеченная в шейдере (пещера, песок, гранит). Оттенок
 * породы задаёт цвет экземпляра поверх.
 */
export type RockTone = 'moss' | 'bare'
const ROCK_TONE_SATURATION: Record<RockTone, number> = { moss: 1, bare: .14 }
/** Подъём яркости голого камня: обесцвеченный мох темнее серого камня фактуры. */
const ROCK_TONE_LIFT: Record<RockTone, number> = { moss: 1, bare: 1.45 }

/** Мшистая фактура — на открытых травяных и земляных местах, в пещере — голый камень. */
export function rockToneFor(map: TacticalMap, material: string | undefined): RockTone {
  if (String(map.theme ?? '').toLowerCase() === 'cave' || String(map.theme ?? '').toLowerCase() === 'mine') return 'bare'
  return material === 'grass' || material === 'earth' ? 'moss' : 'bare'
}

/** Оттенок модели камня: фактура уже светотеневая, поэтому оттенок светлее палитры процедурных валунов. */
const MODEL_ROCK_TINTS: Record<RockTone, Record<string, THREE.Color[]>> = {
  moss: {
    grass: ['#f2f0e6', '#e4e6d6', '#fbf6ea', '#d9dccb'].map((value) => new THREE.Color(value)),
    earth: ['#e2d6c4', '#d4c8b4', '#ece0cc', '#c8baa4'].map((value) => new THREE.Color(value)),
  },
  bare: {
    stone: ['#d2cabd', '#c4bcae', '#ddd5c7', '#b7afa2'].map((value) => new THREE.Color(value)),
    sand: ['#f0d6a8', '#e2c696', '#f8e0b4', '#d6b886'].map((value) => new THREE.Color(value)),
    earth: ['#bda88e', '#ae9a80', '#c8b498', '#a08c74'].map((value) => new THREE.Color(value)),
    grass: ['#ece0c6', '#ddd0b4', '#f6eacf', '#cfc1a4'].map((value) => new THREE.Color(value)),
  },
}
function modelRockTint(tone: RockTone, material: string | undefined) {
  const table = MODEL_ROCK_TINTS[tone]
  return table[material ?? ''] ?? table.stone ?? table.grass
}

/**
 * Материал экземпляров камня: копия материала модели (фактура общая, не
 * копируется) с обесцвечиванием до умножения на цвет экземпляра.
 */
export function createRockModelMaterial(source: THREE.Material, tone: RockTone): THREE.Material {
  const material = source.clone()
  const saturation = ROCK_TONE_SATURATION[tone]
  const lift = ROCK_TONE_LIFT[tone]
  if (saturation < 1 || lift !== 1) {
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        diffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(.299, .587, .114))), diffuseColor.rgb, ${saturation.toFixed(3)}) * ${lift.toFixed(3)};`)
    }
    material.customProgramCacheKey = () => `landscape-rock-${tone}`
  }
  return material
}

type ModelInstance = { model: LandscapeModel; matrix: THREE.Matrix4; color: THREE.Color | null; tone: RockTone | null }

/** Сторона участка карты, на которые делятся экземпляры моделей местности, в клетках. */
export const LANDSCAPE_CHUNK = 6

/**
 * Экземпляры моделей набора: один InstancedMesh на пару (геометрия части,
 * производный материал). Геометрии принадлежат набору и здесь не
 * освобождаются; производные материалы — свои, их освобождает `dispose`.
 */
function instanceLandscapeModels(group: THREE.Group, instances: readonly ModelInstance[], shadows: { cast: boolean; receive: boolean }) {
  const materials = new Map<string, THREE.Material>()
  const batches = new Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; entries: ModelInstance[] }>()
  for (const instance of instances) for (const part of instance.model.parts) {
    const materialKey = `${part.material.uuid}:${instance.tone ?? 'plain'}`
    let material = materials.get(materialKey)
    if (!material) {
      material = instance.tone ? createRockModelMaterial(part.material, instance.tone) : part.material
      materials.set(materialKey, material)
    }
    // Участок карты: у InstancedMesh одна сфера отсечения на все экземпляры, и
    // без разбиения вся гряда попадала бы в каждую грань кубической тени огня.
    const chunk = `${Math.floor(instance.matrix.elements[12] / LANDSCAPE_CHUNK)}:${Math.floor(instance.matrix.elements[14] / LANDSCAPE_CHUNK)}`
    const key = `${part.geometry.uuid}:${materialKey}:${chunk}`
    const batch = batches.get(key) ?? { geometry: part.geometry, material, entries: [] }
    batch.entries.push(instance)
    batches.set(key, batch)
  }
  for (const batch of batches.values()) {
    const mesh = new THREE.InstancedMesh(batch.geometry, batch.material, batch.entries.length)
    mesh.name = 'landscape-model'
    batch.entries.forEach((entry, index) => {
      mesh.setMatrixAt(index, entry.matrix)
      if (entry.color) mesh.setColorAt(index, entry.color)
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.castShadow = shadows.cast
    mesh.receiveShadow = shadows.receive
    mesh.computeBoundingSphere()
    group.add(mesh)
  }
  const owned = [...materials.entries()].filter(([key]) => !key.endsWith(':plain')).map(([, material]) => material)
  return () => owned.forEach((material) => material.dispose())
}

/** Есть ли на карте что рисовать моделями набора: скала или вода (берег, мост). */
export function landscapeWantsModels(map: TacticalMap): boolean {
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    if (isWaterCell(map, x, y) || isRockCell(map, x, y)) return true
  }
  return false
}

/** Плоская плита (высота меньше 0,4 стороны) — основание гряды, а не глыба. */
function isSlab(model: LandscapeModel) {
  return model.size.y < .4
}

/** Модели камней набора, если их хватает на скалы; иначе — `null`, процедурный вариант. */
export function landscapeRockModels(kit: LandscapeKit | null | undefined) {
  const rocks = landscapeModelsOf(kit, 'rock')
  const boulders = rocks.filter((model) => !isSlab(model))
  const slabs = rocks.filter(isSlab)
  const cliffs = landscapeModelsOf(kit, 'cliff')
  if (!boulders.length) return null
  return { boulders, slabs, cliffs: cliffs.length ? cliffs : boulders }
}

/**
 * Скалы: на каждой непроходимой клетке снаружи — груда из двух-трёх валунов,
 * в помещении — блок кладки. Груды соседних клеток срастаются в гряду.
 * С набором моделей валуны и толща — текстурированные камни Quaternius; без
 * него (загрузка, отказ, тесты) — процедурные икосаэдры.
 */
export function createRockClusters(map: TacticalMap, detail: LandscapeDetail, wallHeight = .68, kit: LandscapeKit | null = null): LandscapeInstances {
  const group = new THREE.Group()
  group.name = 'landscape-rocks'
  const kitRocks = landscapeRockModels(kit)
  group.userData.rockSource = kitRocks ? 'models' : 'procedural'
  const modelInstances: ModelInstance[] = []
  const geometries = [0, 1, 2].map((seed) => createBoulderGeometry(seed))
  const material = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .92, metalness: 0, flatShading: true })
  const blockGeometry = new THREE.BoxGeometry(1, 1, 1)
  const blockMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .9, metalness: 0, flatShading: true })
  const rocks: Array<{ variant: number; matrix: THREE.Matrix4; color: THREE.Color }> = []
  const blocks: Array<{ matrix: THREE.Matrix4; color: THREE.Color }> = []
  const masonryRuns: MasonryRun[] = []
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
    // Глухая толща постройки (вокруг только непроходимое): каменная площадка
    // из плит со швами — одна плита на клетку вместо десятка камней кладки.
    if (isMasonryCell(map, x, y) && isSolidMass(map, x, y)) {
      const base = new THREE.Color(MASONRY_COLORS[cell.material] ?? MASONRY_COLORS.stone)
      block(x, y, level, wallHeight - .02, base.clone().multiplyScalar(.4))
      block(x, y, level + wallHeight - .06, .08, base.multiplyScalar(.78 + cellNoise(x, y, 33) * .2), .06)
      continue
    }
    if (isMasonryCell(map, x, y) && detail === 'minimal') {
      block(x, y, level, wallHeight, new THREE.Color(MASONRY_COLORS[cell.material] ?? MASONRY_COLORS.stone))
      continue
    }
    if (isMasonryCell(map, x, y)) {
      // Тёмное ядро и два ряда кладки крест-накрест: стена-клетка сложена
      // теми же камнями, что и стены по рёбрам.
      block(x, y, level, wallHeight - .06, new THREE.Color(masonryStyleFor(cell.material) === 'wood' ? '#2f2219' : '#2b2722'), .1)
      const color = MASONRY_COLORS[cell.material] ?? MASONRY_COLORS.stone
      const style = masonryStyleFor(cell.material)
      masonryRuns.push({ x: x + .5, z: y + .25, y: level, length: 1, thickness: .42, height: wallHeight, alongX: true, style, color, seed: x * 13 + y * 29 })
      masonryRuns.push({ x: x + .5, z: y + .75, y: level, length: 1, thickness: .42, height: wallHeight, alongX: true, style, color, seed: x * 13 + y * 29 + 5 })
      continue
    }
    if (!isRockCell(map, x, y)) continue
    const palette = rockPalette(cell.material)
    const pick = (salt: number) => palette[Math.floor(cellNoise(x, y, salt) * palette.length) % palette.length]
    const core = isRockCore(map, x, y) && (cell.material === 'earth' || cell.material === 'stone' || themeSolidKind(map) === 'rock' && map.theme === 'cave')
    if (kitRocks) {
      const tone = rockToneFor(map, cell.material)
      const tints = modelRockTint(tone, cell.material)
      const place = (model: LandscapeModel, salt: number, footprint: number, height: number, offset: number, base: number, tilt: number) => {
        const n = (value: number) => cellNoise(x, y, salt + value)
        // Высота задаётся отдельно от ширины, но вытягивание ограничено: камень
        // остаётся камнем, а не столбом или блином.
        const stretch = Math.min(1.5, Math.max(.75, height / Math.max(.05, model.size.y * footprint)))
        object.position.set(x + .5 + (n(1) - .5) * offset * 2, base, y + .5 + (n(2) - .5) * offset * 2)
        object.rotation.set((n(3) - .5) * tilt, n(4) * Math.PI * 2, (n(5) - .5) * tilt)
        object.scale.set(footprint, footprint * stretch, footprint * (.88 + n(6) * .24))
        object.updateMatrix()
        const tint = tints[Math.floor(n(7) * tints.length) % tints.length]
        modelInstances.push({ model, matrix: object.matrix.clone(), color: core ? tint.clone().multiplyScalar(.94) : tint, tone })
      }
      if (core) {
        // Толща: тёмное основание закрывает щели, сверху — крупная глыба шире
        // клетки; соседние глыбы срастаются в сплошной массив.
        block(x, y, level, .7, pick(42).clone().multiplyScalar(.42), .08)
        const model = pickLandscapeVariant(kitRocks.cliffs, cellNoise(x, y, 60))!
        place(model, 61, 1.8 + cellNoise(x, y, 62) * .35, 1.02 + cellNoise(x, y, 63) * .25, .1, level - .1, .1)
        continue
      }
      // Кромка: глыба в клетку и больше, у основания — плита или камень
      // поменьше, сверху — обломок. Детерминированно по шуму клетки.
      const n = (salt: number) => cellNoise(x, y, salt)
      place(pickLandscapeVariant(kitRocks.boulders, n(70))!, 71, 1.2 + n(72) * .3, .9 + n(73) * .4, .08, level - .06, .2)
      if (perCell > 1) {
        const slab = kitRocks.slabs.length && n(80) < .5
        const model = slab ? pickLandscapeVariant(kitRocks.slabs, n(81))! : pickLandscapeVariant(kitRocks.boulders, n(81))!
        place(model, 82, slab ? 1 + n(83) * .25 : .6 + n(83) * .2, slab ? .3 : .45 + n(84) * .2, .28, level - .03, .25)
      }
      if (perCell > 2 && n(90) < .6) {
        place(pickLandscapeVariant(kitRocks.boulders, n(91))!, 92, .42 + n(93) * .18, .3 + n(94) * .15, .3, level + .25 + n(95) * .2, .5)
      }
      continue
    }
    if (core) {
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
    // Кромка: широкая плоская глыба в основании и глыбы поменьше сверху —
    // слоистая гряда, сросшаяся с соседними клетками.
    for (let index = 0; index < perCell; index += 1) {
      const n = (salt: number) => cellNoise(x, y, salt + index * 13)
      const size = index === 0 ? 1.35 + n(1) * .3 : .7 + n(1) * .35
      const tall = index === 0 ? .7 + n(2) * .25 : .55 + n(2) * .4
      const spread = index === 0 ? .06 : .26
      const lift = index === 0 ? tall * .3 : .38 + tall * .22
      object.position.set(x + .5 + (n(3) - .5) * spread * 2, level + lift, y + .5 + (n(4) - .5) * spread * 2)
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
  const masonry = masonryRuns.length ? createMasonryDressing(masonryRuns, 'cell-masonry') : null
  if (masonry) group.add(masonry.group)
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
  const disposeModels = modelInstances.length ? instanceLandscapeModels(group, modelInstances, { cast: true, receive: true }) : null
  return {
    group,
    dispose() {
      group.removeFromParent()
      group.clear()
      geometries.forEach((geometry) => geometry.dispose())
      material.dispose()
      blockGeometry.dispose()
      blockMaterial.dispose()
      masonry?.dispose()
      disposeModels?.()
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

/** Вертикальный масштаб пролёта Kenney: перила поднимаются примерно на треть клетки над настилом. */
const BRIDGE_MODEL_HEIGHT_SCALE = 1.6
/** Высота середины настила пролёта Kenney над его основанием, в приведённой модели. */
const BRIDGE_MODEL_DECK = .2

export type BridgeStrip = { x: number; y: number; span: 'x' | 'y'; width: number; level: number }

/**
 * Полосы настила поперёк пролёта для моделей моста: для 'x' полоса идёт вдоль
 * y, для 'y' — вдоль x. Полоса с клетками разной высоты (террасы в футах)
 * моделью не покрывается: одна секция легла бы над частью настила.
 */
export function bridgeModelStrips(map: TacticalMap): BridgeStrip[] {
  const strips: BridgeStrip[] = []
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const span = bridgeSpan(map, x, y)
    if (!span) continue
    const [ax, ay] = span === 'x' ? [0, 1] : [1, 0]
    if (bridgeSpan(map, x - ax, y - ay) === span) continue
    const level = terrainHeightAt(map, x, y)
    let width = 1
    let flat = true
    while (width < BRIDGE_MAX_WIDTH && bridgeSpan(map, x + ax * width, y + ay * width) === span) {
      if (Math.abs(terrainHeightAt(map, x + ax * width, y + ay * width) - level) > .01) flat = false
      width += 1
    }
    if (flat) strips.push({ x, y, span, width, level })
  }
  return strips
}

/**
 * Мост из моделей набора: на каждую полосу настила — одна секция Kenney,
 * растянутая поперёк на всю ширину полосы, поэтому перила стоят только по
 * внешним краям, а не между полосами. Настил секции утоплен под плитку: по
 * мосту ходят по той же плитке-настилу, что и в 2D, а модель добавляет
 * перила, стойки и арку балок над водой.
 */
function bridgeModelInstances(strips: readonly BridgeStrip[], model: LandscapeModel): ModelInstance[] {
  const object = new THREE.Object3D()
  return strips.map((strip) => {
    const { x, y, span, width, level } = strip
    object.position.set(x + (span === 'x' ? .5 : width / 2), level - .006 - BRIDGE_MODEL_DECK * BRIDGE_MODEL_HEIGHT_SCALE, y + (span === 'x' ? width / 2 : .5))
    object.rotation.set(0, span === 'x' ? 0 : Math.PI / 2, 0)
    object.scale.set(1 / Math.max(.5, model.size.x), BRIDGE_MODEL_HEIGHT_SCALE, width / Math.max(.5, model.size.z))
    object.updateMatrix()
    return { model, matrix: object.matrix.clone(), color: null, tone: null }
  })
}

/**
 * Кувшинки на глади и тростник у берега — только из набора моделей: у
 * процедурного варианта их нет. Выбор клетки, варианта и поворота —
 * детерминированно по шуму клетки; на «Экономном» не ставятся.
 */
export function createWaterPlants(map: TacticalMap, detail: LandscapeDetail, kit: LandscapeKit | null): LandscapeInstances | null {
  if (detail === 'minimal' || !kit) return null
  // В пещере, шахте и постройках у воды нет ни солнца, ни тростника.
  const theme = String(map.theme ?? '').toLowerCase()
  if (theme === 'cave' || theme === 'mine' || BUILT_THEMES.has(theme)) return null
  const lilies = landscapeModelsOf(kit, 'lily')
  const reeds = landscapeModelsOf(kit, 'reed')
  if (!lilies.length && !reeds.length) return null
  const instances: ModelInstance[] = []
  const object = new THREE.Object3D()
  const place = (model: LandscapeModel, px: number, base: number, pz: number, footprint: number, height: number, yaw: number) => {
    object.position.set(px, base, pz)
    object.rotation.set(0, yaw, 0)
    object.scale.set(footprint, height / Math.max(.02, model.size.y), footprint)
    object.updateMatrix()
    instances.push({ model, matrix: object.matrix.clone(), color: null, tone: null })
  }
  const lilyChance = detail === 'full' ? .32 : .2
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    if (!isWaterCell(map, x, y)) continue
    const n = (salt: number) => cellNoise(x, y, salt)
    const level = terrainHeightAt(map, x, y)
    // Берег — ближайшая сторона суши: тростник растёт у неё, из дна.
    const land = ([[0, -1], [1, 0], [0, 1], [-1, 0]] as const).filter(([dx, dy]) => {
      const cell = cellAt(map, x + dx, y + dy)
      return Boolean(cell?.revealed && cell.surface !== 'water' && cell.passable)
    })
    if (reeds.length && land.length && n(101) < .5) {
      const [dx, dy] = land[Math.floor(n(102) * land.length) % land.length]
      const clumps = detail === 'full' ? 2 : 1
      for (let index = 0; index < clumps; index += 1) {
        const m = (salt: number) => cellNoise(x, y, salt + index * 7)
        const along = (m(103) - .5) * .6
        place(pickLandscapeVariant(reeds, m(104))!, x + .5 + dx * .3 + (dy ? along : 0), level - WATER_BED_DEPTH, y + .5 + dy * .3 + (dx ? along : 0),
          .32 + m(105) * .16, .5 + m(106) * .2, m(107) * Math.PI * 2)
      }
    }
    if (lilies.length && n(110) < lilyChance) {
      const count = 1 + (n(111) < .4 ? 1 : 0)
      for (let index = 0; index < count; index += 1) {
        const m = (salt: number) => cellNoise(x, y, salt + index * 5)
        place(pickLandscapeVariant(lilies, m(112))!, x + .2 + m(113) * .6, level - WATER_SURFACE_DEPTH - .012, y + .2 + m(114) * .6,
          .26 + m(115) * .14, .03, m(116) * Math.PI * 2)
      }
    }
  }
  if (!instances.length) return null
  const group = new THREE.Group()
  group.name = 'landscape-water-plants'
  // Мелкие растения не бросают тень: экономия на картах теней.
  const disposeModels = instanceLandscapeModels(group, instances, { cast: false, receive: true })
  return {
    group,
    dispose() {
      group.removeFromParent()
      group.clear()
      disposeModels()
    },
  }
}

/**
 * Перила и балки моста. С набором моделей ровные полосы настила получают
 * секции Kenney, остальные клетки моста — процедурные перила из брусков.
 */
export function createBridgeRails(map: TacticalMap, kit: LandscapeKit | null = null): LandscapeInstances | null {
  const bridgeModels = landscapeModelsOf(kit, 'bridge')
  const bridgeModel = bridgeModels.find((entry) => entry.key === 'bridge-wood') ?? bridgeModels[0] ?? null
  const strips = bridgeModel ? bridgeModelStrips(map) : []
  const covered = new Set<string>()
  for (const strip of strips) for (let index = 0; index < strip.width; index += 1) {
    covered.add(strip.span === 'x' ? `${strip.x},${strip.y + index}` : `${strip.x + index},${strip.y}`)
  }
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
    if (!span || covered.has(`${x},${y}`)) continue
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
  if (!pieces.length && !strips.length) return null
  const group = new THREE.Group()
  group.name = 'landscape-bridges'
  group.userData.bridgeSource = strips.length ? 'models' : 'procedural'
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const material = new THREE.MeshStandardMaterial({ color: '#6b4b30', roughness: .85, metalness: 0 })
  if (pieces.length) {
    const mesh = new THREE.InstancedMesh(geometry, material, pieces.length)
    pieces.forEach((matrix, index) => mesh.setMatrixAt(index, matrix))
    mesh.instanceMatrix.needsUpdate = true
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.computeBoundingSphere()
    group.add(mesh)
  }
  const disposeModels = bridgeModel && strips.length
    ? instanceLandscapeModels(group, bridgeModelInstances(strips, bridgeModel), { cast: true, receive: true }) : null
  return {
    group,
    dispose() {
      group.removeFromParent()
      group.clear()
      geometry.dispose()
      material.dispose()
      disposeModels?.()
    },
  }
}

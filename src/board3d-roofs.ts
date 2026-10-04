import * as THREE from 'three'

import type { BoardPalette } from './board-render'
import type { TacticalCell, TacticalMap, TacticalZone } from './types'
import { cellAt, edgeBetween, edgeList, edgeNeighbor, revealedAt } from './tactical-map-client'
import { terrainHeightAt } from './board3d-terrain'
import type { GraphicsStylePack } from './board3d-style'
import { STRUCTURAL_ROLES, structuralInstance, type StructuralModelAssets, type StructuralRole } from './board3d-structural'
import { createLookMaterial, createUvLookMaterial, edgeSideCell, lookRepeat, wallLookFor, type WallTextureLoader } from './board3d-walls'
import { cellKey, createHipDistance, createHipRoofGeometry, hipRoofDepth, hipRoofRafters, hipRoofRuns } from './board3d-hip-roof'

/** Режим оболочки здания. Крышный слой не меняет клеточную механику. */
export type Board3DRoofMode = 'cutaway' | 'full' | 'hidden'

export type Board3DRoofOptions = {
  /** Высота существующей срезанной стены, от которой начинается карниз. */
  wallHeight?: number
  mode?: Board3DRoofMode
  /**
   * Пакет рисованного стиля: скаты из черепицы или досок, фронтоны и верх стен
   * — фактурой кладки дома, стропила и конёк — брусом. Без пакета крыши
   * прежние, однотонные.
   */
  stylePack?: GraphicsStylePack | null
  /** Модели, которые можно поставить только на уже построенную крышу. */
  structuralAssets?: StructuralModelAssets | null
  /** Подгрузилась фактура: доске пора перерисоваться. */
  onTexture?: () => void
  /** Подмена загрузчика текстур в тестах. */
  loadTexture?: WallTextureLoader
}

/** Материалы крыш из пакета стиля; создаются по требованию и освобождаются с крышами. */
type RoofStyle = {
  /** Фактура по мировым координатам (фронтоны, верх стен, брус, своды). */
  look: (key: string, tint?: string) => THREE.Material
  /** Фактура по UV ската: ряды черепицы вдоль конька. */
  covering: (key: string) => THREE.Material
  repeat: (key: string) => { u: number; v: number }
}

const ROOF_REQUIRED_LOOKS = ['tiles', 'shingles', 'timber', 'stone'] as const

/** Есть ли в пакете всё, без чего крыши стиля не строятся. */
export function packHasRoofLooks(pack: GraphicsStylePack | null | undefined): pack is GraphicsStylePack {
  return Boolean(pack && ROOF_REQUIRED_LOOKS.every((key) => pack.walls[key] && pack.materials[pack.walls[key].material]))
}

export type Board3DRoofController = {
  group: THREE.Group
  setMode: (mode: Board3DRoofMode) => void
  getMode: () => Board3DRoofMode
  dispose: () => void
}

/** Высота карниза обычного полного этажа в мировых единицах. */
export const BOARD3D_FULL_WALL_HEIGHT = 1.8

type RoofResources = {
  geometries: Set<THREE.BufferGeometry>
  materials: Set<THREE.Material>
}

type RoofSide = 'north' | 'east' | 'south' | 'west'

type RoofRect = {
  zone: TacticalZone
  cells: TacticalCell[]
  /** Клетки, которые считаются «внутри»: комната или весь дом из нескольких комнат. */
  members: Set<string>
  minX: number
  minY: number
  maxX: number
  maxY: number
  sides: Set<RoofSide>
  /** Стороны, где за ребром лежит кольцо кладки: крыша накрывает и его. */
  ring: Set<RoofSide>
  baseY: number
}

const ROOF_OVERHANG = 0.12
const ROOF_THICKNESS = 0.09
const ROOF_EAVE_HEIGHT = 0.075
const ROOF_EAVE_WIDTH = 0.105
const ROOF_PITCH = 0.38
/**
 * Рисованная крыша круче: черепица Village рассчитана на скат около 30°, а
 * почти плоский скат читается сверху как ровный лист. Предел — чтобы крыша
 * большого зала не вырастала выше двух этажей.
 */
const PAINTED_ROOF_PITCH = 1.05
const PAINTED_ROOF_SLOPE = .3
const WOOD_ROOF_STRUCTURE_COLOR = '#594630'
const WOOD_ROOF_STRUCTURE_SIZE = 0.09
/** На сколько стропило опущено под верх ската: толщина кровли и половина бруса. */
const RAFTER_DROP = ROOF_THICKNESS + WOOD_ROOF_STRUCTURE_SIZE / 2 + .01
const ROOF_RIDGE_SIZE = 0.095
const VAULT_THICKNESS = 0.13
const VAULT_SEGMENTS = 12
const RIB_LIMIT = 7
const STRUCTURAL_EDGES = new Set(['wall', 'door', 'window', 'loophole', 'grate'])
const VAULT_WORDS = /crypt|склеп|крипт|гробниц|усыпальниц|катакомб|мавзоле|погреб|подвал|cellar|underground/iu
const NATURAL_CEILING_WORDS = /cave|пещер|грот|каверн|штольн|шахт|нора/iu

function ownGeometry(resources: RoofResources, geometry: THREE.BufferGeometry) {
  resources.geometries.add(geometry)
  return geometry
}

function ownMaterial(resources: RoofResources, material: THREE.Material) {
  resources.materials.add(material)
  return material
}

function roofMaterial(resources: RoofResources, color: string, options: THREE.MeshStandardMaterialParameters = {}) {
  return ownMaterial(resources, new THREE.MeshStandardMaterial({
    color,
    roughness: 0.9,
    metalness: 0.02,
    fog: true,
    ...options,
  }))
}

function createRoofStyle(pack: GraphicsStylePack, resources: RoofResources, options: Board3DRoofOptions): RoofStyle {
  const cache = new Map<string, THREE.Material>()
  const known = (key: string) => pack.walls[key] ? key : 'stone'
  const textureOptions = { onTexture: options.onTexture, loadTexture: options.loadTexture }
  return {
    look(key, tint = '#ffffff') {
      const id = `look:${known(key)}:${tint}`
      let material = cache.get(id)
      if (!material) {
        const created = createLookMaterial(pack, known(key), textureOptions)
        created.color.set(tint)
        material = ownMaterial(resources, created)
        cache.set(id, material)
      }
      return material
    },
    covering(key) {
      const id = `covering:${known(key)}`
      let material = cache.get(id)
      if (!material) {
        material = ownMaterial(resources, createUvLookMaterial(pack, known(key), textureOptions))
        cache.set(id, material)
      }
      return material
    },
    repeat: (key) => lookRepeat(pack, known(key)),
  }
}

function roofObject<T extends THREE.Object3D>(object: T): T {
  object.userData.board3dRoof = true
  object.userData.board3dPickable = false
  return object
}

function addMesh(
  resources: RoofResources,
  parent: THREE.Object3D,
  name: string,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: [number, number, number] = [0, 0, 0],
) {
  const object = roofObject(new THREE.Mesh(ownGeometry(resources, geometry), material))
  object.name = name
  object.position.set(...position)
  object.castShadow = true
  object.receiveShadow = true
  parent.add(object)
  return object
}

function addQuad(positions: number[], a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]) {
  positions.push(...a, ...b, ...c, ...a, ...c, ...d)
}

function addTriangle(positions: number[], a: [number, number, number], b: [number, number, number], c: [number, number, number]) {
  positions.push(...a, ...b, ...c)
}

function geometryFromPositions(positions: number[]) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  // Нулевые UV: материалам с картами атрибут нужен, даже если фактура ложится по миру.
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3 * 2), 2))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * Верхняя панель стены с наклонной верхней кромкой. Четыре промежуточные
 * точки по длине совпадают с полуклеточными изломами hip-сетки и не дают
 * плоскому коробу пересекать скат в одном конце и висеть в другом.
 */
function createUpperWallPanelGeometry(horizontal: boolean, bottom: number, topAt: (progress: number, across: number) => number) {
  const segments = 4
  const width = horizontal ? 1 : 1 / 6
  const depth = horizontal ? 1 / 6 : 1
  const geometry = new THREE.BoxGeometry(width, 1, depth, horizontal ? segments : 1, 1, horizontal ? 1 : segments)
  const position = geometry.getAttribute('position') as THREE.BufferAttribute
  for (let index = 0; index < position.count; index += 1) {
    const along = horizontal ? position.getX(index) : position.getZ(index)
    const across = horizontal ? position.getZ(index) : position.getX(index)
    const progress = Math.max(0, Math.min(1, along + .5))
    const top = topAt(progress, across)
    position.setY(index, position.getY(index) > 0 ? top : bottom)
  }
  // Верх панели закрыт кровлей: собственная крышка коробки здесь лишь
  // спорит с её треугольниками на стыках скатов и проступает белой полосой.
  const cap = geometry.groups.find((group) => group.materialIndex === 2)
  const indices = geometry.getIndex()
  if (cap && indices) {
    geometry.setIndex([...indices.array.slice(0, cap.start), ...indices.array.slice(cap.start + cap.count)])
    geometry.clearGroups()
  }
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * Замкнутая тонкая призма одного ската. Ось длины лежит вдоль локального X.
 * `covering` задаёт UV для черепицы: u — вдоль конька, v — от карниза вверх по
 * скату, в повторах фактуры; `across` кладёт доски вдоль ската.
 */
function createGableSlopeGeometry(length: number, span: number, rise: number, side: -1 | 1, thickness: number, covering?: { u: number; v: number; across?: boolean }) {
  const halfLength = length / 2
  const halfSpan = span / 2
  const edgeZ = side * halfSpan
  const ridgeZ = 0
  const edgeY = 0
  const ridgeY = rise
  const bottomEdgeY = edgeY - thickness
  const bottomRidgeY = ridgeY - thickness
  const x0 = -halfLength
  const x1 = halfLength
  const positions: number[] = []
  const edgeTop0: [number, number, number] = [x0, edgeY, edgeZ]
  const edgeTop1: [number, number, number] = [x1, edgeY, edgeZ]
  const ridgeTop0: [number, number, number] = [x0, ridgeY, ridgeZ]
  const ridgeTop1: [number, number, number] = [x1, ridgeY, ridgeZ]
  const edgeBottom0: [number, number, number] = [x0, bottomEdgeY, edgeZ]
  const edgeBottom1: [number, number, number] = [x1, bottomEdgeY, edgeZ]
  const ridgeBottom0: [number, number, number] = [x0, bottomRidgeY, ridgeZ]
  const ridgeBottom1: [number, number, number] = [x1, bottomRidgeY, ridgeZ]
  addQuad(positions, edgeTop0, edgeTop1, ridgeTop1, ridgeTop0)
  addQuad(positions, ridgeBottom0, ridgeBottom1, edgeBottom1, edgeBottom0)
  addQuad(positions, edgeTop0, ridgeTop0, ridgeBottom0, edgeBottom0)
  addQuad(positions, edgeTop1, edgeBottom1, ridgeBottom1, ridgeTop1)
  addQuad(positions, ridgeTop0, ridgeTop1, ridgeBottom1, ridgeBottom0)
  const geometry = geometryFromPositions(positions)
  if (covering) {
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute
    const slant = Math.hypot(halfSpan, rise) / Math.max(.001, halfSpan)
    for (let index = 0; index < uv.count; index += 1) {
      const along = positions[index * 3]
      const upSlope = Math.abs(positions[index * 3 + 2] - edgeZ) * slant
      if (covering.across) uv.setXY(index, upSlope / covering.u, along / covering.v)
      else uv.setXY(index, along / covering.u, upSlope / covering.v)
    }
  }
  return geometry
}

function createGableEndGeometry(span: number, rise: number, thickness: number) {
  const halfSpan = span / 2
  const positions: number[] = []
  for (const x of [-thickness / 2, thickness / 2]) {
    addTriangle(positions, [x, 0, -halfSpan], [x, 0, halfSpan], [x, rise, 0])
  }
  return geometryFromPositions(positions)
}

function addShingles(
  resources: RoofResources,
  parent: THREE.Object3D,
  length: number,
  span: number,
  rise: number,
  side: -1 | 1,
  material: THREE.Material,
) {
  const halfSpan = span / 2
  const rows = Math.max(2, Math.min(5, Math.round(span * 2)))
  const slopeAngle = Math.atan2(rise, halfSpan)
  const geometry = ownGeometry(resources, new THREE.BoxGeometry(Math.max(.25, length - .16), .026, .075))
  const shingles = roofObject(new THREE.Group())
  shingles.name = side < 0 ? 'roof-shingles:far' : 'roof-shingles:near'
  for (let row = 1; row <= rows; row += 1) {
    const progress = row / (rows + 1)
    const z = side < 0 ? -halfSpan + halfSpan * progress : halfSpan - halfSpan * progress
    const y = rise * progress
    const strip = roofObject(new THREE.Mesh(geometry, material))
    strip.name = `roof-shingle:${row}`
    strip.position.set((row % 2 ? -.025 : .025), y + .018, z)
    strip.rotation.x = side < 0 ? -slopeAngle : slopeAngle
    strip.castShadow = true
    strip.receiveShadow = true
    shingles.add(strip)
  }
  parent.add(shingles)
  return shingles
}

/** Узкие стропила остаются видимыми в срезе, когда сплошные скаты скрыты. */
function addRafters(
  resources: RoofResources,
  parent: THREE.Object3D,
  length: number,
  span: number,
  rise: number,
  material: THREE.Material,
) {
  const halfSpan = span / 2
  const slopeAngle = Math.atan2(rise, halfSpan)
  const beamLength = Math.hypot(halfSpan, rise)
  const positions = Math.max(2, Math.min(5, Math.floor(length / 2)))
  const geometry = ownGeometry(resources, new THREE.BoxGeometry(WOOD_ROOF_STRUCTURE_SIZE, WOOD_ROOF_STRUCTURE_SIZE, beamLength))
  for (const side of [-1, 1] as const) {
    const group = roofObject(new THREE.Group())
    group.name = side < 0 ? 'roof-rafters:far' : 'roof-rafters:near'
    for (let index = 0; index < positions; index += 1) {
      const along = positions === 1 ? 0 : (index / (positions - 1) - .5) * (length - .18)
      const beam = roofObject(new THREE.Mesh(geometry, material))
      beam.name = `roof-rafter:${side < 0 ? 'far' : 'near'}:${index}`
      // Стропило под кровлей, а не поверх: иначе брус проступал полосами сквозь скат.
      beam.position.set(along, rise / 2 - RAFTER_DROP, side * halfSpan / 2)
      beam.rotation.x = side < 0 ? -slopeAngle : slopeAngle
      beam.castShadow = true
      beam.receiveShadow = true
      group.add(beam)
    }
    parent.add(group)
  }
}

function addUpperWallPanels(
  resources: RoofResources,
  parent: THREE.Group,
  map: TacticalMap,
  rect: RoofRect,
  palette: BoardPalette,
  cutWallHeight: number,
  fullWallHeight: number,
  seenEdges: Set<string>,
  style: RoofStyle | null,
  edges = structuralEdges(map, rect),
  roof: RoofSurface | null = null,
  roofBaseY: number | null = null,
) {
  const color = ['wood', 'earth'].includes(rect.zone.material) ? palette.prop : palette.wall
  const plainMaterial = style ? null : roofMaterial(resources, color, { roughness: .94 })
  for (const edge of edges) {
    // Стиль продолжает кладку срезанной стены вверх той же фактурой: рисунок
    // по мировым координатам сходится на линии среза без шва.
    let panelMaterial = plainMaterial
    let fachwerk = false
    if (style) {
      const look = wallLookFor(map, edgeSideCell(map, edge))
      panelMaterial = style.look(look.kind === 'palisade' ? 'planks' : look.body, look.tint)
      fachwerk = look.kind === 'fachwerk'
    }
    const key = `${edge.x},${edge.y},${edge.dir}`
    if (seenEdges.has(key)) continue
    seenEdges.add(key)
    const horizontal = edge.dir === 's'
    const centerX = edge.dir === 'e' ? edge.x + 1 : edge.x + .5
    const centerZ = edge.dir === 'e' ? edge.y + .5 : edge.y + 1
    const wallBaseY = edgeBaseY(map, edge)
    const roofOriginY = roofBaseY ?? wallBaseY
    // Небольшой заход под кровлю убирает борьбу совпадающих поверхностей:
    // иначе белая верхняя грань кладки мерцает поверх однослойной вальмы.
    const wallTopAt = (x: number, z: number) => Math.max(cutWallHeight,
      roofOriginY + fullWallHeight + (roof ? roof.heightAt(x, z) - roof.skinThickness - .003 : 0) - wallBaseY)
    const start = horizontal
      ? { x: edge.x, z: edge.y + 1 }
      : { x: edge.x + 1, z: edge.y }
    const end = horizontal
      ? { x: edge.x + 1, z: edge.y + 1 }
      : { x: edge.x + 1, z: edge.y + 1 }
    const topAt = (progress: number, across: number) => wallTopAt(
      start.x + (end.x - start.x) * progress + (horizontal ? 0 : across),
      start.z + (end.z - start.z) * progress + (horizontal ? across : 0),
    )
    const topSamples = [0, .25, .5, .75, 1].flatMap((progress) => [topAt(progress, -1 / 12), topAt(progress, 1 / 12)])
    const height = Math.max(...topSamples) - cutWallHeight
    if (height <= 0) continue
    const geometry = createUpperWallPanelGeometry(horizontal, cutWallHeight, topAt)
    addMesh(resources, parent, `roof-wall-upper:${edge.x},${edge.y},${edge.dir}`, geometry, panelMaterial!, [centerX, wallBaseY, centerZ])
    if (fachwerk && style) {
      const timberHeight = Math.max(0, Math.min(...topSamples) - cutWallHeight)
      if (timberHeight > 0) addFachwerkTimbers(resources, parent, edge, style.look('timber'), wallBaseY + cutWallHeight, timberHeight, seenEdges)
    }
  }
}

/**
 * Брус фахверка на верхнем этаже: пояс по линии среза, обвязка под карнизом,
 * стойки на стыках и раскос с обеих сторон — тот же рисунок, что у срезанной стены.
 */
function addFachwerkTimbers(
  resources: RoofResources,
  parent: THREE.Group,
  edge: ReturnType<typeof edgeList>[number],
  material: THREE.Material,
  bottom: number,
  height: number,
  seen: Set<string>,
) {
  const horizontal = edge.dir === 's'
  const centerX = edge.dir === 'e' ? edge.x + 1 : edge.x + .5
  const centerZ = edge.dir === 'e' ? edge.y + .5 : edge.y + 1
  const depth = 1 / 6 + .03
  const beam = (y: number, tall: number) => horizontal ? new THREE.BoxGeometry(1, tall, depth) : new THREE.BoxGeometry(depth, tall, 1)
  addMesh(resources, parent, 'roof-wall-timber:belt', beam(.08, .08), material, [centerX, bottom + .04, centerZ])
  addMesh(resources, parent, 'roof-wall-timber:plate', beam(.09, .09), material, [centerX, bottom + height - .045, centerZ])
  const ends = horizontal ? [[edge.x, centerZ], [edge.x + 1, centerZ]] : [[centerX, edge.y], [centerX, edge.y + 1]]
  for (const [x, z] of ends) {
    const key = `post:${x},${z}`
    if (seen.has(key)) continue
    seen.add(key)
    addMesh(resources, parent, 'roof-wall-timber:post', new THREE.BoxGeometry(.12, height, .12 + 1 / 6), material, [x, bottom + height / 2, z])
  }
  const rise = height - .17, run = .88
  const length = Math.hypot(rise, run)
  const angle = Math.atan2(rise, run) * ((edge.x + edge.y) % 2 ? 1 : -1)
  for (const side of [-1, 1]) {
    const offset = side * (1 / 12 + .012)
    const brace = addMesh(resources, parent, 'roof-wall-timber:brace',
      horizontal ? new THREE.BoxGeometry(length, .07, .03) : new THREE.BoxGeometry(.03, .07, length), material,
      [centerX + (horizontal ? 0 : offset), bottom + .08 + rise / 2, centerZ + (horizontal ? offset : 0)])
    if (horizontal) brace.rotation.z = angle
    else brace.rotation.x = -angle
  }
}

function createVaultShellGeometry(length: number, span: number, thickness: number, segments = VAULT_SEGMENTS) {
  const radius = span / 2
  const innerRadius = Math.max(.08, radius - thickness)
  const positions: number[] = []
  const x0 = -length / 2
  const x1 = length / 2
  const point = (x: number, r: number, angle: number): [number, number, number] => [x, Math.sin(angle) * r, -Math.cos(angle) * r]
  for (let index = 0; index < segments; index += 1) {
    const a = Math.PI * index / segments
    const b = Math.PI * (index + 1) / segments
    addQuad(positions, point(x0, radius, a), point(x1, radius, a), point(x1, radius, b), point(x0, radius, b))
    addQuad(positions, point(x0, innerRadius, b), point(x1, innerRadius, b), point(x1, innerRadius, a), point(x0, innerRadius, a))
    addQuad(positions, point(x0, radius, a), point(x0, radius, b), point(x0, innerRadius, b), point(x0, innerRadius, a))
    addQuad(positions, point(x1, radius, b), point(x1, radius, a), point(x1, innerRadius, a), point(x1, innerRadius, b))
  }
  return geometryFromPositions(positions)
}

function createVaultRibGeometry(span: number, width: number, thickness = .10, segments = VAULT_SEGMENTS) {
  const outer = span / 2 + thickness
  const inner = Math.max(.08, span / 2 - thickness)
  const positions: number[] = []
  const x0 = -width / 2
  const x1 = width / 2
  const point = (x: number, radius: number, angle: number): [number, number, number] => [x, Math.sin(angle) * radius, -Math.cos(angle) * radius]
  for (let index = 0; index < segments; index += 1) {
    const a = Math.PI * index / segments
    const b = Math.PI * (index + 1) / segments
    addQuad(positions, point(x0, outer, a), point(x1, outer, a), point(x1, outer, b), point(x0, outer, b))
    addQuad(positions, point(x0, inner, b), point(x1, inner, b), point(x1, inner, a), point(x0, inner, a))
    addQuad(positions, point(x0, outer, a), point(x0, outer, b), point(x0, inner, b), point(x0, inner, a))
    addQuad(positions, point(x1, outer, b), point(x1, outer, a), point(x1, inner, a), point(x1, inner, b))
  }
  return geometryFromPositions(positions)
}

function isInsideRect(cell: TacticalCell | null, rect: RoofRect) {
  return Boolean(cell?.passable && rect.members.has(cellKey(cell.x, cell.y))
    && cell.x >= rect.minX && cell.x <= rect.maxX && cell.y >= rect.minY && cell.y <= rect.maxY)
}

function sideForEdge(edge: ReturnType<typeof edgeList>[number], rect: RoofRect, map: TacticalMap): RoofSide | null {
  if (!STRUCTURAL_EDGES.has(edge.kind)) return null
  const owner = cellAt(map, edge.x, edge.y)
  const neighbor = edgeNeighbor(edge)
  const other = cellAt(map, neighbor.x, neighbor.y)
  const ownerInside = isInsideRect(owner, rect)
  const otherInside = isInsideRect(other, rect)
  if (ownerInside === otherInside) return null
  const line = edge.dir === 'e' ? edge.x + 1 : edge.y + 1
  if (edge.dir === 'e') return line <= rect.minX ? 'west' : line >= rect.maxX + 1 ? 'east' : null
  return line <= rect.minY ? 'north' : line >= rect.maxY + 1 ? 'south' : null
}

/**
 * Что лежит за ребром снаружи прямоугольника: `ring` — непроходимая кладка
 * старой толстой стены, `thin` — тонкая наружная стена на ребре, за которой
 * двор или улица, `null` — перегородка между двумя комнатами.
 */
function outerWallKind(map: TacticalMap, edge: ReturnType<typeof edgeList>[number], rect: RoofRect): 'ring' | 'thin' | null {
  const owner = cellAt(map, edge.x, edge.y)
  const neighbor = edgeNeighbor(edge)
  const other = cellAt(map, neighbor.x, neighbor.y)
  const outside = isInsideRect(owner, rect) ? other : owner
  if (outside?.passable !== true) return 'ring'
  const zone = map.zones.find((entry) => entry.id === outside.zone)
  return zone?.kind === 'interior' ? null : 'thin'
}

function structuralSides(map: TacticalMap, rect: RoofRect) {
  const sides = new Set<RoofSide>()
  const ring = new Set<RoofSide>()
  for (const edge of edgeList(map)) {
    const side = sideForEdge(edge, rect, map)
    if (!side || !(revealedAt(map, edge.x, edge.y) || revealedAt(map, edgeNeighbor(edge).x, edgeNeighbor(edge).y))) continue
    // Карниз выносится на кольцо непроходимых стен; тонкая наружная стена
    // даёт карниз без выноса, а перегородка между комнатами — ничего.
    const kind = outerWallKind(map, edge, rect)
    if (!kind) continue
    sides.add(side)
    if (kind === 'ring') ring.add(side)
  }
  return { sides, ring }
}

function edgeBaseY(map: TacticalMap, edge: ReturnType<typeof edgeList>[number]) {
  const neighbor = edgeNeighbor(edge)
  const heights = [[edge.x, edge.y], [neighbor.x, neighbor.y]]
    .filter(([x, y]) => revealedAt(map, x, y))
    .map(([x, y]) => terrainHeightAt(map, x, y))
    .filter(Number.isFinite)
  return heights.length ? Math.max(...heights) : 0
}

function structuralEdges(map: TacticalMap, rect: RoofRect) {
  const result: Array<ReturnType<typeof edgeList>[number]> = []
  const seen = new Set<string>()
  for (const edge of edgeList(map)) {
    const side = sideForEdge(edge, rect, map)
    if (!side || seen.has(`${edge.x},${edge.y},${edge.dir}`)) continue
    if (!(revealedAt(map, edge.x, edge.y) || revealedAt(map, edgeNeighbor(edge).x, edgeNeighbor(edge).y))) continue
    if (!outerWallKind(map, edge, rect)) continue
    seen.add(`${edge.x},${edge.y},${edge.dir}`)
    result.push(edge)
  }
  return result
}

/** Крыша закрывает наружное кольцо стен, но не протекает в соседнюю комнату. */
function roofBounds(rect: RoofRect) {
  return {
    minX: rect.minX - (rect.ring.has('west') ? 1 : 0),
    minY: rect.minY - (rect.ring.has('north') ? 1 : 0),
    maxX: rect.maxX + (rect.ring.has('east') ? 1 : 0),
    maxY: rect.maxY + (rect.ring.has('south') ? 1 : 0),
  }
}

function mergeRuns(cells: TacticalCell[]) {
  const byRow = new Map<number, number[]>()
  for (const cell of cells) byRow.set(cell.y, [...(byRow.get(cell.y) ?? []), cell.x])
  const runs: Array<{ y: number; minX: number; maxX: number }> = []
  for (const y of [...byRow.keys()].sort((a, b) => a - b)) {
    const xs = [...new Set(byRow.get(y))].sort((a, b) => a - b)
    if (!xs.length) continue
    let minX = xs[0]
    let previous = xs[0]
    for (let index = 1; index <= xs.length; index += 1) {
      const current = xs[index]
      if (current !== previous + 1) {
        runs.push({ y, minX, maxX: previous })
        minX = current
      }
      previous = current
    }
  }
  const rectangles: Array<{ minX: number; minY: number; maxX: number; maxY: number; cells: TacticalCell[] }> = []
  for (const run of runs) {
    const previous = rectangles.at(-1)
    if (previous && previous.maxY === run.y - 1 && previous.minX === run.minX && previous.maxX === run.maxX) {
      previous.maxY = run.y
      previous.cells.push(...cells.filter((cell) => cell.y === run.y && cell.x >= run.minX && cell.x <= run.maxX))
    } else {
      rectangles.push({ minX: run.minX, minY: run.y, maxX: run.maxX, maxY: run.y, cells: cells.filter((cell) => cell.y === run.y && cell.x >= run.minX && cell.x <= run.maxX) })
    }
  }
  return rectangles
}

function roofIsVaulted(map: TacticalMap, zone: TacticalZone) {
  const haystack = `${map.theme} ${map.locationId} ${map.levelLabel} ${zone.id} ${zone.label}`
  return map.levelIndex < 0 || VAULT_WORDS.test(haystack)
}

function roofStyle(map: TacticalMap, zone: TacticalZone) {
  const haystack = `${map.theme} ${map.locationId} ${map.levelLabel} ${zone.id} ${zone.label}`
  if (NATURAL_CEILING_WORDS.test(haystack) && !VAULT_WORDS.test(haystack)) return null
  return roofIsVaulted(map, zone) ? 'vault' : 'gable'
}

function roofColors(palette: BoardPalette, zone: TacticalZone, vaulted: boolean) {
  const stone = vaulted || ['stone', 'marble', 'metal'].includes(zone.material)
  return {
    shell: vaulted ? '#73746d' : stone ? palette.wall : palette.prop,
    trim: vaulted ? '#a09e91' : stone ? palette.ledge : palette.propAccent,
  }
}

/**
 * Вид дома под крышей: срубу — доски, остальным — черепица; фронтон — кладкой
 * стен этого дома. Материал стены берётся по зоне, а не по полу клетки.
 */
function roofLooks(map: TacticalMap, rect: RoofRect) {
  const look = wallLookFor(map, { ...rect.cells[0], material: rect.zone.material })
  const wooden = look.kind === 'planks' || look.kind === 'palisade'
  return { covering: wooden ? 'shingles' : 'tiles', gable: look.kind === 'palisade' ? 'planks' : look.body, tint: look.tint }
}

/**
 * Готовая кровля дома: её считает сама крыша, а детали на ней (труба,
 * слуховое окно) спрашивают высоту, а не выводят скат заново.
 */
type RoofSurface = {
  /** Высота кровли над карнизом в точке плана, в клетках. */
  heightAt: (x: number, z: number) => number
  /** Подъём ската на клетку по горизонтали. */
  slope: number
  /** Толщина оболочки между верхом кровли и её нижней стороной. */
  skinThickness: number
  /** Место слухового окна у двускатной крыши: середина ближнего ската. */
  dormer?: { x: number; z: number; yaw: number }
}

function addPitchedRoof(
  resources: RoofResources,
  shellGroup: THREE.Group,
  structureGroup: THREE.Group,
  rect: RoofRect,
  palette: BoardPalette,
  eaveHeight: number,
  map: TacticalMap,
  style: RoofStyle | null,
  inferred = false,
) {
  if (!rect.sides.size) return false
  const bounds = roofBounds(rect)
  const centerX = (bounds.minX + bounds.maxX + 1) / 2
  const centerZ = (bounds.minY + bounds.maxY + 1) / 2
  const rawWidth = bounds.maxX - bounds.minX + 1
  const rawDepth = bounds.maxY - bounds.minY + 1
  // Конёк — вдоль длинной стороны дома; у квадратного — по направлению пола.
  const ridgeAlongX = rawWidth === rawDepth ? rect.zone.floorDirection === 'horizontal' : rawWidth > rawDepth
  const length = (ridgeAlongX ? rawWidth : rawDepth) + ROOF_OVERHANG * 2
  const span = (ridgeAlongX ? rawDepth : rawWidth) + ROOF_OVERHANG * 2
  const rise = style
    ? Math.min(PAINTED_ROOF_PITCH, Math.max(.3, span * PAINTED_ROOF_SLOPE))
    : Math.min(ROOF_PITCH, Math.max(.18, span * .2))
  const colors = roofColors(palette, rect.zone, false)
  const piece = roofObject(new THREE.Group())
  piece.name = `roof-pitched:${rect.zone.id}:${rect.minX},${rect.minY},${rect.maxX},${rect.maxY}`
  piece.position.set(centerX, rect.baseY + eaveHeight, centerZ)
  if (!ridgeAlongX) piece.rotation.y = Math.PI / 2
  const far = roofObject(new THREE.Group())
  far.name = 'roof-shell:far'
  const near = roofObject(new THREE.Group())
  near.name = 'roof-shell:near'
  const looks = style ? roofLooks(map, rect) : null
  const shellMaterial = style && looks ? style.covering(looks.covering) : roofMaterial(resources, colors.shell)
  const trimMaterial = style ? style.look('timber') : roofMaterial(resources, colors.trim, { roughness: .82 })
  const gableMaterial = style && looks ? style.look(looks.gable, looks.tint) : trimMaterial
  const roofStructureMaterial = style
    ? trimMaterial
    : ['wood', 'earth'].includes(rect.zone.material)
      ? roofMaterial(resources, WOOD_ROOF_STRUCTURE_COLOR, { roughness: .95 })
      : trimMaterial
  // Черепица ложится рядами вдоль конька, доски — вдоль ската.
  const covering = style && looks ? { ...style.repeat(looks.covering), across: looks.covering === 'shingles' } : undefined
  addMesh(resources, far, 'roof-slope:far', createGableSlopeGeometry(length, span, rise, -1, ROOF_THICKNESS, covering), shellMaterial)
  addMesh(resources, near, 'roof-slope:near', createGableSlopeGeometry(length, span, rise, 1, ROOF_THICKNESS, covering), shellMaterial)
  // Полосы гонта нужны только однотонной крыше: у стиля ряды нарисованы фактурой.
  if (!style) {
    addShingles(resources, far, length, span, rise, -1, trimMaterial)
    addShingles(resources, near, length, span, rise, 1, trimMaterial)
  }
  far.userData.board3dRoof = true
  near.userData.board3dRoof = true
  piece.add(far, near)
  shellGroup.add(piece)

  const structural = roofObject(new THREE.Group())
  structural.name = piece.name.replace('roof-pitched', 'roof-structure')
  if (inferred) structural.userData.board3dInferredRoof = true
  structural.position.copy(piece.position)
  const eaveGeometry = ownGeometry(resources, new THREE.BoxGeometry(length, ROOF_EAVE_HEIGHT, ROOF_EAVE_WIDTH))
  const farSide: RoofSide = ridgeAlongX ? 'north' : 'west'
  const nearSide: RoofSide = ridgeAlongX ? 'south' : 'east'
  if (rect.sides.has(farSide)) addMesh(resources, structural, 'roof-eave:far', eaveGeometry, trimMaterial, [0, -.025, -span / 2])
  if (rect.sides.has(nearSide)) addMesh(resources, structural, 'roof-eave:near', eaveGeometry.clone(), trimMaterial, [0, -.025, span / 2])
  addRafters(resources, structural, length, span, rise, roofStructureMaterial)
  const ridgeGeometry = ownGeometry(resources, new THREE.BoxGeometry(length + .14, ROOF_RIDGE_SIZE, ROOF_RIDGE_SIZE))
  addMesh(resources, structural, 'roof-ridge', ridgeGeometry, roofStructureMaterial, [0, rise + .035, 0])
  const endGeometry = ownGeometry(resources, createGableEndGeometry(span, rise, .045))
  const endWest = addMesh(resources, structural, 'roof-gable:end-west', endGeometry, gableMaterial, [-length / 2, 0, 0])
  const endEast = addMesh(resources, structural, 'roof-gable:end-east', endGeometry.clone(), gableMaterial, [length / 2, 0, 0])
  endWest.userData.board3dOpaqueRoof = true
  endEast.userData.board3dOpaqueRoof = true
  if (!ridgeAlongX) structural.rotation.y = Math.PI / 2
  structureGroup.add(structural)
  const half = span / 2
  const surface: RoofSurface = {
    heightAt: (x, z) => Math.max(0, rise * (1 - Math.abs(ridgeAlongX ? z - centerZ : x - centerX) / half)),
    slope: rise / half,
    skinThickness: ROOF_THICKNESS,
    // Окно смотрит на ближний скат; сдвиг от края держит модель внутри крыши.
    dormer: ridgeAlongX
      ? { x: centerX, z: bounds.maxY + .08, yaw: 0 }
      : { x: bounds.maxX + .08, z: centerZ, yaw: Math.PI / 2 },
  }
  return surface
}

function addVaultRoof(
  resources: RoofResources,
  shellGroup: THREE.Group,
  structureGroup: THREE.Group,
  rect: RoofRect,
  palette: BoardPalette,
  eaveHeight: number,
  style: RoofStyle | null,
) {
  if (!rect.sides.size) return false
  const bounds = roofBounds(rect)
  const centerX = (bounds.minX + bounds.maxX + 1) / 2
  const centerZ = (bounds.minY + bounds.maxY + 1) / 2
  const rawWidth = bounds.maxX - bounds.minX + 1
  const rawDepth = bounds.maxY - bounds.minY + 1
  const axisX = rawWidth >= rawDepth
  const length = (axisX ? rawWidth : rawDepth) + ROOF_OVERHANG * 2
  const span = (axisX ? rawDepth : rawWidth) + ROOF_OVERHANG * 2
  const colors = roofColors(palette, rect.zone, true)
  const piece = roofObject(new THREE.Group())
  piece.name = `roof-vault:${rect.zone.id}:${rect.minX},${rect.minY},${rect.maxX},${rect.maxY}`
  piece.userData.board3dVault = true
  piece.position.set(centerX, rect.baseY + eaveHeight, centerZ)
  if (!axisX) piece.rotation.y = Math.PI / 2
  // Свод склепа — тёсаные блоки, рёбра и пяты — неровный камень.
  const shellMaterial = style ? style.look('fortress') : roofMaterial(resources, colors.shell, { roughness: .96 })
  const trimMaterial = style ? style.look('stone') : roofMaterial(resources, colors.trim, { roughness: .78 })
  addMesh(resources, piece, 'vault-shell', createVaultShellGeometry(length, span, VAULT_THICKNESS), shellMaterial)
  shellGroup.add(piece)

  const structural = roofObject(new THREE.Group())
  structural.name = piece.name.replace('roof-vault', 'roof-structure')
  structural.position.copy(piece.position)
  const ribs = Math.max(2, Math.min(RIB_LIMIT, Math.floor(length / 2)))
  const ribGeometry = ownGeometry(resources, createVaultRibGeometry(span, .13))
  for (let index = 0; index < ribs; index += 1) {
    const progress = ribs === 1 ? .5 : index / (ribs - 1)
    const rib = addMesh(resources, structural, `vault-rib:${index}`, ribGeometry, trimMaterial, [(progress - .5) * length, 0, 0])
    rib.userData.board3dRoofInterior = index > 0 && index < ribs - 1
  }
  const edgeGeometry = ownGeometry(resources, new THREE.BoxGeometry(length, ROOF_EAVE_HEIGHT, ROOF_EAVE_WIDTH))
  const farSide: RoofSide = axisX ? 'north' : 'west'
  const nearSide: RoofSide = axisX ? 'south' : 'east'
  if (rect.sides.has(farSide)) addMesh(resources, structural, 'vault-eave:far', edgeGeometry, trimMaterial, [0, -.025, -span / 2])
  if (rect.sides.has(nearSide)) addMesh(resources, structural, 'vault-eave:near', edgeGeometry.clone(), trimMaterial, [0, -.025, span / 2])
  if (!axisX) structural.rotation.y = Math.PI / 2
  structureGroup.add(structural)
  return true
}

function buildRoofRects(map: TacticalMap) {
  const result: RoofRect[] = []
  for (const zone of map.zones.filter((entry) => entry.kind === 'interior')) {
    const cells: TacticalCell[] = []
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell?.revealed && cell.passable && cell.zone === zone.id) cells.push(cell)
    }
    for (const rect of mergeRuns(cells)) {
      const candidate: RoofRect = {
        zone,
        cells: rect.cells,
        members: new Set(rect.cells.map((cell) => cellKey(cell.x, cell.y))),
        minX: rect.minX,
        minY: rect.minY,
        maxX: rect.maxX,
        maxY: rect.maxY,
        sides: new Set(),
        ring: new Set(),
        baseY: Math.max(...rect.cells.map((cell) => terrainHeightAt(map, cell.x, cell.y))),
      }
      const outline = structuralSides(map, candidate)
      candidate.sides = outline.sides
      candidate.ring = outline.ring
      // Без канонического рёберного контура это просто открытая площадка, а
      // не здание. Так крыша не появляется на случайном прямоугольнике пола.
      if (candidate.sides.size) result.push(candidate)
    }
  }
  return result
}

/**
 * Нераскрытые помещения: связные области нераскрытых клеток, со всех сторон
 * закрытые стенами, дверями, окнами или кладкой. Их пол игроку не виден, и
 * прежде на их месте в 3D зиял чёрный провал (этап 5
 * `docs/map-generation-plan.md`). Сюда идёт только то, что проекция и так
 * отдаёт игроку снаружи, — рёбра стен и форма клеток; область, открытая в
 * туман улицы, крышки не получает, чтобы не выдать, где стоит постройка.
 */
export function closedUnrevealedRegions(map: TacticalMap): TacticalCell[][] {
  const regions: TacticalCell[][] = []
  const seen = new Set<string>()
  const hidden = (x: number, y: number) => {
    const cell = cellAt(map, x, y)
    return Boolean(cell && !cell.revealed && cell.passable)
  }
  const border = (x: number, y: number) => x <= 0 || y <= 0 || x >= map.width - 1 || y >= map.height - 1
  const walls = new Set<string>()
  for (const edge of edgeList(map)) {
    if (!STRUCTURAL_EDGES.has(edge.kind)) continue
    const other = edgeNeighbor(edge)
    walls.add(`${edge.x},${edge.y}|${other.x},${other.y}`)
    walls.add(`${other.x},${other.y}|${edge.x},${edge.y}`)
  }
  const structural = (x: number, y: number, nx: number, ny: number) => walls.has(`${x},${y}|${nx},${ny}`)
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    if (seen.has(`${x},${y}`) || !hidden(x, y)) continue
    const queue: Array<{ x: number; y: number }> = [{ x, y }]
    seen.add(`${x},${y}`)
    let closed = true
    let walled = false
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = current.x + dx
        const ny = current.y + dy
        const neighbor = cellAt(map, nx, ny)
        if (!neighbor) { closed = false; continue }
        const wall = structural(current.x, current.y, nx, ny)
        if (wall) { walled = true; continue }
        if (hidden(nx, ny)) {
          if (!seen.has(`${nx},${ny}`)) {
            seen.add(`${nx},${ny}`)
            queue.push({ x: nx, y: ny })
          }
          continue
        }
        // Глухая клетка — кладка вокруг комнаты, но скала у края карты —
        // это туман за околицей, а не стена дома. Раскрытая проходимая без
        // стены между — область открыта в видимый мир.
        if (neighbor.passable) closed = false
        else if (!neighbor.revealed && border(nx, ny)) closed = false
        else walled = true
      }
    }
    if (closed && walled) regions.push(queue.map((point) => cellAt(map, point.x, point.y)).filter((cell): cell is TacticalCell => Boolean(cell)))
  }
  return regions
}

type RoofBuilding = {
  /** Прямоугольный дом — двускатная крыша на весь дом. */
  rect: RoofRect | null
  /** Дом сложной формы — вальма по клеткам дома вместе с кольцом толстой кладки. */
  footprint: Set<string>
  cells: TacticalCell[]
  zone: TacticalZone
  baseY: number
  /** Есть клетки, раскрытые только наружным контуром; детали скрыты в cutaway. */
  inferred?: boolean
}

/**
 * Наружный контур дома может быть открыт раньше пола: игрок видит двор и
 * фасад, а клетки комнат всё ещё в тумане. В этом случае цельная крыша дома
 * разрешена, но соседнее нераскрытое здание остаётся без оболочки.
 */
function exteriorDiscovered(map: TacticalMap, cells: TacticalCell[]) {
  const zoneKinds = new Map(map.zones.map((zone) => [zone.id, zone.kind]))
  const members = new Set(cells.map((cell) => cellKey(cell.x, cell.y)))
  const exterior = (cell: TacticalCell | null) => cell?.revealed && zoneKinds.get(cell.zone) === 'exterior'
  for (const cell of cells) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const neighbor = cellAt(map, cell.x + dx, cell.y + dy)
      if (members.has(cellKey(cell.x + dx, cell.y + dy))) continue
      if (exterior(neighbor)) return true
      // Импортированные карты иногда держат фасад отдельной непроходимой
      // клеткой. Один дополнительный шаг на улицу сохраняет ту же границу.
      if (!neighbor?.revealed || neighbor.passable) continue
      for (const [ddx, ddy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (exterior(cellAt(map, cell.x + dx + ddx, cell.y + dy + ddy))) return true
      }
    }
  }
  return false
}

function hiddenPassableComponents(map: TacticalMap) {
  const candidates = new Map<string, TacticalCell>()
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (cell?.passable && !cell.revealed) candidates.set(cellKey(x, y), cell)
  }
  const result: TacticalCell[][] = []
  const visited = new Set<string>()
  for (const [start, first] of candidates) {
    if (visited.has(start)) continue
    const cells: TacticalCell[] = [], queue = [first]
    visited.add(start)
    while (queue.length) {
      const cell = queue.pop()!
      cells.push(cell)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const key = cellKey(cell.x + dx, cell.y + dy)
        const next = candidates.get(key)
        if (next && !visited.has(key)) { visited.add(key); queue.push(next) }
      }
    }
    result.push(cells)
  }
  return result
}

function structuralBoundary(map: TacticalMap, first: TacticalCell, second: TacticalCell) {
  const edge = edgeBetween(map, first.x, first.y, second.x, second.y)
  return Boolean(edge && STRUCTURAL_EDGES.has(edge.kind))
}

function touchesCells(map: TacticalMap, cells: TacticalCell[], targets: Set<string>) {
  for (const cell of cells) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const neighbor = cellAt(map, cell.x + dx, cell.y + dy)
    if (neighbor && targets.has(cellKey(neighbor.x, neighbor.y)) && structuralBoundary(map, cell, neighbor)) return true
  }
  return false
}

/**
 * Дома для скатных крыш: связные области комнат, чьи фасады уже обнаружены
 * или чьи полы раскрыты. Комнаты одного дома за перегородками — одна крыша,
 * а не лоскуты по комнатам; своды склепов и пещеры сюда не входят.
 */
function buildRoofBuildings(map: TacticalMap) {
  const zoneById = new Map(map.zones.map((zone) => [zone.id, zone]))
  const hiddenFallbackZone: TacticalZone = {
    id: '__revealed-building-shell', kind: 'interior', material: 'stone', lightLevel: 'dim',
    floorDirection: 'horizontal', label: '',
  }
  zoneById.set(hiddenFallbackZone.id, hiddenFallbackZone)
  const candidates = new Map<string, TacticalCell>()
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    const zone = cell?.passable ? zoneById.get(cell.zone ?? '') : undefined
    if (cell && zone?.kind === 'interior' && roofStyle(map, zone) === 'gable') candidates.set(cellKey(x, y), cell)
  }
  const hiddenComponents = hiddenPassableComponents(map)
  const pitched = new Map<string, TacticalCell>()
  const inferred = new Set<string>()
  const discovered = new Set<string>()
  for (const [start, first] of candidates) {
    if (discovered.has(start)) continue
    const cells: TacticalCell[] = []
    const queue = [first]
    discovered.add(start)
    while (queue.length) {
      const cell = queue.pop()!
      cells.push(cell)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const key = cellKey(cell.x + dx, cell.y + dy)
        const next = candidates.get(key)
        if (next && !discovered.has(key)) { discovered.add(key); queue.push(next) }
      }
    }
    const allExterior = exteriorDiscovered(map, cells)
    for (const cell of (allExterior ? cells : cells.filter((entry) => entry.revealed))) pitched.set(cellKey(cell.x, cell.y), cell)
    if (!allExterior) continue
    const members = new Set(cells.map((cell) => cellKey(cell.x, cell.y)))
    const zone = [...new Set(cells.map((cell) => cell.zone).filter(Boolean))]
      .map((id) => zoneById.get(id))
      .find((entry): entry is TacticalZone => Boolean(entry))
    if (!zone) continue
    for (const hidden of hiddenComponents) {
      if (!touchesCells(map, hidden, members)) continue
      for (const cell of hidden) {
        const inferredCell = cell.zone ? cell : { ...cell, zone: zone.id }
        pitched.set(cellKey(cell.x, cell.y), inferredCell)
        inferred.add(cellKey(cell.x, cell.y))
      }
    }
  }
  // A room may be completely hidden while its outside wall is already visible.
  // This path is available when the authoritative/admin map still carries its
  // zone; public maps use the discovered visible-room path above.
  for (const hidden of hiddenComponents) {
    if (!hidden.length || hidden.some((cell) => pitched.has(cellKey(cell.x, cell.y)))) continue
    if (!exteriorDiscovered(map, hidden)) continue
    const zone = [...new Set(hidden.map((cell) => cell.zone).filter(Boolean))]
      .map((id) => zoneById.get(id))
      .find((entry): entry is TacticalZone => Boolean(entry && entry.kind === 'interior' && roofStyle(map, entry) === 'gable'))
      ?? (exteriorDiscovered(map, hidden) ? hiddenFallbackZone : null)
    if (!zone) continue
    for (const cell of hidden) {
      const inferredCell = cell.zone ? cell : { ...cell, zone: zone.id }
      pitched.set(cellKey(cell.x, cell.y), inferredCell)
      inferred.add(cellKey(cell.x, cell.y))
    }
  }
  const solid = (x: number, y: number) => {
    const cell = cellAt(map, x, y)
    return Boolean(cell && !cell.passable && cell.surface !== 'water')
  }
  const buildings: RoofBuilding[] = []
  const visited = new Set<string>()
  for (const [start, first] of pitched) {
    if (visited.has(start)) continue
    const cells: TacticalCell[] = []
    const queue = [first]
    visited.add(start)
    while (queue.length) {
      const cell = queue.pop()!
      cells.push(cell)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const key = cellKey(cell.x + dx, cell.y + dy)
        const next = pitched.get(key)
        if (next && !visited.has(key)) { visited.add(key); queue.push(next) }
      }
    }
    const members = new Set(cells.map((cell) => cellKey(cell.x, cell.y)))
    // Зона дома — та, что занимает больше клеток: по ней материал и вид кровли.
    const counts = new Map<string, number>()
    for (const cell of cells) counts.set(cell.zone ?? '', (counts.get(cell.zone ?? '') ?? 0) + 1)
    const zone = zoneById.get([...counts].sort((a, b) => b[1] - a[1])[0][0])!
    const baseY = Math.max(...cells.map((cell) => terrainHeightAt(map, cell.x, cell.y)))
    const rects = mergeRuns(cells)
    if (rects.length === 1) {
      const only = rects[0]
      const candidate: RoofRect = { zone, cells, members, minX: only.minX, minY: only.minY, maxX: only.maxX, maxY: only.maxY, sides: new Set(), ring: new Set(), baseY }
      const outline = structuralSides(map, candidate)
      candidate.sides = outline.sides
      candidate.ring = outline.ring
      if (candidate.sides.size) buildings.push({ rect: candidate, footprint: members, cells, zone, baseY, inferred: cells.some((cell) => !cell.revealed || inferred.has(cellKey(cell.x, cell.y))) })
      continue
    }
    // Без стен на краю это навес или двор, а не дом: крыша не нужна.
    let walled = false
    const footprint = new Set(members)
    for (const cell of cells) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = cell.x + dx, y = cell.y + dy
      if (members.has(cellKey(x, y))) continue
      if (solid(x, y)) { footprint.add(cellKey(x, y)); walled = true; continue }
    }
    for (const edge of edgeList(map)) {
      if (!STRUCTURAL_EDGES.has(edge.kind)) continue
      const neighbor = edgeNeighbor(edge)
      if (members.has(cellKey(edge.x, edge.y)) !== members.has(cellKey(neighbor.x, neighbor.y))) { walled = true; break }
    }
    if (!walled) continue
    // Угол кольца толстой кладки: клетка по диагонали, если обе соседки уже в кольце.
    for (const key of [...footprint]) {
      if (members.has(key)) continue
      const [x, y] = key.split(',').map(Number)
      for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        if (footprint.has(cellKey(x + dx, y)) && footprint.has(cellKey(x, y + dy)) && !footprint.has(cellKey(x + dx, y + dy))
          && solid(x + dx, y + dy) && !members.has(cellKey(x + dx, y)) && !members.has(cellKey(x, y + dy))) footprint.add(cellKey(x + dx, y + dy))
      }
    }
    buildings.push({ rect: null, footprint, cells, zone, baseY, inferred: cells.some((cell) => !cell.revealed || inferred.has(cellKey(cell.x, cell.y))) })
  }
  return buildings
}

/**
 * Периметр уже выбранного дома. В отличие от `buildRoofRects` он использует
 * полный корпус здания, включая inferred-клетки, поэтому фасад не обрывается
 * на последней раскрытой комнате. Видимые внутренние стены и дверные линии
 * тоже получают верхнюю панель: это не раскрывает туман, потому что ребро уже
 * пришло в публичной проекции.
 */
function buildingUpperWallEdges(map: TacticalMap, building: RoofBuilding) {
  const members = new Set(building.cells.map((cell) => cellKey(cell.x, cell.y)))
  const zoneKinds = new Map(map.zones.map((zone) => [zone.id, zone.kind]))
  const opening = new Set(['door', 'window', 'loophole', 'grate'])
  const result: Array<ReturnType<typeof edgeList>[number]> = []
  for (const edge of edgeList(map)) {
    if (!STRUCTURAL_EDGES.has(edge.kind)) continue
    const neighbor = edgeNeighbor(edge)
    const owner = cellAt(map, edge.x, edge.y)
    const other = cellAt(map, neighbor.x, neighbor.y)
    const ownerInside = members.has(cellKey(edge.x, edge.y))
    const otherInside = members.has(cellKey(neighbor.x, neighbor.y))
    if (!ownerInside && !otherInside) continue
    if (!(revealedAt(map, edge.x, edge.y) || revealedAt(map, neighbor.x, neighbor.y))) continue

    if (ownerInside === otherInside) {
      // Стена между двумя раскрытыми комнатами — известная часть конструкции.
      // Скрытая внутренняя стена не попадает в оболочку; видимый проём всё же
      // получает перемычку и верх стены, как линия наружной двери.
      if (ownerInside && otherInside && (owner?.revealed && other?.revealed || opening.has(edge.kind))) result.push(edge)
      continue
    }

    const outside = ownerInside ? other : owner
    const outsideKind = outside?.zone ? zoneKinds.get(outside.zone) : undefined
    if (outside?.passable === true && (!outsideKind || outsideKind === 'interior') && !opening.has(edge.kind)) continue
    result.push(edge)
  }
  return result
}

function roofRectForBuilding(building: RoofBuilding): RoofRect {
  const xs = building.cells.map((cell) => cell.x)
  const ys = building.cells.map((cell) => cell.y)
  return {
    zone: building.zone,
    cells: building.cells,
    members: new Set(building.cells.map((cell) => cellKey(cell.x, cell.y))),
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
    sides: new Set(),
    ring: new Set(),
    baseY: building.baseY,
  }
}

/** Крышные роли загружаются только для домов с уже валидным контуром крыши. */
export function structuralRoofRolesForMap(map: TacticalMap): StructuralRole[] {
  const buildings = buildRoofBuildings(map).filter((building) => building.cells.length >= 3)
  if (!buildings.length) return []
  const wanted = new Set<StructuralRole>(['chimney_brick'])
  if (buildings.some((building) => Boolean(building.rect))) wanted.add('roof_dormer_roundtile')
  return STRUCTURAL_ROLES.filter((role) => wanted.has(role))
}

/**
 * Цельная крыша дома сложной формы: вальмы, коньки и ендовы из одной сетки
 * (`src/board3d-hip-roof.ts`). Стропила и карнизы — в структуре: их видно и в
 * срезе крыши.
 */
function addHipRoof(
  resources: RoofResources,
  shellGroup: THREE.Group,
  structureGroup: THREE.Group,
  building: RoofBuilding,
  palette: BoardPalette,
  eaveHeight: number,
  map: TacticalMap,
  style: RoofStyle | null,
) {
  const distance = createHipDistance(building.footprint)
  const depth = Math.max(.5, hipRoofDepth(building.footprint, distance))
  const slope = style ? Math.min(PAINTED_ROOF_SLOPE * 2, PAINTED_ROOF_PITCH / depth) : Math.min(.4, ROOF_PITCH / depth)
  const colors = roofColors(palette, building.zone, false)
  const looks = style ? roofLooks(map, { zone: building.zone, cells: building.cells } as RoofRect) : null
  const shellMaterial = style && looks ? style.covering(looks.covering) : roofMaterial(resources, colors.shell)
  const trimMaterial = style ? style.look('timber') : roofMaterial(resources, colors.trim, { roughness: .82 })
  const covering = style && looks ? { ...style.repeat(looks.covering), across: looks.covering === 'shingles' } : undefined
  const keys = [...building.footprint].map((key) => key.split(',').map(Number))
  const minX = Math.min(...keys.map(([x]) => x)), minY = Math.min(...keys.map(([, y]) => y))
  const maxX = Math.max(...keys.map(([x]) => x)), maxY = Math.max(...keys.map(([, y]) => y))
  const y = building.baseY + eaveHeight
  const piece = roofObject(new THREE.Group())
  piece.name = `roof-hip:${building.zone.id}:${minX},${minY},${maxX},${maxY}`
  piece.position.set(0, y, 0)
  addMesh(resources, piece, 'roof-slope:hip', createHipRoofGeometry(building.footprint, { slope, overhang: ROOF_OVERHANG, covering }), shellMaterial)
  shellGroup.add(piece)

  const structural = roofObject(new THREE.Group())
  structural.name = piece.name.replace('roof-hip', 'roof-structure')
  if (building.inferred) structural.userData.board3dInferredRoof = true
  structural.position.set(0, y, 0)
  // Карниз: брус под краем свеса, со срезом в углах, как сам свес.
  for (const run of hipRoofRuns(building.footprint)) {
    const length = run.start.distanceTo(run.end) + (run.convexStart ? ROOF_OVERHANG : -ROOF_OVERHANG) + (run.convexEnd ? ROOF_OVERHANG : -ROOF_OVERHANG)
    if (length <= .05) continue
    const middle = run.start.clone().add(run.end).multiplyScalar(.5)
      .addScaledVector(run.along, ((run.convexEnd ? 1 : -1) - (run.convexStart ? 1 : -1)) * ROOF_OVERHANG / 2)
      .addScaledVector(run.outward, ROOF_OVERHANG - ROOF_EAVE_WIDTH / 2)
    const alongX = Math.abs(run.along.x) > .5
    const geometry = alongX ? new THREE.BoxGeometry(length, ROOF_EAVE_HEIGHT, ROOF_EAVE_WIDTH) : new THREE.BoxGeometry(ROOF_EAVE_WIDTH, ROOF_EAVE_HEIGHT, length)
    addMesh(resources, structural, 'roof-eave:hip', geometry, trimMaterial, [middle.x, -ROOF_OVERHANG * slope - .03, middle.z])
  }
  const rafterGeometry = ownGeometry(resources, new THREE.BoxGeometry(WOOD_ROOF_STRUCTURE_SIZE, WOOD_ROOF_STRUCTURE_SIZE, 1))
  hipRoofRafters(building.footprint, slope).forEach((rafter, index) => {
    const beam = addMesh(resources, structural, `roof-rafter:hip:${index}`, rafterGeometry, trimMaterial)
    const length = rafter.from.distanceTo(rafter.to)
    beam.position.copy(rafter.from).add(rafter.to).multiplyScalar(.5)
    beam.position.y -= RAFTER_DROP
    beam.scale.z = length
    beam.lookAt(rafter.to.clone().add(new THREE.Vector3(0, y - RAFTER_DROP, 0)))
  })
  structureGroup.add(structural)
  const surface: RoofSurface = { heightAt: (x, z) => slope * distance(x, z), slope, skinThickness: 0 }
  return surface
}

function roofDecorationCell(building: RoofBuilding) {
  if (!building.cells.length) return null
  const centerX = building.cells.reduce((sum, cell) => sum + cell.x + .5, 0) / building.cells.length
  const centerY = building.cells.reduce((sum, cell) => sum + cell.y + .5, 0) / building.cells.length
  return [...building.cells].sort((a, b) => (
    Math.hypot(a.x + .5 - centerX, a.y + .5 - centerY)
      - Math.hypot(b.x + .5 - centerX, b.y + .5 - centerY)
      || a.y - b.y || a.x - b.x
  ))[0]
}

/**
 * Крышные детали ставятся только после того, как для дома уже создан скат или
 * вальма, и садятся на его кровлю. Их скрывает cutaway так же, как сплошную
 * оболочку крыши.
 */
function addRoofDecorations(
  parent: THREE.Group,
  building: RoofBuilding,
  assets: StructuralModelAssets | null | undefined,
  eaveHeight: number,
  roof: RoofSurface,
) {
  const anchor = roofDecorationCell(building)
  if (!anchor || building.cells.length < 3) return
  const base = building.baseY + eaveHeight
  const x = anchor.x + .5, z = anchor.y + .5
  // Труба утоплена в кровлю на долю клетки: на скате под ней нет щели.
  const chimney = structuralInstance(assets, {
    role: 'chimney_brick', x, y: base + roof.heightAt(x, z) - .1, z,
    width: .42, height: .92, depth: .42, opaqueRoof: true,
  })
  if (chimney) parent.add(chimney)

  if (roof.dormer) {
    const spot = roof.dormer
    // Передний низ окна лежит на кровле: центр опущен на полглубины по уклону.
    const model = structuralInstance(assets, {
      role: 'roof_dormer_roundtile', x: spot.x, y: base + roof.heightAt(spot.x, spot.z) - roof.slope * .39, z: spot.z,
      yaw: spot.yaw, width: .84, height: .84, depth: .78, opaqueRoof: true,
    })
    if (model) parent.add(model)
  }
}

/** Создаёт видимый слой крыш, не добавляя ничего в TacticalMap и не раскрывая туман. */
export function createBoard3DRoofs(map: TacticalMap, palette: BoardPalette, options: Board3DRoofOptions = {}): Board3DRoofController {
  const resources: RoofResources = { geometries: new Set(), materials: new Set() }
  const group = roofObject(new THREE.Group())
  group.name = 'roofs'
  const shells = roofObject(new THREE.Group())
  shells.name = 'roof-shells'
  const structures = roofObject(new THREE.Group())
  structures.name = 'roof-structures'
  const upperWalls = roofObject(new THREE.Group())
  upperWalls.name = 'roof-upper-walls'
  // Крышки нераскрытых помещений видны в обоих режимах крыш: под ними пол
  // игроку неизвестен, и срезать нечего.
  const closedCaps = roofObject(new THREE.Group())
  closedCaps.name = 'roof-closed-caps'
  group.add(shells, structures, upperWalls, closedCaps)
  const cutWallHeight = Number.isFinite(options.wallHeight) ? Math.max(.1, options.wallHeight as number) : .68
  const fullWallHeight = Math.max(BOARD3D_FULL_WALL_HEIGHT, cutWallHeight + .8)
  const capMaterial = roofMaterial(resources, palette.prop, { roughness: .95 })
  for (const region of closedUnrevealedRegions(map)) {
    for (const rect of mergeRuns(region)) {
      const width = rect.maxX - rect.minX + 1
      const depth = rect.maxY - rect.minY + 1
      const baseY = Math.max(...rect.cells.map((cell) => terrainHeightAt(map, cell.x, cell.y)))
      addMesh(resources, closedCaps, `roof-closed:${rect.minX},${rect.minY},${rect.maxX},${rect.maxY}`,
        new THREE.BoxGeometry(width, ROOF_THICKNESS, depth), capMaterial,
        [rect.minX + width / 2, baseY + cutWallHeight + ROOF_THICKNESS / 2, rect.minY + depth / 2])
    }
  }
  const seenUpperWallEdges = new Set<string>()
  const painted = packHasRoofLooks(options.stylePack) ? createRoofStyle(options.stylePack, resources, options) : null
  group.userData.roofStyle = painted ? 'painted' : 'plain'
  // Своды остаются по комнатам. Скатные дома получают верх стен ниже вместе
  // с полной оболочкой: там доступен тот же inferred-корпус, что и у крыши.
  for (const rect of buildRoofRects(map)) {
    const style = roofStyle(map, rect.zone)
    if (!style) continue
    if (style === 'vault') {
      addUpperWallPanels(resources, upperWalls, map, rect, palette, cutWallHeight, fullWallHeight, seenUpperWallEdges, painted)
      addVaultRoof(resources, shells, structures, rect, palette, fullWallHeight, painted)
    }
  }
  for (const building of buildRoofBuildings(map)) {
    const built = building.rect
      ? addPitchedRoof(resources, shells, structures, building.rect, palette, fullWallHeight, map, painted, building.inferred)
      : addHipRoof(resources, shells, structures, building, palette, fullWallHeight, map, painted)
    if (built) {
      const rect = building.rect ?? roofRectForBuilding(building)
      addUpperWallPanels(resources, upperWalls, map, rect, palette, cutWallHeight, fullWallHeight,
        seenUpperWallEdges, painted, buildingUpperWallEdges(map, building), built, building.baseY)
    }
    if (built && painted) addRoofDecorations(structures, building, options.structuralAssets, fullWallHeight, built)
  }

  let mode: Board3DRoofMode = options.mode ?? 'cutaway'
  let disposed = false
  const applyMode = () => {
    group.userData.roofMode = mode
    group.visible = mode !== 'hidden'
    shells.visible = mode === 'full'
    structures.visible = mode !== 'hidden'
    upperWalls.visible = mode === 'full'
    shells.traverse((object) => {
      if (object === shells) return
      object.visible = mode === 'full'
    })
    structures.traverse((object) => { object.userData.board3dRoof = true })
    structures.traverse((object) => {
      if (object.userData.board3dInferredRoof === true
        || object.userData.board3dOpaqueRoof === true
        || object.userData.board3dRoofInterior === true) object.visible = mode === 'full'
    })
  }
  applyMode()

  return {
    group,
    setMode(next) {
      if (disposed) return
      const normalized = next === 'full' || next === 'hidden' ? next : 'cutaway'
      if (normalized === mode) return
      mode = normalized
      applyMode()
    },
    getMode: () => mode,
    dispose() {
      if (disposed) return
      disposed = true
      group.removeFromParent()
      group.clear()
      for (const material of resources.materials) material.dispose()
      for (const geometry of resources.geometries) geometry.dispose()
      resources.materials.clear()
      resources.geometries.clear()
    },
  }
}

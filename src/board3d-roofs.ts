import * as THREE from 'three'

import type { BoardPalette } from './board-render'
import type { TacticalCell, TacticalMap, TacticalZone } from './types'
import { cellAt, edgeList, edgeNeighbor, revealedAt } from './tactical-map-client'
import { terrainHeightAt } from './board3d-terrain'

/** Режим оболочки здания. Крышный слой не меняет клеточную механику. */
export type Board3DRoofMode = 'cutaway' | 'full' | 'hidden'

export type Board3DRoofOptions = {
  /** Высота существующей срезанной стены, от которой начинается карниз. */
  wallHeight?: number
  mode?: Board3DRoofMode
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
  minX: number
  minY: number
  maxX: number
  maxY: number
  sides: Set<RoofSide>
  baseY: number
}

const ROOF_OVERHANG = 0.12
const ROOF_THICKNESS = 0.09
const ROOF_EAVE_HEIGHT = 0.075
const ROOF_EAVE_WIDTH = 0.105
const ROOF_PITCH = 0.38
const WOOD_ROOF_STRUCTURE_COLOR = '#594630'
const WOOD_ROOF_STRUCTURE_SIZE = 0.09
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
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/** Замкнутая тонкая призма одного ската. Ось длины лежит вдоль локального X. */
function createGableSlopeGeometry(length: number, span: number, rise: number, side: -1 | 1, thickness: number) {
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
  return geometryFromPositions(positions)
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
      beam.position.set(along, rise / 2, side * halfSpan / 2)
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
) {
  const height = fullWallHeight - cutWallHeight
  if (height <= 0) return
  const color = ['wood', 'earth'].includes(rect.zone.material) ? palette.prop : palette.wall
  const panelMaterial = roofMaterial(resources, color, { roughness: .94 })
  for (const edge of structuralEdges(map, rect)) {
    const key = `${edge.x},${edge.y},${edge.dir}`
    if (seenEdges.has(key)) continue
    seenEdges.add(key)
    const horizontal = edge.dir === 's'
    const centerX = edge.dir === 'e' ? edge.x + 1 : edge.x + .5
    const centerZ = edge.dir === 'e' ? edge.y + .5 : edge.y + 1
    const geometry = horizontal
      ? new THREE.BoxGeometry(1, height, 1 / 6)
      : new THREE.BoxGeometry(1 / 6, height, 1)
    addMesh(resources, parent, `roof-wall-upper:${edge.x},${edge.y},${edge.dir}`, geometry, panelMaterial, [
      centerX,
      edgeBaseY(map, edge) + cutWallHeight + height / 2,
      centerZ,
    ])
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
  return Boolean(cell?.revealed && cell.zone === rect.zone.id && cell.passable
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

function structuralSides(map: TacticalMap, rect: RoofRect) {
  const sides = new Set<RoofSide>()
  for (const edge of edgeList(map)) {
    const side = sideForEdge(edge, rect, map)
    if (!side || !(revealedAt(map, edge.x, edge.y) || revealedAt(map, edgeNeighbor(edge).x, edgeNeighbor(edge).y))) continue
    const owner = cellAt(map, edge.x, edge.y)
    const neighbor = edgeNeighbor(edge)
    const other = cellAt(map, neighbor.x, neighbor.y)
    const outside = isInsideRect(owner, rect) ? other : owner
    // Сдвигаем карниз на кольцо непроходимых стен; грань между двумя
    // проходимыми зонами остаётся общей перегородкой без наружного выноса.
    if (outside?.passable === true) continue
    sides.add(side)
  }
  return sides
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
    const owner = cellAt(map, edge.x, edge.y)
    const neighbor = edgeNeighbor(edge)
    const other = cellAt(map, neighbor.x, neighbor.y)
    const outside = isInsideRect(owner, rect) ? other : owner
    if (outside?.passable === true) continue
    seen.add(`${edge.x},${edge.y},${edge.dir}`)
    result.push(edge)
  }
  return result
}

/** Крыша закрывает наружное кольцо стен, но не протекает в соседнюю комнату. */
function roofBounds(rect: RoofRect) {
  return {
    minX: rect.minX - (rect.sides.has('west') ? 1 : 0),
    minY: rect.minY - (rect.sides.has('north') ? 1 : 0),
    maxX: rect.maxX + (rect.sides.has('east') ? 1 : 0),
    maxY: rect.maxY + (rect.sides.has('south') ? 1 : 0),
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

function addPitchedRoof(
  resources: RoofResources,
  shellGroup: THREE.Group,
  structureGroup: THREE.Group,
  rect: RoofRect,
  palette: BoardPalette,
  eaveHeight: number,
) {
  if (!rect.sides.size) return false
  const bounds = roofBounds(rect)
  const centerX = (bounds.minX + bounds.maxX + 1) / 2
  const centerZ = (bounds.minY + bounds.maxY + 1) / 2
  const rawWidth = bounds.maxX - bounds.minX + 1
  const rawDepth = bounds.maxY - bounds.minY + 1
  const ridgeAlongX = rect.zone.floorDirection === 'horizontal'
  const length = (ridgeAlongX ? rawWidth : rawDepth) + ROOF_OVERHANG * 2
  const span = (ridgeAlongX ? rawDepth : rawWidth) + ROOF_OVERHANG * 2
  const rise = Math.min(ROOF_PITCH, Math.max(.18, span * .2))
  const colors = roofColors(palette, rect.zone, false)
  const piece = roofObject(new THREE.Group())
  piece.name = `roof-pitched:${rect.zone.id}:${rect.minX},${rect.minY},${rect.maxX},${rect.maxY}`
  piece.position.set(centerX, rect.baseY + eaveHeight, centerZ)
  if (!ridgeAlongX) piece.rotation.y = Math.PI / 2
  const far = roofObject(new THREE.Group())
  far.name = 'roof-shell:far'
  const near = roofObject(new THREE.Group())
  near.name = 'roof-shell:near'
  const shellMaterial = roofMaterial(resources, colors.shell)
  const trimMaterial = roofMaterial(resources, colors.trim, { roughness: .82 })
  const roofStructureMaterial = ['wood', 'earth'].includes(rect.zone.material)
    ? roofMaterial(resources, WOOD_ROOF_STRUCTURE_COLOR, { roughness: .95 })
    : trimMaterial
  addMesh(resources, far, 'roof-slope:far', createGableSlopeGeometry(length, span, rise, -1, ROOF_THICKNESS), shellMaterial)
  addMesh(resources, near, 'roof-slope:near', createGableSlopeGeometry(length, span, rise, 1, ROOF_THICKNESS), shellMaterial)
  addShingles(resources, far, length, span, rise, -1, trimMaterial)
  addShingles(resources, near, length, span, rise, 1, trimMaterial)
  far.userData.board3dRoof = true
  near.userData.board3dRoof = true
  piece.add(far, near)
  shellGroup.add(piece)

  const structural = roofObject(new THREE.Group())
  structural.name = piece.name.replace('roof-pitched', 'roof-structure')
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
  const endWest = addMesh(resources, structural, 'roof-gable:end-west', endGeometry, trimMaterial, [-length / 2, 0, 0])
  const endEast = addMesh(resources, structural, 'roof-gable:end-east', endGeometry.clone(), trimMaterial, [length / 2, 0, 0])
  endWest.userData.board3dOpaqueRoof = true
  endEast.userData.board3dOpaqueRoof = true
  if (!ridgeAlongX) structural.rotation.y = Math.PI / 2
  structureGroup.add(structural)
  return true
}

function addVaultRoof(
  resources: RoofResources,
  shellGroup: THREE.Group,
  structureGroup: THREE.Group,
  rect: RoofRect,
  palette: BoardPalette,
  eaveHeight: number,
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
  const shellMaterial = roofMaterial(resources, colors.shell, { roughness: .96 })
  const trimMaterial = roofMaterial(resources, colors.trim, { roughness: .78 })
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
        minX: rect.minX,
        minY: rect.minY,
        maxX: rect.maxX,
        maxY: rect.maxY,
        sides: new Set(),
        baseY: Math.max(...rect.cells.map((cell) => terrainHeightAt(map, cell.x, cell.y))),
      }
      candidate.sides = structuralSides(map, candidate)
      // Без канонического рёберного контура это просто открытая площадка, а
      // не здание. Так крыша не появляется на случайном прямоугольнике пола.
      if (candidate.sides.size) result.push(candidate)
    }
  }
  return result
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
  group.add(shells, structures, upperWalls)
  const cutWallHeight = Number.isFinite(options.wallHeight) ? Math.max(.1, options.wallHeight as number) : .68
  const fullWallHeight = Math.max(BOARD3D_FULL_WALL_HEIGHT, cutWallHeight + .8)
  const seenUpperWallEdges = new Set<string>()
  for (const rect of buildRoofRects(map)) {
    const style = roofStyle(map, rect.zone)
    if (!style) continue
    addUpperWallPanels(resources, upperWalls, map, rect, palette, cutWallHeight, fullWallHeight, seenUpperWallEdges)
    if (style === 'vault') addVaultRoof(resources, shells, structures, rect, palette, fullWallHeight)
    else if (style === 'gable') addPitchedRoof(resources, shells, structures, rect, palette, fullWallHeight)
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
      if (object.userData.board3dOpaqueRoof === true || object.userData.board3dRoofInterior === true) object.visible = mode === 'full'
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

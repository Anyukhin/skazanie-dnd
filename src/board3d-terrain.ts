import * as THREE from 'three'

import { cellAt } from './tactical-map-client'
import type { TacticalMap, TacticalProp } from './types'

const ELEVATION_FEET_PER_WORLD_CELL = 5

function heightOf(cell: ReturnType<typeof cellAt>) {
  return cell?.revealed && Number.isFinite(cell.elevation) ? cell.elevation / ELEVATION_FEET_PER_WORLD_CELL : 0
}

export function terrainHeightAt(map: TacticalMap | null, x: number, y: number): number {
  if (!map || !Number.isFinite(x) || !Number.isFinite(y)) return 0
  return heightOf(cellAt(map, Math.floor(x), Math.floor(y)))
}

export function visibleTerrainHeightRange(map: TacticalMap | null): { min: number; max: number } {
  if (!map) return { min: 0, max: 0 }
  let min = 0, max = 0
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (!cell?.revealed) continue
    const height = heightOf(cell)
    min = Math.min(min, height); max = Math.max(max, height)
  }
  return { min, max }
}

function geometryFromArrays(positions: number[], uvs: number[], indices: number[]) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  const vertices = positions.length / 3
  geometry.setIndex(vertices > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1))
  geometry.computeVertexNormals()
  if (vertices) {
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
  } else {
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3())
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0)
  }
  return geometry
}

function addQuad(positions: number[], uvs: number[], indices: number[], points: Array<[number, number, number]>, uvPoints: Array<[number, number]>, vertex: number) {
  for (const point of points) positions.push(...point)
  for (const uv of uvPoints) uvs.push(...uv)
  indices.push(vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3)
  return vertex + 4
}

export function createTerrainSurfaceGeometry(map: TacticalMap, lift = 0): THREE.BufferGeometry {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = []
  const width = Math.max(1, map.width), height = Math.max(1, map.height)
  const offset = Number.isFinite(lift) ? lift : 0
  let vertex = 0
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (!cell?.revealed) continue
    const level = heightOf(cell) + offset
    vertex = addQuad(positions, uvs, indices,
      [[x, level, y], [x, level, y + 1], [x + 1, level, y + 1], [x + 1, level, y]],
      [[x / width, 1 - y / height], [x / width, 1 - (y + 1) / height], [(x + 1) / width, 1 - (y + 1) / height], [(x + 1) / width, 1 - y / height]], vertex)
  }
  return geometryFromArrays(positions, uvs, indices)
}

export function createTerrainSideGeometry(map: TacticalMap): THREE.BufferGeometry {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = []
  const width = Math.max(1, map.width), height = Math.max(1, map.height)
  const boundaryBase = Math.min(0, visibleTerrainHeightRange(map).min) - .12
  let vertex = 0
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (!cell?.revealed) continue
    const own = heightOf(cell)
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      const neighbor = cellAt(map, x + dx, y + dy)
      if (neighbor && !neighbor.revealed) continue
      if (!neighbor) {
        const edge = dx === 1 ? x + 1 : dx === -1 ? x : dy === 1 ? y + 1 : y
        const points: Array<[number, number, number]> = dx === 1
          ? [[edge, boundaryBase, y + 1], [edge, boundaryBase, y], [edge, own, y], [edge, own, y + 1]]
          : dx === -1
            ? [[edge, boundaryBase, y], [edge, boundaryBase, y + 1], [edge, own, y + 1], [edge, own, y]]
            : dy === 1
              ? [[x, boundaryBase, edge], [x + 1, boundaryBase, edge], [x + 1, own, edge], [x, own, edge]]
              : [[x + 1, boundaryBase, edge], [x, boundaryBase, edge], [x, own, edge], [x + 1, own, edge]]
        vertex = addQuad(positions, uvs, indices, points, points.map(([px, , pz]) => [px / width, 1 - pz / height]), vertex)
        continue
      }
      // Восточная и южная сторона каждой пары — единственный источник
      // внутренней грани; западная/северная сторона той же пары уже учтена.
      if (dx < 0 || dy < 0) continue
      const other = heightOf(neighbor)
      if (own === other) continue
      const low = Math.min(own, other), high = Math.max(own, other)
      if (dx === 1) {
        const edge = x + 1
        const points: Array<[number, number, number]> = own > other
          ? [[edge, low, y + 1], [edge, low, y], [edge, high, y], [edge, high, y + 1]]
          : [[edge, low, y], [edge, low, y + 1], [edge, high, y + 1], [edge, high, y]]
        vertex = addQuad(positions, uvs, indices, points, points.map(([px, , pz]) => [px / width, 1 - pz / height]), vertex)
      } else {
        const edge = y + 1
        const points: Array<[number, number, number]> = own > other
          ? [[x, low, edge], [x + 1, low, edge], [x + 1, high, edge], [x, high, edge]]
          : [[x + 1, low, edge], [x, low, edge], [x, high, edge], [x + 1, high, edge]]
        vertex = addQuad(positions, uvs, indices, points, points.map(([px, , pz]) => [px / width, 1 - pz / height]), vertex)
      }
    }
  }
  return geometryFromArrays(positions, uvs, indices)
}

export function propTerrainHeight(map: TacticalMap | null, prop: TacticalProp): number {
  if (!map) return 0
  if (!prop.footprint.length) return terrainHeightAt(map, prop.x, prop.y)
  let found = false, highest = 0
  for (const point of prop.footprint) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
    const cell = cellAt(map, Math.floor(point.x), Math.floor(point.y))
    if (!cell?.revealed) continue
    const height = heightOf(cell)
    if (!found || height > highest) highest = height
    found = true
  }
  return found ? highest : 0
}

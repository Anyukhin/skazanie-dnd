import * as THREE from 'three'

/** Геометрия, материалы и текстуры, принадлежащие одной библиотеке реквизита. */
export type Resources = {
  geometries: Set<THREE.BufferGeometry>
  materials: Set<THREE.Material>
  textures: Set<THREE.Texture>
  geometryPool: Map<string, THREE.BufferGeometry>
  materialPool: Map<string, THREE.MeshStandardMaterial>
}

export function resources(): Resources {
  return {
    geometries: new Set(), materials: new Set(), textures: new Set(),
    geometryPool: new Map(), materialPool: new Map(),
  }
}

export function geometry(resources: Resources, key: string, factory: () => THREE.BufferGeometry) {
  const cached = resources.geometryPool.get(key)
  if (cached) return cached
  const value = factory()
  resources.geometryPool.set(key, value)
  resources.geometries.add(value)
  return value
}

export function material(
  resources: Resources,
  key: string,
  color: string,
  options: THREE.MeshStandardMaterialParameters = {},
) {
  const cached = resources.materialPool.get(key)
  if (cached) return cached
  const value = new THREE.MeshStandardMaterial({ color, roughness: 0.88, metalness: 0.03, ...options })
  resources.materialPool.set(key, value)
  resources.materials.add(value)
  return value
}

export function part(
  resources: Resources,
  parent: THREE.Group,
  name: string,
  key: string,
  factory: () => THREE.BufferGeometry,
  materialValue: THREE.Material,
  size: [number, number, number],
  position: [number, number, number] = [0, 0, 0],
  rotation: [number, number, number] = [0, 0, 0],
  castShadow = true,
) {
  const mesh = new THREE.Mesh(geometry(resources, key, factory), materialValue)
  mesh.name = name
  mesh.position.set(...position)
  mesh.rotation.set(...rotation)
  mesh.scale.set(...size)
  mesh.castShadow = castShadow
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}

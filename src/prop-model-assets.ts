import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  loadSharedModelBuffer,
  recordModelAssetParse,
  registerCspSafeEmbeddedTextureLoader,
} from './actor-models'
import { loadPropModelCatalog, propModelFor, type PropModelCatalog } from './prop-model-catalog'
import { resolvePropAssetId } from './board-render'
import type { TacticalProp } from './types'

export type PropModelAssets = {
  catalog: PropModelCatalog
  models: Map<string, THREE.Group>
  dispose: () => void
}

async function modelBuffer(url: string, signal: AbortSignal) {
  const buffer = await loadSharedModelBuffer(url, { signal, timeoutMs: 15_000, maxBytes: 8_000_000 })
  if (signal.aborted) throw signal.reason ?? new Error('Загрузка модели отменена')
  return buffer
}

/** Геометрии и GPU-ресурсы моделей одной сцены освобождаются её владельцем. */
export function disposePropModelAssets(models: Map<string, THREE.Group>) {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  const skeletons = new Set<THREE.Skeleton>()
  for (const root of models.values()) root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton)
    geometries.add(object.geometry)
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material)
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value)
    }
  })
  skeletons.forEach((skeleton) => skeleton.dispose())
  textures.forEach((texture) => texture.dispose())
  materials.forEach((material) => material.dispose())
  geometries.forEach((geometry) => geometry.dispose())
  models.clear()
}

export async function loadPropModelAssets(props: readonly TacticalProp[], signal: AbortSignal, catalogRevision?: string): Promise<PropModelAssets | null> {
  const catalog = await loadPropModelCatalog(catalogRevision)
  if (!catalog || signal.aborted) return null
  const models = new Map<string, THREE.Group>()
  const entries = new Map(props.flatMap((prop) => {
    const entry = propModelFor(catalog, resolvePropAssetId(prop.assetId), prop.id)
    return entry ? [[entry.key, entry] as const] : []
  }))
  if (!entries.size) return null
  const loader = new GLTFLoader()
  registerCspSafeEmbeddedTextureLoader(loader)
  const queue = [...entries.values()]
  // Не загружаем всю библиотеку: только варианты раскрытых предметов, по четыре.
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length && !signal.aborted) {
      const entry = queue.shift()!
      try {
        const buffer = await modelBuffer(entry.url, signal)
        if (signal.aborted) break
        recordModelAssetParse()
        const gltf = await loader.parseAsync(buffer, '/assets/models/environment/')
        const root = new THREE.Group()
        root.add(gltf.scene)
        if (signal.aborted) { disposePropModelAssets(new Map([[entry.key, root]])); break }
        root.rotation.y = entry.yaw * Math.PI / 180
        root.updateMatrixWorld(true)
        const bounds = new THREE.Box3().setFromObject(root)
        if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) {
          disposePropModelAssets(new Map([[entry.key, root]])); continue
        }
        root.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return
          object.castShadow = true; object.receiveShadow = true
        })
        if (signal.aborted) { disposePropModelAssets(new Map([[entry.key, root]])); break }
        models.set(entry.key, root)
      } catch { /* До успешной загрузки остаётся процедурное представление. */ }
    }
  }))
  let disposed = false
  const result = { catalog, models, dispose() { if (!disposed) { disposed = true; disposePropModelAssets(models) } } }
  if (signal.aborted) { result.dispose(); return null }
  return models.size ? result : null
}

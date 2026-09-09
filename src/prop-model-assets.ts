import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { registerCspSafeEmbeddedTextureLoader, validateGlbContainer } from './actor-models'
import { loadPropModelCatalog, propModelFor, type PropModelCatalog } from './prop-model-catalog'
import { resolvePropAssetId } from './board-render'
import type { TacticalProp } from './types'

export type PropModelAssets = {
  catalog: PropModelCatalog
  models: Map<string, THREE.Group>
  dispose: () => void
}

const buffers = new Map<string, ArrayBuffer>()
let cachedBytes = 0
const CACHE_BUDGET = 32 * 1024 * 1024

async function modelBuffer(url: string, signal: AbortSignal) {
  const cached = buffers.get(url)
  if (cached) { buffers.delete(url); buffers.set(url, cached); return cached }
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), cache: 'no-cache' })
  if (!response.ok || Number(response.headers.get('content-length')) > 8_000_000) throw new Error('Недоступная модель окружения')
  const buffer = await response.arrayBuffer()
  validateGlbContainer(buffer, 8_000_000)
  while (buffers.size && cachedBytes + buffer.byteLength > CACHE_BUDGET) {
    const oldest = buffers.keys().next().value!
    cachedBytes -= buffers.get(oldest)!.byteLength; buffers.delete(oldest)
  }
  // Одновременная смена сцен может завершить два запроса одного файла.
  cachedBytes -= buffers.get(url)?.byteLength ?? 0
  buffers.set(url, buffer); cachedBytes += buffer.byteLength
  return buffer
}

/** Геометрии общие для экземпляров одной сцены и освобождаются её владельцем. */
function disposeModels(models: Map<string, THREE.Group>) {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  for (const root of models.values()) root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    geometries.add(object.geometry)
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material)
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value)
    }
  })
  textures.forEach((texture) => texture.dispose())
  materials.forEach((material) => material.dispose())
  geometries.forEach((geometry) => geometry.dispose())
  models.clear()
}

export async function loadPropModelAssets(props: readonly TacticalProp[], signal: AbortSignal): Promise<PropModelAssets | null> {
  const catalog = await loadPropModelCatalog()
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
        const gltf = await loader.parseAsync(buffer, '/assets/models/environment/')
        const root = new THREE.Group()
        root.add(gltf.scene)
        root.rotation.y = entry.yaw * Math.PI / 180
        root.updateMatrixWorld(true)
        const bounds = new THREE.Box3().setFromObject(root)
        if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) {
          disposeModels(new Map([[entry.key, root]])); continue
        }
        root.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return
          object.castShadow = true; object.receiveShadow = true
        })
        models.set(entry.key, root)
      } catch { /* До успешной загрузки остаётся процедурное представление. */ }
    }
  }))
  let disposed = false
  const result = { catalog, models, dispose() { if (!disposed) { disposed = true; disposeModels(models) } } }
  if (signal.aborted) { result.dispose(); return null }
  return models.size ? result : null
}

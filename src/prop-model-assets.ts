import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  loadSharedModelBuffer,
  recordModelAssetParse,
  registerCspSafeEmbeddedTextureLoader,
} from './model-assets'
import { loadPropModelCatalog, propModelFor, type PropModelCatalog } from './prop-model-catalog'
import { createStyleMaterialBinder, type GraphicsStylePack } from './board3d-style'
import { resolvePropAssetId, withStyleProps, type PropFrame } from './board-render'
import { DETAIL_ASSET_ROOT, DETAIL_PROP_ATLAS_MANIFEST, isDetailFloorStamp } from './detail-props'
import type { TacticalProp } from './types'

export type PropModelAssets = {
  catalog: PropModelCatalog
  models: Map<string, THREE.Group>
  /** Штампы плоских наклеек набора детализации по `assetId` (`isDetailFloorStamp`). */
  stamps?: Map<string, THREE.Texture>
  dispose: () => void
}

type StampAtlas = { image: HTMLImageElement; frames: Record<string, PropFrame> }

let stampAtlas: Promise<StampAtlas | null> | null = null

/**
 * Атлас штампов набора детализации для 3D-доски. Манифест и картинка
 * запрашиваются один раз на приложение; это тот же файл, что рисует 2D-доска,
 * и второй раз он приходит из кэша браузера. Неудача не запоминается:
 * следующая сцена попробует снова, а пока лежит процедурная плашка.
 */
function loadStampAtlas(): Promise<StampAtlas | null> {
  if (stampAtlas) return stampAtlas
  const pending: Promise<StampAtlas | null> = fetch(DETAIL_PROP_ATLAS_MANIFEST, { cache: 'no-cache', signal: AbortSignal.timeout(10_000) })
    .then((response) => (response.ok ? response.json() : null))
    .then((manifest) => new Promise<StampAtlas | null>((resolve) => {
      const frames = manifest?.frames
      const name = typeof manifest?.image === 'string' ? manifest.image : ''
      if (!/^[a-z0-9_-]+\.png$/u.test(name) || !frames) { resolve(null); return }
      const image = new Image()
      image.decoding = 'async'
      image.onload = () => resolve(image.naturalWidth ? { image, frames } : null)
      image.onerror = () => resolve(null)
      image.src = `${DETAIL_ASSET_ROOT}${name}`
    }))
    .catch(() => null)
  stampAtlas = pending
  void pending.then((atlas) => { if (!atlas && stampAtlas === pending) stampAtlas = null })
  return pending
}

/**
 * Кадры штампов отдельными фактурами: плоскость наклейки берёт свой кадр
 * целиком. Вырезка из атласа вместо окна UV — иначе каждая наклейка грузила
 * бы в видеопамять весь атлас набора.
 */
async function loadDetailStamps(assetIds: readonly string[], signal: AbortSignal): Promise<Map<string, THREE.Texture>> {
  const stamps = new Map<string, THREE.Texture>()
  const atlas = await loadStampAtlas()
  if (!atlas || signal.aborted || typeof document === 'undefined') return stamps
  for (const assetId of assetIds) {
    const frame = atlas.frames[assetId]
    if (!frame) continue
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(frame.w))
    canvas.height = Math.max(1, Math.round(frame.h))
    const context = canvas.getContext('2d')
    if (!context) continue
    context.drawImage(atlas.image, frame.x, frame.y, frame.w, frame.h, 0, 0, canvas.width, canvas.height)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 4
    texture.needsUpdate = true
    stamps.set(assetId, texture)
  }
  return stamps
}

async function modelBuffer(url: string, signal: AbortSignal) {
  const buffer = await loadSharedModelBuffer(url, { signal, timeoutMs: 15_000, maxBytes: 8_000_000 })
  if (signal.aborted) throw signal.reason ?? new Error('Загрузка модели отменена')
  return buffer
}

/**
 * Запекает SkinnedMesh шаблона в обычный Mesh в текущей позе скелета (поза
 * файла, то есть bind/первый кадр). Предметы не анимируются костями, а
 * `clone(true)` у скиннингового меша оставляет ссылку на скелет шаблона:
 * шаблон в сцене не стоит, и вершины клона уезжали в начало координат карты.
 * Статичный меш клонируется как любой другой и попадает в batching.
 * Возвращает число запечённых мешей.
 */
export function bakeSkinnedMeshes(root: THREE.Object3D): number {
  root.updateMatrixWorld(true)
  const skinned: THREE.SkinnedMesh[] = []
  root.traverse((object) => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(object as THREE.SkinnedMesh) })
  if (!skinned.length) return 0
  const sources = new Set<THREE.BufferGeometry>()
  const skeletons = new Set<THREE.Skeleton>()
  const skinIndex = new THREE.Vector4(), skinWeight = new THREE.Vector4()
  const blended = new THREE.Matrix4(), bone = new THREE.Matrix4(), vertexMatrix = new THREE.Matrix4()
  const normalMatrix = new THREE.Matrix3(), vector = new THREE.Vector3()
  let baked = 0
  for (const mesh of skinned) {
    const parent = mesh.parent
    const source = mesh.geometry
    // Чередующиеся атрибуты читаются тем же fromBufferAttribute; тип three этого не отражает.
    const indices = source.getAttribute('skinIndex') as THREE.BufferAttribute | undefined
    const weights = source.getAttribute('skinWeight') as THREE.BufferAttribute | undefined
    if (!parent || !mesh.skeleton || !indices || !weights) continue
    mesh.skeleton.update()
    const boneMatrices = mesh.skeleton.boneMatrices
    if (!boneMatrices) continue
    const geometry = source.clone()
    const position = geometry.getAttribute('position')
    const normal = geometry.getAttribute('normal')
    const tangent = geometry.getAttribute('tangent')
    for (let index = 0; index < position.count; index += 1) {
      // Та же линейная смесь, что в шейдере three: bindMatrixInverse · Σ(w · bone) · bindMatrix.
      skinIndex.fromBufferAttribute(indices, index)
      skinWeight.fromBufferAttribute(weights, index)
      blended.elements.fill(0)
      for (let slot = 0; slot < 4; slot += 1) {
        const weight = skinWeight.getComponent(slot)
        if (!weight) continue
        bone.fromArray(boneMatrices, skinIndex.getComponent(slot) * 16)
        for (let element = 0; element < 16; element += 1) blended.elements[element] += bone.elements[element] * weight
      }
      vertexMatrix.copy(mesh.bindMatrixInverse).multiply(blended).multiply(mesh.bindMatrix)
      vector.fromBufferAttribute(position, index).applyMatrix4(vertexMatrix)
      position.setXYZ(index, vector.x, vector.y, vector.z)
      if (normal) {
        normalMatrix.getNormalMatrix(vertexMatrix)
        vector.fromBufferAttribute(normal, index).applyMatrix3(normalMatrix).normalize()
        normal.setXYZ(index, vector.x, vector.y, vector.z)
      }
      if (tangent) {
        vector.set(tangent.getX(index), tangent.getY(index), tangent.getZ(index)).transformDirection(vertexMatrix)
        tangent.setXYZ(index, vector.x, vector.y, vector.z)
      }
    }
    geometry.deleteAttribute('skinIndex')
    geometry.deleteAttribute('skinWeight')
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    const replacement = new THREE.Mesh(geometry, mesh.material)
    replacement.name = mesh.name
    replacement.userData = { ...mesh.userData, bakedSkin: true }
    replacement.position.copy(mesh.position)
    replacement.quaternion.copy(mesh.quaternion)
    replacement.scale.copy(mesh.scale)
    replacement.matrixAutoUpdate = mesh.matrixAutoUpdate
    replacement.matrix.copy(mesh.matrix)
    replacement.visible = mesh.visible
    replacement.castShadow = mesh.castShadow
    replacement.receiveShadow = mesh.receiveShadow
    replacement.frustumCulled = mesh.frustumCulled
    replacement.renderOrder = mesh.renderOrder
    replacement.layers.mask = mesh.layers.mask
    for (const child of [...mesh.children]) replacement.add(child)
    const at = parent.children.indexOf(mesh)
    parent.remove(mesh)
    parent.add(replacement)
    parent.children.splice(parent.children.indexOf(replacement), 1)
    parent.children.splice(at, 0, replacement)
    sources.add(source)
    skeletons.add(mesh.skeleton)
    baked += 1
  }
  const used = new Set<THREE.BufferGeometry>()
  root.traverse((object) => { if ((object as THREE.Mesh).isMesh) used.add((object as THREE.Mesh).geometry) })
  sources.forEach((geometry) => { if (!used.has(geometry)) geometry.dispose() })
  skeletons.forEach((skeleton) => skeleton.dispose())
  root.updateMatrixWorld(true)
  return baked
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

export async function loadPropModelAssets(props: readonly TacticalProp[], signal: AbortSignal, catalogRevision?: string, stylePack?: GraphicsStylePack | null): Promise<PropModelAssets | null> {
  const loaded = await loadPropModelCatalog(catalogRevision)
  if (!loaded || signal.aborted) return null
  // Пакет стиля подменяет модели тех видов, для которых у него есть своя;
  // остальные берутся из выпуска карты, как и без стиля.
  const catalog = withStyleProps(loaded, stylePack, props)
  const models = new Map<string, THREE.Group>()
  const entries = new Map(props.flatMap((prop) => {
    const entry = propModelFor(catalog, resolvePropAssetId(prop.assetId), prop.id)
    return entry ? [[entry.key, entry] as const] : []
  }))
  // Плоская наклейка без своей модели ложится на пол штампом; модель, если
  // она есть в выпуске или пакете стиля, сильнее штампа.
  const stampIds = [...new Set(props.map((prop) => resolvePropAssetId(prop.assetId)))]
    .filter((assetId) => isDetailFloorStamp(assetId) && !catalog.models.some((entry) => entry.assetIds.includes(assetId)))
  if (!entries.size && !stampIds.length) return null
  const stampsLoading = stampIds.length ? loadDetailStamps(stampIds, signal) : Promise.resolve(new Map<string, THREE.Texture>())
  const loader = new GLTFLoader()
  registerCspSafeEmbeddedTextureLoader(loader)
  // Модели пакета стиля без своих текстур: материалы `skz:*` общие на всю загрузку.
  const bindStyleMaterials = stylePack ? createStyleMaterialBinder(stylePack) : null
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
        bakeSkinnedMeshes(root)
        bindStyleMaterials?.bind(root)
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
  // Модели показываются уже с рисованными фактурами, а не белыми на миг.
  if (bindStyleMaterials && models.size && !signal.aborted) await Promise.race([bindStyleMaterials.ready(), new Promise((resolve) => setTimeout(resolve, 15_000))])
  const stamps = await stampsLoading
  let disposed = false
  const result = {
    catalog, models, stamps,
    dispose() {
      if (disposed) return
      disposed = true
      disposePropModelAssets(models)
      stamps.forEach((texture) => texture.dispose())
      stamps.clear()
    },
  }
  if (signal.aborted) { result.dispose(); return null }
  if (models.size || stamps.size) return result
  result.dispose()
  return null
}

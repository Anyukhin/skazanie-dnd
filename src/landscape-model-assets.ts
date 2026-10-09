import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { loadSharedModelBuffer, recordModelAssetParse, registerCspSafeEmbeddedTextureLoader } from './model-assets'
import { prepareCutoutMaterials } from './board3d-cutout'

/**
 * Модели местности 3D-доски: камни гряд и толщи скалы, кувшинки и тростник у
 * воды, пролёты моста. Набор собирает `tools/build-landscape-kit.mjs` в
 * неизменяемую ревизию `public/assets/models/landscape/<ревизия>/`; активный
 * manifest.json рядом указывает на неё.
 *
 * Только представление: клетки и проходимость решает TacticalMap. Пока набор
 * не загружен (или не загрузился вовсе, или это тест/SSR без window), доска
 * рисует процедурный запасной вариант.
 */

export const LANDSCAPE_ROLES = ['rock', 'cliff', 'lily', 'reed', 'bridge'] as const
export type LandscapeRole = typeof LANDSCAPE_ROLES[number]

export type LandscapeModelEntry = {
  key: string
  role: LandscapeRole
  url: string
  /** Имя узла модели в GLB: несколько записей могут делить один узел. */
  node: string
  source: string
  sourceId: string
  license: string
  sha256: string
}

export type LandscapeManifest = {
  version: 1
  revision: string
  models: LandscapeModelEntry[]
}

export type LandscapeModelPart = { geometry: THREE.BufferGeometry; material: THREE.Material }

/**
 * Модель, приведённая к общему виду: центр основания в начале координат, низ
 * на y = 0, большая сторона по X/Z равна 1. `size` — габарит после приведения.
 */
export type LandscapeModel = {
  key: string
  role: LandscapeRole
  parts: LandscapeModelPart[]
  size: THREE.Vector3
}

export type LandscapeKit = {
  revision: string
  models: readonly LandscapeModel[]
}

/** Набор, взятый сценой: `release` отдаёт его, последний владелец освобождает GPU-ресурсы. */
export type LandscapeKitHandle = LandscapeKit & { release: () => void }

export const LANDSCAPE_MANIFEST_URL = '/assets/models/landscape/manifest.json'
const URL_ROOT = '/assets/models/landscape/'
const REVISION = /^[a-f0-9]{8,64}$/
const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/
const FILE = /^[a-z0-9][a-z0-9-]{0,63}\.glb$/
const SHA256 = /^[a-f0-9]{64}$/
const MAX_MODELS = 64
const MAX_MANIFEST_BYTES = 128_000
const MAX_GLB_BYTES = 4_000_000

/** Проверяет форму манифеста; файлы — только внутри объявленной ревизии. */
export function validateLandscapeManifest(value: unknown): LandscapeManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Нет манифеста местности')
  const input = value as Record<string, unknown>
  const revision = input.revision
  if (input.version !== 1 || typeof revision !== 'string' || !REVISION.test(revision)) throw new Error('Некорректная ревизия манифеста местности')
  if (!Array.isArray(input.models) || !input.models.length || input.models.length > MAX_MODELS) throw new Error('Некорректный список моделей местности')
  const prefix = `${URL_ROOT}${revision}/`
  const keys = new Set<string>()
  const models = input.models.map((raw): LandscapeModelEntry => {
    const entry = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const { key, role, url, node, source, sourceId, license, sha256 } = entry
    if (typeof key !== 'string' || !KEY.test(key) || keys.has(key)
      || typeof role !== 'string' || !(LANDSCAPE_ROLES as readonly string[]).includes(role)
      || typeof url !== 'string' || !url.startsWith(prefix) || !FILE.test(url.slice(prefix.length))
      || typeof node !== 'string' || !KEY.test(node)
      || typeof source !== 'string' || !source || source.length > 200
      || typeof sourceId !== 'string' || !KEY.test(sourceId)
      || typeof license !== 'string' || !license || license.length > 40
      || typeof sha256 !== 'string' || !SHA256.test(sha256)) throw new Error('Некорректная запись модели местности')
    keys.add(key)
    return { key, role: role as LandscapeRole, url, node, source, sourceId, license, sha256 }
  })
  return { version: 1, revision, models }
}

/**
 * Детерминированный выбор варианта по шуму клетки 0..1: тот же вариант при
 * каждой пересборке сцены.
 */
export function pickLandscapeVariant<T>(list: readonly T[], noise: number): T | null {
  if (!list.length) return null
  const unit = Number.isFinite(noise) ? noise - Math.floor(noise) : 0
  return list[Math.min(list.length - 1, Math.floor(unit * list.length))]
}

export function landscapeModelsOf(kit: LandscapeKit | null | undefined, role: LandscapeRole): LandscapeModel[] {
  return kit ? kit.models.filter((model) => model.role === role) : []
}

/**
 * Запекает узел модели в отдельные геометрии по материалу, в координатах
 * приведённой модели (см. `LandscapeModel`). Узел не меняется.
 */
export function normalizeLandscapeNode(root: THREE.Object3D): { parts: LandscapeModelPart[]; size: THREE.Vector3 } | null {
  root.updateMatrixWorld(true)
  const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const baked: LandscapeModelPart[] = []
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    if (materials.length !== 1) return
    const geometry = mesh.geometry.clone()
    for (const name of Object.keys(geometry.attributes)) {
      if (!['position', 'normal', 'uv'].includes(name)) geometry.deleteAttribute(name)
    }
    geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld))
    // COLOR_0 у травы Quaternius — маска ветра, а не цвет; атрибут снят, и
    // материал без него читал бы чёрный цвет вершин.
    const material = materials[0] as THREE.MeshStandardMaterial
    if (material.vertexColors) { material.vertexColors = false; material.needsUpdate = true }
    baked.push({ geometry, material })
  })
  if (!baked.length) return null
  const bounds = new THREE.Box3()
  for (const part of baked) {
    part.geometry.computeBoundingBox()
    bounds.union(part.geometry.boundingBox!)
  }
  const size = bounds.getSize(new THREE.Vector3())
  const footprint = Math.max(size.x, size.z)
  if (bounds.isEmpty() || !(footprint > 1e-6) || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) {
    baked.forEach((part) => part.geometry.dispose())
    return null
  }
  const center = bounds.getCenter(new THREE.Vector3())
  const transform = new THREE.Matrix4().makeScale(1 / footprint, 1 / footprint, 1 / footprint)
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -bounds.min.y, -center.z))
  for (const part of baked) {
    part.geometry.applyMatrix4(transform)
    part.geometry.computeBoundingBox()
    part.geometry.computeBoundingSphere()
  }
  return { parts: baked, size: size.multiplyScalar(1 / footprint) }
}

export function pointNormalsUp(geometry: THREE.BufferGeometry) {
  const count = geometry.getAttribute('position').count
  const normals = new Float32Array(count * 3)
  for (let index = 0; index < count; index += 1) normals[index * 3 + 1] = 1
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
}

function disposeKit(models: readonly LandscapeModel[]) {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  for (const model of models) for (const part of model.parts) {
    geometries.add(part.geometry)
    materials.add(part.material)
    for (const value of Object.values(part.material)) if (value instanceof THREE.Texture) textures.add(value)
  }
  textures.forEach((texture) => texture.dispose())
  materials.forEach((material) => material.dispose())
  geometries.forEach((geometry) => geometry.dispose())
}

async function fetchManifest(): Promise<LandscapeManifest | null> {
  const response = await fetch(LANDSCAPE_MANIFEST_URL, { cache: 'no-cache', signal: AbortSignal.timeout(10_000) })
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_MANIFEST_BYTES) return null
  const text = await response.text()
  if (text.length > MAX_MANIFEST_BYTES) return null
  return validateLandscapeManifest(JSON.parse(text))
}

async function loadKit(): Promise<LandscapeKit | null> {
  const manifest = await fetchManifest()
  if (!manifest) return null
  const loader = new GLTFLoader()
  registerCspSafeEmbeddedTextureLoader(loader)
  const scenes = new Map<string, Promise<THREE.Object3D | null>>()
  const sceneOf = (url: string) => {
    let pending = scenes.get(url)
    if (!pending) {
      pending = loadSharedModelBuffer(url, { timeoutMs: 15_000, maxBytes: MAX_GLB_BYTES })
        .then((buffer) => { recordModelAssetParse(); return loader.parseAsync(buffer, URL_ROOT) })
        // Кувшинки и тростник вырезаны по альфе: заливка пустых пикселей и
        // сглаженный край, как у листвы предметов.
        .then((gltf) => { prepareCutoutMaterials(gltf.scene); return gltf.scene as THREE.Object3D })
        .catch(() => null)
      scenes.set(url, pending)
    }
    return pending
  }
  const shared = new Map<string, { parts: LandscapeModelPart[]; size: THREE.Vector3 } | null>()
  const models: LandscapeModel[] = []
  for (const entry of manifest.models) {
    const id = `${entry.url}#${entry.node}`
    if (!shared.has(id)) {
      const scene = await sceneOf(entry.url)
      const node = scene?.getObjectByName(entry.node)
      const normalized = node ? normalizeLandscapeNode(node) : null
      // Тонкие стебли освещаются как трава: нормаль вверх, иначе обращённые
      // от солнца лезвия чернеют.
      if (normalized && entry.role === 'reed') normalized.parts.forEach((part) => pointNormalsUp(part.geometry))
      shared.set(id, normalized)
    }
    const normalized = shared.get(id)
    // Отказ одной модели снимает только её: её роль останется процедурной.
    if (normalized) models.push({ key: entry.key, role: entry.role, parts: normalized.parts, size: normalized.size.clone() })
  }
  // Исходные сцены GLTF больше не нужны: запечённые геометрии — копии.
  for (const pending of scenes.values()) {
    const scene = await pending
    scene?.traverse((object) => { if ((object as THREE.Mesh).isMesh) (object as THREE.Mesh).geometry.dispose() })
  }
  return models.length ? { revision: manifest.revision, models } : null
}

type SharedKit = { promise: Promise<LandscapeKit | null>; kit: LandscapeKit | null; users: number; settled: boolean }
let current: SharedKit | null = null

function releaseShared(entry: SharedKit) {
  entry.users = Math.max(0, entry.users - 1)
  if (entry.users || !entry.settled) return
  if (current === entry) current = null
  if (entry.kit) disposeKit(entry.kit.models)
  entry.kit = null
}

/**
 * Берёт общий набор моделей местности. Сцены одной вкладки делят геометрии и
 * материалы; при отмене `signal` или отказе загрузки — `null`, и сцена остаётся
 * на процедурном варианте. Буферы GLB кэширует `loadSharedModelBuffer`.
 */
export async function acquireLandscapeKit(signal: AbortSignal): Promise<LandscapeKitHandle | null> {
  if (typeof window === 'undefined' || typeof fetch !== 'function' || signal.aborted) return null
  if (!current) {
    const created: SharedKit = { promise: Promise.resolve(null), kit: null, users: 0, settled: false }
    created.promise = loadKit().catch(() => null).then((kit) => {
      created.settled = true
      created.kit = kit
      if (!kit && current === created) current = null
      // Все потребители ушли до конца загрузки — освобождать сразу.
      if (!created.users && kit) { if (current === created) current = null; disposeKit(kit.models); created.kit = null }
      return created.kit
    })
    current = created
  }
  const entry = current
  entry.users += 1
  const kit = await new Promise<LandscapeKit | null>((resolve) => {
    const onAbort = () => resolve(null)
    signal.addEventListener('abort', onAbort, { once: true })
    void entry.promise.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value) })
  })
  if (!kit || signal.aborted) { releaseShared(entry); return null }
  let released = false
  return { revision: kit.revision, models: kit.models, release() { if (!released) { released = true; releaseShared(entry) } } }
}

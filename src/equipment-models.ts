import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  EQUIPMENT_VISUAL_SLOTS,
  normalizeEquipmentModelKey,
  normalizeEquipmentVisualSlot,
  normalizeEquipmentVisualVariant,
  normalizePublicLoadout,
  modelKeysForEquipmentSlot,
  itemVisualForCatalogId,
} from '../server/equipment-visuals.mjs'
import type {
  EquipmentVisualDescriptor,
  EquipmentVisualSlot,
  EquipmentVisualVariant,
  PublicLoadout,
} from '../server/equipment-visuals.mjs'
import {
  loadModelAssetBuffer,
  loadSharedModelBuffer,
  recordModelAssetCacheHit,
  recordModelAssetParse,
  registerCspSafeEmbeddedTextureLoader,
} from './model-assets'
import { createEquipmentRig, type EquipmentRig, type EquipmentSide } from './equipment-rig'

const DEFAULT_MANIFEST_URL = '/assets/models/equipment/manifest.json'
const EQUIPMENT_MODEL_ROOT = '/assets/models/equipment/'
const DEFAULT_MAX_MANIFEST_BYTES = 256 * 1024
const DEFAULT_MAX_GLB_BYTES = 16 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 8_000

export type EquipmentModelManifestEntry = {
  key: string
  slot: EquipmentVisualSlot
  variant: EquipmentVisualVariant
  url: string
  /** Имена частей, если модель содержит несколько rig-mounted групп. */
  parts: string[]
  /** Части тела, закрываемые бронёй; применяется только для body. */
  coverage: string[]
  kind?: string
  handedness?: string
}

export type EquipmentModelManifest = {
  version: 1
  models: EquipmentModelManifestEntry[]
}

export type EquipmentControllerStatus = 'idle' | 'loading' | 'ready' | 'error' | 'disposed'

export type EquipmentControllerOptions = {
  height: number
  profile: string
  manifestUrl?: string
  fetcher?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
  maxManifestBytes?: number
  maxGlbBytes?: number
  loader?: GLTFLoader
  onChange?: () => void
}

export type EquipmentController = {
  readonly ready: Promise<void>
  readonly loadout: PublicLoadout
  readonly status: EquipmentControllerStatus
  readonly error: Error | null
  readonly rig: EquipmentRig
  setLoadout: (loadout: unknown) => Promise<void>
  dispose: () => void
}

type RawRecord = Record<string, unknown>
type LoadedModel = { entry: EquipmentModelManifestEntry; root: THREE.Group }
type MountPlan = { loaded: LoadedModel; parts: Array<{ object: THREE.Object3D; key: string }> }

const manifestCache = new Map<string, Promise<EquipmentModelManifest>>()
const fetcherIds = new WeakMap<object, number>()
let nextFetcherId = 1

function objectLike(value: unknown): value is RawRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizedList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : []
}

function safeEquipmentManifestUrl(value: unknown): string | null {
  const raw = text(value)
  if (!raw || raw.includes('\\') || raw.includes('%') || raw.includes('?') || raw.includes('#')
    || raw.startsWith('//') || /^[a-z][a-z\d+.-]*:/iu.test(raw)) return null
  const path = raw.startsWith('/') ? raw : `${EQUIPMENT_MODEL_ROOT}${raw}`
  if (!path.startsWith(EQUIPMENT_MODEL_ROOT) || path.split('/').includes('..') || !path.toLocaleLowerCase('en-US').endsWith('.json')) return null
  return path
}

function safeEquipmentModelUrl(value: unknown): string | null {
  const raw = text(value)
  if (!raw || raw.includes('\\') || raw.includes('%') || raw.includes('?') || raw.includes('#')
    || raw.startsWith('//') || /^[a-z][a-z\d+.-]*:/iu.test(raw)) return null
  const path = raw.startsWith('/') ? raw : `${EQUIPMENT_MODEL_ROOT}${raw}`
  if (!path.startsWith(EQUIPMENT_MODEL_ROOT) || path.split('/').includes('..') || !path.toLocaleLowerCase('en-US').endsWith('.glb')) return null
  return path
}

function fetcherKey(fetcher: typeof fetch): string {
  const owner = fetcher as unknown as object
  let id = fetcherIds.get(owner)
  if (!id) { id = nextFetcherId; nextFetcherId += 1; fetcherIds.set(owner, id) }
  return `${id}:`
}

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function finiteLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback
}

function variantUrl(raw: RawRecord, variant: string, baseUrl: unknown): unknown {
  const variants = raw.variants
  if (objectLike(variants)) {
    const candidate = variants[variant]
    if (typeof candidate === 'string') return candidate
    if (objectLike(candidate)) return candidate.url ?? candidate.path ?? baseUrl
  }
  const urls = raw.urls
  if (objectLike(urls)) return urls[variant] ?? baseUrl
  return baseUrl
}

function declaredVariants(raw: RawRecord): string[] {
  if (objectLike(raw.variants)) return Object.keys(raw.variants)
  if (Array.isArray(raw.variants)) return normalizedList(raw.variants)
  return [text(raw.variant) || 'default']
}

function partNames(raw: RawRecord): string[] {
  return normalizedList(raw.parts ?? raw.part_keys ?? raw.partKeys)
}

function catalogIds(raw: RawRecord): string[] {
  return normalizedList(raw.catalogIds ?? raw.catalog_ids ?? raw.catalogId ?? raw.catalog_id)
}

function coverageNames(raw: RawRecord): string[] {
  const declared = normalizedList(raw.coverage ?? raw.occludes ?? raw.occlusion)
  return declared.flatMap((part) => part.toLocaleLowerCase('en-US') === 'body' ? ['chest', 'waist'] : [part])
}

/** Проверяет локальный манифест и оставляет только закрытые server model keys. */
export function validateEquipmentModelManifest(value: unknown): EquipmentModelManifest {
  if (!objectLike(value) || value.version !== 1 || !Array.isArray(value.models)) {
    throw new Error('Каталог экипировки должен иметь version=1 и массив models')
  }
  const seen = new Set<string>()
  const models: EquipmentModelManifestEntry[] = []
  for (const [index, rawValue] of value.models.entries()) {
    if (!objectLike(rawValue)) throw new Error(`Модель экипировки ${index + 1} имеет неверную форму`)
    const key = normalizeEquipmentModelKey(rawValue.key ?? rawValue.model_key)
    const explicitSlot = rawValue.slot === undefined ? null : normalizeEquipmentVisualSlot(rawValue.slot)
    if (rawValue.slot !== undefined && !explicitSlot) throw new Error(`Модель экипировки ${index + 1} содержит неизвестный slot`)
    if (!key) continue
    const catalogVisuals = catalogIds(rawValue)
      .map((catalogId) => itemVisualForCatalogId(catalogId))
      .filter((visual): visual is { slot: EquipmentVisualSlot; model_key: string; variant?: EquipmentVisualVariant } => Boolean(visual && visual.model_key === key))
    const derivedSlots = [...new Set(catalogVisuals.map((visual) => visual.slot))]
    const allowlistedSlots = EQUIPMENT_VISUAL_SLOTS.filter((slot): slot is EquipmentVisualSlot => modelKeysForEquipmentSlot(slot).includes(key))
    if (explicitSlot && !allowlistedSlots.includes(explicitSlot)) {
      if (!allowlistedSlots.length) continue
      throw new Error(`Модель ${key} не разрешена в слоте ${explicitSlot}`)
    }
    const slots: EquipmentVisualSlot[] = explicitSlot
      ? [explicitSlot]
      : derivedSlots.length
        ? derivedSlots
        : allowlistedSlots
    // Внутренние recipe-only записи (например, net) не входят в server
    // allowlist и не должны превращать весь публичный manifest в ошибку.
    if (!slots.length) continue
    const variants = [...new Set([
      ...declaredVariants(rawValue),
      ...catalogVisuals.map((visual) => visual.variant ?? 'default'),
    ])]
    if (!variants.length) throw new Error(`Модель экипировки ${key} не содержит variant`)
    const parts = partNames(rawValue)
    for (const slot of slots) {
      if ((slot === 'body' || slot === 'cloak') && parts.some((part) => !canonicalPartKey(part))) {
        throw new Error(`Модель ${key} содержит неизвестную rig-часть`)
      }
      for (const variantValue of variants) {
        const variant = normalizeEquipmentVisualVariant(variantValue)
        if (!variant) throw new Error(`Модель ${key} содержит неизвестный variant`)
        const url = safeEquipmentModelUrl(variantUrl(rawValue, variant, rawValue.url ?? rawValue.path))
        if (!url) throw new Error(`Модель ${key} должна ссылаться на локальный self-contained .glb`)
        const id = `${slot}:${key}:${variant}`
        if (seen.has(id)) throw new Error(`Повторная модель экипировки: ${id}`)
        seen.add(id)
        models.push({
          key, slot, variant, url,
          parts, coverage: coverageNames(rawValue),
          ...(text(rawValue.kind) ? { kind: text(rawValue.kind) } : {}),
          ...(text(rawValue.handedness) ? { handedness: text(rawValue.handedness) } : {}),
        })
      }
    }
  }
  return { version: 1, models }
}

async function loadEquipmentManifest(options: Pick<EquipmentControllerOptions, 'manifestUrl' | 'fetcher' | 'signal' | 'timeoutMs' | 'maxManifestBytes'> = {}): Promise<EquipmentModelManifest> {
  const url = safeEquipmentManifestUrl(options.manifestUrl ?? DEFAULT_MANIFEST_URL)
  if (!url) throw new Error('manifestUrl должен указывать на локальный /assets/models/equipment/*.json')
  const fetcher = options.fetcher ?? (typeof fetch === 'function' ? fetch : undefined)
  if (!fetcher) throw new Error('В браузере недоступен fetch')
  const maxBytes = finiteLimit(options.maxManifestBytes, DEFAULT_MAX_MANIFEST_BYTES)
  const timeoutMs = Math.max(250, Math.min(30_000, finitePositive(options.timeoutMs, 5_000)))
  const cacheable = !options.fetcher && !options.signal
  const key = `${fetcherKey(fetcher)}${url}`
  let promise = cacheable ? manifestCache.get(key) : undefined
  if (promise) recordModelAssetCacheHit()
  if (!promise) {
    promise = loadModelAssetBuffer(fetcher, url, { signal: options.signal, timeoutMs, maxBytes })
      .then((buffer) => validateEquipmentModelManifest(JSON.parse(new TextDecoder().decode(buffer))))
    if (cacheable) manifestCache.set(key, promise)
  }
  try { return await promise } catch (error) {
    if (cacheable && manifestCache.get(key) === promise) manifestCache.delete(key)
    throw error
  }
}

export const loadEquipmentModelManifest = loadEquipmentManifest

function parseGltf(loader: GLTFLoader, buffer: ArrayBuffer): Promise<GLTF> {
  if (typeof loader.parseAsync === 'function') return loader.parseAsync(buffer, EQUIPMENT_MODEL_ROOT)
  return new Promise((resolve, reject) => loader.parse(buffer, EQUIPMENT_MODEL_ROOT, resolve, reject))
}

function disposeObject(root: THREE.Group): void {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  const skeletons = new Set<THREE.Skeleton>()
  const images = new Set<{ close: () => void }>()
  root.traverse((object) => {
    const candidate = object as THREE.Mesh
    if (!candidate.isMesh) return
    if (candidate.geometry) geometries.add(candidate.geometry)
    if (candidate instanceof THREE.SkinnedMesh && candidate.skeleton) skeletons.add(candidate.skeleton)
    for (const material of Array.isArray(candidate.material) ? candidate.material : [candidate.material]) {
      if (!material) continue
      materials.add(material)
      for (const value of Object.values(material)) {
        if (!(value instanceof THREE.Texture)) continue
        textures.add(value)
        const image = value.image
        if (image && typeof image === 'object' && typeof (image as { close?: unknown }).close === 'function') images.add(image as { close: () => void })
      }
    }
  })
  skeletons.forEach((skeleton) => skeleton.dispose())
  images.forEach((image) => image.close())
  textures.forEach((texture) => texture.dispose())
  materials.forEach((material) => material.dispose())
  geometries.forEach((geometry) => geometry.dispose())
  root.clear()
}

function validBounds(root: THREE.Group): boolean {
  root.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(root)
  return !bounds.isEmpty() && [...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)
}

function markShadows(root: THREE.Group): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true }
  })
}

function applyVisualVariant(root: THREE.Group, entry: EquipmentModelManifestEntry): void {
  const ringFire = entry.slot === 'ring-fire-resistance'
  const ringProtection = entry.slot === 'ring-protection'
  if (entry.variant === 'default' && !ringFire && !ringProtection) {
    root.userData.visualVariantApplied = 'default'
    return
  }
  const cloned = new Map<THREE.Material, THREE.Material>()
  const originals = new Set<THREE.Material>()
  const recolor = (material: THREE.Material): THREE.Material => {
    const existing = cloned.get(material)
    if (existing) return existing
    originals.add(material)
    const next = material.clone()
    if (next instanceof THREE.MeshStandardMaterial) {
      if (ringFire) {
        next.color.set('#a84a2e')
        next.emissive.set('#6e2417')
        next.emissiveIntensity = .32
      } else if (ringProtection) {
        next.color.set('#5f9ec4')
        next.emissive.set('#254c73')
        next.emissiveIntensity = .22
      } else if (entry.variant === 'flaming') {
        next.color.lerp(new THREE.Color('#e06b31'), .2)
        next.emissive.set('#ff4b1f')
        next.emissiveIntensity = .7
      } else if (entry.variant === 'adamantine') {
        next.color.lerp(new THREE.Color('#202a33'), .28)
        next.metalness = Math.max(next.metalness, .72)
        next.roughness = Math.min(next.roughness, .5)
      } else if (entry.variant === 'enchanted') {
        next.emissive.set('#315d9b')
        next.emissiveIntensity = .16
      }
    }
    cloned.set(material, next)
    return next
  }
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || !mesh.material) return
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((material) => recolor(material))
      : recolor(mesh.material)
  })
  originals.forEach((material) => material.dispose())
  root.userData.visualVariantApplied = ringFire ? 'fire-resistance' : ringProtection ? 'protection' : entry.variant
}

async function loadEquipmentModel(entry: EquipmentModelManifestEntry, options: EquipmentControllerOptions, signal: AbortSignal, loader: GLTFLoader): Promise<THREE.Group> {
  const timeoutMs = Math.max(250, Math.min(30_000, finitePositive(options.timeoutMs, DEFAULT_TIMEOUT_MS)))
  const maxBytes = finiteLimit(options.maxGlbBytes, DEFAULT_MAX_GLB_BYTES)
  const buffer = await loadSharedModelBuffer(entry.url, {
    signal, timeoutMs, maxBytes, fetcher: options.fetcher,
  })
  if (signal.aborted) throw signal.reason ?? new Error('Загрузка экипировки отменена')
  recordModelAssetParse()
  const gltf = await parseGltf(loader, buffer)
  const root = new THREE.Group()
  root.name = `equipment-${entry.slot}-${entry.key}-${entry.variant}`
  root.userData = { equipmentKey: entry.key, equipmentSlot: entry.slot, equipmentVariant: entry.variant }
  root.add(gltf.scene)
  applyVisualVariant(root, entry)
  markShadows(root)
  if (signal.aborted || !validBounds(root)) {
    disposeObject(root)
    throw signal.reason ?? new Error(`Модель экипировки ${entry.key} имеет неверные границы`)
  }
  return root
}

const PART_KEYS = Object.freeze([
  'chest', 'waist', 'upper-arm-left', 'upper-arm-right', 'forearm-left', 'forearm-right',
  'thigh-left', 'thigh-right', 'shin-left', 'shin-right', 'foot-left', 'foot-right',
  'hand-left', 'hand-right', 'head', 'back', 'collar', 'brooch', 'rings', 'rings-left', 'rings-right',
])

function canonicalPartKey(value: unknown): string | null {
  const raw = text(value).replace(/^part:?/iu, '').replace(/^part(?=[a-z])/iu, '')
  const compact = raw.replace(/[^a-z\d]/giu, '').toLocaleLowerCase('en-US')
  return PART_KEYS.find((key) => key.replace(/[^a-z\d]/giu, '').toLocaleLowerCase('en-US') === compact) ?? null
}

function directParts(root: THREE.Group, names: string[]): Array<{ object: THREE.Object3D; key: string }> {
  const wanted = new Set(names.map(canonicalPartKey).filter((value): value is string => Boolean(value)))
  const result: Array<{ object: THREE.Object3D; key: string }> = []
  root.traverse((object) => {
    if (object === root) return
    const key = canonicalPartKey(object.userData?.armorPart ?? object.userData?.accessoryPart ?? object.name)
    if (key && (!wanted.size || wanted.has(key))) result.push({ object, key })
  })
  return result
}

function slotParts(loaded: LoadedModel): Array<{ object: THREE.Object3D; key: string }> {
  const { entry, root } = loaded
  if (entry.slot === 'body') {
    const parts = directParts(root, entry.parts)
    return parts.length ? parts : entry.parts.length ? [] : [{ object: root, key: 'chest' }]
  }
  if (entry.slot === 'cloak') {
    const parts = directParts(root, entry.parts.length ? entry.parts : ['back', 'collar'])
    return parts.length ? parts : entry.parts.length ? [] : [{ object: root, key: 'back' }]
  }
  if (entry.slot === 'brooch') return [{ object: root, key: 'brooch' }]
  if (entry.slot === 'ring-protection') return [{ object: root, key: 'rings-right' }]
  if (entry.slot === 'ring-fire-resistance') return [{ object: root, key: 'rings-left' }]
  return []
}

function sideForSlot(slot: EquipmentVisualSlot): EquipmentSide | null {
  if (slot === 'main_hand') return 'right'
  if (slot === 'off_hand') return 'left'
  return null
}

function normalizedLoadout(value: unknown): PublicLoadout {
  return normalizePublicLoadout(value)
}

function descriptorFor(value: unknown): EquipmentVisualDescriptor | null {
  return objectLike(value) && typeof value.model_key === 'string' ? value as EquipmentVisualDescriptor : null
}

function entryIndex(manifest: EquipmentModelManifest): Map<string, EquipmentModelManifestEntry> {
  return new Map(manifest.models.map((entry) => [`${entry.slot}:${entry.key}:${entry.variant}`, entry]))
}

function findEntry(index: Map<string, EquipmentModelManifestEntry>, slot: EquipmentVisualSlot, descriptor: EquipmentVisualDescriptor): EquipmentModelManifestEntry | null {
  const key = normalizeEquipmentModelKey(descriptor.model_key)
  if (!key) return null
  const variant = normalizeEquipmentVisualVariant(descriptor.variant) ?? 'default'
  const exact = index.get(`${slot}:${key}:${variant}`)
  if (exact) return exact
  const fallback = index.get(`${slot}:${key}:default`)
  return fallback ? { ...fallback, variant } : null
}

function rolesForPlan(plan: MountPlan): string[] {
  if (plan.loaded.entry.slot === 'body' || plan.loaded.entry.slot === 'cloak') return plan.parts.map((part) => part.key)
  if (plan.loaded.entry.slot === 'brooch') return ['brooch']
  if (plan.loaded.entry.slot === 'ring-protection') return ['rings-right']
  if (plan.loaded.entry.slot === 'ring-fire-resistance') return ['rings-left']
  return []
}

function planForLoaded(rig: EquipmentRig, loaded: LoadedModel): MountPlan {
  const side = sideForSlot(loaded.entry.slot)
  if (side) {
    if (!rig.grips[side] && !rig.diagnostics.aliases[`grip-${side}`]) throw new Error(`Для ${loaded.entry.slot} нет совместимой руки`)
    return { loaded, parts: [] }
  }
  const parts = slotParts(loaded)
  const expectedParts = new Set(loaded.entry.parts.map(canonicalPartKey).filter((value): value is string => Boolean(value)))
  if (expectedParts.size && new Set(parts.map((part) => part.key)).size !== expectedParts.size) {
    throw new Error(`У ${loaded.entry.key} отсутствуют rig-части: ${[...expectedParts].filter((key) => !parts.some((part) => part.key === key)).join(', ')}`)
  }
  for (const role of rolesForPlan({ loaded, parts })) {
    if (!rig.diagnostics.aliases[role]) throw new Error(`Для экипировки нет rig-якоря ${role}`)
  }
  return { loaded, parts }
}

function mountPlan(rig: EquipmentRig, plan: MountPlan): void {
  const { entry, root } = plan.loaded
  const side = sideForSlot(entry.slot)
  if (side) {
    if (!rig.mountHeld(root, side, { kind: entry.kind ?? entry.key, handedness: entry.handedness })) throw new Error(`Не удалось закрепить ${entry.key} в руке`)
    return
  }
  for (const part of plan.parts) if (!rig.mountPart(part.object, part.key)) throw new Error(`Не удалось закрепить ${entry.key}/${part.key}`)
  if (entry.slot === 'body' && entry.coverage.length) rig.setCoverage(entry.coverage)
}

function sameLoadout(left: PublicLoadout, right: PublicLoadout): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function linkedSignal(external: AbortSignal | undefined, controller: AbortController): { signal: AbortSignal; dispose: () => void } {
  if (!external) return { signal: controller.signal, dispose: () => undefined }
  const onAbort = () => controller.abort(external.reason)
  if (external.aborted) controller.abort(external.reason)
  else external.addEventListener('abort', onAbort, { once: true })
  return { signal: controller.signal, dispose: () => external.removeEventListener('abort', onAbort) }
}

/** Составляет видимый слой экипировки поверх уже созданного actor rig. */
export function createEquipmentController(root: THREE.Group, options: EquipmentControllerOptions): EquipmentController {
  const height = finitePositive(options?.height, 1.4)
  const profile = text(options?.profile) || 'unknown'
  const rig = createEquipmentRig(root, { height, profile })
  const loader = options?.loader ?? new GLTFLoader()
  registerCspSafeEmbeddedTextureLoader(loader)
  let disposed = false
  let status: EquipmentControllerStatus = 'idle'
  let lastError: Error | null = null
  let currentLoadout: PublicLoadout = {}
  let ready: Promise<void> = Promise.resolve()
  let generation = 0
  let activeAbort: AbortController | null = null
  let activeRoots = new Set<THREE.Group>()
  let activePlans: MountPlan[] = []
  let requestedLoadout: PublicLoadout = {}
  let retainedManifest: Promise<EquipmentModelManifest> | null = null

  const notify = () => { try { options?.onChange?.() } catch { /* callback не должен ломать рендер */ } }
  const clearActive = () => {
    rig.clear()
    for (const model of activeRoots) disposeObject(model)
    activeRoots = new Set()
    activePlans = []
  }

  const apply = async (requested: PublicLoadout, signal: AbortSignal, id: number): Promise<void> => {
    if (profile === 'beast' || profile === 'wolf' || rig.family === 'unknown') {
      if (id !== generation || disposed) return
      if (signal.aborted) throw signal.reason ?? new Error('Загрузка экипировки отменена')
      clearActive()
      currentLoadout = requested
      status = 'ready'
      lastError = null
      notify()
      return
    }
    if (!EQUIPMENT_VISUAL_SLOTS.some((slot) => descriptorFor(requested[slot]))) {
      if (id !== generation || disposed) return
      if (signal.aborted) throw signal.reason ?? new Error('Загрузка экипировки отменена')
      clearActive(); currentLoadout = {}; status = 'ready'; lastError = null; notify(); return
    }
    // Манифест мал и неизменяем в рамках выпуска. Держим его на controller,
    // чтобы каждое изменение loadout не запускало новый HTTP-запрос.
    if (!retainedManifest) {
      retainedManifest = loadEquipmentManifest({
        manifestUrl: options?.manifestUrl, fetcher: options?.fetcher,
        timeoutMs: options?.timeoutMs, maxManifestBytes: options?.maxManifestBytes,
      }).catch((error) => { retainedManifest = null; throw error })
    }
    const manifest = await retainedManifest
    if (id !== generation || disposed) return
    if (signal.aborted) throw signal.reason ?? new Error('Загрузка экипировки отменена')
    const index = entryIndex(manifest)
    const descriptors = EQUIPMENT_VISUAL_SLOTS.flatMap((slot) => {
      const descriptor = descriptorFor(requested[slot])
      if (!descriptor) return []
      const entry = findEntry(index, slot, descriptor)
      if (!entry) throw new Error(`В манифесте нет модели ${slot}/${descriptor.model_key}`)
      return [{ slot, entry }]
    })
    const settled = await Promise.allSettled(descriptors.map(({ entry }) => loadEquipmentModel(entry, options, signal, loader)))
    const loaded: LoadedModel[] = []
    let rejection: unknown = null
    for (const [index, result] of settled.entries()) {
      if (result.status === 'fulfilled') loaded.push({ entry: descriptors[index].entry, root: result.value })
      else if (!rejection) rejection = result.reason
    }
    if (rejection) {
      for (const model of loaded) disposeObject(model.root)
      throw rejection
    }
    if (id !== generation || disposed) {
      for (const model of loaded) disposeObject(model.root)
      return
    }
    if (signal.aborted) {
      for (const model of loaded) disposeObject(model.root)
      throw signal.reason ?? new Error('Загрузка экипировки отменена')
    }
    let plans: MountPlan[]
    try {
      plans = loaded.map((model) => planForLoaded(rig, model))
    } catch (error) {
      for (const model of loaded) disposeObject(model.root)
      throw error
    }
    const previousRoots = activeRoots
    const previousPlans = activePlans
    rig.clear()
    try {
      for (const plan of plans) mountPlan(rig, plan)
    } catch (error) {
      rig.clear()
      try {
        for (const plan of previousPlans) mountPlan(rig, plan)
        activeRoots = previousRoots
        activePlans = previousPlans
      } catch {
        for (const model of previousRoots) disposeObject(model)
        activeRoots = new Set()
        activePlans = []
      }
      for (const model of loaded) disposeObject(model.root)
      throw error
    }
    for (const model of previousRoots) disposeObject(model)
    activeRoots = new Set(loaded.map((model) => model.root))
    activePlans = plans
    currentLoadout = requested
    status = 'ready'
    lastError = null
    notify()
  }

  const setLoadout = (value: unknown): Promise<void> => {
    if (disposed) return Promise.resolve()
    const requested = normalizedLoadout(value)
    if (sameLoadout(requested, currentLoadout) && status !== 'error') {
      requestedLoadout = requested
      if (activeAbort) {
        generation += 1
        activeAbort.abort(new Error('Предыдущая загрузка экипировки устарела'))
        activeAbort = null
        status = 'ready'
        ready = Promise.resolve()
      }
      return ready
    }
    if (sameLoadout(requested, requestedLoadout) && status !== 'error') return ready
    requestedLoadout = requested
    generation += 1
    const id = generation
    activeAbort?.abort(new Error('Предыдущая загрузка экипировки устарела'))
    const controller = new AbortController()
    activeAbort = controller
    const linked = linkedSignal(options?.signal, controller)
    status = 'loading'
    lastError = null
    const work = apply(requested, linked.signal, id)
      .catch((error: unknown) => {
        if (id !== generation || disposed) return
        if (linked.signal.aborted) {
          clearActive()
          currentLoadout = requested
          status = 'ready'
          lastError = null
          notify()
          return
        }
        clearActive()
        currentLoadout = requested
        lastError = error instanceof Error ? error : new Error(String(error))
        status = 'error'
        notify()
      })
      .finally(() => {
        linked.dispose()
        if (activeAbort === controller) activeAbort = null
      })
    ready = work
    return work
  }

  const controller: EquipmentController = {
    get ready() { return ready },
    get loadout() { return currentLoadout },
    get status() { return status },
    get error() { return lastError },
    rig,
    setLoadout,
    dispose: () => {
      if (disposed) return
      disposed = true
      generation += 1
      activeAbort?.abort(new Error('Экипировка освобождена'))
      activeAbort = null
      clearActive()
      rig.dispose()
      status = 'disposed'
      lastError = null
      currentLoadout = {}
      requestedLoadout = {}
    },
  }
  return controller
}

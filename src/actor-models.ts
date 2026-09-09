import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Box3,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  LoopOnce,
  LoopRepeat,
  Material,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TextureLoader,
  TorusGeometry,
  Vector3,
} from 'three'
import { GLTFLoader, type GLTF, type GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * Визуальная модель участника боя. Это слой отображения: `actorId` никогда не
 * используется для принятия решения о допустимости хода.
 */
export type ActorKind = 'hero' | 'enemy' | 'summon' | 'neutral'
export type ActorPose = 'idle' | 'walk' | 'attack' | 'cast' | 'hit' | 'death'
export type ActorModelProfile = 'warrior' | 'mage' | 'rogue' | 'goblin' | 'skeleton' | 'beast'

export type ActorModelInput = {
  id: string
  label: string
  kind: ActorKind
  modelKey?: string
  archetype?: string
  /** Локальный акцент игрока из карточки персонажа. */
  color?: string
}

export type NormalizedActorModelInput = Omit<ActorModelInput, 'modelKey' | 'archetype' | 'color'> & {
  modelKey?: string
  archetype?: string
  color?: string
}

export type ModelRights = {
  /** Откуда взят GLB или кто создал процедурную модель. */
  source: string
  /** SPDX-идентификатор либо `original`. */
  license: string
  attribution?: string
  notes?: string
}

export type ActorModelManifestEntry = {
  key: string
  name_ru?: string
  profile: ActorModelProfile
  /** Идентификаторы, которым этот вариант назначается без `modelKey`. */
  actorIds?: string[]
  /** Значения `characterClass`, `creature_type` или локального выбора игрока. */
  archetypes?: string[]
  /** Только self-contained GLB под `/assets/models/`; null означает fallback. */
  url?: string | null
  /** Высота в клетках; отсутствие значения означает 1.4. */
  height?: number
  rights: ModelRights
}

export type ActorModelManifest = {
  version: 1
  models: ActorModelManifestEntry[]
}

export type ActorModelChoice = {
  key: string
  label: string
  profile: ActorModelProfile
  source: 'glb' | 'procedural'
  actorIds: string[]
  archetypes: string[]
}

export type ActorModel = Group & {
  actorId: string
  actorLabel: string
  modelKey: string
  profile: ActorModelProfile
  source: 'glb' | 'procedural'
  /** Высота после нормализации. Нижняя точка модели находится на y = 0. */
  modelHeight: number
  /** Останавливает анимацию и освобождает геометрию, материалы и текстуры. */
  dispose: () => void
  /** Устанавливает нормализованную позу; для GLB можно передать progress 0..1. */
  setPose: (pose: ActorPose, progress?: number) => void
  /** Продвигает GLB mixer; у процедурной модели это безопасная пустая операция. */
  update: (deltaSeconds: number) => void
  idle?: (progress?: number) => void
  walk?: (progress?: number) => void
  attack?: (progress?: number) => void
  cast?: (progress?: number) => void
  hit?: (progress?: number) => void
  death?: (progress?: number) => void
}

export type ActorModelOptions = {
  manifest?: ActorModelManifest
  /** Алиас `manifest` для компонентов, где каталог уже называется catalog. */
  catalog?: ActorModelManifest
  /** Одноразовый browser override, если не хочется менять входной объект. */
  modelKey?: string
  manifestUrl?: string
  fetcher?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
  maxManifestBytes?: number
  maxGlbBytes?: number
  height?: number
  loader?: GLTFLoader
}

const DEFAULT_HEIGHT = 1.4
const DEFAULT_MANIFEST_URL = '/assets/models/manifest.json'
const DEFAULT_MAX_MANIFEST_BYTES = 256 * 1024
const DEFAULT_MAX_GLB_BYTES = 16 * 1024 * 1024
const MODEL_ROOT = '/assets/models/'
const MODEL_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u
const ACTOR_PROFILES: readonly ActorModelProfile[] = ['warrior', 'mage', 'rogue', 'goblin', 'skeleton', 'beast']
const ACTOR_KINDS: readonly ActorKind[] = ['hero', 'enemy', 'summon', 'neutral']

const profileLabels: Record<ActorModelProfile, string> = {
  warrior: 'Воин', mage: 'Волшебник', rogue: 'Плут / следопыт', goblin: 'Гоблин', skeleton: 'Скелет', beast: 'Зверь',
}

/** Встроенный каталог позволяет начать бой при недоступном manifest.json. */
export const DEFAULT_ACTOR_MODEL_MANIFEST: ActorModelManifest = {
  version: 1,
  models: ACTOR_PROFILES.map((profile) => ({
    key: profile,
    name_ru: profileLabels[profile],
    profile,
    actorIds: [],
    archetypes: [profile],
    url: null,
    height: profile === 'goblin' || profile === 'beast' ? 1.18 : DEFAULT_HEIGHT,
    rights: { source: 'Процедурная модель проекта «Сказание»', license: 'original', attribution: 'Проект «Сказание»' },
  })),
}

const manifestCache = new Map<string, Promise<ActorModelManifest>>()
const glbBufferCache = new Map<string, Promise<ArrayBuffer>>()
const cspSafeTextureLoaders = new WeakSet<GLTFLoader>()

function objectLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function slug(value: string): string {
  return value.trim().toLocaleLowerCase('ru-RU').replace(/[ё]/gu, 'е').replace(/[^\p{L}\p{N}]+/gu, '-')
}

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function isProfile(value: unknown): value is ActorModelProfile {
  return typeof value === 'string' && (ACTOR_PROFILES as readonly string[]).includes(value)
}

function isActorKind(value: unknown): value is ActorKind {
  return typeof value === 'string' && (ACTOR_KINDS as readonly string[]).includes(value)
}

/**
 * Проверяет путь до модели до того, как он попадёт в fetch. Внешние CDN,
 * data-URL и `..` намеренно запрещены: каталог ассетов должен быть локальным.
 */
export function safeModelUrl(value: unknown): string | null {
  const raw = text(value)
  if (!raw || raw.includes('\\') || raw.includes('%') || raw.includes('?') || raw.includes('#') || raw.startsWith('//') || /^[a-z][a-z\d+.-]*:/iu.test(raw)) return null
  const path = raw.startsWith('/') ? raw : `${MODEL_ROOT}${raw}`
  const pieces = path.split('/')
  if (!path.startsWith(MODEL_ROOT) || pieces.includes('..') || !path.toLocaleLowerCase('en-US').endsWith('.glb')) return null
  return path
}

function safeManifestUrl(value: unknown): string | null {
  const raw = text(value)
  if (!raw || raw.includes('\\') || raw.includes('%') || raw.includes('?') || raw.includes('#') || raw.startsWith('//') || /^[a-z][a-z\d+.-]*:/iu.test(raw)) return null
  const path = raw.startsWith('/') ? raw : `${MODEL_ROOT}${raw}`
  if (!path.startsWith(MODEL_ROOT) || path.split('/').includes('..') || !path.toLocaleLowerCase('en-US').endsWith('.json')) return null
  return path
}

function normalizedList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : []
}

/**
 * Валидирует внешний каталог моделей и возвращает копию с нормальными
 * необязательными полями. Ошибка каталога не ломает бой: `createActorModel`
 * перехватывает её и использует встроенные процедурные модели.
 */
export function validateModelManifest(value: unknown): ActorModelManifest {
  if (!objectLike(value) || value.version !== 1 || !Array.isArray(value.models)) throw new Error('Каталог 3D-моделей должен иметь version=1 и массив models')
  const keys = new Set<string>()
  const actorIds = new Set<string>()
  const models = value.models.map((raw, index): ActorModelManifestEntry => {
    if (!objectLike(raw)) throw new Error(`Модель ${index + 1} имеет неверную форму`)
    const key = text(raw.key)
    if (!MODEL_KEY_PATTERN.test(key) || keys.has(key)) throw new Error(`Недопустимый или повторный ключ модели: ${key || index + 1}`)
    if (!isProfile(raw.profile)) throw new Error(`Неизвестный профиль модели: ${text(raw.profile)}`)
    keys.add(key)
    const url = raw.url == null || raw.url === '' ? null : safeModelUrl(raw.url)
    if (raw.url != null && raw.url !== '' && !url) throw new Error(`Модель ${key} должна ссылаться на локальный self-contained .glb`)
    const rights = objectLike(raw.rights) ? raw.rights : null
    if (!rights || !text(rights.source) || !text(rights.license)) throw new Error(`У модели ${key} отсутствуют rights.source или rights.license`)
    const ids = normalizedList(raw.actorIds)
    for (const id of ids) {
      if (actorIds.has(id)) throw new Error(`actorId ${id} назначен нескольким моделям`)
      actorIds.add(id)
    }
    const archetypes = normalizedList(raw.archetypes)
    const height = raw.height == null ? undefined : finitePositive(raw.height, 0)
    if (raw.height != null && (!height || height > 8)) throw new Error(`Высота модели ${key} должна быть в диапазоне 0..8`)
    return {
      key,
      name_ru: text(raw.name_ru) || profileLabels[raw.profile],
      profile: raw.profile,
      actorIds: ids,
      archetypes,
      url,
      ...(height ? { height } : {}),
      rights: {
        source: text(rights.source), license: text(rights.license),
        ...(text(rights.attribution) ? { attribution: text(rights.attribution) } : {}),
        ...(text(rights.notes) ? { notes: text(rights.notes) } : {}),
      },
    }
  })
  return { version: 1, models }
}

export function normalizeActorInput(input: ActorModelInput): NormalizedActorModelInput {
  if (!objectLike(input)) throw new Error('Для фигурки нужен объект участника')
  const id = text(input.id)
  if (!id) throw new Error('Для фигурки нужен actor id')
  return {
    id,
    label: text(input.label) || id,
    kind: isActorKind(input.kind) ? input.kind : 'neutral',
    ...(text(input.modelKey) ? { modelKey: text(input.modelKey) } : {}),
    ...(text(input.archetype) ? { archetype: text(input.archetype) } : {}),
    ...(text(input.color) ? { color: text(input.color) } : {}),
  }
}

function profileFromText(value: string): ActorModelProfile | null {
  const token = slug(value)
  if (!token) return null
  if (/(goblin|гоблин|goblinoid|гоблиноид)/u.test(token)) return 'goblin'
  if (/(skeleton|скелет|undead|нежить|zombie|зомби)/u.test(token)) return 'skeleton'
  if (/(beast|звер|wolf|волк|bear|медвед|boar|кабан|lion|лев|tiger|тигр|summon)/u.test(token)) return 'beast'
  if (/(mage|wizard|волшеб|маг|sorcer|чарод|warlock|колдун|cleric|жрец|druid|друид)/u.test(token)) return 'mage'
  if (/(rogue|плут|ranger|следопыт|scout|разведчик|thief|вор)/u.test(token)) return 'rogue'
  if (/(warrior|воин|fighter|боец|paladin|паладин|knight|рыцарь|barbarian|варвар)/u.test(token)) return 'warrior'
  return null
}

function fallbackProfile(input: NormalizedActorModelInput): ActorModelProfile {
  // Неизвестный гуманоидный враг — воинская нейтральная форма. Зелёный
  // гоблин допустим только когда это видно из имени/архетипа; иначе модель
  // начинает сообщать игроку расу, которой сервер не объявлял.
  return profileFromText(input.archetype ?? '') ?? profileFromText(input.label) ?? (input.kind === 'summon' ? 'beast' : 'warrior')
}

/** Возвращает выбранную запись каталога без сетевых запросов. */
export function resolveModelProfile(input: ActorModelInput, manifest: ActorModelManifest = DEFAULT_ACTOR_MODEL_MANIFEST): ActorModelManifestEntry {
  const actor = normalizeActorInput(input)
  const catalog = validateModelManifest(manifest)
  const explicit = actor.modelKey ? catalog.models.find((entry) => entry.key === actor.modelKey) : undefined
  if (explicit) return explicit
  const byActorId = catalog.models.find((entry) => entry.actorIds?.includes(actor.id))
  if (byActorId) return byActorId
  const requestedArchetype = slug(actor.archetype ?? '')
  // Сначала точное значение из каталога: запись `humanoid` или конкретный
  // класс должна иметь приоритет над fuzzy-профилем из более ранней строки.
  const byExactArchetype = requestedArchetype
    ? catalog.models.find((entry) => entry.archetypes?.some((item) => slug(item) === requestedArchetype))
    : undefined
  if (byExactArchetype) return byExactArchetype
  const requestedProfile = profileFromText(actor.archetype ?? '')
  const byProfile = requestedProfile ? catalog.models.find((entry) => entry.profile === requestedProfile) : undefined
  if (byProfile) return byProfile
  const profile = fallbackProfile(actor)
  return catalog.models.find((entry) => entry.profile === profile) ?? DEFAULT_ACTOR_MODEL_MANIFEST.models.find((entry) => entry.profile === profile)!
}

/** Данные для select/дисклозера в браузере; состояние выбора может жить в localStorage. */
export function availableActorModels(manifest: ActorModelManifest = DEFAULT_ACTOR_MODEL_MANIFEST): ActorModelChoice[] {
  return validateModelManifest(manifest).models.map((entry) => ({
    key: entry.key,
    label: entry.name_ru || profileLabels[entry.profile],
    profile: entry.profile,
    source: entry.url ? 'glb' : 'procedural',
    actorIds: [...(entry.actorIds ?? [])],
    archetypes: [...(entry.archetypes ?? [])],
  }))
}

/** Удобное имя для UI-кода, где записи каталога называются options. */
export function actorModelOptions(manifest: ActorModelManifest = DEFAULT_ACTOR_MODEL_MANIFEST): Array<{ id: string; label: string }> {
  return availableActorModels(manifest).map((choice) => ({ id: choice.key, label: choice.label }))
}

/** Совместимое имя для загрузчика, используемого боевой доской. */
export const loadActorModelCatalog = loadActorModelManifest

async function boundedFetch(fetcher: typeof fetch, url: string, options: { signal?: AbortSignal; timeoutMs: number; maxBytes: number }): Promise<ArrayBuffer> {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('Загрузка отменена')
  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('Превышено время загрузки модели')), options.timeoutMs)
  try {
    // Каталог и GLB имеют постоянные имена. Перепроверяем ETag после загрузки
    // страницы, чтобы новая модель не оставалась в часовом кеше public/.
    const response = await fetcher(url, { signal: controller.signal, cache: 'no-cache' })
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error('Загрузка отменена')
    if (!response.ok) throw new Error(`Не удалось загрузить ${url}: HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > options.maxBytes) throw new Error(`Файл ${url} превышает лимит размера`)
    const buffer = await response.arrayBuffer()
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error('Загрузка отменена')
    if (buffer.byteLength > options.maxBytes) throw new Error(`Файл ${url} превышает лимит размера`)
    return buffer
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

export async function loadActorModelManifest(options: Pick<ActorModelOptions, 'manifestUrl' | 'fetcher' | 'signal' | 'timeoutMs' | 'maxManifestBytes'> = {}): Promise<ActorModelManifest> {
  const url = safeManifestUrl(options.manifestUrl ?? DEFAULT_MANIFEST_URL)
  if (!url) throw new Error('manifestUrl должен указывать на локальный /assets/models/*.json')
  const fetcher = options.fetcher ?? fetch
  const maxBytes = options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES
  const timeoutMs = Math.max(250, Math.min(30_000, options.timeoutMs ?? 5_000))
  const cacheable = !options.fetcher && !options.signal
  let promise = cacheable ? manifestCache.get(url) : undefined
  if (!promise) {
    promise = boundedFetch(fetcher, url, { signal: options.signal, timeoutMs, maxBytes })
      .then((buffer) => validateModelManifest(JSON.parse(new TextDecoder().decode(buffer))))
    if (cacheable) manifestCache.set(url, promise)
  }
  try { return await promise } catch (error) {
    if (cacheable && manifestCache.get(url) === promise) manifestCache.delete(url)
    throw error
  }
}

type GlbJson = Record<string, unknown>
export type GlbValidation = { json: GlbJson; byteLength: number; hasBinaryChunk: boolean }

function collectUris(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => collectUris(item, `${path}[${index}]`))
  if (!objectLike(value)) return []
  const found: string[] = []
  for (const [key, item] of Object.entries(value)) {
    if (key === 'uri' && text(item)) found.push(`${path}.uri`)
    else found.push(...collectUris(item, `${path}.${key}`))
  }
  return found
}

/** Проверяет контейнер GLB и запрещает встроенным данным ссылаться наружу. */
export function validateGlbContainer(value: ArrayBuffer | Uint8Array, maxBytes = DEFAULT_MAX_GLB_BYTES): GlbValidation {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  if (bytes.byteLength > maxBytes) throw new Error('GLB превышает лимит размера')
  if (bytes.byteLength < 20) throw new Error('GLB слишком короткий')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) throw new Error('Ожидался GLB версии 2')
  const declaredLength = view.getUint32(8, true)
  if (declaredLength !== bytes.byteLength) throw new Error('Размер GLB не совпадает с заголовком')
  let offset = 12
  let json: GlbJson | null = null
  let hasBinaryChunk = false
  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = view.getUint32(offset, true)
    const chunkType = view.getUint32(offset + 4, true)
    offset += 8
    if (offset + chunkLength > bytes.byteLength) throw new Error('Повреждённый chunk GLB')
    if (chunkType === 0x4e4f534a) {
      const raw = new TextDecoder().decode(bytes.subarray(offset, offset + chunkLength)).replace(/\0+$/u, '').trim()
      try { json = JSON.parse(raw) as GlbJson } catch { throw new Error('JSON chunk GLB не разобран') }
    } else if (chunkType === 0x004e4942) {
      hasBinaryChunk = true
    }
    offset += chunkLength
  }
  if (offset !== bytes.byteLength || !json) throw new Error('В GLB отсутствует JSON chunk')
  const version = objectLike(json.asset) ? text(json.asset.version) : ''
  if (!version.startsWith('2')) throw new Error('GLB должен содержать asset.version 2.x')
  const uris = collectUris(json)
  if (uris.length) throw new Error(`GLB содержит внешние ресурсы: ${uris[0]}`)
  const buffers = Array.isArray(json.buffers) ? json.buffers : []
  if (buffers.some((item) => !objectLike(item) || item.byteLength == null)) throw new Error('GLB содержит buffer без embedded byteLength')
  const images = Array.isArray(json.images) ? json.images : []
  if (images.some((item) => !objectLike(item) || item.bufferView == null)) throw new Error('Изображение GLB должно быть встроено через bufferView')
  return { json, byteLength: bytes.byteLength, hasBinaryChunk }
}

async function loadGlbBuffer(url: string, options: ActorModelOptions): Promise<ArrayBuffer> {
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = Math.max(250, Math.min(30_000, options.timeoutMs ?? 8_000))
  const maxBytes = options.maxGlbBytes ?? DEFAULT_MAX_GLB_BYTES
  const cacheable = !options.fetcher && !options.signal
  let promise = cacheable ? glbBufferCache.get(url) : undefined
  if (!promise) {
    promise = boundedFetch(fetcher, url, { signal: options.signal, timeoutMs, maxBytes })
      .then((buffer) => { validateGlbContainer(buffer, maxBytes); return buffer })
    if (cacheable) glbBufferCache.set(url, promise)
  }
  try { return await promise } catch (error) {
    if (cacheable && glbBufferCache.get(url) === promise) glbBufferCache.delete(url)
    throw error
  }
}

/** Очищает кэш байтов; уже созданные фигурки продолжают владеть своими ресурсами. */
export function clearActorModelCache(url?: string): void {
  if (url) {
    const modelUrl = safeModelUrl(url)
    const manifestUrl = safeManifestUrl(url)
    if (modelUrl) glbBufferCache.delete(modelUrl)
    if (manifestUrl) manifestCache.delete(manifestUrl)
  } else {
    glbBufferCache.clear()
    manifestCache.clear()
  }
}

function material(hex: string, options: { metalness?: number; roughness?: number; emissive?: string } = {}): MeshStandardMaterial {
  const result = new MeshStandardMaterial({
    color: hex,
    roughness: options.roughness ?? .78,
    metalness: options.metalness ?? .08,
    flatShading: true,
  })
  if (options.emissive) { result.emissive = new Color(options.emissive); result.emissiveIntensity = .45 }
  return result
}

function maybeColor(value: string | undefined, fallback: string): string {
  if (!value) return fallback
  try { return `#${new Color(value).getHexString()}` } catch { return fallback }
}

function mesh<T extends BufferGeometry>(parent: Object3D, geometry: T, surface: Material, name: string, position?: [number, number, number], rotation?: [number, number, number]): Mesh<T, Material> {
  const result = new Mesh(geometry, surface)
  result.name = name
  result.castShadow = true
  result.receiveShadow = true
  if (position) result.position.set(...position)
  if (rotation) result.rotation.set(...rotation)
  parent.add(result)
  return result
}

function cube(parent: Object3D, name: string, size: [number, number, number], surface: Material, position: [number, number, number], rotation?: [number, number, number]) {
  return mesh(parent, new BoxGeometry(...size), surface, name, position, rotation)
}

function cylinder(parent: Object3D, name: string, radiusTop: number, radiusBottom: number, height: number, surface: Material, position: [number, number, number], rotation?: [number, number, number], segments = 8) {
  return mesh(parent, new CylinderGeometry(radiusTop, radiusBottom, height, segments), surface, name, position, rotation)
}

function cone(parent: Object3D, name: string, radius: number, height: number, surface: Material, position: [number, number, number], rotation?: [number, number, number], segments = 8) {
  return mesh(parent, new ConeGeometry(radius, height, segments), surface, name, position, rotation)
}

function sphere(parent: Object3D, name: string, radius: number, surface: Material, position: [number, number, number], scale?: [number, number, number]) {
  const result = mesh(parent, new SphereGeometry(radius, 10, 6), surface, name, position)
  if (scale) result.scale.set(...scale)
  return result
}

function limb(parent: Object3D, name: string, from: Vector3, to: Vector3, radius: number, surface: Material): Mesh<CylinderGeometry, Material> {
  const direction = new Vector3().subVectors(to, from)
  const result = cylinder(parent, name, radius, radius * 1.08, direction.length(), surface, [0, 0, 0], undefined, 8)
  result.position.copy(from).add(to).multiplyScalar(.5)
  result.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize())
  return result
}

type Rig = {
  motion: Group
  parts: Map<string, Object3D>
  rest: Map<Object3D, { position: Vector3; rotation: { x: number; y: number; z: number } }>
}

function registerPart(rig: Rig, key: string, part: Object3D): Object3D {
  part.name = `rig-${key}`
  rig.parts.set(key, part)
  rig.rest.set(part, { position: part.position.clone(), rotation: { x: part.rotation.x, y: part.rotation.y, z: part.rotation.z } })
  return part
}

function newRig(root: Group): Rig {
  const motion = new Group()
  motion.name = 'actor-motion'
  root.add(motion)
  return { motion, parts: new Map(), rest: new Map() }
}

function part(rig: Rig, key: string, position: [number, number, number]): Group {
  const result = new Group()
  result.position.set(...position)
  registerPart(rig, key, result)
  rig.motion.add(result)
  return result
}

function resetRig(rig: Rig) {
  rig.motion.position.set(0, 0, 0)
  rig.motion.rotation.set(0, 0, 0)
  for (const [object, rest] of rig.rest) {
    object.position.copy(rest.position)
    object.rotation.set(rest.rotation.x, rest.rotation.y, rest.rotation.z)
  }
}

function applyProceduralPose(rig: Rig, pose: ActorPose, progress: number): void {
  resetRig(rig)
  const p = MathUtils.clamp(progress, 0, 1)
  const wave = Math.sin(p * Math.PI * 2)
  const leftArm = rig.parts.get('leftArm')
  const rightArm = rig.parts.get('rightArm')
  const leftLeg = rig.parts.get('leftLeg')
  const rightLeg = rig.parts.get('rightLeg')
  const torso = rig.parts.get('torso')
  const head = rig.parts.get('head')
  if (pose === 'idle') {
    rig.motion.position.y = Math.abs(wave) * .008
    if (head) head.rotation.y = wave * .035
    if (leftArm) leftArm.rotation.z = wave * .025
    if (rightArm) rightArm.rotation.z = -wave * .025
  } else if (pose === 'walk') {
    const stride = Math.sin(p * Math.PI * 2)
    if (leftLeg) leftLeg.rotation.x = stride * .48
    if (rightLeg) rightLeg.rotation.x = -stride * .48
    if (leftArm) leftArm.rotation.x = -stride * .3
    if (rightArm) rightArm.rotation.x = stride * .3
    rig.motion.position.y = Math.abs(stride) * .025
  } else if (pose === 'attack') {
    const swing = Math.sin(MathUtils.clamp(p, 0, 1) * Math.PI)
    if (rightArm) rightArm.rotation.z = -1.05 + swing * 1.7
    if (leftArm) leftArm.rotation.z = .18 - swing * .2
    if (torso) torso.rotation.y = -.22 + swing * .42
    rig.motion.position.z = -swing * .045
  } else if (pose === 'cast') {
    const lift = Math.sin(MathUtils.clamp(p, 0, 1) * Math.PI)
    if (leftArm) { leftArm.rotation.z = .7 - lift * .9; leftArm.rotation.x = -.35 }
    if (rightArm) { rightArm.rotation.z = -.7 + lift * .9; rightArm.rotation.x = -.35 }
    if (head) head.rotation.x = -.08
    rig.motion.position.y = lift * .02
  } else if (pose === 'hit') {
    const recoil = Math.sin(MathUtils.clamp(p, 0, 1) * Math.PI)
    rig.motion.rotation.z = recoil * .12
    rig.motion.position.z = recoil * .07
    if (head) head.rotation.x = recoil * .12
  } else if (pose === 'death') {
    const fall = MathUtils.clamp(p, 0, 1)
    rig.motion.rotation.z = fall * 1.32
    rig.motion.position.y = -fall * .06
    if (leftArm) leftArm.rotation.z = fall * .8
    if (rightArm) rightArm.rotation.z = -fall * .8
  }
}

function base(root: Group, accent: string, neutral = '#665b4d') {
  cylinder(root, 'miniature-base', .29, .34, .05, material(neutral, { metalness: .32, roughness: .58 }), [0, .025, 0], undefined, 24)
  cylinder(root, 'miniature-base-inlay', .205, .205, .008, material(accent, { metalness: .25, roughness: .55 }), [0, .055, 0], undefined, 24)
  mesh(root, new TorusGeometry(.28, .012, 5, 24), material('#b49b73', { metalness: .45, roughness: .5 }), 'miniature-base-rim', [0, .058, 0], [0, 0, 0])
}

type Palette = { skin: string; cloth: string; clothDark: string; metal: string; leather: string; wood: string; bone: string; accent: string }

const PALETTES: Record<ActorModelProfile, Palette> = {
  warrior: { skin: '#9a7864', cloth: '#6f3e3d', clothDark: '#292d35', metal: '#77808a', leather: '#46382f', wood: '#594336', bone: '#d2c2a5', accent: '#587ca5' },
  mage: { skin: '#94766d', cloth: '#3f4d6b', clothDark: '#202b42', metal: '#9d8b62', leather: '#4a3a33', wood: '#674b35', bone: '#c4b593', accent: '#7d8ec0' },
  rogue: { skin: '#987967', cloth: '#59614b', clothDark: '#252b2a', metal: '#6f7777', leather: '#5b3f2c', wood: '#5b4233', bone: '#c9b89e', accent: '#72907a' },
  goblin: { skin: '#66764e', cloth: '#76533c', clothDark: '#293a2b', metal: '#81766b', leather: '#4b3529', wood: '#573c2d', bone: '#c9b58e', accent: '#8b7152' },
  skeleton: { skin: '#c9bea1', cloth: '#2d2f36', clothDark: '#16181d', metal: '#666d73', leather: '#4a3629', wood: '#563c2e', bone: '#e1d3b0', accent: '#9c5960' },
  beast: { skin: '#766451', cloth: '#4f443a', clothDark: '#26221f', metal: '#7b766c', leather: '#4b3529', wood: '#533b2d', bone: '#c6b494', accent: '#9c7151' },
}

function addSword(parent: Object3D, surface: Material, guard: Material, name = 'sword') {
  const weapon = new Group(); weapon.name = name
  cube(weapon, `${name}-blade`, [.035, .34, .014], surface, [0, .18, 0])
  cube(weapon, `${name}-point`, [.025, .07, .014], surface, [0, .385, 0], [0, 0, Math.PI / 4])
  cube(weapon, `${name}-guard`, [.16, .025, .035], guard, [0, .01, 0])
  cylinder(weapon, `${name}-grip`, .022, .022, .13, guard, [0, -.065, 0], undefined, 6)
  sphere(weapon, `${name}-pommel`, .035, guard, [0, -.145, 0])
  parent.add(weapon)
  return weapon
}

function addShield(parent: Object3D, surface: Material, rim: Material) {
  const shield = new Group(); shield.name = 'shield'
  mesh(shield, new CylinderGeometry(.18, .18, .045, 8), surface, 'shield-face', [0, 0, 0], [Math.PI / 2, 0, 0])
  mesh(shield, new TorusGeometry(.17, .012, 5, 16), rim, 'shield-rim', [0, 0, -.026], [Math.PI / 2, 0, 0])
  sphere(shield, 'shield-boss', .038, rim, [0, 0, -.045])
  parent.add(shield)
  return shield
}

function addStaff(parent: Object3D, wood: Material, crystal: Material) {
  const staff = new Group(); staff.name = 'staff'
  cylinder(staff, 'staff-shaft', .018, .026, .68, wood, [0, .18, 0], undefined, 7)
  sphere(staff, 'staff-crystal', .065, crystal, [0, .54, 0], [.85, 1.2, .85])
  mesh(staff, new TorusGeometry(.078, .008, 5, 12), crystal, 'staff-ring', [0, .54, 0], [Math.PI / 2, 0, 0])
  parent.add(staff)
  return staff
}

function addBow(parent: Object3D, wood: Material, string: Material) {
  const bow = new Group(); bow.name = 'bow'
  mesh(bow, new TorusGeometry(.22, .014, 5, 18, Math.PI), wood, 'bow-limb', [0, .17, 0], [Math.PI / 2, 0, Math.PI / 2])
  cylinder(bow, 'bow-grip', .018, .018, .11, wood, [0, .01, 0], undefined, 6)
  cylinder(bow, 'bow-string', .006, .006, .42, string, [0, .17, 0], [0, 0, 0], 5)
  parent.add(bow)
  return bow
}

function addHumanoidParts(root: Group, profile: ActorModelProfile, palette: Palette, input: NormalizedActorModelInput): Rig {
  const rig = newRig(root)
  const torso = part(rig, 'torso', [0, .69, 0])
  const pelvis = part(rig, 'pelvis', [0, .48, 0])
  const head = part(rig, 'head', [0, 1.12, 0])
  const leftArm = part(rig, 'leftArm', [-.24, .88, 0])
  const rightArm = part(rig, 'rightArm', [.24, .88, 0])
  const leftLeg = part(rig, 'leftLeg', [-.105, .48, 0])
  const rightLeg = part(rig, 'rightLeg', [.105, .48, 0])

  const bodySurface = material(palette.cloth)
  const darkSurface = material(palette.clothDark)
  const skin = material(palette.skin)
  const leather = material(palette.leather)
  const metal = material(palette.metal, { metalness: .48, roughness: .52 })
  const bone = material(palette.bone, { roughness: .86 })
  const wood = material(palette.wood)

  if (profile === 'mage') {
    mesh(torso, new ConeGeometry(.28, .58, 9), bodySurface, 'mage-robe', [0, 0, 0])
    cylinder(torso, 'mage-belt', .22, .22, .035, leather, [0, -.18, 0], undefined, 12)
  } else {
    cylinder(torso, 'torso-armor', .215, .26, .43, bodySurface, [0, 0, 0], undefined, 8)
    cube(torso, 'torso-panel', [.22, .23, .035], profile === 'warrior' ? metal : darkSurface, [0, .015, -.21])
    cylinder(pelvis, 'belt', .22, .22, .07, leather, [0, 0, 0], undefined, 10)
  }
  cube(pelvis, 'hip-cloth', [.27, .15, .18], darkSurface, [0, -.04, 0])

  for (const [arm, side] of [[leftArm, -1] as const, [rightArm, 1] as const]) {
    cylinder(arm, `${side < 0 ? 'left' : 'right'}-upper-arm`, .052, .064, .22, profile === 'skeleton' ? bone : bodySurface, [0, -.12, 0], undefined, 7)
    sphere(arm, `${side < 0 ? 'left' : 'right'}-shoulder`, .075, profile === 'warrior' ? metal : bodySurface, [0, -.015, 0])
    cylinder(arm, `${side < 0 ? 'left' : 'right'}-forearm`, .042, .052, .19, profile === 'skeleton' ? bone : leather, [0, -.315, 0], undefined, 7)
    sphere(arm, `${side < 0 ? 'left' : 'right'}-hand`, .047, profile === 'skeleton' ? bone : skin, [0, -.42, 0])
  }
  for (const [leg, side] of [[leftLeg, -1] as const, [rightLeg, 1] as const]) {
    cylinder(leg, `${side < 0 ? 'left' : 'right'}-leg`, .065, .075, .32, profile === 'skeleton' ? bone : darkSurface, [0, -.17, 0], undefined, 7)
    cube(leg, `${side < 0 ? 'left' : 'right'}-boot`, [.12, .11, .22], leather, [0, -.36, -.045])
  }
  sphere(head, 'head-shape', .145, profile === 'skeleton' ? bone : skin, [0, 0, 0], profile === 'goblin' ? [1.05, 1.1, .9] : undefined)

  if (profile === 'warrior') {
    cylinder(head, 'helmet', .16, .19, .13, metal, [0, .06, 0], undefined, 10)
    mesh(head, new TorusGeometry(.15, .018, 5, 16), metal, 'helmet-rim', [0, 0, 0])
    cone(head, 'helmet-crest', .035, .14, material(palette.accent), [0, .17, 0], [0, 0, 0])
    const sword = addSword(rightArm, metal, leather)
    sword.position.set(0, -.39, -.02)
    sword.rotation.z = -.12
    const shield = addShield(leftArm, material('#475b66'), metal)
    shield.position.set(0, -.3, -.04)
  } else if (profile === 'mage') {
    mesh(head, new ConeGeometry(.2, .24, 9), bodySurface, 'mage-hood', [0, .08, 0])
    cylinder(head, 'mage-hood-band', .15, .16, .035, leather, [0, -.015, 0], undefined, 10)
    const staff = addStaff(leftArm, wood, material(palette.accent, { emissive: palette.accent, roughness: .42 }))
    staff.position.set(0, -.37, .04); staff.rotation.z = -.12
    sphere(rightArm, 'spell-focus', .045, material(palette.accent, { emissive: palette.accent, roughness: .35 }), [0, -.42, -.02])
  } else if (profile === 'rogue') {
    mesh(head, new ConeGeometry(.175, .21, 8), darkSurface, 'rogue-hood', [0, .045, .01])
    cube(head, 'rogue-scarf', [.18, .055, .18], material('#6e503a'), [0, -.09, -.03])
    const bow = addBow(rightArm, wood, material('#af9b7a'))
    bow.position.set(0, -.28, -.035); bow.rotation.z = -.26
    addSword(leftArm, metal, leather, 'short-blade').position.set(0, -.37, -.02)
    cube(torso, 'quiver', [.07, .22, .07], leather, [-.19, .02, .08], [.2, 0, -.18])
  } else if (profile === 'goblin') {
    const earSurface = skin
    cone(head, 'goblin-ear-left', .065, .2, earSurface, [-.12, .05, 0], [0, 0, -.85], 7)
    cone(head, 'goblin-ear-right', .065, .2, earSurface, [.12, .05, 0], [0, 0, .85], 7)
    sphere(head, 'goblin-nose', .055, skin, [0, -.015, -.135], [1, .8, 1.4])
    const cleaver = addSword(rightArm, metal, leather, 'rusty-cleaver')
    cleaver.position.set(0, -.39, -.02); cleaver.rotation.z = -.28; cleaver.scale.set(1.05, .9, 1)
    pelvis.rotation.x = .12; torso.rotation.x = -.08; head.rotation.x = .06
  } else if (profile === 'skeleton') {
    cube(head, 'skull-jaw', [.16, .075, .14], bone, [0, -.1, -.015])
    sphere(head, 'skull-cap', .14, bone, [0, .035, 0], [1, 1.05, .9])
    sphere(head, 'eye-left', .018, material('#9e5960', { emissive: '#d63f48' }), [-.048, .025, -.13])
    sphere(head, 'eye-right', .018, material('#9e5960', { emissive: '#d63f48' }), [.048, .025, -.13])
    for (const y of [-.08, .02, .12]) mesh(torso, new TorusGeometry(.14 - y * .08, .012, 5, 14), bone, `rib-${y}`, [0, y, -.005], [Math.PI / 2, 0, 0])
    const sword = addSword(rightArm, metal, leather)
    sword.position.set(0, -.39, -.02)
    sword.rotation.z = -.12
    pelvis.rotation.x = -.08
  }

  // Цвет игрока может выделить миниатюру, но не меняет принадлежность actor-а.
  const accent = maybeColor(input.color, palette.accent)
  cylinder(root, 'actor-color-ring', .215, .215, .012, material(accent, { metalness: .2, roughness: .5 }), [0, .064, 0], undefined, 20)
  return rig
}

function buildHumanoid(input: NormalizedActorModelInput, profile: ActorModelProfile): { root: Group; rig: Rig } {
  const root = new Group()
  root.name = `procedural-${profile}-${input.id}`
  const palette = PALETTES[profile]
  const accent = maybeColor(input.color, input.kind === 'enemy' ? '#a5524a' : input.kind === 'summon' ? '#4c8d85' : input.kind === 'neutral' ? '#82786a' : palette.accent)
  base(root, accent)
  const rig = addHumanoidParts(root, profile, palette, input)
  return { root, rig }
}

function buildBeast(input: NormalizedActorModelInput): { root: Group; rig: Rig } {
  const root = new Group(); root.name = `procedural-beast-${input.id}`
  const palette = PALETTES.beast
  const accent = maybeColor(input.color, input.kind === 'enemy' ? '#a5524a' : '#4c8d85')
  base(root, accent)
  const rig = newRig(root)
  const body = part(rig, 'torso', [0, .48, 0])
  const head = part(rig, 'head', [0, .67, -.3])
  const frontLeft = part(rig, 'leftArm', [-.15, .43, -.2])
  const frontRight = part(rig, 'rightArm', [.15, .43, -.2])
  const backLeft = part(rig, 'leftLeg', [-.15, .43, .2])
  const backRight = part(rig, 'rightLeg', [.15, .43, .2])
  const fur = material(palette.skin)
  const darkFur = material(palette.clothDark)
  const nose = material('#3b3029')
  sphere(body, 'beast-body', .25, fur, [0, 0, 0], [1.35, .82, 1.75])
  sphere(body, 'beast-chest', .2, material('#8d775f'), [0, .02, -.21], [1.15, .95, .8])
  sphere(head, 'beast-head', .2, fur, [0, .02, 0], [1.1, .95, 1.2])
  sphere(head, 'beast-muzzle', .105, material('#8b735b'), [0, -.03, -.19], [1, .8, 1.3])
  sphere(head, 'beast-nose', .045, nose, [0, -.015, -.29])
  cone(head, 'beast-ear-left', .08, .17, darkFur, [-.13, .18, -.01], [0, 0, -.25])
  cone(head, 'beast-ear-right', .08, .17, darkFur, [.13, .18, -.01], [0, 0, .25])
  for (const [leg, side, z] of [[frontLeft, -1, -.2] as const, [frontRight, 1, -.2] as const, [backLeft, -1, .2] as const, [backRight, 1, .2] as const]) {
    cylinder(leg, `beast-leg-${side}-${z}`, .055, .07, .31, fur, [0, -.18, 0], undefined, 7)
    sphere(leg, `beast-paw-${side}-${z}`, .075, darkFur, [0, -.35, -.025], [1, .5, 1.25])
  }
  const tail = part(rig, 'tail', [0, .5, .24])
  cylinder(tail, 'beast-tail', .065, .035, .4, fur, [0, .17, 0], [Math.PI / 2, 0, 0], 8)
  tail.rotation.x = -.45
  sphere(head, 'beast-eye-left', .018, material('#8a6a43', { emissive: '#5b3824' }), [-.08, .06, -.18])
  sphere(head, 'beast-eye-right', .018, material('#8a6a43', { emissive: '#5b3824' }), [.08, .06, -.18])
  cylinder(root, 'actor-color-ring', .215, .215, .012, material(accent, { metalness: .2, roughness: .5 }), [0, .064, 0], undefined, 20)
  return { root, rig }
}

function fitToHeight(root: Group, targetHeight: number, centerHorizontal = true): number {
  root.updateMatrixWorld(true)
  const bounds = new Box3().setFromObject(root)
  const currentHeight = bounds.max.y - bounds.min.y
  if (!Number.isFinite(currentHeight) || currentHeight <= .0001) throw new Error('У модели нет положительной высоты')
  const factor = targetHeight / currentHeight
  root.scale.setScalar(factor)
  // У процедурной миниатюры центр всей AABB совпадает с основанием. У GLB
  // оружие, плащ или посох могут быть асимметричны: сохраняем origin rig-а,
  // иначе feet/pelvis съезжают с центра тактической клетки.
  if (centerHorizontal) {
    root.position.x -= ((bounds.min.x + bounds.max.x) / 2) * factor
    root.position.z -= ((bounds.min.z + bounds.max.z) / 2) * factor
  }
  root.position.y -= bounds.min.y * factor
  root.updateMatrixWorld(true)
  return targetHeight
}

function clipPose(clip: AnimationClip): ActorPose | null {
  const name = slug(clip.name)
  if (name.includes('idle') || name.includes('stand') || name.includes('rest')) return 'idle'
  if (name.includes('walk') || name.includes('run') || name.includes('move')) return 'walk'
  if (name.includes('attack') || name.includes('strike') || name.includes('slash')) return 'attack'
  if (name.includes('cast') || name.includes('spell') || name.includes('magic')) return 'cast'
  if (name.includes('hit') || name.includes('hurt') || name.includes('damage')) return 'hit'
  if (name.includes('death') || name.includes('die') || name.includes('dead')) return 'death'
  return null
}

function disposeMaterial(surface: Material, materials: Set<Material>, textures: Set<{ dispose: () => void }>, images: Set<{ close: () => void }>) {
  if (materials.has(surface)) return
  materials.add(surface)
  for (const value of Object.values(surface)) {
    if (value && typeof value === 'object' && 'isTexture' in value && typeof (value as { dispose?: unknown }).dispose === 'function') {
      textures.add(value as { dispose: () => void })
      const image = (value as { image?: unknown }).image
      if (image && typeof image === 'object' && typeof (image as { close?: unknown }).close === 'function') images.add(image as { close: () => void })
    }
  }
  surface.dispose()
}

function disposeObject(root: Group) {
  const geometries = new Set<BufferGeometry>()
  const materials = new Set<Material>()
  const textures = new Set<{ dispose: () => void }>()
  const images = new Set<{ close: () => void }>()
  root.traverse((object) => {
    const candidate = object as Mesh<BufferGeometry, Material>
    if (candidate.geometry && !geometries.has(candidate.geometry)) { geometries.add(candidate.geometry); candidate.geometry.dispose() }
    const surfaces = Array.isArray(candidate.material) ? candidate.material : candidate.material ? [candidate.material] : []
    surfaces.forEach((surface) => disposeMaterial(surface, materials, textures, images))
  })
  images.forEach((image) => image.close())
  textures.forEach((texture) => texture.dispose())
  root.clear()
}

function enableActorShadows(root: Group): void {
  root.traverse((object) => {
    const renderable = object as Mesh
    if (renderable.isMesh) {
      renderable.castShadow = true
      renderable.receiveShadow = true
    }
  })
}

function addProceduralMethods(model: ActorModel, rig: Rig) {
  const setPose = (pose: ActorPose, progress?: number) => applyProceduralPose(rig, pose, progress == null ? 0 : progress)
  model.setPose = setPose
  model.update = () => undefined
  model.idle = (progress = 0) => applyProceduralPose(rig, 'idle', progress - Math.floor(progress))
  model.walk = (progress = 0) => applyProceduralPose(rig, 'walk', progress - Math.floor(progress))
  model.attack = (progress = 0) => setPose('attack', progress)
  model.cast = (progress = 0) => setPose('cast', progress)
  model.hit = (progress = 0) => setPose('hit', progress)
  model.death = (progress = 0) => setPose('death', progress)
}

function decorateModel(root: Group, input: NormalizedActorModelInput, entry: ActorModelManifestEntry, source: 'glb' | 'procedural', targetHeight: number, rig?: Rig, mixer?: AnimationMixer, actions?: Map<ActorPose, AnimationAction>): ActorModel {
  const model = root as ActorModel
  model.actorId = input.id
  model.actorLabel = input.label
  model.modelKey = entry.key
  model.profile = entry.profile
  model.source = source
  model.modelHeight = targetHeight
  let disposed = false
  let activeAction: AnimationAction | null = null
  const setGlbPose = (pose: ActorPose, progress?: number) => {
    if (disposed || !mixer || !actions) return
    const action = actions.get(pose)
    if (!action) return
    if (activeAction !== action) {
      activeAction?.stop()
      activeAction = action.reset().setLoop(pose === 'death' ? LoopOnce : LoopRepeat, pose === 'death' ? 1 : Infinity).play()
    }
    if (progress != null) {
      action.paused = true
      action.time = MathUtils.clamp(progress, 0, 1) * action.getClip().duration
    } else action.paused = false
  }
  model.setPose = source === 'glb' ? setGlbPose : model.setPose
  model.update = (deltaSeconds: number) => {
    if (!disposed && mixer && Number.isFinite(deltaSeconds) && deltaSeconds > 0) mixer.update(Math.min(deltaSeconds, .25))
  }
  if (source === 'glb' && actions) {
    for (const pose of ACTOR_POSES) if (actions.has(pose)) model[pose] = (progress?: number) => setGlbPose(pose, progress)
  }
  model.dispose = () => {
    if (disposed) return
    disposed = true
    mixer?.stopAllAction()
    mixer?.uncacheRoot(root)
    disposeObject(root)
  }
  return model
}

const ACTOR_POSES: readonly ActorPose[] = ['idle', 'walk', 'attack', 'cast', 'hit', 'death']

/**
 * В Chromium ImageBitmapLoader получает embedded картинку через fetch(blob:),
 * а CSP проекта разрешает blob только в `img-src`, не в `connect-src`. В
 * браузере принудительно используем HTML Image через TextureLoader: blob URL
 * остаётся тем же, но загружается как `<img src>`. В Node/SSR без document
 * оставляем штатный loader — это сохраняет возможность тестировать GLB с
 * подменённым `createImageBitmap` без DOM.
 */
export function registerCspSafeEmbeddedTextureLoader(loader: GLTFLoader): void {
  if (cspSafeTextureLoaders.has(loader)) return
  const callback = (parser: GLTFParser) => {
    const imageLoader = typeof document !== 'undefined' && typeof document.createElementNS === 'function'
      ? new TextureLoader(parser.options.manager)
      : null
    return {
      name: 'SkazanieEmbeddedTextureLoader',
      loadTexture(textureIndex: number) {
        const textureDef = parser.json.textures?.[textureIndex]
        const sourceIndex = textureDef?.source
        const sourceDef = sourceIndex == null ? undefined : parser.json.images?.[sourceIndex]
        if (!imageLoader || sourceDef?.bufferView == null) return null
        return parser.loadTextureImage(textureIndex, sourceIndex, imageLoader)
      },
    }
  }
  loader.register(callback)
  cspSafeTextureLoaders.add(loader)
}

function parseGltf(loader: GLTFLoader, buffer: ArrayBuffer): Promise<GLTF> {
  return new Promise((resolve, reject) => loader.parse(buffer, MODEL_ROOT, resolve, reject))
}

async function createGlbModel(input: NormalizedActorModelInput, entry: ActorModelManifestEntry, options: ActorModelOptions, targetHeight: number): Promise<ActorModel> {
  const buffer = await loadGlbBuffer(entry.url!, options)
  validateGlbContainer(buffer, options.maxGlbBytes ?? DEFAULT_MAX_GLB_BYTES)
  const loader = options.loader ?? new GLTFLoader()
  registerCspSafeEmbeddedTextureLoader(loader)
  const gltf = await parseGltf(loader, buffer)
  const root = new Group()
  root.name = `glb-${entry.key}-${input.id}`
  root.add(gltf.scene)
  enableActorShadows(root)
  fitToHeight(root, targetHeight, false)
  // Запрос может быть отменён уже после parse callback. Не отдаём компоненту
  // частично готовую сцену и сразу освобождаем поздно пришедший результат.
  if (options.signal?.aborted) {
    disposeObject(root)
    throw options.signal.reason ?? new Error('Загрузка модели отменена')
  }
  const mixer = gltf.animations?.length ? new AnimationMixer(root) : undefined
  const actions = mixer ? new Map<ActorPose, AnimationAction>() : undefined
  if (mixer && actions) for (const clip of gltf.animations) {
    const pose = clipPose(clip)
    if (pose && !actions.has(pose)) actions.set(pose, mixer.clipAction(clip))
  }
  return decorateModel(root, input, entry, 'glb', targetHeight, undefined, mixer, actions)
}

/** Создаёт фигурку синхронно; удобно для первого кадра и fallback без сети. */
export function createProceduralActorModel(input: ActorModelInput, manifest: ActorModelManifest = DEFAULT_ACTOR_MODEL_MANIFEST, height?: number): ActorModel {
  const normalized = normalizeActorInput(input)
  const entry = resolveModelProfile(normalized, manifest)
  const targetHeight = finitePositive(height, entry.height ?? DEFAULT_HEIGHT)
  const built = entry.profile === 'beast' ? buildBeast(normalized) : buildHumanoid(normalized, entry.profile)
  fitToHeight(built.root, targetHeight)
  const model = decorateModel(built.root, normalized, entry, 'procedural', targetHeight, built.rig)
  addProceduralMethods(model, built.rig)
  return model
}

/**
 * Загружает self-contained GLB из каталога. Любая ошибка загрузки/парсинга
 * откатывается к выразительной процедурной миниатюре; отмена запроса уважает
 * AbortSignal и не маскируется fallback-ом.
 */
export async function createActorModel(input: ActorModelInput, options: ActorModelOptions = {}): Promise<ActorModel> {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('Загрузка модели отменена')
  const normalized = normalizeActorInput(options.modelKey && !input.modelKey ? { ...input, modelKey: options.modelKey } : input)
  const providedManifest = options.manifest ?? options.catalog
  let manifest = DEFAULT_ACTOR_MODEL_MANIFEST
  if (providedManifest) {
    try { manifest = validateModelManifest(providedManifest) } catch {
      // Испорченный browser override не должен ломать сам бой.
    }
  }
  if (!providedManifest) {
    try { manifest = await loadActorModelManifest(options) } catch (error) {
      if (options.signal?.aborted) throw error
    }
  }
  const entry = resolveModelProfile(normalized, manifest)
  const targetHeight = finitePositive(options.height, entry.height ?? DEFAULT_HEIGHT)
  if (entry.url) {
    try { return await createGlbModel(normalized, entry, options, targetHeight) } catch (error) {
      if (options.signal?.aborted) throw error
    }
  }
  return createProceduralActorModel(normalized, manifest, targetHeight)
}

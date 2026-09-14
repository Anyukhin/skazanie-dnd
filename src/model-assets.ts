import { TextureLoader } from 'three'
import { GLTFLoader, type GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js'

const DEFAULT_MAX_GLB_BYTES = 16 * 1024 * 1024
const MODEL_BUFFER_CACHE_BUDGET = 32 * 1024 * 1024

type ModelBufferCacheEntry = { url: string; buffer: ArrayBuffer; bytes: number }
type ModelBufferConsumer = { active: boolean; maxBytes: number }
type PendingModelBuffer = {
  key: string
  url: string
  fetcher: typeof fetch
  controller: AbortController
  consumers: Set<ModelBufferConsumer>
  maxBytes: number
  cancelled: boolean
  promise: Promise<ArrayBuffer>
}

export type ModelAssetDiagnostics = Readonly<{ fetches: number; cacheHits: number; parses: number; cachedBytes: number; entries: number; pending: number }>
export type SharedModelBufferOptions = { signal?: AbortSignal; timeoutMs: number; maxBytes: number; fetcher?: typeof fetch }

const cspSafeTextureLoaders = new WeakSet<GLTFLoader>()
const modelBufferCache = new Map<string, ModelBufferCacheEntry>()
const pendingModelBuffers = new Map<string, PendingModelBuffer>()
const fetcherIds = new WeakMap<object, number>()
let nextFetcherId = 1
let cachedModelBufferBytes = 0
const modelAssetDiagnostics = { fetches: 0, cacheHits: 0, parses: 0 }

function objectLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function modelBufferKey(url: string, fetcher: typeof fetch): string {
  const owner = fetcher as unknown as object
  let id = fetcherIds.get(owner)
  if (!id) { id = nextFetcherId; nextFetcherId += 1; fetcherIds.set(owner, id) }
  return `${id}:${url}`
}

function modelAbortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new Error('Загрузка модели отменена')
}

function touchModelBuffer(key: string, entry: ModelBufferCacheEntry): void {
  modelBufferCache.delete(key)
  modelBufferCache.set(key, entry)
}

function dropModelBuffer(key: string): void {
  const entry = modelBufferCache.get(key)
  if (!entry) return
  modelBufferCache.delete(key)
  cachedModelBufferBytes -= entry.bytes
}

function cacheModelBuffer(entry: PendingModelBuffer, buffer: ArrayBuffer): void {
  if (entry.cancelled || entry.controller.signal.aborted || buffer.byteLength > MODEL_BUFFER_CACHE_BUDGET) return
  dropModelBuffer(entry.key)
  const cached = { url: entry.url, buffer, bytes: buffer.byteLength }
  modelBufferCache.set(entry.key, cached)
  cachedModelBufferBytes += cached.bytes
  while (cachedModelBufferBytes > MODEL_BUFFER_CACHE_BUDGET) {
    const oldest = modelBufferCache.entries().next().value as [string, ModelBufferCacheEntry] | undefined
    if (!oldest) break
    dropModelBuffer(oldest[0])
  }
}

async function fetchModelBuffer(entry: PendingModelBuffer): Promise<ArrayBuffer> {
  if (entry.cancelled || entry.controller.signal.aborted) throw modelAbortReason(entry.controller.signal)
  const timer = setTimeout(() => entry.controller.abort(new Error('Превышено время загрузки модели')), 30_000)
  try {
    modelAssetDiagnostics.fetches += 1
    const fetcher = entry.fetcher
    const response = await fetcher(entry.url, { signal: entry.controller.signal, cache: 'no-cache' })
    if (entry.cancelled || entry.controller.signal.aborted) throw modelAbortReason(entry.controller.signal)
    if (!response.ok) throw new Error(`Не удалось загрузить ${entry.url}: HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > entry.maxBytes) throw new Error(`Файл ${entry.url} превышает лимит размера`)
    const buffer = await response.arrayBuffer()
    if (entry.cancelled || entry.controller.signal.aborted) throw modelAbortReason(entry.controller.signal)
    if (buffer.byteLength > entry.maxBytes) throw new Error(`Файл ${entry.url} превышает лимит размера`)
    return buffer
  } finally {
    clearTimeout(timer)
  }
}

function finishPendingModelBuffer(entry: PendingModelBuffer): void {
  if (pendingModelBuffers.get(entry.key) === entry) pendingModelBuffers.delete(entry.key)
}

function cancelPendingModelBuffer(entry: PendingModelBuffer, reason: unknown): void {
  if (entry.cancelled) return
  entry.cancelled = true
  if (pendingModelBuffers.get(entry.key) === entry) pendingModelBuffers.delete(entry.key)
  entry.controller.abort(reason)
}

function subscribeModelBuffer(entry: PendingModelBuffer, options: SharedModelBufferOptions): Promise<ArrayBuffer> {
  const { signal, maxBytes, timeoutMs } = options
  if (signal?.aborted) return Promise.reject(modelAbortReason(signal))
  return new Promise<ArrayBuffer>((resolve, reject) => {
    let consumer: ModelBufferConsumer
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      if (timer) clearTimeout(timer)
    }
    const release = () => { consumer.active = false; cleanup(); entry.consumers.delete(consumer) }
    const abort = (reason: unknown) => {
      if (!consumer.active) return
      release()
      reject(reason)
      if (!entry.consumers.size) cancelPendingModelBuffer(entry, reason)
    }
    const onAbort = () => abort(modelAbortReason(signal))
    consumer = { active: true, maxBytes }
    entry.consumers.add(consumer)
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => abort(new Error('Превышено время загрузки модели')), Math.max(1, timeoutMs))
    entry.promise.then((buffer) => {
      if (!consumer.active) return
      if (buffer.byteLength > consumer.maxBytes) {
        release()
        reject(new Error('Файл модели превышает лимит размера'))
        return
      }
      release()
      resolve(buffer)
    }, (error) => {
      if (!consumer.active) return
      release()
      reject(error)
    })
  })
}

function resolveCachedModelBuffer(buffer: ArrayBuffer, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (!signal) return Promise.resolve(buffer)
  if (signal.aborted) return Promise.reject(modelAbortReason(signal))
  return new Promise<ArrayBuffer>((resolve, reject) => {
    let active = true
    const onAbort = () => {
      if (!active) return
      active = false
      signal.removeEventListener('abort', onAbort)
      reject(modelAbortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    queueMicrotask(() => {
      if (!active) return
      active = false
      signal.removeEventListener('abort', onAbort)
      resolve(buffer)
    })
  })
}

/** Общий fetch/кэш GLB для акторов, предметов и экипировки. */
export function loadSharedModelBuffer(url: string, options: SharedModelBufferOptions): Promise<ArrayBuffer> {
  const fetcher = options.fetcher ?? (typeof fetch === 'function' ? fetch : undefined)
  if (!fetcher) return Promise.reject(new Error('В браузере недоступен fetch'))
  if (options.signal?.aborted) return Promise.reject(modelAbortReason(options.signal))
  const key = modelBufferKey(url, fetcher)
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(0, options.maxBytes) : 0
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 30_000
  const cached = modelBufferCache.get(key)
  if (cached && cached.bytes <= maxBytes) {
    try { validateGlbContainer(cached.buffer, MODEL_BUFFER_CACHE_BUDGET) } catch (error) {
      dropModelBuffer(key)
      return Promise.reject(error)
    }
    modelAssetDiagnostics.cacheHits += 1
    touchModelBuffer(key, cached)
    return resolveCachedModelBuffer(cached.buffer, options.signal)
  }
  let entry = pendingModelBuffers.get(key)
  if (entry?.cancelled) entry = undefined
  if (!entry) {
    const created: PendingModelBuffer = {
      key, url, fetcher, controller: new AbortController(), consumers: new Set<ModelBufferConsumer>(),
      maxBytes, cancelled: false, promise: Promise.resolve(new ArrayBuffer(0)),
    }
    created.promise = Promise.resolve()
      .then(() => fetchModelBuffer(created))
      .then((buffer) => {
        validateGlbContainer(buffer, MODEL_BUFFER_CACHE_BUDGET)
        cacheModelBuffer(created, buffer)
        return buffer
      })
    entry = created
    pendingModelBuffers.set(key, entry)
    void entry.promise.then(() => finishPendingModelBuffer(entry!), () => finishPendingModelBuffer(entry!))
  } else {
    modelAssetDiagnostics.cacheHits += 1
    entry.maxBytes = Math.max(entry.maxBytes, maxBytes)
  }
  return subscribeModelBuffer(entry, options)
}

export function clearSharedModelBufferCache(url?: string): void {
  const matches = (entry: { url: string }) => url === undefined || entry.url === url
  for (const [key, entry] of [...pendingModelBuffers]) {
    if (!matches(entry)) continue
    cancelPendingModelBuffer(entry, new Error('Кэш моделей очищен'))
    if (pendingModelBuffers.get(key) === entry) pendingModelBuffers.delete(key)
  }
  for (const [key, entry] of [...modelBufferCache]) if (matches(entry)) dropModelBuffer(key)
}

export function recordModelAssetCacheHit(): void { modelAssetDiagnostics.cacheHits += 1 }
export function recordModelAssetParse(): void { modelAssetDiagnostics.parses += 1 }

export function getModelAssetDiagnostics(): ModelAssetDiagnostics {
  return {
    ...modelAssetDiagnostics,
    cachedBytes: cachedModelBufferBytes,
    entries: modelBufferCache.size,
    pending: pendingModelBuffers.size,
  }
}

export function resetModelAssetDiagnostics(): void {
  modelAssetDiagnostics.fetches = 0
  modelAssetDiagnostics.cacheHits = 0
  modelAssetDiagnostics.parses = 0
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

/** Ограниченная загрузка JSON-каталога с теми же timeout/size/diagnostics. */
export async function loadModelAssetBuffer(fetcher: typeof fetch, url: string, options: { signal?: AbortSignal; timeoutMs: number; maxBytes: number }): Promise<ArrayBuffer> {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('Загрузка отменена')
  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('Превышено время загрузки модели')), options.timeoutMs)
  try {
    modelAssetDiagnostics.fetches += 1
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

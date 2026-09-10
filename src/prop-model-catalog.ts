/** Общий выбор модели для 3D-предмета и его изображения сверху. */
export type PropModelEntry = {
  key: string
  label: string
  category: string
  url: string
  assetIds: string[]
  yaw: number
  preview?: { x: number; y: number; w: number; h: number }
}

export type PropModelCatalog = {
  version: 1
  revision?: string
  models: PropModelEntry[]
  atlas?: { image: string; key: string }
}

const ROOT = '/assets/models/environment/'
export const LEGACY_CATALOG_REVISION = 'pr79'
const KEY = /^[a-z0-9][a-z0-9_-]{0,95}$/
const LOCAL_FILE = /^\/assets\/models\/environment\/[a-zA-Z0-9_/-]+\.(glb|png)$/

export function validatePropModelCatalog(value: unknown): PropModelCatalog {
  if (!value || typeof value !== 'object') throw new Error('Нет каталога окружения')
  const input = value as Record<string, unknown>
  if (input.version !== 1 || !Array.isArray(input.models) || input.models.length > 512) throw new Error('Некорректный каталог окружения')
  const keys = new Set<string>()
  const models = input.models.map((raw: unknown): PropModelEntry => {
    if (!raw || typeof raw !== 'object') throw new Error('Некорректная модель окружения')
    const entry = raw as Record<string, unknown>
    if (typeof entry.key !== 'string' || !KEY.test(entry.key) || keys.has(entry.key)
      || typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 160
      || typeof entry.category !== 'string' || entry.category.length > 80
      || typeof entry.url !== 'string' || !LOCAL_FILE.test(entry.url) || !entry.url.endsWith('.glb')
      || !Array.isArray(entry.assetIds) || entry.assetIds.some((id) => typeof id !== 'string' || !KEY.test(id))) throw new Error('Некорректная запись модели окружения')
    keys.add(entry.key)
    const result: PropModelEntry = { key: entry.key, label: entry.label, category: entry.category, url: entry.url,
      assetIds: [...new Set(entry.assetIds as string[])], yaw: typeof entry.yaw === 'number' && Number.isFinite(entry.yaw) ? entry.yaw : 0 }
    if (entry.preview && typeof entry.preview === 'object') {
      const p = entry.preview as Record<string, unknown>
      if (['x', 'y', 'w', 'h'].every((k) => typeof p[k] === 'number' && Number.isInteger(p[k]) && Number(p[k]) >= 0 && Number(p[k]) <= 8192)
        && Number(p.w) > 0 && Number(p.h) > 0) result.preview = { x: Number(p.x), y: Number(p.y), w: Number(p.w), h: Number(p.h) }
    }
    return result
  })
  const result: PropModelCatalog = { version: 1, models }
  if (typeof input.revision === 'string' && KEY.test(input.revision)) result.revision = input.revision
  const atlas = input.atlas as Record<string, unknown> | undefined
  if (atlas && typeof atlas.image === 'string' && LOCAL_FILE.test(atlas.image) && atlas.image.endsWith('.png')
    && typeof atlas.key === 'string' && atlas.key.length <= 128) result.atlas = { image: atlas.image, key: atlas.key }
  return result
}

export function propModelFor(catalog: PropModelCatalog | null | undefined, assetId: string, propId: string): PropModelEntry | null {
  const choices = catalog?.models.filter((entry) => entry.assetIds.includes(assetId)) ?? []
  if (!choices.length) return null
  let seed = 2166136261
  for (const char of propId) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0
  return choices[seed % choices.length]
}

const catalogs = new Map<string, { promise: Promise<PropModelCatalog | null>; settled: boolean }>()
const CATALOG_CACHE_LIMIT = 12

export function loadPropModelCatalog(revision = LEGACY_CATALOG_REVISION): Promise<PropModelCatalog | null> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return Promise.resolve(null)
  if (typeof revision !== 'string' || !KEY.test(revision)) return Promise.resolve(null)
  const cached = catalogs.get(revision)
  if (cached) { catalogs.delete(revision); catalogs.set(revision, cached); return cached.promise }
  const url = revision === LEGACY_CATALOG_REVISION
    ? `${ROOT}baseline-pr79.json` : `${ROOT}releases/${revision}/manifest.json`
  const entry = { promise: Promise.resolve<PropModelCatalog | null>(null), settled: false }
  entry.promise = Promise.resolve().then(() => fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(10_000) }))
    .then(async (response) => {
      if (!response.ok || Number(response.headers.get('content-length')) > 512_000) return null
      const text = await response.text()
      if (text.length > 512_000) return null
      const raw = JSON.parse(text)
      const declared = revision === LEGACY_CATALOG_REVISION ? raw?.revision : raw?.release?.id
      if (declared !== revision) return null
      return { ...validatePropModelCatalog(raw), revision }
    }).catch(() => null).then((catalog) => {
      entry.settled = true
      if (!catalog && catalogs.get(revision) === entry) catalogs.delete(revision)
      // Незавершённые загрузки не вытесняются: новый потребитель разделяет запрос.
      for (const [key, value] of catalogs) {
        if (catalogs.size <= CATALOG_CACHE_LIMIT) break
        if (value.settled) catalogs.delete(key)
      }
      return catalog
    })
  catalogs.set(revision, entry)
  return entry.promise
}

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
  models: PropModelEntry[]
  atlas?: { image: string; key: string }
}

const ROOT = '/assets/models/environment/'
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

let pending: Promise<PropModelCatalog | null> | null = null
export function loadPropModelCatalog(): Promise<PropModelCatalog | null> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return Promise.resolve(null)
  pending ??= fetch(`${ROOT}manifest.json`, { cache: 'no-cache', signal: AbortSignal.timeout(10_000) })
    .then(async (response) => {
      if (!response.ok || Number(response.headers.get('content-length')) > 512_000) return null
      const text = await response.text()
      return text.length <= 512_000 ? validatePropModelCatalog(JSON.parse(text)) : null
    }).catch(() => null).then((catalog) => { if (!catalog) pending = null; return catalog })
  return pending
}

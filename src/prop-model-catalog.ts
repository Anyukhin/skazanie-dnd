/** Общий выбор модели для 3D-предмета и его изображения сверху. */
export type PropModelEntry = {
  key: string
  label: string
  category: string
  url: string
  assetIds: string[]
  yaw: number
  /** Предел высоты модели в клетках до масштаба предмета; перекрывает PROP_MODEL_MAX_HEIGHTS. */
  maxHeight?: number
  preview?: { x: number; y: number; w: number; h: number }
}

/**
 * Предел высоты GLB-модели по каноническому asset id, в клетках до `prop.scale`.
 * Футпринт задаёт ширину и глубину, но высоту не ограничивает: тонкая модель
 * (метла, фонарный столб, бутылка), вписанная в клетку по ширине, вырастала
 * в несколько клеток. Шкала: герой 1.25–1.4, стена 0.68 (BOARD3D_WALL_HEIGHT),
 * столешница около 0.73. Вида без записи предел не касается (лестницы).
 */
export const PROP_MODEL_MAX_HEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  // Посуда и мелочь — стоят на столах и полках.
  mug: .3, plate: .1, bowl_stew: .3, bottle: .42, jug: .42, bread_loaf: .25, cheese_wheel: .25,
  candle: .4, dice_cup: .3, coin_pile: .2, cutting_board: .12, pot: .4, lute: .6,
  // Бытовые предметы на полу.
  broom: .9, sack: .6, basket: .5, bucket: .45, offering_bowl: .5, urn: .6, bone_pile: .4,
  firewood_stack: .5, woodpile: .6, cauldron: .6, keg: .6, crate: .6, chest: .6, barrel: .75,
  barrel_stack: 1.05, crate_stack: 1,
  // Мебель.
  table_round: .8, table_long: .8, table_royal: .85, table_small: .75, bar_counter: .9,
  bench: .6, prayer_bench: .6, stool: .55, chair: 1, royal_throne: 1.3, night_table: .6,
  bed: .75, bunk_bed: 1.2, washbasin: .85, cupboard: 1.1, wardrobe: 1.2, bookshelf: 1.2,
  bar_shelf: 1.2, shelf_wall: .5, fireplace: 1.2, hearth_fire: .7,
  // Свет и стенные предметы.
  torch_wall: .9, lantern_wall: .9, candelabra: .9, chandelier: 1, brazier: .9, campfire: .4,
  banner: 1.2, temple_banner: 1.2, sign_board: 1,
  // Храм и склеп.
  altar: .8, sarcophagus: .7, grave: .8, reliquary: .9, crypt_niche: 1.2, pillar: 1.4, statue: 1.8,
  // Улица и поселение.
  lamp_post: 2.2, signpost: 1.5, hitching_post: .9, milestone: .7, roadside_shrine: 1.3,
  water_trough: .6, wagon_wheel: .7, village_fence: .7, well: 1.6, haystack: 1.3, cart: 1.6,
  market_stall: 2,
  // Природа.
  tree_oak: 2.8, tree_birch: 2.8, tree_pine: 3, tree_spruce: 3, tree_dead: 2.4, tree_stump: .4,
  bush: .8, shrub: .6, grass_tuft: .3, flowers: .35, fern: .4, mushroom_cluster: .35,
  rock_small: .3, boulder: 1, stalagmite: 1.2, rubble_heap: .5, fallen_log: .5,
})

const MAX_HEIGHT_LIMIT = 8

/** Предел высоты модели предмета в клетках; `null` — высота не ограничена. */
export function propModelMaxHeight(assetId: string, entry?: Pick<PropModelEntry, 'maxHeight'> | null): number | null {
  if (entry?.maxHeight !== undefined) return entry.maxHeight
  return Object.prototype.hasOwnProperty.call(PROP_MODEL_MAX_HEIGHTS, assetId) ? PROP_MODEL_MAX_HEIGHTS[assetId] : null
}

export type PropModelCatalog = {
  version: 1
  revision?: string
  models: PropModelEntry[]
  atlas?: { image: string; key: string }
}

const ROOT = '/assets/models/environment/'
export const LEGACY_CATALOG_REVISION = 'pr79'
export const ENVIRONMENT_MODEL_FAMILIES = Object.freeze(['quaternius', 'kenney', 'kenney-dungeon', 'skazanie'] as const)
const KEY = /^[a-z0-9][a-z0-9_-]{0,95}$/
const LOCAL_FILE = /^\/assets\/models\/environment\/[a-zA-Z0-9_/-]+\.(glb|png)$/
const MODEL_FILE = /^\/assets\/models\/environment\/[a-zA-Z0-9_/-]+\.glb$/

function supportedModelUrl(url: string) {
  if (!MODEL_FILE.test(url)) return false
  const parts = url.slice(ROOT.length).split('/')
  if (parts.length === 1) return true
  const family = parts[0] === 'releases' ? parts[2] : parts[0]
  const expectedLength = parts[0] === 'releases' ? 4 : 2
  return parts.length === expectedLength && typeof family === 'string'
    && (ENVIRONMENT_MODEL_FAMILIES as readonly string[]).includes(family)
}

function releaseFilePrefix(revision: string) {
  return `${ROOT}releases/${revision}/`
}

export function validatePropModelCatalog(value: unknown, revision?: string): PropModelCatalog {
  if (revision !== undefined && !KEY.test(revision)) throw new Error('Некорректная ревизия каталога окружения')
  if (!value || typeof value !== 'object') throw new Error('Нет каталога окружения')
  const input = value as Record<string, unknown>
  const release = input.release && typeof input.release === 'object' && !Array.isArray(input.release)
    ? input.release as Record<string, unknown> : undefined
  const declaredRelease = release?.id
  if (declaredRelease !== undefined && (typeof declaredRelease !== 'string' || !KEY.test(declaredRelease))) {
    throw new Error('Некорректная ревизия каталога окружения')
  }
  const pinnedRevision = revision ?? (typeof declaredRelease === 'string' ? declaredRelease : undefined)
  if (input.version !== 1 || !Array.isArray(input.models) || input.models.length > 512) throw new Error('Некорректный каталог окружения')
  const keys = new Set<string>()
  const models = input.models.map((raw: unknown): PropModelEntry => {
    if (!raw || typeof raw !== 'object') throw new Error('Некорректная модель окружения')
    const entry = raw as Record<string, unknown>
    if (typeof entry.key !== 'string' || !KEY.test(entry.key) || keys.has(entry.key)
      || typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 160
      || typeof entry.category !== 'string' || entry.category.length > 80
      || typeof entry.url !== 'string' || !supportedModelUrl(entry.url)
      || (pinnedRevision !== undefined && pinnedRevision !== LEGACY_CATALOG_REVISION && !entry.url.startsWith(releaseFilePrefix(pinnedRevision)))
      || !Array.isArray(entry.assetIds) || entry.assetIds.some((id) => typeof id !== 'string' || !KEY.test(id))) throw new Error('Некорректная запись модели окружения')
    keys.add(entry.key)
    const result: PropModelEntry = { key: entry.key, label: entry.label, category: entry.category, url: entry.url,
      assetIds: [...new Set(entry.assetIds as string[])], yaw: typeof entry.yaw === 'number' && Number.isFinite(entry.yaw) ? entry.yaw : 0 }
    if (typeof entry.maxHeight === 'number' && Number.isFinite(entry.maxHeight) && entry.maxHeight > 0 && entry.maxHeight <= MAX_HEIGHT_LIMIT) {
      result.maxHeight = entry.maxHeight
    }
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
  const atlasImage = typeof atlas?.image === 'string' ? atlas.image : ''
  const atlasKey = typeof atlas?.key === 'string' ? atlas.key : ''
  const atlasValid = Boolean(atlas && typeof atlas.key === 'string' && LOCAL_FILE.test(atlasImage) && atlasImage.endsWith('.png')
    && (pinnedRevision === undefined || pinnedRevision === LEGACY_CATALOG_REVISION || atlasImage.startsWith(releaseFilePrefix(pinnedRevision)))
    && atlasKey.length <= 128)
  if (pinnedRevision !== undefined && pinnedRevision !== LEGACY_CATALOG_REVISION && !atlasValid) {
    throw new Error('Некорректная запись атласа окружения')
  }
  if (atlasValid) result.atlas = { image: atlasImage, key: atlasKey }
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
      return { ...validatePropModelCatalog(raw, revision), revision }
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

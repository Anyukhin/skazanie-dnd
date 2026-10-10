import { detailPropModelUrl } from './detail-props'

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
  /** Реальный bbox модели после entry.yaw: ширина, высота, глубина. */
  size?: [number, number, number]
  /** Модель пришла из style pack, а не из выпуска окружения. */
  source?: 'style'
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
  candle: .4, dice_cup: .3, coin_pile: .1, cutting_board: .06, pot: .4, lute: .6,
  // Бытовые предметы на полу.
  broom: .9, sack: .6, basket: .4, bucket: .3, offering_bowl: .5, urn: .6, bone_pile: .4,
  firewood_stack: .5, woodpile: .6, cauldron: .6, keg: .6, crate: .6, chest: .6, barrel: .75,
  barrel_stack: 1.05, crate_stack: 1,
  // Замер `tools/model-scale-audit.mjs` (2026-10-09): эти модели без предела
  // выходили выше человека — кафедра 10,5 фт, вешалка 11, книжный шкаф 13,
  // окованный ларец 3,7 фт, бочка для воды 4,8 фт.
  strongbox: .36, rain_barrel: .8, water_barrel: .8, anvil: .75, butcher_block: .7,
  prep_table: .75, offering_table: .8, map_table: .8,
  bookcase_tall: 1.7, display_shelf: 1.6, coat_rack: 1.35, standing_mirror: 1.45, tool_rack: 1.35,
  book_lectern: 1, temple_lectern: 1, training_dummy: 1.35,
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

/**
 * Наименьшая высота вида в клетках уже после `prop.scale`, только для 3D.
 * Генератор ставит стул и табурет уменьшенными (`scaleRange` 0.33–0.5), чтобы
 * в 2D они не занимали клетку целиком, а в 3D рост падал вместе с шириной:
 * стул выходил ниже колена человека (замер `tools/model-scale-audit.mjs`).
 */
export const PROP_MODEL_MIN_HEIGHTS: Readonly<Record<string, number>> = Object.freeze({ chair: .68, stool: .4 })

/**
 * Поднимает вписывание GLB до наименьшей высоты вида, не выпуская модель за
 * клетки следа. `fit` — результат `propModelFit`, `scale` — `prop.scale`.
 */
export function propModelFloorFit(assetId: string, fit: number, size: [number, number, number], scale: number, width: number, depth: number): number {
  const minimum = Object.prototype.hasOwnProperty.call(PROP_MODEL_MIN_HEIGHTS, assetId) ? PROP_MODEL_MIN_HEIGHTS[assetId] : 0
  const applied = scale > 0 ? scale : 1
  if (!minimum || !(size[1] > 0) || size[1] * fit * applied >= minimum) return fit
  const roomy = Math.min(width / Math.max(size[0], .0001), depth / Math.max(size[2], .0001)) / applied
  return Math.max(fit, Math.min(minimum / (size[1] * applied), roomy))
}

/**
 * Рост деревьев в 3D, клетки. В масштабе фигурки (человек 1,3 клетки = 5,75
 * фт): дуб 18 фт, берёза 16, сосна и ель 20, сухое дерево 14. Предел высоты
 * и след сжимали модель до 9–13 фт — ниже фонаря; в 3D дерево вытягивается
 * вверх до этого роста, ширина кроны и рисунок в 2D не меняются. Фигурки
 * видны сквозь крону (`board3d-see-through`).
 */
export const PROP_MODEL_TREE_HEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  tree_oak: 4.1, tree_birch: 3.6, tree_pine: 4.5, tree_spruce: 4.5, tree_dead: 3.2,
})
const MAX_TREE_STRETCH = 2.1

/** Во сколько раз вытянуть дерево вверх в 3D; `heightCells` — рост после вписывания и масштаба. */
export function propModelTreeStretch(assetId: string, heightCells: number): number {
  const target = Object.prototype.hasOwnProperty.call(PROP_MODEL_TREE_HEIGHTS, assetId) ? PROP_MODEL_TREE_HEIGHTS[assetId] : 0
  if (!target || !(heightCells > 0)) return 1
  return Math.min(MAX_TREE_STRETCH, Math.max(1, target / heightCells))
}

const MAX_HEIGHT_LIMIT = 8
const MAX_SIZE_LIMIT = 10_000

/**
 * Поправка лица модели. Предмет с поворотом 0° смотрит на юг, и модель
 * обязана смотреть лицом в +Z. Часть авторских рецептов собрана лицом в −Z
 * (печь, лавочный прилавок, зеркала, стойка с доспехом), а у трёх знамён и
 * колеса Kenney полотно стоит вдоль X — на стене они торчали ребром. Пока
 * генератор ставил настенные вещи лицом в стену, эти модели смотрели в
 * комнату по случайности; после исправления стороны (обзор генератора
 * 2026-10-10) их развернула бы та же правка. Лестница `kd-stairs`
 * поднимается к +Z, а подниматься ей к стене — у неё та же поправка.
 *
 * `baseYaw` — yaw записи в манифесте, к которому поправка относится. При
 * пересборке пакета с исправленным yaw в `tools/graphics-style-sources.mjs`
 * запись отсюда убирается; сторож — `test/prop-model-front.test.mjs`.
 * Замер — агентный обход рецептов и GLB 2026-10-10.
 */
const FRONT_TURN_DETAIL_ASSETS = Object.freeze([
  'kitchen_stove', 'bread_oven', 'shop_counter', 'jailer_desk', 'standing_mirror', 'idol', 'scroll_rack',
  'reading_nook', 'armor_stand', 'archery_target', 'wall_chains', 'candle_desk', 'straw_bed', 'bathtub',
])
export const PROP_MODEL_FRONT_TURNS: Readonly<Record<string, { turn: 90 | 180 | 270; baseYaw: number }>> = Object.freeze({
  ...Object.fromEntries(FRONT_TURN_DETAIL_ASSETS.flatMap((assetId) => [
    [`style-detail-${assetId.replaceAll('_', '-')}`, { turn: 180, baseYaw: 0 }],
    [`detail-v1-${assetId}`, { turn: 180, baseYaw: 0 }],
  ])),
  'style-detail-magic-mirror': { turn: 180, baseYaw: 0 },
  'style-detail-potion-cabinet': { turn: 180, baseYaw: 0 },
  'style-detail-iron-maiden': { turn: 180, baseYaw: 0 },
  'style-detail-arcane-lectern': { turn: 180, baseYaw: 0 },
  'style-extra-weapon-rack': { turn: 180, baseYaw: 0 },
  'detail-v1-weapon_rack': { turn: 180, baseYaw: 0 },
  'style-extra-alchemy-table': { turn: 180, baseYaw: 0 },
  'detail-v1-alchemy_table': { turn: 180, baseYaw: 0 },
  'style-extra-timber-shoring': { turn: 180, baseYaw: 0 },
  'detail-v1-timber_shoring': { turn: 180, baseYaw: 0 },
  'kd-stairs': { turn: 180, baseYaw: 0 },
  'style-kenney-town-banner-green': { turn: 90, baseYaw: 0 },
  'style-kenney-town-banner-red': { turn: 90, baseYaw: 0 },
  'style-kenney-castle-flag-banner-long': { turn: 90, baseYaw: 0 },
  'style-kenney-town-wheel': { turn: 90, baseYaw: 0 },
})

/** Доворот модели к её лицу в градусах yaw (против часовой сверху); 0 — без поправки. */
export function propModelFrontTurn(key: string): number {
  return Object.prototype.hasOwnProperty.call(PROP_MODEL_FRONT_TURNS, key) ? PROP_MODEL_FRONT_TURNS[key].turn : 0
}

/**
 * Запись модели для 3D с поправкой лица: yaw доворачивается, а bbox после
 * четверти оборота меняет ширину и глубину местами. 2D рисует вид сверху,
 * снятый при исходном yaw, и доворачивает его сам.
 */
export function frontFacingEntry<T extends Pick<PropModelEntry, 'key' | 'yaw' | 'size'>>(entry: T): T {
  const turn = propModelFrontTurn(entry.key)
  if (!turn) return entry
  const size = entry.size && turn % 180 ? [entry.size[2], entry.size[1], entry.size[0]] as [number, number, number] : entry.size
  return { ...entry, yaw: entry.yaw + turn, ...(size ? { size } : {}) }
}

/** Предел высоты модели предмета в клетках; `null` — высота не ограничена. */
export function propModelMaxHeight(assetId: string, entry?: Pick<PropModelEntry, 'maxHeight'> | null): number | null {
  if (entry?.maxHeight !== undefined) return entry.maxHeight
  return Object.prototype.hasOwnProperty.call(PROP_MODEL_MAX_HEIGHTS, assetId) ? PROP_MODEL_MAX_HEIGHTS[assetId] : null
}

/** Масштаб GLB в footprint до применения `prop.scale`. */
export function propModelFit(
  assetId: string,
  entry: Pick<PropModelEntry, 'size' | 'maxHeight'> | null | undefined,
  width: number,
  depth: number,
  fill: number,
  actualSize?: [number, number, number],
): number | null {
  const size = entry?.size ?? actualSize
  if (!size || !size.every((value) => Number.isFinite(value) && value > 0)) return null
  if (!Number.isFinite(width) || !Number.isFinite(depth) || !Number.isFinite(fill) || width <= 0 || depth <= 0 || fill <= 0) return null
  const footprintFit = Math.min(width / size[0], depth / size[2]) * fill
  const maxHeight = propModelMaxHeight(assetId, entry)
  return maxHeight === null ? footprintFit : Math.min(footprintFit, maxHeight / size[1])
}

export type PropModelCatalog = {
  version: 1
  revision?: string
  models: PropModelEntry[]
  atlas?: { image: string; key: string }
}

const ROOT = '/assets/models/environment/'
export const LEGACY_CATALOG_REVISION = 'pr79'
export const ENVIRONMENT_MODEL_FAMILIES = Object.freeze([
  'quaternius', 'kenney', 'kenney-dungeon', 'skazanie', 'quaternius-nature', 'kaykit-dungeon', 'kenney-graveyard',
] as const)
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
    if (entry.size !== undefined) {
      if (!Array.isArray(entry.size) || entry.size.length !== 3 || entry.size.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_SIZE_LIMIT)) {
        throw new Error('Некорректный габарит модели окружения')
      }
      result.size = [entry.size[0] as number, entry.size[1] as number, entry.size[2] as number]
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
  // Вид, которого нет в выпуске окружения, но есть в наборе детализации:
  // его авторская модель лежит в `detail-v1/models`. Выпуск сильнее набора,
  // а прежние виды набором не перекрываются вовсе.
  if (!choices.length) return catalog ? detailModelEntry(assetId) : null
  let seed = 2166136261
  for (const char of propId) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0
  return choices[seed % choices.length]
}

/** Запись каталога для GLB набора детализации. */
function detailModelEntry(assetId: string): PropModelEntry | null {
  const url = detailPropModelUrl(assetId)
  return url ? { key: `detail-v1-${assetId}`, label: assetId, category: 'detail-v1', url, assetIds: [assetId], yaw: 0 } : null
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

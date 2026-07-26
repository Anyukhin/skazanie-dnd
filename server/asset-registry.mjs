// @ts-check
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Реестр ассетов — единственное место, которое знает, чем рисуется предмет
 * (`docs/tactical-map-plan.md`, решение Р3 и раздел 6).
 *
 * Карта хранит только `assetId`. Рендер спрашивает реестр и получает векторный
 * рисунок, растровый спрайт или ничего; в последнем случае рисуется плоская
 * заливка по `baseFootprint`. Поэтому переход на растровый атлас — это
 * заполнение поля `raster`, без изменений в генераторе, модели карты и
 * серверной валидации.
 */

export const ASSET_REGISTRY_VERSION = 'skazanie:asset-registry-v1'

export const ASSET_KINDS = Object.freeze(['prop', 'floor_tile', 'wall_segment', 'door_leaf', 'decal'])

/**
 * Якорь влияет на расстановку (`docs/tactical-map-plan.md`, стадия 3):
 * `wall` тянет предмет к стене и разворачивает лицом внутрь помещения,
 * `corner` — в угол, `center` — свободно.
 */
export const ASSET_ANCHORS = Object.freeze(['center', 'wall', 'corner'])

export const ASSET_COVER_LEVELS = Object.freeze(['none', 'half', 'three_quarters'])

export class AssetRegistryError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'AssetRegistryError'
    this.code = code
  }
}

/**
 * @typedef {object} AssetEntry
 * @property {string} id
 * @property {string} kind значение из ASSET_KINDS
 * @property {string[]} themes в каких темах допустим
 * @property {{w: number, h: number}} baseFootprint сколько клеток занимает по умолчанию
 * @property {string} anchor значение из ASSET_ANCHORS
 * @property {string} vector идентификатор векторного рисунка
 * @property {string|null} raster путь к спрайту в атласе
 * @property {string|null} rightsId запись в data/asset-rights.json, обязательна для растра
 * @property {boolean} blocksMove
 * @property {boolean} blocksSight
 * @property {string} cover значение из ASSET_COVER_LEVELS
 * @property {boolean} destructible
 * @property {number} hp
 * @property {boolean} interactive
 * @property {{min: number, max: number}} scaleRange допустимый разброс масштаба
 */

const BUILDING = Object.freeze(['building', 'tavern', 'house', 'interior'])
const YARD = Object.freeze(['building', 'tavern', 'house', 'yard', 'exterior'])

/**
 * Короткая запись: всё, что не указано, берёт значения по умолчанию.
 * @param {string} id
 * @param {Partial<AssetEntry>} overrides
 * @returns {AssetEntry}
 */
function entry(id, overrides = {}) {
  return {
    id,
    kind: 'prop',
    themes: [...BUILDING],
    baseFootprint: { w: 1, h: 1 },
    anchor: 'center',
    vector: id,
    raster: null,
    rightsId: null,
    blocksMove: false,
    blocksSight: false,
    cover: 'none',
    destructible: false,
    hp: 0,
    interactive: false,
    scaleRange: { min: 0.9, max: 1.1 },
    ...overrides,
  }
}

/**
 * Набор под тему «здание с участком» — сцена-эталон из раздела 1 плана.
 * Раздел 12 плана даёт ориентир 60–75 записей.
 *
 * Ни у одной записи пока нет растра: `raster` заполняется отдельно, когда под
 * набор будут зафиксированы права. До тех пор рендер рисует вектор, а при его
 * отсутствии — плоскую заливку. Не описывать эти записи как «нарисованные».
 */
const ENTRIES = Object.freeze([
  // --- Мебель общего зала ---------------------------------------------
  entry('table_round', { baseFootprint: { w: 2, h: 2 }, blocksMove: true, cover: 'half', destructible: true, hp: 12, scaleRange: { min: 0.85, max: 1.15 } }),
  entry('table_long', { baseFootprint: { w: 3, h: 1 }, blocksMove: true, cover: 'half', destructible: true, hp: 15 }),
  entry('table_small', { blocksMove: true, cover: 'half', destructible: true, hp: 8 }),
  entry('bench', { baseFootprint: { w: 2, h: 1 }, anchor: 'wall', destructible: true, hp: 8 }),
  entry('chair', { destructible: true, hp: 5, scaleRange: { min: 0.85, max: 1.1 } }),
  entry('stool', { destructible: true, hp: 4, scaleRange: { min: 0.8, max: 1.1 } }),
  entry('bar_counter', { baseFootprint: { w: 4, h: 1 }, anchor: 'wall', blocksMove: true, cover: 'three_quarters', destructible: true, hp: 25 }),
  entry('bar_shelf', { baseFootprint: { w: 3, h: 1 }, anchor: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' }),
  entry('fireplace', { baseFootprint: { w: 2, h: 1 }, anchor: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters', interactive: true }),
  entry('hearth_fire', { anchor: 'wall', interactive: true, scaleRange: { min: 0.8, max: 1.2 } }),
  entry('cauldron', { anchor: 'wall', interactive: true, destructible: true, hp: 10 }),
  entry('firewood_stack', { anchor: 'wall', blocksMove: true, cover: 'half', destructible: true, hp: 8 }),

  // --- Хранение и утварь ----------------------------------------------
  entry('barrel', { anchor: 'wall', blocksMove: true, cover: 'half', destructible: true, hp: 10, scaleRange: { min: 0.85, max: 1.15 } }),
  entry('barrel_stack', { baseFootprint: { w: 2, h: 1 }, anchor: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters', destructible: true, hp: 18 }),
  entry('keg', { anchor: 'wall', blocksMove: true, cover: 'half', destructible: true, hp: 8 }),
  entry('crate', { anchor: 'wall', blocksMove: true, cover: 'half', destructible: true, hp: 10, scaleRange: { min: 0.85, max: 1.15 } }),
  entry('crate_stack', { anchor: 'corner', blocksMove: true, blocksSight: true, cover: 'three_quarters', destructible: true, hp: 16 }),
  entry('sack', { anchor: 'wall', destructible: true, hp: 4, scaleRange: { min: 0.8, max: 1.2 } }),
  entry('basket', { anchor: 'wall', destructible: true, hp: 3, scaleRange: { min: 0.8, max: 1.2 } }),
  entry('bucket', { scaleRange: { min: 0.8, max: 1.1 } }),
  entry('chest', { anchor: 'wall', blocksMove: true, cover: 'half', destructible: true, hp: 14, interactive: true }),
  entry('cupboard', { anchor: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters', interactive: true }),
  entry('wardrobe', { baseFootprint: { w: 2, h: 1 }, anchor: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters', interactive: true }),
  entry('bookshelf', { baseFootprint: { w: 2, h: 1 }, anchor: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters', interactive: true }),
  entry('shelf_wall', { baseFootprint: { w: 2, h: 1 }, anchor: 'wall' }),
  entry('broom', { anchor: 'corner', scaleRange: { min: 0.9, max: 1.05 } }),

  // --- Мелочь на столах: футпринт пуст, предмет ничего не занимает -----
  entry('mug', { baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.7, max: 1.1 } }),
  entry('plate', { baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.8, max: 1.1 } }),
  entry('bowl_stew', { baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.8, max: 1.1 } }),
  entry('bottle', { baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.75, max: 1.15 } }),
  entry('jug', { baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.8, max: 1.15 } }),
  entry('bread_loaf', { baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.8, max: 1.2 } }),
  entry('cheese_wheel', { baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.8, max: 1.15 } }),
  entry('candle', { baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.8, max: 1.1 } }),
  entry('dice_cup', { baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.85, max: 1.05 } }),
  entry('coin_pile', { baseFootprint: { w: 0, h: 0 }, interactive: true, scaleRange: { min: 0.8, max: 1.2 } }),
  entry('lute', { baseFootprint: { w: 0, h: 0 }, interactive: true }),
  entry('cutting_board', { baseFootprint: { w: 0, h: 0 } }),
  entry('pot', { baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.8, max: 1.15 } }),

  // --- Спальные помещения ---------------------------------------------
  entry('bed', { baseFootprint: { w: 2, h: 1 }, anchor: 'wall', blocksMove: true, cover: 'half', destructible: true, hp: 10 }),
  entry('bunk_bed', { baseFootprint: { w: 2, h: 1 }, anchor: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' }),
  entry('night_table', { anchor: 'wall', destructible: true, hp: 5 }),
  entry('washbasin', { anchor: 'wall' }),

  // --- Освещение и убранство ------------------------------------------
  entry('torch_wall', { kind: 'decal', baseFootprint: { w: 0, h: 0 }, anchor: 'wall', interactive: true }),
  entry('lantern_wall', { kind: 'decal', baseFootprint: { w: 0, h: 0 }, anchor: 'wall', interactive: true }),
  entry('candelabra', { destructible: true, hp: 4 }),
  entry('banner', { kind: 'decal', baseFootprint: { w: 0, h: 0 }, anchor: 'wall' }),
  entry('sign_board', { kind: 'decal', baseFootprint: { w: 0, h: 0 }, anchor: 'wall' }),
  entry('rug', { kind: 'decal', baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.9, max: 1.3 } }),
  entry('floor_stain', { kind: 'decal', baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.7, max: 1.4 } }),

  // --- Переходы --------------------------------------------------------
  entry('stairs_up', { baseFootprint: { w: 2, h: 1 }, anchor: 'wall', interactive: true }),
  entry('stairs_down', { baseFootprint: { w: 2, h: 1 }, anchor: 'wall', interactive: true }),
  entry('trapdoor', { kind: 'decal', baseFootprint: { w: 0, h: 0 }, interactive: true }),

  // --- Внешняя территория ---------------------------------------------
  entry('tree_oak', { themes: [...YARD], baseFootprint: { w: 2, h: 2 }, blocksMove: true, blocksSight: true, cover: 'three_quarters', destructible: true, hp: 40, scaleRange: { min: 0.8, max: 1.4 } }),
  entry('tree_pine', { themes: [...YARD], baseFootprint: { w: 1, h: 1 }, blocksMove: true, blocksSight: true, cover: 'three_quarters', destructible: true, hp: 30, scaleRange: { min: 0.8, max: 1.5 } }),
  entry('tree_birch', { themes: [...YARD], blocksMove: true, blocksSight: true, cover: 'half', destructible: true, hp: 22, scaleRange: { min: 0.85, max: 1.35 } }),
  entry('tree_dead', { themes: [...YARD], blocksMove: true, cover: 'half', destructible: true, hp: 18, scaleRange: { min: 0.8, max: 1.3 } }),
  entry('tree_stump', { themes: [...YARD], cover: 'half', scaleRange: { min: 0.8, max: 1.2 } }),
  entry('bush', { themes: [...YARD], blocksSight: true, cover: 'half', scaleRange: { min: 0.75, max: 1.35 } }),
  entry('shrub', { themes: [...YARD], cover: 'half', scaleRange: { min: 0.75, max: 1.3 } }),
  entry('grass_tuft', { themes: [...YARD], kind: 'decal', baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.7, max: 1.4 } }),
  entry('flowers', { themes: [...YARD], kind: 'decal', baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.7, max: 1.3 } }),
  entry('rock_small', { themes: [...YARD], cover: 'half', scaleRange: { min: 0.7, max: 1.3 } }),
  entry('boulder', { themes: [...YARD], blocksMove: true, blocksSight: true, cover: 'three_quarters', scaleRange: { min: 0.85, max: 1.4 } }),
  entry('woodpile', { themes: [...YARD], anchor: 'wall', baseFootprint: { w: 2, h: 1 }, blocksMove: true, cover: 'half', destructible: true, hp: 12 }),
  entry('cart', { themes: [...YARD], baseFootprint: { w: 2, h: 1 }, blocksMove: true, cover: 'half', destructible: true, hp: 20 }),
  entry('wagon_wheel', { themes: [...YARD], anchor: 'wall', cover: 'half', destructible: true, hp: 6 }),
  entry('hitching_post', { themes: [...YARD], interactive: true }),
  entry('water_trough', { themes: [...YARD], baseFootprint: { w: 2, h: 1 }, blocksMove: true, cover: 'half' }),
  entry('well', { themes: [...YARD], baseFootprint: { w: 2, h: 2 }, blocksMove: true, cover: 'half', interactive: true }),
  entry('lamp_post', { themes: [...YARD], interactive: true }),
  entry('signpost', { themes: [...YARD], interactive: true }),
  entry('haystack', { themes: [...YARD], baseFootprint: { w: 2, h: 2 }, blocksMove: true, blocksSight: true, cover: 'three_quarters', destructible: true, hp: 10, scaleRange: { min: 0.85, max: 1.25 } }),
  entry('path_stone', { themes: [...YARD], kind: 'decal', baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.7, max: 1.3 } }),
  entry('campfire', { themes: [...YARD], interactive: true }),
])

/** @type {Map<string, AssetEntry>} */
const BY_ID = new Map(ENTRIES.map((record) => [record.id, record]))

/**
 * @param {string} id
 * @returns {AssetEntry|null}
 */
export function assetById(id) {
  return BY_ID.get(String(id)) ?? null
}

/**
 * @param {string} theme
 * @returns {AssetEntry[]}
 */
export function assetsForTheme(theme) {
  const wanted = String(theme ?? '')
  return ENTRIES.filter((record) => record.themes.includes(wanted))
}

/** @returns {AssetEntry[]} */
export function listAssets() {
  return [...ENTRIES]
}

/**
 * Пути, зарегистрированные в `data/asset-rights.json`. Растровая запись обязана
 * ссылаться на одну из них: правило «не смешивать случайные стили внутри
 * кампании» и регистрация хешей уже действуют (`docs/map-library.md`).
 *
 * @param {string} [rightsFile]
 * @returns {Set<string>}
 */
export function registeredRightsIds(rightsFile = fileURLToPath(new URL('../data/asset-rights.json', import.meta.url))) {
  try {
    const raw = JSON.parse(readFileSync(rightsFile, 'utf8'))
    const assets = Array.isArray(raw?.assets) ? raw.assets : []
    return new Set(assets.map((/** @type {unknown[]} */ record) => String(record?.[0] ?? '')))
  } catch {
    return new Set()
  }
}

/**
 * Проверка реестра. Возвращает список замечаний, а не бросает: реестр читается
 * на старте, и одна плохая запись не должна ронять сервер.
 *
 * @param {AssetEntry[]} [entries]
 * @param {Set<string>} [rightsIds]
 * @returns {{ok: boolean, errors: Array<{code: string, message: string, at?: string}>}}
 */
export function validateAssetRegistry(entries = listAssets(), rightsIds = registeredRightsIds()) {
  /** @type {Array<{code: string, message: string, at?: string}>} */
  const errors = []
  /** @type {Set<string>} */
  const seen = new Set()
  for (const record of entries) {
    if (!record.id) errors.push({ code: 'ASSET_ID_REQUIRED', message: 'У записи реестра нет идентификатора' })
    if (seen.has(record.id)) errors.push({ code: 'ASSET_ID_NOT_UNIQUE', message: `Ассет ${record.id} объявлен дважды`, at: record.id })
    seen.add(record.id)
    if (!ASSET_KINDS.includes(record.kind)) {
      errors.push({ code: 'ASSET_KIND_NOT_ALLOWED', message: `Недопустимый вид ассета: ${record.kind}`, at: record.id })
    }
    if (!ASSET_ANCHORS.includes(record.anchor)) {
      errors.push({ code: 'ASSET_ANCHOR_NOT_ALLOWED', message: `Недопустимый якорь: ${record.anchor}`, at: record.id })
    }
    if (!ASSET_COVER_LEVELS.includes(record.cover)) {
      errors.push({ code: 'ASSET_COVER_NOT_ALLOWED', message: `Недопустимое укрытие: ${record.cover}`, at: record.id })
    }
    if (!record.vector && !record.raster) {
      errors.push({ code: 'ASSET_HAS_NO_DRAWING', message: `У ассета ${record.id} нет ни вектора, ни растра`, at: record.id })
    }
    if (record.raster && !record.rightsId) {
      errors.push({ code: 'ASSET_RASTER_WITHOUT_RIGHTS', message: `Растровый ассет ${record.id} не ссылается на права`, at: record.id })
    }
    if (record.rightsId && !rightsIds.has(record.rightsId)) {
      errors.push({ code: 'ASSET_RIGHTS_NOT_REGISTERED', message: `Права ${record.rightsId} не зарегистрированы в data/asset-rights.json`, at: record.id })
    }
    if (record.baseFootprint.w < 0 || record.baseFootprint.h < 0
      || (record.baseFootprint.w === 0) !== (record.baseFootprint.h === 0)) {
      errors.push({ code: 'ASSET_FOOTPRINT_INVALID', message: `Футпринт ${record.id} задан неверно`, at: record.id })
    }
    if (!(record.scaleRange.min > 0) || record.scaleRange.max < record.scaleRange.min) {
      errors.push({ code: 'ASSET_SCALE_RANGE_INVALID', message: `Разброс масштаба ${record.id} задан неверно`, at: record.id })
    }
    // Предмет с футпринтом больше клетки обязан её занимать: иначе укрытие и
    // проходимость расходятся с тем, что видно на карте.
    if (record.blocksMove && record.baseFootprint.w === 0) {
      errors.push({ code: 'ASSET_BLOCKS_WITHOUT_FOOTPRINT', message: `Ассет ${record.id} перекрывает движение, но не занимает клеток`, at: record.id })
    }
  }
  return { ok: errors.length === 0, errors }
}

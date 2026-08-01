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
 * Темы этапа M6.
 *
 * Метка `interior` принадлежит теме здания и общим видом помещения **не
 * является**: иначе саркофаг и сталагмит попадали бы в набор таверны. У храма,
 * склепа и пещеры метка своя.
 *
 * Растительность двора переиспользуется лесом и дорогой осознанно: это одни и
 * те же деревья, и рисовать их дважды незачем.
 */
const TEMPLE = Object.freeze(['temple'])
const CRYPT = Object.freeze(['crypt'])
const CAVE = Object.freeze(['cave'])
const WILD = Object.freeze(['forest', 'road', 'settlement', 'exterior'])

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
 * Тема проёмов. Рендер выбирает запись по виду ребра и состоянию двери, а не
 * по теме сцены, поэтому отдельная тема здесь — это способ **не** попасть в
 * каталог расстановки предметов.
 */
export const OPENINGS_THEME = 'openings'

/**
 * @param {string} id
 * @param {'door_leaf'|'wall_segment'} kind
 * @param {Partial<AssetEntry>} [overrides]
 */
function opening(id, kind, overrides = {}) {
  return entry(id, {
    kind,
    themes: [OPENINGS_THEME],
    baseFootprint: { w: 0, h: 0 },
    anchor: 'wall',
    ...overrides,
  })
}

const OPENINGS = Object.freeze([
  opening('door_closed', 'door_leaf', { interactive: true, destructible: true, hp: 15 }),
  opening('door_open', 'door_leaf', { interactive: true, destructible: true, hp: 15 }),
  opening('door_iron', 'door_leaf', { interactive: true, destructible: true, hp: 30 }),
  opening('door_broken', 'door_leaf'),
  opening('window_glazed', 'wall_segment', { destructible: true, hp: 4 }),
  opening('arrow_slit', 'wall_segment'),
  opening('rail_fence', 'wall_segment', { destructible: true, hp: 8 }),
  opening('ledge_step', 'wall_segment'),
  opening('portcullis_gate', 'wall_segment', { interactive: true, destructible: true, hp: 40 }),
])

/**
 * Набор под тему «здание с участком» — сцена-эталон из раздела 1 плана.
 * Раздел 12 плана даёт ориентир 60–75 записей.
 *
 * Здесь записи объявлены **без растра**: поле `raster` доклеивается ниже из
 * манифеста атласа, если атлас собран. Так у набора один источник правды —
 * сам атлас, — и пересборка набора не требует правки сотни строк реестра.
 */
const DECLARED = Object.freeze([
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
  entry('tree_oak', { themes: [...YARD, ...WILD], baseFootprint: { w: 2, h: 2 }, blocksMove: true, blocksSight: true, cover: 'three_quarters', destructible: true, hp: 40, scaleRange: { min: 0.8, max: 1.4 } }),
  entry('tree_pine', { themes: [...YARD, ...WILD], baseFootprint: { w: 1, h: 1 }, blocksMove: true, blocksSight: true, cover: 'three_quarters', destructible: true, hp: 30, scaleRange: { min: 0.8, max: 1.5 } }),
  entry('tree_birch', { themes: [...YARD, ...WILD], blocksMove: true, blocksSight: true, cover: 'half', destructible: true, hp: 22, scaleRange: { min: 0.85, max: 1.35 } }),
  entry('tree_dead', { themes: [...YARD, ...WILD], blocksMove: true, cover: 'half', destructible: true, hp: 18, scaleRange: { min: 0.8, max: 1.3 } }),
  entry('tree_stump', { themes: [...YARD, ...WILD], cover: 'half', scaleRange: { min: 0.8, max: 1.2 } }),
  entry('bush', { themes: [...YARD, ...WILD], blocksSight: true, cover: 'half', scaleRange: { min: 0.75, max: 1.35 } }),
  entry('shrub', { themes: [...YARD, ...WILD], cover: 'half', scaleRange: { min: 0.75, max: 1.3 } }),
  entry('grass_tuft', { themes: [...YARD, ...WILD], kind: 'decal', baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.7, max: 1.4 } }),
  entry('flowers', { themes: [...YARD, ...WILD], kind: 'decal', baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.7, max: 1.3 } }),
  entry('rock_small', { themes: [...YARD, ...WILD], cover: 'half', scaleRange: { min: 0.7, max: 1.3 } }),
  entry('boulder', { themes: [...YARD, ...WILD], blocksMove: true, blocksSight: true, cover: 'three_quarters', scaleRange: { min: 0.85, max: 1.4 } }),
  entry('woodpile', { themes: [...YARD, ...WILD], anchor: 'wall', baseFootprint: { w: 2, h: 1 }, blocksMove: true, cover: 'half', destructible: true, hp: 12 }),
  entry('cart', { themes: [...YARD, ...WILD], baseFootprint: { w: 2, h: 1 }, blocksMove: true, cover: 'half', destructible: true, hp: 20 }),
  entry('wagon_wheel', { themes: [...YARD, ...WILD], anchor: 'wall', cover: 'half', destructible: true, hp: 6 }),
  entry('hitching_post', { themes: [...YARD, ...WILD], interactive: true }),
  entry('water_trough', { themes: [...YARD, ...WILD], baseFootprint: { w: 2, h: 1 }, blocksMove: true, cover: 'half' }),
  entry('well', { themes: [...YARD, ...WILD], baseFootprint: { w: 2, h: 2 }, blocksMove: true, cover: 'half', interactive: true }),
  entry('lamp_post', { themes: [...YARD, ...WILD], interactive: true }),
  entry('signpost', { themes: [...YARD, ...WILD], interactive: true }),
  entry('haystack', { themes: [...YARD, ...WILD], baseFootprint: { w: 2, h: 2 }, blocksMove: true, blocksSight: true, cover: 'three_quarters', destructible: true, hp: 10, scaleRange: { min: 0.85, max: 1.25 } }),
  entry('path_stone', { themes: [...YARD, ...WILD], kind: 'decal', baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.7, max: 1.3 } }),
  entry('campfire', { themes: [...YARD, ...WILD], interactive: true }),

  // --- Храм --------------------------------------------------------------
  entry('pillar', { themes: [...TEMPLE], blocksMove: true, blocksSight: true, cover: 'three_quarters' }),
  entry('altar', { themes: [...TEMPLE, ...CRYPT], baseFootprint: { w: 2, h: 1 }, anchor: 'wall', blocksMove: true, cover: 'half', interactive: true }),
  entry('statue', { themes: [...TEMPLE, ...CRYPT], blocksMove: true, blocksSight: true, cover: 'three_quarters' }),
  entry('brazier', { themes: [...TEMPLE, ...CRYPT], interactive: true, destructible: true, hp: 6 }),
  entry('offering_bowl', { themes: [...TEMPLE], baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.8, max: 1.1 } }),
  entry('prayer_bench', { themes: [...TEMPLE], baseFootprint: { w: 2, h: 1 }, anchor: 'wall', destructible: true, hp: 8 }),
  entry('temple_banner', { themes: [...TEMPLE], kind: 'decal', baseFootprint: { w: 0, h: 0 }, anchor: 'wall' }),
  entry('reliquary', { themes: [...TEMPLE], anchor: 'wall', blocksMove: true, cover: 'half', interactive: true }),
  entry('mosaic', { themes: [...TEMPLE], kind: 'decal', baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.9, max: 1.4 } }),

  // --- Склеп -------------------------------------------------------------
  entry('sarcophagus', { themes: [...CRYPT], baseFootprint: { w: 2, h: 1 }, blocksMove: true, cover: 'half', interactive: true, destructible: true, hp: 25 }),
  // Могила читалась мелкой: насыпь размером ровно в клетку выглядит как
  // коврик, а не как захоронение. Настоящий двухклеточный footprint здесь
  // невозможен без перерисовки штампа — кадр в атласе 83×96, то есть могила
  // нарисована одноклеточной, и в рамке 2×1 спрайт остался бы прежней высоты
  // и потерялся бы в пустоте. Поэтому увеличен рисунок, а не занимаемые
  // клетки: насыпь выходит за края своей клетки, как и положено.
  entry('grave', { themes: [...CRYPT], anchor: 'wall', cover: 'half', scaleRange: { min: 1.3, max: 1.5 } }),
  entry('bone_pile', { themes: [...CRYPT, ...CAVE], baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.7, max: 1.3 } }),
  entry('urn', { themes: [...CRYPT], anchor: 'wall', destructible: true, hp: 4 }),
  entry('crypt_niche', { themes: [...CRYPT], anchor: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' }),
  entry('cobweb', { themes: [...CRYPT, ...CAVE], kind: 'decal', baseFootprint: { w: 0, h: 0 }, anchor: 'corner' }),

  // --- Пещера ------------------------------------------------------------
  entry('stalagmite', { themes: [...CAVE], blocksMove: true, cover: 'half', scaleRange: { min: 0.7, max: 1.5 } }),
  entry('cave_pool', { themes: [...CAVE], baseFootprint: { w: 2, h: 2 }, blocksMove: true, cover: 'none' }),
  entry('mushroom_cluster', { themes: [...CAVE], baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.7, max: 1.4 } }),
  entry('ore_vein', { themes: [...CAVE], kind: 'decal', baseFootprint: { w: 0, h: 0 }, anchor: 'wall', interactive: true }),
  entry('rubble_heap', { themes: [...CAVE], cover: 'half', scaleRange: { min: 0.8, max: 1.3 } }),

  // --- Лес, дорога, поселение --------------------------------------------
  entry('tree_spruce', { themes: [...WILD], baseFootprint: { w: 2, h: 2 }, blocksMove: true, blocksSight: true, cover: 'three_quarters', destructible: true, hp: 35, scaleRange: { min: 0.8, max: 1.4 } }),
  entry('fallen_log', { themes: [...WILD], baseFootprint: { w: 2, h: 1 }, cover: 'half' }),
  entry('fern', { themes: [...WILD], kind: 'decal', baseFootprint: { w: 0, h: 0 }, scaleRange: { min: 0.7, max: 1.3 } }),
  entry('milestone', { themes: [...WILD], anchor: 'wall', cover: 'half' }),
  entry('roadside_shrine', { themes: [...WILD], anchor: 'wall', blocksMove: true, cover: 'half', interactive: true }),
  entry('market_stall', { themes: ['settlement', 'exterior'], baseFootprint: { w: 2, h: 2 }, blocksMove: true, cover: 'half' }),
  entry('village_fence', { themes: ['settlement', 'exterior'], baseFootprint: { w: 2, h: 1 }, anchor: 'wall', cover: 'half' }),

  // --- Проёмы на рёбрах ----------------------------------------------------
  // Ребро — не клетка (решение Р2): эти записи ничего не занимают, никого не
  // держат и укрытия не дают. Проходимость, обзор и укрытие задаёт само ребро,
  // а запись отвечает только за рисунок.
  //
  // Тема у них своя — `openings`. В темы помещений они не входят намеренно:
  // расстановка предметов берёт каталог по теме (`prop-placement.mjs`), и
  // дверь, попавшая в этот каталог, встала бы посреди зала как мебель.
  ...OPENINGS,
])

/**
 * Манифест растрового атласа предметов. Собирается инструментом
 * `tools/build-prop-atlas.mjs` из листов штампов и лежит рядом с самим атласом
 * в `public/assets`.
 *
 * Читается терпимо: нет файла, битый JSON, пустой набор кадров — реестр
 * остаётся векторным и доска рисует вектор. Играбельность без арта —
 * блокирующее требование (решение Р6 плана), поэтому отсутствие атласа не
 * является ошибкой.
 */
export const PROP_ATLAS_FILE = fileURLToPath(new URL('../public/assets/maps/props/prop-atlas.json', import.meta.url))

/**
 * @typedef {object} PropAtlas
 * @property {string} image путь внутри `public/assets`, он же `rightsId`
 * @property {number} cellPixels
 * @property {Record<string, {x: number, y: number, w: number, h: number}>} frames
 */

/**
 * @param {string} [file]
 * @returns {PropAtlas}
 */
export function readPropAtlas(file = PROP_ATLAS_FILE) {
  const empty = { image: '', cellPixels: 0, frames: {} }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const image = String(raw?.image ?? '')
    const frames = raw?.frames && typeof raw.frames === 'object' ? raw.frames : {}
    if (!image || !Object.keys(frames).length) return empty
    return { image, cellPixels: Number(raw?.cellPixels) || 0, frames }
  } catch {
    return empty
  }
}

/**
 * Растр приклеивается к записи по идентификатору кадра. Записи без кадра
 * остаются векторными: набор наполняется темами постепенно, и половина
 * реестра без спрайтов — это штатное состояние, а не поломка.
 *
 * Единственный источник растра — атлас, поэтому запись без кадра теряет
 * `raster` и `rightsId`, даже если они у неё были. Иначе пересборка набора
 * оставила бы в реестре ссылку на спрайт, которого в атласе уже нет.
 *
 * @param {AssetEntry[]} entries
 * @param {PropAtlas} atlas
 * @returns {AssetEntry[]}
 */
export function withAtlasArt(entries, atlas) {
  return entries.map((record) => (atlas.image && atlas.frames[record.id]
    ? { ...record, raster: `${atlas.image}#${record.id}`, rightsId: atlas.image }
    : { ...record, raster: null, rightsId: null }))
}

const ENTRIES = Object.freeze(withAtlasArt(/** @type {AssetEntry[]} */ ([...DECLARED]), readPropAtlas()))

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

// @ts-check
import { createHash } from 'node:crypto'

import { authoredLocationMapFor } from './authored-location-maps.mjs'
import { buildAresFortressScene, buildBuildingScene } from './building-generator.mjs'
import { buildSceneFromGraph } from './graph-layout.mjs'
import { buildSettlementScene } from './settlement-generator.mjs'
import { addSceneLink, addSceneZone, createSceneGraph } from './scene-graph.mjs'
import { assetById } from './asset-registry.mjs'
import { ensurePropAccess, placeColonnade, placeProps } from './prop-placement.mjs'
import {
  SIZE_CLASSES,
  addProp,
  addSpawnPoint,
  addZone,
  cellAt,
  createTacticalMap,
  edgeBetween,
  edgeList,
  edgeNeighbor,
  floorVariantAt,
  setCell,
  setDoor,
  setEdge,
} from './tactical-map.mjs'

/**
 * Каталог тем сцены — этап M6 (`docs/tactical-map-plan.md`, раздел 12).
 *
 * Тема = набор материалов, набор предметов и правила расстановки. Геометрия
 * берётся одним из трёх способов, и выбор способа — часть темы:
 *
 * - `building` — здание с участком, отдельный генератор планировки;
 * - `graph` — сначала граф зон с проверкой ключей, затем подходящая теме
 *   геометрия. Храм и склеп получают помещения, пещера — органическую полость;
 * - `open` — открытая местность без помещений: лес и дорога;
 * - `settlement` — поселение с семейством улиц, неодинаковыми зданиями и
 *   местными ориентирами: площадью, воротами, причалами или переправой.
 *
 * Опознание темы идёт по названию локации и по виду сцены. Это единственное
 * место, где такое опознание живёт: раньше оно было размазано регулярками по
 * `dynamic-map.mjs`.
 */

/**
 * Склеп и храм берут подсвечники, сундуки и ковры из интерьера, но не
 * мебель жилья: ни кроватей, ни стойки, ни бочек в нефе.
 */
const DWELLING_FURNITURE_OFF = Object.freeze({
  bed: 0, bunk_bed: 0, bar_counter: 0, bar_shelf: 0, table_round: 0, table_long: 0, table_small: 0, chair: 0, stool: 0, bench: 0,
  barrel: 0, barrel_stack: 0, keg: 0, crate: 0, crate_stack: 0, sack: 0, basket: 0, bucket: 0, cupboard: 0, wardrobe: 0, broom: 0,
  fireplace: 0, hearth_fire: 0, cauldron: 0, firewood_stack: 0, mug: 0, plate: 0, bowl_stew: 0, bottle: 0, jug: 0, bread_loaf: 0,
  cheese_wheel: 0, dice_cup: 0, lute: 0, cutting_board: 0, pot: 0, night_table: 0, washbasin: 0, sign_board: 0, floor_stain: 0,
  stairs_up: 0, stairs_down: 0, trapdoor: 0, lantern_wall: 0, bookshelf: 0, shelf_wall: 0,
})
const TEMPLE_INTERIOR_CAPS = DWELLING_FURNITURE_OFF
/** Подземелью мебель нужна по делу: стол стражи, нары, бочки — не кровать и не люстра. */
const DUNGEON_INTERIOR_CAPS = Object.freeze({
  bed: 0, bar_counter: 0, bar_shelf: 0, table_round: 0, table_royal: 0, royal_throne: 0, chandelier: 0, candelabra: 0, rug: 0, cupboard: 0, wardrobe: 0,
  night_table: 0, washbasin: 0, lute: 0, dice_cup: 1, mug: 2, plate: 1, bowl_stew: 1, bread_loaf: 1, cheese_wheel: 0, bottle: 1, jug: 1, cutting_board: 0,
  fireplace: 0, hearth_fire: 0, firewood_stack: 0, broom: 0, stairs_up: 0, stairs_down: 0, trapdoor: 0, sign_board: 0, lantern_wall: 0, bookshelf: 0, shelf_wall: 0,
  banner: 0, floor_stain: 1, basket: 0, keg: 0, pot: 0,
})
const CRYPT_INTERIOR_CAPS = Object.freeze({ ...DWELLING_FURNITURE_OFF, chandelier: 0, rug: 0 })
/** Лагерь берёт из интерьера ящики, мешки и сундук, но не мебель дома. */
const CAMP_INTERIOR_OFF = Object.freeze({ ...DWELLING_FURNITURE_OFF, crate: 3, sack: 3, barrel: 2, chandelier: 0, candelabra: 0, rug: 0, chest: 1, torch_wall: 0, banner: 0, candle: 0, coin_pile: 1 })
/** Из пещерной темы склеп берёт только завалы, кости и паутину. */
const CRYPT_CAVE_CAPS = Object.freeze({ stalagmite: 0, cave_pool: 0, mushroom_cluster: 0, ore_vein: 0 })

/**
 * `live` — отдаётся ли тема живой игре. Сейчас готовы все семь; флаг остаётся
 * явным предохранителем для будущих тем, которые ещё хуже структурированного
 * fallback.
 *
 * Обычные здания и поселения используют версионированные генераторы;
 * сохранённые карты не проходят через эту фабрику повторно.
 */
export const SCENE_THEMES = Object.freeze([
  {
    id: 'building',
    label: 'Здание с участком',
    kind: 'building',
    live: true,
    material: 'wood',
    // `\b` в JavaScript опирается на латиницу и с кириллицей не работает.
    // Караван-сарай, подворье и ночлежка — те же постоялые дворы: здание с
    // двором, ровно то, что строит генератор. «Караван» без дефисной части не
    // берём: торговый караван в пути — это не постройка.
    // Кузница, мельница, башня, казарма, склад — тоже постройки с двором.
    // Прежде они не узнавались: кузница становилась лесом с прудом, башня и
    // мельница — дорогой, казарма городской стражи — целым городом.
    match: /таверн|трактир|постоял|корчм|харчевн|гостиниц|караван-сара|подворь|ночлежк|особняк|терем|(?<![а-яё])дом(?![а-яё])|(?<![а-яё])изб[аеуы](?![а-яё])|хижин|усадьб|поместь|лавк|кузн|кузниц|мельниц|(?<![а-яё])башн|казарм|караульн|(?<![а-яё])склад|амбар|конюшн|сторожк|библиотек|лаборатори|мастерск|пекарн|аптек|ратуш|кабак/iu,
  },
  {
    id: 'temple',
    label: 'Храм',
    kind: 'graph',
    live: true,
    material: 'marble',
    match: /храм|святилищ|капищ|алтар|собор|монастыр/iu,
    zones: ['Притвор', 'Неф', 'Алтарная', 'Ризница'],
    density: 14,
    require: ['altar', 'pillar', 'statue', 'brazier'],
    prefer: ['pillar', 'statue', 'brazier', 'prayer_bench', 'reliquary', 'mosaic', 'temple_banner'],
    // У каждого помещения храма своё назначение. Без плана все четыре
    // получали один список «алтарь, колонна, статуя, жаровня»: алтарь стоял в
    // притворе, а тринадцать статуй — где придётся.
    propPlans: [
      { density: 8, extraThemes: ['interior'], require: ['statue', 'brazier'], prefer: ['mosaic', 'temple_banner', 'offering_bowl', 'candelabra', 'rug'], caps: { altar: 0, statue: 2, pillar: 2, prayer_bench: 0, reliquary: 0, candelabra: 2, rug: 1, brazier: 2, offering_bowl: 2, ...TEMPLE_INTERIOR_CAPS } },
      { density: 10, colonnade: true, extraThemes: ['interior'], require: ['prayer_bench', 'prayer_bench', 'brazier'], prefer: ['prayer_bench', 'temple_banner', 'mosaic', 'brazier', 'chandelier', 'candelabra'], caps: { altar: 0, statue: 1, pillar: 0, reliquary: 0, brazier: 4, chandelier: 2, candelabra: 2, offering_bowl: 2, ...TEMPLE_INTERIOR_CAPS } },
      { density: 14, require: ['altar', 'reliquary', 'brazier', 'statue'], prefer: ['offering_bowl', 'temple_banner', 'mosaic', 'statue', 'reliquary'], caps: { altar: 1, reliquary: 2, statue: 2, pillar: 2, prayer_bench: 2, brazier: 2, offering_bowl: 3 } },
      { density: 18, theme: 'interior', purpose: 'store', require: ['chest', 'wardrobe', 'shelf_wall'], prefer: ['chest', 'shelf_wall', 'candle', 'table_small', 'bookshelf'], caps: { bed: 0, bunk_bed: 0, barrel_stack: 0, crate_stack: 1 } },
    ],
  },
  {
    id: 'crypt',
    label: 'Склеп',
    kind: 'graph',
    live: true,
    material: 'stone',
    match: /склеп|крипт|гробниц|усыпальниц|катакомб|мавзоле/iu,
    zones: ['Вход', 'Галерея', 'Погребальная', 'Тайник'],
    density: 16,
    require: ['sarcophagus', 'grave', 'urn', 'brazier'],
    prefer: ['grave', 'urn', 'crypt_niche', 'bone_pile', 'cobweb', 'statue'],
    // Склеп тоже разный по помещениям: у входа — стражи и свет, в галерее —
    // ниши вдоль стен, в погребальной — саркофаг, в тайнике — урны и кости.
    propPlans: [
      { density: 8, extraThemes: ['interior'], require: ['statue', 'brazier'], prefer: ['cobweb', 'urn', 'statue', 'candelabra', 'banner'], caps: { sarcophagus: 0, grave: 0, statue: 2, candelabra: 1, urn: 2, cobweb: 3, candle: 2, ...CRYPT_INTERIOR_CAPS } },
      { density: 14, extraThemes: ['interior', 'cave'], require: ['crypt_niche', 'crypt_niche', 'urn'], prefer: ['crypt_niche', 'urn', 'cobweb', 'bone_pile', 'rubble_heap', 'candle', 'torch_wall'], caps: { sarcophagus: 0, statue: 0, rubble_heap: 2, urn: 4, cobweb: 3, candle: 2, ...CRYPT_INTERIOR_CAPS, ...CRYPT_CAVE_CAPS } },
      { density: 16, extraThemes: ['interior'], require: ['sarcophagus', 'brazier', 'brazier'], prefer: ['grave', 'urn', 'crypt_niche', 'cobweb', 'candelabra', 'offering_bowl'], caps: { sarcophagus: 2, statue: 2, candelabra: 2, urn: 3, grave: 4, cobweb: 3, candle: 2, ...CRYPT_INTERIOR_CAPS } },
      { density: 20, extraThemes: ['interior', 'cave'], require: ['urn', 'bone_pile', 'chest'], prefer: ['urn', 'bone_pile', 'cobweb', 'crypt_niche', 'chest', 'coin_pile', 'rubble_heap'], caps: { sarcophagus: 1, chest: 2, coin_pile: 2, urn: 6, cobweb: 3, candle: 2, ...CRYPT_INTERIOR_CAPS, ...CRYPT_CAVE_CAPS } },
    ],
    locked: true,
  },
  {
    id: 'dungeon',
    label: 'Подземелье',
    kind: 'graph',
    live: true,
    material: 'stone',
    // Доска и погода видят подземелье как склеп: каменные своды, без неба.
    assetTheme: 'crypt',
    match: /подземель|темниц|тюрьм|каземат|застенк|узилищ/iu,
    zones: ['Караульная', 'Коридор', 'Камеры', 'Пыточная', 'Склад'],
    density: 14,
    locked: true,
    require: ['brazier', 'bone_pile', 'cobweb'],
    prefer: ['bone_pile', 'cobweb', 'brazier', 'urn', 'statue'],
    // Тюрьма под замком: стража у входа, коридор с факелами, камеры с
    // нарами и костями, пыточная, склад конфиската.
    propPlans: [
      { density: 14, extraThemes: ['interior'], require: ['table_small', 'chair', 'chest', 'torch_wall'], prefer: ['barrel', 'crate', 'bench', 'chair', 'torch_wall'], caps: { ...DUNGEON_INTERIOR_CAPS, torch_wall: 2, table_small: 1, chest: 1, barrel: 2, crate: 2, bench: 1, chair: 2, sarcophagus: 0, crypt_niche: 0, grave: 0, urn: 0, altar: 0 } },
      { density: 8, extraThemes: ['interior', 'cave'], require: ['torch_wall', 'cobweb'], prefer: ['torch_wall', 'cobweb', 'rubble_heap', 'bone_pile'], caps: { ...DUNGEON_INTERIOR_CAPS, torch_wall: 4, rubble_heap: 2, bone_pile: 2, stalagmite: 0, cave_pool: 0, mushroom_cluster: 0, ore_vein: 0, sarcophagus: 0, crypt_niche: 0, grave: 0, urn: 0, altar: 0, statue: 0 } },
      { density: 16, extraThemes: ['interior'], require: ['bunk_bed', 'bone_pile', 'bucket'], prefer: ['bunk_bed', 'bone_pile', 'cobweb', 'sack', 'bucket'], caps: { ...DUNGEON_INTERIOR_CAPS, torch_wall: 1, bunk_bed: 3, bucket: 2, sack: 2, sarcophagus: 0, crypt_niche: 0, grave: 0, urn: 0, altar: 0, statue: 0 } },
      { density: 14, extraThemes: ['interior'], require: ['brazier', 'table_long', 'chest'], prefer: ['cauldron', 'bone_pile', 'brazier', 'chest', 'cobweb'], caps: { ...DUNGEON_INTERIOR_CAPS, torch_wall: 2, table_long: 1, cauldron: 1, chest: 1, brazier: 2, sarcophagus: 0, crypt_niche: 0, grave: 0, urn: 0, altar: 0, statue: 0 } },
      { density: 22, theme: 'interior', purpose: 'store', require: ['crate_stack', 'chest'], prefer: ['crate', 'barrel', 'sack', 'chest', 'crate_stack'], caps: { bed: 0, bunk_bed: 0, table_long: 0, table_round: 0, bar_counter: 0, chandelier: 0, rug: 0, fireplace: 0 } },
    ],
  },
  {
    id: 'cave',
    label: 'Пещера',
    kind: 'graph',
    live: true,
    material: 'earth',
    match: /пещер|грот|каверн|штольн|шахт|рудник|логов|(?<![а-яё])нор[аеуы](?![а-яё])/iu,
    zones: ['Устье', 'Штрек', 'Зал', 'Тупик'],
    density: 18,
    require: ['stalagmite', 'cave_pool', 'rubble_heap'],
    prefer: ['stalagmite', 'rubble_heap', 'mushroom_cluster', 'bone_pile', 'ore_vein', 'cobweb'],
    // Устье ещё видит свет: валуны, папоротник, корни. Ход — порода и руда.
    // Дальний зал — логово: кости, лужа, костровище и чужая добыча.
    propPlans: [
      { density: 12, extraThemes: ['forest'], require: ['boulder', 'rubble_heap'], prefer: ['boulder', 'rock_small', 'fern', 'bush', 'stalagmite', 'rubble_heap'], caps: { tree_oak: 0, tree_pine: 0, tree_birch: 0, tree_spruce: 0, tree_dead: 0, cart: 0, well: 0, haystack: 0, signpost: 0, milestone: 0, lamp_post: 0, roadside_shrine: 0, hitching_post: 0, water_trough: 0, wagon_wheel: 0, flowers: 0, woodpile: 0, path_stone: 0, campfire: 0, grass_tuft: 1 } },
      { density: 16, extraThemes: ['forest'], require: ['stalagmite', 'ore_vein'], prefer: ['stalagmite', 'ore_vein', 'rubble_heap', 'mushroom_cluster', 'rock_small', 'boulder', 'cobweb'], caps: { tree_oak: 0, tree_pine: 0, tree_birch: 0, tree_spruce: 0, tree_dead: 0, cart: 0, well: 0, haystack: 0, signpost: 0, milestone: 0, lamp_post: 0, roadside_shrine: 0, hitching_post: 0, water_trough: 0, wagon_wheel: 0, flowers: 0, woodpile: 0, path_stone: 0, campfire: 0, grass_tuft: 0, fern: 0, bush: 0, shrub: 0, fallen_log: 0, tree_stump: 0 } },
      { density: 16, extraThemes: ['interior', 'forest'], require: ['cave_pool', 'bone_pile', 'campfire', 'chest'], prefer: ['bone_pile', 'mushroom_cluster', 'stalagmite', 'sack', 'crate', 'barrel', 'cobweb', 'rubble_heap'], caps: { tree_oak: 0, tree_pine: 0, tree_birch: 0, tree_spruce: 0, tree_dead: 0, cart: 0, well: 0, haystack: 0, signpost: 0, milestone: 0, lamp_post: 0, roadside_shrine: 0, hitching_post: 0, water_trough: 0, wagon_wheel: 0, flowers: 0, woodpile: 0, path_stone: 0, campfire: 1, chest: 1, crate: 2, barrel: 1, sack: 2, grass_tuft: 0, fern: 0, bush: 0, shrub: 0, fallen_log: 0, tree_stump: 0 } },
    ],
  },
  {
    id: 'forest',
    label: 'Лес',
    kind: 'open',
    live: true,
    material: 'grass',
    // Существительные, а не прилагательные: «Лесная хижина» — хижина, а
    // «Хутор у леса» — хутор. «Бор» с границей слова, иначе «собор» — лес.
    match: /(?<![а-яё])(?:лес(?:а|у|ом|е|ов|ами|ах)?|чащ[аиуеё]\p{L}*|рощ[аиуеё]\p{L}*|бор(?:а|у|ом|е|ы)?|дубрав\p{L}*|пущ[аиуеё]\p{L}*|тайг\p{L}*|опушк\p{L}*|оазис\p{L}*|поляна|поляне|поляну|лагер\p{L}*|стоянк\p{L}*|бивак\p{L}*)(?![а-яё])/iu,
    // Каменная кромка забирает край участка: плотность выше, чтобы чаща
    // осталась чащей (v3 открытой местности).
    density: 22,
    require: ['tree_oak', 'tree_spruce', 'tree_birch', 'fallen_log', 'campfire'],
    prefer: ['tree_oak', 'tree_spruce', 'tree_birch', 'tree_pine', 'tree_dead', 'tree_stump', 'bush', 'shrub', 'boulder', 'fern', 'campfire'],
  },
  {
    id: 'road',
    label: 'Дорога',
    kind: 'open',
    live: true,
    // Обочины — луг, а не голая земля: с материалом `earth` вся карта сливалась
    // в одну коричневую плоскость, и сама дорога на ней не читалась. Полосу
    // утоптанной земли рисует layoutOpenTerrain поверх травы.
    material: 'grass',
    match: /дорог|тракт|путь|перекрёст|перекрест|мост|брод|перевал/iu,
    density: 12,
    require: ['milestone', 'tree_birch', 'cart', 'roadside_shrine'],
    prefer: ['tree_birch', 'tree_dead', 'bush', 'boulder', 'fern', 'path_stone', 'milestone'],
    road: true,
  },
  {
    id: 'graveyard',
    label: 'Кладбище',
    kind: 'open',
    live: true,
    material: 'grass',
    assetTheme: 'forest',
    match: /кладбищ|погост|могильник|некропол/iu,
    density: 10,
    require: ['tree_dead', 'roadside_shrine', 'statue'],
    prefer: ['tree_dead', 'bush', 'statue', 'rock_small', 'flowers', 'tree_oak', 'urn'],
    graves: true,
    flat: true,
  },
  {
    id: 'settlement',
    label: 'Поселение',
    kind: 'settlement',
    live: true,
    material: 'earth',
    // «Город» — существительное: «казарма городской стражи» — казарма.
    match: /деревн|поселен|(?<![а-яё])сел[оаеу](?![а-яё])|посад|хутор|(?<![а-яё])город(?:а|у|ом|е|ов)?(?![а-яё])|столиц|слобод|рынок|площад/iu,
    density: 14,
    require: ['market_stall', 'well', 'cart', 'village_fence'],
    // Одноклеточный `campfire` сохраняется и в legacy-клетках под известным
    // движку feature. `hitching_post` намеренно не здесь: старый контракт
    // encounter-cell такого идентификатора не знает.
    prefer: ['market_stall', 'village_fence', 'cart', 'haystack', 'woodpile', 'tree_birch', 'campfire'],
    road: true,
  },
])

/**
 * Небольшие варианты карт стартовых authored-миров. Они не становятся общими
 * эвристическими темами: их можно выбрать только явным `scene.map.theme_id`.
 * Так «порт» и «оазис» не разъезжаются с обычным городом, а дворец не
 * превращается в храм из-за слова `capital` на глобальной карте.
 */
/** @type {ReadonlyArray<Record<string, any>>} */
const AUTHORED_SCENE_THEMES = Object.freeze([
  {
    id: 'authored-harbor', label: 'Каменная гавань', kind: 'settlement', live: true,
    assetTheme: 'settlement', surfaceMaterial: 'stone', streetMaterial: 'earth', houseMaterial: 'stone', waterBand: 'right',
    density: 14, require: ['market_stall', 'well', 'cart', 'village_fence'],
    prefer: ['market_stall', 'cart', 'lamp_post', 'woodpile', 'campfire'],
  },
  {
    id: 'authored-oasis', label: 'Оазисная площадь', kind: 'settlement', live: true,
    assetTheme: 'settlement', surfaceMaterial: 'sand', streetMaterial: 'earth', houseMaterial: 'sand', waterBand: 'top',
    density: 14, require: ['market_stall', 'well', 'cart', 'village_fence'],
    prefer: ['market_stall', 'well', 'water_trough', 'cart', 'campfire'],
  },
  {
    id: 'authored-caldera-port', label: 'Пепельная гавань', kind: 'settlement', live: true,
    assetTheme: 'settlement', surfaceMaterial: 'stone', streetMaterial: 'earth', houseMaterial: 'stone', waterBand: 'left',
    density: 14, require: ['market_stall', 'well', 'cart', 'village_fence'],
    prefer: ['market_stall', 'cart', 'campfire', 'woodpile', 'lamp_post'],
  },
  {
    id: 'authored-palace', label: 'Военная галерея', kind: 'fortress', live: true, material: 'stone', assetTheme: 'building',
    zones: ['Большой внутренний двор', 'Военная галерея', 'Казарма', 'Конюшня', 'Военный склад', 'Мастерская'],
  },
])

/** @type {ReadonlyArray<Record<string, any>>} */
const ALL_SCENE_THEMES = Object.freeze([...SCENE_THEMES, ...AUTHORED_SCENE_THEMES])

/** Старые и короткие имена authored-крепости сходятся в один генератор. */
/** @type {Readonly<Record<string, string>>} */
const SCENE_THEME_ALIASES = Object.freeze({
  'ares-fortress': 'authored-palace',
  'authored-ares-fortress': 'authored-palace',
})

/** Идентификаторы тем, которые можно закрепить в авторском шаблоне карты. */
export const SCENE_THEME_IDS = new Set([...ALL_SCENE_THEMES.map((theme) => theme.id), ...Object.keys(SCENE_THEME_ALIASES)])

/** Тема по умолчанию, когда ничто не опознано. */
export const FALLBACK_THEME = SCENE_THEMES[0]

/**
 * @param {string|number} seed
 * @returns {() => number}
 */
function randomFor(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/**
 * Опознаёт тему сцены. Дикая местность никогда не становится зданием, даже если
 * в названии есть «дом»: «Дом у дороги» в лесу — это всё-таки лес.
 *
 * @param {object} input
 * @param {string} [input.location]
 * @param {string} [input.theme]
 * @param {string} [input.sceneKind]
 * @returns {typeof SCENE_THEMES[number]}
 */
export function themeFor(input = {}) {
  const matched = matchTheme(input)
  if (matched) return matched
  // Для прямого вызова без карты дикая местность всё равно безопасно
  // показывается лесом. Живой выбор генератора получает `null` от matchTheme и
  // успевает учесть layout/pattern до такого fallback.
  if (String(input.sceneKind) === 'wilderness') {
    return SCENE_THEMES.find((candidate) => candidate.id === 'forest') ?? FALLBACK_THEME
  }
  return FALLBACK_THEME
}

/**
 * То же опознание, но без подстановки темы по умолчанию: `null` означает «не
 * узнал». Вызывающий после этого выбирает структурированный fallback по виду
 * сцены и заявленной планировке.
 *
 * @param {object} input
 * @param {string} [input.location]
 * @param {string} [input.theme]
 * @param {string} [input.sceneKind]
 * @returns {typeof SCENE_THEMES[number]|null}
 */
export function matchTheme({ location = '', theme = '', sceneKind = '' } = {}) {
  const haystack = `${location} ${theme}`
  const wilderness = String(sceneKind) === 'wilderness'
  // Главное слово названия стоит первым: «Хутор у леса» — хутор, «Мост через
  // ущелье» — мост, «Казарма городской стражи» — казарма. Побеждает тема,
  // чьё слово встретилось раньше; при равенстве — порядок списка.
  /** @type {typeof SCENE_THEMES[number]|null} */
  let best = null
  let bestIndex = Number.POSITIVE_INFINITY
  for (const candidate of SCENE_THEMES) {
    if (wilderness && candidate.kind === 'building') continue
    const found = candidate.match.exec(haystack)
    if (found && found.index < bestIndex) {
      best = candidate
      bestIndex = found.index
    }
  }
  return best
}

/**
 * Узор и планировка из заявки картографа — тоже его слова, а не догадка по
 * названию. Часть значений называет тему однозначно: `crypt` — это склеп, а не
 * «что-то каменное». Остальные (`keep`, `great-hall`, `courtyard`, `bridge`,
 * `radial`, `ruins`, `natural`) своей темы не имеют и достаются безопасному
 * тематическому fallback по планировке.
 *
 * Сознательно не сопоставляется `small-room`: комната бывает в любом здании, и
 * по одному этому слову нельзя ставить дом с двором, оградой и деревьями.
 *
 * @param {{layout?: string, pattern?: string, theme_id?: string, themeId?: string}} [request]
 * @returns {Record<string, any>|null}
 */
export function themeFromMapRequest({ pattern = '', layout = '' } = {}) {
  /** @type {Record<string, string>} */
  const byPattern = {
    crypt: 'crypt',
    'cave-cluster': 'cave',
    village: 'settlement',
    bridge: 'road',
  }
  /** @type {Record<string, string>} */
  const byLayout = { cavern: 'cave', streets: 'settlement', winding: 'road' }
  const id = byPattern[String(pattern).toLocaleLowerCase('en')]
    ?? byLayout[String(layout).toLocaleLowerCase('en')]
    ?? ''
  return id ? SCENE_THEMES.find((candidate) => candidate.id === id) ?? null : null
}

/**
 * Безопасная тема для неопознанной локации. Это последний выбор геометрии, а
 * не попытка угадать художественный смысл: он сохраняет заявленную топологию
 * и всегда отдаёт структурированную, связную карту.
 *
 * @param {object} [input]
 * @param {string} [input.sceneKind]
 * @param {{layout?: string, pattern?: string, material?: string, theme_id?: string, themeId?: string}} [input.request]
 * @returns {Record<string, any>}
 */
export function fallbackThemeFor({ sceneKind = '', request = {} } = {}) {
  const requested = themeFromMapRequest(request)
  if (requested) return requested

  const kind = String(sceneKind).toLocaleLowerCase('en')
  const layout = String(request?.layout ?? '').toLocaleLowerCase('en')
  const pattern = String(request?.pattern ?? '').toLocaleLowerCase('en')
  const material = String(request?.material ?? '').toLocaleLowerCase('en')
  let id = ''
  if (kind === 'settlement') id = 'settlement'
  else if (kind === 'road') id = 'road'
  else if (kind === 'wilderness') id = layout === 'winding' || pattern === 'bridge' ? 'road' : 'forest'
  else if (kind === 'dungeon') id = layout === 'cavern' ? 'cave' : 'crypt'
  else if (layout === 'open' || pattern === 'natural') id = 'forest'
  else if (layout === 'rooms' || layout === 'ruins' || layout === 'radial'
    || ['small-room', 'great-hall', 'keep', 'courtyard'].includes(pattern)) {
    const masonry = ['stone', 'marble', 'earth'].includes(material)
      || ['keep', 'great-hall'].includes(pattern)
      || ['ruins', 'radial'].includes(layout)
    id = masonry ? 'crypt' : 'building'
  }
  else id = 'road'
  return SCENE_THEMES.find((candidate) => candidate.id === id) ?? FALLBACK_THEME
}

/**
 * Готова ли тема к живой игре. Отдельная функция, а не чтение поля на месте:
 * вызывающему не нужно знать, чем именно выражена готовность.
 *
 * @param {typeof SCENE_THEMES[number]|null} theme
 * @returns {boolean}
 */
export function isLiveTheme(theme) {
  return Boolean(theme?.live)
}

/** Темы, которые называют постройку или подземелье, а не открытую местность. */
const STRUCTURE_THEMES = new Set(['building', 'temple', 'crypt', 'cave', 'dungeon'])

/** Виды точек карты мира, которые означают поселение. */
const SETTLEMENT_WORLD_KINDS = new Set(['capital', 'city', 'town', 'village', 'port'])

/**
 * Тема по виду точки карты мира, когда название сцены о местности молчит.
 * @type {Record<string, string>}
 */
const WORLD_KIND_THEMES = {
  wilds: 'forest',
  dungeon: 'cave',
  ruin: 'crypt',
  fortress: 'building',
}

/**
 * @param {string} id
 * @returns {Record<string, any>}
 */
function themeById(id) {
  const canonicalId = SCENE_THEME_ALIASES[id] ?? id
  return ALL_SCENE_THEMES.find((candidate) => candidate.id === canonicalId) ?? FALLBACK_THEME
}

/**
 * Выбор темы для живой сцены — по всем признакам, а не только по словам в
 * названии.
 *
 * Одного названия мало: деревня «Тихий Брод» опознавалась как дорога по слову
 * «брод», и поселение с колодцем, кузницей и архивом рисовалось полем с полосой
 * утоптанной земли — ровно таким же, как дорога, в которую отряд потом уходил.
 * Игрок нажимал «покинуть локацию» и видел ту же пустую карту, что и до того.
 *
 * Порядок признаков:
 *
 * 1. Название, в котором есть постройка или подземелье (таверна, храм, склеп,
 *    пещера), — самый точный признак: таверна в городе остаётся зданием.
 * 2. Признак поселения — вид сцены `settlement`, тип поселения, вид точки карты
 *    мира (столица, город, городок, деревня, порт), заявка картографа
 *    (`streets`/`village`). Он перекрывает «дорогу» и молчащее название, но не
 *    лес и не рощу: «Роща у Эствуда» — это роща, а не улица. Явный вид сцены
 *    «дикая местность», «дорога» или «подземелье» снимает признак поселения,
 *    взятый с карты мира: карта знает о месте, а сцена — о том, где отряд стоит.
 * 3. Название открытой местности (лес, дорога, поселение) — как и раньше.
 * 4. Вид точки карты мира: пустошь — лес, подземелье — пещера, руины и
 *    крепость — каменные палаты.
 * 5. Заявка картографа, затем безопасный fallback по топологии.
 *
 * @param {object} [input]
 * @param {string} [input.location]
 * @param {string} [input.theme]
 * @param {string} [input.sceneKind]
 * @param {string} [input.settlementType]
 * @param {string} [input.worldKind]
 * @param {{layout?: string, pattern?: string, material?: string, theme_id?: string, themeId?: string}} [input.request]
 * @returns {Record<string, any>}
 */
export function resolveSceneTheme({ location = '', theme = '', sceneKind = '', settlementType = '', worldKind = '', request = {} } = {}) {
  const kind = String(sceneKind ?? '').toLocaleLowerCase('en')
  const explicitThemeId = String(request?.theme_id ?? request?.themeId ?? '').trim()
  const explicitCanonicalId = SCENE_THEME_ALIASES[explicitThemeId] ?? explicitThemeId
  const explicitTheme = explicitThemeId
    ? ALL_SCENE_THEMES.find((candidate) => candidate.id === explicitCanonicalId) ?? null
    : null
  // Авторский шаблон может знать больше, чем эвристика по названию и виду
  // точки мира: «военная галерея» находится в столице, но это всё ещё зал,
  // а не улица. Явная тема сильнее worldKind и сохраняет тот же генератор,
  // который используется для обычных переходов.
  if (explicitTheme) return explicitTheme
  const byName = matchTheme({ location, theme, sceneKind: kind })
  if (byName && STRUCTURE_THEMES.has(byName.id)) return byName
  const explicitlyNotSettlement = kind === 'wilderness' || kind === 'road' || kind === 'dungeon'
  const requestedLayout = String(request?.layout ?? '').toLocaleLowerCase('en')
  const requestedPattern = String(request?.pattern ?? '').toLocaleLowerCase('en')
  const sceneText = `${location} ${theme}`.toLocaleLowerCase('ru')
  const outdoorStructure = /(?:^|[\s«])двор(?:\s|$|ом(?:\s|$)|е(?:\s|$)|у(?:\s|$)|а(?:\s|$))|площад|улиц|пристан|гаван|порт|набережн|рынок|сад|переул|внешн|за ворот|перед ворот/iu.test(sceneText)
  const interiorStructure = /галере|дворец|замок|крепост|цитадел|трон|кабинет|поко[ия]|военн(?:ая|ый).*(?:зал|галере)|архив|библиотек|зал/iu.test(sceneText)
  const interiorLayout = requestedLayout === 'rooms'
    || ['small-room', 'great-hall', 'keep', 'crypt', 'temple'].includes(requestedPattern)
  if (outdoorStructure && (worldKind === 'fortress' || /крепост|замок|цитадел/iu.test(sceneText))) return themeById('settlement')
  // Название внутренней части места сильнее вида узла карты мира. Слова
  // «двор», «пристань» и «улица» явно оставляют сцену снаружи: «двор замка»
  // не должен внезапно стать комнатой только из-за слова «замок».
  if (!explicitlyNotSettlement && kind !== 'settlement' && !outdoorStructure && (interiorStructure || interiorLayout)) {
    if (/крепост|замок|цитадел/iu.test(sceneText)) return themeById('building')
    if (/храм|святилищ|алтар|собор|монастыр/iu.test(sceneText) || requestedPattern === 'temple') return themeById('temple')
    return themeById('building')
  }
  const settlementSignal = kind === 'settlement'
    || Boolean(String(settlementType ?? '').trim())
    || requestedLayout === 'streets'
    || requestedPattern === 'village'
    || (!explicitlyNotSettlement && SETTLEMENT_WORLD_KINDS.has(String(worldKind ?? '').toLocaleLowerCase('en')))
  if (settlementSignal && (!byName || byName.id === 'road')) return themeById('settlement')
  if (byName) return byName
  const byWorld = WORLD_KIND_THEMES[String(worldKind ?? '').toLocaleLowerCase('en')] ?? ''
  // Вид сцены, объявленный явно, спорит с картой мира — и выигрывает: подземелье
  // посреди пустоши остаётся подземельем. Карта мира дорисовывает только то,
  // чему сцена не противоречит.
  const worldThemeFits = !kind || kind === 'other' || kind === 'settlement'
    || (kind === 'wilderness' && byWorld === 'forest')
    || (kind === 'dungeon' && (byWorld === 'cave' || byWorld === 'crypt'))
  if (byWorld && worldThemeFits) return themeById(byWorld)
  return themeFromMapRequest(request ?? {}) ?? fallbackThemeFor({ sceneKind: kind, request: request ?? {} })
}

/**
 * Граф зон под тему: цепочка помещений, последнее — цель. У склепа последняя
 * дверь заперта, а ключ лежит в предыдущей зоне — проверку порядка ключей
 * делает стадия 1.
 *
 * @param {Record<string, any>} theme
 * @param {string} seed
 * @returns {import('./scene-graph.mjs').SceneGraph}
 */
export function sceneGraphForTheme(theme, seed) {
  const random = randomFor(`${theme.id}:${seed}`)
  const labels = theme.zones ?? ['Вход', 'Зал', 'Дальняя']
  const count = Math.max(3, Math.min(labels.length, 3 + Math.floor(random() * (labels.length - 2))))
  const graph = createSceneGraph({ entranceZoneId: 'zone-0', goalZoneId: `zone-${count - 1}` })
  for (let index = 0; index < count; index += 1) {
    addSceneZone(graph, {
      id: `zone-${index}`,
      kind: 'interior',
      required: index < count - 1,
      label: labels[index] ?? `Помещение ${index + 1}`,
      keys: theme.locked && index === count - 2 ? ['goal-key'] : [],
    })
  }
  for (let index = 1; index < count; index += 1) {
    const lockLast = theme.locked && index === count - 1
    addSceneLink(graph, {
      id: `link-${index}`,
      from: `zone-${index - 1}`,
      to: `zone-${index}`,
      kind: lockLast ? 'locked' : (random() < 0.5 ? 'door' : 'open'),
      keyId: lockLast ? 'goal-key' : null,
    })
  }
  return graph
}

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/**
 * Заменяет часть глухих стен узкими проёмами — решёткой или бойницей.
 *
 * Меняется **только вид ребра**: `blocksMove` у стены, бойницы и решётки один
 * и тот же, поэтому проходимость сцены остаётся ровно прежней и связность,
 * проверенная сборкой, сломаться не может. Разница в другом — сквозь проём
 * видно (`blocksSight` снимается) и укрытие слабее сплошной кладки: три
 * четверти у бойницы, половина у решётки.
 *
 * Выбор идёт по отсортированному списку рёбер с постоянным шагом, поэтому тот
 * же seed даёт ту же карту — как и вся остальная сборка темы.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {{kind: 'loophole' | 'grate', stride: number, limit: number}} options
 * @returns {number} сколько стен заменено
 */
function pierceWalls(map, { kind, stride, limit }) {
  const walls = edgeList(map).filter((edge) => edge.kind === 'wall')
  let pierced = 0
  for (let index = Math.floor(stride / 2); index < walls.length && pierced < limit; index += stride) {
    const wall = walls[index]
    const neighbor = edgeNeighbor(wall)
    setEdge(map, wall.x, wall.y, neighbor.x, neighbor.y, { kind })
    pierced += 1
  }
  return pierced
}

/**
 * Ставит стены на границе пола и непроходимой породы. Клеточная форма нужна
 * старому представлению сцены, рёбра — структурированной карте; оба вида
 * описывают одну и ту же границу.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 */
function outlineImpassableCells(map) {
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const own = cellAt(map, x, y)
      if (!own || own.passable) continue
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (cellAt(map, x + dx, y + dy)?.passable) {
          setEdge(map, x, y, x + dx, y + dy, {
            kind: 'wall',
            blocksMove: true,
            blocksSight: true,
            cover: 'three_quarters',
          })
        }
      }
    }
  }
}

/**
 * Органическая геометрия пещеры. Граф зон остаётся стадией 1, но вместо
 * двоичного разбиения на прямоугольные комнаты его узлы становятся неровными
 * залами, соединёнными вырубленным извилистым ходом.
 *
 * Полость строится только добавлением пересекающихся дисков. Поэтому она
 * связна по построению, а не благодаря ремонту после случайной генерации.
 *
 * @param {Record<string, any>} theme
 * @param {{seed?: string, width?: number, height?: number, locationId?: string}} [options]
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function layoutOrganicCave(theme, {
  seed = 'cave', width = 26, height = 26, locationId = '',
} = {}) {
  const safeWidth = Math.max(16, Math.min(SIZE_CLASSES.area.maxWidth, Math.round(width)))
  const safeHeight = Math.max(16, Math.min(SIZE_CLASSES.area.maxHeight, Math.round(height)))
  const random = randomFor(`cave:${theme.id}:${seed}`)
  const graph = sceneGraphForTheme(theme, String(seed))
  const map = createTacticalMap({
    width: safeWidth,
    height: safeHeight,
    locationId,
    seed: String(seed),
    generator: { id: 'theme-cave-organic', version: '2' },
    theme: theme.id,
    sizeClass: safeWidth * safeHeight <= SIZE_CLASSES.arena.maxCells ? 'arena' : 'area',
  })

  for (let index = 0; index < graph.zones.length; index += 1) {
    const zone = graph.zones[index]
    addZone(map, {
      id: zone.id,
      kind: 'interior',
      material: theme.material,
      lightLevel: index === 0 ? 'dim' : index === graph.zones.length - 1 ? 'dark' : 'dim',
      // У породы нет настила, и разворачивать её фактуру нечему.
      floorDirection: 'horizontal',
      label: zone.label,
    })
  }

  // Порода существует на всей сетке; игровая форма задаётся вырубленным полом.
  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      setCell(map, x, y, {
        passable: false,
        material: theme.material,
        variant: floorVariantAt(seed, x, y),
        revealed: true,
      })
    }
  }

  /** @type {Set<string>} */
  const floor = new Set()
  /**
   * Неровность радиуса считается внутри фиксированного обхода, поэтому не
   * нарушает детерминизм. Ядро радиусом `radius - 0.45` остаётся сплошным.
   * @param {number} cx
   * @param {number} cy
   * @param {number} radius
   * @param {boolean} [toEdge] вырубать ли до самого края карты — только устье
   */
  const carveDisc = (cx, cy, radius, toEdge = false) => {
    const reach = Math.ceil(radius + 0.5)
    for (let dy = -reach; dy <= reach; dy += 1) {
      for (let dx = -reach; dx <= reach; dx += 1) {
        const x = Math.round(cx + dx)
        const y = Math.round(cy + dy)
        const raggedRadius = radius + random() * 0.9 - 0.45
        // Залы и ходы не доходят до края: ход, упёртый в край карты, обрывается
        // в никуда. Край открыт только у устья, откуда пришёл отряд.
        if (x < (toEdge ? 0 : 1) || y < 1 || x >= safeWidth - 1 || y >= safeHeight - 1) continue
        if (Math.hypot(dx, dy) <= raggedRadius) floor.add(`${x},${y}`)
      }
    }
  }

  const count = graph.zones.length
  // Залы гуляют по высоте шире, чтобы пещера занимала карту, а не узкую
  // полосу посередине сплошной скалы.
  const verticalRoom = Math.max(2, Math.min(7, Math.floor(safeHeight * 0.26)))
  /** @type {Array<{x: number, y: number}>} */
  const centers = []
  // Фаза волны — своя у каждой пещеры. Без неё при трёх залах синус брался в
  // точках 0, π и 2π, и все залы ложились на среднюю линию одной полосой.
  const phase = Math.PI * (0.35 + random() * 0.5) * (random() < 0.5 ? 1 : -1)
  for (let index = 0; index < count; index += 1) {
    const progress = count <= 1 ? 0 : index / (count - 1)
    const x = Math.round(3 + progress * (safeWidth - 7))
    const wave = Math.sin(progress * Math.PI * 2 + phase + random() * 0.8) * verticalRoom
    const y = clamp(Math.round(safeHeight / 2 + wave + (random() - 0.5) * 3), 3, safeHeight - 4)
    centers.push({ x, y })
    const chamberRadius = clamp(Math.min(safeWidth, safeHeight) * (0.115 + random() * 0.035), 2.5, 5)
    carveDisc(x, y, chamberRadius)
    // Боковая ниша ломает круглую симметрию зала, но пересекается с ним.
    const side = random() < 0.5 ? -1 : 1
    carveDisc(x + side * Math.max(1, Math.floor(chamberRadius * 0.65)), y + (random() < 0.5 ? -1 : 1), chamberRadius * 0.62)
  }

  // Последовательные узлы графа соединяются одной гарантированной полостью.
  for (let index = 1; index < centers.length; index += 1) {
    const target = centers[index]
    let x = centers[index - 1].x
    let y = centers[index - 1].y
    let guard = safeWidth * safeHeight
    while ((x !== target.x || y !== target.y) && guard > 0) {
      carveDisc(x, y, 1.45 + random() * 0.65)
      const dx = target.x - x
      const dy = target.y - y
      const horizontalChance = Math.abs(dx) / Math.max(1, Math.abs(dx) + Math.abs(dy))
      if (dx && (!dy || random() < horizontalChance)) x += Math.sign(dx)
      else if (dy) y += Math.sign(dy)
      guard -= 1
    }
    carveDisc(target.x, target.y, 1.8)
  }

  // Устье до края карты — настоящий вход, а не точка появления внутри скалы.
  const entranceY = centers[0]?.y ?? Math.floor(safeHeight / 2)
  for (let x = 0; x <= (centers[0]?.x ?? 2); x += 1) carveDisc(x, entranceY, 1.35, true)

  for (const key of floor) {
    const [x, y] = key.split(',').map(Number)
    let zoneIndex = 0
    let nearest = Number.POSITIVE_INFINITY
    for (let index = 0; index < centers.length; index += 1) {
      const distance = Math.abs(centers[index].x - x) + Math.abs(centers[index].y - y)
      if (distance < nearest) {
        nearest = distance
        zoneIndex = index
      }
    }
    setCell(map, x, y, {
      passable: true,
      material: theme.material,
      zone: graph.zones[zoneIndex]?.id ?? graph.zones[0].id,
      variant: floorVariantAt(seed, x, y),
      revealed: true,
    })
  }

  outlineImpassableCells(map)
  addSpawnPoint(map, { id: 'party-entrance', x: 1, y: entranceY, role: 'party' })
  map.overlays = {
    compass: true,
    scaleBar: true,
    roomLabels: graph.zones.map((zone) => ({ zoneId: zone.id, label: zone.label })),
  }
  return map
}

/** С какой площади зал подземной темы получает колоннаду ради укрытий. */
const SPACIOUS_HALL_CELLS = 100

/**
 * Петли по длине пути (приём генератора Brogue): стена между двумя
 * помещениями получает дверь, если обойти её сейчас можно только в
 * десять клеток и больше. Линейная цепочка комнат превращается в
 * кольцо — у отряда появляются отступление и обход с фланга, у врага —
 * засада с двух сторон (Jaquays, «несколько путей к цели»).
 *
 * Запертая комната в петлю входит только через такую же запертую дверь —
 * с тем же замком и тем же ключом (`locks`): у сокровищницы может быть два
 * входа, но оба под ключ, иначе ключ теряет смысл.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {{exclude?: string[], limit?: number, minDetour?: number, locks?: Record<string, {lockDc?: number, keyItemId?: string|null}>}} [options]
 * @returns {number} сколько проходов прорублено
 */
export function addShortcutLoops(map, { exclude = [], limit = 2, minDetour = 10, locks = {} } = {}) {
  const blocked = new Set(exclude)
  const zoneOf = (/** @type {number} */ x, /** @type {number} */ y) => cellAt(map, x, y)?.zone ?? ''
  /** @param {{x: number, y: number}} from @param {{x: number, y: number}} to */
  const distance = (from, to) => {
    const seen = new Set([`${from.x},${from.y}`])
    let frontier = [from]
    for (let steps = 0; steps <= minDetour && frontier.length; steps += 1) {
      /** @type {Array<{x: number, y: number}>} */
      const next = []
      for (const point of frontier) {
        if (point.x === to.x && point.y === to.y) return steps
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = point.x + dx
          const ny = point.y + dy
          const key = `${nx},${ny}`
          if (seen.has(key) || !cellAt(map, nx, ny)?.passable) continue
          const edge = edgeBetween(map, point.x, point.y, nx, ny)
          if (edge && edge.kind !== 'door' && edge.blocksMove) continue
          seen.add(key)
          next.push({ x: nx, y: ny })
        }
      }
      frontier = next
    }
    return Number.POSITIVE_INFINITY
  }
  /** @type {Array<{x: number, y: number, a: {x: number, y: number}, b: {x: number, y: number}, pair: string, wall: Array<{x: number, y: number}>}>} */
  const candidates = []
  // Стена между помещениями бывает толщиной в одну клетку и толще: раскладка
  // графа оставляет между комнатами по две-три клетки камня. Сквозь толстую
  // стену прорубается короткий лаз, а дверь встаёт на выходе из него. Более
  // тонкая стена предпочтительнее — она идёт первой.
  for (const thickness of [1, 2, 3]) {
    for (let y = 1; y < map.height - 1; y += 1) for (let x = 1; x < map.width - 1; x += 1) {
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const wall = Array.from({ length: thickness }, (_, step) => ({ x: x + dx * step, y: y + dy * step }))
        if (wall.some((cell) => !cellAt(map, cell.x, cell.y) || cellAt(map, cell.x, cell.y)?.passable)) continue
        // Лаз не идёт вдоль чужого помещения: по бокам у него только камень.
        if (thickness > 1 && wall.some((cell) => [[dy, dx], [-dy, -dx]].some(([sx, sy]) => cellAt(map, cell.x + sx, cell.y + sy)?.passable))) continue
        const a = { x: x - dx, y: y - dy }
        const b = { x: x + dx * thickness, y: y + dy * thickness }
        if (b.x >= map.width - 1 || b.y >= map.height - 1) continue
        const zoneA = zoneOf(a.x, a.y)
        const zoneB = zoneOf(b.x, b.y)
        if (!cellAt(map, a.x, a.y)?.passable || !cellAt(map, b.x, b.y)?.passable) continue
        if (!zoneA || !zoneB || zoneA === zoneB || blocked.has(zoneA) || blocked.has(zoneB)) continue
        candidates.push({ x, y, a, b, pair: `${[zoneA, zoneB].sort().join('|')}#${thickness}`, wall })
      }
    }
  }
  let opened = 0
  const usedPairs = new Set()
  // Середина общей стены лучше её края: порядок — по удалённости от углов.
  for (const candidate of candidates) {
    if (opened >= limit) break
    const rooms = candidate.pair.split('#')[0]
    if (usedPairs.has(rooms)) continue
    const detour = minDetour + candidate.wall.length - 1
    if (distance(candidate.a, candidate.b) <= detour) continue
    const sameWall = candidates.filter((other) => other.pair === candidate.pair)
    const middle = sameWall[Math.floor(sameWall.length / 2)]
    if (distance(middle.a, middle.b) <= detour) continue
    for (const cell of middle.wall) setCell(map, cell.x, cell.y, { passable: true, zone: '' })
    const path = [middle.a, ...middle.wall, middle.b]
    for (let step = 1; step < path.length; step += 1) setEdge(map, path[step - 1].x, path[step - 1].y, path[step].x, path[step].y, { kind: 'none' })
    // Дверь — на выходе из лаза в дальнее помещение.
    const last = middle.wall[middle.wall.length - 1]
    const edge = middle.b.x !== last.x ? { x: last.x, y: last.y, dir: /** @type {'e'} */ ('e') } : { x: last.x, y: last.y, dir: /** @type {'s'} */ ('s') }
    const lock = rooms.split('|').map((zoneId) => locks[zoneId]).find(Boolean)
    setDoor(map, lock
      ? { id: `loop-door-${opened + 1}`, ...edge, state: 'locked', ...(lock.lockDc ? { lockDc: lock.lockDc } : {}), ...(lock.keyItemId ? { keyItemId: lock.keyItemId } : {}) }
      : { id: `loop-door-${opened + 1}`, ...edge, state: 'closed', blocksMove: false, blocksSight: false })
    usedPairs.add(rooms)
    opened += 1
  }
  return opened
}

/**
 * Тюремные камеры: вдоль длинной оси зала идёт коридор в клетку, по обе
 * стороны (в узком зале — по одну) — камеры шириной в три клетки,
 * разделённые стенами; у каждой камеры дверь в коридор. Зал уже пяти
 * клеток или короче восьми не делится.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {string} zoneId
 */
function partitionPrisonCells(map, zoneId) {
  /** @type {Array<{x: number, y: number}>} */
  const cells = []
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if (cellAt(map, x, y)?.zone === zoneId && cellAt(map, x, y)?.passable) cells.push({ x, y })
  if (!cells.length) return
  const minX = Math.min(...cells.map((cell) => cell.x))
  const maxX = Math.max(...cells.map((cell) => cell.x))
  const minY = Math.min(...cells.map((cell) => cell.y))
  const maxY = Math.max(...cells.map((cell) => cell.y))
  const horizontal = maxX - minX >= maxY - minY
  const length = (horizontal ? maxX - minX : maxY - minY) + 1
  const breadth = (horizontal ? maxY - minY : maxX - minX) + 1
  if (breadth < 5 || length < 8) return
  // Широкий зал — коридор посередине и камеры с двух сторон; узкий (5–6) —
  // коридор вдоль одной стены и камеры вдоль другой.
  const twoSided = breadth >= 7
  // Оси: along — вдоль коридора, across — поперёк.
  const at = (/** @type {number} */ along, /** @type {number} */ across) => horizontal ? { x: along, y: across } : { x: across, y: along }
  const alongMin = horizontal ? minX : minY
  const alongMax = horizontal ? maxX : maxY
  const acrossMin = horizontal ? minY : minX
  const acrossMax = horizontal ? maxY : maxX
  const corridor = twoSided ? Math.floor((acrossMin + acrossMax) / 2) : acrossMin
  const sides = twoSided ? [-1, 1] : [1]
  // Клетки дверных проёмов в другие зоны не застраиваются: вход в зал
  // остаётся входом, даже если он не на коридоре.
  const doorway = (/** @type {{x: number, y: number}} */ point) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
    const near = cellAt(map, point.x + dx, point.y + dy)
    return near?.passable && near.zone !== zoneId
  })
  const wall = (/** @type {{x: number, y: number}} */ point) => {
    if (cellAt(map, point.x, point.y)?.zone !== zoneId || doorway(point)) return false
    setCell(map, point.x, point.y, { passable: false, zone: '' })
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (cellAt(map, point.x + dx, point.y + dy)?.passable) setEdge(map, point.x, point.y, point.x + dx, point.y + dy, { kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' })
    }
    return true
  }
  // Стены вдоль коридора по обе стороны.
  for (let along = alongMin; along <= alongMax; along += 1) for (const side of sides) wall(at(along, corridor + side))
  // Перегородки между камерами через три клетки.
  for (let along = alongMin + 3; along < alongMax - 1; along += 4) {
    for (let across = acrossMin; across <= acrossMax; across += 1) {
      const cellSide = across < corridor - 1 ? -1 : across > corridor + 1 ? 1 : 0
      if (cellSide && sides.includes(cellSide)) wall(at(along, across))
    }
  }
  // Дверь каждой камеры — в середине её отрезка, на ребре к коридору.
  let index = 0
  for (let start = alongMin; start <= alongMax; start += 4) {
    const middle = Math.min(alongMax, start + 1)
    for (const side of sides) {
      const opening = at(middle, corridor + side)
      const inside = at(middle, corridor + side * 2)
      const hall = at(middle, corridor)
      if (!cellAt(map, inside.x, inside.y)?.passable || !cellAt(map, hall.x, hall.y)?.passable) continue
      setCell(map, opening.x, opening.y, { passable: true, zone: zoneId })
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const near = cellAt(map, opening.x + dx, opening.y + dy)
        if (near?.passable) setEdge(map, opening.x, opening.y, opening.x + dx, opening.y + dy, { kind: 'none' })
      }
      const edge = horizontal
        ? { x: opening.x, y: Math.min(opening.y, hall.y), dir: /** @type {'s'} */ ('s') }
        : { x: Math.min(opening.x, hall.x), y: opening.y, dir: /** @type {'e'} */ ('e') }
      index += 1
      setDoor(map, { id: `cell-door-${index}`, ...edge, state: 'closed', blocksMove: false, blocksSight: false })
    }
  }
}

/**
 * Ряды могил кладбища: надгробие 2×1, ряд через клетку, между надгробиями
 * — проход. Ряды стоят посреди участка, не у входа и не на тропе.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {string} seed
 */
function placeGraveRows(map, seed) {
  const asset = assetById('grave')
  if (!asset) return
  const random = randomFor(`graves:${seed}`)
  const entrance = map.spawnPoints.find((point) => point.role === 'party')
  const free = (/** @type {number} */ x, /** @type {number} */ y) => {
    const cell = cellAt(map, x, y)
    if (!cell?.passable || cell.surface === 'water' || cell.material === 'earth' || cell.zone !== 'field') return false
    if (entrance && Math.abs(x - entrance.x) <= 6 && Math.abs(y - entrance.y) <= 3) return false
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => cellAt(map, x + dx, y + dy)?.passable)
  }
  let placed = 0
  const offsetX = Math.floor(random() * 2)
  for (let y = 4; y < map.height - 4; y += 3) {
    for (let x = 6 + offsetX; x < map.width - 5; x += 3) {
      if (!free(x, y) || !free(x + 1, y) || random() < 0.18) continue
      placed += 1
      addProp(map, {
        id: `grave-row-${placed}`, assetId: asset.id, x: x + 1, y: y + 0.5, rotation: 0, scale: 1,
        footprint: [{ x, y }, { x: x + 1, y }], zOrder: 0, blocksMove: asset.blocksMove, blocksSight: asset.blocksSight,
        cover: asset.cover, destructible: asset.destructible, hp: asset.hp, interactive: asset.interactive,
      })
    }
  }
}

/** Наибольший перепад между проходимыми соседями, в футах: шаг без лазания. */
export const OPEN_TERRAIN_MAX_STEP_FEET = 3

/**
 * Рельеф открытой местности: два-три холма с пологими склонами. Высоты — в
 * футах, как у правил: вершина 10–15 футов даёт возвышенность (от 5 футов),
 * а соседние проходимые клетки различаются не больше чем на
 * `OPEN_TERRAIN_MAX_STEP_FEET`, поэтому ни один шаг не требует лазания —
 * механики лазания и падения в правилах нет. Вход ровный, дорога сглажена,
 * вода лежит ниже берегов. Скалы кромки поднимаются над соседями: это только
 * вид, клетки непроходимы.
 *
 * @param {Record<string, any>} theme
 * @param {string|number} seed
 * @param {Map<string, {x: number, y: number, patch: Record<string, any>}>} terrainCells
 * @param {{width: number, height: number, entranceY: number, onRoadAt: (x: number, y: number) => boolean}} layout
 */
export function applyOpenTerrainRelief(theme, seed, terrainCells, { width, height, entranceY, onRoadAt }) {
  const random = randomFor(`open-relief:${theme.id}:${seed}`)
  const hills = []
  const count = 2 + Math.floor(random() * 2)
  for (let index = 0; index < count; index += 1) {
    hills.push({
      x: Math.floor(width * (0.25 + random() * 0.6)),
      y: Math.floor(height * (0.15 + random() * 0.7)),
      radius: 3.5 + random() * 3.5,
      peak: 10 + Math.floor(random() * 6),
    })
  }
  /** @type {Map<string, number>} */
  const level = new Map()
  for (const cell of terrainCells.values()) {
    let feet = 0
    for (const hill of hills) {
      const distance = Math.hypot(cell.x - hill.x, cell.y - hill.y) / hill.radius
      // Плато с округлым краем: вершина ровная, склон — косинус.
      if (distance < 1.6) feet = Math.max(feet, hill.peak * (distance < 0.55 ? 1 : 0.5 + 0.5 * Math.cos((distance - 0.55) / 1.05 * Math.PI)))
    }
    if (cell.patch.surface === 'water') feet = -2
    if (onRoadAt(cell.x, cell.y)) feet *= 0.45
    if (cell.x <= 5 && Math.abs(cell.y - entranceY) <= 2) feet = 0
    level.set(`${cell.x},${cell.y}`, Math.round(feet))
  }
  // Склоны без уступов: проходимые соседи сводятся к перепаду не больше шага.
  // Понижаются только высокие клетки, поэтому вход и вода остаются на месте.
  /** @param {{patch: Record<string, any>}} cell */
  const passable = (cell) => cell.patch.passable !== false && cell.patch.surface !== 'water'
  for (let pass = 0; pass < 40; pass += 1) {
    let changed = false
    for (const cell of terrainCells.values()) {
      if (!passable(cell) && cell.patch.surface !== 'water') continue
      const own = level.get(`${cell.x},${cell.y}`) ?? 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const neighbor = terrainCells.get(`${cell.x + dx},${cell.y + dy}`)
        if (!neighbor || !passable(neighbor) && neighbor.patch.surface !== 'water') continue
        const other = level.get(`${neighbor.x},${neighbor.y}`) ?? 0
        if (own - other > OPEN_TERRAIN_MAX_STEP_FEET) {
          level.set(`${cell.x},${cell.y}`, other + OPEN_TERRAIN_MAX_STEP_FEET)
          changed = true
          break
        }
      }
    }
    if (!changed) break
  }
  // Скала кромки — выше самого высокого проходимого соседа: край читается
  // утёсом, а не бордюром.
  for (const cell of terrainCells.values()) {
    if (passable(cell) || cell.patch.surface === 'water') continue
    let top = level.get(`${cell.x},${cell.y}`) ?? 0
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) top = Math.max(top, level.get(`${cell.x + dx},${cell.y + dy}`) ?? 0)
    level.set(`${cell.x},${cell.y}`, top + 1 + Math.floor(random() * 2))
  }
  for (const cell of terrainCells.values()) {
    const feet = level.get(`${cell.x},${cell.y}`) ?? 0
    if (feet) cell.patch = { ...cell.patch, elevation: feet }
  }
}

/**
 * Версия генератора открытой местности. 3 — петляющая река с каменистыми
 * берегами, скалистая кромка участка, пруд в лесу и холмы (высоты в футах). Сохранённые карты не
 * перегенерируются: их версия остаётся прежней.
 */
export const OPEN_TERRAIN_GENERATOR_VERSION = '3'

/**
 * Открытая местность: помещений нет, есть проходимая площадка с опушкой по
 * краю. У дороги и поселения через карту идёт полоса утоптанной земли.
 *
 * @param {Record<string, any>} theme
 * @param {{seed?: string, width?: number, height?: number, locationId?: string}} [options]
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function layoutOpenTerrain(theme, { seed = 'open', width = 26, height = 26, locationId = '' } = {}) {
  const safeWidth = Math.max(12, Math.min(SIZE_CLASSES.area.maxWidth, Math.round(width)))
  const safeHeight = Math.max(12, Math.min(SIZE_CLASSES.area.maxHeight, Math.round(height)))
  const random = randomFor(`open:${theme.id}:${seed}`)
  const map = createTacticalMap({
    width: safeWidth,
    height: safeHeight,
    locationId,
    seed: String(seed),
    generator: { id: `theme-${theme.id}`, version: OPEN_TERRAIN_GENERATOR_VERSION },
    theme: theme.id,
    sizeClass: safeWidth * safeHeight <= SIZE_CLASSES.arena.maxCells ? 'arena' : 'area',
  })
  addZone(map, {
    id: 'field',
    kind: 'exterior',
    material: theme.material,
    lightLevel: 'bright',
    floorDirection: 'horizontal',
    label: theme.label,
  })

  const roadY = Math.floor(safeHeight / 2)
  const phase = random() * Math.PI * 2
  const bend = 1 + Math.floor(random() * Math.max(1, safeHeight * 0.09))
  const shift = Math.round((random() - 0.5) * safeHeight * 0.14)
  const forkX = Math.floor(safeWidth * (0.3 + random() * 0.4))
  const fork = theme.road && random() < 0.45
  /** @param {number} x */
  const trailY = (x) => clamp(roadY + shift + Math.round(Math.sin(x / Math.max(1, safeWidth - 1) * Math.PI * 2 + phase) * bend), 3, safeHeight - 4)
  /** @type {Map<string, {x: number, y: number, patch: Partial<import('./tactical-map.mjs').TacticalCell>}>} */
  const terrainCells = new Map()
  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      // Дорога вьётся, а не идёт по линейке: прямая полоса читается как шов.
      const onRoad = theme.road && (Math.abs(y - trailY(x)) <= 1 || fork && Math.abs(x - forkX) <= 1 && y <= trailY(x))
      const left = 1 + Math.floor((1 + Math.sin(y * 0.29 + phase)) * 1.2)
      const right = safeWidth - 2 - Math.floor((1 + Math.cos(y * 0.23 + phase)) * 1.2)
      const top = 1 + Math.floor((1 + Math.cos(x * 0.25 + phase)) * 1.2)
      const bottom = safeHeight - 2 - Math.floor((1 + Math.sin(x * 0.31 + phase)) * 1.2)
      const present = onRoad || x >= left && x <= right && y >= top && y <= bottom
      if (!present) continue
      terrainCells.set(`${x},${y}`, { x, y, patch: {
        passable: true,
        material: onRoad ? 'earth' : theme.material,
        surface: onRoad ? 'none' : theme.surface ?? 'none',
        moveCost: !onRoad && theme.surface === 'mud' ? 2 : 1,
        zone: 'field',
        variant: floorVariantAt(seed, x, y),
        revealed: true,
      } })
    }
  }
  // У опушки неровный силуэт, но вход всегда связан с широкой центральной
  // областью. Это граница участка, а не каменная стена посреди леса.
  const entranceY = trailY(0)
  for (let x = theme.road ? 0 : 1; x <= Math.min(5, safeWidth - 2); x += 1) {
    for (let y = entranceY - 1; y <= entranceY + 1; y += 1) {
      terrainCells.set(`${x},${y}`, { x, y, patch: { passable: true, material: theme.road ? 'earth' : theme.material,
        surface: 'none', moveCost: 1, zone: 'field', revealed: true } })
    }
  }
  // Скалистая кромка по контуру участка: край карты читается грядой камня, а
  // не обрывом плиток в пустоту. Дорогу и вход кромка не перекрывает.
  /** @param {number} x @param {number} y */
  const onRoadAt = (x, y) => theme.road && (Math.abs(y - trailY(x)) <= 1 || fork && Math.abs(x - forkX) <= 1 && y <= trailY(x))
  /** @param {number} x @param {number} y */
  const nearEntrance = (x, y) => x <= 5 && Math.abs(y - entranceY) <= 2
  const rimNoise = randomFor(`open-rim:${theme.id}:${seed}`)
  /** @param {number} x @param {number} y */
  const isEdge = (x, y) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !terrainCells.has(`${x + dx},${y + dy}`))
  const edgeCells = [...terrainCells.values()].filter((cell) => isEdge(cell.x, cell.y))
  /** @param {{x: number, y: number, patch: Record<string, any>}} cell */
  const toRock = (cell) => { cell.patch = { ...cell.patch, passable: false, surface: 'none', moveCost: 1 } }
  for (const cell of edgeCells) {
    if (onRoadAt(cell.x, cell.y) || nearEntrance(cell.x, cell.y)) continue
    toRock(cell)
  }
  // Второй, неровный слой кромки — гряда, а не ровный бордюр. В лесу он
  // редкий: опушку держат деревья, и чаща не должна редеть.
  for (const cell of terrainCells.values()) {
    if (!cell.patch.passable || onRoadAt(cell.x, cell.y) || nearEntrance(cell.x, cell.y)) continue
    const besideRim = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => edgeCells.some((edge) => edge.x === cell.x + dx && edge.y === cell.y + dy && !edge.patch.passable))
    if (besideRim && rimNoise() < (theme.id === 'forest' ? 0.08 : 0.32)) toRock(cell)
  }
  if (theme.chasm) {
    // Пропасть — разрыв в земле: клеток там нет вовсе, и доска рисует
    // темноту. Через неё по дороге перекинут мост.
    addZone(map, { id: 'crossing', kind: 'exterior', material: theme.bridgeMaterial, lightLevel: 'bright', label: 'Мост' })
    const chasmX = Math.floor(safeWidth * (0.45 + random() * 0.15))
    const chasmPhase = random() * Math.PI * 2
    /** @param {number} y */
    const chasmCenter = (y) => chasmX + Math.round(Math.sin(y * 0.29 + chasmPhase) * 1.4)
    for (const cell of [...terrainCells.values()]) {
      if (Math.abs(cell.x - chasmCenter(cell.y)) > 1) continue
      if (onRoadAt(cell.x, cell.y)) {
        cell.patch = { ...cell.patch, passable: true, surface: 'none', material: theme.bridgeMaterial, zone: 'crossing', moveCost: 1 }
        continue
      }
      terrainCells.delete(`${cell.x},${cell.y}`)
    }
  } else if (theme.river) {
    addZone(map, { id: 'water', kind: 'exterior', material: theme.material, lightLevel: 'bright', label: 'Река' })
    addZone(map, { id: 'crossing', kind: 'exterior', material: theme.bridgeMaterial, lightLevel: 'bright', label: 'Мост' })
    // Река петляет: русло смещается по синусоиде и местами разливается шире.
    const riverX = Math.floor(safeWidth * (0.45 + random() * 0.15))
    const meander = 1 + Math.floor(random() * 2)
    const riverPhase = random() * Math.PI * 2
    /** @param {number} y */
    const riverCenter = (y) => riverX + Math.round(Math.sin(y * 0.33 + riverPhase) * meander)
    /** @param {number} y */
    const riverHalf = (y) => Math.sin(y * 0.71 + riverPhase * 2) > 0.72 ? 2 : 1
    for (const cell of terrainCells.values()) {
      if (Math.abs(cell.x - riverCenter(cell.y)) > riverHalf(cell.y)) continue
      const bridge = Math.abs(cell.y - trailY(cell.x)) <= 1
      cell.patch = { ...cell.patch, passable: bridge, surface: bridge ? 'none' : 'water',
        material: bridge ? theme.bridgeMaterial : theme.material, zone: bridge ? 'crossing' : 'water', moveCost: 1 }
    }
    // Каменистые берега: часть клеток у воды — валуны, но не у моста.
    const bankNoise = randomFor(`open-bank:${theme.id}:${seed}`)
    for (const cell of terrainCells.values()) {
      if (!cell.patch.passable || cell.patch.zone === 'crossing' || onRoadAt(cell.x, cell.y) || nearEntrance(cell.x, cell.y)) continue
      const nearWater = [[1, 0], [-1, 0]].some(([dx]) => terrainCells.get(`${cell.x + dx},${cell.y}`)?.patch.surface === 'water')
      const nearBridge = [[0, 1], [0, -1], [0, 2], [0, -2]].some(([, dy]) => terrainCells.get(`${cell.x},${cell.y + dy}`)?.patch.zone === 'crossing')
      if (nearWater && !nearBridge && bankNoise() < 0.38) toRock(cell)
    }
  } else if (theme.pond || (theme.id === 'forest' && random() < 0.55)) {
    // Пруд на поляне в стороне от тропы и входа: неровное пятно воды.
    addZone(map, { id: 'water', kind: 'exterior', material: theme.material, lightLevel: 'bright', label: 'Пруд' })
    const pondX = Math.floor(safeWidth * (0.55 + random() * 0.25))
    const pondY = trailY(pondX) + (random() < 0.5 ? -1 : 1) * Math.floor(safeHeight * 0.25)
    const radius = 2 + random() * 1.4
    for (const cell of terrainCells.values()) {
      if (!cell.patch.passable || onRoadAt(cell.x, cell.y) || nearEntrance(cell.x, cell.y)) continue
      const angle = Math.atan2(cell.y - pondY, cell.x - pondX)
      const reach = radius * (1 + Math.sin(angle * 3 + pondX) * 0.22)
      if (Math.hypot(cell.x - pondX, cell.y - pondY) <= reach) {
        cell.patch = { ...cell.patch, passable: false, surface: 'water', zone: 'water', moveCost: 1 }
      }
    }
  }
  // Пересечение двух неровных контуров иногда оставляет отдельную угловую
  // клетку. В карту попадает только связный участок с входом, включая воду.
  const queue = [{ x: 1, y: entranceY }]
  const connected = new Set([`1,${entranceY}`])
  for (let index = 0; index < queue.length; index += 1) {
    const point = queue[index]
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: point.x + dx, y: point.y + dy }
      const key = `${next.x},${next.y}`
      if (!terrainCells.has(key) || connected.has(key)) continue
      connected.add(key)
      queue.push(next)
    }
  }
  // Кладбище — ровный погост: надгробия на ступенях холма выглядят съехавшими.
  if (!theme.flat) applyOpenTerrainRelief(theme, seed, terrainCells, { width: safeWidth, height: safeHeight, entranceY, onRoadAt })
  // Скалы и вода не должны отрезать часть поляны от входа: недостижимые
  // проходимые клетки становятся камнем, а не ловушкой для отряда.
  const walkable = new Set([`1,${entranceY}`])
  const walkQueue = [{ x: 1, y: entranceY }]
  for (let index = 0; index < walkQueue.length; index += 1) {
    const point = walkQueue[index]
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const key = `${point.x + dx},${point.y + dy}`
      if (walkable.has(key) || !connected.has(key) || !terrainCells.get(key)?.patch.passable) continue
      walkable.add(key)
      walkQueue.push({ x: point.x + dx, y: point.y + dy })
    }
  }
  for (const point of queue) {
    const cell = terrainCells.get(`${point.x},${point.y}`)
    if (!cell) continue
    if (cell.patch.passable && !walkable.has(`${point.x},${point.y}`)) toRock(cell)
    setCell(map, cell.x, cell.y, cell.patch)
  }
  map.spawnPoints.push({ id: 'party-entrance', x: 1, y: entranceY, role: 'party' })
  map.overlays = { compass: true, scaleBar: true, roomLabels: [{ zoneId: 'field', label: theme.label }] }
  return map
}

/**
 * Узкий фасад для старых вызывающих мест. Формат карты остаётся единым, а
 * геометрия и идентификаторы принадлежат новому генератору поселений.
 *
 * @param {Record<string, any>} theme
 * @param {{seed?: string, width?: number, height?: number, locationId?: string, design?: Record<string, any>}} [options]
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function layoutSettlement(theme, { seed = 'settlement', width = 26, height = 26, locationId = '', design = {} } = {}) {
  return buildSettlementScene({ seed, width, height, locationId, theme, design }).map
}

/**
 * Собирает сцену по теме. Единая точка входа: вызывающему не нужно знать, каким
 * способом строится геометрия.
 *
 * @param {object} options
 * @param {string} [options.location]
 * @param {string} [options.theme]
 * @param {string} [options.sceneKind]
 * @param {string} [options.seed]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {string} [options.locationId]
 * @param {string} [options.themeId] уже опознанная тема; сильнее названия
 * @param {Record<string, any>} [options.design] пространственный замысел выбранного места
 * @param {'interior'|'exterior'} [options.entry] сторона входа в сцену здания
 * @param {Array<{offset?: number, label?: string}>} [options.levels] объявленные этажи локации
 * @returns {{map: import('./tactical-map.mjs').TacticalMap, theme: string, warnings: string[]}}
 */
export function buildThemedScene({
  location = '', theme = '', sceneKind = '', seed = 'scene', width = 26, height = 26, locationId = '', themeId = '', design = {},
  levels = [], entry = 'exterior',
} = {}) {
  // Тему могли опознать не по названию, а по узору из заявки картографа. Тогда
  // повторное опознание здесь её потеряет: `themeFor` читает только слова.
  const chosen = themeId ? themeById(themeId) : null
  const definition = /** @type {any} */ (chosen ?? themeFor({ location, theme, sceneKind }))

  // Известное authored-место сильнее эвристики темы и слов Архитектора. Карта
  // уже собрана офлайн и приходит новой копией на каждый стол, поэтому
  // повторный вход не меняет ни контур, ни двери, ни реквизит.
  const authored = authoredLocationMapFor(locationId)
  if (authored) return { map: authored, theme: authored.theme || definition.id, warnings: [] }

  if (definition.kind === 'fortress') {
    const built = buildAresFortressScene({ seed, width, height, locationId, theme: definition.id })
    return { map: built.map, theme: definition.id, warnings: built.warnings }
  }

  if (definition.kind === 'building') {
    // Объявленные этажи нужны только теме здания: лестницу на этаже входа
    // ставит один `building-generator`, остальные темы крючков не расставляют
    // вовсе, и привязывать им нечего.
    const built = buildBuildingScene({ seed, width, height, locationId, theme: definition.id, levels, design, entry })
    return { map: built.map, theme: definition.id, warnings: built.warnings }
  }

  if (definition.kind === 'graph') {
    if (definition.id === 'cave') {
      const map = layoutOrganicCave(definition, { seed, width, height, locationId })
      placeProps(map, {
        seed: `${seed}:props`,
        maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (map.sizeClass)].maxProps,
        zones: map.zones.map((zone, index) => {
          const plans = Array.isArray(definition.propPlans) ? definition.propPlans : []
          const base = plans.length ? plans[Math.min(index, plans.length - 1)] : {}
          // Логово с сокровищами получает в дальнем зале золото, шахта — руду
          // и вагонетку в штреке: слова места меняют обстановку, не форму.
          const text = `${location} ${theme}`.toLocaleLowerCase('ru')
          const last = index >= Math.min(map.zones.length, plans.length) - 1
          const hoard = /золот|сокровищ|(?<![а-яё])клад(?![а-яё])|дракон/u.test(text) && last
          const mine = /шахт|рудник|штольн|забой/u.test(text) && index === 1
          const plan = hoard ? { ...base, require: [...(base.require ?? []), 'coin_pile', 'coin_pile', 'chest'], caps: { ...(base.caps ?? {}), coin_pile: 4, chest: 2 } }
            : mine ? { ...base, require: [...(base.require ?? []), 'ore_vein', 'cart'], caps: { ...(base.caps ?? {}), cart: 1, ore_vein: 4 } }
              : base
          return {
            ...plan,
            zoneId: zone.id,
            theme: definition.id,
            density: plan.density ?? definition.density ?? 12,
            require: plan.require ?? definition.require,
            prefer: plan.prefer ?? definition.prefer,
          }
        }),
      })
      ensurePropAccess(map)
      return { map, theme: definition.id, warnings: [] }
    }
    const graph = sceneGraphForTheme(definition, seed)
    const built = buildSceneFromGraph(graph, {
      seed, width, height, locationId, theme: definition.id, material: definition.material,
    })
    // Каменная тема получает узкие проёмы в кладке: склеп перегорожен
    // решётками, храм смотрит наружу щелями под сводом. Это те же стены —
    // пройти сквозь них нельзя, но видно и укрытие слабее.
    // Петли по образцу Brogue: цепочка помещений получает обходной путь.
    // Запертая цель входит в петлю только второй запертой дверью на тот же
    // ключ — иначе ключ теряет смысл.
    const goalDoor = definition.locked
      // Проём двери — клетка стены без зоны, поэтому дверь цели узнаётся по
      // замку, а не по зоне своих клеток.
      ? built.map.doors.find((door) => door.state === 'locked' && door.keyItemId)
      : null
    addShortcutLoops(built.map, {
      exclude: definition.locked && !goalDoor ? [graph.goalZoneId] : [],
      locks: goalDoor ? { [graph.goalZoneId]: { lockDc: goalDoor.lockDc, keyItemId: goalDoor.keyItemId } } : {},
      limit: 2,
    })
    if (definition.id === 'crypt') pierceWalls(built.map, { kind: 'grate', stride: 13, limit: 3 })
    if (definition.id === 'temple') pierceWalls(built.map, { kind: 'loophole', stride: 11, limit: 4 })
    // Камеры тюрьмы — ряд клеток вдоль коридора, а не пустой зал.
    if (definition.id === 'dungeon') {
      const cellsZone = built.map.zones.find((zone) => zone.label === 'Камеры')
      if (cellsZone) partitionPrisonCells(built.map, cellsZone.id)
    }
    const labelled = built.map.zones.filter((zone) => zone.label)
    const plans = Array.isArray(definition.propPlans) ? definition.propPlans : []
    // Колоннада ставится до общей расстановки: она задаёт структуру зала, а
    // скамьи и жаровни потом встают между колонн, а не наоборот.
    // Просторный зал без опор — голое поле боя: от лучника негде укрыться.
    // Зал от сотни клеток получает колоннаду, даже если план её не просил;
    // камеры — нет, у них своя структура. Коридор подземелья шириной в зал
    // получает опоры, как зал.
    const zoneSize = (/** @type {string} */ zoneId) => {
      let cells = 0
      for (let y = 0; y < built.map.height; y += 1) for (let x = 0; x < built.map.width; x += 1) {
        const cell = cellAt(built.map, x, y)
        if (cell?.passable && cell.zone === zoneId) cells += 1
      }
      return cells
    }
    labelled.forEach((zone, index) => {
      const asked = plans.length && plans[index % plans.length]?.colonnade
      const spacious = zone.label !== 'Камеры' && zoneSize(zone.id) >= SPACIOUS_HALL_CELLS
      if (asked || spacious) placeColonnade(built.map, { zoneId: zone.id, assetId: 'pillar' })
    })
    const map = placeProps(built.map, {
      seed: `${seed}:props`,
      maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (built.map.sizeClass)].maxProps,
      zones: built.map.zones
        .filter((zone) => zone.label)
        .map((zone, index) => {
          const plan = Array.isArray(definition.propPlans) && definition.propPlans.length
            ? (definition.propPlans[index % definition.propPlans.length] ?? {})
            : {}
          return {
            ...plan,
            zoneId: zone.id,
            theme: plan.theme ?? definition.assetTheme ?? definition.id,
            density: plan.density ?? definition.density ?? 12,
            require: plan.require ?? definition.require,
            prefer: plan.prefer ?? definition.prefer,
          }
        }),
    })
    ensurePropAccess(map)
    return {
      map,
      theme: definition.id,
      warnings: [...built.warnings, ...built.errors.map((issue) => issue.code)],
    }
  }

  if (definition.kind === 'settlement') {
    const built = buildSettlementScene({ seed, width, height, locationId, theme: definition, design })
    const map = built.map
    // Улица деревни — не склад реквизита: прежде на четыре дома приходилось
    // по восемь телег с колёсами, пять прилавков и три костра. Прилавки —
    // у рыночной площади, у остальных поселений один-два; телег и колёс — по
    // паре, колодец и костёр — по одному.
    const market = design.topology === 'market'
    const urban = design.scale === 'town' || design.scale === 'city'
    const streetCaps = {
      market_stall: market ? 6 : 1, cart: 2, wagon_wheel: 2, campfire: 1, well: 1, haystack: 2,
      woodpile: 3, village_fence: 6, water_trough: 1, hitching_post: 2, signpost: 1, roadside_shrine: 1,
      // Зелень разная: кустов, цветов и камней — не больше дюжины каждого.
      bush: 12, shrub: 8, flowers: 10, rock_small: 8, grass_tuft: 6,
    }
    // В городе колодец и прилавки стоят на площади, а дворы за домами —
    // сады и огороды: деревья, кусты, поленницы, без сена и прилавков.
    // Колодец один: если есть площадь, он стоит на ней, а не на улице.
    const hasSquare = map.zones.some((zone) => zone.id === 'square')
    const streetRequire = urban ? ['tree_oak', 'woodpile'] : market ? ['market_stall', 'market_stall'] : hasSquare ? ['cart', 'village_fence'] : ['well', 'cart', 'village_fence']
    const squarePlan = hasSquare ? [{
      zoneId: 'square',
      theme: definition.assetTheme ?? definition.id,
      density: urban ? 9 : 7,
      require: urban || market ? ['well', 'market_stall', 'market_stall', 'market_stall', 'lamp_post'] : ['well', 'lamp_post'],
      prefer: ['market_stall', 'lamp_post', 'cart', 'water_trough', 'signpost', 'hitching_post'],
      caps: { well: 1, market_stall: urban ? 6 : 3, lamp_post: 4, cart: 1, water_trough: 1, signpost: 1, hitching_post: 2, tree_oak: 0, tree_pine: 0, tree_birch: 0, tree_dead: 0, tree_spruce: 0, tree_stump: 0, bush: 0, shrub: 0, haystack: 0, woodpile: 0, campfire: 0, village_fence: 0, fallen_log: 0, fern: 0, rock_small: 0, boulder: 0, milestone: 0, roadside_shrine: 0, path_stone: 0, grass_tuft: 0, flowers: 0, wagon_wheel: 0 },
    }] : []
    // Фонари вдоль городских улиц — редко, по краю, чтобы не мешать проходу.
    const streetPlan = urban ? [{
      zoneId: 'street',
      theme: definition.assetTheme ?? definition.id,
      density: 1.2,
      require: ['lamp_post', 'signpost'],
      prefer: ['lamp_post', 'hitching_post', 'water_trough'],
      caps: { lamp_post: 8, signpost: 2, hitching_post: 2, water_trough: 2, cart: 0, well: 0, market_stall: 0, haystack: 0, woodpile: 0, campfire: 0, village_fence: 0, tree_oak: 0, tree_pine: 0, tree_birch: 0, tree_dead: 0, tree_spruce: 0, tree_stump: 0, bush: 0, shrub: 0, fallen_log: 0, fern: 0, rock_small: 0, boulder: 0, milestone: 0, roadside_shrine: 0, path_stone: 0, grass_tuft: 0, flowers: 0, wagon_wheel: 0 },
    }] : []
    /**
     * Обстановка дома по комнате: передняя — жилая (очаг, стол, стулья) или
     * торговая (прилавок-стол, полки), задняя — спальня, кладовая или кухня.
     * @param {{id: string}} zone
     */
    const housePlan = (zone) => {
      const back = zone.id.endsWith('-back')
      const use = built.uses?.[zone.id.replace(/-back$/u, '')] ?? design.building_use
      // Амбар: сено, поилка, мешки и бочки, телега под крышей.
      if (use === 'barn') return { purpose: 'stable', extraThemes: ['yard'], require: ['haystack', 'water_trough', 'sack'], prefer: ['haystack', 'sack', 'barrel', 'hitching_post', 'crate', 'woodpile'], caps: { haystack: 2, water_trough: 1, cart: 1, tree_oak: 0, tree_pine: 0, tree_birch: 0, tree_dead: 0, tree_stump: 0, bush: 0, shrub: 0, grass_tuft: 0, flowers: 0, rock_small: 0, boulder: 0, well: 0, lamp_post: 0, signpost: 0, path_stone: 0, campfire: 0 } }
      if (use === 'workshop') return back
        ? { purpose: 'store', require: ['crate_stack', 'barrel'], prefer: ['crate', 'barrel', 'sack', 'chest'] }
        : { purpose: 'workshop', require: ['table_long', 'shelf_wall', 'firewood_stack'], prefer: ['shelf_wall', 'crate', 'barrel', 'chest', 'bucket', 'broom'] }
      if (use === 'shop') return back
        ? { purpose: 'store', require: ['crate_stack', 'barrel'], prefer: ['crate', 'barrel', 'sack', 'chest'] }
        : { purpose: 'workshop', require: ['table_small', 'shelf_wall'], prefer: ['shelf_wall', 'crate', 'barrel', 'chest', 'chair'] }
      if (use === 'tavern') return back
        ? { purpose: 'kitchen', require: ['fireplace', 'cupboard'], prefer: ['barrel', 'crate', 'cupboard'] }
        : { purpose: 'gallery', require: ['table_small', 'table_small', 'barrel'], prefer: ['table_small', 'chair', 'stool', 'barrel'] }
      if (back) return { purpose: 'bedroom', require: ['bed', 'chest'], prefer: ['bed', 'chest', 'night_table', 'wardrobe'] }
      // Однокомнатный дом держит всё в одной комнате: и очаг, и кровать.
      const single = !map.zones.some((other) => other.id === `${zone.id}-back`)
      return { purpose: 'living', require: single ? ['fireplace', 'table_small', 'bed'] : ['fireplace', 'table_small'], prefer: ['chair', 'cupboard', 'barrel', 'basket'] }
    }
    placeProps(map, {
      seed: `${seed}:props`,
      maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (map.sizeClass)].maxProps,
      zones: [{
        zoneId: 'common',
        theme: definition.assetTheme ?? definition.id,
        density: definition.density ?? 10,
        require: streetRequire,
        prefer: urban ? ['tree_oak', 'tree_birch', 'bush', 'woodpile', 'flowers', 'village_fence', 'rock_small', 'shrub']
          : market ? definition.prefer : ['tree_birch', 'tree_oak', 'bush', 'woodpile', 'haystack', 'water_trough', 'village_fence', 'cart', 'flowers'],
        caps: hasSquare && !urban ? { ...streetCaps, well: 0 } : urban ? { ...streetCaps, well: 0, market_stall: 0, haystack: 0, cart: 1, wagon_wheel: 1, campfire: 0, village_fence: 8, woodpile: 6 } : streetCaps,
      }, ...squarePlan, ...streetPlan, ...map.zones.filter((zone) => zone.kind === 'interior').map((zone) => ({
        zoneId: zone.id,
        theme: 'interior',
        density: 30,
        ...housePlan(zone),
      }))],
    })
    ensurePropAccess(map)
    return { map, theme: definition.id, warnings: built.warnings }
  }

  const arid = design.climate === 'arid'
  const cold = design.climate === 'cold'
  const wetland = design.climate === 'wetland'
  const placeText = `${location} ${theme}`.toLocaleLowerCase('ru')
  const chasmScene = /ущель|пропаст|обрыв|расщелин|разлом|бездн/u.test(placeText)
  const bridgeScene = /(?<![а-яё])мост|переправ|(?<![а-яё])брод/u.test(placeText)
  const pondScene = /оазис|пруд|озер|озёр|родник|источник/u.test(placeText)
  const campScene = /лагер|стоянк|бивак|привал|разбойн|бандит/u.test(placeText)
  const terrain = {
    ...definition,
    // Мост, брод и переправа — через реку; ущелье и пропасть — через провал.
    // Прежде «мост через ущелье» был обычной дорогой без моста и обрыва.
    chasm: chasmScene,
    river: !chasmScene && (design.topology === 'river' || bridgeScene),
    pond: pondScene,
    road: definition.road || design.topology === 'river' || bridgeScene || chasmScene,
    bridgeMaterial: ['stone', 'marble', 'metal'].includes(design.architecture) ? design.architecture : 'wood',
    material: arid ? 'sand' : cold ? 'ice' : wetland ? 'earth' : definition.material,
    surface: cold ? 'ice' : wetland ? 'mud' : 'none',
    label: definition.id === 'forest'
      ? arid && pondScene ? 'Оазис' : arid ? 'Сухое редколесье' : cold ? 'Заснеженный лес' : wetland ? 'Заболоченная чаща' : definition.label
      : definition.label,
    // Оазис в пустыне — зелень вокруг воды; без воды — сухостой и валуны.
    ...(arid && pondScene ? { require: ['bush', 'shrub', 'tree_dead'], prefer: ['bush', 'shrub', 'grass_tuft', 'flowers', 'fern', 'boulder', 'tree_dead'] }
      : arid ? { require: ['tree_dead', 'boulder'], prefer: ['tree_dead', 'tree_stump', 'boulder', 'bush', 'woodpile'] }
      : cold ? { require: ['tree_pine', 'tree_spruce', 'fallen_log'], prefer: ['tree_pine', 'tree_spruce', 'tree_dead', 'boulder'] }
        : wetland ? { require: ['tree_dead', 'fallen_log', 'bush'], prefer: ['tree_dead', 'bush', 'fern', 'fallen_log'] } : {}),
  }
  const map = layoutOpenTerrain(terrain, { seed, width, height, locationId })
  if (definition.graves) placeGraveRows(map, seed)
  // Дикая местность — не склад реквизита: костёр один (в лагере — два),
  // телега и колесо — от силы по одному, колодца и прилавков в лесу нет.
  const wildCaps = { campfire: campScene ? 2 : 1, cart: 1, wagon_wheel: 1, well: 0, haystack: 0, hitching_post: 0, water_trough: 0, lamp_post: 0, market_stall: 0, village_fence: 0, signpost: 1, roadside_shrine: definition.graves ? 2 : 1, milestone: 2, woodpile: 2 }
  const camp = campScene
    ? { extraThemes: ['interior'], require: [...(terrain.require ?? []), 'campfire', 'crate', 'sack', 'chest', 'woodpile'], prefer: [...(terrain.prefer ?? []), 'crate', 'sack', 'barrel'], caps: { ...wildCaps, ...CAMP_INTERIOR_OFF } }
    : {}
  placeProps(map, {
    seed: `${seed}:props`,
    maxProps: SIZE_CLASSES[/** @type {keyof typeof SIZE_CLASSES} */ (map.sizeClass)].maxProps,
    zones: [{
      zoneId: 'field',
      theme: definition.id,
      density: design.density === 'sparse' ? 9 : design.density === 'dense' ? 20 : definition.density ?? 14,
      require: terrain.require,
      prefer: terrain.prefer,
      caps: arid && pondScene ? { ...wildCaps, boulder: 5, tree_dead: 4, tree_stump: 2 } : definition.graves ? { ...wildCaps, grave: 4, sarcophagus: 0, crypt_niche: 0, urn: 2, altar: 0, brazier: 0, cobweb: 0, bone_pile: 1 } : wildCaps,
      ...camp,
    }],
  })
  ensurePropAccess(map)
  return { map, theme: definition.id, warnings: [] }
}

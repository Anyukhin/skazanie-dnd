// @ts-check
import { createHash } from 'node:crypto'

import { assetById, assetsForTheme } from './asset-registry.mjs'
import { addProp, cellAt, edgeBetween, edgeNeighbor, reachableCells } from './tactical-map.mjs'

/**
 * Расстановка предметов по правилам (`docs/tactical-map-plan.md`, стадия 3).
 *
 * Развитие `featureCellScore` из `server/dynamic-map.mjs`: там тоже считается
 * оценка клетки под предмет, притяжение к стене и к столу. Здесь та же идея
 * доведена до якорей, поворота, масштаба и плотности на зону.
 *
 * Всё детерминировано от `seed`: тот же seed даёт ту же расстановку, включая
 * повороты и масштабы.
 */

export const PROP_PLACEMENT_VERSION = 'skazanie:prop-placement-v4'

/**
 * Ограниченный словарь назначений комнаты. Это намеренно не новый формат карты:
 * `purpose` живёт только в заявке на расстановку, а на карту попадают обычные
 * props. Если назначение неизвестно, сохраняется прежняя расстановка по теме.
 *
 * `themes` — назначения из набора детализации (`server/detail-props.mjs`),
 * которые профиль открывает зоне: кузня видит горн и наковальню, а трактир их
 * не видит. Это и есть шаблоны помещений: набор предметов с центром
 * (`SET_ANCHORS`), вокруг которого остальное собирается.
 *
 * @type {Record<string, {require: string[], prefer: string[], themes?: string[], caps?: Record<string, number>, arrangement?: 'rows'|'gathered'|'stalls'}>}
 */
const SEMANTIC_PROFILES = Object.freeze({
  // «Галерея» — общий/военный зал: поверхности для карт, места вокруг них и
  // подвешенный свет из уже зарегистрированных предметов.
  gallery: {
    require: ['table_long'],
    prefer: ['table_long', 'table_small', 'chair', 'bench', 'chandelier', 'banner', 'candelabra', 'rug'],
    caps: { table_long: 2, table_small: 2, chandelier: 1 },
    arrangement: 'gathered',
  },
  barracks: {
    require: ['bunk_bed', 'bunk_bed', 'bunk_bed', 'bunk_bed'],
    prefer: ['bunk_bed', 'bed', 'night_table', 'chest', 'wardrobe', 'washbasin', 'footlocker', 'armor_stand', 'weapon_rack_wall', 'weapon_rack', 'shield_display', 'ballista', 'wolf_pelt', 'straw_mat'],
    themes: ['barracks'],
    caps: { bunk_bed: 8, bed: 8, table_long: 0, bench: 0, chair: 0, armor_stand: 2, weapon_rack_wall: 2 },
    arrangement: 'rows',
  },
  mill: {
    require: ['millstone', 'flour_bin', 'grain_sacks'],
    prefer: ['grain_sacks', 'flour_bin', 'flour_spill', 'sack', 'crate_stack', 'barrel', 'basket'],
    themes: ['farm', 'shop'],
    caps: { millstone: 1, flour_bin: 2, shop_counter: 0, display_shelf: 0, scales_table: 0 },
    arrangement: 'stalls',
  },
  // Кузня: горн у стены, рядом наковальня, бочка для закалки и уголь;
  // верстак и стойка инструмента — по стенам.
  forge: {
    require: ['forge', 'anvil', 'quench_tub', 'coal_pile'],
    prefer: ['tool_rack', 'workbench', 'grindstone', 'tool_peg_rack', 'chain_coil', 'arcane_coil', 'firewood_stack', 'barrel', 'crate', 'scorch_mark'],
    themes: ['forge', 'workshop'],
    caps: { forge: 1, anvil: 1, quench_tub: 1, coal_pile: 2, workbench: 1, grindstone: 1, fireplace: 0, bed: 0 },
    arrangement: 'gathered',
  },
  // Камеры темницы: соломенный тюфяк, ведро в углу, цепи на стене.
  cells: {
    require: ['straw_bed', 'cell_bucket'],
    prefer: ['straw_bed', 'cell_bucket', 'wall_chains', 'prison_cage', 'manacle_post', 'straw_mat', 'straw_scatter', 'bone_heap', 'floor_crack', 'drain_grate'],
    themes: ['prison'],
    caps: { straw_bed: 8, iron_cage: 1, torture_rack: 0, jailer_desk: 0, bed: 0, bunk_bed: 0 },
    arrangement: 'stalls',
  },
  // Караульная: стол тюремщика, оружие на стене, жаровня и сундучки.
  guardroom: {
    require: ['jailer_desk', 'weapon_rack_wall', 'guard_brazier'],
    prefer: ['footlocker', 'strongbox', 'chair', 'stool', 'table_small', 'barrel', 'water_barrel', 'map_table', 'war_table', 'ammo_crates', 'training_dummy', 'archery_target', 'armor_stand'],
    themes: ['prison', 'barracks'],
    caps: { jailer_desk: 1, guard_brazier: 2, map_table: 1, war_table: 1, weapon_rack_wall: 2, training_dummy: 1, archery_target: 1, armor_stand: 2 },
    arrangement: 'gathered',
  },
  // Пыточная: дыба посредине, клетка в углу, цепи и жаровня.
  torture: {
    require: ['torture_rack', 'iron_cage', 'wall_chains'],
    prefer: ['guard_brazier', 'dungeon_rack', 'iron_maiden', 'manacle_post', 'weapon_rack', 'shield_display', 'key_bundle', 'wall_chains', 'scorch_mark', 'bone_heap', 'stocks', 'bucket'],
    themes: ['prison'],
    caps: { torture_rack: 1, iron_cage: 2, stocks: 1, dungeon_rack: 1, iron_maiden: 1 },
    arrangement: 'gathered',
  },
  // Алтарная: алтарь у стены, курильница и подушки для коленопреклонения
  // перед ним, стойка свечей и стол приношений рядом.
  altar: {
    require: ['altar', 'incense_burner', 'kneeling_cushions', 'candle_rack'],
    prefer: ['offering_table', 'font_basin', 'holy_pool', 'idol', 'crystal_orb', 'ceremonial_chalice', 'scroll_pile', 'book_row', 'single_book', 'statue', 'prayer_rug', 'temple_banner', 'brazier'],
    themes: ['temple'],
    caps: { altar: 1, idol: 1, holy_pool: 1, kneeling_cushions: 3, candle_rack: 2, offering_table: 1, font_basin: 1 },
    arrangement: 'gathered',
  },
  // Неф: скамьи рядами, дорожка-ковёр, кафедра и чаша у входа.
  nave: {
    require: ['prayer_bench', 'prayer_bench', 'temple_lectern'],
    prefer: ['prayer_bench', 'kneeling_cushions', 'candle_rack', 'ceremonial_chalice', 'scroll_pile', 'book_row', 'rug_runner', 'font_basin', 'temple_banner', 'brazier'],
    themes: ['temple'],
    caps: { temple_lectern: 1, font_basin: 1, rug_runner: 1, altar: 0 },
    arrangement: 'rows',
  },
  // Обеденный зал усадьбы: длинный стол посредине, стулья вдоль, люстра
  // над ним, ковёр под ним, горка с посудой у стены.
  dining: {
    require: ['table_long', 'chair', 'chair', 'chandelier'],
    prefer: ['chair', 'candelabra', 'rug_red_large', 'cupboard', 'fireplace', 'bear_pelt', 'wine_stain', 'banner'],
    themes: ['hall'],
    caps: { table_long: 2, chandelier: 2, fireplace: 1, rug_red_large: 1, bench: 0 },
    arrangement: 'gathered',
  },
  // Кабинет: письменный стол, высокие шкафы, глобус и кресло для чтения.
  study: {
    require: ['writing_desk', 'bookcase_tall', 'armchair'],
    prefer: ['globe', 'alchemy_bottles', 'crystal_orb', 'arcane_coil', 'book_piles', 'book_row', 'scroll_pile', 'single_book', 'desk_candlestick', 'key_bundle', 'coin_pouch', 'arch_shelf', 'vial_display_shelf', 'scroll_rack', 'candle_desk', 'reading_nook', 'map_table', 'telescope', 'rug_round', 'paper_scatter', 'strongbox', 'book_lectern'],
    themes: ['study', 'bedroom'],
    caps: { writing_desk: 1, globe: 1, telescope: 1, map_table: 1, bed: 0, bunk_bed: 0 },
    arrangement: 'gathered',
  },
  // Торговый зал лавки: прилавок, витрины по стенам, весы и товар.
  shop: {
    require: ['shop_counter', 'display_shelf'],
    prefer: ['display_shelf', 'vial_display_shelf', 'arch_shelf', 'alchemy_bottles', 'key_bundle', 'coin_pouch', 'scales_table', 'cloth_bolts', 'goods_baskets', 'pottery_stand', 'spice_crates', 'grain_sacks', 'crate', 'barrel'],
    themes: ['shop'],
    caps: { shop_counter: 1, scales_table: 1, display_shelf: 3, bar_counter: 0 },
    arrangement: 'gathered',
  },
  // Спальня дома — не казарма: одна-две кровати у стены, сундук, шкаф и
  // тумбочка. Прежде спальня шла профилем казармы и получала по три
  // двухъярусные койки.
  bedroom: {
    require: ['bed', 'chest'],
    prefer: ['bed', 'wardrobe', 'night_table', 'chest', 'rug', 'washbasin', 'candle', 'dresser', 'coat_rack', 'standing_mirror', 'rug_blue', 'bear_pelt', 'armchair', 'hide_rug', 'folding_screen', 'cradle'],
    themes: ['bedroom'],
    caps: { bed: 2, bunk_bed: 0, wardrobe: 1, chest: 1, washbasin: 1, rug: 1, table_long: 0, bench: 0, dresser: 1, standing_mirror: 1, coat_rack: 1, double_bed: 1, bathtub: 1, cradle: 1 },
    arrangement: 'gathered',
  },
  // Горница жилого дома: очаг, один стол со стульями, посудный шкаф. Не
  // трактирный зал с рядами длинных столов и скамей.
  living: {
    require: ['fireplace', 'table_small'],
    prefer: ['table_small', 'chair', 'cupboard', 'rug', 'shelf_wall', 'barrel', 'basket', 'bench', 'firewood_stack'],
    caps: { table_long: 0, table_round: 1, table_small: 1, bench: 1, fireplace: 1, cupboard: 1, rug: 1, bar_counter: 0, bar_shelf: 0 },
    arrangement: 'gathered',
  },
  // Кухня: плита и хлебная печь у стены, разделочный стол посредине,
  // кастрюли на стене, полки с припасами.
  kitchen: {
    require: ['kitchen_stove', 'prep_table', 'pantry_shelf'],
    prefer: ['cupboard', 'alchemy_table', 'alchemy_bottles', 'cutlery_set', 'butcher_block', 'hanging_pots', 'bread_oven', 'spice_crates', 'washtub', 'water_barrel', 'cauldron', 'barrel', 'cutting_board', 'pot', 'flour_spill'],
    themes: ['kitchen'],
    caps: { kitchen_stove: 1, bread_oven: 1, prep_table: 1, butcher_block: 1, hanging_pots: 2 },
    arrangement: 'gathered',
  },
  store: {
    require: ['crate_stack', 'barrel_stack'],
    prefer: ['crate_stack', 'barrel_stack', 'crate', 'barrel', 'sack', 'chain_coil', 'rope_coils', 'key_bundle', 'coin_pouch', 'chest', 'shelf_wall', 'grain_sacks', 'spice_crates', 'goods_baskets', 'crate_stack_goods'],
    themes: ['shop'],
    caps: { shop_counter: 0, display_shelf: 0, scales_table: 0, cloth_bolts: 0, pottery_stand: 0 },
    arrangement: 'stalls',
  },
  stable: {
    require: ['haystack', 'water_trough', 'hitching_post'],
    prefer: ['haystack', 'water_trough', 'hitching_post', 'cart', 'sack'],
    caps: { haystack: 1, water_trough: 1, cart: 2, hitching_post: 4, woodpile: 0 },
    arrangement: 'stalls',
  },
  workshop: {
    require: ['workbench', 'tool_rack'],
    prefer: ['table_long', 'alchemy_table', 'tool_peg_rack', 'chain_coil', 'arcane_coil', 'shelf_wall', 'crate', 'barrel', 'chest', 'firewood_stack', 'candle', 'sawhorse', 'lumber_pile', 'grindstone', 'sawdust'],
    themes: ['workshop'],
    caps: { workbench: 2, sawhorse: 1, grindstone: 1, table_long: 1 },
    arrangement: 'gathered',
  },
  courtyard: {
    require: ['well', 'cart'],
    prefer: ['well', 'cart', 'hitching_post', 'water_trough', 'woodpile', 'haystack', 'tree_oak', 'tree_birch', 'bush', 'rain_barrel', 'hay_bales', 'flower_bed'],
    themes: ['farm'],
    caps: { well: 1, cart: 2, water_trough: 1, haystack: 1, hitching_post: 4, woodpile: 1, campfire: 1 },
    arrangement: 'gathered',
  },
  // Обычная улица: только природа и плющ. Палатки, краны, баллисты и сани
  // приходят назначениями ниже, а не случайным добором во дворе.
  exterior: {
    require: [],
    prefer: ['giant_fungus', 'mangrove_roots', 'clover_patch', 'forest_plant', 'wall_ivy', 'wall_ivy_corner', 'wall_ivy_wide', 'tree_oak', 'tree_birch', 'tree_pine', 'bush', 'shrub', 'rock_small', 'boulder', 'mossy_rock', 'dead_bramble', 'root_tangle', 'leaf_litter', 'rock_cluster', 'pebbles'],
    caps: { mangrove_roots: 2, giant_fungus: 2 },
    arrangement: 'gathered',
  },
  // Эти назначения не появляются случайно: Архитектор/сцена должны назвать
  // их явно, иначе крупные лагерные и портовые силуэты не засоряют двор.
  camp: {
    require: [],
    prefer: ['command_tent', 'scout_tent', 'nomad_tent', 'bedroll_cluster', 'shield_rack', 'camp_dummy', 'spiked_beam_barrier', 'rope_coils', 'weapon_rack', 'shield_display'],
    themes: ['camp', 'barracks'],
    caps: { command_tent: 1, nomad_tent: 1, spiked_beam_barrier: 3 },
    arrangement: 'gathered',
  },
  winter: {
    require: [],
    prefer: ['snowdrift', 'snowy_boulder', 'ice_pillars', 'snow_cairn', 'frozen_pool', 'winter_cache', 'cargo_sled', 'snowshoe_pair'],
    themes: ['winter'],
    caps: { cargo_sled: 1, winter_cache: 2, frozen_pool: 1 },
    arrangement: 'gathered',
  },
  siege: {
    require: [],
    prefer: ['ballista', 'mantlet', 'spiked_beam_barrier', 'command_tent'],
    themes: ['siege', 'barracks', 'camp'],
    caps: { command_tent: 1 },
    arrangement: 'gathered',
  },
  harbor: {
    require: [],
    prefer: ['dock_crane', 'capstan', 'anchor', 'mooring_bollard', 'cargo_net', 'fishing_crates', 'lobster_cage', 'sail_bundle', 'rope_coils'],
    themes: ['harbor'],
    caps: { dock_crane: 1, capstan: 1, anchor: 1 },
    arrangement: 'gathered',
  },
  desert: {
    require: [],
    prefer: ['sand_dune', 'desert_boulders', 'cactus_cluster', 'dead_scrub', 'broken_obelisk', 'oasis_pool', 'nomad_tent'],
    themes: ['desert'],
    caps: { nomad_tent: 1, oasis_pool: 1, broken_obelisk: 1 },
    arrangement: 'gathered',
  },
  swamp: {
    require: [],
    prefer: ['bog_pool', 'lily_pad_cluster', 'reed_cluster', 'rotten_log', 'mud_patch', 'peat_mound', 'swamp_totem', 'mangrove_roots', 'giant_fungus'],
    themes: ['swamp'],
    caps: { swamp_totem: 1 },
    arrangement: 'gathered',
  },
  // Лаборатория мага: котёл и кафедра посредине, шкаф с зельями и зеркало у
  // стены, круг призыва на полу; мелочь — на письменном столе.
  laboratory: {
    require: ['alchemy_cauldron', 'writing_desk', 'potion_cabinet'],
    prefer: ['arcane_lectern', 'ritual_circle', 'arcane_stone', 'magic_mirror', 'crystal_orb', 'alchemy_table', 'alchemy_bottles', 'arcane_coil', 'book_piles', 'scroll_pile', 'desk_candlestick', 'bookcase_tall', 'vial_display_shelf', 'candle'],
    themes: ['arcane', 'study'],
    caps: { alchemy_cauldron: 1, arcane_lectern: 1, ritual_circle: 1, arcane_stone: 1, magic_mirror: 1, potion_cabinet: 2, alchemy_table: 1, bed: 0, bunk_bed: 0 },
    arrangement: 'gathered',
  },
})

/** Псевдонимы назначения сохраняют короткий и понятный словарь генератора. */
const PURPOSE_ALIASES = Object.freeze({
  hall: 'gallery',
  main_hall: 'gallery',
  great_hall: 'gallery',
  war_room: 'gallery',
  gallery: 'gallery',
  barracks: 'barracks',
  sleeping: 'barracks',
  bedroom: 'bedroom',
  living: 'living',
  kitchen: 'kitchen',
  store: 'store',
  storage: 'store',
  warehouse: 'store',
  storehouse: 'store',
  stable: 'stable',
  stables: 'stable',
  workshop: 'workshop',
  forge: 'forge',
  smithy: 'forge',
  cells: 'cells',
  prison: 'cells',
  guardroom: 'guardroom',
  torture: 'torture',
  altar: 'altar',
  sanctum: 'altar',
  nave: 'nave',
  dining: 'dining',
  study: 'study',
  library: 'study',
  shop: 'shop',
  mill: 'mill',
  courtyard: 'courtyard',
  yard: 'courtyard',
  exterior: 'exterior',
  laboratory: 'laboratory',
  lab: 'laboratory',
  alchemy: 'laboratory',
  encampment: 'camp',
  docks: 'harbor',
  pier: 'harbor',
  marsh: 'swamp',
  bog: 'swamp',
  dunes: 'desert',
})

/**
 * Теги — необязательное сокращение для вызывающих модулей, у которых уже есть
 * метки комнаты. План расстановки остаётся публичным стыком: теги в карту не
 * записываются.
 *
 * @type {Record<string, string>}
 */
const TAG_PURPOSES = Object.freeze({
  hall: 'gallery', throne: 'gallery', maps: 'gallery', military: 'gallery',
  sleeping: 'barracks', soldiers: 'barracks', beds: 'barracks',
  cooking: 'kitchen', hearth: 'kitchen', food: 'kitchen',
  storage: 'store', supplies: 'store', crates: 'store', barrels: 'store',
  horses: 'stable', animals: 'stable', fodder: 'stable',
  forge: 'forge', tools: 'workshop', craft: 'workshop',
  courtyard: 'courtyard', yard: 'courtyard', outside: 'exterior',
  camp: 'camp', winter: 'winter', snow: 'winter', siege: 'siege', harbor: 'harbor', port: 'harbor', docks: 'harbor',
  desert: 'desert', sand: 'desert', dunes: 'desert', swamp: 'swamp', marsh: 'swamp', bog: 'swamp',
  laboratory: 'laboratory', lab: 'laboratory', alchemy: 'laboratory', arcane: 'laboratory', wizard: 'laboratory',
})

/**
 * Что тянется за предметом. Это связи, а не украшение: без них у стола не будет
 * стульев, а на столе — посуды, и расстановка выглядит случайной
 * (`docs/tactical-map-plan.md`, раздел 14, соответствующий риск).
 *
 * @type {Record<string, Array<[string, number]>>}
 */
const COMPANIONS = Object.freeze({
  table_round: [['chair', 4], ['mug', 2], ['plate', 1]],
  table_long: [['bench', 2], ['chair', 2], ['jug', 1], ['bread_loaf', 1]],
  table_small: [['chair', 2], ['candle', 1]],
  bar_counter: [['stool', 3], ['mug', 2], ['bottle', 1]],
  fireplace: [['cauldron', 1], ['firewood_stack', 1]],
  bed: [['night_table', 1]],
  bunk_bed: [['night_table', 1], ['chest', 1]],
  cart: [['wagon_wheel', 1]],
  // Стог тянет мешок и ставится в первой, крупной очереди: иначе мелочь
  // занимала амбар раньше, и стогу 2×2 не оставалось места.
  haystack: [['sack', 1]],
  tree_oak: [['bush', 1]],
})

/**
 * Центры шаблонов помещений: к чему тянется предмет набора. Центр ставится
 * первым (он крупнее и обязателен), остальное собирается вокруг.
 *
 * @type {Readonly<Record<string, string[]>>}
 */
const SET_ANCHORS = Object.freeze({
  anvil: ['forge'], quench_tub: ['forge', 'anvil'], coal_pile: ['forge'], grindstone: ['anvil', 'workbench'],
  butcher_block: ['kitchen_stove', 'prep_table'], hanging_pots: ['kitchen_stove'], washtub: ['prep_table'],
  incense_burner: ['altar', 'idol'], kneeling_cushions: ['altar', 'idol', 'temple_lectern'], candle_rack: ['altar', 'idol'],
  offering_table: ['altar', 'idol'], font_basin: ['prayer_bench', 'temple_lectern'],
  iron_cage: ['torture_rack'], guard_brazier: ['jailer_desk', 'torture_rack'], strongbox: ['jailer_desk', 'writing_desk'],
  scales_table: ['shop_counter'], armchair: ['writing_desk', 'reading_nook', 'fireplace'], globe: ['writing_desk'],
  chandelier: ['table_long'], candelabra: ['table_long', 'altar'],
  // Утварь тянется только к тем столам, которые служат опорой (`SURFACES`):
  // иначе она встаёт рядом с опорой, которой нет, и снимается в attachPropSupports.
  alchemy_bottles: ['writing_desk', 'shop_counter', 'table_small'], crystal_orb: ['alchemy_table', 'writing_desk'],
  arcane_coil: ['writing_desk', 'table_long', 'map_table'], book_piles: ['writing_desk', 'map_table'],
  cutlery_set: ['table_long', 'table_small'], desk_candlestick: ['writing_desk', 'table_small'],
  ceremonial_chalice: ['altar', 'offering_table'], scroll_pile: ['writing_desk', 'map_table'],
  single_book: ['writing_desk', 'map_table', 'table_small'], book_row: ['writing_desk', 'map_table', 'table_small'],
  key_bundle: ['jailer_desk', 'writing_desk', 'shop_counter'], coin_pouch: ['shop_counter', 'writing_desk', 'table_small'],
  alchemy_cauldron: ['alchemy_table', 'potion_cabinet'], arcane_lectern: ['ritual_circle', 'alchemy_cauldron'],
  magic_mirror: ['arcane_lectern', 'writing_desk'], arcane_stone: ['ritual_circle'],
  iron_maiden: ['torture_rack', 'dungeon_rack'], manacle_post: ['torture_rack', 'straw_bed'],
  camp_dummy: ['shield_rack', 'weapon_rack'], bedroll_cluster: ['scout_tent', 'command_tent', 'campfire'],
  mooring_bollard: ['capstan', 'dock_crane'], lobster_cage: ['fishing_crates', 'cargo_net'], sail_bundle: ['cargo_net', 'rope_coils'],
})

/** Четыре стороны в порядке n, e, s, w. Поворот 0° смотрит на север. */
const SIDES = Object.freeze([
  { dx: 0, dy: -1, facing: 180 },
  { dx: 1, dy: 0, facing: 270 },
  { dx: 0, dy: 1, facing: 0 },
  { dx: -1, dy: 0, facing: 90 },
])

/**
 * @param {string} seed
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
 * Стены вокруг клетки. Стена — это ребро, а не соседняя клетка: низкая ограда
 * между двумя проходимыми клетками тоже держит якорь `wall`.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {number} x
 * @param {number} y
 * @returns {Array<{dx: number, dy: number, facing: number}>}
 */
function wallSidesAt(map, x, y) {
  return SIDES.filter((side) => {
    const edge = edgeBetween(map, x, y, x + side.dx, y + side.dy)
    if (edge && (edge.kind === 'wall' || edge.kind === 'rail')) return true
    const neighbor = cellAt(map, x + side.dx, y + side.dy)
    return !neighbor || !neighbor.passable
  })
}

/**
 * Есть ли у клетки окно на одном из четырёх рёбер.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {number} x
 * @param {number} y
 */
function windowBeside(map, x, y) {
  return SIDES.some((side) => edgeBetween(map, x, y, x + side.dx, y + side.dy)?.kind === 'window')
}

/**
 * Предметы, которые по смыслу ставятся рядами и группами одного вида: им
 * соседство с таким же не штрафуется.
 */
const CLUSTER_FRIENDLY = new Set(['village_fence', 'rail_fence', 'prayer_bench', 'crypt_niche', 'crate_stack', 'barrel_stack', 'crate', 'barrel', 'bunk_bed', 'bed', 'grave', 'chair', 'stool', 'bench', 'hitching_post', 'sack', 'shelf_wall', 'bookshelf', 'pillar', 'wall_ivy', 'wall_ivy_corner', 'wall_ivy_wide', 'clover_patch', 'forest_plant'])

/** Сколько клеток-кандидатов пробуем, прежде чем отказаться от предмета. */
const PLACEMENT_ATTEMPTS = 16

/** Обязательный предмет получает расширенный, но всё ещё ограниченный поиск. */
const REQUIRED_PLACEMENT_ATTEMPTS = 64

/** Вторая bounded-попытка required после неудачи первых кандидатов. */
const REQUIRED_RETRY_ATTEMPTS = 128

/**
 * Сколько клеток зоны просматривается под один предмет. Ограничение делает
 * стоимость расстановки линейной по числу клеток вместо квадратичной: замер до
 * него давал 821 мс на карте 60×60, после — десятки миллисекунд. Четырёхсот
 * кандидатов хватает, чтобы найти клетку у стены или рядом со столом.
 */
const CANDIDATE_SCAN_LIMIT = 400

/**
 * Подбирает положение прямоугольника футпринта так, чтобы он накрывал выбранную
 * клетку и целиком помещался на проходимых свободных клетках.
 *
 * Прямоугольник не привязан к верхнему левому углу: стойка 4×1 у стены обязана
 * лечь **вдоль** стены, а не упереться в неё. Поэтому перебираются все сдвиги,
 * при которых выбранная клетка остаётся внутри прямоугольника.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {Set<string>} blocked занятые предметами или зарезервированные под проход клетки
 * @param {{x: number, y: number}} anchor
 * @param {{w: number, h: number}} footprint
 * @param {number} rotation
 * @returns {Array<{x: number, y: number}>|null} null, если положения нет
 */
function fittingFootprint(map, blocked, anchor, footprint, rotation) {
  if (!footprint.w || !footprint.h) return []
  // Плоское освещение позволяет вращать предмет свободно, но занимаемые клетки
  // считаются по прямоугольнику: поворот на 90° меняет ширину и высоту местами.
  const quarter = Math.round(((rotation % 360) + 360) % 360 / 90) % 4
  const width = quarter % 2 === 0 ? footprint.w : footprint.h
  const height = quarter % 2 === 0 ? footprint.h : footprint.w
  for (let offsetY = 0; offsetY < height; offsetY += 1) {
    for (let offsetX = 0; offsetX < width; offsetX += 1) {
      /** @type {Array<{x: number, y: number}>} */
      const cells = []
      let fits = true
      for (let dy = 0; dy < height && fits; dy += 1) {
        for (let dx = 0; dx < width && fits; dx += 1) {
          const x = anchor.x - offsetX + dx
          const y = anchor.y - offsetY + dy
          const target = cellAt(map, x, y)
          if (!target || !target.passable || blocked.has(`${x},${y}`)) fits = false
          else cells.push({ x, y })
        }
      }
      if (fits) return cells
    }
  }
  return null
}

/**
 * Оценка клетки под конкретный ассет. Прямое развитие `featureCellScore`.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {import('./asset-registry.mjs').AssetEntry} asset
 * @param {{x: number, y: number}} cell
 * @param {Array<{assetId: string, x: number, y: number, zoneId?: string}>} placed
 * @param {{zoneId?: string, arrangement?: 'rows'|'gathered'|'stalls', zoneBounds?: {minX: number, maxX: number, minY: number, maxY: number}, localPlaced?: Array<{assetId: string, x: number, y: number, zoneId?: string}>, sameAsset?: Array<{assetId: string, x: number, y: number, zoneId?: string}>}} context
 *   `localPlaced` и `sameAsset` вызывающий считает один раз на предмет, а не на каждую клетку-кандидата
 * @param {() => number} random
 * @returns {number}
 */
function scoreCellForAsset(map, asset, cell, placed, context = {}, random = () => 0) {
  const walls = wallSidesAt(map, cell.x, cell.y).length
  let score = random() * 2
  const localPlaced = context.localPlaced ?? (context.zoneId
    ? placed.filter((record) => record.zoneId === context.zoneId)
    : placed)

  // Шкаф, стеллаж и штабель не заслоняют окно: свет и обзор из окна — то,
  // ради чего его прорубили. Низкая мебель — кровать, стол, сундук — под
  // окном стоит, как и в жизни.
  if (asset.blocksSight && windowBeside(map, cell.x, cell.y)) return Number.NEGATIVE_INFINITY

  if (asset.anchor === 'wall') score += walls * 6
  else if (asset.anchor === 'corner') score += walls >= 2 ? 14 : walls * 2
  else score -= walls * 1.5

  // Одинаковое вплотную — штамп, а не обстановка: три урны в ряд, пять
  // паутин подряд, куст к кусту. Предметы, которые и стоят рядами (забор,
  // скамьи, штабели, стулья у стола), правило не трогает.
  if (!CLUSTER_FRIENDLY.has(asset.id)) {
    const same = nearestPlaced(context.sameAsset ?? placed, cell, (id) => id === asset.id)
    // Вплотную — запрет, а не штраф: в тесной зоне штраф проигрывал, и
    // одинаковое всё равно вставало рядом, а то и в ту же клетку.
    if (same != null && same <= 1) return Number.NEGATIVE_INFINITY
    if (same === 2) score -= 6
  }

  // Шаблон помещения: предмет набора тянется к своему центру — наковальня и
  // бочка к горну, курильница и подушки к алтарю, колода к плите. Без
  // центра поблизости предмет стоит где угодно, но с заметным штрафом.
  const anchors = SET_ANCHORS[asset.id]
  if (anchors) {
    const nearest = nearestPlaced(localPlaced, cell, (id) => anchors.includes(id))
    if (nearest != null) score += nearest <= 1 ? 14 : nearest === 2 ? 8 : nearest <= 4 ? 2 : -nearest
  }
  // Стул тянется к столу — правило, ради которого расстановка вообще перестаёт
  // выглядеть случайной.
  if (asset.id === 'chair' || asset.id === 'stool' || asset.id === 'bench') {
    const nearestTable = nearestPlaced(localPlaced, cell, (id) => id.startsWith('table_'))
    score += nearestTable == null ? -8 : nearestTable <= 1 ? 16 : nearestTable === 2 ? 6 : -nearestTable
  }
  // В казарме койки образуют ряды, а не равномерный случайный шум. Ось ряда
  // выбирается по форме зоны; соседняя койка получает заметный бонус по той же
  // линии, сохраняя прежний якорь стены и детерминированный перебор.
  if (context.arrangement === 'rows' && (asset.id === 'bed' || asset.id === 'bunk_bed')) {
    const beds = localPlaced.filter((record) => (
      record.zoneId === context.zoneId && (record.assetId === 'bed' || record.assetId === 'bunk_bed')
    ))
    const nearestBed = closestRecord(beds, cell, () => true)
    if (nearestBed) {
      const minX = context.zoneBounds?.minX ?? cell.x
      const maxX = context.zoneBounds?.maxX ?? cell.x
      const minY = context.zoneBounds?.minY ?? cell.y
      const maxY = context.zoneBounds?.maxY ?? cell.y
      const horizontal = maxX - minX >= maxY - minY
      const lineDistance = horizontal
        ? Math.abs(nearestBed.y - cell.y)
        : Math.abs(nearestBed.x - cell.x)
      score += lineDistance === 0 ? 14 : lineDistance === 1 ? 4 : -lineDistance
    }
  }
  // Стойла и склад предпочитают повторяющиеся группы вдоль стен. Это намеренно
  // небольшой дополнительный балл: главным правилом остаётся якорь реестра.
  if (context.arrangement === 'stalls' && ['crate', 'crate_stack', 'barrel', 'barrel_stack', 'haystack', 'water_trough', 'hitching_post'].includes(asset.id)) {
    const sameKind = nearestPlaced(localPlaced, cell, (id) => id === asset.id)
    if (sameKind != null) score += sameKind <= 2 ? 8 : -sameKind
  }
  // Мелкая утварь ложится поверх столов и стойки.
  if (!asset.baseFootprint.w) {
    const nearestSurface = nearestPlaced(localPlaced, cell, (id) => id.startsWith('table_') || id === 'bar_counter')
    score += nearestSurface == null ? -4 : nearestSurface === 0 ? 12 : nearestSurface <= 1 ? 5 : -nearestSurface
  }
  // Растительность требует грунта. Сухостой допустим на песке, хвойные — на
  // снежной поверхности снаружи; каменный или ледяной пол дома не подходит.
  if (asset.id.startsWith('tree_') || asset.id === 'bush' || asset.id === 'shrub') {
    const ground = cellAt(map, cell.x, cell.y)
    const material = ground?.material
    const outside = map.zones.some((zone) => zone.id === ground?.zone && zone.kind === 'exterior')
    const climateGround = outside && (
      material === 'sand' && ['tree_dead', 'tree_stump'].includes(asset.id)
      || material === 'ice' && ground?.surface === 'ice' && ['tree_pine', 'tree_spruce', 'tree_dead', 'tree_stump'].includes(asset.id)
    )
    if (material !== 'grass' && material !== 'earth' && !climateGround) return Number.NEGATIVE_INFINITY
    score += material === 'grass' ? 8 : 2
    // Деревья не жмутся друг к другу вплотную.
    const nearestTree = nearestPlaced(localPlaced, cell, (id) => id.startsWith('tree_'))
    if (nearestTree != null && nearestTree <= 1) score -= 12
  }
  // Пуассоновский диск для природы под открытым небом: дерево, куст и камень
  // не встают ближе своего радиуса к другой такой же природе. Случайная
  // россыпь давала комья и пустоши, а сетка кандидатов — ряды; диск даёт
  // ровную, но не регулярную рассадку, как в настоящем подлеске.
  const radius = SCATTER_RADIUS[asset.id]
  if (radius && map.zones.some((zone) => zone.id === context.zoneId && zone.kind === 'exterior')) {
    for (const record of localPlaced) {
      const other = SCATTER_RADIUS[record.assetId]
      if (!other) continue
      const reach = Math.max(radius, other)
      if ((record.x - cell.x) ** 2 + (record.y - cell.y) ** 2 < reach * reach) return Number.NEGATIVE_INFINITY
    }
  }
  return score
}

/**
 * Радиус пуассоновского диска в клетках для природной россыпи. Пара берёт
 * больший из двух радиусов: крона дуба держит куст дальше, чем куст куст.
 * Дерево 2×2 стоит якорем в левой верхней клетке, поэтому его радиус с запасом.
 *
 * @type {Readonly<Record<string, number>>}
 */
const SCATTER_RADIUS = Object.freeze({
  tree_oak: 2.3, tree_pine: 2.3, tree_birch: 1.8, tree_dead: 1.8,
  bush: 1.2, shrub: 1.2, rock_small: 1.2, boulder: 1.5, tree_stump: 1.2,
})

/**
 * @param {Array<{assetId: string, x: number, y: number}>} placed
 * @param {{x: number, y: number}} cell
 * @param {(assetId: string) => boolean} match
 * @returns {number|null}
 */
function nearestPlaced(placed, cell, match) {
  let best = null
  for (const record of placed) {
    if (!match(record.assetId)) continue
    const distance = Math.max(Math.abs(record.x - cell.x), Math.abs(record.y - cell.y))
    if (best == null || distance < best) best = distance
  }
  return best
}

/**
 * Поворот предмета. Якорь `wall` разворачивает лицом внутрь помещения; стул
 * поворачивается к ближайшему столу; остальное получает свободный угол.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {import('./asset-registry.mjs').AssetEntry} asset
 * @param {{x: number, y: number}} cell
 * @param {Array<{assetId: string, x: number, y: number, zoneId?: string}>} placed
 * @param {string} zoneId
 * @param {() => number} random
 * @returns {number}
 */
function rotationFor(map, asset, cell, placed, zoneId, random) {
  if (asset.anchor === 'wall' || asset.anchor === 'corner') {
    const walls = wallSidesAt(map, cell.x, cell.y)
    if (walls.length) return walls[Math.floor(random() * walls.length) % walls.length].facing
  }
  if (asset.id === 'chair' || asset.id === 'stool' || asset.id === 'bench') {
    const localPlaced = zoneId ? placed.filter((record) => record.zoneId === zoneId) : placed
    const table = closestRecord(localPlaced, cell, (id) => id.startsWith('table_') || id === 'bar_counter')
    if (table) return angleTowards(cell, table)
  }
  if (asset.id.startsWith('tree_') || asset.id === 'bush' || asset.id === 'rock_small' || asset.id === 'boulder') {
    // У кроны нет лица, поэтому угол свободный — именно он и создаёт
    // впечатление разных деревьев из одного рисунка.
    return Math.floor(random() * 360)
  }
  return Math.round(random() * 4) % 4 * 90
}

/**
 * @param {Array<{assetId: string, x: number, y: number}>} placed
 * @param {{x: number, y: number}} cell
 * @param {(assetId: string) => boolean} match
 * @returns {{x: number, y: number}|null}
 */
function closestRecord(placed, cell, match) {
  let best = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const record of placed) {
    if (!match(record.assetId)) continue
    const distance = Math.max(Math.abs(record.x - cell.x), Math.abs(record.y - cell.y))
    if (distance < bestDistance) {
      bestDistance = distance
      best = record
    }
  }
  return best
}

/**
 * Угол от клетки к цели, кратный 90°, где 0 смотрит на север.
 * @param {{x: number, y: number}} from
 * @param {{x: number, y: number}} to
 * @returns {number}
 */
function angleTowards(from, to) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 270 : 90
  return dy >= 0 ? 0 : 180
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizedPurpose(value) {
  const key = String(value ?? '').trim().toLocaleLowerCase('en').replace(/[-\s]+/gu, '_')
  return (/** @type {Record<string, string>} */ (PURPOSE_ALIASES))[key] ?? key
}

/**
 * Разбирает необязательные purpose/tags, не меняя схему карты. Явное назначение
 * имеет приоритет; первым безопасным запасным вариантом служит известный тег.
 *
 * @param {{purpose?: unknown, tags?: unknown}} plan
 * @returns {{purpose: string, require: string[], prefer: string[], themes?: string[], caps?: Record<string, number>, arrangement?: 'rows'|'gathered'|'stalls'}|null}
 */
function semanticProfileFor(plan) {
  const explicit = normalizedPurpose(plan?.purpose)
  const fromPurpose = (/** @type {Record<string, any>} */ (SEMANTIC_PROFILES))[explicit]
  if (fromPurpose) return { purpose: explicit, ...fromPurpose }
  for (const rawTag of Array.isArray(plan?.tags) ? plan.tags : []) {
    const purpose = (/** @type {Record<string, string>} */ (TAG_PURPOSES))[String(rawTag ?? '').trim().toLocaleLowerCase('en').replace(/[-\s]+/gu, '_')]
    if (purpose && SEMANTIC_PROFILES[purpose]) return { purpose, ...SEMANTIC_PROFILES[purpose] }
  }
  return null
}

/**
 * @param {{x: number, y: number}} cell
 * @returns {string}
 */
function cellKey(cell) {
  return `${cell.x},${cell.y}`
}

/**
 * Запись двери указывает на одно ребро проёма. В графовой планировке проём
 * может иметь проходимую клетку без зоны, поэтому учитываются и её проходимые соседи.
 * Эти соседи — первые клетки, которые нужно оставить свободными у двери комнаты.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {string} zoneId
 * @param {Set<string>} allowed
 * @returns {Array<{x: number, y: number}>}
 */
function doorwayApproaches(map, zoneId, allowed) {
  /** @type {Map<string, {x: number, y: number}>} */
  const found = new Map()
  /** @param {number} x @param {number} y */
  const add = (x, y) => {
    const cell = cellAt(map, x, y)
    if (!cell || !cell.passable || cell.zone !== zoneId || !allowed.has(`${x},${y}`)) return
    found.set(`${x},${y}`, { x, y })
  }
  for (const door of Array.isArray(map.doors) ? map.doors : []) {
    const first = { x: door.x, y: door.y }
    const second = edgeNeighbor(door)
    for (const endpoint of [first, second]) {
      add(endpoint.x, endpoint.y)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) add(endpoint.x + dx, endpoint.y + dy)
    }
  }
  // Открытая связь графа или старая дверь могут оставить проходимый порог без
  // записи в `doors`. Граница зоны всё равно считается дверным проёмом для расстановки.
  // Только у помещения: у двора или улицы граница — вся кромка, и такой
  // резерв отнимал почти все клетки — цветы громоздились в оставшиеся восемь.
  const interior = map.zones.find((zone) => zone.id === zoneId)?.kind === 'interior'
  if (interior) for (const candidate of allowed) {
    const [x, y] = candidate.split(',').map(Number)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const neighbor = cellAt(map, x + dx, y + dy)
      // Сосед за тонкой стеной — не проём: через ребро-стену не пройти, и
      // вдоль всей стены комнаты мебели иначе не было бы места.
      const edge = neighbor ? edgeBetween(map, x, y, x + dx, y + dy) : null
      if (edge && edge.kind !== 'door' && edge.blocksMove) continue
      if (neighbor?.passable && neighbor.zone !== zoneId) {
        found.set(candidate, { x, y })
        break
      }
    }
  }
  return [...found.values()].sort((left, right) => left.y - right.y || left.x - right.x)
}

/**
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {Set<string>} allowed
 * @param {{x: number, y: number}} start
 * @param {{x: number, y: number}} target
 * @returns {Array<{x: number, y: number}>}
 */
function corridorPath(map, allowed, start, target) {
  const startKey = cellKey(start)
  const targetKey = cellKey(target)
  if (!allowed.has(startKey) || !allowed.has(targetKey)) return []
  /** @type {Array<{x: number, y: number}>} */
  const queue = [{ x: start.x, y: start.y }]
  /** @type {Map<string, string|null>} */
  const previous = new Map([[startKey, null]])
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    const currentKey = cellKey(current)
    if (currentKey === targetKey) break
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const next = { x: current.x + dx, y: current.y + dy }
      const nextKey = cellKey(next)
      if (previous.has(nextKey) || !allowed.has(nextKey)) continue
      // Стена внутри некорректной комнаты не должна превращать путь очистки в
      // обещание прохода, которого не сможет обеспечить само движение.
      const edge = edgeBetween(map, current.x, current.y, next.x, next.y)
      if (edge && edge.kind !== 'door' && edge.blocksMove) continue
      previous.set(nextKey, currentKey)
      queue.push(next)
    }
  }
  if (!previous.has(targetKey)) return []
  /** @type {Array<{x: number, y: number}>} */
  const path = []
  let cursor = targetKey
  while (cursor) {
    const [x, y] = cursor.split(',').map(Number)
    path.push({ x, y })
    cursor = previous.get(cursor) ?? ''
  }
  return path.reverse()
}

/**
 * Резервирует одноклеточный путь от каждого дверного проёма комнаты к другим
 * проёмам (или к центру комнаты, если проём один). Так мебель остаётся
 * читаемой, а существующий валидатор движения получает настоящий маршрут.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {string} zoneId
 * @param {Array<{x: number, y: number}>} cells
 * @returns {Set<string>}
 */
function passageClearance(map, zoneId, cells) {
  const allowed = new Set(cells.map(cellKey))
  const approaches = doorwayApproaches(map, zoneId, allowed)
  const clear = new Set(approaches.map(cellKey))
  if (!approaches.length) return clear

  const targets = approaches.length > 1 ? approaches.slice(1) : [
    [...cells].sort((left, right) => left.y - right.y || left.x - right.x)[Math.floor(cells.length / 2)],
  ]
  let from = approaches[0]
  for (const target of targets) {
    const path = corridorPath(map, allowed, from, target)
    for (const cell of path) clear.add(cellKey(cell))
    from = target
  }
  return clear
}

/** Максимум мебельных предметов, которые может снять один repair-pass. */
const PROP_ACCESS_REPAIR_LIMIT = 12

/**
 * Соседи клетки в том же порядке, в котором их обходят правила движения.
 * Порядок является частью детерминизма repair-pass: при равной цене всегда
 * выбирается один и тот же коридор.
 */
const ACCESS_DIRECTIONS = Object.freeze([[1, 0], [0, 1], [-1, 0], [0, -1]])

/**
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @returns {{baseline: Set<string>, targets: Set<string>, semantic: Set<string>}|null}
 */
function propAccessTargets(map) {
  const spawn = Array.isArray(map.spawnPoints)
    ? map.spawnPoints.find((point) => point.role === 'party')
    : null
  if (!spawn) return null
  const baseline = reachableCells(map, spawn.x, spawn.y, { throughDoors: true })
  if (!baseline.size) return null

  /** @type {Set<string>} */
  const targets = new Set()
  const blockers = blockingPropsByCell(map)
  for (const key of baseline) {
    // Клетка под мебелью не является целью движения: furniture footprint уже
    // занимает её по правилам тактики. Пороги и spawn добавляются ниже даже
    // если их занял проп — это точки, которые repair обязан освободить.
    // Цель — любая свободная клетка, не только в помещении: деревья и телеги
    // тоже отрезали куски леса, улицы и пещеры, куда отряд не мог дойти.
    if (!blockers.has(key)) targets.add(key)
  }
  // Дверной порог и клетка по другую сторону двери — семантические цели.
  // В отличие от мебели внутри комнаты, их нужно очистить даже когда проп уже
  // успел занять клетку.
  for (const door of Array.isArray(map.doors) ? map.doors : []) {
    for (const endpoint of [{ x: door.x, y: door.y }, edgeNeighbor(door)]) {
      const key = cellKey(endpoint)
      const cell = cellAt(map, endpoint.x, endpoint.y)
      if (baseline.has(key) && cell?.passable) targets.add(key)
    }
  }
  const spawnKey = cellKey(spawn)
  /** @type {Set<string>} */
  const semantic = new Set()
  for (const door of Array.isArray(map.doors) ? map.doors : []) {
    for (const endpoint of [{ x: door.x, y: door.y }, edgeNeighbor(door)]) if (targets.has(cellKey(endpoint))) semantic.add(cellKey(endpoint))
  }
  if (baseline.has(spawnKey)) {
    targets.add(spawnKey)
    semantic.add(spawnKey)
  }
  return { baseline, targets, semantic }
}

/** Главная мебель комнаты: ремонт доступа снимает её последней. */
const KEY_FURNITURE = new Set(['bed', 'bunk_bed', 'bar_counter', 'bar_shelf', 'fireplace', 'altar', 'well', 'stairs_up', 'stairs_down', 'sarcophagus', 'table_long', 'table_round', 'market_stall'])
const KEY_FURNITURE_COST = 4

/** Закуток меньше этого числа клеток не стоит снятой мебели. */
const MIN_POCKET_CELLS = 1

/**
 * Отрезанные клетки, ради которых стоит снимать предмет: пороги дверей,
 * точка появления и любые закутки: все клетки помещения обязаны быть
 * досягаемы. Порог оставлен параметром, а беречь кровать помогает цена
 * пути (`KEY_FURNITURE`), а не отказ от ремонта.
 *
 * @param {Set<string>} pending
 * @param {Set<string>} semantic
 * @returns {Set<string>}
 */
function worthRepair(pending, semantic) {
  /** @type {Set<string>} */
  const result = new Set()
  /** @type {Set<string>} */
  const seen = new Set()
  for (const start of pending) {
    if (seen.has(start)) continue
    const group = [start]
    seen.add(start)
    for (let index = 0; index < group.length; index += 1) {
      const [x, y] = group[index].split(',').map(Number)
      for (const [dx, dy] of ACCESS_DIRECTIONS) {
        const key = `${x + dx},${y + dy}`
        if (pending.has(key) && !seen.has(key)) {
          seen.add(key)
          group.push(key)
        }
      }
    }
    if (group.length >= MIN_POCKET_CELLS || group.some((key) => semantic.has(key))) for (const key of group) result.add(key)
  }
  return result
}

/**
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @returns {Map<string, number[]>}
 */
function blockingPropsByCell(map) {
  /** @type {Map<string, number[]>} */
  const byCell = new Map()
  map.props.forEach((prop, index) => {
    if (!prop.blocksMove || !Array.isArray(prop.footprint) || !prop.footprint.length) return
    for (const cell of prop.footprint) {
      const key = cellKey(cell)
      const owners = byCell.get(key) ?? []
      owners.push(index)
      byCell.set(key, owners)
    }
  })
  return byCell
}

/**
 * Находит маршрут до любой цели с минимальным числом клеток, занятых
 * blocking-пропами. Это один 0–1 BFS после полной расстановки, а не проверка
 * связности для каждого кандидата мебели.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {Set<string>} baseline
 * @param {Set<string>} reached
 * @param {Set<string>} targets
 * @param {Map<string, number[]>} blockers
 * @returns {number[]}
 */
function accessRepairPath(map, baseline, reached, targets, blockers) {
  /** @type {Map<string, number>} */
  const distance = new Map()
  /** @type {Map<string, string|null>} */
  const previous = new Map()
  // Дейкстра на корзинах: свободная клетка стоит 0, клетка под мелочью — 1,
  // под главной мебелью комнаты — `KEY_FURNITURE_COST`. Путь ремонта поэтому
  // идёт через тумбочку и свечу, а не через кровать и барную стойку: прежде
  // ради клетки за шкафом из спальни выносили единственную кровать.
  /** @type {Array<string[]>} */
  const buckets = []
  const push = (/** @type {string} */ key, /** @type {number} */ cost) => {
    if (!buckets[cost]) buckets[cost] = []
    buckets[cost].push(key)
  }
  /** @param {string} key */
  const stepCostAt = (key) => {
    const owners = blockers.get(key)
    if (!owners?.length) return 0
    return owners.some((index) => KEY_FURNITURE.has(map.props[index]?.assetId)) ? KEY_FURNITURE_COST : 1
  }

  for (const key of [...reached].sort(compareCellKeys)) {
    distance.set(key, 0)
    previous.set(key, null)
    push(key, 0)
  }

  for (let cost = 0; cost < buckets.length; cost += 1) {
    const bucket = buckets[cost]
    if (!bucket) continue
    for (let position = 0; position < bucket.length; position += 1) {
      const current = bucket[position]
      if ((distance.get(current) ?? Number.POSITIVE_INFINITY) < cost) continue
      const [x, y] = current.split(',').map(Number)
      for (const [dx, dy] of ACCESS_DIRECTIONS) {
        const next = { x: x + dx, y: y + dy }
        const nextKey = cellKey(next)
        if (!baseline.has(nextKey)) continue
        const edge = edgeBetween(map, x, y, next.x, next.y)
        if (edge && edge.kind !== 'door' && edge.blocksMove) continue
        const nextDistance = cost + stepCostAt(nextKey)
        if (nextDistance >= (distance.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue
        distance.set(nextKey, nextDistance)
        previous.set(nextKey, current)
        push(nextKey, nextDistance)
      }
    }
  }

  let target = null
  let targetDistance = Number.POSITIVE_INFINITY
  for (const key of [...targets].sort(compareCellKeys)) {
    const candidateDistance = distance.get(key)
    if (candidateDistance == null || candidateDistance <= 0) continue
    if (candidateDistance < targetDistance) {
      target = key
      targetDistance = candidateDistance
    }
  }
  if (!target) return []

  /** @type {number[]} */
  const pathProps = []
  const seenProps = new Set()
  let cursor = target
  while (cursor) {
    for (const index of blockers.get(cursor) ?? []) {
      if (seenProps.has(index)) continue
      seenProps.add(index)
      pathProps.push(index)
    }
    cursor = previous.get(cursor) ?? ''
  }
  pathProps.reverse()
  return pathProps
}

/**
 * Удаляет один blocking-проп и мелкие предметы, подвешенные к его поверхности.
 * Ссылки на поверхность не должны переживать удаление самой поверхности.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {number} index
 * @returns {boolean}
 */
function removeBlockingProp(map, index) {
  const removed = map.props[index]
  if (!removed || !removed.blocksMove) return false
  const removedIds = new Set([removed.id])
  const removedProps = new Set([removed])
  let changed = true
  while (changed) {
    changed = false
    for (const prop of map.props) {
      if (removedProps.has(prop) || prop.mount?.kind !== 'surface' || !removedIds.has(prop.mount.propId)) continue
      removedProps.add(prop)
      removedIds.add(prop.id)
      changed = true
    }
  }
  map.props = map.props.filter((prop) => !removedProps.has(prop))
  return true
}

/**
 * Восстанавливает доступ к новой карте после расстановки blocking-пропов.
 * Геометрия и рёбра не меняются: bounded-pass снимает только минимальный
 * ближайший blocking-проп, если он запер изначально доступную интерьерную
 * клетку, дверной порог или точку появления.
 *
 * Вызывается владельцем генератора после `placeProps`; сохранённые карты и
 * статическая расстановка этим проходом не затрагиваются.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function ensurePropAccess(map) {
  for (let repair = 0; repair < PROP_ACCESS_REPAIR_LIMIT; repair += 1) {
    // Цели пересчитываются на каждом шаге: снятый предмет освобождает клетки
    // под собой, и они тоже обязаны быть досягаемы — иначе за соседним ящиком
    // остаётся закуток, которого при первом подсчёте ещё не было.
    const access = propAccessTargets(map)
    if (!access) break
    const blockers = blockingPropsByCell(map)
    const blockedCells = new Set(blockers.keys())
    const spawn = map.spawnPoints.find((point) => point.role === 'party')
    if (!spawn) break
    const spawnBlockers = blockers.get(cellKey(spawn)) ?? []
    if (spawnBlockers.length) {
      if (!removeBlockingProp(map, spawnBlockers[0])) break
      continue
    }
    const reached = reachableCells(map, spawn.x, spawn.y, { throughDoors: true, blockedCells })
    const pending = worthRepair(new Set([...access.targets].filter((key) => !reached.has(key))), access.semantic)
    if (!pending.size) break
    const pathProps = accessRepairPath(map, access.baseline, reached, pending, blockers)
    if (!pathProps.length) break
    if (!removeBlockingProp(map, pathProps[0])) break
  }
  return map
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareCellKeys(left, right) {
  const [leftX, leftY] = left.split(',').map(Number)
  const [rightX, rightY] = right.split(',').map(Number)
  return leftY - rightY || leftX - rightX
}

/**
 * @typedef {object} ZonePlacementPlan
 * @property {string} zoneId
 * @property {string} theme тема, по которой отбираются ассеты реестра
 * @property {number} density предметов на 100 клеток зоны
 * @property {string} [purpose] назначение комнаты: gallery, living, bedroom, barracks, kitchen, store, stable, workshop, courtyard, exterior
 * @property {string[]} [tags] необязательные теги; первый известный тег задаёт то же назначение
 * @property {string[]} [require] идентификаторы, которые обязаны появиться
 * @property {string[]} [prefer] из чего добирать остальное; без него — весь каталог темы
 * @property {Record<string, number>} [caps] потолок числа предметов вида в зоне; сильнее потолков профиля
 * @property {string[]} [extraThemes] дополнительные темы, чьи предметы тоже допустимы в зоне
 */

/**
 * Раскладывает предметы по карте. Мутирует карту и возвращает её же.
 *
 * Плотность задаётся зоной, а не общим счётчиком (`docs/tactical-map-plan.md`,
 * стадия 3): иначе двор и общий зал получают поровну, хотя наполнены по-разному.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {object} options
 * @param {string} options.seed
 * @param {ZonePlacementPlan[]} options.zones
 * @param {number} [options.maxProps] бюджет класса размера
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function placeProps(map, { seed, zones, maxProps = 250 } = /** @type {any} */ ({})) {
  const random = randomFor(`${PROP_PLACEMENT_VERSION}:${seed}`)
  /** @type {Set<string>} */
  const occupied = new Set()
  for (const prop of map.props) for (const cell of prop.footprint) occupied.add(`${cell.x},${cell.y}`)
  /** @type {Array<{assetId: string, x: number, y: number, zoneId?: string}>} */
  const placed = map.props.map((prop) => ({
    assetId: prop.assetId,
    x: Math.floor(prop.x),
    y: Math.floor(prop.y),
    zoneId: cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone,
  }))
  let counter = map.props.length
  // Порог любой двери и клетка за ним по прямой закрыты для мебели всех зон:
  // двухклеточный прилавок площади или крона дуба во дворе иначе выступали
  // на подход к двери соседнего дома — резерв зоны их не видел.
  const thresholds = doorThresholds(map)
  // Тропа к двери дома (`path`, поселение v5) закрыта так же: двухклеточный
  // ящик кладовой у стены выступал на неё и перекрывал путь к двери.
  // Крайняя клетка карты тоже: предмет на ней обрезан краем доски, к нему не
  // подойти со всех сторон (критерий плана карт: «никакой предмет не стоит на
  // крайней клетке»; корпус программ находил там поленницы и бочки).
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    if (cellAt(map, x, y)?.zone === 'path' || x === 0 || y === 0 || x === map.width - 1 || y === map.height - 1) thresholds.add(`${x},${y}`)
  }

  for (const plan of zones ?? []) {
    const cells = zoneCells(map, plan.zoneId)
    if (!cells.length) continue
    const semantic = semanticProfileFor(plan)
    const keepClear = passageClearance(map, plan.zoneId, cells)
    const zoneBounds = cells.reduce((bounds, cell) => ({
      minX: Math.min(bounds.minX, cell.x),
      maxX: Math.max(bounds.maxX, cell.x),
      minY: Math.min(bounds.minY, cell.y),
      maxY: Math.max(bounds.maxY, cell.y),
    }), { minX: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY })
    const budget = Math.max(0, Math.round(cells.length * Math.max(0, plan.density) / 100))
    // Комната может брать предметы из нескольких тем: склеп — подсвечник и
    // сундук из интерьера, пещера-логово — ящики и костёр. Основная тема
    // первой, повторы отброшены.
    const catalogue = [...new Map([plan.theme, ...(plan.extraThemes ?? []), ...(semantic?.themes ?? [])]
      .flatMap((theme) => assetsForTheme(theme)).map((record) => [record.id, record])).values()]
    if (!catalogue.length) continue

    // Сначала набирается список того, что вообще ставим, и лишь потом он
    // сортируется по размеру. Перебор каталога по размеру давал бы одни
    // крупные предметы: до стульев очередь не доходила бы никогда.
    /** @type {import('./asset-registry.mjs').AssetEntry[]} */
    const wanted = []
    // Список темы — единственный источник допустимого. Раньше `require` брал
    // предмет по идентификатору мимо фильтра, и в пещеру могла попасть барная
    // стойка: обязательность не отменяет принадлежность теме.
    const allowed = new Set(catalogue.map((record) => record.id))
    // Потолки профиля и плана складываются: план сцены может сказать «не
    // больше двух телег на деревню», даже если профиля у зоны нет.
    const profileCaps = { ...(semantic?.caps ?? {}), ...(plan.caps ?? {}) }
    /** @type {Map<string, number>} */
    const counts = new Map()
    /** @type {Map<string, number>} */
    const requiredCounts = new Map()
    /** @type {import('./asset-registry.mjs').AssetEntry[]} */
    const requiredAssets = []
    /** @param {import('./asset-registry.mjs').AssetEntry|null} asset @param {boolean} [withCompanions] @param {boolean} [required] */
    const enqueue = (asset, withCompanions = true, required = false) => {
      // Required ассеты резервируются до companions и не вытесняются плотностью
      // зоны. Общий cap `maxProps` остаётся последним ограничителем уже при
      // фактической расстановке.
      if (!asset || !allowed.has(asset.id) || (!required && wanted.length >= budget)) return false
      // Плоская мелочь без футпринта (мозаика, паутина, цветы) не перегружает
      // зону: не больше штуки на шестьдесят клеток, если план не сказал иного.
      const decalCap = !asset.baseFootprint.w && !TABLEWARE.has(asset.id) && !WALL_MOUNTS.has(asset.id)
        ? Math.max(2, Math.round(cells.length / 60))
        : Number.POSITIVE_INFINITY
      const cap = profileCaps[asset.id] ?? decalCap
      const current = counts.get(asset.id) ?? 0
      if (Number.isFinite(cap) && current >= cap) return false
      wanted.push(asset)
      counts.set(asset.id, current + 1)
      if (required) {
        requiredAssets.push(asset)
        requiredCounts.set(asset.id, (requiredCounts.get(asset.id) ?? 0) + 1)
      }
      if (withCompanions) {
        for (const [companionId, count] of COMPANIONS[asset.id] ?? []) {
          for (let index = 0; index < count && wanted.length < budget; index += 1) {
            enqueue(assetById(companionId), false, false)
          }
        }
      }
      return true
    }
    // Явные требования плана имеют приоритет: профиль добавляет недостающие
    // роли, но не вытесняет ключевой предмет компаньонами из повторного стола.
    const required = [...(plan.require ?? [])]
    for (const id of semantic?.require ?? []) {
      const requiredCount = (semantic?.require ?? []).filter((candidate) => candidate === id).length
      const currentCount = required.filter((candidate) => candidate === id).length
      for (let index = currentCount; index < requiredCount; index += 1) required.push(id)
    }
    for (const id of required) enqueue(assetById(id), false, true)
    // Companions заполняют только оставшийся budget и никогда не занимают
    // слоты обязательных предметов.
    for (const asset of requiredAssets) {
      for (const [companionId, count] of COMPANIONS[asset.id] ?? []) {
        for (let index = 0; index < count && wanted.length < budget; index += 1) {
          enqueue(assetById(companionId), false, false)
        }
      }
    }
    // Случайный добор идёт из `prefer`, если он задан, и только иначе из всего
    // каталога темы. Без этого мелочь вытесняет крупное: во дворе таверны
    // оказывалось по четыре костра и по три коновязи, а деревьев — одно, и
    // двор переставал читаться как двор.
    const pool = [...(semantic?.prefer ?? []), ...(plan.prefer ?? [])]
      .map((id) => assetById(id))
      .filter((asset) => asset && allowed.has(asset.id)
        && !(Number.isFinite(profileCaps[asset.id]) && profileCaps[asset.id] <= 0))
    const source = pool.length ? pool : catalogue
    const maxFillAttempts = Math.max(32, budget * 8)
    // Новая утварь без опоры снимается в attachPropSupports. Без стола в зоне
    // её не берём вовсе: иначе она съедала бюджет, и комната пустела.
    const surfaceAhead = () => wanted.some((asset) => SURFACES.has(asset.id))
      || placed.some((record) => record.zoneId === plan.zoneId && SURFACES.has(record.assetId))
    // Добор взвешен против уже выбранного: каждый следующий экземпляр того же
    // предмета вдвое-втрое менее вероятен. Равновероятный выбор давал храм,
    // где треть предметов — мозаика, и склеп из одной паутины.
    for (let attempt = 0; wanted.length < budget && attempt < maxFillAttempts; attempt += 1) {
      const weights = source.map((asset) => 1 / ((1 + (counts.get(asset?.id ?? '') ?? 0)) ** 1.6))
      let roll = random() * weights.reduce((sum, weight) => sum + weight, 0)
      let pick = source[source.length - 1]
      for (let index = 0; index < source.length; index += 1) {
        roll -= weights[index]
        if (roll <= 0) { pick = source[index]; break }
      }
      if (!pick) break
      if (NEW_TABLEWARE.has(pick.id) && !surfaceAhead()) continue
      enqueue(pick)
    }

    // Крупные предметы ставятся первыми, мелкая утварь — поверх и рядом.
    const requiredRemaining = new Map(requiredCounts)
    // Обязательность принадлежит конкретному экземпляру. Дополнительный
    // сундук того же вида не должен опережать обязательный штабель бочек.
    const order = wanted.map((asset) => {
      const required = (requiredRemaining.get(asset.id) ?? 0) > 0
      if (required) requiredRemaining.set(asset.id, /** @type {number} */ (requiredRemaining.get(asset.id)) - 1)
      return { asset, required }
    }).sort((leftEntry, rightEntry) => {
      const { asset: left, required: leftRequired } = leftEntry
      const { asset: right, required: rightRequired } = rightEntry
      if (leftRequired !== rightRequired) return leftRequired ? -1 : 1
      if (leftRequired) {
        // Сначала ставим поверхности, которые тянут companions (столы,
        // очаги), затем малые required: так стул получает якорь, а сундук
        // успевает занять единственную свободную клетку до штабелей.
        const leftHasCompanions = (COMPANIONS[left.id]?.length ?? 0) > 0
        const rightHasCompanions = (COMPANIONS[right.id]?.length ?? 0) > 0
        if (leftHasCompanions !== rightHasCompanions) return leftHasCompanions ? -1 : 1
        const leftArea = left.baseFootprint.w * left.baseFootprint.h
        const rightArea = right.baseFootprint.w * right.baseFootprint.h
        return leftHasCompanions ? rightArea - leftArea : leftArea - rightArea
      }
      return (right.baseFootprint.w * right.baseFootprint.h) - (left.baseFootprint.w * left.baseFootprint.h)
    })

    for (let index = 0; index < order.length && counter < maxProps; index += 1) {
      const { asset, required } = order[index]
      if (!asset) break
      // Кандидаты по убыванию оценки, а не один лучший: широкий предмет у стены
      // часто не помещается именно в самой удачной клетке, и одна неудача
      // раньше выбрасывала его целиком — вместе со стойкой и очагом.
      // Просматривается не вся зона, а ограниченная выборка. Полный перебор
      // давал квадратичную стоимость: предметов примерно столько же, сколько
      // клеток, и на 60×60 сборка занимала 0.8 секунды. Шаг выборки смещается
      // от номера предмета, поэтому разные предметы видят разные клетки, а
      // детерминизм сохраняется.
      const stride = cells.length > CANDIDATE_SCAN_LIMIT ? Math.ceil(cells.length / CANDIDATE_SCAN_LIMIT) : 1
      const offset = stride > 1 ? index % stride : 0
      const candidates = []
      // Списки для оценки — один раз на предмет: фильтр по всем поставленным
      // предметам на каждую клетку-кандидата делал расстановку квадратичной.
      const localPlaced = placed.filter((record) => record.zoneId === plan.zoneId)
      // Соседство одинаковых считается внутри зоны: стог на улице у стены
      // амбара не мешает стогу внутри.
      const sameAsset = localPlaced.filter((record) => record.assetId === asset.id)
      for (let position = offset; position < cells.length; position += stride) {
        const cell = cells[position]
        if (occupied.has(`${cell.x},${cell.y}`) || keepClear.has(`${cell.x},${cell.y}`) || thresholds.has(`${cell.x},${cell.y}`)) continue
        const score = scoreCellForAsset(map, asset, cell, placed, {
          zoneId: plan.zoneId,
          arrangement: semantic?.arrangement,
          zoneBounds,
          localPlaced,
          sameAsset,
        }, random)
        if (score === Number.NEGATIVE_INFINITY) continue
        candidates.push({ cell, score })
      }
      if (!candidates.length) continue
      candidates.sort((left, right) => right.score - left.score)

      let chosen = null
      const candidateLimit = required ? REQUIRED_PLACEMENT_ATTEMPTS : PLACEMENT_ATTEMPTS
      for (const candidate of candidates.slice(0, candidateLimit)) {
        const rotation = rotationFor(map, asset, candidate.cell, placed, plan.zoneId, random)
        const blocked = new Set([...occupied, ...keepClear, ...thresholds])
        const footprint = fittingFootprint(map, blocked, candidate.cell, asset.baseFootprint, rotation)
        // Вторая клетка шкафа тоже не встаёт перед окном.
        if (footprint && asset.blocksSight && footprint.some((point) => windowBeside(map, point.x, point.y))) continue
        if (footprint) {
          chosen = { cell: candidate.cell, rotation, footprint }
          break
        }
      }
      // Если required не поместился в первых лучших позициях, bounded retry
      // проверяет следующий детерминированный слой кандидатов до отказа от
      // предмета. Optional props остаются на коротком пути.
      if (!chosen && required) {
        for (const candidate of candidates.slice(candidateLimit, candidateLimit + REQUIRED_RETRY_ATTEMPTS)) {
          const rotation = rotationFor(map, asset, candidate.cell, placed, plan.zoneId, random)
          const blocked = new Set([...occupied, ...keepClear, ...thresholds])
          const footprint = fittingFootprint(map, blocked, candidate.cell, asset.baseFootprint, rotation)
          // Вторая клетка шкафа тоже не встаёт перед окном.
          if (footprint && asset.blocksSight && footprint.some((point) => windowBeside(map, point.x, point.y))) continue
          if (footprint) {
            chosen = { cell: candidate.cell, rotation, footprint }
            break
          }
        }
      }
      if (!chosen) continue

      const span = asset.scaleRange.max - asset.scaleRange.min
      counter += 1
      addProp(map, {
        id: `prop-${counter}-${asset.id}`,
        assetId: asset.id,
        x: chosen.cell.x + 0.5,
        y: chosen.cell.y + 0.5,
        rotation: chosen.rotation,
        scale: Number((asset.scaleRange.min + random() * span).toFixed(3)),
        footprint: chosen.footprint,
        zOrder: asset.baseFootprint.w ? 0 : 1,
        blocksMove: asset.blocksMove,
        blocksSight: asset.blocksSight,
        cover: asset.cover,
        destructible: asset.destructible,
        hp: asset.hp,
        interactive: asset.interactive,
      })
      for (const cell of chosen.footprint) occupied.add(`${cell.x},${cell.y}`)
      placed.push({ assetId: asset.id, x: chosen.cell.x, y: chosen.cell.y, zoneId: plan.zoneId })
    }
  }
  attachPropSupports(map)
  return map
}

/** Темы, по которым предмет считается вещью под крышей. */
export const INDOOR_THEMES = new Set(['interior', 'tavern', 'house', 'temple', 'crypt', 'dungeon', 'cave'])

/**
 * Переживут ли предметы ремонт доступа. Ремонт меняет только `map.props`,
 * поэтому проба идёт на мелкой копии карты.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {string[]} ids
 */
function survivesAccessRepair(map, ids) {
  const probe = { ...map, props: [...map.props] }
  ensurePropAccess(probe)
  const kept = new Set(probe.props.map((prop) => prop.id))
  return ids.every((id) => kept.has(id))
}

/**
 * Обещанное сценой: ставит недостающие предметы из списка «вид → штук». Сцена
 * говорит «три настила и алтарь», тема о них не знает — без этого шага на
 * карте не было бы ни того, ни другого. Предмет ставится той же расстановкой
 * как обязательный: двери, проходы и соседство одинаковых соблюдаются.
 * Предмет под крышу ищет комнату, уличный — двор или улицу; если таких зон
 * нет, годится любая. Не поместилось — значит, не поместилось: обещание
 * остаётся невыполненным и видно по `requirementsCoverage`, место не
 * выдумывается.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {Array<{assets: string[], count: number}>} wanted
 * @param {{seed: string}} options
 * @returns {number} сколько предметов поставлено
 */
export function placeRequiredProps(map, wanted, { seed }) {
  let added = 0
  for (const [index, requirement] of wanted.entries()) {
    const ids = new Set(requirement.assets)
    const asset = requirement.assets.map((id) => assetById(id)).find(Boolean)
    if (!asset) continue
    let missing = Math.max(1, requirement.count) - map.props.filter((prop) => ids.has(prop.assetId)).length
    if (missing <= 0) continue
    const indoor = asset.themes.some((theme) => INDOOR_THEMES.has(theme)) && !asset.themes.includes('exterior')
    // Зоны с местом: сначала подходящего рода, крупные первыми — там проще
    // не задеть проход.
    // Тропа к двери (`path`, поселение v5) — проход, а не место для обещанного.
    const sized = map.zones.filter((zone) => zone.id !== 'path')
      .map((zone) => ({ zone, size: zoneCells(map, zone.id).length })).filter((entry) => entry.size >= 4)
    const fitting = sized.filter(({ zone }) => (indoor ? zone.kind === 'interior' : zone.kind !== 'interior'))
    const order = (fitting.length ? fitting : sized).sort((left, right) => right.size - left.size || left.zone.id.localeCompare(right.zone.id))
    for (let attempt = 0; missing > 0 && attempt < missing + order.length * 2; attempt += 1) {
      const { zone } = order[attempt % order.length] ?? {}
      if (!zone) break
      const before = map.props.length
      placeProps(map, {
        seed: `${seed}:required:${index}:${attempt}`,
        maxProps: before + 1,
        zones: [{ zoneId: zone.id, theme: asset.themes[0], density: 0, require: [asset.id], caps: { [asset.id]: Number.POSITIVE_INFINITY } }],
      })
      const placedNow = map.props.length - before
      // Свой префикс: номер по счётчику расстановки мог совпасть с предметом,
      // который ремонт доступа уже убрал и чей номер освободился.
      for (const prop of map.props.slice(before)) prop.id = `required-${index}-${attempt}-${asset.id}`
      // Место, которое ремонт доступа потом расчистит (телега поперёк прохода
      // между рядами могил), обещанному не годится: снимаем и ищем другое.
      // Иначе предмет ставился и тут же пропадал — со сдвигом случайного
      // добора пропадала и обещанная «телега гробовщика».
      if (placedNow > 0 && !survivesAccessRepair(map, map.props.slice(before).map((prop) => prop.id))) {
        map.props = map.props.slice(0, before)
        continue
      }
      missing -= placedNow
      added += placedNow
    }
  }
  return added
}

/**
 * Клетки у дверей, которые не занимает мебель: обе стороны полотна и по
 * клетке за каждой стороной по прямой — тот же подход, что проверяет
 * `auditTacticalMap`.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @returns {Set<string>}
 */
function doorThresholds(map) {
  /** @type {Set<string>} */
  const cells = new Set()
  for (const door of Array.isArray(map.doors) ? map.doors : []) {
    const next = edgeNeighbor(door)
    const step = { x: next.x - door.x, y: next.y - door.y }
    for (const point of [{ x: door.x, y: door.y }, next, { x: door.x - step.x, y: door.y - step.y }, { x: next.x + step.x, y: next.y + step.y }]) cells.add(`${point.x},${point.y}`)
  }
  return cells
}

/**
 * Колоннада: два ровных ряда опор вдоль длинной оси зала, на шаг от стен и
 * через клетку друг от друга; в нефе шире 15 клеток — и средние ряды. Случайная расстановка давала «лес» колонн
 * посреди нефа; настоящий неф делится колоннами на центральный проход и
 * боковые нефы, и за колонной можно укрыться.
 *
 * Ряды не встают на подходы к дверям и на сквозной проход между ними — те
 * же клетки, которые бережёт обычная расстановка. Зал уже пяти клеток или
 * короче семи колонн не получает.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {{zoneId: string, assetId?: string, idPrefix?: string}} options
 * @returns {number} сколько опор поставлено
 */
export function placeColonnade(map, { zoneId, assetId = 'pillar', idPrefix = 'colonnade' }) {
  const asset = assetById(assetId)
  const cells = zoneCells(map, zoneId)
  if (!asset || cells.length < 35) return 0
  const minX = Math.min(...cells.map((cell) => cell.x))
  const maxX = Math.max(...cells.map((cell) => cell.x))
  const minY = Math.min(...cells.map((cell) => cell.y))
  const maxY = Math.max(...cells.map((cell) => cell.y))
  const horizontal = maxX - minX >= maxY - minY
  const length = (horizontal ? maxX - minX : maxY - minY) + 1
  const breadth = (horizontal ? maxY - minY : maxX - minX) + 1
  if (length < 7 || breadth < 5) return 0
  const inZone = new Set(cells.map(cellKey))
  const clear = passageClearance(map, zoneId, cells)
  /** @type {Set<string>} */
  const occupied = new Set()
  for (const prop of map.props) for (const cell of prop.footprint) occupied.add(cellKey(cell))
  // Ряды — на шаг от длинных стен; в широком зале — на два, чтобы боковые
  // нефы были проходимы для двоих.
  const inset = breadth >= 9 ? 2 : 1
  const first = (horizontal ? minY : minX) + inset
  const last = (horizontal ? maxY : maxX) - inset
  const rows = [first, last]
  // Широкий неф (от 15 клеток) делится ещё рядами: между двумя крайними рядами
  // посредине зала иначе остаётся голое поле шириной в десяток клеток.
  if (breadth >= 15) {
    const inner = Math.ceil((last - first) / 7) - 1
    for (let index = 1; index <= inner; index += 1) rows.push(Math.round(first + (last - first) * index / (inner + 1)))
  }
  let placed = 0
  for (const row of rows) {
    for (let along = (horizontal ? minX : minY) + 1; along <= (horizontal ? maxX : maxY) - 1; along += 2) {
      const cell = horizontal ? { x: along, y: row } : { x: row, y: along }
      const key = cellKey(cell)
      if (!inZone.has(key) || clear.has(key) || occupied.has(key)) continue
      // Колонна не встаёт вплотную к проходу — иначе дверной проём сужается.
      const touchesClear = ACCESS_DIRECTIONS.some(([dx, dy]) => clear.has(cellKey({ x: cell.x + dx, y: cell.y + dy })))
      if (touchesClear) continue
      addProp(map, {
        id: `${idPrefix}-${zoneId}-${placed + 1}`,
        assetId: asset.id,
        x: cell.x + 0.5,
        y: cell.y + 0.5,
        rotation: 0,
        scale: 1,
        footprint: [cell],
        zOrder: 0,
        blocksMove: asset.blocksMove,
        blocksSight: asset.blocksSight,
        cover: asset.cover,
        destructible: asset.destructible,
        hp: asset.hp,
        interactive: asset.interactive,
      })
      occupied.add(key)
      placed += 1
    }
  }
  return placed
}

/**
 * Утварь набора детализации: без опоры она не ставится вовсе. Прежняя утварь
 * (`TABLEWARE` ниже) без опоры по-старому остаётся на полу.
 */
const NEW_TABLEWARE = new Set([
  'cutlery_set', 'book_piles', 'arcane_coil', 'alchemy_bottles', 'desk_candlestick', 'single_book',
  'ceremonial_chalice', 'book_row', 'scroll_pile', 'key_bundle', 'coin_pouch',
])
const TABLEWARE = new Set(['mug', 'plate', 'bowl_stew', 'bottle', 'jug', 'bread_loaf', 'cheese_wheel', 'candle', 'dice_cup', 'coin_pile', 'cutting_board', 'offering_bowl', ...NEW_TABLEWARE])
// Опоры — столы с ровной столешницей. У рецептов стиля с вещами сверху она
// помечена `surface-top`, и 3D ставит утварь на столешницу, а не на макушку
// свечи. Алхимический стол сюда не входит: его колбы и весы — часть модели.
const SURFACES = new Set([
  'table_round', 'table_long', 'table_royal', 'table_small', 'bar_counter', 'night_table', 'altar',
  'writing_desk', 'map_table', 'war_table', 'offering_table', 'shop_counter', 'prep_table', 'jailer_desk',
])
const WALL_MOUNTS = new Set(['torch_wall', 'lantern_wall', 'banner', 'arch_shelf', 'tool_peg_rack', 'shield_display', 'weapon_rack', 'vial_display_shelf', 'wall_ivy', 'wall_ivy_corner', 'wall_ivy_wide'])
const SURFACE_SLOTS = [[-.2, -.2], [.2, .2], [-.2, .2], [.2, -.2], [0, 0], [0, -.25], [0, .25], [.25, 0]]

/**
 * Завершает только новую расстановку. Мелочь без игровой площади получает
 * явную опору; сохранённые карты на чтении не переоформляются. После поломки
 * опоры рендер опускает утварь на пол, не создавая добычи или нового укрытия.
 * @param {import('./tactical-map.mjs').TacticalMap} map
 */
export function attachPropSupports(map) {
  const surfaces = map.props.filter((prop) => SURFACES.has(prop.assetId) && prop.footprint.length && !['toppled', 'broken', 'burned'].includes(prop.state))
    .map((prop) => {
      const minX = Math.min(...prop.footprint.map((cell) => cell.x)), maxX = Math.max(...prop.footprint.map((cell) => cell.x)) + 1
      const minY = Math.min(...prop.footprint.map((cell) => cell.y)), maxY = Math.max(...prop.footprint.map((cell) => cell.y)) + 1
      return { prop, x: (minX + maxX) / 2, y: (minY + maxY) / 2, width: maxX - minX, depth: maxY - minY,
        zone: cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone }
    })
  /** @type {Map<string, number>} */
  const used = new Map()
  /** @type {Set<string>} */
  const discard = new Set()
  for (const prop of map.props) if (prop.mount?.kind === 'surface') used.set(prop.mount.propId, (used.get(prop.mount.propId) ?? 0) + 1)
  for (const prop of map.props) {
    if (prop.mount) continue
    if (WALL_MOUNTS.has(prop.assetId)) {
      const sides = wallSidesAt(map, Math.floor(prop.x), Math.floor(prop.y))
      const side = sides.find((candidate) => candidate.facing === prop.rotation) ?? sides[0]
      if (side) prop.mount = { kind: 'wall', side: side.dy < 0 ? 'n' : side.dx > 0 ? 'e' : side.dy > 0 ? 's' : 'w' }
      continue
    }
    if (!TABLEWARE.has(prop.assetId) || prop.footprint.length || prop.interactive || prop.blocksMove || prop.blocksSight) continue
    const zone = cellAt(map, Math.floor(prop.x), Math.floor(prop.y))?.zone
    const candidates = surfaces.filter((surface) => surface.zone === zone
      && Math.max(Math.abs(surface.x - prop.x), Math.abs(surface.y - prop.y)) <= 4
      && (used.get(surface.prop.id) ?? 0) < Math.min(SURFACE_SLOTS.length, Math.max(2, surface.prop.footprint.length * 2)))
    candidates.sort((a, b) => Math.hypot(a.x - prop.x, a.y - prop.y) - Math.hypot(b.x - prop.x, b.y - prop.y) || a.prop.id.localeCompare(b.prop.id))
    const surface = candidates[0]
    if (!surface) {
      // Новая мелкая утварь не должна тихо падать на пол: без опоры её
      // присутствие нарушает смысл 0×0 surface-пропа. Старые виды сохраняют
      // прежнее совместимое поведение.
      if (NEW_TABLEWARE.has(prop.assetId)) discard.add(prop.id)
      continue
    }
    const slot = used.get(surface.prop.id) ?? 0
    const [dx, dy] = SURFACE_SLOTS[slot]
    prop.x = Number((surface.x + dx * surface.width * surface.prop.scale).toFixed(3))
    prop.y = Number((surface.y + dy * surface.depth * surface.prop.scale).toFixed(3))
    prop.zOrder = Math.max(prop.zOrder, surface.prop.zOrder + 1)
    prop.mount = { kind: 'surface', propId: surface.prop.id }
    used.set(surface.prop.id, slot + 1)
  }
  if (discard.size) map.props = map.props.filter((prop) => !discard.has(prop.id))
  return map
}

/**
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {string} zoneId
 * @returns {Array<{x: number, y: number}>}
 */
function zoneCells(map, zoneId) {
  /** @type {Array<{x: number, y: number}>} */
  const cells = []
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const cell = cellAt(map, x, y)
      if (cell && cell.passable && cell.zone === zoneId) cells.push({ x, y })
    }
  }
  return cells
}

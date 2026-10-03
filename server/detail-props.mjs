// @ts-check

/**
 * Предметы набора детализации карт (`public/assets/maps/detail-v1`): штамп
 * для доски и, у части, авторская GLB-модель. Здесь — только игровая сторона:
 * какую клетку предмет занимает, держит ли шаг и взгляд, даёт ли укрытие и в
 * каких помещениях он уместен.
 *
 * Темы — не темы сцены, а назначения комнат: `forge`, `kitchen`, `prison`…
 * Расстановка берёт их только там, где назначение их зовёт
 * (`SEMANTIC_PROFILES` в `prop-placement.mjs`), поэтому дыба не появится в
 * трактире случайным добором. Исключение — `temple` и уличная природа: эти
 * предметы входят в прежние темы храма и леса.
 *
 * `alias` — ближайший прежний предмет. Его векторный рисунок и процедурная
 * модель служат запасным видом, пока штамп или GLB не загружены, и на доске
 * без фактур (решение Р6). Клиентский двойник таблицы — `src/detail-props.ts`;
 * их согласие держит `test/detail-props.test.mjs`.
 *
 * Все предметы набора неинтерактивны: справочник опасностей и каталог
 * взаимодействий о них не знают (сторож `test/scene-hazards.test.mjs`).
 */

/**
 * @typedef {object} DetailProp
 * @property {string} id
 * @property {string[]} themes
 * @property {{w: number, h: number}} footprint пустой (0×0) — плоский штамп без клетки
 * @property {'center'|'wall'|'corner'} anchor
 * @property {'prop'|'decal'} kind
 * @property {boolean} blocksMove
 * @property {boolean} blocksSight
 * @property {'none'|'half'|'three_quarters'} cover
 * @property {string} alias прежний предмет с вектором и процедурной моделью
 * @property {{min: number, max: number}} scaleRange
 */

const TEMPLE = ['temple']
const WILD = ['forest', 'road', 'settlement', 'exterior', 'graveyard']

/**
 * Короткая запись: `id, темы, Ш×Г, флаги, псевдоним`. Флаги: `m` — держит шаг,
 * `s` — заслоняет взгляд (укрытие три четверти), `c` — даёт половинное
 * укрытие, `w` — к стене, `k` — в угол, `d` — плоский штамп на полу.
 *
 * @param {string} id
 * @param {string[]} themes
 * @param {string} size `2x1`; `0x0` — без клетки
 * @param {string} flags
 * @param {string} alias
 * @param {{min: number, max: number}} [scaleRange]
 * @returns {DetailProp}
 */
function detail(id, themes, size, flags, alias, scaleRange = { min: 0.92, max: 1.06 }) {
  const [w, h] = size.split('x').map(Number)
  const decal = flags.includes('d')
  const blocksSight = flags.includes('s')
  return {
    id,
    themes,
    footprint: { w, h },
    anchor: flags.includes('w') ? 'wall' : flags.includes('k') ? 'corner' : 'center',
    kind: decal ? 'decal' : 'prop',
    blocksMove: flags.includes('m'),
    blocksSight,
    cover: blocksSight ? 'three_quarters' : flags.includes('c') ? 'half' : 'none',
    alias,
    scaleRange,
  }
}

export const DETAIL_PROPS = Object.freeze([
  // --- Кузня и мастерская ------------------------------------------------
  detail('forge', ['forge'], '2x2', 'mswc', 'fireplace'),
  detail('anvil', ['forge'], '1x1', 'mc', 'milestone'),
  detail('quench_tub', ['forge'], '1x1', 'mc', 'bucket'),
  detail('coal_pile', ['forge'], '1x1', 'wc', 'rubble_heap'),
  detail('grindstone', ['forge', 'workshop'], '1x1', 'mc', 'wagon_wheel'),
  detail('tool_rack', ['forge', 'workshop'], '2x1', 'mw', 'shelf_wall'),
  detail('workbench', ['forge', 'workshop'], '2x1', 'mcw', 'table_long'),
  detail('sawhorse', ['workshop', 'farm'], '2x1', 'm', 'bench'),
  detail('lumber_pile', ['workshop', 'farm'], '2x1', 'mcw', 'woodpile'),
  detail('sawdust', ['workshop'], '0x0', 'd', 'floor_stain'),

  // --- Кухня -------------------------------------------------------------
  detail('kitchen_stove', ['kitchen'], '2x1', 'mcw', 'fireplace'),
  detail('bread_oven', ['kitchen'], '2x2', 'mswk', 'fireplace'),
  detail('butcher_block', ['kitchen'], '1x1', 'mc', 'table_small'),
  detail('prep_table', ['kitchen'], '2x1', 'mc', 'table_long'),
  detail('pantry_shelf', ['kitchen'], '2x1', 'msw', 'cupboard'),
  detail('hanging_pots', ['kitchen'], '2x1', 'w', 'shelf_wall'),
  detail('spice_crates', ['kitchen', 'shop'], '1x1', 'mcw', 'crate'),
  detail('washtub', ['kitchen'], '1x1', 'mw', 'bucket'),
  detail('water_barrel', ['kitchen', 'barracks'], '1x1', 'mcw', 'barrel'),
  detail('flour_spill', ['kitchen', 'farm'], '0x0', 'd', 'floor_stain'),

  // --- Спальня и кабинет -------------------------------------------------
  detail('double_bed', ['bedroom'], '2x2', 'mcw', 'bed'),
  detail('dresser', ['bedroom'], '2x1', 'mcw', 'cupboard'),
  detail('armchair', ['bedroom', 'study'], '1x1', 'm', 'chair'),
  detail('bathtub', ['bedroom'], '2x1', 'mcw', 'water_trough'),
  detail('coat_rack', ['bedroom'], '1x1', 'mk', 'broom'),
  detail('cradle', ['bedroom'], '1x1', 'm', 'chest'),
  detail('folding_screen', ['bedroom'], '2x1', 'ms', 'village_fence'),
  detail('standing_mirror', ['bedroom'], '1x1', 'mw', 'sign_board'),
  detail('writing_desk', ['bedroom', 'study'], '2x1', 'mcw', 'table_small'),
  detail('candle_desk', ['study'], '2x1', 'mcw', 'table_small'),
  detail('bookcase_tall', ['study'], '2x1', 'msw', 'bookshelf'),
  detail('scroll_rack', ['study'], '2x1', 'msw', 'bookshelf'),
  detail('book_lectern', ['study', 'temple'], '1x1', 'm', 'reliquary'),
  detail('globe', ['study'], '1x1', 'm', 'urn'),
  detail('map_table', ['study', 'barracks'], '2x2', 'mc', 'table_round'),
  detail('reading_nook', ['study'], '2x1', 'mw', 'bench'),
  detail('strongbox', ['study', 'prison'], '1x1', 'mcw', 'chest'),
  detail('telescope', ['study'], '1x1', 'm', 'signpost'),
  detail('paper_scatter', ['study'], '0x0', 'd', 'floor_stain'),

  // --- Ковры и шкуры -----------------------------------------------------
  detail('rug_blue', ['bedroom', 'study'], '0x0', 'd', 'rug'),
  detail('rug_round', ['bedroom', 'study'], '0x0', 'd', 'rug'),
  detail('rug_red_large', ['hall', 'study'], '0x0', 'd', 'rug', { min: 1.1, max: 1.25 }),
  detail('rug_runner', ['hall', 'temple'], '0x0', 'd', 'rug'),
  detail('bear_pelt', ['bedroom', 'hall'], '0x0', 'd', 'rug'),
  detail('hide_rug', ['bedroom', 'hall'], '0x0', 'd', 'rug'),
  detail('wolf_pelt', ['bedroom', 'barracks'], '0x0', 'd', 'rug'),
  detail('prayer_rug', ['temple'], '0x0', 'd', 'rug'),
  detail('straw_mat', ['prison', 'barracks'], '0x0', 'd', 'rug'),

  // --- Казарма -----------------------------------------------------------
  detail('barracks_bed', ['barracks'], '1x2', 'mcw', 'bed'),
  detail('footlocker', ['barracks', 'prison'], '1x1', 'mcw', 'chest'),
  detail('armor_stand', ['barracks'], '1x1', 'mw', 'statue'),
  detail('weapon_rack_wall', ['barracks', 'prison'], '2x1', 'w', 'shelf_wall'),
  detail('training_dummy', ['barracks'], '1x1', 'm', 'statue'),
  detail('archery_target', ['barracks'], '1x1', 'mw', 'sign_board'),
  detail('ammo_crates', ['barracks'], '2x1', 'mcw', 'crate_stack'),
  detail('war_table', ['barracks'], '2x2', 'mc', 'table_round'),
  detail('guard_brazier', ['barracks', 'prison'], '1x1', 'm', 'brazier'),

  // --- Темница -----------------------------------------------------------
  detail('straw_bed', ['prison'], '1x2', 'w', 'bed'),
  detail('cell_bucket', ['prison'], '1x1', 'k', 'bucket'),
  detail('wall_chains', ['prison'], '1x1', 'w', 'shelf_wall'),
  detail('iron_cage', ['prison'], '1x1', 'mck', 'crate'),
  detail('jailer_desk', ['prison'], '1x1', 'mc', 'table_small'),
  detail('torture_rack', ['prison'], '2x1', 'mc', 'table_long'),
  detail('stocks', ['prison', 'street'], '2x1', 'mc', 'village_fence'),
  detail('bone_heap', ['prison'], '0x0', '', 'bone_pile'),
  detail('drain_grate', ['prison'], '0x0', 'd', 'path_stone'),
  detail('straw_scatter', ['prison', 'farm'], '0x0', 'd', 'floor_stain'),
  detail('scorch_mark', ['prison', 'forge'], '0x0', 'd', 'floor_stain'),

  // --- Храм --------------------------------------------------------------
  detail('idol', TEMPLE, '2x2', 'msw', 'statue'),
  detail('holy_pool', TEMPLE, '2x2', 'm', 'cave_pool'),
  detail('font_basin', TEMPLE, '1x1', 'mc', 'washbasin'),
  detail('incense_burner', TEMPLE, '1x1', 'm', 'brazier'),
  detail('kneeling_cushions', TEMPLE, '2x1', '', 'prayer_bench'),
  detail('candle_rack', TEMPLE, '2x1', 'mw', 'candelabra'),
  detail('offering_table', TEMPLE, '2x1', 'mcw', 'altar'),
  detail('temple_lectern', TEMPLE, '1x1', 'm', 'reliquary'),
  detail('bell_frame', TEMPLE, '2x1', 'm', 'roadside_shrine'),

  // --- Лавка -------------------------------------------------------------
  detail('shop_counter', ['shop'], '3x1', 'mc', 'bar_counter'),
  detail('display_shelf', ['shop'], '2x1', 'msw', 'bookshelf'),
  detail('scales_table', ['shop'], '1x1', 'mc', 'table_small'),
  detail('cloth_bolts', ['shop'], '1x1', 'mcw', 'basket'),
  detail('goods_baskets', ['shop', 'street'], '1x1', 'mw', 'basket'),
  detail('pottery_stand', ['shop', 'street'], '1x1', 'mcw', 'urn'),
  detail('grain_sacks', ['shop', 'farm'], '1x1', 'mcw', 'sack'),
  detail('crate_stack_goods', ['shop', 'street'], '2x2', 'mswk', 'crate_stack'),

  // --- Двор, мельница, огород --------------------------------------------
  detail('hay_bales', ['farm'], '2x1', 'mcw', 'haystack'),
  detail('chicken_coop', ['farm'], '2x1', 'mcw', 'crate_stack'),
  detail('garden_bed', ['farm'], '2x1', '', 'flowers'),
  detail('scarecrow', ['farm'], '1x1', 'm', 'signpost'),
  detail('rain_barrel', ['farm', 'street'], '1x1', 'mcw', 'barrel'),
  detail('flour_bin', ['farm'], '1x1', 'mcw', 'chest'),
  detail('millstone', ['farm'], '2x2', 'mc', 'wagon_wheel'),
  detail('water_wheel', ['farm'], '1x3', 'msw', 'wagon_wheel'),
  detail('fence_gate', ['farm'], '1x1', 'm', 'village_fence'),
  detail('flower_bed', ['farm', 'street'], '2x1', '', 'flowers'),

  // --- Улица и площадь ---------------------------------------------------
  detail('fountain', ['street'], '3x3', 'mc', 'well'),
  detail('town_well', ['street'], '2x2', 'mc', 'well'),
  detail('market_awning', ['street'], '3x2', 'mc', 'market_stall'),
  detail('fruit_cart', ['street'], '2x1', 'mc', 'cart'),
  detail('notice_board', ['street'], '1x1', 'm', 'sign_board'),
  detail('sign_post_city', ['street'], '1x1', 'm', 'signpost'),
  detail('pillory', ['street'], '2x1', 'mc', 'village_fence'),
  detail('statue_plinth', ['street', 'temple'], '2x2', 'ms', 'statue'),
  detail('street_planter', ['street'], '1x1', 'mc', 'bush'),

  // --- Река и пристань ---------------------------------------------------
  detail('mooring_post', ['harbor'], '1x1', 'm', 'hitching_post'),
  detail('fish_rack', ['harbor'], '2x1', 'mw', 'village_fence'),
  detail('fishing_nets', ['harbor'], '2x1', 'w', 'village_fence'),
  detail('rowboat', ['harbor'], '1x3', 'mc', 'fallen_log'),
  detail('punt', ['harbor'], '1x3', 'mc', 'fallen_log'),
  detail('stone_steps', ['harbor'], '2x1', '', 'path_stone'),
  detail('reeds', ['harbor'], '0x0', 'd', 'grass_tuft'),
  detail('river_rocks', ['harbor'], '0x0', 'd', 'path_stone'),
  detail('lily_pads', ['harbor'], '0x0', 'd', 'flowers'),

  // --- Дикая природа и скалы ---------------------------------------------
  detail('mossy_rock', WILD, '1x1', 'mc', 'boulder'),
  detail('rock_cluster', WILD, '2x2', 'ms', 'boulder'),
  detail('boulder_split', WILD, '2x2', 'ms', 'boulder'),
  detail('dead_bramble', WILD, '1x1', 'c', 'bush'),
  detail('root_tangle', WILD, '2x1', 'c', 'fallen_log'),
  detail('scree', WILD, '0x0', 'd', 'path_stone'),
  detail('pebbles', WILD, '0x0', 'd', 'path_stone'),
  detail('leaf_litter', WILD, '0x0', 'd', 'fern'),
  detail('cliff_medium', ['cliff'], '2x2', 'ms', 'boulder'),
  detail('cliff_large', ['cliff'], '3x3', 'ms', 'boulder'),
  detail('cliff_long', ['cliff'], '3x1', 'ms', 'boulder'),

  // --- Следы на полу -----------------------------------------------------
  detail('wine_stain', ['hall'], '0x0', 'd', 'floor_stain'),
  detail('floor_crack', ['prison', 'hall'], '0x0', 'd', 'floor_stain'),

  // --- Расширение реквизита PR104 и наборов Quaternius -------------------
  // Эти виды только оформляют сцену: интерактивность и игровые состояния
  // для них намеренно отсутствуют. Большие объекты получают footprint здесь,
  // а не из GLB, чтобы 2D и 3D занимали одну и ту же площадь.
  detail('ballista', ['barracks', 'workshop', 'siege'], '2x2', 'mc', 'village_fence'),
  detail('command_tent', ['barracks', 'camp'], '2x2', 'mc', 'haystack'),
  detail('alchemy_table', ['study', 'kitchen', 'workshop'], '2x1', 'mc', 'table_long'),
  detail('dock_crane', ['harbor'], '2x2', 'm', 'well'),
  detail('mine_cart', ['mine', 'cave', 'dungeon'], '1x1', 'mc', 'cart'),
  detail('crystal_orb', ['study', 'temple'], '1x1', 'mc', 'offering_bowl', { min: .7, max: 1.1 }),
  detail('giant_fungus', ['cave', 'forest', 'graveyard', 'swamp'], '2x2', 'mc', 'mushroom_cluster', { min: .7, max: 1.3 }),
  detail('mantlet', ['barracks', 'siege'], '2x1', 'm', 'village_fence'),
  detail('cargo_sled', ['winter'], '2x1', 'mc', 'cart'),
  // Низкая полка (модель ~0,7 клетки): держит шаг, но взгляд поверх неё виден.
  detail('arch_shelf', ['study', 'shop', 'temple'], '2x1', 'mw', 'shelf_wall'),
  detail('cutlery_set', ['kitchen', 'hall', 'study'], '0x0', '', 'plate', { min: 1.2, max: 1.8 }),
  detail('tool_peg_rack', ['forge', 'workshop', 'barracks'], '2x1', 'w', 'shelf_wall'),
  detail('chain_coil', ['forge', 'workshop', 'prison', 'mine'], '0x0', '', 'rubble_heap'),
  detail('book_piles', ['study', 'bedroom', 'temple'], '0x0', '', 'mug', { min: .9, max: 1.4 }),
  detail('crystal_cluster', ['cave', 'mine', 'dungeon'], '1x1', 'mc', 'boulder', { min: .8, max: 1.25 }),
  detail('nomad_tent', ['desert', 'camp'], '2x2', 'mc', 'haystack'),
  detail('obsidian_monolith', ['cave', 'dungeon', 'graveyard', 'temple'], '1x1', 'msc', 'pillar'),
  detail('weapon_rack', ['barracks', 'workshop', 'prison'], '2x1', 'w', 'shelf_wall'),
  detail('scout_tent', ['camp', 'barracks'], '2x2', 'mc', 'haystack'),
  detail('timber_shoring', ['mine', 'cave', 'dungeon'], '2x1', 'w', 'village_fence'),
  detail('mine_rail', ['mine', 'cave'], '0x0', 'd', 'path_stone'),
  detail('shield_display', ['barracks', 'workshop', 'study', 'temple'], '0x0', 'w', 'shelf_wall'),
  detail('arcane_coil', ['study', 'forge', 'workshop'], '0x0', '', 'offering_bowl', { min: .8, max: 1.2 }),
  detail('alchemy_bottles', ['study', 'shop', 'kitchen'], '0x0', '', 'bottle', { min: .9, max: 1.3 }),
  detail('desk_candlestick', ['study', 'temple', 'hall'], '0x0', '', 'candle', { min: .8, max: 1.2 }),
  detail('single_book', ['study', 'temple'], '0x0', '', 'mug', { min: 1.1, max: 1.7 }),
  // Настенная полочка с флаконами, как и её двойник shelf_wall, прохода не держит.
  detail('vial_display_shelf', ['study', 'shop', 'kitchen'], '2x1', 'w', 'shelf_wall'),
  detail('ceremonial_chalice', ['temple', 'study'], '0x0', '', 'offering_bowl', { min: .9, max: 1.4 }),
  detail('book_row', ['study', 'temple'], '0x0', '', 'mug', { min: .9, max: 1.3 }),
  detail('scroll_pile', ['study', 'temple'], '0x0', '', 'mug', { min: 1.1, max: 1.7 }),
  detail('rope_coils', ['harbor', 'workshop'], '0x0', '', 'woodpile'),
  detail('capstan', ['harbor'], '1x1', 'mc', 'well'),
  detail('snowshoe_pair', ['winter'], '0x0', '', 'mug'),
  detail('anchor', ['harbor'], '1x1', 'm', 'milestone'),
  detail('clover_patch', ['forest', 'road', 'settlement', 'exterior', 'graveyard'], '0x0', 'd', 'flowers'),
  detail('forest_plant', ['forest', 'road', 'settlement', 'exterior', 'graveyard'], '0x0', 'd', 'fern'),
  detail('mangrove_roots', ['swamp', 'forest', 'exterior'], '2x2', 'c', 'fallen_log'),
  detail('wall_ivy', ['settlement', 'exterior', 'graveyard', 'crypt'], '0x0', 'dw', 'cobweb'),
  detail('wall_ivy_corner', ['settlement', 'exterior', 'graveyard', 'crypt'], '0x0', 'dk', 'cobweb'),
  detail('wall_ivy_wide', ['settlement', 'exterior', 'graveyard', 'crypt'], '0x0', 'dw', 'cobweb'),
  detail('key_bundle', ['study', 'shop', 'prison'], '0x0', '', 'mug', { min: 1.4, max: 2.2 }),
  detail('coin_pouch', ['study', 'shop', 'hall'], '0x0', '', 'coin_pile', { min: .8, max: 1.3 }),

  // --- Подготовленные штампы, получившие модели стиля (2026-10-04) --------
  // 2D — прежний штамп набора, 3D — рецепт `tools/map-detail-models-frontier.mjs`
  // в пакете стиля. Только оформление: лёд не скользит, вода в луже не мочит,
  // клетка и шипы не ранят — для этого нужны отдельные правила.
  // Зима.
  detail('snowdrift', ['winter'], '0x0', 'd', 'floor_stain'),
  detail('snowy_boulder', ['winter'], '1x1', 'mc', 'boulder'),
  detail('ice_pillars', ['winter'], '1x1', 'mc', 'stalagmite'),
  detail('frozen_pool', ['winter'], '1x1', '', 'cave_pool'),
  detail('winter_cache', ['winter', 'camp'], '1x1', 'mc', 'crate'),
  detail('snow_cairn', ['winter'], '1x1', 'mc', 'milestone'),
  // Пустыня.
  detail('sand_dune', ['desert'], '0x0', 'd', 'floor_stain'),
  detail('desert_boulders', ['desert'], '1x1', 'mc', 'boulder'),
  detail('cactus_cluster', ['desert'], '1x1', 'mc', 'bush'),
  detail('dead_scrub', ['desert'], '1x1', 'c', 'bush'),
  detail('oasis_pool', ['desert'], '1x1', '', 'cave_pool'),
  detail('broken_obelisk', ['desert'], '1x1', 'mc', 'pillar'),
  // Болото.
  detail('bog_pool', ['swamp'], '1x1', '', 'cave_pool'),
  detail('lily_pad_cluster', ['swamp'], '0x0', 'd', 'fern'),
  detail('reed_cluster', ['swamp'], '1x1', 'c', 'grass_tuft'),
  detail('rotten_log', ['swamp'], '2x1', 'mc', 'fallen_log'),
  detail('mud_patch', ['swamp'], '0x0', 'd', 'floor_stain'),
  detail('swamp_totem', ['swamp'], '1x1', 'm', 'signpost'),
  detail('peat_mound', ['swamp'], '1x1', 'c', 'rubble_heap'),
  // Гавань.
  detail('mooring_bollard', ['harbor'], '1x1', 'mc', 'hitching_post'),
  detail('cargo_net', ['harbor'], '1x1', 'mc', 'sack'),
  detail('fishing_crates', ['harbor'], '1x1', 'mc', 'crate'),
  detail('lobster_cage', ['harbor'], '1x1', 'mc', 'basket'),
  detail('sail_bundle', ['harbor'], '0x0', '', 'woodpile'),
  // Военный лагерь.
  detail('bedroll_cluster', ['camp', 'barracks'], '0x0', '', 'sack'),
  detail('shield_rack', ['camp', 'barracks'], '1x1', 'mc', 'shelf_wall'),
  detail('camp_dummy', ['camp', 'barracks'], '1x1', 'm', 'statue'),
  detail('spiked_beam_barrier', ['camp', 'siege'], '1x1', 'mc', 'village_fence'),
  // Лаборатория мага.
  detail('alchemy_cauldron', ['arcane'], '1x1', 'mc', 'cauldron'),
  detail('arcane_lectern', ['arcane'], '1x1', 'm', 'reliquary'),
  detail('ritual_circle', ['arcane'], '0x0', 'd', 'mosaic'),
  detail('arcane_stone', ['arcane'], '1x1', '', 'mosaic'),
  detail('potion_cabinet', ['arcane'], '1x1', 'msw', 'cupboard'),
  detail('magic_mirror', ['arcane'], '1x1', 'mw', 'cupboard'),
  // Темница.
  detail('prison_cage', ['prison'], '1x1', 'mc', 'crate'),
  detail('dungeon_rack', ['prison'], '2x1', 'mc', 'table_long'),
  detail('iron_maiden', ['prison'], '1x1', 'msw', 'wardrobe'),
  detail('manacle_post', ['prison'], '1x1', 'mc', 'pillar'),
])

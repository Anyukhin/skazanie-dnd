/**
 * Клиентский двойник `server/detail-props.mjs`: предметы набора детализации
 * карт (`public/assets/maps/detail-v1`). Сервер решает, где предмет стоит и
 * что держит; здесь — только как его нарисовать.
 *
 * `DETAIL_PROP_ALIASES` — прежний предмет, чей вектор и процедурная модель
 * служат запасным видом, пока штамп и GLB не загружены, и на доске без фактур.
 * Согласие с сервером держит `test/detail-props.test.mjs`.
 */
export const DETAIL_PROP_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  forge: 'fireplace', anvil: 'milestone', quench_tub: 'bucket', coal_pile: 'rubble_heap', grindstone: 'wagon_wheel',
  tool_rack: 'shelf_wall', workbench: 'table_long', sawhorse: 'bench', lumber_pile: 'woodpile', sawdust: 'floor_stain',
  kitchen_stove: 'fireplace', bread_oven: 'fireplace', butcher_block: 'table_small', prep_table: 'table_long', pantry_shelf: 'cupboard',
  hanging_pots: 'shelf_wall', spice_crates: 'crate', washtub: 'bucket', water_barrel: 'barrel', flour_spill: 'floor_stain',
  double_bed: 'bed', dresser: 'cupboard', armchair: 'chair', bathtub: 'water_trough', coat_rack: 'broom',
  cradle: 'chest', folding_screen: 'village_fence', standing_mirror: 'sign_board', writing_desk: 'table_small', candle_desk: 'table_small',
  bookcase_tall: 'bookshelf', scroll_rack: 'bookshelf', book_lectern: 'reliquary', globe: 'urn', map_table: 'table_round',
  reading_nook: 'bench', strongbox: 'chest', telescope: 'signpost', paper_scatter: 'floor_stain', rug_blue: 'rug',
  rug_round: 'rug', rug_red_large: 'rug', rug_runner: 'rug', bear_pelt: 'rug', hide_rug: 'rug',
  wolf_pelt: 'rug', prayer_rug: 'rug', straw_mat: 'rug', barracks_bed: 'bed', footlocker: 'chest',
  armor_stand: 'statue', weapon_rack_wall: 'shelf_wall', training_dummy: 'statue', archery_target: 'sign_board', ammo_crates: 'crate_stack',
  war_table: 'table_round', guard_brazier: 'brazier', straw_bed: 'bed', cell_bucket: 'bucket', wall_chains: 'shelf_wall',
  iron_cage: 'crate', jailer_desk: 'table_small', torture_rack: 'table_long', stocks: 'village_fence', bone_heap: 'bone_pile',
  drain_grate: 'path_stone', straw_scatter: 'floor_stain', scorch_mark: 'floor_stain', idol: 'statue', holy_pool: 'cave_pool',
  font_basin: 'washbasin', incense_burner: 'brazier', kneeling_cushions: 'prayer_bench', candle_rack: 'candelabra', offering_table: 'altar',
  temple_lectern: 'reliquary', bell_frame: 'roadside_shrine', shop_counter: 'bar_counter', display_shelf: 'bookshelf', scales_table: 'table_small',
  cloth_bolts: 'basket', goods_baskets: 'basket', pottery_stand: 'urn', grain_sacks: 'sack', crate_stack_goods: 'crate_stack',
  hay_bales: 'haystack', chicken_coop: 'crate_stack', garden_bed: 'flowers', scarecrow: 'signpost', rain_barrel: 'barrel',
  flour_bin: 'chest', millstone: 'wagon_wheel', water_wheel: 'wagon_wheel', fence_gate: 'village_fence', flower_bed: 'flowers',
  fountain: 'well', town_well: 'well', market_awning: 'market_stall', fruit_cart: 'cart', notice_board: 'sign_board',
  sign_post_city: 'signpost', pillory: 'village_fence', statue_plinth: 'statue', street_planter: 'bush', mooring_post: 'hitching_post',
  fish_rack: 'village_fence', fishing_nets: 'village_fence', rowboat: 'fallen_log', punt: 'fallen_log', stone_steps: 'path_stone',
  reeds: 'grass_tuft', river_rocks: 'path_stone', lily_pads: 'flowers', mossy_rock: 'boulder', rock_cluster: 'boulder',
  boulder_split: 'boulder', dead_bramble: 'bush', root_tangle: 'fallen_log', scree: 'path_stone', pebbles: 'path_stone',
  leaf_litter: 'fern', cliff_medium: 'boulder', cliff_large: 'boulder', cliff_long: 'boulder', wine_stain: 'floor_stain',
  floor_crack: 'floor_stain',
  ballista: 'village_fence', command_tent: 'haystack', alchemy_table: 'table_long', dock_crane: 'well',
  mine_cart: 'cart', crystal_orb: 'offering_bowl', giant_fungus: 'mushroom_cluster',
  mantlet: 'village_fence', cargo_sled: 'cart', arch_shelf: 'shelf_wall', cutlery_set: 'plate',
  tool_peg_rack: 'shelf_wall', chain_coil: 'rubble_heap', book_piles: 'mug', crystal_cluster: 'boulder',
  nomad_tent: 'haystack', obsidian_monolith: 'pillar', weapon_rack: 'shelf_wall', scout_tent: 'haystack',
  timber_shoring: 'village_fence', mine_rail: 'path_stone', shield_display: 'shelf_wall', arcane_coil: 'offering_bowl',
  alchemy_bottles: 'bottle', desk_candlestick: 'candle', single_book: 'mug', vial_display_shelf: 'shelf_wall',
  ceremonial_chalice: 'offering_bowl', book_row: 'mug', scroll_pile: 'mug', rope_coils: 'woodpile', capstan: 'well',
  snowshoe_pair: 'mug', anchor: 'milestone', clover_patch: 'flowers', forest_plant: 'fern', mangrove_roots: 'fallen_log',
  wall_ivy: 'cobweb', wall_ivy_corner: 'cobweb', wall_ivy_wide: 'cobweb', key_bundle: 'mug', coin_pouch: 'coin_pile',
  snowdrift: 'floor_stain', snowy_boulder: 'boulder', ice_pillars: 'stalagmite', frozen_pool: 'cave_pool',
  winter_cache: 'crate', snow_cairn: 'milestone', sand_dune: 'floor_stain', desert_boulders: 'boulder',
  cactus_cluster: 'bush', dead_scrub: 'bush', oasis_pool: 'cave_pool', broken_obelisk: 'pillar',
  bog_pool: 'cave_pool', lily_pad_cluster: 'fern', reed_cluster: 'grass_tuft', rotten_log: 'fallen_log',
  mud_patch: 'floor_stain', swamp_totem: 'signpost', peat_mound: 'rubble_heap', mooring_bollard: 'hitching_post',
  cargo_net: 'sack', fishing_crates: 'crate', lobster_cage: 'basket', sail_bundle: 'woodpile',
  bedroll_cluster: 'sack', shield_rack: 'shelf_wall', camp_dummy: 'statue', spiked_beam_barrier: 'village_fence',
  alchemy_cauldron: 'cauldron', arcane_lectern: 'reliquary', ritual_circle: 'mosaic', arcane_stone: 'mosaic',
  potion_cabinet: 'cupboard', magic_mirror: 'cupboard', prison_cage: 'crate', dungeon_rack: 'table_long',
  iron_maiden: 'wardrobe', manacle_post: 'pillar',
})

/** Предметы набора, у которых есть авторская GLB-модель (`models/<id>.glb`). */
export const DETAIL_PROP_MODELS: ReadonlySet<string> = new Set([
  'forge', 'quench_tub', 'coal_pile', 'sawhorse', 'lumber_pile', 'kitchen_stove', 'bread_oven', 'butcher_block',
  'hanging_pots', 'washtub', 'double_bed', 'dresser', 'armchair', 'bathtub', 'coat_rack', 'cradle',
  'folding_screen', 'standing_mirror', 'writing_desk', 'candle_desk', 'scroll_rack', 'globe', 'reading_nook', 'telescope',
  'armor_stand', 'archery_target', 'straw_bed', 'wall_chains', 'jailer_desk', 'torture_rack', 'stocks', 'idol',
  'holy_pool', 'font_basin', 'incense_burner', 'kneeling_cushions', 'bell_frame', 'shop_counter', 'scales_table', 'cloth_bolts',
  'hay_bales', 'chicken_coop', 'garden_bed', 'scarecrow', 'flour_bin', 'millstone', 'water_wheel', 'fence_gate',
  'flower_bed', 'fountain', 'town_well', 'market_awning', 'notice_board', 'sign_post_city', 'pillory', 'statue_plinth',
  'street_planter', 'mooring_post', 'fish_rack', 'fishing_nets', 'rowboat', 'punt', 'stone_steps', 'root_tangle',
  'ballista', 'command_tent', 'alchemy_table', 'dock_crane', 'mine_cart', 'crystal_orb', 'giant_fungus',
  'mantlet', 'cargo_sled', 'crystal_cluster', 'nomad_tent', 'obsidian_monolith', 'weapon_rack', 'scout_tent',
  'timber_shoring', 'mine_rail', 'arcane_coil', 'capstan', 'snowshoe_pair', 'anchor', 'mangrove_roots',
])

/** Корень набора внутри `public`. */
export const DETAIL_ASSET_ROOT = '/assets/maps/detail-v1/'

/** Манифест штампов набора: отдельный атлас рядом с основным. */
export const DETAIL_PROP_ATLAS_MANIFEST = `${DETAIL_ASSET_ROOT}prop-atlas.json`

/** Прежний двойник предмета набора или сам идентификатор. */
export function detailPropAlias(assetId: string): string | undefined {
  return DETAIL_PROP_ALIASES[assetId]
}

/** Путь GLB-модели предмета набора, если она есть. */
export function detailPropModelUrl(assetId: string): string | null {
  return DETAIL_PROP_MODELS.has(assetId) ? `${DETAIL_ASSET_ROOT}models/${assetId}.glb` : null
}

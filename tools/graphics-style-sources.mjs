// @ts-check
/**
 * Источники двух стилей графики 3D-доски. Только данные: сборкой занимается
 * `tools/build-graphics-styles.mjs`, клиент читает готовый манифест стиля.
 *
 * Клетка карты — 1,5 м. `cells` — сколько клеток накрывает один повтор
 * текстуры. `relief` — глубина рельефа в мировых единицах (клетка = 1).
 *
 * Образцы Poly Haven увеличены примерно втрое против физического размера:
 * камень в 10–20 см с высоты тактической камеры сливается в ровный цвет, а
 * настольные диорамы (ориентир — TaleSpire) рисуют камни крупно.
 */

/** @typedef {{ polyhaven?: string, quaternius?: string, painted?: string, cells: number, relief: number }} FloorSource */
/** @typedef {{ polyhaven: string, yaw?: number, triangles?: number }} PropSource */
/** @typedef {{ label: string, floors: Record<string, FloorSource>, props: Record<string, PropSource[]>, license: string, sources: string[] }} StyleSource */

/** @type {Readonly<Record<string, StyleSource>>} */
export const GRAPHICS_STYLE_SOURCES = Object.freeze({
  realistic: {
    label: 'Реалистичный',
    license: 'CC0 (https://polyhaven.com/license)',
    sources: ['https://polyhaven.com', 'tmp/asset-src/polyhaven/polyhaven-files.json'],
    floors: {
      stone: { polyhaven: 'stone_floor', cells: 3.7, relief: .08 },
      wood: { polyhaven: 'wood_planks', cells: 3, relief: .03 },
      earth: { polyhaven: 'dirt_floor', cells: 4, relief: .06 },
      grass: { polyhaven: 'grass_ground', cells: 4, relief: .05 },
      sand: { polyhaven: 'coast_sand_01', cells: 4, relief: .04 },
      marble: { polyhaven: 'marble_01', cells: 3, relief: .01 },
      metal: { polyhaven: 'metal_plate', cells: 2, relief: .015 },
      ice: { polyhaven: 'snow_floor', cells: 4, relief: .03 },
      'planks-dark': { polyhaven: 'dark_wooden_planks', cells: 3.5, relief: .03 },
      parquet: { polyhaven: 'herringbone_parquet', cells: 4, relief: .012 },
      flagstone: { polyhaven: 'stone_tiles', cells: 3, relief: .07 },
      checker: { polyhaven: 'checkered_pavement_tiles', cells: 3, relief: .02 },
      dungeon: { polyhaven: 'slate_floor', cells: 3.5, relief: .07 },
      cobble: { polyhaven: 'cobblestone_floor_01', cells: 3, relief: .1 },
      dock: { polyhaven: 'weathered_planks', cells: 3.5, relief: .04 },
      gravel: { polyhaven: 'gravel', cells: 4, relief: .06 },
      cave: { polyhaven: 'rocky_terrain_02', cells: 5, relief: .1 },
      snow: { polyhaven: 'snow_02', cells: 4, relief: .04 },
      mud: { polyhaven: 'brown_mud_02', cells: 3, relief: .05 },
      rubble: { polyhaven: 'rubble', cells: 3.5, relief: .1 },
    },
    // Деревья Poly Haven — фотограмметрия на сотни мегабайт; в этом стиле
    // деревья остаются из основного выпуска моделей.
    props: {
      tree_dead: [{ polyhaven: 'dead_tree_trunk', triangles: 14000 }],
      fallen_log: [{ polyhaven: 'dead_tree_trunk_02', triangles: 12000 }],
      tree_stump: [{ polyhaven: 'tree_stump_01', triangles: 8000 }],
      bush: [{ polyhaven: 'wild_rooibos_bush', triangles: 12000 }],
      shrub: [{ polyhaven: 'wild_rooibos_bush', triangles: 12000 }],
      fern: [{ polyhaven: 'fern_02' }],
      boulder: [{ polyhaven: 'rock_07', triangles: 6000 }],
      rock_small: [{ polyhaven: 'rock_07', triangles: 6000 }],
      chair: [{ polyhaven: 'gallinera_chair' }, { polyhaven: 'painted_wooden_chair_01' }],
      stool: [{ polyhaven: 'wooden_stool_01' }],
      bench: [{ polyhaven: 'painted_wooden_bench' }],
      table_long: [{ polyhaven: 'gallinera_table' }],
      table_small: [{ polyhaven: 'small_wooden_table_01' }],
      table_round: [{ polyhaven: 'round_wooden_table_01' }],
      night_table: [{ polyhaven: 'side_table_01' }],
      chest: [{ polyhaven: 'treasure_chest', triangles: 12000 }],
      crate: [{ polyhaven: 'wooden_crate_01' }],
      barrel: [{ polyhaven: 'wine_barrel_01' }, { polyhaven: 'barrel_03' }],
      bucket: [{ polyhaven: 'wooden_bucket_01' }],
      basket: [{ polyhaven: 'wicker_basket_01', triangles: 8000 }],
      chandelier: [{ polyhaven: 'lantern_chandelier_01' }],
      bed: [{ polyhaven: 'old_bed_frame', triangles: 12000 }],
      bookshelf: [{ polyhaven: 'wooden_bookshelf_worn' }],
      cupboard: [{ polyhaven: 'painted_wooden_cabinet' }],
      wardrobe: [{ polyhaven: 'vintage_cabinet_01', triangles: 12000 }],
      statue: [{ polyhaven: 'gothic_statue', triangles: 12000 }],
      lamp_post: [{ polyhaven: 'street_lamp_01', triangles: 12000 }],
      pot: [{ polyhaven: 'brass_pot_01' }],
      jug: [{ polyhaven: 'jug_01' }],
      urn: [{ polyhaven: 'antique_ceramic_vase_01' }],
    },
  },
  stylized: {
    label: 'Рисованный',
    license: 'CC0 (Quaternius Medieval Village MegaKit) и собственные текстуры проекта (data/asset-rights.json)',
    sources: ['https://quaternius.com/packs/medievalvillagemegakit.html', 'public/assets/maps/terrain/terrain-tiles.json'],
    floors: {
      stone: { painted: 'maps/terrain/floor-stone.png', cells: 4, relief: .03 },
      wood: { painted: 'maps/terrain/floor-wood.png', cells: 8, relief: .015 },
      earth: { painted: 'maps/terrain/floor-earth.png', cells: 8, relief: .025 },
      grass: { painted: 'maps/terrain/floor-grass.png', cells: 8, relief: .02 },
      sand: { painted: 'maps/terrain/floor-sand.png', cells: 8, relief: .02 },
      marble: { painted: 'maps/terrain/floor-marble.png', cells: 4, relief: .006 },
      metal: { painted: 'maps/terrain/floor-metal.png', cells: 4, relief: .01 },
      ice: { painted: 'maps/terrain/floor-ice.png', cells: 8, relief: .01 },
      'planks-dark': { painted: 'maps/detail-v1/textures/floor-planks-dark.png', cells: 8, relief: .015 },
      parquet: { painted: 'maps/detail-v1/textures/floor-parquet.png', cells: 8, relief: .008 },
      flagstone: { quaternius: 'T_UnevenBrick', cells: 3, relief: .045 },
      checker: { painted: 'maps/detail-v1/textures/floor-checker.png', cells: 8, relief: .008 },
      dungeon: { quaternius: 'T_Brick', cells: 3, relief: .04 },
      mosaic: { painted: 'maps/detail-v1/textures/floor-mosaic.png', cells: 8, relief: .008 },
      cobble: { quaternius: 'T_UnevenBrick', cells: 2.4, relief: .05 },
      straw: { painted: 'maps/detail-v1/textures/floor-straw.png', cells: 8, relief: .02 },
      dock: { painted: 'maps/detail-v1/textures/floor-dock.png', cells: 8, relief: .02 },
      gravel: { painted: 'maps/detail-v1/textures/floor-gravel.png', cells: 8, relief: .03 },
      cave: { painted: 'maps/detail-v1/textures/floor-cave.png', cells: 8, relief: .05 },
      snow: { painted: 'maps/detail-v1/textures/floor-snow.png', cells: 8, relief: .02 },
      mud: { painted: 'maps/terrain/surface-mud.png', cells: 8, relief: .02 },
      rubble: { painted: 'maps/terrain/surface-rubble.png', cells: 8, relief: .05 },
    },
    props: {},
  },
})

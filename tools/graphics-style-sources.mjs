// @ts-check
/**
 * Источники рисованного стиля 3D-доски. Только данные: сборкой занимается
 * `tools/build-graphics-styles.mjs`, клиент читает готовый манифест стиля.
 *
 * Ориентир — наборы Quaternius (Fantasy Props, Medieval Village, Stylized
 * Nature MegaKit): рисованные фактуры с контурными прожилками, мягкий рельеф.
 * Стиль один: реалистичный вариант на фотографиях Poly Haven убран
 * 2026-10-03 — предметы двух стилей на одной доске не сходились.
 *
 * Клетка карты — 1,5 м. `cells` — сколько клеток накрывает один повтор
 * текстуры пола. `relief` — глубина рельефа в мировых единицах (клетка = 1).
 */

/** @typedef {{ quaternius?: string, painted?: string, cells: number, relief: number }} FloorSource */

/**
 * Рисованный материал для перекраски чужих моделей: вырезка из фактуры
 * Quaternius, сшитая в бесшовный повтор. `rect` — x, y, ширина, высота в
 * пикселях исходника; `meters` — сколько метров модели накрывает повтор по
 * длинной стороне вырезки.
 * @typedef {{ color: string, normal?: string, orm?: string, roughness?: string, rect: [number, number, number, number], meters: number, metalness?: number, roughnessValue?: number, along?: 'u' | 'v' }} PaintedMaterial
 */

/**
 * Деталь сборной модели.
 * - `kit` — модель набора Quaternius из `tmp/asset-src` (`fpmk/…`, `mvmk/…`, `snmk/…`);
 * - `restyle` — прежняя модель выпуска окружения, перекрашенная рисованными материалами
 *   (`release/<семья>/<файл>` — текущий выпуск, `old/<семья>/<файл>` — выпуск bd5c…);
 * - `detail` — авторская модель набора детализации, собранная заново из рецепта.
 * `at` — смещение в метрах, `yaw` — поворот в градусах, `on` — поставить на
 * верх детали с этим номером.
 * `native` — не ставить деталь на землю: она уже на месте в координатах набора.
 * @typedef {{ kit?: string, restyle?: string, detail?: string, at?: [number, number, number], yaw?: number, scale?: number | [number, number, number], on?: number, tilt?: [number, number, number], native?: boolean }} PartSource
 */

/**
 * Вариант модели вида предмета: готовая модель текущего выпуска (`ref`) или
 * сборная (`name` + `parts`), которая ляжет в пакет как `props/<name>.glb`.
 * @typedef {{ ref?: string, name?: string, parts?: PartSource[], yaw?: number }} PropSource
 */

/** @typedef {{ label: string, floors: Record<string, FloorSource>, materials: Record<string, PaintedMaterial>, props: Record<string, PropSource[]>, license: string, sources: string[] }} StyleSource */

/** Выпуск окружения, из которого берутся готовые модели Quaternius. */
export const STYLE_RELEASE = '5f884daa35bf2ebe49f61f75'

const FPMK = 'fpmk/'
const ref = (/** @type {string} */ path, yaw = 0) => ({ ref: path, yaw })
const restyled = (/** @type {string} */ name, /** @type {string} */ restyle) => ({ name, parts: [{ restyle }] })
const detail = (/** @type {string} */ id) => ({ name: `detail_${id}`, parts: [{ detail: id }] })
const nature = (/** @type {string[]} */ files) => files.map((file) => ref(`quaternius-nature/${file}`))

/** Модели набора детализации, у которых есть авторский рецепт. */
const DETAIL_RECIPES = [
  'forge', 'quench_tub', 'coal_pile', 'sawhorse', 'lumber_pile', 'kitchen_stove', 'bread_oven', 'butcher_block',
  'hanging_pots', 'washtub', 'double_bed', 'dresser', 'armchair', 'bathtub', 'coat_rack', 'cradle',
  'folding_screen', 'standing_mirror', 'writing_desk', 'candle_desk', 'scroll_rack', 'globe', 'reading_nook', 'telescope',
  'armor_stand', 'archery_target', 'straw_bed', 'wall_chains', 'jailer_desk', 'torture_rack', 'stocks', 'idol',
  'holy_pool', 'font_basin', 'incense_burner', 'kneeling_cushions', 'bell_frame', 'shop_counter', 'scales_table', 'cloth_bolts',
  'hay_bales', 'chicken_coop', 'garden_bed', 'scarecrow', 'flour_bin', 'millstone', 'water_wheel', 'fence_gate',
  'flower_bed', 'fountain', 'town_well', 'market_awning', 'notice_board', 'sign_post_city', 'pillory', 'statue_plinth',
  'street_planter', 'mooring_post', 'fish_rack', 'fishing_nets', 'rowboat', 'punt', 'stone_steps', 'root_tangle',
]

/** @type {Record<string, PropSource[]>} */
const PROPS = {
  // --- Модели прежнего выпуска, у которых в наборах Quaternius есть замена.
  barrel: [ref('quaternius/barrel.glb'), ref('quaternius/barrel_apples.glb')],
  keg: [ref('quaternius/barrel.glb')],
  water_barrel: [ref('quaternius/barrel.glb')],
  rain_barrel: [ref('quaternius/barrel.glb')],
  chest: [ref('quaternius/chest_wood.glb')],
  footlocker: [ref('quaternius/chest_wood.glb')],
  strongbox: [ref('quaternius/crate_metal.glb')],
  coin_pile: [ref('quaternius/coin_pile.glb'), ref('quaternius/coin_pile_2.glb')],
  crate: [ref('quaternius/crate_wooden.glb'), { name: 'mvmk_crate', parts: [{ kit: 'mvmk/Prop_Crate' }] }],
  torch_wall: [ref('quaternius/torch_metal.glb')],
  urn: [ref('quaternius/vase_2.glb'), ref('quaternius/vase_4.glb')],
  anvil: [ref('quaternius/anvil.glb'), ref('quaternius/anvil_log.glb')],
  grindstone: [ref('quaternius/whetstone.glb')],
  bookcase_tall: [ref('quaternius/bookcase_2.glb')],
  book_lectern: [ref('quaternius/book_stand.glb')],
  temple_lectern: [ref('quaternius/book_stand.glb')],
  barracks_bed: [ref('quaternius/bed_twin2.glb')],
  weapon_rack_wall: [ref('quaternius/weapon_stand.glb')],
  training_dummy: [ref('quaternius/dummy.glb')],
  cell_bucket: [ref('quaternius/bucket_wooden_1.glb')],
  iron_cage: [ref('quaternius/cage_small.glb')],
  candle_rack: [ref('quaternius/candle_stick_stand.glb')],
  spice_crates: [ref('quaternius/farm_crate_carrot.glb'), ref('quaternius/farm_crate_apple.glb')],
  village_fence: [
    { name: 'mvmk_fence_single', parts: [{ kit: 'mvmk/Prop_WoodenFence_Single' }] },
    { name: 'mvmk_fence_extension', parts: [{ kit: 'mvmk/Prop_WoodenFence_Extension1' }] },
  ],

  // --- Сборные модели из деталей Quaternius.
  barrel_stack: [
    ref('quaternius/barrel_holder.glb'),
    { name: 'barrel_pyramid', parts: [
      { kit: `${FPMK}Barrel`, at: [-.37, 0, 0], yaw: 20 },
      { kit: `${FPMK}Barrel`, at: [.37, 0, .02], yaw: 75 },
      { kit: `${FPMK}Barrel_Apples`, at: [0, .9, 0], yaw: 140, scale: .9 },
    ] },
  ],
  crate_stack: [
    { name: 'crate_stack_three', parts: [
      { kit: `${FPMK}Crate_Wooden`, at: [-.46, 0, 0], yaw: 4 },
      { kit: `${FPMK}Crate_Wooden`, at: [.46, 0, .04], yaw: -7 },
      { kit: `${FPMK}Crate_Wooden`, at: [-.1, .93, .02], yaw: 18, scale: .82 },
    ] },
    { name: 'crate_stack_mixed', parts: [
      { kit: 'mvmk/Prop_Crate', at: [-.3, 0, 0], yaw: 8, scale: .85 },
      { kit: `${FPMK}Crate_Metal`, at: [.62, 0, .06], yaw: -12, scale: .8 },
      { kit: `${FPMK}FarmCrate_Empty`, on: 0, at: [-.3, 0, 0], yaw: 25 },
    ] },
  ],
  ammo_crates: [
    { name: 'ammo_crates', parts: [
      { kit: `${FPMK}Crate_Wooden`, at: [-.45, 0, 0], yaw: 3 },
      { kit: `${FPMK}Crate_Metal`, at: [.48, 0, .02], yaw: -5 },
      { kit: `${FPMK}Sword_Bronze`, on: 0, at: [-.45, 0, 0], yaw: 80, tilt: [90, 0, 0], scale: 1.6 },
    ] },
  ],
  crate_stack_goods: [
    { name: 'crate_stack_goods', parts: [
      { kit: `${FPMK}Crate_Wooden`, at: [-.3, 0, 0], yaw: 6 },
      { kit: `${FPMK}FarmCrate_Apple`, on: 0, at: [-.3, 0, 0], yaw: -10 },
      { kit: `${FPMK}FarmCrate_Carrot`, at: [.55, 0, .1], yaw: 85 },
    ] },
  ],
  goods_baskets: [
    { name: 'goods_baskets', parts: [
      { kit: `${FPMK}FarmCrate_Apple`, at: [-.38, 0, 0], yaw: 4 },
      { kit: `${FPMK}FarmCrate_Carrot`, at: [.38, 0, .05], yaw: -6 },
      { kit: `${FPMK}FarmCrate_Empty`, on: 0, at: [-.38, 0, 0], yaw: 12 },
    ] },
  ],
  grain_sacks: [
    { name: 'grain_sacks', parts: [
      { kit: `${FPMK}Bag`, at: [-.32, 0, 0], yaw: 10 },
      { kit: `${FPMK}Bag`, at: [.34, 0, .08], yaw: 140, scale: .92 },
      { kit: `${FPMK}Bag`, at: [0, 0, -.42], yaw: 250, scale: .85 },
    ] },
  ],
  pottery_stand: [
    { name: 'pottery_stand', parts: [
      { kit: `${FPMK}Vase_2`, at: [-.3, 0, 0] },
      { kit: `${FPMK}Vase_4`, at: [.38, 0, -.12], yaw: 40 },
      { kit: `${FPMK}Vase_4`, at: [.3, 0, .3], yaw: 200, scale: .8 },
    ] },
  ],
  workbench: [
    ref('quaternius/workbench.glb'),
    { name: 'workbench_drawers', parts: [
      { kit: `${FPMK}Workbench` },
      { kit: `${FPMK}Workbench_Drawers`, native: true },
      { kit: `${FPMK}Pickaxe_Bronze`, on: 0, at: [-.4, 0, 0], yaw: 20, tilt: [0, 0, 90] },
    ] },
  ],
  tool_rack: [
    { name: 'tool_rack', parts: [
      { kit: `${FPMK}Workbench`, scale: [.6, 1, .7] },
      { kit: `${FPMK}Peg_Rack`, at: [0, 1.55, -.3] },
      { kit: `${FPMK}Axe_Bronze`, at: [-.3, .95, -.33], scale: 1.1 },
      { kit: `${FPMK}Shield_Wooden`, at: [.28, 1.05, -.32], scale: 1.1 },
      { kit: `${FPMK}Pickaxe_Bronze`, on: 0, at: [.1, 0, .1], yaw: 30, tilt: [0, 0, 90] },
      { kit: `${FPMK}Rope_1`, on: 0, at: [-.45, 0, .15], scale: .7 },
    ] },
  ],
  prep_table: [
    { name: 'prep_table', parts: [
      { kit: `${FPMK}Table_Large`, scale: [.72, 1, .9] },
      { kit: `${FPMK}Carrot`, on: 0, at: [-.4, 0, .1], tilt: [0, 0, 90], scale: 1.6 },
      { kit: `${FPMK}Table_Knife`, on: 0, at: [.1, 0, 0], yaw: 30, scale: 1.6 },
      { kit: `${FPMK}Pot_1`, on: 0, at: [.6, 0, -.1], scale: 1.6 },
      { kit: `${FPMK}Table_Plate`, on: 0, at: [-.05, 0, -.25], scale: 1.6 },
    ] },
  ],
  pantry_shelf: [
    { name: 'pantry_shelf', parts: [
      { kit: `${FPMK}Cabinet` },
      { kit: `${FPMK}Pot_1_Lid`, on: 0, at: [-.35, 0, 0], scale: .7 },
      { kit: `${FPMK}Vase_4`, on: 0, at: [.15, 0, 0], scale: .55 },
      { kit: `${FPMK}Bottle_1`, on: 0, at: [.48, 0, .02] },
    ] },
  ],
  display_shelf: [
    { name: 'display_shelf', parts: [
      { kit: `${FPMK}Cabinet` },
      { kit: `${FPMK}Shelf_Small_Bottles`, on: 0, at: [0, 0, -.03] },
    ] },
  ],
  bar_shelf: [
    restyled('sk_bar_shelf', 'release/skazanie/sk-bar-shelf'),
    { name: 'bar_shelf_bottles', parts: [
      { kit: `${FPMK}Shelf_Small_Bottles` },
      { kit: `${FPMK}Shelf_Small_Bottles`, at: [0, .68, 0] },
    ] },
  ],
  map_table: [
    { name: 'map_table', parts: [
      { kit: `${FPMK}Table_Large`, scale: [.75, 1, 1] },
      { kit: `${FPMK}Scroll_1`, on: 0, at: [-.5, 0, .1], yaw: 20, scale: 1.6 },
      { kit: `${FPMK}Scroll_2`, on: 0, at: [-.3, 0, -.25], yaw: -40, scale: 1.6 },
      { kit: `${FPMK}Book_7`, on: 0, at: [.55, 0, .1], yaw: 15, scale: 1.6 },
      { kit: `${FPMK}CandleStick`, on: 0, at: [.15, 0, -.3], scale: 1.6 },
    ] },
  ],
  war_table: [
    { name: 'war_table', parts: [
      { kit: `${FPMK}Table_Large`, scale: [.75, 1, 1] },
      { kit: `${FPMK}Scroll_1`, on: 0, at: [.4, 0, .2], yaw: -10, scale: 1.6 },
      { kit: `${FPMK}Sword_Bronze`, on: 0, at: [-.2, .03, 0], yaw: 70, tilt: [90, 0, 0], scale: 1.6 },
      { kit: `${FPMK}Coin_Pile`, on: 0, at: [.6, 0, -.25], scale: 1.6 },
      { kit: `${FPMK}CandleStick`, on: 0, at: [-.65, 0, -.3], scale: 1.6 },
    ] },
  ],
  offering_table: [
    { name: 'offering_table', parts: [
      { restyle: 'release/skazanie/sk-table-small' },
      { kit: `${FPMK}Chalice`, on: 0, at: [0, 0, 0] },
      { kit: `${FPMK}Candle_1`, on: 0, at: [-.22, 0, .1] },
      { kit: `${FPMK}Candle_2`, on: 0, at: [.22, 0, -.08] },
    ] },
  ],
  fruit_cart: [
    { name: 'fruit_cart', parts: [
      { kit: `${FPMK}Stall_Cart_Empty` },
      { kit: `${FPMK}FarmCrate_Apple`, at: [-.35, .82, 0], yaw: 3 },
      { kit: `${FPMK}FarmCrate_Carrot`, at: [.45, .82, .05], yaw: -4 },
    ] },
  ],
  rubble_heap: [
    { name: 'brick_rubble', parts: [
      { kit: 'mvmk/Prop_Brick1', at: [-.15, .1, .05], yaw: 20 },
      { kit: 'mvmk/Prop_Brick2', at: [.2, .11, -.1], yaw: -35 },
      { kit: 'mvmk/Prop_Brick3', at: [0, .3, 0], yaw: 70, tilt: [0, 0, 18] },
      { kit: 'mvmk/Prop_Brick4', at: [.1, .1, .3], yaw: 140 },
      { kit: 'snmk/Pebble_Square_3', at: [-.35, 0, -.2], yaw: 40 },
      { kit: 'snmk/Pebble_Round_2', at: [.4, 0, .25], yaw: 90, scale: .7 },
    ] },
    restyled('sk_rubble_heap', 'old/skazanie/sk-rubble-heap'),
  ],
  campfire: [
    { name: 'campfire_ring', parts: [
      ...[0, 72, 144, 216, 288].map((angle) => (/** @type {PartSource} */ ({
        kit: 'mvmk/Roof_Log', yaw: angle, scale: .075, tilt: [-58, 0, 0],
        at: [Math.round(Math.sin(angle * Math.PI / 180) * 20) / 100, 0, Math.round(Math.cos(angle * Math.PI / 180) * 20) / 100],
      }))),
      ...[0, 51, 103, 154, 206, 257, 309].map((angle, index) => (/** @type {PartSource} */ ({
        kit: `snmk/Pebble_Square_${index % 5 + 1}`,
        at: [Math.round(Math.cos(angle * Math.PI / 180) * 55) / 100, 0, Math.round(Math.sin(angle * Math.PI / 180) * 55) / 100],
        yaw: angle, scale: .55,
      }))),
    ] },
    restyled('kenney_campfire_stones', 'release/kenney/campfire_stones'),
  ],
  dead_bramble: [
    { name: 'dead_bramble', parts: [
      { kit: 'snmk/DeadTree_3', scale: [.11, .05, .11] },
      { kit: 'snmk/DeadTree_1', at: [.35, 0, .2], yaw: 120, scale: [.1, .045, .1], tilt: [0, 0, 25] },
      { kit: 'snmk/DeadTree_4', at: [-.3, 0, -.25], yaw: 250, scale: [.08, .04, .08], tilt: [20, 0, 0] },
    ] },
  ],
  mossy_rock: nature(['rock_medium_1.glb', 'rock_medium_2.glb']),
  boulder_split: [
    { name: 'boulder_split', parts: [
      { kit: 'snmk/Rock_Medium_2', at: [-.45, 0, 0], yaw: 10, scale: .45 },
      { kit: 'snmk/Rock_Medium_2', at: [.5, 0, .05], yaw: 190, scale: .42 },
    ] },
  ],
  rock_cluster: [
    { name: 'rock_cluster', parts: [
      { kit: 'snmk/Rock_Medium_1', scale: .32 },
      { kit: 'snmk/Rock_Medium_3', at: [.7, 0, .3], yaw: 80, scale: .22 },
      { kit: 'snmk/Rock_Medium_2', at: [-.55, 0, .45], yaw: 200, scale: .2 },
      { kit: 'snmk/Pebble_Square_2', at: [.2, 0, -.7], yaw: 30 },
    ] },
  ],
  cliff_medium: [{ name: 'cliff_medium', parts: [{ kit: 'snmk/Rock_Medium_3', scale: [.6, .75, .45] }, { kit: 'snmk/Rock_Medium_1', at: [1.2, 0, .1], yaw: 60, scale: .45 }] }],
  cliff_large: [{ name: 'cliff_large', parts: [{ kit: 'snmk/Rock_Medium_3', scale: .9 }, { kit: 'snmk/Rock_Medium_1', at: [1.9, 0, .4], yaw: 130, scale: .7 }, { kit: 'snmk/Rock_Medium_2', at: [-1.5, 0, .5], yaw: 250, scale: .6 }] }],
  cliff_long: [{ name: 'cliff_long', parts: [
    { kit: 'snmk/Rock_Medium_1', at: [-2, 0, 0], scale: [.7, .65, .5] },
    { kit: 'snmk/Rock_Medium_3', at: [0, 0, .1], yaw: 90, scale: [.6, .75, .5] },
    { kit: 'snmk/Rock_Medium_2', at: [2, 0, -.1], yaw: 180, scale: [.7, .6, .5] },
  ] }],

  // --- Природа: те же модели Stylized Nature, что в текущем выпуске; для карт
  //     прежних выпусков (там Kenney) стиль подменяет их так же.
  boulder: nature(['rock_medium_1.glb', 'rock_medium_2.glb', 'rock_medium_3.glb']),
  rock_small: nature(['pebble_round_3.glb', 'pebble_square_4.glb']),
  bush: nature(['bush_common.glb', 'bush_common_flowers.glb']),
  shrub: nature(['bush_common.glb', 'bush_common_flowers.glb']),
  fern: nature(['fern_1.glb']),
  flowers: nature(['flower_3_group.glb', 'flower_4_group.glb', 'plant_7_big.glb']),
  grass_tuft: nature(['grass_common_short.glb', 'grass_common_tall.glb']),
  mushroom_cluster: nature(['mushroom_common.glb', 'mushroom_laetiporus.glb']),
  tree_oak: nature(['common_tree_1.glb', 'common_tree_2.glb', 'common_tree_5.glb']),
  tree_birch: nature(['common_tree_3.glb', 'common_tree_4.glb']),
  tree_pine: nature(['pine_1.glb', 'pine_3.glb', 'pine_4.glb']),
  tree_spruce: nature(['pine_2.glb', 'pine_5.glb']),
  tree_dead: nature(['dead_tree_1.glb', 'dead_tree_2.glb', 'dead_tree_4.glb']),

  // --- Свои и чужие модели без замены: перекраска рисованными материалами.
  altar: [restyled('sk_altar', 'release/skazanie/sk-altar')],
  bar_counter: [restyled('sk_bar_counter', 'release/skazanie/sk-bar-counter')],
  basket: [restyled('sk_basket', 'release/skazanie/sk-household-basket')],
  bone_pile: [restyled('sk_bone_pile', 'release/skazanie/sk-bone-pile')],
  bone_heap: [restyled('sk_bone_pile', 'release/skazanie/sk-bone-pile')],
  bowl_stew: [restyled('sk_bowl_stew', 'release/skazanie/sk-household-bowl-stew')],
  brazier: [restyled('sk_brazier', 'release/skazanie/sk-brazier')],
  guard_brazier: [restyled('sk_brazier', 'release/skazanie/sk-brazier')],
  bread_loaf: [restyled('sk_bread_loaf', 'release/skazanie/sk-household-bread-loaf')],
  broom: [restyled('sk_broom', 'release/skazanie/sk-household-broom')],
  bunk_bed: [restyled('sk_bunk_bed', 'release/skazanie/sk-household-bunk-bed')],
  cheese_wheel: [restyled('sk_cheese_wheel', 'release/skazanie/sk-household-cheese-wheel')],
  crypt_niche: [restyled('sk_crypt_niche', 'release/skazanie/sk-crypt-niche')],
  cutting_board: [restyled('sk_cutting_board', 'release/skazanie/sk-household-cutting-board')],
  dice_cup: [restyled('sk_dice_cup', 'release/skazanie/sk-household-dice-cup')],
  fireplace: [restyled('sk_fireplace', 'release/skazanie/sk-fireplace')],
  grave: [restyled('sk_grave', 'old/skazanie/sk-grave')],
  haystack: [restyled('sk_haystack', 'release/skazanie/sk-haystack')],
  hearth_fire: [restyled('sk_hearth_fire', 'release/skazanie/sk-hearth-fire')],
  hitching_post: [restyled('sk_hitching_post', 'release/skazanie/sk-hitching-post')],
  jug: [restyled('sk_jug', 'release/skazanie/sk-household-jug')],
  lamp_post: [restyled('sk_lamp_post', 'release/skazanie/sk-lamp-post')],
  lute: [restyled('sk_lute', 'release/skazanie/sk-household-lute')],
  milestone: [restyled('sk_milestone', 'release/skazanie/sk-milestone')],
  offering_bowl: [restyled('sk_offering_bowl', 'release/skazanie/sk-household-offering-bowl')],
  pillar: [restyled('sk_pillar', 'old/skazanie/sk-pillar')],
  reliquary: [restyled('sk_reliquary', 'release/skazanie/sk-reliquary')],
  roadside_shrine: [restyled('sk_roadside_shrine', 'release/skazanie/sk-roadside-shrine')],
  royal_throne: [restyled('sk_royal_throne', 'release/skazanie/sk-household-royal-throne')],
  sarcophagus: [restyled('sk_sarcophagus', 'release/skazanie/sk-sarcophagus')],
  table_round: [restyled('sk_table_round', 'release/skazanie/sk-table-round')],
  table_royal: [restyled('sk_table_royal', 'release/skazanie/sk-household-table-royal')],
  table_small: [restyled('sk_table_small', 'release/skazanie/sk-table-small')],
  wagon_wheel: [restyled('sk_wagon_wheel', 'release/skazanie/sk-wagon-wheel')],
  wardrobe: [restyled('sk_wardrobe', 'release/skazanie/sk-household-wardrobe')],
  washbasin: [restyled('sk_washbasin', 'release/skazanie/sk-household-washbasin')],
  water_trough: [restyled('sk_water_trough', 'release/skazanie/sk-water-trough')],
  well: [restyled('sk_well', 'release/skazanie/sk-well')],
  fallen_log: [restyled('kenney_log', 'release/kenney/log'), restyled('kenney_log_large', 'release/kenney/log_large')],
  firewood_stack: [restyled('kenney_log_stack', 'release/kenney/log_stack'), restyled('kenney_log_stack_large', 'release/kenney/log_stack_large')],
  woodpile: [restyled('kenney_log_stack', 'release/kenney/log_stack'), restyled('kenney_log_stack_large', 'release/kenney/log_stack_large')],
  tree_stump: [
    restyled('kenney_stump_old', 'release/kenney/stump_old'),
    restyled('kenney_stump_round', 'release/kenney/stump_round_detailed'),
    restyled('kenney_stump_old_tall', 'release/kenney/stump_old_tall'),
  ],
  signpost: [restyled('kenney_sign', 'release/kenney/sign')],
  stalagmite: [
    restyled('kenney_rock_tall_c', 'release/kenney/rock_tall_c'),
    restyled('kenney_rock_tall_d', 'release/kenney/rock_tall_d'),
    restyled('kenney_rock_tall_j', 'release/kenney/rock_tall_j'),
  ],
  statue: [
    restyled('kenney_statue_head', 'release/kenney/statue_head'),
    restyled('kenney_statue_obelisk', 'release/kenney/statue_obelisk'),
    restyled('kenney_statue_column', 'release/kenney/statue_column'),
  ],
}
for (const id of DETAIL_RECIPES) PROPS[id] = [detail(id)]

/** @type {Readonly<Record<string, StyleSource>>} */
export const GRAPHICS_STYLE_SOURCES = Object.freeze({
  stylized: {
    label: 'Рисованный',
    license: 'CC0 (Quaternius: Fantasy Props, Medieval Village и Stylized Nature MegaKit) и собственные текстуры и модели проекта (data/asset-rights.json)',
    sources: [
      'https://quaternius.com/packs/fantasypropsmegakit.html',
      'https://quaternius.com/packs/medievalvillagemegakit.html',
      'https://quaternius.itch.io/stylized-nature-megakit',
      'public/assets/maps/terrain/terrain-tiles.json',
      `public/assets/models/environment/releases/${STYLE_RELEASE}/`,
      'public/assets/maps/detail-v1/manifest.json',
    ],
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
    // Вырезки из фактур Quaternius; координаты — пиксели исходника.
    materials: {
      wood: { color: 'fpmk/T_Trim_Furniture_BaseColor.png', normal: 'fpmk/T_Trim_Furniture_Normal.png', orm: 'fpmk/T_Trim_Furniture_ORM.png', rect: [0, 165, 2048, 680], meters: 1.6 },
      straw: { color: 'mvmk/T_WoodTrim_BaseColor.png', normal: 'mvmk/T_WoodTrim_Normal.png', roughness: 'mvmk/T_WoodTrim_Roughness.png', rect: [0, 0, 1024, 310], meters: .9 },
      stone: { color: 'mvmk/T_RockTrim_BaseColor.png', normal: 'mvmk/T_RockTrim_Normal.png', orm: 'mvmk/T_RockTrim_ORM.png', rect: [0, 345, 1024, 245], meters: 1.6 },
      brick: { color: 'mvmk/T_RockTrim_BaseColor.png', normal: 'mvmk/T_RockTrim_Normal.png', orm: 'mvmk/T_RockTrim_ORM.png', rect: [0, 605, 1024, 412], meters: 1.2 },
      metal: { color: 'fpmk/T_Trim_Metal_BaseColor.png', normal: 'fpmk/T_Trim_Metal_Normal.png', orm: 'fpmk/T_Trim_Metal_ORM.png', rect: [0, 40, 2048, 680], meters: 1.2, metalness: .55 },
      cloth: { color: 'fpmk/T_Trim_Cloth_BaseColor.png', normal: 'fpmk/T_Trim_Cloth_Normal.png', orm: 'fpmk/T_Trim_Cloth_ORM.png', rect: [72, 20, 340, 900], meters: .9, along: 'v' },
      bark: { color: 'snmk/Bark_NormalTree.png', normal: 'snmk/Bark_NormalTree_Normal.png', rect: [0, 0, 2048, 2048], meters: 1.4, along: 'v', roughnessValue: .9 },
      plaster: { color: 'mvmk/T_Plaster_BaseColor.png', normal: 'mvmk/T_Plaster_Normal.png', orm: 'mvmk/T_Plaster_ORM.png', rect: [0, 0, 2048, 2048], meters: 2 },
    },
    props: PROPS,
  },
})

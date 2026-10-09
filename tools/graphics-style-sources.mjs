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

/**
 * `procedural` — фактура рисуется сборщиком (`paintGrass`, `paintDirt` в
 * `tools/build-graphics-styles-page.js`), без исходной картинки.
 * @typedef {{ quaternius?: string, painted?: string, procedural?: 'grass' | 'dirt', cells: number, relief: number }} FloorSource
 */

/**
 * Рисованный материал: вырезка из фактуры Quaternius, сшитая в бесшовный
 * повтор. `rect` — x, y, ширина, высота в пикселях исходника (наборы Village и
 * Fantasy Props — 2048 px); `meters` — сколько метров модели накрывает повтор
 * по длинной стороне вырезки. `seam` — по каким осям сшивать края (трим-полосы
 * Quaternius уже повторяются по горизонтали). `neutral: false` оставляет
 * собственный цвет фактуры: так красятся стены, а не перекрашенные модели,
 * чей оттенок задают цвета вершин.
 * @typedef {{ color: string, normal?: string, orm?: string, roughness?: string, rect: [number, number, number, number], meters: number, metalness?: number, roughnessValue?: number, along?: 'u' | 'v', seam?: '' | 'x' | 'y' | 'xy', neutral?: boolean }} PaintedMaterial
 */

/**
 * Вид стены или ската крыши 3D-доски: материал пакета и сколько клеток
 * накрывает его повтор по горизонтали (по вертикали — с пропорцией фактуры).
 * @typedef {{ material: string, cells: number }} WallLookSource
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
 * `kenney` — модель набора Kenney 2.0 из `tmp/asset-src` (путь без `.glb`): цвет
 *   её палитры переносится в цвета вершин, треугольники делятся по классу
 *   материала, дальше — та же перекраска, что у `restyle`. `tones` меняет класс
 *   тона палитры (`lavender`, `orange`, `mint`, `blue`): мятное кладбищенское —
 *   железо, синее фонтана — вода.
 * @typedef {{ lavender?: string, orange?: string, mint?: string, blue?: string }} KenneyTones
 * @typedef {{ kit?: string, restyle?: string, detail?: string, kenney?: string, tones?: KenneyTones, at?: [number, number, number], yaw?: number, scale?: number | [number, number, number], on?: number, tilt?: [number, number, number], native?: boolean, center?: boolean, imageOverrides?: Record<string, string> }} PartSource
 */

/**
 * Вариант модели вида предмета: готовая модель текущего выпуска (`ref`) или
 * сборная (`name` + `parts`), которая ляжет в пакет как `props/<name>.glb`.
 * `surface` — модель служит опорой для утвари: сборщик ставит метку
 * `surface-top` на столешницу, и доска сажает посуду на неё, а не на перо.
 * @typedef {{ ref?: string, name?: string, parts?: PartSource[], yaw?: number, maxHeight?: number, surface?: boolean }} PropSource
 */

/** @typedef {{ label: string, floors: Record<string, FloorSource>, materials: Record<string, PaintedMaterial>, walls: Record<string, WallLookSource>, props: Record<string, PropSource[]>, license: string, sources: string[] }} StyleSource */

/** Выпуск окружения, из которого берутся готовые модели Quaternius. */
export const STYLE_RELEASE = '5f884daa35bf2ebe49f61f75'

const FPMK = 'fpmk/'
const ref = (/** @type {string} */ path, yaw = 0) => ({ ref: path, yaw })
const restyled = (/** @type {string} */ name, /** @type {string} */ restyle) => ({ name, parts: [{ restyle }] })
const detail = (/** @type {string} */ id) => ({ name: `detail_${id}`, parts: [{ detail: id }] })
const nature = (/** @type {string[]} */ files) => files.map((file) => ref(`quaternius-nature/${file}`))

/**
 * Наборы Kenney 2.0 (CC0): городок, замок и пещера скачаны 2026-10-09,
 * кладбище — архив `kenney_graveyard-kit_5.0.zip`, который уже даёт выпуску
 * окружения могилы и урны, распакован в `kenney-graveyard-kit`
 * (`tmp/asset-src/SOURCES.md`). Берутся отдельные вещи — телеги, прилавки,
 * знамёна, фонтаны, надгробия, баллиста; стены, крыши, дороги и сегменты
 * пещер — строительные детали, доска строит их сама.
 */
const KENNEY_KITS = Object.freeze({
  town: 'dl-kenney-fantasy-town-kit/unpacked/Models/GLB format',
  castle: 'dl-kenney-castle-kit/unpacked/Models/GLB format',
  cave: 'dl-kenney-modular-cave-kit/unpacked/Models/GLB format',
  graveyard: 'kenney-graveyard-kit/Models/GLB format',
})
/**
 * У моделей Kenney длинная сторона вдоль Z, а длинные виды (телега, скамья,
 * ограда, бревно) занимают 2×1 клетки по X: `yaw: 90` кладёт модель вдоль следа,
 * иначе вписывание сжимает её вдвое.
 * @param {keyof typeof KENNEY_KITS} kit @param {string} file @param {number} [yaw] @param {KenneyTones} [tones]
 */
const kenney = (kit, file, yaw = 0, tones = undefined) => ({
  name: `kenney_${kit}_${file.replace(/-/gu, '_')}`,
  parts: [{ kenney: `${KENNEY_KITS[kit]}/${file}`, ...(tones ? { tones } : {}) }],
  ...(yaw ? { yaw } : {}),
})
/** Мятное у кладбища Kenney — кованое железо оград, фонарей и решёток. */
const GRAVEYARD_TONES = Object.freeze({ mint: 'metal' })
/** @param {string} file @param {number} [yaw] @param {KenneyTones} [tones] */
const graveyard = (file, yaw = 0, tones = {}) => kenney('graveyard', file, yaw, { ...GRAVEYARD_TONES, ...tones })
/**
 * Могила кладбища Kenney: земляной холм и надгробие в изголовье, как могилы выпуска
 * окружения (`GRAVEYARD_SELECTION` в `tools/environment-packs.mjs`); `yaw: 90`
 * кладёт её вдоль следа 2×1.
 * @param {string} mound @param {string} stone @param {number} head
 */
const graveyardGrave = (mound, stone, head) => ({
  name: `kenney_graveyard_${mound.replace(/-/gu, '_')}_${stone.replace(/-/gu, '_')}`,
  yaw: 90,
  parts: [
    { kenney: `${KENNEY_KITS.graveyard}/${mound}`, tones: { ...GRAVEYARD_TONES, orange: 'dirt' } },
    { kenney: `${KENNEY_KITS.graveyard}/${stone}`, tones: GRAVEYARD_TONES, center: true, at: /** @type {[number, number, number]} */ ([0, 0, head]) },
  ],
})

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

  // --- Kenney Fantasy Town Kit 2.0 и Castle Kit 2.0: ещё варианты тех же видов.
  // Вид без своей модели стиля сохраняет прежнюю модель выпуска (`ref`), иначе
  // пакет стиля заменил бы её, а не добавил вариант.
  market_stall: [ref('quaternius/stall_empty.glb'), kenney('town', 'stall-green'), kenney('town', 'stall-red')],
  bench: [ref('quaternius/bench.glb'), kenney('town', 'stall-bench', 90)],
  stool: [ref('quaternius/stool.glb'), kenney('town', 'stall-stool')],
  // Сиреневое у решёток — сталь, а не камень.
  portcullis_gate: [kenney('castle', 'metal-gate', 0, { lavender: 'metal' }), kenney('cave', 'gate-metal-bars', 0, { lavender: 'metal' })],
}
for (const id of DETAIL_RECIPES) PROPS[id] = [detail(id)]

// --- Одобренное расширение: предметы, варианты и детали построек (03.10.2026).
// Мосты, стены и крыши читает структурный рендерер; мебелью они не становятся.
/** @type {Record<string, PropSource[]>} */
const EXPANSION_PROPS = {
  ballista: [{"name":"extra_ballista","parts":[{"detail":"ballista"}],"maxHeight":1.1}],
  command_tent: [{"name":"extra_command_tent","parts":[{"detail":"command_tent"}],"maxHeight":1.45}],
  alchemy_table: [{"name":"extra_alchemy_table","parts":[{"detail":"alchemy_table"}],"maxHeight":0.72}],
  dock_crane: [{"name":"extra_dock_crane","parts":[{"detail":"dock_crane"}],"maxHeight":1.7}],
  tree_oak: [{"name":"extra_twisted_tree_tall","parts":[{"kit":"snmk/TwistedTree_1","center":true,"imageOverrides":{"Leaves_TwistedTree_C.png":"Leaves_NormalTree_C.png"}}]},{"name":"extra_twisted_tree_broad","parts":[{"kit":"snmk/TwistedTree_3","center":true,"imageOverrides":{"Leaves_TwistedTree_C.png":"Leaves_NormalTree_C.png"}}]}],
  mine_cart: [{"name":"extra_mine_cart","parts":[{"detail":"mine_cart"}],"maxHeight":0.7}],
  rope_bridge: [{"name":"extra_rope_bridge","parts":[{"detail":"rope_bridge"}]}],
  crystal_orb: [{"name":"extra_crystal_orb","parts":[{"detail":"crystal_orb"}],"maxHeight":0.8}],
  giant_fungus: [{"name":"extra_giant_fungus","parts":[{"detail":"giant_fungus"}],"maxHeight":1.6}],
  sandstone_arch: [{"name":"extra_sandstone_arch","parts":[{"detail":"sandstone_arch"}],"maxHeight":1.7}],
  mantlet: [{"name":"extra_mantlet","parts":[{"detail":"mantlet"}],"maxHeight":1.35}],
  cargo_sled: [{"name":"extra_cargo_sled","parts":[{"detail":"cargo_sled"}],"maxHeight":0.48}],
  ruin_wall_arch: [{"name":"extra_ruin_wall_arch","parts":[{"kit":"mvmk/Wall_Arch","center":true}]}],
  chimney_brick: [{"name":"extra_chimney_brick","parts":[{"kit":"mvmk/Prop_Chimney","center":true}]}],
  ornate_iron_fence: [{"name":"extra_ornate_iron_fence","parts":[{"kit":"mvmk/Prop_MetalFence_Ornament","center":true}]}],
  roof_dormer_roundtile: [{"name":"extra_roof_dormer_roundtile","parts":[{"kit":"mvmk/Roof_Dormer_RoundTile","center":true}]}],
  ruin_corner_brick: [{"name":"extra_ruin_corner_brick","parts":[{"kit":"mvmk/Corner_ExteriorWide_Brick","center":true}]}],
  round_window_brick: [{"name":"extra_round_window_brick","parts":[{"kit":"mvmk/Wall_UnevenBrick_Window_Wide_Round","center":true}]}],
  arch_shelf: [{"name":"extra_arch_shelf","parts":[{"kit":"fpmk/Shelf_Arch","center":true}],"maxHeight":0.7}],
  cutlery_set: [{"name":"extra_cutlery_set","parts":[{"kit":"fpmk/Table_Fork","center":true,"at":[-0.22,0,0],"scale":1.6,"yaw":-35},{"kit":"fpmk/Table_Knife","center":true,"at":[0,0,0.04],"scale":1.6,"yaw":12},{"kit":"fpmk/Table_Spoon","center":true,"at":[0.22,0,0.02],"scale":1.6,"yaw":42}],"maxHeight":0.09}],
  tool_peg_rack: [{"name":"extra_tool_peg_rack","parts":[{"kit":"fpmk/Peg_Rack","center":true,"at":[0,0.95,-0.04]}],"maxHeight":0.25}],
  chain_coil: [{"name":"extra_chain_coil","parts":[{"kit":"fpmk/Chain_Coil","center":true}],"maxHeight":0.13}],
  book_piles: [{"name":"extra_book_piles","parts":[{"kit":"fpmk/Book_Stack_1","center":true,"at":[-0.25,0,0],"yaw":-10},{"kit":"fpmk/Book_Stack_2","center":true,"at":[0.25,0,0.04],"yaw":15}],"maxHeight":0.24}],
  crystal_cluster: [{"name":"extra_crystal_cluster","parts":[{"detail":"crystal_cluster"}],"maxHeight":1.2}],
  nomad_tent: [{"name":"extra_nomad_tent","parts":[{"detail":"nomad_tent"}],"maxHeight":1.2}],
  obsidian_monolith: [{"name":"extra_obsidian_monolith","parts":[{"detail":"obsidian_monolith"}],"maxHeight":1.8}],
  weapon_rack: [{"name":"extra_weapon_rack","parts":[{"detail":"weapon_rack"}],"maxHeight":0.95}],
  scout_tent: [{"name":"extra_scout_tent","parts":[{"detail":"scout_tent"}],"maxHeight":0.95}],
  timber_shoring: [{"name":"extra_timber_shoring","parts":[{"detail":"timber_shoring"}],"maxHeight":1.6}],
  mine_rail: [{"name":"extra_mine_rail","parts":[{"detail":"mine_rail"}],"maxHeight":0.09}],
  shield_display: [{"name":"extra_shield_display","parts":[{"kit":"fpmk/Shield_Wooden","center":true,"at":[0,0.7,-0.08],"scale":1.1,"yaw":0}],"maxHeight":0.65}],
  banner: [{"name":"extra_banner_variant","parts":[{"kit":"fpmk/Banner_2","center":true}]}],
  arcane_coil: [{"name":"extra_arcane_coil","parts":[{"detail":"arcane_coil"}],"maxHeight":0.75}],
  alchemy_bottles: [{"name":"extra_alchemy_bottles","parts":[{"kit":"fpmk/Potion_1","center":true,"at":[-0.24,0,0]},{"kit":"fpmk/Potion_2","center":true,"at":[0.2,0,0.06]},{"kit":"fpmk/Potion_4","center":true,"at":[0,0,-0.26]}],"maxHeight":0.36}],
  desk_candlestick: [{"name":"extra_desk_candlestick","parts":[{"kit":"fpmk/CandleStick","center":true,"scale":1.6,"yaw":-12}],"maxHeight":0.3}],
  single_book: [{"name":"extra_single_book","parts":[{"kit":"fpmk/Book_Simplified_Single","center":true,"scale":1.6,"yaw":18}],"maxHeight":0.28}],
  vial_display_shelf: [{"name":"extra_vial_display_shelf","parts":[{"kit":"fpmk/Shelf_Small_Bottles","center":true,"at":[0,0.8,-0.04]}],"maxHeight":0.5}],
  ceremonial_chalice: [{"name":"extra_ceremonial_chalice","parts":[{"kit":"fpmk/Chalice","center":true,"scale":1.6,"yaw":8}],"maxHeight":0.32}],
  book_row: [{"name":"extra_book_row","parts":[{"kit":"fpmk/BookGroup_Medium_1","center":true,"scale":1.15,"yaw":0}],"maxHeight":0.3}],
  scroll_pile: [{"name":"extra_scroll_pile","parts":[{"kit":"fpmk/Scroll_1","center":true,"at":[-0.2,0,0],"scale":1.6,"yaw":-15},{"kit":"fpmk/Scroll_2","center":true,"at":[0.2,0,0.05],"scale":1.6,"yaw":20}],"maxHeight":0.16}],
  rope_coils: [{"name":"extra_rope_coils","parts":[{"kit":"fpmk/Rope_1","center":true,"at":[-0.28,0,0]},{"kit":"fpmk/Rope_2","center":true,"at":[0.28,0,0.1],"yaw":65}],"maxHeight":0.15}],
  capstan: [{"name":"extra_capstan","parts":[{"detail":"capstan"}],"maxHeight":0.68}],
  snowshoe_pair: [{"name":"extra_snowshoe_pair","parts":[{"detail":"snowshoe_pair"}],"maxHeight":0.1}],
  anchor: [{"name":"extra_anchor","parts":[{"detail":"anchor"}],"maxHeight":0.24}],
  swamp_boardwalk: [{"name":"extra_swamp_boardwalk","parts":[{"detail":"swamp_boardwalk"}]}],
  path_stone: [{"name":"extra_rock_path_square","parts":[{"kit":"snmk/RockPath_Square_Wide","center":true},{"kit":"snmk/RockPath_Square_Thin","center":true,"at":[1.5,0,0.02],"yaw":-4}]},{"name":"extra_rock_path_round","parts":[{"kit":"snmk/RockPath_Round_Wide","center":true},{"kit":"snmk/RockPath_Round_Thin","center":true,"at":[1.55,0,0.04],"yaw":6}]}],
  clover_patch: [{"name":"extra_clover_patch","parts":[{"kit":"snmk/Clover_1","center":true,"at":[-0.2,0,0]},{"kit":"snmk/Clover_2","center":true,"at":[0.2,0,0.08],"yaw":35}],"maxHeight":0.2}],
  forest_plant: [{"name":"extra_forest_plant","parts":[{"kit":"snmk/Plant_1","center":true},{"kit":"snmk/Plant_1_Big","center":true,"at":[0.28,0,0.1],"scale":0.8,"yaw":70}],"maxHeight":0.5}],
  mangrove_roots: [{"name":"extra_mangrove_roots","parts":[{"detail":"mangrove_roots"}],"maxHeight":0.95}],
  tree_dead: [{"name":"extra_dead_tree_low","parts":[{"kit":"snmk/DeadTree_5","center":true}]},{"name":"extra_dead_tree_sparse","parts":[{"kit":"snmk/DeadTree_3","center":true}]}],
  wall_ivy: [{"name":"extra_wall_ivy","parts":[{"kit":"mvmk/Prop_Vine1","center":true}],"maxHeight":0.65}],
  wall_ivy_corner: [{"name":"extra_wall_ivy_corner","parts":[{"kit":"mvmk/Prop_Vine6","center":true}],"maxHeight":0.65}],
  grass_tuft: [{"name":"extra_grass_wispy","parts":[{"kit":"snmk/Grass_Wispy_Short","center":true},{"kit":"snmk/Grass_Wispy_Tall","center":true}]}],
  wall_ivy_wide: [{"name":"extra_wall_ivy_wide","parts":[{"kit":"mvmk/Prop_Vine4","center":true}],"maxHeight":0.65}],
  cart: [{"name":"extra_merchant_wagon","parts":[{"kit":"mvmk/Prop_Wagon","center":true,"yaw":90}]}],
  key_bundle: [{"name":"extra_key_bundle","parts":[{"kit":"fpmk/Key_Gold","center":true,"at":[-0.12,0,0],"scale":2.2,"yaw":35},{"kit":"fpmk/Key_Metal","center":true,"at":[0.12,0,0.03],"scale":2.2,"yaw":-20}],"maxHeight":0.1}],
  coin_pouch: [{"name":"extra_coin_pouch","parts":[{"kit":"fpmk/Pouch_Large","center":true,"scale":1.2,"yaw":12}],"maxHeight":0.28}],
}
// Ранее доступные варианты телеги и знамени остаются рядом с новыми.
PROPS.cart = [ref('quaternius/stall_cart_empty.glb')]
PROPS.banner = [ref('quaternius/banner_1.glb')]
for (const [id, recipes] of Object.entries(EXPANSION_PROPS)) PROPS[id] = [...(PROPS[id] ?? []), ...recipes]

// Столы с вещами из рецепта, на которые сервер ставит утварь (`SURFACES` в
// `server/prop-placement.mjs`): их столешница отмечается лучом сверху.
for (const id of ['writing_desk', 'jailer_desk', 'shop_counter']) PROPS[id] = PROPS[id].map((prop) => ({ ...prop, surface: true }))

// --- Подготовленные штампы набора детализации получают модели (04.10.2026).
// Рецепты — `tools/map-detail-models-frontier.mjs`; предел высоты в клетках
// держит их по шкале доски (стена 0,95, герой 1,25–1,4).
/** @type {Record<string, number>} */
const FRONTIER_HEIGHTS = {
  snowdrift: .25, snowy_boulder: .65, ice_pillars: 1.1, frozen_pool: .12, winter_cache: .45, snow_cairn: .9,
  sand_dune: .22, desert_boulders: .6, cactus_cluster: 1.1, dead_scrub: .5, oasis_pool: .15, broken_obelisk: .3,
  bog_pool: .12, lily_pad_cluster: .08, reed_cluster: 1, rotten_log: .45, mud_patch: .06, swamp_totem: 1.3, peat_mound: .3,
  mooring_bollard: .6, cargo_net: .45, lobster_cage: .45, sail_bundle: .25,
  bedroll_cluster: .25, shield_rack: .95, camp_dummy: 1.25, spiked_beam_barrier: .65,
  alchemy_cauldron: .6, arcane_lectern: .95, ritual_circle: .05, arcane_stone: .2, potion_cabinet: 1.2, magic_mirror: 1.3,
  prison_cage: 1.2, dungeon_rack: .7, iron_maiden: 1.4, manacle_post: .85,
}
for (const [id, maxHeight] of Object.entries(FRONTIER_HEIGHTS)) PROPS[id] = [{ ...detail(id), maxHeight }]

// Kenney 2.0 — после всех переназначений списков выше (`PROPS.cart`, `PROPS.banner`).
PROPS.cart = [...PROPS.cart, kenney('town', 'cart', 90), kenney('town', 'cart-high', 90)]
PROPS.wagon_wheel = [...PROPS.wagon_wheel, kenney('town', 'wheel')]
PROPS.banner = [...PROPS.banner, kenney('town', 'banner-green'), kenney('town', 'banner-red'), kenney('castle', 'flag-banner-long')]
PROPS.lamp_post = [...PROPS.lamp_post, kenney('town', 'lantern')]
PROPS.village_fence = [...PROPS.village_fence, kenney('town', 'fence', 90), kenney('town', 'fence-broken', 90)]
PROPS.pillar = [...PROPS.pillar, kenney('town', 'pillar-stone')]
PROPS.boulder = [...PROPS.boulder, kenney('town', 'rock-large'), kenney('castle', 'rocks-large')]
PROPS.rock_small = [...PROPS.rock_small, kenney('town', 'rock-small'), kenney('castle', 'rocks-small')]
PROPS.fallen_log = [...PROPS.fallen_log, kenney('castle', 'tree-log', 90)]
PROPS.ballista = [...PROPS.ballista, kenney('castle', 'siege-ballista')]
// Кладбище Kenney 5.0 и фонтаны городка: варианты склепа, храма, двора и площади.
// Клиент принимает не больше восьми вариантов вида (`validateGraphicsStylePack`).
PROPS.grave = [...PROPS.grave,
  graveyardGrave('grave', 'gravestone-round', -.66), graveyardGrave('grave', 'gravestone-cross', -.7),
  graveyardGrave('grave-border', 'gravestone-decorative', -.74), graveyardGrave('grave-border', 'gravestone-broken', -.76),
  graveyardGrave('grave', 'gravestone-wide', -.68), graveyardGrave('grave-border', 'gravestone-roof', -.74),
  graveyardGrave('grave', 'gravestone-cross-large', -.7),
]
PROPS.sarcophagus = [...PROPS.sarcophagus, graveyard('crypt', 90)]
PROPS.urn = [...PROPS.urn, graveyard('urn-round'), graveyard('urn-square')]
PROPS.altar = [...PROPS.altar, graveyard('altar-stone'), graveyard('altar-wood')]
// Оранжевые пояса колонны — резьба того же камня, а не деревянные обручи.
PROPS.pillar = [...PROPS.pillar, graveyard('column-large', 0, { orange: 'stone' })]
PROPS.bench = [...PROPS.bench, graveyard('bench')]
PROPS.tree_stump = [...PROPS.tree_stump, graveyard('trunk')]
PROPS.rock_cluster = [...PROPS.rock_cluster, graveyard('rocks-tall')]
PROPS.fence_gate = [...PROPS.fence_gate, graveyard('fence-gate')]
// Два тюка рядом: один тюк на следе 2×1 вышел бы ростом с человека.
PROPS.hay_bales = [...PROPS.hay_bales, { name: 'kenney_graveyard_hay_bales', parts: [
  { kenney: `${KENNEY_KITS.graveyard}/hay-bale`, tones: { orange: 'straw' }, center: true, at: [-.33, 0, 0], yaw: 4 },
  { kenney: `${KENNEY_KITS.graveyard}/hay-bale-bundled`, tones: { orange: 'straw' }, center: true, at: [.33, 0, .03], yaw: -6 },
] }]
PROPS.fountain = [...PROPS.fountain, kenney('town', 'fountain-round-detail', 0, { blue: 'water' }), kenney('town', 'fountain-square-detail', 0, { blue: 'water' })]
PROPS.water_wheel = [...PROPS.water_wheel, kenney('town', 'watermill')]
// Ящики рыбаков — из тех же ящиков набора, что и в лавках: штабель на трёх.
PROPS.fishing_crates = [{ name: 'fishing_crates', maxHeight: .75, parts: [
  { kit: `${FPMK}Crate_Wooden`, at: [-.32, 0, .18], yaw: 6 },
  { kit: `${FPMK}Crate_Wooden`, at: [.34, 0, .2], yaw: -8 },
  { kit: `${FPMK}Crate_Wooden`, on: 0, at: [.02, 0, .04], yaw: 3, scale: .92 },
] }]

/** @type {Readonly<Record<string, StyleSource>>} */
export const GRAPHICS_STYLE_SOURCES = Object.freeze({
  stylized: {
    label: 'Рисованный',
    license: 'CC0 (Quaternius: Fantasy Props, Medieval Village и Stylized Nature MegaKit; Kenney: Fantasy Town Kit 2.0, Castle Kit 2.0, Modular Cave Kit, Graveyard Kit 5.0) и собственные текстуры и модели проекта (data/asset-rights.json)',
    sources: [
      'https://quaternius.com/packs/fantasypropsmegakit.html',
      'https://quaternius.com/packs/medievalvillagemegakit.html',
      'https://quaternius.itch.io/stylized-nature-megakit',
      'https://kenney.nl/assets/fantasy-town-kit',
      'https://kenney.nl/assets/castle-kit',
      'https://kenney.nl/assets/modular-cave-kit',
      'https://kenney.nl/assets/graveyard-kit',
      'public/assets/maps/terrain/terrain-tiles.json',
      `public/assets/models/environment/releases/${STYLE_RELEASE}/`,
      'public/assets/maps/detail-v1/manifest.json',
    ],
    floors: {
      stone: { painted: 'maps/terrain/floor-stone.png', cells: 4, relief: .03 },
      wood: { painted: 'maps/terrain/floor-wood.png', cells: 8, relief: .015 },
      earth: { procedural: 'dirt', cells: 5, relief: .03 },
      grass: { procedural: 'grass', cells: 5, relief: .025 },
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
      wood: { color: 'fpmk/T_Trim_Furniture_BaseColor.png', normal: 'fpmk/T_Trim_Furniture_Normal.png', orm: 'fpmk/T_Trim_Furniture_ORM.png', rect: [0, 165, 2048, 680], meters: 1.6, seam: 'y' },
      straw: { color: 'mvmk/T_WoodTrim_BaseColor.png', normal: 'mvmk/T_WoodTrim_Normal.png', roughness: 'mvmk/T_WoodTrim_Roughness.png', rect: [0, 0, 2048, 620], meters: .9, seam: 'y' },
      stone: { color: 'mvmk/T_RockTrim_BaseColor.png', normal: 'mvmk/T_RockTrim_Normal.png', orm: 'mvmk/T_RockTrim_ORM.png', rect: [0, 690, 2048, 490], meters: 1.6, seam: 'y' },
      brick: { color: 'mvmk/T_RockTrim_BaseColor.png', normal: 'mvmk/T_RockTrim_Normal.png', orm: 'mvmk/T_RockTrim_ORM.png', rect: [0, 1210, 2048, 824], meters: 1.2, seam: 'y' },
      metal: { color: 'fpmk/T_Trim_Metal_BaseColor.png', normal: 'fpmk/T_Trim_Metal_Normal.png', orm: 'fpmk/T_Trim_Metal_ORM.png', rect: [0, 40, 2048, 680], meters: 1.2, metalness: .55, seam: 'y' },
      cloth: { color: 'fpmk/T_Trim_Cloth_BaseColor.png', normal: 'fpmk/T_Trim_Cloth_Normal.png', orm: 'fpmk/T_Trim_Cloth_ORM.png', rect: [72, 20, 340, 900], meters: .9, along: 'v', seam: 'xy' },
      bark: { color: 'snmk/Bark_NormalTree.png', normal: 'snmk/Bark_NormalTree_Normal.png', rect: [0, 0, 2048, 2048], meters: 1.4, along: 'v', roughnessValue: .9, seam: '' },
      plaster: { color: 'mvmk/T_Plaster_BaseColor.png', normal: 'mvmk/T_Plaster_Normal.png', orm: 'mvmk/T_Plaster_ORM.png', rect: [0, 0, 2048, 2048], meters: 2, seam: '' },
      // Стены: собственный цвет фактур Village, без перекраски.
      'wall-stone': { color: 'mvmk/T_UnevenBrick_BaseColor.png', normal: 'mvmk/T_UnevenBrick_Normal.png', roughness: 'mvmk/T_UnevenBrick_Roughness.png', rect: [0, 0, 2048, 2048], meters: 2, seam: '', neutral: false },
      'wall-brick': { color: 'mvmk/T_RedBrick_BaseColor.png', normal: 'mvmk/T_Brick_Normal.png', roughness: 'mvmk/T_Brick_Roughness.png', rect: [0, 0, 2048, 2048], meters: 2, seam: '', neutral: false },
      'wall-ashlar': { color: 'mvmk/T_Brick_BaseColor.png', normal: 'mvmk/T_Brick_Normal.png', roughness: 'mvmk/T_Brick_Roughness.png', rect: [0, 0, 2048, 2048], meters: 2, seam: '', neutral: false },
      'wall-plaster': { color: 'mvmk/T_Plaster_BaseColor.png', normal: 'mvmk/T_Plaster_Normal.png', orm: 'mvmk/T_Plaster_ORM.png', rect: [0, 0, 2048, 2048], meters: 2, seam: '', neutral: false },
      'wall-planks': { color: 'fpmk/T_Trim_Furniture_BaseColor.png', normal: 'fpmk/T_Trim_Furniture_Normal.png', orm: 'fpmk/T_Trim_Furniture_ORM.png', rect: [0, 165, 2048, 680], meters: 1.6, seam: 'y', neutral: false },
      'wall-timber': { color: 'mvmk/T_WoodTrim_BaseColor.png', normal: 'mvmk/T_WoodTrim_Normal.png', roughness: 'mvmk/T_WoodTrim_Roughness.png', rect: [0, 640, 2048, 620], meters: 1.2, seam: 'y', neutral: false },
      'wall-log': { color: 'snmk/Bark_NormalTree.png', normal: 'snmk/Bark_NormalTree_Normal.png', rect: [0, 0, 2048, 2048], meters: 1.4, roughnessValue: .9, seam: '', neutral: false },
      // Крыши: глиняная черепица Village; деревянным домам — доски стен.
      'roof-tiles': { color: 'mvmk/T_RoundTiles_BaseColor.png', normal: 'mvmk/T_RoundTiles_Normal.png', roughness: 'mvmk/T_RoundTiles_Roughness.png', rect: [0, 0, 2048, 2048], meters: 2, seam: '', neutral: false },
    },
    // Виды стен доски. Клетка — 1,5 м, стена в разрезе — 0,95 клетки.
    walls: {
      stone: { material: 'wall-stone', cells: 1.2 },
      brick: { material: 'wall-brick', cells: 1 },
      fortress: { material: 'wall-ashlar', cells: 1.5 },
      plaster: { material: 'wall-plaster', cells: 1.6 },
      planks: { material: 'wall-planks', cells: 1.4 },
      timber: { material: 'wall-timber', cells: 1 },
      log: { material: 'wall-log', cells: .8 },
      iron: { material: 'metal', cells: .8 },
      // Скаты крыш: повтор по длине конька; по скату — с пропорцией фактуры.
      tiles: { material: 'roof-tiles', cells: 1.7 },
      shingles: { material: 'wall-planks', cells: 1.2 },
    },
    props: PROPS,
  },
})

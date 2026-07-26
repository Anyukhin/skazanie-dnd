// @ts-check
/**
 * Раскладка листов штампов реквизита.
 *
 * Лист — это одна картинка с несколькими предметами в ровной сетке; порядок
 * чтения слева направо и сверху вниз. Промпты, которыми листы сгенерированы, и
 * описание каждого предмета — в `docs/prop-stamps-prompts.md`,
 * `docs/prop-stamps-expansion-prompts.md` и `docs/prop-stamps-expansion-2-prompts.md`.
 * Здесь лежит только то, что нужно нарезке: файл, сетка и порядок
 * идентификаторов реестра.
 *
 * Пустые ячейки в конце листа не перечисляются: идентификаторы кончились —
 * значит, остаток кадра пуст. Нарезка это проверяет по картинке и падает, если
 * непустых ячеек оказалось не столько, сколько идентификаторов.
 *
 * Сами листы лежат **вне репозитория** (`assets-src/` в `.gitignore`), поэтому
 * каталог задаётся ключом `--sheets`. В репозиторий попадает только собранный
 * атлас.
 */

export const DEFAULT_SHEET_DIR = 'assets-src/prop-stamps'

/**
 * @typedef {object} StampSheet
 * @property {string} file
 * @property {{cols: number, rows: number}} grid
 * @property {string[]} ids в порядке чтения
 * @property {string} [dir] свой каталог от корня репозитория; по умолчанию — общий
 */

/** @type {ReadonlyArray<StampSheet>} */
export const PROP_STAMP_SHEETS = Object.freeze([
  {
    file: 'sheet-01-hall-wide.png',
    grid: { cols: 3, rows: 3 },
    ids: ['bar_counter', 'bar_shelf', 'table_long', 'fireplace', 'bench', 'bookshelf', 'barrel_stack'],
  },
  {
    file: 'sheet-02-furniture.png',
    grid: { cols: 3, rows: 3 },
    ids: ['table_small', 'chair', 'stool', 'barrel', 'keg', 'crate', 'chest', 'cupboard', 'night_table'],
  },
  {
    file: 'sheet-03-utility.png',
    grid: { cols: 3, rows: 3 },
    ids: ['crate_stack', 'sack', 'basket', 'bucket', 'broom', 'candelabra', 'washbasin', 'cauldron', 'firewood_stack'],
  },
  {
    file: 'sheet-04-tableware.png',
    grid: { cols: 4, rows: 4 },
    ids: ['mug', 'plate', 'bowl_stew', 'bottle', 'jug', 'bread_loaf', 'cheese_wheel', 'candle', 'dice_cup', 'coin_pile', 'lute', 'cutting_board', 'pot'],
  },
  {
    file: 'sheet-05-rooms-wide.png',
    grid: { cols: 3, rows: 3 },
    ids: ['bed', 'bunk_bed', 'wardrobe', 'shelf_wall', 'stairs_up', 'stairs_down', 'woodpile', 'cart', 'water_trough'],
  },
  {
    file: 'sheet-06-decals.png',
    grid: { cols: 3, rows: 3 },
    ids: ['torch_wall', 'lantern_wall', 'banner', 'sign_board', 'rug', 'floor_stain', 'trapdoor', 'hearth_fire'],
  },
  {
    file: 'sheet-07-large.png',
    grid: { cols: 2, rows: 2 },
    ids: ['table_round', 'tree_oak', 'well', 'haystack'],
  },
  {
    file: 'sheet-08-yard-nature.png',
    grid: { cols: 3, rows: 3 },
    ids: ['tree_pine', 'tree_birch', 'tree_dead', 'tree_stump', 'bush', 'shrub', 'rock_small', 'boulder', 'campfire'],
  },
  {
    file: 'sheet-10-yard-small.png',
    grid: { cols: 3, rows: 3 },
    ids: ['wagon_wheel', 'hitching_post', 'lamp_post', 'signpost', 'grass_tuft', 'flowers', 'path_stone'],
  },
  {
    file: 'sheet-11-temple.png',
    grid: { cols: 3, rows: 3 },
    ids: ['pillar', 'altar', 'statue', 'brazier', 'offering_bowl', 'prayer_bench', 'temple_banner', 'reliquary', 'mosaic'],
  },
  {
    file: 'sheet-12-crypt-cave.png',
    grid: { cols: 3, rows: 3 },
    ids: ['sarcophagus', 'grave', 'bone_pile', 'urn', 'crypt_niche', 'cobweb', 'stalagmite', 'cave_pool', 'mushroom_cluster'],
  },
  {
    file: 'sheet-13-wild-settlement.png',
    grid: { cols: 3, rows: 3 },
    ids: ['ore_vein', 'rubble_heap', 'tree_spruce', 'fallen_log', 'fern', 'milestone', 'roadside_shrine', 'market_stall', 'village_fence'],
  },
  // Листы 14–22 сгенерированы, но записей реестра под них ещё нет: тема
  // подземелья, шахты, лагеря, лаборатории, канализации, порта, снега, пустыни
  // и болота — отдельный шаг. Нарезка их пропускает и говорит об этом вслух,
  // а не молча кладёт в атлас спрайты, которых никто не нарисует.
  {
    file: 'sheet-14-dungeon-hazards.png',
    grid: { cols: 3, rows: 3 },
    ids: ['portcullis', 'prison_cage', 'torture_rack', 'iron_maiden', 'manacle_post', 'spike_pit', 'pressure_plate', 'blade_trap', 'tripwire_bells'],
  },
  {
    file: 'sheet-15-depths-mine.png',
    grid: { cols: 3, rows: 3 },
    ids: ['cavern_chasm', 'rope_bridge', 'mine_rail', 'mine_cart', 'timber_shoring', 'crystal_cluster', 'giant_fungus', 'spore_cloud', 'obsidian_monolith'],
  },
  {
    file: 'sheet-16-military-camp.png',
    grid: { cols: 3, rows: 3 },
    ids: ['command_tent', 'scout_tent', 'bedroll_cluster', 'weapon_rack', 'shield_rack', 'training_dummy', 'mantlet', 'spiked_beam_barrier', 'ballista'],
  },
  {
    file: 'sheet-17-arcane-lab.png',
    grid: { cols: 3, rows: 3 },
    ids: ['alchemy_table', 'alchemy_cauldron', 'book_lectern', 'crystal_orb', 'ritual_circle', 'arcane_stone', 'potion_cabinet', 'magic_mirror', 'arcane_coil'],
  },
  {
    file: 'sheet-18-sewer-undercity.png',
    grid: { cols: 3, rows: 3 },
    ids: ['sewer_grate', 'drain_channel', 'slime_puddle', 'refuse_heap', 'broken_pipe', 'sluice_gate', 'maintenance_ladder', 'plank_crossing', 'valve_wheel'],
  },
  {
    file: 'sheet-19-harbor-docks.png',
    grid: { cols: 3, rows: 3 },
    ids: ['rowboat', 'anchor', 'capstan', 'mooring_bollard', 'cargo_net', 'fishing_crates', 'dock_crane', 'lobster_cage', 'sail_bundle'],
  },
  {
    file: 'sheet-20-snow-ice.png',
    grid: { cols: 3, rows: 3 },
    ids: ['snowdrift', 'ice_patch', 'frozen_pool', 'ice_pillars', 'snowy_boulder', 'cargo_sled', 'snowshoe_pair', 'winter_cache', 'snow_cairn'],
  },
  {
    file: 'sheet-21-desert-ruins.png',
    grid: { cols: 3, rows: 3 },
    ids: ['sand_dune', 'desert_boulders', 'cactus_cluster', 'dead_scrub', 'oasis_pool', 'sandstone_arch', 'broken_obelisk', 'nomad_tent', 'desert_fire_bowl'],
  },
  {
    file: 'sheet-22-swamp-marsh.png',
    grid: { cols: 3, rows: 3 },
    ids: ['bog_pool', 'lily_pad_cluster', 'mangrove_roots', 'reed_cluster', 'rotten_log', 'mud_patch', 'swamp_boardwalk', 'swamp_totem', 'peat_mound'],
  },
  // Лист проёмов идёт из набора пола и стен (`docs/floor-wall-stamps-prompts.md`),
  // но режется тем же инструментом и попадает в тот же атлас: это такие же
  // спрайты, только рисуются они не на клетке, а на ребре.
  {
    file: 'sheet-23-openings.png',
    dir: 'assets-src/floor-wall-stamps',
    grid: { cols: 3, rows: 3 },
    ids: ['door_closed', 'door_open', 'door_iron', 'door_broken', 'window_glazed', 'arrow_slit', 'rail_fence', 'ledge_step', 'portcullis_gate'],
  },
])

/**
 * Разрешение спрайта задаётся футпринтом: предмет на две клетки хранится вдвое
 * крупнее предмета на одну. Но рисунок не обязан совпадать с футпринтом —
 * ковёр не занимает ни клетки, а рисуется на три. Такие записи перечислены
 * здесь: число — сколько клеток занимает **рисунок** по длинной стороне
 * (значения повторяют `visual` из библиотеки рисунков `src/board-render.ts`).
 * Всё, чего здесь нет, хранится из расчёта одной клетки.
 */
export const DRAWN_CELLS = Object.freeze({
  rug: 3,
  mosaic: 2,
  banner: 1.3,
  temple_banner: 1.3,
  floor_stain: 1.15,
  sign_board: 1.1,
})

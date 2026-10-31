//! Перенос `server/detail-props.mjs`: предметы набора детализации карт
//! (`public/assets/maps/detail-v1`).
//!
//! Только игровая сторона: какую клетку предмет занимает, держит ли шаг и
//! взгляд, даёт ли укрытие и в каких помещениях он уместен. Темы — назначения
//! комнат (`forge`, `kitchen`, `prison`…), а не темы сцены; исключение —
//! `temple` и уличная природа. `alias` — ближайший прежний предмет: его вектор
//! и процедурная модель — запасной вид. Все предметы набора неинтерактивны.

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Площадь предмета в клетках; 0×0 — плоский штамп без клетки.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Footprint {
    pub w: i64,
    pub h: i64,
}

/// Допустимый разброс масштаба рисунка.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ScaleRange {
    #[serde(serialize_with = "crate::util::ser_js_number")]
    pub min: f64,
    #[serde(serialize_with = "crate::util::ser_js_number")]
    pub max: f64,
}

/// Предмет набора детализации.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailProp {
    pub id: &'static str,
    pub themes: &'static [&'static str],
    pub footprint: Footprint,
    /// `center`, `wall` или `corner`.
    pub anchor: &'static str,
    /// `prop` или `decal`.
    pub kind: &'static str,
    pub blocks_move: bool,
    pub blocks_sight: bool,
    /// `none`, `half` или `three_quarters`.
    pub cover: &'static str,
    /// Прежний предмет с вектором и процедурной моделью.
    pub alias: &'static str,
    pub scale_range: ScaleRange,
}

impl DetailProp {
    /// Форма JSON, которую пишет JS.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

const TEMPLE: &[&str] = &["temple"];
/// Храмовое, что уместно и в склепе: свет, подношения, постамент.
const TEMPLE_AND_CRYPT: &[&str] = &["temple", "crypt"];
const WILD: &[&str] = &["forest", "road", "settlement", "exterior", "graveyard"];

/// Короткая запись: `id, темы, Ш×Г, флаги, псевдоним`. Флаги: `m` — держит
/// шаг, `s` — заслоняет взгляд (укрытие три четверти), `c` — половинное
/// укрытие, `w` — к стене, `k` — в угол, `d` — плоский штамп на полу.
fn detail(
    id: &'static str,
    themes: &'static [&'static str],
    (w, h): (i64, i64),
    flags: &str,
    alias: &'static str,
    scale: Option<(f64, f64)>,
) -> DetailProp {
    let (min, max) = scale.unwrap_or((0.92, 1.06));
    let blocks_sight = flags.contains('s');
    DetailProp {
        id,
        themes,
        footprint: Footprint { w, h },
        anchor: if flags.contains('w') {
            "wall"
        } else if flags.contains('k') {
            "corner"
        } else {
            "center"
        },
        kind: if flags.contains('d') { "decal" } else { "prop" },
        blocks_move: flags.contains('m'),
        blocks_sight,
        cover: if blocks_sight {
            "three_quarters"
        } else if flags.contains('c') {
            "half"
        } else {
            "none"
        },
        alias,
        scale_range: ScaleRange { min, max },
    }
}

type Row = (&'static str, &'static [&'static str], (i64, i64), &'static str, &'static str, Option<(f64, f64)>);

#[rustfmt::skip]
const ROWS: &[Row] = &[
    // --- Кузня и мастерская ------------------------------------------------
    ("forge", &["forge"], (2, 2), "mswc", "fireplace", None),
    ("anvil", &["forge"], (1, 1), "mc", "milestone", None),
    ("quench_tub", &["forge"], (1, 1), "mc", "bucket", None),
    ("coal_pile", &["forge"], (1, 1), "wc", "rubble_heap", None),
    ("grindstone", &["forge", "workshop"], (1, 1), "mc", "wagon_wheel", None),
    ("tool_rack", &["forge", "workshop"], (2, 1), "mw", "shelf_wall", None),
    ("workbench", &["forge", "workshop"], (2, 1), "mcw", "table_long", None),
    ("sawhorse", &["workshop", "farm"], (2, 1), "m", "bench", None),
    ("lumber_pile", &["workshop", "farm"], (2, 1), "mcw", "woodpile", None),
    ("sawdust", &["workshop"], (0, 0), "d", "floor_stain", None),
    // --- Кухня -------------------------------------------------------------
    ("kitchen_stove", &["kitchen"], (2, 1), "mcw", "fireplace", None),
    ("bread_oven", &["kitchen"], (2, 2), "mswk", "fireplace", None),
    ("butcher_block", &["kitchen"], (1, 1), "mc", "table_small", None),
    ("prep_table", &["kitchen"], (2, 1), "mc", "table_long", None),
    ("pantry_shelf", &["kitchen"], (2, 1), "msw", "cupboard", None),
    ("hanging_pots", &["kitchen"], (2, 1), "w", "shelf_wall", None),
    ("spice_crates", &["kitchen", "shop"], (1, 1), "mcw", "crate", None),
    ("washtub", &["kitchen"], (1, 1), "mw", "bucket", None),
    ("water_barrel", &["kitchen", "barracks"], (1, 1), "mcw", "barrel", None),
    ("flour_spill", &["kitchen", "farm"], (0, 0), "d", "floor_stain", None),
    // --- Спальня и кабинет -------------------------------------------------
    ("double_bed", &["bedroom"], (2, 2), "mcw", "bed", None),
    ("dresser", &["bedroom"], (2, 1), "mcw", "cupboard", None),
    ("armchair", &["bedroom", "study"], (1, 1), "m", "chair", None),
    ("bathtub", &["bedroom"], (2, 1), "mcw", "water_trough", None),
    ("coat_rack", &["bedroom"], (1, 1), "mk", "broom", None),
    ("cradle", &["bedroom"], (1, 1), "m", "chest", None),
    ("folding_screen", &["bedroom"], (2, 1), "ms", "village_fence", None),
    ("standing_mirror", &["bedroom"], (1, 1), "mw", "sign_board", None),
    ("writing_desk", &["bedroom", "study"], (2, 1), "mcw", "table_small", None),
    ("candle_desk", &["study"], (2, 1), "mcw", "table_small", None),
    ("bookcase_tall", &["study"], (2, 1), "msw", "bookshelf", None),
    ("scroll_rack", &["study"], (2, 1), "msw", "bookshelf", None),
    ("book_lectern", &["study", "temple"], (1, 1), "m", "reliquary", None),
    ("globe", &["study"], (1, 1), "m", "urn", None),
    ("map_table", &["study", "barracks"], (2, 2), "mc", "table_round", None),
    ("reading_nook", &["study"], (2, 1), "mw", "bench", None),
    ("strongbox", &["study", "prison", "crypt"], (1, 1), "mcw", "chest", None),
    ("telescope", &["study"], (1, 1), "m", "signpost", None),
    ("paper_scatter", &["study"], (0, 0), "d", "floor_stain", None),
    // --- Ковры и шкуры -----------------------------------------------------
    ("rug_blue", &["bedroom", "study"], (0, 0), "d", "rug", None),
    ("rug_round", &["bedroom", "study"], (0, 0), "d", "rug", None),
    ("rug_red_large", &["hall", "study"], (0, 0), "d", "rug", Some((1.1, 1.25))),
    ("rug_runner", &["hall", "temple"], (0, 0), "d", "rug", None),
    ("bear_pelt", &["bedroom", "hall"], (0, 0), "d", "rug", None),
    ("hide_rug", &["bedroom", "hall"], (0, 0), "d", "rug", None),
    ("wolf_pelt", &["bedroom", "barracks"], (0, 0), "d", "rug", None),
    ("prayer_rug", &["temple"], (0, 0), "d", "rug", None),
    ("straw_mat", &["prison", "barracks"], (0, 0), "d", "rug", None),
    // --- Казарма -----------------------------------------------------------
    ("barracks_bed", &["barracks"], (1, 2), "mcw", "bed", None),
    ("footlocker", &["barracks", "prison"], (1, 1), "mcw", "chest", None),
    ("armor_stand", &["barracks"], (1, 1), "mw", "statue", None),
    ("weapon_rack_wall", &["barracks", "prison"], (2, 1), "w", "shelf_wall", None),
    ("training_dummy", &["barracks"], (1, 1), "m", "statue", None),
    ("archery_target", &["barracks"], (1, 1), "mw", "sign_board", None),
    ("ammo_crates", &["barracks"], (2, 1), "mcw", "crate_stack", None),
    ("war_table", &["barracks"], (2, 2), "mc", "table_round", None),
    ("guard_brazier", &["barracks", "prison"], (1, 1), "m", "brazier", None),
    // --- Темница -----------------------------------------------------------
    ("straw_bed", &["prison"], (1, 2), "w", "bed", None),
    ("cell_bucket", &["prison"], (1, 1), "k", "bucket", None),
    ("wall_chains", &["prison"], (1, 1), "w", "shelf_wall", None),
    ("iron_cage", &["prison"], (1, 1), "mck", "crate", None),
    ("jailer_desk", &["prison"], (1, 1), "mc", "table_small", None),
    ("torture_rack", &["prison"], (2, 1), "mc", "table_long", None),
    ("stocks", &["prison", "street"], (2, 1), "mc", "village_fence", None),
    ("bone_heap", &["prison", "crypt"], (0, 0), "", "bone_pile", None),
    ("drain_grate", &["prison"], (0, 0), "d", "path_stone", None),
    ("straw_scatter", &["prison", "farm"], (0, 0), "d", "floor_stain", None),
    ("scorch_mark", &["prison", "forge"], (0, 0), "d", "floor_stain", None),
    // --- Храм --------------------------------------------------------------
    ("idol", TEMPLE, (2, 2), "msw", "statue", None),
    ("holy_pool", TEMPLE, (2, 2), "m", "cave_pool", None),
    ("font_basin", TEMPLE, (1, 1), "mc", "washbasin", None),
    ("incense_burner", TEMPLE_AND_CRYPT, (1, 1), "m", "brazier", None),
    ("kneeling_cushions", TEMPLE, (2, 1), "", "prayer_bench", None),
    ("candle_rack", TEMPLE_AND_CRYPT, (2, 1), "mw", "candelabra", None),
    ("offering_table", TEMPLE_AND_CRYPT, (2, 1), "mcw", "altar", None),
    ("temple_lectern", TEMPLE, (1, 1), "m", "reliquary", None),
    ("bell_frame", TEMPLE, (2, 1), "m", "roadside_shrine", None),
    // --- Лавка -------------------------------------------------------------
    ("shop_counter", &["shop"], (3, 1), "mc", "bar_counter", None),
    ("display_shelf", &["shop"], (2, 1), "msw", "bookshelf", None),
    ("scales_table", &["shop"], (1, 1), "mc", "table_small", None),
    ("cloth_bolts", &["shop"], (1, 1), "mcw", "basket", None),
    ("goods_baskets", &["shop", "street"], (1, 1), "mw", "basket", None),
    ("pottery_stand", &["shop", "street"], (1, 1), "mcw", "urn", None),
    ("grain_sacks", &["shop", "farm"], (1, 1), "mcw", "sack", None),
    ("crate_stack_goods", &["shop", "street"], (2, 2), "mswk", "crate_stack", None),
    // --- Двор, мельница, огород --------------------------------------------
    ("hay_bales", &["farm"], (2, 1), "mcw", "haystack", None),
    ("chicken_coop", &["farm"], (2, 1), "mcw", "crate_stack", None),
    ("garden_bed", &["farm"], (2, 1), "", "flowers", None),
    ("scarecrow", &["farm"], (1, 1), "m", "signpost", None),
    ("rain_barrel", &["farm", "street"], (1, 1), "mcw", "barrel", None),
    ("flour_bin", &["farm"], (1, 1), "mcw", "chest", None),
    ("millstone", &["farm"], (2, 2), "mc", "wagon_wheel", None),
    ("water_wheel", &["farm"], (1, 3), "msw", "wagon_wheel", None),
    ("fence_gate", &["farm"], (1, 1), "m", "village_fence", None),
    ("flower_bed", &["farm", "street"], (2, 1), "", "flowers", None),
    // --- Улица и площадь ---------------------------------------------------
    ("fountain", &["street"], (3, 3), "mc", "well", None),
    ("town_well", &["street"], (2, 2), "mc", "well", None),
    ("market_awning", &["street"], (3, 2), "mc", "market_stall", None),
    ("fruit_cart", &["street"], (2, 1), "mc", "cart", None),
    ("notice_board", &["street"], (1, 1), "m", "sign_board", None),
    ("sign_post_city", &["street"], (1, 1), "m", "signpost", None),
    ("pillory", &["street"], (2, 1), "mc", "village_fence", None),
    ("statue_plinth", &["street", "temple", "crypt"], (2, 2), "ms", "statue", None),
    ("street_planter", &["street"], (1, 1), "mc", "bush", None),
    // --- Река и пристань ---------------------------------------------------
    ("mooring_post", &["harbor"], (1, 1), "m", "hitching_post", None),
    ("fish_rack", &["harbor"], (2, 1), "mw", "village_fence", None),
    ("fishing_nets", &["harbor"], (2, 1), "w", "village_fence", None),
    ("rowboat", &["harbor"], (1, 3), "mc", "fallen_log", None),
    ("punt", &["harbor"], (1, 3), "mc", "fallen_log", None),
    ("stone_steps", &["harbor"], (2, 1), "", "path_stone", None),
    ("reeds", &["harbor"], (0, 0), "d", "grass_tuft", None),
    ("river_rocks", &["harbor"], (0, 0), "d", "path_stone", None),
    ("lily_pads", &["harbor"], (0, 0), "d", "flowers", None),
    // --- Дикая природа и скалы ---------------------------------------------
    ("mossy_rock", WILD, (1, 1), "mc", "boulder", None),
    ("rock_cluster", WILD, (2, 2), "ms", "boulder", None),
    ("boulder_split", WILD, (2, 2), "ms", "boulder", None),
    ("dead_bramble", WILD, (1, 1), "c", "bush", None),
    ("root_tangle", WILD, (2, 1), "c", "fallen_log", None),
    ("scree", WILD, (0, 0), "d", "path_stone", None),
    ("pebbles", WILD, (0, 0), "d", "path_stone", None),
    ("leaf_litter", WILD, (0, 0), "d", "fern", None),
    ("cliff_medium", &["cliff"], (2, 2), "ms", "boulder", None),
    ("cliff_large", &["cliff"], (3, 3), "ms", "boulder", None),
    ("cliff_long", &["cliff"], (3, 1), "ms", "boulder", None),
    // --- Следы на полу -----------------------------------------------------
    ("wine_stain", &["hall"], (0, 0), "d", "floor_stain", None),
    ("floor_crack", &["prison", "hall"], (0, 0), "d", "floor_stain", None),
    // --- Расширение реквизита PR104 и наборов Quaternius -------------------
    // Эти виды только оформляют сцену: интерактивность и игровые состояния
    // для них намеренно отсутствуют. Большие объекты получают footprint здесь,
    // а не из GLB, чтобы 2D и 3D занимали одну и ту же площадь.
    ("ballista", &["barracks", "workshop", "siege"], (2, 2), "mc", "village_fence", None),
    ("command_tent", &["barracks", "camp"], (2, 2), "mc", "haystack", None),
    ("alchemy_table", &["study", "kitchen", "workshop"], (2, 1), "mc", "table_long", None),
    ("dock_crane", &["harbor"], (2, 2), "m", "well", None),
    ("mine_cart", &["mine", "cave", "dungeon"], (1, 1), "mc", "cart", None),
    ("crystal_orb", &["study", "temple"], (1, 1), "mc", "offering_bowl", Some((0.7, 1.1))),
    ("giant_fungus", &["cave", "forest", "graveyard", "swamp"], (2, 2), "mc", "mushroom_cluster", Some((0.7, 1.3))),
    ("mantlet", &["barracks", "siege"], (2, 1), "m", "village_fence", None),
    ("cargo_sled", &["winter"], (2, 1), "mc", "cart", None),
    // Низкая полка (модель ~0,7 клетки): держит шаг, но взгляд поверх неё виден.
    ("arch_shelf", &["study", "shop", "temple"], (2, 1), "mw", "shelf_wall", None),
    ("cutlery_set", &["kitchen", "hall", "study"], (0, 0), "", "plate", Some((1.2, 1.8))),
    ("tool_peg_rack", &["forge", "workshop", "barracks"], (2, 1), "w", "shelf_wall", None),
    ("chain_coil", &["forge", "workshop", "prison", "mine", "crypt"], (0, 0), "", "rubble_heap", None),
    ("book_piles", &["study", "bedroom", "temple"], (0, 0), "", "mug", Some((0.9, 1.4))),
    ("crystal_cluster", &["cave", "mine", "dungeon"], (1, 1), "mc", "boulder", Some((0.8, 1.25))),
    ("nomad_tent", &["desert", "camp"], (2, 2), "mc", "haystack", None),
    ("obsidian_monolith", &["cave", "dungeon", "graveyard", "temple", "crypt"], (1, 1), "msc", "pillar", None),
    ("weapon_rack", &["barracks", "workshop", "prison"], (2, 1), "w", "shelf_wall", None),
    ("scout_tent", &["camp", "barracks"], (2, 2), "mc", "haystack", None),
    ("timber_shoring", &["mine", "cave", "dungeon"], (2, 1), "w", "village_fence", None),
    ("mine_rail", &["mine", "cave"], (0, 0), "d", "path_stone", None),
    ("shield_display", &["barracks", "workshop", "study", "temple"], (0, 0), "w", "shelf_wall", None),
    ("arcane_coil", &["study", "forge", "workshop"], (0, 0), "", "offering_bowl", Some((0.8, 1.2))),
    ("alchemy_bottles", &["study", "shop", "kitchen"], (0, 0), "", "bottle", Some((0.9, 1.3))),
    ("desk_candlestick", &["study", "temple", "hall"], (0, 0), "", "candle", Some((0.8, 1.2))),
    ("single_book", &["study", "temple"], (0, 0), "", "mug", Some((1.1, 1.7))),
    // Настенная полочка с флаконами, как и её двойник shelf_wall, прохода не держит.
    ("vial_display_shelf", &["study", "shop", "kitchen"], (2, 1), "w", "shelf_wall", None),
    ("ceremonial_chalice", &["temple", "study"], (0, 0), "", "offering_bowl", Some((0.9, 1.4))),
    ("book_row", &["study", "temple"], (0, 0), "", "mug", Some((0.9, 1.3))),
    ("scroll_pile", &["study", "temple"], (0, 0), "", "mug", Some((1.1, 1.7))),
    ("rope_coils", &["harbor", "workshop"], (0, 0), "", "woodpile", None),
    ("capstan", &["harbor"], (1, 1), "mc", "well", None),
    ("snowshoe_pair", &["winter"], (0, 0), "", "mug", None),
    ("anchor", &["harbor"], (1, 1), "m", "milestone", None),
    ("clover_patch", &["forest", "road", "settlement", "exterior", "graveyard"], (0, 0), "d", "flowers", None),
    ("forest_plant", &["forest", "road", "settlement", "exterior", "graveyard"], (0, 0), "d", "fern", None),
    ("mangrove_roots", &["swamp", "forest", "exterior"], (2, 2), "c", "fallen_log", None),
    ("wall_ivy", &["settlement", "exterior", "graveyard", "crypt"], (0, 0), "dw", "cobweb", None),
    ("wall_ivy_corner", &["settlement", "exterior", "graveyard", "crypt"], (0, 0), "dk", "cobweb", None),
    ("wall_ivy_wide", &["settlement", "exterior", "graveyard", "crypt"], (0, 0), "dw", "cobweb", None),
    ("key_bundle", &["study", "shop", "prison"], (0, 0), "", "mug", Some((1.4, 2.2))),
    ("coin_pouch", &["study", "shop", "hall"], (0, 0), "", "coin_pile", Some((0.8, 1.3))),
    // --- Подготовленные штампы, получившие модели стиля (2026-10-04) --------
    // 2D — прежний штамп набора, 3D — рецепт `tools/map-detail-models-frontier.mjs`
    // в пакете стиля. Только оформление: лёд не скользит, вода в луже не мочит,
    // клетка и шипы не ранят — для этого нужны отдельные правила.
    // Зима.
    ("snowdrift", &["winter"], (0, 0), "d", "floor_stain", None),
    ("snowy_boulder", &["winter"], (1, 1), "mc", "boulder", None),
    ("ice_pillars", &["winter"], (1, 1), "mc", "stalagmite", None),
    ("frozen_pool", &["winter"], (1, 1), "", "cave_pool", None),
    ("winter_cache", &["winter", "camp"], (1, 1), "mc", "crate", None),
    ("snow_cairn", &["winter"], (1, 1), "mc", "milestone", None),
    // Пустыня.
    ("sand_dune", &["desert"], (0, 0), "d", "floor_stain", None),
    ("desert_boulders", &["desert"], (1, 1), "mc", "boulder", None),
    ("cactus_cluster", &["desert"], (1, 1), "mc", "bush", None),
    ("dead_scrub", &["desert"], (1, 1), "c", "bush", None),
    ("oasis_pool", &["desert"], (1, 1), "", "cave_pool", None),
    ("broken_obelisk", &["desert"], (1, 1), "mc", "pillar", None),
    // Болото.
    ("bog_pool", &["swamp"], (1, 1), "", "cave_pool", None),
    ("lily_pad_cluster", &["swamp"], (0, 0), "d", "fern", None),
    ("reed_cluster", &["swamp"], (1, 1), "c", "grass_tuft", None),
    ("rotten_log", &["swamp"], (2, 1), "mc", "fallen_log", None),
    ("mud_patch", &["swamp"], (0, 0), "d", "floor_stain", None),
    ("swamp_totem", &["swamp"], (1, 1), "m", "signpost", None),
    ("peat_mound", &["swamp"], (1, 1), "c", "rubble_heap", None),
    // Гавань.
    ("mooring_bollard", &["harbor"], (1, 1), "mc", "hitching_post", None),
    ("cargo_net", &["harbor"], (1, 1), "mc", "sack", None),
    ("fishing_crates", &["harbor"], (1, 1), "mc", "crate", None),
    ("lobster_cage", &["harbor"], (1, 1), "mc", "basket", None),
    ("sail_bundle", &["harbor"], (0, 0), "", "woodpile", None),
    // Военный лагерь.
    ("bedroll_cluster", &["camp", "barracks"], (0, 0), "", "sack", None),
    ("shield_rack", &["camp", "barracks"], (1, 1), "mc", "shelf_wall", None),
    ("camp_dummy", &["camp", "barracks"], (1, 1), "m", "statue", None),
    ("spiked_beam_barrier", &["camp", "siege"], (1, 1), "mc", "village_fence", None),
    // Лаборатория мага.
    ("alchemy_cauldron", &["arcane"], (1, 1), "mc", "cauldron", None),
    ("arcane_lectern", &["arcane"], (1, 1), "m", "reliquary", None),
    ("ritual_circle", &["arcane"], (0, 0), "d", "mosaic", None),
    ("arcane_stone", &["arcane"], (1, 1), "", "mosaic", None),
    ("potion_cabinet", &["arcane"], (1, 1), "msw", "cupboard", None),
    ("magic_mirror", &["arcane"], (1, 1), "mw", "cupboard", None),
    // Темница.
    ("prison_cage", &["prison"], (1, 1), "mc", "crate", None),
    ("dungeon_rack", &["prison"], (2, 1), "mc", "table_long", None),
    ("iron_maiden", &["prison"], (1, 1), "msw", "wardrobe", None),
    ("manacle_post", &["prison"], (1, 1), "mc", "pillar", None),
];

/// Предметы набора детализации (`DETAIL_PROPS`), в порядке объявления.
pub static DETAIL_PROPS: LazyLock<Vec<DetailProp>> =
    LazyLock::new(|| ROWS.iter().map(|&(id, themes, size, flags, alias, scale)| detail(id, themes, size, flags, alias, scale)).collect());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_form_expands_like_js() {
        let forge = DETAIL_PROPS.iter().find(|prop| prop.id == "forge").expect("кузня");
        assert_eq!(forge.anchor, "wall");
        assert_eq!(forge.cover, "three_quarters");
        assert!(forge.blocks_move && forge.blocks_sight);
        let ivy = DETAIL_PROPS.iter().find(|prop| prop.id == "wall_ivy_corner").expect("плющ");
        assert_eq!((ivy.kind, ivy.anchor), ("decal", "corner"));
        assert_eq!(DETAIL_PROPS.len(), 206);
    }
}

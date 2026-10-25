//! Перенос `server/prop-placement.mjs`: расстановка предметов по правилам
//! (`docs/tactical-map-plan.md`, стадия 3).
//!
//! Развитие `featureCellScore` из `server/dynamic-map.mjs`: оценка клетки под
//! предмет, притяжение к стене и к столу, доведённые до якорей, поворота,
//! масштаба и плотности на зону. Назначение комнаты (`purpose`) живёт только
//! в заявке на расстановку ([`ZonePlacementPlan`]), на карту попадают обычные
//! предметы. После расстановки — ремонт доступа ([`ensure_prop_access`]),
//! колоннада ([`place_colonnade`]), обещанные сценой предметы
//! ([`place_required_props`]) и опоры утвари ([`attach_prop_supports`]).
//!
//! Всё детерминировано от `seed`: тот же сид даёт ту же расстановку, включая
//! повороты и масштабы. Функции мутируют карту, как JS мутирует её объект.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{js, text, Point};
use sk_scene_base::asset_registry::{asset_by_id, assets_for_theme, AssetEntry};
use sk_tactical::tactical_map::{
    add_prop, cell_at, cell_passable, edge_neighbor, reachable_cells, EdgeKind, MapResult, PropMount, TacticalMap, TacticalMapError,
    TacticalProp,
};

use crate::js_math::js_pow;
use crate::util::{cell_at_floor, edge_at, falsy_number, floor_cell, js_hypot, js_max, SeedRandom};

pub const PROP_PLACEMENT_VERSION: &str = "skazanie:prop-placement-v4";

/// Бюджет предметов по умолчанию (`maxProps = 250`).
pub const DEFAULT_MAX_PROPS: i64 = 250;

/// Порядок раскладки профиля: ряды, собранная группа, стойла.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Arrangement {
    Rows,
    Gathered,
    Stalls,
}

/// Профиль назначения комнаты (`SEMANTIC_PROFILES`). `themes` — назначения
/// набора детализации, которые профиль открывает зоне: кузня видит горн и
/// наковальню, а трактир их не видит.
#[derive(Clone, Copy, Debug)]
pub struct SemanticProfile {
    pub require: &'static [&'static str],
    pub prefer: &'static [&'static str],
    pub themes: &'static [&'static str],
    pub caps: &'static [(&'static str, f64)],
    pub arrangement: Arrangement,
}

macro_rules! profile {
    (require: [$($r:literal),*], prefer: [$($p:literal),*], themes: [$($t:literal),*], caps: {$($ck:ident: $cv:expr),*}, $arr:ident) => {
        SemanticProfile {
            require: &[$($r),*],
            prefer: &[$($p),*],
            themes: &[$($t),*],
            caps: &[$((stringify!($ck), $cv as f64)),*],
            arrangement: Arrangement::$arr,
        }
    };
}

/// Ограниченный словарь назначений комнаты в порядке объекта JS.
#[rustfmt::skip]
pub static SEMANTIC_PROFILES: &[(&str, SemanticProfile)] = &[
    // «Галерея» — общий/военный зал: поверхности для карт, места вокруг них и
    // подвешенный свет из уже зарегистрированных предметов.
    ("gallery", profile!(require: ["table_long"], prefer: ["table_long", "table_small", "chair", "bench", "chandelier", "banner", "candelabra", "rug"], themes: [], caps: {table_long: 2, table_small: 2, chandelier: 1}, Gathered)),
    ("barracks", profile!(require: ["bunk_bed", "bunk_bed", "bunk_bed", "bunk_bed"], prefer: ["bunk_bed", "bed", "night_table", "chest", "wardrobe", "washbasin", "footlocker", "armor_stand", "weapon_rack_wall", "weapon_rack", "shield_display", "ballista", "wolf_pelt", "straw_mat"], themes: ["barracks"], caps: {bunk_bed: 8, bed: 8, table_long: 0, bench: 0, chair: 0, armor_stand: 2, weapon_rack_wall: 2}, Rows)),
    ("mill", profile!(require: ["millstone", "flour_bin", "grain_sacks"], prefer: ["grain_sacks", "flour_bin", "flour_spill", "sack", "crate_stack", "barrel", "basket"], themes: ["farm", "shop"], caps: {millstone: 1, flour_bin: 2, shop_counter: 0, display_shelf: 0, scales_table: 0}, Stalls)),
    // Кузня: горн у стены, рядом наковальня, бочка для закалки и уголь;
    // верстак и стойка инструмента — по стенам.
    ("forge", profile!(require: ["forge", "anvil", "quench_tub", "coal_pile"], prefer: ["tool_rack", "workbench", "grindstone", "tool_peg_rack", "chain_coil", "arcane_coil", "firewood_stack", "barrel", "crate", "scorch_mark"], themes: ["forge", "workshop"], caps: {forge: 1, anvil: 1, quench_tub: 1, coal_pile: 2, workbench: 1, grindstone: 1, fireplace: 0, bed: 0}, Gathered)),
    // Камеры темницы: соломенный тюфяк, ведро в углу, цепи на стене.
    ("cells", profile!(require: ["straw_bed", "cell_bucket"], prefer: ["straw_bed", "cell_bucket", "wall_chains", "prison_cage", "manacle_post", "straw_mat", "straw_scatter", "bone_heap", "floor_crack", "drain_grate"], themes: ["prison"], caps: {straw_bed: 8, iron_cage: 1, torture_rack: 0, jailer_desk: 0, bed: 0, bunk_bed: 0}, Stalls)),
    // Караульная: стол тюремщика, оружие на стене, жаровня и сундучки.
    ("guardroom", profile!(require: ["jailer_desk", "weapon_rack_wall", "guard_brazier"], prefer: ["footlocker", "strongbox", "chair", "stool", "table_small", "barrel", "water_barrel", "map_table", "war_table", "ammo_crates", "training_dummy", "archery_target", "armor_stand"], themes: ["prison", "barracks"], caps: {jailer_desk: 1, guard_brazier: 2, map_table: 1, war_table: 1, weapon_rack_wall: 2, training_dummy: 1, archery_target: 1, armor_stand: 2}, Gathered)),
    // Пыточная: дыба посредине, клетка в углу, цепи и жаровня.
    ("torture", profile!(require: ["torture_rack", "iron_cage", "wall_chains"], prefer: ["guard_brazier", "dungeon_rack", "iron_maiden", "manacle_post", "weapon_rack", "shield_display", "key_bundle", "wall_chains", "scorch_mark", "bone_heap", "stocks", "bucket"], themes: ["prison"], caps: {torture_rack: 1, iron_cage: 2, stocks: 1, dungeon_rack: 1, iron_maiden: 1}, Gathered)),
    // Алтарная: алтарь у стены, курильница и подушки для коленопреклонения
    // перед ним, стойка свечей и стол приношений рядом.
    ("altar", profile!(require: ["altar", "incense_burner", "kneeling_cushions", "candle_rack"], prefer: ["offering_table", "font_basin", "holy_pool", "idol", "crystal_orb", "ceremonial_chalice", "scroll_pile", "book_row", "single_book", "statue", "prayer_rug", "temple_banner", "brazier"], themes: ["temple"], caps: {altar: 1, idol: 1, holy_pool: 1, kneeling_cushions: 3, candle_rack: 2, offering_table: 1, font_basin: 1}, Gathered)),
    // Неф: скамьи рядами, дорожка-ковёр, кафедра и чаша у входа.
    ("nave", profile!(require: ["prayer_bench", "prayer_bench", "temple_lectern"], prefer: ["prayer_bench", "kneeling_cushions", "candle_rack", "ceremonial_chalice", "scroll_pile", "book_row", "rug_runner", "font_basin", "temple_banner", "brazier"], themes: ["temple"], caps: {temple_lectern: 1, font_basin: 1, rug_runner: 1, altar: 0}, Rows)),
    // Обеденный зал усадьбы: длинный стол посредине, стулья вдоль, люстра
    // над ним, ковёр под ним, горка с посудой у стены.
    ("dining", profile!(require: ["table_long", "chair", "chair", "chandelier"], prefer: ["chair", "candelabra", "rug_red_large", "cupboard", "fireplace", "bear_pelt", "wine_stain", "banner"], themes: ["hall"], caps: {table_long: 2, chandelier: 2, fireplace: 1, rug_red_large: 1, bench: 0}, Gathered)),
    // Кабинет: письменный стол, высокие шкафы, глобус и кресло для чтения.
    ("study", profile!(require: ["writing_desk", "bookcase_tall", "armchair"], prefer: ["globe", "alchemy_bottles", "crystal_orb", "arcane_coil", "book_piles", "book_row", "scroll_pile", "single_book", "desk_candlestick", "key_bundle", "coin_pouch", "arch_shelf", "vial_display_shelf", "scroll_rack", "candle_desk", "reading_nook", "map_table", "telescope", "rug_round", "paper_scatter", "strongbox", "book_lectern"], themes: ["study", "bedroom"], caps: {writing_desk: 1, globe: 1, telescope: 1, map_table: 1, bed: 0, bunk_bed: 0}, Gathered)),
    // Торговый зал лавки: прилавок, витрины по стенам, весы и товар.
    ("shop", profile!(require: ["shop_counter", "display_shelf"], prefer: ["display_shelf", "vial_display_shelf", "arch_shelf", "alchemy_bottles", "key_bundle", "coin_pouch", "scales_table", "cloth_bolts", "goods_baskets", "pottery_stand", "spice_crates", "grain_sacks", "crate", "barrel"], themes: ["shop"], caps: {shop_counter: 1, scales_table: 1, display_shelf: 3, bar_counter: 0}, Gathered)),
    // Спальня дома — не казарма: одна-две кровати у стены, сундук, шкаф и
    // тумбочка. Прежде спальня шла профилем казармы и получала по три
    // двухъярусные койки.
    ("bedroom", profile!(require: ["bed", "chest"], prefer: ["bed", "wardrobe", "night_table", "chest", "rug", "washbasin", "candle", "dresser", "coat_rack", "standing_mirror", "rug_blue", "bear_pelt", "armchair", "hide_rug", "folding_screen", "cradle"], themes: ["bedroom"], caps: {bed: 2, bunk_bed: 0, wardrobe: 1, chest: 1, washbasin: 1, rug: 1, table_long: 0, bench: 0, dresser: 1, standing_mirror: 1, coat_rack: 1, double_bed: 1, bathtub: 1, cradle: 1}, Gathered)),
    // Горница жилого дома: очаг, один стол со стульями, посудный шкаф. Не
    // трактирный зал с рядами длинных столов и скамей.
    ("living", profile!(require: ["fireplace", "table_small"], prefer: ["table_small", "chair", "cupboard", "rug", "shelf_wall", "barrel", "basket", "bench", "firewood_stack"], themes: [], caps: {table_long: 0, table_round: 1, table_small: 1, bench: 1, fireplace: 1, cupboard: 1, rug: 1, bar_counter: 0, bar_shelf: 0}, Gathered)),
    // Кухня: плита и хлебная печь у стены, разделочный стол посредине,
    // кастрюли на стене, полки с припасами.
    ("kitchen", profile!(require: ["kitchen_stove", "prep_table", "pantry_shelf"], prefer: ["cupboard", "alchemy_table", "alchemy_bottles", "cutlery_set", "butcher_block", "hanging_pots", "bread_oven", "spice_crates", "washtub", "water_barrel", "cauldron", "barrel", "cutting_board", "pot", "flour_spill"], themes: ["kitchen"], caps: {kitchen_stove: 1, bread_oven: 1, prep_table: 1, butcher_block: 1, hanging_pots: 2}, Gathered)),
    ("store", profile!(require: ["crate_stack", "barrel_stack"], prefer: ["crate_stack", "barrel_stack", "crate", "barrel", "sack", "chain_coil", "rope_coils", "key_bundle", "coin_pouch", "chest", "shelf_wall", "grain_sacks", "spice_crates", "goods_baskets", "crate_stack_goods"], themes: ["shop"], caps: {shop_counter: 0, display_shelf: 0, scales_table: 0, cloth_bolts: 0, pottery_stand: 0}, Stalls)),
    ("stable", profile!(require: ["haystack", "water_trough", "hitching_post"], prefer: ["haystack", "water_trough", "hitching_post", "cart", "sack"], themes: [], caps: {haystack: 1, water_trough: 1, cart: 2, hitching_post: 4, woodpile: 0}, Stalls)),
    ("workshop", profile!(require: ["workbench", "tool_rack"], prefer: ["table_long", "alchemy_table", "tool_peg_rack", "chain_coil", "arcane_coil", "shelf_wall", "crate", "barrel", "chest", "firewood_stack", "candle", "sawhorse", "lumber_pile", "grindstone", "sawdust"], themes: ["workshop"], caps: {workbench: 2, sawhorse: 1, grindstone: 1, table_long: 1}, Gathered)),
    ("courtyard", profile!(require: ["well", "cart"], prefer: ["well", "cart", "hitching_post", "water_trough", "woodpile", "haystack", "tree_oak", "tree_birch", "bush", "rain_barrel", "hay_bales", "flower_bed"], themes: ["farm"], caps: {well: 1, cart: 2, water_trough: 1, haystack: 1, hitching_post: 4, woodpile: 1, campfire: 1}, Gathered)),
    // Обычная улица: только природа и плющ. Палатки, краны, баллисты и сани
    // приходят назначениями ниже, а не случайным добором во дворе.
    ("exterior", profile!(require: [], prefer: ["giant_fungus", "mangrove_roots", "clover_patch", "forest_plant", "wall_ivy", "wall_ivy_corner", "wall_ivy_wide", "tree_oak", "tree_birch", "tree_pine", "bush", "shrub", "rock_small", "boulder", "mossy_rock", "dead_bramble", "root_tangle", "leaf_litter", "rock_cluster", "pebbles"], themes: [], caps: {mangrove_roots: 2, giant_fungus: 2}, Gathered)),
    // Эти назначения не появляются случайно: Архитектор/сцена должны назвать
    // их явно, иначе крупные лагерные и портовые силуэты не засоряют двор.
    ("camp", profile!(require: [], prefer: ["command_tent", "scout_tent", "nomad_tent", "bedroll_cluster", "shield_rack", "camp_dummy", "spiked_beam_barrier", "rope_coils", "weapon_rack", "shield_display"], themes: ["camp", "barracks"], caps: {command_tent: 1, nomad_tent: 1, spiked_beam_barrier: 3}, Gathered)),
    ("winter", profile!(require: [], prefer: ["snowdrift", "snowy_boulder", "ice_pillars", "snow_cairn", "frozen_pool", "winter_cache", "cargo_sled", "snowshoe_pair"], themes: ["winter"], caps: {cargo_sled: 1, winter_cache: 2, frozen_pool: 1}, Gathered)),
    ("siege", profile!(require: [], prefer: ["ballista", "mantlet", "spiked_beam_barrier", "command_tent"], themes: ["siege", "barracks", "camp"], caps: {command_tent: 1}, Gathered)),
    ("harbor", profile!(require: [], prefer: ["dock_crane", "capstan", "anchor", "mooring_bollard", "cargo_net", "fishing_crates", "lobster_cage", "sail_bundle", "rope_coils"], themes: ["harbor"], caps: {dock_crane: 1, capstan: 1, anchor: 1}, Gathered)),
    ("desert", profile!(require: [], prefer: ["sand_dune", "desert_boulders", "cactus_cluster", "dead_scrub", "broken_obelisk", "oasis_pool", "nomad_tent"], themes: ["desert"], caps: {nomad_tent: 1, oasis_pool: 1, broken_obelisk: 1}, Gathered)),
    ("swamp", profile!(require: [], prefer: ["bog_pool", "lily_pad_cluster", "reed_cluster", "rotten_log", "mud_patch", "peat_mound", "swamp_totem", "mangrove_roots", "giant_fungus"], themes: ["swamp"], caps: {swamp_totem: 1}, Gathered)),
    // Лаборатория мага: котёл и кафедра посредине, шкаф с зельями и зеркало у
    // стены, круг призыва на полу; мелочь — на письменном столе.
    ("laboratory", profile!(require: ["alchemy_cauldron", "writing_desk", "potion_cabinet"], prefer: ["arcane_lectern", "ritual_circle", "arcane_stone", "magic_mirror", "crystal_orb", "alchemy_table", "alchemy_bottles", "arcane_coil", "book_piles", "scroll_pile", "desk_candlestick", "bookcase_tall", "vial_display_shelf", "candle"], themes: ["arcane", "study"], caps: {alchemy_cauldron: 1, arcane_lectern: 1, ritual_circle: 1, arcane_stone: 1, magic_mirror: 1, potion_cabinet: 2, alchemy_table: 1, bed: 0, bunk_bed: 0}, Gathered)),
];

/// Профиль по имени назначения (собственный ключ объекта JS: ключи
/// прототипа, вроде `constructor`, профиля не дают и в JS).
pub fn semantic_profile(name: &str) -> Option<&'static SemanticProfile> {
    SEMANTIC_PROFILES.iter().find(|(key, _)| *key == name).map(|(_, profile)| profile)
}

/// Псевдонимы назначения сохраняют короткий и понятный словарь генератора.
#[rustfmt::skip]
const PURPOSE_ALIASES: &[(&str, &str)] = &[
    ("hall", "gallery"), ("main_hall", "gallery"), ("great_hall", "gallery"), ("war_room", "gallery"), ("gallery", "gallery"),
    ("barracks", "barracks"), ("sleeping", "barracks"), ("bedroom", "bedroom"), ("living", "living"), ("kitchen", "kitchen"),
    ("store", "store"), ("storage", "store"), ("warehouse", "store"), ("storehouse", "store"), ("stable", "stable"),
    ("stables", "stable"), ("workshop", "workshop"), ("forge", "forge"), ("smithy", "forge"), ("cells", "cells"),
    ("prison", "cells"), ("guardroom", "guardroom"), ("torture", "torture"), ("altar", "altar"), ("sanctum", "altar"),
    ("nave", "nave"), ("dining", "dining"), ("study", "study"), ("library", "study"), ("shop", "shop"),
    ("mill", "mill"), ("courtyard", "courtyard"), ("yard", "courtyard"), ("exterior", "exterior"), ("laboratory", "laboratory"),
    ("lab", "laboratory"), ("alchemy", "laboratory"), ("encampment", "camp"), ("docks", "harbor"), ("pier", "harbor"),
    ("marsh", "swamp"), ("bog", "swamp"), ("dunes", "desert"),
];

/// Теги — необязательное сокращение для вызывающих модулей, у которых уже
/// есть метки комнаты. Теги в карту не записываются.
#[rustfmt::skip]
const TAG_PURPOSES: &[(&str, &str)] = &[
    ("hall", "gallery"), ("throne", "gallery"), ("maps", "gallery"), ("military", "gallery"),
    ("sleeping", "barracks"), ("soldiers", "barracks"), ("beds", "barracks"),
    ("cooking", "kitchen"), ("hearth", "kitchen"), ("food", "kitchen"),
    ("storage", "store"), ("supplies", "store"), ("crates", "store"), ("barrels", "store"),
    ("horses", "stable"), ("animals", "stable"), ("fodder", "stable"),
    ("forge", "forge"), ("tools", "workshop"), ("craft", "workshop"),
    ("courtyard", "courtyard"), ("yard", "courtyard"), ("outside", "exterior"),
    ("camp", "camp"), ("winter", "winter"), ("snow", "winter"), ("siege", "siege"), ("harbor", "harbor"), ("port", "harbor"), ("docks", "harbor"),
    ("desert", "desert"), ("sand", "desert"), ("dunes", "desert"), ("swamp", "swamp"), ("marsh", "swamp"), ("bog", "swamp"),
    ("laboratory", "laboratory"), ("lab", "laboratory"), ("alchemy", "laboratory"), ("arcane", "laboratory"), ("wizard", "laboratory"),
];

fn table_lookup(table: &[(&'static str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(name, _)| *name == key).map(|(_, value)| *value)
}

/// Что тянется за предметом: без этого у стола не будет стульев, а на столе —
/// посуды, и расстановка выглядит случайной.
#[rustfmt::skip]
const COMPANIONS: [(&str, &[(&str, usize)]); 10] = [
    ("table_round", &[("chair", 4), ("mug", 2), ("plate", 1)]),
    ("table_long", &[("bench", 2), ("chair", 2), ("jug", 1), ("bread_loaf", 1)]),
    ("table_small", &[("chair", 2), ("candle", 1)]),
    ("bar_counter", &[("stool", 3), ("mug", 2), ("bottle", 1)]),
    ("fireplace", &[("cauldron", 1), ("firewood_stack", 1)]),
    ("bed", &[("night_table", 1)]),
    ("bunk_bed", &[("night_table", 1), ("chest", 1)]),
    ("cart", &[("wagon_wheel", 1)]),
    // Стог тянет мешок и ставится в первой, крупной очереди: иначе мелочь
    // занимала амбар раньше, и стогу 2×2 не оставалось места.
    ("haystack", &[("sack", 1)]),
    ("tree_oak", &[("bush", 1)]),
];

fn companions(id: &str) -> &'static [(&'static str, usize)] {
    COMPANIONS.iter().find(|(key, _)| *key == id).map_or(&[], |(_, list)| list)
}

/// Мебель со спинкой: стоит только у стены, лицом в комнату (`BACKED_FURNITURE`).
#[rustfmt::skip]
const BACKED_FURNITURE: &[&str] = &["bar_shelf", "bookshelf", "bookcase_tall", "wardrobe", "cupboard", "pantry_shelf", "display_shelf", "shelf_wall",
    "fireplace", "kitchen_stove", "bread_oven", "forge", "tool_rack", "scroll_rack", "potion_cabinet", "dresser", "armor_stand",
    "magic_mirror", "standing_mirror", "washbasin", "iron_maiden", "wall_chains", "crypt_niche", "reliquary"];

/// Сиденья. Встают гарнитуром у своей поверхности, а не сами по себе.
const SEATS: [&str; 3] = ["chair", "stool", "bench"];
/// У чего сидят. Прилавок и разделочный стол — работа стоя, без сидений.
#[rustfmt::skip]
const SEATING_SURFACES: [&str; 9] = ["table_round", "table_long", "table_royal", "table_small", "bar_counter", "writing_desk", "map_table", "war_table", "jailer_desk"];
/// Доля клетки, которую модель занимает при масштабе 1 (`PROP_FOOTPRINT_FILL` клиента).
const FOOTPRINT_FILL: f64 = 0.84;
/// Зазор между сиденьем и краем стола, в клетках.
const SEAT_GAP: f64 = 0.05;

fn is_seat(id: &str) -> bool {
    SEATS.contains(&id)
}

fn is_seating_surface(id: &str) -> bool {
    SEATING_SURFACES.contains(&id)
}

/// Сиденья поверхности (`seatSpecFor`): из `COMPANIONS`, у конторки — один
/// стул, у королевского стола — шесть.
pub fn seat_spec_for(asset_id: &str) -> Vec<(String, usize)> {
    let from_companions: Vec<(String, usize)> =
        companions(asset_id).iter().filter(|(id, _)| is_seat(id)).map(|(id, count)| ((*id).to_string(), *count)).collect();
    if !from_companions.is_empty() {
        return from_companions;
    }
    if asset_id == "table_royal" {
        return vec![("chair".to_string(), 6)];
    }
    if is_seating_surface(asset_id) {
        vec![("chair".to_string(), 1)]
    } else {
        Vec::new()
    }
}

/// Направление взгляда предмета с поворотом `rotation` (`facingVector`): 0° —
/// на юг (+y), 90° — на запад, 180° — на север, 270° — на восток.
fn facing_vector(rotation: f64) -> (i64, i64) {
    let quarter = js::round((((rotation % 360.0) + 360.0) % 360.0) / 90.0) % 4.0;
    match quarter as i64 {
        1 => (-1, 0),
        2 => (0, -1),
        3 => (1, 0),
        _ => (0, 1),
    }
}

/// С какой площади помещения его середина обязана быть обставлена.
const CORE_FILL_MIN_CELLS: usize = 30;

/// Что ставится в середину помещения по его назначению (`CORE_CENTERPIECES`) —
/// первое, что разрешено темой и потолком зоны и что встаёт. Ковёр плоский:
/// он не занимает клетку, но середина спальни перестаёт быть голым полом.
#[rustfmt::skip]
const CORE_CENTERPIECES: &[(&str, &[&str])] = &[
    ("gallery", &["table_round", "table_long", "table_small"]),
    ("dining", &["table_round", "table_small"]),
    ("living", &["table_small", "rug"]),
    ("guardroom", &["table_long", "table_small"]),
    ("barracks", &["table_long", "table_small"]),
    ("kitchen", &["prep_table", "table_small"]),
    ("store", &["crate_stack", "barrel_stack", "crate"]),
    ("shop", &["scales_table", "table_small", "crate"]),
    ("workshop", &["workbench", "table_long", "crate"]),
    ("forge", &["anvil", "workbench"]),
    ("study", &["table_small", "rug"]),
    ("laboratory", &["table_small", "rug"]),
    ("bedroom", &["rug", "table_small"]),
    ("mill", &["grain_sacks", "sack"]),
];

/// Центры шаблонов помещений: к чему тянется предмет набора.
#[rustfmt::skip]
const SET_ANCHORS: &[(&str, &[&str])] = &[
    ("anvil", &["forge"]), ("quench_tub", &["forge", "anvil"]), ("coal_pile", &["forge"]), ("grindstone", &["anvil", "workbench"]),
    ("butcher_block", &["kitchen_stove", "prep_table"]), ("hanging_pots", &["kitchen_stove"]), ("washtub", &["prep_table"]),
    ("incense_burner", &["altar", "idol"]), ("kneeling_cushions", &["altar", "idol", "temple_lectern"]), ("candle_rack", &["altar", "idol"]),
    ("offering_table", &["altar", "idol"]), ("font_basin", &["prayer_bench", "temple_lectern"]),
    ("iron_cage", &["torture_rack"]), ("guard_brazier", &["jailer_desk", "torture_rack"]), ("strongbox", &["jailer_desk", "writing_desk"]),
    ("scales_table", &["shop_counter"]), ("armchair", &["writing_desk", "reading_nook", "fireplace"]), ("globe", &["writing_desk"]),
    ("chandelier", &["table_long"]), ("candelabra", &["table_long", "altar"]),
    // Утварь тянется только к тем столам, которые служат опорой (`SURFACES`):
    // иначе она встаёт рядом с опорой, которой нет, и снимается в attachPropSupports.
    ("alchemy_bottles", &["writing_desk", "shop_counter", "table_small"]), ("crystal_orb", &["alchemy_table", "writing_desk"]),
    ("arcane_coil", &["writing_desk", "table_long", "map_table"]), ("book_piles", &["writing_desk", "map_table"]),
    ("cutlery_set", &["table_long", "table_small"]), ("desk_candlestick", &["writing_desk", "table_small"]),
    ("ceremonial_chalice", &["altar", "offering_table"]), ("scroll_pile", &["writing_desk", "map_table"]),
    ("single_book", &["writing_desk", "map_table", "table_small"]), ("book_row", &["writing_desk", "map_table", "table_small"]),
    ("key_bundle", &["jailer_desk", "writing_desk", "shop_counter"]), ("coin_pouch", &["shop_counter", "writing_desk", "table_small"]),
    ("alchemy_cauldron", &["alchemy_table", "potion_cabinet"]), ("arcane_lectern", &["ritual_circle", "alchemy_cauldron"]),
    ("magic_mirror", &["arcane_lectern", "writing_desk"]), ("arcane_stone", &["ritual_circle"]),
    ("iron_maiden", &["torture_rack", "dungeon_rack"]), ("manacle_post", &["torture_rack", "straw_bed"]),
    ("camp_dummy", &["shield_rack", "weapon_rack"]), ("bedroll_cluster", &["scout_tent", "command_tent", "campfire"]),
    ("mooring_bollard", &["capstan", "dock_crane"]), ("lobster_cage", &["fishing_crates", "cargo_net"]), ("sail_bundle", &["cargo_net", "rope_coils"]),
];

fn set_anchors(id: &str) -> Option<&'static [&'static str]> {
    SET_ANCHORS.iter().find(|(key, _)| *key == id).map(|(_, list)| *list)
}

/// Сторона клетки и поворот предмета, стоящего спиной к стене этой стороны.
#[derive(Clone, Copy, Debug)]
struct Side {
    dx: i64,
    dy: i64,
    facing: f64,
}

/// Четыре стороны в порядке n, e, s, w. Поворот 0° смотрит на юг (+y), 90° —
/// на запад, 180° — на север, 270° — на восток: так его читают 2D и 3D
/// (`propVisualLayout`). Прежде здесь стоял угол на саму стену (#184).
const SIDES: [Side; 4] = [
    Side { dx: 0, dy: -1, facing: 0.0 },
    Side { dx: 1, dy: 0, facing: 90.0 },
    Side { dx: 0, dy: 1, facing: 180.0 },
    Side { dx: -1, dy: 0, facing: 270.0 },
];

/// Стены вокруг клетки. Стена — это ребро, а не соседняя клетка: низкая
/// ограда между двумя проходимыми клетками тоже держит якорь `wall`.
/// Закрытая на время расстановки точка появления (`reserveDesignSpawn`) —
/// пол, а не стена.
fn wall_sides_at(map: &TacticalMap, x: i64, y: i64) -> Vec<Side> {
    SIDES
        .iter()
        .copied()
        .filter(|side| {
            if let Some(edge) = edge_at(map, x, y, x + side.dx, y + side.dy) {
                if edge.kind == EdgeKind::Wall || edge.kind == EdgeKind::Rail {
                    return true;
                }
            }
            let neighbor = cell_at(map, x + side.dx, y + side.dy);
            if let Some(neighbor) = &neighbor {
                if !neighbor.passable && map.spawn_points.iter().any(|point| point.x == neighbor.x && point.y == neighbor.y) {
                    return false;
                }
            }
            neighbor.is_none_or(|neighbor| !neighbor.passable)
        })
        .collect()
}

/// `wallSidesAt(map, Math.floor(prop.x), Math.floor(prop.y))` для координат
/// предмета. NaN в координате — отказ, как у JS: `canonicalEdge` не находит
/// соседства у `NaN`. Координата без клетки (бесконечность, огромное число) —
/// стена со всех сторон: ни рёбер, ни клеток там нет.
fn wall_sides_at_prop(map: &TacticalMap, x: f64, y: f64) -> MapResult<Vec<Side>> {
    let (fx, fy) = (x.floor(), y.floor());
    if fx.is_nan() || fy.is_nan() {
        let side = SIDES[0];
        let ax = js::f64_string(fx);
        let ay = js::f64_string(fy);
        let bx = js::f64_string(fx + side.dx as f64);
        let by = js::f64_string(fy + side.dy as f64);
        return Err(TacticalMapError::new(
            format!("Клетки {ax},{ay} и {bx},{by} не соседние — ребра между ними не существует"),
            "EDGE_CELLS_NOT_ADJACENT",
        ));
    }
    match (floor_cell(x), floor_cell(y)) {
        (Some(cx), Some(cy)) => Ok(wall_sides_at(map, cx, cy)),
        _ => Ok(SIDES.to_vec()),
    }
}

/// Есть ли у клетки окно на одном из четырёх рёбер.
fn window_beside(map: &TacticalMap, x: i64, y: i64) -> bool {
    SIDES.iter().any(|side| edge_at(map, x, y, x + side.dx, y + side.dy).is_some_and(|edge| edge.kind == EdgeKind::Window))
}

/// Предметы, которые по смыслу ставятся рядами и группами одного вида: им
/// соседство с таким же не штрафуется.
#[rustfmt::skip]
const CLUSTER_FRIENDLY: [&str; 24] = ["village_fence", "rail_fence", "prayer_bench", "crypt_niche", "crate_stack", "barrel_stack", "crate", "barrel", "bunk_bed", "bed", "grave", "chair", "stool", "bench", "hitching_post", "sack", "shelf_wall", "bookshelf", "pillar", "wall_ivy", "wall_ivy_corner", "wall_ivy_wide", "clover_patch", "forest_plant"];

/// Сколько клеток-кандидатов пробуем, прежде чем отказаться от предмета.
const PLACEMENT_ATTEMPTS: usize = 16;
/// Обязательный предмет получает расширенный, но всё ещё ограниченный поиск.
const REQUIRED_PLACEMENT_ATTEMPTS: usize = 64;
/// Вторая ограниченная попытка обязательного после неудачи первых кандидатов.
const REQUIRED_RETRY_ATTEMPTS: usize = 128;
/// Сколько клеток зоны просматривается под один предмет: стоимость
/// расстановки линейна по числу клеток, а не квадратична.
const CANDIDATE_SCAN_LIMIT: usize = 400;

/// Радиус пуассоновского диска в клетках для природной россыпи.
const SCATTER_RADIUS: [(&str, f64); 9] = [
    ("tree_oak", 2.3),
    ("tree_pine", 2.3),
    ("tree_birch", 1.8),
    ("tree_dead", 1.8),
    ("bush", 1.2),
    ("shrub", 1.2),
    ("rock_small", 1.2),
    ("boulder", 1.5),
    ("tree_stump", 1.2),
];

fn scatter_radius(id: &str) -> Option<f64> {
    SCATTER_RADIUS.iter().find(|(key, _)| *key == id).map(|(_, radius)| *radius)
}

/// Утварь набора детализации: без опоры она не ставится вовсе.
const NEW_TABLEWARE: [&str; 11] = [
    "cutlery_set",
    "book_piles",
    "arcane_coil",
    "alchemy_bottles",
    "desk_candlestick",
    "single_book",
    "ceremonial_chalice",
    "book_row",
    "scroll_pile",
    "key_bundle",
    "coin_pouch",
];
/// Прежняя утварь: без опоры остаётся на полу.
const OLD_TABLEWARE: [&str; 12] = ["mug", "plate", "bowl_stew", "bottle", "jug", "bread_loaf", "cheese_wheel", "candle", "dice_cup", "coin_pile", "cutting_board", "offering_bowl"];

fn is_tableware(id: &str) -> bool {
    OLD_TABLEWARE.contains(&id) || NEW_TABLEWARE.contains(&id)
}

/// Опоры — столы с ровной столешницей. Алхимический стол сюда не входит: его
/// колбы и весы — часть модели.
#[rustfmt::skip]
const SURFACES: [&str; 14] = [
    "table_round", "table_long", "table_royal", "table_small", "bar_counter", "night_table", "altar",
    "writing_desk", "map_table", "war_table", "offering_table", "shop_counter", "prep_table", "jailer_desk",
];
#[rustfmt::skip]
const WALL_MOUNTS: [&str; 11] = ["torch_wall", "lantern_wall", "banner", "arch_shelf", "tool_peg_rack", "shield_display", "weapon_rack", "vial_display_shelf", "wall_ivy", "wall_ivy_corner", "wall_ivy_wide"];
const SURFACE_SLOTS: [(f64, f64); 8] = [(-0.2, -0.2), (0.2, 0.2), (-0.2, 0.2), (0.2, -0.2), (0.0, 0.0), (0.0, -0.25), (0.0, 0.25), (0.25, 0.0)];

/// Главная мебель комнаты: ремонт доступа снимает её последней.
#[rustfmt::skip]
pub const KEY_FURNITURE: [&str; 13] = ["bed", "bunk_bed", "bar_counter", "bar_shelf", "fireplace", "altar", "well", "stairs_up", "stairs_down", "sarcophagus", "table_long", "table_round", "market_stall"];
const KEY_FURNITURE_COST: usize = 4;
/// Закуток меньше этого числа клеток не стоит снятой мебели.
const MIN_POCKET_CELLS: usize = 1;
/// Максимум мебельных предметов, которые может снять один проход ремонта.
const PROP_ACCESS_REPAIR_LIMIT: usize = 12;
/// Соседи клетки в порядке правил движения: часть детерминизма ремонта.
const ACCESS_DIRECTIONS: [(i64, i64); 4] = [(1, 0), (0, 1), (-1, 0), (0, -1)];

/// Темы, по которым предмет считается вещью под крышей (`INDOOR_THEMES`).
pub const INDOOR_THEMES: [&str; 7] = ["interior", "tavern", "house", "temple", "crypt", "dungeon", "cave"];

type Cell = (i64, i64);

fn point(cell: Cell) -> Point {
    Point::new(cell.0, cell.1)
}

// --- заявка на расстановку ---------------------------------------------------

/// Заявка зоны (`ZonePlacementPlan`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ZonePlacementPlan {
    pub zone_id: String,
    /// Тема, по которой отбираются ассеты реестра.
    pub theme: String,
    /// Предметов на 100 клеток зоны; NaN — как `undefined` в JS (бюджет ноль).
    pub density: f64,
    /// Назначение комнаты; пусто — нет (`String(purpose ?? '')`).
    pub purpose: String,
    /// Теги; первый известный задаёт назначение.
    pub tags: Vec<String>,
    /// Идентификаторы, которые обязаны появиться.
    pub require: Vec<String>,
    /// Из чего добирать остальное; пусто — весь каталог темы.
    pub prefer: Vec<String>,
    /// Потолок числа предметов вида в зоне, поверх потолков профиля. `None` —
    /// ключ со значением `null`: потолок профиля снят, действует потолок
    /// наклеек. Нечисловое значение JS — `Some(NaN)` (потолка нет).
    pub caps: Vec<(String, Option<f64>)>,
    /// Дополнительные темы, чьи предметы тоже допустимы в зоне.
    pub extra_themes: Vec<String>,
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items.iter().map(|item| js::string(Some(item))).collect(),
        _ => Vec::new(),
    }
}

impl ZonePlacementPlan {
    /// Заявка из объекта JS. `None` — у заявки нет строкового `zoneId`: JS
    /// не находит у такой зоны клеток и пропускает её.
    pub fn from_json(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let zone_id = object.get("zoneId").and_then(Value::as_str)?.to_string();
        let caps = match object.get("caps") {
            Some(Value::Object(caps)) => js::entries(caps)
                .into_iter()
                .map(|(key, value)| {
                    let cap = match value {
                        Value::Null => None,
                        Value::Number(number) => Some(number.as_f64().unwrap_or(f64::NAN)),
                        _ => Some(f64::NAN),
                    };
                    (key.clone(), cap)
                })
                .collect(),
            _ => Vec::new(),
        };
        Some(Self {
            zone_id,
            theme: match object.get("theme") {
                None | Some(Value::Null) => String::new(),
                other => js::string(other),
            },
            density: js::number(object.get("density")),
            purpose: js::s(object.get("purpose")),
            tags: match object.get("tags") {
                Some(Value::Array(items)) => items.iter().map(|item| js::s(Some(item))).collect(),
                _ => Vec::new(),
            },
            require: string_list(object.get("require")),
            prefer: string_list(object.get("prefer")),
            caps,
            extra_themes: string_list(object.get("extraThemes")),
        })
    }
}

/// `String(value).trim().toLocaleLowerCase('en').replace(/[-\s]+/gu, '_')`.
fn purpose_key(value: &str) -> String {
    let lower = text::lower(text::trim(value));
    text::replace_all(sk_core::re!(r"[-\s]+", "gu"), &lower, "_")
}

/// Профиль заявки: явное назначение, иначе первый известный тег.
fn semantic_profile_for(plan: &ZonePlacementPlan) -> Option<&'static SemanticProfile> {
    let key = purpose_key(&plan.purpose);
    let explicit = table_lookup(&PURPOSE_ALIASES, &key).map_or(key.clone(), str::to_string);
    if let Some(profile) = semantic_profile(&explicit) {
        return Some(profile);
    }
    for tag in &plan.tags {
        if let Some(purpose) = table_lookup(&TAG_PURPOSES, &purpose_key(tag)) {
            if let Some(profile) = semantic_profile(purpose) {
                return Some(profile);
            }
        }
    }
    None
}

// --- оценка клетки -------------------------------------------------------------

/// Запись о поставленном предмете: опорная клетка (`Math.floor` координат),
/// зона (`None` — клетки нет, `undefined` в JS) и след.
#[derive(Clone, Debug)]
struct Placed {
    asset_id: String,
    x: f64,
    y: f64,
    zone_id: Option<String>,
    footprint: Vec<Point>,
}

fn chebyshev(record: &Placed, cell: Point) -> f64 {
    js_max((record.x - cell.x as f64).abs(), (record.y - cell.y as f64).abs())
}

/// `nearestPlaced`: расстояние Чебышёва до ближайшей подходящей записи.
fn nearest_placed(records: &[&Placed], cell: Point, matches: impl Fn(&str) -> bool) -> Option<f64> {
    let mut best: Option<f64> = None;
    for record in records {
        if !matches(&record.asset_id) {
            continue;
        }
        let distance = chebyshev(record, cell);
        if best.is_none_or(|best| distance < best) {
            best = Some(distance);
        }
    }
    best
}

/// `closestRecord`: первая из ближайших подходящих записей.
fn closest_record<'a>(records: &[&'a Placed], cell: Point, matches: impl Fn(&str) -> bool) -> Option<&'a Placed> {
    let mut best = None;
    let mut best_distance = f64::INFINITY;
    for record in records {
        if !matches(&record.asset_id) {
            continue;
        }
        let distance = chebyshev(record, cell);
        if distance < best_distance {
            best_distance = distance;
            best = Some(*record);
        }
    }
    best
}

#[derive(Clone, Copy)]
struct ZoneBounds {
    min_x: i64,
    max_x: i64,
    min_y: i64,
    max_y: i64,
}

struct ScoreContext<'a> {
    zone_id: &'a str,
    arrangement: Option<Arrangement>,
    zone_bounds: ZoneBounds,
    local_placed: &'a [&'a Placed],
    same_asset: &'a [&'a Placed],
}

const STALL_ASSETS: [&str; 7] = ["crate", "crate_stack", "barrel", "barrel_stack", "haystack", "water_trough", "hitching_post"];

/// Оценка клетки под конкретный ассет (`scoreCellForAsset`).
fn score_cell_for_asset(map: &TacticalMap, asset: &AssetEntry, cell: Point, context: &ScoreContext<'_>, random: &mut SeedRandom) -> f64 {
    let walls = wall_sides_at(map, cell.x, cell.y).len() as f64;
    let mut score = random.next() * 2.0;
    let local = context.local_placed;
    let id = asset.id.as_str();

    // Шкаф, стеллаж и штабель не заслоняют окно.
    if asset.blocks_sight && window_beside(map, cell.x, cell.y) {
        return f64::NEG_INFINITY;
    }

    if asset.anchor == "wall" {
        // Мебель со спинкой и настенная вещь без стены рядом не ставятся.
        if walls == 0.0 && (BACKED_FURNITURE.contains(&id) || WALL_MOUNTS.contains(&id)) {
            return f64::NEG_INFINITY;
        }
        score += walls * 6.0;
    } else if asset.anchor == "corner" {
        score += if walls >= 2.0 { 14.0 } else { walls * 2.0 };
    } else {
        score -= walls * 1.5;
    }

    // Одинаковое вплотную — штамп, а не обстановка.
    if !CLUSTER_FRIENDLY.contains(&id) {
        let same = nearest_placed(context.same_asset, cell, |other| other == id);
        if same.is_some_and(|same| same <= 1.0) {
            return f64::NEG_INFINITY;
        }
        if same == Some(2.0) {
            score -= 6.0;
        }
    }

    // Шаблон помещения: предмет набора тянется к своему центру.
    if let Some(anchors) = set_anchors(id) {
        if let Some(nearest) = nearest_placed(local, cell, |other| anchors.contains(&other)) {
            score += if nearest <= 1.0 {
                14.0
            } else if nearest == 2.0 {
                8.0
            } else if nearest <= 4.0 {
                2.0
            } else {
                -nearest
            };
        }
    }
    // Стул тянется к столу.
    if id == "chair" || id == "stool" || id == "bench" {
        score += match nearest_placed(local, cell, |other| other.starts_with("table_")) {
            None => -8.0,
            Some(nearest) if nearest <= 1.0 => 16.0,
            Some(nearest) if nearest == 2.0 => 6.0,
            Some(nearest) => -nearest,
        };
    }
    // В казарме койки образуют ряды.
    if context.arrangement == Some(Arrangement::Rows) && (id == "bed" || id == "bunk_bed") {
        let beds: Vec<&Placed> = local
            .iter()
            .copied()
            .filter(|record| record.zone_id.as_deref() == Some(context.zone_id) && (record.asset_id == "bed" || record.asset_id == "bunk_bed"))
            .collect();
        if let Some(nearest_bed) = closest_record(&beds, cell, |_| true) {
            let bounds = context.zone_bounds;
            let horizontal = bounds.max_x - bounds.min_x >= bounds.max_y - bounds.min_y;
            let line_distance = if horizontal { (nearest_bed.y - cell.y as f64).abs() } else { (nearest_bed.x - cell.x as f64).abs() };
            score += if line_distance == 0.0 {
                14.0
            } else if line_distance == 1.0 {
                4.0
            } else {
                -line_distance
            };
        }
    }
    // Стойла и склад предпочитают повторяющиеся группы вдоль стен.
    if context.arrangement == Some(Arrangement::Stalls) && STALL_ASSETS.contains(&id) {
        if let Some(same_kind) = nearest_placed(local, cell, |other| other == id) {
            score += if same_kind <= 2.0 { 8.0 } else { -same_kind };
        }
    }
    // Мелкая утварь ложится поверх столов и стойки.
    if falsy_number(asset.base_footprint.w) {
        score += match nearest_placed(local, cell, |other| other.starts_with("table_") || other == "bar_counter") {
            None => -4.0,
            Some(nearest) if nearest == 0.0 => 12.0,
            Some(nearest) if nearest <= 1.0 => 5.0,
            Some(nearest) => -nearest,
        };
    }
    // Растительность требует грунта.
    if id.starts_with("tree_") || id == "bush" || id == "shrub" {
        let ground = cell_at(map, cell.x, cell.y);
        let material = ground.as_ref().map(|ground| ground.material);
        let surface = ground.as_ref().map(|ground| ground.surface);
        let ground_zone = ground.as_ref().map(|ground| ground.zone);
        let outside = map.zones.iter().any(|zone| Some(zone.id.as_str()) == ground_zone && zone.kind == "exterior");
        let climate_ground = outside
            && ((material == Some("sand") && ["tree_dead", "tree_stump"].contains(&id))
                || (material == Some("ice") && surface == Some("ice") && ["tree_pine", "tree_spruce", "tree_dead", "tree_stump"].contains(&id)));
        if material != Some("grass") && material != Some("earth") && !climate_ground {
            return f64::NEG_INFINITY;
        }
        score += if material == Some("grass") { 8.0 } else { 2.0 };
        // Деревья не жмутся друг к другу вплотную.
        if nearest_placed(local, cell, |other| other.starts_with("tree_")).is_some_and(|nearest| nearest <= 1.0) {
            score -= 12.0;
        }
    }
    // Пуассоновский диск для природы под открытым небом.
    if let Some(radius) = scatter_radius(id) {
        if map.zones.iter().any(|zone| zone.id == context.zone_id && zone.kind == "exterior") {
            for record in local {
                let Some(other) = scatter_radius(&record.asset_id) else { continue };
                let reach = js_max(radius, other);
                let dx = record.x - cell.x as f64;
                let dy = record.y - cell.y as f64;
                if dx * dx + dy * dy < reach * reach {
                    return f64::NEG_INFINITY;
                }
            }
        }
    }
    score
}

/// Угол от клетки к цели, кратный 90° (`angleTowards`).
fn angle_towards(from: Point, to_x: f64, to_y: f64) -> f64 {
    let dx = to_x - from.x as f64;
    let dy = to_y - from.y as f64;
    if dx.abs() >= dy.abs() {
        if dx >= 0.0 {
            270.0
        } else {
            90.0
        }
    } else if dy >= 0.0 {
        0.0
    } else {
        180.0
    }
}

/// Поворот предмета (`rotationFor`). Якорь `wall` разворачивает лицом внутрь
/// помещения; стул поворачивается к ближайшему столу, без стола — в комнату;
/// кресло — к огню; остальное получает свободный угол.
fn rotation_for(map: &TacticalMap, asset: &AssetEntry, cell: Point, placed: &[Placed], zone_id: &str, random: &mut SeedRandom, zone_bounds: Option<ZoneBounds>) -> f64 {
    let id = asset.id.as_str();
    if asset.anchor == "wall" || asset.anchor == "corner" {
        let walls = wall_sides_at(map, cell.x, cell.y);
        if !walls.is_empty() {
            let index = (random.next() * walls.len() as f64).floor() as usize % walls.len();
            return walls[index].facing;
        }
    }
    let local = || -> Vec<&Placed> {
        if zone_id.is_empty() {
            placed.iter().collect()
        } else {
            placed.iter().filter(|record| record.zone_id.as_deref() == Some(zone_id)).collect()
        }
    };
    let toward_middle = |bounds: ZoneBounds| {
        angle_towards(cell, (bounds.min_x + bounds.max_x) as f64 / 2.0, (bounds.min_y + bounds.max_y) as f64 / 2.0)
    };
    if id == "chair" || id == "stool" || id == "bench" {
        if let Some(table) = closest_record(&local(), cell, |other| other.starts_with("table_") || other == "bar_counter") {
            return angle_towards(cell, table.x, table.y);
        }
        if let Some(bounds) = zone_bounds {
            return toward_middle(bounds);
        }
    }
    // Кресло читают у огня: к очагу комнаты, без очага — в комнату.
    if id == "armchair" {
        if let Some(hearth) = closest_record(&local(), cell, |other| other == "fireplace" || other == "hearth_fire" || other == "brazier") {
            return angle_towards(cell, hearth.x, hearth.y);
        }
        if let Some(bounds) = zone_bounds {
            return toward_middle(bounds);
        }
    }
    if id.starts_with("tree_") || id == "bush" || id == "rock_small" || id == "boulder" {
        // У кроны нет лица, поэтому угол свободный.
        return (random.next() * 360.0).floor();
    }
    (js::round(random.next() * 4.0) % 4.0) * 90.0
}

/// Подбирает положение прямоугольника футпринта так, чтобы он накрывал
/// выбранную клетку и целиком помещался на проходимых свободных клетках
/// (`fittingFootprint`). `None` — положения нет.
fn fitting_footprint(map: &TacticalMap, blocked: &dyn Fn(Cell) -> bool, anchor: Point, w: f64, h: f64, rotation: f64) -> Option<Vec<Point>> {
    if falsy_number(w) || falsy_number(h) {
        return Some(Vec::new());
    }
    // Поворот на 90° меняет ширину и высоту местами.
    let quarter = js::round((((rotation % 360.0) + 360.0) % 360.0) / 90.0) % 4.0;
    let (width, height) = if quarter % 2.0 == 0.0 { (w, h) } else { (h, w) };
    // Предмет целиком в одной зоне, на одной высоте и без ребра между своими
    // клетками: после тонких стен по обе стороны стены — проходимый пол.
    let home = cell_at(map, anchor.x, anchor.y);
    let mut offset_y = 0_i64;
    while (offset_y as f64) < height {
        let mut offset_x = 0_i64;
        while (offset_x as f64) < width {
            let mut cells = Vec::new();
            let mut fits = true;
            let mut dy = 0_i64;
            while (dy as f64) < height && fits {
                let mut dx = 0_i64;
                while (dx as f64) < width && fits {
                    let x = anchor.x - offset_x + dx;
                    let y = anchor.y - offset_y + dy;
                    let target = cell_at(map, x, y);
                    if target.as_ref().is_none_or(|target| !target.passable) || blocked((x, y)) {
                        fits = false;
                    } else if home.as_ref().is_some_and(|home| {
                        target.as_ref().is_some_and(|target| target.zone != home.zone || target.elevation != home.elevation)
                    }) {
                        fits = false;
                    } else if (dx > 0 && edge_at(map, x - 1, y, x, y).is_some()) || (dy > 0 && edge_at(map, x, y - 1, x, y).is_some()) {
                        fits = false;
                    } else {
                        cells.push(Point::new(x, y));
                    }
                    dx += 1;
                }
                dy += 1;
            }
            if fits {
                return Some(cells);
            }
            offset_x += 1;
        }
        offset_y += 1;
    }
    None
}

// --- середина помещения и гарнитур ----------------------------------------------------

/// Что поставить в середину помещения и куда (`coreCenterpiece`).
struct Centerpiece {
    asset: &'static AssetEntry,
    cell: Point,
    footprint: Vec<Point>,
    rotation: f64,
}

/// Середина помещения без мебели (`coreCenterpiece`): клетки не ближе двух
/// шагов к стене, двери, окну и краю помещения. `None` — середина уже
/// обставлена, мала или ничего не встало, не отрезав проход. Назначение —
/// собственный ключ `CORE_CENTERPIECES`; ключи прототипа (`constructor`) в JS
/// роняют расстановку (`docs/rust-port-js-findings.md`), здесь — назначение
/// без середины.
fn core_centerpiece(
    map: &TacticalMap,
    zone_id: &str,
    purpose: &str,
    cells: &[Point],
    allowed: &HashSet<&str>,
    caps: &IndexMap<String, Option<f64>>,
    blocked: &HashSet<Cell>,
) -> Option<Centerpiece> {
    let zone = map.zones.iter().find(|entry| entry.id == zone_id);
    let choices: &[&str] = CORE_CENTERPIECES.iter().find(|(key, _)| *key == purpose).map_or(&[], |(_, list)| list);
    if zone.is_none_or(|zone| zone.kind != "interior") || cells.len() < CORE_FILL_MIN_CELLS || choices.is_empty() {
        return None;
    }
    let own: HashSet<Cell> = cells.iter().map(|cell| (cell.x, cell.y)).collect();
    let rim: Vec<Point> = cells
        .iter()
        .copied()
        .filter(|cell| {
            [(1, 0), (-1, 0), (0, 1), (0, -1)].iter().any(|(dx, dy)| {
                !own.contains(&(cell.x + dx, cell.y + dy)) || edge_at(map, cell.x, cell.y, cell.x + dx, cell.y + dy).is_some()
            })
        })
        .collect();
    // `Math.min(...rim.map(…))`: пустая кромка — бесконечность.
    let distance = |cell: &Point| rim.iter().map(|edge| (edge.x - cell.x).abs().max((edge.y - cell.y).abs())).min().map_or(f64::INFINITY, |d| d as f64);
    let core: Vec<Point> = cells.iter().copied().filter(|cell| distance(cell) >= 2.0).collect();
    if core.len() < 2 {
        return None;
    }
    let core_keys: HashSet<Cell> = core.iter().map(|cell| (cell.x, cell.y)).collect();
    if map.props.iter().any(|prop| prop.mount.is_none() && prop.footprint.iter().any(|point| core_keys.contains(&(point.x, point.y)))) {
        return None;
    }
    // Сам предмет может выйти из середины на клетку, но не к стене.
    let inner: HashSet<Cell> = cells.iter().filter(|cell| distance(cell) >= 1.0).map(|cell| (cell.x, cell.y)).collect();
    let center_x = core.iter().fold(0.0, |sum, cell| sum + cell.x as f64) / core.len() as f64;
    let center_y = core.iter().fold(0.0, |sum, cell| sum + cell.y as f64) / core.len() as f64;
    let key = |cell: &Point| (cell.x as f64 - center_x).abs() + (cell.y as f64 - center_y).abs();
    let mut ordered = core.clone();
    ordered.sort_by(|left, right| {
        key(left).partial_cmp(&key(right)).unwrap_or(Ordering::Equal).then(left.y.cmp(&right.y)).then(left.x.cmp(&right.x))
    });
    let min_x = cells.iter().map(|cell| cell.x).min().unwrap_or(0);
    let max_x = cells.iter().map(|cell| cell.x).max().unwrap_or(0);
    let min_y = cells.iter().map(|cell| cell.y).min().unwrap_or(0);
    let max_y = cells.iter().map(|cell| cell.y).max().unwrap_or(0);
    let wide = max_x - min_x >= max_y - min_y;
    let blockers: HashSet<Cell> =
        map.props.iter().filter(|prop| prop.blocks_move && prop.mount.is_none()).flat_map(|prop| prop.footprint.iter().map(|cell| (cell.x, cell.y))).collect();
    for asset_id in choices {
        let Some(asset) = asset_by_id(asset_id) else { continue };
        if !allowed.contains(asset_id) {
            continue;
        }
        let present = map.props.iter().filter(|prop| prop.asset_id == *asset_id && floor_key(prop.x, prop.y).is_some_and(|key| own.contains(&key))).count();
        if let Some(Some(cap)) = caps.get(*asset_id) {
            if cap.is_finite() && present as f64 >= *cap {
                continue;
            }
        }
        if falsy_number(asset.base_footprint.w) {
            return Some(Centerpiece { asset, cell: ordered[0], footprint: Vec::new(), rotation: 0.0 });
        }
        // Длинный стол и верстак лежат вдоль длинной стороны комнаты.
        let rotation = if wide { 0.0 } else { 90.0 };
        for cell in &ordered {
            let blocked_fn = |key: Cell| blocked.contains(&key);
            let Some(footprint) = fitting_footprint(map, &blocked_fn, *cell, asset.base_footprint.w, asset.base_footprint.h, rotation) else { continue };
            if !footprint.iter().all(|point| inner.contains(&(point.x, point.y))) {
                continue;
            }
            if asset.blocks_move {
                // Предмет отнимает у обхода ровно свои клетки — проход не отрезан.
                let taken: HashSet<Cell> = footprint.iter().map(|point| (point.x, point.y)).collect();
                let Some(anchor) = cells.iter().find(|other| !blockers.contains(&(other.x, other.y)) && !taken.contains(&(other.x, other.y))) else { continue };
                let before = reachable_cells(map, anchor.x, anchor.y, true, Some(&blockers)).len();
                let mut with_taken = blockers.clone();
                with_taken.extend(taken.iter().copied());
                let after = reachable_cells(map, anchor.x, anchor.y, true, Some(&with_taken)).len();
                if after as i64 != before as i64 - footprint.len() as i64 {
                    continue;
                }
            }
            return Some(Centerpiece { asset, cell: *cell, footprint, rotation });
        }
    }
    None
}

/// `` `${Math.floor(x)},${Math.floor(y)}` `` как ключ клетки; `None` — у
/// координаты нет клетки (NaN, бесконечность): такого ключа нет ни в одном
/// множестве клеток.
fn floor_key(x: f64, y: f64) -> Option<Cell> {
    Some((floor_cell(x)?, floor_cell(y)?))
}

/// Поверхность, к которой садятся: вид, след и масштаб предмета.
#[derive(Clone, Debug, PartialEq)]
pub struct SeatSurface {
    pub asset_id: String,
    pub footprint: Vec<Point>,
    pub scale: f64,
}

impl SeatSurface {
    pub fn from_prop(prop: &TacticalProp) -> Self {
        Self { asset_id: prop.asset_id.clone(), footprint: prop.footprint.clone(), scale: prop.scale }
    }

    /// Поверхность из объекта JS (`{ assetId, footprint, scale }`).
    pub fn from_json(value: &Value) -> Self {
        let footprint = match value.get("footprint") {
            Some(Value::Array(cells)) => cells
                .iter()
                .filter_map(|cell| Some(Point::new(cell.get("x")?.as_f64()? as i64, cell.get("y")?.as_f64()? as i64)))
                .collect(),
            _ => Vec::new(),
        };
        Self { asset_id: js::s(value.get("assetId")), footprint, scale: js::number(value.get("scale")) }
    }
}

/// Место для сиденья у стороны поверхности (`seatSlots`).
#[derive(Clone, Copy, Debug)]
struct SeatSlot {
    x: i64,
    y: i64,
    toward: Point,
    side: char,
}

/// Места для сидений у поверхности: свободные клетки той же зоны и высоты
/// вплотную к её сторонам — без углов и без ребра между сиденьем и столом.
fn seat_slots(map: &TacticalMap, footprint: &[Point], blocked: &HashSet<Cell>) -> Vec<SeatSlot> {
    let own: HashSet<Cell> = footprint.iter().map(|cell| (cell.x, cell.y)).collect();
    let home = cell_at(map, footprint[0].x, footprint[0].y);
    let mut slots: IndexMap<Cell, SeatSlot> = IndexMap::new();
    for cell in footprint {
        for (dx, dy, side) in [(0, -1, 'n'), (1, 0, 'e'), (0, 1, 's'), (-1, 0, 'w')] {
            let (x, y) = (cell.x + dx, cell.y + dy);
            if own.contains(&(x, y)) || blocked.contains(&(x, y)) || slots.contains_key(&(x, y)) {
                continue;
            }
            let Some(target) = cell_at(map, x, y) else { continue };
            let Some(home) = &home else { continue };
            if !target.passable || target.zone != home.zone || target.elevation != home.elevation {
                continue;
            }
            if edge_at(map, cell.x, cell.y, x, y).is_some() {
                continue;
            }
            slots.insert((x, y), SeatSlot { x, y, toward: *cell, side });
        }
    }
    slots.into_values().collect()
}

/// Сиденье, найденное раскладкой (`arrangeSeats`).
#[derive(Clone, Debug)]
struct Seat {
    asset: &'static AssetEntry,
    cells: Vec<Point>,
    rotation: f64,
    x: f64,
    y: f64,
}

/// Раскладка сидений вокруг поверхности (`arrangeSeats`). Сначала длинная
/// сторона, затем противоположная, затем торцы; на стороне — от середины к
/// краям. Скамья встаёт вдоль стороны на две соседние клетки. У стойки —
/// только её передняя сторона.
fn arrange_seats(map: &TacticalMap, surface: &SeatSurface, spec: &[(String, usize)], blocked: &HashSet<Cell>) -> Vec<Seat> {
    let footprint = &surface.footprint;
    if footprint.is_empty() || spec.is_empty() {
        return Vec::new();
    }
    let mut taken = blocked.clone();
    let slots = seat_slots(map, footprint, &taken);
    if slots.is_empty() {
        return Vec::new();
    }
    let min_x = footprint.iter().map(|cell| cell.x).min().unwrap_or(0);
    let max_x = footprint.iter().map(|cell| cell.x).max().unwrap_or(0);
    let min_y = footprint.iter().map(|cell| cell.y).min().unwrap_or(0);
    let max_y = footprint.iter().map(|cell| cell.y).max().unwrap_or(0);
    let span_w = max_x - min_x + 1;
    let span_h = max_y - min_y + 1;
    let middle_x = (min_x + max_x) as f64 / 2.0;
    let middle_y = (min_y + max_y) as f64 / 2.0;
    let opposite = |side: char| match side {
        'n' => 's',
        's' => 'n',
        'e' => 'w',
        _ => 'e',
    };
    let side_length = |side: char| if side == 'n' || side == 's' { span_w } else { span_h };
    let mut by_side: IndexMap<char, Vec<SeatSlot>> = IndexMap::new();
    for slot in &slots {
        by_side.entry(slot.side).or_default().push(*slot);
    }
    for list in by_side.values_mut() {
        let distance = |slot: &SeatSlot| js_hypot(slot.x as f64 - middle_x, slot.y as f64 - middle_y);
        list.sort_by(|a, b| distance(a).partial_cmp(&distance(b)).unwrap_or(Ordering::Equal).then(a.x.cmp(&b.x)).then(a.y.cmp(&b.y)));
    }
    // У стойки сидят только спереди: сторона, где мест больше и за спиной меньше стен.
    let behind = |list: &[SeatSlot]| list.iter().map(|slot| wall_sides_at(map, slot.x, slot.y).len()).sum::<usize>();
    let count = |side: &char| by_side.get(side).map_or(0, Vec::len);
    let mut order: Vec<char> = by_side.keys().copied().collect();
    order.sort_by(|a, b| {
        side_length(*b)
            .cmp(&side_length(*a))
            .then(count(b).cmp(&count(a)))
            .then(behind(by_side.get(a).map_or(&[][..], Vec::as_slice)).cmp(&behind(by_side.get(b).map_or(&[][..], Vec::as_slice))))
            .then_with(|| text::locale_compare(&a.to_string(), &b.to_string()))
    });
    if order.len() > 1 && by_side.contains_key(&opposite(order[0])) {
        let first = order[0];
        let mut reordered = vec![first, opposite(first)];
        reordered.extend(order[1..].iter().copied().filter(|side| *side != opposite(first)));
        order = reordered;
    }
    if surface.asset_id == "bar_counter" {
        order.truncate(1);
    }
    let mut result: Vec<Seat> = Vec::new();
    let table_scale = if surface.scale > 0.0 { surface.scale } else { 1.0 };
    // Сдвиг сиденья к столу внутри своей клетки: футпринт тот же — меняется
    // только точка рисунка (`propVisualLayout`).
    let shift_toward = |slot: &SeatSlot, asset: &AssetEntry| {
        let across = (if slot.side == 'n' || slot.side == 's' { span_h } else { span_w }) as f64;
        let table_inset = across / 2.0 * (1.0 - FOOTPRINT_FILL * table_scale);
        let seat_scale = (asset.scale_range.min + asset.scale_range.max) / 2.0;
        js_max(0.0, (0.5 + table_inset - FOOTPRINT_FILL * seat_scale / 2.0 - SEAT_GAP).min(0.4))
    };
    for (seat_id, seat_count) in spec {
        let Some(asset) = asset_by_id(seat_id) else { continue };
        for _ in 0..*seat_count {
            if asset.base_footprint.w > 1.0 || asset.base_footprint.h > 1.0 {
                // Скамья: две соседние клетки вдоль одной стороны.
                let mut bench: Option<(SeatSlot, SeatSlot)> = None;
                for side in &order {
                    let list: Vec<SeatSlot> = by_side.get(side).map_or(&[][..], Vec::as_slice).iter().copied().filter(|slot| !taken.contains(&(slot.x, slot.y))).collect();
                    let (along_dx, along_dy) = if *side == 'n' || *side == 's' { (1, 0) } else { (0, 1) };
                    for slot in &list {
                        if let Some(next) = list.iter().find(|other| other.x == slot.x + along_dx && other.y == slot.y + along_dy) {
                            bench = Some((*slot, *next));
                            break;
                        }
                    }
                    if bench.is_some() {
                        break;
                    }
                }
                let Some((slot, next)) = bench else { continue };
                let cells = vec![Point::new(slot.x, slot.y), Point::new(next.x, next.y)];
                for cell in &cells {
                    taken.insert((cell.x, cell.y));
                }
                let from = Point::new(slot.x, slot.y);
                result.push(Seat {
                    asset,
                    cells,
                    rotation: angle_towards(from, slot.toward.x as f64, slot.toward.y as f64),
                    x: slot.x as f64 + 0.5,
                    y: slot.y as f64 + 0.5,
                });
                continue;
            }
            // Стул: по кругу сторон, чтобы сидели напротив друг друга.
            let mut chosen: Option<SeatSlot> = None;
            let mut turn = 0;
            while turn < order.len() && chosen.is_none() {
                let side = order[(result.len() + turn) % order.len()];
                chosen = by_side.get(&side).and_then(|list| list.iter().find(|slot| !taken.contains(&(slot.x, slot.y))).copied());
                turn += 1;
            }
            let Some(chosen) = chosen else { break };
            taken.insert((chosen.x, chosen.y));
            let shift = shift_toward(&chosen, asset);
            let dx = (chosen.toward.x - chosen.x).signum() as f64;
            let dy = (chosen.toward.y - chosen.y).signum() as f64;
            let from = Point::new(chosen.x, chosen.y);
            result.push(Seat {
                asset,
                cells: vec![from],
                rotation: angle_towards(from, chosen.toward.x as f64, chosen.toward.y as f64),
                x: js::parse_float(&js::to_fixed(chosen.x as f64 + 0.5 + dx * shift, 3)),
                y: js::parse_float(&js::to_fixed(chosen.y as f64 + 0.5 + dy * shift, 3)),
            });
        }
    }
    result
}

/// Предмет сиденья для `addProp`.
fn seat_prop_value(id: String, seat: &Seat, scale: f64) -> Value {
    prop_value(id, seat.asset, seat.x, seat.y, seat.rotation, scale, &seat.cells, 0)
}

/// Параметры [`seat_around_surface`] (`{ idPrefix, blocked, spec, random }`).
pub struct SeatOptions<'a> {
    pub id_prefix: &'a str,
    pub blocked: HashSet<Cell>,
    /// `None` — `seatSpecFor(surface.assetId)`.
    pub spec: Option<Vec<(String, usize)>>,
    /// `None` — `() => 0.5`.
    pub random: Option<&'a mut dyn FnMut() -> f64>,
}

/// `seatAroundSurface(map, surface, options)`: ставит сиденья к уже стоящей
/// поверхности (стол, стойка, конторка). Возвращает поставленные предметы.
/// Используется расстановкой и дообстановкой пустых четвертей зала
/// (`building-generator`).
pub fn seat_around_surface(map: &mut TacticalMap, surface: &SeatSurface, options: SeatOptions<'_>) -> Vec<TacticalProp> {
    let SeatOptions { id_prefix, blocked, spec, mut random } = options;
    let spec = spec.unwrap_or_else(|| seat_spec_for(&surface.asset_id));
    let mut occupied_now = blocked;
    for prop in &map.props {
        if prop.mount.is_some() {
            continue;
        }
        for cell in &prop.footprint {
            occupied_now.insert((cell.x, cell.y));
        }
    }
    let seats = arrange_seats(map, surface, &spec, &occupied_now);
    let mut added = Vec::new();
    for (index, seat) in seats.iter().enumerate() {
        let span = seat.asset.scale_range.max - seat.asset.scale_range.min;
        let roll = match random.as_mut() {
            Some(random) => random(),
            None => 0.5,
        };
        let scale = js::parse_float(&js::to_fixed(seat.asset.scale_range.min + roll * span, 3));
        let prop = seat_prop_value(format!("{id_prefix}-{index}-{}", seat.asset.id), seat, scale);
        if let Ok(prop) = add_prop(map, &prop) {
            added.push(prop.clone());
        }
    }
    added
}

// --- проходы у дверей ------------------------------------------------------------

/// Проходимые клетки зоны в порядке y, затем x (`zoneCells`).
fn zone_cells(map: &TacticalMap, zone_id: &str) -> Vec<Point> {
    let mut cells = Vec::new();
    for y in 0..map.height {
        for x in 0..map.width {
            if let Some(cell) = cell_at(map, x, y) {
                if cell.passable && cell.zone == zone_id {
                    cells.push(Point::new(x, y));
                }
            }
        }
    }
    cells
}

fn compare_cells(left: &Point, right: &Point) -> Ordering {
    left.y.cmp(&right.y).then(left.x.cmp(&right.x))
}

fn compare_cell_keys(left: &Cell, right: &Cell) -> Ordering {
    left.1.cmp(&right.1).then(left.0.cmp(&right.0))
}

/// Подходы к дверям комнаты (`doorwayApproaches`): клетки у записей дверей и,
/// у помещения, границы с соседними проходимыми зонами.
fn doorway_approaches(map: &TacticalMap, zone_id: &str, allowed: &IndexSet<Cell>) -> Vec<Point> {
    let mut found: IndexSet<Cell> = IndexSet::new();
    let add = |found: &mut IndexSet<Cell>, x: i64, y: i64| {
        let Some(cell) = cell_at(map, x, y) else { return };
        if !cell.passable || cell.zone != zone_id || !allowed.contains(&(x, y)) {
            return;
        }
        found.insert((x, y));
    };
    for door in &map.doors {
        let first = (door.x, door.y);
        let second = edge_neighbor(door.x, door.y, door.dir);
        for endpoint in [first, second] {
            add(&mut found, endpoint.0, endpoint.1);
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                add(&mut found, endpoint.0 + dx, endpoint.1 + dy);
            }
        }
    }
    // Открытая связь графа или старая дверь могут оставить проходимый порог
    // без записи в `doors`. Только у помещения: у двора граница — вся кромка.
    let interior = map.zones.iter().find(|zone| zone.id == zone_id).is_some_and(|zone| zone.kind == "interior");
    if interior {
        for &(x, y) in allowed {
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let neighbor = cell_at(map, x + dx, y + dy);
                // Сосед за тонкой стеной — не проём.
                let edge = if neighbor.is_some() { edge_at(map, x, y, x + dx, y + dy) } else { None };
                if edge.is_some_and(|edge| edge.kind != EdgeKind::Door && edge.blocks_move) {
                    continue;
                }
                if neighbor.is_some_and(|neighbor| neighbor.passable && neighbor.zone != zone_id) {
                    found.insert((x, y));
                    break;
                }
            }
        }
    }
    let mut result: Vec<Point> = found.into_iter().map(point).collect();
    result.sort_by(compare_cells);
    result
}

/// Кратчайший путь по клеткам зоны в обход стен (`corridorPath`).
fn corridor_path(map: &TacticalMap, allowed: &IndexSet<Cell>, start: Point, target: Point) -> Vec<Point> {
    let start_key = (start.x, start.y);
    let target_key = (target.x, target.y);
    if !allowed.contains(&start_key) || !allowed.contains(&target_key) {
        return Vec::new();
    }
    let mut queue = vec![start_key];
    let mut previous: HashMap<Cell, Option<Cell>> = HashMap::new();
    previous.insert(start_key, None);
    let mut index = 0;
    while index < queue.len() {
        let current = queue[index];
        index += 1;
        if current == target_key {
            break;
        }
        for (dx, dy) in [(1, 0), (0, 1), (-1, 0), (0, -1)] {
            let next = (current.0 + dx, current.1 + dy);
            if previous.contains_key(&next) || !allowed.contains(&next) {
                continue;
            }
            if edge_at(map, current.0, current.1, next.0, next.1).is_some_and(|edge| edge.kind != EdgeKind::Door && edge.blocks_move) {
                continue;
            }
            previous.insert(next, Some(current));
            queue.push(next);
        }
    }
    if !previous.contains_key(&target_key) {
        return Vec::new();
    }
    let mut path = Vec::new();
    let mut cursor = Some(target_key);
    while let Some(cell) = cursor {
        path.push(point(cell));
        cursor = previous.get(&cell).copied().flatten();
    }
    path.reverse();
    path
}

/// Одноклеточный путь от каждого дверного проёма комнаты к другим проёмам
/// (или к середине комнаты, если проём один) — `passageClearance`.
fn passage_clearance(map: &TacticalMap, zone_id: &str, cells: &[Point]) -> HashSet<Cell> {
    let allowed: IndexSet<Cell> = cells.iter().map(|cell| (cell.x, cell.y)).collect();
    let approaches = doorway_approaches(map, zone_id, &allowed);
    let mut clear: HashSet<Cell> = approaches.iter().map(|cell| (cell.x, cell.y)).collect();
    if approaches.is_empty() {
        return clear;
    }
    let targets: Vec<Point> = if approaches.len() > 1 {
        approaches[1..].to_vec()
    } else {
        let mut sorted = cells.to_vec();
        sorted.sort_by(compare_cells);
        vec![sorted[cells.len() / 2]]
    };
    let mut from = approaches[0];
    for target in targets {
        for cell in corridor_path(map, &allowed, from, target) {
            clear.insert((cell.x, cell.y));
        }
        from = target;
    }
    clear
}

/// Пороги дверей (`doorThresholds`): обе стороны полотна и по клетке за
/// каждой стороной по прямой.
fn door_thresholds(map: &TacticalMap) -> HashSet<Cell> {
    let mut cells = HashSet::new();
    for door in &map.doors {
        let next = edge_neighbor(door.x, door.y, door.dir);
        let step = (next.0 - door.x, next.1 - door.y);
        for cell in [(door.x, door.y), next, (door.x - step.0, door.y - step.1), (next.0 + step.0, next.1 + step.1)] {
            cells.insert(cell);
        }
    }
    cells
}

// --- ремонт доступа ----------------------------------------------------------------

struct Access {
    baseline: IndexSet<Cell>,
    targets: IndexSet<Cell>,
    semantic: IndexSet<Cell>,
}

/// Клетки под предметами, перекрывающими движение, → индексы предметов.
fn blocking_props_by_cell(props: &[TacticalProp]) -> IndexMap<Cell, Vec<usize>> {
    let mut by_cell: IndexMap<Cell, Vec<usize>> = IndexMap::new();
    for (index, prop) in props.iter().enumerate() {
        if !prop.blocks_move || prop.footprint.is_empty() {
            continue;
        }
        for cell in &prop.footprint {
            by_cell.entry((cell.x, cell.y)).or_default().push(index);
        }
    }
    by_cell
}

fn party_spawn(map: &TacticalMap) -> Option<Cell> {
    map.spawn_points.iter().find(|point| point.role == "party").map(|point| (point.x, point.y))
}

/// `propAccessTargets`: досягаемое без предметов, цели ремонта и
/// семантические цели (пороги дверей и точка появления).
fn prop_access_targets(map: &TacticalMap, props: &[TacticalProp]) -> Option<Access> {
    let spawn = party_spawn(map)?;
    let baseline = reachable_cells(map, spawn.0, spawn.1, true, None);
    if baseline.is_empty() {
        return None;
    }
    let blockers = blocking_props_by_cell(props);
    let mut targets: IndexSet<Cell> = baseline.iter().copied().filter(|key| !blockers.contains_key(key)).collect();
    // Дверной порог и клетка по другую сторону двери — семантические цели.
    for door in &map.doors {
        for endpoint in [(door.x, door.y), edge_neighbor(door.x, door.y, door.dir)] {
            if baseline.contains(&endpoint) && cell_passable(map, endpoint.0, endpoint.1) {
                targets.insert(endpoint);
            }
        }
    }
    let mut semantic: IndexSet<Cell> = IndexSet::new();
    for door in &map.doors {
        for endpoint in [(door.x, door.y), edge_neighbor(door.x, door.y, door.dir)] {
            if targets.contains(&endpoint) {
                semantic.insert(endpoint);
            }
        }
    }
    if baseline.contains(&spawn) {
        targets.insert(spawn);
        semantic.insert(spawn);
    }
    Some(Access { baseline, targets, semantic })
}

/// Отрезанные клетки, ради которых стоит снимать предмет (`worthRepair`).
fn worth_repair(pending: &IndexSet<Cell>, semantic: &IndexSet<Cell>) -> IndexSet<Cell> {
    let mut result = IndexSet::new();
    let mut seen: HashSet<Cell> = HashSet::new();
    for &start in pending {
        if seen.contains(&start) {
            continue;
        }
        let mut group = vec![start];
        seen.insert(start);
        let mut index = 0;
        while index < group.len() {
            let (x, y) = group[index];
            index += 1;
            for (dx, dy) in ACCESS_DIRECTIONS {
                let key = (x + dx, y + dy);
                if pending.contains(&key) && !seen.contains(&key) {
                    seen.insert(key);
                    group.push(key);
                }
            }
        }
        if group.len() >= MIN_POCKET_CELLS || group.iter().any(|key| semantic.contains(key)) {
            result.extend(group);
        }
    }
    result
}

/// Маршрут до любой цели с наименьшей ценой снятых предметов
/// (`accessRepairPath`): Дейкстра на корзинах, свободная клетка стоит 0,
/// клетка под мелочью — 1, под главной мебелью — `KEY_FURNITURE_COST`.
fn access_repair_path(
    map: &TacticalMap,
    props: &[TacticalProp],
    baseline: &IndexSet<Cell>,
    reached: &IndexSet<Cell>,
    targets: &IndexSet<Cell>,
    blockers: &IndexMap<Cell, Vec<usize>>,
) -> Vec<usize> {
    let mut distance: HashMap<Cell, usize> = HashMap::new();
    let mut previous: HashMap<Cell, Option<Cell>> = HashMap::new();
    let mut buckets: Vec<Vec<Cell>> = Vec::new();
    let push = |buckets: &mut Vec<Vec<Cell>>, key: Cell, cost: usize| {
        if buckets.len() <= cost {
            buckets.resize_with(cost + 1, Vec::new);
        }
        buckets[cost].push(key);
    };
    let step_cost_at = |key: &Cell| -> usize {
        match blockers.get(key) {
            Some(owners) if !owners.is_empty() => {
                if owners.iter().any(|index| props.get(*index).is_some_and(|prop| KEY_FURNITURE.contains(&prop.asset_id.as_str()))) {
                    KEY_FURNITURE_COST
                } else {
                    1
                }
            }
            _ => 0,
        }
    };

    let mut starts: Vec<Cell> = reached.iter().copied().collect();
    starts.sort_by(compare_cell_keys);
    for key in starts {
        distance.insert(key, 0);
        previous.insert(key, None);
        push(&mut buckets, key, 0);
    }

    let mut cost = 0;
    while cost < buckets.len() {
        let mut position = 0;
        while position < buckets[cost].len() {
            let current = buckets[cost][position];
            position += 1;
            if distance.get(&current).is_some_and(|known| *known < cost) {
                continue;
            }
            for (dx, dy) in ACCESS_DIRECTIONS {
                let next = (current.0 + dx, current.1 + dy);
                if !baseline.contains(&next) {
                    continue;
                }
                if edge_at(map, current.0, current.1, next.0, next.1).is_some_and(|edge| edge.kind != EdgeKind::Door && edge.blocks_move) {
                    continue;
                }
                let next_distance = cost + step_cost_at(&next);
                if distance.get(&next).is_some_and(|known| next_distance >= *known) {
                    continue;
                }
                distance.insert(next, next_distance);
                previous.insert(next, Some(current));
                push(&mut buckets, next, next_distance);
            }
        }
        cost += 1;
    }

    let mut sorted_targets: Vec<Cell> = targets.iter().copied().collect();
    sorted_targets.sort_by(compare_cell_keys);
    let mut target = None;
    let mut target_distance = usize::MAX;
    for key in sorted_targets {
        let Some(candidate) = distance.get(&key).copied() else { continue };
        if candidate == 0 {
            continue;
        }
        if candidate < target_distance {
            target = Some(key);
            target_distance = candidate;
        }
    }
    let Some(target) = target else { return Vec::new() };

    let mut path_props = Vec::new();
    let mut seen: HashSet<usize> = HashSet::new();
    let mut cursor = Some(target);
    while let Some(cell) = cursor {
        for index in blockers.get(&cell).map(Vec::as_slice).unwrap_or(&[]) {
            if seen.insert(*index) {
                path_props.push(*index);
            }
        }
        cursor = previous.get(&cell).copied().flatten();
    }
    path_props.reverse();
    path_props
}

/// Снимает один предмет, перекрывающий движение, и мелочь на его
/// поверхности (`removeBlockingProp`).
fn remove_blocking_prop(props: &mut Vec<TacticalProp>, index: usize) -> bool {
    let Some(removed) = props.get(index) else { return false };
    if !removed.blocks_move {
        return false;
    }
    let mut removed_ids: HashSet<String> = HashSet::from([removed.id.clone()]);
    let mut removed_props = vec![false; props.len()];
    removed_props[index] = true;
    let mut changed = true;
    while changed {
        changed = false;
        for (position, prop) in props.iter().enumerate() {
            if removed_props[position] {
                continue;
            }
            let Some(PropMount::Surface { prop_id }) = &prop.mount else { continue };
            if !removed_ids.contains(prop_id) {
                continue;
            }
            removed_props[position] = true;
            removed_ids.insert(prop.id.clone());
            changed = true;
        }
    }
    // Гарнитур уходит вместе со столом: стул, смотрящий в пустое место, — тот
    // же «стул без стола».
    let removed = &props[index];
    if is_seating_surface(&removed.asset_id) {
        let own: HashSet<Cell> = removed.footprint.iter().map(|cell| (cell.x, cell.y)).collect();
        for (position, prop) in props.iter().enumerate() {
            if removed_props[position] || !is_seat(&prop.asset_id) {
                continue;
            }
            let (dx, dy) = facing_vector(prop.rotation);
            if prop.footprint.iter().any(|cell| own.contains(&(cell.x + dx, cell.y + dy))) {
                removed_props[position] = true;
            }
        }
    }
    let mut position = 0;
    props.retain(|_| {
        let keep = !removed_props[position];
        position += 1;
        keep
    });
    true
}

/// Ремонт доступа над отдельным списком предметов: карта даёт клетки, рёбра,
/// двери и точки появления, а предметы — `props`.
fn ensure_access_props(map: &TacticalMap, props: &mut Vec<TacticalProp>) {
    for _ in 0..PROP_ACCESS_REPAIR_LIMIT {
        // Цели пересчитываются на каждом шаге: снятый предмет освобождает
        // клетки под собой, и они тоже обязаны быть досягаемы.
        let Some(access) = prop_access_targets(map, props) else { break };
        let blockers = blocking_props_by_cell(props);
        let blocked_cells: HashSet<Cell> = blockers.keys().copied().collect();
        let Some(spawn) = party_spawn(map) else { break };
        if let Some(first) = blockers.get(&spawn).and_then(|owners| owners.first()).copied() {
            if !remove_blocking_prop(props, first) {
                break;
            }
            continue;
        }
        let reached = reachable_cells(map, spawn.0, spawn.1, true, Some(&blocked_cells));
        let unreached: IndexSet<Cell> = access.targets.iter().copied().filter(|key| !reached.contains(key)).collect();
        let pending = worth_repair(&unreached, &access.semantic);
        if pending.is_empty() {
            break;
        }
        let path_props = access_repair_path(map, props, &access.baseline, &reached, &pending, &blockers);
        let Some(first) = path_props.first().copied() else { break };
        if !remove_blocking_prop(props, first) {
            break;
        }
    }
}

/// `ensurePropAccess(map)`: восстанавливает доступ к новой карте после
/// расстановки предметов. Геометрия и рёбра не меняются: проход снимает
/// только ближайший предмет, если он запер изначально доступную клетку,
/// дверной порог или точку появления. Не больше двенадцати предметов.
pub fn ensure_prop_access(map: &mut TacticalMap) {
    let mut props = std::mem::take(&mut map.props);
    ensure_access_props(map, &mut props);
    map.props = props;
}

// --- расстановка -------------------------------------------------------------------

/// Значение предмета для `addProp` из записи реестра.
fn prop_value(id: String, asset: &AssetEntry, x: f64, y: f64, rotation: f64, scale: f64, footprint: &[Point], z_order: i64) -> Value {
    let cells: Vec<Value> = footprint.iter().map(|cell| json!({ "x": cell.x, "y": cell.y })).collect();
    let mut prop = Map::new();
    prop.insert("id".into(), Value::String(id));
    prop.insert("assetId".into(), Value::String(asset.id.clone()));
    prop.insert("x".into(), js::num(x));
    prop.insert("y".into(), js::num(y));
    prop.insert("rotation".into(), js::num(rotation));
    prop.insert("scale".into(), js::num(scale));
    prop.insert("footprint".into(), Value::Array(cells));
    prop.insert("zOrder".into(), Value::from(z_order));
    prop.insert("blocksMove".into(), Value::Bool(asset.blocks_move));
    prop.insert("blocksSight".into(), Value::Bool(asset.blocks_sight));
    prop.insert("cover".into(), Value::String(asset.cover.clone()));
    prop.insert("destructible".into(), Value::Bool(asset.destructible));
    prop.insert("hp".into(), js::num(asset.hp));
    prop.insert("interactive".into(), Value::Bool(asset.interactive));
    Value::Object(prop)
}

/// `addProp` для предмета из реестра: такой предмет всегда принимается
/// (укрытие из реестра, непустой id, без перехода), отказ JS здесь
/// невозможен — поэтому ошибка не поднимается выше.
pub(crate) fn add_registry_prop(map: &mut TacticalMap, prop: &Value) {
    let _ = add_prop(map, prop);
}

/// Очередь зоны: что вообще ставим (`wanted`) и счётчики потолков.
struct ZoneQueue<'a> {
    allowed: HashSet<&'a str>,
    caps: IndexMap<String, Option<f64>>,
    budget: f64,
    cells_len: usize,
    wanted: Vec<&'static AssetEntry>,
    counts: HashMap<&'static str, usize>,
    required_counts: HashMap<&'static str, usize>,
    required_assets: Vec<&'static AssetEntry>,
}

impl ZoneQueue<'_> {
    fn below_budget(&self) -> bool {
        (self.wanted.len() as f64) < self.budget
    }

    /// `profileCaps[id]` с запасным потолком.
    fn cap_for(&self, id: &str, fallback: f64) -> f64 {
        match self.caps.get(id) {
            Some(Some(cap)) => *cap,
            _ => fallback,
        }
    }

    fn enqueue(&mut self, asset: Option<&'static AssetEntry>, with_companions: bool, required: bool) -> bool {
        let Some(asset) = asset else { return false };
        let id = asset.id.as_str();
        // Обязательное резервируется до спутников и не вытесняется плотностью.
        if !self.allowed.contains(id) || (!required && !self.below_budget()) {
            return false;
        }
        // Плоская мелочь без футпринта не перегружает зону.
        let decal_cap = if falsy_number(asset.base_footprint.w) && !is_tableware(id) && !WALL_MOUNTS.contains(&id) {
            js_max(2.0, js::round(self.cells_len as f64 / 60.0))
        } else {
            f64::INFINITY
        };
        let cap = self.cap_for(id, decal_cap);
        let current = self.counts.get(id).copied().unwrap_or(0);
        if cap.is_finite() && current as f64 >= cap {
            return false;
        }
        self.wanted.push(asset);
        self.counts.insert(id, current + 1);
        if required {
            self.required_assets.push(asset);
            *self.required_counts.entry(id).or_insert(0) += 1;
        }
        if with_companions {
            self.enqueue_companions(id);
        }
        true
    }

    fn enqueue_companions(&mut self, id: &str) {
        for (companion, count) in companions(id) {
            // Сиденья приходят гарнитуром вместе с поверхностью (`arrangeSeats`).
            if is_seat(companion) {
                continue;
            }
            let mut index = 0;
            while index < *count && self.below_budget() {
                self.enqueue(asset_by_id(companion), false, false);
                index += 1;
            }
        }
    }
}

fn area(asset: &AssetEntry) -> f64 {
    asset.base_footprint.w * asset.base_footprint.h
}

fn number_order(value: f64) -> Ordering {
    if value < 0.0 {
        Ordering::Less
    } else if value > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// Элемент очереди расстановки: предмет, обязательность экземпляра и
/// «стул, ради которого позвали столик» (`requeued`).
#[derive(Clone, Copy)]
struct OrderEntry {
    asset: &'static AssetEntry,
    required: bool,
    requeued: bool,
}

/// Стоит ли в зоне поверхность, у которой сидят (`hasSurface`).
fn zone_has_seating_surface(map: &TacticalMap, zone_id: &str) -> bool {
    map.props.iter().any(|prop| {
        is_seating_surface(&prop.asset_id) && !prop.footprint.is_empty() && cell_at(map, prop.footprint[0].x, prop.footprint[0].y).is_some_and(|cell| cell.zone == zone_id)
    })
}

/// Место у стола зоны для одного сиденья (`joinTable`).
fn join_table(map: &TacticalMap, zone_id: &str, seat_asset: &AssetEntry, blocked_now: &HashSet<Cell>) -> Option<Seat> {
    let spec = [(seat_asset.id.clone(), 1)];
    for prop in &map.props {
        if !is_seating_surface(&prop.asset_id) || prop.footprint.is_empty() || !cell_at(map, prop.footprint[0].x, prop.footprint[0].y).is_some_and(|cell| cell.zone == zone_id) {
            continue;
        }
        if let Some(seat) = arrange_seats(map, &SeatSurface::from_prop(prop), &spec, blocked_now).into_iter().next() {
            return Some(seat);
        }
    }
    None
}

/// Общее для `addSeat` и `seatPending` расстановки одной зоны.
struct SeatContext<'a> {
    zone_id: &'a str,
    max_props: i64,
    allowed: &'a HashSet<&'a str>,
    keep_clear: &'a HashSet<Cell>,
    thresholds: &'a HashSet<Cell>,
}

impl SeatContext<'_> {
    /// `addSeat`: сиденье на карту, в занятые клетки и в поставленное.
    fn add_seat(&self, map: &mut TacticalMap, seat: &Seat, counter: &mut i64, random: &mut SeedRandom, occupied: &mut HashSet<Cell>, placed: &mut Vec<Placed>) {
        let span = seat.asset.scale_range.max - seat.asset.scale_range.min;
        *counter += 1;
        let scale = js::parse_float(&js::to_fixed(seat.asset.scale_range.min + random.next() * span, 3));
        let prop = seat_prop_value(format!("prop-{counter}-{}", seat.asset.id), seat, scale);
        add_registry_prop(map, &prop);
        for cell in &seat.cells {
            occupied.insert((cell.x, cell.y));
        }
        placed.push(Placed { asset_id: seat.asset.id.clone(), x: seat.cells[0].x as f64, y: seat.cells[0].y as f64, zone_id: Some(self.zone_id.to_string()), footprint: seat.cells.clone() });
    }

    /// `seatPending`: гарнитур ожидающих поверхностей.
    #[allow(clippy::too_many_arguments)] // те же замыкания JS, что держат состояние зоны
    fn seat_pending(&self, map: &mut TacticalMap, pending: &mut Vec<SeatSurface>, counter: &mut i64, random: &mut SeedRandom, occupied: &mut HashSet<Cell>, placed: &mut Vec<Placed>) {
        for surface in std::mem::take(pending) {
            let spec: Vec<(String, usize)> = seat_spec_for(&surface.asset_id).into_iter().filter(|(id, _)| self.allowed.contains(id.as_str()) || id == "chair").collect();
            let mut blocked: HashSet<Cell> = occupied.clone();
            blocked.extend(self.keep_clear.iter().copied());
            blocked.extend(self.thresholds.iter().copied());
            let seats = arrange_seats(map, &surface, &spec, &blocked);
            for seat in &seats {
                if *counter < self.max_props {
                    self.add_seat(map, seat, counter, random, occupied, placed);
                }
            }
        }
    }
}

/// `normalizedPurpose`: псевдоним назначения или сам ключ.
fn normalized_purpose(value: &str) -> String {
    let key = purpose_key(value);
    table_lookup(&PURPOSE_ALIASES, &key).map_or(key.clone(), str::to_string)
}

/// Назначение, по которому `semanticProfileFor` нашёл профиль (`semantic?.purpose`).
fn semantic_purpose_for(plan: &ZonePlacementPlan) -> Option<String> {
    let explicit = normalized_purpose(&plan.purpose);
    if semantic_profile(&explicit).is_some() {
        return Some(explicit);
    }
    for tag in &plan.tags {
        if let Some(purpose) = table_lookup(&TAG_PURPOSES, &purpose_key(tag)) {
            if semantic_profile(purpose).is_some() {
                return Some(purpose.to_string());
            }
        }
    }
    None
}

/// `placeProps(map, { seed, zones, maxProps })`: раскладывает предметы по
/// карте и мутирует её. Плотность задаётся зоной, а не общим счётчиком.
/// Отказ возможен только у опор утвари ([`attach_prop_supports`]) — на
/// предмете с координатой NaN, как в JS.
pub fn place_props(map: &mut TacticalMap, seed: &str, zones: &[ZonePlacementPlan], max_props: i64) -> MapResult<()> {
    let mut random = SeedRandom::new(&format!("{PROP_PLACEMENT_VERSION}:{seed}"));
    let mut occupied: HashSet<Cell> = HashSet::new();
    for prop in &map.props {
        for cell in &prop.footprint {
            occupied.insert((cell.x, cell.y));
        }
    }
    let mut placed: Vec<Placed> = map
        .props
        .iter()
        .map(|prop| Placed {
            asset_id: prop.asset_id.clone(),
            x: prop.x.floor(),
            y: prop.y.floor(),
            zone_id: cell_at_floor(map, prop.x, prop.y).map(|cell| cell.zone.to_string()),
            footprint: prop.footprint.clone(),
        })
        .collect();
    let mut counter = map.props.len() as i64;
    // Точка появления — не место для мебели середины комнаты.
    let spawn_cells: HashSet<Cell> = map.spawn_points.iter().map(|point| (point.x, point.y)).collect();
    // Порог любой двери и клетка за ним по прямой закрыты для мебели всех зон;
    // тропа к двери дома (`path`) и крайние клетки карты — тоже.
    let mut thresholds = door_thresholds(map);
    for y in 0..map.height {
        for x in 0..map.width {
            let on_path = cell_at(map, x, y).is_some_and(|cell| cell.zone == "path");
            if on_path || x == 0 || y == 0 || x == map.width - 1 || y == map.height - 1 {
                thresholds.insert((x, y));
            }
        }
    }

    for plan in zones {
        let cells = zone_cells(map, &plan.zone_id);
        if cells.is_empty() {
            continue;
        }
        let semantic = semantic_profile_for(plan);
        let keep_clear = passage_clearance(map, &plan.zone_id, &cells);
        let zone_bounds = cells.iter().fold(ZoneBounds { min_x: i64::MAX, max_x: i64::MIN, min_y: i64::MAX, max_y: i64::MIN }, |bounds, cell| ZoneBounds {
            min_x: bounds.min_x.min(cell.x),
            max_x: bounds.max_x.max(cell.x),
            min_y: bounds.min_y.min(cell.y),
            max_y: bounds.max_y.max(cell.y),
        });
        let budget = js_max(0.0, js::round(cells.len() as f64 * js_max(0.0, plan.density) / 100.0));
        // Комната может брать предметы из нескольких тем: основная первой,
        // повторы отброшены.
        let mut themes: Vec<&str> = vec![plan.theme.as_str()];
        themes.extend(plan.extra_themes.iter().map(String::as_str));
        themes.extend(semantic.map_or(&[][..], |profile| profile.themes).iter().copied());
        let mut catalogue_map: IndexMap<&str, &'static AssetEntry> = IndexMap::new();
        for theme in themes {
            for record in assets_for_theme(theme) {
                catalogue_map.insert(record.id.as_str(), record);
            }
        }
        let catalogue: Vec<&'static AssetEntry> = catalogue_map.values().copied().collect();
        if catalogue.is_empty() {
            continue;
        }

        // Потолки профиля и плана складываются, план сильнее.
        let mut caps: IndexMap<String, Option<f64>> = IndexMap::new();
        for (id, cap) in semantic.map_or(&[][..], |profile| profile.caps) {
            caps.insert((*id).to_string(), Some(*cap));
        }
        for (id, cap) in &plan.caps {
            caps.insert(id.clone(), *cap);
        }
        let mut queue = ZoneQueue {
            allowed: catalogue.iter().map(|record| record.id.as_str()).collect(),
            caps,
            budget,
            cells_len: cells.len(),
            wanted: Vec::new(),
            counts: HashMap::new(),
            required_counts: HashMap::new(),
            required_assets: Vec::new(),
        };
        // Явные требования плана имеют приоритет: профиль добавляет
        // недостающие роли, но не вытесняет ключевой предмет.
        let mut required: Vec<String> = plan.require.clone();
        let semantic_require = semantic.map_or(&[][..], |profile| profile.require);
        for id in semantic_require {
            let required_count = semantic_require.iter().filter(|candidate| *candidate == id).count();
            let current_count = required.iter().filter(|candidate| candidate.as_str() == *id).count();
            for _ in current_count..required_count {
                required.push((*id).to_string());
            }
        }
        for id in &required {
            queue.enqueue(asset_by_id(id), false, true);
        }
        // Спутники заполняют только оставшийся бюджет.
        for asset in queue.required_assets.clone() {
            queue.enqueue_companions(&asset.id);
        }
        // Случайный добор идёт из `prefer`, если он задан, иначе из всего
        // каталога темы.
        let pool: Vec<&'static AssetEntry> = semantic
            .map_or(&[][..], |profile| profile.prefer)
            .iter()
            .copied()
            .chain(plan.prefer.iter().map(String::as_str))
            .filter_map(asset_by_id)
            .filter(|asset| {
                let cap = queue.cap_for(&asset.id, f64::NAN);
                queue.allowed.contains(asset.id.as_str()) && !(cap.is_finite() && cap <= 0.0)
            })
            .collect();
        let source: Vec<&'static AssetEntry> = if pool.is_empty() { catalogue.clone() } else { pool };
        let max_fill_attempts = js_max(32.0, budget * 8.0);
        // Новая утварь без стола в зоне не берётся в добор вовсе.
        let zone_has_surface = placed.iter().any(|record| record.zone_id.as_deref() == Some(plan.zone_id.as_str()) && SURFACES.contains(&record.asset_id.as_str()));
        // Добор взвешен против уже выбранного: каждый следующий экземпляр
        // того же предмета вдвое-втрое менее вероятен.
        let mut attempt = 0_usize;
        while queue.below_budget() && (attempt as f64) < max_fill_attempts {
            attempt += 1;
            let weights: Vec<f64> =
                source.iter().map(|asset| 1.0 / js_pow(1.0 + queue.counts.get(asset.id.as_str()).copied().unwrap_or(0) as f64, 1.6)).collect();
            let total = weights.iter().fold(0.0, |sum, weight| sum + weight);
            let mut roll = random.next() * total;
            let mut pick = source.last().copied();
            for (index, weight) in weights.iter().enumerate() {
                roll -= weight;
                if roll <= 0.0 {
                    pick = Some(source[index]);
                    break;
                }
            }
            let Some(pick) = pick else { break };
            if NEW_TABLEWARE.contains(&pick.id.as_str()) && !(queue.wanted.iter().any(|asset| SURFACES.contains(&asset.id.as_str())) || zone_has_surface) {
                continue;
            }
            queue.enqueue(Some(pick), true, false);
        }

        // Крупные предметы ставятся первыми, мелкая утварь — поверх и рядом.
        // Обязательность принадлежит конкретному экземпляру.
        let mut required_remaining = queue.required_counts.clone();
        let mut order: Vec<OrderEntry> = queue
            .wanted
            .iter()
            .map(|asset| {
                let remaining = required_remaining.get(asset.id.as_str()).copied().unwrap_or(0);
                let required = remaining > 0;
                if required {
                    required_remaining.insert(asset.id.as_str(), remaining - 1);
                }
                OrderEntry { asset, required, requeued: false }
            })
            .collect();
        order.sort_by(|left_entry, right_entry| {
            let (left, left_required) = (left_entry.asset, left_entry.required);
            let (right, right_required) = (right_entry.asset, right_entry.required);
            if left_required != right_required {
                return if left_required { Ordering::Less } else { Ordering::Greater };
            }
            if left_required {
                // Сначала крупное у стены со спутниками (стойка, очаг), затем
                // полка за стойкой, затем прочие поверхности со спутниками,
                // затем малые обязательные.
                let rank = |asset: &AssetEntry| {
                    let has = !companions(&asset.id).is_empty();
                    if has && asset.anchor == "wall" {
                        0
                    } else if asset.id == "bar_shelf" {
                        1
                    } else if has {
                        2
                    } else {
                        3
                    }
                };
                let (left_rank, right_rank) = (rank(left), rank(right));
                if left_rank != right_rank {
                    return left_rank.cmp(&right_rank);
                }
                return number_order(if left_rank < 3 { area(right) - area(left) } else { area(left) - area(right) });
            }
            number_order(area(right) - area(left))
        });

        let blocked_now = |occupied: &HashSet<Cell>| -> HashSet<Cell> {
            let mut blocked: HashSet<Cell> = occupied.clone();
            blocked.extend(keep_clear.iter().copied());
            blocked.extend(thresholds.iter().copied());
            blocked
        };
        // Сиденья обязательных столов ставятся после всех обязательных
        // предметов: иначе гарнитур занимал клетку, нужную лестнице или сундуку.
        let mut pending_surfaces: Vec<SeatSurface> = Vec::new();
        let seats_ctx = SeatContext { zone_id: &plan.zone_id, max_props, allowed: &queue.allowed, keep_clear: &keep_clear, thresholds: &thresholds };

        let mut index = 0;
        while index < order.len() && counter < max_props {
            let OrderEntry { asset, required, requeued } = order[index];
            let id = asset.id.as_str();
            if !required && !pending_surfaces.is_empty() {
                seats_ctx.seat_pending(map, &mut pending_surfaces, &mut counter, &mut random, &mut occupied, &mut placed);
                if counter >= max_props {
                    break;
                }
            }
            // Стул из добора сначала ищет место у стола. Без стола стоит только
            // обязательный (стул караульной, кресло кабинета).
            if is_seat(id) {
                let has_surface = |map: &TacticalMap| zone_has_seating_surface(map, &plan.zone_id);
                // Стул, ради которого позвали столик, уже сидит в его гарнитуре.
                if requeued && has_surface(map) {
                    index += 1;
                    continue;
                }
                if let Some(seat) = join_table(map, &plan.zone_id, asset, &blocked_now(&occupied)) {
                    seats_ctx.add_seat(map, &seat, &mut counter, &mut random, &mut occupied, &mut placed);
                    index += 1;
                    continue;
                }
                if !required || has_surface(map) {
                    index += 1;
                    continue;
                }
                // Обязательный стул в комнате без стола: сначала столик, и стул садится к нему.
                if let Some(table) = asset_by_id("table_small") {
                    if !requeued && queue.allowed.contains(table.id.as_str()) {
                        order.insert(index + 1, OrderEntry { asset: table, required: true, requeued: false });
                        order.insert(index + 2, OrderEntry { asset, required: true, requeued: true });
                        index += 1;
                        continue;
                    }
                }
            }
            // Просматривается ограниченная выборка клеток со сдвигом от номера
            // предмета: разные предметы видят разные клетки.
            let stride = if cells.len() > CANDIDATE_SCAN_LIMIT { (cells.len() as f64 / CANDIDATE_SCAN_LIMIT as f64).ceil() as usize } else { 1 };
            let offset = if stride > 1 { index % stride } else { 0 };
            let chosen = {
                let local_placed: Vec<&Placed> = placed.iter().filter(|record| record.zone_id.as_deref() == Some(plan.zone_id.as_str())).collect();
                // Соседство одинаковых считается внутри зоны.
                let same_asset: Vec<&Placed> = local_placed.iter().copied().filter(|record| record.asset_id == id).collect();
                let cluster_friendly = CLUSTER_FRIENDLY.contains(&id);
                // Для широкого предмета «одинаковое вплотную» проверяется по всему следу.
                let touching_same = |footprint: &[Point]| {
                    !cluster_friendly
                        && same_asset.iter().any(|record| {
                            let anchor = [(record.x, record.y)];
                            let points: Vec<(f64, f64)> =
                                if record.footprint.is_empty() { anchor.to_vec() } else { record.footprint.iter().map(|cell| (cell.x as f64, cell.y as f64)).collect() };
                            points.iter().any(|(px, py)| {
                                footprint.iter().any(|cell| js_max((cell.x as f64 - px).abs(), (cell.y as f64 - py).abs()) <= 1.0)
                            })
                        })
                };
                let context = ScoreContext {
                    zone_id: &plan.zone_id,
                    arrangement: semantic.map(|profile| profile.arrangement),
                    zone_bounds,
                    local_placed: &local_placed,
                    same_asset: &same_asset,
                };
                let mut candidates: Vec<(Point, f64)> = Vec::new();
                let mut position = offset;
                while position < cells.len() {
                    let cell = cells[position];
                    position += stride;
                    let key = (cell.x, cell.y);
                    if occupied.contains(&key) || keep_clear.contains(&key) || thresholds.contains(&key) {
                        continue;
                    }
                    let score = score_cell_for_asset(map, asset, cell, &context, &mut random);
                    if score == f64::NEG_INFINITY {
                        continue;
                    }
                    candidates.push((cell, score));
                }
                if candidates.is_empty() {
                    index += 1;
                    continue;
                }
                candidates.sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(Ordering::Equal));

                let blocked = |key: Cell| occupied.contains(&key) || keep_clear.contains(&key) || thresholds.contains(&key);
                let candidate_limit = if required { REQUIRED_PLACEMENT_ATTEMPTS } else { PLACEMENT_ATTEMPTS };
                let try_candidates = |slice: &[(Point, f64)], random: &mut SeedRandom| {
                    for (cell, _) in slice {
                        let rotation = rotation_for(map, asset, *cell, &placed, &plan.zone_id, random, Some(zone_bounds));
                        let Some(footprint) = fitting_footprint(map, &blocked, *cell, asset.base_footprint.w, asset.base_footprint.h, rotation) else {
                            continue;
                        };
                        // Вторая клетка шкафа тоже не встаёт перед окном.
                        if asset.blocks_sight && footprint.iter().any(|point| window_beside(map, point.x, point.y)) {
                            continue;
                        }
                        if touching_same(&footprint) {
                            continue;
                        }
                        return Some((*cell, rotation, footprint));
                    }
                    None
                };
                let first = &candidates[..candidates.len().min(candidate_limit)];
                let mut chosen = try_candidates(first, &mut random);
                // Обязательный, не поместившийся в первых лучших позициях,
                // проверяет следующий слой кандидатов до отказа.
                if chosen.is_none() && required && candidates.len() > candidate_limit {
                    let end = candidates.len().min(candidate_limit + REQUIRED_RETRY_ATTEMPTS);
                    chosen = try_candidates(&candidates[candidate_limit..end], &mut random);
                }
                chosen
            };
            let Some((cell, rotation, footprint)) = chosen else {
                index += 1;
                continue;
            };

            let span = asset.scale_range.max - asset.scale_range.min;
            counter += 1;
            let scale = js::parse_float(&js::to_fixed(asset.scale_range.min + random.next() * span, 3));
            let z_order = if falsy_number(asset.base_footprint.w) { 1 } else { 0 };
            let prop = prop_value(format!("prop-{counter}-{id}"), asset, cell.x as f64 + 0.5, cell.y as f64 + 0.5, rotation, scale, &footprint, z_order);
            add_registry_prop(map, &prop);
            for point in &footprint {
                occupied.insert((point.x, point.y));
            }
            placed.push(Placed { asset_id: id.to_string(), x: cell.x as f64, y: cell.y as f64, zone_id: Some(plan.zone_id.clone()), footprint });
            if is_seating_surface(id) {
                if let Some(last) = map.props.last() {
                    pending_surfaces.push(SeatSurface::from_prop(last));
                }
                if !required {
                    seats_ctx.seat_pending(map, &mut pending_surfaces, &mut counter, &mut random, &mut occupied, &mut placed);
                }
            }
            index += 1;
        }
        seats_ctx.seat_pending(map, &mut pending_surfaces, &mut counter, &mut random, &mut occupied, &mut placed);
        let centerpiece = if counter < max_props {
            let explicit = normalized_purpose(&plan.purpose);
            let purpose = if explicit.is_empty() { semantic_purpose_for(plan).unwrap_or_default() } else { explicit };
            let mut blocked = blocked_now(&occupied);
            blocked.extend(spawn_cells.iter().copied());
            core_centerpiece(map, &plan.zone_id, &purpose, &cells, &queue.allowed, &queue.caps, &blocked)
        } else {
            None
        };
        if let Some(Centerpiece { asset, cell, footprint, rotation }) = centerpiece {
            let span = asset.scale_range.max - asset.scale_range.min;
            counter += 1;
            let scale = js::parse_float(&js::to_fixed(asset.scale_range.min + random.next() * span, 3));
            let z_order = if falsy_number(asset.base_footprint.w) { 1 } else { 0 };
            let prop = prop_value(format!("prop-{counter}-{}", asset.id), asset, cell.x as f64 + 0.5, cell.y as f64 + 0.5, rotation, scale, &footprint, z_order);
            add_registry_prop(map, &prop);
            for point in &footprint {
                occupied.insert((point.x, point.y));
            }
            placed.push(Placed { asset_id: asset.id.clone(), x: cell.x as f64, y: cell.y as f64, zone_id: Some(plan.zone_id.clone()), footprint });
            if is_seating_surface(&asset.id) {
                if let Some(last) = map.props.last() {
                    pending_surfaces.push(SeatSurface::from_prop(last));
                }
                seats_ctx.seat_pending(map, &mut pending_surfaces, &mut counter, &mut random, &mut occupied, &mut placed);
            }
        }
    }
    attach_prop_supports(map)
}

/// Тема предмета под крышей (`INDOOR_THEMES.has(theme)`).
pub fn is_indoor_theme(theme: &str) -> bool {
    INDOOR_THEMES.contains(&theme)
}

/// Переживут ли предметы ремонт доступа (`survivesAccessRepair`): проба на
/// копии списка предметов, карта не меняется.
fn survives_access_repair(map: &TacticalMap, ids: &[String]) -> bool {
    let mut probe = map.props.clone();
    ensure_access_props(map, &mut probe);
    let kept: HashSet<&str> = probe.iter().map(|prop| prop.id.as_str()).collect();
    ids.iter().all(|id| kept.contains(id.as_str()))
}

/// Обещанное сценой: «вид → штук» (`{ assets, count }`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RequiredProps {
    /// Подходящие виды; ставится первый известный реестру.
    pub assets: Vec<String>,
    /// Сколько нужно; NaN — как `undefined` в JS (ничего не ставится).
    pub count: f64,
}

impl RequiredProps {
    /// Требование из объекта JS `{ assets: string[], count: number }`.
    pub fn from_json(value: &Value) -> Self {
        Self { assets: string_list(value.get("assets")), count: js::number(value.get("count")) }
    }
}

/// `placeRequiredProps(map, wanted, { seed })`: ставит недостающие обещанные
/// сценой предметы той же расстановкой, как обязательные. Предмет под крышу
/// ищет комнату, уличный — двор или улицу; не поместилось — обещание остаётся
/// невыполненным. Возвращает, сколько предметов поставлено (как в JS, число
/// может уйти в минус, если опоры утвари сняли посторонние предметы).
pub fn place_required_props(map: &mut TacticalMap, wanted: &[RequiredProps], seed: &str) -> MapResult<i64> {
    let mut added = 0_i64;
    for (index, requirement) in wanted.iter().enumerate() {
        let ids: HashSet<&str> = requirement.assets.iter().map(String::as_str).collect();
        let Some(asset) = requirement.assets.iter().find_map(|id| asset_by_id(id)) else { continue };
        let present = map.props.iter().filter(|prop| ids.contains(prop.asset_id.as_str())).count();
        let mut missing = js_max(1.0, requirement.count) - present as f64;
        if !(missing > 0.0) {
            continue;
        }
        let indoor = asset.themes.iter().any(|theme| is_indoor_theme(theme)) && !asset.themes.iter().any(|theme| theme == "exterior");
        // Зоны с местом: сначала подходящего рода, крупные первыми. Тропа к
        // двери — проход, а не место для обещанного.
        let sized: Vec<(String, String, usize)> = map
            .zones
            .iter()
            .filter(|zone| zone.id != "path")
            .map(|zone| (zone.id.clone(), zone.kind.clone(), zone_cells(map, &zone.id).len()))
            .filter(|(_, _, size)| *size >= 4)
            .collect();
        let fitting: Vec<(String, String, usize)> =
            sized.iter().filter(|(_, kind, _)| if indoor { kind == "interior" } else { kind != "interior" }).cloned().collect();
        let mut order = if fitting.is_empty() { sized } else { fitting };
        order.sort_by(|left, right| right.2.cmp(&left.2).then_with(|| text::locale_compare(&left.0, &right.0)));
        let theme = asset.themes.first().cloned().unwrap_or_default();
        let mut attempt = 0_usize;
        while missing > 0.0 && (attempt as f64) < missing + (order.len() * 2) as f64 {
            if order.is_empty() {
                break;
            }
            let zone_id = order[attempt % order.len()].0.clone();
            let before = map.props.len();
            let plan = ZonePlacementPlan {
                zone_id,
                theme: theme.clone(),
                density: 0.0,
                require: vec![asset.id.clone()],
                caps: vec![(asset.id.clone(), Some(f64::INFINITY))],
                ..ZonePlacementPlan::default()
            };
            place_props(map, &format!("{seed}:required:{index}:{attempt}"), &[plan], before as i64 + 1)?;
            let placed_now = map.props.len() as i64 - before as i64;
            // Свой префикс: номер по счётчику мог совпасть с предметом, который
            // ремонт доступа уже убрал.
            let renamed = format!("required-{index}-{attempt}-{}", asset.id);
            if map.props.len() > before {
                for prop in &mut map.props[before..] {
                    prop.id = renamed.clone();
                }
            }
            // Место, которое ремонт доступа потом расчистит, обещанному не годится.
            if placed_now > 0 {
                let ids: Vec<String> = map.props[before..].iter().map(|prop| prop.id.clone()).collect();
                if !survives_access_repair(map, &ids) {
                    map.props.truncate(before);
                    attempt += 1;
                    continue;
                }
            }
            missing -= placed_now as f64;
            added += placed_now;
            attempt += 1;
        }
    }
    Ok(added)
}

/// `placeColonnade(map, { zoneId, assetId, idPrefix })`: два ровных ряда опор
/// вдоль длинной оси зала, на шаг от стен; в нефе шире 15 клеток — и средние
/// ряды. Ряды не встают на подходы к дверям и сквозной проход. Возвращает,
/// сколько опор поставлено. По умолчанию `asset_id` — `pillar`, `id_prefix` —
/// `colonnade`.
pub fn place_colonnade(map: &mut TacticalMap, zone_id: &str, asset_id: &str, id_prefix: &str) -> usize {
    let Some(asset) = asset_by_id(asset_id) else { return 0 };
    let cells = zone_cells(map, zone_id);
    if cells.len() < 35 {
        return 0;
    }
    let min_x = cells.iter().map(|cell| cell.x).min().unwrap_or(0);
    let max_x = cells.iter().map(|cell| cell.x).max().unwrap_or(0);
    let min_y = cells.iter().map(|cell| cell.y).min().unwrap_or(0);
    let max_y = cells.iter().map(|cell| cell.y).max().unwrap_or(0);
    let horizontal = max_x - min_x >= max_y - min_y;
    let length = (if horizontal { max_x - min_x } else { max_y - min_y }) + 1;
    let breadth = (if horizontal { max_y - min_y } else { max_x - min_x }) + 1;
    if length < 7 || breadth < 5 {
        return 0;
    }
    let in_zone: HashSet<Cell> = cells.iter().map(|cell| (cell.x, cell.y)).collect();
    let clear = passage_clearance(map, zone_id, &cells);
    let mut occupied: HashSet<Cell> = HashSet::new();
    for prop in &map.props {
        for cell in &prop.footprint {
            occupied.insert((cell.x, cell.y));
        }
    }
    // Ряды — на шаг от длинных стен; в широком зале — на два.
    let inset = if breadth >= 9 { 2 } else { 1 };
    let first = (if horizontal { min_y } else { min_x }) + inset;
    let last = (if horizontal { max_y } else { max_x }) - inset;
    let mut rows = vec![first, last];
    if breadth >= 15 {
        let inner = ((last - first) as f64 / 7.0).ceil() as i64 - 1;
        for index in 1..=inner {
            rows.push(js::round(first as f64 + ((last - first) * index) as f64 / (inner + 1) as f64) as i64);
        }
    }
    let mut placed = 0;
    // В длинном зале опоры — через две клетки, в коротком — через одну.
    let step = if length >= 12 { 3 } else { 2 };
    for row in rows {
        let mut along = (if horizontal { min_x } else { min_y }) + 1;
        let end = (if horizontal { max_x } else { max_y }) - 1;
        while along <= end {
            let cell = if horizontal { (along, row) } else { (row, along) };
            along += step;
            if !in_zone.contains(&cell) || clear.contains(&cell) || occupied.contains(&cell) {
                continue;
            }
            // Колонна не встаёт вплотную к проходу.
            if ACCESS_DIRECTIONS.iter().any(|(dx, dy)| clear.contains(&(cell.0 + dx, cell.1 + dy))) {
                continue;
            }
            let prop = prop_value(format!("{id_prefix}-{zone_id}-{}", placed + 1), asset, cell.0 as f64 + 0.5, cell.1 as f64 + 0.5, 0.0, 1.0, &[point(cell)], 0);
            add_registry_prop(map, &prop);
            occupied.insert(cell);
            placed += 1;
        }
    }
    placed
}

/// `attachPropSupports(map)`: мелочь без игровой площади получает явную опору
/// на ближайшем столе той же зоны, настенное — сторону стены. Новая утварь
/// без опоры снимается. Отказ — только у настенного предмета с координатой
/// NaN: `wallSidesAt` в JS бросает `EDGE_CELLS_NOT_ADJACENT`.
pub fn attach_prop_supports(map: &mut TacticalMap) -> MapResult<()> {
    struct Surface {
        id: String,
        x: f64,
        y: f64,
        width: f64,
        depth: f64,
        scale: f64,
        z_order: i64,
        slots: usize,
        zone: Option<String>,
    }
    let surfaces: Vec<Surface> = map
        .props
        .iter()
        .filter(|prop| SURFACES.contains(&prop.asset_id.as_str()) && !prop.footprint.is_empty() && !["toppled", "broken", "burned"].contains(&prop.state.as_str()))
        .map(|prop| {
            let min_x = prop.footprint.iter().map(|cell| cell.x).min().unwrap_or(0) as f64;
            let max_x = prop.footprint.iter().map(|cell| cell.x).max().unwrap_or(0) as f64 + 1.0;
            let min_y = prop.footprint.iter().map(|cell| cell.y).min().unwrap_or(0) as f64;
            let max_y = prop.footprint.iter().map(|cell| cell.y).max().unwrap_or(0) as f64 + 1.0;
            Surface {
                id: prop.id.clone(),
                x: (min_x + max_x) / 2.0,
                y: (min_y + max_y) / 2.0,
                width: max_x - min_x,
                depth: max_y - min_y,
                scale: prop.scale,
                z_order: prop.z_order,
                slots: SURFACE_SLOTS.len().min(2.max(prop.footprint.len() * 2)),
                zone: cell_at_floor(map, prop.x, prop.y).map(|cell| cell.zone.to_string()),
            }
        })
        .collect();
    let mut used: HashMap<String, usize> = HashMap::new();
    let mut discard: HashSet<String> = HashSet::new();
    for prop in &map.props {
        if let Some(PropMount::Surface { prop_id }) = &prop.mount {
            *used.entry(prop_id.clone()).or_insert(0) += 1;
        }
    }
    for index in 0..map.props.len() {
        let prop = &map.props[index];
        if prop.mount.is_some() {
            continue;
        }
        if WALL_MOUNTS.contains(&prop.asset_id.as_str()) {
            let sides = wall_sides_at_prop(map, prop.x, prop.y)?;
            let rotation = prop.rotation;
            if let Some(side) = sides.iter().find(|candidate| candidate.facing == rotation).or(sides.first()) {
                let letter = if side.dy < 0 {
                    "n"
                } else if side.dx > 0 {
                    "e"
                } else if side.dy > 0 {
                    "s"
                } else {
                    "w"
                };
                map.props[index].mount = Some(PropMount::Wall { side: letter });
            }
            continue;
        }
        if !is_tableware(&prop.asset_id) || !prop.footprint.is_empty() || prop.interactive || prop.blocks_move || prop.blocks_sight {
            continue;
        }
        let zone = cell_at_floor(map, prop.x, prop.y).map(|cell| cell.zone.to_string());
        let (px, py) = (prop.x, prop.y);
        let mut candidates: Vec<&Surface> = surfaces
            .iter()
            .filter(|surface| surface.zone == zone && js_max((surface.x - px).abs(), (surface.y - py).abs()) <= 4.0 && used.get(&surface.id).copied().unwrap_or(0) < surface.slots)
            .collect();
        candidates.sort_by(|a, b| {
            let difference = js_hypot(a.x - px, a.y - py) - js_hypot(b.x - px, b.y - py);
            if difference != 0.0 && !difference.is_nan() {
                return number_order(difference);
            }
            text::locale_compare(&a.id, &b.id)
        });
        let Some(surface) = candidates.first() else {
            // Новая мелкая утварь не должна тихо падать на пол.
            if NEW_TABLEWARE.contains(&prop.asset_id.as_str()) {
                discard.insert(prop.id.clone());
            }
            continue;
        };
        let slot = used.get(&surface.id).copied().unwrap_or(0);
        let (dx, dy) = SURFACE_SLOTS[slot];
        let x = js::parse_float(&js::to_fixed(surface.x + dx * surface.width * surface.scale, 3));
        let y = js::parse_float(&js::to_fixed(surface.y + dy * surface.depth * surface.scale, 3));
        let (surface_id, surface_z) = (surface.id.clone(), surface.z_order);
        let target = &mut map.props[index];
        target.x = x;
        target.y = y;
        target.z_order = target.z_order.max(surface_z + 1);
        target.mount = Some(PropMount::Surface { prop_id: surface_id.clone() });
        used.insert(surface_id, slot + 1);
    }
    if !discard.is_empty() {
        map.props.retain(|prop| !discard.contains(&prop.id));
    }
    Ok(())
}

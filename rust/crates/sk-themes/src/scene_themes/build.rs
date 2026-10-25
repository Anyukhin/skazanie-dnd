//! `buildThemedScene` — единая точка сборки сцены по теме — и узкий фасад
//! `layoutSettlement`.

use serde_json::{json, Map, Value};
use sk_buildings::building_generator::{build_ares_fortress_scene, build_building_scene, ensure_declared_transitions};
use sk_core::{js, text};
use sk_map_core::authored_location_maps::authored_location_map_for;
use sk_map_core::room_floors::{apply_room_floors, RoomContext, RoomFloorsOptions};
use sk_map_core::scene_features::{deepest_room, raise_dais, DaisOptions};
use sk_map_core::thin_walls::{thin_walls, ThinWallsOptions};
use sk_props::prop_placement::{ensure_prop_access, place_colonnade, place_props, ZonePlacementPlan};
use sk_props::scene_dressing::{mark_low_furniture, place_ruins_field, place_vignettes, roughen_ground, vignettes_named_by, RoughKind, RoughOptions, RuinsFieldOptions, VignetteOptions};
use sk_settlements::graph_layout::{build_scene_from_graph, GraphLayoutOptions};
use sk_settlements::settlement_generator::{build_settlement_scene, LARGE_HOUSE_FLOOR};
use sk_tactical::tactical_map::{self as tm, TacticalMap};

use super::catalog::{theme_by_id, theme_for, theme_min_size, SceneTheme, CAMP_INTERIOR_OFF};
use super::cave::{layout_organic_cave, outline_impassable_cells, LayoutOptions};
use super::graph::{add_shortcut_loops, partition_prison_cells, pierce_walls, scene_graph_for_theme, ShortcutLock, ShortcutOptions};
use super::open::{dress_water_edges, layout_open, place_grave_rows, place_nature_cover, place_ruin_fragments, roughen_open_terrain};
use super::{Result, ThemeError};

/// Этаж, который объявил сам генератор (двухэтажная постройка поселения).
#[derive(Clone, Debug, PartialEq)]
pub struct SceneLevel {
    pub offset: f64,
    pub hint: String,
    pub label: String,
}

impl SceneLevel {
    /// Форма JS: `{ offset, hint, label }`.
    pub fn to_json(&self) -> Value {
        json!({ "offset": js::num(self.offset), "hint": self.hint, "label": self.label })
    }
}

/// Итог `buildThemedScene`: карта, id темы, предупреждения и объявленные
/// генератором этажи (`None` — поля нет).
#[derive(Clone, Debug, PartialEq)]
pub struct ThemedScene {
    pub map: TacticalMap,
    pub theme: String,
    pub warnings: Vec<String>,
    pub levels: Option<Vec<SceneLevel>>,
}

impl ThemedScene {
    /// `levels` в форме JS.
    pub fn levels_json(&self) -> Option<Value> {
        self.levels.as_ref().map(|levels| Value::Array(levels.iter().map(SceneLevel::to_json).collect()))
    }
}

/// Поле рыхлого объекта (`value?.[key]`).
fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|object| object.get(key))
}

/// Строгое сравнение поля со строкой (`design.topology === 'market'`).
fn is(value: &Value, key: &str, expected: &str) -> bool {
    field(value, key).and_then(Value::as_str) == Some(expected)
}

/// Значение параметра с умолчанием JS: отсутствие — `default`.
fn param(options: &Value, key: &str, default: Value) -> Value {
    field(options, key).cloned().unwrap_or(default)
}

/// Строка параметра в шаблоне (`${value}`).
fn template(value: &Value) -> String {
    js::string(Some(value))
}

/// Строка-аргумент `boundedText` JS: не строка — пусто.
fn text_or_empty(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

fn strings(items: &[&str]) -> Value {
    Value::Array(items.iter().map(|item| json!(item)).collect())
}

/// Заявки зон для `placeProps` из объектов JS.
fn plans(zones: &[Value]) -> Vec<ZonePlacementPlan> {
    zones.iter().filter_map(ZonePlacementPlan::from_json).collect()
}

fn max_props(map: &TacticalMap) -> i64 {
    tm::size_class(&map.size_class).map_or(tm::SIZE_CLASSES[0].1.max_props, |limits| limits.max_props)
}

/// `{ ...a, ...b }` для объектов.
fn spread(base: &Value, patch: &Value) -> Value {
    let mut result = base.as_object().cloned().unwrap_or_default();
    if let Value::Object(patch) = patch {
        for (key, value) in patch {
            result.insert(key.clone(), value.clone());
        }
    }
    Value::Object(result)
}

/// `[...(base ?? []), ...extra]` для списка строк.
fn extend(base: Option<&Value>, extra: &[&str]) -> Value {
    let mut items: Vec<Value> = match base {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    items.extend(extra.iter().map(|item| json!(item)));
    Value::Array(items)
}

/// `a ?? b` для полей объекта.
fn either(first: Option<&Value>, second: Option<&Value>) -> Option<Value> {
    first.filter(|value| !value.is_null()).or(second.filter(|value| !value.is_null())).cloned()
}

fn insert_opt(object: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        object.insert(key.into(), value);
    }
}

/// Объект параметров генератора `{ seed, width, height, locationId, theme, … }`.
fn generator_options(pairs: &[(&str, &Value)]) -> Value {
    Value::Object(pairs.iter().map(|(key, value)| ((*key).to_string(), (*value).clone())).collect())
}

/// `buildThemedScene(options)`: собирает сцену по теме. Вход — объект JS
/// `{ location, theme, sceneKind, seed, width, height, locationId, themeId,
/// design, levels, entry, description }`; `null` — `TypeError`, как в JS.
pub fn build_themed_scene(options: &Value) -> Result<ThemedScene> {
    if options.is_null() {
        return Err(ThemeError::type_error("location"));
    }
    let empty_text = Value::String(String::new());
    let location = param(options, "location", empty_text.clone());
    let theme = param(options, "theme", empty_text.clone());
    let scene_kind = param(options, "sceneKind", empty_text.clone());
    let seed_value = param(options, "seed", json!("scene"));
    let mut width = param(options, "width", json!(26));
    let mut height = param(options, "height", json!(26));
    let location_id = param(options, "locationId", empty_text.clone());
    let theme_id = param(options, "themeId", empty_text.clone());
    let design = param(options, "design", json!({}));
    let levels = param(options, "levels", json!([]));
    let entry = param(options, "entry", json!("exterior"));
    let description = param(options, "description", empty_text.clone());
    let seed = template(&seed_value);

    let scene_text = text::lower(&format!("{} {} {}", template(&location), template(&theme), template(&description)));
    let ruins_asked = text::test(sk_core::re!(r"руин|развалин|заброшен|древн|остов|пепелищ|сгоревш", "u"), &scene_text);
    let chosen: Option<&'static SceneTheme> = if js::truthy(Some(&theme_id)) {
        Some(match theme_id.as_str() {
            Some(id) => theme_by_id(id),
            None => theme_by_id(""),
        })
    } else {
        None
    };
    let definition = chosen.unwrap_or_else(|| theme_for(&json!({ "location": location, "theme": theme, "sceneKind": scene_kind })));
    let def = definition.json();
    if let Some(minimum) = theme_min_size(definition.id) {
        let number_or_zero = |value: &Value| {
            let number = js::number(Some(value));
            if number.is_nan() {
                0.0
            } else {
                number
            }
        };
        width = js::num(number_or_zero(&width).max(minimum.width as f64));
        height = js::num(number_or_zero(&height).max(minimum.height as f64));
    }

    if let Some(authored) = authored_location_map_for(Some(&location_id)) {
        let theme = if authored.theme.is_empty() { definition.id.to_string() } else { authored.theme.clone() };
        return Ok(ThemedScene { map: authored, theme, warnings: Vec::new(), levels: None });
    }

    let id_value = json!(definition.id);
    if definition.kind == "fortress" {
        let built = build_ares_fortress_scene(&generator_options(&[("seed", &seed_value), ("width", &width), ("height", &height), ("locationId", &location_id), ("theme", &id_value)]))?;
        return Ok(ThemedScene { map: built.map, theme: definition.id.into(), warnings: built.warnings, levels: None });
    }

    if definition.kind == "building" {
        let mut built = build_building_scene(&generator_options(&[
            ("seed", &seed_value),
            ("width", &width),
            ("height", &height),
            ("locationId", &location_id),
            ("theme", &id_value),
            ("levels", &levels),
            ("design", &design),
            ("entry", &entry),
        ]))?;
        let tavern_hall = if built.map.props.iter().any(|prop| prop.asset_id == "bar_counter") { built.map.zones.iter().find(|zone| zone.id == "hall").map(|zone| zone.id.clone()) } else { None };
        if let Some(hall) = tavern_hall {
            let zones = [hall.clone()];
            let vignette = |hug_walls: bool| VignetteOptions { seed: &seed, set: "tavern", zones: Some(&zones), limit: 0, text: &scene_text, hug_walls };
            let mut placed = place_vignettes(&mut built.map, &vignette(false));
            if placed.is_empty() && !vignettes_named_by("tavern", &scene_text).is_empty() {
                placed = place_vignettes(&mut built.map, &vignette(true));
                let seat = sk_core::re!(r"^(table_|chair|stool|bench)", "u");
                let seats: Vec<String> = built
                    .map
                    .props
                    .iter()
                    .filter(|prop| {
                        let (x, y) = prop.footprint.first().map_or((prop.x.floor() as i64, prop.y.floor() as i64), |cell| (cell.x, cell.y));
                        text::test(seat, &prop.asset_id) && tm::cell_at(&built.map, x, y).is_some_and(|cell| cell.zone == hall)
                    })
                    .map(|prop| prop.id.clone())
                    .collect();
                for seat_id in seats {
                    if !placed.is_empty() {
                        break;
                    }
                    built.map.props.retain(|prop| prop.id != seat_id);
                    placed = place_vignettes(&mut built.map, &vignette(true));
                }
            }
            if !placed.is_empty() {
                ensure_prop_access(&mut built.map);
            }
        }
        return Ok(ThemedScene { map: built.map, theme: definition.id.into(), warnings: built.warnings, levels: None });
    }

    if definition.kind == "graph" {
        return build_graph_scene(definition, &GraphInput { seed: &seed, width: &width, height: &height, location_id: &location_id, location: &location, theme: &theme, scene_text: &scene_text });
    }

    if definition.kind == "settlement" {
        let built = build_settlement_scene(&generator_options(&[
            ("seed", &seed_value),
            ("width", &width),
            ("height", &height),
            ("locationId", &location_id),
            ("theme", def),
            ("design", &design),
        ]))?;
        if design.is_null() {
            return Err(ThemeError::type_error("topology"));
        }
        return build_settlement_branch(definition, built, &SettlementInput { seed: &seed, design: &design, levels: &levels, scene_text: &scene_text, ruins_asked });
    }

    if design.is_null() {
        return Err(ThemeError::type_error("climate"));
    }
    build_open_scene(definition, &OpenInput { seed: &seed, width: &width, height: &height, location_id: &location_id, location: &location, theme: &theme, design: &design, scene_text: &scene_text, ruins_asked })
}

struct GraphInput<'a> {
    seed: &'a str,
    width: &'a Value,
    height: &'a Value,
    location_id: &'a Value,
    location: &'a Value,
    theme: &'a Value,
    scene_text: &'a str,
}

fn prop_plans(def: &Value) -> &[Value] {
    match def.get("propPlans") {
        Some(Value::Array(plans)) => plans,
        _ => &[],
    }
}

fn build_graph_scene(definition: &'static SceneTheme, input: &GraphInput<'_>) -> Result<ThemedScene> {
    let def = definition.json();
    let seed = input.seed;
    let width = js::number(Some(input.width));
    let height = js::number(Some(input.height));
    let location_id = text_or_empty(input.location_id);
    if definition.id == "cave" {
        let mut map = layout_organic_cave(def, &LayoutOptions { seed, width, height, location_id })?;
        roughen_ground(&mut map, &RoughOptions { seed, kind: RoughKind::Rubble, zones: None, patches: 2 });
        place_vignettes(&mut map, &VignetteOptions { seed, set: "cave", zones: None, limit: 1, text: input.scene_text, hug_walls: false });
        if let Some(hall) = map.zones.iter().find(|zone| zone.label == "Зал").map(|zone| zone.id.clone()) {
            raise_dais(&mut map, &hall, &DaisOptions { height: 5, depth: 3 })?;
        }
        let plans = prop_plans(def);
        let place_text = text::lower(&format!("{} {}", template(input.location), template(input.theme)));
        let zone_count = map.zones.len();
        let empty = json!({});
        let zones: Vec<Value> = map
            .zones
            .iter()
            .enumerate()
            .map(|(index, zone)| {
                let base = if plans.is_empty() { &empty } else { &plans[index.min(plans.len() - 1)] };
                let last = index as i64 >= zone_count.min(plans.len()) as i64 - 1;
                let hoard = text::test(sk_core::re!(r"золот|сокровищ|(?<![а-яё])клад(?![а-яё])|дракон", "u"), &place_text) && last;
                let mine = text::test(sk_core::re!(r"шахт|рудник|штольн|забой", "u"), &place_text) && index == 1;
                let plan = if hoard {
                    spread(base, &json!({ "require": extend(base.get("require"), &["coin_pile", "coin_pile", "chest"]), "caps": spread(base.get("caps").unwrap_or(&empty), &json!({ "coin_pile": 4, "chest": 2 })) }))
                } else if mine {
                    spread(base, &json!({ "require": extend(base.get("require"), &["ore_vein", "cart"]), "caps": spread(base.get("caps").unwrap_or(&empty), &json!({ "cart": 1, "ore_vein": 4 })) }))
                } else {
                    base.clone()
                };
                let mut entry = plan.as_object().cloned().unwrap_or_default();
                entry.insert("zoneId".into(), json!(zone.id));
                entry.insert("theme".into(), json!(definition.id));
                entry.insert("density".into(), either(plan.get("density"), def.get("density")).unwrap_or(json!(12)));
                insert_or_remove(&mut entry, "require", either(plan.get("require"), def.get("require")));
                insert_or_remove(&mut entry, "prefer", either(plan.get("prefer"), def.get("prefer")));
                Value::Object(entry)
            })
            .collect();
        let max = max_props(&map);
        place_props(&mut map, &format!("{seed}:props"), &plans_of(&zones), max)?;
        ensure_prop_access(&mut map);
        return Ok(ThemedScene { map, theme: definition.id.into(), warnings: Vec::new(), levels: None });
    }

    let graph = scene_graph_for_theme(def, seed)?;
    let mut built = build_scene_from_graph(&graph, &GraphLayoutOptions { seed, width, height, location_id, theme: definition.id, material: definition.material().unwrap_or("stone") })?;
    let locked = js::truthy(def.get("locked"));
    let goal_door = if locked { built.map.doors.iter().find(|door| door.state == "locked" && door.key_item_id.as_deref().is_some_and(|key| !key.is_empty())).cloned() } else { None };
    let locks: Vec<(String, ShortcutLock)> = goal_door
        .as_ref()
        .map(|door| vec![(graph.goal_zone_id.clone(), ShortcutLock { lock_dc: door.lock_dc, key_item_id: door.key_item_id.clone() })])
        .unwrap_or_default();
    let exclude: Vec<String> = if locked && goal_door.is_none() { vec![graph.goal_zone_id.clone()] } else { Vec::new() };
    add_shortcut_loops(&mut built.map, &ShortcutOptions { exclude: exclude.clone(), locks: locks.clone(), limit: 2, ..ShortcutOptions::default() })?;
    if definition.id == "crypt" {
        pierce_walls(&mut built.map, "grate", 13, 3)?;
    }
    if definition.id == "temple" {
        pierce_walls(&mut built.map, "loophole", 11, 4)?;
    }
    if definition.id == "dungeon" || definition.id == "crypt" {
        if let Some(deepest) = deepest_room(&built.map) {
            if deepest.doors < 2 {
                add_shortcut_loops(
                    &mut built.map,
                    &ShortcutOptions { only: deepest.zone_id.clone(), min_detour: 6, limit: 1, id_prefix: "second-entrance".into(), locks: locks.clone(), exclude: exclude.clone() },
                )?;
            }
        }
    }
    thin_walls(&mut built.map, &ThinWallsOptions::default())?;
    // Корпус храма стоит посреди породы (`compactArea`), а тонкие стены рёбер
    // к породе не ставят: без них у храма не было наружного контура, и 3D не
    // давало ему крыши (#184).
    if definition.id == "temple" {
        outline_impassable_cells(&mut built.map)?;
    }
    if definition.id == "dungeon" {
        if let Some(cells_zone) = built.map.zones.iter().find(|zone| zone.label == "Камеры").map(|zone| zone.id.clone()) {
            partition_prison_cells(&mut built.map, &cells_zone)?;
        }
    }
    let dais: Vec<String> = built.map.zones.iter().filter(|zone| zone.label == "Алтарная" || zone.label == "Погребальная").map(|zone| zone.id.clone()).collect();
    for zone_id in dais {
        raise_dais(&mut built.map, &zone_id, &DaisOptions::default())?;
    }
    apply_room_floors(&mut built.map, &RoomFloorsOptions { context: RoomContext { use_: definition.id, architecture: definition.material().unwrap_or("stone") }, ..RoomFloorsOptions::default() })?;
    let labelled: Vec<(String, String)> = built.map.zones.iter().filter(|zone| !zone.label.is_empty()).map(|zone| (zone.id.clone(), zone.label.clone())).collect();
    let plans = prop_plans(def);
    let zone_size = |map: &TacticalMap, zone_id: &str| tm::cells(map).filter(|cell| cell.passable && cell.zone == zone_id).count();
    const SPACIOUS_HALL_CELLS: usize = 100;
    for (index, (zone_id, label)) in labelled.iter().enumerate() {
        let plan = (!plans.is_empty()).then(|| &plans[index % plans.len()]);
        let colonnade = plan.and_then(|plan| plan.get("colonnade"));
        let asked = colonnade == Some(&Value::Bool(true));
        let size = zone_size(&built.map, zone_id);
        let declined = colonnade == Some(&Value::Bool(false)) && (size as f64) < SPACIOUS_HALL_CELLS as f64 * 2.5;
        let never = colonnade.and_then(Value::as_str) == Some("never");
        let spacious = label != "Камеры" && !declined && !never && size >= SPACIOUS_HALL_CELLS;
        if asked || spacious {
            place_colonnade(&mut built.map, zone_id, "pillar", "colonnade");
        }
    }
    let dressed: Vec<String> = labelled.iter().filter(|(id, label)| *id != graph.goal_zone_id && label != "Камеры").map(|(id, _)| id.clone()).collect();
    if definition.id == "crypt" {
        place_vignettes(&mut built.map, &VignetteOptions { seed, set: "crypt", zones: Some(&dressed), limit: 1, text: input.scene_text, hug_walls: false });
    }
    if definition.id == "crypt" || definition.id == "dungeon" {
        roughen_ground(&mut built.map, &RoughOptions { seed, kind: RoughKind::Rubble, zones: Some(&dressed), patches: 1 });
    }
    if definition.id == "temple" && text::test(sk_core::re!(r"заброш|разруш|руин|развалин|осквер|обвал|древн", "u"), input.scene_text) {
        roughen_ground(&mut built.map, &RoughOptions { seed, kind: RoughKind::Rubble, zones: Some(&dressed), patches: 3 });
    }
    let empty = json!({});
    let zones: Vec<Value> = built
        .map
        .zones
        .iter()
        .filter(|zone| !zone.label.is_empty())
        .enumerate()
        .map(|(index, zone)| {
            let plan = if plans.is_empty() { &empty } else { &plans[index % plans.len()] };
            let mut entry = plan.as_object().cloned().unwrap_or_default();
            entry.insert("zoneId".into(), json!(zone.id));
            entry.insert("theme".into(), either(plan.get("theme"), def.get("assetTheme")).unwrap_or(json!(definition.id)));
            entry.insert("density".into(), either(plan.get("density"), def.get("density")).unwrap_or(json!(12)));
            insert_or_remove(&mut entry, "require", either(plan.get("require"), def.get("require")));
            insert_or_remove(&mut entry, "prefer", either(plan.get("prefer"), def.get("prefer")));
            Value::Object(entry)
        })
        .collect();
    let mut map = built.map;
    let max = max_props(&map);
    place_props(&mut map, &format!("{seed}:props"), &plans_of(&zones), max)?;
    if definition.id == "temple" {
        mark_low_furniture(&mut map, &["prayer_bench", "kneeling_cushions"]);
    }
    ensure_prop_access(&mut map);
    let mut warnings = built.warnings;
    warnings.extend(built.errors.iter().map(|issue| issue.code.clone()));
    Ok(ThemedScene { map, theme: definition.id.into(), warnings, levels: None })
}

/// `{ ...plan, key: value }`: `undefined` убирает ключ из раскрытого плана.
fn insert_or_remove(entry: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            entry.insert(key.into(), value);
        }
        None => {
            entry.shift_remove(key);
        }
    }
}

fn plans_of(zones: &[Value]) -> Vec<ZonePlacementPlan> {
    plans(zones)
}

struct SettlementInput<'a> {
    seed: &'a str,
    design: &'a Value,
    levels: &'a Value,
    scene_text: &'a str,
    ruins_asked: bool,
}

/// Объект JS из пар ключ — значение в порядке записи.
fn object(pairs: Vec<(&str, Value)>) -> Value {
    Value::Object(pairs.into_iter().map(|(key, value)| (key.to_string(), value)).collect())
}

/// Обстановка дома по комнате (`housePlan`).
fn house_plan(zone_id: &str, use_: Option<&str>, single: bool) -> Value {
    let back = zone_id.ends_with("-back");
    let side = zone_id.ends_with("-side");
    let plan = |purpose: &str, require: &[&str], prefer: &[&str]| object(vec![("purpose", json!(purpose)), ("require", strings(require)), ("prefer", strings(prefer))]);
    let yard_caps = |extra: Value| {
        let base = json!({ "tree_oak": 0, "tree_pine": 0, "tree_birch": 0, "tree_dead": 0, "tree_stump": 0, "bush": 0, "shrub": 0, "grass_tuft": 0, "flowers": 0, "rock_small": 0, "boulder": 0, "well": 0, "lamp_post": 0, "signpost": 0, "path_stone": 0, "campfire": 0 });
        spread(&extra, &base)
    };
    if side {
        return match use_ {
            Some("shop") => plan("workshop", &["shelf_wall"], &["shelf_wall", "crate", "barrel", "chest", "bucket"]),
            Some("manor") => plan("bedroom", &["bed", "chest"], &["bed", "chest", "night_table", "wardrobe", "rug", "double_bed", "bathtub"]),
            Some("workshop") => plan("bedroom", &["bed", "chest"], &["bed", "chest", "night_table", "wardrobe", "rug"]),
            _ => plan("store", &["crate_stack", "barrel"], &["crate", "barrel", "sack", "chest", "shelf_wall"]),
        };
    }
    if use_ == Some("barn") && back {
        let caps = yard_caps(json!({ "haystack": 3 }));
        let mut caps = caps;
        if let Some(object) = caps.as_object_mut() {
            object.insert("cart".into(), json!(0));
        }
        return object(vec![
            ("purpose", json!("store")),
            ("extraThemes", strings(&["yard"])),
            ("require", strings(&["haystack", "sack"])),
            ("prefer", strings(&["haystack", "sack", "crate", "woodpile"])),
            ("caps", caps),
        ]);
    }
    if use_ == Some("barn") {
        return object(vec![
            ("purpose", json!("stable")),
            ("extraThemes", strings(&["yard"])),
            ("require", strings(&["haystack", "water_trough", "sack"])),
            ("prefer", strings(&["haystack", "sack", "barrel", "hitching_post", "crate", "woodpile"])),
            ("caps", yard_caps(json!({ "haystack": 2, "water_trough": 1, "cart": 1 }))),
        ]);
    }
    match use_ {
        Some("workshop") => {
            if back {
                plan("store", &["crate_stack", "barrel"], &["crate", "barrel", "sack", "chest"])
            } else {
                plan("workshop", &["table_long", "shelf_wall", "firewood_stack"], &["shelf_wall", "crate", "barrel", "chest", "bucket", "broom"])
            }
        }
        Some("shop") => {
            if back {
                plan("store", &["crate_stack", "barrel"], &["crate", "barrel", "sack", "chest"])
            } else {
                plan("shop", &["chest"], &["shelf_wall", "crate", "barrel", "chest", "chair"])
            }
        }
        Some("tavern") => {
            if back {
                plan("kitchen", &["cupboard"], &["barrel", "crate", "cupboard"])
            } else {
                plan("gallery", &["table_small", "table_small", "barrel"], &["table_small", "chair", "stool", "barrel"])
            }
        }
        Some("manor") => {
            if back {
                plan("study", &["chair"], &["bookshelf", "chest", "candle", "rug"])
            } else {
                plan("dining", &["fireplace"], &["candelabra", "cupboard", "banner"])
            }
        }
        _ if back => plan("bedroom", &["bed", "chest"], &["bed", "chest", "night_table", "wardrobe"]),
        _ => plan("living", if single { &["fireplace", "table_small", "bed"] } else { &["fireplace", "table_small"] }, &["chair", "cupboard", "barrel", "basket"]),
    }
}

fn build_settlement_branch(definition: &'static SceneTheme, built: sk_settlements::settlement_generator::SettlementScene, input: &SettlementInput<'_>) -> Result<ThemedScene> {
    let def = definition.json();
    let design = input.design;
    let seed = input.seed;
    let mut map = built.map;
    let market = is(design, "topology", "market");
    let urban = is(design, "scale", "town") || is(design, "scale", "city");
    let has_square = map.zones.iter().any(|zone| zone.id == "square");
    let street_caps = json!({
        "market_stall": if market { 6 } else { 1 }, "cart": if has_square { 1 } else { 2 }, "wagon_wheel": 2, "campfire": 1, "well": 1, "haystack": 2,
        "woodpile": 3, "village_fence": 6, "water_trough": 1, "hitching_post": 2, "signpost": 1, "roadside_shrine": 1,
        "bush": 12, "shrub": 8, "flowers": 10, "rock_small": 8, "grass_tuft": 6,
        "scarecrow": 2, "chicken_coop": 3, "garden_bed": 6, "hay_bales": 3, "rain_barrel": 5, "flower_bed": 4,
        "grain_sacks": 3, "sawhorse": 1, "lumber_pile": 2, "flour_bin": 1,
    });
    let street_require: &[&str] = if urban {
        &["tree_oak", "woodpile"]
    } else if market {
        &["market_stall", "market_stall"]
    } else if has_square {
        &["cart", "village_fence"]
    } else {
        &["well", "cart", "village_fence"]
    };
    let asset_theme = either(def.get("assetTheme"), None).unwrap_or(json!(definition.id));
    let mut zones: Vec<Value> = Vec::new();
    let river_like = is(design, "topology", "river") || is(design, "topology", "harbor");
    let mut prefer: Vec<Value> = if urban {
        strings(&["tree_oak", "tree_birch", "bush", "woodpile", "flowers", "village_fence", "rock_small", "shrub", "flower_bed", "rain_barrel"]).as_array().cloned().unwrap_or_default()
    } else if market {
        match def.get("prefer") {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        }
    } else {
        strings(&["tree_birch", "tree_oak", "bush", "woodpile", "haystack", "water_trough", "village_fence", "cart", "flowers", "garden_bed", "chicken_coop", "hay_bales", "scarecrow", "rain_barrel"])
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    if river_like {
        prefer.extend(["fish_rack", "fishing_nets", "mooring_post", "rowboat"].iter().map(|item| json!(item)));
    }
    if is(design, "topology", "harbor") {
        prefer.extend(["mooring_bollard", "cargo_net", "fishing_crates", "lobster_cage", "sail_bundle"].iter().map(|item| json!(item)));
    }
    let common_caps = if has_square && !urban {
        spread(&street_caps, &json!({ "well": 0 }))
    } else if urban {
        spread(&street_caps, &json!({ "well": 0, "market_stall": 0, "haystack": 0, "cart": 1, "wagon_wheel": 1, "campfire": 0, "village_fence": 8, "woodpile": 6 }))
    } else {
        street_caps.clone()
    };
    zones.push(object(vec![
        ("zoneId", json!("common")),
        ("theme", asset_theme.clone()),
        ("density", either(def.get("density"), None).unwrap_or(json!(10))),
        ("require", strings(street_require)),
        ("extraThemes", if river_like { strings(&["farm", "harbor"]) } else { strings(&["farm"]) }),
        ("prefer", Value::Array(prefer)),
        ("caps", common_caps),
    ]));
    if has_square {
        let require: &[&str] = if urban {
            &["fountain", "market_stall", "market_stall", "market_stall", "lamp_post", "notice_board"]
        } else if market {
            &["well", "market_stall", "market_stall", "market_stall", "lamp_post", "notice_board"]
        } else {
            &["well", "lamp_post"]
        };
        let prefer: &[&str] = if urban {
            &["market_stall", "market_awning", "fruit_cart", "lamp_post", "notice_board", "statue_plinth", "street_planter", "goods_baskets", "pottery_stand", "pillory", "signpost", "hitching_post"]
        } else {
            &["market_stall", "lamp_post", "cart", "water_trough", "signpost", "hitching_post", "notice_board", "flower_bed"]
        };
        zones.push(object(vec![
            ("zoneId", json!("square")),
            ("theme", asset_theme.clone()),
            ("density", json!(if urban { 9 } else { 7 })),
            ("extraThemes", strings(&["street"])),
            ("require", strings(require)),
            ("prefer", strings(prefer)),
            (
                "caps",
                json!({ "notice_board": 1, "market_awning": 2, "fruit_cart": 1, "statue_plinth": 1, "pillory": 1, "stocks": 0, "fountain": 1, "town_well": 0, "street_planter": 4, "goods_baskets": 3, "pottery_stand": 2, "crate_stack_goods": 1, "flower_bed": 2, "rain_barrel": 0, "well": if urban { 0 } else { 1 }, "market_stall": if urban { 6 } else { 3 }, "lamp_post": 4, "cart": 1, "water_trough": 1, "signpost": 1, "hitching_post": 2, "tree_oak": 0, "tree_pine": 0, "tree_birch": 0, "tree_dead": 0, "tree_spruce": 0, "tree_stump": 0, "bush": 0, "shrub": 0, "haystack": 0, "woodpile": 0, "campfire": 0, "village_fence": 0, "fallen_log": 0, "fern": 0, "rock_small": 0, "boulder": 0, "milestone": 0, "roadside_shrine": 0, "path_stone": 0, "grass_tuft": 0, "flowers": 0, "wagon_wheel": 0 }),
            ),
        ]));
    }
    if urban {
        zones.push(object(vec![
            ("zoneId", json!("street")),
            ("theme", asset_theme.clone()),
            ("density", json!(1.2)),
            ("extraThemes", strings(&["street"])),
            ("require", strings(&["lamp_post", "signpost", "sign_post_city"])),
            ("prefer", strings(&["lamp_post", "hitching_post", "water_trough", "street_planter", "rain_barrel"])),
            (
                "caps",
                json!({ "sign_post_city": 2, "street_planter": 4, "rain_barrel": 3, "notice_board": 0, "fountain": 0, "town_well": 0, "market_awning": 0, "fruit_cart": 0, "pillory": 0, "stocks": 0, "statue_plinth": 0, "flower_bed": 0, "goods_baskets": 0, "pottery_stand": 0, "crate_stack_goods": 0, "lamp_post": 8, "signpost": 2, "hitching_post": 2, "water_trough": 2, "cart": 0, "well": 0, "market_stall": 0, "haystack": 0, "woodpile": 0, "campfire": 0, "village_fence": 0, "tree_oak": 0, "tree_pine": 0, "tree_birch": 0, "tree_dead": 0, "tree_spruce": 0, "tree_stump": 0, "bush": 0, "shrub": 0, "fallen_log": 0, "fern": 0, "rock_small": 0, "boulder": 0, "milestone": 0, "roadside_shrine": 0, "path_stone": 0, "grass_tuft": 0, "flowers": 0, "wagon_wheel": 0 }),
            ),
        ]));
    }
    let design_use = field(design, "building_use").and_then(Value::as_str).map(str::to_string);
    let suffix = sk_core::re!(r"-(?:back|side)$", "u");
    for zone in map.zones.iter().filter(|zone| zone.kind == "interior") {
        let owner = text::replace_first(suffix, &zone.id, "");
        let use_ = match built.uses.get(&owner) {
            Some(use_) => Some(use_.clone()),
            None => design_use.clone(),
        };
        let single = !map.zones.iter().any(|other| other.id == format!("{}-back", zone.id));
        let mut entry = object(vec![("zoneId", json!(zone.id)), ("theme", json!("interior")), ("density", json!(30))]);
        if let (Some(target), Value::Object(plan)) = (entry.as_object_mut(), house_plan(&zone.id, use_.as_deref(), single)) {
            for (key, value) in plan {
                target.insert(key, value);
            }
        }
        zones.push(entry);
    }
    let common = ["common".to_string()];
    place_ruins_field(&mut map, &RuinsFieldOptions { seed, zone: "common", asked: input.ruins_asked, chance: 0.25 });
    let rough = if is(design, "climate", "cold") {
        RoughKind::Snow
    } else if is(design, "climate", "arid") {
        RoughKind::Sand
    } else {
        RoughKind::Mud
    };
    roughen_ground(&mut map, &RoughOptions { seed, kind: rough, zones: Some(&common), patches: 3 });
    place_vignettes(&mut map, &VignetteOptions { seed, set: "settlement", zones: Some(&common), limit: 1, text: input.scene_text, hug_walls: false });
    let max = max_props(&map);
    place_props(&mut map, &format!("{seed}:props"), &plans_of(&zones), max)?;

    let floor_of = |map: &TacticalMap, zone_id: &str| {
        let back = format!("{zone_id}-back");
        let side = format!("{zone_id}-side");
        tm::cells(map).filter(|cell| cell.passable && (cell.zone == zone_id || cell.zone == back || cell.zone == side)).count() as i64
    };
    let rank = |use_: &str| match use_ {
        "tavern" => Some(0),
        "manor" => Some(1),
        "shop" => Some(2),
        _ => None,
    };
    let mut storeyed: Vec<(String, i64, i64)> = built
        .uses
        .iter()
        .filter_map(|(zone_id, use_)| rank(use_).map(|rank| (zone_id.clone(), rank, floor_of(&map, zone_id))))
        .filter(|(_, _, floor)| *floor >= LARGE_HOUSE_FLOOR)
        .collect();
    storeyed.sort_by(|left, right| left.1.cmp(&right.1).then(right.2.cmp(&left.2)).then_with(|| text::locale_compare(&left.0, &right.0)));
    let mut scene_levels: Vec<SceneLevel> = Vec::new();
    if let Some((zone_id, _, _)) = storeyed.first() {
        let house = map.zones.iter().find(|zone| zone.id == *zone_id).map_or_else(|| "дом".to_string(), |zone| zone.label.clone());
        let declared: Vec<&Value> = match input.levels {
            Value::Array(levels) => levels
                .iter()
                .filter(|level| {
                    let offset = js::number(field(level, "offset"));
                    offset == 1.0 || offset == -1.0
                })
                .collect(),
            _ => Vec::new(),
        };
        scene_levels = if declared.is_empty() {
            vec![SceneLevel { offset: 1.0, hint: format!("верхний этаж: {house}"), label: "Второй этаж".into() }]
        } else {
            declared
                .iter()
                .map(|level| SceneLevel { offset: js::number(field(level, "offset")), hint: js::s(field(level, "hint")), label: js::s(field(level, "label")) })
                .collect()
        };
        let declared_json = Value::Array(
            scene_levels
                .iter()
                .map(|level| {
                    let name = if !level.label.is_empty() {
                        level.label.clone()
                    } else if level.offset > 0.0 {
                        "Второй этаж".into()
                    } else {
                        "Погреб".into()
                    };
                    json!({ "offset": js::num(level.offset), "hint": level.hint, "label": format!("{name} — {house}") })
                })
                .collect(),
        );
        ensure_declared_transitions(&mut map, &declared_json, zone_id)?;
        if !map.props.iter().any(|prop| prop.transition.is_some()) {
            scene_levels.clear();
        }
    }
    if is(design, "topology", "river") {
        dress_water_edges(&mut map, seed)?;
    }
    ensure_prop_access(&mut map);
    Ok(ThemedScene { map, theme: definition.id.into(), warnings: built.warnings, levels: (!scene_levels.is_empty()).then_some(scene_levels) })
}

struct OpenInput<'a> {
    seed: &'a str,
    width: &'a Value,
    height: &'a Value,
    location_id: &'a Value,
    location: &'a Value,
    theme: &'a Value,
    design: &'a Value,
    scene_text: &'a str,
    ruins_asked: bool,
}

fn build_open_scene(definition: &'static SceneTheme, input: &OpenInput<'_>) -> Result<ThemedScene> {
    let def = definition.json();
    let design = input.design;
    let seed = input.seed;
    let arid = is(design, "climate", "arid");
    let cold = is(design, "climate", "cold");
    let wetland = is(design, "climate", "wetland");
    let place_text = text::lower(&format!("{} {}", template(input.location), template(input.theme)));
    let chasm_scene = text::test(sk_core::re!(r"ущель|пропаст|обрыв|расщелин|разлом|бездн", "u"), &place_text);
    let bridge_scene = text::test(sk_core::re!(r"(?<![а-яё])мост|переправ|(?<![а-яё])брод", "u"), &place_text);
    let pond_scene = text::test(sk_core::re!(r"оазис|пруд|озер|озёр|родник|источник", "u"), &place_text);
    let camp_scene = text::test(sk_core::re!(r"лагер|стоянк|бивак|привал|разбойн|бандит", "u"), &place_text);
    let river_topology = is(design, "topology", "river");
    let forest = definition.id == "forest";
    let graves = js::truthy(def.get("graves"));
    let mut terrain = def.as_object().cloned().unwrap_or_default();
    terrain.insert("chasm".into(), json!(chasm_scene));
    terrain.insert("river".into(), json!(!chasm_scene && (river_topology || bridge_scene)));
    terrain.insert("pond".into(), json!(pond_scene));
    let road = if js::truthy(def.get("road")) { def.get("road").cloned().unwrap_or(json!(true)) } else { json!(river_topology || bridge_scene || chasm_scene) };
    terrain.insert("road".into(), road);
    let architecture = field(design, "architecture").and_then(Value::as_str).filter(|value| ["stone", "marble", "metal"].contains(value));
    terrain.insert("bridgeMaterial".into(), json!(architecture.unwrap_or("wood")));
    let material = if arid {
        Some(json!("sand"))
    } else if cold {
        Some(json!("ice"))
    } else if wetland {
        Some(json!("earth"))
    } else {
        def.get("material").cloned()
    };
    insert_or_remove(&mut terrain, "material", material);
    terrain.insert("surface".into(), json!(if cold { "ice" } else { "none" }));
    terrain.insert("wetland".into(), json!(wetland));
    let label = if forest {
        if arid && pond_scene {
            json!("Оазис")
        } else if arid {
            json!("Сухое редколесье")
        } else if cold {
            json!("Заснеженный лес")
        } else if wetland {
            json!("Заболоченная чаща")
        } else {
            def.get("label").cloned().unwrap_or(Value::Null)
        }
    } else {
        def.get("label").cloned().unwrap_or(Value::Null)
    };
    terrain.insert("label".into(), label);
    let climate: Option<(&[&str], &[&str])> = if arid && pond_scene {
        Some((&["bush", "shrub", "tree_dead"], &["bush", "shrub", "grass_tuft", "flowers", "fern", "boulder", "tree_dead", "cactus_cluster", "desert_boulders"]))
    } else if arid {
        Some((&["tree_dead", "boulder", "cactus_cluster"], &["tree_dead", "tree_stump", "boulder", "bush", "woodpile", "desert_boulders", "cactus_cluster", "dead_scrub", "sand_dune", "broken_obelisk"]))
    } else if cold {
        Some((&["tree_pine", "tree_spruce", "fallen_log", "snowy_boulder"], &["tree_pine", "tree_spruce", "tree_dead", "boulder", "snowy_boulder", "snowdrift", "ice_pillars", "snow_cairn"]))
    } else if wetland {
        Some((
            &["tree_dead", "fallen_log", "bush", "reed_cluster"],
            &["tree_dead", "bush", "fern", "fallen_log", "reed_cluster", "bog_pool", "mud_patch", "peat_mound", "rotten_log", "lily_pad_cluster", "mangrove_roots", "swamp_totem"],
        ))
    } else {
        None
    };
    if let Some((require, prefer)) = climate {
        terrain.insert("require".into(), strings(require));
        terrain.insert("prefer".into(), strings(prefer));
    }
    let climate_themes: &[&str] = if arid {
        &["desert"]
    } else if cold {
        &["winter"]
    } else if wetland {
        &["swamp"]
    } else {
        &[]
    };
    terrain.insert("climateThemes".into(), strings(climate_themes));
    let terrain = Value::Object(terrain);
    let width = js::number(Some(input.width));
    let height = js::number(Some(input.height));
    let (mut map, layout) = layout_open(&terrain, &LayoutOptions { seed, width, height, location_id: text_or_empty(input.location_id) })?;
    let layout = Some(&layout);
    if graves {
        place_grave_rows(&mut map, seed)?;
    }
    let temperate = !arid && !cold && !wetland;
    let ruin_fragments = if input.ruins_asked && !camp_scene && !graves { place_ruin_fragments(&mut map, layout, seed, 4)? } else { 0 };
    if !camp_scene && ruin_fragments == 0 {
        place_ruins_field(&mut map, &RuinsFieldOptions { seed, zone: "field", asked: input.ruins_asked, chance: 0.4 });
    }
    let field_zone = ["field".to_string()];
    if graves {
        if temperate {
            roughen_ground(&mut map, &RoughOptions { seed, kind: RoughKind::Undergrowth, zones: Some(&field_zone), patches: 2 });
        }
        if cold || arid {
            roughen_ground(&mut map, &RoughOptions { seed, kind: if cold { RoughKind::Snow } else { RoughKind::Sand }, zones: Some(&field_zone), patches: 2 });
        }
    }
    if !camp_scene {
        place_vignettes(&mut map, &VignetteOptions { seed, set: "wild", zones: Some(&field_zone), limit: 1, text: input.scene_text, hug_walls: false });
    }
    if !graves {
        let assets: &[&str] = if arid {
            &["desert_boulders", "boulder", "rock_cluster"]
        } else if cold {
            &["snowy_boulder", "tree_spruce", "rotten_log", "boulder"]
        } else if wetland {
            &["rotten_log", "tree_dead", "mossy_rock"]
        } else if forest {
            &["tree_oak", "boulder", "rotten_log", "tree_spruce", "rock_cluster"]
        } else {
            &["boulder", "rotten_log", "rock_cluster", "tree_oak", "mossy_rock"]
        };
        place_nature_cover(&mut map, layout, seed, assets, if forest { 0.18 } else { 0.26 })?;
    }
    let already = |map: &TacticalMap, asset_id: &str| map.props.iter().filter(|prop| prop.asset_id == asset_id).count() as i64;
    let wild_caps = json!({
        "campfire": 0.max(if camp_scene { 2 } else { 1 } - already(&map, "campfire")), "cart": 0.max(1 - already(&map, "cart")), "wagon_wheel": 0.max(1 - already(&map, "wagon_wheel")),
        "well": 0, "haystack": 0, "hitching_post": 0, "water_trough": 0, "lamp_post": 0, "market_stall": 0, "village_fence": 0, "signpost": 1,
        "roadside_shrine": if graves { 2 } else { 1 }, "milestone": 2, "woodpile": 2, "broken_obelisk": 1, "swamp_totem": 1, "snow_cairn": 2, "scout_tent": 2, "bog_pool": 2,
        "ice_pillars": 3, "snowy_boulder": 5, "desert_boulders": 4, "cactus_cluster": 4, "dead_scrub": 4, "rotten_log": 3, "reed_cluster": 5, "peat_mound": 3, "camp_dummy": 2,
        "shield_rack": 2, "spiked_beam_barrier": 3, "mangrove_roots": 3, "giant_fungus": 2,
    });
    let caps = if arid && pond_scene {
        spread(&wild_caps, &json!({ "boulder": 5, "tree_dead": 4, "tree_stump": 2 }))
    } else if graves {
        spread(&wild_caps, &json!({ "grave": 4, "sarcophagus": 0, "crypt_niche": 0, "urn": 2, "altar": 0, "brazier": 0, "cobweb": 0, "bone_pile": 1 }))
    } else {
        wild_caps.clone()
    };
    let density = if is(design, "density", "sparse") {
        json!(9)
    } else if is(design, "density", "dense") {
        json!(20)
    } else {
        either(def.get("density"), None).unwrap_or(json!(14))
    };
    let mut zone = Map::new();
    zone.insert("zoneId".into(), json!("field"));
    zone.insert("theme".into(), json!(definition.id));
    zone.insert("density".into(), density);
    insert_opt(&mut zone, "require", terrain.get("require").cloned());
    insert_opt(&mut zone, "prefer", terrain.get("prefer").cloned());
    zone.insert("caps".into(), caps);
    if camp_scene {
        let mut extra = vec!["interior", "camp"];
        extra.extend_from_slice(climate_themes);
        zone.insert("extraThemes".into(), strings(&extra));
        zone.insert("require".into(), extend(terrain.get("require"), &["campfire", "crate", "sack", "chest", "woodpile", "scout_tent", "bedroll_cluster"]));
        let mut prefer_extra = vec!["crate", "sack", "barrel", "bedroll_cluster", "shield_rack", "camp_dummy", "spiked_beam_barrier"];
        if cold {
            prefer_extra.push("winter_cache");
        }
        zone.insert("prefer".into(), extend(terrain.get("prefer"), &prefer_extra));
        zone.insert("caps".into(), spread(&wild_caps, &CAMP_INTERIOR_OFF));
    } else if !climate_themes.is_empty() {
        zone.insert("extraThemes".into(), strings(climate_themes));
    }
    let max = max_props(&map);
    place_props(&mut map, &format!("{seed}:props"), &plans_of(&[Value::Object(zone)]), max)?;
    dress_water_edges(&mut map, seed)?;
    ensure_prop_access(&mut map);
    if !graves {
        let thick = forest || wetland;
        let kinds: &[&str] = if cold {
            &["snow"]
        } else if arid {
            &["sand"]
        } else if wetland {
            &["mud", "shallows"]
        } else if forest {
            &["undergrowth", "undergrowth", "windfall"]
        } else {
            &["undergrowth", "mud"]
        };
        roughen_open_terrain(&mut map, layout, seed, kinds, if thick { 0.15 } else { 0.085 }, if thick { (5, 12) } else { (3, 8) })?;
    }
    Ok(ThemedScene { map, theme: definition.id.into(), warnings: Vec::new(), levels: None })
}

/// `layoutSettlement(theme, { seed, width, height, locationId, design })`:
/// узкий фасад генератора поселений для старых вызывающих.
pub fn layout_settlement(theme: &Value, options: &Value) -> Result<TacticalMap> {
    if options.is_null() {
        return Err(ThemeError::type_error("seed"));
    }
    let seed = param(options, "seed", json!("settlement"));
    let width = param(options, "width", json!(26));
    let height = param(options, "height", json!(26));
    let location_id = param(options, "locationId", json!(""));
    let design = param(options, "design", json!({}));
    let built = build_settlement_scene(&generator_options(&[("seed", &seed), ("width", &width), ("height", &height), ("locationId", &location_id), ("theme", theme), ("design", &design)]))?;
    Ok(built.map)
}

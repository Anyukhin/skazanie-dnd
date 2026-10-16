//! Сборка карты сцены — `generateSceneGeometryFor` и обёртки
//! `generateSceneGeometry`/`generateSceneCells`, путь библиотеки готовых карт
//! (`librarySceneGeometry`), пол храма (`refreshSceneFloors`) и замена
//! визуального реквизита на предметы словаря механики
//! (`ensureSceneInteractionFeatures`).
//!
//! Порядок выбора: авторская карта места → готовая постройка библиотеки →
//! тематический генератор с проверкой программы сцены и повторными
//! попытками → прежний процедурный генератор (водоём вне поселения).

use std::cell::RefCell;

use serde_json::{json, Map, Value};
use sk_buildings::building_generator::REFERENCE_SIZE;
use sk_core::{hash, js, re, text as jstext};
use sk_map_core::authored_location_maps::authored_location_map_meta_for;
use sk_map_core::dynamic_map::generate_dynamic_scene_map;
use sk_map_core::map_quality::{program_report, ProgramOptions, ProgramReport, SETTLEMENT_MIN_SIZE};
use sk_map_core::room_floors::{apply_room_floors, RoomContext, RoomFloor, RoomFloorsOptions};
use sk_scene_base::scene_map_design::scene_map_design_for;
use sk_scene_base::scene_requirements::normalize_scene_requirements;
use sk_settlements::scene_program_layout::{apply_scene_plan, program_focus_outdoors};
use sk_story::map_library::{active_map_library, library_request_for, LibraryRequestInput, MapLibrary, PickOptions, PickedMap, LIBRARY_SEED_PREFIX};
use sk_tactical::scene_interactions::{scene_interaction_catalog_entry, scene_interaction_fallback_assets};
use sk_tactical::tactical_map::{
    cell_at, deserialize_tactical_map, legacy_cells_from_tactical_map, orient_tactical_map, serialize_tactical_map, tactical_map_from_legacy_cells, LegacyMapOptions, RoomLabel,
    TacticalMap, SIZE_CLASSES,
};
use sk_themes::scene_themes::{build_themed_scene, is_live_theme, resolve_scene_theme, SceneTheme};
use sk_world_time::level_generator::{normalize_declared_levels, DeclaredLevel};

use super::{integer, prop, public_text, text, tpl, DirectorError, DirectorResult};

/// Сколько раз генератор пробует карту, прежде чем взять лучшую из неудачных.
const MAP_CHECK_ATTEMPTS: usize = 4;

/// `SIZE_CLASSES.area`.
fn area_limits() -> (i64, i64) {
    SIZE_CLASSES.iter().find(|(name, _)| *name == "area").map_or((60, 60), |(_, class)| (class.max_width, class.max_height))
}

// --- итог сборки --------------------------------------------------------------------

/// Этаж библиотечной карты, кроме этажа входа: сериализованная карта едет
/// рядом со сценой и ложится в память места.
#[derive(Clone, Debug, PartialEq)]
pub struct LibraryLevel {
    /// `Number(level.index) || 0`.
    pub index: f64,
    pub label: String,
    /// Сериализованная карта этажа.
    pub map: Value,
}

impl LibraryLevel {
    /// Форма JS: `{ index, label, map }`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("index".into(), js::num(self.index));
        object.insert("label".into(), Value::String(self.label.clone()));
        object.insert("map".into(), self.map.clone());
        Value::Object(object)
    }
}

/// Выбор библиотеки: запись индекса и этажи выше и ниже входа.
#[derive(Clone, Debug, PartialEq)]
pub struct LibraryGeometry {
    pub entry: Value,
    pub levels: Vec<LibraryLevel>,
}

impl LibraryGeometry {
    /// Форма JS: `{ entry, levels }`.
    pub fn to_json(&self) -> Value {
        json!({ "entry": self.entry, "levels": self.levels.iter().map(LibraryLevel::to_json).collect::<Vec<_>>() })
    }
}

/// Итог `generateSceneGeometry`: старые клетки, живая карта и необязательные
/// поля. `None` у поля — ключа в объекте JS нет.
#[derive(Clone, Debug, PartialEq)]
pub struct SceneGeometry {
    /// `legacyCellsFromTacticalMap(map)` — или клетки прежнего генератора.
    pub cells: Vec<Value>,
    pub map: TacticalMap,
    /// Этажи, которые объявил сам генератор (двухэтажная таверна поселения);
    /// может быть пустым списком, если нормализация их отбросила.
    pub levels: Option<Vec<DeclaredLevel>>,
    /// Обязательное по программе сцены, что карта так и не воплотила.
    pub missing: Option<Vec<String>>,
    /// Выбранная готовая постройка.
    pub library: Option<LibraryGeometry>,
}

impl SceneGeometry {
    /// Форма JS с сериализованной картой (`map` в JS — живая карта; для
    /// сверки и передачи по JSON — её сериализация).
    pub fn to_json(&self) -> DirectorResult<Value> {
        let mut object = Map::new();
        object.insert("cells".into(), Value::Array(self.cells.clone()));
        object.insert("map".into(), serialize_tactical_map(&self.map)?);
        if let Some(library) = &self.library {
            object.insert("library".into(), library.to_json());
        }
        if let Some(levels) = &self.levels {
            object.insert("levels".into(), Value::Array(levels.iter().map(DeclaredLevel::to_json).collect()));
        }
        if let Some(missing) = &self.missing {
            object.insert("missing".into(), js::strings_value(missing.iter().cloned()));
        }
        Ok(Value::Object(object))
    }
}

// --- пол храма ----------------------------------------------------------------------

/// `refreshSceneFloors(map, theme)`: покрытия уже собранной карты по теме, без
/// перепланировки. Сейчас правило есть только у храма. Возвращает, сколько
/// интерьерных зон получили правило пола.
pub fn refresh_scene_floors(map: &mut TacticalMap, theme: &str) -> DirectorResult<usize> {
    let normalized = jstext::lower(jstext::trim(theme));
    if normalized != "temple" && !jstext::test(re!(r"храм|монастыр|святилищ|собор|капищ", "iu"), &normalized) {
        return Ok(0);
    }
    promote_temple_nave(map);
    let default_floor = RoomFloor::new("marble", Some("mosaic"));
    let options = RoomFloorsOptions { context: RoomContext { use_: "temple", architecture: "marble" }, wall: None, default_floor: Some(&default_floor), zones: None };
    Ok(apply_room_floors(map, &options)?)
}

/// `promoteTempleNave(map)`: у библиотечной Stave Temple импорт пометил крытый
/// неф двором. Непограничная наружная зона, где стоит не меньше четырёх
/// скамей, становится нефом под крышей.
fn promote_temple_nave(map: &mut TacticalMap) {
    if !map.seed.starts_with("library:tt-stave-temple:") {
        return;
    }
    // `new Map(zones.map((zone) => [zone.id, zone]))`: при повторе id — последняя.
    let zone_index = |map: &TacticalMap, id: &str| map.zones.iter().rposition(|zone| zone.id == id);
    let mut candidates: Vec<(String, usize)> = Vec::new();
    for prop in &map.props {
        if prop.asset_id != "bench" && prop.asset_id != "prayer_bench" {
            continue;
        }
        let mut zones: Vec<String> = Vec::new();
        for point in &prop.footprint {
            if let Some(cell) = cell_at(map, point.x, point.y) {
                if !cell.zone.is_empty() && !zones.iter().any(|zone| zone == cell.zone) {
                    zones.push(cell.zone.to_string());
                }
            }
        }
        for zone_id in zones {
            if zone_index(map, &zone_id).map(|index| map.zones[index].kind.as_str()) != Some("exterior") {
                continue;
            }
            match candidates.iter_mut().find(|(id, _)| *id == zone_id) {
                Some(entry) => entry.1 += 1,
                None => candidates.push((zone_id, 1)),
            }
        }
    }
    for (zone_id, benches) in candidates {
        if benches < 4 {
            continue;
        }
        let Some(index) = zone_index(map, &zone_id) else { continue };
        let mut touches_border = false;
        for y in 0..map.height {
            for x in 0..map.width {
                if let Some(cell) = cell_at(map, x, y) {
                    if cell.passable && cell.zone == zone_id && (x == 0 || y == 0 || x == map.width - 1 || y == map.height - 1) {
                        touches_border = true;
                    }
                }
            }
        }
        if touches_border {
            continue;
        }
        let zone = &mut map.zones[index];
        zone.kind = "interior".into();
        zone.material = "marble".into();
        zone.light_level = "dim".into();
        zone.floor_direction = "horizontal".into();
        zone.label = "Неф".into();
        map.overlays.room_labels.retain(|entry| entry.zone_id != zone_id);
        map.overlays.room_labels.push(RoomLabel { zone_id, label: "Неф".into() });
    }
}

// --- предметы словаря механики --------------------------------------------------------

/// `ensureSceneInteractionFeatures(cells, seed, themeAssets)`: если на карте
/// меньше двух предметов словаря механики, до двух визуальных предметов
/// заменяются каноническими (тематическими, иначе запасными). Число предметов
/// и лестницы не меняются.
fn ensure_scene_interaction_features(cells: &mut [Value], seed: &Value, theme_assets: &[Value]) {
    let supported_of = |feature: Option<&Value>| scene_interaction_catalog_entry(feature).is_some();
    let mut supported = cells.iter().filter(|cell| supported_of(cell.get("feature"))).count();
    if supported >= 2 {
        return;
    }
    let mut thematic: Vec<Value> = Vec::new();
    for asset in theme_assets {
        if !thematic.iter().any(|known| super::strict_equal(Some(known), Some(asset))) {
            thematic.push(asset.clone());
        }
    }
    let thematic: Vec<String> = thematic.iter().filter(|asset| supported_of(Some(asset))).map(|asset| js::s(Some(asset))).collect();
    let fallback = if thematic.is_empty() { scene_interaction_fallback_assets() } else { thematic };
    let seed = tpl(Some(seed));
    let mut replaceable: Vec<(usize, u64, i64, i64)> = cells
        .iter()
        .enumerate()
        .filter_map(|(index, cell)| {
            let Some(Value::String(feature)) = cell.get("feature") else { return None };
            if feature == "enemy" || jstext::test(re!(r"stairs", "iu"), feature) || supported_of(cell.get("feature")) {
                return None;
            }
            let (x, y) = (cell.get("x"), cell.get("y"));
            let digest = hash::sha256(format!("{seed}:poi-feature:{}:{}:{feature}", tpl(x), tpl(y)));
            let score = u64::from(u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]));
            Some((index, score, js::number(y) as i64, js::number(x) as i64))
        })
        .collect();
    replaceable.sort_by(|left, right| left.1.cmp(&right.1).then(left.2.cmp(&right.2)).then(left.3.cmp(&right.3)));
    for (index, score, ..) in replaceable {
        if fallback.is_empty() {
            break;
        }
        let feature = fallback[((score + supported as u64) % fallback.len() as u64) as usize].clone();
        if let Value::Object(cell) = &mut cells[index] {
            cell.insert("feature".into(), Value::String(feature));
        }
        supported += 1;
        if supported >= 2 {
            break;
        }
    }
}

// --- вход ----------------------------------------------------------------------------

/// Аргументы `generateSceneGeometryFor` — рыхлые значения JS. Где JS
/// подставляет значение по умолчанию, оно уже подставлено; `null` проходит
/// как есть.
pub(crate) struct GeometryArgs {
    pub theme: Value,
    pub danger: Value,
    pub location: Value,
    pub scene_kind: Value,
    pub settlement_type: Value,
    pub world_kind: Value,
    pub seed: Value,
    pub location_id: Value,
    /// Заявка картографа — всегда объект.
    pub requested_map: Map<String, Value>,
    pub levels: Vec<DeclaredLevel>,
    pub description: Value,
    pub world_description: Value,
    pub biome: Value,
    pub use_library: bool,
    pub used_library_ids: Vec<String>,
    pub requirements: Value,
    pub program: Value,
    pub entry_side: Value,
}

/// Значение параметра с умолчанием JS: подставляется только вместо `undefined`.
fn param(input: &Value, key: &str, default: Value) -> Value {
    prop(Some(input), key).cloned().unwrap_or(default)
}

fn levels_json(levels: &[DeclaredLevel]) -> Value {
    Value::Array(levels.iter().map(DeclaredLevel::to_json).collect())
}

impl GeometryArgs {
    /// Разбор входа `generateSceneGeometry({ … } = {})`.
    fn from_input(input: &Value) -> DirectorResult<Self> {
        if input.is_null() {
            return Err(DirectorError::null_read("theme"));
        }
        let empty = || Value::String(String::new());
        let map = param(input, "map", json!({}));
        let requested_map = match map {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        let levels = param(input, "levels", json!([]));
        Ok(Self {
            theme: param(input, "theme", empty()),
            danger: param(input, "danger", json!("средняя")),
            location: param(input, "location", empty()),
            scene_kind: param(input, "sceneKind", empty()),
            settlement_type: param(input, "settlementType", empty()),
            world_kind: param(input, "worldKind", empty()),
            seed: param(input, "seed", json!("scene")),
            location_id: param(input, "locationId", empty()),
            requested_map,
            levels: normalize_declared_levels(Some(&levels)),
            description: param(input, "description", empty()),
            world_description: param(input, "worldDescription", empty()),
            biome: param(input, "biome", empty()),
            use_library: js::truthy(Some(&param(input, "useLibrary", Value::Bool(true)))),
            used_library_ids: Vec::new(),
            requirements: param(input, "requirements", json!([])),
            program: param(input, "program", Value::Null),
            entry_side: param(input, "entrySide", empty()),
        })
    }
}

// --- сборка --------------------------------------------------------------------------

/// `mapCheckFor(theme, plan)`: поселение не меньше 24×20 и не глухое.
fn map_check_for(theme: &SceneTheme) -> ProgramOptions {
    let settlement = theme.kind == "settlement";
    ProgramOptions { min_size: settlement.then_some(SETTLEMENT_MIN_SIZE), open_scene: settlement }
}

/// Подписи комнат маяка: башня-усадьба не должна читаться особняком.
const LIGHTHOUSE_ROOM_LABELS: [(&str, &str); 5] = [
    ("Парадный зал", "Нижний ярус маяка"),
    ("Кухня", "Каморка смотрителя"),
    ("Салон", "Лестница к фонарю"),
    ("Кладовая", "Кладовая масла"),
    ("Участок", "Скала у маяка"),
];

fn lighthouse_label(label: &str) -> Option<&'static str> {
    LIGHTHOUSE_ROOM_LABELS.iter().find(|(from, _)| *from == label).map(|(_, to)| *to)
}

/// `relabelLighthouseRooms(map, location)`.
fn relabel_lighthouse_rooms(map: &mut TacticalMap, location: &Value) {
    if !jstext::test(re!(r"(?<![\p{L}\p{M}])маяк\p{L}*", "iu"), &tpl(Some(location))) {
        return;
    }
    for zone in &mut map.zones {
        if let Some(label) = lighthouse_label(&zone.label) {
            zone.label = label.into();
        }
    }
    for entry in &mut map.overlays.room_labels {
        if let Some(label) = lighthouse_label(&entry.label) {
            entry.label = label.into();
        }
    }
}

/// `matched.assetTheme ?? matched.id`.
fn asset_theme_of(theme: &SceneTheme) -> String {
    match theme.get("assetTheme") {
        None | Some(Value::Null) => theme.id.to_string(),
        Some(value) => js::s(Some(value)),
    }
}

/// `{ items: [...] }` у программы-списка: сериализованные требования.
fn requirements_value(items: &[sk_scene_base::scene_requirements::Requirement]) -> Value {
    serde_json::to_value(items).unwrap_or(Value::Array(Vec::new()))
}

/// Проверка готовой карты по программе сцены. Отказ разбора — исключение в
/// JS, оно прерывает выбор; здесь оно запоминается и возвращается после
/// `pick` (первое по времени).
fn pick_from_library(library: &MapLibrary, args: &GeometryArgs, matched: &SceneTheme, design: &Value, plan: &Value) -> DirectorResult<Option<PickedMap>> {
    let levels: Vec<Value> = args.levels.iter().map(DeclaredLevel::to_json).collect();
    let width = js::number(args.requested_map.get("width"));
    let height = js::number(args.requested_map.get("height"));
    let or_reference = |value: f64, reference: i64| if value.is_nan() || value == 0.0 { reference as f64 } else { value };
    let place = format!("{} {}", tpl(Some(&args.location)), tpl(Some(&args.theme)));
    let world = tpl(Some(&args.world_description));
    fn as_str(value: Option<&Value>) -> &str {
        value.and_then(Value::as_str).unwrap_or("")
    }
    let request = library_request_for(&LibraryRequestInput {
        theme_id: matched.id,
        building_use: as_str(design.get("building_use")),
        topology: as_str(design.get("topology")),
        climate: as_str(design.get("climate")),
        world_kind: as_str(Some(&args.world_kind)),
        levels: &levels,
        width: or_reference(width, REFERENCE_SIZE.width),
        height: or_reference(height, REFERENCE_SIZE.height),
        place: &place,
        world: &world,
        requirements: &args.requirements,
        program: plan,
    });
    let failure: RefCell<Option<DirectorError>> = RefCell::new(None);
    let check_options = map_check_for(matched);
    let check = |map: &Value| -> bool {
        match deserialize_tactical_map(map) {
            Ok(live) => program_report(&live, plan, &check_options).problems.is_empty(),
            Err(error) => {
                failure.borrow_mut().get_or_insert(error.into());
                false
            }
        }
    };
    let seed = tpl(Some(&args.seed));
    let options = PickOptions { seed: &seed, used_ids: &args.used_library_ids, check: if plan.is_null() { None } else { Some(&check) } };
    let picked = library.pick(&request, &options);
    if let Some(error) = failure.into_inner() {
        return Err(error);
    }
    Ok(picked?)
}

/// `generateSceneGeometryFor(args)`: единственная развилка выбора генератора
/// — для перехода Режиссёра и для первой сцены кампании.
pub(crate) fn generate_scene_geometry_for(args: &GeometryArgs, library: Option<&MapLibrary>) -> DirectorResult<SceneGeometry> {
    // Программа сцены (`scene.map_requirements`); старый вызов с одним списком
    // читается как программа без центра и постов.
    let plan = match &args.program {
        program @ (Value::Object(_) | Value::Array(_)) => program.clone(),
        _ => {
            let items = normalize_scene_requirements(&args.requirements);
            if items.is_empty() {
                Value::Null
            } else {
                json!({ "items": requirements_value(&items) })
            }
        }
    };
    let request = Value::Object(args.requested_map.clone());
    let recognized = resolve_scene_theme(&json!({
        "location": args.location, "theme": args.theme, "sceneKind": args.scene_kind,
        "settlementType": args.settlement_type, "worldKind": args.world_kind, "request": request,
    }));
    let design = scene_map_design_for(&json!({
        "location": args.location, "theme": args.theme, "description": args.description, "worldDescription": args.world_description,
        "biome": args.biome, "worldKind": args.world_kind, "settlementType": args.settlement_type, "seed": args.seed, "request": request,
    }));
    // Поселения строят собственные гавани и переправы; водоём вне поселения
    // остаётся процедурному генератору с непроходимой водой. Явный `theme_id`
    // — просьба о конкретной геометрии.
    let explicit_theme = jstext::trim(&js::s(super::nullish(args.requested_map.get("theme_id"), args.requested_map.get("themeId")))).to_string();
    let water_chance = js::number(args.requested_map.get("water"));
    let place = format!("{} {}", tpl(Some(&args.location)), tpl(Some(&args.theme)));
    let water_body = jstext::test(re!(r"озер|река|водо[её]м|пруд|залив|отмел|переправ|берег", "iu"), &place);
    let water_scene = recognized.kind == "open"
        && design.get("topology").and_then(Value::as_str) != Some("river")
        && explicit_theme.is_empty()
        && (water_body || (water_chance.is_finite() && water_chance >= 0.35));
    let matched = (!water_scene && is_live_theme(Some(recognized))).then_some(recognized);

    if let Some(matched) = matched {
        // Библиотека — после авторского каталога и до процедурного генератора.
        let library = if args.use_library
            && explicit_theme.is_empty()
            && !matched.id.starts_with("authored-")
            && authored_location_map_meta_for(Some(&args.location_id)).is_none()
        {
            library
        } else {
            None
        };
        if let Some(library) = library {
            if let Some(picked) = pick_from_library(library, args, matched, &design, &plan)? {
                return library_scene_geometry(picked, &args.location_id, &asset_theme_of(matched));
            }
        }
        return themed_scene_geometry(args, matched, design, &plan, &place);
    }
    // Водоём вне поселения — прежний процедурный путь.
    let mut spec = args.requested_map.clone();
    spec.insert("seed".into(), args.seed.clone());
    spec.insert("theme".into(), args.theme.clone());
    spec.insert("danger".into(), args.danger.clone());
    let cells: Vec<Value> = generate_dynamic_scene_map(Some(&Value::Object(spec)))?.iter().map(|cell| cell.to_json()).collect();
    let location_id = js::s(Some(&args.location_id));
    let seed = js::s(Some(&args.seed));
    let mut map = tactical_map_from_legacy_cells(&cells, &LegacyMapOptions { location_id: &location_id, seed: &seed, generator: None, tileset_id: "" })?;
    map.theme = asset_theme_of(recognized);
    Ok(SceneGeometry { cells, map, levels: None, missing: None, library: None })
}

/// Тематическая ветка `generateSceneGeometryFor`: до четырёх попыток со
/// своим подсидом, лучшая по числу замечаний программы; затем подписи маяка
/// и поворот к дороге.
fn themed_scene_geometry(args: &GeometryArgs, matched: &SceneTheme, design: Value, plan: &Value, place: &str) -> DirectorResult<SceneGeometry> {
    let description = tpl(Some(&args.description));
    let exterior_cue = re!(r"снаружи|у входа|перед (?:дом|здани|таверн|трактир|замк|дворц)|у двер(?:и|ей)", "iu");
    // Сцена, где отряд уже в помещении («в зале», «за столом»), начинается внутри.
    let interior_cue = re!(
        r"(?<![\p{L}\p{M}])(?:внутри|в зале|в залу|за стол\p{L}*|у стойк\p{L}*|у очага|в помещени\p{L}*|входит|входят|заходит|заходят)(?![\p{L}\p{M}])",
        "iu"
    );
    let starts_outside = jstext::test(exterior_cue, place)
        || jstext::test(
            re!(r"(?:отряд|герои|путники|вы)[^.!?]{0,50}(?:снаружи|у входа|перед (?:дом|здани|таверн|трактир|замк|дворц)|у двер(?:и|ей))", "iu"),
            &description,
        )
        || (js::truthy(Some(&args.entry_side)) && !jstext::test(interior_cue, &description));
    let check = map_check_for(matched);
    let (max_width, max_height) = area_limits();
    // Центр сцены под открытым небом просит у деревни площадь.
    let design = if program_focus_outdoors(plan) { js::spread(&design, json!({ "square": true })) } else { design };
    let mut best: Option<(sk_themes::scene_themes::ThemedScene, ProgramReport)> = None;
    for attempt in 0..MAP_CHECK_ATTEMPTS {
        let attempt_seed = if attempt == 0 { args.seed.clone() } else { Value::String(format!("{}:attempt-{attempt}", tpl(Some(&args.seed)))) };
        let options = json!({
            "location": args.location,
            "theme": text(Some(&args.theme), 60, matched.id),
            "sceneKind": args.scene_kind,
            "themeId": matched.id,
            "seed": attempt_seed,
            "locationId": args.location_id,
            "width": integer(args.requested_map.get("width"), REFERENCE_SIZE.width, 16, max_width),
            "height": integer(args.requested_map.get("height"), REFERENCE_SIZE.height, 16, max_height),
            "levels": levels_json(&args.levels),
            "design": design,
            "entry": if starts_outside { "exterior" } else { "interior" },
            "description": args.description,
        });
        let mut built = build_themed_scene(&options)?;
        built.map.theme = asset_theme_of(matched);
        if !plan.is_null() {
            apply_scene_plan(&mut built.map, plan, &tpl(Some(&attempt_seed)))?;
        }
        let report = program_report(&built.map, plan, &check);
        let clean = report.problems.is_empty();
        if best.as_ref().is_none_or(|(_, best)| report.problems.len() < best.problems.len()) {
            best = Some((built, report));
        }
        if clean {
            break;
        }
    }
    let Some((mut built, report)) = best else { return Err(DirectorError::type_error("Cannot destructure property 'built' of 'best' as it is null.")) };
    relabel_lighthouse_rooms(&mut built.map, &args.location);
    // Вход по дороге: улица и поле строят вход у западного края; карта
    // поворачивается целиком к стороне прежнего места.
    let party_west = built.map.spawn_points.iter().find(|point| point.role == "party").is_some_and(|party| party.x <= 1);
    let mut map = built.map;
    if js::truthy(Some(&args.entry_side)) && ["settlement", "open"].contains(&matched.kind) && !matched.id.starts_with("authored-") && party_west {
        map = orient_tactical_map(map, args.entry_side.as_str().unwrap_or(""))?;
    }
    let levels = match &built.levels {
        Some(levels) if !levels.is_empty() => Some(normalize_declared_levels(Some(&Value::Array(levels.iter().map(|level| level.to_json()).collect())))),
        _ => None,
    };
    let missing = (!plan.is_null() && !report.missing.is_empty()).then(|| report.missing.clone());
    Ok(SceneGeometry { cells: legacy_cells_from_tactical_map(&map), map, levels, missing, library: None })
}

/// `librarySceneGeometry(picked, { locationId, theme })`: этаж входа — карта
/// сцены, остальные этажи едут рядом. Каждый этаж помечается сидом
/// `library:<id>:<этаж>`.
fn library_scene_geometry(picked: PickedMap, location_id: &Value, theme: &str) -> DirectorResult<SceneGeometry> {
    let entry_id = tpl(prop(Some(&picked.entry), "id"));
    let mut maps: Vec<(f64, String, TacticalMap)> = Vec::new();
    for level in &picked.levels {
        let mut map = deserialize_tactical_map(prop(Some(level), "map").unwrap_or(&Value::Null))?;
        let index = {
            let number = js::number(prop(Some(level), "index"));
            if number.is_nan() || number == 0.0 {
                0.0
            } else {
                number
            }
        };
        map.location_id = public_text(Some(location_id), 120, "");
        map.seed = format!("{LIBRARY_SEED_PREFIX}{entry_id}:{}", js::f64_string(index));
        map.theme = text(Some(&Value::String(theme.to_string())), 60, "");
        let floor_theme = map.theme.clone();
        refresh_scene_floors(&mut map, &floor_theme)?;
        maps.push((index, text(prop(Some(level), "label"), 120, ""), map));
    }
    let ground_at = maps.iter().position(|(index, ..)| *index == 0.0).unwrap_or(0);
    if maps.is_empty() {
        return Err(DirectorError::null_read("map"));
    }
    let mut levels = Vec::new();
    let mut ground: Option<TacticalMap> = None;
    for (position, (index, label, map)) in maps.into_iter().enumerate() {
        if index != 0.0 {
            levels.push(LibraryLevel { index, label, map: serialize_tactical_map(&map)? });
        }
        if position == ground_at {
            ground = Some(map);
        }
    }
    let Some(ground) = ground else { return Err(DirectorError::null_read("map")) };
    Ok(SceneGeometry {
        cells: legacy_cells_from_tactical_map(&ground),
        map: ground,
        levels: None,
        missing: None,
        library: Some(LibraryGeometry { entry: picked.entry, levels }),
    })
}

// --- обёртки ---------------------------------------------------------------------------

/// `generateSceneGeometry(input)`: выбор генератора для тех, кто собирает
/// сцену вне перехода Режиссёра, прежде всего для первой сцены кампании.
/// Вход — объект JS `{ theme, danger, location, sceneKind, settlementType,
/// worldKind, seed, locationId, map, levels, description, worldDescription,
/// biome, useLibrary, requirements, program, entrySide }`. Библиотека —
/// активная (`setActiveMapLibrary`).
pub fn generate_scene_geometry(input: &Value) -> DirectorResult<SceneGeometry> {
    let library = active_map_library();
    generate_scene_geometry_with(input, library.as_deref())
}

/// `generateSceneGeometry(input)` с явной библиотекой (`None` — без неё).
pub fn generate_scene_geometry_with(input: &Value, library: Option<&MapLibrary>) -> DirectorResult<SceneGeometry> {
    generate_scene_geometry_for(&GeometryArgs::from_input(input)?, library)
}

/// `generateSceneCells(input)`: совместимое клеточное представление для
/// старых потребителей и инструментов.
pub fn generate_scene_cells(input: &Value) -> DirectorResult<Vec<Value>> {
    let library = active_map_library();
    generate_scene_cells_with(input, library.as_deref())
}

/// `generateSceneCells(input)` с явной библиотекой.
pub fn generate_scene_cells_with(input: &Value, library: Option<&MapLibrary>) -> DirectorResult<Vec<Value>> {
    if input.is_null() {
        return Err(DirectorError::null_read("map"));
    }
    let request = super::nullish(prop(Some(input), "map"), None).cloned().unwrap_or_else(|| json!({}));
    let mut theme_input = match input {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    theme_input.insert("request".into(), request);
    let definition = resolve_scene_theme(&Value::Object(theme_input));
    let mut assets: Vec<Value> = Vec::new();
    for key in ["require", "prefer"] {
        if let Some(Value::Array(items)) = definition.get(key) {
            assets.extend(items.iter().cloned());
        }
    }
    let mut cells = generate_scene_geometry_with(input, library)?.cells;
    let seed = super::nullish(prop(Some(input), "seed"), None).cloned().unwrap_or_else(|| json!("scene"));
    ensure_scene_interaction_features(&mut cells, &seed, &assets);
    Ok(cells)
}

/// `generateSceneMap` — псевдоним `generateDynamicSceneMap` (прежний
/// процедурный генератор клеток).
pub fn generate_scene_map(spec: Option<&Value>) -> DirectorResult<Vec<Value>> {
    Ok(generate_dynamic_scene_map(spec)?.iter().map(|cell| cell.to_json()).collect())
}

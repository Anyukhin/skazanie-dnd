//! Перенос `server/scene-dressing.mjs`: глубина карты поверх планировки —
//! сюжетные виньетки, трудная местность и развалины.
//!
//! Генератор расставляет предметы по назначению комнаты и поштучно, поэтому
//! карта читалась складом реквизита: ни следа того, что здесь было до отряда,
//! ни места, где шаг даётся дороже, ни укрытия посреди поля. Модуль — лист:
//! он знает только реестр ассетов и тактическую карту, ничего не спрашивает у
//! модели и детерминирован по сиду.

use std::collections::HashSet;
use std::sync::LazyLock;

use serde_json::{Map, Value};
use sk_core::{js, text, Point};
use sk_scene_base::asset_registry::{asset_by_id, AssetEntry};
use sk_tactical::tactical_map::{cell_at, edge_list, edge_neighbor, set_cell, set_edge, CellPatch, EdgeKind, EdgePatch, TacticalMap};

use crate::js_math::{js_atan2, js_sin};
use crate::prop_placement::add_registry_prop;
use crate::util::{falsy_number, floor_cell, js_hypot, js_max, SeedRandom};

/// Часть виньетки: предмет и сдвиг от якоря.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VignettePart {
    pub asset: &'static str,
    pub dx: i64,
    pub dy: i64,
    /// Поворот в градусах; `None` — 0.
    pub rotation: Option<f64>,
    /// Состояние предмета (`broken`, `toppled`).
    pub state: Option<&'static str>,
}

/// Виньетка. `cue` — корни слов, по которым сцену узнают в тексте места
/// (регулярное выражение JS с флагом `u`). `ambient` — тихая примета без
/// события: она может встать и без слов. Виньетка с событием встаёт только
/// по слову описания.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vignette {
    pub id: &'static str,
    pub parts: &'static [VignettePart],
    pub near_road: bool,
    pub cue: Option<&'static str>,
    pub ambient: bool,
}

const fn part(asset: &'static str, dx: i64, dy: i64) -> VignettePart {
    VignettePart { asset, dx, dy, rotation: None, state: None }
}

const fn turned(asset: &'static str, dx: i64, dy: i64, rotation: f64, state: &'static str) -> VignettePart {
    VignettePart { asset, dx, dy, rotation: Some(rotation), state: Some(state) }
}

const fn broken(asset: &'static str, dx: i64, dy: i64, state: &'static str) -> VignettePart {
    VignettePart { asset, dx, dy, rotation: None, state: Some(state) }
}

/// Виньетки по обстановке в порядке объекта JS. Сломанным или опрокинутым
/// ставится только неинтерактивное: состояние интерактивного предмета —
/// событие правил, а не декор генератора.
#[rustfmt::skip]
pub static VIGNETTES: [(&str, &[Vignette]); 5] = [
    ("wild", &[
        // Костёр ещё горит, а хозяев нет: скатка, мешок, бревно вместо скамьи.
        Vignette { id: "abandoned-camp", near_road: false, ambient: false,
            cue: Some(r"кострищ|костёр|костер|костра|ночлег|ночёвк|ночевк|следы (?:[а-яё]+ )?(?:стоянки|привала)|брошенн[а-яё]* (?:стоянк|лагер)"),
            parts: &[part("campfire", 0, 0), part("bedroll_cluster", 1, 1), part("sack", 1, -1), part("fallen_log", -2, 1)] },
        // Телега у обочины: колесо отлетело, мешок распорот.
        Vignette { id: "cart-wreck", near_road: true, ambient: false,
            cue: Some(r"телег|повозк|обоз|фургон|караван|опрокинут|засад"),
            parts: &[part("cart", 0, 0), turned("wagon_wheel", 2, 1, 90.0, "broken"), broken("sack", -1, 1, "broken"), part("pebbles", 1, 1)] },
        // Могила у дороги — тихая примета: цветы и свеча, за ней кто-то ходит.
        Vignette { id: "wayside-grave", near_road: true, ambient: true,
            cue: Some(r"могил|надгроб|похорон|погост|памятн"),
            parts: &[part("grave", 0, 0), part("flowers", 0, 1), part("candle", 1, 1), part("rock_small", 2, 0)] },
        // Лёжка зверя: кости, палая листва, бурелом.
        Vignette { id: "beast-lair", near_road: false, ambient: false,
            cue: Some(r"звер|волк|волч|медвед|берлог|логов|хищн|чудищ|чудовищ|твар[ьи]"),
            parts: &[part("bone_pile", 0, 0), part("bone_pile", 1, 1), part("leaf_litter", -1, 0), part("dead_bramble", 1, -1), part("fallen_log", -1, 2)] },
        // Бурелом — тихая примета леса: ствол поперёк, пень, листва и папоротник.
        Vignette { id: "fallen-tree", near_road: false, ambient: true,
            cue: Some(r"бурелом|поваленн|упавш[а-яё]* (?:дерев|ствол)|ветровал"),
            parts: &[part("fallen_log", 0, 0), part("tree_stump", 2, 0), part("leaf_litter", 0, 1), part("fern", 1, 1)] },
    ]),
    ("cave", &[
        // Тот, кто дошёл сюда раньше: кости, распоротый мешок, рассыпанные монеты.
        Vignette { id: "fallen-adventurer", near_road: false, ambient: false,
            cue: Some(r"искател|авантюрист|пропавш|погибш|сгинул|останк|скелет|экспедиц"),
            parts: &[part("bone_pile", 0, 0), broken("sack", 1, 0, "broken"), part("coin_pile", 0, 1), part("rock_small", -1, 1)] },
        // Тайник контрабандистов: ящик, бочка, мешки и огарок.
        Vignette { id: "smuggler-cache", near_road: false, ambient: false,
            cue: Some(r"контрабанд|тайник|схрон|награбл|разбойн|бандит|краден"),
            parts: &[part("crate", 0, 0), part("barrel", 1, 0), part("sack", 0, 1), part("candle", 1, 1)] },
        // Грибной грот — тихая примета сырой пещеры.
        Vignette { id: "mushroom-grotto", near_road: false, ambient: true,
            cue: Some(r"гриб|плесен|сырост"),
            parts: &[part("giant_fungus", 0, 0), part("mushroom_cluster", 2, 0), part("mushroom_cluster", 0, 2), part("pebbles", 2, 2)] },
    ]),
    ("crypt", &[
        // Разорённое погребение: урны разбиты, кости разбросаны, монеты обронены.
        Vignette { id: "looted-burial", near_road: false, ambient: false,
            cue: Some(r"разграбл|разорен|разорён|мародёр|мародер|грабител|осквернён|осквернен|вскрыт"),
            parts: &[broken("urn", 0, 0, "broken"), part("bone_pile", 1, 0), turned("urn", 1, 1, 90.0, "toppled"), part("coin_pile", 0, 1), part("rubble_heap", -1, 0)] },
        // Место обряда: круг на полу, свечи по краю, кости в стороне.
        Vignette { id: "ritual-site", near_road: false, ambient: false,
            cue: Some(r"обряд|ритуал|культ|жертвоприн|некромант|сектант|призыв|колдовск|чернокниж"),
            parts: &[part("ritual_circle", 0, 0), part("candle", -1, -1), part("candle", 1, -1), part("candle", 0, 1), part("bone_heap", 2, 1)] },
        // Поминальное место — тихая примета: урна, свечи и чаша подношений.
        Vignette { id: "memorial", near_road: false, ambient: true,
            cue: Some(r"помин|памят|предк|родов"),
            parts: &[part("urn", 0, 0), part("candle", 1, 0), part("candle", -1, 0), part("offering_bowl", 0, 1)] },
    ]),
    ("tavern", &[
        // Общий зал после драки: стулья опрокинуты, вино разлито, бутылка
        // разбита, кружка закатилась под стол.
        Vignette { id: "after-brawl", near_road: false, ambient: false,
            cue: Some(r"драк|потасовк|поножовщ|дебош|буян|разгром|погром|скандал|мордобо"),
            parts: &[turned("chair", 0, 0, 90.0, "toppled"), part("wine_stain", 1, 0), broken("stool", 2, 1, "toppled"), part("mug", 1, 1), broken("bottle", 0, 1, "broken")] },
    ]),
    ("settlement", &[
        Vignette { id: "cart-wreck", near_road: true, ambient: false,
            cue: Some(r"телег|повозк|обоз|фургон|караван|опрокинут"),
            parts: &[part("cart", 0, 0), turned("wagon_wheel", 2, 1, 90.0, "broken"), broken("sack", -1, 1, "broken")] },
        // Дровяной двор — тихая примета деревни: козлы, пень и поленница.
        Vignette { id: "woodcutting", near_road: false, ambient: true,
            cue: Some(r"дров|лесоруб|плотник|пилорам"),
            parts: &[part("sawhorse", 0, 0), part("tree_stump", 2, 0), part("woodpile", 0, 2), part("sawdust", 2, 1)] },
    ]),
];

/// Скомпилированные слова виньеток: по набору и порядку `VIGNETTES`.
static CUES: LazyLock<Vec<Vec<Option<sk_core::fancy_regex::Regex>>>> = LazyLock::new(|| {
    VIGNETTES.iter().map(|(_, recipes)| recipes.iter().map(|recipe| recipe.cue.and_then(|cue| text::js_regex(cue, "u"))).collect()).collect()
});

fn set_index(set: &str) -> Option<usize> {
    VIGNETTES.iter().position(|(name, _)| *name == set)
}

/// Виньетки набора (`VIGNETTES[set] ?? []`). Неизвестный набор — пустой
/// список (ключи прототипа JS здесь тоже неизвестны, см. отчёт переноса).
pub fn vignettes(set: &str) -> &'static [Vignette] {
    set_index(set).map_or(&[], |index| VIGNETTES[index].1)
}

/// `vignettesNamedBy(set, text)`: какие виньетки набора названы текстом сцены.
pub fn vignettes_named_by(set: &str, scene_text: &str) -> Vec<&'static str> {
    let Some(index) = set_index(set) else { return Vec::new() };
    let lower = text::lower(scene_text);
    VIGNETTES[index]
        .1
        .iter()
        .enumerate()
        .filter(|(position, _)| CUES[index][*position].as_ref().is_some_and(|cue| text::test(cue, &lower)))
        .map(|(_, recipe)| recipe.id)
        .collect()
}

/// `shuffled(items, random)`: перемешивание Фишера — Йетса от конца — порядок
/// кандидатов не зависит от обхода карты.
fn shuffled<T: Clone>(items: &[T], random: &mut SeedRandom) -> Vec<T> {
    let mut copy = items.to_vec();
    let mut index = copy.len();
    while index > 1 {
        index -= 1;
        let other = (random.next() * (index + 1) as f64).floor() as usize;
        copy.swap(index, other);
    }
    copy
}

const SIDES: [(i64, i64); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

type Cell = (i64, i64);

/// Клетки, которые обстановка не трогает (`reservedCells`): вход отряда и его
/// окрестность, подходы к дверям, лестницы и люки, край карты.
fn reserved_cells(map: &TacticalMap, spawn_radius: i64) -> HashSet<Cell> {
    let mut reserved = HashSet::new();
    for point in &map.spawn_points {
        let radius = if point.role == "party" { spawn_radius } else { 1 };
        for dy in -radius..=radius {
            for dx in -radius..=radius {
                reserved.insert((point.x + dx, point.y + dy));
            }
        }
    }
    for door in &map.doors {
        let next = edge_neighbor(door.x, door.y, door.dir);
        let step = (next.0 - door.x, next.1 - door.y);
        for cell in [(door.x, door.y), next, (door.x - step.0, door.y - step.1), (next.0 + step.0, next.1 + step.1)] {
            reserved.insert(cell);
        }
    }
    for prop in &map.props {
        if prop.transition.is_none() {
            continue;
        }
        for cell in &prop.footprint {
            reserved.insert((cell.x, cell.y));
        }
    }
    for x in 0..map.width {
        reserved.insert((x, 0));
        reserved.insert((x, map.height - 1));
    }
    for y in 0..map.height {
        reserved.insert((0, y));
        reserved.insert((map.width - 1, y));
    }
    reserved
}

/// Клетки под предметами и у рёбер-стен (`occupiedCells`). `hug_walls`
/// снимает запрет у стен — для замкнутого помещения. Предмет без следа и с
/// координатой без клетки (NaN, бесконечность) занимает в JS ключ вроде
/// `NaN,NaN`, который не совпадает ни с одной клеткой, — здесь он просто не
/// записывается.
fn occupied_cells(map: &TacticalMap, hug_walls: bool) -> HashSet<Cell> {
    let mut occupied = HashSet::new();
    for prop in &map.props {
        if prop.footprint.is_empty() {
            if let (Some(x), Some(y)) = (floor_cell(prop.x), floor_cell(prop.y)) {
                occupied.insert((x, y));
            }
        } else {
            for cell in &prop.footprint {
                occupied.insert((cell.x, cell.y));
            }
        }
    }
    if hug_walls {
        return occupied;
    }
    for edge in edge_list(map) {
        if edge.kind == EdgeKind::Door {
            continue;
        }
        let next = edge_neighbor(edge.x, edge.y, edge.dir);
        occupied.insert((edge.x, edge.y));
        occupied.insert(next);
    }
    occupied
}

/// Дорога (`onRoad`): утоптанная земля поверх иного покрытия поля, а в
/// поселении — улица и площадь.
fn on_road(map: &TacticalMap, x: i64, y: i64) -> bool {
    let Some(cell) = cell_at(map, x, y) else { return false };
    if cell.zone == "street" || cell.zone == "square" {
        return true;
    }
    if cell.material != "earth" {
        return false;
    }
    map.zones.iter().find(|zone| zone.id == cell.zone).is_some_and(|zone| zone.material != "earth")
}

struct Ground<'a> {
    zones: Option<&'a HashSet<String>>,
    occupied: &'a HashSet<Cell>,
    reserved: &'a HashSet<Cell>,
}

/// Свободная земля для обстановки (`freeGround`): проходимая сухая клетка
/// разрешённой зоны, не занятая предметом, не дорога и не бережёная.
fn free_ground(map: &TacticalMap, x: i64, y: i64, ground: &Ground<'_>) -> bool {
    let Some(cell) = cell_at(map, x, y) else { return false };
    if !cell.passable || cell.surface == "water" || cell.surface == "oil" {
        return false;
    }
    if ground.zones.is_some_and(|zones| !zones.contains(cell.zone)) {
        return false;
    }
    let key = (x, y);
    !ground.occupied.contains(&key) && !ground.reserved.contains(&key) && !on_road(map, x, y)
}

struct PartCells {
    asset: &'static AssetEntry,
    cells: Vec<Point>,
    width: f64,
    height: f64,
    flat: bool,
}

/// Клетки части виньетки (`partCells`): футпринт предмета либо одна клетка
/// под наклейкой.
fn part_cells(part: &VignettePart, ax: i64, ay: i64) -> Option<PartCells> {
    let asset = asset_by_id(part.asset)?;
    let rotation = part.rotation.unwrap_or(0.0);
    let quarter = js::round((((rotation % 360.0) + 360.0) % 360.0) / 90.0) % 2.0 == 1.0;
    let width = js_max(1.0, if quarter { asset.base_footprint.h } else { asset.base_footprint.w });
    let height = js_max(1.0, if quarter { asset.base_footprint.w } else { asset.base_footprint.h });
    let mut cells = Vec::new();
    let mut dy = 0_i64;
    while (dy as f64) < height {
        let mut dx = 0_i64;
        while (dx as f64) < width {
            cells.push(Point::new(ax + part.dx + dx, ay + part.dy + dy));
            dx += 1;
        }
        dy += 1;
    }
    Some(PartCells { asset, cells, width, height, flat: falsy_number(asset.base_footprint.w) })
}

/// Значение предмета для `addProp` из записи реестра.
fn dressing_prop(id: String, asset: &AssetEntry, x: f64, y: f64, rotation: f64, scale: f64, footprint: &[Point], state: Option<&str>) -> Value {
    let cells: Vec<Value> = footprint.iter().map(|cell| serde_json::json!({ "x": cell.x, "y": cell.y })).collect();
    let mut prop = Map::new();
    prop.insert("id".into(), Value::String(id));
    prop.insert("assetId".into(), Value::String(asset.id.clone()));
    prop.insert("x".into(), js::num(x));
    prop.insert("y".into(), js::num(y));
    prop.insert("rotation".into(), js::num(rotation));
    prop.insert("scale".into(), js::num(scale));
    prop.insert("footprint".into(), Value::Array(cells));
    prop.insert("zOrder".into(), Value::from(0));
    prop.insert("blocksMove".into(), Value::Bool(asset.blocks_move));
    prop.insert("blocksSight".into(), Value::Bool(asset.blocks_sight));
    prop.insert("cover".into(), Value::String(asset.cover.clone()));
    prop.insert("destructible".into(), Value::Bool(asset.destructible));
    prop.insert("hp".into(), js::num(asset.hp));
    prop.insert("interactive".into(), Value::Bool(asset.interactive));
    if let Some(state) = state {
        prop.insert("state".into(), Value::String(state.into()));
    }
    Value::Object(prop)
}

/// Параметры [`place_vignettes`]: `placeVignettes(map, { seed, set, zones,
/// limit, text, hugWalls })`.
#[derive(Clone, Copy, Debug)]
pub struct VignetteOptions<'a> {
    pub seed: &'a str,
    pub set: &'a str,
    /// `None` — любые зоны (`zones = null`).
    pub zones: Option<&'a [String]>,
    pub limit: i64,
    pub text: &'a str,
    pub hug_walls: bool,
}

impl Default for VignetteOptions<'_> {
    fn default() -> Self {
        Self { seed: "", set: "", zones: None, limit: 1, text: "", hug_walls: false }
    }
}

/// `nearRoad`: дорога в квадрате 5×5 вокруг клетки.
fn near_road(map: &TacticalMap, x: i64, y: i64) -> bool {
    for dy in -2..=2 {
        for dx in -2..=2 {
            if on_road(map, x + dx, y + dy) {
                return true;
            }
        }
    }
    false
}

/// `placeVignettes(map, options)`: сюжетные виньетки — небольшие группы
/// готовых предметов, которые читаются историей места. Названное текстом
/// сцены встаёт всегда; свободные места до `limit` занимают только тихие
/// приметы. Возвращает идентификаторы поставленных виньеток.
pub fn place_vignettes(map: &mut TacticalMap, options: &VignetteOptions<'_>) -> Vec<&'static str> {
    let recipes = vignettes(options.set);
    if recipes.is_empty() {
        return Vec::new();
    }
    let mut random = SeedRandom::new(&format!("vignettes:{}:{}", options.set, options.seed));
    let named: HashSet<&str> = vignettes_named_by(options.set, options.text).into_iter().collect();
    let wanted = shuffled(&recipes.iter().filter(|recipe| named.contains(recipe.id)).collect::<Vec<_>>(), &mut random);
    let quiet = shuffled(&recipes.iter().filter(|recipe| recipe.ambient && !named.contains(recipe.id)).collect::<Vec<_>>(), &mut random);
    let budget = options.limit.max(wanted.len() as i64);
    if budget <= 0 {
        return Vec::new();
    }
    let reserved = reserved_cells(map, 3);
    let mut occupied = occupied_cells(map, options.hug_walls);
    let allowed: Option<HashSet<String>> = options.zones.map(|zones| zones.iter().cloned().collect());
    let mut ground_cells: Vec<Point> = Vec::new();
    for y in 1..map.height - 1 {
        for x in 1..map.width - 1 {
            let ground = Ground { zones: allowed.as_ref(), occupied: &occupied, reserved: &reserved };
            if free_ground(map, x, y, &ground) {
                ground_cells.push(Point::new(x, y));
            }
        }
    }
    let mut placed: Vec<&'static str> = Vec::new();
    let mut anchors: Vec<Point> = Vec::new();
    for recipe in wanted.iter().chain(quiet.iter()) {
        // Тихая примета — только на свободное место в пределе; названное — сверх.
        let ceiling = if named.contains(recipe.id) { budget } else { options.limit };
        if placed.len() as i64 >= ceiling {
            continue;
        }
        for anchor in shuffled(&ground_cells, &mut random) {
            // Виньетки — не кучей: каждая своя история и своё место.
            if anchors.iter().any(|other| (other.x - anchor.x).abs() + (other.y - anchor.y).abs() < 7) {
                continue;
            }
            if recipe.near_road && !near_road(map, anchor.x, anchor.y) {
                continue;
            }
            let layout: Vec<(&VignettePart, Option<PartCells>)> = recipe.parts.iter().map(|part| (part, part_cells(part, anchor.x, anchor.y))).collect();
            let mut used: Vec<Cell> = Vec::new();
            let fits = {
                let ground = Ground { zones: allowed.as_ref(), occupied: &occupied, reserved: &reserved };
                layout.iter().all(|(_, cells)| {
                    cells.as_ref().is_some_and(|cells| {
                        cells.cells.iter().all(|point| {
                            let key = (point.x, point.y);
                            if used.contains(&key) || !free_ground(map, point.x, point.y, &ground) {
                                return false;
                            }
                            used.push(key);
                            true
                        })
                    })
                })
            };
            if !fits {
                continue;
            }
            for (index, (part, cells)) in layout.iter().enumerate() {
                let Some(cells) = cells else { continue };
                let prop = dressing_prop(
                    format!("vignette-{}-{}-{}", recipe.id, placed.len() + 1, index + 1),
                    cells.asset,
                    (anchor.x + part.dx) as f64 + cells.width / 2.0,
                    (anchor.y + part.dy) as f64 + cells.height / 2.0,
                    part.rotation.unwrap_or(0.0),
                    1.0,
                    if cells.flat { &[] } else { &cells.cells },
                    part.state,
                );
                add_registry_prop(map, &prop);
            }
            // Клетки виньетки и кольцо вокруг заняты: следующая встанет поодаль.
            for (x, y) in &used {
                occupied.insert((*x, *y));
                for (dx, dy) in SIDES {
                    occupied.insert((x + dx, y + dy));
                }
            }
            anchors.push(anchor);
            placed.push(recipe.id);
            break;
        }
    }
    placed
}

/// Вид трудной местности (`ROUGH_DECALS`): подлесок, завал, снег, песок, грязь.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoughKind {
    Undergrowth,
    Rubble,
    Snow,
    Sand,
    Mud,
}

impl RoughKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RoughKind::Undergrowth => "undergrowth",
            RoughKind::Rubble => "rubble",
            RoughKind::Snow => "snow",
            RoughKind::Sand => "sand",
            RoughKind::Mud => "mud",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        [RoughKind::Undergrowth, RoughKind::Rubble, RoughKind::Snow, RoughKind::Sand, RoughKind::Mud].into_iter().find(|kind| kind.as_str() == value)
    }

    /// Наклейки, которыми отмечена трудная местность.
    fn decals(self) -> &'static [&'static str] {
        match self {
            RoughKind::Undergrowth => &["fern", "leaf_litter", "forest_plant"],
            RoughKind::Rubble => &["scree", "pebbles"],
            RoughKind::Snow => &["snowdrift"],
            RoughKind::Sand => &["sand_dune"],
            RoughKind::Mud => &["mud_patch"],
        }
    }

    /// Покрытие клетки под трудной местностью; подлесок и наносы его не меняют.
    fn surface(self) -> Option<&'static str> {
        match self {
            RoughKind::Rubble => Some("rubble"),
            RoughKind::Mud => Some("mud"),
            _ => None,
        }
    }
}

/// Параметры [`roughen_ground`]: `roughenGround(map, { seed, kind, zones, patches })`.
#[derive(Clone, Copy, Debug)]
pub struct RoughOptions<'a> {
    pub seed: &'a str,
    pub kind: RoughKind,
    pub zones: Option<&'a [String]>,
    pub patches: usize,
}

fn touching(a: (f64, f64), b: Point) -> bool {
    js_max((a.0 - b.x as f64).abs(), (a.1 - b.y as f64).abs()) <= 1.0
}

/// `roughenGround(map, options)`: трудная местность пятнами. Шаг по такой
/// клетке стоит вдвое (`moveCost` 2), пятно — несколько клеток, а не полоса.
/// Дорога, улица, вход и подходы к дверям не трогаются. Возвращает, сколько
/// клеток стало трудными.
pub fn roughen_ground(map: &mut TacticalMap, options: &RoughOptions<'_>) -> usize {
    let kind = options.kind;
    let mut random = SeedRandom::new(&format!("rough:{}:{}", kind.as_str(), options.seed));
    let reserved = reserved_cells(map, 4);
    let allowed: Option<HashSet<String>> = options.zones.map(|zones| zones.iter().cloned().collect());
    let nothing: HashSet<Cell> = HashSet::new();
    let eligible = |map: &TacticalMap, x: i64, y: i64| {
        let ground = Ground { zones: allowed.as_ref(), occupied: &nothing, reserved: &reserved };
        cell_at(map, x, y).is_some_and(|cell| cell.move_cost <= 1) && free_ground(map, x, y, &ground)
    };
    let mut ground_cells: Vec<Point> = Vec::new();
    for y in 1..map.height - 1 {
        for x in 1..map.width - 1 {
            if eligible(map, x, y) {
                ground_cells.push(Point::new(x, y));
            }
        }
    }
    let mut centers: Vec<Point> = Vec::new();
    let mut changed = 0;
    let mut busy = occupied_cells(map, false);
    let surface = kind.surface();
    let decals = kind.decals();
    for center in shuffled(&ground_cells, &mut random) {
        if centers.len() >= options.patches {
            break;
        }
        if centers.iter().any(|other| (other.x - center.x).abs() + (other.y - center.y).abs() < 6) {
            continue;
        }
        let radius = 1.3 + random.next();
        let mut cells: Vec<Point> = Vec::new();
        for dy in -3_i64..=3 {
            for dx in -3_i64..=3 {
                let (x, y) = (center.x + dx, center.y + dy);
                // Неровный край пятна: шум по углу, а не ровный круг.
                let wobble = 1.0 + js_sin(js_atan2(dy as f64, dx as f64) * 3.0 + center.x as f64) * 0.25;
                if js_hypot(dx as f64, dy as f64) > radius * wobble || !eligible(map, x, y) {
                    continue;
                }
                cells.push(Point::new(x, y));
            }
        }
        if cells.len() < 3 {
            continue;
        }
        centers.push(center);
        for point in &cells {
            let patch = CellPatch { move_cost: Some(2.0), surface, ..CellPatch::default() };
            // Клетка пятна существует и в границах карты, значения допустимы:
            // отказа `setCell` здесь не бывает.
            let _ = set_cell(map, point.x, point.y, &patch);
            changed += 1;
        }
        // Наклейки — поодаль друг от друга: три одинаковых вплотную проверка
        // карты считает кучей.
        let mut chosen: Vec<Point> = Vec::new();
        let limit = 3.min(cells.len().div_ceil(3));
        for point in shuffled(&cells, &mut random) {
            if chosen.len() >= limit {
                break;
            }
            if busy.contains(&(point.x, point.y)) {
                continue;
            }
            if chosen.iter().any(|other| touching((other.x as f64, other.y as f64), point)) {
                continue;
            }
            let asset_id = decals[chosen.len() % decals.len()];
            if map.props.iter().any(|prop| prop.asset_id == asset_id && touching((prop.x.floor(), prop.y.floor()), point)) {
                continue;
            }
            chosen.push(point);
        }
        for (index, point) in chosen.iter().enumerate() {
            let Some(asset) = asset_by_id(decals[index % decals.len()]) else { continue };
            let rotation = (random.next() * 4.0).floor() * 90.0;
            let scale = 0.9 + random.next() * 0.25;
            let mut prop = Map::new();
            prop.insert("id".into(), Value::String(format!("rough-{}-{}-{}", kind.as_str(), centers.len(), index + 1)));
            prop.insert("assetId".into(), Value::String(asset.id.clone()));
            prop.insert("x".into(), js::num(point.x as f64 + 0.5));
            prop.insert("y".into(), js::num(point.y as f64 + 0.5));
            prop.insert("rotation".into(), js::num(rotation));
            prop.insert("scale".into(), js::num(scale));
            prop.insert("footprint".into(), Value::Array(Vec::new()));
            prop.insert("zOrder".into(), Value::from(0));
            prop.insert("blocksMove".into(), Value::Bool(false));
            prop.insert("blocksSight".into(), Value::Bool(false));
            prop.insert("cover".into(), Value::String("none".into()));
            prop.insert("destructible".into(), Value::Bool(false));
            prop.insert("hp".into(), Value::from(0));
            prop.insert("interactive".into(), Value::Bool(false));
            add_registry_prop(map, &Value::Object(prop));
            busy.insert((point.x, point.y));
        }
    }
    changed
}

/// `markLowFurniture(map, assetIds)`: низкая мебель — трудная местность
/// (5e): клетки под скамьями и подушками дорожают. Мебель, которая держит
/// шаг целиком, сюда не входит. Возвращает, сколько клеток стало трудными.
pub fn mark_low_furniture(map: &mut TacticalMap, asset_ids: &[&str]) -> usize {
    let ids: HashSet<&str> = asset_ids.iter().copied().collect();
    let reserved = reserved_cells(map, 1);
    let mut changed = 0;
    let mut cells: Vec<Point> = Vec::new();
    for prop in &map.props {
        if !ids.contains(prop.asset_id.as_str()) || prop.blocks_move {
            continue;
        }
        cells.extend(prop.footprint.iter().copied());
    }
    for point in cells {
        let Some(cell) = cell_at(map, point.x, point.y) else { continue };
        if !cell.passable || cell.move_cost > 1 || reserved.contains(&(point.x, point.y)) {
            continue;
        }
        // Клетка существует, значение допустимо: отказа не бывает.
        let _ = set_cell(map, point.x, point.y, &CellPatch { move_cost: Some(2.0), ..CellPatch::default() });
        changed += 1;
    }
    changed
}

/// Форма остова: `house` — дом без крыши, `tower` — квадрат сторожевой
/// башни, `wall` — обрывок крепостной стены. Иная строка ведёт себя как дом
/// (как в JS: сравниваются только `tower` и `wall`).
const RUIN_SHAPES: [&str; 4] = ["house", "house", "tower", "wall"];

/// Что поставил [`place_ruins`]: угол, размер и форма остова.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ruins {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub shape: String,
}

impl Ruins {
    pub fn to_json(&self) -> Value {
        serde_json::json!({ "x": self.x, "y": self.y, "width": self.width, "height": self.height, "shape": self.shape })
    }
}

/// Параметры [`place_ruins`]: `placeRuins(map, { seed, zone, shape, index })`.
#[derive(Clone, Copy, Debug)]
pub struct RuinsOptions<'a> {
    pub seed: &'a str,
    pub zone: &'a str,
    pub shape: Option<&'a str>,
    pub index: i64,
}

impl Default for RuinsOptions<'_> {
    fn default() -> Self {
        Self { seed: "", zone: "field", shape: None, index: 1 }
    }
}

#[derive(Clone, Copy)]
struct RuinEdge {
    x: i64,
    y: i64,
    nx: i64,
    ny: i64,
}

const RUIN_WALL: EdgePatch<'static> = EdgePatch { kind: Some("wall"), blocks_move: Some(true), blocks_sight: Some(true), cover: Some("three_quarters"), door_id: None };

fn ruin_wall(map: &mut TacticalMap, edge: RuinEdge) {
    // Соседние клетки и допустимые значения: отказа `setEdge` не бывает.
    let _ = set_edge(map, edge.x, edge.y, edge.nx, edge.ny, &RUIN_WALL);
}

fn ruin_prop(map: &mut TacticalMap, index: i64, asset_id: &str, x: i64, y: i64, number: usize) {
    let Some(asset) = asset_by_id(asset_id) else { return };
    let flat = falsy_number(asset.base_footprint.w);
    let footprint = [Point::new(x, y)];
    let prop = dressing_prop(format!("ruins-{index}-{asset_id}-{number}"), asset, x as f64 + 0.5, y as f64 + 0.5, 0.0, 1.0, if flat { &[] } else { &footprint }, None);
    add_registry_prop(map, &prop);
}

/// Стоит ли кусок стены после выкрашивания; индексы за концом стороны JS
/// записывает в массив, но не читает.
fn set_standing(side: &mut [bool], index: usize, value: bool) {
    if let Some(slot) = side.get_mut(index) {
        *slot = value;
    }
}

/// `placeRuins(map, options)`: остов постройки — обрывки стен по периметру с
/// проломами, плиты пола местами, завал внутри и уцелевшая колонна, либо
/// обрывок крепостной стены. Зона остаётся прежней. `None` — места нет.
pub fn place_ruins(map: &mut TacticalMap, options: &RuinsOptions<'_>) -> Option<Ruins> {
    let mut random = SeedRandom::new(&format!("ruins:{}", options.seed));
    let form: String = match options.shape {
        Some(shape) => shape.to_string(),
        None => RUIN_SHAPES[(random.next() * RUIN_SHAPES.len() as f64).floor() as usize].to_string(),
    };
    let tower = form == "tower";
    let is_wall = form == "wall";
    let prefer_along = random.next() < 0.5;
    let span = if tower {
        4 + (random.next() * 2.0).floor() as i64
    } else if is_wall {
        8 + (random.next() * 4.0).floor() as i64
    } else {
        5 + (random.next() * 3.0).floor() as i64
    };
    let depth = if tower {
        span
    } else if is_wall {
        1
    } else {
        4 + (random.next() * 3.0).floor() as i64
    };
    let reserved = reserved_cells(map, 6);
    let occupied = occupied_cells(map, false);
    let allowed: HashSet<String> = HashSet::from([options.zone.to_string()]);
    // Обрывок стены пробует обе ориентации: поперёк дороги он не встаёт, а вдоль — встанет.
    let orientations = if is_wall { vec![prefer_along, !prefer_along] } else { vec![true] };
    let mut origin: Option<Point> = None;
    let mut along = prefer_along;
    let mut width = span;
    let mut height = depth;
    for option in orientations {
        along = option;
        width = if is_wall && !along { 1 } else { span };
        height = if is_wall && !along { span } else { depth };
        let ground = Ground { zones: Some(&allowed), occupied: &occupied, reserved: &reserved };
        // Остов и клетка вокруг — свободная земля.
        let fits = |x0: i64, y0: i64| {
            for y in y0 - 1..=y0 + height {
                for x in x0 - 1..=x0 + width {
                    if !free_ground(map, x, y, &ground) {
                        return false;
                    }
                }
            }
            true
        };
        let mut corners: Vec<Point> = Vec::new();
        let mut y = 2;
        while y + height + 2 <= map.height {
            let mut x = 2;
            while x + width + 2 <= map.width {
                corners.push(Point::new(x, y));
                x += 1;
            }
            y += 1;
        }
        origin = shuffled(&corners, &mut random).into_iter().find(|corner| fits(corner.x, corner.y));
        if origin.is_some() {
            break;
        }
    }
    let origin = origin?;
    let (x0, y0) = (origin.x, origin.y);
    let index = options.index;
    if is_wall {
        // Обрывок стены: рёбра вдоль линии, два-три пролома. Обломки кладки
        // и щебень — по обе стороны.
        let cells: Vec<RuinEdge> = if along {
            (0..width).map(|step| RuinEdge { x: x0 + step, y: y0, nx: x0 + step, ny: y0 + 1 }).collect()
        } else {
            (0..height).map(|step| RuinEdge { x: x0, y: y0 + step, nx: x0 + 1, ny: y0 + step }).collect()
        };
        let mut standing: Vec<bool> = cells.iter().map(|_| random.next() < 0.8).collect();
        // Условие цикла JS тянет случайное число на каждой проверке.
        let mut gap = 0;
        while gap < 2 + (random.next() * 2.0).floor() as i64 {
            let start = 1 + (random.next() * 1.max(cells.len() as i64 - 3) as f64).floor() as usize;
            set_standing(&mut standing, start, false);
            set_standing(&mut standing, start + 1, false);
            gap += 1;
        }
        for (step, edge) in cells.iter().enumerate() {
            if standing[step] {
                ruin_wall(map, *edge);
            }
        }
        let fallen: Vec<RuinEdge> = cells.iter().enumerate().filter(|(step, _)| !standing[*step]).map(|(_, edge)| *edge).collect();
        let scatter = shuffled(&fallen, &mut random);
        if let Some(first) = scatter.first() {
            ruin_prop(map, index, "rubble_heap", first.x, first.y, 1);
        }
        if let Some(second) = scatter.get(1) {
            ruin_prop(map, index, "scree", second.nx, second.ny, 1);
        }
        let end = cells[0];
        ruin_prop(map, index, "mossy_rock", if along { end.x - 1 } else { end.x }, if along { end.y } else { end.y - 1 }, 1);
        return Some(Ruins { x: x0, y: y0, width, height, shape: form });
    }
    // Периметр — по сторонам, каждая сторона — ряд рёбер изнутри наружу.
    let sides: [Vec<RuinEdge>; 4] = [
        (0..width).map(|step| RuinEdge { x: x0 + step, y: y0, nx: x0 + step, ny: y0 - 1 }).collect(),
        (0..width).map(|step| RuinEdge { x: x0 + step, y: y0 + height - 1, nx: x0 + step, ny: y0 + height }).collect(),
        (0..height).map(|step| RuinEdge { x: x0, y: y0 + step, nx: x0 - 1, ny: y0 + step }).collect(),
        (0..height).map(|step| RuinEdge { x: x0 + width - 1, y: y0 + step, nx: x0 + width, ny: y0 + step }).collect(),
    ];
    // Углы держатся дольше всего; середина стен выкрошена. Башня уцелела
    // почти вся: у неё один пролом, у дома — два.
    let keep = if tower { 0.9 } else { 0.55 };
    let mut standing: Vec<Vec<bool>> = sides
        .iter()
        .map(|side| (0..side.len()).map(|step| step == 0 || step == side.len() - 1 || random.next() < keep).collect())
        .collect();
    let broken_sides = shuffled(&[0_usize, 1, 2, 3], &mut random);
    for side_index in broken_sides.into_iter().take(if tower { 1 } else { 2 }) {
        let side = &mut standing[side_index];
        let length = side.len() as i64;
        let start = 1 + (random.next() * 1.max(length - 3) as f64).floor() as i64;
        set_standing(side, start as usize, false);
        let second = (length - 2).min(start + 1);
        if second >= 0 {
            set_standing(side, second as usize, false);
        }
    }
    for (side_index, side) in sides.iter().enumerate() {
        for (step, edge) in side.iter().enumerate() {
            if standing[side_index][step] {
                ruin_wall(map, *edge);
            }
        }
    }
    // Пол: плиты местами уцелели, остальное заросло. В углу — завал.
    for y in y0..y0 + height {
        for x in x0..x0 + width {
            if random.next() < 0.7 {
                let _ = set_cell(map, x, y, &CellPatch { material: Some("stone"), ..CellPatch::default() });
            }
        }
    }
    let corner_x = if random.next() < 0.5 { x0 } else { x0 + width - 2 };
    let corner_y = if random.next() < 0.5 { y0 } else { y0 + height - 2 };
    for (dx, dy) in [(0, 0), (1, 0), (0, 1)] {
        let patch = CellPatch { surface: Some("rubble"), move_cost: Some(2.0), material: Some("stone"), ..CellPatch::default() };
        let _ = set_cell(map, corner_x + dx, corner_y + dy, &patch);
    }
    ruin_prop(map, index, "rubble_heap", corner_x + 1, corner_y + 1, 1);
    ruin_prop(map, index, "scree", corner_x, corner_y, 1);
    // Уцелевшая колонна — в углу напротив завала. В башне её место занимает
    // обломок кладки.
    let pillar_x = if corner_x == x0 { x0 + width - 1 } else { x0 };
    let pillar_y = if corner_y == y0 { y0 + height - 1 } else { y0 };
    ruin_prop(map, index, if tower { "mossy_rock" } else { "pillar" }, pillar_x, pillar_y, 1);
    // Камни у стен снаружи — обломки кладки. JS пересчитывает занятые клетки
    // на каждое ребро, но карта за время отбора не меняется.
    let busy = occupied_cells(map, false);
    let ground = Ground { zones: Some(&allowed), occupied: &busy, reserved: &reserved };
    let outside: Vec<RuinEdge> = sides.iter().flatten().copied().filter(|edge| free_ground(map, edge.nx, edge.ny, &ground)).collect();
    for (number, edge) in shuffled(&outside, &mut random).into_iter().take(2).enumerate() {
        ruin_prop(map, index, if number == 0 { "mossy_rock" } else { "pebbles" }, edge.nx, edge.ny, number + 2);
    }
    Some(Ruins { x: x0, y: y0, width, height, shape: form })
}

/// Параметры [`place_ruins_field`]: `placeRuinsField(map, { seed, zone, asked, chance })`.
#[derive(Clone, Copy, Debug)]
pub struct RuinsFieldOptions<'a> {
    pub seed: &'a str,
    pub zone: &'a str,
    pub asked: bool,
    pub chance: f64,
}

impl Default for RuinsFieldOptions<'_> {
    fn default() -> Self {
        Self { seed: "", zone: "field", asked: false, chance: 0.4 }
    }
}

/// `placeRuinsField(map, options)`: несколько остовов на карту — по размеру
/// участка, а названные текстом развалины — всегда хотя бы один. Возвращает,
/// сколько остовов поставлено.
pub fn place_ruins_field(map: &mut TacticalMap, options: &RuinsFieldOptions<'_>) -> usize {
    let mut random = SeedRandom::new(&format!("ruins-field:{}", options.seed));
    let area = map.width * map.height;
    // Карта до 900 клеток держит один остов, больше — до трёх.
    let most = if area >= 1500 {
        3
    } else if area >= 900 {
        2
    } else {
        1
    };
    let mut wanted = if options.asked { 1 } else { 0 };
    let mut roll = wanted;
    while roll < most {
        let threshold = if roll == 0 { options.chance } else { options.chance * 0.6 };
        if random.next() < threshold {
            wanted += 1;
        } else {
            break;
        }
        roll += 1;
    }
    if options.asked && most > 1 && random.next() < 0.5 {
        wanted = wanted.max(2);
    }
    let mut placed = 0;
    for index in 0..wanted.min(most) {
        let seed = format!("{}:{index}", options.seed);
        if place_ruins(map, &RuinsOptions { seed: &seed, zone: options.zone, shape: None, index: index + 1 }).is_some() {
            placed += 1;
        }
    }
    placed
}

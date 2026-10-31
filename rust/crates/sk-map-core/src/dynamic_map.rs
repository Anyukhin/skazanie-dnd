//! Перенос `server/dynamic-map.mjs`: старый генератор тактической сцены
//! клетками и форма такой клетки ([`SceneCell`]) — отправная точка миграции
//! на тактическую карту (`docs/tactical-map-plan.md`, M0).
//!
//! Генератор детерминирован по спецификации картографа: органические
//! планировки опускают клетки вне контура, поэтому доска бывает пещерой,
//! кругом или развалинами, а не только прямоугольником. Все клетки, где может
//! стоять существо, досягаемы от входа. Случайность — линейный конгруэнтный
//! поток от SHA-256 строки спецификации, ровно как в JS; порядок обращений к
//! нему (в том числе ленивые `&&` и `||`) повторён, иначе карта по тому же
//! сиду выйдет другой.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};
use sk_core::{hash, js, re, text};
use sk_tactical::scene_interactions::scene_interaction_catalog_entry;
use sk_tactical::tactical_map::{floor_variant_at, size_class, FLOOR_VARIANTS};

/// Вид старой клетки (`SceneCellType`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SceneCellType {
    Floor,
    Wall,
    Water,
    Door,
}

impl SceneCellType {
    pub fn as_str(self) -> &'static str {
        match self {
            SceneCellType::Floor => "floor",
            SceneCellType::Wall => "wall",
            SceneCellType::Water => "water",
            SceneCellType::Door => "door",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "floor" => Some(SceneCellType::Floor),
            "wall" => Some(SceneCellType::Wall),
            "water" => Some(SceneCellType::Water),
            "door" => Some(SceneCellType::Door),
            _ => None,
        }
    }

    fn walkable(self) -> bool {
        matches!(self, SceneCellType::Floor | SceneCellType::Door)
    }
}

/// Старая тактическая клетка (`SceneCell`). Обязательны `x`, `y`, `type` и
/// `revealed`; остальное генератор заполняет, но границы системы отдают
/// разные подмножества полей, поэтому читатель считает их необязательными.
/// `feature` — произвольная строка: и декор, и вид сущности.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SceneCell {
    pub x: i64,
    pub y: i64,
    pub kind: SceneCellType,
    pub revealed: bool,
    /// `stone`, `wood`, `earth`, `grass`, `sand`, `metal`, `marble`, `ice`.
    pub material: Option<String>,
    /// Целое 0…5, выбор спрайта.
    pub variant: Option<i64>,
    /// `small-room`, `great-hall`, `keep`, `courtyard`, `crypt`,
    /// `cave-cluster`, `village`, `bridge`, `natural`.
    pub pattern: Option<String>,
    /// Высота площадки в футах; отсутствие — уровень земли.
    pub elevation: Option<i64>,
    /// Декор либо вид сущности.
    pub feature: Option<String>,
    /// Подпоследовательность `nesw` — стороны, где клетка граничит с непроходимым.
    pub edge_mask: Option<String>,
}

impl SceneCell {
    /// Форма JS. Порядок ключей — как у генератора и у
    /// `legacyCellsFromTacticalMap`: высота раньше декора, маска — последней.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("x".into(), Value::from(self.x));
        object.insert("y".into(), Value::from(self.y));
        object.insert("type".into(), Value::String(self.kind.as_str().into()));
        object.insert("revealed".into(), Value::Bool(self.revealed));
        if let Some(material) = &self.material {
            object.insert("material".into(), Value::String(material.clone()));
        }
        if let Some(variant) = self.variant {
            object.insert("variant".into(), Value::from(variant));
        }
        if let Some(pattern) = &self.pattern {
            object.insert("pattern".into(), Value::String(pattern.clone()));
        }
        if let Some(elevation) = self.elevation {
            object.insert("elevation".into(), Value::from(elevation));
        }
        if let Some(feature) = &self.feature {
            object.insert("feature".into(), Value::String(feature.clone()));
        }
        if let Some(mask) = &self.edge_mask {
            object.insert("edge_mask".into(), Value::String(mask.clone()));
        }
        Value::Object(object)
    }
}

/// Клетки в JSON (массив в порядке генератора).
pub fn scene_cells_json(cells: &[SceneCell]) -> Value {
    Value::Array(cells.iter().map(SceneCell::to_json).collect())
}

/// `clampInteger(value, fallback, minimum, maximum)`.
fn clamp_integer(value: Option<&Value>, fallback: i64, minimum: i64, maximum: i64) -> i64 {
    let number = js::number(value);
    if number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0 {
        (number as i64).clamp(minimum, maximum)
    } else {
        fallback
    }
}

/// `randomFor(seed)`: детерминированный поток в [0, 1).
struct RandomSource {
    state: u32,
}

impl RandomSource {
    fn new(seed: &str) -> Self {
        let digest = hash::sha256(seed);
        let state = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]);
        Self { state: if state == 0 { 1 } else { state } }
    }

    fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        f64::from(self.state) / 4_294_967_296.0
    }
}

/// Строковый параметр спецификации: значение для сравнений (`===` — только
/// строка) и запись в шаблоне (`${value}`).
struct Param {
    string: Option<String>,
    text: String,
}

impl Param {
    fn read(value: Option<&Value>, fallback: &str) -> Self {
        match value {
            None => Param { string: Some(fallback.to_string()), text: fallback.to_string() },
            Some(Value::String(text)) => Param { string: Some(text.clone()), text: text.clone() },
            Some(other) => Param { string: None, text: js::string(Some(other)) },
        }
    }

    fn is(&self, value: &str) -> bool {
        self.string.as_deref() == Some(value)
    }
}

/// `featuresFor(theme, layout, pattern, material)`.
fn features_for(theme: &str, layout: &str, pattern: &str, material: &str) -> &'static [&'static str] {
    let value = text::lower(&format!("{theme} {layout} {pattern} {material}"));
    if text::test(re!(r"дом|комнат|кабинет|камор|спальн|хижин|таверн|small-room", "iu"), &value) {
        return &["bed", "table", "chair", "chair", "fireplace", "bookshelf", "barrel", "chest", "crate", "torch"];
    }
    if text::test(re!(r"пещ|шахт|подзем|cave-cluster|cavern", "iu"), &value) {
        return &["rock", "rock", "mushroom", "mushroom", "bones", "torch", "rune", "stairs", "chest", "campfire"];
    }
    if text::test(re!(r"склеп|крипт|гробниц|crypt", "iu"), &value) {
        return &["grave", "grave", "pillar", "altar", "bones", "torch", "statue", "stairs", "chest"];
    }
    if text::test(re!(r"лес|болот|чащ|роща|луг|grass|wild|natural", "iu"), &value) {
        return &["tree", "tree", "bush", "bush", "rock", "campfire", "rune", "chest", "stairs"];
    }
    if text::test(re!(r"город|деревн|рынок|улиц|порт|village|streets", "iu"), &value) {
        return &["barrel", "crate", "wagon", "well", "table", "torch", "chest", "stairs", "statue"];
    }
    if text::test(re!(r"храм|дворец|мрамор|marble|courtyard|great-hall", "iu"), &value) {
        return &["pillar", "pillar", "statue", "altar", "torch", "rune", "chest", "stairs"];
    }
    if text::test(re!(r"косм|станци|тех|кибер|металл|metal", "iu"), &value) {
        return &["console", "console", "crate", "pillar", "rune", "stairs", "chest", "torch"];
    }
    if text::test(re!(r"дорог|тракт|мост|bridge", "iu"), &value) {
        return &["wagon", "campfire", "rock", "bush", "crate", "chest", "stairs"];
    }
    if text::test(re!(r"пустын|пес|sand", "iu"), &value) {
        return &["rock", "rock", "campfire", "bones", "rune", "chest", "stairs"];
    }
    if text::test(re!(r"руин|развал|keep|ruins", "iu"), &value) {
        return &["pillar", "statue", "rock", "bones", "torch", "rune", "chest", "stairs"];
    }
    &["rock", "torch", "rune", "chest", "stairs", "crate"]
}

const PATTERNS: [&str; 9] = ["small-room", "great-hall", "keep", "courtyard", "crypt", "cave-cluster", "village", "bridge", "natural"];
const MATERIALS: [&str; 8] = ["stone", "wood", "earth", "grass", "sand", "metal", "marble", "ice"];
const WALL_HUGGERS: [&str; 11] = ["bed", "bookshelf", "fireplace", "barrel", "crate", "grave", "tree", "bush", "rock", "pillar", "console"];

/// `visualMaterial(theme, layout, requested)`.
fn visual_material(theme: &str, layout: &str, requested: Option<&Value>) -> String {
    if let Some(Value::String(material)) = requested {
        if MATERIALS.contains(&material.as_str()) {
            return material.clone();
        }
    }
    let value = text::lower(&format!("{theme} {layout}"));
    let material = if text::test(re!(r"косм|станци|тех|кибер|металл|лаборатор", "u"), &value) {
        "metal"
    } else if text::test(re!(r"лед|снег|мороз|аркти", "u"), &value) {
        "ice"
    } else if text::test(re!(r"пустын|пес|дюн", "u"), &value) {
        "sand"
    } else if text::test(re!(r"лес|роща|луг|сад|болот", "u"), &value) {
        "grass"
    } else if text::test(re!(r"таверн|дом|кают|деревян", "u"), &value) {
        "wood"
    } else if text::test(re!(r"дворец|храм|мрамор", "u"), &value) {
        "marble"
    } else if text::test(re!(r"пещ|шахт|земл|пустош", "u"), &value) {
        "earth"
    } else {
        "stone"
    };
    material.to_string()
}

/// `scaleSize(scale)`.
fn scale_size(scale: Option<&Value>) -> (i64, i64) {
    match scale.and_then(Value::as_str) {
        Some("room") => (9, 7),
        Some("stronghold") => (23, 17),
        Some("region") => (25, 19),
        _ => (15, 11),
    }
}

/// `Math.sin` для дороги моста и тропы луга — как в V8: системный `f64::sin`
/// на Windows (mingw) даёт `sin(π)` = 1.2246063538223773e-16 вместо
/// 1.2246467991473532e-16 у V8, поэтому синус посчитан по fdlibm (как
/// `ieee754::sin` V8). Входы генератора — `x / (w − 1) · 2π` при `w` от 7 до
/// 30; на всех 444 совпадение побитное (эталон `fixtures/dynamic-map.json`).
pub fn math_sin(angle: f64) -> f64 {
    sk_core::v8math::sin(angle)
}

/// `footprintFor(layout, pattern, x, y, width, height, random)`.
fn footprint_for(layout: &Param, pattern: &str, x: i64, y: i64, width: i64, height: i64, random: &mut RandomSource) -> bool {
    let (xf, yf) = (x as f64, y as f64);
    let cx = (width - 1) as f64 / 2.0;
    let cy = (height - 1) as f64 / 2.0;
    let nx = ((xf - cx) / cx.max(1.0)).abs();
    let ny = ((yf - cy) / cy.max(1.0)).abs();
    let spine = yf == cy.floor() && xf <= cx;
    if pattern == "bridge" {
        let road_y = js::round(cy + math_sin((xf / ((width - 1) as f64).max(1.0)) * std::f64::consts::PI * 2.0) * (height as f64 * 0.08).max(1.0));
        return (yf - road_y).abs() <= 2.0 || spine;
    }
    let cavern = pattern == "cave-cluster" || layout.is("cavern");
    if cavern {
        let wobble = 0.06 + random.next() * 0.18;
        return nx * nx + ny * ny <= 1.05 - wobble || spine;
    }
    if layout.is("radial") {
        return nx * nx + ny * ny <= 1.02 || spine;
    }
    if layout.is("ruins") {
        let cut_corner = (nx > 0.82 && ny > 0.62) || (ny > 0.84 && nx > 0.68);
        let broken_edge = (x == 0 || x == width - 1 || y == 0 || y == height - 1) && random.next() < 0.55;
        return !cut_corner && !broken_edge;
    }
    if layout.is("winding") || layout.is("open") {
        return nx * nx + ny * ny <= 1.1 - random.next() * 0.12 || spine;
    }
    true
}

/// Отказ генератора: спецификация `null` (в JS деструктуризация бросает `TypeError`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DynamicMapError {
    pub name: &'static str,
    pub message: String,
}

impl std::fmt::Display for DynamicMapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DynamicMapError {}

/// `generateDynamicSceneMap(spec)`: детерминированная связная сцена клетками
/// по ограниченной спецификации картографа (`seed`, `theme`, `danger`,
/// `width`, `height`, `scale`, `layout`, `pattern`, `material`, `openness`,
/// `water`, `featureCount` — рыхлые значения, как в JS). `None` — `{}`.
/// Возвращает **разреженный** список по `y`, затем по `x`.
pub fn generate_dynamic_scene_map(spec: Option<&Value>) -> Result<Vec<SceneCell>, DynamicMapError> {
    if matches!(spec, Some(Value::Null)) {
        return Err(DynamicMapError {
            name: "TypeError",
            message: "Cannot destructure property 'seed' of '(intermediate value)(intermediate value)(intermediate value)' as it is null.".into(),
        });
    }
    let get = |key: &str| spec.and_then(Value::as_object).and_then(|object| object.get(key));
    let seed_text = js::string(get("seed"));
    let theme = Param::read(get("theme"), "");
    let danger = Param::read(get("danger"), "средняя");
    let layout = Param::read(get("layout"), "rooms");
    let arena = size_class("arena").unwrap_or(sk_tactical::tactical_map::SIZE_CLASSES[0].1);
    let scale_default = if js::truthy(get("scale")) { scale_size(get("scale")) } else { (13, 9) };
    let mut width = clamp_integer(get("width"), scale_default.0, 7, arena.max_width);
    let height = clamp_integer(get("height"), scale_default.1, 7, arena.max_height);
    while width * height > arena.max_cells {
        width -= 1;
    }
    let pattern = match get("pattern") {
        Some(Value::String(pattern)) if PATTERNS.contains(&pattern.as_str()) => pattern.clone(),
        None => "natural".to_string(),
        _ => "natural".to_string(),
    };
    let material = visual_material(&theme.text, &layout.text, get("material"));
    let mut random = RandomSource::new(&format!("{seed_text}:{}:{}:{width}:{height}:{}:{pattern}:{material}", theme.text, danger.text, layout.text));
    let center_x = width.div_euclid(2);
    let center_y = height.div_euclid(2);
    let openness = match get("openness") {
        None => 0.6,
        Some(value) => js::number(Some(value)),
    };
    let open_chance = 0.35_f64.max(0.85_f64.min(if openness == 0.0 || openness.is_nan() { 0.6 } else { openness }));
    let water = match get("water") {
        None => 0.04,
        Some(value) => js::number(Some(value)),
    };
    let water_chance = 0.0_f64.max(0.3_f64.min(if water == 0.0 || water.is_nan() { 0.0 } else { water }));
    let street_xs: HashSet<i64> = [center_x, 2.max(width.div_euclid(3)), (width - 3).min((width * 2).div_euclid(3))].into_iter().collect();
    let street_ys: HashSet<i64> = [center_y, 2.max(height.div_euclid(3)), (height - 3).min((height * 2).div_euclid(3))].into_iter().collect();
    let variant = |x: i64, y: i64| i64::from(floor_variant_at(&seed_text, x, y, FLOOR_VARIANTS));
    let grass = material == "grass";
    let pattern_is = |name: &str| pattern == name;
    let mut cells: Vec<SceneCell> = Vec::new();

    for y in 0..height {
        for x in 0..width {
            if !footprint_for(&layout, &pattern, x, y, width, height, &mut random) {
                continue;
            }
            let border = x == 0 || y == 0 || x == width - 1 || y == height - 1;
            let entrance_road = y == center_y && x <= center_x;
            let central_spine = y == center_y || x == center_x;
            let trail_y = center_y
                + js::round(math_sin((x as f64 / ((width - 1) as f64).max(1.0)) * std::f64::consts::PI * 2.0) * ((height as f64 * 0.1).floor()).max(1.0)) as i64;
            let scenic_trail = grass && y == trail_y;
            let streets = street_xs.contains(&x) || street_ys.contains(&y);
            let chamber = (x >= 2 && x <= 3.max(center_x - 2) && y >= 2 && y <= height - 3)
                || (x <= width - 3 && x >= (width - 4).min(center_x + 2) && y >= 2 && y <= height - 3);
            let distance = (x - center_x).abs().max((y - center_y).abs());
            let mut passable = false;
            if !border || entrance_road {
                passable = if pattern_is("small-room") {
                    !border
                } else if pattern_is("great-hall") {
                    !border && !((x % 4 == 0) && (y % 4 == 0) && x > 1 && y > 1)
                } else if pattern_is("courtyard") {
                    !border && ((x > 1 && y > 1 && x < width - 2 && y < height - 2) || central_spine)
                } else if pattern_is("keep") {
                    central_spine || chamber || (x > 1 && y > 1 && x < width - 2 && y < height - 2 && random.next() < open_chance * 0.32)
                } else if pattern_is("crypt") {
                    central_spine || (x % 4 != 0 && y % 3 != 0 && random.next() < open_chance * 0.7)
                } else if pattern_is("bridge") {
                    true
                } else if layout.is("streets") || pattern_is("village") {
                    streets || random.next() < open_chance * 0.42
                } else if layout.is("open") {
                    entrance_road || random.next() < open_chance
                } else if layout.is("winding") {
                    entrance_road
                        || scenic_trail
                        || central_spine
                        || ((y - center_y).abs() <= 2 && random.next() < open_chance)
                        || random.next() < open_chance * 0.28
                } else if layout.is("cavern") {
                    entrance_road || central_spine || random.next() < open_chance * 0.88
                } else if layout.is("radial") {
                    entrance_road || central_spine || distance == 2.max(width.min(height).div_euclid(3)) || random.next() < open_chance * 0.22
                } else if layout.is("ruins") {
                    entrance_road || central_spine || chamber || ((x + y) % 3 != 0 && random.next() < open_chance * 0.58)
                } else {
                    central_spine || chamber || random.next() < open_chance * 0.48
                };
            }
            let mut kind = if passable { SceneCellType::Floor } else { SceneCellType::Wall };
            if passable && !central_spine && random.next() < water_chance {
                kind = SceneCellType::Water;
            }
            if (layout.is("streets") || layout.is("ruins"))
                && kind == SceneCellType::Wall
                && !border
                && (street_xs.contains(&(x - 1)) || street_xs.contains(&(x + 1)) || street_ys.contains(&(y - 1)) || street_ys.contains(&(y + 1)))
                && random.next() < 0.14
            {
                kind = SceneCellType::Door;
            }
            let cell_material = if grass && kind == SceneCellType::Floor && (scenic_trail || entrance_road) { "earth".to_string() } else { material.clone() };
            cells.push(SceneCell {
                x,
                y,
                kind,
                revealed: passable && x <= 2,
                material: Some(cell_material),
                variant: Some(variant(x, y)),
                pattern: Some(pattern.clone()),
                elevation: None,
                feature: None,
                edge_mask: None,
            });
        }
    }

    let mut by_position: HashMap<(i64, i64), usize> = cells.iter().enumerate().map(|(index, cell)| ((cell.x, cell.y), index)).collect();
    let mut ensure_floor = |cells: &mut Vec<SceneCell>, x: i64, y: i64| {
        let index = match by_position.get(&(x, y)) {
            Some(index) => *index,
            None => {
                cells.push(SceneCell {
                    x,
                    y,
                    kind: SceneCellType::Floor,
                    revealed: x <= 2,
                    material: Some(if grass { "earth".to_string() } else { material.clone() }),
                    variant: Some(variant(x, y)),
                    pattern: Some(pattern.clone()),
                    elevation: None,
                    feature: None,
                    edge_mask: None,
                });
                by_position.insert((x, y), cells.len() - 1);
                cells.len() - 1
            }
        };
        let cell = &mut cells[index];
        cell.kind = SceneCellType::Floor;
        cell.revealed = x <= 2;
        if grass {
            cell.material = Some("earth".into());
        }
    };
    for x in 1..=center_x {
        ensure_floor(&mut cells, x, center_y);
    }
    ensure_floor(&mut cells, center_x, center_y);
    let by_position: HashMap<(i64, i64), usize> = cells.iter().enumerate().map(|(index, cell)| ((cell.x, cell.y), index)).collect();
    let walkable_at = |cells: &[SceneCell], x: i64, y: i64| by_position.get(&(x, y)).is_some_and(|index| cells[*index].kind.walkable());

    // Острова пола и дверей, недосягаемые от входа, становятся стеной: вода и
    // стены остаются декорацией, но каждая клетка, где можно стоять, досягаема.
    let mut reached: HashSet<(i64, i64)> = HashSet::new();
    if walkable_at(&cells, 1, center_y) {
        let mut queue = vec![(1, center_y)];
        reached.insert((1, center_y));
        let mut index = 0;
        while index < queue.len() {
            let (cx, cy) = queue[index];
            index += 1;
            for next in [(cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)] {
                if !walkable_at(&cells, next.0, next.1) || reached.contains(&next) {
                    continue;
                }
                reached.insert(next);
                queue.push(next);
            }
        }
    }
    for cell in &mut cells {
        if cell.kind.walkable() && !reached.contains(&(cell.x, cell.y)) {
            cell.kind = SceneCellType::Wall;
            cell.revealed = false;
        }
    }

    let mut candidates: Vec<usize> = (0..cells.len())
        .filter(|index| {
            let cell = &cells[*index];
            cell.kind == SceneCellType::Floor && reached.contains(&(cell.x, cell.y)) && !(cell.x <= 2 && cell.y == center_y)
        })
        .collect();
    let features = features_for(&theme.text, &layout.text, &pattern, &material);
    let default_count = if danger.is("высокая") {
        8
    } else if danger.is("низкая") {
        4
    } else {
        6
    };
    let count = clamp_integer(get("featureCount"), default_count, 2, 12);
    let mut placed: Vec<usize> = Vec::new();
    let mut index = 0;
    while index < count && !candidates.is_empty() {
        let feature = features[(index as usize) % features.len()];
        let mut chosen_index = 0;
        let mut chosen_score = f64::NEG_INFINITY;
        for (candidate_index, candidate) in candidates.iter().enumerate() {
            let score = feature_cell_score(feature, &cells, *candidate, &walkable_at, center_x, center_y, &placed, &mut random);
            if score > chosen_score {
                chosen_index = candidate_index;
                chosen_score = score;
            }
        }
        let chosen = candidates.remove(chosen_index);
        cells[chosen].feature = Some(feature.to_string());
        placed.push(chosen);
        index += 1;
    }
    // Каждая сцена держит явную отметку выхода.
    if let Some(last) = placed.last() {
        if !placed.iter().any(|index| cells[*index].feature.as_deref() == Some("stairs")) {
            cells[*last].feature = Some("stairs".into());
        }
    }
    // Среди уже выделенного бюджета декора — хотя бы два предмета словаря
    // взаимодействий, если для этого физически хватает мест.
    let supported = |feature: Option<&str>| scene_interaction_catalog_entry(feature.map(|feature| Value::String(feature.into())).as_ref()).is_some();
    let mut supported_features: Vec<&str> = Vec::new();
    for feature in features {
        if supported(Some(feature)) && !supported_features.contains(feature) {
            supported_features.push(feature);
        }
    }
    let mut supported_placed = placed.iter().filter(|index| supported(cells[**index].feature.as_deref())).count();
    if !supported_features.is_empty() && supported_placed < 2 {
        let replaceable: Vec<usize> = placed
            .iter()
            .copied()
            .filter(|index| {
                let feature = cells[*index].feature.as_deref();
                feature != Some("stairs") && !supported(feature)
            })
            .collect();
        for index in replaceable {
            cells[index].feature = Some(supported_features[supported_placed % supported_features.len()].to_string());
            supported_placed += 1;
            if supported_placed >= 2 {
                break;
            }
        }
    }

    // Возвышенности кладутся последними, после стен, воды и реквизита: поток
    // случайных чисел у остального не сдвигается.
    let ledge_budget = if danger.is("высокая") {
        3
    } else if danger.is("низкая") {
        1
    } else {
        2
    };
    let mut raised: HashSet<(i64, i64)> = HashSet::new();
    let ledge_allowed = |cells: &[SceneCell], raised: &HashSet<(i64, i64)>, index: usize| {
        let cell = &cells[index];
        cell.kind == SceneCellType::Floor
            && reached.contains(&(cell.x, cell.y))
            && !raised.contains(&(cell.x, cell.y))
            // Въездная дорога — место высадки партии, её оставляем ровной.
            && !(cell.x <= 2 && cell.y == center_y)
    };
    for _ in 0..ledge_budget {
        let available: Vec<usize> = (0..cells.len()).filter(|index| ledge_allowed(&cells, &raised, *index)).collect();
        if available.is_empty() {
            break;
        }
        // Ступень в 10 футов реже пятифутовой.
        let step = if random.next() < 0.3 { 10 } else { 5 };
        let size = 2 + (random.next() * 4.0).floor() as i64;
        let start = available[(random.next() * available.len() as f64).floor() as usize];
        let mut frontier: std::collections::VecDeque<usize> = std::collections::VecDeque::from([start]);
        let mut grown = 0;
        while grown < size {
            let Some(index) = frontier.pop_front() else { break };
            if !ledge_allowed(&cells, &raised, index) {
                continue;
            }
            let (x, y) = (cells[index].x, cells[index].y);
            raised.insert((x, y));
            cells[index].elevation = Some(step);
            grown += 1;
            for next in [(x, y - 1), (x + 1, y), (x, y + 1), (x - 1, y)] {
                if let Some(neighbor) = by_position.get(&next) {
                    if ledge_allowed(&cells, &raised, *neighbor) {
                        frontier.push_back(*neighbor);
                    }
                }
            }
        }
    }

    let masks: Vec<String> = cells
        .iter()
        .map(|cell| {
            let mut edges = String::new();
            for (label, x, y) in [('n', cell.x, cell.y - 1), ('e', cell.x + 1, cell.y), ('s', cell.x, cell.y + 1), ('w', cell.x - 1, cell.y)] {
                let neighbor = by_position.get(&(x, y)).map(|index| cells[*index].kind);
                if neighbor.is_none_or(|neighbor| cell.kind.walkable() && !neighbor.walkable()) {
                    edges.push(label);
                }
            }
            edges
        })
        .collect();
    for (cell, mask) in cells.iter_mut().zip(masks) {
        cell.edge_mask = Some(mask);
    }
    cells.sort_by_key(|cell| (cell.y, cell.x));
    Ok(cells)
}

/// `featureCellScore(feature, cell, byPosition, centerX, centerY, placed, random)`.
#[allow(clippy::too_many_arguments)] // повторяет сигнатуру JS
fn feature_cell_score(
    feature: &str,
    cells: &[SceneCell],
    index: usize,
    walkable_at: &dyn Fn(&[SceneCell], i64, i64) -> bool,
    center_x: i64,
    center_y: i64,
    placed: &[usize],
    random: &mut RandomSource,
) -> f64 {
    let cell = &cells[index];
    let adjacent_walls = [(1, 0), (-1, 0), (0, 1), (0, -1)].iter().filter(|(dx, dy)| !walkable_at(cells, cell.x + dx, cell.y + dy)).count() as f64;
    let center_distance = ((cell.x - center_x).abs() + (cell.y - center_y).abs()) as f64;
    let table = placed.iter().map(|index| &cells[*index]).find(|entry| entry.feature.as_deref() == Some("table"));
    let table_distance = table.map_or(99.0, |table| ((cell.x - table.x).abs() + (cell.y - table.y).abs()) as f64);
    let mut score = random.next() * 2.0;
    if WALL_HUGGERS.contains(&feature) {
        score += adjacent_walls * 4.0 + center_distance * 0.15;
    }
    if matches!(feature, "table" | "altar" | "statue" | "well") {
        score += (8.0 - center_distance).max(0.0) * 1.2;
    }
    if feature == "chair" {
        score += if table_distance <= 1.0 {
            14.0
        } else if table_distance == 2.0 {
            7.0
        } else {
            -table_distance
        };
    }
    if matches!(feature, "stairs" | "chest" | "rune") {
        score += cell.x as f64 * 0.6;
    }
    if feature == "campfire" {
        score += (6.0 - center_distance).max(0.0);
    }
    if matches!(feature, "tree" | "bush") {
        score += if cell.material.as_deref() == Some("grass") { 8.0 } else { -5.0 };
    }
    if feature == "rock" {
        score += if cell.material.as_deref() == Some("earth") { 3.0 } else { 0.0 };
    }
    score
}

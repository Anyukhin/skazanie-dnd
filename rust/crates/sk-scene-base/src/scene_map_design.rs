//! Перенос `server/scene-map-design.mjs`: замысел карты нового места.
//!
//! Только замысел — топология, климат, материал построек, плотность,
//! назначение здания, форма, масштаб. Геометрия, проходимость и числа
//! принадлежат генератору. Местное описание сильнее общего сеттинга и заявки
//! модели; без слов выбор детерминирован сидом (SHA-256, как в JS).
//! Якоря (`landmarks`) — виды из закрытого словаря `scene_requirements`.

use serde::Serialize;
use serde_json::{Map, Value};
use sk_core::fancy_regex::Regex;
use sk_core::{hash, js, re, text};

use crate::scene_requirements::normalize_landmarks;
use crate::util::{js_string, nullish, str_of, utf16_head};

const FIELDS: [(&str, &[&str]); 7] = [
    ("topology", &["organic", "linear", "crossroads", "market", "courtyard", "harbor", "river", "terraced", "gate"]),
    ("climate", &["temperate", "arid", "cold", "wetland"]),
    ("architecture", &["wood", "stone", "sand", "metal", "marble", "ice"]),
    ("density", &["sparse", "mixed", "dense"]),
    ("building_use", &["dwelling", "tavern", "shop", "manor", "smithy", "barracks", "mill"]),
    ("shape", &["rect", "L", "cross", "round"]),
    ("scale", &["village", "town", "city"]),
];

/// `String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('ru').slice(0, limit)`.
fn clean(value: &str, limit: usize) -> String {
    utf16_head(&text::lower(text::trim(&text::nfkc(value))), limit).to_string()
}

/// Только замысел места: признаки из закрытых перечней и якоря. Не объект —
/// пустой замысел.
pub fn normalize_scene_map_design(value: &Value) -> Value {
    let mut result = Map::new();
    let Value::Object(source) = value else { return Value::Object(result) };
    for (key, allowed) in FIELDS {
        if let Some(Value::String(chosen)) = source.get(key) {
            if allowed.contains(&chosen.as_str()) {
                result.insert(key.to_string(), Value::String(chosen.clone()));
            }
        }
    }
    let landmarks = normalize_landmarks(source.get("landmarks").unwrap_or(&Value::Null));
    if !landmarks.is_empty() {
        result.insert("landmarks".into(), serde_json::to_value(&landmarks).unwrap_or(Value::Null));
    }
    Value::Object(result)
}

fn seeded_choice<'a>(values: &[&'a str], seed: &str, purpose: &str) -> &'a str {
    let digest = hash::sha256(format!("{seed}:map-design/v1:{purpose}"));
    let index = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]);
    values[index as usize % values.len()]
}

fn climate_from(source: &str) -> &'static str {
    let patterns: [(&Regex, &str); 3] = [
        (re!(r"пустын|засушлив|бархан|песчан|\barid\b|\bdesert\b", "u"), "arid"),
        // «Льд» — только с начала слова: в «Вельдбурге» те же буквы.
        (re!(r"снеж|снег|ледян|(?<![\p{L}\p{M}])льд|мерзлот|тундр|арктич|\btundra\b|\bice\b|\bsnow\b", "u"), "cold"),
        (re!(r"болот|топ[ьи]|трясин|мангр|\bswamp\b|\bwetland\b|\bmarsh\b", "u"), "wetland"),
    ];
    let climates: Vec<&str> = patterns.iter().filter(|(pattern, _)| text::test(pattern, source)).map(|(_, climate)| *climate).collect();
    // Неоднозначный текст не сильнее местного канона.
    if climates.len() == 1 {
        climates[0]
    } else {
        ""
    }
}

/// Поле входа как значение JS: отсутствующее — `None` (сработает значение по
/// умолчанию деструктуризации), `null` — `Some(Null)`.
fn input_field<'a>(input: &'a Value, key: &str) -> Option<&'a Value> {
    input.get(key)
}

/// `${value}` для поля со значением по умолчанию.
fn template(input: &Value, key: &str, default: &str) -> String {
    match input_field(input, key) {
        None => default.to_string(),
        some => js_string(some),
    }
}

fn explicit_str<'a>(explicit: &'a Value, key: &str) -> Option<&'a str> {
    explicit.get(key).and_then(Value::as_str)
}

/// Структурная заявка для нового места.
///
/// Вход — объект с полями JS: `location`, `theme`, `description`,
/// `worldDescription`, `worldKind`, `settlementType`, `biome`, `request`,
/// `seed`. Локальное описание сильнее общего сеттинга; прошлое место и текст
/// квеста здесь намеренно не используются.
pub fn scene_map_design_for(input: &Value) -> Value {
    let empty_request = Value::Object(Map::new());
    let request = match input_field(input, "request") {
        // `request: null` в JS бросает TypeError на `request.design`; здесь — пустая заявка.
        None | Some(Value::Null) => &empty_request,
        Some(other) => other,
    };
    let explicit = normalize_scene_map_design(request.get("design").unwrap_or(&Value::Null));
    let location = template(input, "location", "");
    let theme = template(input, "theme", "");
    let description = template(input, "description", "");
    let biome = template(input, "biome", "");
    let seed = template(input, "seed", "scene");
    let local = clean(&format!("{location} {theme} {description} {biome}"), 1600);
    let lighthouse =
        text::test(re!(r"(?<![\p{L}\p{M}])маяк(?:а|у|ом|е|и|ов|ам|ами|ах)?(?![\p{L}\p{M}])", "u"), &clean(&format!("{location} {theme}"), 1600));
    let world = clean(&str_of(input_field(input, "worldDescription")), 2400);
    let world_kind = input_field(input, "worldKind");
    let kind_source = if js::truthy(world_kind) { world_kind } else { input_field(input, "settlementType") };
    // Значение по умолчанию `''`: отсутствующее поле — пустая строка.
    let kind = clean(&str_of(kind_source), 40);
    let city_kind = ["city", "capital", "port", "town"].contains(&kind.as_str());
    let rural = kind == "village"
        || (!city_kind && text::test(re!(r"деревн|(?<![\p{L}\p{M}])сел[оау](?![\p{L}\p{M}])|хутор|слобод", "u"), &local));
    let urban = city_kind || (kind != "village" && text::test(re!(r"город|столиц|квартал", "u"), &local));
    let climate = [climate_from(&local), explicit_str(&explicit, "climate").unwrap_or(""), climate_from(&world)]
        .into_iter()
        .find(|value| !value.is_empty())
        .unwrap_or("temperate");
    let dry_watercourse = text::test(re!(r"(?:пересох|высох)[^.!?]{0,40}(?:рек|русл|канал)|без (?:реки|канала|воды)", "u"), &local);
    let river = !dry_watercourse
        && text::test(
            re!(r"речн|междуреч|дельт|\b(?:river|canal)\b|(?<![\p{L}\p{M}])рек(?:а|и|у|е|ой|ою|ам|ах)?(?![\p{L}\p{M}])|канал|двух берег|два берег", "u"),
            &local,
        );
    let topology: &str = if river {
        "river"
    // Дамба, плотина, шлюз, набережная — тоже край воды.
    } else if kind == "port"
        || text::test(
            re!(r"(?<![\p{L}\p{M}])порт(?:а|у|ом|е|ы|ов[а-яё]*|ами|ах)?(?![\p{L}\p{M}])|гаван|пристан|верф|причал|морск.*берег|(?<![\p{L}\p{M}])(?:дамб|плотин|шлюз|набережн|волнолом)|\b(?:harbou?r|port)\b", "u"),
            &local,
        )
    {
        "harbor"
    } else if text::test(re!(r"(?<![\p{L}\p{M}])(?:ворот|врат)|застав|приврат", "u"), &local) {
        "gate"
    } else if text::test(re!(r"террас|горн|склон|кряж|на скал|\bmountains\b", "u"), &local) {
        "terraced"
    } else if text::test(re!(r"рыноч|рынок|базар|торгов[а-яё]* площад", "u"), &local) {
        "market"
    } else if text::test(re!(r"вокруг двор|внутренн[а-яё]* двор|замкнут[а-яё]* двор", "u"), &local) {
        "courtyard"
    } else if text::test(re!(r"вдоль дорог|вдоль тракт|дорожн[а-яё]* деревн|одна улица", "u"), &local) {
        "linear"
    } else {
        match explicit_str(&explicit, "topology") {
            Some(topology) if !topology.is_empty() => topology,
            _ => {
                let choices: &[&str] = if rural {
                    &["organic", "linear", "crossroads"]
                } else if urban {
                    &["market", "courtyard", "crossroads", "linear"]
                } else {
                    &["organic", "crossroads", "courtyard"]
                };
                seeded_choice(choices, &seed, "topology")
            }
        }
    };

    let mut architecture: &str = if text::test(re!(r"саман|глинобит|сырцов", "u"), &local) {
        "sand"
    } else if text::test(re!(r"деревян|бревен|сруб|дощат", "u"), &local) {
        "wood"
    } else if text::test(re!(r"мрамор", "u"), &local) {
        "marble"
    } else if text::test(re!(r"металлическ|стальн|железн[а-яё]* (?:дом|город|башн)", "u"), &local) {
        "metal"
    } else if text::test(re!(r"ледян[а-яё]* (?:дом|дворец|город)|изо? льда", "u"), &local) {
        "ice"
    } else if text::test(re!(r"каменн|кирпич|белокамен", "u"), &local) {
        "stone"
    } else {
        explicit_str(&explicit, "architecture").unwrap_or("")
    };
    if architecture.is_empty() {
        architecture = if climate == "arid" {
            "sand"
        } else if urban || kind == "fortress" || lighthouse {
            "stone"
        } else {
            "wood"
        };
    }
    let density: &str = if text::test(re!(r"редк[а-яё]* (?:дом|застрой)|разбросан|маленьк[а-яё]* деревн|хутор", "u"), &local) {
        "sparse"
    } else if text::test(re!(r"тесн|густ[а-яё]* застрой|плотн[а-яё]* застрой|многолюд|столиц", "u"), &local) {
        "dense"
    } else {
        // Деревня по умолчанию — обычная застройка; редкой остаётся хутор и деревня в пустыне.
        match explicit_str(&explicit, "density") {
            Some(density) if !density.is_empty() => density,
            _ if rural => {
                if climate == "arid" {
                    "sparse"
                } else {
                    "mixed"
                }
            }
            _ if urban => "dense",
            _ => "mixed",
        }
    };
    let building_use: &str = if text::test(re!(r"кузн|кузниц", "u"), &local) {
        "smithy"
    } else if text::test(re!(r"казарм|караульн|гарнизон|сторожев[а-яё]* башн|дозорн[а-яё]* башн", "u"), &local) {
        "barracks"
    // Маяк — башня смотрителя: только по названию места.
    } else if text::test(re!(r"башн", "u"), &local) || lighthouse {
        "manor"
    } else if text::test(re!(r"мельниц", "u"), &local) {
        "mill"
    } else if text::test(re!(r"таверн|трактир|постоял|корчм|гостиниц", "u"), &local) {
        "tavern"
    } else if text::test(re!(r"лавк|магазин|мастерск|склад|торгов[а-яё]* ряд|рыночн[а-яё]* набережн", "u"), &local) {
        "shop"
    } else if text::test(re!(r"особняк|усадьб|дворец|крепост|замок|цитадел|галере|тронн[а-яё]* зал", "u"), &local)
        || kind == "fortress"
        || request.get("pattern").and_then(Value::as_str) == Some("keep")
    {
        "manor"
    } else {
        explicit_str(&explicit, "building_use").filter(|value| !value.is_empty()).unwrap_or("dwelling")
    };
    // Форма корпуса — по словам места; без слов форму выберет генератор.
    let shape: Option<&str> =
        if text::test(re!(r"кругл[а-яё]* (?:башн|зал|дом|здани)|ротонд|башн[яиюе]", "u"), &local) || lighthouse {
            Some("round")
        } else if text::test(re!(r"г-образн|углом|буквой г", "u"), &local) {
            Some("L")
        } else if text::test(re!(r"крестообразн|крестом", "u"), &local) {
            Some("cross")
        } else {
            explicit_str(&explicit, "shape")
        };
    // Масштаб поселения: деревня, город, столица.
    let scale: Option<&str> = if kind == "capital" || text::test(re!(r"столиц|мегаполис|великий город", "u"), &local) {
        Some("city")
    } else if city_kind || urban {
        Some("town")
    } else if rural {
        Some("village")
    } else {
        explicit_str(&explicit, "scale")
    };
    // Дом мага или алхимика. «Маг» — отдельным словом: в «магазине» те же буквы.
    let arcane = text::test(
        re!(r"(?<![\p{L}\p{M}])маг(?:а|у|ом|е|и|ов|ам|ами|ах)?(?![\p{L}\p{M}])|магическ|магии|чароде|колдун|волшебник|алхими|лаборатор|чернокниж|некромант|\b(?:wizard|mage|alchemist)\b", "u"),
        &local,
    );
    let mut result = Map::new();
    result.insert("topology".into(), Value::String(topology.into()));
    result.insert("climate".into(), Value::String(climate.into()));
    result.insert("architecture".into(), Value::String(architecture.into()));
    result.insert("density".into(), Value::String(density.into()));
    result.insert("building_use".into(), Value::String(building_use.into()));
    if let Some(shape) = shape.filter(|value| !value.is_empty()) {
        result.insert("shape".into(), Value::String(shape.into()));
    }
    if let Some(scale) = scale.filter(|value| !value.is_empty()) {
        result.insert("scale".into(), Value::String(scale.into()));
    }
    if arcane {
        result.insert("arcane".into(), Value::Bool(true));
    }
    Value::Object(result)
}

/// Публичное описание точки карты мира.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LocationDesignContext {
    pub description: String,
    pub biome: String,
}

fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    // `(worldMap?.locations ?? [])`: не массив в JS бросает на `.find`; здесь — пусто.
    match value.get(key) {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// Публичное описание именно выбранной точки карты мира: по `locationId`,
/// иначе по имени места. Скрытые и неизвестные игрокам точки дают пустое.
pub fn world_location_design_context(world_map: &Value, location_id: Option<&Value>, location: Option<&Value>) -> LocationDesignContext {
    let wanted_id = js_string(location_id);
    let wanted_name = clean(&str_of(location), 1600);
    let locations = list(world_map, "locations");
    let node = locations
        .iter()
        .find(|entry| js_string(entry.get("id")) == wanted_id)
        .or_else(|| locations.iter().find(|entry| clean(&str_of(entry.get("name")), 1600) == wanted_name));
    let Some(node) = node else { return LocationDesignContext::default() };
    if js::is_false(node.get("known"))
        || js::is_true(node.get("hidden"))
        || node.get("visibility").and_then(Value::as_str) == Some("gm_only")
    {
        return LocationDesignContext::default();
    }
    let region_id = js_string(nullish(node.get("regionId"), node.get("region_id")));
    let region = list(world_map, "regions").iter().find(|entry| js_string(entry.get("id")) == region_id);
    let description = [node.get("summary"), node.get("history")]
        .into_iter()
        .filter_map(|value| value.and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    let biome = str_of(nullish(node.get("biome"), region.and_then(|region| region.get("biome"))));
    LocationDesignContext { description: utf16_head(&description, 1600).to_string(), biome: utf16_head(&biome, 80).to_string() }
}

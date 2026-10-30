//! Перенос `server/scene-requirements.mjs`: обязательные объекты сцены — что
//! текст сцены пообещал увидеть на карте.
//!
//! Сервер без модели вытаскивает из слов сцены закрытым словарём, что обязано
//! стоять на карте (`scene.map_requirements`): виды объектов, количество по
//! числительному, центр сцены, посты жителей, улики из якорей картографа.
//! Тем же словарём Рассказчик проверяет, не описывает ли он отсутствующее, а
//! строки перехода теряют фразы о постройках, которых на карте нет.
//!
//! Границы слов — через `\p{L}`, а не `\b`: в JS `\b` знает только латиницу.
//! Регулярные выражения перенесены без правки (синтаксис JS, `sk_core::re!`).
//! Модуль — лист: состояния не хранит, Replay от него не зависит.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Serialize;
use serde_json::{Map, Value};
use sk_core::fancy_regex::Regex;
use sk_core::{js, re, text};

use crate::util::{
    field, js_max, js_min, js_string, letter_before, nullish, number_or_zero, split_regex, str_of,
    utf16_back, utf16_head,
};

// v2 (2026-10-03): центр сцены (`focus`) и посты жителей (`posts`).
// v3 (этапы 2–4): якоря модели, улики (`clues`) и недостающее (`missing`).
pub const SCENE_REQUIREMENTS_VERSION: &str = "scene-requirements/v3";

/// Роль якоря в программе сцены. Обязательны центр, пост жителя и улика.
pub const LANDMARK_ROLES: [&str; 5] = ["focus", "npc_post", "clue", "entry", "dressing"];

/// Сколько якорей модель может назвать для одной сцены.
const MAX_LANDMARKS: usize = 6;

/// Сколько видов объектов держит одна сцена и сколько штук одного вида.
const MAX_ITEMS: usize = 12;
const MAX_COUNT: f64 = 6.0;

/// Вид объекта сцены.
#[derive(Debug)]
pub struct RequirementKind {
    pub id: &'static str,
    /// Подпись по-русски.
    pub label: &'static str,
    /// Источник регулярного выражения в синтаксисе JS (флаг `u`).
    pub source: &'static str,
    /// Слово в тексте; левая граница проверяется отдельно.
    pub pattern: Regex,
    /// Предметы реестра, которые воплощают объект; пусто — карта обещание не выполнит.
    pub assets: &'static [&'static str],
    /// Объект строится клетками карты, а не предметом: настил — `platform`.
    pub terrain: Option<&'static str>,
    /// `false` — вид не читается из слов сцены, только из якорей модели.
    pub from_text: bool,
}

type KindRow = (&'static str, &'static str, &'static str, &'static [&'static str], Option<&'static str>, bool);

/// Окончания существительных сведены в явные списки, а не в `\p{L}*`: иначе
/// «навес» ловил бы «навеселе», а «стол» — «столицу».
const KIND_TABLE: [KindRow; 30] = [
    ("shelter", "навес", r"навес(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?!\p{L})", &["market_awning"], None, true),
    ("platform", "настил", r"(?:настил|помост)(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?!\p{L})|мостк(?:и|ов|ам|ами|ах)(?!\p{L})", &[], Some("platform"), true),
    ("threshold_stone", "камни на пороге", r"(?:камн(?:и|ей|ям|ями|ях)|камень|камнем|камня)\s+(?:у|на|перед|под)\s+порог\p{L}*|порожн\p{L}*\s+камн\p{L}*|порог(?:е|ах|ам|и|а|у)?\s+(?:\p{L}+\s+){0,2}камн(?:и|ей|ям|ями|ях)(?!\p{L})", &["path_stone", "ledge_step"], None, true),
    ("crate", "ящик", r"ящик(?:а|у|ом|е|и|ов|ам|ами|ах)?(?!\p{L})", &["crate", "crate_stack", "chest"], None, true),
    ("chest", "сундук", r"сундук(?:а|у|ом|е|и|ов|ам|ами|ах)?(?!\p{L})|лар(?:ец|ца|цу|цом|це|цы|цов)(?!\p{L})|шкатулк\p{L}*", &["chest"], None, true),
    ("campfire", "костёр", r"кост(?:ёр|ер|ра|ру|ром|ре|ры|ров|рам|рами|рах)(?!\p{L})|кострищ\p{L}*|костровищ\p{L}*", &["campfire"], None, true),
    ("hearth", "очаг", r"очаг(?:а|у|ом|е|и|ов|ам|ами|ах)?(?!\p{L})|камин(?:а|у|ом|е|ы|ов)?(?!\p{L})", &["fireplace", "hearth_fire"], None, true),
    ("well", "колодец", r"колод(?:ец|ца|цу|цем|це|цы|цев|цам|цами|цах)(?!\p{L})", &["well"], None, true),
    ("statue", "статуя", r"стату(?:я|и|ю|ей|е|й|ям|ями|ях)(?!\p{L})|изваян\p{L}*|идол(?:а|у|ом|е|ы|ов)?(?!\p{L})", &["statue"], None, true),
    ("altar", "алтарь", r"алтар(?:ь|я|ю|ём|ем|е|и|ей|ям|ями|ях)(?!\p{L})|жертвенник\p{L}*", &["altar"], None, true),
    ("shrine", "часовня", r"часовн\p{L}*|божниц\p{L}*", &["roadside_shrine", "altar"], None, true),
    ("cart", "телега", r"телег\p{L}*|повозк\p{L}*|фургон(?:а|у|ом|е|ы|ов)?(?!\p{L})", &["cart"], None, true),
    ("market_stall", "прилавок", r"прилав(?:ок|ка|ку|ком|ке|ки|ков|кам|ками|ках)(?!\p{L})|торгов\p{L}*\s+(?:палатк|лот[ок])\p{L}*", &["market_stall"], None, true),
    ("haystack", "стог", r"стог(?:а|у|ом|е|и|ов)?(?!\p{L})|скирд\p{L}*", &["haystack"], None, true),
    ("trough", "поилка", r"поилк\p{L}*|корыт(?:о|а|у|ом|е)(?!\p{L})", &["water_trough"], None, true),
    ("fence", "изгородь", r"забор(?:а|у|ом|е|ы|ов)?(?!\p{L})|изгород\p{L}*|плет(?:ень|ня|ню|нём|нем|не|ни)(?!\p{L})|частокол\p{L}*", &["village_fence", "rail_fence"], None, true),
    ("barrels", "бочки", r"бо(?:чк|чек|чонок|чонк)\p{L}*", &["barrel", "barrel_stack", "keg"], None, true),
    ("signpost", "указатель", r"указател(?:ь|я|ю|ем|е|и|ей)(?!\p{L})", &["signpost"], None, true),
    ("milestone", "верстовой камень", r"верстов\p{L}*\s+(?:столб|камн|камен)\p{L}*", &["milestone"], None, true),
    ("lantern", "фонарь", r"фонар(?:ь|я|ю|ём|ем|е|и|ей|ям|ями|ях)(?!\p{L})", &["lamp_post", "lantern_wall"], None, true),
    ("grave", "могила", r"могил(?:а|ы|е|у|ой|ам|ами|ах)?(?!\p{L})|надгроби\p{L}*", &["grave"], None, true),
    ("table", "стол", r"стол(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?!\p{L})", &["table_small", "table_round", "table_long", "table_royal"], None, true),
    ("bench", "скамья", r"скам(?:ья|ьи|ье|ью|ьёй|ьей|ей|ьям|ьями|ьях)(?!\p{L})", &["bench", "prayer_bench"], None, true),
    ("brazier", "жаровня", r"жаровн\p{L}*", &["brazier"], None, true),
    ("cauldron", "котёл", r"кот(?:ёл|ел|ла|лу|лом|ле|лы|лов)(?!\p{L})", &["cauldron"], None, true),
    ("oak", "дуб", r"дуб(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?!\p{L})", &["tree_oak"], None, true),
    ("notice_board", "доска объявлений", r"доск(?:а|и|е|у|ой)\s+(?:объявлений|указов|приказов|вестей)(?!\p{L})", &["notice_board"], None, true),
    ("forge", "кузница", r"кузн(?:ица|ицы|ице|ицу|ицей|ечн\p{L}*)(?!\p{L})|наковальн\p{L}*", &["forge", "anvil"], None, true),
    // Замер 31 (2026-10-11): причал — по словам сцены, лодка — только якорем модели.
    ("mooring", "причал", r"(?:причал|пирс)(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?!\p{L})|пристан(?:ь|и|ью|ей|ям|ями|ях)(?!\p{L})|кнехт\p{L}*|швартов\p{L}*\s+тумб\p{L}*", &["mooring_post"], None, true),
    ("rowboat", "лодка", r"(?:лодк|баркас|шлюпк|ялик|плоскодонк)\p{L}*|чел(?:н|ён|ен)(?:а|у|ом|е|ы|ов)?(?!\p{L})", &["rowboat", "punt"], None, false),
];

fn compile(source: &str) -> Regex {
    text::js_regex(source, "u").expect("регулярное выражение словаря сцены")
}

/// Словарь видов объектов сцены (`SCENE_REQUIREMENT_KINDS`).
pub static SCENE_REQUIREMENT_KINDS: LazyLock<Vec<RequirementKind>> = LazyLock::new(|| {
    KIND_TABLE
        .iter()
        .map(|&(id, label, source, assets, terrain, from_text)| RequirementKind {
            id,
            label,
            source,
            pattern: compile(source),
            assets,
            terrain,
            from_text,
        })
        .collect()
});

/// Что может быть центром сцены: первое по тексту из этих мест.
const FOCUS_KINDS: [&str; 11] =
    ["shelter", "well", "campfire", "market_stall", "statue", "altar", "shrine", "hearth", "notice_board", "oak", "table"];

fn kind_by_id(id: &str) -> Option<&'static RequirementKind> {
    static BY_ID: LazyLock<HashMap<&'static str, usize>> =
        LazyLock::new(|| SCENE_REQUIREMENT_KINDS.iter().enumerate().map(|(index, kind)| (kind.id, index)).collect());
    BY_ID.get(id).map(|index| &SCENE_REQUIREMENT_KINDS[*index])
}

/// Глава общины стоит в центре сцены.
fn leader_role() -> &'static Regex {
    re!(r"(?<!\p{L})(?:старост\p{L}*|старейшин\p{L}*|вожд\p{L}*|вождь|(?:голов|глав)(?:а|ы|е|у|ой)\s+(?:деревни|общины|посёлка|поселка|совета|скита))(?!\p{L})", "u")
}

/// Роль жителя называет его рабочее место.
fn role_kinds() -> [(&'static Regex, &'static str); 5] {
    [
        (re!(r"(?<!\p{L})(?:хранител\p{L}*\s+(?:записей|архива|документов|бумаг|грамот)|архивариус\p{L}*|писар\p{L}*|летописц\p{L}*)", "u"), "chest"),
        (re!(r"(?<!\p{L})кузнец\p{L}*", "u"), "forge"),
        (re!(r"(?<!\p{L})(?:торгов(?:ец|ка|цы)|лавочни\p{L}*|продав\p{L}*|купе(?:ц|чих)\p{L}*)", "u"), "market_stall"),
        (re!(r"(?<!\p{L})(?:жрец\p{L}*|жриц\p{L}*|священник\p{L}*|настоятел\p{L}*|монах\p{L}*|послушни\p{L}*)", "u"), "altar"),
        (re!(r"(?<!\p{L})мастер\p{L}*\s+(?:настил|помост|мостк)\p{L}*", "u"), "platform"),
    ]
}

/// Числительные, которые задают количество. «Пара» — тоже два.
const NUMERALS: [(&str, f64); 24] = [
    ("один", 1.0), ("одна", 1.0), ("одно", 1.0), ("одного", 1.0), ("одной", 1.0),
    ("два", 2.0), ("две", 2.0), ("двух", 2.0), ("пара", 2.0), ("пару", 2.0), ("оба", 2.0), ("обе", 2.0),
    ("три", 3.0), ("трёх", 3.0), ("трех", 3.0), ("четыре", 4.0), ("четырёх", 4.0), ("четырех", 4.0),
    ("пять", 5.0), ("пяти", 5.0), ("шесть", 6.0), ("шести", 6.0), ("семь", 7.0), ("восемь", 8.0),
];

/// `NUMERALS[word]` по собственному ключу: число или «нет» (`undefined`).
fn numeral(word: &str) -> Option<f64> {
    if let Some((_, value)) = NUMERALS.iter().find(|(key, _)| *key == word) {
        return Some(*value);
    }
    None
}

/// Отрицание прямо перед словом снимает объект: «без навеса», «нет ни одного колодца».
fn negation_before() -> &'static Regex {
    re!(r"(?<!\p{L})(?:без|нет|ни|лишён\p{L}*|лишен\p{L}*)(?:\s+(?:ни|одного|одной|даже|какого-либо|никакого|никакой|\p{L}+(?:ого|ей|ых)))*\s+$", "u")
}

/// Прилагательное между числительным и объектом: «три старых дощатых настила».
fn adjective() -> &'static Regex {
    re!(r"\p{L}{2,}(?:ых|их|ые|ие|ый|ий|ой|ая|яя|ое|ее|ую|юю|ого|его|ому|ему|ым|им)$", "u")
}

/// `String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').toLocaleLowerCase('ru')`.
fn clean(value: Option<&Value>) -> String {
    clean_str(&str_of(value))
}

fn clean_str(value: &str) -> String {
    text::lower(&text::replace_all(re!(r"\s+", "gu"), &text::nfkc(value), " "))
}

/// `String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, 120)`.
fn clean_name(value: Option<&Value>) -> String {
    let spaced = text::replace_all(re!(r"\s+", "gu"), &str_of(value), " ");
    utf16_head(text::trim(&spaced), 120).to_string()
}

/// Количество из числительного прямо перед объектом; между ними допускаются
/// только прилагательные. «В двух шагах от колодца» — один колодец.
fn count_before(before: &str) -> f64 {
    let words: Vec<&str> = text::trim_end(before).split(' ').collect();
    let words = &words[words.len().saturating_sub(3)..];
    for raw in words.iter().rev() {
        // Конец фразы между числом и объектом разрывает связь.
        if text::test(re!(r"[.!?;:,—]$", "u"), raw) {
            return 1.0;
        }
        let word = text::replace_all(re!(r"[^\p{L}\d]", "gu"), raw, "");
        let digits = js::parse_number(&word);
        if text::test(re!(r"^\d{1,2}$", "u"), &word) && digits > 0.0 {
            return js_min(MAX_COUNT, digits);
        }
        if let Some(value) = numeral(&word) {
            return js_min(MAX_COUNT, value);
        }
        if !text::test(adjective(), &word) {
            return 1.0;
        }
    }
    1.0
}

/// Обещанный объект: вид и количество. Количество — число JS: из словаря
/// приходит целое (ключ прототипа числительным не считается); нечисло JSON
/// записал бы как `null`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Requirement {
    pub id: String,
    #[serde(serialize_with = "crate::util::ser_js_number")]
    pub count: f64,
}

/// Обязательные объекты по словам сцены, в порядке первого упоминания.
///
/// `texts` — массив описаний или одно значение; учитываются только непустые
/// строки (секреты ведущего сюда не передаются).
pub fn scene_requirements_from_text(texts: &Value) -> Vec<Requirement> {
    let values: Vec<&Value> = match texts {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    requirements_from_strings(values.into_iter().filter_map(Value::as_str))
}

fn requirements_from_strings<'a>(texts: impl Iterator<Item = &'a str>) -> Vec<Requirement> {
    let joined = texts.filter(|value| !text::trim(value).is_empty()).map(clean_str).collect::<Vec<_>>().join(" . ");
    let source = utf16_head(&joined, 8000);
    if source.is_empty() {
        return Vec::new();
    }
    // (id, count, at): `at` — байтовый индекс, порядок тот же, что у индекса JS.
    let mut found: Vec<(&'static str, f64, usize)> = Vec::new();
    for kind in SCENE_REQUIREMENT_KINDS.iter() {
        if !kind.from_text {
            continue;
        }
        for matched in kind.pattern.find_iter(source) {
            let Ok(matched) = matched else { break };
            let at = matched.start();
            if at > 0 && letter_before(source, at) {
                continue;
            }
            let before = &source[utf16_back(source, at, 64)..at];
            if text::test(negation_before(), before) {
                continue;
            }
            let count = count_before(before);
            match found.iter_mut().find(|entry| entry.0 == kind.id) {
                Some(previous) => {
                    previous.1 = js_max(previous.1, count);
                    previous.2 = previous.2.min(at);
                }
                None => found.push((kind.id, js_max(1.0, count), at)),
            }
        }
    }
    found.sort_by(|left, right| left.2.cmp(&right.2).then_with(|| text::locale_compare(left.0, right.0)));
    found.into_iter().take(MAX_ITEMS).map(|(id, count, _)| Requirement { id: id.to_string(), count }).collect()
}

/// Якорь из заявки картографа (`map.design.landmarks`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Landmark {
    pub id: String,
    pub role: String,
    pub count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub npc: Option<String>,
}

/// Пост жителя: имя и вид объекта, у которого он стоит.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScenePost {
    pub npc: String,
    pub id: String,
}

/// Программа сцены в `scene.map_requirements`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScenePlanProgram {
    pub version: String,
    pub items: Vec<Requirement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focus: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub posts: Vec<ScenePost>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub clues: Vec<String>,
}

impl ScenePlanProgram {
    /// Форма JSON, которую пишет JS.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// Рабочее место жителя: предмет из его описания, иначе — из роли, у главы
/// общины — центр сцены. `None` — поста нет.
fn post_kind_for(npc: &Value, focus: Option<&str>) -> Option<String> {
    let summary = str_of(npc.get("summary"));
    if let Some(own) = requirements_from_strings(std::iter::once(summary.as_str())).into_iter().next() {
        return Some(own.id);
    }
    let role = clean(npc.get("role"));
    for (pattern, kind) in role_kinds() {
        if text::test(pattern, &role) {
            return Some(kind.to_string());
        }
    }
    match focus {
        Some(focus) if !focus.is_empty() && text::test(leader_role(), &role) => Some(focus.to_string()),
        _ => None,
    }
}

/// Поле сцены со списком или `None`, когда обещать нечего.
///
/// `npcs` — жители, которые стоят в этой сцене; `landmarks` — якоря из заявки
/// картографа. Отсутствующий параметр — как пропущенное поле в JS.
pub fn scene_map_requirements_for(texts: &Value, npcs: Option<&Value>, landmarks: Option<&Value>) -> Option<ScenePlanProgram> {
    let mut items = scene_requirements_from_text(texts);
    let marks = normalize_landmarks(landmarks.unwrap_or(&Value::Null));
    for mark in &marks {
        if let Some(item) = items.iter_mut().find(|entry| entry.id == mark.id) {
            item.count = js_max(item.count, mark.count as f64);
        } else if items.len() < MAX_ITEMS {
            items.push(Requirement { id: mark.id.clone(), count: mark.count as f64 });
        }
    }
    let focus = marks
        .iter()
        .find(|mark| mark.role == "focus")
        .map(|mark| mark.id.clone())
        .or_else(|| items.iter().find(|item| FOCUS_KINDS.contains(&item.id.as_str())).map(|item| item.id.clone()));
    let empty = Vec::new();
    let residents = match npcs {
        Some(Value::Array(list)) => list,
        _ => &empty,
    };
    let visible: Vec<(&Value, String)> =
        residents.iter().map(|npc| (npc, clean_name(npc.get("name")))).filter(|(_, name)| !name.is_empty()).collect();
    let mut posts: Vec<ScenePost> = Vec::new();
    for mark in &marks {
        let Some(npc) = mark.npc.as_deref().filter(|npc| mark.role == "npc_post" && !npc.is_empty()) else { continue };
        let wanted = text::lower(npc);
        let resident = visible.iter().find(|(_, name)| text::lower(name) == wanted);
        if let Some((_, name)) = resident {
            if !posts.iter().any(|post| &post.npc == name) {
                posts.push(ScenePost { npc: name.clone(), id: mark.id.clone() });
            }
        }
    }
    for (npc, name) in &visible {
        if posts.iter().any(|post| &post.npc == name) {
            continue;
        }
        let Some(kind) = post_kind_for(npc, focus.as_deref()) else { continue };
        posts.push(ScenePost { npc: name.clone(), id: kind.clone() });
        if !items.iter().any(|item| item.id == kind) && items.len() < MAX_ITEMS {
            items.push(Requirement { id: kind, count: 1.0 });
        }
    }
    let mut clues: Vec<String> = Vec::new();
    for mark in marks.iter().filter(|mark| mark.role == "clue") {
        if !clues.contains(&mark.id) {
            clues.push(mark.id.clone());
        }
    }
    if items.is_empty() {
        return None;
    }
    Some(ScenePlanProgram { version: SCENE_REQUIREMENTS_VERSION.to_string(), items, focus, posts, clues })
}

/// Якоря из заявки картографа. Неизвестный вид, роль вне перечня и мусор
/// отбрасываются; примечание модели не хранится.
pub fn normalize_landmarks(value: &Value) -> Vec<Landmark> {
    let mut result: Vec<Landmark> = Vec::new();
    let Value::Array(entries) = value else { return result };
    for entry in entries {
        if result.len() >= MAX_LANDMARKS {
            break;
        }
        // Нормализованный якорь хранит вид в `id`: замысел первой карты
        // нормализуется ещё раз в программе сцены.
        let id = str_of(nullish(entry.get("kind"), entry.get("id")));
        if kind_by_id(&id).is_none() || result.iter().any(|mark| mark.id == id) {
            continue;
        }
        let role = match entry.get("role").and_then(Value::as_str) {
            Some(role) if LANDMARK_ROLES.contains(&role) => role.to_string(),
            _ => "dressing".to_string(),
        };
        let count = js::number(entry.get("count"));
        let npc = if role == "npc_post" { clean_name(entry.get("npc")) } else { String::new() };
        let safe = count.is_finite() && count.fract() == 0.0 && count.abs() <= 9_007_199_254_740_991.0;
        result.push(Landmark {
            id,
            role,
            count: if safe && count > 0.0 { js_min(MAX_COUNT, count) as i64 } else { 1 },
            npc: (!npc.is_empty()).then_some(npc),
        });
    }
    result
}

/// Обязательные виды программы: центр, посты жителей и улики.
pub fn required_program_kinds(program: &Value) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    if program.is_object() || program.is_array() {
        ids.push(str_of(program.get("focus")));
        ids.extend(normalize_scene_posts(program).into_iter().map(|post| post.id));
        if let Some(Value::Array(clues)) = program.get("clues") {
            ids.extend(clues.iter().map(|id| str_of(Some(id))));
        }
    } else {
        ids.push(String::new());
    }
    let mut result: Vec<String> = Vec::new();
    for id in ids {
        if kind_by_id(&id).is_some() && !result.contains(&id) {
            result.push(id);
        }
    }
    result
}

/// Упоминает ли текст объект этого вида — тем же словарём; отрицание рядом
/// («без навеса») упоминанием не считается. Возвращает найденное слово или
/// пустую строку.
pub fn requirement_mention(text_value: Option<&Value>, id: &str) -> String {
    let kind = kind_by_id(id);
    let source = clean(text_value);
    let Some(kind) = kind.filter(|_| !source.is_empty()) else { return String::new() };
    for matched in kind.pattern.find_iter(&source) {
        let Ok(matched) = matched else { break };
        let at = matched.start();
        if at > 0 && letter_before(&source, at) {
            continue;
        }
        if text::test(negation_before(), &source[utf16_back(&source, at, 64)..at]) {
            continue;
        }
        return matched.as_str().to_string();
    }
    String::new()
}

/// Сумма `Number(props[assetId]) || 0` по предметам вида.
fn assets_count(kind: &RequirementKind, props: Option<&Value>) -> f64 {
    kind.assets.iter().fold(0.0, |sum, asset_id| sum + number_or_zero(field(props, asset_id)))
}

/// Паспорт якорей карты: сколько объектов каждого вида словаря на ней есть
/// (`props` — счётчик `assetId → штук`, `terrain` — `platform → штук`).
/// В ответе только виды, что есть на карте.
pub fn anchor_counts_for(props: Option<&Value>, terrain: Option<&Value>) -> Value {
    let mut result = Map::new();
    for kind in SCENE_REQUIREMENT_KINDS.iter() {
        let count = match kind.terrain {
            Some(cells) => number_or_zero(field(terrain, cells)),
            None => assets_count(kind, props),
        };
        if count > 0.0 {
            result.insert(kind.id.to_string(), js::num(count));
        }
    }
    Value::Object(result)
}

/// Что выполнено и что нет.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Coverage {
    pub met: Vec<String>,
    pub missing: Vec<String>,
}

/// Что из обещанного держит карта по её паспорту якорей.
pub fn anchor_coverage(requirements: &[Requirement], anchors: Option<&Value>) -> Coverage {
    let mut coverage = Coverage::default();
    for requirement in requirements {
        if number_or_zero(field(anchors, &requirement.id)) >= js_max(1.0, requirement.count) {
            coverage.met.push(requirement.id.clone());
        } else {
            coverage.missing.push(requirement.id.clone());
        }
    }
    coverage
}

/// Каким клеточным объектом воплощается вид: настил — приподнятым полом.
pub fn requirement_terrain(id: &str) -> Option<&'static str> {
    kind_by_id(id).and_then(|kind| kind.terrain)
}

/// Посты жителей из сохранённой сцены; v1 и мусор дают пустой список.
pub fn normalize_scene_posts(value: &Value) -> Vec<ScenePost> {
    let mut result: Vec<ScenePost> = Vec::new();
    let Some(Value::Array(posts)) = value.get("posts") else { return result };
    for post in posts {
        let npc = clean_name(post.get("npc"));
        let id = str_of(post.get("id"));
        if npc.is_empty() || kind_by_id(&id).is_none() || result.iter().any(|entry| entry.npc == npc) {
            continue;
        }
        result.push(ScenePost { npc, id });
        if result.len() >= MAX_ITEMS {
            break;
        }
    }
    result
}

/// Список из сохранённой сцены: незнакомые виды и мусор отбрасываются.
pub fn normalize_scene_requirements(value: &Value) -> Vec<Requirement> {
    let items: &[Value] = match value {
        Value::Array(items) => items,
        Value::Object(map) => match map.get("items") {
            Some(Value::Array(items)) => items,
            _ => &[],
        },
        _ => &[],
    };
    let mut result: Vec<Requirement> = Vec::new();
    for item in items {
        let id = str_of(item.get("id"));
        if kind_by_id(&id).is_none() || result.iter().any(|entry| entry.id == id) {
            continue;
        }
        let count = js::number(item.get("count"));
        let safe = count.is_finite() && count.fract() == 0.0 && count.abs() <= 9_007_199_254_740_991.0;
        result.push(Requirement { id, count: if safe && count > 0.0 { js_min(MAX_COUNT, count) } else { 1.0 } });
        if result.len() >= MAX_ITEMS {
            break;
        }
    }
    result
}

/// Предметы реестра, которыми воплощается вид объекта.
pub fn requirement_assets(id: &str) -> Vec<&'static str> {
    kind_by_id(id).map(|kind| kind.assets.to_vec()).unwrap_or_default()
}

/// Подпись вида объекта по-русски; знает и постройки (`SCENE_STRUCTURE_KINDS`).
pub fn requirement_label(id: &str) -> String {
    kind_by_id(id)
        .map(|kind| kind.label)
        .or_else(|| structure_by_id(id).map(|kind| kind.label))
        .unwrap_or(id)
        .to_string()
}

// ---------------------------------------------------------------------------
// Постройки и местность в строках перехода
// ---------------------------------------------------------------------------

/// Постройка или местность в строках перехода.
#[derive(Debug)]
pub struct StructureKind {
    pub id: &'static str,
    pub label: &'static str,
    pub source: &'static str,
    pub pattern: Regex,
    /// Постройка, которую может называть само имя места.
    pub building: bool,
    /// Законно встречается по дороге и в строке пути не проверяется.
    pub journey: bool,
}

const STRUCTURE_TABLE: [(&str, &str, &str, bool, bool); 8] = [
    ("lighthouse", "маяк", r"маяк(?:а|у|ом|е|и|ов|ам|ами|ах)?(?!\p{L})", true, false),
    ("tower", "башня", r"башн(?:я|и|е|ю|ей|ею|ям|ями|ях)(?!\p{L})", true, false),
    ("tavern", "таверна", r"(?:таверн|трактир|корчм|харчевн)\p{L}*|постоял\p{L}*\s+двор\p{L}*", true, false),
    ("temple", "храм", r"(?:храм|святилищ|собор)(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?!\p{L})", true, false),
    ("door", "дверь", r"двер(?:ь|и|ью|ей|ям|ями|ях)(?!\p{L})", false, false),
    ("bridge", "мост", r"мост(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?!\p{L})", false, true),
    ("river", "река", r"рек(?:а|и|е|у|ой|ою)(?!\p{L})|речк\p{L}*", false, true),
    ("boat", "лодка", r"(?:лодк|баркас|шлюпк|ялик)\p{L}*|чел(?:н|ён|ен)(?:а|у|ом|е|ы|ов)?(?!\p{L})", false, true),
];

/// Постройки и местность, которые архитектор называет в строках перехода
/// (`arrival`, `transition`). Словарь отдельный от предметов сцены.
pub static SCENE_STRUCTURE_KINDS: LazyLock<Vec<StructureKind>> = LazyLock::new(|| {
    STRUCTURE_TABLE
        .iter()
        .map(|&(id, label, source, building, journey)| StructureKind { id, label, source, pattern: compile(source), building, journey })
        .collect()
});

fn structure_by_id(id: &str) -> Option<&'static StructureKind> {
    SCENE_STRUCTURE_KINDS.iter().find(|kind| kind.id == id)
}

/// `new RegExp('(?<!\\p{L})(?:' + kind.pattern.source + ')', 'u')`.
fn named_structure_patterns() -> &'static [Regex] {
    static NAMED: LazyLock<Vec<Regex>> =
        LazyLock::new(|| SCENE_STRUCTURE_KINDS.iter().map(|kind| compile(&format!(r"(?<!\p{{L}})(?:{})", kind.source))).collect());
    &NAMED
}

/// Стоит ли постройка или местность на карте. `facts` — то, что о постройках
/// знает карта (`theme`, `zones`, `doors`, `props`, `water`), `location` — имя места.
pub fn structure_present(id: &str, facts: &Value, location: &str) -> bool {
    let empty = Vec::new();
    let zones = match facts.get("zones") {
        Some(Value::Array(zones)) => zones,
        _ => &empty,
    };
    let labels: Vec<String> = zones.iter().map(|zone| clean(zone.get("label"))).collect();
    let interior: Vec<String> = zones
        .iter()
        .filter(|zone| zone.get("kind").and_then(Value::as_str) == Some("interior") && !clean(zone.get("label")).is_empty())
        .map(|zone| clean(zone.get("label")))
        .collect();
    let place = clean_str(location);
    let theme = str_of(facts.get("theme"));
    let building = !interior.is_empty() && (theme == "building" || theme == "temple");
    let props = match facts.get("props") {
        Some(Value::Array(props)) => props,
        _ => &empty,
    };
    let any_label = |pattern: &Regex| labels.iter().any(|label| text::test(pattern, label));
    let any_interior = |pattern: &Regex| interior.iter().any(|label| text::test(pattern, label));
    match id {
        "lighthouse" => any_label(re!(r"маяк|маяч", "u")) || (building && text::test(re!(r"маяк", "u"), &place)),
        "tower" => any_label(re!(r"башн|маяк|маяч", "u")) || (building && text::test(re!(r"башн|маяк", "u"), &place)),
        "tavern" => any_interior(re!(r"таверн|трактир|постоял|питейн|гостев|корчм|харчевн|общий зал", "u")),
        "temple" => theme == "temple" || any_interior(re!(r"храм|неф|притвор|алтарн|святилищ|часовн|собор", "u")),
        "door" => js::number(facts.get("doors")) > 0.0,
        "bridge" => any_label(re!(r"мост|рек", "u")),
        "river" => any_label(re!(r"рек|ручей|ручь", "u")) || js::is_true(facts.get("water")),
        "boat" => props.iter().any(|asset_id| text::test(re!(r"boat|ship|raft", "u"), &js_string(Some(asset_id)))),
        _ => true,
    }
}

/// Вдали, за краем карты: «вдали белеет маяк» карте не противоречит.
fn far_context() -> &'static Regex {
    re!(r"(?<!\p{L})(?:вдал\p{L}*|вдалек\p{L}*|на\s+горизонт\p{L}*|далеко|издалека|издали|за\s+(?:морем|холмами|рекой|лесом|горами|перевалом|заливом))(?!\p{L})", "u")
}

/// Строка пути говорит о месте прибытия, а не о дороге: «входят», «перед героями».
fn arrival_cue() -> &'static Regex {
    re!(r"(?<!\p{L})(?:вход\p{L}*|вош\p{L}*|заход\p{L}*|заш\p{L}*|внутр\p{L}*|прибыва\p{L}*|прибыл\p{L}*|оказыва\p{L}*|оказал\p{L}*|встреча\p{L}*|перед\s+(?:ними|героями|отрядом)|открыва\p{L}*)(?!\p{L})", "u")
}

/// …а не об оставленном месте: «покидают таверну».
fn departure_cue() -> &'static Regex {
    re!(r"(?<!\p{L})(?:покида\p{L}*|покинул\p{L}*|оставля\p{L}*|оставил\p{L}*|выход\p{L}*|вышл\p{L}*|выш[её]л|уход\p{L}*|ушл\p{L}*|уш[её]л|отступа\p{L}*|из\s+(?:таверн|трактир|храм|башн|дом))(?!\p{L})", "u")
}

/// «Двери нет», «моста не видно».
fn negated_after() -> &'static Regex {
    re!(r"^\s*(?:,\s*)?(?:нет|не\s+(?:было|видно|видать|осталось))(?!\p{L})", "u")
}

/// Строка перехода без фраз о постройках, которых нет на карте.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TextAgainstMap {
    pub text: String,
    /// id отсутствующих построек, без повторов.
    pub dropped: Vec<String>,
}

/// Строка перехода без фраз о постройках, которых нет на карте. Фраза
/// выбрасывается целиком. Имя места и названия в кавычках постройкой не
/// считаются. `journey` — строка пути: проверяются только фразы о прибытии и
/// только постройки.
pub fn text_against_map(value: Option<&Value>, facts: &Value, location: &str, journey: bool) -> TextAgainstMap {
    let spaced = text::replace_all(re!(r"\s+", "gu"), &str_of(value), " ");
    let source = text::trim(&spaced);
    if source.is_empty() {
        return TextAgainstMap { text: String::new(), dropped: Vec::new() };
    }
    let place_clean = text::replace_all(re!(r#"[«»"„“”]"#, "gu"), &clean_str(location), "");
    let place = text::trim(&place_clean);
    let mut dropped: Vec<String> = Vec::new();
    let mut kept: Vec<&str> = Vec::new();
    for sentence in split_regex(re!(r"(?<=[.!?…])\s+", "u"), source) {
        let mut probe = text::replace_all(re!(r#"«[^»]{0,160}»|“[^”]{0,160}”|"[^"]{0,160}""#, "gu"), &clean_str(sentence), " ");
        if !place.is_empty() {
            probe = probe.replace(place, " ");
        }
        let skip = text::test(far_context(), &probe)
            || (journey && (!text::test(arrival_cue(), &probe) || text::test(departure_cue(), &probe)));
        let absent = if skip {
            ""
        } else {
            SCENE_STRUCTURE_KINDS
                .iter()
                .find(|kind| {
                    if journey && kind.journey {
                        return false;
                    }
                    for matched in kind.pattern.find_iter(&probe) {
                        let Ok(matched) = matched else { break };
                        let at = matched.start();
                        if at > 0 && letter_before(&probe, at) {
                            continue;
                        }
                        if text::test(negation_before(), &probe[utf16_back(&probe, at, 64)..at]) {
                            continue;
                        }
                        if text::test(negated_after(), &probe[matched.end()..]) {
                            continue;
                        }
                        return !structure_present(kind.id, facts, location);
                    }
                    false
                })
                .map(|kind| kind.id)
                .unwrap_or("")
        };
        if absent.is_empty() {
            kept.push(sentence);
        } else {
            dropped.push(absent.to_string());
        }
    }
    let mut unique: Vec<String> = Vec::new();
    for id in dropped {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    TextAgainstMap { text: kept.join(" "), dropped: unique }
}

/// Постройка, которую называет имя места, а карта не построила: «Старый
/// маяк» без единого помещения. Пустая строка — имя постройки не называет или
/// карта её держит.
pub fn missing_structure_for(location: &str, facts: &Value) -> String {
    let place = text::replace_all(re!(r#"[«»"„“”]"#, "gu"), &clean_str(location), " ");
    let named = SCENE_STRUCTURE_KINDS
        .iter()
        .zip(named_structure_patterns())
        .find(|(kind, pattern)| kind.building && text::test(pattern, &place))
        .map(|(kind, _)| kind);
    let Some(named) = named else { return String::new() };
    let has_interior = match facts.get("zones") {
        Some(Value::Array(zones)) => zones
            .iter()
            .any(|zone| zone.get("kind").and_then(Value::as_str) == Some("interior") && !clean(zone.get("label")).is_empty()),
        _ => false,
    };
    if has_interior || structure_present(named.id, facts, location) {
        String::new()
    } else {
        named.id.to_string()
    }
}

/// Какие обещания карта выполняет по счётчику своих предметов (`props`) и
/// клеточных объектов (`terrain`). Количество сверяется.
pub fn requirements_coverage(requirements: &[Requirement], props: Option<&Value>, terrain: Option<&Value>) -> Coverage {
    let mut coverage = Coverage::default();
    for requirement in requirements {
        let have = match kind_by_id(&requirement.id) {
            Some(kind) => match kind.terrain {
                Some(cells) => number_or_zero(field(terrain, cells)),
                None => assets_count(kind, props),
            },
            None => 0.0,
        };
        if have >= js_max(1.0, requirement.count) {
            coverage.met.push(requirement.id.clone());
        } else {
            coverage.missing.push(requirement.id.clone());
        }
    }
    coverage
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_has_every_kind_once() {
        assert_eq!(SCENE_REQUIREMENT_KINDS.len(), 30);
        let mut ids: Vec<&str> = SCENE_REQUIREMENT_KINDS.iter().map(|kind| kind.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 30);
    }

    #[test]
    fn prototype_numeral_is_not_a_number_word() {
        // Ключ прототипа числительным не считается: количество по умолчанию.
        let items = scene_requirements_from_text(&Value::String("constructor навес".into()));
        assert_eq!(items.len(), 1);
        assert_eq!(serde_json::to_value(&items[0]).expect("json"), serde_json::json!({ "id": "shelter", "count": 1 }));
    }
}

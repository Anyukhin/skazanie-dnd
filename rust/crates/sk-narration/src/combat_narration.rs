//! Перенос `server/combat-narration.mjs`: боевой текст для ленты — удары,
//! состояния, спасброски, ход времени, жизнь стола (кости, молитва, пленные,
//! звери).
//!
//! Сюда приходят **сырые** committed events, а не проекция: всё, что
//! принадлежит врагу, закрывается здесь вручную (`target_is_enemy`). Выбор
//! формулировки детерминирован зерном события (`sk_narration_base::combat_phrases`),
//! и порядок вызовов книги фраз повторяет JS шаг в шаг — от него зависит, какой
//! вариант выпадет соседней строке.
//!
//! Рассказчик следует контракту `deterministic-narration`, но в реестр
//! **намеренно не входит** (AGENTS.md §4): маршруты зовут его напрямую.
//!
//! На мусоре старых сохранений JS бросает `TypeError` (`null` в списке событий
//! или героев, строка вместо массива укрытий); здесь это [`JsTypeError`].

use std::collections::HashSet;
use std::sync::{Arc, LazyLock};

use serde_json::{Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{js, re, text};
use sk_narration_base::combat_phrases::{
    action_phrase, attack_phrase, confident_accusative, damage_phrase, downed_phrase, encounter_end_phrase, encounter_intro_phrase, hours_label_ru,
    join_ru, lower_first, move_phrase, save_phrase, spell_source_text, stabilized_phrase, tactic_lead, turn_end_phrase, turn_start_phrase,
    AttackPhraseInput, Phrasebook,
};
use sk_narration_base::concentration_end_reasons::concentration_end_reason_label_str;
use sk_narration_base::deterministic_narration::{DeterministicNarrator, SharedNarrator, NARRATOR_PRIORITY};
use sk_npc_world::blessings::BLESSING_CONDITION;
use sk_world_time::weather::{elapsed_minutes_of, time_of_day_of, world_clock_narration, TIME_OF_DAY_CHANGED_EVENT, UNDERGROUND_SCENE_THEMES, WORLD_CLOCK_EVENT_TYPES};

use crate::jsv::{
    array_or_empty, clean_text, coalesce, get, index0, is_str, mappable, max, n, nn, num_or, num_or0, own_lookup, path, slice_utf16, str_or_empty, table_lookup,
    text_or, text_or2, JsResult, JsTypeError,
};

/// Склонение имени живёт в словаре реплик; запасной рассказчик и тесты берут его отсюда.
pub use sk_narration_base::combat_phrases::accusative_name;

// ---------------------------------------------------------------------------
// Участники
// ---------------------------------------------------------------------------

/// Кандидат `[...players, ...enemies, ...actors]`: значение списка или символ
/// строки (разворот строки даёт символы, у которых полей нет).
enum Candidate<'a> {
    Value(&'a Value),
    Char,
}

/// `[...(list ?? [])]`: не-итерируемое значение — `TypeError`.
fn spread<'a>(value: Option<&'a Value>, out: &mut Vec<Candidate<'a>>) -> JsResult<()> {
    match value {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Array(items)) => {
            out.extend(items.iter().map(Candidate::Value));
            Ok(())
        }
        Some(Value::String(text)) => {
            out.extend(text.chars().map(|_| Candidate::Char));
            Ok(())
        }
        Some(_) => Err(JsTypeError("[...list] is not iterable")),
    }
}

/// `String(candidate.id ?? candidate.actor_id ?? '')`.
fn actor_key(candidate: &Value) -> String {
    js::s(coalesce(get(Some(candidate), "id"), get(Some(candidate), "actor_id")))
}

fn tactical_actor_name(state: &Value, id: Option<&Value>) -> JsResult<String> {
    let expected = str_or_empty(id);
    let mut candidates = Vec::new();
    spread(get(Some(state), "players"), &mut candidates)?;
    spread(get(Some(state), "enemies"), &mut candidates)?;
    spread(get(Some(state), "actors"), &mut candidates)?;
    let mut found: Option<&Value> = None;
    for candidate in candidates {
        match candidate {
            Candidate::Value(Value::Null) => return Err(JsTypeError("candidate.id of null")),
            Candidate::Value(value) => {
                if actor_key(value) == expected {
                    found = Some(value);
                    break;
                }
            }
            Candidate::Char => {
                if expected.is_empty() {
                    break;
                }
            }
        }
    }
    let character = get(found, "character");
    if js::truthy(character) {
        return Ok(js::s(character));
    }
    let name = get(found, "name");
    if js::truthy(name) {
        return Ok(js::s(name));
    }
    Ok(if expected.is_empty() { "Участник".to_string() } else { expected })
}

/// `(list ?? []).some(predicate)` с `TypeError` у не-массива и у `null` внутри.
fn some_actor(list: Option<&Value>, predicate: impl Fn(&Value) -> bool) -> JsResult<bool> {
    match list {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Array(items)) => {
            for item in items {
                if item.is_null() {
                    return Err(JsTypeError("candidate.id of null"));
                }
                if predicate(item) {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Some(_) => Err(JsTypeError("list.some is not a function")),
    }
}

fn tactical_actor_is_enemy(state: &Value, id: Option<&Value>) -> JsResult<bool> {
    let expected = str_or_empty(id);
    some_actor(get(Some(state), "enemies"), |candidate| actor_key(candidate) == expected)
}

/// Герой отряда — тот, кто на нуле бросает спасброски от смерти.
fn tactical_actor_is_hero(state: &Value, id: Option<&Value>) -> JsResult<bool> {
    let expected = str_or_empty(id);
    if expected.is_empty() {
        return Ok(false);
    }
    some_actor(get(Some(state), "players"), |candidate| actor_key(candidate) == expected)
}

/// Выбывший противник: место в инициативе за ним остаётся, но рассказывать о
/// его ходе нечего. Герой на нуле не выбывший: его ход — спасбросок от смерти.
fn defeated_enemy(state: &Value, id: Option<&Value>) -> JsResult<bool> {
    let expected = str_or_empty(id);
    let enemy = match get(Some(state), "enemies") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => {
            let mut found = None;
            for item in items {
                if item.is_null() {
                    return Err(JsTypeError("candidate.id of null"));
                }
                if js::s(get(Some(item), "id")) == expected {
                    found = Some(item);
                    break;
                }
            }
            found
        }
        Some(_) => return Err(JsTypeError("enemies.find is not a function")),
    };
    Ok(js::truthy(enemy) && js::number(get(enemy, "hp")) <= 0.0)
}

// ---------------------------------------------------------------------------
// Конец боя и награда
// ---------------------------------------------------------------------------

/// Причина конца боя словами стола; незнакомый служебный код не печатается.
const ENCOUNTER_END_TEXT: [(&str, &str); 9] = [
    ("resolved", "исход подтверждён"),
    ("victory", "победа"),
    ("enemies_defeated", "противники повержены"),
    ("party_defeated", "отряд пал"),
    ("party_incapacitated", "отряд не может продолжать бой"),
    ("surrendered", "противник сдался"),
    ("truce", "стороны заключили перемирие"),
    ("parley", "стороны договорились"),
    ("fled", "противник бежал"),
];

/// `encounterEndText(reason)`: служебный код — русской фразой; свободный
/// русский текст ведущего проходит как есть (до 120 единиц UTF-16).
pub fn encounter_end_text(reason: Option<&Value>) -> String {
    let source = js::s(reason);
    let code = text::trim(&source);
    if let Some(label) = own_lookup(&ENCOUNTER_END_TEXT, code) {
        return label.to_string();
    }
    if text::test(re!(r"[а-яё]", "iu"), code) && !text::test(re!(r"[a-z]", "iu"), code) {
        slice_utf16(code, 120)
    } else {
        "исход подтверждён".to_string()
    }
}

/// Длительности политики `post_encounter_recovery`.
const POST_VICTORY_REST_MINUTES: f64 = 480.0;
/// Привал после победы — только по заявке игроков (решение владельца 2026-10-10).
const POST_VICTORY_REST_DISABLED: bool = true;
const POST_VICTORY_STABLE_RECOVERY_MINUTES: f64 = 240.0;

/// Причины `DowntimeResolved`, которые пишет политика `post_encounter_recovery`.
const POST_VICTORY_DOWNTIME_REASONS: [&str; 3] = ["post_encounter_recovery", "post_encounter_recovery_after_stabilisation", "post_defeat_recovery"];

fn is_post_victory_reason(reason: Option<&Value>) -> bool {
    POST_VICTORY_DOWNTIME_REASONS.contains(&js::s(reason).as_str())
}

/// Сколько минут отряд проведёт в отдыхе после этой победы; 0 — отдыха не
/// будет. С 2026-10-10 привал после победы отключён, и функция всегда даёт 0
/// (как в JS, остальная ветка не исполняется).
fn post_victory_rest_minutes(state: &Value, outcome: Option<&Value>) -> f64 {
    if POST_VICTORY_REST_DISABLED || js::s(outcome) != "enemies_defeated" {
        return 0.0;
    }
    let party: HashSet<String> = array_or_empty(get(Some(state), "partyMemberIds")).iter().map(|id| js::string(Some(id))).collect();
    let survivors: Vec<&Value> = array_or_empty(get(Some(state), "players"))
        .iter()
        .filter(|hero| {
            let id = get(Some(hero), "id");
            party.contains(&js::s(id))
                && !is_str(path(Some(state), &["mechanics", "death", "heroes"]).and_then(|heroes| get(Some(heroes), &js::string(id))).and_then(|entry| get(Some(entry), "status")), "dead")
        })
        .collect();
    if !survivors.iter().any(|hero| js::number(get(Some(hero), "hp")) > 0.0) {
        return 0.0;
    }
    POST_VICTORY_REST_MINUTES + if survivors.iter().any(|hero| js::number(get(Some(hero), "hp")) == 0.0) { POST_VICTORY_STABLE_RECOVERY_MINUTES } else { 0.0 }
}

/// 1 медяк, 2 медяка, 5 медяков.
fn coin_word_ru(count: f64, [one, few, many]: [&str; 3]) -> String {
    let tens = count % 100.0;
    let units = count % 10.0;
    let word = if (11.0..=14.0).contains(&tens) {
        many
    } else if units == 1.0 {
        one
    } else if (2.0..=4.0).contains(&units) {
        few
    } else {
        many
    };
    format!("{} {word}", n(count))
}

/// «2 золотых и 9 медяков».
fn coins_label_ru(value: f64) -> String {
    let start = if value == 0.0 || value.is_nan() { 0.0 } else { value };
    let mut copper = max(0.0, start.trunc());
    let gold = (copper / 100.0).floor();
    copper -= gold * 100.0;
    let silver = (copper / 10.0).floor();
    copper -= silver * 10.0;
    let truthy = |value: f64| value != 0.0 && !value.is_nan();
    let parts: Vec<String> = [
        if truthy(gold) { coin_word_ru(gold, ["золотой", "золотых", "золотых"]) } else { String::new() },
        if truthy(silver) { coin_word_ru(silver, ["серебряк", "серебряка", "серебряков"]) } else { String::new() },
        if truthy(copper) { coin_word_ru(copper, ["медяк", "медяка", "медяков"]) } else { String::new() },
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect();
    join_ru(&parts)
}

/// «Короткий лук», «Кинжал» (2 шт.) — одноимённые экземпляры склеиваются.
fn reward_items_list(items: Option<&Value>) -> Vec<String> {
    let mut counts: IndexMap<String, f64> = IndexMap::new();
    for item in array_or_empty(items) {
        let name = clean_text(get(Some(item), "name"), 80);
        if name.is_empty() {
            continue;
        }
        let quantity = max(1.0, num_or(get(Some(item), "quantity"), 1.0).trunc());
        *counts.entry(name).or_insert(0.0) += quantity;
    }
    counts.into_iter().map(|(name, count)| if count > 1.0 { format!("«{name}» ({} шт.)", n(count)) } else { format!("«{name}»") }).collect()
}

/// Сводка награды встречи по `EncounterRewardsDistributed`: кому какие вещи,
/// сколько монет и опыта — только из payload события.
fn encounter_reward_line(payload: &Value, state: &Value, book: &mut Phrasebook, event: &Value) -> JsResult<String> {
    let allocations = array_or_empty(get(Some(payload), "allocations"));
    let mut shares = Vec::new();
    for allocation in allocations {
        let items = reward_items_list(get(Some(allocation), "items"));
        if !items.is_empty() {
            shares.push((tactical_actor_name(state, get(Some(allocation), "recipient_id"))?, join_ru(&items)));
        }
    }
    let mut parts = Vec::new();
    if let Some(((first_name, first_items), rest)) = shares.split_first() {
        let mut line = vec![format!("{first_name} забирает {first_items}")];
        line.extend(rest.iter().map(|(name, items)| format!("{name} — {items}")));
        parts.push(line.join("; "));
    }
    let several = allocations.len() > 1;
    let coins = coins_label_ru(allocations.iter().fold(0.0, |sum, allocation| sum + max(0.0, num_or0(get(Some(allocation), "coins_cp")))));
    if !coins.is_empty() {
        parts.push(format!("в кошелях набралось {coins}{}", if several { " — на всех поровну" } else { "" }));
    }
    let xp_shares: Vec<f64> = allocations.iter().map(|allocation| max(0.0, num_or0(get(Some(allocation), "xp")).trunc())).collect();
    let xp = xp_shares.iter().fold(0.0, |sum, value| sum + value);
    if xp != 0.0 {
        parts.push(if several && xp_shares.iter().all(|value| *value == xp_shares[0]) { format!("опыта — по {} каждому", n(xp_shares[0])) } else { format!("опыта — {}", n(xp)) });
    }
    let leftover = join_ru(&reward_items_list(path(Some(payload), &["unassigned", "items"])));
    if !leftover.is_empty() {
        parts.push(format!("всё унести не выходит, пришлось оставить: {leftover}"));
    }
    if parts.is_empty() {
        return Ok(String::new());
    }
    let head = book.pick("reward", &["После схватки", "Когда всё стихает"], Some(event));
    Ok(format!("{head}: {}.", parts.join("; ")))
}

// ---------------------------------------------------------------------------
// Подписи
// ---------------------------------------------------------------------------

const COVER_SCENERY_LABELS: [(&str, &str); 16] = [
    ("altar", "алтарь"),
    ("barrel", "бочку"),
    ("bed", "кровать"),
    ("bookshelf", "шкаф"),
    ("bush", "куст"),
    ("chest", "сундук"),
    ("console", "пульт"),
    ("crate", "ящик"),
    ("fireplace", "очаг"),
    ("grave", "могилу"),
    ("pillar", "колонну"),
    ("rock", "камень"),
    ("statue", "статую"),
    ("table", "стол"),
    ("tree", "дерево"),
    ("well", "колодец"),
];

/// `id.toLowerCase().split(/[_\-\s]+/u)`.
fn split_scenery_parts(lower: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_separator = false;
    for ch in lower.chars() {
        if ch == '_' || ch == '-' || text::is_js_space(ch) {
            if !in_separator {
                parts.push(std::mem::take(&mut current));
                in_separator = true;
            }
        } else {
            in_separator = false;
            current.push(ch);
        }
    }
    parts.push(current);
    parts
}

/// Подпись укрытия по имени предмета карты: `tree_oak` — «дерево»; незнакомое
/// имя — «укрытие».
fn cover_scenery_label(feature: Option<&Value>) -> String {
    let id = js::s(feature);
    if let Some(label) = table_lookup(&COVER_SCENERY_LABELS, &id) {
        return label.to_string();
    }
    let lower = text::lower(&id);
    if let Some(label) = split_scenery_parts(&lower).iter().find_map(|part| table_lookup(&COVER_SCENERY_LABELS, part)) {
        return label.to_string();
    }
    if text::test(re!(r"[а-яё]", "iu"), &id) {
        id
    } else {
        "укрытие".to_string()
    }
}

const CONDITION_LABELS: [(&str, &str); 12] = [
    ("blinded", "ослеплена"),
    ("frightened", "испугана"),
    ("grappled", "схвачена"),
    ("incapacitated", "недееспособна"),
    ("invisible", "невидима"),
    ("paralyzed", "парализована"),
    ("petrified", "окаменела"),
    ("poisoned", "отравлена"),
    ("prone", "сбита с ног"),
    ("restrained", "опутана"),
    ("stunned", "оглушена"),
    ("unconscious", "без сознания"),
];

/// Названия состояний по книге — термином, без рода.
const MONSTER_HIT_CONDITION_TERMS: [(&str, &str); 8] = [
    ("blinded", "Ослеплённый"),
    ("frightened", "Испуганный"),
    ("grappled", "Схваченный"),
    ("paralyzed", "Парализованный"),
    ("poisoned", "Отравленный"),
    ("prone", "Лежащий ничком"),
    ("restrained", "Опутанный"),
    ("stunned", "Ошеломлённый"),
];

const ATTACKER_CONDITION_LABELS: [(&str, &str); 12] = [
    ("blinded", "ослеплён"),
    ("frightened", "испуган"),
    ("grappled", "схвачен"),
    ("incapacitated", "недееспособен"),
    ("invisible", "невидим"),
    ("paralyzed", "парализован"),
    ("petrified", "окаменел"),
    ("poisoned", "отравлен"),
    ("prone", "сбит с ног"),
    ("restrained", "опутан"),
    ("stunned", "оглушён"),
    ("unconscious", "без сознания"),
];

/// Названия видов урона в именительном падеже — для фразы «яд не действует».
const DAMAGE_TYPE_LABELS: [(&str, &str); 13] = [
    ("acid", "Кислота"),
    ("bludgeoning", "Дробящий удар"),
    ("cold", "Холод"),
    ("fire", "Огонь"),
    ("force", "Силовая волна"),
    ("lightning", "Молния"),
    ("necrotic", "Некротическая энергия"),
    ("piercing", "Колющий удар"),
    ("poison", "Яд"),
    ("psychic", "Психическая атака"),
    ("radiant", "Свет"),
    ("slashing", "Рубящий удар"),
    ("thunder", "Грохот"),
];

const REACTION_ACTION_LABELS: [(&str, &str); 5] = [
    ("opportunity-attack", "Атака по возможности"),
    ("readied-attack", "Подготовленная атака"),
    ("readied-spell", "Подготовленное заклинание"),
    ("cast:shield", "Щит"),
    ("uncanny-dodge", "Невероятное уклонение"),
];

/// `damageTypeLabel(damageType)`: вид урона по-русски или «Этот урон».
pub fn damage_type_label(damage_type: Option<&Value>) -> String {
    table_lookup(&DAMAGE_TYPE_LABELS, &text::lower(&js::s(damage_type))).unwrap_or("Этот урон").to_string()
}

fn has_cyrillic(value: &str) -> bool {
    text::test(re!(r"[А-ЯЁа-яё]", "u"), value)
}

/// Название заклинания в ёлочках или пусто, если имени нет ни в событии, ни в каталоге.
fn public_spell_label(payload: &Value) -> String {
    let source = js::s(coalesce(get(Some(payload), "spell_name"), get(Some(payload), "name")));
    let explicit = text::trim(&source);
    if !explicit.is_empty() && has_cyrillic(explicit) {
        return format!("«{explicit}»");
    }
    let catalog = sk_combat_content::combat_spells::canonical_combat_spell_for(get(Some(payload), "spell_id"), None);
    let name = get(catalog.as_ref(), "name");
    if js::truthy(name) {
        format!("«{}»", js::s(name))
    } else {
        String::new()
    }
}

fn reaction_action_label(payload: &Value) -> String {
    let mut values = vec![get(Some(payload), "name")];
    if let Some(Value::Array(options)) = get(Some(payload), "action_options") {
        values.extend(options.iter().map(|option| get(Some(option), "name")));
    }
    let explicit = values.into_iter().map(|value| text::trim(&js::s(value)).to_string()).find(|value| !value.is_empty() && has_cyrillic(value));
    if let Some(explicit) = explicit {
        return explicit;
    }
    table_lookup(&REACTION_ACTION_LABELS, &js::s(get(Some(payload), "action_id"))).unwrap_or("").to_string()
}

fn reaction_action_text(payload: &Value) -> String {
    let label = reaction_action_label(payload);
    if label.is_empty() {
        "реакцию".into()
    } else {
        format!("реакцию «{label}»")
    }
}

/// «реакцией «Щит»» — для «отвечает …».
fn reaction_instrumental_text(payload: &Value) -> String {
    let label = reaction_action_label(payload);
    if label.is_empty() {
        "реакцией".into()
    } else {
        format!("реакцией «{label}»")
    }
}

/// `(list ?? []).length > 0` для любого значения JSON.
fn length_positive(value: Option<&Value>) -> bool {
    match nn(value) {
        None => false,
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(text)) => !text.is_empty(),
        Some(object @ Value::Object(_)) => js::number(get(Some(object), "length")) > 0.0,
        Some(_) => false,
    }
}

/// `(list ?? []).length` как условие.
fn length_truthy(value: Option<&Value>) -> bool {
    match nn(value) {
        None => false,
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(text)) => !text.is_empty(),
        Some(object @ Value::Object(_)) => js::truthy(get(Some(object), "length")),
        Some(_) => false,
    }
}

/// Почему атака шла с преимуществом или помехой. Когда вклад есть у обеих
/// сторон, они взаимно гасятся, и называть любую — значит соврать.
fn attack_condition_reason(payload: &Value) -> JsResult<String> {
    let advantage = get(Some(payload), "condition_advantage");
    let disadvantage = get(Some(payload), "condition_disadvantage");
    if length_positive(advantage) == length_positive(disadvantage) {
        return Ok(String::new());
    }
    let with_advantage = length_truthy(advantage);
    let entries = if with_advantage { advantage } else { disadvantage };
    let entries = match nn(entries) {
        Some(Value::Array(items)) => items,
        _ => return Err(JsTypeError("entries.map is not a function")),
    };
    // Запись без двоеточия не называет ни стороны, ни состояния: её не
    // пересказываем (прежде в ленту уходило «атакующий undefined»).
    let described: Vec<String> = entries
        .iter()
        .filter_map(|entry| {
            let source = js::string(Some(entry));
            let mut pieces = source.split(':');
            let side = pieces.next().unwrap_or("");
            let key = pieces.next().filter(|condition| !condition.is_empty())?;
            Some(if side == "target" {
                format!("цель {}", table_lookup(&CONDITION_LABELS, key).unwrap_or(key))
            } else {
                format!("атакующий {}", table_lookup(&ATTACKER_CONDITION_LABELS, key).unwrap_or(key))
            })
        })
        .collect();
    if described.is_empty() {
        return Ok(String::new());
    }
    Ok(format!(" {} ({})", if with_advantage { "с преимуществом" } else { "с помехой" }, described.join(", ")))
}

// ---------------------------------------------------------------------------
// Части рассказа
// ---------------------------------------------------------------------------

/// Сколько строк уезжает в ленту за один ход.
const MAX_NARRATION_LINES: usize = 8;

/// Текст хода двумя частями: что сделал отряд (`main`) и что стало с небом (`sky`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NarrationParts {
    pub main: String,
    pub sky: String,
}

impl NarrationParts {
    /// Форма JS: `{ main, sky }`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("main".into(), Value::String(self.main.clone()));
        object.insert("sky".into(), Value::String(self.sky.clone()));
        Value::Object(object)
    }
}

/// `tacticalNarrationParts(events, state, options)`. `options.npcTurns` — ходы
/// существ из планировщика: их публичная тактика окрашивает перемещение и первую
/// атаку существа в этом ходе.
pub fn tactical_narration_parts(events: &[Value], state: &Value, options: Option<&Value>) -> JsResult<NarrationParts> {
    let (main, sky) = tactical_narration_lines(events, state, options)?;
    let sky_limit = MAX_NARRATION_LINES.saturating_sub(main.len());
    Ok(NarrationParts {
        main: main.iter().take(MAX_NARRATION_LINES).cloned().collect::<Vec<_>>().join(" "),
        sky: sky.iter().take(sky_limit).cloned().collect::<Vec<_>>().join(" "),
    })
}

/// События хода без неба: ровно то, что видит запасной рассказчик.
pub fn events_without_world_clock(events: &[Value]) -> Vec<Value> {
    events.iter().filter(|event| !is_world_clock(event)).cloned().collect()
}

fn is_world_clock(event: &Value) -> bool {
    get(Some(event), "event_type").and_then(Value::as_str).is_some_and(|kind| WORLD_CLOCK_EVENT_TYPES.contains(&kind))
}

fn is_additional_beam_spell_cast(event: &Value) -> bool {
    is_str(get(Some(event), "event_type"), "SpellCast")
        && js::is_false(path(Some(event), &["payload", "economy_consumed"]))
        && (text::test(re!(r"^spell-cast:.+:beam:\d+$", "u"), &js::s(get(Some(event), "event_id")))
            || text::test(re!(r":beam:\d+$", "u"), &js::s(get(Some(event), "command_id"))))
}

/// `tacticalNarrationOr(events, state, fallback, options)`: текст хода с
/// запасным вариантом. `fallback` зовут лишь тогда, когда боевому рассказчику
/// сказать про сам ход нечего, и отдают ему события без неба; его ответ — уже
/// `String(x ?? '')`.
pub fn tactical_narration_or<F>(events: &[Value], state: &Value, fallback: F, options: Option<&Value>) -> JsResult<String>
where
    F: FnOnce(&[Value]) -> String,
{
    let parts = tactical_narration_parts(events, state, options)?;
    let base = if parts.main.is_empty() { fallback(&events_without_world_clock(events)) } else { parts.main };
    Ok([base, parts.sky].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" "))
}

/// То же со строкой вместо функции.
pub fn tactical_narration_or_text(events: &[Value], state: &Value, fallback: &str, options: Option<&Value>) -> JsResult<String> {
    tactical_narration_or(events, state, |_| fallback.to_string(), options)
}

/// События, по которым строка летописи — строка боя.
const COMBAT_VOICE_EVENT_TYPES: [&str; 13] = [
    "AttackResolved",
    "AreaAttackResolved",
    "CombatStarted",
    "CombatEnded",
    "EncounterCreated",
    "EncounterEnded",
    "TurnStarted",
    "TurnEnded",
    "ReactionWindowOpened",
    "ReactionWindowClosed",
    "HitPointsReducedToZero",
    "DeathSavingThrowRolled",
    "LegendaryActionUsed",
];

/// Голос строки летописи.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JournalVoice {
    /// `system` или `narrator`.
    pub speaker: &'static str,
    pub author: &'static str,
}

impl JournalVoice {
    /// Форма JS: `{ speaker, author }`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("speaker".into(), Value::String(self.speaker.into()));
        object.insert("author".into(), Value::String(self.author.into()));
        Value::Object(object)
    }
}

/// `combatJournalVoice(events, state)`: «Система боя» — только в бою или когда
/// сам ход и есть бой; вне боя — «Рассказчик».
pub fn combat_journal_voice(events: &[Value], state: &Value) -> JournalVoice {
    let combat_line = js::truthy(path(Some(state), &["mechanics", "combat", "active"]))
        || events.iter().any(|event| COMBAT_VOICE_EVENT_TYPES.contains(&js::s(get(Some(event), "event_type")).as_str()));
    if combat_line {
        JournalVoice { speaker: "system", author: "Система боя" }
    } else {
        JournalVoice { speaker: "narrator", author: "Рассказчик" }
    }
}

/// Где искать находку у предмета и как его назвать в винительном.
const PROP_PHRASES: [(&str, &str, &str); 37] = [
    ("сундук", "Под крышкой сундука", "сундук"),
    ("бочка", "Под крышкой бочки", "бочку"),
    ("ящик", "В ящике", "ящик"),
    ("саркофаг", "Под крышкой саркофага", "саркофаг"),
    ("урна", "В урне", "урну"),
    ("ниша", "В нише", "нишу"),
    ("ковчег", "В ковчеге", "ковчег"),
    ("буфет", "В буфете", "буфет"),
    ("платяной шкаф", "В платяном шкафу", "платяной шкаф"),
    ("корзина", "В корзине", "корзину"),
    ("бочонок", "В бочонке", "бочонок"),
    ("могила", "В могиле", "могилу"),
    ("труп", "При теле", "тело"),
    ("кости", "Среди костей", "кости"),
    ("полка", "На полке", "полку"),
    ("стеллаж", "На стеллаже", "стеллаж"),
    ("телега", "В телеге", "телегу"),
    ("лоток", "На лотке", "лоток"),
    ("сено", "В сене", "сено"),
    ("стойка", "За стойкой", "стойку"),
    ("полка за стойкой", "На полке за стойкой", "полку за стойкой"),
    ("стол", "На столе", "стол"),
    ("алтарь", "На алтаре", "алтарь"),
    ("статуя", "У подножия статуи", "статую"),
    ("руна", "У руны", "руну"),
    ("святилище", "В святилище", "святилище"),
    ("королевский трон", "У трона", "трон"),
    ("завал", "Под завалом", "завал"),
    ("валун", "Под валуном", "валун"),
    ("пень", "У пня", "пень"),
    ("бревно", "Под бревном", "бревно"),
    ("верстовой столб", "У верстового столба", "верстовой столб"),
    ("колонна", "У колонны", "колонну"),
    ("жаровня", "У жаровни", "жаровню"),
    ("костёр", "У костра", "костёр"),
    ("люстра", "На люстре", "люстру"),
    ("сталагмит", "У сталагмита", "сталагмит"),
];

struct PropPhrase {
    inside: &'static str,
    accusative: &'static str,
    label: String,
}

fn scene_prop_phrase(state: &Value, prop_id: Option<&Value>) -> Option<PropPhrase> {
    let expected = js::s(prop_id);
    if expected.is_empty() {
        return None;
    }
    let props = array_or_empty(path(Some(state), &["scene", "map", "props"]));
    let prop = props.iter().find(|candidate| js::s(get(Some(candidate), "id")) == expected)?;
    // Подписи пропов — русские слова, ключей прототипа среди них нет.
    let label = text::lower(&sk_tactical::scene_interactions::scene_object_label_for(get(Some(prop), "assetId")));
    if label.is_empty() {
        return None;
    }
    PROP_PHRASES.iter().find(|(key, _, _)| *key == label).map(|(_, inside, accusative)| PropPhrase { inside, accusative, label })
}

fn loot_names(loot: Option<&Value>) -> Vec<String> {
    array_or_empty(loot).iter().map(|item| lower_first(&clean_text(get(Some(item), "name"), 120))).filter(|name| !name.is_empty()).collect()
}

fn event_type(event: &Value) -> Option<&str> {
    get(Some(event), "event_type").and_then(Value::as_str)
}

fn payload_field<'a>(event: &'a Value, key: &str) -> Option<&'a Value> {
    path(Some(event), &["payload", key])
}

/// Строка взаимодействия с предметом сцены словами стола; где имени предмета
/// нет или исход уже звучит сценой — прежняя строка `sceneInteractionNarration`.
fn scene_interaction_line(batch: &[Value], state: &Value) -> JsResult<String> {
    let fallback = sk_tactical::scene_interactions::scene_interaction_narration(Some(&Value::Array(batch.to_vec())));
    if fallback.is_empty() {
        return Ok(String::new());
    }
    if batch.iter().any(|event| {
        let kind = event_type(event);
        kind == Some("LockpickNoticed")
            || (kind == Some("SceneObjectKnowledgeRevealed") && js::truthy(payload_field(event, "text")))
            || (kind == Some("DamageApplied") && is_str(payload_field(event, "reason"), "scene-object-trap"))
    }) {
        return Ok(fallback);
    }
    let anchor = batch.iter().find(|event| js::s(get(Some(event), "event_type")).starts_with("SceneObject") && js::truthy(payload_field(event, "prop_id")));
    let actor_id = anchor.and_then(|anchor| get(Some(anchor), "actor_id"));
    let actor = if js::truthy(actor_id) { tactical_actor_name(state, actor_id)? } else { "Герой".to_string() };
    if let Some(granted) = batch.iter().find(|event| event_type(event) == Some("SceneObjectLootGranted")) {
        let names = loot_names(payload_field(granted, "loot"));
        return Ok(if names.is_empty() { format!("{actor} забирает находку.") } else { format!("{actor} забирает {}.", join_ru(&names)) });
    }
    let place = anchor.and_then(|anchor| scene_prop_phrase(state, payload_field(anchor, "prop_id")));
    if let Some(revealed) = batch.iter().find(|event| event_type(event) == Some("SceneObjectLootRevealed")) {
        let names = loot_names(payload_field(revealed, "loot"));
        if names.is_empty() {
            return Ok(fallback);
        }
        return Ok(format!("{} — {}.", place.as_ref().map_or("Внутри", |place| place.inside), join_ru(&names)));
    }
    if batch.iter().any(|event| event_type(event) == Some("RestCompleted") && js::truthy(payload_field(event, "source_prop_id"))) {
        return Ok(fallback);
    }
    let Some(place) = place else { return Ok(fallback) };
    let changed = batch.iter().rev().find(|event| event_type(event) == Some("SceneObjectStateChanged"));
    let changed_field = |key: &str| changed.and_then(|event| payload_field(event, key));
    let lockpick = is_str(changed_field("intent"), "lockpick");
    if js::is_false(changed_field("success")) {
        return Ok(if lockpick { fallback } else { format!("{actor} пытается, но {} не поддаётся.", place.label) });
    }
    let accusative = place.accusative;
    match changed_field("state").and_then(Value::as_str) {
        Some("open") => return Ok(if lockpick { fallback } else { format!("{actor} открывает {accusative}.") }),
        Some("toppled") => return Ok(format!("{actor} опрокидывает {accusative}.")),
        Some("burning") => return Ok(format!("{actor} поджигает {accusative} — огонь занимается.")),
        Some("taken") => return Ok(format!("{actor} забирает содержимое.")),
        Some("used") => return Ok(format!("{actor} использует {accusative}.")),
        _ => {}
    }
    if let Some(inspected) = batch.iter().find(|event| event_type(event) == Some("SceneObjectInspected")) {
        if js::is_false(payload_field(inspected, "success")) {
            return Ok(format!("{actor} осматривает {accusative}, но ничего определённого не находит."));
        }
        return Ok(if js::is_true(payload_field(inspected, "trap_detected")) {
            format!("{actor} осматривает {accusative} и замечает ловушку.")
        } else {
            format!("{actor} осматривает {accusative} — ничего необычного.")
        });
    }
    Ok(fallback)
}

/// `encounterSetting(state, encounter)`: обстановка столкновения для вступления —
/// `ambush`, `underground`, `graveyard`, `night`, `forest`, `road`,
/// `settlement` или `generic`.
pub fn encounter_setting(state: &Value, encounter: Option<&Value>) -> &'static str {
    let scene_theme = text::lower(&js::s(coalesce(path(Some(state), &["scene", "theme"]), path(Some(state), &["scene", "map", "theme"]))));
    let encounter_theme = text::lower(&js::s(get(encounter, "theme")));
    if encounter_theme == "ambush" {
        return "ambush";
    }
    if UNDERGROUND_SCENE_THEMES.contains(&scene_theme.as_str()) || ["crypt", "cave"].contains(&encounter_theme.as_str()) {
        return "underground";
    }
    if scene_theme == "graveyard" {
        return "graveyard";
    }
    let outdoors = ["forest", "road", "settlement", "graveyard", ""].contains(&scene_theme.as_str());
    if outdoors && js::truthy(path(Some(state), &["mechanics", "world_time"])) && time_of_day_of(elapsed_minutes_of(state)) == "night" {
        return "night";
    }
    match scene_theme.as_str() {
        "forest" => "forest",
        "road" => "road",
        "settlement" | "building" | "temple" => "settlement",
        _ => "generic",
    }
}

/// `encounterIntro(event, state)`: вступление столкновения по `EncounterCreated` —
/// обстановка и состав. Общая точка для боевого рассказчика и рассказчика
/// столкновения.
pub fn encounter_intro(event: &Value, state: &Value) -> String {
    let empty = Value::Object(Map::new());
    let encounter = match path(Some(event), &["payload", "encounter"]) {
        Some(value @ (Value::Object(_) | Value::Array(_))) => value,
        _ => &empty,
    };
    let names: Vec<String> =
        array_or_empty(get(Some(encounter), "enemies")).iter().map(|enemy| clean_text(get(Some(enemy), "name"), 120)).filter(|name| !name.is_empty()).take(12).collect();
    encounter_intro_phrase(&mut Phrasebook::new(), &names, encounter_setting(state, Some(encounter)), Some(event))
}

/// Тактика существа по ходам планировщика: первая названная на каждого.
fn npc_tactics_from(turns: Option<&Value>) -> IndexMap<String, String> {
    let mut tactics = IndexMap::new();
    for turn in array_or_empty(turns) {
        let id = js::s(get(Some(turn), "actor_id"));
        let tactic = js::s(get(Some(turn), "tactic"));
        if !id.is_empty() && !tactic.is_empty() && !tactics.contains_key(&id) {
            tactics.insert(id, tactic);
        }
    }
    tactics
}

/// `String(event?.target_ids?.[0] ?? event?.payload?.target_id ?? '')`.
fn event_target_id(event: &Value) -> String {
    let first = index0(get(Some(event), "target_ids"));
    match first.as_ref().filter(|value| !value.is_null()) {
        Some(value) => js::s(Some(value)),
        None => js::s(payload_field(event, "target_id")),
    }
}

/// Урон, который ложится в строку своего удара: тот же удар (команда) и та же
/// цель, до следующей атаки. Особые случаи остаются своими строками.
fn mergeable_damage_index(events: &[Value], attack_index: usize, consumed: &IndexSet<usize>) -> Option<usize> {
    let attack = &events[attack_index];
    let target_id = event_target_id(attack);
    for (index, candidate) in events.iter().enumerate().skip(attack_index + 1) {
        let kind = event_type(candidate);
        if kind == Some("AttackResolved") || kind == Some("AreaAttackResolved") {
            return None;
        }
        if kind != Some("DamageApplied") || consumed.contains(&index) {
            continue;
        }
        if event_target_id(candidate) != target_id {
            continue;
        }
        let attack_command = get(Some(attack), "command_id");
        let candidate_command = get(Some(candidate), "command_id");
        if js::truthy(attack_command) && js::truthy(candidate_command) && js::s(attack_command) != js::s(candidate_command) {
            continue;
        }
        let field = |key: &str| payload_field(candidate, key);
        if !(js::number(field("applied_amount")) > 0.0)
            || js::is_true(field("immune"))
            || js::truthy(field("death_ward_triggered"))
            || js::truthy(field("resistance_cantrip_reduction"))
            || js::truthy(field("scenario_ward_text"))
            || is_str(field("reason"), "scene-object-trap")
        {
            return None;
        }
        return Some(index);
    }
    None
}

const SAVE_EVENT_TYPES: [&str; 3] = ["SavingThrowResolved", "NpcSavingThrowResolved", "SpellSavingThrowResolved"];

/// `${natural} + mod = total` для спасброска; без модификатора — только кость.
fn roll_text(natural: f64, modifier: f64, total: f64) -> String {
    if modifier == 0.0 {
        n(natural)
    } else {
        format!("{} {} {} = {}", n(natural), if modifier > 0.0 { "+" } else { "−" }, n(modifier.abs()), n(total))
    }
}

/// Строки хода и строки про небо.
fn tactical_narration_lines(list: &[Value], state: &Value, options: Option<&Value>) -> JsResult<(Vec<String>, Vec<String>)> {
    let mut meaningful: Vec<String> = Vec::new();
    let mut turns: Vec<String> = Vec::new();
    let mut sky: Vec<String> = Vec::new();
    let mut book = Phrasebook::new();
    let completed_rest_actors: HashSet<String> = list
        .iter()
        .filter(|event| event_type(event) == Some("RestCompleted") && !js::truthy(payload_field(event, "source_prop_id")))
        .map(|event| js::s(get(Some(event), "actor_id")))
        .collect();
    let post_victory_rest_actors: HashSet<String> = list
        .iter()
        .filter(|event| event_type(event) == Some("DowntimeResolved") && is_post_victory_reason(payload_field(event, "reason")))
        .flat_map(|event| array_or_empty(payload_field(event, "participant_ids")).iter().map(|id| js::string(Some(id))))
        .collect();
    let scene_interaction = scene_interaction_line(list, state)?;
    if !scene_interaction.is_empty() {
        meaningful.push(scene_interaction);
    }
    let party_failed = list.iter().any(|event| event_type(event) == Some("CampaignFailed"));
    let windows_by_preference: HashSet<String> = list
        .iter()
        .filter(|event| event_type(event) == Some("ReactionWindowClosed") && js::truthy(payload_field(event, "reaction_preference")))
        .map(|event| js::s(payload_field(event, "id")))
        .collect();
    let encounter_ended = list.iter().any(|event| event_type(event) == Some("EncounterEnded"));
    let tactics = npc_tactics_from(get(options, "npcTurns"));
    let mut tactic_lead_used: HashSet<String> = HashSet::new();
    let mut consumed: IndexSet<usize> = IndexSet::new();
    let mut opportunity_attacks: HashSet<usize> = HashSet::new();
    for (index, event) in list.iter().enumerate() {
        if event_type(event) != Some("CombatActionUsed") || !is_str(payload_field(event, "action_id"), "opportunity-attack") {
            continue;
        }
        let actor_id = js::s(get(Some(event), "actor_id"));
        let attack_index = list
            .iter()
            .enumerate()
            .position(|(at, candidate)| at > index && event_type(candidate) == Some("AttackResolved") && js::s(get(Some(candidate), "actor_id")) == actor_id);
        if let Some(attack_index) = attack_index {
            consumed.insert(index);
            opportunity_attacks.insert(attack_index);
        }
    }
    for (index, event) in list.iter().enumerate() {
        if event_type(event) != Some("ReactionWindowClosed") || !js::is_true(payload_field(event, "accepted")) || js::truthy(payload_field(event, "reaction_preference")) {
            continue;
        }
        let actor_id = js::s(get(Some(event), "actor_id"));
        let used = list.iter().enumerate().any(|(at, candidate)| {
            at != index
                && event_type(candidate) == Some("CombatActionUsed")
                && (is_str(payload_field(candidate, "action_type"), "reaction") || js::truthy(payload_field(candidate, "reaction_window_id")))
                && js::s(get(Some(candidate), "actor_id")) == actor_id
        });
        if used {
            consumed.insert(index);
        }
    }
    let last_phase_index = list.iter().rposition(|event| event_type(event) == Some(TIME_OF_DAY_CHANGED_EVENT));
    let last_weather_index = list.iter().rposition(|event| is_world_clock(event) && event_type(event) != Some(TIME_OF_DAY_CHANGED_EVENT));
    let empty = Value::Object(Map::new());
    for (index, event) in list.iter().enumerate() {
        if event.is_null() {
            return Err(JsTypeError("event.payload of null"));
        }
        let payload = match get(Some(event), "payload") {
            None | Some(Value::Null) => &empty,
            Some(payload) => payload,
        };
        if consumed.contains(&index) {
            continue;
        }
        let field = |key: &str| get(Some(payload), key);
        let actor_id_value = get(Some(event), "actor_id");
        let actor = tactical_actor_name(state, actor_id_value)?;
        let target_id_owned = coalesce_owned(index0(get(Some(event), "target_ids")), field("target_id"));
        let target_id = target_id_owned.as_ref();
        let target = tactical_actor_name(state, target_id)?;
        let target_is_enemy = tactical_actor_is_enemy(state, target_id)?;
        let kind = event_type(event).unwrap_or("");
        let has_kind = event_type(event).is_some();
        let ev = Some(event);
        if has_kind && WORLD_CLOCK_EVENT_TYPES.contains(&kind) {
            if Some(index) != last_phase_index && Some(index) != last_weather_index {
                continue;
            }
            let line = world_clock_narration(event);
            if !line.is_empty() {
                sky.push(line);
            }
            continue;
        }
        if !has_kind {
            // `event.event_type` не строка: ни одна ветка ниже не совпадёт.
            continue;
        }
        match kind {
            "EncounterCreated" => meaningful.push(encounter_intro(event, state)),
            "EncounterEnded" => {
                let rest_minutes = post_victory_rest_minutes(state, coalesce(field("outcome"), field("reason")));
                let rest_ahead = if rest_minutes != 0.0 {
                    format!(" Можно перевести дух: дальше отряд встанет на привал и отдохнёт {} — силы вернутся.", hours_label_ru(rest_minutes / 60.0))
                } else {
                    String::new()
                };
                let end_text = encounter_end_text(coalesce(field("reason"), field("outcome")));
                meaningful.push(format!("{}{rest_ahead}", encounter_end_phrase(&mut book, &end_text, ev)));
            }
            "EncounterRewardsDistributed" => {
                let line = encounter_reward_line(payload, state, &mut book, event)?;
                if !line.is_empty() {
                    meaningful.push(line);
                }
            }
            "DowntimeResolved" if is_post_victory_reason(field("reason")) => {
                let hours = hours_label_ru(num_or(field("duration_minutes"), POST_VICTORY_REST_MINUTES) / 60.0);
                meaningful.push(if js::s(field("reason")) == "post_defeat_recovery" {
                    format!("Отряд приходит в себя после поражения: противники ушли, герои отдыхают {hours} и восстанавливают силы.")
                } else {
                    book.pick(
                        "victory-rest",
                        &[
                            format!("Отряд разбивает лагерь и отдыхает {hours} — силы восстановлены."),
                            format!("Привал на {hours}: раны перевязаны, силы восстановлены."),
                            format!("После победы отряд отдыхает {hours} и восстанавливает силы."),
                        ],
                        ev,
                    )
                });
            }
            "CombatStarted" => {
                let opening = field("opening_action");
                let opening_field = |key: &str| get(opening, key);
                let first_id = index0(path(Some(state), &["mechanics", "combat", "initiative"]));
                let first_id = get(first_id.as_ref(), "actor_id");
                let order = if js::truthy(opening_field("actor_id")) {
                    String::new()
                } else if js::truthy(first_id) {
                    format!(" Первый ход — за {}.", tactical_actor_name(state, first_id)?)
                } else {
                    String::new()
                };
                let start = book.pick("combat-start", &["Звенит сталь.", "Сталь покидает ножны.", "Медлить больше некогда."], ev);
                meaningful.push(format!("{start}{order}"));
                if js::truthy(opening_field("actor_id")) {
                    let attacker = tactical_actor_name(state, opening_field("actor_id"))?;
                    let victim_name = if js::truthy(opening_field("npc_id")) { tactical_actor_name(state, opening_field("npc_id"))? } else { String::new() };
                    let victim = if victim_name.is_empty() {
                        String::new()
                    } else {
                        format!(" на {}", confident_accusative(&victim_name).unwrap_or_else(|| accusative_name(&victim_name)))
                    };
                    meaningful.push(if js::is_true(opening_field("free_strike")) {
                        format!("{attacker} нападает{victim} вне очереди, пока никто не успел опомниться, — свой ход это не отнимает.")
                    } else if is_str(opening_field("status"), "deferred") {
                        format!("{attacker} нападает{victim}, но {} успевает раньше: удар придётся повторить в свой ход.", tactical_actor_name(state, opening_field("first_actor_id"))?)
                    } else {
                        format!("{attacker} нападает{victim} и открывает бой.")
                    });
                }
                let surprised = mappable(field("surprised"), "surprised.map")?.iter().map(|id| tactical_actor_name(state, Some(id))).collect::<JsResult<Vec<_>>>()?;
                if !surprised.is_empty() {
                    meaningful.push(format!("Застигнуты врасплох: {} — первый ход они теряют и не могут использовать реакцию.", surprised.join(", ")));
                }
            }
            "ReactionWindowOpened" if windows_by_preference.contains(&js::s(field("id"))) => {}
            "ReactionWindowClosed" if js::truthy(field("reaction_preference")) => {}
            "ReactionWindowOpened" => {
                let reactor_id = coalesce_owned(index0(nn(get(Some(event), "target_ids"))), field("target_id"));
                let reactor = tactical_actor_name(state, reactor_id.as_ref())?;
                let source = tactical_actor_name(state, coalesce(field("source_actor_id"), actor_id_value))?;
                let reply = reaction_instrumental_text(payload);
                let trigger = js::s(field("trigger"));
                meaningful.push(match trigger.as_str() {
                    "enemy-left-reach" => format!("{source} выходит из досягаемости — {reactor} может ответить {reply}."),
                    "spell-cast" => format!("{source} начинает колдовать — {reactor} может ответить {reply}."),
                    _ => format!("Момент для реакции: {reactor} может ответить {reply}."),
                });
            }
            "ReactionWindowClosed" => {
                meaningful.push(if js::is_true(field("accepted")) {
                    format!("{actor} отвечает {}.", reaction_instrumental_text(payload))
                } else if js::is_false(field("accepted")) {
                    book.pick("reaction-declined", &[format!("{actor} не отвечает — реакция остаётся в запасе."), format!("{actor} пропускает момент: реакция не использована.")], ev)
                } else {
                    format!("{actor} пропускает момент для реакции.")
                });
            }
            "SwingResolved" => meaningful.push(if js::is_true(field("success")) {
                format!("{actor} удерживается за люстру и продолжает манёвр.")
            } else {
                format!("{actor} срывается при попытке ухватиться за люстру и падает ничком у опоры; удар не происходит.")
            }),
            "ActorMoved" if js::is_true(field("forced_movement")) && js::truthy(target_id) && js::s(target_id) != js::s(actor_id_value) => {
                let feet = max(0.0, num_or0(field("distance")));
                meaningful.push(if js::truthy(field("pulled")) { format!("{target} рывком оказывается на {} фт ближе.", n(feet)) } else { format!("{target} отлетает на {} фт.", n(feet)) });
            }
            "ActorMoved" => {
                let tactic = if tactical_actor_is_enemy(state, actor_id_value)? { tactics.get(&js::s(actor_id_value)).map(String::as_str) } else { None };
                meaningful.push(move_phrase(&mut book, &actor, max(0.0, num_or0(field("distance"))), tactic, field("movement_mode"), ev));
            }
            "MapLevelChanged" => {
                let explicit = js::s(field("level_label"));
                let explicit = text::trim(&explicit);
                let label = if explicit.is_empty() { format!("этаж {}", n(num_or0(field("to_level")))) } else { explicit.to_string() };
                meaningful.push(if js::number(field("to_level")) > js::number(field("from_level")) {
                    format!("Партия поднимается по лестнице — {label}.")
                } else {
                    format!("Партия спускается по лестнице — {label}.")
                });
            }
            "DoorLockpicked" => meaningful.push(if js::is_true(field("success")) {
                format!("{actor} вскрывает замок отмычкой: дверь взломана и открыта.")
            } else {
                format!("{actor} возится с замком двери, но тот не поддаётся.")
            }),
            "AttackResolved" => {
                if js::is_true(field("recharge_action")) {
                    meaningful.push(format!("{actor} пускает в ход «{}».", text_or2(field("action_name"), field("action_id"), "особый приём")));
                }
                let mut reason = attack_condition_reason(payload)?;
                if is_str(field("high_ground"), "higher") {
                    reason.push_str(" с возвышенности");
                } else if is_str(field("high_ground"), "lower") {
                    reason.push_str(" снизу вверх");
                }
                if js::truthy(field("cover")) {
                    let mut covers = mappable(field("cover_blockers"), "cover_blockers.map")?.iter().map(|id| tactical_actor_name(state, Some(id))).collect::<JsResult<Vec<_>>>()?;
                    covers.extend(mappable(field("cover_scenery"), "cover_scenery.map")?.iter().map(|feature| cover_scenery_label(Some(feature))));
                    let joined = covers.join(", ");
                    reason.push_str(&format!(
                        " сквозь {} ({}, +{} к КД)",
                        if joined.is_empty() { "помеху" } else { &joined },
                        if is_str(field("cover"), "three-quarters") { "три четверти укрытия" } else { "половинное укрытие" },
                        n(num_or(field("cover_bonus"), 2.0)),
                    ));
                }
                let total = num_or0(field("total"));
                let base_armor_class = num_or0(field("armor_class"));
                let shielded = js::is_true(field("shielded_by_reaction"));
                let shown_armor_class = if shielded && !js::truthy(field("hit")) && total >= base_armor_class { base_armor_class + 5.0 } else { base_armor_class };
                let shield_note = if shielded { " с «Щитом»" } else { "" };
                let damage_index = if js::truthy(field("hit")) { mergeable_damage_index(list, index, &consumed) } else { None };
                let damage_payload = damage_index.map(|at| match get(Some(&list[at]), "payload") {
                    None | Some(Value::Null) => &empty,
                    Some(payload) => payload,
                });
                if let Some(at) = damage_index {
                    consumed.insert(at);
                }
                let damage = match damage_payload {
                    Some(damage) => {
                        let applied = n(js::number(get(Some(damage), "applied_amount")));
                        if target_is_enemy {
                            format!(", {applied} урона")
                        } else {
                            format!(", {applied} урона; ОЗ {} → {}", n(num_or0(get(Some(damage), "hp_before"))), n(num_or0(get(Some(damage), "hp_after"))))
                        }
                    }
                    None => String::new(),
                };
                let actor_key_text = js::s(actor_id_value);
                let actor_key_value = Value::String(actor_key_text.clone());
                let tactic_text =
                    if tactical_actor_is_enemy(state, Some(&actor_key_value))? && !tactic_lead_used.contains(&actor_key_text) { tactic_lead(tactics.get(&actor_key_text).map(String::as_str)) } else { "" };
                let lead = if tactic_text.is_empty() { String::new() } else { book.pick("tactic-lead", &[tactic_text, "", ""], ev) };
                if tactical_actor_is_enemy(state, Some(&actor_key_value))? {
                    tactic_lead_used.insert(actor_key_text);
                }
                let numbers = if target_is_enemy { String::new() } else { format!("{} против КД {}{shield_note}", n(total), n(shown_armor_class)) };
                let input = AttackPhraseInput {
                    actor: &actor,
                    target: &target,
                    target_is_enemy,
                    payload: Some(payload),
                    reason: Some(&reason),
                    numbers: Some(&numbers),
                    damage: Some(&damage),
                    opportunity: opportunity_attacks.contains(&index),
                    lead: Some(&lead),
                };
                if melee_verbs_throw(&book, &input, payload, ev) {
                    return Err(JsTypeError("MELEE_VERBS[damage_type].map is not a function"));
                }
                meaningful.push(attack_phrase(&mut book, &input, ev));
                if js::is_true(get(damage_payload, "resistant")) {
                    meaningful.push("Удар словно вязнет — цель сопротивляется такому урону.".into());
                } else if js::is_true(get(damage_payload, "vulnerable")) {
                    meaningful.push("Удар приходится по уязвимому месту — рана вдвое тяжелее.".into());
                }
            }
            "NpcItemUsed" => meaningful.push(format!("{actor} {}.", text_or(field("label"), "пускает в ход своё снаряжение"))),
            "NpcEquipmentSpent" if is_str(field("reason"), "ammunition") && js::number(field("shots_after")) == 0.0 => {
                meaningful.push(format!("{actor} тянется за следующим снарядом и находит колчан пустым."));
            }
            "ItemEffectIneffective" => {
                let item = text_or(field("item_name"), "Склянка");
                meaningful.push(match confident_accusative(&target) {
                    Some(victim) => format!("{item} разбивается о {victim}, но вреда не причиняет."),
                    None => format!("{item} разбивается, но вреда не причиняет (цель — {target})."),
                });
            }
            "LegendaryActionUsed" => meaningful.push(format!("Вне очереди: {actor} — «{}».", text_or(field("name"), "легендарное действие"))),
            "LegendaryResistanceUsed" => meaningful.push(if is_str(field("reason"), "lethal") {
                format!("Такой удар валит любого — но {target} остаётся на ногах: сила, что держит это существо, тратится, но не иссякла.")
            } else {
                format!("{target} стряхивает с себя чары, даже не дрогнув.")
            }),
            "LegendaryActionsReset" => meaningful.push(format!("{target} собирается с силами: удары вне очереди снова в запасе.")),
            "MonsterAbilityRecharged" => meaningful.push(format!("{target}: «{}» снова наготове.", text_or2(field("name"), field("action_id"), "особый приём"))),
            "AreaAttackResolved" => {
                meaningful.push(format!("{actor} бросает {} в область радиусом {} фт.", text_or(field("item_name"), "снаряд"), n(num_or0(field("radius_feet")))));
            }
            "CombatActionUsed" if is_str(field("reaction_preference"), "never") => {}
            "CombatActionUsed" if is_str(field("action_type"), "reaction") || js::truthy(field("reaction_window_id")) => {
                meaningful.push(if is_str(field("reaction_preference"), "auto") {
                    format!("{actor} сразу использует {}.", reaction_action_text(payload))
                } else {
                    book.pick("reaction-used", &[format!("{actor} использует {}.", reaction_action_text(payload)), format!("{actor} отвечает {}.", reaction_instrumental_text(payload))], ev)
                });
            }
            "CombatActionUsed" if js::is_true(field("monster_action")) => meaningful.push(format!("{actor} использует приём «{}».", text_or(field("name"), "особая атака"))),
            "CombatActionUsed" if is_str(field("action_id"), "break-free") && matches!(field("success"), Some(Value::Bool(_))) => {
                meaningful.push(if js::is_true(field("success")) { format!("{actor} вырывается: путы больше не держат.") } else { format!("{actor} рвётся из пут, но они держат.") });
            }
            "CombatActionUsed" => {
                let source = js::s(field("name"));
                let label = text::trim(&source);
                if !label.is_empty() && has_cyrillic(label) {
                    meaningful.push(action_phrase(&mut book, &actor, field("action_id"), label, ev));
                }
            }
            _ if SAVE_EVENT_TYPES.contains(&kind) => {
                let source = if kind == "SpellSavingThrowResolved" || kind == "NpcSavingThrowResolved" { spell_source_text(&public_spell_label(payload)) } else { String::new() };
                let saved = field("saved").and_then(Value::as_bool);
                meaningful.push(save_phrase(&mut book, &target, saved, &source, ev));
            }
            "SpellCast" if !is_additional_beam_spell_cast(event) => {
                let spell = format!("«{}»", text_or2(field("name"), field("spell_id"), "магия"));
                meaningful.push(book.pick(
                    "spell-cast",
                    &[format!("{actor} творит заклинание {spell}."), format!("{actor} произносит слова заклинания {spell}."), format!("{actor} сплетает чары — {spell}.")],
                    ev,
                ));
            }
            "SummonedCreatureCreated" => {
                meaningful.push(format!("{actor} призывает {}; его ход поставлен сразу после хозяина.", text_or(path(Some(payload), &["summon", "name"]), "помощника")));
            }
            "SummonedCreatureDismissed" => meaningful.push(format!("{target} исчезает с поля боя.")),
            "EquipmentChanged" => meaningful.push(format!(
                "{actor} экипирует {}{}.",
                text_or(field("item_name"), "оружие"),
                if js::truthy(field("turns_spent")) { ", затрачивая действие" } else { " перед атакой" }
            )),
            "DamageApplied" if js::is_true(field("immune")) && js::number(field("raw_amount")) > 0.0 && js::truthy(field("scenario_ward_text")) => {
                meaningful.push(js::s(field("scenario_ward_text")));
            }
            "DamageApplied" if js::is_true(field("immune")) && js::number(field("raw_amount")) > 0.0 => {
                meaningful.push(format!("{} не действует на {target}.", damage_type_label(field("damage_type"))));
            }
            "ConditionImmunityResolved" => meaningful.push(format!("{target} не поддаётся: состояние не пристаёт к такому существу.")),
            "DamageApplied" if js::number(field("applied_amount")) > 0.0 => {
                let amount = js::number(field("applied_amount"));
                let hp = || format!("; ОЗ {} → {}", n(num_or0(field("hp_before"))), n(num_or0(field("hp_after"))));
                meaningful.push(if target_is_enemy {
                    if js::truthy(field("death_ward_triggered")) {
                        format!("{target} получает {} урона, но Охрана от смерти удерживает цель на ногах.", n(amount))
                    } else {
                        damage_phrase(&target, amount, None)
                    }
                } else if js::truthy(field("death_ward_triggered")) {
                    format!("{target} получает {} урона, но Охрана от смерти срабатывает и оставляет 1 ОЗ.", n(amount))
                } else if js::truthy(field("resistance_cantrip_reduction")) {
                    format!(
                        "Сопротивление уменьшает урон: {target} получает на {} меньше; ОЗ {} → {}.",
                        n(js::number(field("resistance_cantrip_reduction"))),
                        n(num_or0(field("hp_before"))),
                        n(num_or0(field("hp_after")))
                    )
                } else {
                    damage_phrase(&target, amount, Some(&hp()))
                });
                if js::is_true(field("resistant")) {
                    meaningful.push("Удар словно вязнет — цель сопротивляется такому урону.".into());
                } else if js::is_true(field("vulnerable")) {
                    meaningful.push("Удар приходится по уязвимому месту — рана вдвое тяжелее.".into());
                }
            }
            "CreatureKnockedOut" => meaningful.push(if target_is_enemy {
                book.pick("knockout-enemy", &[format!("{target} без чувств — сопротивления больше нет."), format!("Оглушающий удар: {target} без сознания и больше не сопротивляется.")], ev)
            } else {
                format!("{target} теряет сознание от оглушающего удара, но остаётся с 1 ОЗ и начинает короткий отдых.")
            }),
            "KnockoutEnded" => meaningful.push(format!("{target} приходит в сознание после успешной первой помощи.")),
            "RestCompleted" if is_str(field("reason"), "knockout") => meaningful.push(format!("{target} приходит в сознание после завершения короткого отдыха.")),
            "RestStarted" if !js::truthy(field("source_prop_id")) && !completed_rest_actors.contains(&js::s(actor_id_value)) => {
                meaningful.push(format!("{actor} начинает {} отдых.", if is_str(field("kind"), "long") { "продолжительный" } else { "короткий" }));
            }
            "RestCompleted" if !js::truthy(field("source_prop_id")) => {
                let long = is_str(field("kind"), "long");
                if !(long && post_victory_rest_actors.contains(&js::s(actor_id_value))) {
                    meaningful.push(format!("{actor} завершает {} отдых.", if long { "продолжительный" } else { "короткий" }));
                }
            }
            "HitPointsReducedToZero" => {
                let side = if tactical_actor_is_hero(state, target_id)? {
                    "hero"
                } else if target_is_enemy {
                    "enemy"
                } else {
                    "other"
                };
                meaningful.push(downed_phrase(&mut book, &target, side, ev));
            }
            "DeathSavingThrowRolled" => {
                let outcome = match field("result").and_then(Value::as_str) {
                    Some("revived") => "натуральная 20 возвращает 1 ОЗ",
                    Some("stabilized") => "кровь остановлена, жизнь вне опасности",
                    Some("died") => "третий провал",
                    _ if js::truthy(field("success")) => "успех",
                    _ => "провал",
                };
                let natural = num_or0(field("natural_roll"));
                let modifier = num_or0(field("modifier"));
                let total = num_or(field("total"), natural + modifier);
                let aura = if js::truthy(field("aura_of_protection_bonus")) { format!(" Аура защиты даёт +{}.", n(js::number(field("aura_of_protection_bonus")))) } else { String::new() };
                let head = book.pick(
                    "death-save",
                    &[format!("{target} делает спасбросок от смерти"), format!("{target} борется за жизнь — спасбросок от смерти"), format!("{target} на грани — спасбросок от смерти")],
                    ev,
                );
                meaningful.push(format!("{head}: {} — {outcome}.{aura}", roll_text(natural, modifier, total)));
            }
            "ConcentrationSavingThrowResolved" => {
                let natural = num_or0(field("kept"));
                let modifier = num_or0(field("modifier"));
                let total = num_or(field("total"), natural + modifier);
                let aura = if js::truthy(field("aura_of_protection_bonus")) { format!(" Аура защиты даёт +{}.", n(js::number(field("aura_of_protection_bonus")))) } else { String::new() };
                let verdict = if js::truthy(field("saved")) { "успех" } else { "провал" };
                meaningful.push(if target_is_enemy {
                    format!("{target} пытается удержать концентрацию — {verdict}.")
                } else {
                    format!("{target} проверяет концентрацию: {} против СЛ {} — {verdict}.{aura}", roll_text(natural, modifier, total), n(num_or(field("difficulty"), 10.0)))
                });
            }
            "ConcentrationEnded" => {
                meaningful.push(format!("{target} теряет концентрацию ({}).", concentration_end_reason_label_str(&js::s(field("reason")))));
            }
            "ActionReadied" => {
                let trigger = match nn(field("trigger_label")) {
                    Some(value) => js::s(Some(value)),
                    None => "сработает выбранный триггер".into(),
                };
                meaningful.push(format!("{target} замирает с оружием наготове и ждёт, когда {trigger}."));
            }
            "ReadiedActionExpired" => {
                if is_str(field("reason"), "concentration-lost") {
                    meaningful.push(format!("{target} теряет сосредоточенность: заготовленное заклинание рассеивается."));
                } else if !is_str(field("reason"), "used") {
                    meaningful.push(if js::truthy(field("spell_id")) {
                        format!("{target}: повода так и не случилось — заготовленное заклинание рассеивается.")
                    } else {
                        format!("{target}: повода так и не случилось — заготовленный удар пропадает.")
                    });
                }
            }
            "DeathSaveFailureRecorded" => {
                let failures = if js::number(field("failure_increment")) == 2.0 { "два провала" } else { "провал" };
                meaningful.push(book.pick(
                    "death-save-damage",
                    &[format!("{target} получает {failures} спасброска от смерти из-за урона."), format!("Новая рана: {target} получает {failures} спасброска от смерти.")],
                    ev,
                ));
            }
            "HeroStabilized" => meaningful.push(stabilized_phrase(&mut book, &target, ev)),
            "StableRecoveryScheduled" => {
                meaningful.push(format!("{target} придёт в себя с 1 ОЗ через {}.", hours_label_ru(max(1.0, num_or(field("recovery_hours"), 1.0)))));
            }
            "HealingApplied" if is_str(field("reason"), "stable-recovery-after-1d4-hours") => {
                meaningful.push(format!("{target} приходит в сознание с 1 ОЗ после необходимого времени покоя."));
            }
            "HealingApplied" if is_str(field("spell_id"), "aura-of-life") => meaningful.push(format!("Аура жизни возвращает {target} 1 ОЗ в начале хода.")),
            "HealingApplied" if js::number(field("applied_amount")) > 0.0 => meaningful.push(if target_is_enemy {
                format!("{target} восстанавливает силы.")
            } else {
                format!(
                    "{target} восстанавливает {} ОЗ; ОЗ {} → {}.",
                    n(js::number(field("applied_amount"))),
                    n(num_or0(field("hp_before"))),
                    n(num_or0(field("hp_after")))
                )
            }),
            "HitPointMaximumReductionPrevented" => meaningful.push(format!("{target}: аура жизни не даёт уменьшить максимум ОЗ.")),
            "HitPointMaximumReduced" => meaningful.push(if target_is_enemy {
                format!("{target} слабеет: жизненные силы подточены.")
            } else {
                format!("Максимум ОЗ {target} снижается: {} → {}.", n(num_or0(field("maximum_hp_before"))), n(num_or0(field("maximum_hp_after"))))
            }),
            "HitPointMaximumIncreased" => meaningful.push(if target_is_enemy {
                format!("{target} держится крепче прежнего.")
            } else {
                format!("Максимум ОЗ {target} поднимается: {} → {}.", n(num_or0(field("maximum_hp_before"))), n(num_or0(field("maximum_hp_after"))))
            }),
            "HeroDied" => meaningful.push(if party_failed {
                format!("{target} погибает. Последний герой отряда пал, и история завершилась поражением.")
            } else {
                format!("{target} погибает. Судьбу героя нужно разрешить: воскресить или заменить новым.")
            }),
            "HeroResurrected" => meaningful.push(format!("{target} возвращается к жизни с 1 ОЗ.")),
            "HeroReplaced" => meaningful.push(format!("{} присоединяется к группе вместо погибшего героя.", text_or(field("replacement_name"), &target))),
            "ConditionAdded" if js::truthy(field("action_id")) && table_lookup(&MONSTER_HIT_CONDITION_TERMS, &js::string(field("condition"))).is_some() => {
                let term = table_lookup(&MONSTER_HIT_CONDITION_TERMS, &js::string(field("condition"))).unwrap_or("");
                meaningful.push(format!("{target} — состояние «{term}»."));
            }
            "ConditionAdded" if is_str(field("condition"), "fled") => meaningful.push(format!("{target} отступает и покидает бой.")),
            "ConditionAdded" if is_str(field("condition"), "surrendered") => meaningful.push(format!("{target} прекращает сопротивление и сдаётся.")),
            "ParleyProposed" => meaningful.push(format!("{actor} перекрикивает лязг: «Стойте! Поговорим!»")),
            "ParleyRejected" => meaningful.push(text_or(field("taunt"), "Ответа нет — бой продолжается.")),
            "TruceEstablished" => {
                let truce = coalesce(field("truce"), None);
                meaningful.push(format!(
                    "Оружие опускается: {} готов говорить. Перемирие держится, пока его никто не нарушил.",
                    text_or(get(truce, "leader_name"), "предводитель уцелевших")
                ));
            }
            "TruceBroken" => meaningful.push(if is_str(field("broken_by"), "enemies") {
                "Противник бьёт под перемирием — уговор разорван, бой возобновляется.".to_string()
            } else {
                format!("{actor} бьёт под перемирием. Слово нарушено, и это видели.")
            }),
            "ParleySettled" => meaningful.push(if is_str(field("outcome"), "resume") {
                "Переговоры кончились ничем: стороны расходятся по местам, и бой продолжается.".to_string()
            } else {
                let tribute = if js::number(field("tribute_cp")) > 0.0 { format!(" Отряду остаётся {} мм.", n(max(0.0, num_or0(field("tribute_cp"))))) } else { String::new() };
                format!("Уговор заключён: {}{tribute}", text_or2(field("term_summary"), field("term_label"), "условия приняты"))
            }),
            "TavernDiceRoundOpened" => meaningful.push(format!(
                "{} мечет кости: выпало {}. {} мм легли на стол — {actor} свою ставку сделал(а).",
                text_or(field("npc_name"), "Сосед по столу"),
                n(num_or0(field("npc_total"))),
                n(max(0.0, num_or0(field("stake_cp"))))
            )),
            "TavernDiceRoundResolved" => {
                let hero = n(num_or0(field("hero_total")));
                let opponent = n(num_or0(field("npc_total")));
                let stake = max(0.0, num_or0(field("stake_cp")));
                meaningful.push(match field("outcome").and_then(Value::as_str) {
                    Some("win") => format!("{actor} выбрасывает {hero} против {opponent} — банк в {} мм уходит герою.", n(stake * 2.0)),
                    Some("loss") => format!("{actor} выбрасывает {hero} против {opponent}: ставка в {} мм остаётся на столе.", n(stake)),
                    Some("push") => format!("Ровно {hero} у обоих — ставки возвращаются владельцам."),
                    Some("caught") => format!("{actor} тянется к костям — и руку перехватывают. Ставка потеряна."),
                    _ => format!("{actor} не сводит глаз с чужих рук и раунд не доигрывает."),
                });
                if is_str(field("watch_result"), "clean") {
                    meaningful.push("Ничего подозрительного: играют честно.".into());
                }
            }
            "TavernDiceRoundCancelled" => {
                let returned = max(0.0, num_or0(field("returned_cp")));
                meaningful.push(if returned > 0.0 {
                    if is_str(field("reason"), "patron-ejected") {
                        format!("{actor} выставлен(а) за дверь, не ответив на кость: раунд закрыт, и {} мм ставки возвращаются в кошелёк.", n(returned))
                    } else {
                        format!("Раунд {actor} закрылся, не дойдя до ответа: {} мм ставки возвращаются в кошелёк.", n(returned))
                    }
                } else {
                    format!(
                        "{actor} отодвигает скамью и встаёт, не ответив на кость. {} мм со стола забирает {}.",
                        n(max(0.0, num_or0(field("forfeited_cp")))),
                        text_or(field("npc_name"), "сосед")
                    )
                });
            }
            "TavernCheatCaught" => meaningful.push(format!("Скандал за столом: {} во весь голос объявляет героя шулером. Это видели.", text_or(field("npc_name"), "сосед"))),
            "TavernCheatExposed" => meaningful.push(format!("{} играет краплёными: подмену заметили, и уговор кончен.", text_or(field("npc_name"), "Сосед по столу"))),
            "TavernPatronEjected" => meaningful.push(format!("{actor} выставлен за дверь: за этим столом ему больше не наливают.")),
            "TavernDrinkOrdered" => {
                let drinks = n(max(1.0, num_or(field("drinks"), 1.0)));
                meaningful.push(if js::number(field("social_bonus")) > 0.0 {
                    format!("{actor} берёт кружку ({drinks}-я за вечер) — язык развязывается, разговор идёт легче.")
                } else {
                    format!("{actor} берёт ещё одну кружку. Это уже {drinks}-я.")
                });
            }
            "ShrinePrayerResolved" => meaningful.push(match field("outcome").and_then(Value::as_str) {
                Some("blessed") => format!("{actor} склоняет голову у святыни, и слова находят ответ: благословение принято."),
                Some("omen") => format!("{actor} молится, но ответа нет. {}", text_or(field("omen"), "Что-то в этом месте отзывается неправильно.")),
                _ => format!("{actor} молится у святыни. Ответа нет — только тишина и камень."),
            }),
            "NpcBlessingGranted" => meaningful.push(format!(
                "{} принимает пожертвование в {} мм и кладёт ладонь на голову героя: благословение дано.",
                text_or(field("npc_name"), "Служитель"),
                n(max(0.0, num_or0(field("donation_cp"))))
            )),
            "ConditionAdded" if js::s(field("source")).starts_with("blessing:") => meaningful.push(format!(
                "{target} несёт малое благословение: первый же удар пойдёт вернее (+{}), и держится оно до продолжительного отдыха.",
                n(max(0.0, num_or0(field("attack_bonus"))))
            )),
            "ConditionRemoved" if is_str(field("condition"), BLESSING_CONDITION) && is_str(field("trigger"), "attack") => {
                meaningful.push("Благословение израсходовано этим ударом.".into());
            }
            "ConditionAdded" if is_str(field("source"), "tavern-drink") => {
                meaningful.push(format!("{target} перебрал(а): всё плывёт, и до отдыха любая проверка идёт с помехой."));
            }
            "CaptiveTaken" => {
                let captive = coalesce(field("captive"), None);
                meaningful.push(if is_str(get(captive, "origin"), "knocked_out") {
                    format!("{} связан(а) без сознания и остаётся пленником отряда.", text_or(get(captive, "name"), "Побеждённый"))
                } else {
                    format!("{} сдаётся на милость и остаётся пленником отряда.", text_or(get(captive, "name"), "Сдавшийся"))
                });
            }
            "CaptiveInterrogated" => meaningful.push(if js::is_true(field("success")) {
                format!("{actor} разговорил(а) пленного — тот выдаёт то, что знает.")
            } else {
                format!("{actor} давит на пленного, но тот молчит.")
            }),
            "CaptiveFed" => meaningful.push("Пленного накормили и напоили.".into()),
            "CaptiveNeglected" => meaningful.push(format!("{} вторые сутки без еды и держится из последних сил.", text_or(field("captive_name"), "Пленник"))),
            "CaptiveReleased" => meaningful.push(format!("{actor} разрезает верёвки: пленный уходит живым.")),
            "CaptiveHandedOver" => meaningful.push(format!(
                "Пленный передан страже «{}»; за него уплачено {} мм.",
                text_or(field("settlement_name"), "поселения"),
                n(max(0.0, num_or0(field("bounty_cp"))))
            )),
            "CaptiveExecuted" => meaningful.push(format!("{actor} добивает связанного. Этого уже не отменить.")),
            "CaptiveMoved" => meaningful.push("Пленного уводят с собой.".into()),
            "BeastEncountered" => {
                meaningful.push(format!("{} не бросается: {actor} опускает оружие и делает шаг навстречу.", text_or(path(Some(payload), &["beast", "name"]), "Зверь")));
            }
            "BeastSoothingResolved" => {
                let beast = text_or(field("beast_name"), "Зверь");
                meaningful.push(if js::is_true(field("success")) {
                    if is_str(field("stage_after"), "tamed") {
                        format!("{beast} подходит сам и больше не смотрит на отряд как на добычу.")
                    } else {
                        format!("{beast} перестаёт скалиться: {actor} говорит с ним, и это работает.")
                    }
                } else {
                    format!("{beast} пятится и не подпускает: уговор не вышел.")
                });
            }
            "BeastBit" => {
                meaningful.push(format!("{} бросается и кусает: {} урона.", text_or(field("beast_name"), "Зверь"), n(max(0.0, num_or0(field("amount"))))));
            }
            "BeastFed" => meaningful.push(format!(
                "{actor} протягивает {} — и {} берёт еду с руки.",
                text_or(field("item_name"), "паёк"),
                text_or(field("beast_name"), "зверь")
            )),
            "BeastTamed" => meaningful.push(format!("{} идёт с отрядом. В строй он не встанет, но и один больше не останется.", text_or(field("beast_name"), "Зверь"))),
            "BeastMoved" => meaningful.push(format!("{} трусит следом за отрядом.", text_or(field("beast_name"), "Зверь"))),
            "BeastScaredThreat" => {
                let fallback = format!("{} отгоняет мелкую тварь.", text_or(field("beast_name"), "Зверь"));
                meaningful.push(text_or(field("line"), &fallback));
            }
            "CombatEnded" => {
                if !encounter_ended {
                    let round = n(num_or(field("round"), 1.0));
                    meaningful.push(book.pick("combat-end", &[format!("Бой завершён в раунде {round}."), format!("Схватка окончена — раунд {round}.")], ev));
                }
            }
            "TurnEnded" if is_str(field("auto_skip_reason"), "turn-timeout") => meaningful.push(format!("{actor}: время хода вышло, ход пропущен.")),
            "TurnEnded" => {
                if !defeated_enemy(state, actor_id_value)? {
                    turns.push(turn_end_phrase(&mut book, &actor, ev));
                }
            }
            "TurnStarted" => {
                if !defeated_enemy(state, target_id)? {
                    turns.push(turn_start_phrase(&mut book, &target, num_or(field("round"), 1.0), ev));
                }
            }
            _ => {}
        }
    }
    Ok((if meaningful.is_empty() { turns } else { meaningful }, sky))
}

/// Бросит ли JS `TypeError` в `transitiveAttackVerbs` (`server/combat-phrases.mjs`):
/// `MELEE_VERBS[String(damage_type)]` с ключом прототипа (`constructor`,
/// `__proto__`…) находит функцию или прототип, и `.map` у них нет. Перенос в
/// `sk_narration_base::combat_phrases` берёт здесь глаголы по умолчанию, поэтому
/// исключение воспроизводится тут: если реплика зависит от вида урона (путь
/// ближнего удара без природной атаки), то в JS до неё дело не дошло бы.
fn melee_verbs_throw(book: &Phrasebook, input: &AttackPhraseInput<'_>, payload: &Value, event: Option<&Value>) -> bool {
    let key = js::s(get(Some(payload), "damage_type"));
    if ["slashing", "piercing", "bludgeoning", "default"].contains(&key.as_str()) || crate::jsv::object_prototype_text(&key).is_none() {
        return false;
    }
    let probe = |damage_type: &str| {
        let mut changed = payload.clone();
        if let Some(object) = changed.as_object_mut() {
            object.insert("damage_type".into(), Value::String(damage_type.into()));
        }
        let mut copy = book.clone();
        attack_phrase(&mut copy, &AttackPhraseInput { payload: Some(&changed), ..*input }, event)
    };
    probe("slashing") != probe("piercing")
}

/// `a ?? b`, где `a` — уже вычисленное значение.
fn coalesce_owned(first: Option<Value>, second: Option<&Value>) -> Option<Value> {
    match first {
        Some(value) if !value.is_null() => Some(value),
        _ => second.cloned(),
    }
}

/// `combatNarration(events, state, options)` (`tacticalNarration` в JS): ход
/// и небо одной строкой.
pub fn combat_narration(events: &[Value], state: &Value, options: Option<&Value>) -> JsResult<String> {
    let parts = tactical_narration_parts(events, state, options)?;
    Ok([parts.main, parts.sky].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" "))
}

/// Типы событий, про которые этот рассказчик умеет говорить.
pub const COMBAT_NARRATION_EVENT_TYPES: &[&str] = &[
    "ActionReadied",
    "ActorMoved",
    "AreaAttackResolved",
    "AttackResolved",
    "SwingResolved",
    "BeastBit",
    "BeastEncountered",
    "BeastFed",
    "BeastMoved",
    "BeastScaredThreat",
    "BeastSoothingResolved",
    "BeastTamed",
    "CaptiveExecuted",
    "CaptiveFed",
    "CaptiveHandedOver",
    "CaptiveInterrogated",
    "CaptiveMoved",
    "CaptiveNeglected",
    "CaptiveReleased",
    "CaptiveTaken",
    "CombatEnded",
    "CombatStarted",
    "ConcentrationEnded",
    "ConcentrationSavingThrowResolved",
    "ConditionAdded",
    "ConditionImmunityResolved",
    "CreatureKnockedOut",
    "DamageApplied",
    "DeathSaveFailureRecorded",
    "DeathSavingThrowRolled",
    "DowntimeResolved",
    "EncounterCreated",
    "EncounterEnded",
    "EncounterRewardsDistributed",
    "EquipmentChanged",
    "HealingApplied",
    "HeroDied",
    "HeroReplaced",
    "HeroResurrected",
    "HeroStabilized",
    "HitPointMaximumIncreased",
    "HitPointMaximumReduced",
    "HitPointMaximumReductionPrevented",
    "HitPointsReducedToZero",
    "ItemEffectIneffective",
    "LegendaryActionUsed",
    "LegendaryActionsReset",
    "LegendaryResistanceUsed",
    "MonsterAbilityRecharged",
    "NpcBlessingGranted",
    "NpcEquipmentSpent",
    "NpcItemUsed",
    "CombatActionUsed",
    "NpcSavingThrowResolved",
    "ReactionWindowClosed",
    "ReactionWindowOpened",
    "SavingThrowResolved",
    "SpellSavingThrowResolved",
    "DoorLockpicked",
    "LockpickNoticed",
    "KnockoutEnded",
    "MapLevelChanged",
    "ParleyProposed",
    "ParleyRejected",
    "ParleySettled",
    "ReadiedActionExpired",
    "RestCompleted",
    "RestStarted",
    "ShrinePrayerResolved",
    "SpellCast",
    "SceneObjectCheckResolved",
    "SceneObjectEffectApplied",
    "SceneObjectInspected",
    "SceneObjectLootRevealed",
    "SceneObjectKnowledgeRevealed",
    "SceneObjectLootGranted",
    "SceneObjectOperated",
    "SceneObjectStateChanged",
    "StableRecoveryScheduled",
    "SummonedCreatureCreated",
    "SummonedCreatureDismissed",
    "TavernCheatCaught",
    "TavernCheatExposed",
    "TavernDiceRoundCancelled",
    "TavernDiceRoundOpened",
    "TavernDiceRoundResolved",
    "TavernDrinkOrdered",
    "TavernPatronEjected",
    "TimeOfDayChanged",
    "TruceBroken",
    "TruceEstablished",
    "TurnEnded",
    "TurnStarted",
    "WeatherChanged",
];

/// `hasCombatNarrationEvent(events)`.
pub fn has_combat_narration_event(events: &[Value]) -> bool {
    events.iter().any(|event| COMBAT_NARRATION_EVENT_TYPES.contains(&js::s(get(Some(event), "event_type")).as_str()))
}

/// `combatNarrator`: объявлен по общему контракту, но **намеренно не
/// зарегистрирован** в реестре — боевой текст живёт в другом потоке, маршруты
/// зовут его напрямую.
#[derive(Debug, Default, Clone, Copy)]
pub struct CombatNarrator;

impl DeterministicNarrator for CombatNarrator {
    fn id(&self) -> &str {
        "combat"
    }

    fn prompt_version(&self) -> &str {
        // v2: варианты реплик по идентификатору события, урон в строке удара,
        // тактика существа, вступление столкновения.
        "combat-narrator/v2"
    }

    fn provider(&self) -> &str {
        "deterministic-combat"
    }

    fn priority(&self) -> f64 {
        NARRATOR_PRIORITY.combat
    }

    fn matches(&self, events: &[Value]) -> bool {
        has_combat_narration_event(events)
    }

    /// `tacticalNarration(events, state) || null`. Исключение JS на мусоре
    /// контракт трейта передать не может — здесь оно даёт `None`.
    fn narrate(&self, events: &[Value], state: &Value) -> Option<String> {
        combat_narration(events, state, None).ok().filter(|text| !text.is_empty())
    }
}

/// Рассказчик боя как общий объект контракта (в реестр не входит).
pub static COMBAT_NARRATOR: LazyLock<SharedNarrator> = LazyLock::new(|| Arc::new(CombatNarrator));

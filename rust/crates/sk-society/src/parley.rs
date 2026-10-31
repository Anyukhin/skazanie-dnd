//! Перенос `server/parley.mjs`: переговоры посреди боя.
//!
//! Отклик считает мораль стороны противника, а не бросок игрока: СЛ выводится
//! из доли оставшихся ОЗ и доли выбывших, фанатики и бессловесные не отвечают
//! вовсе (до броска). Перемирие — состояние боя (`mechanics.combat.truce`),
//! исход выбирается из закрытого серверного списка. Модуль детерминированный
//! и без обращений к модели; свободная фраза распознаётся закрытым списком
//! выражений.

use serde_json::{json, Value};
use sk_core::{js, re, text as sk_text};

use crate::common::{array, coalesce, digest, get, integer, js_string, pick, s, text_squash, tpl, utf16_cmp};

pub const PARLEY_SCHEMA_VERSION: i64 = 1;
pub const PARLEY_POLICY_ID: &str = "skazanie:parley-v1";

/// Чем можно давить на переговорах. Список закрытый и серверный.
pub const PARLEY_SKILLS: [&str; 2] = ["persuasion", "intimidation"];
pub const PARLEY_ABILITY: &str = "cha";

/// Команды парлея: предложить и договориться.
pub const PARLEY_COMMAND_TYPES: [&str; 2] = ["ProposeParley", "SettleParley"];

/// Чем перемирие рвут: атака, площадная атака, заклинание, урон.
pub const TRUCE_BREAKING_COMMAND_TYPES: [&str; 4] = ["MakeAttack", "MakeAreaAttack", "CastSpell", "ApplyDamage"];

/// Кто вообще способен вести переговоры.
pub const NEGOTIABLE_CREATURE_TYPES: [&str; 5] = ["humanoid", "giant", "fiend", "celestial", "dragon"];

/// Черты «дерётся до конца»: их носитель на парлей не отвечает.
pub const ZEALOT_TRAIT_IDS: [&str; 2] = ["bloodied-frenzy", "relentless-pursuit"];

/// Почему разговора не вышло — и что при этом слышит стол.
pub const PARLEY_REFUSAL_LINES: [(&str, &str); 3] = [
    ("no_leader", "Отвечать уже некому: на ногах никого не осталось."),
    ("mindless", "Окрик уходит в пустоту: этим существам нечего сказать и нечего просить."),
    ("zealots", "Ответом только рёв: эти дерутся до конца и слов не слышат."),
];

pub const PARLEY_REFUSAL_REASONS: [&str; 3] = ["no_leader", "mindless", "zealots"];

/// Исходы перемирия. `resume` — всегда доступный отказ от уговора.
pub const PARLEY_OUTCOMES: [&str; 4] = ["withdraw", "tribute", "surrender", "resume"];

/// Условие перемирия карточкой: подпись и пояснение серверные.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParleyTerm {
    pub id: &'static str,
    pub label: &'static str,
    pub summary: &'static str,
}

impl ParleyTerm {
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "label": self.label, "summary": self.summary })
    }
}

/// Карточки условий (`PARLEY_TERMS`) в порядке объявления JS.
pub const PARLEY_TERMS: [ParleyTerm; 4] = [
    ParleyTerm { id: "withdraw", label: "Разойтись миром", summary: "Противник уходит со сцены и клянётся не возвращаться. Поле остаётся за отрядом." },
    ParleyTerm { id: "tribute", label: "Уйти, оставив добычу", summary: "Противник уходит и оставляет отряду всё взятое. Клятва не возвращаться — часть уговора." },
    ParleyTerm { id: "surrender", label: "Сложить оружие", summary: "Противник сдаётся отряду и переходит в плен, когда бой будет закрыт." },
    ParleyTerm { id: "resume", label: "Разойтись без уговора", summary: "Переговоры кончились ничем: перемирие снимается, и бой продолжается с текущего хода." },
];

/// База СЛ: сторона в полной силе слушать не станет.
pub const PARLEY_BASE_DC: i64 = 20;
/// Насколько сильно на СЛ влияют потерянные ОЗ и выбывшие бойцы.
pub const PARLEY_HEALTH_WEIGHT: f64 = 8.0;
pub const PARLEY_LOSS_WEIGHT: f64 = 6.0;

/// Порог «сломленности», с которого противник готов на уговор.
pub const PARLEY_OUTCOME_THRESHOLDS: [(&str, i64); 3] = [("withdraw", 0), ("tribute", 6), ("surrender", 10)];

fn clamp(value: i64, minimum: i64, maximum: i64) -> i64 {
    minimum.max(maximum.min(value))
}

fn clamp_f(value: f64, minimum: f64, maximum: f64) -> f64 {
    js::max_of([minimum, js::min_of([maximum, value])])
}

fn text(value: Option<&Value>, maximum: usize) -> String {
    text_squash(value, maximum)
}

fn comparable(value: Option<&Value>) -> String {
    sk_text::lower(&text(value, 180))
}

// ---------------------------------------------------------------------------
// Сторона противника
// ---------------------------------------------------------------------------

/// `String(entry?.id ?? entry)`.
fn id_or_self(entry: &Value) -> String {
    match get(Some(entry), "id") {
        None | Some(Value::Null) => js_string(entry),
        Some(id) => js_string(id),
    }
}

fn condition_ids(state: &Value, actor_id: &Value) -> Vec<String> {
    let conditions = get(get(Some(state), "mechanics"), "conditions");
    array(crate::common::prop(conditions, &js_string(actor_id))).iter().map(id_or_self).collect()
}

fn is_standing(state: &Value, enemy: &Value) -> bool {
    let Some(id) = get(Some(enemy), "id").filter(|id| js::truthy(Some(id))) else {
        return false;
    };
    if js::is_false(get(Some(enemy), "alive")) || integer(get(Some(enemy), "hp"), 0).max(0) <= 0 {
        return false;
    }
    let conditions = condition_ids(state, id);
    !conditions.iter().any(|condition| condition == "fled" || condition == "surrendered" || condition == "unconscious")
}

fn creature_type_of(enemy: &Value) -> String {
    let value = ["creature_type", "creatureType", "monster_type", "kind"]
        .iter()
        .fold(None, |found, key| coalesce(found, None).or_else(|| coalesce(get(Some(enemy), key), None)));
    comparable(value)
}

fn trait_ids(enemy: &Value) -> Vec<String> {
    array(get(Some(enemy), "traits")).iter().map(id_or_self).collect()
}

fn id_string(enemy: &Value) -> String {
    tpl(get(Some(enemy), "id"))
}

/// Уцелевшие противники — те, с кем ещё можно говорить (`standingEnemies`).
pub fn standing_enemies(state: &Value) -> Vec<&Value> {
    let mut standing: Vec<&Value> = array(get(Some(state), "enemies")).iter().filter(|enemy| is_standing(state, enemy)).collect();
    standing.sort_by(|left, right| sk_text::locale_compare(&id_string(left), &id_string(right)));
    standing
}

fn max_hp_score(enemy: &Value) -> i64 {
    integer(coalesce(get(Some(enemy), "maxHp"), get(Some(enemy), "max_hp")), 0).max(0)
}

/// Кто отвечает за сторону: самый крепкий из уцелевших (`parleyLeaderFor`).
pub fn parley_leader_for(state: &Value) -> Option<&Value> {
    let standing = standing_enemies(state);
    let first = *standing.first()?;
    Some(standing.iter().fold(first, |best, enemy| {
        let best_score = max_hp_score(best);
        let score = max_hp_score(enemy);
        if score > best_score {
            enemy
        } else if score < best_score {
            best
        } else if utf16_cmp(&id_string(enemy), &id_string(best)) == std::cmp::Ordering::Less {
            enemy
        } else {
            best
        }
    }))
}

/// Мораль стороны противника (`parleyMoraleFor`): СЛ, причина отказа и
/// доступные исходы. Чистая функция состояния.
pub fn parley_morale_for(state: &Value) -> Value {
    let enemies = array(get(Some(state), "enemies"));
    let standing = standing_enemies(state);
    let leader = parley_leader_for(state);
    let total = enemies.iter().filter(|enemy| js::truthy(get(Some(enemy), "id"))).count();
    let fallen = total as f64 - standing.len() as f64;
    let fallen_ratio = if total > 0 { clamp_f(fallen / total as f64, 0.0, 1.0) } else { 0.0 };
    let hp_sum: f64 = standing.iter().map(|enemy| integer(get(Some(enemy), "hp"), 0).max(0) as f64).sum();
    let max_hp_sum: f64 = standing.iter().map(|enemy| integer(coalesce(get(Some(enemy), "maxHp"), get(Some(enemy), "max_hp")), 1).max(1) as f64).sum();
    let health_ratio = if max_hp_sum > 0.0 { clamp_f(hp_sum / max_hp_sum, 0.0, 1.0) } else { 0.0 };
    let health_pressure = js::round((1.0 - health_ratio) * PARLEY_HEALTH_WEIGHT) as i64;
    let loss_pressure = js::round(fallen_ratio * PARLEY_LOSS_WEIGHT) as i64;
    let pressure = health_pressure + loss_pressure;
    let zealots = standing.iter().filter(|enemy| trait_ids(enemy).iter().any(|id| ZEALOT_TRAIT_IDS.contains(&id.as_str()))).count();
    let speakers = standing.iter().filter(|enemy| NEGOTIABLE_CREATURE_TYPES.contains(&creature_type_of(enemy).as_str())).count();
    // Фанатизм проверяется раньше речи: берсерк говорить умеет, но не станет.
    let refusal = match leader {
        None => Some("no_leader"),
        Some(_) if zealots > 0 => Some("zealots"),
        Some(leader) if speakers == 0 || !NEGOTIABLE_CREATURE_TYPES.contains(&creature_type_of(leader).as_str()) => Some("mindless"),
        Some(_) => None,
    };
    let difficulty = clamp(PARLEY_BASE_DC - pressure, 5, 30);
    let mut outcomes: Vec<&str> = Vec::new();
    if refusal.is_none() {
        outcomes.push("resume");
        for outcome in PARLEY_OUTCOMES {
            let threshold = PARLEY_OUTCOME_THRESHOLDS.iter().find(|(name, _)| *name == outcome).map_or(99, |(_, value)| *value);
            if outcome != "resume" && pressure >= threshold {
                outcomes.push(outcome);
            }
        }
    }
    outcomes.sort_by(|a, b| utf16_cmp(a, b));
    let health_text = js::to_fixed(health_ratio, 3);
    let leader_name = leader.and_then(|leader| coalesce(get(Some(leader), "name"), get(Some(leader), "character")));
    json!({
        "leader_id": leader.map(|leader| tpl(get(Some(leader), "id"))).unwrap_or_default(),
        "leader_name": text(leader_name, 160),
        "standing_count": standing.len(),
        "fallen_count": (total as i64 - standing.len() as i64).max(0),
        "health_ratio": js::num(js::parse_number(&health_text)),
        "health_pressure": health_pressure,
        "loss_pressure": loss_pressure,
        "pressure": pressure,
        "difficulty": difficulty,
        "refusal_reason": refusal,
        "refuses": refusal.is_some(),
        "outcomes": outcomes,
        "policy_id": PARLEY_POLICY_ID,
    })
}

/// Откуп монетой из XP уцелевших (`parleyTributeCp`).
pub fn parley_tribute_cp(state: &Value) -> i64 {
    let experience: f64 = standing_enemies(state).iter().map(|enemy| integer(get(get(Some(enemy), "provenance"), "xp"), 0).max(0) as f64).sum();
    let rounded = js::round(experience / 4.0 / 10.0) * 10.0;
    js::max_of([20.0, js::min_of([5_000.0, rounded])]) as i64
}

// ---------------------------------------------------------------------------
// Состояние перемирия
// ---------------------------------------------------------------------------

/// Нормализованное перемирие либо `None` (`normalizeTruce`).
pub fn normalize_truce(value: Option<&Value>) -> Option<Value> {
    if !matches!(value, Some(Value::Object(_))) {
        return None;
    }
    let leader_id = text(get(value, "leader_id"), 120);
    if leader_id.is_empty() {
        return None;
    }
    let mut outcomes: Vec<String> = Vec::new();
    for entry in array(get(value, "outcomes")) {
        let outcome = text(Some(entry), 40);
        if PARLEY_OUTCOMES.contains(&outcome.as_str()) && !outcomes.contains(&outcome) {
            outcomes.push(outcome);
        }
    }
    outcomes.sort_by(|a, b| utf16_cmp(a, b));
    if outcomes.is_empty() {
        outcomes.push("resume".into());
    }
    let skill = tpl(get(value, "skill"));
    let skill = if PARLEY_SKILLS.contains(&skill.as_str()) { skill } else { "persuasion".into() };
    Some(json!({
        "schema_version": PARLEY_SCHEMA_VERSION,
        "policy_id": PARLEY_POLICY_ID,
        "leader_id": leader_id,
        "leader_name": text(get(value, "leader_name"), 160),
        "hero_id": text(get(value, "hero_id"), 120),
        "hero_name": text(get(value, "hero_name"), 160),
        "skill": skill,
        "difficulty": clamp(integer(get(value, "difficulty"), PARLEY_BASE_DC), 5, 30),
        "total": integer(get(value, "total"), 0),
        "round": integer(get(value, "round"), 0).max(0),
        "established_at_minutes": integer(get(value, "established_at_minutes"), 0).max(0),
        "outcomes": outcomes,
        "tribute_cp": integer(get(value, "tribute_cp"), 0).max(0),
    }))
}

/// Действующее перемирие текущего боя либо `None` (`truceFor`).
pub fn truce_for(state: &Value) -> Option<Value> {
    let combat = get(get(Some(state), "mechanics"), "combat");
    if !js::truthy(get(combat, "active")) {
        return None;
    }
    normalize_truce(get(combat, "truce"))
}

/// Держится ли перемирие прямо сейчас (`truceHolds`).
pub fn truce_holds(state: &Value) -> bool {
    truce_for(state).is_some()
}

/// Сколько раз отряд уже пробовал договориться в этом бою (`parleyAttempts`).
pub fn parley_attempts(state: &Value) -> i64 {
    integer(get(get(get(Some(state), "mechanics"), "combat"), "parley_attempts"), 0).max(0)
}

/// Условия перемирия карточкой (`parleyTermsFor`).
pub fn parley_terms_for(truce: &Value) -> Vec<Value> {
    array(get(Some(truce), "outcomes"))
        .iter()
        .filter_map(|outcome| {
            let key = js_string(outcome);
            if let Some(term) = PARLEY_TERMS.iter().find(|term| term.id == key) {
                return Some(term.to_json());
            }
            None
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Свободная фраза
// ---------------------------------------------------------------------------

fn parley_phrase() -> &'static sk_core::fancy_regex::Regex {
    re!(
        r"(?<!\p{L})(?:парл[еи]й|переговор|перемири|поговорим|давай(?:те)?\s+погово|погово\p{L}*\s+(?:миром|по-хорошему)|сложите\s+оружие|опустите\s+оружие|брос(?:ай|ьте)\s+оружие|прекрат\p{L}*\s+(?:бой|драк)|хватит\s+(?:драться|биться)|не\s+хотим\s+(?:драться|биться)|предлага\p{L}*\s+(?:мир|сдаться)|сдавайтесь)",
        "iu"
    )
}

/// Встречные признаки по порядку проверки: `attack`, `negation`,
/// `own_surrender`, `postponed`, `recollection`.
pub const PARLEY_COUNTER_REASONS: [&str; 5] = ["attack", "negation", "own_surrender", "postponed", "recollection"];

fn counter_phrase(reason: &str) -> &'static sk_core::fancy_regex::Regex {
    match reason {
        "attack" => re!(
            r"(?<!\p{L})(?:бью|бь[её]м|атаку(?:ю|ем)|напада(?:ю|ем)|руб(?:лю|им)|реж(?:у|ем)|кол(?:ю|ем)|стреля(?:ю|ем)|мечу|кида(?:ю|ем)|швыря(?:ю|ем)|добива(?:ю|ем)|наношу\s+удар|замахива(?:юсь|емся))(?!\p{L})",
            "iu"
        ),
        "negation" => re!(
            r"(?<!\p{L})(?:никак(?:их|ого)\s+(?:переговор|перемири|уговор|разговор)|не\s+пахнет|не\s+буд(?:у|ем|ет)\s+(?:говорить|договар|переговар)|какие\s+(?:уж\s+)?(?:тут\s+)?переговор|не\s+о\s+ч[её]м\s+говорить)",
            "iu"
        ),
        "own_surrender" => re!(r"(?<!\p{L})(?:сдаюсь|сда[её]мся)(?!\p{L})", "iu"),
        "postponed" => re!(
            r"(?<!\p{L})(?:после\s+бо[яю]|после\s+драки|позже|потом|не\s+сейчас|когда\s+(?:вс[её]\s+)?(?:закончим|кончится|закончится))(?!\p{L})",
            "iu"
        ),
        _ => re!(
            r"(?<!\p{L})(?:помню|вспомн\p{L}*|припомин\p{L}*|говорил\p{L}*\s+(?:про|о(?!\p{L}))|рассказыва\p{L}*|слыша\p{L}*\s+(?:про|о(?!\p{L})))",
            "iu"
        ),
    }
}

/// Почему распознанное слово о переговорах окриком не считается, либо `None`
/// (`parleyCounterReasonFor`).
pub fn parley_counter_reason_for(value: &Value) -> Option<&'static str> {
    let phrase = text(Some(value), 1_000);
    PARLEY_COUNTER_REASONS.into_iter().find(|reason| sk_text::test(counter_phrase(reason), &phrase))
}

/// Объявлен ли парлей голосом (`mentionsParley`).
pub fn mentions_parley(value: &Value) -> bool {
    let phrase = text(Some(value), 1_000);
    sk_text::test(parley_phrase(), &phrase) && parley_counter_reason_for(&Value::String(phrase)).is_none()
}

/// Чем давят: нажим (`intimidation`) или уговор (`persuasion`) (`parleySkillFor`).
pub fn parley_skill_for(value: &Value) -> &'static str {
    let pressing = re!(
        r"(?<!\p{L})(?:сдавайтесь|сложите\s+оружие|опустите\s+оружие|брос(?:ай|ьте)\s+оружие|предлага\p{L}*\s+сдаться|или\s+(?:я|мы)(?!\p{L})|иначе(?!\p{L})|убь\p{L}*|прикончу|заруб(?:лю|им)|перебь\p{L}*|пожале(?:ешь|ете)|последнее\s+предупреждение)",
        "iu"
    );
    if sk_text::test(pressing, &text(Some(value), 1_000)) {
        "intimidation"
    } else {
        "persuasion"
    }
}

// ---------------------------------------------------------------------------
// Насмешки и реплики
// ---------------------------------------------------------------------------

const PARLEY_TAUNTS: [&str; 6] = [
    "Смех в ответ: «Поздно торговаться, пришлые».",
    "«Говорить будешь с землёй», — и сталь снова идёт вперёд.",
    "«Мы не для разговоров сюда шли».",
    "Плевок под ноги вместо ответа.",
    "«Слова кончились там, где вы взялись за оружие».",
    "«Проси у своих богов, а не у нас».",
];

/// Насмешка после провала, одинаковая при каждом replay того же боя
/// (`parleyTaunt`). `options` — `{ leaderId, round, attempt }`, как в JS.
pub fn parley_taunt(state: &Value, options: &Value) -> &'static str {
    let round = get(Some(options), "round").map_or_else(|| "0".to_string(), js_string);
    let attempt = get(Some(options), "attempt").map_or_else(|| "1".to_string(), js_string);
    let seed = digest(&[text(get(Some(state), "sessionCode"), 60), text(get(Some(options), "leaderId"), 120), round, attempt]);
    pick(&PARLEY_TAUNTS, &seed, "taunt").unwrap_or(PARLEY_TAUNTS[0])
}

/// Реплика отказа по причине (`parleyRefusalLine`); неизвестная — «бессловесные».
pub fn parley_refusal_line(reason: &Value) -> &'static str {
    let key = js_string(reason);
    PARLEY_REFUSAL_LINES.iter().find(|(name, _)| *name == key).map_or(PARLEY_REFUSAL_LINES[1].1, |(_, line)| *line)
}

// ---------------------------------------------------------------------------
// Редьюсер боевого состояния
// ---------------------------------------------------------------------------

/// Что событие парлея меняет в `mechanics.combat` — патч, а не целый бой
/// (`parleyCombatPatch`); `None` — событие бой не трогает.
pub fn parley_combat_patch(combat: &Value, event: &Value) -> Option<Value> {
    let kind = s(get(Some(event), "event_type"));
    let payload = coalesce(get(Some(event), "payload"), None);
    match kind.as_str() {
        "ParleyProposed" => Some(json!({ "parley_attempts": integer(get(Some(combat), "parley_attempts"), 0).max(0) + 1 })),
        "TruceEstablished" => normalize_truce(get(payload, "truce")).map(|truce| json!({ "truce": truce })),
        // Разорванное и исполненное перемирие не остаётся «сломанной» записью.
        "TruceBroken" | "ParleySettled" => Some(json!({ "truce": null })),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bandit(id: &str, hp: i64, alive: bool) -> Value {
        json!({ "id": id, "name": format!("Разбойник {id}"), "hp": hp, "maxHp": 11, "creature_type": "humanoid", "provenance": { "xp": 25 }, "alive": alive })
    }

    #[test]
    fn dc_falls_with_losses_and_wounds() {
        let fresh = parley_morale_for(&json!({ "enemies": [bandit("a", 11, true), bandit("b", 11, true)] }));
        assert_eq!(fresh["refuses"], false);
        assert_eq!(fresh["difficulty"], PARLEY_BASE_DC);
        let broken = parley_morale_for(&json!({ "enemies": [bandit("enemy-leader", 3, true), bandit("f1", 0, false), bandit("f2", 0, false)] }));
        assert!(broken["difficulty"].as_i64() < fresh["difficulty"].as_i64());
        assert_eq!(broken["standing_count"], 1);
        assert_eq!(broken["fallen_count"], 2);
        assert_eq!(broken["leader_id"], "enemy-leader");
    }

    #[test]
    fn zealots_and_mindless_refuse() {
        let mut zealot = bandit("z", 5, true);
        zealot["traits"] = json!([{ "id": "bloodied-frenzy" }]);
        assert_eq!(parley_morale_for(&json!({ "enemies": [zealot] }))["refusal_reason"], "zealots");
        let wolf = json!({ "id": "w", "hp": 5, "maxHp": 11, "creature_type": "beast" });
        let morale = parley_morale_for(&json!({ "enemies": [wolf] }));
        assert_eq!(morale["refusal_reason"], "mindless");
        assert_eq!(morale["outcomes"], json!([]));
    }

    #[test]
    fn leader_is_the_toughest_standing() {
        let state = json!({ "enemies": [
            { "id": "enemy-c", "hp": 20, "maxHp": 30, "alive": true },
            { "id": "enemy-b", "hp": 5, "maxHp": 20, "alive": true },
            { "id": "enemy-a", "hp": 5, "maxHp": 10, "alive": true },
        ], "mechanics": { "conditions": { "enemy-c": [{ "id": "fled" }] } } });
        assert_eq!(parley_leader_for(&state).and_then(|leader| leader.get("id")), Some(&json!("enemy-b")));
        let ids: Vec<&Value> = standing_enemies(&state).into_iter().filter_map(|enemy| enemy.get("id")).collect();
        assert_eq!(ids, [&json!("enemy-a"), &json!("enemy-b")]);
    }

    #[test]
    fn phrase_is_recognised_without_a_model() {
        for phrase in ["кричу им: остановитесь, поговорим!", "Предлагаю переговоры", "Сдавайтесь, и мы вас не тронем", "Предлагаю переговоры: хватит драться!"] {
            assert!(mentions_parley(&json!(phrase)), "{phrase}");
        }
        assert!(!mentions_parley(&json!("бью топором по щиту")));
    }

    #[test]
    fn counter_phrases_win_over_the_parley_word() {
        let counters = [
            ("Кричу товарищу: поговорим после боя! А сейчас бью гоблина топором", "attack"),
            ("Помню, староста говорил про переговоры с гильдией — но сейчас атакую", "attack"),
            ("Перемирием тут и не пахнет, режу его", "attack"),
            ("Хватит драться, я сдаюсь", "own_surrender"),
            ("Никаких переговоров с этой швалью", "negation"),
            ("Предлагаю переговоры, но не сейчас", "postponed"),
            ("Помню, в трактире говорили про переговоры с бандой", "recollection"),
        ];
        for (phrase, reason) in counters {
            assert_eq!(parley_counter_reason_for(&json!(phrase)), Some(reason), "{phrase}");
            assert!(!mentions_parley(&json!(phrase)), "{phrase}");
        }
    }

    #[test]
    fn pressing_and_persuading_are_told_apart() {
        assert_eq!(parley_skill_for(&json!("кричу им: остановитесь, поговорим!")), "persuasion");
        assert_eq!(parley_skill_for(&json!("Сдавайтесь, и мы вас не тронем")), "intimidation");
        assert!(mentions_parley(&json!("Прекрати бой, гоблин, или я тебя убью")));
        assert_eq!(parley_skill_for(&json!("Прекрати бой, гоблин, или я тебя убью")), "intimidation");
    }

    #[test]
    fn truce_freezes_combat_only_while_active() {
        let truce = json!({ "leader_id": "enemy-leader", "outcomes": ["withdraw", "resume", "bogus", "withdraw"] });
        let state = json!({ "mechanics": { "combat": { "active": true, "truce": truce } } });
        assert!(truce_holds(&state));
        assert_eq!(truce_for(&state).map(|truce| truce["outcomes"].clone()), Some(json!(["resume", "withdraw"])));
        assert!(!truce_holds(&json!({ "mechanics": { "combat": { "active": false, "truce": truce } } })));
        assert_eq!(parley_combat_patch(&json!({ "parley_attempts": 2 }), &json!({ "event_type": "ParleyProposed" })), Some(json!({ "parley_attempts": 3 })));
        assert_eq!(parley_combat_patch(&json!({}), &json!({ "event_type": "TruceBroken" })), Some(json!({ "truce": null })));
        assert_eq!(parley_combat_patch(&json!({}), &json!({ "event_type": "MakeAttack" })), None);
        // Ключ прототипа условием перемирия не считается.
        assert_eq!(parley_terms_for(&json!({ "outcomes": ["resume", "constructor", "nope"] })).len(), 1);
    }
}

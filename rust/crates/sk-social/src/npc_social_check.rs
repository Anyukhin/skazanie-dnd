//! Перенос `server/npc-social-check.mjs`: навыковые проверки в разговоре с NPC.
//!
//! Вид проверки (Убеждение, Обман, Запугивание, Проницательность) читается из
//! самой реплики героя, СЛ считает сервер: настроение и отношение NPC, слава
//! отряда у его фракций (`sk_society::reputation_policy`), ручная СЛ профиля и
//! протянутая монета (`sk_society::underworld`). Сам бросок модуль не делает:
//! политика уходит в `MakeAbilityCheck` Rules Engine, а исход читается из
//! события `AbilityCheckResolved` (`npc_social_check_outcome`). Кости — только
//! у Rules Engine, через внедрённый `sk_dice::Dice`.

use serde_json::{json, Map, Value};
use sk_core::{hash, js, re, text, RuleError};
use sk_society::reputation_policy::reputation_standing_for;
use sk_society::underworld::{bribe_outcome_for, bribe_tier_by_id, npc_is_incorruptible};

use crate::common::{array, clean, coalesce, element, empty, get, is_str, one_of, or_empty, tpl};
use crate::npc_social::{ensure_npc_social_state, npc_profile_at_world_time};

/// Навыки социальной проверки (`NPC_SOCIAL_CHECK_SKILLS`).
pub const NPC_SOCIAL_CHECK_SKILLS: [&str; 4] = ["persuasion", "deception", "intimidation", "insight"];

/// Монета кладётся только под Убеждение (`BRIBEABLE_SOCIAL_SKILLS`): обман и
/// запугивание деньгами не подкрепляют — первое ими выдаёт себя, второе ими
/// себе противоречит. Проницательность вообще не разговор, а взгляд.
pub const BRIBEABLE_SOCIAL_SKILLS: [&str; 1] = ["persuasion"];

const DEFAULT_CLEAN: usize = 2_000;

fn skill_ability(skill: &str) -> &'static str {
    match skill {
        "insight" => "wis",
        _ => "cha",
    }
}

/// `Math.max(minimum, Math.min(maximum, Number(value) || 0))`.
fn clamp(value: f64, minimum: f64, maximum: f64) -> f64 {
    let value = if value.is_nan() { 0.0 } else { value };
    value.min(maximum).max(minimum)
}

/// SHA-256 от очищенных частей, склеенных через `\0`.
fn stable_hash(parts: &[Option<&Value>]) -> String {
    let joined: Vec<String> = parts.iter().map(|part| clean(*part, DEFAULT_CLEAN)).collect();
    hash::sha256_hex(joined.join("\0"))
}

/// Утвердительная часть реплики (`affirmativeActionText`): без цитат и без
/// отрицаемых действий («не угрожаю», «не хочу его запугивать»).
pub fn affirmative_action_text(message: &Value) -> String {
    let lowered = text::lower(&clean(Some(message), DEFAULT_CLEAN));
    let unquoted = text::replace_all(re!(r#"«[^»]*»|"[^"]*"|'[^']*'"#, "gu"), &lowered, " ");
    let without_intent = text::replace_all(
        re!(r"(?:^|\s)(?:не|ни|без|никогда)\s+(?!только(?:\s|$))(?:буду|хочу|собираюсь)\s+(?:(?:его|её|их|это|так|себя)\s+)?\p{L}+", "giu"),
        &unquoted,
        " ",
    );
    text::replace_all(re!(r"(?:^|\s)(?:не|ни|без|никогда)\s+(?!только(?:\s|$))\p{L}+", "giu"), &without_intent, " ")
}

/// Вид социальной проверки по реплике (`classifyNpcSocialCheck`).
pub fn classify_npc_social_check(message: &Value) -> Option<&'static str> {
    let text = affirmative_action_text(message);
    if text.is_empty() {
        return None;
    }
    let test = |pattern: &sk_core::fancy_regex::Regex| text::test(pattern, &text);
    if test(re!(r"(проницател|распозн.*мотив|понимаю.*мотив|лж[её]т\s+ли|вр[её]т\s+ли|insight|read\s+(?:their|his|her)\s+intent)", "iu")) {
        return Some("insight");
    }
    if test(re!(r"(запуг|угрож|шантаж|припуг|intimidat|threaten|coerce)", "iu")) {
        return Some("intimidation");
    }
    if test(re!(r"(обман|лгу|солг|вру|блеф|выдаю\s+себя|deceiv|\blie\b|bluff)", "iu")) {
        return Some("deception");
    }
    if test(re!(r"(убежд|уговар|дипломат|склоняю|прошу\s+согласиться|persuad|convinc|negotiate)", "iu")) {
        return Some("persuasion");
    }
    // Флирт и подкуп — те же попытки расположить к себе: судит Убеждение и решает собеседник.
    if test(re!(r"(?<![\p{L}\p{M}])(?:флирт\p{L}*|кокетнича\p{L}*|очаровыва\p{L}*|подкуп\p{L}*|взятк\p{L}*|предлага\p{L}*[^.!?]{0,60}(?:монет|деньг|серебр|золот|плат))", "iu")) {
        return Some("persuasion");
    }
    None
}

struct Attitude {
    relationship: f64,
    stance: String,
}

fn attitude_for(social: &Value, npc_id: &str, hero_id: &str) -> Attitude {
    let score = get(get(get(Some(social), "relationships"), npc_id), hero_id);
    let relationship = match coalesce(score, None) {
        None => 0.0,
        some => js::number(some),
    };
    let latest = array(social.get("conversations"))
        .iter()
        .rev()
        .find(|entry| is_str(entry.get("npc_id"), npc_id) && is_str(entry.get("hero_id"), hero_id));
    let stance = match coalesce(latest.and_then(|entry| entry.get("stance")), None) {
        Some(stance) => tpl(Some(stance)),
        None => if relationship >= 20.0 {
            "friendly"
        } else if relationship <= -20.0 {
            "hostile"
        } else if relationship <= -5.0 {
            "guarded"
        } else {
            "neutral"
        }
        .to_string(),
    };
    Attitude { relationship, stance }
}

/// СЛ проверки. `reputation_shift` — поправка от славы отряда у фракций NPC;
/// личное отношение и репутация складываются. Явно заданный `social_dcs`
/// репутацией не двигается: это ручное решение автора кампании.
fn difficulty_for(profile: &Value, skill: &str, attitude: &Attitude, reputation_shift: f64) -> f64 {
    let configured = js::number(get(get(Some(profile), "social_dcs"), skill));
    if configured.is_finite() && configured.fract() == 0.0 && configured.abs() <= 9_007_199_254_740_991.0 {
        return clamp(configured, 5.0, 30.0);
    }
    let base = match attitude.stance.as_str() {
        "friendly" => 10.0,
        "neutral" => 12.0,
        "guarded" => 15.0,
        "hostile" => 18.0,
        _ => 12.0,
    };
    let relationship = attitude.relationship;
    let relationship_adjustment = if relationship >= 50.0 {
        -4.0
    } else if relationship >= 20.0 {
        -2.0
    } else if relationship >= 5.0 {
        -1.0
    } else if relationship <= -50.0 {
        4.0
    } else if relationship <= -20.0 {
        2.0
    } else if relationship <= -5.0 {
        1.0
    } else {
        0.0
    };
    let skill_adjustment = match skill {
        "deception" => 1.0,
        "insight" => 3.0,
        _ => 0.0,
    };
    clamp(base + relationship_adjustment + skill_adjustment + clamp(reputation_shift, -3.0, 3.0), 5.0, 25.0)
}

/// Есть ли в реплике протянутая монета и какой она щедрости (`classifyBribeTier`):
/// `generous`, `purse`, `coin` или пустая строка. Ступень читается из самой
/// фразы — тем же способом, каким читается и вид проверки.
pub fn classify_bribe_tier(message: &Value) -> &'static str {
    let text = js::s(Some(message));
    if !text::test(re!(r"подкуп\p{L}*|взятк\p{L}*|подмаз\p{L}*|подкрепл\p{L}*|сую|суну\p{L}*|монет\p{L}*|кошел\p{L}*|мошн\p{L}*|золот\p{L}*|серебр\p{L}*|плач\p{L}*", "iu"), &text) {
        return "";
    }
    if text::test(re!(r"щедро|не\s*скупясь|горст\p{L}*\s+золот|золот\p{L}*\s+сверху", "iu"), &text) {
        return "generous";
    }
    if text::test(re!(r"кошел\p{L}*|мошн\p{L}*|увесист\p{L}*", "iu"), &text) {
        return "purse";
    }
    if text::test(re!(r"монет\p{L}*|мед\p{L}*|серебр\p{L}*|звон\p{L}*|подкрепл\p{L}*|сую|суну\p{L}*|плач\p{L}*|отсчит\p{L}*", "iu"), &text) {
        return "coin";
    }
    "coin"
}

/// Параметр со значением по умолчанию JS (`name = ''`): `undefined` — запас,
/// остальное — `String(value)`.
fn string_param(params: &Value, key: &str) -> String {
    match get(Some(params), key) {
        None => String::new(),
        some => tpl(some),
    }
}

/// Политика проверки разговора (`buildNpcSocialCheckPolicy`): навык,
/// характеристика, СЛ, подкуп, отпечаток запроса и `check_id`; `None`, если
/// реплика не проверка или NPC недоступен.
///
/// `params` — `{ state, npcId, heroId, message, turnId, bribeTierId,
/// bribeReferenceCp }`, как в JS.
pub fn build_npc_social_check_policy(params: &Value) -> Option<Value> {
    let params = or_empty(params);
    let source = Some(params);
    let state = or_empty(get(source, "state").unwrap_or(empty()));
    let message = get(source, "message").unwrap_or(&Value::Null);
    let skill = classify_npc_social_check(message)?;
    let social = ensure_npc_social_state(&element(get(Some(state), "social")), state, &Value::Null);
    let npc_id = string_param(params, "npcId");
    let persisted = array(social.get("npcs")).iter().find(|npc| is_str(npc.get("id"), &npc_id))?;
    let profile = npc_profile_at_world_time(persisted, state);
    if js::is_false(profile.get("available")) {
        return None;
    }
    let normalized_npc_id = tpl(profile.get("id"));
    let normalized_hero_id = string_param(params, "heroId");
    let attitude = attitude_for(&social, &normalized_npc_id, &normalized_hero_id);
    let npc_value = Value::String(normalized_npc_id.clone());
    let hero_value = Value::String(normalized_hero_id.clone());
    let skill_value = Value::String(skill.to_string());
    let standing = reputation_standing_for(state, &npc_value);
    let fingerprint = stable_hash(&[Some(&npc_value), Some(&hero_value), Some(&skill_value), Some(message)]);
    let tier = if BRIBEABLE_SOCIAL_SKILLS.contains(&skill) {
        let requested = get(source, "bribeTierId");
        let tier_id = if js::truthy(requested) { element(requested) } else { Value::String(classify_bribe_tier(message).to_string()) };
        let reference = get(source, "bribeReferenceCp").cloned().unwrap_or_else(|| Value::from(0));
        bribe_tier_by_id(&tier_id, &reference)
    } else {
        None
    };
    let bribe = tier.map(|tier| {
        let mut bribe = Map::new();
        bribe.insert("tier_id".into(), element(tier.get("id")));
        bribe.insert("label".into(), element(tier.get("label")));
        bribe.insert("amount_cp".into(), element(tier.get("amount_cp")));
        let incorruptible = npc_is_incorruptible(state, &profile);
        if let Value::Object(outcome) = bribe_outcome_for(&json!({ "incorruptible": incorruptible, "tier": tier })) {
            for (key, value) in outcome {
                bribe.insert(key, value);
            }
        }
        Value::Object(bribe)
    });
    let turn_hash = stable_hash(&[get(source, "turnId"), Some(&Value::String(fingerprint.clone()))]);
    let bribe_shift = match bribe.as_ref().and_then(|bribe| coalesce(bribe.get("dc_shift"), None)) {
        None => 0.0,
        some => js::number(some),
    };
    let difficulty = js::max_of([1.0, difficulty_for(&profile, skill, &attitude, js::number(standing.get("social_dc_shift"))) + bribe_shift]);
    let mut policy = Map::new();
    policy.insert("check_id".into(), Value::String(format!("social-check:{}", text::head(&turn_hash, 24))));
    policy.insert("request_fingerprint".into(), Value::String(fingerprint));
    policy.insert("npc_id".into(), npc_value);
    policy.insert("hero_id".into(), hero_value);
    policy.insert("skill".into(), skill_value);
    policy.insert("ability".into(), Value::String(skill_ability(skill).to_string()));
    policy.insert("difficulty".into(), js::num(difficulty));
    if let Some(bribe) = bribe {
        policy.insert("bribe".into(), bribe);
    }
    policy.insert("reputation_tier".into(), element(standing.get("tier")));
    policy.insert("visibility".into(), Value::String("specific_player".into()));
    Some(Value::Object(policy))
}

fn number_or_zero(value: Option<&Value>) -> f64 {
    match coalesce(value, None) {
        None => 0.0,
        some => js::number(some),
    }
}

/// Исход социальной проверки из события `AbilityCheckResolved`
/// (`npcSocialCheckOutcome`): успех и его степень (разница с СЛ ≥ 10 — сильный
/// успех или тяжёлый провал). `None` — событие не про социальную проверку.
pub fn npc_social_check_outcome(event: &Value) -> Option<Value> {
    let source = Some(event);
    let payload = get(source, "payload");
    if !is_str(get(source, "event_type"), "AbilityCheckResolved") || !js::truthy(get(payload, "social_check")) {
        return None;
    }
    let social_check = get(payload, "social_check");
    let success = js::is_true(get(payload, "success"));
    let total = number_or_zero(get(payload, "total"));
    let margin = total - number_or_zero(get(payload, "difficulty"));
    let degree = if success {
        if margin >= 10.0 {
            "strong_success"
        } else {
            "success"
        }
    } else if margin <= -10.0 {
        "severe_failure"
    } else {
        "failure"
    };
    let skill = match one_of(get(payload, "skill"), &NPC_SOCIAL_CHECK_SKILLS) {
        Some(skill) => skill.to_string(),
        None => clean(get(social_check, "skill"), 30),
    };
    Some(json!({
        "check_id": clean(get(social_check, "check_id"), 120),
        "npc_id": clean(get(social_check, "npc_id"), 120),
        "skill": skill,
        "ability": clean(get(payload, "ability"), 10),
        "roll_id": clean(get(payload, "roll_id"), 120),
        "total": js::num(total),
        "modifier": js::num(number_or_zero(get(payload, "modifier"))),
        "success": success,
        "degree": degree,
    }))
}

/// Ключ идемпотентности уже привязан к другой проверке
/// (`assertNpcSocialCheckFingerprint`): отказ `IDEMPOTENCY_CONFLICT`, если
/// отпечаток записанного события не совпадает с политикой.
pub fn assert_npc_social_check_fingerprint(event: &Value, policy: &Value) -> Result<(), RuleError> {
    let actual = js::s(get(get(get(Some(event), "payload"), "social_check"), "request_fingerprint"));
    let expected = js::s(get(Some(policy), "request_fingerprint"));
    if actual.is_empty() || actual != expected {
        return Err(RuleError::new("IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to a different social check"));
    }
    Ok(())
}

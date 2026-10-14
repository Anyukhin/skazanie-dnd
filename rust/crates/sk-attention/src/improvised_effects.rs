//! Перенос `server/improvised-effects.mjs` — каталог того, что импровизация
//! вообще может сделать с миром.
//!
//! Это граница полномочий агента, записанная кодом. Модель называет **ключ**
//! из закрытого списка и цель; всё остальное — какие кости, сколько, какое
//! условие, сколько это стоит хода — принадлежит серверу. Модель не может ни
//! придумать новый эффект, ни назначить число: незнакомый ключ просто
//! отбрасывается.
//!
//! Модуль детерминированный и без обращений к LLM. Каталоги — JSON той же
//! формы и с тем же порядком ключей, что у JS (`IMPROVISED_EFFECTS`,
//! `ENVIRONMENT_HAZARDS`): план импровизации отдаёт запись каталога целиком.

use std::sync::LazyLock;

use serde::Serialize;
use serde_json::{json, Map, Value};
use sk_core::{js, text};
use sk_geometry::actor_footprint::footprint_distance_feet;
use sk_ruleset::rules_actors::actor_position;

use crate::support::{array, head_utf16, insert_raw, is_str, prop};

/// `clean` модуля: `String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, max)`.
fn clean_nfkc(value: Option<&Value>, max: usize) -> String {
    head_utf16(&text::squash_spaces(&text::nfkc(&js::s(value))), max)
}

/// Чем импровизация платит в бою. Вне боя цена всегда `free`.
///
/// Перемещения в списке нет намеренно: движок списывает футы только событием
/// `ActorMoved` с настоящим путём, и «потратить движение» без перемещения было
/// бы фикцией. Если импровизация двигает героя — это обычная команда
/// перемещения.
pub const ACTION_COSTS: [&str; 3] = ["action", "bonus_action", "free"];

const MELEE_REACH_FEET: i64 = 5;
/// Окрик и брошенная в глаза горсть песка достают дальше касания — решение
/// пользователя от 2026-07-27. Тридцать футов, а не «сколько слышно»:
/// дальность обязана быть конечной и проверяемой.
const SHOUTING_RANGE_FEET: i64 = 30;

/// Эффекты успеха. Каждый опирается на правило, которое движок уже исполняет,
/// поэтому новых механик здесь нет — есть новый повод применить старые.
///
/// `target` говорит, на кого эффект вообще можно навести; `range_feet` —
/// досягаемость: касание (ближняя досягаемость SRD) или окрик. Эффекты
/// обстановки (`target: 'scene_prop'`) ничего не исполняют сами: они называют
/// глагол `OperateSceneObject`, а механику снова считает эта команда.
pub static IMPROVISED_EFFECTS: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "none": {
            "id": "none", "target": "none", "label": "без механического следствия",
            "summary": "Успех меняет обстановку описанием, без механического следствия.",
        },
        "prone": {
            "id": "prone", "target": "enemy", "range_feet": MELEE_REACH_FEET, "condition": "prone", "label": "сбить с ног",
            "summary": "Цель сбита с ног.",
        },
        "help_ally": {
            "id": "help_ally", "target": "ally", "range_feet": MELEE_REACH_FEET, "condition": "helped", "duration": "until-used", "label": "помочь союзнику",
            "summary": "Союзник получает преимущество на следующую атаку.",
        },
        "distract": {
            "id": "distract", "target": "enemy", "range_feet": SHOUTING_RANGE_FEET, "condition": "disadvantage-next-attack", "duration": "until-next-turn", "label": "отвлечь противника",
            "summary": "Противник отвлечён: его следующая атака идёт с помехой.",
        },
        "blind": {
            "id": "blind", "target": "enemy", "range_feet": SHOUTING_RANGE_FEET, "condition": "blinded", "duration": "until-next-turn", "label": "ослепить",
            "summary": "Цель ослеплена до конца своего следующего хода.",
        },
        "restrain": {
            "id": "restrain", "target": "enemy", "range_feet": MELEE_REACH_FEET, "condition": "restrained", "duration": "until-next-turn", "label": "опутать",
            "summary": "Цель опутана до конца своего следующего хода.",
        },
        "hazard_damage": {
            "id": "hazard_damage", "target": "enemy", "range_feet": MELEE_REACH_FEET, "label": "подставить под опасность",
            "summary": "Цель попадает под опасность окружения.",
            "requiresHazard": true,
        },
        "topple_prop": {
            "id": "topple_prop", "target": "scene_prop", "range_feet": MELEE_REACH_FEET, "sceneIntent": "topple",
            "label": "опрокинуть предмет обстановки",
            "summary": "Тяжёлый предмет обстановки валится на то, что оказалось под ним.",
        },
        "ignite_prop": {
            "id": "ignite_prop", "target": "scene_prop", "range_feet": MELEE_REACH_FEET, "sceneIntent": "ignite",
            "label": "поджечь предмет обстановки",
            "summary": "Горючий предмет обстановки занимается огнём.",
        },
    })
});

/// Опасности окружения: кости фиксированы здесь, а не выбираются моделью, и
/// растут только со ставкой, которую сервер уже определил сам. Значения в
/// масштабе SRD: падение — 1к6 за 10 футов, огонь и кипяток сопоставимы с
/// ловушкой низкого уровня.
pub static ENVIRONMENT_HAZARDS: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "fall": {
            "id": "fall", "damage_type": "bludgeoning", "label": "падение с высоты",
            "expressions": { "none": "1d6", "minor": "1d6", "serious": "2d6", "deadly": "3d6" },
        },
        "fire": {
            "id": "fire", "damage_type": "fire", "label": "открытый огонь",
            "expressions": { "none": "1d6", "minor": "1d6", "serious": "2d6", "deadly": "3d6" },
        },
        "scalding": {
            "id": "scalding", "damage_type": "fire", "label": "кипяток или пар",
            "expressions": { "none": "1d4", "minor": "1d4", "serious": "2d4", "deadly": "3d4" },
        },
        "crush": {
            "id": "crush", "damage_type": "bludgeoning", "label": "обрушение или тяжёлый предмет",
            "expressions": { "none": "1d6", "minor": "2d6", "serious": "3d6", "deadly": "4d6" },
        },
        "caustic": {
            "id": "caustic", "damage_type": "acid", "label": "едкое вещество",
            "expressions": { "none": "1d4", "minor": "1d6", "serious": "2d6", "deadly": "3d6" },
        },
        "shards": {
            "id": "shards", "damage_type": "piercing", "label": "осколки или обломки",
            "expressions": { "none": "1d4", "minor": "1d6", "serious": "2d6", "deadly": "2d6" },
        },
    })
});

pub const IMPROVISED_EFFECT_IDS: [&str; 9] = ["none", "prone", "help_ally", "distract", "blind", "restrain", "hazard_damage", "topple_prop", "ignite_prop"];
pub const ENVIRONMENT_HAZARD_IDS: [&str; 6] = ["fall", "fire", "scalding", "crush", "caustic", "shards"];

/// `IMPROVISED_EFFECTS[id]` — только собственные ключи каталога (свойства
/// `Object.prototype` — не эффекты).
pub fn improvised_effect(id: &str) -> Option<&'static Value> {
    IMPROVISED_EFFECTS.get(id)
}

/// `ENVIRONMENT_HAZARDS[id]` — только собственные ключи каталога.
pub fn environment_hazard(id: &str) -> Option<&'static Value> {
    ENVIRONMENT_HAZARDS.get(id)
}

fn none_effect() -> &'static Value {
    &IMPROVISED_EFFECTS["none"]
}

/// `scenePropIntentFor(effectId)` — глагол `OperateSceneObject` за эффектом
/// обстановки, либо `None`. Это весь мост между свободной фразой и механикой
/// обстановки: маршрут выбирается по закрытому каталогу, а не по тексту игрока
/// и не по слову модели.
pub fn scene_prop_intent_for(effect_id: &str) -> Option<String> {
    let effect = improvised_effect(&clean_nfkc(Some(&Value::String(effect_id.to_string())), 40))?;
    is_str(effect.get("target"), "scene_prop").then(|| js::s(effect.get("sceneIntent")))
}

/// Входы `planImprovisedEffect(state, { actorId, effectId, targetId, hazardId,
/// risk })`. `None` — поле не передано (`undefined`, значение по умолчанию).
#[derive(Debug, Clone, Copy, Default)]
pub struct ImprovisedEffectRequest<'a> {
    pub actor_id: Option<&'a Value>,
    pub effect_id: Option<&'a Value>,
    pub target_id: Option<&'a Value>,
    pub hazard_id: Option<&'a Value>,
    pub risk: Option<&'a Value>,
}

impl<'a> ImprovisedEffectRequest<'a> {
    /// Из объекта JS-формы `{ actorId, effectId, targetId, hazardId, risk }`.
    pub fn from_value(options: &'a Value) -> Self {
        let field = |key: &str| options.get(key);
        Self {
            actor_id: field("actorId"),
            effect_id: field("effectId"),
            target_id: field("targetId"),
            hazard_id: field("hazardId"),
            risk: field("risk"),
        }
    }
}

/// План импровизации: исполнимые команды или честный отказ.
#[derive(Debug, Clone, PartialEq)]
pub struct ImprovisedPlan {
    /// Запись каталога эффекта (при отказе — `none`).
    pub effect: Value,
    /// Запись каталога опасности (только у урона окружением).
    pub hazard: Option<Value>,
    /// Причина отказа для игрока.
    pub rejected: Option<String>,
    pub commands: Vec<Value>,
    pub summary: String,
}

impl ImprovisedPlan {
    fn plain(effect: &Value) -> Self {
        Self { effect: effect.clone(), hazard: None, rejected: None, commands: Vec::new(), summary: js::s(effect.get("summary")) }
    }

    fn rejected(reason: impl Into<String>) -> Self {
        Self { rejected: Some(reason.into()), ..Self::plain(none_effect()) }
    }

    /// План в JSON — с тем же порядком ключей, что у JS.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("effect".into(), self.effect.clone());
        if let Some(hazard) = &self.hazard {
            map.insert("hazard".into(), hazard.clone());
        }
        if let Some(reason) = &self.rejected {
            map.insert("rejected".into(), Value::String(reason.clone()));
        }
        map.insert("commands".into(), Value::Array(self.commands.clone()));
        map.insert("summary".into(), Value::String(self.summary.clone()));
        Value::Object(map)
    }
}

/// Герои, прочие и противники подряд, без слияния повторов.
fn scene_actors(state: &Value) -> impl Iterator<Item = &Value> {
    array(state.get("players")).iter().chain(array(state.get("actors"))).chain(array(state.get("enemies")))
}

/// Сторона участника: `party`, `enemy` или `None`.
fn actor_side(state: &Value, actor_id: Option<&Value>) -> Option<&'static str> {
    let id = clean_nfkc(actor_id, 120);
    if id.is_empty() {
        return None;
    }
    let has = |key: &str| array(state.get(key)).iter().any(|actor| js::string(prop(Some(actor), "id")) == id);
    if has("players") || has("actors") {
        Some("party")
    } else if has("enemies") {
        Some("enemy")
    } else {
        None
    }
}

/// Расстояние берётся из той же серверной позиции, по которой ходит движок.
fn distance_in_feet(state: &Value, first_actor_id: Option<&Value>, second_actor_id: &str) -> Option<f64> {
    let left_id = clean_nfkc(first_actor_id, 120);
    let right_id = clean_nfkc(Some(&Value::String(second_actor_id.to_string())), 120);
    let first = actor_position(Some(state), &left_id)?;
    let second = actor_position(Some(state), &right_id)?;
    let card = |id: &str| scene_actors(state).find(|actor| js::s(prop(Some(actor), "id")) == id);
    let anchor = |point: sk_core::Point| json!({ "x": point.x, "y": point.y });
    footprint_distance_feet(card(&left_id), card(&right_id), Some(&anchor(first)), Some(&anchor(second)))
}

fn is_alive(state: &Value, id: &str) -> bool {
    let Some(actor) = scene_actors(state).find(|candidate| js::string(prop(Some(candidate), "id")) == id) else {
        return false;
    };
    // `Number(actor.hp ?? 1) > 0`.
    let hp = match prop(Some(actor), "hp") {
        None | Some(Value::Null) => 1.0,
        hp => js::number(hp),
    };
    !js::is_false(prop(Some(actor), "alive")) && hp > 0.0
}

/// `planImprovisedEffect(state, options)` — сверка предложенного эффекта с
/// миром. Единственное место, где «сбить с ног дракона» отличается от «сбить с
/// ног того, кого на поле нет». Возвращает либо исполнимый план, либо причину
/// отказа — отказ тоже честный ответ игроку.
pub fn plan_improvised_effect(state: &Value, request: ImprovisedEffectRequest) -> ImprovisedPlan {
    let default_effect = Value::String("none".into());
    let effect_id = clean_nfkc(Some(request.effect_id.unwrap_or(&default_effect)), 40);
    let Some(effect) = improvised_effect(&effect_id) else {
        return ImprovisedPlan::plain(none_effect());
    };
    let target_kind = js::s(effect.get("target"));
    if target_kind == "none" {
        return ImprovisedPlan::plain(effect);
    }
    // Предмет обстановки сюда доходить не должен: маршрут в
    // `OperateSceneObject` выбирается до броска. Если дошёл — значит, предмет
    // не подтвердился картой, и придумывать вместо него команду нельзя.
    if target_kind == "scene_prop" {
        return ImprovisedPlan::rejected("предмет обстановки не подтверждён картой");
    }
    let target = clean_nfkc(request.target_id, 120);
    if target.is_empty() {
        return ImprovisedPlan::rejected("цель не названа");
    }
    if !is_alive(state, &target) {
        return ImprovisedPlan::rejected("цели нет на поле");
    }
    let actor = clean_nfkc(request.actor_id, 120);
    let actor_team = actor_side(state, request.actor_id);
    let target_team = actor_side(state, Some(&Value::String(target.clone())));
    if target_kind == "enemy" && (target_team.is_none() || target_team == actor_team) {
        return ImprovisedPlan::rejected("этот эффект применяется к противнику");
    }
    if target_kind == "ally" && (target_team != actor_team || target == actor) {
        return ImprovisedPlan::rejected("этот эффект применяется к союзнику");
    }
    // Дальность сервер меряет сам: иначе агенту достаточно было назвать любого
    // живого противника на карте.
    let range = js::number(effect.get("range_feet"));
    let reach = if range.is_nan() || range == 0.0 { 0.0 } else { range.max(0.0) };
    let distance = distance_in_feet(state, request.actor_id, &target);
    if distance.is_none_or(|distance| distance > reach) {
        return ImprovisedPlan::rejected(format!("цель слишком далеко: досягаемость {} фт", js::f64_string(reach)));
    }
    if js::truthy(effect.get("requiresHazard")) {
        let Some(hazard) = environment_hazard(&clean_nfkc(request.hazard_id, 40)) else {
            return ImprovisedPlan::rejected("такой опасности нет в списке");
        };
        let default_risk = Value::String("minor".into());
        let risk = clean_nfkc(Some(request.risk.unwrap_or(&default_risk)), 20);
        let expressions = &hazard["expressions"];
        let expression = expressions.get(&risk).unwrap_or(&expressions["minor"]).clone();
        let summary = format!("{}: цель получает урон ({}).", js::s(hazard.get("label")), js::s(Some(&expression)));
        return ImprovisedPlan {
            effect: effect.clone(),
            hazard: Some(hazard.clone()),
            rejected: None,
            commands: vec![json!({
                "command_type": "ApplyDamage",
                "actor_id": actor,
                "target_id": target,
                "expression": expression,
                "damage_type": hazard["damage_type"],
                "source": format!("improvised:{}", js::s(hazard.get("id"))),
            })],
            summary,
        };
    }
    let mut command = Map::new();
    command.insert("command_type".into(), json!("AddCondition"));
    command.insert("actor_id".into(), Value::String(actor));
    command.insert("target_id".into(), Value::String(target));
    insert_raw(&mut command, "condition", effect.get("condition"));
    if let Some(duration) = effect.get("duration").filter(|duration| js::truthy(Some(duration))) {
        command.insert("duration".into(), duration.clone());
    }
    command.insert("source".into(), json!("improvised-action"));
    ImprovisedPlan { commands: vec![Value::Object(command)], ..ImprovisedPlan::plain(effect) }
}

/// Цена хода импровизации (`resolveActionCost`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ActionCost {
    pub cost: &'static str,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot: Option<&'static str>,
}

/// `resolveActionCost(state, actorId, requestedCost)` — цена хода. Модель
/// предлагает слот, но потратить можно только свободный: если действие уже
/// израсходовано, импровизация не проходит — как за столом. `None` —
/// `undefined`.
pub fn resolve_action_cost(state: &Value, actor_id: Option<&Value>, requested_cost: Option<&Value>) -> ActionCost {
    let combat = prop(state.get("mechanics"), "combat");
    if !js::truthy(prop(combat, "active")) {
        return ActionCost { cost: "free", available: true, slot: None };
    }
    let requested = js::string(requested_cost);
    let cost = ACTION_COSTS.iter().copied().find(|cost| *cost == requested).unwrap_or("action");
    if cost == "free" {
        return ActionCost { cost, available: true, slot: Some("свободное взаимодействие") };
    }
    let economy = prop(prop(combat, "action_economy"), &js::string(actor_id));
    if cost == "bonus_action" {
        return ActionCost { cost, available: !js::is_false(prop(economy, "bonus_action")), slot: Some("бонусное действие") };
    }
    ActionCost { cost, available: !js::is_false(prop(economy, "action")), slot: Some("действие") }
}

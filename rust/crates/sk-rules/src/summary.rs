//! Сводка событий `eventSummary` и подстановка имён `actorNameResolver`.
//! Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 27251–27502.
//!
//! Тексты — байт в байт с JS: шаблонная строка `${x}` печатает значение как
//! `String(x)` (`undefined`, `null`, числа без `.0`, массивы через запятую,
//! объекты — `[object Object]`). Отсутствующее поле — `None` (`undefined`).
//! Там, где JS на мусорном payload бросил бы `TypeError` (`.map` у
//! не-массива, поле у `null`-элемента), Rust печатает тот же текст, что и для
//! пустого или отсутствующего значения: сводка — летопись, и роняться ей не на чем.

use serde_json::Value;
use sk_core::indexmap::IndexMap;
use sk_core::js;
use sk_core::text;

/// Значение JS: `None` — `undefined`.
type V = Option<Value>;

/// Подстановка `actor_id → имя` (`actorNameResolver(state)`).
#[derive(Debug, Clone, Default)]
pub struct NameResolver {
    names: IndexMap<String, String>,
}

impl NameResolver {
    /// `(id) => names.get(String(id ?? '')) ?? id`.
    pub fn resolve(&self, id: Option<&Value>) -> Option<Value> {
        match self.names.get(&js::s(id)) {
            Some(name) => Some(Value::String(name.clone())),
            None => id.cloned(),
        }
    }
}

/// `actorNameResolver(state)`: имена героев, существ и собеседников сцены.
pub fn actor_name_resolver(state: &Value) -> NameResolver {
    let mut names = IndexMap::new();
    let list = |key: &str| state.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    for actor in list("players").iter().chain(list("enemies").iter()).chain(list("actors").iter()) {
        let id = match actor.get("id").filter(|value| !value.is_null()) {
            Some(id) => js::s(Some(id)),
            None => js::s(actor.get("actor_id")),
        };
        let name = if js::truthy(actor.get("character")) {
            js::string(actor.get("character"))
        } else if js::truthy(actor.get("name")) {
            js::string(actor.get("name"))
        } else {
            String::new()
        };
        if !id.is_empty() && !name.is_empty() {
            names.insert(id, name);
        }
    }
    let npcs = state.get("social").and_then(|social| social.get("npcs")).and_then(Value::as_array).cloned().unwrap_or_default();
    for npc in &npcs {
        let id = js::s(npc.get("id"));
        let name = js::s(npc.get("name"));
        if !id.is_empty() && !name.is_empty() && !names.contains_key(&id) {
            names.insert(id, name);
        }
    }
    NameResolver { names }
}

/// `eventSummary(event)` без подстановки имён (`resolveName = (id) => id`).
pub fn event_summary_plain(event: &Value) -> String {
    event_summary(event, &|id: Option<&Value>| id.cloned())
}

/// `eventSummary(event, resolver)` с подстановкой имён состояния.
pub fn event_summary_named(event: &Value, resolver: &NameResolver) -> String {
    event_summary(event, &|id: Option<&Value>| resolver.resolve(id))
}

// --- значения JS ----------------------------------------------------------------

/// `${value}`.
fn t(value: &V) -> String {
    js::string(value.as_ref())
}

fn truthy(value: &V) -> bool {
    js::truthy(value.as_ref())
}

fn present(value: &V) -> bool {
    js::present(value.as_ref())
}

/// `a || b`.
fn or(a: V, b: V) -> V {
    if truthy(&a) {
        a
    } else {
        b
    }
}

/// `a ?? b`.
fn nn(a: V, b: V) -> V {
    if present(&a) {
        a
    } else {
        b
    }
}

fn s(text: &str) -> V {
    Some(Value::String(text.into()))
}

/// `${a || 'запас'}`.
fn or_text(a: V, fallback: &str) -> String {
    t(&or(a, s(fallback)))
}

/// `value?.key` (поле есть только у объекта).
fn at(value: &V, key: &str) -> V {
    value.as_ref().and_then(|value| value.as_object()).and_then(|map| map.get(key)).cloned()
}

/// `safeInteger(value, fallback)`.
fn int(value: &V, fallback: i64) -> i64 {
    js::safe_int(value.as_ref(), fallback)
}

/// `Number(value)`.
fn number(value: &V) -> f64 {
    js::number(value.as_ref())
}

/// `(value ?? []).length`.
fn length(value: &V) -> V {
    match value {
        None | Some(Value::Null) => Some(Value::from(0)),
        Some(Value::Array(items)) => Some(Value::from(items.len())),
        Some(Value::String(text)) => Some(Value::from(text.encode_utf16().count())),
        Some(_) => None,
    }
}

/// `(value ?? [])[0]`.
fn first(value: &V) -> V {
    match value {
        Some(Value::Array(items)) => items.first().cloned(),
        Some(Value::String(text)) => text.encode_utf16().next().map(|unit| Value::String(String::from_utf16_lossy(&[unit]))),
        _ => None,
    }
}

/// Элементы `(value ?? [])` для `.map`; не-массив — пусто.
fn items(value: &V) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

/// `Array.prototype.join(separator)`: `null` и `undefined` — пустая строка.
fn join(values: &[V], separator: &str) -> String {
    values.iter().map(|value| js::s(value.as_ref())).collect::<Vec<_>>().join(separator)
}

/// Свойства `Object.prototype`, которые находит поиск по ключу в литерале
/// объекта (`{ … }[key]`), и их `String(…)`.
fn prototype_member_text(key: &str) -> Option<String> {
    match key {
        "constructor" => Some("function Object() { [native code] }".into()),
        "__proto__" => Some("[object Object]".into()),
        "__defineGetter__" | "__defineSetter__" | "hasOwnProperty" | "__lookupGetter__" | "__lookupSetter__" | "isPrototypeOf" | "propertyIsEnumerable" | "toString" | "valueOf" | "toLocaleString" => {
            Some(format!("function {key}() {{ [native code] }}"))
        }
        _ => None,
    }
}

/// `({ … })[key]` для литерала-таблицы: значение таблицы, свойство прототипа
/// текстом или `None`.
fn table_lookup(table: &[(&str, &str)], key: &V) -> V {
    let key = t(key);
    if let Some((_, label)) = table.iter().find(|(name, _)| *name == key) {
        return s(label);
    }
    prototype_member_text(&key).map(Value::String)
}

/// Суффиксы спасброска: предмет, Аура защиты, Несгибаемый.
fn save_suffixes(payload: &V, aura: bool) -> String {
    let mut text = String::new();
    if truthy(&at(payload, "item_saving_throw_bonus")) {
        text.push_str(&format!(" (предмет +{})", t(&at(payload, "item_saving_throw_bonus"))));
    }
    if aura && truthy(&at(payload, "aura_of_protection_bonus")) {
        text.push_str(&format!(" (Аура защиты +{})", t(&at(payload, "aura_of_protection_bonus"))));
    }
    if truthy(&at(payload, "indomitable_bonus")) {
        text.push_str(&format!(" (Несгибаемый +{}; исходный итог {})", t(&at(payload, "indomitable_bonus")), t(&at(payload, "indomitable_original_total"))));
    }
    text
}

const TIME_UNITS: [(&str, &str); 5] = [("second", "сек."), ("minute", "мин."), ("hour", "ч."), ("day", "дн."), ("round", "раунд.")];

/// `eventSummary(event, resolveName)`: строка летописи. `resolve_name`
/// получает `None` для `undefined`.
pub fn event_summary(event: &Value, resolve_name: &dyn Fn(Option<&Value>) -> Option<Value>) -> String {
    let raw_payload = event.get("payload").filter(|value| !value.is_null()).cloned();
    let payload: V = Some(raw_payload.unwrap_or_else(js::obj));
    let p = |key: &str| at(&payload, key);
    let named = |id: V| -> V {
        match &id {
            None | Some(Value::Null) => id,
            Some(Value::String(text)) if text.is_empty() => id,
            Some(value) => resolve_name(Some(value)),
        }
    };
    let ev = |key: &str| event.get(key).cloned();
    let actor = || named(ev("actor_id"));
    let target0 = || named(first(&nn(ev("target_ids"), Some(Value::Array(Vec::new())))));
    let event_type = event.get("event_type").cloned();
    let kind = event_type.as_ref().and_then(Value::as_str).unwrap_or("");
    match kind {
        "CampaignHouseRuleChanged" => format!("Домашнее правило {} {}", t(&p("house_rule_id")), if truthy(&p("enabled")) { "включено" } else { "выключено" }),
        "OpeningStrikeEconomyRestored" => "Удар вне очереди не отнял ход: инициатива брошена, ход начинается заново".into(),
        "CampaignRulesetChanged" => format!("Правила кампании изменены: {} · {}", t(&p("ruleset_id_after")), t(&p("ruleset_version_after"))),
        "LocationMapImported" => {
            let format_value = at(&p("source"), "format");
            let name = t(&or(p("location_name"), p("location_id")));
            if format_value.as_ref().and_then(Value::as_str) == Some("scene-program-rebuild") {
                format!("Ведущий перестроил карту «{name}» по описанию сцены")
            } else if format_value.as_ref().and_then(Value::as_str) == Some("scene-floor-refresh") {
                format!("Ведущий обновил покрытия карты «{name}»")
            } else {
                let levels = match p("levels") {
                    Some(Value::Array(levels)) => levels.len(),
                    _ => 0,
                };
                format!("Ведущий загрузил карту «{name}»: {levels} эт.")
            }
        }
        "MapLevelChanged" => {
            let direction = if number(&p("to_level")) > number(&p("from_level")) { "Партия поднимается" } else { "Партия спускается" };
            let label = if truthy(&p("level_label")) { t(&p("level_label")) } else { format!("этаж {}", t(&p("to_level"))) };
            format!("{direction}: {label}")
        }
        "SceneObjectOperated" => format!("{} взаимодействует с объектом {}: {}", or_text(actor(), "Герой"), t(&p("prop_id")), t(&p("intent"))),
        "SceneObjectCheckResolved" => format!(
            "{} проверяет объект {}: {} ({}/{})",
            or_text(actor(), "Герой"),
            t(&p("prop_id")),
            if truthy(&p("success")) { "успех" } else { "неудача" },
            t(&p("total")),
            t(&p("difficulty"))
        ),
        "SceneObjectInspected" => format!("{} осматривает объект {}", or_text(actor(), "Герой"), t(&p("prop_id"))),
        "SceneObjectUseRecorded" => format!("{} использует объект {}", or_text(actor(), "Герой"), t(&p("prop_id"))),
        "SceneObjectKnowledgeRevealed" => {
            if truthy(&p("text")) {
                t(&p("text"))
            } else {
                format!("Открыта деталь объекта {}", t(&p("prop_id")))
            }
        }
        "SceneObjectStateChanged" => {
            if p("success") == Some(Value::Bool(false)) {
                format!("Состояние объекта {} не изменилось", t(&p("prop_id")))
            } else {
                format!("Объект {}: {} → {}", t(&p("prop_id")), or_text(p("previous_state"), "idle"), t(&p("state")))
            }
        }
        "SceneObjectLootGranted" => format!("{} забирает находку из объекта {}", or_text(actor(), "Герой"), t(&p("prop_id"))),
        "SceneObjectLootRevealed" => format!("В объекте {} обнаружена находка", t(&p("prop_id"))),
        "SceneObjectEffectApplied" => format!("{} получает эффект объекта {}", or_text(actor(), "Герой"), t(&p("prop_id"))),
        "PartyDecisionOpened" => format!("Party decision opened: {}", t(&or(at(&p("interaction"), "title"), at(&p("interaction"), "id")))),
        "PartyVoteCast" => format!("{} voted for {}", t(&or(p("hero_id"), ev("actor_id"))), t(&p("option_id"))),
        "PartyDecisionAbstained" => format!("{} abstained ({})", or_text(or(or(p("hero_id"), p("voter_id")), ev("actor_id")), "Участник"), or_text(p("reason"), "abstain")),
        "PartyDecisionResolved" => format!("Party decision resolved: {}", t(&p("resolved_option_id"))),
        "PartyDecisionExpired" => format!("Party decision expired: {}", t(&p("resolved_option_id"))),
        "PartyDecisionConsumed" => format!("Party decision consumed: {}", t(&p("resolved_option_id"))),
        "NpcSocialProfileUpserted" => format!("NPC profile updated: {}", t(&or(at(&p("npc"), "name"), at(&p("npc"), "id")))),
        "NpcConversationRecorded" => format!("Conversation recorded with {}", t(&at(&p("conversation"), "npc_id"))),
        "NpcRelationshipAdjusted" => format!("NPC relationship changed by {}: {} -> {}", t(&p("delta")), or_text(p("tier_before"), "neutral"), or_text(p("tier_after"), "neutral")),
        "NpcRelationshipTierChanged" => format!("NPC relationship tier changed: {} -> {}", t(&p("tier_before")), t(&p("tier_after"))),
        "NpcPromiseRecorded" => format!("NPC promise recorded: {}", t(&or(at(&p("promise"), "text"), at(&p("promise"), "id")))),
        "NpcPromiseResolved" => format!("NPC promise {} resolved as {}", t(&p("promise_id")), t(&p("status"))),
        "NpcPlaced" => format!("{} занимает пост в сцене", t(&or(p("npc_name"), p("npc_id")))),
        "NpcMoved" => format!("{} меняет пост в сцене", t(&or(p("npc_name"), p("npc_id")))),
        "NpcHarmed" => format!("{} получает урон", t(&or(p("npc_name"), p("npc_id")))),
        "NpcDied" => format!("{} погибает", t(&or(p("npc_name"), p("npc_id")))),
        "NpcStanceChanged" => format!("{}: стойка {}", t(&or(p("npc_name"), p("npc_id"))), t(&p("stance"))),
        "WorldEntityUpserted" => format!("World entity updated: {}", t(&or(at(&p("entity"), "name"), at(&p("entity"), "id")))),
        "WorldFactRecorded" => format!("World fact recorded: {}", t(&or(or(at(&p("fact"), "summary"), at(&p("fact"), "object")), at(&p("fact"), "id")))),
        "WorldFactRevealed" => format!("Fact {} revealed to {} heroes", t(&p("fact_id")), t(&length(&ev("target_ids")))),
        "QuestUpserted" => format!("Quest updated: {}", t(&or(at(&p("quest"), "title"), at(&p("quest"), "id")))),
        "QuestClockAdvanced" => format!("Quest clock {} advanced by {}", t(&p("quest_id")), t(&p("amount"))),
        "QuestResolved" => format!("Квест {} завершён: {}", t(&p("quest_id")), t(&or(p("summary"), p("outcome")))),
        "QuestInvalidated" | "QuestAssignmentChanged" => t(&or(p("summary"), s(""))),
        "OfficeVacated" => format!("Должность «{}» освободилась", t(&p("title"))),
        "OfficeHolderInstalled" => format!("Должность «{}» получила нового держателя", t(&p("title"))),
        "OfficeSuccessionSkipped" => String::new(),
        "CampaignPacingAdvanced" => format!("Темп кампании: {}, напряжение {}", or_text(p("phase"), "development"), t(&nn(p("tension_after"), Some(Value::from(0))))),
        "TravelResolved" => format!(
            "Отряд завершил путь из {} в {} за {} мин.",
            or_text(p("from"), "предыдущей локации"),
            or_text(p("to"), "новую локацию"),
            t(&or(p("duration_minutes"), Some(Value::from(0))))
        ),
        "DowntimeResolved" => format!("Передышка завершена: {}, {} мин.", or_text(p("kind"), "downtime"), t(&or(p("duration_minutes"), Some(Value::from(0))))),
        "RandomEncounterTriggered" => format!("В пути возникла случайная встреча: {} ({})", or_text(p("theme"), "unknown"), or_text(p("difficulty"), "medium")),
        "SceneAdvanced" => format!(
            "Сцена перемещена из {} в {}",
            or_text(p("location_before"), "прежней локации"),
            or_text(or(p("location_after"), at(&p("scene"), "location")), "новую локацию")
        ),
        "EncounterCreated" => {
            let enemies = items(&nn(at(&p("encounter"), "enemies"), Some(Value::Array(Vec::new()))));
            let names: Vec<V> = enemies.iter().map(|enemy| at(&Some(enemy.clone()), "name")).collect();
            format!("Создано столкновение: {}", join(&names, ", "))
        }
        "EncounterEnded" => format!("Столкновение завершено: {}", sk_narration::combat_narration::encounter_end_text(or(p("reason"), p("outcome")).as_ref())),
        "EncounterOutcomeRecorded" => format!("Исход встречи подтверждён сервером: {}", sk_narration::combat_narration::encounter_end_text(p("outcome").as_ref())),
        "EncounterCoinsRolled" => format!("С противников собрано {} мм", int(&p("total_cp"), 0)),
        "ServerLootGenerated" => {
            let loot = items(&nn(p("loot"), Some(Value::Array(Vec::new()))));
            let lines: Vec<V> = loot
                .iter()
                .map(|item| {
                    let item = Some(item.clone());
                    s(&format!("{} ×{}", t(&at(&item, "name")), t(&nn(at(&item, "quantity"), Some(Value::from(1))))))
                })
                .collect();
            let text = join(&lines, ", ");
            format!("Найдена добыча: {}", if text.is_empty() { "нет предметов".to_string() } else { text })
        }
        "EncounterRewardsDistributed" => {
            let allocations = items(&nn(p("allocations"), Some(Value::Array(Vec::new()))));
            let names: Vec<V> = allocations.iter().map(|allocation| named(at(&Some(allocation.clone()), "recipient_id"))).collect();
            let text = join(&names, ", ");
            format!("Награда распределена между {}", if text.is_empty() { "никем; всё осталось нераспределённым".to_string() } else { text })
        }
        "CombatStarted" => format!("Бой начался; инициатива определена для {} участников", t(&length(&ev("target_ids")))),
        "ActorMoved" => format!("{} перемещается на {} фт.", or_text(actor(), "Участник"), int(&p("distance"), 0)),
        "TurnEnded" => format!("{} завершает ход", or_text(actor(), "Участник")),
        "TurnStarted" => format!("Начинается ход {}, раунд {}", or_text(target0(), "следующего участника"), int(&p("round"), 1)),
        "DieRolled" => format!("Бросок {}: {}", or_text(p("expression"), "кости"), int(&p("total"), 0)),
        "DamageApplied" => {
            if truthy(&p("death_ward_triggered")) {
                format!("Урон: {}; Death Ward удерживает цель на 1 HP", t(&p("applied_amount")))
            } else if truthy(&p("relentless_endurance_triggered")) {
                format!("Урон: {}; Непоколебимая стойкость удерживает цель на 1 ОЗ", t(&p("applied_amount")))
            } else if truthy(&p("item_damage_rider")) {
                format!("{} наносит дополнительно {} урона ({})", or_text(p("item_name"), "Магический предмет"), t(&p("applied_amount")), t(&p("damage_type")))
            } else if truthy(&p("resistance_cantrip_reduction")) {
                format!("Урон снижен Resistance на {}; HP {} → {}", t(&p("resistance_cantrip_reduction")), t(&p("hp_before")), t(&p("hp_after")))
            } else {
                format!("Урон: {}; HP {} → {}", t(&p("applied_amount")), t(&p("hp_before")), t(&p("hp_after")))
            }
        }
        "SneakAttackApplied" => format!("Коварная атака: дополнительно {} урона ({})", int(&p("damage"), 0), t(&p("expression"))),
        "SpellImmunityResolved" => format!("{} полностью защищает от заклинания {}", or_text(at(&first(&p("item_immunity_sources")), "item_name"), "Магический предмет"), t(&p("spell_id"))),
        "ItemEffectIneffective" => format!("{} не действует на {}", or_text(p("item_name"), "Предмет"), or_text(target0(), "цель")),
        "HealingApplied" => format!("Лечение: {}; HP {} → {}", t(&p("applied_amount")), t(&p("hp_before")), t(&p("hp_after"))),
        "NpcItemUsed" => format!("{} {}", or_text(actor(), "Существо"), or_text(p("label"), "пускает в ход своё снаряжение")),
        "NpcEquipmentSpent" => {
            if p("reason").as_ref().and_then(Value::as_str) == Some("ammunition") {
                format!("Боеприпасы {}: осталось {}", or_text(actor(), "существа"), int(&p("shots_after"), 0))
            } else {
                format!("{} расстаётся с предметом «{}»", or_text(actor(), "Существо"), t(&nn(p("item_name"), p("catalog_id"))))
            }
        }
        "AmmunitionSpent" => {
            let owner = or_text(named(nn(p("owner_id"), ev("actor_id"))), "Герой");
            let item = t(&nn(p("item_name"), p("catalog_id")));
            if int(&p("shots_after"), 0) > 0 {
                format!("{owner} тратит боеприпас «{item}»: осталось {}", int(&p("shots_after"), 0))
            } else {
                format!("{owner} выпускает последний боеприпас «{item}»: колчан пуст")
            }
        }
        "HitPointMaximumReduced" => format!("Максимум HP снижен: {} → {}", t(&p("maximum_hp_before")), t(&p("maximum_hp_after"))),
        "HitPointMaximumIncreased" => format!("Максимум HP поднят: {} → {}", t(&p("maximum_hp_before")), t(&p("maximum_hp_after"))),
        "HitPointMaximumReductionPrevented" => "Aura of Life предотвращает снижение максимума HP".into(),
        "AttackResolved" => format!(
            "Атака {}: {} против КД {}{}",
            if truthy(&p("hit")) { "попала" } else { "не попала" },
            t(&p("total")),
            t(&p("armor_class")),
            if truthy(&p("critical_prevented")) { "; критическое попадание стало обычным" } else { "" }
        ),
        "AreaAttackResolved" => format!("{} поражает область радиусом {} фт.", or_text(p("item_name"), "Снаряд"), t(&p("radius_feet"))),
        "EquipmentChanged" => format!("{} экипировано", or_text(p("item_name"), "Оружие")),
        "MagicItemActivationChanged" => format!("{} магический предмет {}", if truthy(&p("activated")) { "Активирован" } else { "Выключен" }, t(&p("item_id"))),
        "CombatActionUsed" => format!("{} использует {}", or_text(actor(), "Участник"), or_text(or(p("name"), p("action_id")), "боевое действие")),
        "MerchantBargainResolved" => {
            if truthy(&p("success")) {
                "Торговец согласился изменить условия сделки".into()
            } else {
                "Торговец отказался уступать в цене".into()
            }
        }
        "MerchantItemAppraised" => format!("Торговец оценил предмет «{}» в {} мм", t(&nn(p("item_name"), p("item_id"))), t(&nn(p("base_unit_price_cp"), Some(Value::from(0))))),
        "MerchantPurchaseCompleted" => format!(
            "Покупка: {}, {} шт. за {} мм.",
            or_text(or(at(&p("item"), "name"), p("catalog_id")), "предмет"),
            t(&p("quantity")),
            t(&p("total_price_cp"))
        ),
        "MerchantServicePurchased" => format!("Услуга: {} за {} мм.", or_text(or(p("service_name"), p("service_id")), "услуга"), t(&p("total_price_cp"))),
        "MerchantSaleCompleted" => format!(
            "Продажа: {}, {} шт. за {} мм.",
            or_text(or(at(&p("item"), "name"), p("catalog_id")), "предмет"),
            t(&p("quantity")),
            t(&p("total_price_cp"))
        ),
        "MerchantCreated" => format!("Создан торговец {}", t(&or(at(&p("merchant"), "name"), p("merchant_id")))),
        "MerchantConfigured" => format!("Обновлены настройки торговца {}", t(&p("merchant_id"))),
        "MerchantRestocked" => format!("Склад торговца {} пополнен на {} ед.", t(&p("merchant_id")), int(&p("total_quantity_added"), 0)),
        sk_economy::merchant_economy::MERCHANT_ECONOMY_CLOCK_EVENT_TYPE => {
            format!("Экономические часы торговца {} переведены на {} минуту", t(&p("merchant_id")), int(&p("processed_at_world_minute"), 0))
        }
        "MerchantMoved" => format!("Торговец {} перемещён в {}", t(&p("merchant_id")), t(&p("location_after"))),
        "MerchantAvailabilityChanged" => format!("Торговец {} {}", t(&p("merchant_id")), if truthy(&p("available_after")) { "доступен" } else { "недоступен" }),
        "AbilityCheckResolved" => format!("Проверка {}: {} против СЛ {}", t(&p("ability")), t(&p("total")), t(&p("difficulty"))),
        "SavingThrowResolved" => format!("Спасбросок {}: {} против СЛ {}{}", t(&p("ability")), t(&p("total")), t(&p("difficulty")), save_suffixes(&payload, true)),
        "SpellSavingThrowResolved" => format!(
            "Спасбросок от {}: {} против СЛ {} — {}{}",
            or_text(p("spell_id"), "заклинания"),
            t(&p("total")),
            t(&p("difficulty")),
            if truthy(&p("saved")) { "успех" } else { "провал" },
            save_suffixes(&payload, false)
        ),
        "ConcentrationSavingThrowResolved" => format!(
            "Концентрация: {} против СЛ {} — {}{}",
            t(&p("total")),
            t(&p("difficulty")),
            if truthy(&p("saved")) { "сохранена" } else { "потеряна" },
            save_suffixes(&payload, true)
        ),
        "ConcentrationEnded" => format!("Концентрация прекращена: {}", or_text(p("reason"), "эффект завершён")),
        "ResourceSpent" => format!("{}: {} → {}", t(&p("resource")), t(&p("before")), t(&p("after"))),
        "EnemyKnowledgeRevealed" => format!("{} опознан: отряд знает точные ОЗ и КД", t(&resolve_name(p("enemy_id").as_ref()))),
        "ConditionAdded" => format!("Добавлено состояние: {}", t(&p("condition"))),
        "ConditionImmunityResolved" => format!("{} невосприимчиво: состояние {} не наложено", or_text(target0(), "Существо"), t(&p("condition"))),
        "MonsterAbilityRecharged" => format!("{}: «{}» снова наготове", or_text(target0(), "Существо"), t(&or(p("name"), p("action_id")))),
        "NpcBribeOffered" => {
            if p("insulted") == Some(Value::Bool(true)) {
                format!("{} протягивает монету — и её отталкивают", or_text(actor(), "Герой"))
            } else {
                format!("{} подкрепляет слова монетой", or_text(actor(), "Герой"))
            }
        }
        "NpcBribeRefused" => format!("{} не берёт денег", or_text(target0(), "Собеседник")),
        "MerchantRefusedStolenGoods" => format!("{} отказывается брать вещь: «{}»", or_text(p("merchant_name"), "Торговец"), or_text(p("item_name"), "предмет")),
        "MerchantDenouncedThief" => format!("{} отправляет весточку страже", or_text(p("merchant_name"), "Торговец")),
        "DoorLockpicked" => {
            if p("success") == Some(Value::Bool(true)) {
                format!("{} вскрывает замок отмычкой: дверь взломана", or_text(actor(), "Герой"))
            } else {
                format!("{} не справляется с замком двери", or_text(actor(), "Герой"))
            }
        }
        "LockpickNoticed" => {
            if p("reason").as_ref().and_then(Value::as_str) == Some("trace") {
                format!("Сорванный замок замечен: {}", or_text(p("target_label"), "чужой замок"))
            } else {
                format!("Возню у замка услышали: {}", or_text(p("target_label"), "чужой замок"))
            }
        }
        "NpcPocketPicked" => format!("{} незаметно обчищает карман: {}", or_text(actor(), "Герой"), or_text(p("npc_name"), "прохожий")),
        "NpcPickpocketNoticed" => format!("{} перехватывает чужую руку у своего кармана", or_text(p("npc_name"), "Прохожий")),
        "LegendaryActionUsed" => format!("{} вне очереди: «{}»", or_text(actor(), "Существо"), t(&or(p("name"), p("action_id")))),
        "LegendaryActionsReset" => format!("{} снова полно сил: легендарные действия восстановлены", or_text(target0(), "Существо")),
        "LegendaryResistanceUsed" => format!("{} стряхивает с себя чары — легендарная стойкость", or_text(target0(), "Существо")),
        "ConditionRemoved" => format!("Снято состояние: {}", t(&p("condition"))),
        "HitPointsReducedToZero" => format!("{} выбывает из боя", or_text(target0(), "Цель")),
        "DeathSavingThrowRolled" => format!(
            "Спасбросок от смерти {}: {} — {}{}",
            or_text(target0(), "героя"),
            t(&p("natural_roll")),
            t(&p("result")),
            save_suffixes(&payload, true)
        ),
        "DeathSaveFailureRecorded" => format!("{} получает {} провал спасброска от смерти из-за урона", or_text(target0(), "Герой"), t(&or(p("failure_increment"), Some(Value::from(1))))),
        "HeroStabilized" => format!("{} стабилизирован", or_text(or(p("hero_name"), target0()), "Герой")),
        "CreatureKnockedOut" => format!("{} нокаутировано и начинает короткий отдых", or_text(target0(), "Существо")),
        "KnockoutRecoveryProgressed" => format!("До пробуждения {} осталось {} мин.", or_text(target0(), "существа"), t(&or(p("recovery_minutes_remaining"), Some(Value::from(0))))),
        "KnockoutEnded" => format!("{} приходит в сознание после первой помощи", or_text(target0(), "Существо")),
        "StableRecoveryScheduled" => format!("{} восстановит 1 ОЗ через {} ч.", or_text(target0(), "Герой"), t(&or(p("recovery_hours"), Some(Value::from(1))))),
        "StableRecoveryProgressed" => format!("До восстановления {} осталось {} мин.", or_text(target0(), "героя"), t(&or(p("recovery_minutes_remaining"), Some(Value::from(0))))),
        "HeroDied" => format!("{} погибает", or_text(or(p("hero_name"), target0()), "Герой")),
        "HeroResurrected" => format!("{} возвращается к жизни", or_text(target0(), "Герой")),
        "CharacterImported" => format!("{} присоединяется к отряду", or_text(or(at(&p("character"), "character"), target0()), "Герой")),
        "HeroReplaced" => format!("{} присоединяется к группе", or_text(p("replacement_name"), "Новый герой")),
        "RestStarted" => format!("{} начинает {} отдых", or_text(actor(), "Герой"), if p("kind").as_ref().and_then(Value::as_str) == Some("long") { "продолжительный" } else { "короткий" }),
        "RestCompleted" => format!("{} завершает {} отдых", or_text(actor(), "Герой"), if p("kind").as_ref().and_then(Value::as_str) == Some("long") { "продолжительный" } else { "короткий" }),
        "RulingRecorded" => "Для действия сохранён ограниченный следующий шаг.".into(),
        "ObjectiveUpdated" => format!("Цель отряда: {}", or_text(p("objective"), "следующий шаг не задан")),
        "ActionDeclared" => "Намерение героя принято к рассмотрению.".into(),
        "SwingResolved" => {
            if p("success") == Some(Value::Bool(true)) {
                "Раскачка на люстре удалась; герой продолжает движение к цели.".into()
            } else {
                "Герой срывается при попытке ухватиться за люстру и падает ничком у опоры; удар не происходит.".into()
            }
        }
        "TimeAdvanced" => {
            let unit = nn(nn(table_lookup(&TIME_UNITS, &p("unit")), p("unit")), s("мин."));
            format!("Проходит {} {}", t(&or(p("amount"), Some(Value::from(0)))), t(&unit))
        }
        sk_world_story::offscreen_world::OFFSCREEN_WORLD_EVENT_TYPE => {
            let lines: Vec<V> = items(&nn(at(&p("step"), "lines"), Some(Value::Array(Vec::new())))).into_iter().map(Some).collect();
            let text = join(&lines, " ");
            format!("Пока отряда не было: {}", if text.is_empty() { "мир сделал свой ход".to_string() } else { text })
        }
        "TimeOfDayChanged" => {
            let text = format!("{} — {}, день {}", or_text(p("phase_label"), "Время суток сменилось"), or_text(p("clock"), ""), int(&p("day"), 1));
            text::trim(&text).to_string()
        }
        "WeatherChanged" => format!(
            "Погода сменилась: {}{}",
            or_text(or(p("weather_label"), p("weather_after")), "неизвестно"),
            if truthy(&p("region_name")) { format!(" ({})", t(&p("region_name"))) } else { String::new() }
        ),
        "CombatEnded" => format!("Бой завершён в раунде {}", t(&p("round"))),
        "CaptiveTaken" => format!("{} становится пленником отряда", or_text(at(&p("captive"), "name"), "Побеждённый")),
        "CaptiveInterrogated" => format!("Допрос пленного: {} (СЛ {})", if p("success") == Some(Value::Bool(true)) { "успех" } else { "провал" }, t(&p("difficulty"))),
        "CaptiveFed" => "Пленного накормили".into(),
        "CaptiveNeglected" => format!("Пленный {} ч без еды", t(&p("hours_without_food"))),
        "CaptiveReleased" => format!("{} отпущен", or_text(target0(), "Пленный")),
        "CaptiveHandedOver" => format!("Пленный передан страже «{}»", or_text(p("settlement_name"), "")),
        "CaptiveExecuted" => format!("{} убит связанным", or_text(p("captive_name"), "Пленный")),
        "CaptiveMoved" => "Пленного увели с отрядом".into(),
        "BeastEncountered" => format!("{}: к нему подошли без оружия", or_text(at(&p("beast"), "name"), "Зверь")),
        "BeastSoothingResolved" => format!("Уход за животными: {} (СЛ {})", if p("success") == Some(Value::Bool(true)) { "успех" } else { "провал" }, t(&p("difficulty"))),
        "BeastBit" => format!("{} кусает: {} урона", or_text(p("beast_name"), "Зверь"), t(&p("amount"))),
        "BeastFed" => format!("{} накормили с руки ({})", or_text(p("beast_name"), "Зверя"), or_text(p("item_name"), "паёк")),
        "BeastTamed" => format!("{} идёт с отрядом", or_text(p("beast_name"), "Зверь")),
        "BeastMoved" => format!("{} следует за отрядом", or_text(p("beast_name"), "Спутник")),
        "BeastScaredThreat" => format!("{} отогнал мелкую тварь", or_text(p("beast_name"), "Спутник")),
        "ParleyProposed" => {
            if p("refused") == Some(Value::Bool(true)) {
                "Окрик о переговорах остался без ответа".into()
            } else {
                format!("Попытка переговоров: {} (СЛ {})", if p("success") == Some(Value::Bool(true)) { "услышан" } else { "не услышан" }, t(&p("difficulty")))
            }
        }
        "ParleyRejected" => "Переговоры отвергнуты, бой продолжается".into(),
        "TruceEstablished" => format!("Объявлено перемирие: говорит {}", or_text(at(&p("truce"), "leader_name"), "предводитель")),
        "TruceBroken" => format!("Перемирие нарушено ({})", if p("broken_by").as_ref().and_then(Value::as_str) == Some("enemies") { "противником" } else { "отрядом" }),
        "ParleySettled" => format!("Уговор на переговорах: {}", or_text(or(p("term_label"), p("outcome")), "без условий")),
        "LootContainerCreated" => format!("После схватки остаётся то, что можно обыскать: {}", or_text(at(&p("container"), "name"), "добыча")),
        "LootContainerTaken" => format!("{} забирает добычу из «{}»", or_text(named(p("recipient_id")), "Отряд"), or_text(p("container_name"), "найденного")),
        "GuardEncounterStarted" => {
            let encounter = p("encounter");
            let text = format!(
                "Стража останавливает отряд в «{}»: говорит {} {}",
                or_text(at(&encounter, "place_name"), "поселении"),
                or_text(at(&encounter, "officer_rank"), "стражник"),
                or_text(at(&encounter, "officer_name"), "")
            );
            text::trim(&text).to_string()
        }
        "GuardEncounterResolved" => match p("resolution").as_ref().and_then(Value::as_str) {
            Some("fine") => format!("Вира страже уплачена: {} мм", int(&p("paid_cp"), 0)),
            Some("surrender") => format!(
                "Отряд сдался страже: изъято {} мм, под замком {} ч",
                int(&p("paid_cp"), 0),
                js::f64_string(js::round(int(&p("custody_minutes"), 0) as f64 / 60.0))
            ),
            Some("fight") => "Отряд поднял оружие на стражу".into(),
            _ => format!(
                "Побег от стражи: {} ({} из {}, СЛ {})",
                if p("success") == Some(Value::Bool(true)) { "ушли" } else { "не ушли" },
                int(&p("successes"), 0),
                int(&p("participants"), 0),
                int(&p("difficulty"), 0)
            ),
        },
        "WantedLevelRaised" => format!("Розыск усилен: {}", or_text(or(at(&p("crime"), "summary"), p("reason")), "сопротивление страже")),
        "WantedCleared" => {
            let reason = match p("reason").as_ref().and_then(Value::as_str) {
                Some("fine") => "вира",
                Some("surrender") => "сдача",
                _ => "амнистия",
            };
            format!("Розыск снят в крае «{}» ({reason})", or_text(or(p("region_name"), p("region_id")), ""))
        }
        "TavernDiceRoundOpened" => format!(
            "Кости на стол: {} показывает {}, ставка {} мм ушла на стол",
            or_text(p("npc_name"), "соперник"),
            int(&p("npc_total"), 0),
            int(&p("stake_cp"), 0)
        ),
        "TavernDiceRoundResolved" => {
            let outcome = match p("outcome").as_ref().and_then(Value::as_str) {
                Some("win") => "банк уходит герою",
                Some("loss") => "ставка потеряна",
                Some("push") => "ничья",
                Some("caught") => "героя поймали за руку",
                _ => "соперник разоблачён",
            };
            format!("Раунд костей: {} против {} — {outcome}", int(&p("hero_total"), 0), int(&p("npc_total"), 0))
        }
        "TavernDiceRoundCancelled" => {
            let returned = int(&p("returned_cp"), 0);
            let reason = p("reason");
            let reason = reason.as_ref().and_then(Value::as_str);
            if returned > 0 {
                if reason == Some("patron-ejected") {
                    format!("{} выставили за дверь: раунд закрыт, ставка {returned} мм возвращена", or_text(named(p("hero_id")), "Героя"))
                } else {
                    format!("Раунд {} закрыт до ответа: ставка {returned} мм возвращена", or_text(named(p("hero_id")), "героя"))
                }
            } else if reason == Some("opponent-broke") {
                format!(
                    "{} спустил всё: раунд {} закрыт, ставка {} мм осталась на столе",
                    or_text(p("npc_name"), "Соперник"),
                    or_text(named(p("hero_id")), "героя"),
                    int(&p("forfeited_cp"), 0)
                )
            } else {
                format!("{} встал из-за стола, не ответив: ставка {} мм осталась сопернику", or_text(named(p("hero_id")), "Герой"), int(&p("forfeited_cp"), 0))
            }
        }
        "TavernCheatCaught" => format!("Скандал за столом: {} пойман на шулерстве ({}-й раз)", or_text(named(p("hero_id")), "герой"), int(&p("scandal_count"), 1)),
        "TavernCheatExposed" => format!("{} уличён в шулерстве", or_text(p("npc_name"), "Соперник")),
        "TavernPatronEjected" => format!("{} выставили из заведения", or_text(named(p("hero_id")), "Героя")),
        "TavernDrinkOrdered" => format!("Заказана выпивка: кружка №{} за {} мм", int(&p("drinks"), 1), int(&p("price_cp"), 0)),
        "ShrinePrayerResolved" => {
            let outcome = match p("outcome").as_ref().and_then(Value::as_str) {
                Some("blessed") => "малое благословение получено",
                Some("omen") => "ответа нет, но было знамение",
                _ => "ответа нет",
            };
            format!("Молитва у святыни «{}»: {outcome}", or_text(p("place_name"), "без названия"))
        }
        "NpcBlessingGranted" => format!(
            "{} благословляет {} за пожертвование {} мм",
            or_text(p("npc_name"), "Служитель"),
            or_text(named(p("hero_id")), "героя"),
            int(&p("donation_cp"), 0)
        ),
        "CourierLetterSent" => format!(
            "Письмо к {} отдано курьеру за {} мм ({} перех.)",
            or_text(or(p("addressee_name"), p("addressee_id")), "адресату"),
            int(&p("fee_cp"), 0),
            int(&p("leagues"), 1)
        ),
        "CourierLetterDelivered" => format!(
            "Письмо доставлено: {} прочитал(а){}",
            or_text(or(p("addressee_name"), p("addressee_id")), "адресат"),
            if p("answer_expected") == Some(Value::Bool(false)) { ", ответа не будет" } else { "" }
        ),
        "CourierLetterReturned" => format!("Письмо вернулось: {}", if p("reason").as_ref().and_then(Value::as_str) == Some("dead") { "адресата нет в живых" } else { "адресата не нашли" }),
        "CourierLetterUnanswered" => format!(
            "Ответа от {} не будет: {}",
            or_text(or(p("addressee_name"), p("addressee_id")), "адресата"),
            if p("reason").as_ref().and_then(Value::as_str) == Some("dead") { "адресата нет в живых" } else { "адресата больше не найти" }
        ),
        "CourierLetterAnswered" => format!("Пришёл ответ от {}", or_text(or(p("addressee_name"), p("addressee_id")), "адресата")),
        "ReactionPreferenceChanged" => {
            let label = nn(table_lookup(&crate::constants::REACTION_PREFERENCE_LABELS, &p("reaction_id")), p("reaction_id"));
            let mode = match p("mode").as_ref().and_then(Value::as_str) {
                Some("auto") => "сразу",
                Some("never") => "никогда",
                _ => "спрашивать",
            };
            format!("{}: реакция «{}» — {mode}", or_text(actor(), "Герой"), t(&label))
        }
        _ => t(&event_type),
    }
}

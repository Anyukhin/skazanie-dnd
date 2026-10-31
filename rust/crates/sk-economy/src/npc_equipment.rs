//! Перенос `server/npc-equipment.mjs`: снаряжение противника в бою — чем
//! существо бьёт на самом деле и что оно тратит.
//!
//! Привязка `npc_weapon_binding` связывает боевое действие стат-блока с
//! экземпляром предмета из инвентаря: ради расхода боеприпаса, недоступности
//! действия при потере оружия и яда на конкретном клинке. Привязка не
//! создаётся молча: формула действия обязана совпасть с каталожной (вид, тип
//! урона, кости) или быть объявленным расхождением
//! [`NPC_ATTACK_FORMULA_DEVIATIONS`] с обеими формулами целиком.
//!
//! Расходных тактик ровно три — зелье, склянка, яд ([`NPC_ITEM_TACTICS`]);
//! каждая сверена с каталожным профилем использования, и расхождение закрывает
//! вещь целиком. Модуль — лист: читает каталог и таблицы `enemy_loadouts`,
//! из боевого слоя ничего не берёт.
//!
//! **Ключи прототипа.** `WEAPON_CATALOG_BY_ACTION['constructor']` и
//! `NPC_ITEM_TACTICS['constructor']` в JS находят функции, но дальше у них нет
//! ни боевого профиля, ни профиля использования — привязки и тактики не
//! возникает, как и у неизвестного кода. Только экспорт
//! `npcItemTacticFor('constructor')` в JS отдаёт саму функцию; здесь — `None`.

use serde_json::{json, Map, Value};
use sk_core::{js, re, text, MechanicsSupport};
use sk_items::item_catalog::{catalog_item, item_lifecycle_profile};

use crate::enemy_loadouts::{ammunition_for_weapon, weapon_catalog_for_action};
use crate::support::{array, coalesce, get, is_object_like, js_order, nfkc_text, num, plain, safe_int};

pub const NPC_EQUIPMENT_POLICY_ID: &str = "npc-equipment-v1";
pub const NPC_EQUIPMENT_EVENT_SCHEMA_VERSION: i64 = 1;
/// Ниже этой доли хитов (в процентах, сравнение целыми) существо тянется за зельем.
pub const NPC_HEALING_POTION_HP_PERCENT: i64 = 30;
/// Маркер израсходованной за бой тактики: `npc-tactic-used:<tactic>`.
pub const NPC_TACTIC_CONDITION_PREFIX: &str = "npc-tactic-used:";

/// Объявленное расхождение формулы стат-блока с каталогом.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttackFormulaDeviation {
    /// `<stat_block_id>|<action_id>`.
    pub key: &'static str,
    pub catalog_id: &'static str,
    pub profile_damage: &'static str,
    pub catalog_damage: &'static str,
    pub reason: &'static str,
}

impl AttackFormulaDeviation {
    /// Форма JS: `{ catalog_id, profile_damage, catalog_damage, reason }`.
    pub fn to_json(&self) -> Value {
        json!({ "catalog_id": self.catalog_id, "profile_damage": self.profile_damage, "catalog_damage": self.catalog_damage, "reason": self.reason })
    }
}

const fn deviation(key: &'static str, catalog_id: &'static str, profile_damage: &'static str, catalog_damage: &'static str, reason: &'static str) -> AttackFormulaDeviation {
    AttackFormulaDeviation { key, catalog_id, profile_damage, catalog_damage, reason }
}

/// `NPC_ATTACK_FORMULA_DEVIATIONS`: одиннадцать настоящих расхождений SRD 5.2.1.
pub const NPC_ATTACK_FORMULA_DEVIATIONS: [AttackFormulaDeviation; 11] = [
    deviation("srd_5_2_1:goblin-minion|scimitar", "srd_5_2_1:scimitar", "1d4+2", "1d6", "Гоблин-налётчик — ослабленный вариант стат-блока: скимитар в его руках бьёт меньшей костью, чем базовое оружие."),
    deviation("srd_5_2_1:bugbear|morningstar", "srd_5_2_1:morningstar", "2d8+2", "1d8", "SRD 5.2.1 масштабирует урон существом, а не оружием: у багбира моргенштерн бьёт удвоенной костью."),
    deviation("srd_5_2_1:warrior-veteran|heavy-crossbow", "srd_5_2_1:heavy-crossbow", "2d10+1", "1d10", "Урон дальней атаки ветерана задан стат-блоком и вдвое превышает каталожный арбалет."),
    deviation("srd_5_2_1:guard-captain|longsword", "srd_5_2_1:longsword", "2d10+4", "1d8", "Стат-блок капитана стражи объявляет свой урон длинного меча; каталог описывает вещь, а не удар офицера."),
    deviation("srd_5_2_1:guard-captain|javelin-melee", "srd_5_2_1:javelin", "3d6+4", "1d6", "То же масштабирование: дротик в руке капитана стражи бьёт втрое большей костью."),
    deviation("srd_5_2_1:guard-captain|javelin-ranged", "srd_5_2_1:javelin", "3d6+4", "1d6", "Брошенный дротик капитана стражи наследует урон стат-блока, а не каталожную кость."),
    deviation("srd_5_2_1:knight|heavy-crossbow", "srd_5_2_1:heavy-crossbow", "2d10", "1d10", "Дальняя атака рыцаря объявлена стат-блоком без модификатора характеристики и удвоенной костью."),
    deviation("srd_5_2_1:gladiator|spear-melee", "srd_5_2_1:spear", "2d6+4", "1d6", "Копьё гладиатора бьёт по стат-блоку арены, а не по каталожной кости древкового оружия."),
    deviation("srd_5_2_1:gladiator|spear-ranged", "srd_5_2_1:spear", "2d6+4", "1d6", "Брошенное копьё гладиатора наследует тот же урон стат-блока."),
    deviation("srd_5_2_1:tough-boss|warhammer", "srd_5_2_1:warhammer", "2d8+3", "1d8", "Босс громил бьёт молотом по стат-блоку — удвоенной костью против каталожной."),
    deviation("srd_5_2_1:tough-boss|heavy-crossbow", "srd_5_2_1:heavy-crossbow", "2d10+2", "1d10", "Дальняя атака босса громил задана стат-блоком и вдвое превышает каталожный арбалет."),
];

/// `NPC_ATTACK_FORMULA_DEVIATIONS` как объект JSON.
pub fn npc_attack_formula_deviations_json() -> Value {
    Value::Object(NPC_ATTACK_FORMULA_DEVIATIONS.iter().map(|entry| (entry.key.to_string(), entry.to_json())).collect())
}

/// `NPC_ATTACK_FORMULA_DEVIATIONS[key]`.
pub fn npc_attack_formula_deviation(key: &str) -> Option<&'static AttackFormulaDeviation> {
    NPC_ATTACK_FORMULA_DEVIATIONS.iter().find(|entry| entry.key == key)
}

/// Тактика расходника: что сервер умеет сделать с вещью в ход существа.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NpcItemTactic {
    pub catalog_id: &'static str,
    pub tactic: &'static str,
    pub use_kind: &'static str,
    pub combat_action: &'static str,
    pub once_per_combat: bool,
    pub label: &'static str,
}

impl NpcItemTactic {
    /// Форма JS: `{ tactic, use_kind, combat_action, once_per_combat, label }`.
    pub fn to_json(&self) -> Value {
        json!({ "tactic": self.tactic, "use_kind": self.use_kind, "combat_action": self.combat_action, "once_per_combat": self.once_per_combat, "label": self.label })
    }
}

/// `NPC_ITEM_TACTICS`: закрытый список тактик по каталожным записям.
pub const NPC_ITEM_TACTICS: [NpcItemTactic; 4] = [
    NpcItemTactic { catalog_id: "srd_5_2_1:potion-of-healing", tactic: "heal", use_kind: "healing", combat_action: "bonus_action", once_per_combat: true, label: "прикладывается к склянке" },
    NpcItemTactic { catalog_id: "srd_5_2_1:acid", tactic: "flask", use_kind: "thrown_flask", combat_action: "action", once_per_combat: false, label: "мечет склянку кислоты" },
    NpcItemTactic { catalog_id: "srd_5_2_1:alchemists-fire", tactic: "flask", use_kind: "thrown_flask", combat_action: "action", once_per_combat: false, label: "мечет склянку алхимического огня" },
    NpcItemTactic { catalog_id: "srd_5_2_1:poison-basic", tactic: "coat", use_kind: "coat_weapon", combat_action: "bonus_action", once_per_combat: true, label: "смазывает лезвие ядом" },
];

/// `NPC_ITEM_TACTICS` как объект JSON.
pub fn npc_item_tactics_json() -> Value {
    Value::Object(NPC_ITEM_TACTICS.iter().map(|entry| (entry.catalog_id.to_string(), entry.to_json())).collect())
}

pub const NPC_ITEM_TACTIC_IDS: [&str; 3] = ["heal", "flask", "coat"];

/// Почему действие недоступно → текст для отказа команды.
pub const NPC_ACTION_UNAVAILABLE_MESSAGES: [(&str, &str); 2] = [
    ("weapon-lost", "Существо потеряло оружие этого действия"),
    ("ammunition-spent", "У существа кончились боеприпасы для этого действия"),
];

/// `NPC_ACTION_UNAVAILABLE_MESSAGES` как объект JSON.
pub fn npc_action_unavailable_messages_json() -> Value {
    Value::Object(NPC_ACTION_UNAVAILABLE_MESSAGES.iter().map(|(key, message)| ((*key).to_string(), json!(message))).collect())
}

/// `npcItemTacticFor(catalogId)`.
pub fn npc_item_tactic_for(catalog_id: Option<&Value>) -> Option<&'static NpcItemTactic> {
    let id = nfkc_text(catalog_id, 120);
    NPC_ITEM_TACTICS.iter().find(|entry| entry.catalog_id == id)
}

fn loadout_items(enemy: Option<&Value>) -> &[Value] {
    array(get(get(enemy, "loadout"), "items"))
}

/// `npcLoadoutItem(enemy, itemInstanceId)`: экземпляр из инвентаря, пока он не кончился.
pub fn npc_loadout_item<'a>(enemy: Option<&'a Value>, item_instance_id: Option<&Value>) -> Option<&'a Value> {
    let expected = nfkc_text(item_instance_id, 160);
    if expected.is_empty() {
        return None;
    }
    loadout_items(enemy).iter().find(|item| nfkc_text(get(Some(item), "item_instance_id"), 160) == expected && safe_int(get(Some(item), "quantity"), 1) > 0)
}

/// Кости выражения без плоской добавки: `2d6+4` → `2d6`.
fn damage_dice_of(expression: Option<&Value>) -> String {
    let source = js::s(expression);
    let Ok(Some(captures)) = re!(r"^\s*(\d+)d(\d+)", "u").captures(&source) else {
        return String::new();
    };
    let part = |index: usize| js::f64_string(js::parse_number(captures.get(index).map_or("", |m| m.as_str())));
    format!("{}d{}", part(1), part(2))
}

fn combat_modes(snapshot_combat: Option<&Value>) -> Vec<Value> {
    let Some(combat) = plain(snapshot_combat) else {
        return Vec::new();
    };
    let modes: Vec<Value> = array(combat.get("modes")).iter().filter(|mode| is_object_like(Some(mode))).cloned().collect();
    if !modes.is_empty() {
        return modes;
    }
    // `{ id: combat.kind, ...combat }`.
    let mut single = Map::new();
    // Ключ `id` стоит первым: своё `id` записи перекрывает `kind` на том же месте.
    if let Some(id) = combat.get("id").or_else(|| combat.get("kind")) {
        single.insert("id".into(), id.clone());
    }
    for (key, value) in combat {
        single.insert(key.clone(), value.clone());
    }
    vec![Value::Object(js_order(single))]
}

fn profile_kind(profile: Option<&Value>) -> &'static str {
    if js::string(get(profile, "kind")) == "ranged" {
        "ranged"
    } else {
        "melee"
    }
}

fn mode_damage_type(mode: &Value) -> String {
    text::lower(&nfkc_text(get(Some(mode), "damageType"), 40))
}

fn matching_mode(profile: Option<&Value>, snapshot_combat: Option<&Value>) -> Option<Value> {
    let kind = profile_kind(profile);
    let damage_type = text::lower(&nfkc_text(get(profile, "damage_type"), 40));
    let dice = damage_dice_of(get(profile, "damage_expression"));
    if dice.is_empty() {
        return None;
    }
    combat_modes(snapshot_combat).into_iter().find(|mode| js::string(get(Some(mode), "kind")) == kind && mode_damage_type(mode) == damage_type && damage_dice_of(get(Some(mode), "damage")) == dice)
}

fn mode_of_kind(profile: Option<&Value>, snapshot_combat: Option<&Value>) -> Option<Value> {
    let kind = profile_kind(profile);
    let damage_type = text::lower(&nfkc_text(get(profile, "damage_type"), 40));
    combat_modes(snapshot_combat).into_iter().find(|mode| js::string(get(Some(mode), "kind")) == kind && mode_damage_type(mode) == damage_type)
}

/// `npcAttackFormulaDeviationKey(statBlockId, actionId)`.
pub fn npc_attack_formula_deviation_key(stat_block_id: Option<&Value>, action_id: Option<&Value>) -> String {
    format!("{}|{}", nfkc_text(stat_block_id, 120), nfkc_text(action_id, 120))
}

/// Итог `npcWeaponBindingCheck`.
#[derive(Debug, Clone, PartialEq)]
pub struct WeaponBindingCheck {
    pub ok: bool,
    pub mode: Option<Value>,
    pub deviation: Option<&'static AttackFormulaDeviation>,
    pub reason: Option<&'static str>,
}

impl WeaponBindingCheck {
    /// Форма JS: `{ ok, mode, deviation, reason }`.
    pub fn to_json(&self) -> Value {
        json!({
            "ok": self.ok,
            "mode": self.mode.clone().unwrap_or(Value::Null),
            "deviation": self.deviation.map_or(Value::Null, AttackFormulaDeviation::to_json),
            "reason": self.reason,
        })
    }
}

/// `npcWeaponBindingCheck(enemy, profile, snapshotCombat)`: чистая сверка
/// формулы действия с боевым снимком вещи.
pub fn npc_weapon_binding_check(enemy: Option<&Value>, profile: Option<&Value>, snapshot_combat: Option<&Value>) -> WeaponBindingCheck {
    if let Some(matched) = matching_mode(profile, snapshot_combat) {
        return WeaponBindingCheck { ok: true, mode: Some(matched), deviation: None, reason: None };
    }
    let key = npc_attack_formula_deviation_key(get(enemy, "stat_block_id"), get(profile, "id"));
    let Some(deviation) = npc_attack_formula_deviation(&key) else {
        return WeaponBindingCheck { ok: false, mode: None, deviation: None, reason: Some("formula-mismatch") };
    };
    let Some(mode) = mode_of_kind(profile, snapshot_combat) else {
        return WeaponBindingCheck { ok: false, mode: None, deviation: Some(deviation), reason: Some("formula-mismatch") };
    };
    // Объявленное расхождение описывает **это** расхождение, а не любое.
    if damage_dice_of(Some(&json!(deviation.profile_damage))) != damage_dice_of(get(profile, "damage_expression")) || damage_dice_of(Some(&json!(deviation.catalog_damage))) != damage_dice_of(get(Some(&mode), "damage")) {
        return WeaponBindingCheck { ok: false, mode: None, deviation: Some(deviation), reason: Some("deviation-stale") };
    }
    WeaponBindingCheck { ok: true, mode: Some(mode), deviation: Some(deviation), reason: None }
}

fn bundle_amount_for(catalog_id: &str) -> i64 {
    safe_int(catalog_item(catalog_id).and_then(|entry| entry.get("ammunition")).and_then(|ammunition| ammunition.get("amount")), 1).max(1)
}

/// Остаток выстрелов в экземпляре боеприпасов (`charges.current` или пачки × размер пачки).
fn ammunition_shots_left(item: Option<&Value>) -> f64 {
    let Some(item) = item else {
        return 0.0;
    };
    let charges = item.get("charges").filter(|charges| js::truthy(Some(charges)) && is_object_like(Some(charges)));
    let current = js::number(get(charges, "current"));
    if charges.is_some() && crate::support::is_safe(current) {
        return current.max(0.0);
    }
    (safe_int(item.get("quantity"), 1).max(0) as f64) * bundle_amount_for(&nfkc_text(item.get("catalog_id"), 120)) as f64
}

fn expenditure_for(item: Option<&Value>, mode: Option<&Value>) -> Option<&'static str> {
    if js::string(get(mode, "kind")) != "ranged" {
        return None;
    }
    if js::is_true(get(mode, "ammunition")) {
        return Some("ammunition");
    }
    if js::is_true(get(mode, "thrown")) && !js::is_true(get(item, "equipped")) {
        return Some("thrown");
    }
    None
}

/// `npcWeaponBindings(enemy)`: привязки всех боевых действий существа с
/// каталожным оружием и сверенной формулой.
pub fn npc_weapon_bindings(enemy: Option<&Value>) -> Vec<Value> {
    let items = loadout_items(enemy);
    let template_id = nfkc_text(get(get(enemy, "loadout"), "template_id"), 120);
    let mut bindings = Vec::new();
    if template_id.is_empty() {
        return bindings;
    }
    for profile in array(get(enemy, "action_profiles")) {
        let action_id = nfkc_text(get(Some(profile), "id"), 120);
        let Some(catalog_id) = weapon_catalog_for_action(&action_id) else {
            continue;
        };
        if action_id.is_empty() {
            continue;
        }
        let item = items.iter().find(|candidate| nfkc_text(get(Some(candidate), "catalog_id"), 120) == catalog_id);
        let catalog_entry = catalog_item(catalog_id);
        let snapshot_combat = coalesce(get(get(item, "snapshot"), "combat"), catalog_entry.and_then(|entry| entry.get("combat")));
        let check = npc_weapon_binding_check(enemy, Some(profile), snapshot_combat);
        if !check.ok {
            continue;
        }
        let ammunition_catalog_id = ammunition_for_weapon(catalog_id);
        let ammunition = ammunition_catalog_id.and_then(|ammunition_id| items.iter().find(|candidate| nfkc_text(get(Some(candidate), "catalog_id"), 120) == ammunition_id));
        let snapshot_name = nfkc_text(get(get(item, "snapshot"), "name"), 120);
        let item_name = if !snapshot_name.is_empty() {
            snapshot_name
        } else {
            let catalog_name = nfkc_text(catalog_entry.and_then(|entry| entry.get("name")), 120);
            if catalog_name.is_empty() {
                catalog_id.to_string()
            } else {
                catalog_name
            }
        };
        let mut binding = Map::new();
        binding.insert("schema_version".into(), json!(NPC_EQUIPMENT_EVENT_SCHEMA_VERSION));
        binding.insert("policy_id".into(), json!(NPC_EQUIPMENT_POLICY_ID));
        binding.insert("action_id".into(), json!(action_id));
        binding.insert("kind".into(), json!(profile_kind(Some(profile))));
        binding.insert("item_instance_id".into(), json!(item.map_or(String::new(), |item| nfkc_text(item.get("item_instance_id"), 160))));
        binding.insert("catalog_id".into(), json!(catalog_id));
        binding.insert("item_name".into(), json!(item_name));
        binding.insert("item_quantity".into(), json!(item.map_or(0, |item| safe_int(item.get("quantity"), 1))));
        binding.insert("equipped".into(), json!(js::is_true(get(item, "equipped"))));
        binding.insert("expends".into(), json!(expenditure_for(item, check.mode.as_ref())));
        binding.insert("ammunition_instance_id".into(), ammunition.map_or(Value::Null, |ammunition| json!(nfkc_text(ammunition.get("item_instance_id"), 160))));
        binding.insert("ammunition_catalog_id".into(), json!(ammunition_catalog_id));
        binding.insert("ammunition_name".into(), ammunition.map_or(Value::Null, |ammunition| json!(nfkc_text(get(ammunition.get("snapshot"), "name"), 120))));
        binding.insert("ammunition_quantity".into(), json!(ammunition.map_or(0, |ammunition| safe_int(ammunition.get("quantity"), 1))));
        binding.insert("ammunition_shots_left".into(), num(ammunition_shots_left(ammunition)));
        binding.insert("deviation".into(), if check.deviation.is_some() { json!(npc_attack_formula_deviation_key(get(enemy, "stat_block_id"), Some(&json!(action_id)))) } else { Value::Null });
        bindings.push(Value::Object(binding));
    }
    bindings
}

/// `npcWeaponBindingFor(enemy, actionId)`.
pub fn npc_weapon_binding_for(enemy: Option<&Value>, action_id: Option<&Value>) -> Option<Value> {
    let expected = nfkc_text(action_id, 120);
    if expected.is_empty() {
        return None;
    }
    npc_weapon_bindings(enemy).into_iter().find(|binding| binding["action_id"] == json!(expected))
}

/// `npcMeleeWeaponBindingForItem(enemy, itemInstanceId)`: ближнее оружие по
/// экземпляру — то, на что кладётся яд.
pub fn npc_melee_weapon_binding_for_item(enemy: Option<&Value>, item_instance_id: Option<&Value>) -> Option<Value> {
    let expected = nfkc_text(item_instance_id, 160);
    if expected.is_empty() {
        return None;
    }
    npc_weapon_bindings(enemy).into_iter().find(|binding| binding["item_instance_id"] == json!(expected) && binding["kind"] == "melee" && binding["item_quantity"].as_i64().unwrap_or(0) > 0)
}

/// `npcActionUnavailableReason(enemy, actionId)`: `weapon-lost`,
/// `ammunition-spent` или `None` — действие доступно.
pub fn npc_action_unavailable_reason(enemy: Option<&Value>, action_id: Option<&Value>) -> Option<&'static str> {
    let binding = npc_weapon_binding_for(enemy, action_id)?;
    if binding["item_quantity"].as_i64().unwrap_or(0) <= 0 {
        return Some("weapon-lost");
    }
    if binding["expends"] == "ammunition" && binding["ammunition_shots_left"].as_f64().unwrap_or(0.0) <= 0.0 {
        return Some("ammunition-spent");
    }
    None
}

/// `npcAttackExpenditureFor(enemy, actionId)`: что списать за одну атаку —
/// выстрел (`shots_*`) и колчаны, что останутся телу (`quantity_*`).
pub fn npc_attack_expenditure_for(enemy: Option<&Value>, action_id: Option<&Value>) -> Option<Value> {
    let binding = npc_weapon_binding_for(enemy, action_id)?;
    let expends = binding["expends"].as_str()?;
    if expends != "ammunition" {
        let quantity = binding["item_quantity"].as_i64().unwrap_or(0);
        if binding["item_instance_id"].as_str().unwrap_or("").is_empty() || quantity <= 0 {
            return None;
        }
        return Some(json!({
            "item_instance_id": binding["item_instance_id"],
            "catalog_id": binding["catalog_id"],
            "item_name": binding["item_name"],
            "reason": expends,
            "quantity_before": quantity,
            "quantity_after": quantity - 1,
            "shots_before": quantity,
            "shots_after": quantity - 1,
        }));
    }
    let shots_left = binding["ammunition_shots_left"].as_f64().unwrap_or(0.0);
    if !js::truthy(binding.get("ammunition_instance_id")) || shots_left <= 0.0 {
        return None;
    }
    let bundle = bundle_amount_for(binding["ammunition_catalog_id"].as_str().unwrap_or("")) as f64;
    let shots_after = shots_left - 1.0;
    let name = binding["ammunition_name"].as_str().filter(|name| !name.is_empty()).unwrap_or("");
    Some(json!({
        "item_instance_id": binding["ammunition_instance_id"],
        "catalog_id": binding["ammunition_catalog_id"],
        "item_name": name,
        "reason": "ammunition",
        "quantity_before": binding["ammunition_quantity"],
        "quantity_after": if shots_after > 0.0 { num(1f64.max((shots_after / bundle).ceil())) } else { json!(0) },
        "shots_before": num(shots_left),
        "shots_after": num(shots_after),
    }))
}

/// `npcUsableItems(enemy, { rulesetId })`: расходники, с которыми сервер
/// умеет что-то сделать в бою; профиль использования — из живого каталога.
pub fn npc_usable_items(enemy: Option<&Value>, ruleset_id: &str) -> Vec<Value> {
    let mut usable = Vec::new();
    for item in loadout_items(enemy) {
        let catalog_id = nfkc_text(get(Some(item), "catalog_id"), 120);
        let Some(tactic) = npc_item_tactic_for(Some(&json!(catalog_id))) else {
            continue;
        };
        if safe_int(get(Some(item), "quantity"), 1) <= 0 {
            continue;
        }
        let Some(entry) = catalog_item(&catalog_id) else {
            continue;
        };
        let lifecycle = item_lifecycle_profile(&catalog_id, ruleset_id);
        let lifecycle_use = lifecycle.as_ref().and_then(|profile| profile.get("use")).filter(|value| js::truthy(Some(value)));
        let entry_use = entry.get("use").filter(|value| js::truthy(Some(value)));
        let (Some(entry_use), Some(lifecycle_use)) = (entry_use, lifecycle_use) else {
            continue;
        };
        if !MechanicsSupport::is(entry.get("mechanics_status"), MechanicsSupport::Verified) {
            continue;
        }
        if entry_use.get("kind").and_then(Value::as_str) != Some(tactic.use_kind) || js::s(entry_use.get("combat_action")) != tactic.combat_action {
            continue;
        }
        let snapshot_name = nfkc_text(get(item.get("snapshot"), "name"), 120);
        let item_name = if snapshot_name.is_empty() { entry.get("name").cloned().unwrap_or(Value::Null) } else { json!(snapshot_name) };
        usable.push(json!({
            "item_instance_id": nfkc_text(item.get("item_instance_id"), 160),
            "catalog_id": catalog_id,
            "item_name": item_name,
            "quantity": safe_int(item.get("quantity"), 1),
            "tactic": tactic.tactic,
            "label": tactic.label,
            "once_per_combat": tactic.once_per_combat,
            "use": lifecycle_use.clone(),
        }));
    }
    usable
}

/// `npcUsableItemFor(enemy, itemInstanceId, { rulesetId })`.
pub fn npc_usable_item_for(enemy: Option<&Value>, item_instance_id: Option<&Value>, ruleset_id: &str) -> Option<Value> {
    let expected = nfkc_text(item_instance_id, 160);
    npc_usable_items(enemy, ruleset_id).into_iter().find(|candidate| candidate["item_instance_id"] == json!(expected))
}

/// `npcTacticCondition(tactic)`: `npc-tactic-used:<tactic>`.
pub fn npc_tactic_condition(tactic: Option<&Value>) -> String {
    format!("{NPC_TACTIC_CONDITION_PREFIX}{}", nfkc_text(tactic, 40))
}

/// `npcNeedsHealingPotion(enemy)`: пора ли тянуться за зельем; порог —
/// целыми (`hp * 100 <= maxHp * 30`), побеждённое существо не пьёт.
pub fn npc_needs_healing_potion(enemy: Option<&Value>) -> bool {
    let hp = safe_int(get(enemy, "hp"), 0).max(0) as f64;
    let maximum = safe_int(coalesce(get(enemy, "maxHp"), get(enemy, "max_hp")), 1).max(1) as f64;
    hp > 0.0 && hp * 100.0 <= maximum * NPC_HEALING_POTION_HP_PERCENT as f64
}

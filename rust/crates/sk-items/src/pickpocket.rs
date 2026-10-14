//! Перенос `server/pickpocket.mjs`: карманная кража у NPC.
//!
//! Карман здесь **выводится, а не хранится**: он полностью определяется сидом
//! кампании и ролью человека, поэтому один и тот же сид даёт один и тот же
//! кошелёк после replay и рестарта — как инвентарь противника и характер
//! соперника за костями. Хранить его в социальном профиле значило бы
//! валидировать, закрывать в проекции и мигрировать поле, которое ничего от
//! этого не выигрывает.
//!
//! **Карман — не витрина.** Торговый инвентарь у торговца свой, и трогать его
//! кража не имеет права: обчистить лавку на весь склад — это уже ограбление.
//! Отсюда маленький честный пул: пара медяков и, изредка, одна мелочь по роли.

use serde_json::{json, Value};
use sk_core::fancy_regex::Regex;
use sk_core::{hash, js, re, text};

use crate::item_catalog::catalog_item;
use crate::support::field;

pub const PICKPOCKET_POLICY_ID: &str = "skazanie:pickpocket-v1";
pub const PICKPOCKET_SKILL: &str = "sleight_of_hand";
pub const PICKPOCKET_ABILITY: &str = "dex";

/// Ступень людности: от скольких людей вокруг, поправка к СЛ и подпись.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PickpocketCrowdStep {
    pub minimum: i64,
    pub shift: i64,
    pub label: &'static str,
}

impl PickpocketCrowdStep {
    /// Форма JS: `{ minimum, shift, label }`.
    pub fn to_json(&self) -> Value {
        json!({ "minimum": self.minimum, "shift": self.shift, "label": self.label })
    }
}

/// Насколько людно вокруг (`PICKPOCKET_CROWD_STEPS`). Толпа помогает вору — в
/// толчее рука в чужом кармане теряется, — а разговор наедине не оставляет ни
/// одного лишнего плеча. Ступени закрыты и считаются по числу людей в сцене,
/// а не по описанию: описание пишет модель, а правило обязано быть серверным.
pub const PICKPOCKET_CROWD_STEPS: [PickpocketCrowdStep; 4] = [
    PickpocketCrowdStep { minimum: 6, shift: -3, label: "в толчее" },
    PickpocketCrowdStep { minimum: 3, shift: -1, label: "при людях" },
    PickpocketCrowdStep { minimum: 2, shift: 0, label: "вдвоём с кем-то ещё" },
    PickpocketCrowdStep { minimum: 0, shift: 3, label: "наедине" },
];

/// Границы СЛ. Ниже — не кража, выше — не попытка.
pub const PICKPOCKET_MIN_DC: i64 = 5;
pub const PICKPOCKET_MAX_DC: i64 = 25;

/// Кошелёк по роли: базовые медяки, разброс и мелочь, которая может лежать в
/// кармане. Вещи выбраны из того, что действительно есть в каталоге и
/// помещается в карман.
struct Purse {
    base: i64,
    spread: i64,
    item: &'static str,
}

fn purse_for(role: &str) -> Purse {
    let table: [(&Regex, Purse); 6] = [
        (re!(r"куп|торг|лавоч|менял|ростовщ", "iu"), Purse { base: 40, spread: 60, item: "srd_5_2_1:rations-one-day" }),
        (re!(r"жрец|служ|монах|настоятел", "iu"), Purse { base: 15, spread: 25, item: "srd_5_2_1:torch" }),
        (re!(r"страж|солдат|воин|наём|десятн|сотник", "iu"), Purse { base: 25, spread: 35, item: "srd_5_2_1:dagger" }),
        (re!(r"кузнец|ремесл|мастер|плотн", "iu"), Purse { base: 20, spread: 30, item: "srd_5_2_1:rope-hempen-50-feet" }),
        (re!(r"нищ|бродяг|попрош", "iu"), Purse { base: 2, spread: 6, item: "" }),
        (re!(r"крест|пахар|рыбак|пасту", "iu"), Purse { base: 6, spread: 12, item: "srd_5_2_1:rations-one-day" }),
    ];
    table.into_iter().find(|(pattern, _)| text::test(pattern, role)).map_or(DEFAULT_PURSE, |(_, purse)| purse)
}

const DEFAULT_PURSE: Purse = Purse { base: 10, spread: 20, item: "srd_5_2_1:torch" };

/// Один шанс из трёх, что кроме монет в кармане есть мелочь.
const POCKET_ITEM_SHARE: u64 = 33;

/// `String(value ?? '').normalize('NFKC').trim().slice(0, maximum)`.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    text::clean(value, maximum)
}

/// `digest(...parts)`: SHA-256 частей через `\0`.
fn digest(parts: &[&str]) -> String {
    hash::sha256_hex(parts.join("\0"))
}

/// `spread(seed, salt, size)`: число 0…size−1 из сида.
fn spread(seed: &str, salt: &str, size: i64) -> i64 {
    let digest = digest(&[seed, salt]);
    let value = digest.get(0..8).and_then(|part| u64::from_str_radix(part, 16).ok()).unwrap_or(0);
    (value % size.max(1) as u64) as i64
}

/// `npcPocketFor(state, npc)`: что лежит у человека в кармане прямо сейчас —
/// `{ npc_id, purse_cp, catalog_id }`; без id человека — `None`. Вещь берётся
/// из каталога и проверяется по нему же: запись, которой в каталоге нет,
/// молча выпадает.
pub fn npc_pocket_for(state: &Value, npc: &Value) -> Option<Value> {
    let id = clean(npc.get("id"), 120);
    if id.is_empty() {
        return None;
    }
    let role = format!("{} {}", clean(npc.get("role"), 160), clean(npc.get("name"), 160));
    let purse = purse_for(&role);
    let session = clean(field(Some(state), "sessionCode"), 60);
    let seed = digest(&[&session, &id, PICKPOCKET_POLICY_ID]);
    let purse_cp = (purse.base + spread(&seed, "purse", purse.spread.max(1))).max(1);
    let carries_item = !purse.item.is_empty() && spread(&seed, "has-item", 100) < POCKET_ITEM_SHARE as i64;
    let entry = if carries_item { catalog_item(purse.item) } else { None };
    Some(json!({
        "npc_id": id,
        "purse_cp": purse_cp,
        "catalog_id": entry.and_then(|entry| entry.get("catalog_id")).cloned().unwrap_or(Value::Null),
    }))
}

/// `npcPassiveInsightFor(state, npc)`: насколько человек внимателен к своим
/// карманам — `10 + разброс от сида`, как у соперника за костями: два разных
/// числа «насколько он замечает чужие руки» в одной игре читались бы как
/// ошибка.
pub fn npc_passive_insight_for(state: &Value, npc: &Value) -> i64 {
    let id = clean(npc.get("id"), 120);
    if id.is_empty() {
        return 10;
    }
    let session = clean(field(Some(state), "sessionCode"), 60);
    let seed = digest(&[&session, &id, "npc-insight"]);
    10 + spread(&seed, "attention", 5)
}

/// `pickpocketCrowdStep(presentCount)`: ступень людности по числу людей вокруг
/// вора и жертвы (`safeInteger(presentCount, 0)`, не меньше нуля).
pub fn pickpocket_crowd_step(present_count: Option<&Value>) -> &'static PickpocketCrowdStep {
    let count = js::safe_int(present_count, 0).max(0);
    PICKPOCKET_CROWD_STEPS.iter().find(|step| count >= step.minimum).unwrap_or(&PICKPOCKET_CROWD_STEPS[PICKPOCKET_CROWD_STEPS.len() - 1])
}

/// `pickpocketDifficultyFor(state, npc, presentCount)`: СЛ карманной кражи —
/// внимание жертвы плюс поправка на людность, в пределах
/// [`PICKPOCKET_MIN_DC`]…[`PICKPOCKET_MAX_DC`]. Прятать её незачем: это
/// проверка Ловкости против чужого внимания, а «он выглядит настороженным» —
/// честная информация за столом.
pub fn pickpocket_difficulty_for(state: &Value, npc: &Value, present_count: Option<&Value>) -> Value {
    let step = pickpocket_crowd_step(present_count);
    let raw = npc_passive_insight_for(state, npc) + step.shift;
    json!({
        "difficulty": raw.clamp(PICKPOCKET_MIN_DC, PICKPOCKET_MAX_DC),
        "crowd_label": step.label,
        "crowd_shift": step.shift,
    })
}

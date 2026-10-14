//! Режим подготовки ассетов — перенос `server/asset-preparation.mjs`
//! (задача 5.1 плана `docs/experience-upgrade-plan.md`).
//!
//! Решение владельца: во время игры картинки не генерируются вовсе. Вечер стоит
//! около 50 ₽, и генерация изображений — заметная его часть; платить за неё
//! посреди хода, пока стол ждёт, незачем. Поэтому картинки готовятся заранее:
//! ведущий заходит в подготовку, видит, у кого портрета ещё нет, и запускает
//! генерацию до начала игры.
//!
//! Подготовка работает **независимо** от рантайм-флага: он выключает генерацию
//! в игровых путях, а не в подготовке. Иначе выключенный флаг закрывал бы и
//! единственный способ картинки получить.
//!
//! Здесь нет ни своего генератора, ни своего кеша: всё идёт через уже
//! существующие сервисы портретов и иллюстраций — тот же путь к модели, те же
//! каталоги, тот же usage-леджер. Второго авторитетного места для картинок
//! быть не должно.

use std::collections::HashSet;
use std::future::Future;

use indexmap::IndexMap;
use serde_json::{json, Value};
use sk_core::js;

use crate::support::{clean_text, field};

pub const ASSET_PREPARATION_POLICY_ID: &str = "skazanie:asset-preparation-v1";

/// Потолок одного запуска — **общий на все виды картинок**. Он не про
/// безопасность, а про деньги: двадцать генераций — это уже заметная сумма, и
/// списывать её молча одним нажатием нельзя. Раздельные потолки по видам
/// означали бы, что счёт вечера растёт вдвое быстрее при тех же цифрах на
/// экране.
pub const MAX_PREPARATION_BATCH: usize = 20;

struct PreparationGroup {
    request_key: &'static str,
    inventory_key: &'static str,
    ready_key: &'static str,
    label: &'static str,
}

/// Виды подготовки. Таблица одна на разбор запроса и на ответ, чтобы добавление
/// третьего вида не превращалось в третью копию проверок капа и неизвестных id.
const PREPARATION_GROUPS: [PreparationGroup; 2] = [
    PreparationGroup { request_key: "npc_ids", inventory_key: "npcs", ready_key: "has_portrait", label: "NPC" },
    PreparationGroup { request_key: "location_ids", inventory_key: "locations", ready_key: "has_illustration", label: "локации" },
];

fn text(value: Option<&Value>, maximum: usize) -> String {
    clean_text(value, maximum)
}

fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn sort_by_id(entries: &mut [Value]) {
    entries.sort_by(|left, right| sk_core::text::locale_compare(&js::s(left.get("id")), &js::s(right.get("id"))));
}

/// Предметы кампании без иллюстрации. Список **информационный**: собственного
/// серверного кеша у предметных картинок нет — их URL живёт на самой записи
/// предмета и проставляется редактором, поэтому «сгенерировать за игрока» здесь
/// значило бы завести второй авторитетный путь к инвентарю. Показать пробел
/// честнее, чем сделать вид, что его нет.
pub fn items_without_illustration(state: &Value) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut gaps = Vec::new();
    for player in array(field(Some(state), "players")) {
        for item in array(field(Some(player), "inventory")) {
            let id = text(field(Some(item), "id"), 120);
            let image = text(field(Some(item), "image"), 400);
            if id.is_empty() || !image.is_empty() || seen.contains(&id) {
                continue;
            }
            seen.insert(id.clone());
            let name = text(field(Some(item), "name"), 120);
            gaps.push(json!({ "id": id, "name": if name.is_empty() { id.clone() } else { name }, "owner_id": text(field(Some(player), "id"), 120) }));
        }
    }
    sort_by_id(&mut gaps);
    gaps
}

/// Кеш портретов (`NpcPortraitService.cached(campaignId, npcId)`): готовая
/// запись или `None`.
pub trait NpcPortraitCache {
    type Error;
    fn cached(&self, campaign_id: &str, npc_id: &Value) -> impl Future<Output = Result<Option<Value>, Self::Error>> + Send;
}

/// NPC кампании, у которых уже есть портрет в репозитории/кеше или ещё нет
/// готового изображения.
///
/// Значимость проверяется тем же правилом, что и в игре: второстепенному NPC
/// портрет не рисуется и в подготовке — иначе ведущий платил бы за картинки,
/// которых игрок всё равно не увидит.
pub async fn npc_portrait_inventory<S: NpcPortraitCache>(
    service: &S,
    campaign_id: &str,
    projected_state: &Value,
    significance: impl Fn(&Value, &Value) -> bool,
    profiles: &[Value],
) -> Result<Vec<Value>, S::Error> {
    let mut entries = Vec::new();
    for profile in profiles {
        let prepared = !sk_core::text::trim(&js::s(field(Some(profile), "portrait_url"))).is_empty();
        if !prepared && !significance(projected_state, profile) {
            continue;
        }
        let cached = if prepared { None } else { service.cached(campaign_id, field(Some(profile), "id").unwrap_or(&Value::Null)).await? };
        let id = text(field(Some(profile), "id"), 120);
        let name = text(field(Some(profile), "name"), 120);
        entries.push(json!({
            "id": id,
            "name": if name.is_empty() { id.clone() } else { name },
            "role": text(field(Some(profile), "role"), 120),
            "has_portrait": prepared || js::truthy(cached.as_ref()),
        }));
    }
    sort_by_id(&mut entries);
    Ok(entries)
}

/// Что подготовка сделает с запрошенным списком. Разбор отделён от исполнения,
/// чтобы отказ по капу был проверяем без единого обращения к генератору.
///
/// `requested` — `{ npc_ids, location_ids }` из тела запроса, `inventories` —
/// `{ npcs, locations }`. Ответ: `{ ok, code, message, npc_ids, location_ids }`.
pub fn plan_preparation(requested: &Value, inventories: &Value, regenerate: bool) -> Value {
    let body = if requested.is_object() { requested.clone() } else { json!({}) };
    // Пустые списки — свежие значения на каждый отказ: разбор отдаёт наружу
    // обычный изменяемый ответ.
    let refuse = |code: &str, message: String| json!({ "ok": false, "code": code, "message": message, "npc_ids": [], "location_ids": [] });
    let mut selected: IndexMap<&str, Vec<String>> = IndexMap::new();
    let mut total = 0;
    for group in &PREPARATION_GROUPS {
        let inventory = array(field(Some(inventories), group.inventory_key));
        // `new Map(inventory.map((entry) => [entry.id, entry]))`: строковый id
        // совпадёт со строкой запроса, иной ключ — никогда.
        let mut known: IndexMap<&str, &Value> = IndexMap::new();
        for entry in inventory {
            if let Some(Value::String(id)) = field(Some(entry), "id") {
                known.insert(id.as_str(), entry);
            }
        }
        let mut ids: Vec<String> = Vec::new();
        for value in array(field(Some(&body), group.request_key)) {
            let id = text(Some(value), 120);
            if !id.is_empty() && !ids.contains(&id) {
                ids.push(id);
            }
        }
        let unknown: Vec<&str> = ids.iter().map(String::as_str).filter(|id| !known.contains_key(id)).collect();
        if !unknown.is_empty() {
            return refuse("UNKNOWN_ASSET", format!("Неизвестные {}: {}", group.label, unknown.iter().take(5).copied().collect::<Vec<_>>().join(", ")));
        }
        total += ids.len();
        // Без явной перегенерации уже готовое пропускается: платить второй раз за
        // ту же картинку незачем.
        let chosen = if regenerate { ids } else { ids.into_iter().filter(|id| !js::is_true(known.get(id.as_str()).and_then(|entry| field(Some(entry), group.ready_key)))).collect() };
        selected.insert(group.request_key, chosen);
    }
    if total == 0 {
        return refuse("NOTHING_REQUESTED", "Не выбрано ни одной позиции".into());
    }
    if total > MAX_PREPARATION_BATCH {
        return refuse(
            "BATCH_TOO_LARGE",
            format!("За один запуск готовится не больше {MAX_PREPARATION_BATCH} позиций: генерация стоит денег, и списывать их молча нельзя"),
        );
    }
    json!({
        "ok": true,
        "code": null,
        "message": "",
        "npc_ids": selected.get("npc_ids").cloned().unwrap_or_default(),
        "location_ids": selected.get("location_ids").cloned().unwrap_or_default(),
    })
}

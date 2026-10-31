//! Перенос `server/scene-hazard-narration.mjs`: текст интеракций с
//! обстановкой. Рассказывает только то, что движок уже подтвердил событиями:
//! повалено, загорелось, кого задело. Ни одного числа механики — урон и
//! спасброски игрок видит в карточке броска.
//!
//! Рассказчик регистрируется по контракту
//! `sk_narration_base::deterministic_narration` ([`register_scene_hazard_narrator`]).

use std::sync::{Arc, LazyLock, OnceLock};

use serde_json::Value;
use sk_core::{js, re, text};
use sk_narration_base::deterministic_narration::{narration_text_or, register_deterministic_narrator, DeterministicNarrator, NarratorContractError, SharedNarrator, NARRATOR_PRIORITY};

use crate::jsv::{self, array, is_str, prop};

const HAZARD_INTENTS: [&str; 2] = ["topple", "ignite"];

fn hazard_intent(event: &Value) -> bool {
    HAZARD_INTENTS.contains(&js::s(jsv::path(Some(event), &["payload", "intent"])).as_str())
}

/// Есть ли в пачке опрокидывание или поджог пропа.
pub fn has_scene_hazard_event(events: &[Value]) -> bool {
    events.iter().any(|event| js::s(event.get("event_type")) == "SceneObjectStateChanged" && hazard_intent(event))
}

/// Подпись известного пропа по-русски.
fn ru_label(key: &str) -> Option<&'static str> {
    Some(match key {
        "bookshelf" | "shelf_wall" => "стеллаж",
        "bar_shelf" => "полка за стойкой",
        "wardrobe" => "платяной шкаф",
        "cupboard" => "буфет",
        "crate_stack" => "штабель ящиков",
        "barrel_stack" => "штабель бочек",
        "table_long" => "длинный стол",
        "table_round" => "круглый стол",
        "table_small" => "столик",
        "bar_counter" => "барная стойка",
        "barrel" => "бочка",
        "keg" => "бочонок",
        "crate" => "ящик",
        "cart" => "телега",
        "market_stall" => "торговый лоток",
        "statue" => "статуя",
        "pillar" => "колонна",
        "haystack" => "стог сена",
        "woodpile" => "поленница",
        "firewood_stack" => "дрова",
        "basket" => "корзина",
        "broom" => "метла",
        "cobweb" => "паутина",
        "banner" => "полотнище",
        "temple_banner" => "храмовое полотнище",
        "rug" => "ковёр",
        "bed" => "постель",
        "bunk_bed" => "койка",
        "prayer_bench" | "bench" => "скамья",
        _ => return None,
    })
}

/// Род подписи: `f`, `n`, `p` (множественное); прочие — мужской.
fn label_gender(label: &str) -> &'static str {
    match label {
        "полка за стойкой" | "барная стойка" | "бочка" | "телега" | "статуя" | "колонна" | "поленница" | "корзина" | "метла" | "паутина" | "постель" | "койка" | "скамья" => "f",
        "полотнище" | "храмовое полотнище" => "n",
        "дрова" => "p",
        _ => "m",
    }
}

/// Формы глагола и местоимения для рода подписи.
struct Forms {
    swayed: &'static str,
    held: &'static str,
    accusative: &'static str,
    under: &'static str,
    falls: &'static str,
    misses: &'static str,
    collapses: &'static str,
    covers: &'static str,
    catches: &'static str,
}

const SINGULAR_VERBS: (&str, &str, &str, &str, &str) = ("валится", "успевает", "обрушивается", "накрывает", "занимается");

fn forms_for(label: &str) -> Forms {
    let (falls, misses, collapses, covers, catches) = SINGULAR_VERBS;
    match label_gender(&text::lower(label)) {
        "f" => Forms { swayed: "качнулась", held: "устояла", accusative: "её", under: "под ней", falls, misses, collapses, covers, catches },
        "n" => Forms { swayed: "качнулось", held: "устояло", accusative: "его", under: "под ним", falls, misses, collapses, covers, catches },
        "p" => Forms {
            swayed: "качнулись",
            held: "устояли",
            accusative: "их",
            under: "под ними",
            falls: "валятся",
            misses: "успевают",
            collapses: "обрушиваются",
            covers: "накрывают",
            catches: "занимаются",
        },
        _ => Forms { swayed: "качнулся", held: "устоял", accusative: "его", under: "под ним", falls, misses, collapses, covers, catches },
    }
}

fn prop_label(asset_id: Option<&Value>) -> &'static str {
    let lowered = text::lower(&js::s(asset_id));
    let tail = lowered.split(['\\', '/']).next_back().unwrap_or("");
    let key = text::replace_first(re!(r"\.[a-z0-9]+$", "u"), tail, "");
    ru_label(&key).unwrap_or("")
}

/// Текст опрокидывания или поджога пропа по событиям пачки; `None` — не наш батч.
pub fn scene_hazard_narration(events: &[Value], state: &Value) -> Option<String> {
    let changed = events.iter().find(|event| is_str(event.get("event_type"), "SceneObjectStateChanged") && hazard_intent(event))?;
    let payload = changed.get("payload");
    let prop_id = js::s(prop(payload, "prop_id"));
    let props = array(jsv::path(Some(state), &["scene", "map", "props"]));
    let found = props.iter().find(|candidate| jsv::string(prop(Some(candidate), "id")) == prop_id);
    let label = match found.and_then(|found| found.get("assetId")).filter(|asset| js::truthy(Some(asset))) {
        Some(asset) => prop_label(Some(asset)),
        None => "",
    };
    let what = narration_text_or(Some(&Value::from(label)), "предмет обстановки", 80);
    let form = forms_for(&what);
    let title = text::capitalize(&what);
    if is_str(prop(payload, "intent"), "topple") {
        if js::is_false(prop(payload, "success")) {
            return Some(format!("{title} {}, но {}: опрокинуть {} не вышло.", form.swayed, form.held, form.accusative));
        }
        let hurt = events.iter().any(|event| is_str(event.get("event_type"), "DamageApplied") && is_str(jsv::path(Some(event), &["payload", "reason"]), "scene-object-topple"));
        let prone = events.iter().any(|event| is_str(event.get("event_type"), "ConditionAdded") && is_str(jsv::path(Some(event), &["payload", "condition"]), "prone"));
        if !hurt {
            return Some(format!("{title} с грохотом {} на пол, но задеть никого не {}.", form.falls, form.misses));
        }
        return Some(format!("{title} {} вниз и {} тех, кто стоял {}{}.", form.collapses, form.covers, form.under, if prone { ", сбивая с ног" } else { "" }));
    }
    let from_prop = js::s(prop(payload, "fire_source")) == "prop";
    Some(format!(
        "{title} {} огнём{}. Пламя перекидывается на соседние клетки, и стоять в нём больше нельзя.",
        form.catches,
        if from_prop { " от стоящего рядом пламени" } else { "" }
    ))
}

/// Рассказчик обстановки (`sceneHazardNarrator`): раньше сцены — обрушенный
/// стеллаж крупнее, чем открытая дверь.
pub struct SceneHazardNarrator;

impl DeterministicNarrator for SceneHazardNarrator {
    fn id(&self) -> &str {
        "scene-hazard"
    }

    fn prompt_version(&self) -> &str {
        "scene-hazard-narrator/v1"
    }

    fn provider(&self) -> &str {
        "deterministic-scene-hazard"
    }

    fn priority(&self) -> f64 {
        NARRATOR_PRIORITY.scene - 1.0
    }

    fn matches(&self, events: &[Value]) -> bool {
        has_scene_hazard_event(events)
    }

    fn narrate(&self, events: &[Value], state: &Value) -> Option<String> {
        scene_hazard_narration(events, state)
    }
}

/// Рассказчик обстановки как общий объект реестра.
pub static SCENE_HAZARD_NARRATOR: LazyLock<SharedNarrator> = LazyLock::new(|| Arc::new(SceneHazardNarrator));

/// Зарегистрировать рассказчика в общем реестре сервера (в JS — при импорте
/// модуля). Повторный вызов возвращает итог первой регистрации.
pub fn register_scene_hazard_narrator() -> Result<SharedNarrator, NarratorContractError> {
    static REGISTERED: OnceLock<Result<SharedNarrator, NarratorContractError>> = OnceLock::new();
    REGISTERED.get_or_init(|| register_deterministic_narrator(Arc::clone(&SCENE_HAZARD_NARRATOR))).clone()
}

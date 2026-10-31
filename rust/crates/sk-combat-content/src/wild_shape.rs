//! Перенос `server/wild-shape.mjs`: Дикий облик друида (PHB 2014) — в каких
//! зверей друид умеет обращаться по кругу и уровню. Формы берутся из
//! бестиария 2014 той же сборкой, что у врагов стенда (`enemy_from_2014`):
//! хиты, КД, скорость, размер и основная атака зверя.
//!
//! - Круг земли и прочие: ПО ¼ со 2-го уровня, ½ с 4-го, 1 с 8-го.
//! - Круг луны: ПО 1 со 2-го уровня, с 6-го — уровень / 3 (на 7-м — ПО 2).
//!
//! Летающих и плавающих зверей в наборе нет, поэтому запреты 2-го и 4-го
//! уровня на полёт и плавание соблюдаются составом списка. Команду и события
//! исполняет Rules Engine.

use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::{js, re, text};

use crate::combat_lab_monsters::enemy_from_2014;
use crate::jsv::{self, array, defined, nullish, num, prop};

const BEAST_IDS: [&str; 6] = ["wolf", "brown-bear", "dire-wolf", "lion", "giant-spider", "giant-boar"];

static RECORDS: LazyLock<Value> = LazyLock::new(|| jsv::embedded_json(include_str!("../../../../data/compendia/dnd_5e_2014/monsters.json")));

/// Облик зверя.
#[derive(Clone, Debug, PartialEq)]
pub struct WildShapeForm {
    pub id: &'static str,
    pub name: String,
    pub challenge_rating: f64,
    pub hp: f64,
    pub armor: f64,
    pub speed: f64,
    pub size: String,
    /// Основная атака зверя (`null`, если её нет).
    pub attack_profile: Value,
}

impl WildShapeForm {
    /// Форма JS.
    pub fn to_value(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "challenge_rating": num(self.challenge_rating),
            "hp": num(self.hp),
            "armor": num(self.armor),
            "speed": num(self.speed),
            "size": self.size,
            "attack_profile": self.attack_profile,
        })
    }
}

/// `1/4` → 0.25.
fn challenge_rating(raw: Option<&Value>) -> f64 {
    let source = js::s(raw);
    let source = text::trim(&source);
    if let Ok(Some(fraction)) = re!(r"^(\d+)\s*\/\s*(\d+)$", "u").captures(source) {
        let numerator = js::parse_number(fraction.get(1).map_or("", |m| m.as_str()));
        let denominator = js::parse_number(fraction.get(2).map_or("", |m| m.as_str()));
        return numerator / jsv::max2(1.0, denominator);
    }
    let value = js::parse_number(source);
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

/// Звери Дикого облика в порядке набора. Бестиарий встроен, поэтому
/// отсутствие зверя — ошибка сборки данных, как и в JS.
pub static WILD_SHAPE_FORMS: LazyLock<Vec<WildShapeForm>> = LazyLock::new(|| {
    let records = array(RECORDS.get("monsters"));
    BEAST_IDS
        .iter()
        .map(|id| {
            let suffix = format!(":{id}");
            let record = records
                .iter()
                .find(|entry| jsv::string(entry.get("id")).ends_with(&suffix))
                .unwrap_or_else(|| panic!("Дикий облик: в бестиарии нет зверя {id}"));
            let beast = enemy_from_2014(record, Some(&json!({ "x": 0, "y": 0 })), 0.0);
            WildShapeForm {
                id,
                name: jsv::string(beast.get("name")),
                challenge_rating: challenge_rating(record.get("challenge_rating")),
                hp: js::number(nullish(beast.get("maxHp"), beast.get("hp"))),
                armor: js::number(beast.get("armor")),
                speed: js::number(beast.get("speed")),
                size: jsv::string(Some(defined(beast.get("size")).unwrap_or(&Value::from("medium")))),
                attack_profile: beast.get("attack_profile").filter(|profile| js::truthy(Some(profile))).cloned().unwrap_or(Value::Null),
            }
        })
        .collect()
});

/// Друид Круга луны.
pub fn is_moon_druid(actor: Option<&Value>) -> bool {
    text::test(re!(r"луны|moon", "iu"), &js::s(nullish(prop(actor, "subclass"), prop(actor, "subClass"))))
}

/// Предельный показатель опасности зверя для друида; `-1` — облика ещё нет.
pub fn wild_shape_challenge_limit(actor: Option<&Value>) -> f64 {
    let level = jsv::max2(1.0, jsv::number_or(prop(actor, "level"), 1.0).trunc());
    if level < 2.0 {
        return -1.0;
    }
    if is_moon_druid(actor) {
        return if level >= 6.0 { (level / 3.0).floor() } else { 1.0 };
    }
    if level >= 8.0 {
        1.0
    } else if level >= 4.0 {
        0.5
    } else {
        0.25
    }
}

/// Звери, доступные друиду.
pub fn wild_shape_forms_for(actor: Option<&Value>) -> Vec<&'static WildShapeForm> {
    let limit = wild_shape_challenge_limit(actor);
    WILD_SHAPE_FORMS.iter().filter(|form| form.challenge_rating <= limit).collect()
}

/// Облик по выбору игрока или сильнейший доступный: выше показатель
/// опасности, затем больше хитов. `None` — друиду ещё некого принять.
pub fn wild_shape_form_for(actor: Option<&Value>, form_id: Option<&Value>) -> Option<&'static WildShapeForm> {
    let forms = wild_shape_forms_for(actor);
    let wanted = js::s(form_id);
    if let Some(chosen) = forms.iter().find(|form| form.id == wanted) {
        return Some(chosen);
    }
    let mut sorted = forms;
    sorted.sort_by(|left, right| {
        let by_rating = right.challenge_rating - left.challenge_rating;
        if by_rating != 0.0 && !by_rating.is_nan() {
            return by_rating.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal);
        }
        let by_hp = right.hp - left.hp;
        if by_hp != 0.0 && !by_hp.is_nan() {
            return by_hp.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal);
        }
        text::locale_compare(left.id, right.id)
    });
    sorted.first().copied()
}

//! Перенос `server/ruleset-config.mjs`: установленные редакции правил
//! (профили 2014 и 2024), их замок для кампании, домашние правила, которые
//! сервер включает сам или даёт переключать ведущему, и перевод
//! идентификаторов правил прежней редакции в выбранную.

use std::fmt;

use serde_json::{json, Value};

use crate::support::str_array;

pub const DND_2014_RULESET_ID: &str = "dnd_5e_2014";
pub const LEGACY_DEFAULT_RULESET_ID: &str = "srd_5_2_1";
pub const NEW_WORLD_DEFAULT_RULESET_ID: &str = DND_2014_RULESET_ID;

/// Запасы классов по таблицам 2024 (`server/combat-actions.mjs`). Только для
/// кампаний, созданных после 2026-10-03: прежние живут по старой таблице, чтобы
/// их replay не менял уже начисленные запасы.
pub const CLASS_RESOURCES_2024_POLICY_ID: &str = "skazanie:class-resources-2024-v1";

/// Домашнее правило в духе BG3: удар из исследования проходит сразу, вне
/// очереди, и только потом бросается инициатива; ход нападающего в первом
/// раунде остаётся целым. Решение владельца от 2026-10-04: включено в новых
/// кампаниях по умолчанию, в идущих его включает ведущий событием
/// `CampaignHouseRuleChanged`.
pub const BG3_OPENING_STRIKE_HOUSE_RULE_ID: &str = "house:bg3-opening-strike";

/// Домашнее правило в духе BG3: жесты и материальный компонент заклинания не
/// требуют свободной руки. Решение владельца от 2026-10-13: включено по
/// умолчанию, ведущий выключает в настройках.
pub const BG3_SPELL_HANDS_HOUSE_RULE_ID: &str = "house:bg3-spell-hands";

/// Правила, которые сервер сам включает и уже идущим кампаниям — при старте,
/// событием `CampaignHouseRuleChanged` (`default_house_rule_event`).
pub const DEFAULT_ON_HOUSE_RULE_IDS: [&str; 2] = [BG3_OPENING_STRIKE_HOUSE_RULE_ID, BG3_SPELL_HANDS_HOUSE_RULE_ID];

/// Домашнее правило, которое ведущий переключает в настройках идущей кампании.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToggleableHouseRule {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
}

impl ToggleableHouseRule {
    /// JSON-форма записи `TOGGLEABLE_HOUSE_RULES`.
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "label": self.label, "description": self.description })
    }
}

/// Домашние правила, которые ведущий переключает в настройках идущей кампании.
/// Сюда попадает только правило, решающее исход в момент команды: его итог
/// записан событиями, поэтому смена правила не меняет replay прошлого.
pub const TOGGLEABLE_HOUSE_RULES: [ToggleableHouseRule; 2] = [
    ToggleableHouseRule {
        id: BG3_OPENING_STRIKE_HOUSE_RULE_ID,
        label: "Нападение как в BG3",
        description: "Удар из исследования проходит сразу, до инициативы, а ход нападающего в первом раунде остаётся целым. Выключено — по редакции: сначала инициатива, и удар исполняется, только если нападающий ходит первым",
    },
    ToggleableHouseRule {
        id: BG3_SPELL_HANDS_HOUSE_RULE_ID,
        label: "Заклинания как в BG3",
        description: "Жесты и материальный компонент заклинания не требуют свободной руки: оружие и щит в руках колдовать не мешают. Выключено — по редакции: нужна свободная рука, кроме черты «Боевой заклинатель»",
    },
];

/// Профиль установленной редакции правил (`RULESET_PROFILES[id]`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RulesetProfile {
    pub id: &'static str,
    pub version: &'static str,
    pub edition_family: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub mechanics_status: &'static str,
    pub availability: &'static str,
    pub creation_enabled: bool,
    pub process_default_allowed: bool,
    pub enabled_rule_packs: &'static [&'static str],
    pub default_house_rules: &'static [&'static str],
    pub limitations: &'static [&'static str],
}

impl RulesetProfile {
    /// JSON-форма профиля с порядком ключей JS.
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "version": self.version,
            "edition_family": self.edition_family,
            "label": self.label,
            "description": self.description,
            "mechanics_status": self.mechanics_status,
            "availability": self.availability,
            "creation_enabled": self.creation_enabled,
            "process_default_allowed": self.process_default_allowed,
            "enabled_rule_packs": str_array(self.enabled_rule_packs),
            "default_house_rules": str_array(self.default_house_rules),
            "limitations": str_array(self.limitations),
        })
    }
}

/// Профили в порядке установки (`profiles` в JS).
pub const RULESET_PROFILES: [RulesetProfile; 2] = [
    RulesetProfile {
        id: DND_2014_RULESET_ID,
        version: "2014.1.0",
        edition_family: "5e_2014",
        label: "D&D 5e 2014",
        description: "Правила 2014 года, как в «Книге игрока». Часть механик ещё в работе.",
        mechanics_status: "partial",
        availability: "preview",
        creation_enabled: true,
        process_default_allowed: false,
        enabled_rule_packs: &["dnd_5e_2014"],
        default_house_rules: &["skazanie:2014-preview-legacy-catalogs-v1", BG3_OPENING_STRIKE_HOUSE_RULE_ID, BG3_SPELL_HANDS_HOUSE_RULE_ID],
        limitations: &[
            "Снаряжение и монстры пока общие с правилами 2024 года.",
            "Часть различий между редакциями ещё не перенесена: такие правила работают по-2024.",
        ],
    },
    RulesetProfile {
        id: "srd_5_2_1",
        version: "5.2.1",
        edition_family: "5e_2024",
        label: "D&D 2024",
        description: "Правила 2024 года — поддерживаются лучше всего.",
        mechanics_status: "partial",
        availability: "active",
        creation_enabled: true,
        process_default_allowed: true,
        enabled_rule_packs: &["srd_5_2_1"],
        default_house_rules: &[CLASS_RESOURCES_2024_POLICY_ID, BG3_OPENING_STRIKE_HOUSE_RULE_ID, BG3_SPELL_HANDS_HOUSE_RULE_ID],
        limitations: &["Часть классовых умений, заклинаний и существ пока объявляется словами."],
    },
];

pub const INSTALLED_RULESET_IDS: [&str; 2] = [RULESET_PROFILES[0].id, RULESET_PROFILES[1].id];

/// `RULESET_PROFILES[id]`: профиль по точному идентификатору.
///
/// В JS это объект с прототипом, и ключи вроде `constructor` давали функцию
/// вместо профиля; здесь такие ключи — просто неизвестная редакция.
pub fn ruleset_profile_by_id(id: &str) -> Option<&'static RulesetProfile> {
    RULESET_PROFILES.iter().find(|profile| profile.id == id)
}

/// `RULESET_PROFILES` целиком — объект «id → профиль».
pub fn ruleset_profiles_json() -> Value {
    Value::Object(RULESET_PROFILES.iter().map(|profile| (profile.id.to_string(), profile.to_json())).collect())
}

/// `TOGGLEABLE_HOUSE_RULES` в JSON-форме.
pub fn toggleable_house_rules_json() -> Value {
    Value::Array(TOGGLEABLE_HOUSE_RULES.iter().map(ToggleableHouseRule::to_json).collect())
}

/// Отказ выбора редакции (`RulesetSelectionError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RulesetSelectionError {
    pub code: String,
    pub message: String,
}

impl RulesetSelectionError {
    pub fn new(message: impl Into<String>, code: &str) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl fmt::Display for RulesetSelectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for RulesetSelectionError {}

/// Параметры `rulesetProfile(id, { fallback, requireCreation })`.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProfileOptions<'a> {
    pub fallback: Option<&'a str>,
    pub require_creation: bool,
}

impl<'a> ProfileOptions<'a> {
    pub fn fallback(fallback: &'a str) -> Self {
        Self { fallback: Some(fallback), require_creation: false }
    }
}

/// `rulesetProfile(rulesetId, options)`. `ruleset_id` — уже приведённое
/// `String(rulesetId ?? '')`.
pub fn ruleset_profile(ruleset_id: &str, options: ProfileOptions<'_>) -> Result<&'static RulesetProfile, RulesetSelectionError> {
    let requested = sk_core::text::trim(ruleset_id);
    // `requested || fallback`: пустая строка уступает запасу.
    let resolved = if requested.is_empty() { options.fallback } else { Some(requested) };
    let Some(profile) = resolved.and_then(ruleset_profile_by_id) else {
        let shown = resolved.filter(|value| !value.is_empty()).or((!requested.is_empty()).then_some(requested)).unwrap_or("(пусто)");
        return Err(RulesetSelectionError::new(format!("Неизвестный ruleset «{shown}»"), "RULESET_INVALID"));
    };
    if options.require_creation && !profile.creation_enabled {
        return Err(RulesetSelectionError::new(
            format!("Ruleset {} пока нельзя выбрать для новой кампании", profile.id),
            "RULESET_CREATION_DISABLED",
        ));
    }
    Ok(profile)
}

/// `rulesetLock(rulesetId, options)`: редакция, её версия, пакеты правил и
/// домашние правила по умолчанию.
pub fn ruleset_lock(ruleset_id: &str, options: ProfileOptions<'_>) -> Result<Value, RulesetSelectionError> {
    let profile = ruleset_profile(ruleset_id, options)?;
    Ok(json!({
        "ruleset_id": profile.id,
        "ruleset_version": profile.version,
        "enabled_rule_packs": str_array(profile.enabled_rule_packs),
        "enabled_house_rules": str_array(profile.default_house_rules),
    }))
}

/// `publicRulesetProfiles()`: редакции, доступные для новой кампании.
pub fn public_ruleset_profiles() -> Value {
    Value::Array(
        RULESET_PROFILES
            .iter()
            .filter(|profile| profile.creation_enabled)
            .map(|profile| {
                json!({
                    "id": profile.id,
                    "version": profile.version,
                    "editionFamily": profile.edition_family,
                    "label": profile.label,
                    "description": profile.description,
                    "mechanicsStatus": profile.mechanics_status,
                    "availability": profile.availability,
                    "limitations": str_array(profile.limitations),
                })
            })
            .collect(),
    )
}

/// `rulesetRuleId(ruleId, rulesetId)`: `srd_5_2_1:x` → `<редакция>:x` для
/// установленной редакции; прочее — как есть. Аргументы — уже приведённые
/// `String(x ?? '')`.
pub fn ruleset_rule_id(rule_id: &str, ruleset_id: &str) -> String {
    let prefix = format!("{LEGACY_DEFAULT_RULESET_ID}:");
    match (ruleset_profile_by_id(ruleset_id), rule_id.strip_prefix(&prefix)) {
        (Some(profile), Some(rest)) => format!("{}:{rest}", profile.id),
        _ => rule_id.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_exposes_exactly_the_selectable_profiles() {
        assert_eq!(INSTALLED_RULESET_IDS, ["dnd_5e_2014", "srd_5_2_1"]);
        assert_eq!(NEW_WORLD_DEFAULT_RULESET_ID, "dnd_5e_2014");
        assert_eq!(LEGACY_DEFAULT_RULESET_ID, "srd_5_2_1");
        let public = public_ruleset_profiles();
        let pairs: Vec<(String, String)> = public
            .as_array()
            .into_iter()
            .flatten()
            .map(|profile| (sk_core::js::s(profile.get("id")), sk_core::js::s(profile.get("availability"))))
            .collect();
        assert_eq!(pairs, [("dnd_5e_2014".to_string(), "preview".to_string()), ("srd_5_2_1".to_string(), "active".to_string())]);
    }

    #[test]
    fn ruleset_lock_carries_a_version_and_one_matching_pack() {
        assert_eq!(
            ruleset_lock("dnd_5e_2014", ProfileOptions::default()),
            Ok(json!({
                "ruleset_id": "dnd_5e_2014",
                "ruleset_version": "2014.1.0",
                "enabled_rule_packs": ["dnd_5e_2014"],
                "enabled_house_rules": ["skazanie:2014-preview-legacy-catalogs-v1", "house:bg3-opening-strike", "house:bg3-spell-hands"],
            }))
        );
        assert!(ruleset_profile("srd_5_2_1", ProfileOptions::default()).is_ok_and(|profile| profile.process_default_allowed));
        assert_eq!(ruleset_profile("invented", ProfileOptions::default()).map_err(|error| error.code), Err("RULESET_INVALID".to_string()));
    }

    #[test]
    fn legacy_provenance_ids_are_remapped_only_for_an_installed_target_edition() {
        assert_eq!(ruleset_rule_id("srd_5_2_1:combat:attack-roll", "dnd_5e_2014"), "dnd_5e_2014:combat:attack-roll");
        assert_eq!(ruleset_rule_id("srd_5_2_1:combat:attack-roll", "srd_5_2_1"), "srd_5_2_1:combat:attack-roll");
        assert_eq!(ruleset_rule_id("house:high-ground", "dnd_5e_2014"), "house:high-ground");
    }
}

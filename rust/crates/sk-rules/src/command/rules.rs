//! Провенанс команд: `RULE_IDS`, `COMMAND_RULES`, `sourceIdsFor`
//! (`rules-engine.mjs`, 669–692, 744–906, 4589–4599). Задача Р0.

use serde_json::Value;
use sk_ruleset::ruleset_config::{ruleset_rule_id, INSTALLED_RULESET_IDS};
use sk_ruleset::rules_core::DEFAULT_RULESET_ID;

use crate::core::unique_strings;
use crate::pause::{rule, Halt};

/// `RULE_IDS`: правила редакции `srd_5_2_1` (для кампании 2014 переводятся
/// `rulesetRuleId` при записи события).
pub mod rule_ids {
    pub const ABILITY_CHECK: &str = "srd_5_2_1:checks:ability-check";
    pub const SAVING_THROW: &str = "srd_5_2_1:checks:saving-throw";
    pub const ADVANTAGE: &str = "srd_5_2_1:core:advantage-disadvantage";
    pub const ATTACK: &str = "srd_5_2_1:combat:attack-roll";
    pub const ARMOR_CLASS: &str = "srd_5_2_1:combat:armor-class";
    pub const CRITICAL_HIT: &str = "srd_5_2_1:combat:critical-hit";
    pub const DAMAGE: &str = "srd_5_2_1:combat:damage";
    pub const HEALING: &str = "srd_5_2_1:combat:healing";
    pub const TEMPORARY_HP: &str = "srd_5_2_1:combat:temporary-hit-points";
    pub const ZERO_HP: &str = "srd_5_2_1:combat:zero-hit-points";
    pub const RESISTANCE: &str = "srd_5_2_1:combat:damage-modifiers";
    pub const RESOURCE: &str = "srd_5_2_1:resources:spending";
    pub const ECONOMY_COINS: &str = "srd_5_2_1:economy:coins";
    pub const SELLING_EQUIPMENT: &str = "srd_5_2_1:economy:selling-equipment";
    pub const CONDITIONS: &str = "srd_5_2_1:conditions:common";
    pub const INITIATIVE: &str = "srd_5_2_1:combat:initiative";
    pub const TURNS: &str = "srd_5_2_1:combat:turn-economy";
    pub const ACTIONS: &str = "srd_5_2_1:combat:turn-economy";
    pub const REACTION: &str = "srd_5_2_1:combat:reaction";
    pub const CONCENTRATION: &str = "srd_5_2_1:spells:concentration";
    pub const AURA_OF_PROTECTION: &str = "srd_5_2_1:classes:paladin-aura-of-protection";
    pub const INDOMITABLE: &str = "srd_5_2_1:classes:fighter-indomitable";
}

/// `RULE_IDS` в порядке ключей JS (для сверки и выгрузки).
pub const RULE_IDS: [(&str, &str); 22] = [
    ("abilityCheck", rule_ids::ABILITY_CHECK),
    ("savingThrow", rule_ids::SAVING_THROW),
    ("advantage", rule_ids::ADVANTAGE),
    ("attack", rule_ids::ATTACK),
    ("armorClass", rule_ids::ARMOR_CLASS),
    ("criticalHit", rule_ids::CRITICAL_HIT),
    ("damage", rule_ids::DAMAGE),
    ("healing", rule_ids::HEALING),
    ("temporaryHp", rule_ids::TEMPORARY_HP),
    ("zeroHp", rule_ids::ZERO_HP),
    ("resistance", rule_ids::RESISTANCE),
    ("resource", rule_ids::RESOURCE),
    ("economyCoins", rule_ids::ECONOMY_COINS),
    ("sellingEquipment", rule_ids::SELLING_EQUIPMENT),
    ("conditions", rule_ids::CONDITIONS),
    ("initiative", rule_ids::INITIATIVE),
    ("turns", rule_ids::TURNS),
    ("actions", rule_ids::ACTIONS),
    ("reaction", rule_ids::REACTION),
    ("concentration", rule_ids::CONCENTRATION),
    ("auraOfProtection", rule_ids::AURA_OF_PROTECTION),
    ("indomitable", rule_ids::INDOMITABLE),
];

use rule_ids as r;

/// `COMMAND_RULES`: правила, на которые опирается команда без явного
/// `source_rule_ids`. Порядок — как в JS.
pub const COMMAND_RULES: &[(&str, &[&str])] = &[
    ("MakeAbilityCheck", &[r::ABILITY_CHECK]),
    ("IdentifyEnemy", &[r::ABILITY_CHECK, r::TURNS]),
    ("MakeSavingThrow", &[r::SAVING_THROW]),
    ("MakeAttack", &[r::ATTACK]),
    ("MakeAreaAttack", &[r::ATTACK, r::DAMAGE]),
    ("UseMonsterAction", &[r::ACTIONS, r::SAVING_THROW, r::DAMAGE]),
    ("ChangeWeapon", &[r::ACTIONS]),
    ("ApplyDamage", &[r::DAMAGE]),
    ("ApplyHealing", &[r::HEALING]),
    ("ReduceHitPointMaximum", &[r::DAMAGE, r::CONDITIONS]),
    ("ResolveHeroDeath", &[r::ZERO_HP, r::HEALING]),
    ("GrantTemporaryHitPoints", &[r::TEMPORARY_HP]),
    ("SpendResource", &[r::RESOURCE]),
    ("RestoreResource", &[r::RESOURCE]),
    ("AddCondition", &[r::CONDITIONS]),
    ("RemoveCondition", &[r::CONDITIONS]),
    ("CastSpell", &[r::TURNS]),
    ("UseLegendaryAction", &[r::TURNS]),
    ("PickpocketNpc", &[r::ABILITY_CHECK]),
    ("UseCombatAction", &[r::ACTIONS]),
    ("MoveActor", &[r::TURNS]),
    ("OperateDoor", &[r::TURNS]),
    ("BarricadeDoor", &[r::TURNS]),
    ("ClearDoorBarricade", &[r::TURNS]),
    ("OperateSceneObject", &[r::TURNS]),
    ("StartCombat", &[r::INITIATIVE]),
    ("AttackNpc", &[r::INITIATIVE]),
    ("EndCombat", &[r::INITIATIVE, r::TURNS]),
    ("EndTurn", &[r::TURNS]),
    ("AdvanceTime", &[r::RESOURCE]),
    ("StartRest", &[r::RESOURCE]),
    ("SpendHitPointDie", &[r::RESOURCE, r::HEALING]),
    ("CompleteRest", &[r::RESOURCE]),
    ("StartConcentration", &[r::CONCENTRATION]),
    ("EndConcentration", &[r::CONCENTRATION]),
    ("CreateEncounter", &[]),
    ("BargainWithMerchant", &[]),
    ("AppraiseItem", &[]),
    ("BuyItem", &[r::ECONOMY_COINS]),
    ("SellItem", &[r::ECONOMY_COINS, r::SELLING_EQUIPMENT]),
    ("PurchaseMerchantService", &[r::ECONOMY_COINS]),
    ("CreateMerchant", &[]),
    ("ConfigureMerchant", &[]),
    ("RestockMerchant", &[]),
    ("MoveMerchant", &[]),
    ("SetMerchantAvailability", &[]),
    ("AdvanceScene", &[]),
    ("UpsertWorldEntity", &[]),
    ("RecordWorldFact", &[]),
    ("RevealWorldFact", &[]),
    ("RecordKnowledgeRevelation", &[]),
    ("RecordWorldRelationship", &[]),
    ("UpsertQuest", &[]),
    ("AdvanceQuestClock", &[]),
    ("ResolveQuest", &[]),
    ("InvalidateQuest", &[]),
    ("CompleteCampaign", &[]),
    ("UpsertNarrativeThread", &[]),
    ("AdvanceNarrativeThreadClock", &[]),
    ("RecordNpcBelief", &[]),
    ("RecordRumor", &[]),
    ("ResolveEpistemicClaim", &[]),
    ("RecordNarrativeSummary", &[]),
    ("UpsertNpcSocialProfile", &[]),
    ("RecordNpcSocialTurn", &[]),
    ("ResolveNpcPromise", &[]),
    ("PlaceNpc", &[]),
    ("MoveNpc", &[]),
    ("HarmNpc", &[r::DAMAGE]),
    ("InterrogateCaptive", &[r::ABILITY_CHECK]),
    ("ReleaseCaptive", &[]),
    ("HandCaptiveToGuards", &[]),
    ("FeedCaptive", &[]),
    ("ExecuteCaptive", &[r::DAMAGE]),
    ("NeglectCaptive", &[]),
    ("CalmBeast", &[r::ABILITY_CHECK, r::DAMAGE, r::TURNS, r::RESOURCE]),
    ("FeedBeast", &[r::TURNS, r::RESOURCE]),
    ("ScareWithBeast", &[]),
    ("ProposeParley", &[r::ABILITY_CHECK, r::TURNS]),
    ("SettleParley", &[]),
    ("ResolveGuardEncounter", &[r::ABILITY_CHECK, r::ECONOMY_COINS]),
    ("ClearWantedLevel", &[]),
    ("LootContainer", &[r::TURNS]),
    ("OpenTavernDiceRound", &[r::ECONOMY_COINS]),
    ("AnswerTavernDiceRound", &[r::ABILITY_CHECK, r::ECONOMY_COINS]),
    ("LeaveTavernDiceRound", &[r::ECONOMY_COINS]),
    ("OrderTavernDrink", &[r::SAVING_THROW, r::ECONOMY_COINS]),
    ("SendLetter", &[r::ECONOMY_COINS]),
    ("ReceiveNpcBlessing", &[r::ECONOMY_COINS, r::CONDITIONS]),
    ("StageScenarioStranger", &[r::SAVING_THROW, r::DAMAGE]),
    ("ReturnKnightHead", &[r::TURNS]),
    ("ReleaseCursedKnight", &[r::ABILITY_CHECK]),
    ("NegotiateScenarioTreaty", &[r::ABILITY_CHECK]),
    ("ReceiveScenarioPurse", &[r::ECONOMY_COINS]),
    ("ChooseScenarioArmoryItem", &[]),
    ("ResolveScenarioInformant", &[]),
    ("ChooseDialogueOption", &[]),
    ("SetCharacterChoices", &[]),
    ("SetSpellSelections", &[]),
    ("SetSpellBonusPreference", &[r::CONDITIONS]),
    ("SetReactionPreference", &[r::REACTION]),
    ("EquipItem", &[r::ACTIONS]),
    ("UseItem", &[r::ACTIONS]),
    ("TransferItem", &[]),
    ("AttuneItem", &[]),
    ("ActivateItem", &[r::ACTIONS]),
    ("LevelUp", &[r::RESOURCE]),
    ("ImportCharacter", &[r::RESOURCE]),
    ("RollCharacterAbilities", &[r::RESOURCE]),
    ("RollCharacterWealth", &[r::RESOURCE]),
];

/// `COMMAND_RULES[commandType]` (без ключей прототипа).
pub fn command_rules_for(command_type: &str) -> Option<&'static [&'static str]> {
    COMMAND_RULES.iter().find(|(kind, _)| *kind == command_type).map(|(_, rules)| *rules)
}

/// `sourceIdsFor(command, state)`: явные правила команды (без чужой редакции)
/// или правила её типа в редакции кампании.
pub fn source_ids_for(command: &serde_json::Map<String, Value>, state: &Value) -> Result<Vec<String>, Halt> {
    let explicit_source = command.get("source_rule_ids").filter(|value| !value.is_null()).or_else(|| command.get("sourceRuleIds"));
    let explicit = unique_strings(explicit_source);
    let ruleset_id = match state.get("ruleset_id").filter(|value| sk_core::js::truthy(Some(value))) {
        Some(value) => sk_core::js::string(Some(value)),
        None => DEFAULT_RULESET_ID.to_string(),
    };
    let foreign = explicit.iter().find(|rule_id| {
        INSTALLED_RULESET_IDS.iter().find(|candidate| rule_id.starts_with(&format!("{candidate}:"))).is_some_and(|owner| *owner != ruleset_id)
    });
    if let Some(foreign) = foreign {
        return Err(rule(format!("Rule id {foreign} принадлежит другой редакции"), "RULESET_RULE_ID_MISMATCH"));
    }
    if !explicit.is_empty() {
        return Ok(explicit);
    }
    let command_type = sk_core::js::s(command.get("command_type"));
    match command_rules_for(&command_type) {
        Some(rules) => Ok(rules.iter().map(|rule_id| ruleset_rule_id(rule_id, &ruleset_id)).collect()),
        None => Ok(Vec::new()),
    }
}

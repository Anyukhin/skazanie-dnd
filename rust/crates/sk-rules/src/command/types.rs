//! Типы команд: `ALLOWED_COMMAND_TYPES`, наборы жизненного цикла, `needsActor`
//! (`rules-engine.mjs`, 908–947, 4875–4887) и множества команд модулей,
//! которые движок разбирает сам. Задача Р0.
//!
//! Модули, чьих крейтов ещё нет (`npc-positioning`, `captives`, `beast-taming`,
//! `loot-containers`, `tavern-life`, `courier-letters`, `blessings`,
//! `scenario-knight`, `campaign-dialogues`, `item-lifecycle`,
//! `character-lifecycle`), даны здесь частной копией; эталон сверяет их с JS
//! (`fixtures/gen-core.mjs`, раздел `sets`). Остальные берутся из крейтов.

use std::sync::LazyLock;

use sk_core::indexmap::IndexSet;

pub use sk_attention::scenario_attention::{
    SCENARIO_ARMORY_COMMAND_TYPES, SCENARIO_ARMORY_POLICY_ID, SCENARIO_COMMAND_TYPES, SCENARIO_INFORMANT_COMMAND_TYPES, SCENARIO_INFORMANT_POLICY_ID,
    SCENARIO_PURSE_COMMAND_TYPES, SCENARIO_STRANGER_STAGES, SCENARIO_TREATY_COMMAND_TYPES,
};
pub use sk_combat_content::character_build::CHARACTER_BUILD_COMMAND_TYPES;
pub use sk_economy::merchant_economy::ECONOMY_POLICY_ID;
pub use sk_memory::world_memory::WORLD_MEMORY_COMMAND_TYPES;
pub use sk_scene_base::talespire_slab::SLAB_MAX_TEXT_LENGTH;
pub use sk_social::npc_social::NPC_SOCIAL_COMMAND_TYPES;
pub use sk_society::law_and_order::{GUARD_ESCAPE_SKILLS, LAW_COMMAND_TYPES, LAW_POLICY_ID};
pub use sk_society::parley::{PARLEY_COMMAND_TYPES, PARLEY_POLICY_ID, PARLEY_SKILLS, TRUCE_BREAKING_COMMAND_TYPES};
pub use sk_world_life::courier_letters::{courier_addressee_for, courier_letter_promise_from, courier_tone_for, COURIER_LETTER_ADDRESSEE_KINDS};

/// `npc-positioning.mjs`: `NPC_WORLD_COMMAND_TYPES`.
pub const NPC_WORLD_COMMAND_TYPES: [&str; 3] = ["PlaceNpc", "MoveNpc", "HarmNpc"];
/// `captives.mjs`: `CAPTIVE_PLAYER_COMMAND_TYPES`.
pub const CAPTIVE_PLAYER_COMMAND_TYPES: [&str; 5] = ["InterrogateCaptive", "ReleaseCaptive", "HandCaptiveToGuards", "FeedCaptive", "ExecuteCaptive"];
/// `captives.mjs`: `CAPTIVE_COMMAND_TYPES`.
pub const CAPTIVE_COMMAND_TYPES: [&str; 6] = ["InterrogateCaptive", "ReleaseCaptive", "HandCaptiveToGuards", "FeedCaptive", "ExecuteCaptive", "NeglectCaptive"];
/// `captives.mjs`: `CAPTIVE_INTERROGATION_SKILLS`.
pub const CAPTIVE_INTERROGATION_SKILLS: [&str; 2] = ["persuasion", "intimidation"];
/// `captives.mjs`: `CAPTIVES_POLICY_ID`.
pub const CAPTIVES_POLICY_ID: &str = "skazanie:captives-v1";
/// `beast-taming.mjs`: `BEAST_COMMAND_TYPES`.
pub const BEAST_COMMAND_TYPES: [&str; 3] = ["CalmBeast", "FeedBeast", "ScareWithBeast"];
/// `beast-taming.mjs`: `BEAST_TAMING_POLICY_ID`.
pub const BEAST_TAMING_POLICY_ID: &str = "skazanie:beast-taming-v1";
/// `loot-containers.mjs`: `LOOT_CONTAINER_COMMAND_TYPES`.
pub const LOOT_CONTAINER_COMMAND_TYPES: [&str; 1] = ["LootContainer"];
/// `loot-containers.mjs`: `LOOT_CONTAINERS_POLICY_ID`.
pub const LOOT_CONTAINERS_POLICY_ID: &str = "skazanie:loot-containers-v1";
/// `loot-containers.mjs`: `MAX_LOOT_LINES`.
pub const MAX_LOOT_LINES: usize = 12;
/// `tavern-life.mjs`: `TAVERN_COMMAND_TYPES`.
pub const TAVERN_COMMAND_TYPES: [&str; 4] = ["OpenTavernDiceRound", "AnswerTavernDiceRound", "LeaveTavernDiceRound", "OrderTavernDrink"];
/// `tavern-life.mjs`: `TAVERN_DICE_APPROACHES`.
pub const TAVERN_DICE_APPROACHES: [&str; 3] = ["fair", "cheat", "watch"];
/// `tavern-life.mjs`: `TAVERN_STAKES_CP`.
pub const TAVERN_STAKES_CP: [i64; 3] = [10, 50, 200];
/// `tavern-life.mjs`: `TAVERN_POLICY_ID`.
pub const TAVERN_POLICY_ID: &str = "skazanie:tavern-life-v1";
/// `courier-letters.mjs`: `COURIER_LETTER_COMMAND_TYPES`.
pub const COURIER_LETTER_COMMAND_TYPES: [&str; 1] = ["SendLetter"];
/// `courier-letters.mjs`: `COURIER_LETTER_BODY_LIMIT`.
pub const COURIER_LETTER_BODY_LIMIT: usize = 1_200;
/// `courier-letters.mjs`: `COURIER_LETTERS_POLICY_ID`.
pub const COURIER_LETTERS_POLICY_ID: &str = "skazanie:courier-letters-v1";
/// `blessings.mjs`: `BLESSING_COMMAND_TYPES`.
pub const BLESSING_COMMAND_TYPES: [&str; 1] = ["ReceiveNpcBlessing"];
/// `blessings.mjs`: `BLESSINGS_POLICY_ID`.
pub const BLESSINGS_POLICY_ID: &str = "skazanie:blessings-v1";
/// `scenario-knight.mjs`: `SCENARIO_KNIGHT_COMMAND_TYPES`.
pub const SCENARIO_KNIGHT_COMMAND_TYPES: [&str; 2] = ["ReturnKnightHead", "ReleaseCursedKnight"];
/// `campaign-dialogues.mjs`: `DIALOGUE_COMMAND_TYPE`.
pub const DIALOGUE_COMMAND_TYPE: &str = "ChooseDialogueOption";
/// `campaign-dialogues.mjs`: `DIALOGUE_POLICY_ID`.
pub const DIALOGUE_POLICY_ID: &str = "skazanie:authored-dialogue-v1";
/// `item-lifecycle.mjs`: `ITEM_LIFECYCLE_COMMAND_TYPES`.
pub const ITEM_LIFECYCLE_COMMAND_TYPES: [&str; 5] = ["EquipItem", "UseItem", "TransferItem", "AttuneItem", "ActivateItem"];
/// `character-lifecycle.mjs`: `CHARACTER_LIFECYCLE_COMMAND_TYPES`.
pub const CHARACTER_LIFECYCLE_COMMAND_TYPES: [&str; 4] = ["LevelUp", "ImportCharacter", "RollCharacterAbilities", "RollCharacterWealth"];

/// `MERCHANT_LIFECYCLE_COMMAND_TYPES`.
pub const MERCHANT_LIFECYCLE_COMMAND_TYPES: [&str; 5] = ["CreateMerchant", "ConfigureMerchant", "RestockMerchant", "MoveMerchant", "SetMerchantAvailability"];
/// `ENCOUNTER_LIFECYCLE_COMMAND_TYPES`.
pub const ENCOUNTER_LIFECYCLE_COMMAND_TYPES: [&str; 1] = ["CreateEncounter"];

/// `ALLOWED_COMMAND_TYPES` в порядке вставки `Set` JS.
pub static ALLOWED_COMMAND_TYPES: LazyLock<IndexSet<&'static str>> = LazyLock::new(|| {
    let mut set = IndexSet::new();
    let explicit: &[&str] = &[
        "UseMonsterAction",
        "DeclareAction", "MakeAbilityCheck", "MakeSavingThrow", "MakeAttack", "ApplyDamage", "ApplyHealing", "ReduceHitPointMaximum",
        "ResolveHeroDeath",
        "GrantTemporaryHitPoints", "SpendResource", "RestoreResource", "AddCondition", "RemoveCondition",
        "CastSpell", "UseLegendaryAction", "PickpocketNpc", "UseCombatAction", "ResolveImprovisedAction", "IdentifyEnemy", "MoveActor", "OperateDoor", "BarricadeDoor",
        "ClearDoorBarricade", "OperateSceneObject", "UseLevelTransition", "StartCombat", "AttackNpc", "EndCombat", "EndTurn", "ChangeWeapon", "MakeAreaAttack",
        "AdvanceTime", "StartRest", "SpendHitPointDie", "CompleteRest",
        "StartConcentration", "EndConcentration", "RevealArea", "UpdateObjective", "SpawnEntity", "GrantItem",
        "RecordRuling", "BargainWithMerchant", "AppraiseItem", "BuyItem", "SellItem", "PurchaseMerchantService",
        "CreateMerchant", "ConfigureMerchant", "RestockMerchant", "MoveMerchant", "SetMerchantAvailability", "CreateEncounter",
        "AdvanceScene", "ImportLocationMap", "RebuildLocationMap",
        "UpsertWorldEntity", "RecordWorldFact", "RevealWorldFact", "RecordKnowledgeRevelation",
        "RecordWorldRelationship", "UpsertQuest", "AdvanceQuestClock", "ResolveQuest", "InvalidateQuest",
        "UpsertNarrativeThread", "AdvanceNarrativeThreadClock",
        "RecordNpcBelief", "RecordRumor", "ResolveEpistemicClaim", "RecordNarrativeSummary",
        "UpsertNpcSocialProfile", "RecordNpcSocialTurn", "ResolveNpcPromise",
    ];
    set.extend(explicit.iter().copied());
    set.extend(NPC_WORLD_COMMAND_TYPES);
    set.extend(CAPTIVE_COMMAND_TYPES);
    set.extend(BEAST_COMMAND_TYPES);
    set.extend(PARLEY_COMMAND_TYPES);
    set.extend(LAW_COMMAND_TYPES);
    set.extend(LOOT_CONTAINER_COMMAND_TYPES);
    set.extend(TAVERN_COMMAND_TYPES);
    set.extend(COURIER_LETTER_COMMAND_TYPES);
    set.extend(BLESSING_COMMAND_TYPES);
    set.extend(SCENARIO_COMMAND_TYPES);
    set.extend(SCENARIO_KNIGHT_COMMAND_TYPES);
    set.extend(SCENARIO_TREATY_COMMAND_TYPES);
    set.extend(SCENARIO_PURSE_COMMAND_TYPES);
    set.extend(SCENARIO_ARMORY_COMMAND_TYPES);
    set.extend(SCENARIO_INFORMANT_COMMAND_TYPES);
    set.insert(DIALOGUE_COMMAND_TYPE);
    set.extend(["SetCharacterChoices", "SetSpellSelections", "SetSpellBonusPreference", "SetReactionPreference"]);
    set.extend(["EquipItem", "UseItem", "TransferItem", "AttuneItem", "ActivateItem", "LevelUp", "ImportCharacter", "RollCharacterAbilities", "RollCharacterWealth"]);
    set.extend(["CompleteCampaign", "AdvanceCampaignArc", "ResolveQuestDecision"]);
    set
});

/// `ALLOWED_COMMAND_TYPES.has(type)`.
pub fn is_allowed_command_type(command_type: &str) -> bool {
    ALLOWED_COMMAND_TYPES.contains(command_type)
}

/// Команды, которым нужен действующий персонаж (`needsActor`).
pub const NEEDS_ACTOR_COMMAND_TYPES: &[&str] = &[
    "UseMonsterAction", "DeclareAction", "MakeAbilityCheck", "MakeSavingThrow", "MakeAttack", "MakeAreaAttack", "ChangeWeapon", "ApplyDamage", "ApplyHealing", "ReduceHitPointMaximum",
    "ResolveHeroDeath",
    "GrantTemporaryHitPoints", "SpendResource", "RestoreResource", "AddCondition", "RemoveCondition", "CastSpell",
    "UseCombatAction", "MoveActor", "BarricadeDoor", "ClearDoorBarricade", "OperateSceneObject", "UseLevelTransition", "EndCombat", "EndTurn", "StartRest", "SpendHitPointDie",
    "CompleteRest", "StartConcentration", "EndConcentration", "GrantItem",
    "ProposeParley", "SettleParley", "ResolveGuardEncounter", "LootContainer", "AttackNpc",
    "CalmBeast", "FeedBeast", "ScareWithBeast",
    "OpenTavernDiceRound", "AnswerTavernDiceRound", "LeaveTavernDiceRound", "OrderTavernDrink",
    "SendLetter", "ReceiveNpcBlessing", "ReturnKnightHead", "ReleaseCursedKnight", "NegotiateScenarioTreaty", "ReceiveScenarioPurse", "ChooseScenarioArmoryItem",
    "ResolveScenarioInformant",
    "ChooseDialogueOption",
    "BargainWithMerchant", "AppraiseItem", "BuyItem", "SellItem", "PurchaseMerchantService",
    "EquipItem", "UseItem", "TransferItem", "AttuneItem", "ActivateItem", "SetCharacterChoices", "SetSpellSelections", "LevelUp", "ImportCharacter",
];

/// `needsActor(type)`.
pub fn needs_actor(command_type: &str) -> bool {
    NEEDS_ACTOR_COMMAND_TYPES.contains(&command_type)
}

/// `set.has(value)` для набора строк.
pub fn has(set: &[&str], value: &str) -> bool {
    set.contains(&value)
}

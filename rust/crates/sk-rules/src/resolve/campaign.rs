//! Ветки `resolveCommandInternal`: Кампания и память мира: решение отряда, цель, 15 команд памяти мира, финал, дуга, социальные профили NPC. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 22744–22748, 22749–22751, 22775–22799, 22800–22814, 22815–22837, 22840–22857. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `ResolveQuestDecision` (22744–22748).
pub fn resolve_quest_decision(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ResolveQuestDecision").into())
}

/// `UpdateObjective` (22749–22751).
pub fn update_objective(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:UpdateObjective").into())
}

/// `UpsertWorldEntity`, `RecordWorldFact`, `RevealWorldFact`, `RecordKnowledgeRevelation`, `RecordWorldRelationship`, `UpsertQuest`, `AdvanceQuestClock`, `ResolveQuest`, `InvalidateQuest`, `UpsertNarrativeThread`, `AdvanceNarrativeThreadClock`, `RecordNpcBelief`, `RecordRumor`, `ResolveEpistemicClaim`, `RecordNarrativeSummary` (22775–22799).
pub fn world_memory(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:UpsertWorldEntity").into())
}

/// `CompleteCampaign` (22800–22814).
pub fn complete_campaign(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:CompleteCampaign").into())
}

/// `AdvanceCampaignArc` (22815–22837).
pub fn advance_campaign_arc(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:AdvanceCampaignArc").into())
}

/// `UpsertNpcSocialProfile`, `RecordNpcSocialTurn`, `ResolveNpcPromise` (22840–22857).
pub fn npc_social(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:UpsertNpcSocialProfile").into())
}

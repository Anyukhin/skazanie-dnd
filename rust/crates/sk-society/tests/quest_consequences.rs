//! Сверка `quest_consequences` и `campaign_stories` с эталонами JS
//! (`fixtures/gen-quest-consequences.mjs`): сценарии дворца Асстохана из
//! `test/quest-consequence-knowledge.test.mjs` и случайные границы знания.

mod common;

use common::{Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_society::campaign_stories::*;
use sk_society::quest_consequences::*;

fn quest_dispatch(name: &str, args: &Args) -> Outcome {
    match name {
        "knowledgeGateForEvent" => Outcome::of(knowledge_gate_for_event(args.val(0), args.val(1))),
        "knowledgeGateVisible" => Outcome::of(knowledge_gate_visible(args.opt(0), args.val(1), args.val(2))),
        "normalizeQuestKnowledgeHistory" => Outcome::of(normalize_quest_knowledge_history(args.opt(0))),
        "recordQuestKnowledge" => Outcome::of(record_quest_knowledge(args.val(0), args.val(1))),
        "questForKnowledge" => Outcome::of(quest_for_knowledge(args.val(0), args.val(1), args.val(2))),
        "questStateForViewer" => Outcome::of(quest_state_for_viewer(args.val(0), args.val(1))),
        "normalizeQuestResponsibility" => Outcome::option(normalize_quest_responsibility(args.opt(0))),
        "questGiverId" => match quest_giver_id(args.val(0), args.opt(1)) {
            Some(id) => Outcome::of(id),
            // У личного поручения без `npc_id` JS возвращает `undefined`, у прочих — `null`.
            None if args.opt(1).and_then(|value| value.get("type")) == Some(&json!("npc")) => Outcome::Value(None),
            None => Outcome::of(Value::Null),
        },
        "questIsImpossible" => Outcome::of(quest_is_impossible(args.val(0), args.opt(1))),
        "questInvalidationDraft" => Outcome::option(quest_invalidation_draft(args.val(0), args.val(1), args.val(2))),
        "planQuestConsequenceDrafts" => Outcome::of(plan_quest_consequence_drafts(args.val(0), &args.list(1), args.val(2))),
        _ => Outcome::Unknown,
    }
}

fn story_dispatch(name: &str, args: &Args) -> Outcome {
    match name {
        "validateCampaignMode" => match validate_campaign_mode(args.opt(0)) {
            Ok(mode) => Outcome::of(mode),
            Err(error) => Outcome::Throws { code: Some(error.code), message: error.message },
        },
        "campaignModeFor" => Outcome::of(campaign_mode_for(args.val(0))),
        "persistentStoryQuest" => Outcome::option(persistent_story_quest(args.val(0)).cloned()),
        "campaignStoryCompletionDraft" => match campaign_story_completion_draft(args.val(0), &args.list(1)) {
            Ok(draft) => Outcome::option(draft),
            Err(error) => Outcome::Throws { code: Some(error.code), message: error.message },
        },
        "campaignStoryChronicleEntry" => Outcome::option(campaign_story_chronicle_entry(args.val(0))),
        _ => Outcome::Unknown,
    }
}

#[test]
fn quest_consequences_match_js() {
    let fixture = Fixture::load(include_str!("../fixtures/quest-consequences.json"));
    assert!(fixture.check(quest_dispatch) > 1_000);
    assert_eq!(fixture.root["constants"]["QUEST_CONSEQUENCE_POLICY_ID"], json!(QUEST_CONSEQUENCE_POLICY_ID));
}

#[test]
fn campaign_stories_match_js() {
    let fixture = Fixture::load(include_str!("../fixtures/campaign-stories.json"));
    assert!(fixture.check(story_dispatch) > 500);
    assert_eq!(fixture.root["constants"], json!({ "CAMPAIGN_MODES": CAMPAIGN_MODES, "PERSISTENT_WORLD_OBJECTIVE": PERSISTENT_WORLD_OBJECTIVE }));
}

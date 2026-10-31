//! Сверка `npc_social` с эталонами JS (`fixtures/gen-npc-social.mjs`):
//! нормализация сотен социальных состояний, в том числе мусорных, редьюсер по
//! цепочкам событий в режимах `current` и `legacy`, проверка команд с кодами
//! отказов, граница знания, проекция для игрока и досье Рассказчика.

mod common;

use common::{Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_core::js;
use sk_social::npc_social::*;
use sk_society::retention_context::with_retention_mode;

static NULL: Value = Value::Null;

fn legacy<T>(operation: impl FnOnce() -> T) -> T {
    with_retention_mode("legacy", operation).expect("режим legacy известен")
}

fn strings(values: impl IntoIterator<Item = String>) -> Value {
    Value::Array(values.into_iter().map(Value::String).collect())
}

fn pairs(map: sk_core::indexmap::IndexMap<String, String>) -> Value {
    Value::Array(map.into_iter().map(|(key, value)| json!([key, value])).collect())
}

fn dispatch(name: &str, args: &Args) -> Outcome {
    match name {
        "relationshipTier" => Outcome::of(relationship_tier(args.val(0))),
        "promiseDueOffsetMinutes" => Outcome::option(promise_due_offset_minutes(args.val(0))),
        "campaignElapsedMinutes" => Outcome::of(js::num(campaign_elapsed_minutes(args.val(0)))),
        "npcSpeechProfile" => Outcome::of(npc_speech_profile(args.val(0))),
        "npcBehaviorPolicy" => Outcome::of(npc_behavior_policy(args.val(0), args.opt(1))),
        "npcScheduleEntryAt" => Outcome::option(npc_schedule_entry_at(args.val(0), args.val(1))),
        "npcProfileAtWorldTime" => Outcome::of(npc_profile_at_world_time(args.val(0), args.val(1))),
        "npcProfileForViewerAt" => Outcome::of(npc_profile_for_viewer_at(args.val(0), args.val(1))),
        "normalizeNpcSocialState" => Outcome::of(normalize_npc_social_state(args.val(0), args.val(1))),
        "normalizeNpcSocialState@legacy" => Outcome::of(legacy(|| normalize_npc_social_state(args.val(0), &NULL))),
        "normalizeNpcSocialStateLegacy" => Outcome::of(normalize_npc_social_state_legacy(args.val(0))),
        "ensureNpcSocialState" => Outcome::of(ensure_npc_social_state(args.val(0), args.val(1), args.val(2))),
        "ensureNpcSocialState@legacy" => Outcome::of(legacy(|| ensure_npc_social_state(args.val(0), args.val(1), &NULL))),
        "npcSocialForViewer" => Outcome::of(npc_social_for_viewer(args.val(0), args.val(1))),
        "implicitSecretHolderIds" => Outcome::of(pairs(implicit_secret_holder_ids(args.val(0), None))),
        "implicitSecretHolderIds@social" => {
            let state = args.val(0);
            let social = ensure_npc_social_state(state.get("social").unwrap_or(&NULL), state, &NULL);
            Outcome::of(pairs(implicit_secret_holder_ids(state, Some(&social))))
        }
        "npcSecretMeta" => Outcome::of(npc_secret_meta(args.val(0)).to_json()),
        "npcKnownFactIds" => Outcome::of(strings(npc_known_fact_ids(args.val(0), args.val(1)))),
        "npcWitnessedFactIds" => Outcome::of(strings(npc_witnessed_fact_ids(args.val(0), args.val(1)))),
        "validateNpcSocialCommand" => match validate_npc_social_command(args.val(0), args.val(1), args.val(2)) {
            Ok(command) => Outcome::of(command),
            Err(error) => Outcome::Throws { code: Some(error.code), message: error.message },
        },
        "npcSocialEvents" => Outcome::of(npc_social_events(args.val(0), args.val(1))),
        "npcRelationshipEventDrafts" => Outcome::of(npc_relationship_event_drafts(args.val(0), args.val(1))),
        "npcPromiseDeadlineEvents" => Outcome::of(npc_promise_deadline_events(args.val(0), args.val(1))),
        "applyNpcSocialEvent" => Outcome::of(apply_npc_social_event(args.val(0), args.val(1), args.val(2), args.val(3))),
        "applyNpcSocialEvent@legacy" => Outcome::of(legacy(|| apply_npc_social_event(args.val(0), args.val(1), args.val(2), &NULL))),
        "npcDossiersForNarrator" => Outcome::of(npc_dossiers_for_narrator(args.val(0))),
        "npcConversationNarration" => Outcome::option(npc_conversation_narration(&args.list(0), args.val(1))),
        _ => Outcome::Unknown,
    }
}

#[test]
fn npc_social_matches_js() {
    let fixture = Fixture::load(include_str!("../fixtures/npc-social.json"));
    let checked = fixture.check(dispatch);
    assert!(checked > 4_000, "эталонных случаев {checked}");
}

#[test]
fn npc_social_constants_match_js() {
    let fixture = Fixture::load(include_str!("../fixtures/npc-social.json"));
    let rust = json!({
        "NPC_DOSSIER_PROFILE_LIMIT": NPC_DOSSIER_PROFILE_LIMIT,
        "NPC_NARRATOR_DOSSIER_LIMITS": NPC_NARRATOR_DOSSIER_LIMITS.to_json(),
        "NPC_SOCIAL_COMMAND_TYPES": NPC_SOCIAL_COMMAND_TYPES,
    });
    assert_eq!(serde_json::to_string(&rust).ok(), serde_json::to_string(&fixture.root["constants"]).ok());
}

#[test]
fn every_reducer_event_type_has_cases() {
    let fixture = Fixture::load(include_str!("../fixtures/npc-social.json"));
    for event_type in ["NpcSocialProfileUpserted", "NpcConversationRecorded", "NpcRelationshipAdjusted", "NpcRelationshipTierChanged", "NpcPromiseRecorded", "NpcPromiseResolved"] {
        let count = fixture
            .cases
            .iter()
            .filter(|case| case.name.starts_with("applyNpcSocialEvent"))
            .filter(|case| case.args.get(1).and_then(Option::as_ref).and_then(|event| event.get("event_type")).and_then(Value::as_str) == Some(event_type))
            .count();
        assert!(count >= 10, "{event_type}: {count} случаев редьюсера");
    }
}

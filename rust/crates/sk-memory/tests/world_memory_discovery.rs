//! Сверка находок и заготовок ведущего `world_memory` с эталоном
//! `server/world-memory.mjs` (`fixtures/gen-world-memory-discovery.mjs`):
//! кампании авторских миров с правками, сотни фраз, навыков и бросков.

mod common;

use common::{js_string, Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_memory::world_memory::*;

fn dispatch(name: &str, args: &Args) -> Outcome {
    match name {
        "freeActionDiscoveryCommands" => Outcome::of(free_action_discovery_commands(args.val(0), &args.obj(1))),
        "freeActionSurfaceCommands" => Outcome::of(free_action_surface_commands(args.val(0), &args.obj(1))),
        "thoroughSearchOutcome" => Outcome::option(thorough_search_outcome(args.val(0), &args.obj(1))),
        "insightRead" => Outcome::of(insight_read(args.val(0), &args.obj(1))),
        "cultNameFrom" => Outcome::of(cult_name_from(args.val(0))),
        "corpseClueCommand" => Outcome::option(corpse_clue_command(args.val(0), &args.obj(1))),
        "isThoroughSearch" => Outcome::of(is_thorough_search(args.opt(0))),
        "thoroughSearchDetail" => Outcome::of(thorough_search_detail(args.opt(0), args.opt(1))),
        "normalizeGmSecrets" => {
            let limit = args.opt(1).map_or(4, |limit| sk_core::js::safe_int(Some(limit), 4));
            Outcome::of(normalize_gm_secrets(args.opt(0), limit))
        }
        "gmSecretFact" => Outcome::of(gm_secret_fact(args.val(0), &args.obj(1))),
        "parseGmSecretObject" => Outcome::of(parse_gm_secret_object(args.opt(0))),
        "questStatusForOutcome" => Outcome::of(quest_status_for_outcome(args.opt(0))),
        "questProgressEvidenceFor" => {
            let quest_id = match args.opt(1) {
                None => String::new(),
                id => js_string(id),
            };
            Outcome::of(quest_progress_evidence_for(args.val(0), &quest_id, sk_core::js::truthy(args.opt(2))))
        }
        _ => Outcome::Unknown,
    }
}

fn fixture() -> Fixture {
    Fixture::load(include_str!("../fixtures/world-memory-discovery.json"))
}

#[test]
fn discovery_matches_js() {
    let total = fixture().check(dispatch);
    assert!(total > 5_000, "эталон подозрительно мал: {total}");
}

#[test]
fn constants_match_js() {
    let fixture = fixture();
    let rust = json!({
        "DISCOVERY_SKILLS": DISCOVERY_SKILLS,
        "GM_SECRET_SKILLS": GM_SECRET_SKILLS,
        "THOROUGH_SEARCH_MINUTES": THOROUGH_SEARCH_MINUTES,
        "WORLD_MEMORY_COMMAND_TYPES": WORLD_MEMORY_COMMAND_TYPES,
        "CLOSED_QUEST_STATUSES": CLOSED_QUEST_STATUSES,
        "QUEST_ABANDONMENT_NEXT_OBJECTIVE": QUEST_ABANDONMENT_NEXT_OBJECTIVE,
    });
    assert_eq!(fixture.root["constants"], rust);
}

fn check(skill: &str, event_id: &str) -> Value {
    json!({ "event_id": event_id, "event_type": "AbilityCheckResolved", "payload": { "success": true, "skill": skill } })
}

/// Сцена без заготовок из `test/discovery-content.test.mjs`.
fn scene_without_secrets() -> Value {
    json!({
        "scene": { "location": "Смотровая дамба", "objective": "Понять, кто открывает шлюзы" },
        "social": { "npcs": [
            { "id": "mara", "name": "Мара", "role": "смотрительница дамбы", "location": "Смотровая дамба", "goals": ["удержать людей подальше от главного шлюза", "найти тех, кто подменил карту прилива"] },
            { "id": "oswald", "name": "Освальд", "role": "купец", "location": "Вельдбург", "goals": ["не пускать никого к шлюзу"] },
            { "id": "ghost", "name": "Тень", "role": "тайный враг", "location": "Смотровая дамба", "visibility": "gm_only", "goals": ["открыть шлюз ночью"] },
        ] },
        "worldMemory": normalize_world_memory(&json!({ "entities": [{ "id": "location:dam", "kind": "location", "name": "Смотровая дамба", "visibility": "public" }] })),
    })
}

#[test]
fn successful_search_without_secret_names_the_knowing_npc() {
    let state = scene_without_secrets();
    let input = json!({ "checkEvent": check("perception", "check-lead"), "skill": "perception", "actionText": "Смотрю, кто возится у шлюза" });
    let commands = free_action_discovery_commands(&state, &input);
    let fact = &commands[0]["fact"];
    assert_eq!(fact["subject_id"], "location:dam");
    assert_eq!(fact["summary"], "Мара, смотрительница дамбы, явно знает об этом больше, чем говорит, — и хочет удержать людей подальше от главного шлюза.");
    let unrelated = json!({ "checkEvent": check("perception", "check-lead"), "skill": "perception", "actionText": "Смотрю на чаек над водой" });
    assert!(free_action_discovery_commands(&state, &unrelated).is_empty(), "без связи со сценой находка не выдумывается");
}

/// Кампания заготовок из `test/gm-secrets.test.mjs`, сведённая к памяти.
fn gm_secrets_state() -> Value {
    let place = "location:mytar";
    json!({
        "scene": { "location": "Мытарский Двор", "location_id": "mytar" },
        "worldMemory": normalize_world_memory(&json!({
            "entities": [{ "id": place, "kind": "location", "name": "Мытарский Двор", "visibility": "public" }],
            "facts": [
                { "id": "fact:secret:case", "subject_id": place, "predicate": "gm_secret", "visibility": "gm_only", "status": "active",
                  "object": "{\"topic\":\"футляр карта замок\",\"skills\":[\"investigation\",\"perception\"],\"holder\":\"\"}",
                  "summary": "На футляре свежая царапина от ножа: его уже вскрывали этой ночью." },
                { "id": "fact:secret:journal", "subject_id": place, "predicate": "gm_secret", "visibility": "gm_only", "status": "active",
                  "object": "{\"topic\":\"журнал отметки почерк\",\"skills\":[\"insight\",\"investigation\"],\"holder\":\"Клара Вельм\"}",
                  "summary": "Клара сама переписала отметки в журнале: её почерк на последних строках другой." },
            ],
        })),
        "social": { "npcs": [{ "id": "klara", "name": "Клара Вельм", "role": "хранительница карты", "location": "Мытарский Двор", "goals": ["Сохранить порядок"] }] },
    })
}

#[test]
fn topical_check_reveals_secret_and_skill_matters() {
    let state = gm_secrets_state();
    let found = free_action_discovery_commands(&state, &json!({ "checkEvent": check("investigation", "check-1"), "skill": "investigation", "actionText": "Изучаю футляр с картой" }));
    assert_eq!(found.len(), 1);
    assert_eq!(found[0]["fact"]["predicate"], "discovery");
    assert_eq!(found[0]["fact"]["supersedes_fact_id"], "fact:secret:case");
    assert!(found[0]["fact"]["summary"].as_str().unwrap_or_default().contains("царапина от ножа"));
    assert!(free_action_discovery_commands(&state, &json!({ "checkEvent": check("athletics", "c"), "skill": "athletics", "actionText": "Изучаю футляр" })).is_empty());
    let look = free_action_discovery_commands(&state, &json!({ "checkEvent": check("perception", "c"), "skill": "perception", "actionText": "Осматриваюсь" }));
    assert!(look[0]["fact"]["summary"].as_str().unwrap_or_default().contains("футляре"));
    let failed = json!({ "event_id": "c", "payload": { "success": false, "skill": "perception" } });
    assert!(free_action_discovery_commands(&state, &json!({ "checkEvent": failed, "skill": "perception", "actionText": "Осматриваюсь" })).is_empty());
}

#[test]
fn thorough_search_finds_hidden_outside_combat() {
    let state = gm_secrets_state();
    let failed = json!({ "event_id": "check-thorough", "event_type": "AbilityCheckResolved", "payload": { "success": false, "skill": "investigation" } });
    assert!(is_thorough_search(Some(&json!("Методично осматриваю футляр, каждую щель"))));
    assert!(!is_thorough_search(Some(&json!("Быстро осматриваю футляр"))));
    let found = thorough_search_outcome(&state, &json!({ "checkEvent": failed, "skill": "investigation", "actionText": "Методично осматриваю футляр и замок" })).expect("правило применимо");
    assert_eq!(found["found"], true);
    assert_eq!(found["minutes"], THOROUGH_SEARCH_MINUTES);
    assert!(thorough_search_outcome(&state, &json!({ "checkEvent": failed, "skill": "perception", "actionText": "Прислушиваюсь у двери" })).is_none());
    let mut fighting = state.clone();
    fighting["mechanics"] = json!({ "combat": { "active": true } });
    assert!(thorough_search_outcome(&fighting, &json!({ "checkEvent": failed, "skill": "investigation", "actionText": "Методично осматриваю футляр" })).is_none());
}

#[test]
fn insight_reads_the_holder_without_revealing_the_secret() {
    let mut state = gm_secrets_state();
    state["scene_npcs"] = json!([{ "id": "klara", "name": "Клара Вельм", "location_id": "mytar", "alive": true }, { "id": "tom", "name": "Том Рыбак", "location_id": "mytar", "alive": true }]);
    let knows = insight_read(&state, &json!({ "actionText": "Спрашиваю Клару про журнал и слежу за её лицом" }));
    assert!(knows.contains("Клара Вельм знает об этом больше, чем говорит"));
    assert!(!knows.contains("почерк"));
    assert!(insight_read(&state, &json!({ "actionText": "Слежу за лицом Клары, когда говорю о погоде на реке" })).contains("скрывает — только, похоже, не это"));
    assert!(insight_read(&state, &json!({ "actionText": "Слежу за Томом, когда спрашиваю про журнал" })).contains("не притворяется"));
    assert_eq!(insight_read(&state, &json!({ "actionText": "Слежу за лицом незнакомца" })), "");
}

#[test]
fn retold_or_ledgered_secret_is_not_found_again() {
    let state = gm_secrets_state();
    let lucky = json!({ "checkEvent": check("investigation", "check-told"), "skill": "investigation", "actionText": "Осматриваю футляр и замок" });
    let summary = "На футляре свежая царапина от ножа: его уже вскрывали этой ночью.";
    let finds = |state: &Value| free_action_discovery_commands(state, &lucky).iter().any(|command| command["fact"]["summary"] == summary);
    assert!(finds(&state));
    let mut ledger = state.clone();
    ledger["worldMemory"]["knowledge_ledger"] = json!([{ "id": "k1", "fact_id": "fact:secret:case", "hero_id": "nova" }]);
    assert!(!finds(&ledger));
    let mut retold = state.clone();
    retold["social"]["conversations"] = json!([{ "id": "c1", "npc_id": "npc", "npc_reply": "На футляре свежая царапина от ножа — его уже вскрывали этой ночью, клянусь." }]);
    assert!(!finds(&retold));
}

//! Смысловые проверки задачи А4 — перенос тестов JS про социальную роль NPC
//! (`test/npc-social-voice.test.mjs`, `test/npc-knowledge-leads.test.mjs`,
//! `test/npc-social.test.mjs`), без HTTP и Rules Engine.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};

use serde_json::{json, Value};
use sk_agents::npc_social_controller::{fresh_reply_text, others_said_nearby, without_circular_referral, NpcSocialController, NPC_SOCIAL_PROMPT_VERSION};
use sk_agents_base::llm_client::{LlmClient, LlmError, LlmFuture};
use sk_tactics::security::{UNTRUSTED_DATA_END, UNTRUSTED_DATA_START};

struct ThreadWaker(std::thread::Thread);

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = Box::pin(future);
    let waker = Waker::from(Arc::new(ThreadWaker(std::thread::current())));
    let mut context = Context::from_waker(&waker);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::park();
    }
}

/// `scriptedLlm`: ответы по очереди, запросы пишутся.
struct Scripted {
    replies: Mutex<Vec<Result<Value, LlmError>>>,
    calls: Mutex<Vec<Value>>,
}

fn scripted(replies: Vec<Result<Value, LlmError>>) -> Arc<Scripted> {
    Arc::new(Scripted { replies: Mutex::new(replies), calls: Mutex::new(Vec::new()) })
}

impl Scripted {
    fn calls(&self) -> Vec<Value> {
        self.calls.lock().unwrap().clone()
    }
}

impl LlmClient for Scripted {
    fn model(&self) -> Option<String> {
        None
    }
    fn complete<'a>(&'a self, _input: &'a Value, _options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        Box::pin(async { Err(LlmError::new("UNEXPECTED", "complete")) })
    }
    fn complete_json<'a>(&'a self, input: &'a Value, _options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        self.calls.lock().unwrap().push(input.clone());
        let mut replies = self.replies.lock().unwrap();
        let reply = if replies.is_empty() { Err(LlmError::new("LLM_UNEXPECTED_CALL", "лишний вызов")) } else { replies.remove(0) };
        Box::pin(async move { reply })
    }
    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>> {
        Box::pin(async { Ok(json!([])) })
    }
    fn health(&self) -> Value {
        json!([])
    }
}

fn with_model(client: &Arc<Scripted>) -> NpcSocialController {
    NpcSocialController::new(Some(Arc::clone(client) as Arc<dyn LlmClient>)).with_provider_name("Object")
}

fn offline() -> NpcSocialController {
    NpcSocialController::new(None)
}

fn respond(controller: &NpcSocialController, input: Value) -> Value {
    block_on(controller.respond(&input)).expect("без исключения").expect("NPC отвечает")
}

fn reply_with(reply: &str, extra: Value) -> Result<Value, LlmError> {
    let mut base = json!({ "reply": reply, "stance": "neutral", "disclosed_fact_ids": [], "disclosed_claim_ids": [], "relationship_delta": 0 });
    if let (Some(base), Value::Object(extra)) = (base.as_object_mut(), extra) {
        base.extend(extra);
    }
    Ok(base)
}

/// Раздел `UNTRUSTED_DATA:<section>` пользовательского сообщения.
fn untrusted_payload(call: &Value, section: &str) -> Value {
    let content = call["messages"][1]["content"].as_str().expect("сообщение пользователя");
    let open = format!("{UNTRUSTED_DATA_START}:{section}>>>");
    let close = format!("{UNTRUSTED_DATA_END}:{section}>>>");
    let start = content.find(&open).expect("начало блока") + open.len();
    let end = content.find(&close).expect("конец блока");
    serde_json::from_str(&content[start..end]).expect("блок — JSON")
}

// --- «Пустой кубок» (npc-social-voice) -----------------------------------------------

fn dialogue_state() -> Value {
    json!({
        "scene": { "title": "Вечер в «Пустом кубке»", "location": "Трактир «Пустой кубок»", "mood": "настороженно", "objective": "Узнать о караване" },
        "players": [{ "id": "hero", "character": "Ада" }, { "id": "rogue", "character": "Рен" }],
        "social": {
            "npcs": [{
                "id": "npc:mira", "name": "Мира", "role": "хозяйка трактира", "location": "Трактир «Пустой кубок»",
                "public_summary": "Держит трактир двадцать лет.", "voice": "Говорит быстро, с прибаутками.",
                "speech_profile": { "pace": "быстро, короткими фразами", "lexicon": "трактирные поговорки и бытовые слова", "mannerism": "один раз заканчивает мысль словами «так-то оно вернее»" },
                "goals": ["Сохранить трактир", "Узнать, кто пугает поставщиков"], "visibility": "party", "available": true,
            }, {
                "id": "npc:orin", "name": "Орин", "role": "архивариус", "location": "Трактир «Пустой кубок»",
                "public_summary": "Сверяет дорожные записи.", "voice": "Говорит медленно и точно.",
                "speech_profile": { "pace": "медленно, с паузой перед выводом", "lexicon": "книжные слова и названия документов", "mannerism": "перед выводом говорит «согласно записи»" },
                "visibility": "party", "available": true,
            }],
            "relationships": { "npc:mira": { "hero": 10, "rogue": 0 }, "npc:orin": { "hero": 0, "rogue": 0 } },
            "promises": [],
            "conversations": [
                { "id": "conv-1", "npc_id": "npc:mira", "hero_id": "rogue", "player_message": "Что слышно у ворот?", "npc_reply": "Стража стала жадной.", "stance": "neutral", "visibility": "party" },
                { "id": "conv-2", "npc_id": "npc:mira", "hero_id": "hero", "player_message": "Налей чего покрепче.", "npc_reply": "Для тебя — из старых запасов.", "stance": "friendly", "visibility": "party" },
            ],
        },
    })
}

#[test]
fn brief_carries_scene_and_party_memory_without_private_goals() {
    let client = scripted(vec![reply_with("Слушаю.", json!({}))]);
    let result = respond(&with_model(&client), json!({ "state": dialogue_state(), "playerId": "hero", "npcId": "npc:mira", "message": "Расскажи о караване", "turnId": "voice-1" }));
    let calls = client.calls();
    assert_eq!(calls.len(), 1);
    assert!(calls[0]["messages"][0]["content"].as_str().unwrap().contains("PROMPT_ID: npc_controller/social-v8"));
    assert_eq!(result["prompt_version"], NPC_SOCIAL_PROMPT_VERSION);
    assert_eq!(result["provider"], "Object");
    let brief = untrusted_payload(&calls[0], "npc_social_brief");
    assert_eq!(brief["scene"]["location"], "Трактир «Пустой кубок»");
    assert_eq!(brief["scene"]["mood"], "настороженно");
    assert!(brief["scene"].get("objective").is_none(), "список задач не становится речью NPC");
    assert!(brief["npc"].get("goals").is_none());
    assert!(!calls[0]["messages"][1]["content"].as_str().unwrap().contains("Сохранить трактир"));
    assert_eq!(brief["npc"]["speech_profile"]["mannerism"], "один раз заканчивает мысль словами «так-то оно вернее»");
    assert_eq!(brief["recent_conversation"].as_array().unwrap().iter().map(|entry| entry["player_message"].clone()).collect::<Vec<_>>(), vec![json!("Налей чего покрепче.")]);
    assert_eq!(brief["recent_party_conversation"], json!([{ "hero": "Рен", "player_message": "Что слышно у ворот?", "npc_reply": "Стража стала жадной.", "stance": "neutral" }]));
}

#[test]
fn party_memory_keeps_last_four() {
    let mut state = dialogue_state();
    state["social"]["conversations"] = Value::Array(
        (0..9)
            .map(|index| json!({ "id": format!("conv-{index}"), "npc_id": "npc:mira", "hero_id": "rogue", "player_message": format!("Реплика {index}"), "npc_reply": format!("Ответ {index}"), "stance": "neutral", "visibility": "party" }))
            .collect(),
    );
    let client = scripted(vec![reply_with("Слушаю.", json!({}))]);
    respond(&with_model(&client), json!({ "state": state, "playerId": "hero", "npcId": "npc:mira", "message": "Ещё раз", "turnId": "voice-2" }));
    let brief = untrusted_payload(&client.calls()[0], "npc_social_brief");
    let messages: Vec<Value> = brief["recent_party_conversation"].as_array().unwrap().iter().map(|entry| entry["player_message"].clone()).collect();
    assert_eq!(messages, vec![json!("Реплика 5"), json!("Реплика 6"), json!("Реплика 7"), json!("Реплика 8")]);
}

#[test]
fn other_heroes_private_talk_stays_out_and_echo_turns_private() {
    let mut state = dialogue_state();
    let conversations = state["social"]["conversations"].as_array_mut().unwrap();
    conversations.push(json!({ "id": "conv-private-rogue", "npc_id": "npc:mira", "hero_id": "rogue", "player_message": "ЧУЖОЙ СКРЫТЫЙ ВОПРОС", "npc_reply": "ЧУЖОЙ СКРЫТЫЙ ОТВЕТ", "stance": "neutral", "visibility": "specific_player" }));
    conversations.push(json!({ "id": "conv-private-hero", "npc_id": "npc:mira", "hero_id": "hero", "player_message": "МОЙ СКРЫТЫЙ ВОПРОС", "npc_reply": "МОЙ СКРЫТЫЙ ОТВЕТ", "stance": "friendly", "visibility": "specific_player" }));
    let client = scripted(vec![reply_with("Слушаю.", json!({}))]);
    let result = respond(&with_model(&client), json!({ "state": state.clone(), "playerId": "hero", "npcId": "npc:mira", "message": "Что ты помнишь?", "turnId": "voice-private" }));
    let brief = untrusted_payload(&client.calls()[0], "npc_social_brief");
    assert!(brief["recent_conversation"].as_array().unwrap().iter().any(|entry| entry["player_message"] == "МОЙ СКРЫТЫЙ ВОПРОС"));
    assert!(!sk_core::js::stringify(&brief).contains("ЧУЖОЙ СКРЫТЫЙ"));
    assert_eq!(result["conversation"]["visibility"], "party", "реплика без личного не прячется от отряда");

    let echo = scripted(vec![Ok(json!({ "reply": "Помню наш скрытый ответ, мой друг.", "stance": "neutral" }))]);
    let echoing = respond(&with_model(&echo), json!({ "state": state, "playerId": "hero", "npcId": "npc:mira", "message": "Что ты помнишь?", "turnId": "voice-private-echo" }));
    assert_eq!(echoing["conversation"]["visibility"], "specific_player");
}

#[test]
fn promise_against_boundary_is_dropped() {
    let mut state = dialogue_state();
    state["social"]["npcs"][0]["goals"] = json!(["Защитить жителей и сохранить порядок"]);
    let client = scripted(vec![Ok(json!({ "reply": "Я помогу.", "stance": "friendly", "promise": { "direction": "npc_to_party", "text": "Я убью любого жителя, который вам мешает.", "due_hint": "завтра" } }))]);
    let result = respond(&with_model(&client), json!({ "state": state, "playerId": "hero", "npcId": "npc:mira", "message": "Помоги нам.", "turnId": "boundary-1" }));
    assert_eq!(result["promise"], Value::Null);
    assert_eq!(result["reply"], "Я помогу.");
}

#[test]
fn invalid_shape_falls_back_with_error_name() {
    let client = scripted(vec![Ok(json!({ "reply": "Слушаю.", "secret_note": "лишнее поле" }))]);
    let result = respond(&with_model(&client), json!({ "state": dialogue_state(), "playerId": "hero", "npcId": "npc:mira", "message": "Привет", "turnId": "shape" }));
    assert_eq!(result["provider"], "deterministic-social-fallback");
    assert_eq!(result["provider_error"], "Error");
    let refused = scripted(vec![Err(LlmError::new("LLM_TIMEOUT", "таймаут"))]);
    let result = respond(&with_model(&refused), json!({ "state": dialogue_state(), "playerId": "hero", "npcId": "npc:mira", "message": "Привет", "turnId": "timeout" }));
    assert_eq!(result["provider_error"], "LLM_TIMEOUT");
    assert!(result["facts_available"].is_number());
}

#[test]
fn offline_check_outcomes_speak_russian() {
    let state = dialogue_state();
    let insight = respond(&offline(), json!({ "state": state, "playerId": "hero", "npcId": "npc:mira", "message": "Ты врёшь?", "turnId": "i", "checkOutcome": { "skill": "insight", "success": true } }));
    assert_eq!(insight["reply"], "Мира отвечает уклончиво, и за словами угадывается что-то недосказанное.");
    assert_eq!(insight["relationship_delta"], 0);
    assert_eq!(insight["provider"], "deterministic-social-fallback");
    let failed = respond(&offline(), json!({ "state": state, "playerId": "hero", "npcId": "npc:mira", "message": "Отдай ключ.", "turnId": "f", "checkOutcome": { "skill": "persuasion", "success": false } }));
    assert_eq!(failed["reply"], "Мира отвечает: «Нет. Меня это не убеждает.»");
    assert_eq!(failed["conversation"]["check"]["skill"], "persuasion");
}

#[test]
fn unavailable_or_missing_npc_gives_none() {
    let mut state = dialogue_state();
    assert!(block_on(offline().respond(&json!({ "state": state.clone(), "playerId": "hero", "npcId": "npc:none" }))).unwrap().is_none());
    state["social"]["npcs"][0]["available"] = json!(false);
    assert!(block_on(offline().respond(&json!({ "state": state, "playerId": "hero", "npcId": "npc:mira" }))).unwrap().is_none());
}

// --- «Серый Причал» (npc-knowledge-leads) ------------------------------------------

const MARK: &str = "На борту баркаса выжжен знак — рыба с тремя глазами.";
const OWNER_CLUE: &str = "Баркас «Чайка» ушёл к маяку той ночью без огней, и правил им чужак.";
const EMPTY_BOAT: &str = "Баркас пришёл пустой на рассвете, и никто не видел, кто его пригнал.";

fn grey_pier() -> Value {
    json!({
        "sessionCode": "GREY-PIER",
        "partyMemberIds": ["wizard", "fighter"],
        "scene": { "title": "Таверна «Сеть»", "location": "Таверна «Сеть»", "objective": "Узнать, чей пустой баркас прибило к пирсу" },
        "mechanics": { "world_time": { "elapsed_minutes": 60 }, "combat": { "active": false } },
        "players": [
            { "id": "wizard", "character": "Тарвин", "role": "Волшебник · ур. 1", "characterClass": "wizard", "background": "Мудрец",
              "backstory": "Три месяца назад моя сестра Ила ушла в море и не вернулась. С тех пор я ищу любой её след.", "bonds": "Найду Илу, чего бы это ни стоило.", "characterSetupRequired": false },
            { "id": "fighter", "character": "Гарет", "role": "Воин · ур. 1", "characterClass": "fighter", "background": "Стражник",
              "backstory": "Бывший стражник. Капитан велел не замечать ночных лодок у маяка.", "bonds": "", "characterSetupRequired": false },
        ],
        "worldMemory": {
            "entities": [
                { "id": "loc:tavern", "kind": "location", "name": "Таверна «Сеть»", "summary": "", "aliases": [], "visibility": "party", "tags": [] },
                { "id": "loc:pier", "kind": "location", "name": "Пирс Серого Причала", "summary": "", "aliases": [], "visibility": "party", "tags": [] },
                { "id": "loc:lighthouse", "kind": "location", "name": "Старый маяк", "summary": "", "aliases": [], "visibility": "party", "tags": [] },
            ],
            "facts": [
                { "id": "fact:opening", "subject_id": "loc:tavern", "predicate": "opening_narration", "object": "Пролог", "summary": "В таверне «Сеть» пахнет рыбой и дымом.", "visibility": "party", "status": "active", "source_event_ids": [], "recorded_at_minutes": 0 },
                { "id": "fact:arrive-pier", "subject_id": "loc:pier", "predicate": "party_arrived", "object": "Пирс", "summary": "Отряд на пирсе.", "visibility": "party", "status": "active", "source_event_ids": [], "recorded_at_minutes": 20 },
                { "id": "fact:found-mark", "subject_id": "loc:pier", "predicate": "discovery", "object": "clue", "summary": MARK, "visibility": "party", "status": "active", "source_event_ids": ["event:search"], "recorded_at_minutes": 30 },
                { "id": "fact:arrive-tavern", "subject_id": "loc:tavern", "predicate": "party_arrived", "object": "Таверна", "summary": "Отряд вернулся в таверну.", "visibility": "party", "status": "active", "source_event_ids": [], "recorded_at_minutes": 50 },
                { "id": "fact:secret:owner", "subject_id": "loc:tavern", "predicate": "gm_secret",
                  "object": "{\"topic\":\"чей баркас «Чайка»\",\"skills\":[\"investigation\",\"insight\"],\"holder\":\"Борс\"}",
                  "summary": OWNER_CLUE, "visibility": "gm_only", "status": "active", "source_event_ids": [], "recorded_at_minutes": 0 },
            ],
            "epistemic_claims": [],
        },
        "social": {
            "npcs": [
                { "id": "npc:bors", "name": "Борс", "role": "трактирщик", "location": "Таверна «Сеть»", "public_summary": "Держит таверну у воды.", "voice": "Басит, отвечает коротко.", "visibility": "party", "available": true, "known_fact_ids": ["fact:opening"] },
                { "id": "npc:helga", "name": "Хельга", "role": "рыбачка", "location": "Пирс Серого Причала", "public_summary": "Чинит сети на пирсе.", "voice": "Говорит быстро, ворчливо.", "visibility": "party", "available": true, "known_fact_ids": [] },
                { "id": "npc:maren", "name": "Марен", "role": "смотритель маяка", "location": "Старый маяк", "public_summary": "Живёт на маяке один.", "voice": "Тихий, медленный.", "visibility": "party", "available": true, "known_fact_ids": [] },
            ],
            "relationships": {}, "conversations": [], "promises": [],
        },
    })
}

#[test]
fn npc_does_not_retell_finding_it_did_not_see() {
    let client = scripted(vec![reply_with("Знак? Не видел никакого знака.", json!({}))]);
    respond(&with_model(&client), json!({ "state": grey_pier(), "playerId": "wizard", "npcId": "npc:bors", "message": "Что за знак на борту баркаса — рыба с тремя глазами?", "turnId": "bors-mark" }));
    let brief = untrusted_payload(&client.calls()[0], "npc_social_brief");
    assert!(!brief["speakable_facts"].as_array().unwrap().iter().any(|fact| fact["id"] == "fact:found-mark"));
    let fallback = respond(&offline(), json!({ "state": grey_pier(), "playerId": "wizard", "npcId": "npc:bors", "message": "Что за знак выжжен на борту баркаса?", "turnId": "bors-mark-offline" }));
    let reply = fallback["reply"].as_str().unwrap();
    assert!(!reply.contains("выжжен") && !reply.contains("тремя глазами"), "{reply}");
}

#[test]
fn witness_knows_the_finding() {
    let client = scripted(vec![reply_with("Знак тот я видела.", json!({}))]);
    respond(&with_model(&client), json!({ "state": grey_pier(), "playerId": "wizard", "npcId": "npc:helga", "message": "Что за знак на борту баркаса?", "turnId": "helga-mark" }));
    let brief = untrusted_payload(&client.calls()[0], "npc_social_brief");
    assert!(brief["speakable_facts"].as_array().unwrap().iter().any(|fact| fact["id"] == "fact:found-mark"));
}

#[test]
fn refusal_leads_to_secret_holder_without_secret_text() {
    let client = scripted(vec![reply_with("Не моё это дело.", json!({}))]);
    respond(&with_model(&client), json!({ "state": grey_pier(), "playerId": "wizard", "npcId": "npc:helga", "message": "Кто правил «Чайкой» той ночью?", "turnId": "helga-owner" }));
    let brief = untrusted_payload(&client.calls()[0], "npc_social_brief");
    assert_eq!(brief["leads"][0], json!({ "kind": "person", "match": "question", "name": "Борс", "role": "трактирщик", "where": "Таверна «Сеть»", "about": "чей баркас «Чайка»" }));
    let text = sk_core::js::stringify(&brief);
    assert!(!text.contains("без огней") && !text.contains("правил им чужак"), "текст тайны в бриф не идёт");
    let fallback = respond(&offline(), json!({ "state": grey_pier(), "playerId": "wizard", "npcId": "npc:helga", "message": "Кто правил «Чайкой» той ночью?", "turnId": "helga-owner-offline" }));
    let reply = fallback["reply"].as_str().unwrap();
    assert!(reply.starts_with("Хельга качает головой: «Больше мне сказать нечего. Об этом больше знает Борс, трактирщик"), "{reply}");
    assert!(!reply.contains("без огней") && !reply.contains("чужак"));
}

#[test]
fn holder_names_price_and_persuasion_opens_secret() {
    let guarded = respond(&offline(), json!({ "state": grey_pier(), "playerId": "wizard", "npcId": "npc:bors", "message": "Чей это баркас «Чайка»?", "turnId": "bors-owner" }));
    assert!(guarded["reply"].as_str().unwrap().contains("просто так такое не рассказывают"));
    assert_eq!(guarded["disclosed_fact_ids"], json!([]));
    assert_eq!(guarded["visibility"], "party");
    let persuaded = respond(
        &offline(),
        json!({ "state": grey_pier(), "playerId": "wizard", "npcId": "npc:bors", "message": "Чей это баркас «Чайка»?", "turnId": "bors-owner-check",
                "checkOutcome": { "skill": "persuasion", "ability": "cha", "success": true, "degree": "success" } }),
    );
    assert_eq!(persuaded["reply"], format!("Борс сдаётся: «{OWNER_CLUE}»"));
    assert_eq!(persuaded["disclosed_fact_ids"], json!(["fact:secret:owner"]));
    assert_eq!(persuaded["visibility"], "specific_player", "раскрытая тайна звучит только тому, кто её добыл");
}

#[test]
fn reply_is_private_only_when_secret_was_said() {
    let silent = scripted(vec![reply_with("Не твоё дело, чей баркас.", json!({}))]);
    let result = respond(&with_model(&silent), json!({ "state": grey_pier(), "playerId": "wizard", "npcId": "npc:bors", "message": "Чей это баркас «Чайка»?", "turnId": "bors-silent" }));
    assert_eq!(result["visibility"], "party");
    let told = scripted(vec![reply_with("Ушла «Чайка» к маяку без огней, чужак правил.", json!({ "disclosed_fact_ids": ["fact:secret:owner"] }))]);
    let result = respond(&with_model(&told), json!({ "state": grey_pier(), "playerId": "wizard", "npcId": "npc:bors", "message": "Чей это баркас «Чайка»?", "turnId": "bors-told" }));
    assert_eq!(result["visibility"], "specific_player");
}

#[test]
fn repeat_of_private_reply_to_other_hero_is_trimmed() {
    let mut state = grey_pier();
    state["social"]["conversations"] = json!([{ "id": "conv:helga:fighter", "npc_id": "npc:helga", "hero_id": "fighter", "player_message": "Что тут случилось?", "npc_reply": EMPTY_BOAT, "stance": "neutral", "visibility": "specific_player" }]);
    let client = scripted(vec![reply_with(&format!("{EMPTY_BOAT} Сети в нём были сухие."), json!({}))]);
    let result = respond(&with_model(&client), json!({ "state": state, "playerId": "wizard", "npcId": "npc:helga", "message": "Что с этим баркасом?", "turnId": "helga-repeat-private" }));
    assert_eq!(result["reply"], "Сети в нём были сухие.");
    assert_eq!(result["repetition"], "trimmed");
    let calls = client.calls();
    assert_eq!(calls.len(), 1);
    let brief = untrusted_payload(&calls[0], "npc_social_brief");
    assert!(!sk_core::js::stringify(&brief["already_said"]).contains("пришёл пустой"), "чужая личная беседа в бриф не идёт");
}

fn pier_with_party_reply() -> Value {
    let mut state = grey_pier();
    state["social"]["conversations"] = json!([{ "id": "conv:helga:fighter", "npc_id": "npc:helga", "hero_id": "fighter", "player_message": "Что тут случилось?", "npc_reply": EMPTY_BOAT, "stance": "neutral", "visibility": "party" }]);
    state
}

#[test]
fn full_repeat_gets_one_retry_with_repeated_lines() {
    let fresh = "Я уже говорила. А вот сети в нём были сухие, будто их не бросали.";
    let client = scripted(vec![reply_with(EMPTY_BOAT, json!({})), reply_with(fresh, json!({}))]);
    let result = respond(&with_model(&client), json!({ "state": pier_with_party_reply(), "playerId": "wizard", "npcId": "npc:helga", "message": "Что с этим баркасом?", "turnId": "helga-regenerate" }));
    let calls = client.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(result["repetition"], "regenerated");
    assert_eq!(result["reply"], fresh);
    let retry = untrusted_payload(&calls[1], "npc_social_brief");
    assert_eq!(retry["repeat_retry"], true);
    assert_eq!(retry["already_said"], json!([EMPTY_BOAT]));
    assert_eq!(retry["repeated_lines"], json!([EMPTY_BOAT]));
}

#[test]
fn second_repeat_becomes_acknowledgement_with_lead() {
    let again = format!("Ну так {}", sk_core::text::lower(EMPTY_BOAT));
    let client = scripted(vec![reply_with(EMPTY_BOAT, json!({})), reply_with(&again, json!({}))]);
    let result = respond(&with_model(&client), json!({ "state": pier_with_party_reply(), "playerId": "wizard", "npcId": "npc:helga", "message": "Кто пригнал баркас «Чайку»?", "turnId": "helga-acknowledge" }));
    assert_eq!(result["repetition"], "acknowledged");
    assert_eq!(result["reply"], "Всё, что знаю, вы уже слышали. Об этом больше знает Борс, трактирщик — ищите там: Таверна «Сеть».");
    assert_eq!(result["disclosed_fact_ids"], json!([]));
}

#[test]
fn hero_card_goes_into_brief_as_data() {
    let client = scripted(vec![reply_with("Сестру ищешь? Слыхал я про «Чайку».", json!({}))]);
    respond(&with_model(&client), json!({ "state": grey_pier(), "playerId": "wizard", "npcId": "npc:bors", "message": "Я ищу сестру, Илу. Ты её видел?", "turnId": "bors-sister" }));
    let calls = client.calls();
    let brief = untrusted_payload(&calls[0], "npc_social_brief");
    assert_eq!(brief["speaking_hero"]["name"], "Тарвин");
    assert_eq!(brief["speaking_hero"]["class"], "Волшебник");
    assert!(brief["speaking_hero"]["backstory"].as_str().unwrap().contains("сестра Ила ушла в море"));
    assert!(!calls[0]["messages"][0]["content"].as_str().unwrap().contains("сестра Ила"), "предыстория — данные, а не системный текст");
}

#[test]
fn asked_before_expert_is_marked() {
    let mut state = grey_pier();
    state["social"]["conversations"] = json!([{ "id": "conversation:bors-1", "npc_id": "npc:bors", "hero_id": "wizard", "visibility": "party", "player_message": "Чей это баркас «Чайка»?", "npc_reply": "Не знаю.", "stance": "neutral" }]);
    let client = scripted(vec![reply_with("Не моё это дело.", json!({}))]);
    respond(&with_model(&client), json!({ "state": state, "playerId": "wizard", "npcId": "npc:helga", "message": "Кто правил «Чайкой» той ночью?", "turnId": "helga-owner-again" }));
    let brief = untrusted_payload(&client.calls()[0], "npc_social_brief");
    let bors = brief["leads"].as_array().unwrap().iter().find(|lead| lead["name"] == "Борс").cloned().unwrap_or(Value::Null);
    assert_eq!(bors["asked_before"], true);
}

// --- экспорты ---------------------------------------------------------------------------

#[test]
fn fresh_reply_text_keeps_new_and_short() {
    let earlier = vec![EMPTY_BOAT.to_string()];
    assert_eq!(fresh_reply_text("Слушаю.", &earlier).to_json(), json!({ "text": "Слушаю.", "dropped": 0 }));
    assert_eq!(fresh_reply_text(&format!("Да. {EMPTY_BOAT}"), &earlier).to_json(), json!({ "text": "", "dropped": 1 }));
    assert_eq!(fresh_reply_text("Пустой баркас пришёл на рассвете, никто не видел, кто его пригнал.", &earlier).text, "");
    assert_eq!(fresh_reply_text("Баркас мой, и ночью его угнали.", &earlier).dropped, 0);
    let stems = vec!["Баркас без огней стоял у старого маяка, а стража отворачивалась.".to_string()];
    assert_eq!(fresh_reply_text("Видела я баркас без огня у старого маяка — стражники тогда отворачивались.", &stems).text, "");
    assert_eq!(fresh_reply_text("А сети в трюме были сухие, будто их не бросали вовсе.", &stems).text, "А сети в трюме были сухие, будто их не бросали вовсе.");
}

#[test]
fn circular_referral_is_trimmed_only_when_something_remains() {
    let social = json!({ "npcs": [{ "id": "mara", "name": "Мара Вейл" }, { "id": "taven", "name": "Тавен" }], "conversations": [{ "npc_id": "taven" }, { "npc_id": "mara" }] });
    let mara = json!({ "id": "mara" });
    assert_eq!(without_circular_referral("Баркас пришёл с юга, без огней. Спроси Тавена, он видел больше.", &social, &mara), "Баркас пришёл с юга, без огней.");
    assert_eq!(without_circular_referral("Спроси Тавена.", &social, &mara), "Спроси Тавена.", "пустой ответ хуже отсылки");
    assert_eq!(without_circular_referral("Тавен знает больше, чем говорит. Баркас пришёл с юга.", &social, &mara), "Тавен знает больше, чем говорит. Баркас пришёл с юга.");
    let fresh = json!({ "npcs": social["npcs"], "conversations": [{ "npc_id": "mara" }] });
    assert_eq!(without_circular_referral("Баркас пришёл с юга. Спроси Тавена.", &fresh, &mara), "Баркас пришёл с юга. Спроси Тавена.", "к новому знатоку отсылать можно");
}

#[test]
fn others_said_nearby_hears_only_public_talk_here() {
    let state = json!({ "scene": { "location": "Таверна" } });
    let social = json!({
        "npcs": [{ "id": "mara", "name": "Мара", "location": "Таверна" }, { "id": "orn", "name": "Орн", "location": "Таверна" }, { "id": "far", "name": "Дальний", "location": "Маяк" }],
        "conversations": [
            { "npc_id": "orn", "npc_reply": "Это лодка Илы, я её знаю.", "visibility": "party" },
            { "npc_id": "orn", "npc_reply": "Тебе одной скажу: я боюсь.", "visibility": "specific_player" },
            { "npc_id": "far", "npc_reply": "С маяка видно всё.", "visibility": "party" },
            { "npc_id": "mara", "npc_reply": "Своё я уже сказала.", "visibility": "party" },
        ],
    });
    assert_eq!(json!(others_said_nearby(&state, &social, &json!({ "id": "mara" }))), json!([{ "npc": "Орн", "npc_reply": "Это лодка Илы, я её знаю." }]));
}

#[test]
fn garbage_state_does_not_panic() {
    for state in [json!(5), json!("x"), json!([]), json!({ "social": "x", "worldMemory": { "facts": [null] } }), json!({ "worldMemory": { "facts": { "a": 1 } } })] {
        let _ = block_on(offline().respond(&json!({ "state": state, "playerId": "hero", "npcId": "npc:mira" })));
    }
    let error = block_on(offline().respond(&json!({ "state": null }))).unwrap_err();
    assert_eq!(error.name, "TypeError");
}

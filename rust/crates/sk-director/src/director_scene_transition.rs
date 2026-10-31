//! Перенос `server/director-scene-transition.mjs`: переход сцены, который
//! выбирает Режиссёр по решению группы.
//!
//! Модуль собирает только серверные команды: архитектор сцены описывает,
//! куда идти, и может попросить лавку общего вида, а топологию перехода,
//! мировые минуты пути (`planServerTravel`), торговца, каталог, количества и
//! цены выводит сервер. Итог — пакет `AdvanceTime` → `AdvanceScene` →
//! (`ResolveQuest`) → (`CreateMerchant`) с одним отпечатком запроса.

use std::fmt;

use serde_json::{json, Map, Value};
use sk_core::{hash, js, re, text as jstext};
use sk_economy::merchant_economy::merchant_is_at_location;
use sk_economy::scene_commerce::normalize_scene_shop_intent;
use sk_economy::shop_assembler::{assemble_shop, ShopAssemblyError};
use sk_story::campaign_loop_policy::plan_server_travel;

use crate::adventure_director::{create_scene_transition, head16, nullish, prop, strict_equal, DirectorError};

pub const DIRECTOR_TRANSITION_CONTRACT_VERSION: &str = "skazanie:director-transition-v1";

/// Отказ модуля (`DirectorTransitionError` JS) или ошибка нижнего слоя с
/// её именем: `TypeError` и иные ошибки `createSceneTransition`,
/// `ShopAssemblyError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectorTransitionError {
    pub name: String,
    pub code: Option<String>,
    pub message: String,
}

impl DirectorTransitionError {
    pub const NAME: &'static str = "DirectorTransitionError";

    fn new(message: impl Into<String>, code: &str) -> Self {
        Self { name: Self::NAME.into(), code: Some(code.into()), message: message.into() }
    }

    /// Форма эталона: `{ name, code, message }`.
    pub fn to_json(&self) -> Value {
        json!({ "name": self.name, "code": self.code, "message": self.message })
    }
}

impl fmt::Display for DirectorTransitionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DirectorTransitionError {}

impl From<DirectorError> for DirectorTransitionError {
    fn from(error: DirectorError) -> Self {
        Self { name: error.name, code: error.code, message: error.message }
    }
}

impl From<ShopAssemblyError> for DirectorTransitionError {
    fn from(error: ShopAssemblyError) -> Self {
        Self { name: "ShopAssemblyError".into(), code: Some(error.code), message: error.message }
    }
}

pub type TransitionResult<T> = Result<T, DirectorTransitionError>;

/// `compactText(value, maximum)`: NFKC, пробелы схлопнуты, срез по UTF-16.
fn compact_text(value: Option<&Value>, maximum: usize) -> String {
    head16(&jstext::squash_spaces(&jstext::nfkc(&js::s(value))), maximum)
}

fn plain(value: Option<&Value>) -> Option<&Map<String, Value>> {
    match value {
        Some(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u`.
fn safe_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else { return false };
    first.is_ascii_alphanumeric() && id.len() <= 120 && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'))
}

fn party_decision_id(value: Option<&Value>, label: &str) -> TransitionResult<String> {
    let id = value.and_then(Value::as_str).map(|text| jstext::trim(text).to_string()).unwrap_or_default();
    if !safe_id(&id) {
        return Err(DirectorTransitionError::new(format!("{label} должен быть безопасным идентификатором"), "INVALID_PARTY_DECISION_REFERENCE"));
    }
    Ok(id)
}

fn reference(interaction_id: String, resolved_option_id: String) -> Value {
    json!({ "interaction_id": interaction_id, "resolved_option_id": resolved_option_id })
}

/// `resolvedPartyDecisionReference(value, { required })`: неизменяемая
/// ссылка на решённое голосование, которое потребляет переход. Сохранённая
/// ссылка (`{ interaction_id, resolved_option_id }`) принимается для
/// повтора; взаимодействие комнаты обязано быть решённым и указывать на
/// настоящий вариант. `None` — решения нет, и оно не обязательно.
pub fn resolved_party_decision_reference(value: Option<&Value>, required: bool) -> TransitionResult<Option<Value>> {
    if !js::present(value) {
        if !required {
            return Ok(None);
        }
        return Err(DirectorTransitionError::new("Переход сцены требует подтверждённого решения группы", "PARTY_DECISION_REQUIRED"));
    }
    let source = plain(value);
    if let Some(source) = source.filter(|source| source.contains_key("interaction_id") || source.contains_key("resolved_option_id")) {
        return Ok(Some(reference(
            party_decision_id(source.get("interaction_id"), "interaction_id")?,
            party_decision_id(source.get("resolved_option_id"), "resolved_option_id")?,
        )));
    }
    let source_value = source.map(|_| value).flatten();
    let interaction = plain(nullish(source_value.and_then(|source| source.get("agentInteraction")), source_value));
    let interaction = interaction.filter(|interaction| interaction.get("status").and_then(Value::as_str) == Some("resolved") && js::truthy(interaction.get("resolvedOptionId")));
    let Some(interaction) = interaction else {
        if !required {
            return Ok(None);
        }
        return Err(DirectorTransitionError::new("Переход сцены требует завершённого решения группы", "PARTY_DECISION_REQUIRED"));
    };
    let option_id = party_decision_id(interaction.get("resolvedOptionId"), "resolved_option_id")?;
    let has_resolved_option = match interaction.get("options") {
        Some(Value::Array(options)) => options.iter().any(|option| js::s(prop(Some(option), "id")) == option_id),
        _ => false,
    };
    if !has_resolved_option {
        return Err(DirectorTransitionError::new("Выбранный вариант отсутствует в решении группы", "INVALID_PARTY_DECISION_REFERENCE"));
    }
    Ok(Some(reference(party_decision_id(interaction.get("id"), "interaction_id")?, option_id)))
}

fn dungeon_scene(text: &str) -> bool {
    jstext::test(re!(r"(?:подзем|пещер|склеп|руин|храм|dungeon|cave|crypt|ruin)", "iu"), text)
}

fn settlement_scene(text: &str) -> bool {
    jstext::test(
        re!(
            r"(?:город|деревн|село|пос[её]лок|поселени|рынок|площад|улиц|порт|таверн|застав|форпост|гарнизон|city|town|village|settlement|market|street|harbou?r|outpost|garrison)",
            "iu"
        ),
        text,
    )
}

fn road_scene(text: &str) -> bool {
    jstext::test(re!(r"(?:тракт|дорог|путь|перевал|road|route|pass)", "iu"), text)
}

fn wilderness_scene(text: &str) -> bool {
    jstext::test(re!(r"(?:лес|чащ|болот|роща|пустын|wilderness|forest|swamp|desert)", "iu"), text)
}

/// `sceneKind(sceneArgs, transition)`: вид места решают тема, раскладка и
/// имена — не торговый замысел.
fn scene_kind(scene_args: Option<&Value>, transition: &Value) -> &'static str {
    let theme = compact_text(prop(scene_args, "theme"), 160);
    let transition_scene = prop(Some(transition), "scene");
    let place = [prop(transition_scene, "location"), prop(transition_scene, "title"), prop(scene_args, "location"), prop(scene_args, "title")]
        .into_iter()
        .map(|item| compact_text(item, 160))
        .collect::<Vec<_>>()
        .join(" ");
    let layout = jstext::lower(&compact_text(prop(prop(scene_args, "map"), "layout"), 40));
    if layout == "rooms" {
        return "dungeon";
    }
    if settlement_scene(&theme) || layout == "streets" {
        return "settlement";
    }
    if dungeon_scene(&theme) {
        return "dungeon";
    }
    if wilderness_scene(&theme) {
        return "wilderness";
    }
    if road_scene(&theme) {
        return "road";
    }
    if dungeon_scene(&place) {
        return "dungeon";
    }
    if settlement_scene(&place) {
        return "settlement";
    }
    if road_scene(&place) {
        return "road";
    }
    if wilderness_scene(&place) {
        return "wilderness";
    }
    "other"
}

fn commerce_for_scene(shop_intent: Value, kind: &str) -> Value {
    if kind == "settlement" {
        return shop_intent;
    }
    js::spread(&shop_intent, json!({ "action": "none", "reason": "Сцена не классифицирована как поселение; постоянная торговая точка не создаётся." }))
}

/// Поля по списку; отсутствующие (`undefined`) не попадают.
fn pick_fields(source: Option<&Value>, fields: &[&str]) -> Map<String, Value> {
    let mut picked = Map::new();
    for field in fields {
        if let Some(value) = prop(source, field) {
            picked.insert((*field).into(), value.clone());
        }
    }
    picked
}

const PRICING_FIELDS: [&str; 9] = [
    "mode",
    "buy_markup_bps",
    "sell_rate_bps",
    "bargain_dc",
    "success_discount_bps",
    "failure_markup_bps",
    "agent_adjustment_bps",
    "agent_adjustment_limit_percent",
    "description",
];

const STOCK_FIELDS: [&str; 9] = ["stock_id", "catalog_id", "quantity", "name", "type", "weight", "rarity", "description", "properties"];

fn lifecycle_merchant_from_proposal(merchant: Option<&Value>) -> Value {
    let mut result = pick_fields(merchant, &["id", "name", "title", "description", "greeting", "voice", "location", "location_id"]);
    result.insert("available".into(), json!(!js::is_false(prop(merchant, "available"))));
    if let Some(purse) = prop(merchant, "purse_cp") {
        result.insert("purse_cp".into(), purse.clone());
    }
    let pricing = nullish(prop(merchant, "pricing"), None);
    result.insert("pricing".into(), Value::Object(pick_fields(pricing, &PRICING_FIELDS)));
    let stock: Vec<Value> = match prop(merchant, "stock") {
        Some(Value::Array(items)) => items.iter().map(|item| Value::Object(pick_fields(Some(item), &STOCK_FIELDS))).collect(),
        _ => Vec::new(),
    };
    result.insert("stock".into(), Value::Array(stock));
    Value::Object(result)
}

/// `directorTransitionFingerprint({ campaignId, action })`: смысловой
/// отпечаток перехода — устойчив к пробелам, меняется с назначением.
pub fn director_transition_fingerprint(campaign_id: Option<&Value>, action: Option<&Value>) -> TransitionResult<String> {
    let campaign = compact_text(campaign_id, 120);
    let semantic_action = compact_text(action, 2_000);
    if campaign.is_empty() || semantic_action.is_empty() {
        return Err(DirectorTransitionError::new("Для перехода нужны campaignId и подтверждённое действие группы", "INVALID_DIRECTOR_TRANSITION"));
    }
    Ok(hash::sha256_hex(format!("{DIRECTOR_TRANSITION_CONTRACT_VERSION}\0{campaign}\0{semantic_action}")))
}

/// `directorDecisionFingerprint({ campaignId, partyDecision })`: отпечаток
/// решённого голосования — к нему привязан сид лавки.
pub fn director_decision_fingerprint(campaign_id: Option<&Value>, party_decision: Option<&Value>) -> TransitionResult<String> {
    let campaign = compact_text(campaign_id, 120);
    let reference = resolved_party_decision_reference(party_decision, true)?.unwrap_or(Value::Null);
    Ok(hash::sha256_hex(format!(
        "{DIRECTOR_TRANSITION_CONTRACT_VERSION}\0decision\0{campaign}\0{}\0{}",
        js::s(reference.get("interaction_id")),
        js::s(reference.get("resolved_option_id"))
    )))
}

/// Вход [`build_director_transition_commands`] (`{ campaignId, action,
/// state, sceneArgs, shopIntent, partyDecision, abandonQuest }` JS); `None` —
/// поле не передано.
#[derive(Debug, Clone, Copy, Default)]
pub struct DirectorTransitionInput<'a> {
    pub campaign_id: Option<&'a Value>,
    pub action: Option<&'a Value>,
    pub state: Option<&'a Value>,
    pub scene_args: Option<&'a Value>,
    pub shop_intent: Option<&'a Value>,
    pub party_decision: Option<&'a Value>,
    pub abandon_quest: Option<&'a Value>,
}

fn opt_string(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

/// `buildDirectorTransitionCommands(input)`: пакет серверных команд
/// перехода. Итог — `{ fingerprint, decisionFingerprint, partyDecision,
/// transition, shopIntent, shopProposal, existingMerchantId,
/// abandonedQuestId, commands }` в форме JS.
pub fn build_director_transition_commands(input: DirectorTransitionInput<'_>) -> TransitionResult<Value> {
    let Some(state) = input.state.filter(|state| state.is_object()) else {
        return Err(DirectorTransitionError::new("Не найдено авторитетное состояние кампании", "INVALID_DIRECTOR_TRANSITION_STATE"));
    };
    let fingerprint = director_transition_fingerprint(input.campaign_id, input.action)?;
    let resolved_decision = resolved_party_decision_reference(Some(nullish(input.party_decision, None).unwrap_or(state)), true)?.unwrap_or(Value::Null);
    let decision_fingerprint = director_decision_fingerprint(input.campaign_id, Some(&resolved_decision))?;
    let empty = json!({});
    let provisional = create_scene_transition(input.scene_args.unwrap_or(&empty), state)?;
    let provisional_scene = provisional.get("scene");
    // Тот же policy, что считает путь автономного Режиссёра, ставит мировые
    // минуты и в голосуемый переход.
    let mut travel_options = Map::new();
    if let Some(campaign_id) = input.campaign_id {
        travel_options.insert("campaignId".into(), campaign_id.clone());
    }
    if let Some(location) = prop(provisional_scene, "location") {
        travel_options.insert("destination".into(), location.clone());
    }
    if let Some(location_id) = prop(provisional_scene, "location_id") {
        travel_options.insert("destinationLocationId".into(), location_id.clone());
    }
    travel_options.insert("idempotencyKey".into(), json!(fingerprint));
    let travel = plan_server_travel(state, &Value::Object(travel_options));
    let duration = js::number(travel.get("duration_minutes"));
    let travel_minutes = if duration.is_nan() { 0.0 } else { duration.max(0.0) };
    let kind = scene_kind(input.scene_args, &provisional);
    let normalized_shop_intent = commerce_for_scene(normalize_scene_shop_intent(input.shop_intent, input.scene_args), kind);
    let mut canonical = plain(input.scene_args).cloned().unwrap_or_default();
    for (key, value) in [("location", prop(provisional_scene, "location")), ("location_id", prop(provisional_scene, "location_id"))] {
        match value {
            Some(value) => {
                canonical.insert(key.into(), value.clone());
            }
            // `{ ...x, location: undefined }`: ключ остаётся на месте, но в
            // JSON не попадает.
            None => {
                canonical.shift_remove(key);
            }
        }
    }
    canonical.insert("scene_kind".into(), json!(kind));
    canonical.insert("settlement_type".into(), if kind == "settlement" { opt_string(normalized_shop_intent.get("settlement_type")) } else { Value::Null });
    let canonical_scene_args = Value::Object(canonical);
    let transition = create_scene_transition(&canonical_scene_args, state)?;
    let transition_scene = transition.get("scene");
    let shop_requested = kind == "settlement" && normalized_shop_intent.get("action").and_then(Value::as_str) == Some("create");
    let existing_merchant = if shop_requested {
        match state.get("merchants") {
            Some(Value::Array(merchants)) => merchants.iter().find(|merchant| merchant_is_at_location(Some(merchant), transition_scene)).filter(|merchant| !merchant.is_null()),
            _ => None,
        }
    } else {
        None
    };
    let existing_merchant_id = nullish(prop(existing_merchant, "id"), None).cloned().unwrap_or(Value::Null);

    let mut scene_commerce = normalized_shop_intent.as_object().cloned().unwrap_or_default();
    scene_commerce.insert(
        "outcome".into(),
        json!(if !shop_requested {
            "not-requested"
        } else if existing_merchant.is_some() {
            "reused"
        } else {
            "created"
        }),
    );
    scene_commerce.insert("merchant_id".into(), existing_merchant_id.clone());
    let state_version = js::number(state.get("state_version"));
    let mut commands = vec![
        json!({ "command_type": "AdvanceTime", "amount": js::num(travel_minutes), "unit": "minute", "server_authoritative": true }),
        json!({
            "command_type": "AdvanceScene",
            "expected_state_version": js::num(if state_version.is_nan() || state_version == 0.0 { 0.0 } else { state_version }),
            "scene_args": canonical_scene_args,
            "scene_commerce": Value::Object(scene_commerce),
            "party_decision": resolved_decision,
            "request_fingerprint": fingerprint,
        }),
    ];

    // Отказ от задания едет тем же коммитом, что и уход, после `AdvanceScene`.
    let abandoned_quest_id = compact_text(prop(input.abandon_quest, "id"), 120);
    if !abandoned_quest_id.is_empty() {
        let state_scene = state.get("scene");
        let from_source = if js::truthy(prop(state_scene, "location")) { prop(state_scene, "location") } else { prop(state_scene, "title") };
        let from = compact_text(from_source, 120);
        let from = if from.is_empty() { "прежняя локация".to_string() } else { from };
        let title = compact_text(prop(input.abandon_quest, "title"), 160);
        let next_objective = compact_text(prop(transition_scene, "objective"), 300);
        commands.push(json!({
            "command_type": "ResolveQuest",
            "quest_id": abandoned_quest_id,
            "outcome": "abandoned",
            "summary": format!("Отряд отказался от задания «{}», покидая «{from}».", if title.is_empty() { &abandoned_quest_id } else { &title }),
            "next_objective": if next_objective.is_empty() { "Найти новую цель без прежнего задания".to_string() } else { next_objective },
            "request_fingerprint": fingerprint,
        }));
    }

    let mut shop_proposal = Value::Null;
    if shop_requested && existing_merchant.is_none() {
        let mut shop_input = Map::new();
        for (key, value) in [
            ("location", prop(transition_scene, "location")),
            ("location_id", prop(transition_scene, "location_id")),
            ("settlement_type", normalized_shop_intent.get("settlement_type")),
            ("theme", normalized_shop_intent.get("theme")),
        ] {
            if let Some(value) = value {
                shop_input.insert(key.into(), value.clone());
            }
        }
        shop_input.insert("seed".into(), json!(format!("decision-{}", &decision_fingerprint[..48])));
        if let Some(budget) = normalized_shop_intent.get("budget_cp") {
            shop_input.insert("budget_cp".into(), budget.clone());
        }
        shop_proposal = assemble_shop(Some(&Value::Object(shop_input)))?;
        commands.push(json!({
            "command_type": "CreateMerchant",
            "merchant": lifecycle_merchant_from_proposal(shop_proposal.get("merchant")),
            "request_fingerprint": fingerprint,
        }));
    }

    Ok(json!({
        "fingerprint": fingerprint,
        "decisionFingerprint": decision_fingerprint,
        "partyDecision": resolved_decision,
        "transition": transition,
        "shopIntent": normalized_shop_intent,
        "shopProposal": shop_proposal,
        "existingMerchantId": existing_merchant_id,
        "abandonedQuestId": if abandoned_quest_id.is_empty() { Value::Null } else { json!(abandoned_quest_id) },
        "commands": commands,
    }))
}

fn events_of<'a>(events: &'a [Value], event_type: &'a str) -> impl Iterator<Item = &'a Value> + 'a {
    events.iter().filter(move |event| prop(Some(event), "event_type").and_then(Value::as_str) == Some(event_type))
}

fn request_fingerprint(event: &Value) -> Option<&Value> {
    prop(prop(Some(event), "payload"), "request_fingerprint")
}

/// `assertDirectorTransitionResult(result, expectedFingerprint)`: пакет
/// обязан нести ровно один `SceneAdvanced` этого перехода, а торговец и отказ
/// от задания — тот же отпечаток; иначе — конфликт идемпотентности.
pub fn assert_director_transition_result(result: Option<&Value>, expected_fingerprint: Option<&Value>) -> TransitionResult<Value> {
    let events: &[Value] = match prop(result, "mechanics") {
        Some(Value::Array(events)) => events,
        _ => &[],
    };
    let scene_events: Vec<&Value> = events_of(events, "SceneAdvanced").collect();
    if scene_events.len() != 1 || !strict_equal(request_fingerprint(scene_events[0]), expected_fingerprint) {
        return Err(DirectorTransitionError::new("Ключ идемпотентности уже связан с другим переходом сцены", "IDEMPOTENCY_CONFLICT"));
    }
    if events_of(events, "MerchantCreated").any(|event| !strict_equal(request_fingerprint(event), expected_fingerprint)) {
        return Err(DirectorTransitionError::new("Ключ идемпотентности уже связан с другим созданием торговца", "IDEMPOTENCY_CONFLICT"));
    }
    // Развязка по заполненным часам приходит отдельным коммитом и сюда не
    // попадает; отказ от задания несёт отпечаток перехода.
    if events_of(events, "QuestResolved")
        .any(|event| prop(prop(Some(event), "payload"), "outcome").and_then(Value::as_str) == Some("abandoned") && !strict_equal(request_fingerprint(event), expected_fingerprint))
    {
        return Err(DirectorTransitionError::new("Ключ идемпотентности уже связан с другим отказом от задания", "IDEMPOTENCY_CONFLICT"));
    }
    Ok(result.cloned().unwrap_or(Value::Null))
}

//! Перенос `server/tavern-life.mjs` — жизнь таверны: кости на деньги и выпивка.
//!
//! Детерминированный модуль без модели. Соперник мечет первым
//! (`OpenTavernDiceRound` кладёт его d20 и резервирует ставку героя), герой
//! отвечает против объявленного числа. Характер соперника (честный или шулер,
//! внимательность, ловкость рук, вечерняя касса) — чистая функция сида
//! кампании и id NPC и в состоянии не хранится. Касса соседа закрепляет
//! покрытие открытых раундов; потолок кассы отдаёт остаток заведению
//! (`house_cut_cp`). Счёт кружек, скандалов и раундов живёт в сцене и
//! обнуляется `SceneAdvanced`; кассы соседей переживают уход из зала.
//!
//! Игроки за столом выводятся из сида и не хранятся; модуль импортирует только
//! `npc-positioning`.
//!
//! Ключи прототипа как id героя или NPC ведут себя как в JS: присваивание
//! `patrons['__proto__']` в нормализаторе меняет прототип (запись не попадает
//! в JSON, но читается по этому ключу), а `gamblers['constructor']` находит
//! унаследованную функцию — касса такого соседа `undefined`.

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexMap;
use sk_core::{js, re, text as jstext};

use crate::common::{coalesce, digest, get, integer, js_max, member, object_entries, spread, text, text_str, utf16_cmp, Member};
use crate::npc_positioning::{normalize_npc_world_state, present_scene_npcs, scene_location_id};

/// `TAVERN_LIFE_SCHEMA_VERSION` — версия среза заведения.
pub const TAVERN_LIFE_SCHEMA_VERSION: i64 = 3;
pub const TAVERN_POLICY_ID: &str = "skazanie:tavern-life-v1";
/// `TAVERN_COMMAND_TYPES` — команды таверны, все игроку и все вне боя.
pub const TAVERN_COMMAND_TYPES: [&str; 4] = ["OpenTavernDiceRound", "AnswerTavernDiceRound", "LeaveTavernDiceRound", "OrderTavernDrink"];
/// `TAVERN_DICE_APPROACHES` — как герой отвечает на бросок соперника.
pub const TAVERN_DICE_APPROACHES: [&str; 3] = ["fair", "cheat", "watch"];
/// `TAVERN_STAKES_CP` — закрытый серверный набор ставок.
pub const TAVERN_STAKES_CP: [i64; 3] = [10, 50, 200];
/// `TAVERN_STAKE_LABELS` — подписи ставок в порядке ключей JS.
pub const TAVERN_STAKE_LABELS: [(i64, &str); 3] = [(10, "на медяки"), (50, "на серебро"), (200, "по-крупному")];
pub const TAVERN_CHEAT_BONUS: i64 = 5;
pub const TAVERN_CHEAT_SHARE: i64 = 30;
pub const TAVERN_CHEAT_SKILL: &str = "sleight-of-hand";
pub const TAVERN_CHEAT_ABILITY: &str = "dex";
pub const TAVERN_SPOT_SKILL: &str = "insight";
pub const TAVERN_SCANDALS_BEFORE_EJECTION: i64 = 2;
pub const TAVERN_CHEAT_RELATIONSHIP_DELTA: i64 = -12;
pub const TAVERN_EXPOSED_RELATIONSHIP_DELTA: i64 = -8;
pub const TAVERN_DRINK_PRICE_CP: i64 = 4;
pub const TAVERN_SOBER_DRINKS: i64 = 2;
pub const TAVERN_SOCIAL_BONUS: i64 = 1;
pub const TAVERN_SOCIAL_SKILL: &str = "persuasion";
pub const TAVERN_DRINK_BASE_DC: i64 = 10;
pub const TAVERN_DRUNK_CONDITION: &str = "poisoned";
pub const TAVERN_DRUNK_DURATION: &str = "until-long-rest";
pub const TAVERN_DRINK_MINUTES: i64 = 15;
pub const TAVERN_DICE_ROUND_MINUTES: i64 = 10;
pub const TAVERN_GAMBLER_PURSE_BASE_CP: i64 = 400;
pub const TAVERN_GAMBLER_PURSE_STEP_CP: i64 = 150;
pub const TAVERN_GAMBLER_PURSE_SPREAD: i64 = 5;
pub const TAVERN_GAMBLER_PURSE_MAX_CP: i64 = 10_000;

const MAX_PATRONS: usize = 12;
const MAX_GAMBLERS: usize = 24;

fn clamp(value: Option<&Value>, minimum: i64, maximum: i64) -> i64 {
    minimum.max(maximum.min(integer(value, minimum)))
}

/// `spread(seed, salt, size)`: `parseInt(digest(seed, salt).slice(0, 8), 16) % max(1, size)`.
fn spread_of(seed: &str, salt: &str, size: i64) -> i64 {
    let hex = digest(&[seed.to_string(), salt.to_string()]);
    i64::from_str_radix(&hex[..8], 16).unwrap_or(0) % size.max(1)
}

fn scene_signature(state: &Value) -> String {
    let scene = get(Some(state), "scene");
    let map = get(scene, "map");
    [get(scene, "title"), get(scene, "location"), get(scene, "theme"), get(scene, "material"), get(map, "layout"), get(map, "theme")]
        .into_iter()
        .map(|value| text(value, 200))
        .collect::<Vec<_>>()
        .join(" ")
}

/// `isTavernScene(state)`: таверна ли это — по названию и теме сцены.
pub fn is_tavern_scene(state: &Value) -> bool {
    jstext::test(
        re!(r"таверн|трактир|корчм|харчевн|постоял[ыо][а-яё]|кабак|(?<![а-яё])шинок|tavern|(?<![a-zа-яё])inn(?![а-яёa-z])|alehouse|(?<![a-zа-яё])pub(?![а-яёa-z])", "iu"),
        &scene_signature(state),
    )
}

/// Соперник за столом: `{ id, name, role }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TavernOpponent {
    pub id: String,
    pub name: String,
    pub role: String,
}

impl TavernOpponent {
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "name": self.name, "role": self.role })
    }
}

/// `tavernOpponents(state)`: живые видимые NPC текущей сцены таверны, ни
/// одного враждебного.
pub fn tavern_opponents(state: &Value) -> Vec<TavernOpponent> {
    if !is_tavern_scene(state) {
        return Vec::new();
    }
    let world = normalize_npc_world_state(get(Some(state), "npc_world"), &Value::Null);
    present_scene_npcs(state)
        .into_iter()
        .filter(|npc| npc.get("visibility").and_then(Value::as_str) != Some("gm_only"))
        .filter(|npc| {
            let stance = member(world.get("stances"), &js::string(npc.get("id"))).field("stance");
            let stance = if stance.nullish() { "neutral".to_string() } else { js::string(stance.own()) };
            stance != "hostile"
        })
        .map(|npc| TavernOpponent { id: js::string(npc.get("id")), name: text(npc.get("name"), 160), role: text(npc.get("role"), 160) })
        .collect()
}

/// `isTavernOpponent(state, npcId)`.
pub fn is_tavern_opponent(state: &Value, npc_id: &Value) -> bool {
    let expected = text(Some(npc_id), 120);
    tavern_opponents(state).iter().any(|npc| npc.id == expected)
}

/// Кто сидит напротив (`tavernGamblerFor`): чистая функция сида кампании и id
/// NPC. `crooked` — серверная тайна; обе СЛ от неё не зависят.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TavernGambler {
    pub npc_id: String,
    pub name: String,
    pub role: String,
    pub crooked: bool,
    /// Пассивная Проницательность соперника: против неё — Ловкость рук героя.
    pub insight_passive: i64,
    /// Насколько трудно разглядеть его собственную подмену.
    pub tell_dc: i64,
    pub dice_bonus: i64,
    /// С чем он сел за стол; дальше касса живёт в состоянии заведения.
    pub base_purse_cp: i64,
}

impl TavernGambler {
    pub fn to_json(&self) -> Value {
        json!({
            "npc_id": self.npc_id,
            "name": self.name,
            "role": self.role,
            "crooked": self.crooked,
            "insight_passive": self.insight_passive,
            "tell_dc": self.tell_dc,
            "dice_bonus": self.dice_bonus,
            "base_purse_cp": self.base_purse_cp,
        })
    }

    /// `tavernOpponentDie(gambler, naturalDie)` для своего соперника.
    pub fn opponent_die(&self, natural_die: Option<&Value>) -> i64 {
        tavern_opponent_die(Some(&self.to_json()), natural_die)
    }
}

/// `tavernGamblerFor(state, npcId)`.
pub fn tavern_gambler_for(state: &Value, npc_id: &Value) -> TavernGambler {
    let id = text(Some(npc_id), 120);
    let npc = tavern_opponents(state).into_iter().find(|candidate| candidate.id == id).unwrap_or_else(|| TavernOpponent { id: id.clone(), name: id.clone(), role: String::new() });
    let seed = digest(&[text(get(Some(state), "sessionCode"), 60), id, "tavern-gambler".to_string()]);
    let crooked = spread_of(&seed, "crook", 100) < TAVERN_CHEAT_SHARE;
    let attention = spread_of(&seed, "attention", 5);
    let slyness = spread_of(&seed, "slyness", 5);
    TavernGambler {
        npc_id: npc.id,
        name: npc.name,
        role: npc.role,
        crooked,
        insight_passive: 10 + attention,
        tell_dc: 10 + slyness,
        dice_bonus: if crooked { TAVERN_CHEAT_BONUS } else { 0 },
        base_purse_cp: TAVERN_GAMBLER_PURSE_BASE_CP + spread_of(&seed, "purse", TAVERN_GAMBLER_PURSE_SPREAD) * TAVERN_GAMBLER_PURSE_STEP_CP,
    }
}

/// `tavernOpponentDie(gambler, naturalDie)`: шулер подменяет кость, а не
/// прибавляет к сумме.
pub fn tavern_opponent_die(gambler: Option<&Value>, natural_die: Option<&Value>) -> i64 {
    let natural = clamp(natural_die, 1, 20);
    if !js::truthy(get(gambler, "crooked")) {
        return natural;
    }
    20.min(natural + 0.max(integer(get(gambler, "dice_bonus"), 0)))
}

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------

/// Открытый раунд героя (`safeRound`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TavernRound {
    pub id: String,
    pub hero_id: String,
    pub npc_id: String,
    pub npc_name: String,
    /// Уже уплаченные деньги: при открытии они ушли из кошелька в банк стола.
    pub stake_cp: i64,
    pub npc_total: i64,
    /// Что надо перебить: `npc_total + 1`.
    pub target: i64,
    pub opened_at_minutes: i64,
}

impl TavernRound {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "hero_id": self.hero_id,
            "npc_id": self.npc_id,
            "npc_name": self.npc_name,
            "stake_cp": self.stake_cp,
            "npc_total": self.npc_total,
            "target": self.target,
            "opened_at_minutes": self.opened_at_minutes,
        })
    }
}

fn safe_round(value: Option<&Value>) -> Option<TavernRound> {
    let value = value.filter(|value| value.is_object())?;
    let id = text(value.get("id"), 140);
    let hero_id = text(value.get("hero_id"), 120);
    let npc_id = text(value.get("npc_id"), 120);
    if id.is_empty() || hero_id.is_empty() || npc_id.is_empty() {
        return None;
    }
    let stake = integer(value.get("stake_cp"), 0);
    let stake_cp = if TAVERN_STAKES_CP.contains(&stake) { stake } else { TAVERN_STAKES_CP[0] };
    let npc_total = clamp(value.get("npc_total"), 1, 20);
    Some(TavernRound {
        id,
        hero_id,
        npc_id,
        npc_name: text(value.get("npc_name"), 160),
        stake_cp,
        npc_total,
        target: npc_total + 1,
        opened_at_minutes: 0.max(integer(value.get("opened_at_minutes"), 0)),
    })
}

/// Запись посетителя (`safePatron`): кружки, скандалы, запрет входа и его раунд.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TavernPatron {
    pub drinks: i64,
    pub scandals: i64,
    pub ejected: bool,
    pub round: Option<TavernRound>,
}

impl TavernPatron {
    pub fn to_json(&self) -> Value {
        json!({ "drinks": self.drinks, "scandals": self.scandals, "ejected": self.ejected, "round": self.round.as_ref().map_or(Value::Null, TavernRound::to_json) })
    }

    fn weight(&self) -> i64 {
        (if self.ejected { 8 } else { 0 }) + (if self.scandals != 0 { 4 } else { 0 }) + (if self.round.is_some() { 2 } else { 0 }) + (if self.drinks != 0 { 1 } else { 0 })
    }
}

fn safe_patron(value: Option<&Value>) -> TavernPatron {
    TavernPatron { drinks: clamp(get(value, "drinks"), 0, 99), scandals: clamp(get(value, "scandals"), 0, 99), ejected: js::is_true(get(value, "ejected")), round: safe_round(get(value, "round")) }
}

/// Касса соседа в состоянии заведения.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct GamblerPurse {
    purse_cp: i64,
    last_played_at_minutes: i64,
}

impl GamblerPurse {
    fn to_json(self) -> Value {
        json!({ "purse_cp": self.purse_cp, "last_played_at_minutes": self.last_played_at_minutes })
    }
}

/// Нормализованный срез заведения. Записи с ключом `__proto__` JS кладёт
/// присваиванием в прототип: в JSON их нет, но чтение по этому ключу их находит.
#[derive(Debug, Clone, Default)]
struct Tavern {
    patrons: IndexMap<String, TavernPatron>,
    proto_patron: Option<TavernPatron>,
    gamblers: IndexMap<String, GamblerPurse>,
    proto_gambler: Option<GamblerPurse>,
}

/// Ключи объекта JS по порядку: индексы по возрастанию, затем прочие в порядке вставки.
fn js_order<'a>(keys: impl Iterator<Item = &'a String>) -> Vec<&'a String> {
    let mut keys: Vec<&String> = keys.collect();
    let mut indexed: Vec<&String> = keys.iter().copied().filter(|key| js::is_array_index_key(key)).collect();
    indexed.sort_by_key(|key| key.parse::<u64>().unwrap_or(0));
    keys.retain(|key| !js::is_array_index_key(key));
    indexed.extend(keys);
    indexed
}

/// Что находит `patrons[key]` / `gamblers[key]` у нормализованного среза.
enum Slot<'a, T> {
    Own(&'a T),
    /// Унаследованное (`Object.prototype` или функция): истинно, полей нет.
    Inherited,
    Missing,
}

impl Tavern {
    fn patron(&self, key: &str) -> Slot<'_, TavernPatron> {
        if let Some(patron) = self.patrons.get(key) {
            return Slot::Own(patron);
        }
        if key == "__proto__" {
            return self.proto_patron.as_ref().map_or(Slot::Inherited, Slot::Own);
        }
        if crate::common::is_prototype_key(key) {
            return Slot::Inherited;
        }
        Slot::Missing
    }

    fn gambler(&self, key: &str) -> Slot<'_, GamblerPurse> {
        if let Some(gambler) = self.gamblers.get(key) {
            return Slot::Own(gambler);
        }
        if key == "__proto__" {
            return self.proto_gambler.as_ref().map_or(Slot::Inherited, Slot::Own);
        }
        if crate::common::is_prototype_key(key) {
            return Slot::Inherited;
        }
        // Касса под `__proto__` стала прототипом карты касс: её поля находит
        // любой ключ с тем же именем — истинное число без `purse_cp`.
        if let Some(proto) = &self.proto_gambler {
            let inherited = match key {
                "purse_cp" => Some(proto.purse_cp),
                "last_played_at_minutes" => Some(proto.last_played_at_minutes),
                _ => None,
            };
            if let Some(value) = inherited {
                return if value != 0 { Slot::Inherited } else { Slot::Missing };
            }
        }
        Slot::Missing
    }

    fn patron_or_default(&self, key: &str) -> TavernPatron {
        match self.patron(key) {
            Slot::Own(patron) => patron.clone(),
            _ => TavernPatron::default(),
        }
    }

    fn patrons_json(&self) -> Map<String, Value> {
        js_order(self.patrons.keys()).into_iter().map(|key| (key.clone(), self.patrons[key].to_json())).collect()
    }

    fn gamblers_json(&self) -> Map<String, Value> {
        js_order(self.gamblers.keys()).into_iter().map(|key| (key.clone(), self.gamblers[key].to_json())).collect()
    }

    fn to_json(&self) -> Value {
        json!({ "schema_version": TAVERN_LIFE_SCHEMA_VERSION, "patrons": Value::Object(self.patrons_json()), "gamblers": Value::Object(self.gamblers_json()) })
    }
}

fn normalize(input: Option<&Value>) -> Tavern {
    let source = input.filter(|value| value.is_object());
    let mut tavern = Tavern::default();
    for (hero_id, patron) in object_entries(coalesce(get(source, "patrons"), None)) {
        let id = text_str(&hero_id, 120);
        if id.is_empty() {
            continue;
        }
        let patron = safe_patron(Some(&patron));
        // `patrons['__proto__'] = …` в JS меняет прототип, а не пишет поле.
        if id == "__proto__" {
            tavern.proto_patron = Some(patron);
        } else {
            tavern.patrons.insert(id, patron);
        }
    }
    // Снимок первой редакции держал раунд одним полем на всё заведение.
    // Переезд идёт до предела, а не после.
    if let Some(legacy) = safe_round(get(source, "round")) {
        let has_round = matches!(tavern.patron(&legacy.hero_id), Slot::Own(patron) if patron.round.is_some());
        if !has_round {
            let mut patron = tavern.patron_or_default(&legacy.hero_id);
            let hero_id = legacy.hero_id.clone();
            patron.round = Some(legacy);
            if hero_id == "__proto__" {
                tavern.proto_patron = Some(patron);
            } else {
                tavern.patrons.insert(hero_id, patron);
            }
        }
    }
    // Лишние посетители вытесняются по весу, при равенстве — по порядку в объекте.
    if tavern.patrons.len() > MAX_PATRONS {
        let ordered: Vec<String> = js_order(tavern.patrons.keys()).into_iter().cloned().collect();
        let mut ranked: Vec<(usize, i64, String)> = ordered.iter().enumerate().map(|(index, id)| (index, tavern.patrons[id].weight(), id.clone())).collect();
        ranked.sort_by(|left, right| left.1.cmp(&right.1).then(left.0.cmp(&right.0)));
        let excess = tavern.patrons.len() - MAX_PATRONS;
        for (_, _, id) in ranked.into_iter().take(excess) {
            tavern.patrons.shift_remove(&id);
        }
    }
    // Кассы: сначала нормализуются все, лишние вытесняются по последней игре.
    let mut kept: IndexMap<String, GamblerPurse> = IndexMap::new();
    for (npc_id, gambler) in object_entries(coalesce(get(source, "gamblers"), None)) {
        let id = text_str(&npc_id, 120);
        if id.is_empty() {
            continue;
        }
        kept.insert(
            id,
            GamblerPurse { purse_cp: clamp(get(Some(&gambler), "purse_cp"), 0, TAVERN_GAMBLER_PURSE_MAX_CP), last_played_at_minutes: 0.max(integer(get(Some(&gambler), "last_played_at_minutes"), 0)) },
        );
    }
    let mut evicted: Vec<String> = Vec::new();
    if kept.len() > MAX_GAMBLERS {
        let mut ranked: Vec<(usize, i64, &String)> = kept.iter().enumerate().map(|(index, (id, gambler))| (index, gambler.last_played_at_minutes, id)).collect();
        ranked.sort_by(|left, right| left.1.cmp(&right.1).then(left.0.cmp(&right.0)));
        evicted = ranked.into_iter().take(kept.len() - MAX_GAMBLERS).map(|(_, _, id)| id.clone()).collect();
    }
    for (id, gambler) in kept {
        if evicted.contains(&id) {
            continue;
        }
        if id == "__proto__" {
            tavern.proto_gambler = Some(gambler);
        } else {
            tavern.gamblers.insert(id, gambler);
        }
    }
    tavern
}

/// `normalizeTavernState(input)`: срез заведения схемы 3 — посетители (не
/// больше 12, лишние вытесняются по весу) и кассы соседей (не больше 24,
/// вытесняется самая давняя игра).
pub fn normalize_tavern_state(input: Option<&Value>) -> Value {
    normalize(input).to_json()
}

fn tavern_of(state: &Value) -> Tavern {
    normalize(get(Some(state), "tavern"))
}

fn patron_for(state: &Value, hero_id: &Value) -> TavernPatron {
    tavern_of(state).patron_or_default(&text(Some(hero_id), 120))
}

/// `tavernRoundFor(state, heroId)`: открытый раунд этого героя.
pub fn tavern_round_for(state: &Value, hero_id: &Value) -> Option<TavernRound> {
    patron_for(state, hero_id).round
}

/// `tavernGamblerPurseFor(state, npcId)`: касса соседа — из сида, пока он не
/// играл, дальше — из события. `None` — `undefined` в JS: так выходит для
/// id — ключа прототипа (`constructor`), чья «касса» — функция без поля.
pub fn tavern_gambler_purse_for(state: &Value, npc_id: &Value) -> Option<i64> {
    let id = text(Some(npc_id), 120);
    match tavern_of(state).gambler(&id) {
        Slot::Own(gambler) => Some(gambler.purse_cp),
        Slot::Inherited => None,
        Slot::Missing => Some(tavern_gambler_for(state, &json!(id)).base_purse_cp),
    }
}

/// Переезд денег в кассу соседа и обратно (`tavernPurseTransfer`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TavernPurseTransfer {
    pub before_cp: i64,
    pub after_cp: i64,
    /// Сколько касса приняла (отрицательное — отдала).
    pub moved_cp: i64,
    /// Сколько входящего платежа съел потолок кассы — доля заведения.
    pub house_cut_cp: i64,
}

impl TavernPurseTransfer {
    pub fn to_json(&self) -> Value {
        json!({ "before_cp": self.before_cp, "after_cp": self.after_cp, "moved_cp": self.moved_cp, "house_cut_cp": self.house_cut_cp })
    }
}

/// `tavernPurseTransfer(purseBeforeCp, amountCp)`.
pub fn tavern_purse_transfer(purse_before_cp: Option<&Value>, amount_cp: Option<&Value>) -> TavernPurseTransfer {
    let before = clamp(purse_before_cp, 0, TAVERN_GAMBLER_PURSE_MAX_CP);
    let requested = integer(amount_cp, 0);
    let after = 0.max(TAVERN_GAMBLER_PURSE_MAX_CP.min(before + requested));
    let moved = after - before;
    TavernPurseTransfer { before_cp: before, after_cp: after, moved_cp: moved, house_cut_cp: 0.max(requested - moved) }
}

/// `tavernPurseTransferPayload(transfer)`: что переезд денег дописывает в
/// событие; пусто — касса не двигалась и потолок ничего не съел.
pub fn tavern_purse_transfer_payload(transfer: Option<&Value>) -> Value {
    let field = |key: &str| get(transfer, key);
    let is_zero = |value: Option<&Value>| value.and_then(Value::as_f64) == Some(0.0);
    if !js::truthy(transfer) || (is_zero(field("moved_cp")) && is_zero(field("house_cut_cp"))) {
        return json!({});
    }
    let mut payload = Map::new();
    if let Some(before) = field("before_cp") {
        payload.insert("npc_purse_before_cp".into(), before.clone());
    }
    if let Some(after) = field("after_cp") {
        payload.insert("npc_purse_after_cp".into(), after.clone());
    }
    if js::number(field("house_cut_cp")) > 0.0 {
        payload.insert("house_cut_cp".into(), field("house_cut_cp").cloned().unwrap_or(Value::Null));
    }
    Value::Object(payload)
}

fn open_rounds_in(tavern: &Tavern) -> Vec<TavernRound> {
    let mut ids: Vec<&String> = tavern.patrons.keys().collect();
    ids.sort_by(|left, right| utf16_cmp(left, right));
    ids.into_iter().filter_map(|id| tavern.patrons[id].round.clone()).collect()
}

/// `tavernOpenRounds(state)`: открытые раунды зала по id героя.
pub fn tavern_open_rounds(state: &Value) -> Vec<TavernRound> {
    open_rounds_in(&tavern_of(state))
}

/// `tavernOpenRoundsAgainst(state, npcId)`.
pub fn tavern_open_rounds_against(state: &Value, npc_id: &Value) -> Vec<TavernRound> {
    let id = text(Some(npc_id), 120);
    if id.is_empty() {
        return Vec::new();
    }
    tavern_open_rounds(state).into_iter().filter(|round| round.npc_id == id).collect()
}

/// `tavernEarmarkedCpAgainst(state, npcId)`: закреплённое покрытие открытых раундов.
pub fn tavern_earmarked_cp_against(state: &Value, npc_id: &Value) -> i64 {
    tavern_open_rounds_against(state, npc_id).iter().map(|round| round.stake_cp).sum()
}

/// `tavernFreePurseFor(state, npcId)`: свободная касса соседа. Число JS:
/// `NaN`, если касса `undefined` (id — ключ прототипа).
pub fn tavern_free_purse_for(state: &Value, npc_id: &Value) -> f64 {
    let purse = tavern_gambler_purse_for(state, npc_id).map_or(f64::NAN, |purse| purse as f64);
    js_max(0.0, purse - tavern_earmarked_cp_against(state, npc_id) as f64)
}

/// `tavernMaxStakeFor(state, npcId)`: самая крупная ставка, которую сосед
/// закроет сейчас; ноль — свободных денег нет.
pub fn tavern_max_stake_for(state: &Value, npc_id: &Value) -> i64 {
    let purse = tavern_free_purse_for(state, npc_id);
    TAVERN_STAKES_CP.iter().copied().filter(|stake| (*stake as f64) <= purse).last().unwrap_or(0)
}

/// `tavernDrinksFor(state, heroId)`.
pub fn tavern_drinks_for(state: &Value, hero_id: &Value) -> i64 {
    patron_for(state, hero_id).drinks
}

/// `tavernScandalsFor(state, heroId)`.
pub fn tavern_scandals_for(state: &Value, hero_id: &Value) -> i64 {
    patron_for(state, hero_id).scandals
}

/// `tavernEjected(state, heroId)`.
pub fn tavern_ejected(state: &Value, hero_id: &Value) -> bool {
    patron_for(state, hero_id).ejected
}

/// `tavernNextDrinkDc(state, heroId)`: СЛ спасброска за следующую кружку;
/// `None` — эта кружка ещё безопасна.
pub fn tavern_next_drink_dc(state: &Value, hero_id: &Value) -> Option<i64> {
    let next = tavern_drinks_for(state, hero_id) + 1;
    (next > TAVERN_SOBER_DRINKS).then(|| TAVERN_DRINK_BASE_DC + (next - TAVERN_SOBER_DRINKS))
}

/// `tavernSocialBonus(state, heroId, skill)`: прибавка застолья к Убеждению.
pub fn tavern_social_bonus(state: &Value, hero_id: &Value, skill: Option<&Value>) -> i64 {
    if js::s(skill).replace('_', "-") != TAVERN_SOCIAL_SKILL {
        return 0;
    }
    let drinks = tavern_drinks_for(state, hero_id);
    if (1..=TAVERN_SOBER_DRINKS).contains(&drinks) {
        TAVERN_SOCIAL_BONUS
    } else {
        0
    }
}

/// `tavernTableMood(state, heroId)`: разговорчивость стола для социального движка.
pub fn tavern_table_mood(state: &Value, hero_id: &Value) -> Option<Value> {
    let drinks = tavern_drinks_for(state, hero_id);
    if !is_tavern_scene(state) || drinks <= 0 {
        return None;
    }
    Some(json!({ "drinks": drinks, "shared_drink": true, "talkative": drinks <= TAVERN_SOBER_DRINKS, "over_the_edge": drinks > TAVERN_SOBER_DRINKS }))
}

/// `tavernForViewer(state, viewer)`: карточка таверны для стола — без
/// характера соперника и без чужого счёта.
pub fn tavern_for_viewer(state: &Value, viewer: &Value) -> Option<Value> {
    if !is_tavern_scene(state) {
        return None;
    }
    let hero_id = text(get(Some(viewer), "playerId"), 120);
    let tavern = tavern_of(state);
    let patron = tavern.patron_or_default(&hero_id);
    // Свой раунд — и только свой; у зрителя без героя — открытый раунд зала.
    let round = if hero_id.is_empty() { open_rounds_in(&tavern).into_iter().next() } else { patron.round.clone() };
    let hero = json!(hero_id);
    let scene = get(Some(state), "scene");
    let opponents: Vec<Value> = tavern_opponents(state)
        .into_iter()
        .map(|npc| {
            let mut entry = match npc.to_json() {
                Value::Object(map) => map,
                _ => Map::new(),
            };
            entry.insert("max_stake_cp".into(), json!(tavern_max_stake_for(state, &json!(npc.id))));
            Value::Object(entry)
        })
        .collect();
    let stakes: Vec<Value> = TAVERN_STAKE_LABELS.iter().map(|(stake, label)| json!({ "stake_cp": stake, "label": label })).collect();
    Some(json!({
        "schema_version": TAVERN_LIFE_SCHEMA_VERSION,
        "place_name": text(coalesce(get(scene, "location"), get(scene, "title")), 180),
        "location_id": scene_location_id(state),
        "opponents": opponents,
        "stakes": stakes,
        "approaches": TAVERN_DICE_APPROACHES,
        "round": round.as_ref().map_or(Value::Null, public_round_json),
        "drink_price_cp": TAVERN_DRINK_PRICE_CP,
        "drinks": patron.drinks,
        "next_drink_dc": tavern_next_drink_dc(state, &hero),
        "social_bonus": tavern_social_bonus(state, &hero, Some(&json!(TAVERN_SOCIAL_SKILL))),
        "ejected": patron.ejected,
    }))
}

fn public_round_json(round: &TavernRound) -> Value {
    json!({
        "id": round.id,
        "hero_id": round.hero_id,
        "npc_id": round.npc_id,
        "npc_name": round.npc_name,
        "stake_cp": round.stake_cp,
        "npc_total": round.npc_total,
        "target": round.target,
    })
}

/// `publicTavernRoundFor(round)`: публичная запись раунда.
pub fn public_tavern_round_for(round: Option<&Value>) -> Option<Value> {
    safe_round(round).as_ref().map(public_round_json)
}

// ---------------------------------------------------------------------------
// Редьюсер
// ---------------------------------------------------------------------------

/// Срез на входе редьюсера: своей версии — как есть (быстрый путь JS), иначе
/// нормализованный.
enum Normalized<'a> {
    Raw(&'a Value),
    Fresh(Tavern),
}

impl Normalized<'_> {
    fn patron(&self, key: &str) -> TavernPatron {
        match self {
            Normalized::Raw(input) => match member(input.get("patrons"), key) {
                Member::Own(found) => safe_patron(Some(found)),
                _ => TavernPatron::default(),
            },
            Normalized::Fresh(tavern) => tavern.patron_or_default(key),
        }
    }

    /// `{ ...normalized }` — для сборки входа следующей нормализации.
    fn fields(&self) -> Map<String, Value> {
        match self {
            Normalized::Raw(input) => spread(Some(input)),
            Normalized::Fresh(tavern) => match tavern.to_json() {
                Value::Object(map) => map,
                _ => Map::new(),
            },
        }
    }

    /// `{ ...normalized.patrons }`.
    fn patrons(&self) -> Map<String, Value> {
        match self {
            Normalized::Raw(input) => spread(input.get("patrons")),
            Normalized::Fresh(tavern) => tavern.patrons_json(),
        }
    }

    /// `normalized.gamblers` для `{ ...normalized.gamblers }` и `{ gamblers }`.
    fn gamblers(&self) -> Value {
        match self {
            Normalized::Raw(input) => input.get("gamblers").cloned().unwrap_or(Value::Null),
            Normalized::Fresh(tavern) => Value::Object(tavern.gamblers_json()),
        }
    }

    fn to_json(&self) -> Value {
        match self {
            Normalized::Raw(input) => (*input).clone(),
            Normalized::Fresh(tavern) => tavern.to_json(),
        }
    }
}

/// Касса соперника после события, которое двигало деньги стола: переносится
/// числом из события. Без `npc_purse_after_cp` касса не трогается.
fn gamblers_after_settlement(normalized: &Normalized<'_>, payload: Option<&Value>) -> Value {
    let npc_id = text(get(payload, "npc_id"), 120);
    let has_after = matches!(payload, Some(Value::Object(map)) if map.contains_key("npc_purse_after_cp"));
    if npc_id.is_empty() || !has_after {
        return normalized.gamblers();
    }
    let mut gamblers = spread(Some(&normalized.gamblers()));
    gamblers.insert(
        npc_id,
        json!({
            "purse_cp": clamp(get(payload, "npc_purse_after_cp"), 0, TAVERN_GAMBLER_PURSE_MAX_CP),
            "last_played_at_minutes": 0.max(integer(get(payload, "at_minutes"), 0)),
        }),
    );
    Value::Object(gamblers)
}

fn with_patron(normalized: &Normalized<'_>, gamblers: Option<Value>, hero_id: &str, patron: Value) -> Value {
    let mut source = normalized.fields();
    if let Some(gamblers) = gamblers {
        source.insert("gamblers".into(), gamblers);
    }
    let mut patrons = normalized.patrons();
    patrons.insert(hero_id.to_string(), patron);
    source.insert("patrons".into(), Value::Object(patrons));
    normalize_tavern_state(Some(&Value::Object(source)))
}

fn patron_patch(patron: &TavernPatron, patch: Value) -> Value {
    js::spread(&patron.to_json(), patch)
}

/// `applyTavernEvent(input, event, state)`: что событие меняет в счёте таверны.
/// Счёт выводится из журнала целиком; кассы соседей переживают смену сцены.
pub fn apply_tavern_event(input: Option<&Value>, event: &Value, _state: &Value) -> Value {
    let kind = js::s(event.get("event_type"));
    let normalized = match input {
        Some(raw) if raw.get("schema_version").and_then(Value::as_f64) == Some(TAVERN_LIFE_SCHEMA_VERSION as f64) && js::truthy(raw.get("patrons")) => Normalized::Raw(raw),
        _ => Normalized::Fresh(normalize(input)),
    };
    let empty = json!({});
    let payload = coalesce(event.get("payload"), Some(&empty));
    match kind.as_str() {
        // Новая сцена — новое заведение; кассы соседей переезжают нетронутыми.
        "SceneAdvanced" => normalize_tavern_state(Some(&json!({ "gamblers": normalized.gamblers() }))),
        "TavernDiceRoundOpened" => {
            let Some(round) = safe_round(get(payload, "round")) else { return normalized.to_json() };
            let patron = normalized.patron(&round.hero_id);
            let hero_id = round.hero_id.clone();
            with_patron(&normalized, None, &hero_id, patron_patch(&patron, json!({ "round": round.to_json() })))
        }
        "TavernDiceRoundResolved" | "TavernDiceRoundCancelled" => {
            let hero_id = text(get(payload, "hero_id"), 120);
            let gamblers = gamblers_after_settlement(&normalized, payload);
            if hero_id.is_empty() {
                let mut source = normalized.fields();
                source.insert("gamblers".into(), gamblers);
                return normalize_tavern_state(Some(&Value::Object(source)));
            }
            let patron = normalized.patron(&hero_id);
            let patch = if kind == "TavernDiceRoundResolved" {
                let caught = text(get(payload, "outcome"), 30) == "caught";
                json!({ "round": null, "scandals": patron.scandals + i64::from(caught) })
            } else {
                json!({ "round": null })
            };
            with_patron(&normalized, Some(gamblers), &hero_id, patron_patch(&patron, patch))
        }
        "TavernPatronEjected" | "TavernDrinkOrdered" => {
            let hero_id = text(get(payload, "hero_id"), 120);
            if hero_id.is_empty() {
                return normalized.to_json();
            }
            let patron = normalized.patron(&hero_id);
            let patch = if kind == "TavernPatronEjected" { json!({ "ejected": true }) } else { json!({ "drinks": patron.drinks + 1 }) };
            with_patron(&normalized, None, &hero_id, patron_patch(&patron, patch))
        }
        _ => normalized.to_json(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn purse_transfer_gives_the_cap_overflow_to_the_house() {
        let transfer = tavern_purse_transfer(Some(&json!(9_900)), Some(&json!(200)));
        assert_eq!(transfer, TavernPurseTransfer { before_cp: 9_900, after_cp: 10_000, moved_cp: 100, house_cut_cp: 100 });
        assert_eq!(tavern_purse_transfer_payload(Some(&transfer.to_json())), json!({ "npc_purse_before_cp": 9_900, "npc_purse_after_cp": 10_000, "house_cut_cp": 100 }));
        assert_eq!(tavern_purse_transfer_payload(Some(&tavern_purse_transfer(Some(&json!(0)), Some(&json!(0))).to_json())), json!({}));
    }

    #[test]
    fn proto_patron_is_hidden_from_json_but_read_by_key() {
        let tavern = normalize(Some(&json!({ "patrons": { "__proto__": { "drinks": 3 }, "hero": { "drinks": 1 } } })));
        assert_eq!(tavern.to_json()["patrons"], json!({ "hero": { "drinks": 1, "scandals": 0, "ejected": false, "round": null } }));
        assert_eq!(tavern.patron_or_default("__proto__").drinks, 3);
        assert_eq!(tavern.patron_or_default("constructor").drinks, 0);
    }
}

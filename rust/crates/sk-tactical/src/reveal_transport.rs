//! Перенос `server/reveal-transport.mjs`: транспорт дельт раскрытия
//! (`docs/tactical-map-plan.md`, 11.2). Помнит проекции карт по хешу и решает,
//! что уходит клиенту: `full` — карта целиком, `delta` — интервалы раскрытия
//! поверх карты клиента, `unchanged` — отправлять нечего.
//!
//! Сторож видимости: дельта уходит, только если её наложение на карту клиента
//! даёт ровно ту же сериализацию, что и полная проекция; любое сомнение
//! решается в пользу полной карты.
//!
//! Кэш JS общий на процесс; здесь он — [`RevealTransport`], а свободные
//! функции работают с общим экземпляром процесса. Запоминание ответа по паре
//! «проекция — карта клиента» (в JS — `WeakMap` по объекту проекции) здесь —
//! по паре хешей с проверкой, что обе карты те же по содержимому; ответ от
//! этого не меняется, сторож проходит один раз на пару.

use std::sync::{LazyLock, Mutex};

use serde_json::{Map, Value};
use sk_core::indexmap::IndexMap;
use sk_core::js;

use crate::reveal_delta::{apply_reveal_delta, reveal_delta_empty, reveal_update_for, RevealUpdate};
use crate::tactical_map::{deserialize_tactical_map, serialize_tactical_map};

/// Сколько проекций карт держать. Одна карта 100×100 — около 30 КБ JSON.
pub const PROJECTED_MAP_CACHE_LIMIT: usize = 24;

/// Сколько разных карт клиентов помнить на одну проекцию.
const DELTA_CHECKS_PER_MAP: usize = 8;

/// Что отправить клиенту (`SceneMapUpdate`).
#[derive(Clone, Debug, PartialEq)]
pub enum SceneMapUpdate {
    /// `{ kind: 'full', hash, map }` — карта целиком.
    Full { hash: String },
    /// `{ kind: 'delta', hash, delta }`.
    Delta { hash: String, delta: Value },
    /// `{ kind: 'unchanged', hash }`.
    Unchanged { hash: String },
}

impl SceneMapUpdate {
    pub fn kind(&self) -> &'static str {
        match self {
            SceneMapUpdate::Full { .. } => "full",
            SceneMapUpdate::Delta { .. } => "delta",
            SceneMapUpdate::Unchanged { .. } => "unchanged",
        }
    }

    pub fn hash(&self) -> &str {
        match self {
            SceneMapUpdate::Full { hash } | SceneMapUpdate::Delta { hash, .. } | SceneMapUpdate::Unchanged { hash } => hash,
        }
    }

    /// Форма JS; для `full` — переданная проекция (`map ?? {}`).
    pub fn to_json(&self, map: Option<&Value>) -> Value {
        let mut object = Map::new();
        object.insert("kind".into(), Value::String(self.kind().into()));
        object.insert("hash".into(), Value::String(self.hash().into()));
        match self {
            SceneMapUpdate::Full { .. } => {
                object.insert("map".into(), map.cloned().unwrap_or_else(|| Value::Object(Map::new())));
            }
            SceneMapUpdate::Delta { delta, .. } => {
                object.insert("delta".into(), delta.clone());
            }
            SceneMapUpdate::Unchanged { .. } => {}
        }
        Value::Object(object)
    }
}

/// Сцена к отправке (`compactSceneFor`): `scene: None` — исходная сцена без
/// изменений (JS возвращает тот же объект).
#[derive(Clone, Debug, PartialEq)]
pub struct CompactScene {
    pub scene: Option<Value>,
    pub hash: String,
}

#[derive(Clone, Debug)]
struct DeltaCheck {
    map: Value,
    client_map: Value,
    update: SceneMapUpdate,
}

/// Кэш проекций карт и ответов сторожа.
#[derive(Debug, Default)]
pub struct RevealTransport {
    projected: IndexMap<String, Value>,
    checks: IndexMap<String, DeltaCheck>,
}

impl RevealTransport {
    pub fn new() -> Self {
        Self::default()
    }

    /// `rememberProjectedMap(hash, map)`: запись встаёт последней, давние
    /// вытесняются сверх предела.
    pub fn remember_projected_map(&mut self, hash: &str, map: Option<&Value>) {
        let Some(map) = map.filter(|map| js::truthy(Some(map))) else { return };
        if hash.is_empty() {
            return;
        }
        self.projected.shift_remove(hash);
        self.projected.insert(hash.to_string(), map.clone());
        while self.projected.len() > PROJECTED_MAP_CACHE_LIMIT {
            self.projected.shift_remove_index(0);
        }
    }

    /// `projectedMapByHash(hash)`: обращение освежает запись.
    pub fn projected_map_by_hash(&mut self, hash: Option<&str>) -> Option<Value> {
        let hash = hash.filter(|hash| !hash.is_empty())?;
        let cached = self.projected.shift_remove(hash)?;
        self.projected.insert(hash.to_string(), cached.clone());
        Some(cached)
    }

    /// `forgetProjectedMaps()`: очистка между тестами.
    pub fn forget_projected_maps(&mut self) {
        self.projected.clear();
        self.checks.clear();
    }

    /// `sceneMapUpdateFor(map, hash, clientHash)`: что отправить клиенту, у
    /// которого закэширована карта с хешем `client_hash`.
    pub fn scene_map_update_for(&mut self, map: Option<&Value>, hash: &str, client_hash: &str) -> SceneMapUpdate {
        let Some(map) = map.filter(|map| js::truthy(Some(map))) else { return SceneMapUpdate::Full { hash: hash.to_string() } };
        if hash.is_empty() {
            return SceneMapUpdate::Full { hash: String::new() };
        }
        self.remember_projected_map(hash, Some(map));
        if !client_hash.is_empty() && client_hash == hash {
            return SceneMapUpdate::Unchanged { hash: hash.to_string() };
        }
        let Some(cached) = self.projected_map_by_hash(Some(client_hash)) else { return SceneMapUpdate::Full { hash: hash.to_string() } };
        let check_key = format!("{hash}\n{client_hash}");
        if let Some(remembered) = self.checks.get(&check_key) {
            if remembered.client_map == cached && remembered.map == *map {
                return remembered.update.clone();
            }
        }
        let update = delta_or_full_update(map, hash, client_hash, &cached);
        self.checks.shift_remove(&check_key);
        self.checks.insert(check_key, DeltaCheck { map: map.clone(), client_map: cached, update: update.clone() });
        while self.checks.len() > PROJECTED_MAP_CACHE_LIMIT * DELTA_CHECKS_PER_MAP {
            self.checks.shift_remove_index(0);
        }
        update
    }

    /// `compactSceneFor(scene, clientHash)`: сцена к отправке и хеш карты,
    /// который вызывающий обязан запомнить за клиентом.
    pub fn compact_scene_for(&mut self, scene: &Value, client_hash: &str) -> CompactScene {
        let unchanged = |hash: String| CompactScene { scene: None, hash };
        let Value::Object(object) = scene else { return unchanged(String::new()) };
        let hash = js::s(object.get("map_hash"));
        if !js::truthy(object.get("map")) || hash.is_empty() {
            return unchanged(String::new());
        }
        let update = self.scene_map_update_for(object.get("map"), &hash, client_hash);
        let mut rest = object.clone();
        rest.shift_remove("map");
        match update {
            SceneMapUpdate::Full { hash } => unchanged(hash),
            SceneMapUpdate::Delta { hash, delta } => {
                rest.insert("map_delta".into(), delta);
                CompactScene { scene: Some(Value::Object(rest)), hash }
            }
            SceneMapUpdate::Unchanged { hash } => {
                rest.insert("map_unchanged".into(), Value::Bool(true));
                CompactScene { scene: Some(Value::Object(rest)), hash }
            }
        }
    }

    /// `compactStateForTransport(state, clientHash)`: `None` — состояние
    /// уходит как есть (у администратора — непроецированное, без `map_hash`).
    pub fn compact_state_for_transport(&mut self, state: &Value, client_hash: &str) -> (Option<Value>, String) {
        let Value::Object(object) = state else { return (None, client_hash.to_string()) };
        let Some(scene) = object.get("scene").filter(|scene| js::truthy(Some(scene))) else { return (None, client_hash.to_string()) };
        let compact = self.compact_scene_for(scene, client_hash);
        let Some(scene) = compact.scene else {
            let hash = if compact.hash.is_empty() { client_hash.to_string() } else { compact.hash };
            return (None, hash);
        };
        let mut next = object.clone();
        next.insert("scene".into(), scene);
        (Some(Value::Object(next)), compact.hash)
    }
}

/// `deltaOrFullUpdate(serialized, hash, clientHash, cached)`: дельта от карты
/// клиента либо карта целиком — со сторожем видимости.
fn delta_or_full_update(serialized: &Value, hash: &str, client_hash: &str, cached: &Value) -> SceneMapUpdate {
    let full = || SceneMapUpdate::Full { hash: hash.to_string() };
    let Ok(RevealUpdate::Delta(delta)) = reveal_update_for(serialized, client_hash, Some(client_hash), Some(cached)) else { return full() };
    if reveal_delta_empty(Some(&delta)) {
        return full();
    }
    let Ok(mut rebuilt) = deserialize_tactical_map(cached) else { return full() };
    if apply_reveal_delta(&mut rebuilt, &delta).is_err() {
        return full();
    }
    let Ok(rebuilt) = serialize_tactical_map(&rebuilt) else { return full() };
    if js::stringify(&rebuilt) != js::stringify(serialized) {
        return full();
    }
    SceneMapUpdate::Delta { hash: hash.to_string(), delta }
}

static TRANSPORT: LazyLock<Mutex<RevealTransport>> = LazyLock::new(|| Mutex::new(RevealTransport::new()));

fn with_transport<T>(run: impl FnOnce(&mut RevealTransport) -> T) -> T {
    let mut transport = TRANSPORT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    run(&mut transport)
}

/// `rememberProjectedMap(hash, map)` в общем кэше процесса.
pub fn remember_projected_map(hash: &str, map: Option<&Value>) {
    with_transport(|transport| transport.remember_projected_map(hash, map));
}

/// `projectedMapByHash(hash)` в общем кэше процесса.
pub fn projected_map_by_hash(hash: Option<&str>) -> Option<Value> {
    with_transport(|transport| transport.projected_map_by_hash(hash))
}

/// `forgetProjectedMaps()` для общего кэша процесса.
pub fn forget_projected_maps() {
    with_transport(RevealTransport::forget_projected_maps);
}

/// `sceneMapUpdateFor(map, hash, clientHash)` над общим кэшем процесса.
pub fn scene_map_update_for(map: Option<&Value>, hash: &str, client_hash: &str) -> SceneMapUpdate {
    with_transport(|transport| transport.scene_map_update_for(map, hash, client_hash))
}

/// `compactSceneFor(scene, clientHash)` над общим кэшем процесса.
pub fn compact_scene_for(scene: &Value, client_hash: &str) -> CompactScene {
    with_transport(|transport| transport.compact_scene_for(scene, client_hash))
}

/// `compactStateForTransport(state, clientHash)` над общим кэшем процесса.
pub fn compact_state_for_transport(state: &Value, client_hash: &str) -> (Option<Value>, String) {
    with_transport(|transport| transport.compact_state_for_transport(state, client_hash))
}

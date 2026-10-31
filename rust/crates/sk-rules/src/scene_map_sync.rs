//! Синхронизация канона `scene.map` и производной `scene.cells`. Задача Р1.
//!
//! JS: `server/rules-engine.mjs`, 2293–2413 — `syncSceneCells`,
//! `writeSceneTacticalMap`, `ensureSceneTacticalMap`,
//! `rebuildSceneTacticalMap`, `reconcileSceneTacticalMap`, `sameLegacyGrid`,
//! `mergeLegacyCells`, `legacyCellsDiverged`.
//!
//! Кэш разобранных карт JS (`sceneTacticalMapCache`) не повторён: карта
//! разбирается заново (см. `tactical_geometry`). Замечено в JS: путь слияния
//! в `reconcileSceneTacticalMap` правит закэшированный экземпляр на месте и
//! не выселяет прежний ключ кэша — держатель старого объекта `scene.map`
//! получил бы из кэша уже изменённую карту. Здесь кэша нет, и такого
//! расхождения не бывает.

use serde_json::Value;
use sk_core::js;
use sk_tactical::tactical_map::{self as tmap, CellPatch, LegacyMapOptions, MapResult, TacticalMap, MATERIALS};

use crate::tactical_geometry::{map_cell_at, scene_tactical_map};

fn scene_object(state: &Value) -> bool {
    state.get("scene").is_some_and(Value::is_object)
}

/// `syncSceneCells(state, map)`: единственное место, где пересобирается
/// `scene.cells` — производная read-модель канона `scene.map`. `map` `None`
/// — карта самой сцены.
pub fn sync_scene_cells(state: &mut Value, map: Option<&TacticalMap>) {
    let owned;
    let source = match map {
        Some(map) => Some(map),
        None => {
            owned = scene_tactical_map(state);
            owned.as_ref()
        }
    };
    let Some(source) = source else { return };
    if !js::truthy(state.get("scene")) {
        return;
    }
    set_scene_cells(state, tmap::legacy_cells_from_tactical_map(source));
}

/// Запись готовой производной `scene.cells` (то, что пишет
/// [`sync_scene_cells`], когда клетки уже выведены из той же карты).
pub fn set_scene_cells(state: &mut Value, cells: Vec<Value>) {
    if !js::truthy(state.get("scene")) {
        return;
    }
    if let Some(scene) = state.get_mut("scene").and_then(Value::as_object_mut) {
        scene.insert("cells".into(), Value::Array(cells));
    }
}

/// `writeSceneTacticalMap(state, map)`: изменённая карта обратно в
/// состояние и обновлённая производная.
pub fn write_scene_tactical_map(state: &mut Value, map: &TacticalMap) -> MapResult<()> {
    sk_tactical::combat_bounds::write_scene_tactical_map(state, map)
}

/// `ensureSceneTacticalMap(state)`: карта сцены, а если её нет — собранная
/// по старым клеткам (состояние, сохранённое до перехода на слои).
pub fn ensure_scene_tactical_map(state: &mut Value) -> MapResult<Option<TacticalMap>> {
    sk_tactical::combat_bounds::ensure_scene_tactical_map(state)
}

/// [`ensure_scene_tactical_map`] над общим состоянием: карта уже есть —
/// состояние не копируется (её чтение ничего не пишет); копия — только
/// когда карту надо собрать и записать.
pub fn ensure_scene_tactical_map_shared(state: &mut std::sync::Arc<Value>) -> MapResult<Option<TacticalMap>> {
    if !scene_object(state) {
        return Ok(None);
    }
    if let Some(existing) = scene_tactical_map(state) {
        return Ok(Some(existing));
    }
    ensure_scene_tactical_map(std::sync::Arc::make_mut(state))
}

/// `rebuildSceneTacticalMap(state)`: карта по `scene.cells`, записанная в
/// `scene.map`; без клеток — `None`.
pub fn rebuild_scene_tactical_map(state: &mut Value) -> MapResult<Option<TacticalMap>> {
    let Some(scene) = state.get("scene") else { return Ok(None) };
    let cells = match scene.get("cells") {
        Some(Value::Array(cells)) if !cells.is_empty() => cells.clone(),
        _ => return Ok(None),
    };
    let location_id = js::s(crate::core::coalesce(&[scene.get("location_id"), scene.get("locationId")]));
    let seed = js::s(state.get("worldMap").and_then(|world| world.get("seed")));
    let map = tmap::tactical_map_from_legacy_cells(&cells, &LegacyMapOptions { location_id: &location_id, seed: &seed, ..LegacyMapOptions::default() })?;
    let serialized = tmap::serialize_tactical_map(&map)?;
    if let Some(scene) = state.get_mut("scene").and_then(Value::as_object_mut) {
        scene.insert("map".into(), serialized);
    }
    Ok(Some(map))
}

/// `reconcileSceneTacticalMap(state)`: канон и производная согласуются при
/// нормализации. Расхождение решается в пользу клеток: та же сетка и те же
/// предметы — раскрытие, проходимость и материал накладываются на карту;
/// иная форма — полная пересборка.
pub fn reconcile_scene_tactical_map(state: &mut Value) -> MapResult<Option<TacticalMap>> {
    Ok(reconcile_scene_tactical_map_cells(state)?.map(|(map, _)| map))
}

/// [`reconcile_scene_tactical_map`] вместе с уже выведенными из итоговой
/// карты клетками (`legacyCellsFromTacticalMap(map)`), если карта осталась
/// прежней: `syncSceneCells` после согласования пишет ровно их, и второй
/// вывод не нужен. Клетки сцены читаются по ссылке, без копии.
pub fn reconcile_scene_tactical_map_cells(state: &mut Value) -> MapResult<Option<(TacticalMap, Option<Vec<Value>>)>> {
    enum Next {
        Keep(Option<Vec<Value>>),
        Merged(Value),
        Rebuild,
    }
    if !scene_object(state) {
        return Ok(None);
    }
    let Some(mut map) = scene_tactical_map(state) else { return Ok(rebuild_scene_tactical_map(state)?.map(|map| (map, None))) };
    let next = {
        let cells: &[Value] = state["scene"].get("cells").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        if cells.is_empty() {
            Next::Keep(None)
        } else {
            let derived = tmap::legacy_cells_from_tactical_map(&map);
            if !legacy_cells_diverged(cells, &derived) {
                Next::Keep(Some(derived))
            } else if same_legacy_grid(cells, &derived) {
                merge_legacy_cells(&mut map, cells)?;
                Next::Merged(tmap::serialize_tactical_map(&map)?)
            } else {
                Next::Rebuild
            }
        }
    };
    match next {
        Next::Keep(derived) => Ok(Some((map, derived))),
        Next::Merged(serialized) => {
            if let Some(scene) = state.get_mut("scene").and_then(Value::as_object_mut) {
                scene.insert("map".into(), serialized);
            }
            Ok(Some((map, None)))
        }
        Next::Rebuild => {
            if let Some(rebuilt) = rebuild_scene_tactical_map(state)? {
                map = rebuilt;
            }
            Ok(Some((map, None)))
        }
    }
}

/// Строгое равенство JS для значений JSON: примитивы по значению, объекты и
/// массивы — никогда (у каждого своя ссылка).
fn strict_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Object(_) | Value::Array(_), _) | (_, Value::Object(_) | Value::Array(_)) => false,
        _ => left == right,
    }
}

/// `value ?? null`.
fn or_null(value: Option<&Value>) -> &Value {
    static NULL: Value = Value::Null;
    value.unwrap_or(&NULL)
}

/// `sameLegacyGrid(actual, derived)`: та же сетка клеток и те же предметы.
pub fn same_legacy_grid(actual: &[Value], derived: &[Value]) -> bool {
    if actual.len() != derived.len() {
        return false;
    }
    actual.iter().zip(derived).all(|(left, right)| {
        js::number(left.get("x")) == js::number(right.get("x"))
            && js::number(left.get("y")) == js::number(right.get("y"))
            && strict_equal(or_null(left.get("feature")), or_null(right.get("feature")))
    })
}

/// `mergeLegacyCells(map, cells)`: раскрытие, проходимость и материал из
/// старых клеток — поверх карты.
pub fn merge_legacy_cells(map: &mut TacticalMap, cells: &[Value]) -> MapResult<()> {
    for legacy in cells {
        let x = js::number(legacy.get("x"));
        let y = js::number(legacy.get("y"));
        let Some(cell) = map_cell_at(map, x, y) else { continue };
        let kind = js::s(Some(legacy.get("type").filter(|kind| !kind.is_null()).unwrap_or(&Value::String("floor".into()))));
        let passable = kind == "floor" || kind == "door";
        let surface = if kind == "water" { "water" } else { "none" };
        let material_raw = legacy.get("material").filter(|material| !material.is_null()).map(|material| js::string(Some(material)));
        let material = material_raw.filter(|material| MATERIALS.contains(&material.as_str()));
        let changes_passable = passable != cell.passable;
        let patch = CellPatch {
            revealed: Some(js::is_true(legacy.get("revealed"))),
            passable: changes_passable.then_some(passable),
            surface: changes_passable.then_some(surface),
            material: material.as_deref(),
            ..CellPatch::default()
        };
        tmap::set_cell(map, x as i64, y as i64, &patch)?;
    }
    Ok(())
}

/// `legacyCellsDiverged(actual, derived)`: сравнение без сериализации.
pub fn legacy_cells_diverged(actual: &[Value], derived: &[Value]) -> bool {
    if actual.len() != derived.len() {
        return true;
    }
    actual.iter().zip(derived).any(|(left, right)| {
        if js::number(left.get("x")) != js::number(right.get("x")) || js::number(left.get("y")) != js::number(right.get("y")) {
            return true;
        }
        // `String(x) === y` без копии строки, когда `x` уже строка.
        let same_text = |left: &Value, right: &Value| match left {
            Value::String(text) => right.as_str() == Some(text.as_str()),
            other => strict_equal(&Value::String(js::string(Some(other))), right),
        };
        let right_kind = or_null(right.get("type"));
        let kind_equal = match left.get("type") {
            None | Some(Value::Null) => right_kind.as_str() == Some("floor"),
            Some(kind) => same_text(kind, right_kind),
        };
        if !kind_equal {
            return true;
        }
        if Value::Bool(js::is_true(left.get("revealed"))) != *or_null(right.get("revealed")) {
            return true;
        }
        if !strict_equal(or_null(left.get("feature")), or_null(right.get("feature"))) {
            return true;
        }
        left.get("material").is_some_and(|material| !material.is_null() && !same_text(material, or_null(right.get("material"))))
    })
}

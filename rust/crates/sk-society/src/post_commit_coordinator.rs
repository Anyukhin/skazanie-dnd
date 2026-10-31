//! Перенос `server/post-commit-coordinator.mjs`: последствия после коммита
//! выводит один координатор, а не пять мест подряд в `index.mjs`.
//!
//! Координатор получает только подтверждённые события и запускает
//! детерминированную последовательность стадий ([`STAGES`]):
//!
//! ```text
//! commit → quest consequences → combat continuation → encounter completion
//!        → hero hooks → world/director trigger → visible projection → narration
//! ```
//!
//! Ключи двух видов: `once` — одноразовое последствие (повтор по тому же
//! источнику не выполняется), `loop` — продолжение цикла (ключ от позиции в
//! состоянии, память процесса его не скипает).
//!
//! В JS стадии и зависимости асинхронны (`await`); перенос синхронный: в
//! крейтах нижних волн нет исполнителя асинхронного кода, а порядок стадий и
//! правила ключей от этого не меняются.

use std::collections::HashSet;

use serde_json::{Map, Value};
use sk_core::{indexmap::IndexMap, indexmap::IndexSet, js};

use crate::common::{digest as digest_parts, get, js_string, prop, s, tpl};
use crate::parley::truce_holds;

/// Вид ключа стадии.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageKeyKind {
    /// Одноразовое последствие: ключ от стабильного источника.
    Once,
    /// Продолжение цикла: ключ от позиции в состоянии.
    Loop,
}

impl StageKeyKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Loop => "loop",
        }
    }
}

pub const STAGE_KEY_KINDS: [&str; 2] = ["once", "loop"];

fn digest(value: &str) -> String {
    digest_parts(&[value.to_string()])[..20].to_string()
}

/// Позиция в бою (`combatPositionKey`): то, что делает ключ продолжения
/// устойчивым к падению на середине очереди инициативы.
pub fn combat_position_key(state: &Value) -> Option<String> {
    let mechanics = get(Some(state), "mechanics");
    let combat = get(mechanics, "combat");
    if !js::truthy(get(combat, "active")) {
        return None;
    }
    let encounter_id = match get(get(mechanics, "encounter"), "id") {
        None | Some(Value::Null) => "no-encounter".to_string(),
        Some(id) => js_string(id),
    };
    let round = js::number(Some(crate::common::coalesce(get(combat, "round"), None).unwrap_or(&Value::from(0))));
    let index = js::number(Some(crate::common::coalesce(get(combat, "active_index"), None).unwrap_or(&Value::from(0))));
    let index_key = js::f64_string(index);
    let actor = match get(prop(get(combat, "initiative"), &index_key), "actor_id") {
        None | Some(Value::Null) => "unknown".to_string(),
        Some(actor) => js_string(actor),
    };
    Some(format!("combat:{encounter_id}:r{}:i{index_key}:{actor}", js::f64_string(round)))
}

/// Такт Режиссёра ключуется позицией в истории (`directorPositionKey`).
pub fn director_position_key(state: &Value) -> String {
    let number_or_one = |value: Option<&Value>| match value {
        None | Some(Value::Null) => 1.0,
        some => js::number(some),
    };
    let arc = number_or_one(get(get(Some(state), "campaignConcept"), "current_arc_number"));
    let adventure = get(Some(state), "adventure");
    let chapter = number_or_one(get(adventure, "chapter"));
    let beat = s(get(adventure, "objective"));
    format!("director:a{}:c{}:{}", js::f64_string(arc), js::f64_string(chapter), digest(&beat))
}

/// Зависимость-стадия: возвращает результат (`None` — `undefined`) или ошибку.
pub type DepFn = Box<dyn FnMut(&StageContext) -> Result<Option<Value>, String>>;

/// Зависимости координатора (`deps` в JS): каждая необязательна.
#[derive(Default)]
pub struct PostCommitDeps {
    pub apply_quest_consequences: Option<DepFn>,
    pub continue_combat: Option<DepFn>,
    pub complete_encounter: Option<DepFn>,
    /// Какие герои ждут плетения зацепок: `(state, campaign_id) → ids`.
    pub heroes_needing_hooks: Option<Box<dyn Fn(&Value, &str) -> Vec<Value>>>,
    pub weave_hero_hooks: Option<DepFn>,
    pub run_director: Option<DepFn>,
    pub persist_projection: Option<DepFn>,
    pub narrate: Option<DepFn>,
}

impl PostCommitDeps {
    fn heroes(&self, context: &StageContext) -> Vec<Value> {
        self.heroes_needing_hooks.as_ref().map(|heroes| heroes(context.state, &context.campaign_id)).unwrap_or_default()
    }
}

fn call(dep: &mut Option<DepFn>, context: &StageContext) -> Result<Option<Value>, String> {
    match dep {
        Some(dep) => dep(context),
        None => Ok(None),
    }
}

/// Контекст стадии: то, что JS собирает в объект `context`.
pub struct StageContext<'a> {
    /// Дополнительные поля вызывающего (`context` в `run`).
    pub extra: Map<String, Value>,
    pub campaign_id: String,
    pub state: &'a Value,
    pub events: &'a [Value],
    pub event_types: IndexSet<String>,
    pub commit_key: String,
    /// Ключ стадии; есть только у контекста, переданного в `run`.
    pub stage_key: Option<String>,
}

impl<'a> StageContext<'a> {
    /// Контекст без событий и ключа — для проверки `applies`/`key` отдельной стадии.
    pub fn for_state(state: &'a Value) -> Self {
        Self { extra: Map::new(), campaign_id: String::new(), state, events: &[], event_types: IndexSet::new(), commit_key: String::new(), stage_key: None }
    }
}

/// Стадия координатора.
#[derive(Clone, Copy)]
pub struct PostCommitStage {
    pub name: &'static str,
    pub key_kind: StageKeyKind,
    pub applies: fn(&StageContext, &PostCommitDeps) -> bool,
    pub key: fn(&StageContext, &PostCommitDeps) -> Option<String>,
    pub run: fn(&StageContext, &mut PostCommitDeps) -> Result<Option<Value>, String>,
}

fn combat_active(state: &Value) -> bool {
    js::truthy(get(get(get(Some(state), "mechanics"), "combat"), "active"))
}

/// Стадии в порядке исполнения (`STAGES`).
pub static STAGES: [PostCommitStage; 7] = [
    PostCommitStage {
        name: "quest-consequences",
        key_kind: StageKeyKind::Once,
        applies: |context, _| context.event_types.contains("QuestResolved") || context.event_types.contains("NpcPromiseResolved"),
        key: |context, _| Some(format!("quest-consequences:{}", context.commit_key)),
        run: |context, deps| call(&mut deps.apply_quest_consequences, context),
    },
    PostCommitStage {
        name: "combat-continuation",
        key_kind: StageKeyKind::Loop,
        // Перемирие останавливает продолжение боя целиком.
        applies: |context, _| combat_active(context.state) && !truce_holds(context.state),
        key: |context, _| combat_position_key(context.state),
        run: |context, deps| call(&mut deps.continue_combat, context),
    },
    PostCommitStage {
        name: "encounter-completion",
        key_kind: StageKeyKind::Once,
        applies: |context, _| s(get(get(get(Some(context.state), "mechanics"), "encounter"), "status")) == "ended",
        key: |context, _| {
            let id = s(get(get(get(Some(context.state), "mechanics"), "encounter"), "id"));
            (!id.is_empty()).then(|| format!("encounter-completion:{id}:transition"))
        },
        run: |context, deps| call(&mut deps.complete_encounter, context),
    },
    PostCommitStage {
        name: "hero-hooks",
        key_kind: StageKeyKind::Once,
        // Зацепки из предысторий плетутся вне боя, когда их ждут герои.
        applies: |context, deps| !combat_active(context.state) && !deps.heroes(context).is_empty(),
        key: |context, deps| {
            let mut ids: Vec<String> = deps.heroes(context).iter().map(js_string).collect();
            ids.sort_by(|a, b| crate::common::utf16_cmp(a, b));
            (!ids.is_empty()).then(|| format!("hero-hooks:{}", ids.join(",")))
        },
        run: |context, deps| call(&mut deps.weave_hero_hooks, context),
    },
    PostCommitStage {
        name: "director-trigger",
        key_kind: StageKeyKind::Loop,
        // Режиссёр вызывается по детерминированным триггерам, а не после каждого хода.
        applies: |context, _| {
            !combat_active(context.state)
                && ["ObjectiveUpdated", "SceneAdvanced", "EncounterRewardsDistributed"].iter().any(|kind| context.event_types.contains(*kind))
        },
        key: |context, _| Some(director_position_key(context.state)),
        run: |context, deps| call(&mut deps.run_director, context),
    },
    PostCommitStage {
        name: "visible-projection",
        key_kind: StageKeyKind::Once,
        applies: |_, _| true,
        key: |context, _| Some(format!("projection:{}", context.commit_key)),
        run: |context, deps| call(&mut deps.persist_projection, context),
    },
    PostCommitStage {
        name: "narration",
        key_kind: StageKeyKind::Once,
        applies: |context, deps| deps.narrate.is_some() && !context.events.is_empty(),
        key: |context, _| Some(format!("narration:{}", context.commit_key)),
        run: |context, deps| call(&mut deps.narrate, context),
    },
];

/// Вход одного прогона (`run({ campaignId, state, events, commitKey, stages, context })`).
pub struct RunInput<'a> {
    pub campaign_id: &'a str,
    pub state: &'a Value,
    pub events: &'a [Value],
    /// Пустая строка — ключ выводится из событий.
    pub commit_key: &'a str,
    /// Подмножество стадий по именам; `None` — все.
    pub stages: Option<&'a [&'a str]>,
    pub context: Map<String, Value>,
}

/// Итог прогона: что выполнено, пропущено, упало, и результаты стадий.
#[derive(Debug, Default, PartialEq)]
pub struct RunResult {
    pub ran: Vec<String>,
    pub skipped: Vec<String>,
    pub failed: Vec<String>,
    /// Результат стадии; `None` — стадия вернула `undefined`.
    pub results: IndexMap<String, Option<Value>>,
}

/// Координатор последствий после коммита (`PostCommitCoordinator`).
pub struct PostCommitCoordinator {
    pub deps: PostCommitDeps,
    pub stages: Vec<PostCommitStage>,
    pub on_error: Option<Box<dyn FnMut(&str, &str)>>,
    completed: HashSet<String>,
}

fn commit_key_for(commit_key: &str, events: &[Value]) -> String {
    if !commit_key.is_empty() {
        return commit_key.to_string();
    }
    if let Some(first) = events.first().and_then(|event| get(Some(event), "event_id")).filter(|id| js::truthy(Some(id))) {
        return js_string(first);
    }
    let ids: Vec<Value> = events
        .iter()
        .map(|event| match get(Some(event), "event_id") {
            None | Some(Value::Null) => Value::String(String::new()),
            Some(id) => id.clone(),
        })
        .collect();
    digest(&serde_json::to_string(&ids).unwrap_or_default())
}

impl PostCommitCoordinator {
    /// `new PostCommitCoordinator({ deps, stages = STAGES, onError })`.
    pub fn new(deps: PostCommitDeps) -> Self {
        Self { deps, stages: STAGES.to_vec(), on_error: None, completed: HashSet::new() }
    }

    /// Обработчик падения стадии: `(текст ошибки, имя стадии)`.
    pub fn with_on_error(mut self, on_error: impl FnMut(&str, &str) + 'static) -> Self {
        self.on_error = Some(Box::new(on_error));
        self
    }

    /// Свой набор стадий вместо [`STAGES`].
    pub fn with_stages(mut self, stages: Vec<PostCommitStage>) -> Self {
        self.stages = stages;
        self
    }

    /// Один прогон последовательности по подтверждённым событиям.
    pub fn run(&mut self, input: RunInput) -> RunResult {
        let context = StageContext {
            extra: input.context,
            campaign_id: input.campaign_id.to_string(),
            state: input.state,
            events: input.events,
            event_types: input.events.iter().map(|event| s(get(Some(event), "event_type"))).collect(),
            commit_key: commit_key_for(input.commit_key, input.events),
            stage_key: None,
        };
        let mut result = RunResult::default();
        // Подмножество стадий нужно для пошагового подключения маршрутов.
        let selected: Vec<PostCommitStage> = match input.stages {
            Some(names) => self.stages.iter().filter(|stage| names.contains(&stage.name)).copied().collect(),
            None => self.stages.clone(),
        };
        for stage in selected {
            if !(stage.applies)(&context, &self.deps) {
                result.skipped.push(stage.name.into());
                continue;
            }
            let Some(key) = (stage.key)(&context, &self.deps) else {
                result.skipped.push(stage.name.into());
                continue;
            };
            let guard = format!("{} {} {key}", tpl(Some(&Value::String(context.campaign_id.clone()))), stage.name);
            // Память процесса стережёт только одноразовые последствия.
            if stage.key_kind == StageKeyKind::Once && self.completed.contains(&guard) {
                result.skipped.push(stage.name.into());
                continue;
            }
            let run_context = StageContext {
                extra: context.extra.clone(),
                campaign_id: context.campaign_id.clone(),
                state: context.state,
                events: context.events,
                event_types: context.event_types.clone(),
                commit_key: context.commit_key.clone(),
                stage_key: Some(key),
            };
            match (stage.run)(&run_context, &mut self.deps) {
                Ok(value) => {
                    result.results.insert(stage.name.into(), value);
                    // Помечаем только успех: упавшая стадия будет повторена.
                    if stage.key_kind == StageKeyKind::Once {
                        self.completed.insert(guard);
                    }
                    result.ran.push(stage.name.into());
                }
                Err(error) => {
                    result.failed.push(stage.name.into());
                    if let Some(on_error) = self.on_error.as_mut() {
                        on_error(&error, stage.name);
                    }
                    // Падение одной стадии не отменяет ни выполненные, ни следующие.
                }
            }
        }
        result
    }
}

/// Порядок стадий для ревью (`stageOrderForReview`): `[(name, keyKind)]`.
pub fn stage_order_for_review() -> Vec<(&'static str, &'static str)> {
    STAGES.iter().map(|stage| (stage.name, stage.key_kind.as_str())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn state_in_combat(round: i64, index: i64, encounter_id: &str) -> Value {
        json!({ "mechanics": {
            "encounter": { "id": encounter_id, "status": "active" },
            "combat": { "active": true, "round": round, "active_index": index, "initiative": [{ "actor_id": "hero" }, { "actor_id": "wolf" }] },
        } })
    }

    fn tracking_deps(order: &Rc<RefCell<Vec<String>>>) -> PostCommitDeps {
        let record = |name: &'static str| -> Option<DepFn> {
            let order = Rc::clone(order);
            Some(Box::new(move |_: &StageContext| {
                order.borrow_mut().push(name.into());
                Ok(None)
            }))
        };
        PostCommitDeps {
            apply_quest_consequences: record("quest-consequences"),
            continue_combat: record("combat-continuation"),
            complete_encounter: record("encounter-completion"),
            run_director: record("director-trigger"),
            persist_projection: record("visible-projection"),
            narrate: record("narration"),
            ..PostCommitDeps::default()
        }
    }

    fn input<'a>(campaign_id: &'a str, state: &'a Value, events: &'a [Value], commit_key: &'a str) -> RunInput<'a> {
        RunInput { campaign_id, state, events, commit_key, stages: None, context: Map::new() }
    }

    fn count(order: &Rc<RefCell<Vec<String>>>, name: &str) -> usize {
        order.borrow().iter().filter(|entry| *entry == name).count()
    }

    #[test]
    fn stage_order_is_declared_as_data_and_matches_the_run() {
        assert_eq!(
            stage_order_for_review(),
            [
                ("quest-consequences", "once"),
                ("combat-continuation", "loop"),
                ("encounter-completion", "once"),
                ("hero-hooks", "once"),
                ("director-trigger", "loop"),
                ("visible-projection", "once"),
                ("narration", "once"),
            ]
        );
        let order = Rc::new(RefCell::new(Vec::new()));
        let mut coordinator = PostCommitCoordinator::new(tracking_deps(&order));
        let state = state_in_combat(1, 0, "enc-1");
        let events = [json!({ "event_id": "e1", "event_type": "QuestResolved" })];
        coordinator.run(input("ORDER", &state, &events, "commit-1"));
        assert_eq!(*order.borrow(), ["quest-consequences", "combat-continuation", "visible-projection", "narration"]);
    }

    #[test]
    fn once_stage_does_not_repeat_for_the_same_source() {
        let order = Rc::new(RefCell::new(Vec::new()));
        let mut coordinator = PostCommitCoordinator::new(tracking_deps(&order));
        let state = json!({ "mechanics": { "encounter": { "id": "enc-7", "status": "ended" }, "combat": { "active": false } } });
        let events = [json!({ "event_id": "e2", "event_type": "EncounterRewardsDistributed" })];
        coordinator.run(input("ONCE", &state, &events, "commit-2"));
        assert_eq!(count(&order, "encounter-completion"), 1);
        coordinator.run(input("ONCE", &state, &events, "commit-2"));
        assert_eq!(count(&order, "encounter-completion"), 1, "завершение встречи не повторяется");
    }

    #[test]
    fn loop_stage_is_not_skipped_by_process_memory() {
        let order = Rc::new(RefCell::new(Vec::new()));
        let mut coordinator = PostCommitCoordinator::new(tracking_deps(&order));
        let events = [json!({ "event_id": "e3", "event_type": "TurnStarted" })];
        for (round, index) in [(1, 0), (1, 0), (1, 1), (2, 0)] {
            let state = state_in_combat(round, index, "enc-1");
            coordinator.run(input("LOOP", &state, &events, ""));
        }
        assert_eq!(count(&order, "combat-continuation"), 4);
    }

    #[test]
    fn position_keys_follow_js() {
        assert_eq!(combat_position_key(&state_in_combat(1, 0, "enc-1")).as_deref(), Some("combat:enc-1:r1:i0:hero"));
        assert_eq!(combat_position_key(&state_in_combat(1, 1, "enc-1")).as_deref(), Some("combat:enc-1:r1:i1:wolf"));
        assert_eq!(combat_position_key(&json!({ "mechanics": { "combat": { "active": false } } })), None);
        let key = |objective: &str| director_position_key(&json!({ "campaignConcept": { "current_arc_number": 2 }, "adventure": { "chapter": 3, "objective": objective } }));
        assert_eq!(key("Найти переправу"), key("Найти переправу"));
        assert_ne!(key("Найти переправу"), key("Перейти реку"));
    }

    #[test]
    fn failed_stage_repeats_and_finished_ones_do_not() {
        let order = Rc::new(RefCell::new(Vec::new()));
        let mut deps = tracking_deps(&order);
        let failures = Rc::new(RefCell::new(0));
        let (projection_order, projection_failures) = (Rc::clone(&order), Rc::clone(&failures));
        deps.persist_projection = Some(Box::new(move |_: &StageContext| {
            projection_order.borrow_mut().push("visible-projection".into());
            let mut failures = projection_failures.borrow_mut();
            *failures += 1;
            if *failures == 1 {
                Err("проекция не сохранилась".into())
            } else {
                Ok(None)
            }
        }));
        let errors = Rc::new(RefCell::new(Vec::<String>::new()));
        let seen = Rc::clone(&errors);
        let mut coordinator = PostCommitCoordinator::new(deps).with_on_error(move |_, stage| seen.borrow_mut().push(stage.into()));
        let state = json!({ "mechanics": { "encounter": { "id": "enc-9", "status": "active" }, "combat": { "active": false } } });
        let events = [json!({ "event_id": "e4", "event_type": "QuestResolved" })];
        let first = coordinator.run(input("RETRY", &state, &events, "commit-4"));
        assert_eq!(first.failed, ["visible-projection"]);
        assert_eq!(*errors.borrow(), ["visible-projection"]);
        assert!(first.ran.iter().any(|name| name == "narration"));
        let second = coordinator.run(input("RETRY", &state, &events, "commit-4"));
        assert_eq!(second.ran, ["visible-projection"]);
        assert_eq!(count(&order, "quest-consequences"), 1);
    }

    #[test]
    fn coordinator_without_events_only_projects() {
        let mut coordinator = PostCommitCoordinator::new(PostCommitDeps::default());
        let state = json!({});
        let result = coordinator.run(input("EMPTY", &state, &[], ""));
        assert_eq!(result.ran, ["visible-projection"]);
        assert!(result.skipped.iter().any(|name| name == "narration"));
    }

    #[test]
    fn route_may_hand_over_a_subset_and_get_results_back() {
        let order = Rc::new(RefCell::new(Vec::new()));
        let mut coordinator = PostCommitCoordinator::new(tracking_deps(&order));
        let state = json!({ "mechanics": { "encounter": { "id": "enc-11", "status": "ended" }, "combat": { "active": false } } });
        let events = [json!({ "event_id": "e5", "event_type": "EncounterRewardsDistributed" })];
        let subset = ["encounter-completion"];
        let run = coordinator.run(RunInput { stages: Some(&subset), ..input("SUBSET", &state, &events, "commit-5") });
        assert_eq!(run.ran, ["encounter-completion"]);
        assert_eq!(*order.borrow(), ["encounter-completion"]);

        let deps = PostCommitDeps {
            complete_encounter: Some(Box::new(|_: &StageContext| Ok(Some(json!({ "reward": { "xp": 120 }, "events": [{ "event_type": "ExperienceAwarded" }] }))))),
            ..PostCommitDeps::default()
        };
        let mut coordinator = PostCommitCoordinator::new(deps);
        let state = json!({ "mechanics": { "encounter": { "id": "enc-12", "status": "ended" }, "combat": { "active": false } } });
        let run = coordinator.run(RunInput { stages: Some(&subset), ..input("RESULT", &state, &[], "") });
        assert_eq!(run.results["encounter-completion"].as_ref().map(|value| value["reward"]["xp"].clone()), Some(json!(120)));
    }

    #[test]
    fn truce_stops_combat_continuation() {
        let stage = STAGES.iter().find(|stage| stage.name == "combat-continuation").expect("стадия продолжения боя");
        let deps = PostCommitDeps::default();
        let fighting = json!({ "mechanics": { "combat": { "active": true } } });
        assert!((stage.applies)(&StageContext::for_state(&fighting), &deps));
        let truced = json!({ "mechanics": { "combat": { "active": true, "truce": { "leader_id": "enemy-leader" } } } });
        assert!(!(stage.applies)(&StageContext::for_state(&truced), &deps));
    }

    #[test]
    fn hero_hooks_wait_for_heroes_outside_combat() {
        let deps = PostCommitDeps { heroes_needing_hooks: Some(Box::new(|_, _| vec![json!("b"), json!("a")])), ..PostCommitDeps::default() };
        let stage = STAGES.iter().find(|stage| stage.name == "hero-hooks").expect("стадия зацепок");
        let calm = json!({});
        assert!((stage.applies)(&StageContext::for_state(&calm), &deps));
        assert_eq!((stage.key)(&StageContext::for_state(&calm), &deps).as_deref(), Some("hero-hooks:a,b"));
        let fighting = json!({ "mechanics": { "combat": { "active": true } } });
        assert!(!(stage.applies)(&StageContext::for_state(&fighting), &deps));
    }
}

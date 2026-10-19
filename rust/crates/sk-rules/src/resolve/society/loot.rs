//! Ветки `resolveCommandInternal`: Обыск контейнера добычи. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 21634–21645. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use serde_json::Value;
use sk_director::loot_containers::loot_container_command_events;

use super::super::Resolve;
use super::with_field;
use crate::core::{event_from, spread_value};
use crate::pause::{Fault, Halt, Step};

/// `LootContainer` (21634–21645): итог проверки, уже лежащий в команде, —
/// в события.
pub fn loot_container(r: &mut Resolve<'_>) -> Step {
    let drafts = loot_container_command_events(&r.command).map_err(|error| {
        let fault = Fault::new(error.name, error.message);
        Halt::Fault(match error.code {
            Some(code) => fault.with_code(code),
            None => fault,
        })
    })?;
    for draft in drafts {
        // `{ ...command, visibility: draft.visibility }`: `undefined` — умолчание `public`.
        let mut source = spread_value(Some(&r.command));
        match draft.get("visibility") {
            Some(visibility) => {
                source.insert("visibility".into(), visibility.clone());
            }
            None => {
                source.shift_remove("visibility");
            }
        }
        let event_type = sk_core::js::s(draft.get("event_type"));
        let event = event_from(&Value::Object(source), &event_type, draft.get("payload").cloned(), draft.get("target_ids"));
        let event = match draft.get("event_schema_version") {
            Some(version) => with_field(event, "event_schema_version", version.clone()),
            None => event,
        };
        r.events.push(event);
    }
    Ok(())
}

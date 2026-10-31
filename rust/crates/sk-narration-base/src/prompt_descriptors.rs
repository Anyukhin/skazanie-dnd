//! Перенос `server/prompt-descriptors.mjs`: реестр промптов рядом с
//! **реальными** загрузчиками (шаг 8 `docs/agent-architecture-plan.md`).
//!
//! Список ролей объявлен один раз и сверяется с двумя источниками правды: с
//! тем, что модули действительно читают с диска (путь `../prompts/<семья>/<id>.txt`
//! ищется в исходниках), и с тем, что лежит в `prompts/`. В JS каталоги
//! вычисляются от `import.meta.url`; здесь — от корня репозитория, известного
//! при сборке ([`repository_root`]), либо передаются явно (`*_in`).

use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sk_core::indexmap::IndexMap;
use sk_core::re;

/// Роль с загружаемым промптом. `module` — файл, который читает его с диска;
/// `prompt_id` — версия, которая попадает в трассу.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PromptDescriptor {
    pub role: &'static str,
    #[serde(rename = "promptId")]
    pub prompt_id: &'static str,
    pub module: &'static str,
    pub loads: bool,
}

const fn descriptor(role: &'static str, prompt_id: &'static str, module: &'static str) -> PromptDescriptor {
    PromptDescriptor { role, prompt_id, module, loads: true }
}

/// `PROMPT_DESCRIPTORS`. Режиссёр — единственная роль с вариантами: промпт
/// выбирается режимом импровизации кампании, поэтому один модуль объявляет два
/// дескриптора.
pub const PROMPT_DESCRIPTORS: &[PromptDescriptor] = &[
    descriptor("npc_morale", "npc_controller/v1", "npc-controller.mjs"),
    descriptor("npc_social", "npc_controller/social_v8", "npc-social-controller.mjs"),
    descriptor("narrator", "narrator/v14", "narrator.mjs"),
    descriptor("director_story", "director/v4_story", "director-agent.mjs"),
    descriptor("director_chaos", "director/v4_chaos", "director-agent.mjs"),
    descriptor("action_adjudicator", "action_adjudicator/v10", "action-adjudicator.mjs"),
    descriptor("campaign_creator", "campaign_creator/v8", "campaign-bootstrap.mjs"),
    descriptor("scene_architect", "map_architect/v8", "scene-architect.mjs"),
    descriptor("recap", "recap/v1", "campaign-recap.mjs"),
    descriptor("hero_hooks", "hero_hooks/v1", "hero-hooks.mjs"),
    descriptor("lore_keeper", "lore_keeper/v1", "lore-voice.mjs"),
];

/// Корень репозитория (где лежат `server/` и `prompts/`), известный при сборке.
/// Сверка привязок промптов читает исходники `server/*.mjs` — дерево сборки,
/// а не корень данных процесса.
pub fn repository_root() -> PathBuf {
    sk_core::data_root::build_root()
}

/// `loadedPromptIds()`: что модули `server/*.mjs` **на самом деле** читают —
/// модуль → все `prompt_id` в порядке первого упоминания.
pub fn loaded_prompt_ids() -> io::Result<IndexMap<String, Vec<String>>> {
    loaded_prompt_ids_in(&repository_root().join("server"), ".mjs")
}

/// То же для произвольного каталога исходников и расширения. Порядок модулей —
/// по имени файла (в JS — порядок `readdirSync`, у ОС он не задан).
pub fn loaded_prompt_ids_in(directory: &Path, extension: &str) -> io::Result<IndexMap<String, Vec<String>>> {
    let mut names: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if name.ends_with(extension) {
            names.push(name);
        }
    }
    names.sort();
    let pattern = re!(r"\.\.\/prompts\/([A-Za-z0-9_]+)\/([A-Za-z0-9_.-]+)\.txt", "g");
    let mut found: IndexMap<String, Vec<String>> = IndexMap::new();
    for name in names {
        let source = std::fs::read_to_string(directory.join(&name))?;
        for captures in pattern.captures_iter(&source).filter_map(Result::ok) {
            let part = |index: usize| captures.get(index).map_or("", |m| m.as_str());
            let prompt_id = format!("{}/{}", part(1), part(2));
            let ids = found.entry(name.clone()).or_default();
            if !ids.contains(&prompt_id) {
                ids.push(prompt_id);
            }
        }
    }
    Ok(found)
}

/// `availablePromptIds()`: все `prompt_id` в `prompts/`, по возрастанию.
/// Старые версии остаются на диске намеренно — для чтения исторических трасс.
pub fn available_prompt_ids() -> io::Result<Vec<String>> {
    available_prompt_ids_in(&repository_root().join("prompts"))
}

/// То же для произвольного корня промптов.
pub fn available_prompt_ids_in(root: &Path) -> io::Result<Vec<String>> {
    let mut ids = Vec::new();
    for family in std::fs::read_dir(root)? {
        let family = family?;
        if !std::fs::metadata(family.path())?.is_dir() {
            continue;
        }
        let family_name = family.file_name().to_string_lossy().into_owned();
        for file in std::fs::read_dir(family.path())? {
            let file = file?.file_name().to_string_lossy().into_owned();
            if let Some(stem) = file.strip_suffix(".txt") {
                ids.push(format!("{family_name}/{stem}"));
            }
        }
    }
    ids.sort_by(|left, right| crate::jsx::utf16_cmp(left, right));
    Ok(ids)
}

/// `descriptorForPromptId(promptId)`.
pub fn descriptor_for_prompt_id(prompt_id: &str) -> Option<&'static PromptDescriptor> {
    PROMPT_DESCRIPTORS.iter().find(|descriptor| descriptor.prompt_id == prompt_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet, HashSet};

    #[test]
    fn registry_matches_what_modules_really_read() {
        let loaded = loaded_prompt_ids().expect("исходники сервера");
        let mut by_module: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for descriptor in PROMPT_DESCRIPTORS {
            by_module.entry(descriptor.module).or_default().push(descriptor.prompt_id);
        }
        for ids in by_module.values_mut() {
            ids.sort_unstable();
        }
        for (module, prompt_ids) in &loaded {
            let declared = by_module.get(module.as_str());
            assert!(declared.is_some(), "{module} читает {}, но его нет в реестре — роль появилась мимо PROMPT_DESCRIPTORS", prompt_ids.join(", "));
            let mut read: Vec<&str> = prompt_ids.iter().map(String::as_str).collect();
            read.sort_unstable();
            assert_eq!(Some(&read), declared, "{module}: реестр и модуль расходятся");
        }
        for descriptor in PROMPT_DESCRIPTORS.iter().filter(|descriptor| descriptor.loads) {
            assert!(loaded.contains_key(descriptor.module), "{} объявлен загрузчиком {}, но ничего не читает", descriptor.module, descriptor.prompt_id);
        }
    }

    #[test]
    fn every_registered_prompt_exists_on_disk() {
        let available: HashSet<String> = available_prompt_ids().expect("prompts/").into_iter().collect();
        for descriptor in PROMPT_DESCRIPTORS {
            assert!(available.contains(descriptor.prompt_id), "{} объявлен в реестре, но файла нет", descriptor.prompt_id);
        }
    }

    #[test]
    fn historical_versions_stay_on_disk_and_are_not_active() {
        let available = available_prompt_ids().expect("prompts/");
        let registered: HashSet<&str> = PROMPT_DESCRIPTORS.iter().map(|descriptor| descriptor.prompt_id).collect();
        let historical: Vec<&String> = available.iter().filter(|id| !registered.contains(id.as_str())).collect();
        assert!(!historical.is_empty(), "исторические версии нужны для чтения сохранённых трасс");
        for id in historical {
            assert!(descriptor_for_prompt_id(id).is_none(), "{id} не должен считаться активным");
        }
        let mut sorted = available.clone();
        sorted.sort();
        assert_eq!(sorted, available, "список отсортирован");
    }

    #[test]
    fn director_has_a_prompt_per_improv_mode() {
        let mut director: Vec<&str> = PROMPT_DESCRIPTORS.iter().filter(|descriptor| descriptor.prompt_id.starts_with("director/")).map(|descriptor| descriptor.prompt_id).collect();
        director.sort_unstable();
        assert_eq!(director, ["director/v4_chaos", "director/v4_story"]);
        for descriptor in PROMPT_DESCRIPTORS.iter().filter(|descriptor| descriptor.prompt_id.starts_with("director/")) {
            assert_eq!(descriptor.module, "director-agent.mjs", "оба варианта грузит один модуль");
        }
        assert!(descriptor_for_prompt_id("director/v1").is_none());
    }

    #[test]
    fn roles_and_prompts_are_unique() {
        let roles: BTreeSet<&str> = PROMPT_DESCRIPTORS.iter().map(|descriptor| descriptor.role).collect();
        assert_eq!(roles.len(), PROMPT_DESCRIPTORS.len(), "роль объявлена дважды");
        let prompts: BTreeSet<&str> = PROMPT_DESCRIPTORS.iter().map(|descriptor| descriptor.prompt_id).collect();
        assert_eq!(prompts.len(), PROMPT_DESCRIPTORS.len(), "общий промпт должен быть решением, а не совпадением");
        let architect = PROMPT_DESCRIPTORS.iter().find(|descriptor| descriptor.prompt_id.starts_with("map_architect/"));
        assert_eq!(architect.map(|descriptor| descriptor.role), Some("scene_architect"));
        let json = serde_json::to_value(PROMPT_DESCRIPTORS[0]).expect("json");
        assert_eq!(json, serde_json::json!({ "role": "npc_morale", "promptId": "npc_controller/v1", "module": "npc-controller.mjs", "loads": true }));
    }
}

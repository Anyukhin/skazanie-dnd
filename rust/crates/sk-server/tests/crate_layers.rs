//! Урок 7, «агенты — отдельный слой» (план переноса, §1 п.7): сценарий,
//! сюжет, Режиссёр без модели и правила — детерминированное ядро; роли модели
//! (`sk-agents`, `sk-agents-base`) — слой поверх него. Тест строит граф
//! зависимостей крейтов workspace по их `Cargo.toml` (обычные и
//! build-зависимости, в том числе `[target.…]`; dev-зависимости тестов в
//! рантайм не попадают и не считаются) — без cargo и сети — и требует, чтобы
//! ни один крейт вне слоя агентов не зависел от них ни прямо, ни транзитивно.
//!
//! Известное исключение записано явно и не чинится молча: если крейт из
//! списка перестал зависеть от агентов, тест просит убрать его из списка.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// Крейты ролей модели.
const AGENT_CRATES: [&str; 2] = ["sk-agents", "sk-agents-base"];

/// Слой поверх агентов: сами агенты и то, что собирает ядро с моделью вместе
/// (оркестраторы `/api/narrate` и автономного Режиссёра, HTTP-сервер).
const AGENT_LAYER: [&str; 4] = ["sk-agents", "sk-agents-base", "sk-orchestrator", "sk-server"];

/// Детерминированное ядро, названное в уроке: сценарий, сюжет и политика
/// кампании (Режиссёр без модели — `sk-story::campaign_loop_policy`), слой
/// мест Режиссёра, правила, ходы NPC.
const NAMED_CORE: [&str; 6] = ["sk-scenario", "sk-story", "sk-director", "sk-rules", "sk-turns", "sk-tactics"];

/// Крейты ядра, которые **сейчас** зависят от агентов, и почему.
const KNOWN_EXCEPTIONS: [(&str, &str); 1] = [(
    "sk-turns",
    "npc_turn_scheduler берёт из sk_agents::npc_controller детерминированные is_morale_moment и \
     commands_for_morale_decision и реализует свой NpcController для NpcMoraleAgent \
     (в JS npc-turn-scheduler.mjs импортирует npc-controller.mjs); вынести их в ядро — отдельная задача",
)];

/// Имя пакета и его `sk-*`-зависимости из текста `Cargo.toml`.
fn parse_manifest(text: &str) -> (String, BTreeSet<String>) {
    let mut name = String::new();
    let mut deps = BTreeSet::new();
    let mut section = String::new();
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.starts_with('[') {
            section = line.trim_matches(|ch| ch == '[' || ch == ']').to_string();
            // `[dependencies.sk-x]` — зависимость подтаблицей.
            for kind in ["dependencies.", "build-dependencies."] {
                if let Some(dep) = section.strip_prefix(kind).or_else(|| section.split_once(&format!(".{kind}")).map(|(_, dep)| dep)) {
                    if dep.starts_with("sk-") {
                        deps.insert(dep.to_string());
                    }
                }
            }
            continue;
        }
        let key: String = line.chars().take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_').collect();
        if key.is_empty() {
            continue;
        }
        if section == "package" && key == "name" {
            name = line.split('"').nth(1).unwrap_or("").to_string();
        }
        let dependency_section = section == "dependencies" || section == "build-dependencies" || section.ends_with(".dependencies") || section.ends_with(".build-dependencies");
        if dependency_section && key.starts_with("sk-") {
            assert!(!line.contains("package"), "переименованная зависимость в {name}: {line} — разбор её не поддерживает");
            deps.insert(key);
        }
    }
    (name, deps)
}

fn workspace_graph() -> BTreeMap<String, BTreeSet<String>> {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut graph = BTreeMap::new();
    for entry in std::fs::read_dir(&crates).expect("каталог crates") {
        let manifest = entry.expect("запись каталога").path().join("Cargo.toml");
        if let Ok(text) = std::fs::read_to_string(&manifest) {
            let (name, deps) = parse_manifest(&text);
            assert!(!name.is_empty(), "нет имени пакета в {}", manifest.display());
            graph.insert(name, deps);
        }
    }
    graph
}

/// Транзитивные зависимости крейта.
fn closure(graph: &BTreeMap<String, BTreeSet<String>>, start: &str) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    let mut stack = vec![start.to_string()];
    while let Some(name) = stack.pop() {
        for dep in graph.get(&name).into_iter().flatten() {
            if seen.insert(dep.clone()) {
                stack.push(dep.clone());
            }
        }
    }
    seen
}

#[test]
fn manifest_parser_reads_workspace_and_subtable_forms() {
    let (name, deps) = parse_manifest(
        "[package]\nname = \"sk-x\"\n\n[dependencies]\nserde.workspace = true\nsk-core.workspace = true\nsk-y = { path = \"../sk-y\" } # sk-z\n\n[target.'cfg(unix)'.dependencies]\nsk-u = { path = \"../sk-u\" }\n\n[dependencies.sk-w]\npath = \"../sk-w\"\n\n[dev-dependencies]\nsk-agents = { path = \"../sk-agents\" }\n",
    );
    assert_eq!(name, "sk-x");
    assert_eq!(deps.into_iter().collect::<Vec<_>>(), ["sk-core", "sk-u", "sk-w", "sk-y"]);
}

#[test]
fn deterministic_core_does_not_depend_on_agents() {
    let graph = workspace_graph();
    assert!(graph.len() > 40, "крейтов workspace: {}", graph.len());
    for (name, deps) in &graph {
        for dep in deps {
            assert!(graph.contains_key(dep), "{name} зависит от {dep}, которого нет в workspace: разбор Cargo.toml ошибся");
        }
    }
    for name in NAMED_CORE.iter().chain(AGENT_CRATES.iter()) {
        assert!(graph.contains_key(*name), "крейта {name} нет в workspace");
    }
    let mut offenders = Vec::new();
    for name in graph.keys().filter(|name| !AGENT_LAYER.contains(&name.as_str())) {
        let reach = closure(&graph, name);
        let agents: Vec<&str> = AGENT_CRATES.iter().copied().filter(|agent| reach.contains(*agent)).collect();
        let excepted = KNOWN_EXCEPTIONS.iter().any(|(crate_name, _)| *crate_name == name.as_str());
        match (agents.is_empty(), excepted) {
            (false, false) => {
                let direct: Vec<&String> = graph[name].iter().filter(|dep| closure(&graph, dep).iter().chain(std::iter::once(*dep)).any(|item| AGENT_CRATES.contains(&item.as_str()))).collect();
                offenders.push(format!("{name} → {} (через {direct:?})", agents.join(", ")));
            }
            (true, true) => offenders.push(format!("{name} больше не зависит от агентов — уберите его из KNOWN_EXCEPTIONS")),
            _ => {}
        }
    }
    assert!(offenders.is_empty(), "детерминированное ядро зависит от слоя агентов:\n{}", offenders.join("\n"));
    // Исключения — только среди ядра, а не слоя агентов, и названы с причиной.
    for (name, why) in KNOWN_EXCEPTIONS {
        assert!(!AGENT_LAYER.contains(&name) && !why.is_empty(), "{name}");
    }
}

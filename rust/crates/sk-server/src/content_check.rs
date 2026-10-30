//! Каталоги контента проверяются при старте (урок 7 плана переноса, §1 п.7):
//! `skazanie-server` до приёма запросов принудительно грузит и проверяет все
//! каталоги `data/`, которые читает сервер; ошибка данных — отказ старта с
//! именем файла и записи и кодом 1, а не паника посреди первого запроса,
//! который тронул каталог. Та же проверка — подкоманда
//! `skazanie-server check-content` (0 — чисто, 1 — ошибки).
//!
//! Проверку каталога держит его крейт (`check_…`, разбор — функцией от строки
//! для тестов на сломанных копиях, `sk_core::content`); здесь — только список
//! и прогон. Каталоги грузятся параллельно, каждый в своём потоке: это те же
//! `LazyLock`, которые иначе разобрал бы первый запрос, поэтому с исправными
//! данными поведение то же, а время разбора уходит со старта, а не с хода.
//!
//! Каталоги `sk-combat-content` и `sk-items` (урок 8 разбирает их механику
//! при загрузке) здесь только грузятся их собственными функциями: их паника
//! на битых данных перехватывается и становится отказом с именем файла.
//! Опись каталогов — `docs/rust-content-catalogs.md`.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use serde_json::json;
use sk_core::content::{ContentError, ContentResult};

/// Каталог для общей проверки: подпись, файлы от корня репозитория и проверка.
#[derive(Clone, Copy)]
pub struct Catalog {
    pub name: &'static str,
    pub files: &'static [&'static str],
    pub check: fn() -> ContentResult<()>,
}

/// Итог проверки одного каталога.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub name: &'static str,
    pub files: &'static [&'static str],
    pub elapsed: Duration,
    pub result: ContentResult<()>,
}

/// Действия классов: `combat_class_catalog_info` разбирает каталог (урок 8).
fn class_actions() -> ContentResult<()> {
    sk_combat_content::combat_actions::combat_class_catalog_info();
    Ok(())
}

/// Заклинания и правки механики: `spell_catalog_info` разбирает оба файла и
/// собирает карточки (урок 8).
fn spells() -> ContentResult<()> {
    sk_combat_content::combat_spells::spell_catalog_info(None);
    Ok(())
}

/// Формы дикого облика: каждый зверь списка есть в бестиарии 2014.
fn wild_shape() -> ContentResult<()> {
    LazyLock::force(&sk_combat_content::wild_shape::WILD_SHAPE_FORMS);
    Ok(())
}

/// Каталог предметов `sk-items` (собран из таблиц кода, урок 8).
fn item_catalog() -> ContentResult<()> {
    LazyLock::force(&sk_items::item_catalog::ITEM_CATALOG);
    Ok(())
}

/// Пакеты правил установленных редакций из `data/rule_packs` корня данных
/// процесса — та же загрузка (`load_rule_pack` каждой редакции), что у
/// `RuleCatalog::load` при открытии состояния; отказ называет пакет.
fn rule_packs() -> ContentResult<()> {
    let root = crate::routes::catalog::rule_packs_root();
    for ruleset_id in sk_ruleset::ruleset_config::INSTALLED_RULESET_IDS {
        sk_rulepack::rule_pack::load_rule_pack(ruleset_id, &root).map_err(|error| ContentError::at("data/rule_packs", ruleset_id, error.message))?;
    }
    Ok(())
}

/// Все каталоги, которые читает сервер.
pub fn catalogs() -> Vec<Catalog> {
    use sk_ruleset::{backgrounds, character_creation_catalog, character_progression};
    vec![
        Catalog { name: "сценарии", files: &[sk_scenario::campaign_scenario::SCENARIO_CATALOG_FILE], check: sk_scenario::campaign_scenario::check_scenario_catalog },
        Catalog { name: "диалоги", files: &[sk_story::campaign_dialogues::DIALOGUES_FILE], check: sk_story::campaign_dialogues::check_dialogue_catalog },
        Catalog { name: "карты мест", files: &[sk_map_core::authored_location_maps::AUTHORED_LOCATION_MAP_CATALOG_FILE], check: sk_map_core::authored_location_maps::check_authored_location_map_catalog },
        Catalog { name: "миры", files: &[sk_world_time::world_template_catalog::WORLD_TEMPLATE_CATALOG_FILE], check: sk_world_time::world_template_catalog::check_world_template_catalog },
        Catalog { name: "предыстории", files: &[backgrounds::CURRENT_CATALOG_FILE, backgrounds::CLASSIC_CATALOG_FILE], check: backgrounds::check_background_catalogs },
        Catalog { name: "происхождение", files: &[character_creation_catalog::CURRENT_POLICY_FILE, character_creation_catalog::CLASSIC_POLICY_FILE], check: character_creation_catalog::check_creation_policies },
        Catalog { name: "развитие классов", files: &[character_progression::CATALOG_FILE, character_progression::MANIFEST_FILE], check: character_progression::check_character_rules },
        Catalog { name: "стартовое снаряжение", files: &[sk_chargen::starter_kit::STARTER_EQUIPMENT_FILE, sk_chargen::starter_kit::STARTER_PRESENTATION_FILE], check: sk_chargen::starter_kit::check_starter_catalogs },
        Catalog { name: "таблицы движка", files: &[sk_rules::tables::CONDITION_EFFECTS_FILE, sk_rules::tables::ITEM_CATALOG_FILE], check: sk_rules::tables::check_tables },
        Catalog {
            name: "ассеты",
            files: &[sk_scene_base::asset_registry::ASSET_RIGHTS_CATALOG_FILE, sk_scene_base::asset_registry::PROP_ATLAS_CATALOG_FILE, sk_scene_base::asset_registry::DETAIL_ATLAS_CATALOG_FILE],
            check: sk_scene_base::asset_registry::check_asset_catalogs,
        },
        Catalog { name: "TaleSpire", files: &[sk_talespire::talespire_import::TALESPIRE_ASSET_TABLE_FILE], check: sk_talespire::talespire_import::check_talespire_asset_table },
        Catalog { name: "справочник 2014", files: &[sk_combat_base::dndsu_2014_content::DEFAULT_CONTENT_DIRECTORY], check: sk_combat_base::dndsu_2014_content::check_dndsu_2014_content },
        Catalog { name: "действия классов", files: &["data/dndsu-class-actions-1-12.json"], check: class_actions },
        Catalog { name: "заклинания", files: &["data/dndsu-spells-0-6.json", "data/dndsu-spell-mechanics-overrides.json"], check: spells },
        Catalog { name: "дикий облик", files: &["data/compendia/dnd_5e_2014/monsters.json"], check: wild_shape },
        Catalog { name: "предметы", files: &["sk-items: каталог в коде"], check: item_catalog },
        Catalog { name: "пакеты правил", files: &["data/rule_packs"], check: rule_packs },
    ]
}

/// Текст паники: `panic!("…")` даёт `&str` или `String`.
fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    payload.downcast_ref::<&str>().map(|text| text.to_string()).or_else(|| payload.downcast_ref::<String>().cloned()).unwrap_or_else(|| "паника без текста".into())
}

fn run_one(catalog: Catalog) -> Outcome {
    let started = Instant::now();
    let result = catch_unwind(AssertUnwindSafe(catalog.check)).unwrap_or_else(|payload| {
        let file = catalog.files.first().copied().unwrap_or(catalog.name);
        Err(ContentError::new(file, format!("паника при загрузке: {}", panic_text(payload.as_ref()))))
    });
    Outcome { name: catalog.name, files: catalog.files, elapsed: started.elapsed(), result }
}

/// Прогнать проверки, каждую в своём потоке; итоги — в порядке списка.
pub fn run_checks(catalogs: &[Catalog]) -> Vec<Outcome> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = catalogs.iter().map(|catalog| (*catalog, scope.spawn(move || run_one(*catalog)))).collect();
        handles
            .into_iter()
            .map(|(catalog, handle)| {
                handle.join().unwrap_or_else(|payload| Outcome {
                    name: catalog.name,
                    files: catalog.files,
                    elapsed: Duration::ZERO,
                    result: Err(ContentError::new(catalog.files.first().copied().unwrap_or(catalog.name), format!("паника при загрузке: {}", panic_text(payload.as_ref())))),
                })
            })
            .collect()
    })
}

/// Все проверки сервера.
pub fn check_all() -> Vec<Outcome> {
    run_checks(&catalogs())
}

/// Отказы прогона.
pub fn failures(outcomes: &[Outcome]) -> Vec<&ContentError> {
    outcomes.iter().filter_map(|outcome| outcome.result.as_ref().err()).collect()
}

/// Проверка при старте сервера (`main.rs`, один вызов до отметки писателя
/// storage и приёма запросов): `Err` — текст отказа со всеми ошибками.
pub fn verify_before_listen() -> Result<(), String> {
    let outcomes = check_all();
    let errors = failures(&outcomes);
    if errors.is_empty() {
        return Ok(());
    }
    let lines: Vec<String> = errors.iter().map(|error| format!("  {error}")).collect();
    Err(format!("Каталоги контента не прошли проверку ({}):\n{}", errors.len(), lines.join("\n")))
}

/// Справка подкоманды.
pub const HELP: &str = "\
skazanie-server check-content — проверить каталоги контента (data/), которые
читает сервер, тем же путём, что и при старте.

Использование:
  skazanie-server check-content [--data-dir <каталог>] [--json]

  --data-dir   корень данных (data/, public/); по умолчанию DND_DATA_DIR,
               каталог бинаря или корень репозитория сборки (.env не читается)
  --json       итог одной строкой JSON

Код выхода: 0 — каталоги чисты, 1 — ошибки, 2 — неверные аргументы.
";

/// Подкоманда `check-content`.
pub fn run(args: &[String]) -> i32 {
    let mut data_dir: Option<PathBuf> = None;
    let mut as_json = false;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                print!("{HELP}");
                return 0;
            }
            "--json" => as_json = true,
            "--data-dir" => match rest.next() {
                Some(dir) if !dir.is_empty() => data_dir = Some(PathBuf::from(dir)),
                _ => {
                    eprintln!("check-content: --data-dir требует каталог\n\n{HELP}");
                    return crate::cli::USAGE_EXIT;
                }
            },
            other => {
                eprintln!("check-content: неизвестный аргумент «{other}»\n\n{HELP}");
                return crate::cli::USAGE_EXIT;
            }
        }
    }
    let root = match data_dir {
        Some(path) => {
            let cwd = std::env::current_dir().unwrap_or_default();
            let path = if path.is_absolute() { path } else { cwd.join(path) };
            sk_core::data_root::DataRoot { path, source: sk_core::data_root::Source::Env }
        }
        None => sk_core::data_root::resolve(),
    };
    let root = match sk_core::data_root::init(root) {
        Ok(root) | Err(root) => root,
    };
    let started = Instant::now();
    let outcomes = check_all();
    let elapsed = started.elapsed();
    let errors = failures(&outcomes);
    if as_json {
        let catalogs: Vec<_> = outcomes
            .iter()
            .map(|outcome| json!({ "name": outcome.name, "files": outcome.files, "ms": outcome.elapsed.as_millis() as u64, "error": outcome.result.as_ref().err().map(ToString::to_string) }))
            .collect();
        println!("{}", json!({ "ok": errors.is_empty(), "data_root": root.path.display().to_string(), "ms": elapsed.as_millis() as u64, "catalogs": catalogs }));
    } else {
        println!("Корень данных: {} ({})", root.path.display(), root.source.label());
        for outcome in &outcomes {
            match &outcome.result {
                Ok(()) => println!("  ок      {:>5} мс  {}", outcome.elapsed.as_millis(), outcome.files.join(", ")),
                Err(error) => println!("  ОШИБКА  {:>5} мс  {error}", outcome.elapsed.as_millis()),
            }
        }
        if errors.is_empty() {
            println!("Каталоги контента: {} проверок, ошибок нет ({} мс)", outcomes.len(), elapsed.as_millis());
        } else {
            eprintln!("Каталоги контента: {} проверок, ошибок {} ({} мс)", outcomes.len(), errors.len(), elapsed.as_millis());
        }
    }
    if errors.is_empty() {
        0
    } else {
        1
    }
}

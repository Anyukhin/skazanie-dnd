//! Бюджет скорости ядра правил (волна скорости, Ск1): нормализация крупного
//! и медианного состояния и цепочка событий редьюсера.
//!
//! Два сторожа:
//! - **выделения памяти** — счётчик на потоке теста, одинаковый на любой
//!   машине и в любом профиле сборки. Порог строгий везде: рост числа
//!   выделений и есть регресс (лишняя копия `Value`, повторная нормализация);
//! - **время** — медиана повторов, только в оптимизированной сборке
//!   (`cargo test --release`). Локально порог строгий, на общем раннере
//!   (`CI` / `GITHUB_ACTIONS`) — вчетверо мягче: шум соседей по машине не
//!   регресс, грубое замедление в разы — регресс. Тот же уклад, что у
//!   `test/tactical-map-budget.test.mjs`.
//!
//! Пороги сняты на Ryzen 7 9800X3D (Windows, release) с запасом; при
//! осознанном изменении стоимости их правят вместе с замером в коммите.
//! Эталон — `fixtures/perf-budget.json.gz` (`fixtures/gen-perf-budget.mjs`).

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::io::Read;
use std::sync::LazyLock;
use std::time::Instant;

use serde_json::Value;
use sk_rules::normalize::{normalize_campaign_state, normalize_campaign_state_cow, without_fixed_point_memory};
use sk_rules::replay::apply_game_event;

thread_local! {
    static ALLOCATIONS: Cell<u64> = const { Cell::new(0) };
}

/// Системный распределитель со счётчиком выделений текущего потока: тесты
/// крейта идут параллельно, чужие потоки в счёт не попадают.
struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let _ = ALLOCATIONS.try_with(|count| count.set(count.get() + 1));
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let _ = ALLOCATIONS.try_with(|count| count.set(count.get() + 1));
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/perf-budget.json.gz")).expect("эталон читается");
    let mut text = String::new();
    flate2::read::GzDecoder::new(&bytes[..]).read_to_string(&mut text).expect("эталон распаковывается");
    serde_json::from_str(&text).expect("эталон")
});

fn allocations() -> u64 {
    ALLOCATIONS.with(Cell::get)
}

fn shared_runner() -> bool {
    ["CI", "GITHUB_ACTIONS"].iter().any(|name| std::env::var(name).is_ok_and(|value| value == "true"))
}

/// Медиана времени `operation` (мс) и число выделений одного прогона.
fn measure(repeats: usize, mut operation: impl FnMut()) -> (f64, u64) {
    operation();
    let before = allocations();
    operation();
    let allocated = allocations() - before;
    let mut times: Vec<f64> = (0..repeats)
        .map(|_| {
            let start = Instant::now();
            operation();
            start.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    times.sort_by(f64::total_cmp);
    (times[times.len() / 2], allocated)
}

/// Проверка обоих сторожей; `budget_ms` — строгий порог времени, `max_allocations`
/// — порог выделений одного прогона. Нарушение — строка в `failures`.
fn check_budget(failures: &mut Vec<String>, label: &str, (median_ms, allocated): (f64, u64), budget_ms: f64, max_allocations: u64) {
    println!("{label}: {median_ms:.2} мс (порог {budget_ms} мс), выделений {allocated} (порог {max_allocations})");
    if allocated > max_allocations {
        failures.push(format!("{label}: {allocated} выделений памяти — больше порога {max_allocations}"));
    }
    if cfg!(debug_assertions) {
        return;
    }
    if shared_runner() {
        if median_ms > budget_ms {
            println!("  [ci] {label} {median_ms:.2} мс выше строгого порога {budget_ms} мс — проверить локально");
        }
        if median_ms > budget_ms * 4.0 {
            failures.push(format!("{label}: {median_ms:.2} мс — больше 4× порога {budget_ms} мс; шумом раннера не объясняется"));
        }
    } else if median_ms > budget_ms {
        failures.push(format!("{label}: {median_ms:.2} мс, порог — {budget_ms} мс"));
    }
}

/// Один тест на все замеры: они идут друг за другом, а не параллельно, и
/// время одного не делит процессор с другим.
#[test]
fn rules_core_within_budget() {
    let mut failures = Vec::new();
    for (key, repeats, budget_ms, max_allocations) in
        [("large", 7, BUDGET_LARGE_MS, ALLOCATIONS_LARGE), ("caster", 15, BUDGET_CASTER_MS, ALLOCATIONS_CASTER), ("plain", 15, BUDGET_PLAIN_MS, ALLOCATIONS_PLAIN)]
    {
        let state = &FIXTURE[key];
        // Настоящая нормализация: память итогов (Ск3) на повторах отдала бы
        // готовое.
        let measured = without_fixed_point_memory(|| measure(repeats, || drop(normalize_campaign_state(state).expect("нормализация"))));
        check_budget(&mut failures, &format!("normalizeCampaignState({key})"), measured, budget_ms, max_allocations);
    }
    // Ск3: повторная нормализация уже нормализованного состояния — сверка с
    // памятью итогов и копия, без прохода нормализации.
    let normalized = normalize_campaign_state(&FIXTURE["large"]).expect("нормализация");
    let measured = measure(7, || drop(normalize_campaign_state(&normalized).expect("нормализация")));
    check_budget(&mut failures, "normalizeCampaignState(normalizeCampaignState(large))", measured, BUDGET_KNOWN_MS, ALLOCATIONS_KNOWN);
    let measured = measure(7, || drop(normalize_campaign_state_cow(&normalized).expect("нормализация")));
    check_budget(&mut failures, "normalizeCampaignState(normalized large), без копии", measured, BUDGET_KNOWN_COW_MS, ALLOCATIONS_KNOWN_COW);
    let replay = &FIXTURE["replay"];
    let events = replay["events"].as_array().expect("события");
    let measured = without_fixed_point_memory(|| {
        measure(7, || {
            let mut state = normalize_campaign_state(&replay["state"]).expect("нормализация");
            for event in events {
                state = apply_game_event(&state, event).expect("событие");
            }
        })
    });
    check_budget(&mut failures, &format!("normalize + applyGameEvent × {}", events.len()), measured, BUDGET_REPLAY_MS, ALLOCATIONS_REPLAY);
    assert!(failures.is_empty(), "бюджет скорости ядра правил нарушен:\n{}", failures.join("\n"));
}

// Пороги (см. шапку). Выделения — замер 2026-10-24 плюс 10 %, время — замер
// (release, Windows, фоновая сборка) примерно с полуторным запасом.
// Замер: крупное 77 мс / 622 157 выделений, заклинатель 3,8 мс / 56 025,
// медианное 0,5 мс / 7 802, цепочка из 13 событий 11,3 мс / 149 632.
const BUDGET_LARGE_MS: f64 = 110.0;
const ALLOCATIONS_LARGE: u64 = 685_000;
const BUDGET_CASTER_MS: f64 = 6.0;
const ALLOCATIONS_CASTER: u64 = 61_600;
const BUDGET_PLAIN_MS: f64 = 1.0;
const ALLOCATIONS_PLAIN: u64 = 8_600;
const BUDGET_REPLAY_MS: f64 = 17.0;
// Ск3, память итогов нормализации: уже нормализованное крупное — сверка и
// копия (замер 41 мс / 473 696 выделений — копия), без копии — 5 мс и ни
// одного выделения.
const BUDGET_KNOWN_MS: f64 = 62.0;
const ALLOCATIONS_KNOWN: u64 = 521_000;
const BUDGET_KNOWN_COW_MS: f64 = 8.0;
const ALLOCATIONS_KNOWN_COW: u64 = 0;
const ALLOCATIONS_REPLAY: u64 = 165_000;

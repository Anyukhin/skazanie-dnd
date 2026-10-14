//! Общие помощники интеграционных тестов `sk-infra`.
#![allow(dead_code)] // Каждый тестовый файл берёт свою часть помощников.

use std::sync::{Arc, Mutex};

use sk_dice::{D20Request, Dice, DiceError, DiceService, Roll, SequenceRng, Visibility};

/// Сервис костей, который переживает «перезапуск» реестра: в JS один и тот же
/// `DiceService` передаётся новому `RollRegistry`.
#[derive(Clone)]
pub struct SharedDice(pub Arc<Mutex<DiceService<SequenceRng>>>);

impl SharedDice {
    /// Последовательность костей, id `prefix-1`, `prefix-2`… и неподвижное время, как
    /// `new DiceService({ rng: new SequenceDiceRng(values), idFactory, now })` в тестах JS.
    pub fn new(values: Vec<i64>, prefix: &str) -> Self {
        let prefix = prefix.to_string();
        let mut counter = 0u64;
        let service = DiceService::new(
            SequenceRng::new(values),
            Box::new(move || {
                counter += 1;
                format!("{prefix}-{counter}")
            }),
            Box::new(|| "2026-01-01T00:00:00.000Z".to_string()),
        );
        Self(Arc::new(Mutex::new(service)))
    }

    /// Неизменный id для каждого броска, как `idFactory: () => 'roll-1'`.
    pub fn fixed_id(values: Vec<i64>, id: &str) -> Self {
        let id = id.to_string();
        let service = DiceService::new(SequenceRng::new(values), Box::new(move || id.clone()), Box::new(|| "2026-01-01T00:00:00.000Z".to_string()));
        Self(Arc::new(Mutex::new(service)))
    }

    pub fn boxed(&self) -> Box<dyn Dice + Send> {
        Box::new(self.clone())
    }
}

impl Dice for SharedDice {
    fn roll(&mut self, expression: &str, purpose: &str, actor_id: Option<&str>, visibility: Visibility) -> Result<Roll, DiceError> {
        self.0.lock().expect("кости").roll(expression, purpose, actor_id, visibility)
    }

    fn roll_d20(&mut self, request: &D20Request) -> Result<Roll, DiceError> {
        self.0.lock().expect("кости").roll_d20(request)
    }

    fn roll_check(&mut self, request: &D20Request, difficulty: i64) -> Result<Roll, DiceError> {
        self.0.lock().expect("кости").roll_check(request, difficulty)
    }
}

/// Путь к файлу эталонов крейта.
pub fn fixture_path(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures").join(name)
}

/// Node для эталонов JS: `SK_NODE` или установка Codex. `None` — проверка
/// против JS пропускается.
pub fn node_binary() -> Option<std::path::PathBuf> {
    if let Ok(path) = std::env::var("SK_NODE") {
        let path = std::path::PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let path = std::path::Path::new(&local).join("OpenAI/Codex/bin/5b9024f90663758b/node.exe");
    path.exists().then_some(path)
}

/// Равенство JSON с числами по значению: эталон JS пишет `14285714285714287000`,
/// а Rust держит то же число как f64 — `serde_json` считает их разными.
pub fn same_json(left: &serde_json::Value, right: &serde_json::Value) -> bool {
    use serde_json::Value;
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(x, y)| same_json(x, y)),
        (Value::Object(a), Value::Object(b)) => a.len() == b.len() && a.iter().all(|(key, x)| b.get(key).is_some_and(|y| same_json(x, y))),
        _ => left == right,
    }
}

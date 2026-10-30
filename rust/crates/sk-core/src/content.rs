//! Каталоги контента (`data/*.json`): ошибка загрузки с файлом и записью и
//! помощники проверки формы (урок 7 плана переноса, §1 п.7).
//!
//! Каталоги встроены в сборку (`include_str!`) и разбираются один раз.
//! Модуль-владелец каталога держит в `LazyLock` **результат** разбора
//! (`Result<_, ContentError>`), отдаёт его проверку функцией `check_…` и
//! разбор — функцией от строки, чтобы тесты проверяли сломанные копии, не
//! трогая `data/`. Сервер зовёт все проверки до приёма запросов
//! (`sk_server::content_check`): ошибка данных — отказ старта с именем файла
//! и записи, а не паника посреди первого запроса, который тронул каталог.
//!
//! Проверяется форма, на которую полагается код: версия схемы, ключевые поля
//! записей (по ним каталог ищут), их уникальность и поля, без которых код
//! молча теряет запись или падает. Опись каталогов — `docs/rust-content-catalogs.md`.

use std::collections::HashSet;
use std::fmt;

use serde_json::{Map, Value};

/// Отказ каталога: файл от корня репозитория, запись внутри файла (индекс,
/// id или путь; `None` — файл целиком) и что не так.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentError {
    pub file: String,
    pub entry: Option<String>,
    pub message: String,
}

impl ContentError {
    /// Отказ файла целиком (или сообщение, которое уже называет запись).
    pub fn new(file: &str, message: impl Into<String>) -> Self {
        Self { file: file.to_string(), entry: None, message: message.into() }
    }

    /// Отказ записи.
    pub fn at(file: &str, entry: impl Into<String>, message: impl Into<String>) -> Self {
        Self { file: file.to_string(), entry: Some(entry.into()), message: message.into() }
    }
}

impl fmt::Display for ContentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.entry {
            Some(entry) => write!(f, "{}: {entry}: {}", self.file, self.message),
            None => write!(f, "{}: {}", self.file, self.message),
        }
    }
}

impl std::error::Error for ContentError {}

/// Результат проверки каталога.
pub type ContentResult<T> = Result<T, ContentError>;

/// Разбор встроенного JSON: ошибка называет строку и столбец.
pub fn parse_json(file: &str, text: &str) -> ContentResult<Value> {
    serde_json::from_str(text).map_err(|error| ContentError::new(file, format!("не JSON: {error}")))
}

/// Подпись записи для сообщений: `list[index]` и, если есть, её имя.
pub fn record_label(list: &str, index: usize, record: &Value) -> String {
    let name = ["id", "name", "name_ru", "title", "label"].iter().find_map(|key| record.get(*key).and_then(Value::as_str).filter(|text| !text.is_empty()));
    match name {
        Some(name) => format!("{list}[{index}] «{name}»"),
        None => format!("{list}[{index}]"),
    }
}

/// Корень-объект или отказ.
pub fn root_object<'a>(file: &str, root: &'a Value) -> ContentResult<&'a Map<String, Value>> {
    root.as_object().ok_or_else(|| ContentError::new(file, "корень должен быть объектом"))
}

/// Поле версии схемы равно ожидаемому числу.
pub fn schema_version(file: &str, root: &Value, key: &str, expected: f64) -> ContentResult<()> {
    if root.get(key).and_then(Value::as_f64) == Some(expected) {
        Ok(())
    } else {
        Err(ContentError::new(file, format!("{key} должен быть {expected}, а не {}", root.get(key).map_or("(нет)".to_string(), Value::to_string))))
    }
}

/// Строковое поле корня равно ожидаемому значению.
pub fn root_str(file: &str, root: &Value, key: &str, expected: &str) -> ContentResult<()> {
    if root.get(key).and_then(Value::as_str) == Some(expected) {
        Ok(())
    } else {
        Err(ContentError::new(file, format!("{key} должен быть «{expected}»")))
    }
}

/// Поле-массив корня.
pub fn array_field<'a>(file: &str, root: &'a Value, key: &str) -> ContentResult<&'a [Value]> {
    root.get(key).and_then(Value::as_array).map(Vec::as_slice).ok_or_else(|| ContentError::new(file, format!("{key} должен быть массивом")))
}

/// Поле-объект корня.
pub fn object_field<'a>(file: &str, root: &'a Value, key: &str) -> ContentResult<&'a Map<String, Value>> {
    root.get(key).and_then(Value::as_object).ok_or_else(|| ContentError::new(file, format!("{key} должен быть объектом")))
}

/// Непустая строка поля `key` записи; `entry` — подпись записи.
pub fn required_str<'a>(file: &str, record: &'a Value, key: &str, entry: &str) -> ContentResult<&'a str> {
    match record.get(key) {
        Some(Value::String(text)) if !text.trim().is_empty() => Ok(text),
        Some(_) => Err(ContentError::at(file, entry, format!("поле «{key}» должно быть непустой строкой"))),
        None => Err(ContentError::at(file, entry, format!("нет поля «{key}»"))),
    }
}

/// Записи массива `list` корня с ключом `key`: каждая — объект с непустой
/// строкой ключа, ключи не повторяются. Порядок — как в файле.
pub fn keyed_records<'a>(file: &str, root: &'a Value, list: &str, key: &str) -> ContentResult<Vec<(&'a str, &'a Value)>> {
    keyed_items(file, array_field(file, root, list)?, list, key)
}

/// То же для готового среза записей (`path` — подпись списка в сообщениях).
pub fn keyed_items<'a>(file: &str, items: &'a [Value], path: &str, key: &str) -> ContentResult<Vec<(&'a str, &'a Value)>> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut records = Vec::with_capacity(items.len());
    for (index, record) in items.iter().enumerate() {
        let entry = record_label(path, index, record);
        if !record.is_object() {
            return Err(ContentError::at(file, entry, "запись должна быть объектом"));
        }
        let id = required_str(file, record, key, &entry)?;
        if !seen.insert(id) {
            return Err(ContentError::at(file, entry, format!("{key} «{id}» повторяется")));
        }
        records.push((id, record));
    }
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn errors_name_file_and_record() {
        let root = json!({ "items": [{ "id": "a", "name": "Альфа" }, { "idd": "b", "name": "Бета" }] });
        let error = keyed_records("data/x.json", &root, "items", "id").err();
        assert_eq!(error.map(|error| error.to_string()), Some("data/x.json: items[1] «Бета»: нет поля «id»".to_string()));
        let twice = json!({ "items": [{ "id": "a" }, { "id": "a" }] });
        assert_eq!(keyed_records("f", &twice, "items", "id").err().map(|error| error.to_string()), Some("f: items[1] «a»: id «a» повторяется".to_string()));
        assert!(parse_json("f", "{").err().is_some_and(|error| error.to_string().starts_with("f: не JSON: EOF")));
        assert_eq!(schema_version("f", &json!({ "v": 2 }), "v", 1.0).err().map(|error| error.to_string()), Some("f: v должен быть 1, а не 2".to_string()));
    }
}

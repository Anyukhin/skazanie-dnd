//! Темы сцены «Сказания» — перенос седьмой волны:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/scene-themes.mjs` | [`scene_themes`] (подмодули — каталог и опознание, граф зон, пещера, открытая местность, сборка сцены) |
//!
//! Этап паритета (`rust/PORTING.md`): тот же сид даёт ту же карту — байт в
//! байт строки `JSON.stringify(serializeTacticalMap(map))`. Вход сборки —
//! объект JS (`options`) рыхлым JSON, как у `buildThemedScene`; темы — те же
//! объекты, что в JS ([`scene_themes::SceneTheme::json`]).

// Таблицы тем записаны литералами `json!` в форме объектов JS; длинные
// объекты потолков (`caps`) глубже рекурсии макроса по умолчанию.
#![recursion_limit = "512"]

pub mod scene_themes;

//! Пакеты правил «Сказания» — перенос `server/rule-pack.mjs` и
//! `server/rule-retriever.mjs`.
//!
//! Пакет читается из каталога `data/rule_packs/<ruleset_id>/` во время работы,
//! как в JS; корень каталога — параметр. Пакет — JSON той же формы, что
//! объект `loadRulePack` (`manifest`, `glossary`, `rules`, `ontologyEdges`,
//! `coverage`, `sourceRegistry`, `summary`), поэтому проверка и поиск
//! принимают и вручную собранные пакеты, как тесты JS.

mod jsv;
pub mod rule_pack;
pub mod rule_retriever;

pub use rule_pack::RulePackValidationError;
pub use rule_retriever::{RetrieverError, RuleRetriever};

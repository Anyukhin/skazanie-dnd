//! Инфраструктура сервера «Сказания» — перенос служебных модулей `server/`:
//!
//! - [`roll_registry`] — `roll-registry.mjs`: карточки проверок и выданные
//!   кости, срок действия, защита от повторного применения броска;
//! - [`usage_ledger`] — `usage-ledger.mjs`: резерв и учёт расхода вызовов
//!   модели, дневная квота, обёртка клиента модели;
//! - [`narration_stream`] — `narration-stream.mjs`: живой поток рассказа и
//!   ограниченная очередь кадров SSE-соединения;
//! - [`backup_service`] — `backup-service.mjs`: зашифрованные копии хранилища
//!   и отметка пишущего сервера;
//! - [`image_generation`] — `image-generation.mjs`: проверка байтов картинки и
//!   единственный путь к картиночной модели;
//! - [`asset_preparation`] — `asset-preparation.mjs`: подготовка картинок до игры.
//!
//! Правила переноса — `rust/PORTING.md`.

pub mod asset_preparation;
pub mod backup_service;
pub mod image_generation;
pub mod local_image;
pub mod narration_stream;
pub mod roll_registry;
pub mod usage_ledger;

mod support;

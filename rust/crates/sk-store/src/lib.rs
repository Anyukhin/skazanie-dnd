//! Хранилище «Сказания»: журнал событий кампаний на SQLite.
//!
//! Перенос `server/event-store.mjs` и `server/map-store.mjs` с той же
//! семантикой коммитов, идемпотентности, снимков и отказа восстановления, но
//! без второго хранилища «комнаты» и без каталога файлов на кампанию (урок §1.3
//! плана: 17,5 МБ файла комнаты переписывались на каждом коммите).

pub mod error;
pub mod legacy;
pub mod maps;
pub mod stable;
pub mod store;

pub use error::{StoreError, StoreResult};
pub use legacy::{import_file_store, ImportReport, ImportedCampaign};
pub use maps::{MapCells, NoMapCells};
pub use store::{
    CommitRequest, CommitResult, EventStore, InitializeRequest, LegacyImportRequest, LoadOptions, Loaded, PendingProjection, Reducer, RetentionMode, StoreOptions,
    VersionOnlyReducer, STORE_SCHEMA_VERSION,
};

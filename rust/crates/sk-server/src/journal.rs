//! Летопись комнаты — **заглушка С0**, реализация — С1
//! (`server/index.mjs:2074–2252`: id сообщений, `journalEntry`,
//! `appendRoomJournal` с тремя попытками и пределом 400 записей).

use serde_json::Value;

use crate::core::GameCore;
use crate::error::Failure;
use crate::room::Room;

/// Предел летописи комнаты (`index.mjs:2236–2252`).
pub const ROOM_JOURNAL_LIMIT: usize = 400;

/// `appendRoomJournal(campaignId, entries)`: дописать записи (форма —
/// `journalEntry(...)`, 2208–2234) и вернуть обновлённую комнату.
pub fn append_room_journal(_core: &GameCore, campaign_id: &str, _entries: Vec<Value>) -> Result<Room, Failure> {
    Err(Failure::new(format!("Летопись комнаты {campaign_id} ещё не перенесена (С1)"), Some("NOT_PORTED")))
}

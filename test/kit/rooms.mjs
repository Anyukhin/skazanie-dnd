// Комната кампании и сверка хранилища глазами теста — без знания, как сервер
// их хранит.
//
// Комната Rust — проекция журнала плюс накладка в SQLite (`rust/AGENTS.md` §2).
// Тест, которому нужно увидеть записанную комнату мимо HTTP или испортить её
// «снаружи» (дрейф при той же версии, SEC-02), зовёт подкоманды бинаря (только
// с фичей `test-hooks`, `rust/crates/sk-server/src/test_hooks/room_cli.rs`):
//
// * `readRoom`     — записанная комната `{ version, state, updatedAt }` или `null`;
// * `writeRoom`    — записать состояние комнаты мимо сервера (дрейф проекции);
// * `auditStorage` — аудит целостности хранилища (`skazanie-server audit-storage`):
//   журнал против replay, подтверждение проекции, комната против журнала.
//
//   skazanie-server room  --storage <dir> --campaign <код>            → { version, state, updatedAt } | null
//   skazanie-server room  --storage <dir> --campaign <код> --write    (JSON { "state": … } на stdin)
//   skazanie-server audit --storage <dir>                             → отчёт аудита
//
// Прежний режим `js` (файл `<storage>/rooms/<КОД>.json`) ушёл в архив вместе с JS-сервером.
import { runRustTool } from './http.mjs'

/**
 * @typedef {object} StoredRoom
 * @property {number} version `room.version`
 * @property {any} state записанное состояние комнаты
 * @property {string | null} updatedAt
 */

/** @typedef {{ storageDir: string }} RoomTarget */

/**
 * Записанная комната кампании — то, что сервер отдаст следующему чтению до
 * сверки. Читается и при живом сервере.
 *
 * @param {RoomTarget} server объект из startTestServer
 * @param {string} campaignCode
 * @returns {Promise<StoredRoom | null>} `null` — комнаты нет
 */
export async function readRoom(server, campaignCode) {
  return runRustTool(['room', '--storage', server.storageDir, '--campaign', campaignCode], { storageDir: server.storageDir })
}

/**
 * Записать состояние комнаты мимо сервера — так, как его испортили бы сбой
 * или внешняя правка: журнал и подтверждение проекции не трогаются. Сервер
 * увидит записанное на ближайшем чтении. Версию комнаты (`room.version`) Rust
 * ведёт счётчиком накладки — тест сравнивает результат `readRoom`, а не числа.
 *
 * @param {RoomTarget} server
 * @param {string} campaignCode
 * @param {any} state полное состояние комнаты
 * @returns {Promise<StoredRoom>} записанная комната
 */
export async function writeRoom(server, campaignCode, state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('writeRoom: состояние комнаты — объект')
  return runRustTool(['room', '--storage', server.storageDir, '--campaign', campaignCode, '--write'], {
    storageDir: server.storageDir, input: { state },
  })
}

/**
 * Аудит целостности хранилища: `blockers` пуст — журнал каждой кампании
 * сходится со своим replay, проекция подтверждена, а записанная комната
 * совпадает с журналом (`PROJECTION_DIVERGENCE`, `PROJECTION_VERSION_DIVERGENCE`,
 * `ROOM_PROJECTION_MISSING`). Лучше при остановленном сервере.
 *
 * @param {RoomTarget} server объект из startTestServer (или `{ storageDir }`)
 * @returns {Promise<{ ready: boolean, campaign_count: number, campaigns: any[], blockers: any[], warnings: any[] }>}
 */
export async function auditStorage(server) {
  return runRustTool(['audit', '--storage', server.storageDir], { storageDir: server.storageDir })
}

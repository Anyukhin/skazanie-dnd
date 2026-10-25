// Комната кампании и сверка хранилища глазами теста — без знания, как сервер
// их хранит.
//
// Комната JS — файл `<storage>/rooms/<КОД>.json` с полным состоянием; комната
// Rust — проекция журнала плюс накладка в SQLite (решение ведущего №2,
// `rust/SERVER-PLAN.md`). Тест, которому нужно увидеть записанную комнату мимо
// HTTP или испортить её «снаружи» (дрейф при той же версии, SEC-02), раньше
// открывал файл сам и против Rust не работал. Здесь три операции с одинаковым
// смыслом в обоих режимах:
//
// * `readRoom`     — записанная комната `{ version, state, updatedAt }` или `null`;
// * `writeRoom`    — записать состояние комнаты мимо сервера (дрейф проекции);
// * `auditStorage` — аудит целостности хранилища (`pnpm cutover:audit`):
//   журнал против replay, подтверждение проекции, комната против журнала.
//
// Режим `rust` зовёт подкоманды бинаря (только с фичей `test-hooks`):
//
//   skazanie-server room  --storage <dir> --campaign <код>            → { version, state, updatedAt } | null
//   skazanie-server room  --storage <dir> --campaign <код> --write    (JSON { "state": … } на stdin)
//   skazanie-server audit --storage <dir>                             → отчёт аудита
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { runRustTool } from './http.mjs'

/**
 * @typedef {object} StoredRoom
 * @property {number} version `room.version`
 * @property {any} state записанное состояние комнаты
 * @property {string | null} updatedAt
 */

/** @typedef {{ impl: 'js' | 'rust', storageDir: string }} RoomTarget */

/** Код комнаты так, как его нормализует хранилище (`roomFile` в `server/store.mjs`). */
function roomKey(/** @type {string} */ code) {
  const key = String(code || '').toUpperCase().replace(/[^A-Z0-9-]/gu, '').slice(0, 24)
  if (!key) throw new Error('Некорректный код комнаты')
  return key
}

/** @param {string} storageDir @param {string} code */
const roomFile = (storageDir, code) => join(storageDir, 'rooms', `${roomKey(code)}.json`)

/**
 * Записанная комната кампании — то, что сервер отдаст следующему чтению до
 * сверки. Читается и при живом сервере.
 *
 * @param {RoomTarget} server объект из startTestServer
 * @param {string} campaignCode
 * @returns {Promise<StoredRoom | null>} `null` — комнаты нет
 */
export async function readRoom(server, campaignCode) {
  if (server.impl === 'rust') {
    return runRustTool(['room', '--storage', server.storageDir, '--campaign', campaignCode], { storageDir: server.storageDir })
  }
  const file = roomFile(server.storageDir, campaignCode)
  if (!existsSync(file)) return null
  const room = JSON.parse(readFileSync(file, 'utf8'))
  return { version: Number(room.version), state: room.state ?? null, updatedAt: room.updatedAt ?? null }
}

/**
 * Записать состояние комнаты мимо сервера — так, как его испортили бы сбой
 * или внешняя правка: журнал и подтверждение проекции не трогаются. Сервер
 * увидит записанное на ближайшем чтении. Версия комнаты (`room.version`) после
 * записи не гарантируется: JS сохраняет прежнюю, Rust ведёт её счётчиком
 * накладки — тест сравнивает результат `readRoom`, а не числа.
 *
 * @param {RoomTarget} server
 * @param {string} campaignCode
 * @param {any} state полное состояние комнаты
 * @returns {Promise<StoredRoom>} записанная комната
 */
export async function writeRoom(server, campaignCode, state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('writeRoom: состояние комнаты — объект')
  if (server.impl === 'rust') {
    return runRustTool(['room', '--storage', server.storageDir, '--campaign', campaignCode, '--write'], {
      storageDir: server.storageDir, input: { state },
    })
  }
  const file = roomFile(server.storageDir, campaignCode)
  if (!existsSync(file)) throw new Error(`writeRoom: нет комнаты ${roomKey(campaignCode)}`)
  const room = JSON.parse(readFileSync(file, 'utf8'))
  room.state = state
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(room, null, 2), 'utf8')
  renameSync(temporary, file)
  return { version: Number(room.version), state: room.state, updatedAt: room.updatedAt ?? null }
}

/**
 * Аудит целостности хранилища, как `pnpm cutover:audit`: `blockers` пуст —
 * журнал каждой кампании сходится со своим replay, проекция подтверждена, а
 * записанная комната совпадает с журналом (`PROJECTION_DIVERGENCE`,
 * `PROJECTION_VERSION_DIVERGENCE`, `ROOM_PROJECTION_MISSING`). Лучше при
 * остановленном сервере.
 *
 * @param {RoomTarget} server объект из startTestServer (или `{ impl, storageDir }`)
 * @returns {Promise<{ ready: boolean, campaign_count: number, campaigns: any[], blockers: any[], warnings: any[] }>}
 */
export async function auditStorage(server) {
  if (server.impl === 'rust') return runRustTool(['audit', '--storage', server.storageDir], { storageDir: server.storageDir })
  const { auditLegacyCutover } = await import('../../server/cutover-audit.mjs')
  return auditLegacyCutover({ storageRoot: server.storageDir })
}

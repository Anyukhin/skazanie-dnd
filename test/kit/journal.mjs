// Журнал кампании глазами теста — без знания, как сервер его хранит.
//
// HTTP-тест не открывает базу сервера сам: три операции идут подкомандой
// бинаря Rust (`--features test-hooks`, `rust/crates/sk-server/src/test_hooks/journal_cli.rs`):
//
// * `readJournal`    — прочитать голову, коммиты и события;
// * `corruptCampaign`— потерять хвост журнала или seed-снимок (сервер остановлен);
// * `appendJournal`  — дописать коммит мимо сервера («сбой между событием и проекцией»).
//
//   skazanie-server journal --storage <dir> --campaign <код> [--at-version N] [--no-snapshots]
//   skazanie-server journal --storage <dir> --campaign <код> --corrupt tail|seed
//   skazanie-server journal --storage <dir> --campaign <код> --append   (JSON коммита на stdin)
//
// Подкоманда печатает в stdout ровно тот JSON, который возвращают функции ниже.
// Прежний режим `js` (файловый журнал JS-сервера) ушёл в архив вместе с сервером.
import { runRustTool } from './http.mjs'

/**
 * @typedef {object} JournalCommit
 * @property {string} idempotency_key
 * @property {string} command_id
 * @property {number} state_version_before
 * @property {number} state_version_after
 * @property {any[]} events
 */

/**
 * @typedef {object} Journal
 * @property {string} campaign_id
 * @property {number} state_version версия прочитанного состояния (`atVersion` или голова)
 * @property {number} current_state_version голова журнала
 * @property {any} state
 * @property {JournalCommit[]} commits все коммиты по порядку
 * @property {any[]} events все события по порядку (плоско)
 * @property {{ checkpoint_version: number, state_version: number } | null} pending_projection
 *   проекция отстаёт от журнала (сбой между commit и подтверждением) или `null`
 * @property {{ version: number, hash: string | null }} projection_checkpoint
 *   отметка подтверждённой проекции: до какой версии и с каким `projectionHash` комнаты
 */

/** @typedef {{ storageDir: string, running?: () => boolean }} JournalTarget */

/**
 * Прочитать журнал кампании. Сырые коммиты читаются без проверки хвоста:
 * тест видит то, что записано, даже если сервер такую кампанию уже не откроет.
 * Состояние же загружается штатно — повреждённая кампания здесь бросает ту же
 * ошибку, что у сервера.
 *
 * @param {JournalTarget} server объект из startTestServer
 * @param {string} campaignCode
 * @param {{ atVersion?: number, useSnapshots?: boolean }} [options]
 *   `useSnapshots: false` — состояние повтором всех событий с нуля
 * @returns {Promise<Journal>}
 */
export async function readJournal(server, campaignCode, { atVersion, useSnapshots = true } = {}) {
  return runRustTool([
    'journal', '--storage', server.storageDir, '--campaign', campaignCode,
    ...(atVersion === undefined ? [] : ['--at-version', String(atVersion)]),
    ...(useSnapshots ? [] : ['--no-snapshots']),
  ], { storageDir: server.storageDir })
}

/** Причина отказа сервера после порчи — код `CampaignRecoveryRequiredError`. */
export const CORRUPTION_REASONS = Object.freeze({ tail: 'EVENT_LOG_TAIL_MISSING', seed: 'SEED_SNAPSHOT_MISSING' })

/**
 * Испортить кампанию так, как её портят неполная копия или сбой диска:
 * `tail` — потерять последний коммит журнала; `seed` — потерять seed-снимок v0.
 * Только при остановленном сервере: порча под живым процессом — другой сценарий.
 *
 * @param {JournalTarget} server
 * @param {string} campaignCode
 * @param {'tail' | 'seed'} mode
 * @returns {Promise<'EVENT_LOG_TAIL_MISSING' | 'SEED_SNAPSHOT_MISSING'>} причина, которую должен назвать сервер
 */
export async function corruptCampaign(server, campaignCode, mode) {
  if (!(mode in CORRUPTION_REASONS)) throw new Error(`corruptCampaign: режим tail или seed, получен ${mode}`)
  if (server.running?.()) throw new Error('corruptCampaign: сначала server.stop() — кампанию портят при остановленном сервере')
  await runRustTool(['journal', '--storage', server.storageDir, '--campaign', campaignCode, '--corrupt', mode], { storageDir: server.storageDir })
  return CORRUPTION_REASONS[/** @type {'tail' | 'seed'} */ (mode)]
}

/**
 * Дописать коммит в журнал мимо сервера: проекция комнаты о нём не знает.
 * Так тест воспроизводит сбой «событие записано, проекция — нет» или ставит
 * ход NPC без координатора. Надёжнее при остановленном сервере.
 *
 * @param {JournalTarget} server
 * @param {string} campaignCode
 * @param {{ idempotency_key: string, command_id?: string, events: any[], expected_state_version?: number }} commit
 *   `expected_state_version` по умолчанию — текущая голова
 * @returns {Promise<{ state_version: number, state: any, events: any[], duplicate: boolean }>}
 */
export async function appendJournal(server, campaignCode, commit) {
  return runRustTool(['journal', '--storage', server.storageDir, '--campaign', campaignCode, '--append'], {
    storageDir: server.storageDir, input: commit,
  })
}

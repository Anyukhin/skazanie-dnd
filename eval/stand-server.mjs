/**
 * Сервер для стендов `eval/`: бинарь Rust (`--impl rust`, по умолчанию).
 *
 * Прежний режим `js` (`server/index.mjs`) с 2026-11-27 в архиве
 * (`archive/js-server/`) и отвергается. `rust` — бинарь тем же
 * путём, что у HTTP-набора тестов (`test/kit/http.mjs`): путь из
 * `SKAZANIE_RUST_SERVER_BIN`, окружение `isolatedServerEnv` (пустой
 * `ROUTERAI_API_KEY`, `NODE_ENV=test`, 127.0.0.1), свой временный каталог и
 * свободный порт. Сид костей стенда (`PLAYTEST_DICE_SEED`) бинарь читает сам,
 * если собран с фичей `test-hooks` (`rust/crates/sk-server/src/test_hooks.rs`:
 * тот же mulberry32, что у `eval/playtest-seeded-dice.mjs`).
 */
import { spawn } from 'node:child_process'

import { REPO_ROOT, isolatedServerEnv, rustServerBinary } from '../test/kit/http.mjs'
import { readJournal } from '../test/kit/journal.mjs'
import { auditStorage } from '../test/kit/rooms.mjs'
import { freePort } from '../test/free-port.mjs'

export const STAND_IMPLS = Object.freeze(['rust'])

/**
 * `--impl rust` из аргументов; без флага — тоже `rust`.
 *
 * @param {string[]} argv
 * @returns {'rust'}
 */
export function standImpl(argv) {
  const index = argv.indexOf('--impl')
  const impl = index >= 0 ? argv[index + 1] : 'rust'
  if (!STAND_IMPLS.includes(impl)) throw new Error(`--impl ${impl ?? ''}: допустим только rust — JS-сервер в архиве (archive/js-server)`)
  rustServerBinary()
  return /** @type {'rust'} */ (impl)
}

export { freePort }

/**
 * Поднять бинарь Rust на хранилище стенда. Ключ модели допускается для loopback.
 *
 * @param {{ port: number, storage: string, setupToken: string, env?: Record<string, string | undefined> }} options
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnRustStand({ port, storage, setupToken, env = {} }) {
  return spawn(rustServerBinary(), [], {
    cwd: REPO_ROOT,
    env: isolatedServerEnv({ port, storageDir: storage, setupToken, env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * События кампании из журнала Rust (SQLite) — подкомандой `journal` бинаря,
 * как `readJournal` набора. Читается и при живом сервере.
 *
 * @param {string} storage
 * @param {string} campaign
 * @returns {Promise<any[]>}
 */
export async function rustJournalEvents(storage, campaign) {
  return (await readJournal({ impl: 'rust', storageDir: storage }, campaign)).events
}

/**
 * Проверить реплей и проекцию тестовой кампании штатным аудитом Rust.
 *
 * @param {string} storage
 * @param {string} campaign
 */
export async function rustCutoverAudit(storage, campaign) {
  try {
    const report = await auditStorage({ storageDir: storage })
    const entry = report.campaigns.find((row) => row.campaign_id === campaign)
    const ready = report.ready && entry?.replay_matched === true
      && entry.projection_matched === true && entry.pending_projection === false
    return { status: ready ? 0 : 1, ready, report, output: JSON.stringify(report, null, 2) }
  } catch (error) {
    return { status: 1, ready: false, report: null, output: String(error?.message ?? error) }
  }
}

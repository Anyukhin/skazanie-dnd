/**
 * Выбор реализации сервера для стендов `eval/` (`--impl js|rust`).
 *
 * `js` — прежний путь каждого стенда (`server/index.mjs` дочерним процессом),
 * его стенд запускает сам, без изменений. `rust` — бинарь переноса тем же
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
import { freePort } from '../test/free-port.mjs'

export const STAND_IMPLS = Object.freeze(['js', 'rust'])

/**
 * `--impl js|rust` из аргументов; без флага — `js`.
 *
 * @param {string[]} argv
 * @returns {'js' | 'rust'}
 */
export function standImpl(argv) {
  const index = argv.indexOf('--impl')
  const impl = index >= 0 ? argv[index + 1] : 'js'
  if (!STAND_IMPLS.includes(impl)) throw new Error(`--impl ${impl ?? ''}: допустимы ${STAND_IMPLS.join(', ')}`)
  if (impl === 'rust') rustServerBinary()
  return /** @type {'js' | 'rust'} */ (impl)
}

export { freePort }

/**
 * Поднять бинарь Rust на хранилище стенда. Ключ модели всегда пуст.
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

/** Первое расхождение двух значений: путь и короткие значения — для отчёта. */
function firstDifference(left, right, path = '') {
  if (Object.is(left, right)) return null
  const bothObjects = left && right && typeof left === 'object' && typeof right === 'object'
  if (!bothObjects || Array.isArray(left) !== Array.isArray(right)) {
    return { path: path || '(корень)', js: JSON.stringify(left)?.slice(0, 200), rust: JSON.stringify(right)?.slice(0, 200) }
  }
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
  for (const key of keys) {
    const found = firstDifference(left[key], right[key], `${path}${Array.isArray(left) ? `[${key}]` : `.${key}`}`)
    if (found) return found
  }
  return null
}

/**
 * Замена `tools/audit-cutover.mjs` для хранилища Rust (SQLite он не читает).
 *
 * Сверяет, как и JS-аудит, загрузку журнала со снимками и полный replay без
 * них (подкомандой `journal` бинаря), и вдобавок — **перекрёстный replay**:
 * тот же журнал Rust, переигранный JS-редьюсером (`FileEventStore` во
 * временном каталоге, seed — состояние версии 0 из Rust). Расхождение
 * перекрёстного replay — отличие редьюсера переноса от JS.
 *
 * Как и JS-аудит без `--strict`, код 0 означает «аудит отработал»; итог — в
 * `report` (`ready`, `replay_matched`, `cross_replay_matched`).
 *
 * @param {string} storage
 * @param {string} campaign
 * @returns {Promise<{ status: number | null, output: string, report: any }>}
 */
export async function rustCutoverAudit(storage, campaign) {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const [{ FileEventStore }, { MapStore }, rules, { canonicalProjection, projectionHash }] = await Promise.all([
    import('../server/event-store.mjs'),
    import('../server/map-store.mjs'),
    import('../server/rules-engine.mjs'),
    import('../server/projection-integrity.mjs'),
  ])
  const target = { impl: 'rust', storageDir: storage }
  const scratch = mkdtempSync(join(tmpdir(), 'skazanie-cross-replay-'))
  try {
    const loaded = await readJournal(target, campaign)
    const replayed = await readJournal(target, campaign, { useSnapshots: false })
    const seed = await readJournal(target, campaign, { atVersion: 0, useSnapshots: false })
    const rootDir = join(scratch, 'engine')
    const store = new FileEventStore({
      rootDir,
      reducer: rules.applyGameEvent,
      normalizeState: rules.normalizeCampaignState,
      reducerNormalizesInput: true,
      snapshotProjectorVersion: rules.GAME_STATE_PROJECTOR_VERSION,
      reducerVersion: rules.GAME_REDUCER_VERSION,
      mapStore: new MapStore({ rootDir }),
    })
    await store.initializeCampaign({ campaignId: campaign, initialState: seed.state })
    let crossError = null
    for (const commit of loaded.commits) {
      try {
        await store.commit({
          campaign_id: campaign,
          expected_state_version: commit.state_version_before,
          idempotency_key: commit.idempotency_key,
          command_id: commit.command_id,
          events: commit.events,
        })
      } catch (error) {
        crossError = { at_version: commit.state_version_before, message: String(error?.message ?? error).slice(0, 300) }
        break
      }
    }
    const cross = crossError ? null : await store.load(campaign)
    const hashes = {
      loaded: projectionHash(loaded.state),
      replayed: projectionHash(replayed.state),
      cross_replay: cross ? projectionHash(cross.state) : null,
    }
    const report = {
      campaign_id: campaign,
      event_version: loaded.current_state_version,
      replay_version: replayed.state_version,
      commits: loaded.commits.length,
      events: loaded.events.length,
      replay_matched: hashes.loaded === hashes.replayed,
      cross_replay_matched: hashes.cross_replay === hashes.loaded,
      cross_replay_error: crossError,
      first_difference: cross && hashes.cross_replay !== hashes.loaded ? firstDifference(canonicalProjection(cross.state), canonicalProjection(loaded.state)) : null,
      pending_projection: loaded.pending_projection,
      hashes,
    }
    report.ready = report.replay_matched && report.cross_replay_matched && !report.pending_projection
    return { status: 0, output: JSON.stringify(report, null, 2), report }
  } catch (error) {
    return { status: 1, output: String(error?.stack ?? error).slice(0, 2000), report: null }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

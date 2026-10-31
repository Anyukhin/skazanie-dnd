// Журнал кампании глазами теста — без знания, как сервер его хранит.
//
// Раньше HTTP-тесты открывали `<storage>/engine/campaigns/<КОД>-<хеш>/events`
// сами, собирали свой `FileEventStore` и удаляли файлы для порчи хвоста. Такой
// тест привязан к файловому хранилищу JS и против Rust-сервера (SQLite) не
// работает. Здесь три операции с одинаковым смыслом в обоих режимах:
//
// * `readJournal`    — прочитать голову, коммиты и события;
// * `corruptCampaign`— потерять хвост журнала или seed-снимок (сервер остановлен);
// * `appendJournal`  — дописать коммит мимо сервера («сбой между событием и проекцией»).
//
// Режим `js` работает через `FileEventStore`, собранный так же, как в
// `server/index.mjs`. Режим `rust` зовёт подкоманду бинаря (контракт для С2):
//
//   skazanie-server journal --storage <dir> --campaign <код> [--at-version N] [--no-snapshots]
//   skazanie-server journal --storage <dir> --campaign <код> --corrupt tail|seed
//   skazanie-server journal --storage <dir> --campaign <код> --append   (JSON коммита на stdin)
//
// Подкоманда печатает в stdout ровно тот JSON, который возвращают функции ниже.
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

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

/** @typedef {{ impl: 'js' | 'rust', storageDir: string, running?: () => boolean }} JournalTarget */

/** Журнал, собранный как в `server/index.mjs`. */
async function jsStore(/** @type {string} */ storageDir) {
  const [{ FileEventStore }, { MapStore }, rules] = await Promise.all([
    import('../../server/event-store.mjs'),
    import('../../server/map-store.mjs'),
    import('../../server/rules-engine.mjs'),
  ])
  const rootDir = join(storageDir, 'engine')
  return new FileEventStore({
    rootDir,
    reducer: rules.applyGameEvent,
    normalizeState: rules.normalizeCampaignState,
    reducerNormalizesInput: true,
    snapshotProjectorVersion: rules.GAME_STATE_PROJECTOR_VERSION,
    reducerVersion: rules.GAME_REDUCER_VERSION,
    mapStore: new MapStore({ rootDir }),
  })
}

/**
 * Каталог кампании в файловом журнале JS. Раскладку знает только сам журнал.
 *
 * @param {any} store
 * @param {string} campaignCode
 * @returns {{ directory: string, events: string, snapshots: string }}
 */
function jsLayout(store, campaignCode) {
  const layout = store._layout(campaignCode)
  if (!existsSync(layout.directory)) throw new Error(`Нет журнала кампании ${campaignCode}`)
  return layout
}

/** @param {string} directory */
function sortedJson(directory) {
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith('.json')).sort() : []
}

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
  if (server.impl === 'rust') {
    return runRustTool([
      'journal', '--storage', server.storageDir, '--campaign', campaignCode,
      ...(atVersion === undefined ? [] : ['--at-version', String(atVersion)]),
      ...(useSnapshots ? [] : ['--no-snapshots']),
    ], { storageDir: server.storageDir })
  }
  const store = await jsStore(server.storageDir)
  const layout = jsLayout(store, campaignCode)
  const commits = sortedJson(layout.events).map((name) => JSON.parse(readFileSync(join(layout.events, name), 'utf8')))
  const loaded = await store.replay(campaignCode, { atVersion, useSnapshots })
  const pending = await store.pendingProjection(campaignCode, { withState: false })
  const metadata = await store.getMetadata(campaignCode)
  return {
    campaign_id: loaded.campaign_id,
    state_version: loaded.state_version,
    current_state_version: loaded.current_state_version,
    state: loaded.state,
    commits: commits.map((commit) => ({
      idempotency_key: commit.idempotency_key,
      command_id: commit.command_id,
      state_version_before: commit.state_version_before,
      state_version_after: commit.state_version_after,
      events: commit.events ?? [],
    })),
    events: commits.flatMap((commit) => commit.events ?? []),
    pending_projection: pending ? { checkpoint_version: pending.checkpoint_version, state_version: pending.state_version } : null,
    projection_checkpoint: {
      version: Number(metadata?.projection_checkpoint_version ?? 0),
      hash: metadata?.projection_checkpoint_hash ?? null,
    },
  }
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
  if (server.impl === 'rust') {
    await runRustTool(['journal', '--storage', server.storageDir, '--campaign', campaignCode, '--corrupt', mode], { storageDir: server.storageDir })
    return CORRUPTION_REASONS[/** @type {'tail' | 'seed'} */ (mode)]
  }
  const layout = jsLayout(await jsStore(server.storageDir), campaignCode)
  if (mode === 'tail') {
    const commits = sortedJson(layout.events)
    if (!commits.length) throw new Error(`corruptCampaign: у кампании ${campaignCode} нет коммитов — терять нечего`)
    rmSync(join(layout.events, commits.at(-1) ?? ''))
  } else {
    const seed = sortedJson(layout.snapshots)[0]
    if (!seed) throw new Error(`corruptCampaign: у кампании ${campaignCode} нет снимков`)
    rmSync(join(layout.snapshots, seed))
  }
  return CORRUPTION_REASONS[mode]
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
  if (server.impl === 'rust') {
    return runRustTool(['journal', '--storage', server.storageDir, '--campaign', campaignCode, '--append'], {
      storageDir: server.storageDir, input: commit,
    })
  }
  const store = await jsStore(server.storageDir)
  jsLayout(store, campaignCode)
  const expected = commit.expected_state_version ?? (await store.load(campaignCode)).state_version
  const result = await store.commit({ ...commit, campaign_id: campaignCode, expected_state_version: expected })
  return { state_version: result.state_version, state: result.state, events: result.events, duplicate: Boolean(result.duplicate) }
}

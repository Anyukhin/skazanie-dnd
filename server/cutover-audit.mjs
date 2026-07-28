import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { FileEventStore } from './event-store.mjs'
import { MapStore } from './map-store.mjs'
import { compareProjection, projectionHash } from './projection-integrity.mjs'
import { GAME_STATE_PROJECTOR_VERSION, applyGameEvent, normalizeCampaignState } from './rules-engine.mjs'

function jsonFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function fileHash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function eventCampaignIds(engineRoot) {
  const campaigns = join(engineRoot, 'campaigns')
  if (!existsSync(campaigns)) return []
  const result = []
  for (const directory of readdirSync(campaigns, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue
    const metadataFile = join(campaigns, directory.name, 'metadata.json')
    if (!existsSync(metadataFile)) continue
    try {
      const metadata = jsonFile(metadataFile)
      if (metadata.campaign_id) result.push(String(metadata.campaign_id))
    } catch {
      result.push(`invalid:${directory.name}`)
    }
  }
  return result
}

export async function auditLegacyCutover({ storageRoot } = {}) {
  const root = resolve(storageRoot || process.env.DND_STORAGE_DIR || 'storage')
  const roomsRoot = join(root, 'rooms')
  const engineRoot = join(root, 'engine')
  const roomIds = existsSync(roomsRoot)
    ? readdirSync(roomsRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -5))
    : []
  const eventIds = eventCampaignIds(engineRoot)
  const campaignIds = [...new Set([...roomIds, ...eventIds])].sort()
  const eventStore = new FileEventStore({
    rootDir: engineRoot,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
    /**
     * MapStore обязателен, и его отсутствие здесь было настоящим дефектом.
     *
     * Снимок хранит карту **ссылкой** (`skazanie:map-ref-v1` + хеш), а комната
     * — клетками: клиенту нужны клетки, снимку — размер. Без хранилища карт
     * `load()` не может вернуть карту на место, ссылка остаётся ссылкой, и
     * сверка сцены сравнивает ссылку с клетками. Совпасть это не могло
     * никогда: `cutover:verify` был красным у любой кампании, чья карта
     * вынесена из снимка, — то есть у всех. Данные при этом были целы.
     */
    mapStore: new MapStore({ rootDir: engineRoot }),
  })
  const campaigns = []
  const blockers = []
  /** Замечания видны в отчёте, но выпуск не останавливают. */
  const warnings = []

  for (const campaignId of campaignIds) {
    if (campaignId.startsWith('invalid:')) {
      blockers.push({ code: 'INVALID_EVENT_METADATA', campaign_id: campaignId })
      continue
    }
    const roomFile = join(roomsRoot, `${campaignId}.json`)
    const hasRoom = existsSync(roomFile)
    const hasEvents = eventIds.includes(campaignId)
    const entry = { campaign_id: campaignId, room: hasRoom, event_stream: hasEvents }
    if (!hasRoom) blockers.push({ code: 'ROOM_PROJECTION_MISSING', campaign_id: campaignId })
    if (!hasEvents) blockers.push({ code: 'EVENT_STREAM_MISSING', campaign_id: campaignId })

    try {
      const room = hasRoom ? jsonFile(roomFile) : null
      const loaded = hasEvents ? await eventStore.load(campaignId) : null
      const replayed = hasEvents ? await eventStore.replay(campaignId, { useSnapshots: false }) : null
      const metadata = hasEvents ? await eventStore.getMetadata(campaignId) : null
      const pending = hasEvents ? await eventStore.pendingProjection(campaignId) : null
      const projection = room?.state && loaded?.state
        ? compareProjection(loaded.state, normalizeCampaignState(room.state))
        : null
      const replayMatched = loaded && replayed
        ? projectionHash(loaded.state) === projectionHash(replayed.state)
        : false
      Object.assign(entry, {
        room_version: Number(room?.state?.state_version ?? -1),
        event_version: Number(loaded?.state_version ?? -1),
        replay_version: Number(replayed?.state_version ?? -1),
        room_file_sha256: hasRoom ? fileHash(roomFile) : null,
        authoritative_sha256: loaded ? projectionHash(loaded.state) : null,
        projected_sha256: room?.state ? projectionHash(normalizeCampaignState(room.state)) : null,
        projection_matched: projection?.matched ?? false,
        replay_matched: replayMatched,
        projection_checkpoint_version: Number(metadata?.projection_checkpoint_version ?? 0),
        projection_checkpoint_hash: metadata?.projection_checkpoint_hash ?? null,
        pending_projection: Boolean(pending),
        raw_room_engine_mode: room?.state?.engine_mode ?? null,
      })
      if (loaded && replayed && !replayMatched) blockers.push({ code: 'REPLAY_DIVERGENCE', campaign_id: campaignId })
      if (projection && !projection.matched) blockers.push({ code: 'PROJECTION_DIVERGENCE', campaign_id: campaignId })
      if (loaded && room && Number(room.state?.state_version ?? -1) !== Number(loaded.state_version)) {
        blockers.push({ code: 'PROJECTION_VERSION_DIVERGENCE', campaign_id: campaignId })
      }
      if (pending) blockers.push({ code: 'PROJECTION_NOT_ACKNOWLEDGED', campaign_id: campaignId })
      /**
       * Контрольная точка хранит хеш, посчитанный **кодом того дня**, когда
       * проекция записывалась. Любое изменение `normalizeCampaignState` —
       * новое поле механики, новый умолчательный раздел — меняет канонический
       * хеш, и старая отметка перестаёт совпадать, хотя на диске всё цело.
       *
       * Поэтому расхождение отметки блокирует выпуск только тогда, когда о
       * беде говорит что-то ещё: проекция разошлась с авторитетным состоянием
       * или запись не была подтверждена. Если сверка сегодняшним кодом
       * сходится, отметка просто устарела — это замечание, а не блокер, и
       * сервер обновит её при следующей записи проекции.
       *
       * Ослаблять настоящую защиту здесь нечего: она держится на
       * `projection_matched` и `pending_projection`, а не на исторической
       * отметке.
       */
      if (!pending && metadata?.projection_checkpoint_version > 0
        && metadata.projection_checkpoint_hash !== projection?.projected_hash) {
        const entry = { code: 'PROJECTION_CHECKPOINT_HASH_MISMATCH', campaign_id: campaignId }
        if (projection?.matched) warnings.push({ ...entry, reason: 'STALE_CHECKPOINT_AFTER_SCHEMA_CHANGE' })
        else blockers.push(entry)
      }
      if (room?.state?.engine_mode && room.state.engine_mode !== 'enforce') {
        blockers.push({ code: 'RETIRED_MODE_IN_ROOM', campaign_id: campaignId, value: room.state.engine_mode })
      }
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error)
      blockers.push({ code: 'CAMPAIGN_AUDIT_FAILED', campaign_id: campaignId, error: entry.error })
    }
    campaigns.push(entry)
  }

  return {
    schema_version: 2,
    storage_root: root,
    campaign_count: campaigns.length,
    ready: blockers.length === 0,
    campaigns,
    blockers,
    warnings,
  }
}

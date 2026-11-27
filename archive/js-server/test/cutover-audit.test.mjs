import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { auditLegacyCutover } from '../server/cutover-audit.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { MapStore } from '../server/map-store.mjs'
import { applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

const floorCells = (size = 9) => {
  const cells = []
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) cells.push({ x, y, type: 'floor', revealed: true })
  return cells
}

function fixture({ withMap = false } = {}) {
  const storageRoot = mkdtempSync(join(tmpdir(), 'skazanie-cutover-'))
  const rooms = join(storageRoot, 'rooms')
  mkdirSync(rooms, { recursive: true })
  const state = normalizeCampaignState({
    sessionCode: 'CUTOVER-1',
    campaign: 'Cutover',
    players: [],
    messages: [],
    scene: { title: 'Начало', location: '', turn: 0, cells: [] },
  })
  writeFileSync(join(rooms, 'CUTOVER-1.json'), JSON.stringify({ version: 1, state }))
  const engineRoot = join(storageRoot, 'engine')
  const eventStore = new FileEventStore({
    rootDir: engineRoot,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    // Боевой сервер всегда с хранилищем карт; без него снимок не выносит карту
    // и проверка «аудит умеет её вернуть» ничего бы не проверяла.
    ...(withMap ? { mapStore: new MapStore({ rootDir: engineRoot }) } : {}),
  })
  return { storageRoot, state, eventStore }
}

test('cutover audit accepts an enforce-only room that exactly matches replay', async () => {
  const { storageRoot, state, eventStore } = fixture()
  await eventStore.initializeCampaign({ campaign_id: 'CUTOVER-1', initial_state: state })
  const report = await auditLegacyCutover({ storageRoot })
  assert.equal(report.ready, true)
  assert.equal(report.campaigns[0].projection_matched, true)
  assert.equal(report.campaigns[0].replay_matched, true)
})

/**
 * Найдено 2026-07-28. Снимок хранит карту **ссылкой** (`skazanie:map-ref-v1` +
 * хеш), комната — клетками: клиенту нужны клетки, снимку — размер. Аудит
 * создавал `FileEventStore` без `MapStore`, поэтому не мог вернуть карту на
 * место, и сверка сцены сравнивала ссылку с клетками. Совпасть это не могло
 * никогда: `cutover:verify` был красным у любой кампании с вынесенной картой,
 * то есть у всех, хотя данные были целы.
 */
test('cutover audit возвращает карту из хранилища и не считает ссылку расхождением', async () => {
  const { storageRoot, eventStore } = fixture({ withMap: true })
  const mapped = normalizeCampaignState({
    sessionCode: 'CUTOVER-1',
    campaign: 'Cutover',
    players: [],
    messages: [],
    scene: { title: 'Двор', location: 'Двор', turn: 0, cells: floorCells() },
  })
  writeFileSync(join(storageRoot, 'rooms', 'CUTOVER-1.json'), JSON.stringify({ version: 1, state: mapped }))
  await eventStore.initializeCampaign({ campaign_id: 'CUTOVER-1', initial_state: mapped })
  // Снимок пишется каждые N событий; форсируем его, чтобы карта уехала в MapStore.
  await eventStore.snapshot?.('CUTOVER-1')

  const report = await auditLegacyCutover({ storageRoot })
  assert.equal(report.campaigns[0].projection_matched, true, JSON.stringify(report.blockers))
  assert.ok(!report.blockers.some((item) => item.code === 'PROJECTION_DIVERGENCE'))
})

/**
 * Контрольная точка хранит хеш, посчитанный кодом того дня. Любое изменение
 * `normalizeCampaignState` меняет канонический хеш, и старая отметка перестаёт
 * совпадать, хотя на диске всё цело. Такое расхождение — замечание, а не
 * блокер: настоящая защита держится на сверке сегодняшним кодом.
 */
test('устаревшая контрольная точка — замечание, пока проекция сходится', async () => {
  const { storageRoot, state, eventStore } = fixture()
  await eventStore.initializeCampaign({ campaign_id: 'CUTOVER-1', initial_state: state })
  await eventStore.commit({
    campaign_id: 'CUTOVER-1',
    expected_state_version: 0,
    idempotency_key: 'roll-1',
    command_id: 'roll-1',
    events: [{
      event_type: 'PublicDieRolled', actor_id: 'hero', target_ids: [],
      payload: { roll: { id: 'roll-1', value: 17 } }, source_rule_ids: [], visibility: 'public',
    }],
  })
  // Комната записана верно и подтверждена — но хешем, каким его посчитал бы
  // код прежней схемы.
  const loaded = await eventStore.load('CUTOVER-1')
  writeFileSync(join(storageRoot, 'rooms', 'CUTOVER-1.json'), JSON.stringify({ version: 2, state: loaded.state }))
  await eventStore.acknowledgeProjection('CUTOVER-1', loaded.state_version, { projectionHash: 'x'.repeat(64) })

  const report = await auditLegacyCutover({ storageRoot })
  assert.equal(report.campaigns[0].projection_matched, true)
  assert.equal(report.ready, true, `устаревшая отметка не должна блокировать выпуск: ${JSON.stringify(report.blockers)}`)
  assert.ok(report.warnings.some((item) => item.code === 'PROJECTION_CHECKPOINT_HASH_MISMATCH'))
  assert.ok(report.warnings.some((item) => item.reason === 'STALE_CHECKPOINT_AFTER_SCHEMA_CHANGE'))
})

test('cutover audit fails closed on an unprojected authoritative commit', async () => {
  const { storageRoot, state, eventStore } = fixture()
  await eventStore.initializeCampaign({ campaign_id: 'CUTOVER-1', initial_state: state })
  await eventStore.commit({
    campaign_id: 'CUTOVER-1',
    expected_state_version: 0,
    idempotency_key: 'public-roll-1',
    command_id: 'public-roll-1',
    events: [{
      event_type: 'PublicDieRolled',
      actor_id: 'hero',
      target_ids: [],
      payload: { roll: { id: 'roll-1', value: 17 } },
      source_rule_ids: [],
      visibility: 'public',
    }],
  })
  const report = await auditLegacyCutover({ storageRoot })
  assert.equal(report.ready, false)
  assert.ok(report.blockers.some((item) => item.code === 'PROJECTION_DIVERGENCE'))
  assert.ok(report.blockers.some((item) => item.code === 'PROJECTION_NOT_ACKNOWLEDGED'))
})

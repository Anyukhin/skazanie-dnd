import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { auditLegacyCutover } from '../server/cutover-audit.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

function fixture() {
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
  const eventStore = new FileEventStore({
    rootDir: join(storageRoot, 'engine'),
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
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

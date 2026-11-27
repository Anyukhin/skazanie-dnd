import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import {
  GAME_STATE_PROJECTOR_VERSION,
  applyGameEvent,
  normalizeCampaignState,
  resolveCommand,
} from '../server/rules-engine.mjs'

test('последняя смерть атомарно сохраняет единственный CampaignFailed и одинаково replay-ится', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-campaign-failure-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const initial = normalizeCampaignState({
    sessionCode: 'FAILURE-INTEGRATION',
    campaign: 'Последний рубеж',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Ада', hp: 0, maxHp: 10, inventory: [] }],
    scene: { location: 'Последний рубеж', objective: 'Удержать ворота', cells: [] },
  })
  const eventStore = new FileEventStore({
    rootDir,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
  })
  await eventStore.initializeCampaign({ campaign_id: initial.sessionCode, initial_state: initial })

  const resolved = resolveCommand({
    command_type: 'ApplyDamage',
    command_id: 'last-blow',
    campaign_id: initial.sessionCode,
    actor_id: 'hero',
    target_id: 'hero',
    amount: 10,
    damage_type: 'force',
  }, initial, {
    diceService: new DiceService({ rng: new SequenceDiceRng([]) }),
  })
  const request = {
    campaign_id: initial.sessionCode,
    expected_state_version: 0,
    idempotency_key: 'last-blow',
    command_id: 'last-blow',
    events: resolved.events,
  }
  const committed = await eventStore.commit(request)

  assert.deepEqual(
    committed.events.slice(-2).map((event) => event.event_type),
    ['HeroDied', 'CampaignFailed'],
  )
  assert.equal(committed.events.filter((event) => event.event_type === 'CampaignFailed').length, 1)
  assert.equal(committed.state.mechanics.campaign_lifecycle.status, 'failed')
  assert.match(committed.state.mechanics.campaign_lifecycle.epilogue, /поражен|погиб|пал/iu)

  const duplicate = await eventStore.commit(request)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.state_version, committed.state_version)

  const reopened = new FileEventStore({
    rootDir,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
  })
  const replayed = await reopened.replay(initial.sessionCode, { use_snapshots: false })
  assert.deepEqual(replayed.state, committed.state)
  assert.equal((await reopened.getEvents(initial.sessionCode)).filter((event) => event.event_type === 'CampaignFailed').length, 1)
})

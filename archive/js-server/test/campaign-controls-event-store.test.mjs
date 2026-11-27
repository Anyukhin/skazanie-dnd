import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { campaignRewindEvent } from '../server/campaign-controls.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

test('CampaignRewound восстанавливает состояние через append-only событие, replay и повтор команды', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-campaign-rewind-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))

  const store = new FileEventStore({
    rootDir,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    snapshotEvery: 0,
  })
  await store.initializeCampaign({
    campaignId: 'rewind-replay',
    initialState: {
      sessionCode: 'REWIND-REPLAY',
      players: [{ id: 'hero-1', character: 'Следопыт', hp: 10, maxHp: 10, x: 0, y: 0 }],
      actors: [],
      partyMemberIds: ['hero-1'],
      activePlayerId: 'hero-1',
      scene: { location: 'Старая дорога', turn: 1, cells: [] },
      mechanics: {
        positions: { 'hero-1': { x: 0, y: 0 } },
        campaign_lifecycle: { status: 'active' },
      },
    },
  })

  await store.commit({
    campaignId: 'rewind-replay',
    expectedStateVersion: 0,
    idempotencyKey: 'turn-move',
    commandId: 'turn-move',
    events: [{
      event_type: 'ActorMoved',
      actor_id: 'hero-1',
      target_ids: ['hero-1'],
      payload: { to: { x: 1, y: 0 }, distance: 5, spend_movement: false },
    }],
  })
  const target = await store.load('rewind-replay', { atVersion: 1 })
  const damaged = await store.commit({
    campaignId: 'rewind-replay',
    expectedStateVersion: 1,
    idempotencyKey: 'turn-damage',
    commandId: 'turn-damage',
    events: [{
      event_type: 'DamageApplied',
      actor_id: 'enemy-1',
      target_ids: ['hero-1'],
      payload: { hp_before: 10, hp_after: 2, applied_amount: 8, temporary_hp_after: 0 },
    }],
  })
  assert.equal(damaged.state.players[0].hp, 2)

  const rewindEvent = campaignRewindEvent({
    action: 'rewind_turn',
    targetState: target.state,
    currentState: damaged.state,
    targetVersion: 1,
    actorId: 'owner-1',
    occurredAt: '2026-07-31T00:00:00.000Z',
  })
  const request = {
    campaignId: 'rewind-replay',
    expectedStateVersion: 2,
    idempotencyKey: 'rewind-turn-1',
    commandId: 'campaign-control:rewind-turn-1',
    events: [rewindEvent],
    forceSnapshot: true,
  }
  const rewound = await store.commit(request)

  assert.equal(rewound.state_version, 3)
  assert.equal(rewound.state.state_version, 3)
  assert.equal(rewound.state.players[0].hp, 10)
  assert.deepEqual(rewound.state.mechanics.positions['hero-1'], { x: 1, y: 0 })
  assert.deepEqual(rewound.events.map((event) => event.event_type), ['CampaignRewound'])

  const replayedWithoutSnapshots = await store.replay('rewind-replay', { use_snapshots: false })
  assert.deepEqual(replayedWithoutSnapshots.state, rewound.state)

  const duplicate = await store.commit(request)
  assert.equal(duplicate.duplicate, true)
  assert.deepEqual(duplicate.state, rewound.state)
  assert.equal((await store.getEvents('rewind-replay')).length, 3)
})

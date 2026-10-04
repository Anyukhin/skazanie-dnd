import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FileEventStore } from '../../../server/event-store.mjs'
import { GameOrchestrator } from '../../../server/game-orchestrator.mjs'
import { DiceService } from '../../../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, RulesEngine } from '../../../server/rules-engine.mjs'
import { FileTraceStore } from '../../../server/trace-store.mjs'
import { projectionHash } from '../../../server/projection-integrity.mjs'

function stateFixture() {
  return normalizeCampaignState({
    sessionCode: 'PROJECTION-TRACE-PROBE', activePlayerId: 'hero',
    scene: { title: 'Зал', cells: [] },
    players: [
      { id: 'hero', character: 'Ада', hp: 10, maxHp: 10, armor: 14, abilities: { str: 14 }, inventory: [] },
      { id: 'goblin', character: 'Гоблин', hp: 8, maxHp: 8, armor: 12, abilities: { dex: 12 }, inventory: [] },
    ],
  })
}

async function projectionAckAcceptsCallerHash() {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-projection-probe-'))
  try {
    const store = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
    await store.initializeCampaign({ campaign_id: 'PROJECTION-TRACE-PROBE', initial_state: stateFixture() })
    await store.commit({
      campaignId: 'PROJECTION-TRACE-PROBE', expectedStateVersion: 0, idempotencyKey: 'probe-commit',
      events: [{ event_type: 'PublicDieRolled', actor_id: 'hero', target_ids: [], payload: { roll: { total: 1 } } }],
    })
    const canonical = projectionHash((await store.load('PROJECTION-TRACE-PROBE')).state)
    const supplied = 'probe-invalid-hash'
    await store.acknowledgeProjection('PROJECTION-TRACE-PROBE', 1, { projectionHash: supplied })
    const metadata = await store.getMetadata('PROJECTION-TRACE-PROBE')
    assert.equal(metadata.projection_checkpoint_version, 1)
    assert.equal(metadata.projection_checkpoint_hash, supplied)
    assert.notEqual(supplied, canonical)
    assert.equal(await store.pendingProjection('PROJECTION-TRACE-PROBE'), null)
    return { checkpoint_version: metadata.projection_checkpoint_version, supplied_hash_accepted: true, pending_after_ack: false }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function traceMissingAfterPostCommitSaveFailure() {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-trace-probe-'))
  try {
    const eventStore = new FileEventStore({ rootDir: join(root, 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState })
    const actualTraceStore = new FileTraceStore({ rootDir: join(root, 'traces') })
    let failOnce = true
    const traceStore = {
      save(input) {
        if (failOnce) { failOnce = false; throw new Error('probe trace failure after commit') }
        return actualTraceStore.save(input)
      },
      get: actualTraceStore.get.bind(actualTraceStore),
      recent: actualTraceStore.recent.bind(actualTraceStore),
    }
    const orchestrator = new GameOrchestrator({
      eventStore,
      rulesEngine: new RulesEngine({ diceService: new DiceService() }),
      traceStore,
      unknownActionHandler: {},
    })
    await eventStore.initializeCampaign({ campaign_id: 'PROJECTION-TRACE-PROBE', initial_state: stateFixture() })
    const input = {
      state: stateFixture(), playerId: 'hero', message: 'Системная команда', idempotencyKey: 'trace-probe',
      commands: [{ command_type: 'ApplyDamage', actor_id: 'hero', target_id: 'goblin', amount: 2, damage_type: 'slashing' }],
    }
    await assert.rejects(orchestrator.handle(input), /probe trace failure after commit/u)
    assert.ok(await eventStore.getByIdempotencyKey('PROJECTION-TRACE-PROBE', 'trace-probe'))
    const replay = await orchestrator.handle(input)
    assert.equal(replay.idempotent_replay, true)
    assert.equal(actualTraceStore.get('PROJECTION-TRACE-PROBE', replay.turn_id), null)
    return { commit_survives: true, retry_is_idempotent: true, trace_recreated: false }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

console.log(JSON.stringify({
  projection_ack: await projectionAckAcceptsCallerHash(),
  trace_recovery: await traceMissingAfterPostCommitSaveFailure(),
}))

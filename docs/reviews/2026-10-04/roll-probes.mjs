import assert from 'node:assert/strict'

import { DiceService, SequenceDiceRng } from '../../../server/dice-service.mjs'
import { RollRegistry } from '../../../server/roll-registry.mjs'
import { applyGameEvent, normalizeCampaignState, RulesEngine } from '../../../server/rules-engine.mjs'
import { GameOrchestrator } from '../../../server/game-orchestrator.mjs'

const NOW = '2026-10-04T00:00:00.000Z'

function d20(values, id) {
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => id,
    now: () => NOW,
  })
}

function stateFixture() {
  return normalizeCampaignState({
    sessionCode: 'PROBE-1',
    players: [{
      id: 'hero', hp: 10, maxHp: 10, armor: 12, proficiency: 2,
      abilities: { str: 16, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      inventory: [],
    }],
  })
}

// Важно: in-memory orchestrator+registry это не real HTTP route test.
// HTTP-путь подтверждается трассировкой callsite в отчёте; здесь проверяется
// тот же порядок consume -> GameOrchestrator -> Rules Engine без storage и LLM.
async function genericRollAppliesToAbilityCheck() {
  const registry = new RollRegistry({ diceService: d20([20], 'generic-roll') })
  const issued = registry.issue({ campaignId: 'PROBE-1', actorId: 'hero' })
  assert.equal(issued.roll_id, 'generic-roll')
  const consumed = registry.consume(issued.roll_id, {
    campaignId: 'PROBE-1', actorId: 'hero', idempotencyKey: 'turn-generic',
  })

  let state = stateFixture()
  const commits = new Map()
  const eventStore = {
    async load() {
      return { state, state_version: state.state_version, current_state_version: state.state_version }
    },
    async getByIdempotencyKey(_campaignId, key) {
      const commit = commits.get(key)
      return commit ? { ...commit, duplicate: true } : null
    },
    async commit({ idempotency_key, events }) {
      state = events.reduce(applyGameEvent, state)
      const commit = { state, state_version: state.state_version, events, idempotency_key, duplicate: false }
      commits.set(idempotency_key, commit)
      return commit
    },
  }
  const orchestrator = new GameOrchestrator({
    eventStore,
    rulesEngine: new RulesEngine({ diceService: d20([], 'fallback') }),
    rollRegistry: registry,
    narrator: { async render() { return { narration: 'Проверка разрешена.', provider: 'probe' } } },
    unknownActionHandler: {},
  })

  const response = await orchestrator.handle({
    campaignId: 'PROBE-1', playerId: 'hero', message: 'Проверяю силу',
    idempotencyKey: 'turn-generic', verifiedRoll: consumed, manualRoll: false,
    user: {}, allowedActorIds: ['hero'],
  })
  const check = response.mechanics.find((event) => event.event_type === 'AbilityCheckResolved')?.payload
  assert.ok(check, 'обычная проверка должна создать AbilityCheckResolved')
  assert.equal(check.kept, 20)
  assert.equal(check.player_rolled, true)
  assert.equal(check.success, true)
  return { total: check.total, difficulty: check.difficulty, kept: check.kept, success: check.success, player_rolled: check.player_rolled }
}

async function precommitFailureKeepsRegistryMarker() {
  const registry = new RollRegistry({ diceService: d20([20], 'precommit-roll') })
  const issued = registry.issue({ campaignId: 'PROBE-1', actorId: 'hero' })
  const consumed = registry.consume(issued.roll_id, {
    campaignId: 'PROBE-1', actorId: 'hero', idempotencyKey: 'turn-failed',
  })
  const state = stateFixture()
  const eventStore = {
    async load() {
      return { state, state_version: state.state_version, current_state_version: state.state_version }
    },
    async getByIdempotencyKey() { return null },
    async commit() {
      throw Object.assign(new Error('simulated conflict'), { code: 'STATE_VERSION_CONFLICT' })
    },
  }
  const orchestrator = new GameOrchestrator({
    eventStore,
    rulesEngine: new RulesEngine({ diceService: d20([], 'fallback') }),
    rollRegistry: registry,
    narrator: { async render() { return { narration: 'unused', provider: 'probe' } } },
    unknownActionHandler: {},
  })
  await assert.rejects(
    orchestrator.handle({
      campaignId: 'PROBE-1', playerId: 'hero', message: 'Проверяю силу',
      idempotencyKey: 'turn-failed', verifiedRoll: consumed, manualRoll: false,
      user: {}, allowedActorIds: ['hero'],
    }),
    (error) => error.code === 'STATE_VERSION_CONFLICT',
  )
  assert.equal(registry.consume(issued.roll_id, {
    campaignId: 'PROBE-1', actorId: 'hero', idempotencyKey: 'turn-failed',
  }).roll_id, issued.roll_id, 'повтор с тем же ключом разрешён')
  assert.throws(
    () => registry.consume(issued.roll_id, {
      campaignId: 'PROBE-1', actorId: 'hero', idempotencyKey: 'turn-new-key',
    }),
    (error) => error.code === 'ROLL_ALREADY_USED',
  )
  return { orchestratorFailure: 'STATE_VERSION_CONFLICT', sameKeyRetry: 'allowed', newKeyRetry: 'ROLL_ALREADY_USED' }
}

const result = {
  generic_success: await genericRollAppliesToAbilityCheck(),
  precommit_failure: await precommitFailureKeepsRegistryMarker(),
}
console.log(JSON.stringify(result))

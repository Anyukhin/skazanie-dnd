import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { assembleEncounter } from '../server/encounter-assembler.mjs'
import {
  RulesValidationError,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
  resolveCommands,
} from '../server/rules-engine.mjs'

function cells(width = 9, height = 5) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
    type: 'floor',
    revealed: true,
  }))
}

function fixture(overrides = {}) {
  return normalizeCampaignState({
    sessionCode: 'ENCOUNTER-FLOW',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{
      id: 'hero', name: 'Aster', level: 1, hp: 24, maxHp: 24, armor: 15,
      speed: 30, proficiency: 2,
      abilities: { str: 14, dex: 10, con: 14, int: 10, wis: 12, cha: 10 },
      x: 0, y: 0, inventory: [],
    }],
    enemies: [],
    scene: {
      title: 'Encounter test field', location: 'Old road', objective: 'Survive', turn: 1,
      cells: cells(),
    },
    mechanics: { positions: { hero: { x: 0, y: 0 } } },
    ...overrides,
  })
}

function dice(values) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `encounter-roll-${++id}`,
    now: () => '2026-07-13T12:00:00.000Z',
  })
}

function createCommand(state, overrides = {}) {
  return {
    command_type: 'CreateEncounter',
    expected_state_version: state.state_version,
    difficulty: 'easy',
    theme: 'beasts',
    seed: 'encounter-flow-seed',
    request_fingerprint: 'f'.repeat(64),
    ...overrides,
  }
}

function applyResult(state, result) {
  return result.events.reduce(applyGameEvent, state)
}

test('CreateEncounter is privileged and derives the complete encounter from authoritative state', () => {
  const state = fixture()
  const command = createCommand(state, {
    encounter: {
      proposal_id: 'forged-proposal',
      enemies: [{
        id: 'forged-enemy', hp: 999_999, armor: 0, attackBonus: 999,
        damageDice: 999, x: 0, y: 0,
      }],
    },
  })

  assert.throws(
    () => resolveCommand(command, state, { diceService: dice([]) }),
    (error) => error instanceof RulesValidationError && error.code === 'ENCOUNTER_MANAGEMENT_FORBIDDEN',
  )

  const expected = assembleEncounter({
    scene: { cells: state.scene.cells },
    party: [{ id: 'hero', level: 1, x: 0, y: 0 }],
    difficulty: 'easy',
    theme: 'beasts',
    seed: 'encounter-flow-seed',
  })
  const result = resolveCommand(command, state, {
    diceService: dice([]),
    context: { isAdmin: true },
  })
  const created = result.events.find((event) => event.event_type === 'EncounterCreated')

  assert.ok(created)
  assert.deepEqual(result.command.encounter.enemies, expected.enemies)
  assert.deepEqual(created.payload.encounter.enemies, expected.enemies)
  assert.equal(created.payload.encounter.enemies.some((enemy) => enemy.id === 'forged-enemy'), false)
  assert.equal(created.payload.request_fingerprint, 'f'.repeat(64))
  assert.ok(created.payload.encounter.enemies.every((enemy) => (
    enemy.provenance?.ruleset_id === 'srd_5_2_1'
      && Number.isSafeInteger(enemy.x)
      && Number.isSafeInteger(enemy.y)
  )))

  const staged = applyResult(state, result)
  assert.equal(staged.mechanics.encounter.status, 'staged')
  assert.deepEqual(staged.mechanics.encounter.enemy_ids, staged.enemies.map((enemy) => enemy.id))
  assert.ok(staged.enemies.every((enemy) => (
    staged.mechanics.positions[enemy.id].x === enemy.x
      && staged.mechanics.positions[enemy.id].y === enemy.y
  )))
  assert.equal(staged.mechanics.combat.active, false)
})

test('resolveCommands atomically stages and starts an encounter, and replay reconstructs the same state', () => {
  const initial = fixture()
  const result = resolveCommands([
    createCommand(initial),
    {
      command_type: 'StartCombat',
      actor_id: 'hero',
      participant_ids: ['hero', 'forged-outsider'],
      server_authoritative: true,
    },
  ], initial, {
    // The hero rolls 1 and the single wolf rolls 20. The generated enemy must
    // therefore be first without accepting client-supplied participant IDs.
    diceService: dice([1, 20]),
    context: { isAdmin: true, serverAuthoritativeCombat: true },
  })

  assert.deepEqual(result.events.slice(0, 2).map((event) => event.event_type), [
    'EncounterCreated',
    'CombatStarted',
  ])
  assert.equal(result.commands[1].expected_state_version, initial.state_version + 1)
  assert.equal(result.state.mechanics.encounter.status, 'active')
  assert.equal(result.state.mechanics.combat.active, true)
  assert.equal(result.state.mechanics.combat.initiative[0].actor_id, result.state.enemies[0].id)
  const enemyInitiative = result.state.mechanics.combat.initiative.find((entry) => entry.actor_id === result.state.enemies[0].id)
  assert.equal(enemyInitiative.modifier, result.state.enemies[0].initiativeBonus)
  assert.deepEqual(
    new Set(result.state.mechanics.combat.initiative.map((entry) => entry.actor_id)),
    new Set(['hero', ...result.state.mechanics.encounter.enemy_ids]),
  )
  assert.equal(result.state.mechanics.combat.initiative.some((entry) => entry.actor_id === 'forged-outsider'), false)

  const replayed = replayEvents(initial, result.events)
  assert.deepEqual(replayed, result.state)
})

test('StartCombat limits participants to the staged encounter enemy IDs', () => {
  const initial = fixture()
  const created = resolveCommand(createCommand(initial), initial, {
    diceService: dice([]),
    context: { isAdmin: true },
  })
  const staged = applyResult(initial, created)
  const encounterEnemyIds = [...staged.mechanics.encounter.enemy_ids]

  staged.enemies.push({
    id: 'unrelated-enemy', name: 'Unrelated enemy', hp: 99, maxHp: 99,
    armor: 20, abilities: { dex: 20 }, x: 1, y: 1, alive: true,
  })
  staged.mechanics.positions['unrelated-enemy'] = { x: 1, y: 1 }

  const started = resolveCommand({
    command_type: 'StartCombat',
    actor_id: 'hero',
    participant_ids: ['hero', 'unrelated-enemy'],
    expected_state_version: staged.state_version,
    server_authoritative: true,
  }, staged, {
    diceService: dice([10, 10]),
    context: { isAdmin: true, serverAuthoritativeCombat: true },
  })
  const combatStarted = started.events.find((event) => event.event_type === 'CombatStarted')

  assert.deepEqual(new Set(combatStarted.payload.enemy_ids), new Set(encounterEnemyIds))
  assert.equal(combatStarted.payload.initiative.some((entry) => entry.actor_id === 'unrelated-enemy'), false)
  assert.deepEqual(
    new Set(combatStarted.payload.initiative.map((entry) => entry.actor_id)),
    new Set(['hero', ...encounterEnemyIds]),
  )
})

test('EndCombat closes encounter, while SceneAdvanced clears all encounter and combat state', () => {
  const initial = fixture()
  const active = resolveCommands([
    createCommand(initial),
    { command_type: 'StartCombat', actor_id: 'hero', server_authoritative: true },
  ], initial, {
    diceService: dice([20, 1]),
    context: { isAdmin: true, serverAuthoritativeCombat: true },
  }).state

  const activeActor = active.mechanics.combat.initiative[active.mechanics.combat.active_index].actor_id
  const ended = resolveCommand({
    command_type: 'EndCombat',
    actor_id: activeActor,
    expected_state_version: active.state_version,
    reason: 'victory',
  }, active, {
    diceService: dice([]),
    context: { isAdmin: true },
  })
  assert.deepEqual(ended.events.map((event) => event.event_type), ['CombatEnded', 'EncounterEnded'])
  assert.equal(ended.events[1].payload.encounter_id, active.mechanics.encounter.id)
  assert.equal(ended.events[1].payload.reason, 'victory')

  const closed = applyResult(active, ended)
  assert.equal(closed.mechanics.combat.active, false)
  assert.equal(closed.mechanics.encounter.status, 'ended')
  assert.equal(closed.mechanics.encounter.outcome, 'victory')

  const nextScene = applyGameEvent(closed, {
    event_type: 'SceneAdvanced',
    state_version_after: closed.state_version + 1,
    payload: {
      scene: {
        title: 'Quiet village', location: 'Quiet village', objective: 'Rest', turn: 2,
        cells: cells(4, 3),
      },
      adventure: { chapter: 2, history: [], visitedLocations: ['Old road', 'Quiet village'] },
      party_positions: [{ actor_id: 'hero', x: 0, y: 0 }],
      suggestions: [],
    },
  })

  assert.equal(nextScene.mechanics.encounter, null)
  assert.equal(nextScene.mechanics.combat.active, false)
  assert.deepEqual(nextScene.enemies, [])
  assert.deepEqual(nextScene.entities, [])
  assert.deepEqual(nextScene.mechanics.positions, { hero: { x: 0, y: 0 } })
  assert.equal(nextScene.tacticalTurn, undefined)
})

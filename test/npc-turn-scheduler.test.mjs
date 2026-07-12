import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { planNpcTurn, runNpcTurnScheduler } from '../server/npc-turn-scheduler.mjs'
import { RULE_IDS, RulesEngine, RulesValidationError, applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

function cells(width = 9, height = 3) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
    type: 'floor',
    revealed: true,
  }))
}

function fixture(overrides = {}) {
  const state = normalizeCampaignState({
    sessionCode: 'NPC-UNIT',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 2,
      abilities: { str: 16, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
      attackBonus: 7, damageDice: 6, damageBonus: 2, x: 0, y: 1,
    }],
    enemies: [{
      id: 'wolf', hp: 20, maxHp: 20, armor: 11, speed: 10, attackBonus: 4, damageDice: 4, damageBonus: 1,
      abilities: { str: 14, dex: 12, con: 12, int: 4, wis: 12, cha: 6 }, x: 3, y: 1, alive: true,
    }],
    scene: { turn: 1, cells: cells() },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'wolf', total: 10 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          wolf: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
  return normalizeCampaignState({ ...state, ...overrides })
}

function dice(values) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `roll-${++id}`, now: () => '2026-07-12T00:00:00.000Z' })
}

test('server-authoritative attack ignores client combat numbers and uses persisted profile', () => {
  const state = fixture()
  state.enemies[0].x = 1
  state.mechanics.positions.wolf = { x: 1, y: 1 }
  const result = resolveCommand({
    command_type: 'MakeAttack', actor_id: 'hero', target_id: 'wolf', server_authoritative: true,
    attack_modifier: 100, armor_class: 0, damage_expression: '100d100+10000', damage_type: 'force',
  }, state, { diceService: dice([10, 4]), context: { serverAuthoritativeCombat: true } })
  const attack = result.events.find((event) => event.event_type === 'AttackResolved')
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(attack.payload.modifier, 7)
  assert.equal(attack.payload.armor_class, 11)
  assert.equal(attack.payload.damage_expression, '1d6+2')
  assert.equal(attack.payload.damage_type, 'slashing')
  assert.equal(damage.payload.raw_amount, 6)
  assert.equal(result.command.attack_modifier, 7)
  assert.equal(result.command.damage_expression, '1d6+2')
  assert.ok(damage.source_rule_ids.includes(RULE_IDS.damage))
})

test('server-authoritative attack cannot bypass combat initiative', () => {
  const state = fixture({ mechanics: { combat: { active: false } } })
  state.enemies[0].x = 1
  state.mechanics.positions.wolf = { x: 1, y: 1 }
  assert.throws(() => resolveCommand({
    command_type: 'MakeAttack', actor_id: 'hero', target_id: 'wolf', server_authoritative: true,
  }, state, { diceService: dice([20, 6]), context: { serverAuthoritativeCombat: true } }),
  (error) => error instanceof RulesValidationError && error.code === 'COMBAT_NOT_ACTIVE')
})

test('movement path and cumulative speed are enforced from authoritative state', () => {
  let state = fixture()
  state.enemies[0].x = 8
  state.mechanics.positions.wolf = { x: 8, y: 1 }
  const first = resolveCommand({ command_type: 'MoveActor', actor_id: 'hero', to: { x: 6, y: 1 }, server_authoritative: true }, state, {
    diceService: dice([]), context: { serverAuthoritativeCombat: true },
  })
  state = first.events.reduce(applyGameEvent, state)
  assert.equal(state.mechanics.combat.action_economy.hero.movement_spent, 30)
  assert.deepEqual(state.mechanics.positions.hero, { x: 6, y: 1 })
  assert.throws(() => resolveCommand({ command_type: 'MoveActor', actor_id: 'hero', to: { x: 5, y: 1 }, server_authoritative: true }, state, {
    diceService: dice([]), context: { serverAuthoritativeCombat: true },
  }), (error) => error instanceof RulesValidationError && error.code === 'SPEED_EXCEEDED')
})

test('authoritative movement rejects unrevealed and unsupported terrain', () => {
  const state = fixture()
  state.scene.cells = state.scene.cells.map((cell) => cell.x === 1 && cell.y === 1 ? { ...cell, type: 'water' } : cell)
  assert.throws(() => resolveCommand({
    command_type: 'MoveActor', actor_id: 'hero', to: { x: 1, y: 1 }, server_authoritative: true,
  }, state, { diceService: dice([]), context: { serverAuthoritativeCombat: true } }),
  (error) => error instanceof RulesValidationError && error.code === 'INVALID_DESTINATION')
})

test('actor can leave unsupported terrain but cannot enter it again', () => {
  let state = fixture()
  state.scene.cells = state.scene.cells.map((cell) => cell.x === 0 && cell.y === 1 ? { ...cell, type: 'water' } : cell)
  const escaped = resolveCommand({
    command_type: 'MoveActor', actor_id: 'hero', to: { x: 0, y: 0 }, server_authoritative: true,
  }, state, { diceService: dice([]), context: { serverAuthoritativeCombat: true } })
  state = escaped.events.reduce(applyGameEvent, state)
  assert.equal(escaped.events[0].payload.movement_spent, 5)
  assert.deepEqual(state.mechanics.positions.hero, { x: 0, y: 0 })
  assert.throws(() => resolveCommand({
    command_type: 'MoveActor', actor_id: 'hero', to: { x: 0, y: 1 }, server_authoritative: true,
  }, state, { diceService: dice([]), context: { serverAuthoritativeCombat: true } }),
  (error) => error instanceof RulesValidationError && error.code === 'INVALID_DESTINATION')
})

test('NPC scheduler moves, attacks and ends turns until control returns to a living PC', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-npc-turn-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const state = fixture()
  state.mechanics.combat.active_index = 1
  const eventStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaign_id: 'NPC-UNIT', initial_state: state })
  const result = await runNpcTurnScheduler({
    campaignId: 'NPC-UNIT',
    eventStore,
    rulesEngine: new RulesEngine({ diceService: dice([15, 3]) }),
  })
  assert.equal(result.turns.length, 1)
  assert.deepEqual(result.turns[0].commands, ['MoveActor', 'MakeAttack', 'EndTurn'])
  assert.deepEqual([result.state.enemies[0].x, result.state.enemies[0].y], [1, 1])
  assert.equal(result.state.players[0].hp, 26)
  assert.equal(result.state.activePlayerId, 'hero')
  assert.equal(result.state.tacticalTurn.actorId, 'hero')
  assert.equal(result.state.tacticalTurn.movementSpent, 0)
  assert.deepEqual(result.events.filter((event) => event.actor_id === 'wolf').map((event) => event.event_type), [
    'ActorMoved', 'AttackResolved', 'DieRolled', 'DamageApplied', 'TurnEnded', 'TurnStarted',
  ])
})

test('NPC prefers a reachable target over a geometrically closer unreachable one', () => {
  const state = fixture()
  state.players.push({
    ...state.players[0], id: 'stranded', hp: 20, maxHp: 20, x: 2, y: 1,
  })
  state.partyMemberIds.push('stranded')
  state.mechanics.positions.stranded = { x: 2, y: 1 }
  state.scene.cells = state.scene.cells.map((cell) => cell.x === 2 && cell.y === 1 ? { ...cell, type: 'water' } : cell)
  state.enemies[0].x = 6
  state.enemies[0].y = 1
  state.mechanics.positions.wolf = { x: 6, y: 1 }
  const commands = planNpcTurn(state, 'wolf')
  assert.equal(commands[0].command_type, 'MoveActor')
  assert.equal(commands.at(-1).command_type, 'EndTurn')
})

test('scheduler closes combat automatically when the last enemy is defeated', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-npc-terminal-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const state = fixture()
  state.enemies[0].hp = 0
  state.enemies[0].alive = false
  const eventStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaign_id: 'NPC-TERMINAL', initial_state: state })
  const result = await runNpcTurnScheduler({
    campaignId: 'NPC-TERMINAL', eventStore,
    rulesEngine: new RulesEngine({ diceService: dice([]) }),
    advanceNpc: false,
  })
  assert.equal(result.state.mechanics.combat.active, false)
  assert.equal(result.turns[0].kind, 'combat-end')
  assert.equal(result.turns[0].reason, 'enemies_defeated')
  assert.equal(result.events.at(-1).event_type, 'CombatEnded')
})

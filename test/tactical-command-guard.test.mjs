import assert from 'node:assert/strict'
import test from 'node:test'

import { canIssueUiTacticalCommand } from '../src/tactical-command-guard.mjs'

const combat = {
  active: true,
  reaction_window: {
    actor_id: 'hero-guest',
    action_ids: ['opportunity-attack'],
  },
}

test('UI turn guard permits only the reaction owner to answer an off-turn reaction window', () => {
  assert.equal(canIssueUiTacticalCommand(combat, {
    command_type: 'UseCombatAction', actor_id: 'hero-guest', action_id: 'opportunity-attack',
  }, 'enemy-active'), true)
  assert.equal(canIssueUiTacticalCommand(combat, {
    command_type: 'UseCombatAction', actor_id: 'hero-guest', action_id: 'decline-reaction',
  }, 'enemy-active'), true)
  assert.equal(canIssueUiTacticalCommand(combat, {
    command_type: 'UseCombatAction', actor_id: 'hero-other', action_id: 'decline-reaction',
  }, 'enemy-active'), false)
  assert.equal(canIssueUiTacticalCommand(combat, {
    command_type: 'UseCombatAction', actor_id: 'hero-guest', action_id: 'forged-reaction',
  }, 'enemy-active'), false)
})

test('UI turn guard continues to reject ordinary off-turn commands', () => {
  assert.equal(canIssueUiTacticalCommand(combat, {
    command_type: 'MoveActor', actor_id: 'hero-guest', to: { x: 1, y: 1 },
  }, 'enemy-active'), false)
  assert.equal(canIssueUiTacticalCommand(combat, {
    command_type: 'EndTurn', actor_id: 'hero-guest',
  }, 'enemy-active'), false)
  assert.equal(canIssueUiTacticalCommand(combat, {
    command_type: 'MakeAttack', actor_id: 'hero-active', target_id: 'enemy-active',
  }, 'hero-active'), true)
})

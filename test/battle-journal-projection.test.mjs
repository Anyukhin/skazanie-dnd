import assert from 'node:assert/strict'
import test from 'node:test'

import { applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

function state() {
  return normalizeCampaignState({
    sessionCode: 'JOURNAL-1',
    players: [{ id: 'hero', character: 'Адара', hp: 12, maxHp: 20, armor: 14, abilities: {} }],
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 10, maxHp: 10, armor: 13, alive: true }],
    scene: { turn: 2, cells: [] },
    battleLog: [],
    mechanics: { combat: { active: true, round: 2, initiative: [], active_index: -1, action_economy: {}, reaction_window: null } },
  })
}

function apply(current, event_type, payload, target = 'goblin') {
  return applyGameEvent(current, {
    event_id: `event-${event_type}-${current.state_version}`,
    command_id: 'spell-command',
    event_type,
    actor_id: 'hero',
    target_ids: [target],
    payload,
  })
}

test('спасбросок и последующий урон заклинания образуют одну понятную запись', () => {
  let current = apply(state(), 'SpellCast', { spell_id: 'burning-hands', name: 'Огненные ладони', action_type: 'action' })
  current = apply(current, 'SpellSavingThrowResolved', {
    spell_id: 'burning-hands', ability: 'dex', kept: 7, modifier: 2, total: 9, difficulty: 13, saved: false,
  })
  current = apply(current, 'DamageApplied', {
    spell_id: 'burning-hands', damage_type: 'fire', applied_amount: 6, hp_before: 10, hp_after: 4,
  })

  assert.equal(current.battleLog.length, 2)
  assert.deepEqual(current.battleLog[1], {
    id: 'event-SpellSavingThrowResolved-1', sceneTurn: 2, round: 2, type: 'spell-save',
    actorId: 'hero', actorKind: 'player', targetId: 'goblin', spellId: 'burning-hands', spellName: 'Огненные ладони', ability: 'dex',
    roll: { die: 7, modifier: 2, total: 9, difficulty: 13, hit: false }, result: 'failure',
    automaticSuccess: false, immunity: null, damage: 6, damageType: 'fire', hpBefore: 10, hpAfter: 4,
  })
})

test('прямой магический урон и лечение не теряются в боевом журнале', () => {
  let current = apply(state(), 'DamageApplied', {
    spell_id: 'magic-missile', damage_type: 'force', applied_amount: 5, hp_before: 10, hp_after: 5,
  })
  current = apply(current, 'HealingApplied', {
    spell_id: 'healing-word', applied_amount: 4, hp_before: 12, hp_after: 16,
  }, 'hero')

  assert.equal(current.battleLog[0].type, 'spell-damage')
  assert.equal(current.battleLog[0].damage, 5)
  assert.equal(current.battleLog[1].type, 'healing')
  assert.equal(current.battleLog[1].healing, 4)
  assert.deepEqual([current.battleLog[1].hpBefore, current.battleLog[1].hpAfter], [12, 16])
})

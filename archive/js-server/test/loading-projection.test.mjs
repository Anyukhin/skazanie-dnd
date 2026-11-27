import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

test('публичная экономика не раскрывает внутренние ID заряженного оружия', () => {
  const state = normalizeCampaignState({
    sessionCode: 'LOADING-PRIVACY', partyMemberIds: ['hero'],
    players: [{ id: 'hero', hp: 10, maxHp: 10, inventory: [], x: 0, y: 0 }],
    enemies: [{ id: 'enemy', name: 'Стрелок', hp: 10, maxHp: 10, alive: true, x: 1, y: 0 }],
    scene: { cells: [{ x: 0, y: 0, type: 'floor', revealed: true }, { x: 1, y: 0, type: 'floor', revealed: true }] },
    mechanics: { combat: { active: true, initiative: [{ actor_id: 'enemy', total: 20 }, { actor_id: 'hero', total: 10 }],
      active_index: 0, action_economy: {
        enemy: { action: false, loading_weapon_item_ids: { action: ['secret-crossbow-instance'], bonus_action: [], reaction: [] } },
        hero: { action: true, loading_weapon_item_ids: { action: ['hero-crossbow-instance'], bonus_action: [], reaction: [] } },
      } } },
  })
  const before = structuredClone(state)
  const room = campaignStateForViewer(state, { role: 'player', heroIds: ['hero'] }, 'hero')
  assert.equal(room.mechanics.combat.action_economy.enemy.action, false)
  assert.equal(room.mechanics.combat.action_economy.hero.action, true)
  assert.doesNotMatch(JSON.stringify(room.mechanics.combat), /secret-crossbow-instance|hero-crossbow-instance|loading_weapon_item_ids/)
  assert.deepEqual(state, before)
  const admin = campaignStateForViewer(state, { role: 'admin' }, 'hero')
  assert.deepEqual(admin.mechanics.combat.action_economy.enemy.loading_weapon_item_ids.action, ['secret-crossbow-instance'])
})

test('публичная очередь action не раскрывает loading-ID и opaque frame-ID', () => {
  const state = normalizeCampaignState({
    sessionCode: 'ACTION-QUEUE-PRIVACY', partyMemberIds: ['hero'],
    players: [{ id: 'hero', hp: 10, maxHp: 10, inventory: [], x: 0, y: 0 }],
    enemies: [{ id: 'enemy', name: 'Стрелок', hp: 10, maxHp: 10, alive: true, x: 1, y: 0 }],
    scene: { cells: [{ x: 0, y: 0, type: 'floor', revealed: true }, { x: 1, y: 0, type: 'floor', revealed: true }] },
    mechanics: { combat: { active: true, initiative: [{ actor_id: 'enemy', total: 20 }, { actor_id: 'hero', total: 10 }],
      active_index: 0, action_economy: {
        enemy: {
          action: true,
          attack_action_id: 'attack-action:enemy-secret-command',
          attack_action_stack: [{
            id: 'turn-action:enemy-secret-event:normal', kind: 'normal', limit: 2, attacks_used: 1,
            loading_weapon_item_ids: { action: ['enemy-crossbow-instance'], bonus_action: [], reaction: [] },
          }],
        },
        hero: {
          action: true,
          attack_action_id: 'attack-action:hero-command',
          attack_action_stack: [{
            id: 'turn-action:hero-event:normal', kind: 'normal', limit: 2, attacks_used: 1,
            loading_weapon_item_ids: { action: ['hero-crossbow-instance'], bonus_action: [], reaction: [] },
          }],
        },
      } } },
  })
  const player = campaignStateForViewer(state, { role: 'player', heroIds: ['hero'] }, 'hero')
  for (const economy of Object.values(player.mechanics.combat.action_economy)) {
    assert.equal(economy.attack_action_id, undefined)
    assert.equal(economy.attack_action_stack[0].id, undefined)
    assert.equal(economy.attack_action_stack[0].loading_weapon_item_ids, undefined)
  }
  const admin = campaignStateForViewer(state, { role: 'admin' }, 'hero')
  assert.equal(admin.mechanics.combat.action_economy.enemy.attack_action_id, 'attack-action:enemy-secret-command')
  assert.deepEqual(admin.mechanics.combat.action_economy.enemy.attack_action_stack[0].loading_weapon_item_ids.action, ['enemy-crossbow-instance'])
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'

const user = { role: 'player', heroIds: ['hero'] }
const state = () => normalizeCampaignState({
  sessionCode: 'MASS-CURE-PRIVACY', partyMemberIds: ['hero'],
  players: [{ id: 'hero', hp: 10, maxHp: 20, x: 0, y: 0, inventory: [] }],
  actors: [{ id: 'secret-summon', kind: 'summon', visibility: 'gm_only', hp: 5, maxHp: 20, x: 1, y: 0 }],
  scene: { cells: [{ x: 0, y: 0, type: 'floor', revealed: true }, { x: 1, y: 0, type: 'floor', revealed: true }] },
})

test('массовое лечение скрывает идентификатор и числа скрытой цели, сохраняя видимый центр волны', () => {
  const events = [
    { event_id: 'cast', event_type: 'SpellCast', actor_id: 'hero', target_ids: ['secret-summon', 'hero'],
      payload: { spell_id: 'mass-cure-wounds', target_id: 'secret-summon', to: { x: 0, y: 0 }, radius_feet: 30 } },
    { event_id: 'secret-heal', event_type: 'HealingApplied', actor_id: 'hero', target_ids: ['secret-summon'],
      payload: { spell_id: 'mass-cure-wounds', applied_amount: 15, hp_before: 5, hp_after: 20 } },
    { event_id: 'visible-heal', event_type: 'HealingApplied', actor_id: 'hero', target_ids: ['hero'],
      payload: { spell_id: 'mass-cure-wounds', applied_amount: 10, hp_before: 10, hp_after: 20 } },
  ]
  const original = structuredClone(events)
  const projected = mechanicsForViewer(events, user, 'hero', state())
  assert.deepEqual(projected.map((event) => event.event_id), ['cast', 'visible-heal'])
  assert.deepEqual(projected[0].target_ids, ['hero'])
  assert.deepEqual(projected[0].payload.to, { x: 0, y: 0 })
  assert.equal(projected[0].payload.target_id, undefined)
  assert.doesNotMatch(JSON.stringify(projected), /secret-summon/)
  assert.deepEqual(events, original)
})

test('после reconnect журнал массового лечения не раскрывает скрытую первую цель', () => {
  const input = state()
  input.battleLog = [{ id: 'cast', type: 'spell', spellId: 'mass-cure-wounds', actorId: 'hero',
    targetId: 'secret-summon', targetIds: ['secret-summon', 'hero'],
    from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, area: { x: 0, y: 0, radiusFeet: 30 } }]
  const projected = campaignStateForViewer(input, user, 'hero')
  assert.deepEqual(projected.battleLog[0].targetIds, ['hero'])
  assert.equal(projected.battleLog[0].targetId, 'hero')
  assert.deepEqual(projected.battleLog[0].to, { x: 0, y: 0 })
  assert.doesNotMatch(JSON.stringify(projected.battleLog), /secret-summon/)
})

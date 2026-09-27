import assert from 'node:assert/strict'
import test from 'node:test'

import { npcHarmEventDrafts } from '../server/npc-positioning.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents } from '../server/rules-engine.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'

function stateWithTemporaryHp(amount = 10) {
  return normalizeCampaignState({
    sessionCode: 'DESTRUCTIVE-WAVE-NPC-TEMP',
    ruleset_id: 'srd_5_2_1',
    players: [{ id: 'hero', character: 'Герой', hp: 20, maxHp: 20, x: 1, y: 1, inventory: [] }],
    enemies: [],
    scene: {
      location: 'market', location_id: 'market', turn: 1,
      cells: Array.from({ length: 36 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true })),
    },
    social: { npcs: [{ id: 'villager', name: 'Житель', role: 'житель', location: 'market', visibility: 'party', available: true }] },
    npc_world: {
      schema_version: 3,
      placements: [{ npc_id: 'villager', location_id: 'market', x: 2, y: 1, placement_reason: 'destructive-wave-temp-test' }],
      vitals: { villager: { hp: 100, max_hp: 100, alive: true } },
      stances: {}, inventories: {}, profiles: {},
    },
    mechanics: {
      temporary_hp: { villager: amount },
      positions: { hero: { x: 1, y: 1 }, villager: { x: 2, y: 1 } },
    },
  })
}

function harm(state, components, temporaryHpBefore, temporaryHpAfter) {
  return npcHarmEventDrafts(state, {
    npcId: 'villager',
    amount: components.reduce((total, component) => total + component.applied_amount, 0),
    damageType: 'mixed',
    damageComponents: components,
    temporaryHpBefore,
    temporaryHpAfter,
    temporaryHpAbsorbed: temporaryHpBefore - temporaryHpAfter,
    sourceEventId: 'spell-cast:wave',
    sourceActorId: 'hero',
    trigger: 'area-spell',
    commandId: 'wave-temp-test',
  })
}

test('absorbed-only NPC harm is committed and replayed with the temporary pool', () => {
  const initial = stateWithTemporaryHp(10)
  const events = harm(initial, [
    { damage_type: 'thunder', raw_amount: 15, applied_amount: 0, temporary_hp_absorbed: 7 },
    { damage_type: 'radiant', raw_amount: 5, applied_amount: 0, temporary_hp_absorbed: 3 },
  ], 10, 0)
  const harmed = events.find((event) => event.event_type === 'NpcHarmed')
  assert.ok(harmed)
  assert.equal(harmed.payload.applied_amount, 0)
  assert.equal(harmed.payload.hp_before, 100)
  assert.equal(harmed.payload.hp_after, 100)
  assert.equal(harmed.payload.temporary_hp_absorbed, 10)
  const replayed = replayEvents(initial, events)
  assert.equal(replayed.npc_world.vitals.villager.hp, 100)
  assert.equal(replayed.mechanics.temporary_hp.villager, 0)
  assert.deepEqual(replayed, events.reduce(applyGameEvent, initial))
})

test('mixed NPC harm carries both typed parts and consumes temporary HP once', () => {
  const initial = stateWithTemporaryHp(10)
  const events = harm(initial, [
    { damage_type: 'thunder', raw_amount: 15, applied_amount: 0, temporary_hp_absorbed: 7 },
    { damage_type: 'radiant', raw_amount: 20, applied_amount: 17, temporary_hp_absorbed: 3 },
  ], 10, 0)
  const harmed = events.find((event) => event.event_type === 'NpcHarmed')
  assert.ok(harmed)
  assert.equal(harmed.payload.applied_amount, 17)
  assert.deepEqual(harmed.payload.damage_components.map(({ damage_type, applied_amount, temporary_hp_absorbed }) => ({ damage_type, applied_amount, temporary_hp_absorbed })), [
    { damage_type: 'thunder', applied_amount: 0, temporary_hp_absorbed: 7 },
    { damage_type: 'radiant', applied_amount: 17, temporary_hp_absorbed: 3 },
  ])
  const replayed = replayEvents(initial, events)
  assert.equal(replayed.npc_world.vitals.villager.hp, 83)
  assert.equal(replayed.mechanics.temporary_hp.villager, 0)
})

test('legacy NpcHarmed without temporary fields leaves the pool unchanged', () => {
  const initial = stateWithTemporaryHp(10)
  const event = {
    event_type: 'NpcHarmed', event_id: 'legacy-npc-harm', command_id: 'legacy-npc-harm',
    target_ids: ['villager'], visibility: 'party',
    payload: { npc_id: 'villager', hp_before: 100, hp_after: 90, max_hp: 100, raw_amount: 10, applied_amount: 10, damage_type: 'slashing' },
  }
  const replayed = applyGameEvent(initial, event)
  assert.equal(replayed.npc_world.vitals.villager.hp, 90)
  assert.equal(replayed.mechanics.temporary_hp.villager, 10)
})

test('NPC temporary HP fields stay private in the event projection', () => {
  const state = stateWithTemporaryHp(10)
  const [event] = harm(state, [
    { damage_type: 'thunder', raw_amount: 15, applied_amount: 0, temporary_hp_absorbed: 7 },
    { damage_type: 'radiant', raw_amount: 20, applied_amount: 17, temporary_hp_absorbed: 3 },
  ], 10, 0)
  const projected = mechanicsForViewer([event], { role: 'player', heroIds: ['hero'] }, 'hero', state)[0]
  assert.equal(projected.payload.hp_before, undefined)
  assert.equal(projected.payload.hp_after, undefined)
  assert.equal(projected.payload.temporary_hp_before, undefined)
  assert.equal(projected.payload.temporary_hp_after, undefined)
  assert.equal(projected.payload.temporary_hp_absorbed, undefined)
  assert.equal(projected.payload.damage_components[0].temporary_hp_absorbed, undefined)
  assert.equal(projected.payload.applied_amount, 17)
  const room = campaignStateForViewer(state, { role: 'player', heroIds: ['hero'] }, 'hero')
  assert.equal(Object.hasOwn(room.mechanics.temporary_hp, 'villager'), false)
  assert.equal(campaignStateForViewer(state, { role: 'admin' }, 'hero').mechanics.temporary_hp.villager, 10)
})

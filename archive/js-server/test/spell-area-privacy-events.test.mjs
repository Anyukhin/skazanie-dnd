import assert from 'node:assert/strict'
import test from 'node:test'

import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'

const user = { role: 'player', heroIds: ['hero'] }

function state(effect) {
  return {
    sessionCode: 'AREA-PRIVACY-CANDIDATE',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Герой', hp: 10, maxHp: 10, x: 0, y: 0, inventory: [] }],
    actors: [],
    enemies: [],
    scene: { cells: [
      { x: 0, y: 0, type: 'floor', revealed: true },
      { x: 1, y: 0, type: 'floor', revealed: false },
      { x: 2, y: 0, type: 'floor', revealed: false },
      { x: 3, y: 0, type: 'floor', revealed: false },
    ] },
    mechanics: {
      active_effects: effect ? [effect] : [],
      concentration: effect ? { [effect.source_actor ?? 'hidden-npc']: { effect_id: effect.effect_id } } : {},
      conditions: {},
    },
  }
}

const hiddenEdge = {
  id: 'silent-image:secret-command', effect_id: 'silent-image:secret-command', spell_id: 'silent-image',
  source_actor: 'hidden-npc', center: { x: 1, y: 0 }, radius_feet: 15, area_shape: 'cube',
  area_side_feet: 20, save_dc: 17, difficult_terrain: true,
}

test('полностью скрытая область и её SpellAreaCreated не попадают в projection', () => {
  const input = state({ ...hiddenEdge, center: { x: 3, y: 0 }, radius_feet: 5 })
  const room = campaignStateForViewer(input, user, 'hero')
  assert.deepEqual(room.mechanics.active_effects, [])
  const events = mechanicsForViewer([{ event_type: 'SpellAreaCreated', actor_id: 'hidden-npc', payload: { effect: input.mechanics.active_effects[0] } }], user, 'hero', input)
  assert.deepEqual(events, [])
  assert.doesNotMatch(JSON.stringify({ room, events }), /silent-image|hidden-npc|secret-command/u)
})

test('видимый край сохраняет клетки и difficult terrain, но получает стабильный нейтральный ID', () => {
  const first = campaignStateForViewer(state(hiddenEdge), user, 'hero')
  const second = campaignStateForViewer(state(hiddenEdge), user, 'hero')
  const effect = first.mechanics.active_effects[0]
  assert.deepEqual(first.mechanics.concentration, {})
  assert.deepEqual(effect.cells, [{ x: 0, y: 0 }])
  assert.equal(effect.difficult_terrain, true)
  assert.equal(effect.spell_id, '')
  assert.match(effect.effect_id, /^area-public-v1:[a-f0-9]{24}$/u)
  assert.equal(effect.effect_id, second.mechanics.active_effects[0].effect_id)
  assert.equal(effect.id, effect.effect_id)
  assert.equal(effect.center, undefined)
  assert.equal(effect.source_actor, undefined)
  assert.doesNotMatch(JSON.stringify(effect), /silent-image|hidden-npc|secret-command/u)
})

test('известная область сохраняет renderer fields', () => {
  const known = { ...hiddenEdge, id: 'darkness:known', effect_id: 'darkness:known', spell_id: 'darkness', source_actor: 'hero', center: { x: 0, y: 0 }, concentration: true }
  const room = campaignStateForViewer(state(known), user, 'hero')
  const effect = room.mechanics.active_effects[0]
  assert.match(effect.effect_id, /^area-public-v1:[a-f0-9]{24}$/u)
  assert.equal(effect.id, effect.effect_id)
  assert.equal(effect.spell_id, 'darkness')
  assert.equal(effect.source_actor, 'hero')
  assert.deepEqual(effect.center, { x: 0, y: 0 })
  assert.deepEqual(effect.cells, [{ x: 0, y: 0 }])
  assert.equal(effect.difficult_terrain, true)
  assert.equal(effect.concentration, true)
  assert.equal(effect.radius_feet, 15)
  assert.equal(effect.area_shape, 'cube')
  assert.equal(effect.area_side_feet, 20)
  assert.equal(room.mechanics.concentration.hero.effect_id, effect.effect_id)
})

test('SpellAreaCreated и SpellAreaRemoved не выдают hidden payload или исходный ID', () => {
  const input = state(hiddenEdge)
  const created = mechanicsForViewer([{ event_type: 'SpellAreaCreated', actor_id: 'hidden-npc', payload: { effect: hiddenEdge } }], user, 'hero', input)
  assert.equal(created[0].payload.effect.spell_id, '')
  assert.notEqual(created[0].payload.effect.effect_id, hiddenEdge.effect_id)
  assert.equal(created[0].actor_id, undefined)
  const removed = mechanicsForViewer([{ event_type: 'SpellAreaRemoved', actor_id: 'hidden-npc', payload: { effect_id: hiddenEdge.effect_id, spell_id: hiddenEdge.spell_id, save_dc: 17 } }], user, 'hero', input)
  assert.equal(removed[0].payload.effect_id, created[0].payload.effect.effect_id)
  assert.equal(removed[0].payload.spell_id, undefined)
  assert.doesNotMatch(JSON.stringify({ created, removed }), /silent-image|hidden-npc|secret-command|save_dc/u)
})

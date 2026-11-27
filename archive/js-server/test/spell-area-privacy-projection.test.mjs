import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { campaignStateForViewer } from '../server/viewer-projection.mjs'

const player = { role: 'player', heroIds: ['hero'] }

function state() {
  return {
    sessionCode: 'PROJECTION-16',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Герой', hp: 10, maxHp: 10, x: 0, y: 0, inventory: [] }],
    enemies: [],
    actors: [],
    scene: {
      title: 'Скрытая комната', location: 'Скрытая комната',
      cells: [
        { x: 0, y: 0, type: 'floor', revealed: true },
        { x: 1, y: 0, type: 'floor', revealed: false },
        { x: 2, y: 0, type: 'floor', revealed: false },
        { x: 3, y: 0, type: 'floor', revealed: false },
      ],
    },
    mechanics: {
      active_effects: [{
        id: 'silent-image:secret-command', effect_id: 'silent-image:secret-command',
        spell_id: 'silent-image', source_actor: 'hidden-npc', center: { x: 30, y: 0 },
        radius_feet: 15, area_shape: 'cube', save_dc: 17,
      }],
      concentration: { 'hidden-npc': { effect_id: 'silent-image:secret-command' } },
      conditions: {},
    },
  }
}

test('игрок не получает длящийся эффект и концентрацию скрытого NPC из room projection', () => {
  const room = campaignStateForViewer(state(), player, 'hero')
  assert.deepEqual(room.mechanics.active_effects, [])
  assert.deepEqual(room.mechanics.concentration, {})
  assert.doesNotMatch(JSON.stringify(room), /silent-image:secret-command|hidden-npc/u)
})

test('видимый эффект сохраняет только поля, нужные persistent projection', () => {
  const input = state()
  input.scene.cells[1].revealed = true
  input.mechanics.active_effects = [{
    id: 'darkness:visible-command', effect_id: 'darkness:visible-command', spell_id: 'darkness',
    source_actor: 'hero', center: { x: 1, y: 0 }, radius_feet: 15, area_shape: 'sphere', save_dc: 18,
    hidden_rule_note: 'server-only', difficult_terrain: true, concentration: true,
  }]
  input.mechanics.concentration = {
    hero: { effect_id: 'darkness:visible-command', source_rule_ids: ['server-only'] },
    'hidden-npc': { effect_id: 'silent-image:secret-command' },
  }
  const room = campaignStateForViewer(input, player, 'hero')
  const areaId = room.mechanics.active_effects[0].id
  assert.match(areaId, /^area-public-v1:[a-f0-9]{24}$/u)
  assert.deepEqual(room.mechanics.active_effects, [{
    id: areaId, effect_id: areaId, spell_id: 'darkness',
    source_actor: 'hero', center: { x: 1, y: 0 }, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    radius_feet: 15, area_shape: 'sphere', difficult_terrain: true, concentration: true,
  }])
  assert.deepEqual(room.mechanics.concentration, { hero: { effect_id: areaId } })
  assert.doesNotMatch(JSON.stringify(room), /server-only|silent-image:secret-command|hidden-npc/u)
})

test('видимый край области остаётся на карте, не раскрывая скрытый центр и источник', () => {
  const input = state()
  input.mechanics.active_effects[0].center = { x: 2, y: 0 }
  const room = campaignStateForViewer(input, player, 'hero')
  assert.equal(room.mechanics.active_effects.length, 1)
  assert.deepEqual(room.mechanics.active_effects[0].cells, [{ x: 0, y: 0 }])
  assert.equal(room.mechanics.active_effects[0].center, undefined)
  assert.equal(room.mechanics.active_effects[0].source_actor, undefined)
  assert.equal(room.mechanics.active_effects[0].save_dc, undefined)
  assert.equal(room.mechanics.active_effects[0].spell_id, '')
  assert.doesNotMatch(JSON.stringify(room.mechanics.active_effects), /silent-image|secret-command|hidden-npc/u)
  assert.deepEqual(room.mechanics.concentration, {})
})

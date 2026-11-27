import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalCombatSpellFor } from '../server/combat-spells.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { createTacticalMap, serializeTacticalMap, setCell, setDoor } from '../server/tactical-map.mjs'
import { normalizeCampaignState, positionInEffect, replayEvents, resolveCommand, spellTargetsAt } from '../server/rules-engine.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'

const VERSION = 'circle-grid-v2'
function field() {
  const map = createTacticalMap({ width: 22, height: 22, locationId: 'circular-pilot', fill: { passable: true, revealed: true, material: 'stone' } })
  return normalizeCampaignState({
    sessionCode: 'CIRCLE-PILOT', ruleset_id: 'dnd_5e_2014', partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Лира', characterClass: 'wizard', level: 5, hp: 30, maxHp: 30, armor: 12,
      speed: 30, abilities: { int: 18, wis: 10, dex: 12, con: 12 }, proficiency: 3, x: 1, y: 10,
      knownSpellIds: ['fireball'], preparedSpellIds: ['fireball'], inventory: [materializeCatalogItem('srd_5_2_1:component-pouch', { id: 'pouch' })] }],
    enemies: [
      { id: 'corner', name: 'В углу старого квадрата', hp: 20, maxHp: 20, x: 6, y: 6, alive: true },
      { id: 'edge', name: 'Внутри дуги', hp: 20, maxHp: 20, x: 8, y: 6, alive: true },
    ],
    scene: { map: serializeTacticalMap(map) },
    mechanics: { resources: { mage: { spell_slots_3: { current: 2, max: 2 } } },
      combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'mage', total: 20 }],
        action_economy: { mage: { action: true, bonus_action: true, reaction: true } } } },
  })
}
const command = () => ({ command_type: 'CastSpell', command_id: 'circle-fireball', actor_id: 'mage', spell_id: 'fireball', to: { x: 10, y: 10 }, slot_level: 3, server_authoritative: true })
const profile = () => canonicalCombatSpellFor('fireball', { rulesetId: 'dnd_5e_2014' })
function cast(state, input = command()) {
  let id = 0
  return resolveCommand(input, state, { diceService: new DiceService({ rng: new SequenceDiceRng(Array(50).fill(4)), idFactory: () => `circle-roll-${++id}` }), context: { allowedActorIds: ['mage'], serverAuthoritativeCombat: true } })
}

test('пилот 2014 использует круг, а профиль старого ruleset сохраняет прежнюю геометрию', () => {
  assert.equal(profile().areaGeometryVersion, VERSION)
  assert.equal(canonicalCombatSpellFor('fireball').areaGeometryVersion, undefined)
  const state = field()
  assert.deepEqual(spellTargetsAt(state, command(), profile()).map((actor) => actor.id), ['edge'])
  assert.deepEqual(spellTargetsAt(state, command(), { ...profile(), areaGeometryVersion: undefined }).map((actor) => actor.id), ['corner', 'edge'])
})

test('новый SpellCast сохраняет точку пересечения в событии, журнале и видимой проекции', () => {
  const state = field()
  const result = cast(state)
  const event = result.events.find((entry) => entry.event_type === 'SpellCast')
  assert.equal(event.payload.area_geometry_version, VERSION)
  assert.deepEqual(event.payload.area_grid_origin, { x: 10, y: 10 })
  assert.deepEqual(event.target_ids, ['edge'])
  const after = replayEvents(state, result.events)
  const user = { role: 'player', heroIds: ['mage'] }
  const view = campaignStateForViewer(after, user, 'mage')
  assert.equal(view.battleLog.find((entry) => entry.type === 'spell').area.geometryVersion, VERSION)
  assert.deepEqual(view.battleLog.find((entry) => entry.type === 'spell').area.gridOrigin, { x: 10, y: 10 })
  const [visible] = mechanicsForViewer([event], user, 'mage', after)
  assert.deepEqual(visible.payload.area_grid_origin, { x: 10, y: 10 })
  assert.deepEqual(replayEvents(state, result.events), after)
})

test('версия области берётся из профиля, поддельные поля команды не возвращают квадрат', () => {
  const state = field()
  const result = cast(state, { ...command(), area_geometry_version: 'legacy-grid-v1', area_grid_origin: { x: 6, y: 6 }, radius: 600 })
  const event = result.events.find((entry) => entry.event_type === 'SpellCast')
  assert.deepEqual(event.target_ids, ['edge'])
  assert.deepEqual(event.payload.area_grid_origin, { x: 10, y: 10 })
  assert.equal(event.payload.radius_feet, 20)
})

test('сохранённая область без версии остаётся квадратной; новая версия переживает replay', () => {
  const state = field()
  const legacy = { id: 'legacy-area', spell_id: 'test-area', center: { x: 10, y: 10 }, radius_feet: 20, area_shape: 'sphere', spreadsAroundCorners: false }
  const current = { ...legacy, id: 'circle-area', geometry_version: VERSION, grid_origin: { x: 10, y: 10 } }
  assert.equal(positionInEffect(state, { x: 6, y: 6 }, legacy), true)
  assert.equal(positionInEffect(state, { x: 6, y: 6 }, current), false)
  const restored = replayEvents(state, [{ event_type: 'SpellAreaCreated', actor_id: 'mage', payload: { effect: current } }])
  assert.equal(positionInEffect(restored, { x: 8, y: 6 }, restored.mechanics.active_effects[0]), true)
})

test('скрытый центр не выдаётся через новые поля геометрии', () => {
  const state = field()
  state.scene.cells = state.scene.cells.map((cell) => ({ ...cell, revealed: cell.x === 8 && cell.y === 6 }))
  const event = { event_type: 'SpellCast', actor_id: 'mage', target_ids: ['edge'], payload: { spell_id: 'fireball', to: { x: 10, y: 10 }, area_geometry_version: VERSION, area_grid_origin: { x: 10, y: 10 } } }
  const [visible] = mechanicsForViewer([event], { role: 'player', heroIds: ['mage'] }, 'mage', state)
  assert.equal(visible.payload.to, undefined)
  assert.equal(visible.payload.area_grid_origin, undefined)
  assert.equal(visible.payload.area_geometry_version, undefined)
})

test('круговая область проверяет стену, дверь и обход угла от нового origin', () => {
  const map = createTacticalMap({ width: 22, height: 22, locationId: 'circle-wall', fill: { passable: true, revealed: true } })
  setCell(map, 12, 10, { type: 'wall', passable: false })
  const state = field()
  state.scene = { map: serializeTacticalMap(map) }
  state.enemies = [{ id: 'beyond', name: 'За углом', hp: 20, maxHp: 20, x: 13, y: 10, alive: true }]
  const current = normalizeCampaignState(state)
  assert.equal(spellTargetsAt(current, command(), { ...profile(), spreadsAroundCorners: false }).length, 0)
  assert.deepEqual(spellTargetsAt(current, command(), profile()).map((actor) => actor.id), ['beyond'])
  setCell(map, 12, 10, { type: 'floor', passable: true })
  for (let y = 0; y < 22; y += 1) setDoor(map, { id: `barrier-${y}`, x: 12, y, dir: 'e', state: 'closed', blocksMove: true, blocksSight: true })
  const sealed = normalizeCampaignState({ ...current, scene: { map: serializeTacticalMap(map) } })
  assert.equal(spellTargetsAt(sealed, command(), profile()).length, 0)
})

test('крупная цель проверяет одну и ту же клетку для круга и линии воздействия', () => {
  const state = field()
  state.enemies = [{ id: 'large', name: 'Крупный', hp: 20, maxHp: 20, x: 5, y: 8, alive: true, footprint: { version: 1, size: 2 } }]
  assert.deepEqual(spellTargetsAt(state, command(), profile()).map((actor) => actor.id), ['large'])
  state.enemies[0].x = 4
  assert.deepEqual(spellTargetsAt(state, command(), profile()), [])
})

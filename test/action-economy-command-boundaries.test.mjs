import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { addProp, createTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'

const authoritative = (command) => ({ ...command, server_authoritative: true })

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `economy-boundary-${++id}`,
    now: () => '2026-09-26T12:00:00.000Z',
  })
}

function party() {
  const cells = Array.from({ length: 15 * 4 }, (_, index) => ({
    x: index % 15, y: Math.floor(index / 15), type: 'floor', revealed: true,
  }))
  return normalizeCampaignState({
    sessionCode: 'ACTION-ECONOMY-COMMAND-BOUNDARIES',
    partyMemberIds: ['mage', 'fighter'],
    players: [
      { id: 'mage', character: 'Маг', characterClass: 'wizard', level: 9, hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 4, abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 12, cha: 10 }, inventory: [], x: 1, y: 0 },
      { id: 'fighter', character: 'Воин', characterClass: 'fighter', level: 5, hp: 40, maxHp: 40, armor: 16, speed: 30, proficiency: 3, abilities: { str: 16, dex: 12, con: 16, int: 10, wis: 10, cha: 10 }, inventory: [
        materializeCatalogItem('srd_5_2_1:club', { id: 'club-main', quantity: 1, equipped: true }),
        materializeCatalogItem('srd_5_2_1:quarterstaff', { id: 'staff-alt', quantity: 1, equipped: false }),
      ], x: 1, y: 1 },
    ],
    enemies: [{ id: 'ogre', name: 'Огр', creature_type: 'giant', hp: 300, maxHp: 300, armor: 11, speed: 30, abilities: { str: 18, dex: 8, con: 16, int: 5, wis: 7, cha: 7 }, x: 2, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'mage', total: 20 }, { actor_id: 'fighter', total: 15 }, { actor_id: 'ogre', total: 8 }],
        action_economy: {
          mage: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          fighter: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          ogre: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const options = (values = []) => ({ diceService: dice(values), context: { serverAuthoritativeCombat: true, isAdmin: true } })

function endTurn(state) {
  const actorId = state.mechanics.combat.initiative[state.mechanics.combat.active_index].actor_id
  return replayEvents(state, resolveCommand(authoritative({ command_type: 'EndTurn', command_id: `end-${actorId}`, actor_id: actorId }), state, options([10, 10, 10])).events)
}

function hastedFighter() {
  const initial = party()
  const cast = resolveCommand(authoritative({ command_type: 'CastSpell', command_id: 'haste-fighter', actor_id: 'mage', spell_id: 'haste', target_id: 'fighter', target_ids: ['fighter'] }), initial, options())
  return endTurn(replayEvents(initial, cast.events))
}

test('IdentifyEnemy consumes the normal frame before Haste action, without granting a third action', () => {
  const state = hastedFighter()
  assert.equal(state.mechanics.combat.initiative[state.mechanics.combat.active_index].actor_id, 'fighter')
  assert.equal(state.mechanics.combat.action_economy.fighter.extra_actions, 1)

  const result = resolveCommand(authoritative({
    command_type: 'IdentifyEnemy', command_id: 'identify-after-haste', actor_id: 'fighter', target_id: 'ogre',
  }), state, options([18]))
  const afterIdentify = replayEvents(state, result.events)
  const dash = resolveCommand(authoritative({
    command_type: 'UseCombatAction', command_id: 'haste-dash-after-identify', actor_id: 'fighter', action_id: 'dash',
  }), afterIdentify, options())
  const afterDash = replayEvents(afterIdentify, dash.events)
  assert.equal(afterDash.mechanics.combat.action_economy.fighter.action, false)
  assert.deepEqual(afterDash.mechanics.combat.action_economy.fighter.attack_action_stack, [])
})

test('после обычного действия Ускорение оставляет только разрешённый рывок', () => {
  const state = hastedFighter()
  const first = resolveCommand(authoritative({
    command_type: 'IdentifyEnemy', command_id: 'identify-normal-frame', actor_id: 'fighter', target_id: 'ogre',
  }), state, options([18]))
  const afterIdentify = replayEvents(state, first.events)
  const withUnidentifiedTarget = normalizeCampaignState({
    ...afterIdentify,
    enemies: [...afterIdentify.enemies, { ...afterIdentify.enemies[0], id: 'ogre-two', x: 3, y: 1 }],
  })
  assert.throws(
    () => resolveCommand(authoritative({
      command_type: 'IdentifyEnemy', command_id: 'identify-haste-frame', actor_id: 'fighter', target_id: 'ogre-two',
    }), withUnidentifiedTarget, options([18])),
    (error) => error?.code === 'HASTE_ACTION_LIMIT',
    'поиск не должен тратить оставшееся действие Ускорения и бросать кость',
  )
  const dash = resolveCommand(authoritative({
    command_type: 'UseCombatAction', command_id: 'identify-haste-dash', actor_id: 'fighter', action_id: 'dash',
  }), withUnidentifiedTarget, options())
  const afterDash = replayEvents(withUnidentifiedTarget, dash.events)
  assert.equal(afterDash.mechanics.combat.action_economy.fighter.action, false)
})

test('редьюсер markerless action-события не оставляет Haste-кадр бесплатным', () => {
  const state = hastedFighter()
  const first = resolveCommand(authoritative({
    command_type: 'IdentifyEnemy', command_id: 'identify-before-markerless-event', actor_id: 'fighter', target_id: 'ogre',
  }), state, options([18]))
  const afterIdentify = replayEvents(state, first.events)
  const afterEquipment = replayEvents(afterIdentify, [{
    event_type: 'EquipmentChanged', event_id: 'markerless-haste-equipment', command_id: 'markerless-haste-equipment',
    actor_id: 'fighter', target_ids: ['fighter'],
    payload: { item_id: 'staff-alt', item_name: 'Посох', equipped: true, timing: 'action' },
  }])
  assert.equal(afterEquipment.mechanics.combat.action_economy.fighter.action, false)
})

function assertHasteFramesSpentAfter(state, command, commandId) {
  const first = resolveCommand(authoritative({ ...command, command_id: commandId }), state, options())
  const afterFirst = replayEvents(state, first.events)
  const dash = resolveCommand(authoritative({
    command_type: 'UseCombatAction', command_id: `${commandId}-haste-dash`, actor_id: 'fighter', action_id: 'dash',
  }), afterFirst, options())
  const afterDash = replayEvents(afterFirst, dash.events)
  assert.equal(afterDash.mechanics.combat.action_economy.fighter.action, false, `${commandId}: действие должно исчезнуть после обычной и Haste части`)
  assert.deepEqual(afterDash.mechanics.combat.action_economy.fighter.attack_action_stack, [], `${commandId}: очередь кадров не должна оставлять третье действие`)
}

test('ChangeWeapon и EquipItem не оставляют обычный кадр после действия Ускорения', () => {
  assertHasteFramesSpentAfter(hastedFighter(), {
    command_type: 'ChangeWeapon', actor_id: 'fighter', item_id: 'staff-alt', server_authoritative: true,
  }, 'change-weapon-after-haste')

  const state = hastedFighter()
  state.mechanics.combat.action_economy.fighter.object_interaction = false
  assertHasteFramesSpentAfter(state, {
    command_type: 'EquipItem', actor_id: 'fighter', item_id: 'club-main', equipped: false,
    server_authoritative: true,
  }, 'equip-item-after-haste')
})

test('осмотр объекта сцены не оставляет обычный кадр после действия Ускорения', () => {
  const state = hastedFighter()
  const map = createTacticalMap({
    width: 5, height: 3, locationId: 'action-economy-scene', seed: 'action-economy-scene',
    fill: { passable: true, revealed: true, material: 'stone' },
  })
  addProp(map, { id: 'prop-chest', assetId: 'chest', x: 2.5, y: 1.5, footprint: [{ x: 2, y: 1 }], interactive: true })
  const { cells: _cells, ...sceneWithoutCells } = state.scene
  const withMap = normalizeCampaignState({
    ...state,
    scene: { ...sceneWithoutCells, map: serializeTacticalMap(map) },
    mechanics: { ...state.mechanics, positions: { ...(state.mechanics.positions ?? {}), fighter: { x: 1, y: 1 }, ogre: { x: 2, y: 1 } } },
  })
  assertHasteFramesSpentAfter(withMap, {
    command_type: 'OperateSceneObject', actor_id: 'fighter', prop_id: 'prop-chest', intent: 'inspect', approach: 'hand',
    server_authoritative: true,
  }, 'inspect-after-haste')
})

test('новое action-событие без кадра в v2 состоянии не заходит в рекурсивный legacy fallback', () => {
  const state = hastedFighter()
  const economy = state.mechanics.combat.action_economy.fighter
  delete economy.attack_action_id
  delete economy.attack_action_kind
  delete economy.attack_action_limit
  delete economy.attacks_used
  delete economy.attacks_allowed
  delete economy.attack_action_stack
  const after = replayEvents(state, [{
    event_type: 'EquipmentChanged', event_id: 'missing-frame-equipment', command_id: 'missing-frame-equipment',
    actor_id: 'fighter', target_ids: ['fighter'],
    payload: { item_id: 'staff-alt', item_name: 'Посох', equipped: true, timing: 'action' },
  }])
  assert.equal(after.mechanics.combat.action_economy.fighter.action, false)
})

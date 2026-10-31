// Бой двумя оружиями (PHB 2014): лёгкое оружие ближнего боя во второй руке
// и удар им бонусным действием после действия Атака. Аудит боя 2026-10-13:
// экипировка второго оружия снимала первое, удара второй рукой не было вовсе.
import assert from 'node:assert/strict'
import test from 'node:test'

import { combatActionsFor } from '../server/combat-actions.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { fixedDice } from './kit/dice.mjs'

const weapon = (id, catalogId, equipped = false) => ({ id, catalog_id: catalogId, type: 'weapon', quantity: 1, equipped })

function arena({ styles = [], inventory = [weapon('sword', 'srd_5_2_1:shortsword', true), weapon('dagger', 'srd_5_2_1:dagger')], combat = false } = {}) {
  const cells = Array.from({ length: 30 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'TWO-WEAPONS', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Шорох', characterClass: 'fighter', level: 7, hp: 50, maxHp: 50, armor: 15, speed: 30, proficiency: 3,
      abilities: { str: 10, dex: 18, con: 12, int: 10, wis: 10, cha: 10 }, selectedFeatureIds: styles, inventory, x: 0, y: 1 }],
    enemies: [{ id: 'ogre', name: 'Огр', hp: 300, maxHp: 300, armor: 10, speed: 30, abilities: { str: 18, dex: 8, con: 16 }, x: 1, y: 1, alive: true }],
    scene: { title: 'Зал', location: 'Зал', turn: 1, cells },
    mechanics: combat ? { combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero', total: 15 }, { actor_id: 'ogre', total: 5 }],
      action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } } } : {},
  })
}
const run = (state, command, diceService = fixedDice(15)) => {
  const result = resolveCommand({ command_id: `c-${command.command_type}-${command.item_id ?? command.action_id ?? ''}`, ...command }, state, { diceService, context: { serverAuthoritativeCombat: true, allowedActorIds: ['hero'] } })
  return { result, state: result.events.reduce(applyGameEvent, state) }
}
const equipOffHand = (state, itemId = 'dagger') => run(state, { command_type: 'EquipItem', actor_id: 'hero', item_id: itemId, equipped: true, equip_slot: 'off_hand' })
const held = (state) => state.players[0].inventory.filter((item) => item.equipped).map((item) => `${item.id}:${item.equipped_slot ?? 'main'}`).sort()

test('лёгкое оружие идёт во вторую руку, основное остаётся; тяжёлое — нельзя', () => {
  const { state } = equipOffHand(arena())
  assert.deepEqual(held(state), ['dagger:off_hand', 'sword:main'])
  assert.deepEqual(held(replayEvents(arena(), equipOffHand(arena()).result.events)), held(state), 'replay')
  const heavy = arena({ inventory: [weapon('sword', 'srd_5_2_1:shortsword', true), weapon('axe', 'srd_5_2_1:battleaxe')] })
  assert.throws(() => equipOffHand(heavy, 'axe'), { code: 'OFF_HAND_WEAPON_NOT_LIGHT' })
  const bigMain = arena({ inventory: [weapon('long', 'srd_5_2_1:longsword', true), weapon('dagger', 'srd_5_2_1:dagger')] })
  assert.throws(() => equipOffHand(bigMain), { code: 'OFF_HAND_MAIN_HAND_NOT_LIGHT' })
  // Двуручный меч в основную руку освобождает и вторую.
  const withGreat = normalizeCampaignState({ ...structuredClone(state), players: [{ ...state.players[0], inventory: [...state.players[0].inventory, weapon('great', 'srd_5_2_1:greatsword')] }] })
  const after = run(withGreat, { command_type: 'EquipItem', actor_id: 'hero', item_id: 'great', equipped: true }).state
  assert.deepEqual(held(after), ['great:main'])
})

test('атака второй рукой — бонусным действием после Атаки, урон без модификатора Ловкости', () => {
  const ready = normalizeCampaignState({ ...equipOffHand(arena()).state, mechanics: arena({ combat: true }).mechanics })
  assert.ok(combatActionsFor(ready.players[0]).some((action) => action.id === 'offhand-attack'), 'действие появляется с оружием во второй руке')
  assert.ok(!combatActionsFor(arena().players[0]).some((action) => action.id === 'offhand-attack'))
  assert.throws(() => run(ready, { command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'offhand-attack', target_id: 'ogre' }), { code: 'OFFHAND_ATTACK_REQUIRES_ATTACK' })
  const swing = run(ready, { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'ogre', item_id: 'sword', server_authoritative: true })
  const mainDamage = swing.result.events.find((event) => event.event_type === 'DamageApplied').payload.applied_amount
  assert.equal(mainDamage, 6 + 4, 'основная рука — с Ловкостью')
  const second = run(swing.state, { command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'offhand-attack', target_id: 'ogre' })
  const attack = second.result.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(attack.payload.item_id ?? attack.payload.weapon_item_id ?? 'dagger', 'dagger')
  assert.equal(second.result.events.find((event) => event.event_type === 'DamageApplied').payload.applied_amount, 4, 'вторая рука: к4 без модификатора')
  assert.equal(second.state.mechanics.combat.action_economy.hero.bonus_action, false, 'бонусное действие потрачено')
})

test('со стилем «Сражение двумя оружиями» удар второй рукой — с модификатором', () => {
  const styled = equipOffHand(arena({ styles: ['fighting-style-two-weapon'] })).state
  const ready = normalizeCampaignState({ ...styled, mechanics: arena({ combat: true }).mechanics })
  const swing = run(ready, { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'ogre', item_id: 'sword', server_authoritative: true })
  const second = run(swing.state, { command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'offhand-attack', target_id: 'ogre' })
  assert.equal(second.result.events.find((event) => event.event_type === 'DamageApplied').payload.applied_amount, 4 + 4)
})

test('у героя без Дополнительной атаки вторая рука бьёт после единственной атаки', () => {
  const equipped = equipOffHand(arena()).state
  const ready = normalizeCampaignState({ ...equipped, players: [{ ...equipped.players[0], level: 4 }], mechanics: arena({ combat: true }).mechanics })
  const swing = run(ready, { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'ogre', item_id: 'sword', server_authoritative: true })
  assert.equal(swing.state.mechanics.combat.action_economy.hero.action, false)
  const second = run(swing.state, { command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'offhand-attack', target_id: 'ogre' })
  assert.ok(second.result.events.some((event) => event.event_type === 'AttackResolved'))
})

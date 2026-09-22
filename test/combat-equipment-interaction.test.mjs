import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { validateItemLifecycleCommand } from '../server/item-lifecycle.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

const context = { context: { allowedActorIds: ['cleric'] } }

function cells() {
  return Array.from({ length: 6 }, (_, x) => ({ x, y: 0, type: 'floor', revealed: true }))
}

function item(catalogId, id, equipped = false) {
  return materializeCatalogItem(catalogId, { id, quantity: 1, equipped })
}

function battle({ inventory, economy = {} } = {}) {
  return normalizeCampaignState({
    ruleset_id: 'dnd_5e_2014',
    sessionCode: 'COMBAT-EQUIP',
    partyMemberIds: ['cleric', 'ally'],
    players: [{
      id: 'cleric', character: 'Жрец', characterClass: 'cleric', level: 12,
      hp: 30, maxHp: 30, armor: 16, speed: 30, proficiency: 4,
      abilities: { str: 14, dex: 10, con: 14, int: 10, wis: 16, cha: 10 },
      inventory,
      knownSpellIds: ['greater-restoration'], preparedSpellIds: ['greater-restoration'],
      x: 0, y: 0,
    }, {
      id: 'ally', character: 'Союзник', characterClass: 'fighter', level: 1,
      hp: 10, maxHp: 10, armor: 12, speed: 30, proficiency: 2,
      abilities: { str: 12, dex: 10, con: 12, int: 10, wis: 10, cha: 10 },
      inventory: [], x: 0, y: 0,
    }],
    enemies: [{
      id: 'goblin', name: 'Гоблин', hp: 8, maxHp: 8, armor: 12, speed: 30,
      abilities: { str: 8, dex: 14, con: 10, int: 8, wis: 8, cha: 8 },
      x: 1, y: 0, alive: true,
    }],
    scene: { title: 'Тракт', location: 'Тракт', turn: 1, cells: cells() },
    mechanics: {
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'cleric', total: 20 }, { actor_id: 'goblin', total: 5 }],
        action_economy: {
          cleric: { action: true, bonus_action: true, reaction: true, movement: true, object_interaction: true, ...economy },
          goblin: { action: true, bonus_action: true, reaction: true, movement: true, object_interaction: true },
        },
      },
    },
  })
}

function equip(state, commandId, itemId, equipped) {
  return resolveCommand({
    campaign_id: 'combat-equip',
    command_id: commandId,
    command_type: 'EquipItem',
    actor_id: 'cleric',
    item_id: itemId,
    equipped,
  }, state, { diceService: new DiceService(), ...context })
}

function apply(state, result) {
  return result.events.reduce(applyGameEvent, state)
}

test('первое снятие ручного оружия в бою бесплатно, replay сохраняет object interaction', () => {
  const initial = battle({ inventory: [item('srd_5_2_1:mace', 'mace', true)] })
  const result = equip(initial, 'unequip-mace', 'mace', false)

  assert.deepEqual(result.events.map((event) => event.event_type), ['CombatRoundTimeMarked', 'ItemUnequipped'])
  assert.equal(result.events.find((event) => event.event_type === 'ItemUnequipped').payload.combat_action, 'object_interaction')
  const after = apply(initial, result)
  assert.equal(after.players[0].inventory[0].equipped, false)
  assert.equal(after.mechanics.combat.action_economy.cleric.object_interaction, false)
  assert.equal(after.mechanics.combat.action_economy.cleric.action, true)
  assert.equal(after.mechanics.combat.round_time_pending, true)
  assert.deepEqual(replayEvents(initial, result.events), after)
})

test('второе ручное взаимодействие в том же ходу требует действие', () => {
  const initial = battle({ inventory: [
    item('srd_5_2_1:mace', 'mace', true),
    item('srd_5_2_1:holy-symbol-reliquary', 'reliquary', false),
  ] })
  const first = apply(initial, equip(initial, 'unequip-mace', 'mace', false))
  const secondResult = equip(first, 'equip-reliquary', 'reliquary', true)

  assert.equal(secondResult.events.find((event) => event.event_type === 'ItemEquipped').payload.combat_action, 'action')
  assert.equal(secondResult.events.some((event) => event.event_type === 'CombatRoundTimeMarked'), false)
  const after = apply(first, secondResult)
  assert.equal(after.players[0].inventory.find((entry) => entry.id === 'reliquary').equipped, true)
  assert.equal(after.mechanics.combat.action_economy.cleric.object_interaction, false)
  assert.equal(after.mechanics.combat.action_economy.cleric.action, false)
})

test('снятие оружия освобождает руку для Greater Restoration в тот же ход', () => {
  const initial = battle({ inventory: [
    item('srd_5_2_1:mace', 'mace', true),
    item('srd_5_2_1:shield', 'shield', true),
    { ...item('srd_5_2_1:material-diamond-dust-100gp', 'dust'), quantity: 2 },
  ] })
  initial.mechanics.conditions.ally = [{ id: 'petrified', duration: 'until-removed' }]
  assert.throws(() => resolveCommand({
    command_type: 'CastSpell', command_id: 'restore-blocked', actor_id: 'cleric', spell_id: 'greater-restoration',
    target_id: 'ally', target_ids: ['ally'], spell_option: 'petrified', server_authoritative: true,
  }, initial, { diceService: new DiceService(), context: { serverAuthoritativeCombat: true } }), (error) => error.code === 'SPELL_MATERIAL_HAND_REQUIRED')

  const afterUnequip = apply(initial, equip(initial, 'unequip-mace-for-restore', 'mace', false))
  const restored = resolveCommand({
    command_type: 'CastSpell', command_id: 'restore-after-unequip', actor_id: 'cleric', spell_id: 'greater-restoration',
    target_id: 'ally', target_ids: ['ally'], spell_option: 'petrified', server_authoritative: true,
  }, afterUnequip, { diceService: new DiceService(), context: { serverAuthoritativeCombat: true } })
  const final = apply(afterUnequip, restored)
  assert.ok(restored.events.some((event) => event.event_type === 'SpellCast'))
  assert.equal(final.players[0].inventory.find((entry) => entry.id === 'dust').quantity, 1)
  assert.equal(final.mechanics.combat.action_economy.cleric.action, false)
  assert.equal(final.mechanics.combat.action_economy.cleric.object_interaction, false)
  assert.equal((final.mechanics.conditions.ally ?? []).some((condition) => condition.id === 'petrified'), false)
})

test('броня и щит не входят в текущую боевую волну экипировки', () => {
  const initial = battle({ inventory: [
    item('srd_5_2_1:shield', 'shield', true),
    item('srd_5_2_1:plate-armor', 'plate', false),
  ] })

  assert.throws(() => equip(initial, 'unequip-shield', 'shield', false), (error) => error.code === 'ITEM_EQUIP_DURING_COMBAT_UNSUPPORTED')
  assert.throws(() => equip(initial, 'equip-plate', 'plate', true), (error) => error.code === 'ITEM_EQUIP_DURING_COMBAT_UNSUPPORTED')
})

test('двуручное оружие не достаётся поверх надетого щита', () => {
  const initial = battle({ inventory: [
    item('srd_5_2_1:shield', 'shield', true),
    item('srd_5_2_1:greatsword', 'greatsword', false),
  ] })
  assert.throws(() => equip(initial, 'equip-greatsword', 'greatsword', true), (error) => error.code === 'TWO_HANDED_WITH_SHIELD')
})

test('достать предмет занятого ручного слота нельзя одним взаимодействием', () => {
  const initial = battle({ inventory: [
    item('srd_5_2_1:mace', 'mace', true),
    item('srd_5_2_1:holy-symbol-reliquary', 'reliquary', false),
  ] })

  assert.throws(() => equip(initial, 'equip-reliquary', 'reliquary', true), (error) => error.code === 'ITEM_COMBAT_SLOT_OCCUPIED')
})

test('повторное снятие и чужой герой отклоняются до расхода экономики', () => {
  const initial = battle({ inventory: [item('srd_5_2_1:mace', 'mace', false)] })
  assert.throws(() => equip(initial, 'unequip-mace-again', 'mace', false), (error) => error.code === 'ITEM_EQUIP_UNCHANGED')
  assert.throws(() => resolveCommand({
    campaign_id: 'combat-equip', command_id: 'foreign-equip', command_type: 'EquipItem',
    actor_id: 'cleric', item_id: 'mace', equipped: true,
  }, initial, { diceService: new DiceService(), context: { allowedActorIds: ['other-hero'] } }), (error) => error.code === 'ACTOR_FORBIDDEN')
})

test('старое отсутствие equipped считается false при проверке повторного снятия', () => {
  const initial = battle({ inventory: [item('srd_5_2_1:mace', 'mace', false)] })
  delete initial.players[0].inventory[0].equipped
  assert.throws(() => validateItemLifecycleCommand({
    command_type: 'EquipItem', command_id: 'legacy-unequip', actor_id: 'cleric', item_id: 'mace', equipped: false,
  }, initial, { allowedActorIds: ['cleric'] }), (error) => error.code === 'ITEM_EQUIP_UNCHANGED')
})

test('если свободное взаимодействие и действие уже потрачены, предмет не меняется', () => {
  const initial = battle({
    inventory: [item('srd_5_2_1:mace', 'mace', true)],
    economy: { object_interaction: false, action: false },
  })
  assert.throws(() => equip(initial, 'late-unequip', 'mace', false), (error) => error.code === 'ACTION_SPENT')
})

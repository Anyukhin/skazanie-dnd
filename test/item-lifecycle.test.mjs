import assert from 'node:assert/strict'
import test from 'node:test'

import { itemViewerCapabilities, materializeCatalogItem } from '../server/item-catalog.mjs'
import {
  MAX_ACTIVE_ITEM_EFFECT_BONUS,
  activeItemEffectTotals,
  applyItemLifecycleEventToPlayers,
  carryingCapacity,
  derivedEquipmentArmorClass,
  inventoryLoadFor,
  itemLifecycleEvents,
  validateItemLifecycleCommand,
} from '../server/item-lifecycle.mjs'

function hero(id, overrides = {}) {
  return {
    id,
    abilities: { str: 10, dex: 14 },
    inventory: [],
    ...overrides,
  }
}

function state(players, combat = false, rulesetId = 'srd_5_2_1') {
  return {
    ruleset_id: rulesetId,
    players,
    partyMemberIds: players.map((actor) => actor.id),
    mechanics: { combat: { active: combat } },
  }
}

const context = (id) => ({ allowedActorIds: [id] })

test('equipment replaces the same slot and derives armor class on the server', () => {
  const owner = hero('hero-1', {
    inventory: [
      { id: 'armor', catalog_id: 'srd_5_2_1:leather-armor', name: 'Leather', type: 'armor', quantity: 1 },
      { id: 'shield', catalog_id: 'srd_5_2_1:shield', name: 'Shield', type: 'armor', quantity: 1, equipped: true },
      { id: 'old-weapon', catalog_id: 'srd_5_2_1:dagger', name: 'Dagger', type: 'weapon', quantity: 1, equipped: true },
      { id: 'new-weapon', catalog_id: 'srd_5_2_1:longsword', name: 'Longsword', type: 'weapon', quantity: 1 },
    ],
  })
  const command = validateItemLifecycleCommand({
    command_type: 'EquipItem',
    command_id: 'equip-1',
    actor_id: owner.id,
    item_id: 'new-weapon',
    equipped: true,
  }, state([owner]), context(owner.id))
  const [event] = itemLifecycleEvents(command)
  const [next] = applyItemLifecycleEventToPlayers([owner], event)

  assert.equal(next.inventory.find((item) => item.id === 'old-weapon').equipped, false)
  assert.equal(next.inventory.find((item) => item.id === 'new-weapon').equipped, true)
  assert.equal(derivedEquipmentArmorClass(next), 14)
})

test('transfer is atomic, conserves quantity, and rejects over-capacity recipients', () => {
  const source = hero('hero-1', {
    inventory: [{ id: 'ration', catalog_id: 'srd_5_2_1:rations-one-day', name: 'Rations', type: 'consumable', quantity: 4, weight: 2 }],
  })
  const recipient = hero('hero-2')
  const command = validateItemLifecycleCommand({
    command_type: 'TransferItem',
    command_id: 'transfer-1',
    actor_id: source.id,
    item_id: 'ration',
    recipient_id: recipient.id,
    quantity: 3,
  }, state([source, recipient]), context(source.id))
  const [event] = itemLifecycleEvents(command)
  const next = applyItemLifecycleEventToPlayers([source, recipient], event)

  assert.equal(next[0].inventory[0].quantity, 1)
  assert.equal(next[1].inventory[0].quantity, 3)
  assert.equal(inventoryLoadFor(next[1]).weight, 6)
  assert.equal(carryingCapacity(next[1]), 150)

  const overloaded = hero('hero-3', { abilities: { str: 0, dex: 10 } })
  assert.throws(() => validateItemLifecycleCommand({
    command_type: 'TransferItem',
    command_id: 'transfer-2',
    actor_id: source.id,
    item_id: 'ration',
    recipient_id: overloaded.id,
    quantity: 4,
  }, state([source, overloaded]), context(source.id)), (error) => error.code === 'CARRYING_CAPACITY_EXCEEDED')
})

test('usable and attunable items are server-profiled and enforce attunement limit', () => {
  const owner = hero('hero-1', {
    inventory: [
      { id: 'potion', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Potion', type: 'consumable', quantity: 1 },
      ...[1, 2, 3].map((number) => ({
        id: `magic-${number}`,
        name: `Magic ${number}`,
        type: 'other',
        quantity: 1,
        requires_attunement: true,
        attuned_to: 'hero-1',
      })),
      { id: 'fourth', name: 'Fourth', type: 'other', quantity: 1, requires_attunement: true },
    ],
  })
  const use = validateItemLifecycleCommand({
    command_type: 'UseItem',
    actor_id: owner.id,
    item_id: 'potion',
    target_id: owner.id,
  }, state([owner], true), context(owner.id))
  assert.deepEqual(use.use_profile, {
    kind: 'healing',
    expression: '2d4+2',
    consumes: 1,
    combat_action: 'bonus_action',
    range_feet: 5,
    target: 'party',
  })
  const classicUse = validateItemLifecycleCommand({
    command_type: 'UseItem',
    actor_id: owner.id,
    item_id: 'potion',
    target_id: owner.id,
  }, state([owner], true, 'dnd_5e_2014'), context(owner.id))
  assert.equal(classicUse.use_profile.combat_action, 'action')
  assert.equal(itemViewerCapabilities(owner.inventory[0], { rulesetId: 'dnd_5e_2014' }).use.action_type, 'action')
  assert.throws(() => validateItemLifecycleCommand({
    command_type: 'AttuneItem',
    actor_id: owner.id,
    item_id: 'fourth',
    attuned: true,
  }, state([owner]), context(owner.id)), (error) => error.code === 'ATTUNEMENT_LIMIT_REACHED')
})

test('passive item effects require the stamped instance state and deduplicate each group by maximum', () => {
  const ring = (id, bonus = 1) => ({
    ...materializeCatalogItem('srd_5_2_1:ring-of-protection', { id }),
    equipped: true,
    attuned_to: 'hero-1',
    passive_effects: [{
      ...materializeCatalogItem('srd_5_2_1:ring-of-protection').passive_effects[0],
      armor_class_bonus: bonus,
      saving_throw_bonus: bonus,
    }],
  })
  const owner = hero('hero-1', {
    inventory: [
      ring('ring-one'),
      ring('ring-two'),
      {
        id: 'other-effect',
        quantity: 1,
        equipped: true,
        attuned_to: 'hero-1',
        passive_effects: [{
          schema_version: 1,
          effect_id: 'test:other',
          group: 'test:other',
          requires_equipped: true,
          requires_attunement: true,
          armor_class_bonus: 2,
          saving_throw_bonus: 2,
        }],
      },
      {
        id: 'legacy-ring',
        catalog_id: 'srd_5_2_1:ring-of-protection',
        quantity: 1,
        equipped: true,
        attuned_to: 'hero-1',
      },
    ],
  })

  assert.deepEqual(activeItemEffectTotals(owner), {
    armor_class_bonus: 3,
    saving_throw_bonus: 3,
    active_groups: ['srd_5_2_1:ring-of-protection', 'test:other'],
  })
  assert.equal(derivedEquipmentArmorClass(owner), 15)
  assert.equal(derivedEquipmentArmorClass(owner, { includeItemEffects: false }), null)
  assert.deepEqual(activeItemEffectTotals({ ...owner, inventory: [owner.inventory.at(-1)] }), {
    armor_class_bonus: 0,
    saving_throw_bonus: 0,
    active_groups: [],
  })
})

test('attunement rejects a second copy of the same catalog item but storage remains allowed', () => {
  const owner = hero('hero-1', {
    inventory: [
      { ...materializeCatalogItem('srd_5_2_1:ring-of-protection', { id: 'ring-one' }), attuned_to: 'hero-1' },
      materializeCatalogItem('srd_5_2_1:ring-of-protection', { id: 'ring-two' }),
    ],
  })
  assert.equal(owner.inventory.length, 2)
  assert.throws(() => validateItemLifecycleCommand({
    command_type: 'AttuneItem',
    actor_id: owner.id,
    item_id: 'ring-two',
    attuned: true,
  }, state([owner]), context(owner.id)), (error) => error.code === 'DUPLICATE_ITEM_ATTUNEMENT')
})

test('known catalog attunement is authoritative while legacy and homebrew instances remain compatible', () => {
  const legacyRing = {
    id: 'legacy-ring',
    catalog_id: 'srd_5_2_1:ring-of-protection',
    name: 'Legacy ring',
    type: 'other',
    quantity: 1,
    equipped: true,
  }
  const forgedDagger = {
    id: 'forged-dagger',
    catalog_id: 'srd_5_2_1:dagger',
    name: 'Forged dagger',
    type: 'weapon',
    quantity: 1,
    requires_attunement: true,
  }
  const homebrew = {
    id: 'homebrew',
    name: 'Homebrew',
    type: 'other',
    quantity: 1,
    requires_attunement: true,
  }
  const owner = hero('hero-1', { inventory: [legacyRing, forgedDagger, homebrew] })

  const legacyCommand = validateItemLifecycleCommand({
    command_type: 'AttuneItem',
    actor_id: owner.id,
    item_id: legacyRing.id,
    attuned: true,
  }, state([owner]), context(owner.id))
  const [legacyAttuned] = applyItemLifecycleEventToPlayers([owner], itemLifecycleEvents(legacyCommand)[0])
  assert.equal(legacyAttuned.inventory[0].attuned_to, owner.id)
  assert.deepEqual(activeItemEffectTotals(legacyAttuned), {
    armor_class_bonus: 0,
    saving_throw_bonus: 0,
    active_groups: [],
  })

  assert.throws(() => validateItemLifecycleCommand({
    command_type: 'AttuneItem',
    actor_id: owner.id,
    item_id: forgedDagger.id,
    attuned: true,
  }, state([owner]), context(owner.id)), (error) => error.code === 'ITEM_NOT_ATTUNABLE')

  assert.equal(validateItemLifecycleCommand({
    command_type: 'AttuneItem',
    actor_id: owner.id,
    item_id: homebrew.id,
    attuned: true,
  }, state([owner]), context(owner.id)).attuned, true)
})

test('passive item effect totals clamp corrupted groups and aggregate output deterministically', () => {
  const effects = Array.from({ length: 200 }, (_, itemIndex) => ({
    id: `effect-item-${itemIndex}`,
    quantity: 1,
    passive_effects: Array.from({ length: 32 }, (_, effectIndex) => {
      const index = itemIndex * 32 + effectIndex
      if (index === 6_398) {
        return { schema_version: 1, effect_id: 'effect:zero', group: 'group:zero', armor_class_bonus: 0, saving_throw_bonus: -1 }
      }
      if (index === 6_399) {
        return { schema_version: 1, effect_id: 'effect:invalid', group: 'group:invalid', armor_class_bonus: Infinity, saving_throw_bonus: NaN }
      }
      return {
        schema_version: 1,
        effect_id: `effect:${index}`,
        group: `group:${index}`,
        armor_class_bonus: index === 0 ? 999_999 : 1,
        saving_throw_bonus: index === 0 ? 999_999 : 1,
      }
    }),
  }))

  const totals = activeItemEffectTotals(hero('hero-1', { inventory: effects }))
  assert.equal(totals.armor_class_bonus, MAX_ACTIVE_ITEM_EFFECT_BONUS)
  assert.equal(totals.saving_throw_bonus, MAX_ACTIVE_ITEM_EFFECT_BONUS)
  assert.equal(totals.active_groups.includes('group:zero'), false)
  assert.equal(totals.active_groups.includes('group:invalid'), false)
  assert.equal(totals.active_groups.includes('group:0'), true)
  assert.equal(totals.active_groups.length, 200 * 32 - 2)
})

test('Ring of Protection copies share their dedicated equip slot', () => {
  const owner = hero('hero-1', {
    inventory: [
      { ...materializeCatalogItem('srd_5_2_1:ring-of-protection', { id: 'ring-one' }), equipped: true },
      materializeCatalogItem('srd_5_2_1:ring-of-protection', { id: 'ring-two' }),
    ],
  })
  const command = validateItemLifecycleCommand({
    command_type: 'EquipItem',
    actor_id: owner.id,
    item_id: 'ring-two',
    equipped: true,
  }, state([owner]), context(owner.id))
  assert.equal(command.equip_slot, 'ring-protection')
  const [next] = applyItemLifecycleEventToPlayers([owner], itemLifecycleEvents(command)[0])
  assert.equal(next.inventory.find((item) => item.id === 'ring-one').equipped, false)
  assert.equal(next.inventory.find((item) => item.id === 'ring-two').equipped, true)
})

test('healer kits remain separate instances and charge replay reads only the event payload', () => {
  const source = hero('hero-1', {
    inventory: [{
      id: 'source-kit',
      catalog_id: 'srd_5_2_1:healers-kit',
      name: 'Набор лекаря',
      type: 'gear',
      quantity: 1,
      charges: { current: 7, max: 10 },
    }],
  })
  const recipient = hero('hero-2', {
    inventory: [{
      id: 'recipient-kit',
      catalog_id: 'srd_5_2_1:healers-kit',
      name: 'Набор лекаря',
      type: 'gear',
      quantity: 1,
      charges: { current: 7, max: 10 },
    }],
  })
  const command = validateItemLifecycleCommand({
    command_type: 'TransferItem',
    command_id: 'separate-kits',
    actor_id: source.id,
    item_id: 'source-kit',
    recipient_id: recipient.id,
    quantity: 1,
  }, state([source, recipient]), context(source.id))
  const [transfer] = itemLifecycleEvents(command)
  assert.equal(transfer.payload.stackable, false)
  const transferred = applyItemLifecycleEventToPlayers([source, recipient], transfer)
  assert.equal(transferred[1].inventory.length, 2)

  const [charged] = applyItemLifecycleEventToPlayers([{
    ...source,
    inventory: [{ ...source.inventory[0], charges: { current: 99, max: 99 } }],
  }], {
    event_type: 'ItemChargesSpent',
    actor_id: source.id,
    target_ids: [source.id],
    payload: { item_id: 'source-kit', after: 12, max: 4 },
  })
  assert.deepEqual(charged.inventory[0].charges, { current: 4, max: 4 })
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
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

function state(players, combat = false) {
  return {
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
  assert.throws(() => validateItemLifecycleCommand({
    command_type: 'AttuneItem',
    actor_id: owner.id,
    item_id: 'fourth',
    attuned: true,
  }, state([owner]), context(owner.id)), (error) => error.code === 'ATTUNEMENT_LIMIT_REACHED')
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

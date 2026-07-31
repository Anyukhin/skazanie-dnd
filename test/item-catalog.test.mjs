import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveArmorClass } from '../server/character-lifecycle.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  ITEM_AVAILABILITY_CHANNELS,
  ITEM_CATALOG,
  ITEM_CATALOG_SCHEMA_VERSION,
  ITEM_CATALOG_SOURCE,
  ITEM_CRAFTING_CATALOG_IDS,
  ITEM_LOOT_CATALOG_IDS,
  ITEM_MECHANICS_STATUSES,
  ITEM_SHOP_CATALOG_IDS,
  catalogIdsFor,
  hydrateCatalogItem,
  materializeCatalogItem,
} from '../server/item-catalog.mjs'
import { inventoryWeight, itemProfileFor } from '../server/item-lifecycle.mjs'
import { inventoryItemFromStock, normalizeInventoryItem } from '../server/merchant-economy.mjs'
import { serverEncounterLoot } from '../server/loot-tables.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { assembleShop } from '../server/shop-assembler.mjs'

const EXPECTED_ATTRIBUTION = 'This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.'

const SHOP_PRICES = Object.freeze({
  'srd_5_2_1:dagger': 200,
  'srd_5_2_1:longsword': 1_500,
  'srd_5_2_1:longbow': 5_000,
  'srd_5_2_1:shortbow': 2_500,
  'srd_5_2_1:leather-armor': 1_000,
  'srd_5_2_1:shield': 1_000,
  'srd_5_2_1:explorers-pack': 1_000,
  'srd_5_2_1:potion-of-healing': 5_000,
  'srd_5_2_1:rations-one-day': 50,
  'srd_5_2_1:rope-hempen-50-feet': 100,
  'srd_5_2_1:torch': 1,
  'srd_5_2_1:arrows-20': 100,
})

function dice(values) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `item-catalog-roll-${++id}`,
    now: () => '2026-07-31T00:00:00.000Z',
  })
}

test('manifest содержит ровно согласованные 98 записей и полную provenance', () => {
  const entries = Object.values(ITEM_CATALOG)
  assert.equal(entries.length, 98)
  assert.equal(new Set(entries.map((entry) => entry.catalog_id)).size, 98)
  assert.deepEqual(
    Object.fromEntries(['weapon', 'armor', 'ammunition', 'artisan-tool', 'other-tool', 'practical-gear', 'magic-item']
      .map((section) => [section, entries.filter((entry) => entry.manifest_section === section).length])),
    { weapon: 38, armor: 13, ammunition: 5, 'artisan-tool': 17, 'other-tool': 1, 'practical-gear': 23, 'magic-item': 1 },
  )
  assert.deepEqual(ITEM_MECHANICS_STATUSES, ['verified', 'partial', 'ruling-only'])
  assert.deepEqual(ITEM_AVAILABILITY_CHANNELS, ['shop', 'loot', 'crafting'])
  assert.equal(ITEM_CATALOG_SCHEMA_VERSION, 'skazanie:item-catalog:v1')
  assert.deepEqual(ITEM_CATALOG_SOURCE, {
    source_url: 'https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf',
    source_version: 'SRD 5.2.1',
    source_sha256: '8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87',
    license: 'CC-BY-4.0',
    attribution: EXPECTED_ATTRIBUTION,
  })
  assert.ok(Object.isFrozen(ITEM_CATALOG))
  for (const [catalogId, entry] of Object.entries(ITEM_CATALOG)) {
    assert.equal(entry.catalog_id, catalogId)
    assert.match(catalogId, /^srd_5_2_1:[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    assert.ok(Object.isFrozen(entry))
    assert.ok(ITEM_MECHANICS_STATUSES.includes(entry.mechanics_status))
    assert.ok(entry.limitation.length > 0)
    assert.ok(Number.isSafeInteger(entry.price_cp) && entry.price_cp >= 0)
    assert.equal(entry.base_price_cp, entry.price_cp)
    assert.ok(Number.isFinite(entry.weight) && entry.weight >= 0)
    assert.ok(Number.isInteger(entry.source_page) && entry.source_page > 0)
    assert.deepEqual(Object.keys(entry.availability).sort(), [...ITEM_AVAILABILITY_CHANNELS].sort())
    assert.ok(Object.values(entry.availability).every((value) => typeof value === 'boolean'))
    assert.equal(entry.provenance.source_url, ITEM_CATALOG_SOURCE.source_url)
    assert.equal(entry.provenance.source_sha256, ITEM_CATALOG_SOURCE.source_sha256)
    assert.equal(entry.provenance.attribution, EXPECTED_ATTRIBUTION)
    assert.equal(entry.provenance.source_page, entry.source_page)
    for (const hook of entry.crafting.hooks) {
      assert.ok(Object.hasOwn(ITEM_CATALOG, hook), `${catalogId}: неизвестный crafting hook ${hook}`)
    }
  }
  assert.deepEqual(ITEM_CATALOG['srd_5_2_1:herbalism-kit'].crafting.hooks, [
    'srd_5_2_1:antitoxin',
    'srd_5_2_1:healers-kit',
    'srd_5_2_1:potion-of-healing',
  ])
  assert.equal(ITEM_CATALOG['srd_5_2_1:herbalism-kit'].price_cp, 500)
  assert.equal(ITEM_CATALOG['srd_5_2_1:herbalism-kit'].weight, 3)
  assert.equal(ITEM_CATALOG['srd_5_2_1:herbalism-kit'].tool.ability, 'Интеллект')
  assert.equal(ITEM_CATALOG['srd_5_2_1:herbalism-kit'].source_page, 94)
  assert.deepEqual(ITEM_CATALOG['srd_5_2_1:smiths-tools'].source_pages, [93, 94])
  assert.equal(ITEM_CATALOG['srd_5_2_1:tinkers-tools'].source_page, 94)
  assert.deepEqual(ITEM_CATALOG['srd_5_2_1:potion-of-healing'].source_pages, [95, 99])
  assert.equal(ITEM_CATALOG['srd_5_2_1:potion-of-healing'].mechanics_source_page, 99)
  assert.deepEqual(
    entries.filter((entry) => entry.mechanics_status === 'verified').map((entry) => entry.catalog_id).sort(),
    ['srd_5_2_1:healers-kit', 'srd_5_2_1:potion-of-healing'],
  )
  assert.deepEqual(ITEM_CATALOG['srd_5_2_1:longsword-plus-1'].source_pages, [91, 206, 253])
  assert.equal(ITEM_CATALOG['srd_5_2_1:longsword-plus-1'].price_cp, 41_500)
  assert.equal(ITEM_CATALOG['srd_5_2_1:longsword-plus-1'].magic_item.bonus, 1)
  assert.equal(ITEM_CATALOG['srd_5_2_1:longsword-plus-1'].attunement.required, false)
})

test('shop, loot и crafting используют отдельные fail-closed allowlist', () => {
  assert.deepEqual([...ITEM_SHOP_CATALOG_IDS].sort(), Object.keys(SHOP_PRICES).sort())
  assert.equal(ITEM_LOOT_CATALOG_IDS.length, 9)
  assert.deepEqual(ITEM_CRAFTING_CATALOG_IDS, [])
  assert.deepEqual(catalogIdsFor('shop').sort(), [...ITEM_SHOP_CATALOG_IDS].sort())
  assert.deepEqual(catalogIdsFor('loot').sort(), [...ITEM_LOOT_CATALOG_IDS].sort())
  assert.deepEqual(catalogIdsFor('crafting'), [])
  assert.deepEqual(catalogIdsFor('unknown'), [])
  for (const [catalogId, price] of Object.entries(SHOP_PRICES)) {
    assert.equal(ITEM_CATALOG[catalogId].base_price_cp, price)
    assert.notEqual(ITEM_CATALOG[catalogId].mechanics_status, 'ruling-only')
  }
  assert.equal(ITEM_SHOP_CATALOG_IDS.includes('srd_5_2_1:pistol'), false)
  assert.equal(ITEM_LOOT_CATALOG_IDS.includes('srd_5_2_1:pistol'), false)
  assert.equal(ITEM_SHOP_CATALOG_IDS.includes('srd_5_2_1:longsword-plus-1'), false)
  assert.equal(ITEM_LOOT_CATALOG_IDS.includes('srd_5_2_1:longsword-plus-1'), false)
  assert.equal(ITEM_CRAFTING_CATALOG_IDS.includes('srd_5_2_1:longsword-plus-1'), false)

  const shop = assembleShop({
    location: 'Рыночная площадь',
    settlement_type: 'city',
    theme: 'general',
    seed: 'item-catalog-allowlist',
    budget_cp: 1_000_000,
    director_intent: {
      stock: ITEM_SHOP_CATALOG_IDS.map((catalog_id) => ({ catalog_id, quantity: 1 })),
      agent_adjustment_bps: 0,
    },
  })
  assert.deepEqual(shop.merchant.stock.map((entry) => entry.catalog_id).sort(), [...ITEM_SHOP_CATALOG_IDS].sort())
  assert.ok(shop.merchant.stock.every((entry) => entry.catalog_schema_version === ITEM_CATALOG_SCHEMA_VERSION))
  assert.throws(() => assembleShop({
    location: 'Рыночная площадь',
    settlement_type: 'city',
    theme: 'general',
    seed: 'item-catalog-pistol',
    budget_cp: 100_000,
    director_intent: {
      stock: [{ catalog_id: 'srd_5_2_1:pistol', quantity: 1 }],
      agent_adjustment_bps: 0,
    },
  }), (error) => error.code === 'CATALOG_ID_NOT_ALLOWED')

  for (const theme of ['goblinoids', 'undead', 'beasts', 'raiders', 'warband', 'generic']) {
    const loot = serverEncounterLoot({ theme, difficulty: 'hard', encounterId: 'catalog-coverage' })
    assert.ok(loot.every((entry) => ITEM_LOOT_CATALOG_IDS.includes(entry.catalog_id)))
    assert.ok(loot.every((entry) => entry.catalog_schema_version === ITEM_CATALOG_SCHEMA_VERSION))
  }
})

test('materialization делает известную механику авторитетной и сохраняет только поля экземпляра', () => {
  const item = materializeCatalogItem('srd_5_2_1:longbow', {
    id: 'hero-bow',
    quantity: 3,
    equipped: true,
    attuned_to: 'hero',
    name: 'Лук следопыта',
    weight: 999,
    type: 'consumable',
    base_price_cp: 1,
    combat: { kind: 'melee', damage: '99d99', damageType: 'force', normalRange: 5 },
    secret: 'не переносить',
  })
  assert.equal(item.id, 'hero-bow')
  assert.equal(item.quantity, 3)
  assert.equal(item.equipped, true)
  assert.equal(item.attuned_to, 'hero')
  assert.equal(item.name, 'Лук следопыта')
  assert.equal(item.catalog_schema_version, ITEM_CATALOG_SCHEMA_VERSION)
  assert.equal(item.weight, 2)
  assert.equal(item.type, 'weapon')
  assert.equal(item.base_price_cp, 5_000)
  assert.deepEqual(item.combat, {
    kind: 'ranged',
    ability: 'dex',
    damage: '1d8',
    damageType: 'piercing',
    normalRange: 150,
    longRange: 600,
    twoHanded: true,
    ammunition: true,
  })
  assert.equal(item.secret, undefined)

  const custom = {
    id: 'custom-compass',
    catalog_id: 'custom:compass',
    name: 'Личный компас',
    type: 'tool',
    quantity: 1,
    weight: 0.25,
    combat: { kind: 'ruling' },
  }
  assert.deepEqual(hydrateCatalogItem(custom), custom)

  const usedKit = materializeCatalogItem('srd_5_2_1:healers-kit', {
    id: 'used-kit',
    charges: { current: 3, max: 999 },
  })
  assert.deepEqual(usedKit.charges, { current: 3, max: 10 })
  assert.equal(itemProfileFor(usedKit).stackable, false)
  assert.deepEqual(
    materializeCatalogItem('srd_5_2_1:healers-kit', { charges: { current: 99 } }).charges,
    { current: 10, max: 10 },
  )
})

test('legacy normalization не меняет replay-поля без явной hydration', () => {
  const legacy = {
    id: 'legacy-bow',
    catalog_id: 'srd_5_2_1:longbow',
    name: 'Старый лук',
    type: 'weapon',
    quantity: 1,
    weight: 99,
    base_price_cp: 1,
    combat: { kind: 'ranged', ability: 'str', damage: '1d2', damageType: 'cold', normalRange: 10 },
  }
  const normalized = normalizeInventoryItem(legacy)
  assert.equal(normalized.catalog_schema_version, undefined)
  assert.equal(normalized.weight, 99)
  assert.deepEqual(normalized.combat, legacy.combat)
  assert.equal(normalized.base_price_cp, 5_000)

  const hydrated = normalizeInventoryItem(legacy, { hydrateCatalog: true })
  assert.equal(hydrated.catalog_schema_version, ITEM_CATALOG_SCHEMA_VERSION)
  assert.equal(hydrated.weight, 2)
  assert.equal(hydrated.combat.damage, '1d8')
  assert.equal(hydrated.combat.ability, 'dex')

  const replayState = normalizeCampaignState({ players: [{ id: 'hero', hp: 1, maxHp: 1, inventory: [legacy] }] })
  assert.equal(replayState.players[0].inventory[0].catalog_schema_version, undefined)
  assert.deepEqual(replayState.players[0].inventory[0].combat, legacy.combat)
})

test('купленный лук получает runtime-профиль и проходит реальную серверную атаку с replay', () => {
  const bought = {
    ...inventoryItemFromStock({
      stock_id: 'longbow-stock',
      catalog_id: 'srd_5_2_1:longbow',
      quantity: 1,
      weight: 999,
      base_price_cp: 1,
      combat: { kind: 'melee', damage: '99d99', damageType: 'force', normalRange: 5 },
    }),
    id: 'longbow',
  }
  assert.equal(bought.catalog_schema_version, ITEM_CATALOG_SCHEMA_VERSION)
  assert.equal(bought.weight, 2)
  assert.equal(bought.base_price_cp, 5_000)
  assert.equal(bought.combat.normalRange, 150)

  const cells = Array.from({ length: 5 }, (_, x) => ({ x, y: 0, type: 'floor', revealed: true }))
  const state = normalizeCampaignState({
    players: [{
      id: 'hero',
      hp: 12,
      maxHp: 12,
      armor: 14,
      proficiency: 2,
      abilities: { str: 10, dex: 16 },
      x: 0,
      y: 0,
      inventory: [bought],
    }],
    enemies: [{ id: 'goblin', hp: 10, maxHp: 10, armor: 12, alive: true, x: 4, y: 0 }],
    scene: { cells, turn: 1 },
    mechanics: {
      combat: {
        active: true,
        round: 1,
        initiative: [{ actor_id: 'hero' }, { actor_id: 'goblin' }],
        active_index: 0,
        action_economy: { hero: { action: true } },
      },
    },
  })
  const result = resolveCommand({
    command_type: 'MakeAttack',
    actor_id: 'hero',
    target_id: 'goblin',
    item_id: 'longbow',
    server_authoritative: true,
  }, state, {
    diceService: dice([15, 4]),
    context: { serverAuthoritativeCombat: true },
  })
  const attack = result.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(attack.payload.modifier, 5)
  assert.equal(attack.payload.distance_feet, 20)
  assert.ok(result.events.some((event) => event.event_type === 'EquipmentChanged'))
  const reduced = result.events.reduce(applyGameEvent, state)
  assert.deepEqual(replayEvents(state, result.events), reduced)
  assert.equal(reduced.players[0].inventory[0].equipped, true)
})

test('BuyItem материализует авторитетный payload события и replay не перечитывает каталог', () => {
  const state = normalizeCampaignState({
    sessionCode: 'ITEM-CATALOG-BUY',
    state_version: 0,
    scene: { location: 'Рынок' },
    players: [{
      id: 'hero',
      hp: 10,
      maxHp: 10,
      abilities: { dex: 16 },
      currency: { gold: 100 },
      inventory: [],
    }],
    merchants: [{
      id: 'bowyer',
      name: 'Лучник',
      location: 'Рынок',
      available: true,
      purse_cp: 10_000,
      pricing: {
        buy_markup_bps: 10_000,
        sell_rate_bps: 5_000,
        bargain_dc: 15,
        success_discount_bps: 1_000,
        failure_markup_bps: 500,
        min_multiplier_bps: 1_000,
        max_multiplier_bps: 30_000,
      },
      stock: [{
        stock_id: 'longbow-stock',
        catalog_id: 'srd_5_2_1:longbow',
        name: 'Лук со склада',
        type: 'consumable',
        quantity: 1,
        weight: 999,
        base_price_cp: 1,
        combat: { kind: 'melee', ability: 'str', damage: '99d99', damageType: 'force', normalRange: 5 },
      }],
    }],
  })
  const result = resolveCommand({
    command_type: 'BuyItem',
    actor_id: 'hero',
    merchant_id: 'bowyer',
    stock_id: 'longbow-stock',
    quantity: 1,
    expected_state_version: 0,
  }, state, {
    diceService: dice([]),
    context: { allowedActorIds: ['hero'] },
  })
  const purchase = result.events.find((event) => event.event_type === 'MerchantPurchaseCompleted')
  assert.equal(purchase.payload.item.catalog_schema_version, ITEM_CATALOG_SCHEMA_VERSION)
  assert.equal(purchase.payload.item.type, 'weapon')
  assert.equal(purchase.payload.item.weight, 2)
  assert.equal(purchase.payload.item.base_price_cp, 5_000)
  assert.equal(purchase.payload.item.combat.damage, '1d8')
  assert.equal(purchase.payload.item.combat.normalRange, 150)
  const reduced = result.events.reduce(applyGameEvent, state)
  assert.deepEqual(replayEvents(state, result.events), reduced)
  assert.equal(reduced.players[0].inventory[0].catalog_schema_version, ITEM_CATALOG_SCHEMA_VERSION)
  assert.equal(reduced.players[0].inventory[0].combat.damage, '1d8')
})

test('купленные броня, вес и профили использования читаются из одного каталога', () => {
  const leather = {
    ...inventoryItemFromStock({ catalog_id: 'srd_5_2_1:leather-armor', stock_id: 'leather', quantity: 1 }),
    id: 'leather',
    equipped: true,
  }
  const shield = {
    ...inventoryItemFromStock({ catalog_id: 'srd_5_2_1:shield', stock_id: 'shield', quantity: 1 }),
    id: 'shield',
    equipped: true,
  }
  const potion = {
    ...inventoryItemFromStock({ catalog_id: 'srd_5_2_1:potion-of-healing', stock_id: 'potion', quantity: 1 }),
    id: 'potion',
  }
  const rations = {
    ...inventoryItemFromStock({ catalog_id: 'srd_5_2_1:rations-one-day', stock_id: 'rations', quantity: 2 }),
    id: 'rations',
    quantity: 2,
  }
  const actor = {
    id: 'hero',
    characterClass: 'fighter',
    abilities: { str: 16, dex: 16, con: 12, int: 10, wis: 10, cha: 10 },
    inventory: [leather, shield, potion, rations],
  }
  assert.equal(deriveArmorClass(actor).value, 16)
  assert.equal(inventoryWeight(actor), 20.5)
  assert.equal(itemProfileFor(leather).equip_slot, 'body')
  assert.equal(itemProfileFor(shield).equip_slot, 'off_hand')
  assert.deepEqual(itemProfileFor(potion).use, {
    kind: 'healing',
    expression: '2d4+2',
    consumes: 1,
    combat_action: 'bonus_action',
    range_feet: 5,
    target: 'party',
  })
  assert.deepEqual(itemProfileFor(rations).use, {
    kind: 'ration',
    consumes: 1,
    combat_action: null,
    range_feet: 0,
    target: 'self',
  })
})

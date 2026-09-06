import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PHB_STARTING_WEALTH,
  resolveStartingPurchases,
  startingPurchaseCatalog,
} from '../server/character-creation-wealth.mjs'

test('мул и повозка покупаются как имущество, не как груз в рюкзаке', () => {
  const result = resolveStartingPurchases('fighter', { id: 'owned-assets-roll', class_id: 'fighter', total_gp: 100 }, [{ id: 'mount:mule', quantity: 1 }, { id: 'vehicle:cart', quantity: 1 }])
  assert.equal(result.ok, true)
  assert.equal(result.remaining_currency.gold, 77)
  assert.deepEqual(result.inventory, [])
  assert.equal(result.owned_assets.length, 2)
  assert.equal(result.owned_assets[0].carrying_capacity_lb, 420)
})

test('таблица стартового богатства содержит точные формулы PHB 2014 для 12 классов', () => {
  assert.deepEqual(PHB_STARTING_WEALTH, {
    barbarian: { expression: '2d4', multiplier: 10 },
    bard: { expression: '5d4', multiplier: 10 },
    cleric: { expression: '5d4', multiplier: 10 },
    druid: { expression: '2d4', multiplier: 10 },
    fighter: { expression: '5d4', multiplier: 10 },
    monk: { expression: '5d4', multiplier: 1 },
    paladin: { expression: '5d4', multiplier: 10 },
    ranger: { expression: '5d4', multiplier: 10 },
    rogue: { expression: '4d4', multiplier: 10 },
    sorcerer: { expression: '3d4', multiplier: 10 },
    warlock: { expression: '4d4', multiplier: 10 },
    wizard: { expression: '4d4', multiplier: 10 },
  })
})

test('каталог покупки содержит обычные предметы с ценой и весом, но не магию', () => {
  const catalog = startingPurchaseCatalog()
  assert.ok(catalog.length > 150)
  assert.ok(catalog.some((entry) => entry.id === 'srd_5_2_1:longsword' && entry.price_cp === 1_500 && entry.weight === 3))
  assert.ok(catalog.some((entry) => entry.id === 'srd_5_2_1:chain-mail' && entry.price_cp === 7_500 && entry.weight === 55))
  assert.ok(catalog.some((entry) => entry.id === 'lute' && entry.price_cp === 3_500 && entry.weight === 2))
  assert.ok(catalog.some((entry) => entry.id === 'dragonchess' && entry.price_cp === 100 && entry.weight === 0.5))
  assert.ok(catalog.some((entry) => entry.id === 'srd_5_2_1:cobblers-tools' && entry.price_cp === 500 && entry.weight === 5))
  assert.ok(catalog.some((entry) => entry.id === 'srd_5_2_1:potion-of-healing' && entry.price_cp === 5_000 && entry.weight === 0.5 && entry.mechanics_status === 'verified'))
  assert.ok(catalog.some((entry) => entry.id === 'abacus' && entry.price_cp === 200 && entry.weight === 2))
  assert.ok(catalog.some((entry) => entry.id === 'rope-silk-50-feet' && entry.price_cp === 1_000 && entry.weight === 5))
  assert.ok(catalog.some((entry) => entry.id === 'srd_5_2_1:rope-hempen-50-feet' && entry.price_cp === 100 && entry.weight === 10))
  assert.ok(catalog.some((entry) => entry.id === 'net' && entry.price_cp === 100 && entry.weight === 3))
  assert.ok(catalog.some((entry) => entry.id === 'dungeoneers-pack' && entry.price_cp === 1_200 && entry.weight === 56.5))
  assert.ok(!catalog.some((entry) => entry.id === 'srd_5_2_1:longsword-plus-1'))
  assert.ok(!catalog.some((entry) => entry.id === 'srd_5_2_1:ring-of-protection'))
  assert.ok(catalog.every((entry) => entry.name && Number.isSafeInteger(entry.price_cp) && entry.price_cp > 0 && (entry.owned_asset || Number.isFinite(entry.weight))))
  const changed = startingPurchaseCatalog()
  changed[0].name = 'подделка'
  assert.notEqual(startingPurchaseCatalog()[0].name, 'подделка')
})

test('покупки считают стоимость в медных монетах и возвращают остаток', () => {
  const result = resolveStartingPurchases('fighter', {
    class_id: 'fighter', total_gp: 100, id: 'wealth-roll-1',
  }, [
    { id: 'srd_5_2_1:longsword', quantity: 1 },
    { id: 'lute', quantity: 1 },
  ])
  assert.equal(result.ok, true)
  assert.equal(result.spent_cp, 5_000)
  assert.equal(result.remaining_currency.total_cp, 5_000)
  assert.deepEqual(result.remaining_currency, { total_cp: 5_000, total_gp: 50, gold: 50, silver: 0, copper: 0 })
  assert.equal(result.inventory[0].catalog_id, 'srd_5_2_1:longsword')
  assert.equal(result.inventory[0].quantity, 1)
  assert.equal(result.inventory[0].weight, 3)
  assert.equal(result.inventory[0].price_cp, 1_500)
  assert.equal(result.inventory[1].catalog_id, 'phb_2014:tool:lute')
  assert.equal(result.inventory[1].type, 'tool')
  assert.equal(result.inventory[1].weight, 2)
  const rope = resolveStartingPurchases('fighter', {
    class_id: 'fighter', total_gp: 10, id: 'wealth-roll-rope',
  }, [{ id: 'srd_5_2_1:rope-hempen-50-feet', quantity: 1 }])
  assert.equal(rope.ok, true)
  assert.equal(rope.inventory[0].weight, 10)
  const canonicalToolAlias = resolveStartingPurchases('fighter', {
    class_id: 'fighter', total_gp: 100, id: 'wealth-roll-2',
  }, [{ id: 'cobblers_tools', quantity: 1 }])
  assert.equal(canonicalToolAlias.ok, true)
  assert.equal(canonicalToolAlias.inventory[0].catalog_id, 'srd_5_2_1:cobblers-tools')
})

test('разрешены покупки дешевле богатства, но не превышающие его', () => {
  const empty = resolveStartingPurchases('monk', { class_id: 'monk', total_gp: 12, id: 'r2' }, [])
  assert.equal(empty.ok, true)
  assert.equal(empty.remaining_currency.total_gp, 12)
  const underBudget = resolveStartingPurchases('monk', { class_id: 'monk', total_gp: 12, id: 'r3' }, [{ id: 'dice_set', quantity: 1 }])
  assert.equal(underBudget.ok, true)
  assert.equal(underBudget.remaining_currency.total_cp, 1_190)
  const overBudget = resolveStartingPurchases('monk', { class_id: 'monk', total_gp: 12, id: 'r4' }, [{ id: 'srd_5_2_1:plate-armor', quantity: 1 }])
  assert.equal(overBudget.ok, false)
  assert.equal(overBudget.code, 'PURCHASES_OVER_BUDGET')
})

test('подделанные, магические и некорректные покупки отклоняются до создания инвентаря', () => {
  const roll = { class_id: 'wizard', total_gp: 100, id: 'r5' }
  assert.equal(resolveStartingPurchases('wizard', { ...roll, class_id: 'fighter' }, []).code, 'WEALTH_CLASS_MISMATCH')
  assert.equal(resolveStartingPurchases('wizard', { ...roll, id: '' }, []).code, 'WEALTH_ROLL_ID_REQUIRED')
  assert.equal(resolveStartingPurchases('wizard', roll, [{ id: 'srd_5_2_1:ring-of-protection', quantity: 1 }]).code, 'PURCHASE_UNKNOWN_ITEM')
  assert.equal(resolveStartingPurchases('wizard', roll, [{ id: 'unknown', quantity: 1 }]).code, 'PURCHASE_UNKNOWN_ITEM')
  assert.equal(resolveStartingPurchases('wizard', roll, [{ id: 'lute', quantity: 0 }]).code, 'PURCHASE_QUANTITY_INVALID')
  assert.equal(resolveStartingPurchases('wizard', roll, [{ id: 'lute', quantity: 1.5 }]).code, 'PURCHASE_QUANTITY_INVALID')
  assert.equal(resolveStartingPurchases('wizard', roll, [{ id: 'lute', quantity: 1 }]).ok, true)
  assert.equal(resolveStartingPurchases('wizard', roll, [{ id: 'srd_5_2_1:plate-armor', quantity: 1 }]).ok, false)
})

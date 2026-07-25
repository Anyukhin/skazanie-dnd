import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  ECONOMY_POLICY_ID,
  DEFAULT_MERCHANT_PURSE_CP,
  MAX_CURRENCY_CP,
  canonicalLocationKey,
  copperToCurrency,
  currencyToCopper,
  locationsMatch,
  merchantIsAtLocation,
  merchantViewFor,
  normalizeCurrency,
  resolveCatalogPrice,
} from '../server/merchant-economy.mjs'
import { RulesValidationError, applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand, resolveCommands } from '../server/rules-engine.mjs'

function dice(values) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `merchant-roll-${++id}`,
    now: () => '2026-07-12T00:00:00.000Z',
  })
}

function merchantState(overrides = {}) {
  return normalizeCampaignState({
    sessionCode: 'SHOP-UNIT',
    state_version: 0,
    engine_mode: 'enforce',
    scene: { location: 'рыночная площадь' },
    players: [{
      id: 'hero', hp: 10, maxHp: 10, armor: 12, abilities: { cha: 16 },
      skills: { persuasion_bonus: 2 },
      currency: { copper: 0, silver: 0, gold: 100, platinum: 0 },
      inventory: [
        { id: 'hero-dagger', catalog_id: 'srd_5_2_1:dagger', name: 'Кинжал', type: 'weapon', quantity: 2, equipped: false, base_price_cp: 99_999 },
        { id: 'quest-letter', name: 'Письмо короля', type: 'document', rarity: 'сюжетный', quantity: 1, equipped: false, price_provenance: 'custom-appraisal', appraisal_policy_id: ECONOMY_POLICY_ID, base_price_cp: 10_000 },
      ],
    }],
    merchants: [{
      id: 'marten', name: 'Мартен', location: 'РЫНОЧНАЯ   ПЛОЩАДЬ', available: true,
      secret_inventory_note: 'не показывать игроку',
      pricing: {
        buy_markup_bps: 11_000, sell_rate_bps: 5_000, bargain_dc: 15,
        success_discount_bps: 1_000, failure_markup_bps: 500,
        min_multiplier_bps: 1_000, max_multiplier_bps: 30_000,
      },
      stock: [{
        stock_id: 'potion-stock', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье лечения',
        type: 'consumable', quantity: 3, base_price_cp: 1, secret_supplier: 'не показывать',
      }],
    }],
    ...overrides,
  })
}

function reduce(state, events) {
  return events.reduce(applyGameEvent, state)
}

test('серверный каталог перекрывает snapshot price, а snapshot appraisal не даёт authority custom-цене', () => {
  const catalog = resolveCatalogPrice({ catalog_id: 'srd_5_2_1:potion-of-healing', base_price_cp: 1 })
  assert.equal(catalog.base_price_cp, 5_000)
  assert.equal(catalog.provenance, 'catalog')
  assert.equal(catalog.source_page, 95)
  assert.equal(resolveCatalogPrice({ catalog_id: 'srd_5_2_1:longbow', base_price_cp: 1 }).base_price_cp, 5_000)
  assert.equal(resolveCatalogPrice({ catalog_id: 'custom:ring', base_price_cp: 100_000 }), null)
  assert.equal(resolveCatalogPrice({
    catalog_id: 'custom:ring', base_price_cp: 100_000,
    price_provenance: 'custom-appraisal', appraisal_policy_id: ECONOMY_POLICY_ID,
  }), null)
})

test('общий server normalizer заполняет обязательные поля frontend-инвентаря и заменяет forged stack_key', () => {
  const state = normalizeCampaignState({
    players: [{ id: 'hero', hp: 1, maxHp: 1, inventory: [{ id: 'legacy', quantity: 1, stack_key: 'forged' }] }],
  })
  const item = state.players[0].inventory[0]
  assert.equal(item.name, 'Предмет')
  assert.equal(item.type, 'other')
  assert.equal(item.weight, 0)
  assert.equal(item.equipped, false)
  assert.equal(item.rarity, 'обычный')
  assert.equal(item.description, '')
  assert.equal(item.properties, '')
  assert.equal(item.image, '')
  assert.match(item.stack_key, /^custom:[a-f0-9]{32}$/u)
  assert.notEqual(item.stack_key, 'forged')
})

test('currency round-trip точен на всём разрешённом диапазоне и denominations имеют фиксированный курс', () => {
  assert.equal(currencyToCopper({ copper: 1, silver: 1, gold: 1, platinum: 1 }), 1_111)
  assert.deepEqual(normalizeCurrency({ copper: 8, silver: 14, gold: 37, platinum: 0 }), { copper: 8, silver: 14, gold: 37, platinum: 0 })
  for (const amount of [0, 1, 9, 10, 99, 100, 999, 1_000, MAX_CURRENCY_CP - 1, MAX_CURRENCY_CP]) {
    assert.equal(currencyToCopper(copperToCurrency(amount)), amount)
  }
  assert.equal(currencyToCopper(normalizeCurrency(copperToCurrency(MAX_CURRENCY_CP))), MAX_CURRENCY_CP)
  const normalizedOverCap = normalizeCurrency({ copper: MAX_CURRENCY_CP, platinum: 9_000_000 })
  assert.equal(currencyToCopper(normalizedOverCap), MAX_CURRENCY_CP)
  assert.deepEqual(normalizedOverCap, copperToCurrency(MAX_CURRENCY_CP))
})

test('merchant view выдаёт только публичный stock и server-derived quotes с optimistic version', () => {
  const state = merchantState()
  assert.equal(canonicalLocationKey('  ＭＡＲＫＥＴ\tSquare  '), 'market square')
  assert.equal(locationsMatch('РЫНОЧНАЯ   ПЛОЩАДЬ', 'рыночная площадь'), true)
  assert.equal(merchantIsAtLocation('РЫНОЧНАЯ   ПЛОЩАДЬ', 'рыночная площадь'), true)
  assert.equal(merchantIsAtLocation('', 'рыночная площадь'), true)
  const view = merchantViewFor(state, 'marten', 'hero')
  assert.equal(view.state_version, 0)
  assert.equal(view.expected_state_version, 0)
  assert.equal(view.balance_cp, 10_000)
  assert.equal(view.merchant_purse_cp, DEFAULT_MERCHANT_PURSE_CP)
  assert.equal(view.merchant.purse_cp, DEFAULT_MERCHANT_PURSE_CP)
  assert.equal(view.merchant.secret_inventory_note, undefined)
  assert.equal(view.merchant.stock[0].secret_supplier, undefined)
  assert.equal(view.buy_quotes[0].item.secret_supplier, undefined)
  assert.equal(view.merchant.stock[0].base_price_cp, 5_000)
  assert.equal(view.buy_quotes[0].unit_price_cp, 5_500)
  assert.equal(view.buy_quotes[0].expected_state_version, 0)
  assert.equal(view.sell_quotes.find((quote) => quote.item_id === 'hero-dagger').unit_price_cp, 100)
  assert.equal(view.sell_quotes.find((quote) => quote.item_id === 'hero-dagger').can_afford, true)
  assert.equal(view.sell_quotes.find((quote) => quote.item_id === 'quest-letter').can_sell, false)
})

test('покупка атомарно списывает деньги, переносит trusted item, уменьшает stock и пишет economyLog', () => {
  const state = merchantState()
  const result = resolveCommand({
    command_type: 'BuyItem', actor_id: 'hero', merchant_id: 'marten', stock_id: 'potion-stock', quantity: 1,
    expected_state_version: 0,
    price_cp: 1, base_price_cp: 1, item: { id: 'forged', name: 'Подделка' }, roll: 20,
  }, state, { diceService: dice([]), context: { allowedActorIds: ['hero'] } })
  const purchase = result.events.find((event) => event.event_type === 'MerchantPurchaseCompleted')
  assert.equal(purchase.payload.unit_price_cp, 5_500)
  assert.equal(purchase.payload.item.name, 'Зелье лечения')
  assert.equal(purchase.payload.item.weight, 0)
  assert.equal(purchase.payload.item.rarity, 'обычный')
  assert.equal(typeof purchase.payload.item.description, 'string')
  assert.equal(typeof purchase.payload.item.properties, 'string')
  assert.equal(purchase.payload.item.secret_supplier, undefined)
  assert.equal(purchase.payload.price_provenance, 'catalog')
  assert.ok(purchase.source_rule_ids.includes('srd_5_2_1:economy:coins'))
  assert.ok(!purchase.source_rule_ids.includes('srd_5_2_1:resources:spending'))
  assert.equal(purchase.house_rule_id, ECONOMY_POLICY_ID)
  const next = reduce(state, result.events)
  assert.equal(currencyToCopper(next.players[0].currency), 4_500)
  assert.equal(next.players[0].inventory.find((item) => item.catalog_id === 'srd_5_2_1:potion-of-healing').quantity, 1)
  assert.equal(next.players[0].inventory.find((item) => item.catalog_id === 'srd_5_2_1:potion-of-healing').secret_supplier, undefined)
  assert.equal(next.merchants[0].stock[0].quantity, 2)
  assert.equal(next.merchants[0].purse_cp, DEFAULT_MERCHANT_PURSE_CP + 5_500)
  assert.equal(purchase.payload.merchant_purse_before_cp, DEFAULT_MERCHANT_PURSE_CP)
  assert.equal(purchase.payload.merchant_purse_after_cp, DEFAULT_MERCHANT_PURSE_CP + 5_500)
  assert.equal(replayEvents(state, result.events).merchants[0].purse_cp, next.merchants[0].purse_cp)
  assert.equal(next.economyLog.at(-1).type, 'purchase')
  assert.equal(next.economyLog.at(-1).totalPriceCp, 5_500)
})

test('торг использует серверный d20, CHA и persisted bonus один раз и сохраняет bounded modifier', () => {
  const state = merchantState()
  const result = resolveCommand({
    command_type: 'BargainWithMerchant', actor_id: 'hero', merchant_id: 'marten',
    expected_state_version: 0, roll: 1, modifier: 100,
  }, state, { diceService: dice([10]), context: { allowedActorIds: ['hero'] } })
  const bargain = result.events.find((event) => event.event_type === 'MerchantBargainResolved')
  assert.equal(bargain.payload.natural_roll, 10)
  assert.equal(bargain.payload.modifier, 5) // CHA +3 and explicit additive persuasion bonus +2.
  assert.equal(bargain.payload.success, true)
  assert.equal(bargain.payload.pricing_adjustment_bps, -1_000)
  const next = reduce(state, result.events)
  assert.equal(merchantViewFor(next, 'marten', 'hero').buy_quotes[0].unit_price_cp, 5_000)
  assert.equal(next.economyLog.at(-1).type, 'bargain')
  assert.throws(() => resolveCommand({ command_type: 'BargainWithMerchant', actor_id: 'hero', merchant_id: 'marten' }, next, { diceService: dice([20]) }), (error) => error instanceof RulesValidationError && error.code === 'BARGAIN_ALREADY_RESOLVED')
})

test('продажа использует SRD half-cost, блокирует equipped/story items и обновляет обе стороны', () => {
  const state = merchantState()
  assert.throws(() => resolveCommand({ command_type: 'SellItem', actor_id: 'hero', merchant_id: 'marten', item_id: 'quest-letter', quantity: 1 }, state, { diceService: dice([]) }), (error) => error.code === 'ITEM_NOT_SELLABLE')
  const equipped = merchantState({ players: [{ ...state.players[0], inventory: [{ ...state.players[0].inventory[0], equipped: true }] }] })
  assert.throws(() => resolveCommand({ command_type: 'SellItem', actor_id: 'hero', merchant_id: 'marten', item_id: 'hero-dagger', quantity: 1 }, equipped, { diceService: dice([]) }), (error) => error.code === 'ITEM_EQUIPPED')

  const result = resolveCommand({ command_type: 'SellItem', actor_id: 'hero', merchant_id: 'marten', item_id: 'hero-dagger', quantity: 1 }, state, { diceService: dice([]) })
  const sale = result.events.find((event) => event.event_type === 'MerchantSaleCompleted')
  assert.equal(sale.payload.base_unit_price_cp, 200)
  assert.equal(sale.payload.unit_price_cp, 100)
  assert.ok(sale.source_rule_ids.includes('srd_5_2_1:economy:selling-equipment'))
  const next = reduce(state, result.events)
  assert.equal(currencyToCopper(next.players[0].currency), 10_100)
  assert.equal(next.players[0].inventory.find((item) => item.id === 'hero-dagger').quantity, 1)
  assert.equal(next.merchants[0].stock.find((stock) => stock.catalog_id === 'srd_5_2_1:dagger').quantity, 1)
  assert.equal(next.merchants[0].purse_cp, DEFAULT_MERCHANT_PURSE_CP - 100)
  assert.equal(sale.payload.merchant_purse_before_cp, DEFAULT_MERCHANT_PURSE_CP)
  assert.equal(sale.payload.merchant_purse_after_cp, DEFAULT_MERCHANT_PURSE_CP - 100)
  assert.equal(replayEvents(state, result.events).merchants[0].purse_cp, next.merchants[0].purse_cp)
  assert.equal(next.economyLog.at(-1).type, 'sale')
})

test('merchant purse ограничивает sell quote и отклоняет выплату без частичного изменения состояния', () => {
  const base = merchantState()
  const state = merchantState({ merchants: [{ ...base.merchants[0], purse_cp: 99 }] })
  const quote = merchantViewFor(state, 'marten', 'hero').sell_quotes.find((candidate) => candidate.item_id === 'hero-dagger')
  assert.equal(quote.unit_price_cp, 100)
  assert.equal(quote.can_afford, false)
  assert.equal(quote.can_sell, false)
  assert.equal(quote.max_quantity, 0)
  assert.match(quote.reason, /недостаточно монет/u)

  assert.throws(
    () => resolveCommand({ command_type: 'SellItem', actor_id: 'hero', merchant_id: 'marten', item_id: 'hero-dagger', quantity: 1 }, state, { diceService: dice([]) }),
    (error) => error.code === 'INSUFFICIENT_MERCHANT_FUNDS',
  )
  assert.equal(state.merchants[0].purse_cp, 99)
  assert.equal(currencyToCopper(state.players[0].currency), 10_000)
  assert.equal(state.players[0].inventory[0].quantity, 2)
})

test('merchant purse нормализуется в общий денежный предел и purchase не переполняет его', () => {
  const base = merchantState()
  const normalized = merchantState({ merchants: [{ ...base.merchants[0], purse_cp: MAX_CURRENCY_CP + 1 }] })
  assert.equal(normalized.merchants[0].purse_cp, MAX_CURRENCY_CP)
  assert.throws(
    () => resolveCommand({ command_type: 'BuyItem', actor_id: 'hero', merchant_id: 'marten', stock_id: 'potion-stock', quantity: 1 }, normalized, { diceService: dice([]) }),
    (error) => error.code === 'MERCHANT_PURSE_LIMIT_EXCEEDED',
  )
})

test('legacy trade events without purse fields preserve the fixed compatibility reserve', () => {
  const purchaseState = merchantState()
  const purchased = applyGameEvent(purchaseState, {
    event_id: 'legacy-purchase',
    event_type: 'MerchantPurchaseCompleted',
    actor_id: 'hero',
    target_ids: ['hero'],
    payload: {
      merchant_id: 'marten', stock_id: 'potion-stock', catalog_id: 'srd_5_2_1:potion-of-healing',
      item: { id: 'legacy-potion', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье лечения', type: 'consumable', quantity: 1 },
      quantity: 1, total_price_cp: 5_000, currency_after: copperToCurrency(5_000),
    },
  })
  assert.equal(purchased.merchants[0].purse_cp, DEFAULT_MERCHANT_PURSE_CP)

  const saleState = merchantState()
  const sold = applyGameEvent(saleState, {
    event_id: 'legacy-sale',
    event_type: 'MerchantSaleCompleted',
    actor_id: 'hero',
    target_ids: ['hero'],
    payload: {
      merchant_id: 'marten', stock_id: 'legacy-dagger', catalog_id: 'srd_5_2_1:dagger',
      item: { id: 'hero-dagger', catalog_id: 'srd_5_2_1:dagger', name: 'Кинжал', type: 'weapon', quantity: 1 },
      quantity: 1, base_unit_price_cp: 200, total_price_cp: 100, currency_after: copperToCurrency(10_100),
    },
  })
  assert.equal(sold.merchants[0].purse_cp, DEFAULT_MERCHANT_PURSE_CP)
})

test('trade goods и valuables сохраняют полную SRD-стоимость до bounded merchant/bargain adjustment', () => {
  const base = merchantState()
  const treasure = {
    id: 'appraised-gem', name: 'Оценённый самоцвет', type: 'treasure', quantity: 1, equipped: false,
    catalog_id: 'srd_5_2_1:dagger', base_price_cp: 1,
  }
  const state = merchantState({ players: [{ ...base.players[0], inventory: [...base.players[0].inventory, treasure] }] })
  const quote = merchantViewFor(state, 'marten', 'hero').sell_quotes.find((candidate) => candidate.item_id === treasure.id)
  assert.equal(quote.breakdown.catalog_base_unit_cp, 200)
  assert.equal(quote.unit_price_cp, 200)
})

test('catalog mode полностью игнорирует agent_adjustment_bps в котировках покупки и продажи', () => {
  const base = merchantState()
  const state = merchantState({
    merchants: [{
      ...base.merchants[0],
      pricing: { ...base.merchants[0].pricing, mode: 'catalog', agent_adjustment_bps: 2_000 },
    }],
  })
  const view = merchantViewFor(state, 'marten', 'hero')
  assert.equal(state.merchants[0].pricing.agent_adjustment_bps, 0)
  assert.equal(view.buy_quotes[0].unit_price_cp, 5_500)
  assert.equal(view.sell_quotes.find((quote) => quote.item_id === 'hero-dagger').unit_price_cp, 100)
})

test('server stack_key не смешивает варианты одного catalog_id в инвентаре и на складе', () => {
  const base = merchantState()
  const blueVariant = {
    id: 'blue-potion', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье в синей склянке',
    type: 'consumable', quantity: 1, equipped: false, properties: 'Синяя печать', stack_key: 'same-forged-key',
  }
  const redStock = {
    stock_id: 'red-potion', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье в красной склянке',
    type: 'consumable', quantity: 1, properties: 'Красная печать', stack_key: 'same-forged-key',
  }
  const state = merchantState({
    players: [{ ...base.players[0], inventory: [blueVariant] }],
    merchants: [{ ...base.merchants[0], stock: [redStock] }],
  })
  const purchased = resolveCommand({
    command_type: 'BuyItem', actor_id: 'hero', merchant_id: 'marten', stock_id: 'red-potion', quantity: 1,
  }, state, { diceService: dice([]) })
  const afterPurchase = reduce(state, purchased.events)
  assert.equal(afterPurchase.players[0].inventory.length, 2)
  assert.notEqual(afterPurchase.players[0].inventory[0].stack_key, afterPurchase.players[0].inventory[1].stack_key)

  const sold = resolveCommand({
    command_type: 'SellItem', actor_id: 'hero', merchant_id: 'marten', item_id: 'blue-potion', quantity: 1,
  }, afterPurchase, { diceService: dice([]) })
  const afterSale = reduce(afterPurchase, sold.events)
  assert.equal(afterSale.merchants[0].stock.length, 2)
  assert.equal(afterSale.merchants[0].stock.find((stock) => stock.stock_id === 'red-potion').quantity, 0)
  assert.equal(afterSale.merchants[0].stock.find((stock) => stock.stock_id !== 'red-potion').quantity, 1)
})

test('явная stale version первой команды не перезаписывается resolveCommands', () => {
  const state = merchantState({ state_version: 4 })
  assert.throws(() => resolveCommands([{
    command_type: 'BuyItem', actor_id: 'hero', merchant_id: 'marten', stock_id: 'potion-stock', quantity: 1,
    expected_state_version: 3,
  }], state, { diceService: dice([]) }), (error) => error.code === 'STATE_VERSION_CONFLICT')
})

test('продажа нового товара не кредитует героя при полном складе', () => {
  const base = merchantState()
  const fullStock = Array.from({ length: 500 }, (_, index) => ({
    stock_id: `stock-${index}`, catalog_id: 'srd_5_2_1:potion-of-healing',
    name: `Товар ${index}`, type: 'other', quantity: 1, base_price_cp: 1,
  }))
  const state = merchantState({ merchants: [{ ...base.merchants[0], stock: fullStock }] })
  assert.throws(() => resolveCommand({ command_type: 'SellItem', actor_id: 'hero', merchant_id: 'marten', item_id: 'hero-dagger', quantity: 1 }, state, { diceService: dice([]) }), (error) => error.code === 'MERCHANT_STOCK_FULL')
  assert.equal(currencyToCopper(state.players[0].currency), 10_000)
  assert.equal(state.players[0].inventory[0].quantity, 2)
})

test('покупка не обходит inventory cap через equipped item того же catalog', () => {
  const base = merchantState()
  const inventory = [
    { id: 'equipped-potion', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье на поясе', type: 'consumable', quantity: 1, equipped: true },
    ...Array.from({ length: 199 }, (_, index) => ({ id: `filler-${index}`, name: `Заполнитель ${index}`, type: 'other', quantity: 1, equipped: false })),
  ]
  const state = merchantState({ players: [{ ...base.players[0], inventory }] })
  assert.throws(() => resolveCommand({ command_type: 'BuyItem', actor_id: 'hero', merchant_id: 'marten', stock_id: 'potion-stock', quantity: 1 }, state, { diceService: dice([]) }), (error) => error.code === 'INVENTORY_FULL')
  assert.equal(state.players[0].inventory.length, 200)
})

test('merchant с location недоступен, если у сцены отсутствует location', () => {
  const base = merchantState()
  const state = merchantState({ scene: {} })
  assert.throws(() => resolveCommand({ command_type: 'BuyItem', actor_id: 'hero', merchant_id: 'marten', stock_id: 'potion-stock', quantity: 1 }, state, { diceService: dice([]) }), (error) => error.code === 'MERCHANT_NOT_PRESENT')
  assert.equal(currencyToCopper(state.players[0].currency), currencyToCopper(base.players[0].currency))
})

test('PurchaseMerchantService server-prices and atomically settles a configured service', () => {
  const base = merchantState()
  const state = merchantState({
    merchants: [{
      ...base.merchants[0],
      services: [{
        service_id: 'repair',
        name: 'Repair armor',
        kind: 'repair',
        base_price_cp: 100,
        duration_minutes: 30,
      }],
    }],
  })
  const result = resolveCommand({
    command_type: 'PurchaseMerchantService',
    actor_id: 'hero',
    merchant_id: 'marten',
    service_id: 'repair',
  }, state, { diceService: dice([]) })
  assert.deepEqual(result.events.map((event) => event.event_type), ['MerchantServicePurchased'])
  assert.equal(result.events[0].payload.total_price_cp, 110)
  const next = reduce(state, result.events)
  assert.equal(currencyToCopper(next.players[0].currency), 9_890)
  assert.equal(next.merchants[0].purse_cp, DEFAULT_MERCHANT_PURSE_CP + 110)
  assert.equal(next.economyLog.at(-1).type, 'service')
  assert.deepEqual(replayEvents(state, result.events), next)
})

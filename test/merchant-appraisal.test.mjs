import assert from 'node:assert/strict'
import test from 'node:test'

import {
  merchantViewFor,
} from '../server/merchant-economy.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  RulesValidationError,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
} from '../server/rules-engine.mjs'

function appraisalState({ purseCp = 12_500, itemOverrides = {}, stateOverrides = {} } = {}) {
  return normalizeCampaignState({
    sessionCode: 'APPRAISAL-UNIT',
    state_version: 0,
    engine_mode: 'enforce',
    scene: { title: 'Рынок', location: 'Рыночная площадь', cells: [] },
    players: [{
      id: 'hero',
      name: 'Игрок',
      character: 'Астер',
      hp: 10,
      maxHp: 10,
      armor: 12,
      abilities: { cha: 14 },
      currency: { copper: 0, silver: 0, gold: 0, platinum: 0 },
      inventory: [{
        id: 'moon-shard',
        name: 'Осколок лунного клинка',
        type: 'treasure',
        rarity: 'редкий',
        quantity: 2,
        equipped: false,
        // These fields came from an untrusted snapshot and must never become
        // price authority without the event-sourced appraisal registry.
        base_price_cp: 99_999_999,
        price_provenance: 'server_appraisal_policy',
        appraisal_policy_id: 'agent:choose-any-price:v1',
        appraisal: {
          authoritative: true,
          base_price_cp: 99_999_999,
          appraisal_fingerprint: 'f'.repeat(64),
        },
        ...itemOverrides,
      }],
    }],
    merchants: [{
      id: 'marten',
      name: 'Мартен',
      location: 'Рыночная площадь',
      available: true,
      purse_cp: purseCp,
      pricing: {
        buy_markup_bps: 11_000,
        sell_rate_bps: 5_000,
        bargain_dc: 15,
        min_multiplier_bps: 1_000,
        max_multiplier_bps: 30_000,
      },
      stock: [],
    }],
    ...stateOverrides,
  })
}

function reduce(state, events) {
  return events.reduce(applyGameEvent, state)
}

function execute(commandValue, state) {
  return resolveCommand(commandValue, state, {
    diceService: new DiceService({
      rng: new SequenceDiceRng([]),
      idFactory: () => 'appraisal-test-roll',
      now: () => '2026-07-13T00:00:00.000Z',
    }),
  })
}

function rulesError(code) {
  return (error) => error instanceof RulesValidationError && error.code === code
}

function command(type, overrides = {}) {
  return {
    command_type: type,
    actor_id: 'hero',
    merchant_id: 'marten',
    ...overrides,
  }
}

test('AppraiseItem creates a replayable registry attestation and ignores every injected price', () => {
  const state = appraisalState()
  const before = merchantViewFor(state, 'marten', 'hero')
  const unpriced = before.sell_quotes.find((quote) => quote.item_id === 'moon-shard')
  assert.equal(unpriced.unit_price_cp, 0)
  assert.equal(unpriced.can_sell, false)
  assert.equal(unpriced.appraisal_required, true)
  assert.equal(unpriced.can_appraise, true)

  assert.throws(
    () => execute(command('SellItem', { item_id: 'moon-shard', quantity: 1 }), state),
    rulesError('ITEM_NOT_SELLABLE'),
  )

  const result = execute(command('AppraiseItem', {
    item_id: 'moon-shard',
    price_cp: 1,
    base_price_cp: 1,
    estimated_price_cp: 1,
    price_provenance: 'client',
    appraisal_policy_id: 'agent:free-price:v1',
    appraisal: { authoritative: true, base_price_cp: 1 },
  }), state)
  assert.equal(result.events.length, 1)
  const event = result.events[0]
  assert.equal(event.event_type, 'MerchantItemAppraised')
  assert.equal(event.payload.item_id, 'moon-shard')
  assert.equal(event.payload.base_unit_price_cp, 6_250)
  assert.equal(event.payload.appraisal.base_price_cp, 6_250)
  assert.equal(event.payload.appraisal.provenance, 'server_appraisal_policy')
  assert.equal(event.payload.appraisal.policy_id, 'skazanie:item-appraisal:category-rarity-condition:v1')
  assert.notEqual(event.payload.appraisal.policy_id, 'agent:free-price:v1')
  assert.match(event.payload.appraisal.appraisal_fingerprint, /^[a-f0-9]{64}$/u)

  const next = reduce(state, result.events)
  const replayed = replayEvents(state, result.events)
  assert.deepEqual(replayed.mechanics.item_appraisals, next.mechanics.item_appraisals)
  assert.equal(next.mechanics.item_appraisals.hero['moon-shard'].base_price_cp, 6_250)
  assert.equal(next.economyLog.at(-1).type, 'appraisal')

  const priced = merchantViewFor(next, 'marten', 'hero').sell_quotes.find((quote) => quote.item_id === 'moon-shard')
  assert.equal(priced.unit_price_cp, 6_250)
  assert.equal(priced.price_provenance, 'server_appraisal_policy')
  assert.equal(priced.appraisal_required, false)
  assert.equal(priced.can_appraise, false)
  assert.equal(priced.can_sell, true)
  assert.equal(priced.max_quantity, 2)

  assert.throws(
    () => execute(command('AppraiseItem', { item_id: 'moon-shard' }), next),
    rulesError('ITEM_ALREADY_APPRAISED'),
  )
})

test('AppraiseItem rejects catalog and quest items before producing an event', () => {
  const catalog = appraisalState({
    itemOverrides: {
      id: 'dagger',
      catalog_id: 'srd_5_2_1:dagger',
      name: 'Кинжал',
      type: 'weapon',
      rarity: 'обычный',
      quantity: 1,
    },
  })
  assert.throws(
    () => execute(command('AppraiseItem', { item_id: 'dagger' }), catalog),
    rulesError('APPRAISAL_NOT_REQUIRED'),
  )

  const quest = appraisalState({
    itemOverrides: {
      id: 'royal-letter',
      name: 'Письмо короля',
      type: 'document',
      rarity: 'сюжетный',
      quest_item: true,
      quantity: 1,
    },
  })
  const quote = merchantViewFor(quest, 'marten', 'hero').sell_quotes.find((candidate) => candidate.item_id === 'royal-letter')
  assert.equal(quote.can_sell, false)
  assert.equal(quote.can_appraise, false)
  assert.equal(quote.appraisal_required, false)
  assert.throws(
    () => execute(command('AppraiseItem', { item_id: 'royal-letter' }), quest),
    rulesError('ITEM_NOT_APPRAISABLE'),
  )
})

test('merchant purse bounds quotes and rejects unaffordable sales atomically', () => {
  const state = appraisalState({ purseCp: 6_249 })
  const appraisal = execute(command('AppraiseItem', { item_id: 'moon-shard' }), state)
  const appraised = reduce(state, appraisal.events)
  const quote = merchantViewFor(appraised, 'marten', 'hero').sell_quotes.find((candidate) => candidate.item_id === 'moon-shard')
  assert.equal(quote.unit_price_cp, 6_250)
  assert.equal(quote.can_afford, false)
  assert.equal(quote.can_sell, false)
  assert.equal(quote.max_quantity, 0)

  const snapshot = structuredClone(appraised)
  assert.throws(
    () => execute(command('SellItem', { item_id: 'moon-shard', quantity: 1 }), appraised),
    rulesError('INSUFFICIENT_MERCHANT_FUNDS'),
  )
  assert.deepEqual(appraised, snapshot)
})

test('full custom sale removes actor appraisal; resale stock retains authority and can be bought back', () => {
  const state = appraisalState()
  const appraisal = execute(command('AppraiseItem', { item_id: 'moon-shard' }), state)
  const appraised = reduce(state, appraisal.events)

  const sale = execute(command('SellItem', {
    item_id: 'moon-shard',
    quantity: 2,
    price_cp: 1,
    base_price_cp: 1,
  }), appraised)
  const saleEvent = sale.events.find((event) => event.event_type === 'MerchantSaleCompleted')
  assert.equal(saleEvent.payload.unit_price_cp, 6_250)
  assert.equal(saleEvent.payload.total_price_cp, 12_500)
  assert.equal(saleEvent.payload.merchant_purse_before_cp, 12_500)
  assert.equal(saleEvent.payload.merchant_purse_after_cp, 0)
  assert.equal(saleEvent.payload.appraisal.base_price_cp, 6_250)

  const sold = reduce(appraised, sale.events)
  assert.equal(sold.players[0].inventory.some((item) => item.id === 'moon-shard'), false)
  assert.equal(sold.mechanics.item_appraisals.hero['moon-shard'], undefined)
  assert.equal(sold.merchants[0].purse_cp, 0)
  const resale = sold.merchants[0].stock.find((stock) => stock.item_id === 'moon-shard')
  assert.ok(resale)
  assert.equal(resale.quantity, 2)
  assert.equal(resale.base_price_cp, 6_250)
  assert.equal(resale.appraisal.base_price_cp, 6_250)

  const buyQuote = merchantViewFor(sold, 'marten', 'hero').buy_quotes.find((quote) => quote.stock_id === resale.stock_id)
  assert.ok(buyQuote)
  assert.equal(buyQuote.unit_price_cp, 6_875)
  assert.equal(buyQuote.max_quantity, 1)
  const purchase = execute(command('BuyItem', {
    stock_id: resale.stock_id,
    quantity: 1,
    price_cp: 1,
  }), sold)
  const purchaseEvent = purchase.events.find((event) => event.event_type === 'MerchantPurchaseCompleted')
  assert.equal(purchaseEvent.payload.unit_price_cp, 6_875)
  assert.equal(purchaseEvent.payload.item_appraisal.base_price_cp, 6_250)

  const bought = reduce(sold, purchase.events)
  assert.equal(bought.players[0].inventory.find((item) => item.id === 'moon-shard').quantity, 1)
  assert.equal(bought.mechanics.item_appraisals.hero['moon-shard'].base_price_cp, 6_250)
  assert.equal(bought.merchants[0].stock.find((stock) => stock.stock_id === resale.stock_id).quantity, 1)
  assert.equal(bought.merchants[0].purse_cp, 6_875)
})

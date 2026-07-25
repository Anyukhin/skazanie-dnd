import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MERCHANT_ECONOMY_CLOCK_EVENT_TYPE,
  MERCHANT_RESTOCK_POLICY_ID,
  MERCHANT_SERVICES_POLICY_ID,
  applyMerchantRestockPlan,
  merchantEconomyClockEventFromPlan,
  merchantRestockCommandFromPlan,
  merchantServiceProposal,
  merchantViewFor,
  normalizeMerchant,
  planMerchantEconomyClock,
  planMerchantRestock,
  quoteMerchantService,
} from '../server/merchant-economy.mjs'

function merchant(overrides = {}) {
  return normalizeMerchant({
    id: 'marten',
    name: 'Marten',
    location: 'Market',
    available: true,
    pricing: {
      buy_markup_bps: 11_000,
      sell_rate_bps: 5_000,
      min_multiplier_bps: 1_000,
      max_multiplier_bps: 30_000,
    },
    stock: [{
      stock_id: 'rope',
      catalog_id: 'srd_5_2_1:rope-hempen-50-feet',
      name: 'Rope',
      type: 'tool',
      quantity: 1,
    }],
    ...overrides,
  })
}

test('merchant services are bounded, server-priced and shown as derived quotes', () => {
  const normalized = merchant({
    services: [
      {
        service_id: 'repair', name: 'Repair kit', kind: 'repair', base_price_cp: 100,
        duration_minutes: 30, tags: ['craft', 'craft', ''], forged_secret: 'not retained',
      },
      { service_id: 'repair', name: 'Duplicate', base_price_cp: 1 },
      { service_id: 'other', name: 'Odd', kind: 'unsupported', base_price_cp: -1, duration_minutes: 99_999 },
    ],
    bargains: { hero: { success: true, pricing_adjustment_bps: -1_000 } },
  })
  assert.equal(normalized.services.length, 2)
  assert.deepEqual(normalized.services[0].tags, ['craft'])
  assert.equal(normalized.services[0].policy_id, MERCHANT_SERVICES_POLICY_ID)
  assert.equal(normalized.services[0].forged_secret, undefined)
  assert.equal(normalized.services[1].kind, 'other')
  assert.equal(normalized.services[1].base_price_cp, 0)
  assert.equal(normalized.services[1].duration_minutes, 10_080)

  const quote = quoteMerchantService(normalized, 'hero', normalized.services[0])
  assert.equal(quote.price_cp, 100)
  assert.equal(quote.bargain_adjustment_bps, -1_000)
  assert.equal(quoteMerchantService(normalized, 'hero', null), null)

  const state = {
    state_version: 7,
    scene: { location: 'Market' },
    players: [{ id: 'hero', currency: { gold: 1 }, inventory: [] }],
    merchants: [normalized],
  }
  const view = merchantViewFor(state, 'marten', 'hero')
  assert.equal(view.service_quotes.length, 2)
  assert.equal(view.service_quotes[0].price_cp, 100)
  assert.equal(view.service_quotes[0].can_afford, true)
  assert.equal(view.merchant.services[0].forged_secret, undefined)
  assert.equal(view.merchant.restock.enabled, false)

  const proposal = merchantServiceProposal(state, 'marten', 'hero', 'repair')
  assert.deepEqual(proposal, {
    proposal_version: 1,
    command_type: 'PurchaseMerchantService',
    merchant_id: 'marten',
    actor_id: 'hero',
    service_id: 'repair',
    expected_state_version: 7,
    price_cp: 100,
    can_afford: true,
    requires_presence: true,
    duration_minutes: 30,
    policy_id: MERCHANT_SERVICES_POLICY_ID,
  })
  assert.equal(merchantServiceProposal({ ...state, scene: { location: 'Docks' } }, 'marten', 'hero', 'repair'), null)
})

test('economy clock creates a deterministic restock command and persists a single checkpoint', () => {
  const initial = merchant({
    restock_policy: {
      enabled: true,
      interval_minutes: 60,
      last_restock_world_minute: 0,
      targets: [{ stock_id: 'rope', target_quantity: 5 }, { stock_id: 'forged', target_quantity: 999 }],
    },
  })
  assert.equal(initial.restock_policy.policy_id, MERCHANT_RESTOCK_POLICY_ID)
  assert.deepEqual(initial.restock_policy.targets, [{ stock_id: 'rope', target_quantity: 5 }])
  assert.equal(planMerchantRestock(initial, 59), null)

  const due = planMerchantRestock(initial, 60)
  assert.deepEqual(due.entries.map((entry) => [entry.stock_id, entry.quantity_before, entry.quantity_added, entry.quantity_after]), [
    ['rope', 1, 4, 5],
  ])
  assert.equal(due.total_quantity_added, 4)
  const command = merchantRestockCommandFromPlan(initial, due)
  assert.equal(command.command_type, 'RestockMerchant')
  assert.deepEqual(command.items.map((item) => [item.stock_id, item.catalog_id, item.quantity]), [
    ['rope', 'srd_5_2_1:rope-hempen-50-feet', 4],
  ])
  const clockEvent = merchantEconomyClockEventFromPlan(initial, due)
  assert.equal(clockEvent.event_type, MERCHANT_ECONOMY_CLOCK_EVENT_TYPE)
  assert.equal(clockEvent.payload.processed_at_world_minute, 60)

  const tampered = { ...due, entries: [{ ...due.entries[0], quantity_added: 999_999, quantity_after: 999_999 }] }
  const restored = applyMerchantRestockPlan(initial, tampered)
  assert.equal(restored.stock[0].quantity, 5)
  assert.equal(restored.restock_policy.last_restock_world_minute, 60)
  assert.equal(planMerchantRestock(restored, 60), null)

  const noChange = planMerchantRestock(restored, 180)
  assert.equal(noChange.entries.length, 0)
  assert.equal(merchantRestockCommandFromPlan(restored, noChange), null)
  const checkpointed = applyMerchantRestockPlan(restored, noChange)
  assert.equal(checkpointed.restock_policy.last_restock_world_minute, 180)
})

test('economy clock plans each merchant from campaign time and ignores disabled policies', () => {
  const due = merchant({
    id: 'due',
    restock_policy: { enabled: true, interval_minutes: 60, targets: [{ stock_id: 'rope', target_quantity: 2 }] },
  })
  const disabled = merchant({
    id: 'disabled',
    restock_policy: { enabled: false, interval_minutes: 60, targets: [{ stock_id: 'rope', target_quantity: 2 }] },
  })
  const plans = planMerchantEconomyClock({
    mechanics: { world_time: { elapsed_minutes: 60 } },
    merchants: [due, disabled],
  })
  assert.equal(plans.length, 1)
  assert.equal(plans[0].merchant_id, 'due')
  assert.equal(plans[0].total_quantity_added, 1)
})

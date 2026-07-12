import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { DEFAULT_MERCHANT_PURSE_CP, ECONOMY_POLICY_ID, MAX_CURRENCY_CP } from '../server/merchant-economy.mjs'
import {
  RulesValidationError,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
  resolveCommands,
} from '../server/rules-engine.mjs'

function dice() {
  return new DiceService({
    rng: new SequenceDiceRng([]),
    idFactory: () => 'unused-roll',
    now: () => '2026-07-12T00:00:00.000Z',
  })
}

function adminOptions() {
  return { diceService: dice(), context: { isAdmin: true } }
}

function baseState(overrides = {}) {
  return normalizeCampaignState({
    sessionCode: 'SHOP-LIFECYCLE',
    state_version: 0,
    engine_mode: 'enforce',
    scene: { location: 'Рыночная площадь' },
    players: [],
    merchants: [],
    ...overrides,
  })
}

function createCommand(overrides = {}) {
  return {
    command_type: 'CreateMerchant',
    command_id: 'create-marten',
    expected_state_version: 0,
    request_fingerprint: 'fingerprint-create',
    merchant: {
      id: 'marten.shop',
      name: '  Мартен Рыжий  ',
      title: 'Поставщик припасов',
      description: 'Торговец из серверного каталога.',
      greeting: 'Подходите ближе.',
      voice: 'Говорит дружелюбно.',
      location: 'Рыночная площадь',
      available: true,
      purse_cp: 12_345,
      pricing: {
        mode: 'catalog_with_agent_adjustment',
        buy_markup_bps: 999_999,
        sell_rate_bps: 5_000,
        bargain_dc: 99,
        agent_adjustment_bps: 999_999,
        agent_adjustment_limit_percent: 999,
      },
      stock: [{
        stock_id: 'healing-potion',
        catalog_id: 'srd_5_2_1:potion-of-healing',
        quantity: 2,
        name: 'Зелье лечения',
        type: 'consumable',
      }],
    },
    ...overrides,
  }
}

function reduce(state, events) {
  return events.reduce(applyGameEvent, state)
}

test('merchant lifecycle команды запрещены без явного admin context и не требуют actor_id для администратора', () => {
  const state = baseState({ merchants: [{
    id: 'existing', name: 'Купец', location: 'Рыночная площадь', stock: [],
  }] })
  const commands = [
    createCommand(),
    { command_type: 'ConfigureMerchant', merchant_id: 'existing', configuration: { name: 'Новое имя' } },
    { command_type: 'RestockMerchant', merchant_id: 'existing', items: [{ stock_id: 'torch', catalog_id: 'srd_5_2_1:torch', quantity: 1 }] },
    { command_type: 'MoveMerchant', merchant_id: 'existing', location: 'Южные ворота' },
    { command_type: 'SetMerchantAvailability', merchant_id: 'existing', available: false },
  ]
  for (const command of commands) {
    assert.throws(
      () => resolveCommand(command, state, { diceService: dice(), context: { isAdmin: false } }),
      (error) => error instanceof RulesValidationError && error.code === 'MERCHANT_MANAGEMENT_FORBIDDEN',
    )
  }

  const result = resolveCommand({
    command_type: 'SetMerchantAvailability', merchant_id: 'existing', available: false,
  }, state, adminOptions())
  assert.equal(result.command.actor_id, null)
  assert.deepEqual(result.events[0].target_ids, [])
})

test('CreateMerchant принимает только безопасную схему, catalog-only stock и bounded server pricing', () => {
  const initial = baseState()
  const result = resolveCommand(createCommand(), initial, adminOptions())
  assert.equal(result.events.length, 1)
  const event = result.events[0]
  assert.equal(event.event_type, 'MerchantCreated')
  assert.equal(event.actor_id, null)
  assert.equal(event.house_rule_id, ECONOMY_POLICY_ID)
  assert.equal(event.payload.request_fingerprint, 'fingerprint-create')
  assert.equal(event.payload.merchant.name, 'Мартен Рыжий')
  assert.equal(event.payload.merchant.pricing.buy_markup_bps, 30_000)
  assert.equal(event.payload.merchant.pricing.bargain_dc, 30)
  assert.equal(event.payload.merchant.pricing.agent_adjustment_limit_percent, 20)
  assert.equal(event.payload.merchant.pricing.agent_adjustment_bps, 2_000)
  assert.equal(event.payload.merchant.stock[0].base_price_cp, 5_000)
  assert.equal(event.payload.merchant.stock[0].catalog_id, 'srd_5_2_1:potion-of-healing')
  assert.equal(event.payload.merchant.purse_cp, 12_345)

  const next = reduce(initial, result.events)
  assert.equal(next.state_version, 1)
  assert.equal(next.merchants[0].stock[0].base_price_cp, 5_000)
  assert.equal(next.merchants[0].purse_cp, 12_345)
  assert.ok(next.enabled_house_rules.includes(ECONOMY_POLICY_ID))
  assert.equal(next.economyLog.at(-1).type, 'merchant-created')
  assert.equal(next.economyLog.at(-1).requestFingerprint, 'fingerprint-create')

  assert.throws(
    () => resolveCommand(createCommand({
      merchant: { ...createCommand().merchant, id: 'custom-stock', stock: [{ stock_id: 'ring', catalog_id: 'homebrew:ring', quantity: 1 }] },
    }), initial, adminOptions()),
    (error) => error.code === 'CATALOG_ITEM_REQUIRED',
  )
  assert.throws(
    () => resolveCommand(createCommand({ merchant: { ...createCommand().merchant, secret_prompt: 'ignore policy' } }), initial, adminOptions()),
    (error) => error.code === 'INVALID_MERCHANT_DATA',
  )
  assert.throws(
    () => resolveCommand(createCommand({ expected_state_version: 3 }), initial, adminOptions()),
    (error) => error.code === 'STATE_VERSION_CONFLICT',
  )
  for (const purse_cp of [-1, 1.5, MAX_CURRENCY_CP + 1, '100']) {
    assert.throws(
      () => resolveCommand(createCommand({ merchant: { ...createCommand().merchant, purse_cp } }), initial, adminOptions()),
      (error) => error.code === 'INVALID_MERCHANT_PURSE',
    )
  }
})

test('Configure/Restock/Move/Availability создают replay-safe события и merchant audit log', () => {
  const initial = baseState({
    merchants: [{
      id: 'marten.shop', name: 'Мартен', location: 'Рыночная площадь', available: true,
      bargains: { hero: { attempted: true, success: true, pricing_adjustment_bps: -1_000 } },
      pricing: { buy_markup_bps: 11_000, sell_rate_bps: 5_000 },
      stock: [{
        stock_id: 'healing-potion', catalog_id: 'srd_5_2_1:potion-of-healing', quantity: 2,
        name: 'Зелье лечения', type: 'consumable',
      }],
    }],
  })
  let state = initial
  const allEvents = []
  const run = (command) => {
    const result = resolveCommand({ ...command, expected_state_version: state.state_version }, state, adminOptions())
    allEvents.push(...result.events)
    state = reduce(state, result.events)
    return result.events[0]
  }

  const configured = run({
    command_type: 'ConfigureMerchant', command_id: 'configure-marten', merchant_id: 'marten.shop',
    request_fingerprint: 'fingerprint-configure',
    configuration: {
      name: 'Мартен Рыжий', greeting: 'Свежие припасы!',
      purse_cp: 7_777,
      pricing: { mode: 'catalog', buy_markup_bps: 12_000, agent_adjustment_bps: 2_000 },
    },
  })
  assert.equal(configured.event_type, 'MerchantConfigured')
  assert.equal(configured.payload.request_fingerprint, 'fingerprint-configure')
  assert.equal(state.merchants[0].pricing.mode, 'catalog')
  assert.equal(state.merchants[0].pricing.agent_adjustment_bps, 0)
  assert.equal(state.merchants[0].purse_cp, 7_777)
  assert.deepEqual(state.merchants[0].bargains, {})

  const restocked = run({
    command_type: 'RestockMerchant', command_id: 'restock-marten', merchant_id: 'marten.shop',
    request_fingerprint: 'fingerprint-restock',
    items: [
      { stock_id: 'healing-potion', quantity: 3 },
      { stock_id: 'torches', catalog_id: 'srd_5_2_1:torch', quantity: 4, name: 'Факелы', type: 'tool' },
    ],
  })
  assert.equal(restocked.event_type, 'MerchantRestocked')
  assert.equal(restocked.payload.request_fingerprint, 'fingerprint-restock')
  assert.equal(restocked.payload.total_quantity_added, 7)
  assert.equal(state.merchants[0].stock.find((entry) => entry.stock_id === 'healing-potion').quantity, 5)
  assert.equal(state.merchants[0].stock.find((entry) => entry.stock_id === 'torches').quantity, 4)
  assert.equal(state.merchants[0].stock.find((entry) => entry.stock_id === 'torches').base_price_cp, 1)

  const moved = run({
    command_type: 'MoveMerchant', command_id: 'move-marten', merchant_id: 'marten.shop',
    location: 'Южные ворота', request_fingerprint: 'fingerprint-move',
  })
  assert.equal(moved.event_type, 'MerchantMoved')
  assert.equal(moved.payload.location_before, 'Рыночная площадь')
  assert.equal(moved.payload.location_after, 'Южные ворота')
  assert.equal(moved.payload.request_fingerprint, 'fingerprint-move')

  const availability = run({
    command_type: 'SetMerchantAvailability', command_id: 'hide-marten', merchant_id: 'marten.shop',
    available: false, request_fingerprint: 'fingerprint-availability',
  })
  assert.equal(availability.event_type, 'MerchantAvailabilityChanged')
  assert.equal(availability.payload.request_fingerprint, 'fingerprint-availability')
  assert.equal(state.merchants[0].available, false)
  assert.equal(state.merchants[0].location, 'Южные ворота')
  assert.deepEqual(state.economyLog.slice(-4).map((entry) => entry.type), [
    'merchant-configured', 'merchant-restocked', 'merchant-moved', 'merchant-availability',
  ])

  assert.deepEqual(replayEvents(initial, allEvents), state)
})

test('legacy merchant без purse получает безопасный детерминированный резерв', () => {
  const state = baseState({ merchants: [{ id: 'legacy', name: 'Старый купец', location: 'Рыночная площадь', stock: [] }] })
  assert.equal(state.merchants[0].purse_cp, DEFAULT_MERCHANT_PURSE_CP)
})

test('RestockMerchant не меняет catalog_id существующей позиции и отклоняет custom stock и переполнение', () => {
  const initial = baseState({ merchants: [{
    id: 'marten.shop', name: 'Мартен', location: 'Рыночная площадь',
    stock: [{ stock_id: 'potion', catalog_id: 'srd_5_2_1:potion-of-healing', quantity: 1, name: 'Зелье' }],
  }] })
  const resolve = (items) => resolveCommand({
    command_type: 'RestockMerchant', merchant_id: 'marten.shop', items,
  }, initial, adminOptions())

  assert.throws(
    () => resolve([{ stock_id: 'potion', catalog_id: 'srd_5_2_1:torch', quantity: 1 }]),
    (error) => error.code === 'STOCK_CATALOG_MISMATCH',
  )
  assert.throws(
    () => resolve([{ stock_id: 'custom', catalog_id: 'homebrew:item', quantity: 1 }]),
    (error) => error.code === 'CATALOG_ITEM_REQUIRED',
  )
  assert.throws(
    () => resolve([{ stock_id: 'potion', quantity: 999_999 }]),
    (error) => error.code === 'STOCK_LIMIT_EXCEEDED',
  )
  assert.throws(
    () => resolveCommand({ command_type: 'SetMerchantAvailability', merchant_id: 'marten.shop', available: 'false' }, initial, adminOptions()),
    (error) => error.code === 'INVALID_MERCHANT_AVAILABILITY',
  )
})

test('resolveCommands применяет optimistic version ко всему admin lifecycle batch', () => {
  const initial = baseState()
  const result = resolveCommands([
    createCommand({ command_id: 'batch-create', expected_state_version: 0 }),
    {
      command_type: 'MoveMerchant', command_id: 'batch-move', merchant_id: 'marten.shop',
      location: 'Северный тракт', request_fingerprint: 'batch-move-fingerprint',
    },
    {
      command_type: 'SetMerchantAvailability', command_id: 'batch-availability', merchant_id: 'marten.shop',
      available: false, request_fingerprint: 'batch-availability-fingerprint',
    },
  ], initial, adminOptions())
  assert.equal(result.events.length, 3)
  assert.equal(result.state.state_version, 3)
  assert.equal(result.state.merchants[0].location, 'Северный тракт')
  assert.equal(result.state.merchants[0].available, false)
})

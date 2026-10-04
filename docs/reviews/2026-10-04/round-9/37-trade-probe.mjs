import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FileEventStore } from '../../../../server/event-store.mjs'
import { DiceService, SequenceDiceRng } from '../../../../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../../../../server/rules-engine.mjs'
import { currencyToCopper, merchantViewFor } from '../../../../server/merchant-economy.mjs'

const diceService = new DiceService({
  rng: new SequenceDiceRng([]),
  idFactory: () => 'trade-probe-roll',
  now: () => new Date('2026-10-04T00:00:00.000Z'),
})

const initialState = normalizeCampaignState({
  sessionCode: 'TRADE-PROBE',
  state_version: 0,
  scene: { location: 'рынок' },
  partyMemberIds: ['hero-a', 'hero-b'],
  players: [
    { id: 'hero-a', hp: 10, maxHp: 10, currency: { gold: 100 }, inventory: [] },
    { id: 'hero-b', hp: 10, maxHp: 10, currency: { gold: 100 }, inventory: [] },
  ],
  merchants: [{
    id: 'merchant', name: 'Лавочник', location: 'рынок', available: true, purse_cp: 0,
    stock: [{ stock_id: 'last-torch', catalog_id: 'srd_5_2_1:torch', quantity: 1 }],
  }],
})

assert.equal(currencyToCopper({ copper: 1, silver: 1, gold: 1, platinum: 1 }), 1_111)
const quoteA = merchantViewFor(initialState, 'merchant', 'hero-a').buy_quotes[0]
const quoteB = merchantViewFor(initialState, 'merchant', 'hero-b').buy_quotes[0]
assert.equal(quoteA.unit_price_cp, quoteB.unit_price_cp)

const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-trade-contract-'))
try {
  const store = new FileEventStore({
    rootDir,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    initialStateFactory: () => initialState,
    snapshotEvery: 0,
  })
  await store.initializeCampaign({ campaignId: 'TRADE-PROBE', initialState })

  const commandFor = (actorId) => resolveCommand({
    command_type: 'BuyItem', actor_id: actorId, merchant_id: 'merchant',
    stock_id: 'last-torch', quantity: 1, expected_state_version: 0,
  }, initialState, { diceService, context: { allowedActorIds: [actorId] } })

  const [first, second] = await Promise.allSettled([
    store.commit({ campaign_id: 'TRADE-PROBE', expected_state_version: 0, idempotency_key: 'hero-a-buy', command_id: 'hero-a-buy', events: commandFor('hero-a').events }),
    store.commit({ campaign_id: 'TRADE-PROBE', expected_state_version: 0, idempotency_key: 'hero-b-buy', command_id: 'hero-b-buy', events: commandFor('hero-b').events }),
  ])
  const finalState = (await store.load('TRADE-PROBE')).state
  const statuses = [first, second].map((result) => result.status)
  const errors = [first, second].map((result) => result.status === 'rejected' ? result.reason?.code ?? String(result.reason) : null)

  assert.deepEqual(statuses.sort(), ['fulfilled', 'rejected'])
  assert.equal(errors.filter((code) => code === 'STATE_VERSION_CONFLICT').length, 1)
  assert.equal(finalState.merchants[0].stock[0].quantity, 0)
  assert.equal(finalState.players.filter((player) => player.inventory.length === 1).length, 1)

  console.log(JSON.stringify({
    quote_unit_price_cp: quoteA.unit_price_cp,
    statuses,
    errors,
    final_stock: finalState.merchants[0].stock[0].quantity,
    buyers_with_item: finalState.players.filter((player) => player.inventory.length === 1).map((player) => player.id),
  }, null, 2))
} finally {
  rmSync(rootDir, { recursive: true, force: true })
}

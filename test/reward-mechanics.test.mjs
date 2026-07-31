import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
  validateCommand,
} from '../server/rules-engine.mjs'

const diceService = new DiceService({ rng: new SequenceDiceRng([]) })

function rewardState() {
  return normalizeCampaignState({
    players: [
      {
        id: 'owner',
        character: 'Ада',
        level: 2,
        hp: 12,
        maxHp: 12,
        abilities: { str: 12, dex: 12, con: 12 },
        currency: { copper: 5, silver: 0, gold: 1, platinum: 0 },
        inventory: [{
          id: 'loot-rope',
          catalog_id: 'srd_5_2_1:rope-hempen-50-feet',
          name: 'Пеньковая верёвка',
          type: 'tool',
          quantity: 2,
          weight: 10,
        }],
      },
      {
        id: 'recipient',
        character: 'Бор',
        level: 2,
        hp: 12,
        maxHp: 12,
        abilities: { str: 14, dex: 10, con: 12 },
        currency: {},
        inventory: [],
      },
    ],
    partyMemberIds: ['owner', 'recipient'],
  })
}

test('монеты врагов выдаёт только сервер, событие сохраняет точный баланс и replay', () => {
  const state = rewardState()
  assert.throws(() => validateCommand({
    command_type: 'AwardCurrency',
    actor_id: 'owner',
    currency: { gold: 5 },
  }, state, { allowedActorIds: ['owner'] }), (error) => error.code === 'CURRENCY_AWARD_FORBIDDEN')

  const result = resolveCommand({
    command_type: 'AwardCurrency',
    actor_id: 'owner',
    currency: { copper: 7, silver: 2, gold: 5, platinum: 1 },
  }, state, {
    diceService,
    context: { isDirector: true, allowedActorIds: ['owner'] },
  })
  assert.deepEqual(result.events.map((event) => event.event_type), ['CurrencyAwarded'])
  assert.equal(result.events[0].payload.amount_cp, 1_527)
  const replayed = replayEvents(state, result.events)
  assert.deepEqual(replayed.players[0].currency, { copper: 2, silver: 3, gold: 6, platinum: 1 })
})

test('владелец делится добычей атомарно, чужой герой не может распорядиться его вещью', () => {
  const state = rewardState()
  const command = {
    command_type: 'TransferItem',
    command_id: 'share-loot-1',
    actor_id: 'owner',
    recipient_id: 'recipient',
    item_id: 'loot-rope',
    quantity: 1,
  }
  assert.throws(
    () => validateCommand(command, state, { allowedActorIds: ['recipient'] }),
    (error) => error.code === 'ACTOR_FORBIDDEN',
  )
  const result = resolveCommand(command, state, {
    diceService,
    context: { allowedActorIds: ['owner'] },
  })
  assert.deepEqual(result.events.map((event) => event.event_type), ['ItemTransferred'])
  const replayed = replayEvents(state, result.events)
  assert.equal(replayed.players.find((hero) => hero.id === 'owner').inventory[0].quantity, 1)
  assert.equal(replayed.players.find((hero) => hero.id === 'recipient').inventory[0].quantity, 1)
  assert.equal(
    replayed.players.reduce((total, hero) => total + hero.inventory.reduce((sum, item) => sum + item.quantity, 0), 0),
    2,
  )
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildNpcSocialCheckPolicy } from '../server/npc-social-check.mjs'
import { merchantViewFor, quoteMerchantBuyUnit, quoteMerchantSellUnit } from '../server/merchant-economy.mjs'
import {
  REPUTATION_PRICE_BPS,
  factionIdsForNpc,
  reputationPriceBps,
  reputationScoreFor,
  reputationStandingFor,
  reputationTier,
} from '../server/reputation-policy.mjs'

function world({ reputations = {}, tags = ['faction:guild'] } = {}) {
  return {
    autonomy: { reputations },
    scene: { title: 'Рынок', location: 'Рынок' },
    players: [{ id: 'hero', character: 'Ада' }],
    partyMemberIds: ['hero'],
    social: {
      npcs: [{
        id: 'merchant-1', name: 'Марта', role: 'торговка', location: 'Рынок',
        public_summary: 'Держит лавку.', voice: 'Сухо.', visibility: 'party', available: true, tags,
      }],
      relationships: {}, promises: [], conversations: [],
    },
  }
}

const merchant = {
  id: 'merchant-1', name: 'Марта', location: 'Рынок', available: true,
  pricing: { mode: 'catalog_with_agent_adjustment' },
  purse_cp: 100_000,
  stock: [{ stock_id: 's1', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье лечения', type: 'consumable', quantity: 5, base_price_cp: 5_000 }],
}

test('ступени репутации выводятся из худшей фракции NPC, а не из средней', () => {
  const state = world({ reputations: { guild: 60, watch: -70 }, tags: ['faction:guild', 'faction:watch'] })
  const npc = state.social.npcs[0]

  assert.deepEqual(factionIdsForNpc(npc), ['guild', 'watch'])
  // Членство в дружественной гильдии не отменяет вражды со стражей.
  assert.equal(reputationScoreFor(state, npc), -70)
  assert.equal(reputationTier(-70), 'reviled')
})

test('NPC без фракций репутацией не затронут — прежнее поведение сохранено', () => {
  const state = world({ reputations: { guild: -100 }, tags: [] })
  const standing = reputationStandingFor(state, 'merchant-1')

  assert.deepEqual(standing.faction_ids, [])
  assert.equal(standing.score, 0)
  assert.equal(standing.tier, 'unknown')
  assert.equal(standing.price_adjustment_bps, 0)
  assert.equal(standing.social_dc_shift, 0)
  assert.equal(standing.services_available, true)
})

test('ненавидимому отряду продают дороже, а выкупают дешевле', () => {
  const hated = reputationPriceBps(world({ reputations: { guild: -80 } }), 'merchant-1')
  const honoured = reputationPriceBps(world({ reputations: { guild: 80 } }), 'merchant-1')
  assert.equal(hated, REPUTATION_PRICE_BPS.reviled)
  assert.equal(honoured, REPUTATION_PRICE_BPS.honoured)

  const stock = merchant.stock[0]
  const neutralBuy = quoteMerchantBuyUnit(merchant, 'hero', stock, 0).unit_price_cp
  const hatedBuy = quoteMerchantBuyUnit(merchant, 'hero', stock, hated).unit_price_cp
  const honouredBuy = quoteMerchantBuyUnit(merchant, 'hero', stock, honoured).unit_price_cp
  assert.ok(hatedBuy > neutralBuy, `покупка у врага должна быть дороже: ${hatedBuy} против ${neutralBuy}`)
  assert.ok(honouredBuy < neutralBuy, `покупка у друга должна быть дешевле: ${honouredBuy} против ${neutralBuy}`)

  const item = { id: 'i1', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье лечения', quantity: 1, type: 'consumable' }
  const neutralSell = quoteMerchantSellUnit(merchant, 'hero', item, null, 0).unit_price_cp
  const hatedSell = quoteMerchantSellUnit(merchant, 'hero', item, null, hated).unit_price_cp
  assert.ok(hatedSell < neutralSell, `выкуп у врага должен быть дешевле: ${hatedSell} против ${neutralSell}`)
})

test('поправка репутации попадает в котировку отдельным полем', () => {
  const quote = quoteMerchantBuyUnit(merchant, 'hero', merchant.stock[0], REPUTATION_PRICE_BPS.distrusted)
  assert.equal(quote.reputation_adjustment_bps, REPUTATION_PRICE_BPS.distrusted)
})

test('репутация не может увести цену за границы политики торговца', () => {
  const bounded = { ...merchant, pricing: { mode: 'catalog_with_agent_adjustment', min_multiplier_bps: 10_000, max_multiplier_bps: 10_000 } }
  const hated = quoteMerchantBuyUnit(bounded, 'hero', bounded.stock[0], REPUTATION_PRICE_BPS.reviled)
  assert.equal(hated.multiplier_bps, 10_000, 'жёсткие границы множителя обязаны перекрывать репутацию')
})

test('услуги закрыты только для ненавидимых; товар продают всем', () => {
  assert.equal(reputationStandingFor(world({ reputations: { guild: -80 } }), 'merchant-1').services_available, false)
  assert.equal(reputationStandingFor(world({ reputations: { guild: -30 } }), 'merchant-1').services_available, true)
  assert.equal(reputationStandingFor(world({ reputations: { guild: 0 } }), 'merchant-1').services_available, true)
})

test('слава отряда двигает СЛ социальной проверки, но не делает её невозможной', () => {
  const neutral = buildNpcSocialCheckPolicy({
    state: world({ reputations: {} }), npcId: 'merchant-1', heroId: 'hero',
    message: 'Убеждаю её рассказать про караван', turnId: 't1',
  })
  const hated = buildNpcSocialCheckPolicy({
    state: world({ reputations: { guild: -80 } }), npcId: 'merchant-1', heroId: 'hero',
    message: 'Убеждаю её рассказать про караван', turnId: 't1',
  })
  const honoured = buildNpcSocialCheckPolicy({
    state: world({ reputations: { guild: 80 } }), npcId: 'merchant-1', heroId: 'hero',
    message: 'Убеждаю её рассказать про караван', turnId: 't1',
  })

  assert.equal(neutral.reputation_tier, 'unknown')
  assert.equal(hated.reputation_tier, 'reviled')
  assert.ok(hated.difficulty > neutral.difficulty, `врагу должно быть труднее: ${hated.difficulty} против ${neutral.difficulty}`)
  assert.ok(honoured.difficulty < neutral.difficulty, `другу должно быть легче: ${honoured.difficulty} против ${neutral.difficulty}`)
  assert.ok(hated.difficulty <= 25, 'СЛ обязана остаться в границах политики')
})

/**
 * Ревью 2026-07-28 поймало расхождение: витрина (`merchantViewFor`) считала
 * цену без репутации, а исполнение `BuyItem` — с ней. Игрок видел одну цену,
 * платил другую — нарушение контракта «явный итог до подтверждения команды».
 * Паритет витрины и сделки закреплён здесь навсегда.
 */
test('витрина показывает ту же цену, которую возьмёт сделка, и объявляет поправку славы', () => {
  const state = {
    ...world({ reputations: { guild: -80 } }),
    state_version: 7,
    merchants: [{ ...merchant }],
  }
  state.players = [{ id: 'hero', character: 'Ада', currency: { gold: 100 }, inventory: [] }]

  const view = merchantViewFor(state, 'merchant-1', 'hero')
  assert.ok(view, 'витрина обязана собраться')
  const shown = view.buy_quotes.find((quote) => quote.stock_id === 's1')
  const charged = quoteMerchantBuyUnit(state.merchants[0], 'hero', state.merchants[0].stock[0], reputationPriceBps(state, 'merchant-1'))

  assert.equal(shown.unit_price_cp, charged.unit_price_cp, 'цена в витрине обязана совпадать с ценой сделки')
  assert.equal(shown.breakdown.reputation_adjustment_percent, REPUTATION_PRICE_BPS.reviled / 100, 'поправка славы объявляется в расшифровке')

  // Отказ в услугах виден заранее и с причиной, а не только ошибкой команды.
  const stateWithService = { ...state, merchants: [{ ...merchant, services: [{ service_id: 'svc-room', name: 'Ночлег', kind: 'lodging', base_price_cp: 100, available: true }] }] }
  const refused = merchantViewFor(stateWithService, 'merchant-1', 'hero')
  const serviceQuote = refused.service_quotes.find((quote) => quote.service_id === 'svc-room')
  assert.equal(serviceQuote.available, false)
  assert.match(String(serviceQuote.unavailable_reason), /славой/u)
})

/**
 * Найдено 2026-07-28 при работе над репутацией. `difficultyFor` умеет уважать
 * заранее заданную `profile.social_dcs[skill]` и возвращать её без поправок,
 * но нормализатор профиля NPC (`safeProfile` в `server/npc-social.mjs`) поле
 * `social_dcs` не переносит: у него явный allowlist полей. Значит ветка
 * ручной СЛ недостижима, и все СЛ считаются политикой.
 *
 * Это не сломано — просто мёртвая ветка. Тест фиксирует факт, чтобы правка
 * схемы профиля не прошла мимо: как только `social_dcs` начнёт доезжать,
 * проверка упадёт и заставит решить, перебивает ли ручная СЛ репутацию.
 */
test('ручная СЛ пока недостижима: профиль NPC не переносит social_dcs', () => {
  const state = world({ reputations: { guild: -80 } })
  state.social.npcs[0].social_dcs = { persuasion: 11 }
  const policy = buildNpcSocialCheckPolicy({
    state, npcId: 'merchant-1', heroId: 'hero', message: 'Убеждаю её', turnId: 't1',
  })
  assert.notEqual(policy.difficulty, 11, 'social_dcs начал доезжать до политики — решите, перебивает ли он репутацию')
  assert.equal(policy.reputation_tier, 'reviled')
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { DiceService } from '../server/dice-service.mjs'
import { WANTED_CRIME_POINTS } from '../server/law-and-order.mjs'
import { currencyToCopper, merchantViewFor, normalizeInventoryItem, quoteMerchantSellUnit } from '../server/merchant-economy.mjs'
import { buildNpcSocialCheckPolicy, classifyBribeTier } from '../server/npc-social-check.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand, validateCommand } from '../server/rules-engine.mjs'
import {
  BRIBE_TIERS,
  FENCE_TAG,
  INCORRUPTIBLE_DC_PENALTY,
  INCORRUPTIBLE_TAG,
  STOLEN_DISCOUNT_BPS,
  bribeTierAmounts,
  npcIsFence,
  npcIsIncorruptible,
} from '../server/underworld.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'

const PLAYER = Object.freeze({ id: 'user-1', role: 'player' })
const ADMIN = Object.freeze({ id: 'gm', role: 'admin' })

function dice() {
  let id = 0
  return new DiceService({ rng: { randint: (_min, max) => max }, idFactory: () => `roll-${++id}`, now: () => '2026-08-16T00:00:00.000Z' })
}

const stolenItem = () => normalizeInventoryItem({
  id: 'loot-1', catalog_id: 'srd_5_2_1:dagger', name: 'Кинжал', type: 'weapon', quantity: 1, weight: 1, origin: 'stolen',
})
const honestItem = () => normalizeInventoryItem({
  id: 'buy-1', catalog_id: 'srd_5_2_1:dagger', name: 'Кинжал', type: 'weapon', quantity: 1, weight: 1, origin: 'purchased',
})

/**
 * Скупщика назначает тег автора, а вот **честного** тегом не назначить: тег
 * только добавляет свойство, снять его нельзя, иначе «неподкупный» в данных
 * читался бы как «подкупный», и правило зависело бы от того, чего в записи нет.
 * Поэтому честный торговец берётся сидом — но не наугад: код кампании
 * подбирается один раз и детерминированно, так что тест не лотерея.
 */
const HONEST_SESSION = (() => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const code = `UNDER-${attempt}`
    if (!npcIsFence({ sessionCode: code, worldMap: { currentLocationId: 'market' } }, { id: 'merchant-1' })) return code
  }
  throw new Error('не нашлось кампании, где этот торговец честен')
})()

function fixture({ fence = false, incorruptible = false, wantedPoints = 0, items = [stolenItem(), honestItem()] } = {}) {
  return normalizeCampaignState({
    sessionCode: HONEST_SESSION,
    partyMemberIds: ['hero'],
    members: [{ user_id: 'user-1', hero_id: 'hero', role: 'player' }],
    players: [{
      id: 'hero', character: 'Ильма', hp: 30, maxHp: 30, armor: 14, speed: 30, level: 3, proficiency: 2, x: 1, y: 1,
      abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 12, cha: 16 },
      currency: { copper: 0, silver: 0, gold: 20, platinum: 0 }, inventory: items,
    }],
    social: {
      npcs: [{
        id: 'merchant-1', name: 'Горазд', role: 'купец', location: 'Рынок', available: true, visibility: 'party',
        tags: [...(fence ? [FENCE_TAG] : []), ...(incorruptible ? [INCORRUPTIBLE_TAG] : [])],
      }],
    },
    merchants: [{
      id: 'merchant-1', name: 'Горазд', location: 'Рынок', available: true, purse_cp: 500_000, stock: [],
    }],
    worldMap: {
      seed: 'under-seed',
      regions: [{ id: 'region-1', name: 'Приречье', biome: 'plains', x: 200, y: 200, radius: 205 }],
      locations: [{ id: 'market', name: 'Рынок', kind: 'town', x: 200, y: 200, regionId: 'region-1' }],
      currentLocationId: 'market',
    },
    ...(wantedPoints ? { law: { schema_version: 1, wanted: [{ region_id: 'region-1', region_name: 'Приречье', points: wantedPoints, crime_ids: [], updated_at_minutes: 0 }] } } : {}),
    scene: { turn: 1, location: 'Рынок', cells: Array.from({ length: 36 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true })) },
  })
}

function commit(state, command) {
  const commandId = `${command.command_type}-${Math.random().toString(36).slice(2, 10)}`
  const result = resolveCommand(
    { campaign_id: 'campaign-1', command_id: commandId, server_authoritative: true, ...command },
    state,
    { diceService: dice(), context: { isAdmin: true } },
  )
  const events = result.events.map((event, index) => ({ ...event, event_id: event.event_id ?? `${commandId}:${index + 1}` }))
  return { events, state: events.reduce(applyGameEvent, state) }
}

const eventTypes = (events) => events.map((event) => event.event_type)

/** Проверка разговора живёт только в серверном контуре — контекст обязателен. */
function commitSocial(state, policy) {
  const commandId = `social-${Math.random().toString(36).slice(2, 10)}`
  const result = resolveCommand(
    { campaign_id: 'campaign-1', command_id: commandId, server_authoritative: true, command_type: 'MakeAbilityCheck', social_check: { check_id: policy.check_id } },
    state,
    { diceService: dice(), context: { isAdmin: true, isSocialController: true, socialCheck: policy } },
  )
  const events = result.events.map((event, index) => ({ ...event, event_id: event.event_id ?? `${commandId}:${index + 1}` }))
  return { events, state: events.reduce(applyGameEvent, state) }
}

// ---------------------------------------------------------------------------
// Скупщик

test('скупщик редок, выводится из сида и уважает руку ведущего', () => {
  const state = fixture()
  const npcs = Array.from({ length: 400 }, (_, index) => ({ id: `npc-${index}` }))
  const fences = npcs.filter((npc) => npcIsFence(state, npc)).length
  assert.ok(fences > 0 && fences < npcs.length / 3, `скупщиков ${fences} из ${npcs.length} — доля неправдоподобна`)
  // Одна и та же запись даёт один и тот же ответ: replay обязан сойтись.
  assert.equal(npcIsFence(state, npcs[7]), npcIsFence(state, npcs[7]))
  assert.equal(npcIsFence(state, { id: 'x', tags: [FENCE_TAG] }), true, 'явный тег автора сильнее сида')
  assert.equal(npcIsIncorruptible(state, { id: 'x', tags: [INCORRUPTIBLE_TAG] }), true)
  assert.equal(npcIsFence(state, {}), false)
})

test('скидка скупщика — отдельное слагаемое и не сливается с репутацией', () => {
  const merchant = { id: 'merchant-1', pricing: {} }
  const item = stolenItem()
  const plain = quoteMerchantSellUnit(merchant, 'hero', item, null, 0, 0)
  const discounted = quoteMerchantSellUnit(merchant, 'hero', item, null, 0, STOLEN_DISCOUNT_BPS)
  assert.ok(discounted.unit_price_cp < plain.unit_price_cp, 'краденое берут дешевле')
  assert.equal(discounted.stolen_adjustment_bps, -STOLEN_DISCOUNT_BPS)
  assert.equal(plain.stolen_adjustment_bps, undefined, 'у некраденого шага в разборе нет')
  // Слагаемые независимы: слава отряда своё поле не теряет и не удваивает.
  const withFame = quoteMerchantSellUnit(merchant, 'hero', item, null, 800, STOLEN_DISCOUNT_BPS)
  assert.equal(withFame.reputation_adjustment_bps, 800)
  assert.equal(withFame.stolen_adjustment_bps, -STOLEN_DISCOUNT_BPS)
})

test('скупщик берёт краденое со скидкой, честный отказывается, некраденое — как раньше', () => {
  const fenceView = merchantViewFor(fixture({ fence: true }), 'merchant-1', 'hero')
  const fenceStolen = fenceView.sell_quotes.find((quote) => quote.item_id === 'loot-1')
  const fenceHonest = fenceView.sell_quotes.find((quote) => quote.item_id === 'buy-1')
  assert.equal(fenceStolen.can_sell, true)
  assert.ok(fenceStolen.unit_price_cp < fenceHonest.unit_price_cp, 'скупщик платит за краденое меньше')
  assert.equal(fenceStolen.breakdown.stolen_adjustment_percent, -STOLEN_DISCOUNT_BPS / 100)
  assert.equal(fenceHonest.breakdown.stolen_adjustment_percent, undefined)

  const honestView = merchantViewFor(fixture({ fence: false }), 'merchant-1', 'hero')
  const refused = honestView.sell_quotes.find((quote) => quote.item_id === 'loot-1')
  assert.equal(refused.can_sell, false)
  assert.match(refused.reason, /не берёт чужие вещи/u)
  // Некраденое честный торговец берёт ровно как раньше.
  const honestOk = honestView.sell_quotes.find((quote) => quote.item_id === 'buy-1')
  assert.equal(honestOk.can_sell, true)
  assert.equal(honestOk.unit_price_cp, fenceHonest.unit_price_cp)
})

test('честный торговец отказывает исходом, а не откатом, и при высоком розыске доносит', () => {
  const quiet = commit(fixture({ fence: false }), {
    command_type: 'SellItem', actor_id: 'hero', merchant_id: 'merchant-1', item_id: 'loot-1', quantity: 1,
  })
  assert.ok(eventTypes(quiet.events).includes('MerchantRefusedStolenGoods'))
  assert.equal(eventTypes(quiet.events).includes('MerchantSaleCompleted'), false, 'сделки не было')
  assert.equal(quiet.state.players[0].inventory.some((item) => item.id === 'loot-1'), true, 'вещь осталась в сумке')
  assert.equal(currencyToCopper(quiet.state.players[0].currency), currencyToCopper(fixture().players[0].currency))

  // Ниже второй ступени никто не побежит за стражей из-за чужого ножа.
  assert.equal(eventTypes(quiet.events).includes('MerchantDenouncedThief'), false)

  // На высокой ступени донос детерминирован: тот же отказ на том же состоянии
  // кончается одинаково и после replay.
  const hunted = commit(fixture({ fence: false, wantedPoints: 5 }), {
    command_type: 'SellItem', actor_id: 'hero', merchant_id: 'merchant-1', item_id: 'loot-1', quantity: 1,
  })
  const denounced = eventTypes(hunted.events).includes('MerchantDenouncedThief')
  const again = commit(fixture({ fence: false, wantedPoints: 5 }), {
    command_type: 'SellItem', actor_id: 'hero', merchant_id: 'merchant-1', item_id: 'loot-1', quantity: 1,
  })
  assert.equal(eventTypes(again.events).includes('MerchantDenouncedThief'), denounced, 'донос обязан быть повторяемым')
  if (denounced) {
    const deed = (hunted.state.world_deeds?.deeds ?? []).at(-1)
    assert.equal(deed?.kind, 'theft', 'донос пишется поступком на героя, а не на торговца')
    assert.ok(deed.witness_ids.includes('merchant-1'))
    assert.ok(deed.actor_ids.includes('hero'))
  }
})

test('скупщик берёт краденое до конца: сделка проходит и переживает replay', () => {
  const state = fixture({ fence: true })
  const sold = commit(state, {
    command_type: 'SellItem', actor_id: 'hero', merchant_id: 'merchant-1', item_id: 'loot-1', quantity: 1,
  })
  assert.ok(eventTypes(sold.events).includes('MerchantSaleCompleted'))
  assert.ok(currencyToCopper(sold.state.players[0].currency) > currencyToCopper(state.players[0].currency))
  assert.deepEqual(
    replayEvents(state, sold.events).players[0].currency,
    sold.state.players[0].currency,
  )
})

// ---------------------------------------------------------------------------
// Подкуп

test('ступени щедрости считаются от масштаба цен и упорядочены', () => {
  const tiers = bribeTierAmounts(10_000)
  assert.equal(tiers.length, BRIBE_TIERS.length)
  assert.deepEqual(tiers.map((tier) => tier.id), ['coin', 'purse', 'generous'])
  assert.ok(tiers[0].amount_cp < tiers[1].amount_cp && tiers[1].amount_cp < tiers[2].amount_cp)
  assert.deepEqual(tiers.map((tier) => tier.dc_shift), [-1, -2, -3])
  // В бедной деревне ступени меньше, но их по-прежнему три и они не схлопываются в ноль.
  for (const tier of bribeTierAmounts(0)) assert.ok(tier.amount_cp > 0)
  assert.deepEqual(['монету', 'кошель', 'щедро'].map((word) => classifyBribeTier(`Убеждаю и подкрепляю слова: ${word}`)),
    ['coin', 'purse', 'generous'])
  assert.equal(classifyBribeTier('просто уговариваю'), '')
})

test('монета облегчает Убеждение, а неподкупному — выходит боком', () => {
  const base = buildNpcSocialCheckPolicy({ state: fixture(), npcId: 'merchant-1', heroId: 'hero', message: 'Убеждаю его помочь', turnId: 't1' })
  const bribed = buildNpcSocialCheckPolicy({
    state: fixture(), npcId: 'merchant-1', heroId: 'hero', message: 'Убеждаю и подкрепляю слова: кошель', turnId: 't1', bribeReferenceCp: 10_000,
  })
  assert.equal(bribed.difficulty, base.difficulty - 2, 'кошель сдвигает СЛ на две ступени')
  assert.equal(bribed.bribe.insulted, false)
  assert.ok(bribed.bribe.amount_cp > 0)

  const insulted = buildNpcSocialCheckPolicy({
    state: fixture({ incorruptible: true }), npcId: 'merchant-1', heroId: 'hero',
    message: 'Убеждаю и подкрепляю слова: кошель', turnId: 't1', bribeReferenceCp: 10_000,
  })
  assert.equal(insulted.difficulty, base.difficulty + INCORRUPTIBLE_DC_PENALTY, 'попытка купить непродающегося портит разговор')
  assert.equal(insulted.bribe.insulted, true)

  // Деньгами подкрепляют только уговор: обман ими выдаёт себя, запугивание — противоречит.
  const threat = buildNpcSocialCheckPolicy({
    state: fixture(), npcId: 'merchant-1', heroId: 'hero', message: 'Запугиваю его и сую монету', turnId: 't1', bribeReferenceCp: 10_000,
  })
  assert.equal(threat.bribe, undefined)
})

test('монета уходит в любом случае, а оскорблённый неподкупный пишет поступок', () => {
  const state = fixture({ incorruptible: true })
  const message = 'Убеждаю и подкрепляю слова: щедро'
  const policy = buildNpcSocialCheckPolicy({
    state, npcId: 'merchant-1', heroId: 'hero', message, turnId: 't1',
    bribeReferenceCp: currencyToCopper(state.players[0].currency),
  })
  assert.equal(policy.bribe.insulted, true)
  const purseBefore = currencyToCopper(state.players[0].currency)
  const result = commitSocial(state, policy)

  const offered = result.events.find((event) => event.event_type === 'NpcBribeOffered')
  assert.ok(offered, 'протянутую монету обязано называть своё событие')
  assert.equal(offered.payload.insulted, true)
  assert.equal(offered.payload.amount_cp, policy.bribe.amount_cp)
  // Забрать протянутую руку назад нельзя: деньги уже показаны за столом.
  assert.equal(currencyToCopper(result.state.players[0].currency), purseBefore - policy.bribe.amount_cp)

  assert.ok(eventTypes(result.events).includes('NpcBribeRefused'))
  const deed = (result.state.world_deeds?.deeds ?? []).at(-1)
  assert.equal(deed?.kind, 'bribery_attempt')
  assert.ok(deed.witness_ids.includes('merchant-1'))
  // Попытка подкупа — не преступление: ступень розыска она не двигает.
  assert.equal(WANTED_CRIME_POINTS.bribery_attempt, undefined)

  // У того, кто берёт, монета уходит так же, но поступка нет.
  const willing = fixture()
  const willingPolicy = buildNpcSocialCheckPolicy({
    state: willing, npcId: 'merchant-1', heroId: 'hero', message, turnId: 't1',
    bribeReferenceCp: currencyToCopper(willing.players[0].currency),
  })
  const paid = commitSocial(willing, willingPolicy)
  assert.equal(paid.events.find((event) => event.event_type === 'NpcBribeOffered').payload.insulted, false)
  assert.equal(eventTypes(paid.events).includes('NpcBribeRefused'), false)
  assert.deepEqual(paid.state.world_deeds?.deeds ?? [], [])
})

test('подкуп не подделывается телом запроса и не проходит с пустым кошельком', () => {
  const state = fixture()
  const policy = buildNpcSocialCheckPolicy({
    state, npcId: 'merchant-1', heroId: 'hero', message: 'Убеждаю и подкрепляю слова: щедро', turnId: 't1',
    bribeReferenceCp: 100_000_000,
  })
  assert.throws(
    () => validateCommand(
      { campaign_id: 'campaign-1', command_id: 'c1', server_authoritative: true, command_type: 'MakeAbilityCheck', social_check: { check_id: policy.check_id } },
      state,
      { isAdmin: true, isSocialController: true, socialCheck: policy },
    ),
    (error) => error.code === 'INSUFFICIENT_FUNDS',
    'обещать монету, которой нет, нельзя',
  )
  // Ступень и сумму объявляет только политика: подделка в теле команды не проходит.
  const forged = validateCommand(
    { campaign_id: 'campaign-1', command_id: 'c2', server_authoritative: true, command_type: 'MakeAbilityCheck',
      social_check: { check_id: 'подделка', bribe: { tier_id: 'generous', amount_cp: 0, dc_shift: -9 } } },
    state,
    { isAdmin: true, isSocialController: true, socialCheck: buildNpcSocialCheckPolicy({ state, npcId: 'merchant-1', heroId: 'hero', message: 'Убеждаю его', turnId: 't2' }) },
  )
  assert.equal(forged.social_check.bribe, undefined)
  assert.equal(forged.social_check.check_id.startsWith('social-check:'), true)
})

// ---------------------------------------------------------------------------
// Проекция и интерфейс

test('теги NPC игроку не текут — только следствия', () => {
  const state = fixture({ fence: true, incorruptible: true, wantedPoints: 5 })
  const sold = commit(state, {
    command_type: 'SellItem', actor_id: 'hero', merchant_id: 'merchant-1', item_id: 'loot-1', quantity: 1,
  })
  const room = campaignStateForViewer(sold.state, PLAYER, 'hero')
  const events = mechanicsForViewer(sold.events, PLAYER, 'hero', sold.state)
  for (const [label, surface] of [['состояние', room], ['события', events]]) {
    const json = JSON.stringify(surface)
    for (const secret of ['скупщик', 'неподкупный', 'wanted_level']) {
      assert.equal(json.includes(secret), false, `${label}: утекло «${secret}»`)
    }
  }
  // Следствие при этом видно: цена в разборе честная, и её игрок обязан читать.
  const view = merchantViewFor(sold.state, 'merchant-1', 'hero')
  assert.ok(view.sell_quotes.length > 0)
})

test('строка скидки стоит в разборе цены, а цепочка держит переменное число шагов', () => {
  const merchantView = readFileSync(new URL('../src/MerchantView.tsx', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../src/merchant.css', import.meta.url), 'utf8')
  const board = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')

  assert.match(merchantView, /breakdown\.stolen_adjustment_percent/u)
  assert.match(merchantView, /merchant-stolen-step/u)
  assert.ok(styles.includes('.merchant-stolen-step'))
  // Жёсткие семь колонок держались, только пока необязательный шаг был один.
  assert.match(styles, /\.merchant-price-flow \{ display: flex; flex-wrap: wrap;/u)
  assert.match(styles, /\.merchant-price-flow\.compact \{ display: grid;/u)

  // Кнопки подкупа шлют ту же фразу, что игрок сказал бы сам, и своих чисел
  // не держат: две копии правила разошлись бы при первой правке долей.
  assert.match(board, /Убеждаю и подкрепляю слова: \$\{tier\}/u)
  assert.doesNotMatch(board, /share_bps|amount_cp/u)
})

// Расходники, которые оставляют след: масло (оба режима), калтропы и яд на
// оружии.
//
// Ни одна из трёх позиций не заводит своей машинерии. Лужа и калтропы — обычные
// площадные эффекты той же формы, что строит `CastSpell` и горящий пропс из
// разбора «среда как оружие»; яд едет добавкой к попаданию рядом с
// зачарованиями предметов, поэтому иммунитет цели обнуляет его сам.
import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { ITEM_CATALOG, itemViewerCapabilities, materializeCatalogItem } from '../server/item-catalog.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

const OIL = 'srd_5_2_1:oil-flask'
const CALTROPS = 'srd_5_2_1:caltrops'
const POISON = 'srd_5_2_1:poison-basic'
const CONTEXT = Object.freeze({ isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true })

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `zone-roll-${++id}`,
    now: () => '2026-08-02T12:00:00.000Z',
  })
}

const sword = () => ({
  id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true,
  combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 },
})

function campaignState({ inventory = [], foeType = 'beast', foeImmunities = null, foeAt = { x: 3, y: 0 } } = {}) {
  return normalizeCampaignState({
    sessionCode: 'CONSUMABLE-ZONES',
    campaign_id: 'CONSUMABLE-ZONES',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Мира', characterClass: 'fighter', level: 3, proficiency: 2,
      hp: 30, maxHp: 30, armor: 15, speed: 30,
      abilities: { str: 16, dex: 16, con: 14, int: 10, wis: 10, cha: 10 },
      attackBonus: 5, damageDice: 8, damageBonus: 3, x: 0, y: 0, inventory,
    }],
    enemies: [{
      id: 'foe', name: 'Тварь', hp: 40, maxHp: 40, armor: 10, speed: 30, alive: true,
      creature_type: foeType,
      ...(foeImmunities ? { damage_immunities: foeImmunities } : {}),
      abilities: { str: 12, dex: 10, con: 12, int: 6, wis: 10, cha: 6 },
      x: foeAt.x, y: foeAt.y,
    }],
    scene: {
      turn: 1,
      cells: Array.from({ length: 12 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true })),
    },
    mechanics: {
      positions: { hero: { x: 0, y: 0 }, foe: { x: foeAt.x, y: foeAt.y } },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'foe', total: 5 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const item = (catalogId, id = catalogId.split(':').at(-1)) => materializeCatalogItem(catalogId, { id, quantity: 1 })
const types = (result) => result.events.map((event) => event.event_type)
const payload = (result, type) => result.events.find((event) => event.event_type === type)?.payload
const areaOf = (state) => (state.mechanics.active_effects ?? [])

/** Новый ход героя: расходники стоят действия, а проверяем мы следующий шаг. */
function withFreshAction(state, actorId = 'hero') {
  return {
    ...state,
    mechanics: {
      ...state.mechanics,
      combat: {
        ...state.mechanics.combat,
        action_economy: {
          ...state.mechanics.combat.action_economy,
          [actorId]: { ...state.mechanics.combat.action_economy[actorId], action: true, bonus_action: true },
        },
      },
    },
  }
}

function useItem(state, fields, rolls = [], commandId = `use-${fields.item_id}`) {
  return resolveCommand({
    command_type: 'UseItem', command_id: commandId, actor_id: 'hero', target_id: 'hero', ...fields,
  }, state, { diceService: dice(rolls), context: CONTEXT })
}

test('каталог объявляет три расходника исполняемыми по SRD 5.2.1', () => {
  for (const catalogId of [OIL, CALTROPS, POISON]) {
    assert.equal(ITEM_CATALOG[catalogId].mechanics_status, 'verified', catalogId)
    assert.doesNotMatch(ITEM_CATALOG[catalogId].limitation, /не реализован/iu, catalogId)
  }
  // Обливание клетки есть в актуальной редакции и не должно маскироваться
  // правилом стола.
  assert.equal(ITEM_CATALOG[OIL].use.spill_mode.house_rule, undefined)
  assert.equal(ITEM_CATALOG[OIL].use.on_failed_save_condition.fire_damage_bonus, 5)
  assert.equal(ITEM_CATALOG[OIL].dndsu_reference_url, 'https://next.dnd.su/equipment/249-oil')
  // Калтропы — прочтение 5.2.1, и оно тоже названо.
  assert.match(ITEM_CATALOG[CALTROPS].limitation, /прочтение SRD 5\.2\.1/u)
  assert.equal(ITEM_CATALOG[CALTROPS].use.zone.save_dc, 15)
  assert.equal(ITEM_CATALOG[POISON].use.rider_damage, '1d4')
  assert.equal(ITEM_CATALOG[POISON].use.rider_damage_type, 'poison')
  assert.equal(ITEM_CATALOG[POISON].use.combat_action, 'bonus_action')
  assert.equal(itemViewerCapabilities(item(CALTROPS)).use.point_target, true)
  assert.deepEqual(itemViewerCapabilities(item(OIL)).use.use_modes, ['target', 'spill'])
  assert.equal(itemViewerCapabilities(item(OIL)).use.point_target, true)
  assert.equal(itemViewerCapabilities(item(POISON)).use.requires_weapon, true)
})

test('облитая маслом цель получает +5 к следующему огненному урону ровно один раз', () => {
  const state = campaignState({ inventory: [item(OIL)] })
  const hit = useItem(state, { item_id: 'oil-flask', target_id: 'foe' }, [10], 'oil-hit')
  assert.deepEqual(types(hit), ['ItemUsed', 'SavingThrowResolved', 'ConditionAdded', 'ItemConsumed'])
  assert.equal(payload(hit, 'SavingThrowResolved').difficulty, 13)
  assert.equal(payload(hit, 'SavingThrowResolved').saved, false)
  assert.equal(payload(hit, 'ConditionAdded').fire_damage_bonus, 5)
  const oiled = hit.events.reduce(applyGameEvent, state)
  assert.equal(oiled.enemies[0].hp, 40, 'само масло урона не наносит')

  const burn = resolveCommand({
    command_type: 'ApplyDamage', command_id: 'oil-burn', actor_id: 'hero', target_id: 'foe', amount: 6, damage_type: 'fire',
  }, oiled, { diceService: dice(), context: { isAdmin: true } })
  const damage = payload(burn, 'DamageApplied')
  assert.equal(damage.raw_amount, 11, '6 огня + 5 от масла')
  assert.equal(damage.applied_amount, 11)
  assert.ok(burn.events.some((event) => event.event_type === 'ConditionRemoved' && event.payload.condition === 'oiled'))

  // Масло сгорело: второй удар идёт без прибавки.
  const after = burn.events.reduce(applyGameEvent, oiled)
  const second = resolveCommand({
    command_type: 'ApplyDamage', command_id: 'oil-burn-2', actor_id: 'hero', target_id: 'foe', amount: 6, damage_type: 'fire',
  }, after, { diceService: dice(), context: { isAdmin: true } })
  assert.equal(payload(second, 'DamageApplied').raw_amount, 6)

  // Другой тип урона масло не тратит и не усиливает.
  const cold = resolveCommand({
    command_type: 'ApplyDamage', command_id: 'oil-cold', actor_id: 'hero', target_id: 'foe', amount: 6, damage_type: 'cold',
  }, oiled, { diceService: dice(), context: { isAdmin: true } })
  assert.equal(payload(cold, 'DamageApplied').raw_amount, 6)
})

test('пролитая лужа сама безвредна, но вспыхивает от огня и горит по 5 входящему', () => {
  const state = campaignState({ inventory: [item(OIL)] })
  const spill = useItem(state, { item_id: 'oil-flask', use_mode: 'spill', to: { x: 1, y: 0 } }, [], 'oil-spill')
  assert.deepEqual(types(spill), ['ItemUsed', 'SpellAreaCreated', 'ItemConsumed'])
  const slick = payload(spill, 'SpellAreaCreated').effect
  assert.equal(slick.spell_id, 'item:oil-slick')
  assert.deepEqual(slick.cells, [{ x: 1, y: 0 }])
  assert.equal(slick.damage_amount, 0, 'лужа сама по себе не жжёт')
  assert.equal(slick.ignites_into.damage_amount, 5)

  let spilled = withFreshAction(spill.events.reduce(applyGameEvent, state))
  assert.equal(areaOf(spilled).length, 1)

  // Любой огонь по луже поджигает её через существующую ветку `flammable`.
  spilled.players[0] = { ...spilled.players[0], characterClass: 'wizard', abilities: { ...spilled.players[0].abilities, int: 16 }, knownSpellIds: ['fire-bolt'], preparedSpellIds: ['fire-bolt'] }
  spilled = normalizeCampaignState(spilled)
  spilled.enemies[0] = { ...spilled.enemies[0], x: 1, y: 0 }
  spilled.mechanics.positions.foe = { x: 1, y: 0 }
  const ignite = resolveCommand({
    command_type: 'CastSpell', command_id: 'oil-ignite', actor_id: 'hero', spell_id: 'fire-bolt',
    target_id: 'foe', target_ids: ['foe'], server_authoritative: true,
  }, spilled, { diceService: dice([18, 6]), context: CONTEXT })
  assert.ok(ignite.events.some((event) => event.event_type === 'SpellAreaRemoved' && event.payload.reason === 'burned-away'))
  const burning = ignite.events.find((event) => event.event_type === 'SpellAreaCreated')
  assert.ok(burning, 'лужа обязана превратиться в горящую зону')
  assert.equal(burning.payload.effect.damage_amount, 5)
  assert.equal(burning.payload.effect.open_flame, true)
  assert.equal(burning.payload.effect.expires_round, 3, 'горит два раунда')

  // Пока лужа горит, стоящий в ней получает 5 огнём в конце своего хода.
  const lit = ignite.events.reduce(applyGameEvent, spilled)
  const endTurn = resolveCommand({
    command_type: 'EndTurn', command_id: 'oil-tick', actor_id: 'foe', server_authoritative: true,
  }, { ...lit, mechanics: { ...lit.mechanics, combat: { ...lit.mechanics.combat, active_index: 1 } } }, { diceService: dice([10]), context: CONTEXT })
  const tick = endTurn.events.find((event) => event.event_type === 'DamageApplied' && event.payload.area_effect)
  assert.ok(tick, 'горящее масло обязано тикнуть по стоящему в нём')
  assert.equal(tick.payload.damage_type, 'fire')
  assert.equal(tick.payload.raw_amount, 5)
})

test('калтропы: спасбросок Ловкости СЛ 15, 1 колющего и нулевая скорость при провале', () => {
  const state = campaignState({ inventory: [item(CALTROPS)], foeAt: { x: 2, y: 0 } })
  const spread = useItem(state, { item_id: 'caltrops', to: { x: 1, y: 0 } }, [], 'caltrops-spread')
  assert.deepEqual(types(spread), ['ItemUsed', 'SpellAreaCreated', 'ItemConsumed'])
  const zone = payload(spread, 'SpellAreaCreated').effect
  assert.equal(zone.save_dc, 15)
  assert.equal(zone.save_ability, 'dex')
  assert.equal(zone.damage_amount, 1)
  assert.equal(zone.damage_type, 'piercing')
  assert.equal(zone.condition, 'caltrops-speed-zero')

  const seeded = spread.events.reduce(applyGameEvent, state)
  // Провал спасброска: бросок 3 против СЛ 15.
  const stepIn = resolveCommand({
    command_type: 'MoveActor', command_id: 'caltrops-step', actor_id: 'foe', to: { x: 1, y: 0 }, server_authoritative: true,
  }, { ...seeded, mechanics: { ...seeded.mechanics, combat: { ...seeded.mechanics.combat, active_index: 1 } } }, { diceService: dice([3]), context: CONTEXT })
  const hurt = stepIn.events.find((event) => event.event_type === 'DamageApplied')
  assert.ok(hurt, 'вход в калтропы обязан ранить при провале')
  assert.equal(hurt.payload.damage_type, 'piercing')
  assert.equal(hurt.payload.applied_amount, 1)
  assert.ok(stepIn.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'caltrops-speed-zero'))

  // Зона видима игрокам: они её сами и высыпали.
  const room = campaignStateForViewer(seeded, { role: 'player', heroIds: ['hero'] }, 'hero')
  assert.ok((room.mechanics.active_effects ?? []).some((effect) => effect.spell_id === 'item:caltrops'))
})

test('успешный спасбросок в калтропах не ранит и не замедляет', () => {
  const state = campaignState({ inventory: [item(CALTROPS)], foeAt: { x: 2, y: 0 } })
  const seeded = useItem(state, { item_id: 'caltrops', to: { x: 1, y: 0 } }, [], 'caltrops-ok').events.reduce(applyGameEvent, state)
  const stepIn = resolveCommand({
    command_type: 'MoveActor', command_id: 'caltrops-save', actor_id: 'foe', to: { x: 1, y: 0 }, server_authoritative: true,
  }, { ...seeded, mechanics: { ...seeded.mechanics, combat: { ...seeded.mechanics.combat, active_index: 1 } } }, { diceService: dice([19]), context: CONTEXT })
  assert.equal(stepIn.events.some((event) => event.event_type === 'DamageApplied'), false)
  assert.equal(stepIn.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'caltrops-speed-zero'), false)
})

test('яд добавляет 1к4 к первому попаданию, тратится и не берёт невосприимчивого', () => {
  const state = campaignState({ inventory: [item(POISON), sword()], foeAt: { x: 1, y: 0 } })
  const coat = useItem(state, { item_id: 'poison-basic', weapon_id: 'sword' }, [], 'coat')
  assert.deepEqual(types(coat), ['ItemUsed', 'ConditionAdded', 'ItemConsumed'])
  assert.equal(payload(coat, 'ConditionAdded').condition, 'weapon-coated:sword')
  assert.equal(payload(coat, 'ConditionAdded').rider_damage, '1d4')

  const coated = withFreshAction(coat.events.reduce(applyGameEvent, state))
  // Атака: попадание 18, урон меча 5, добавка яда 3.
  const strike = resolveCommand({
    command_type: 'MakeAttack', command_id: 'poison-strike', actor_id: 'hero', target_id: 'foe', item_id: 'sword', server_authoritative: true,
  }, coated, { diceService: dice([18, 5, 3]), context: CONTEXT })
  const poisonHit = strike.events.filter((event) => event.event_type === 'DamageApplied').find((event) => event.payload.damage_type === 'poison')
  assert.ok(poisonHit, 'яд обязан прийти отдельным уроном своего типа')
  assert.equal(poisonHit.payload.applied_amount, 3)
  // Своя доза называет свой клинок. Подпись броска у противника обезличена
  // (`item_damage:weapon-coated`, `test/npc-equipment.test.mjs`), потому что
  // ключ вещи там — опись чужого кармана; функция добавки одна на обе стороны,
  // и герою она обязана оставить указание, какой именно клинок сработал.
  assert.equal(
    strike.rolls.find((roll) => String(roll.purpose).startsWith('item_damage:')).purpose,
    'item_damage:weapon-coated:sword',
  )
  assert.ok(strike.events.some((event) => event.event_type === 'ConditionRemoved' && event.payload.condition === 'weapon-coated:sword'))

  // Доза израсходована: второй удар идёт без яда.
  const spent = strike.events.reduce(applyGameEvent, coated)
  assert.equal((spent.mechanics.conditions.hero ?? []).some((entry) => entry.id === 'weapon-coated:sword'), false)

  // Невосприимчивому к яду добавка не проходит — это делает общий счётчик урона.
  const undead = campaignState({ inventory: [item(POISON), sword()], foeAt: { x: 1, y: 0 }, foeType: 'undead', foeImmunities: ['poison'] })
  const coatedUndead = withFreshAction(useItem(undead, { item_id: 'poison-basic', weapon_id: 'sword' }, [], 'coat-undead').events.reduce(applyGameEvent, undead))
  const vsUndead = resolveCommand({
    command_type: 'MakeAttack', command_id: 'poison-undead', actor_id: 'hero', target_id: 'foe', item_id: 'sword', server_authoritative: true,
  }, coatedUndead, { diceService: dice([18, 5, 3]), context: CONTEXT })
  const blocked = vsUndead.events.filter((event) => event.event_type === 'DamageApplied').find((event) => event.payload.damage_type === 'poison')
  assert.ok(blocked)
  assert.equal(blocked.payload.immune, true)
  assert.equal(blocked.payload.applied_amount, 0)
})

test('replay воспроизводит и зоны, и нанесённый яд', () => {
  const initial = campaignState({ inventory: [item(CALTROPS), item(POISON), sword()] })
  const spread = useItem(initial, { item_id: 'caltrops', to: { x: 1, y: 0 } }, [], 'replay-caltrops')
  const seeded = spread.events.reduce(applyGameEvent, initial)
  assert.deepEqual(replayEvents(initial, spread.events), seeded)

  const refreshed = withFreshAction(seeded)
  const coat = useItem(refreshed, { item_id: 'poison-basic', weapon_id: 'sword' }, [], 'replay-coat')
  const coated = coat.events.reduce(applyGameEvent, refreshed)
  assert.deepEqual(replayEvents(refreshed, coat.events), coated)
  assert.equal(areaOf(coated).length, 1, 'зона переживает следующий коммит')
})

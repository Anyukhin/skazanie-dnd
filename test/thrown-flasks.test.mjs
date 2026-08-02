// Метательные склянки: кислота, святая вода, алхимический огонь.
//
// Все три в редакции описаны одинаково — «бросок как импровизированным
// оружием», — поэтому и путь в движке один. Сторож проверяет ровно то, чем они
// различаются: чем бьют, кому вредят и что оставляют после попадания.
import assert from 'node:assert/strict'
import test from 'node:test'

import { combatNarration } from '../server/combat-narration.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { ITEM_CATALOG, itemViewerCapabilities, materializeCatalogItem } from '../server/item-catalog.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { mechanicsForViewer } from '../server/viewer-projection.mjs'

const ACID = 'srd_5_2_1:acid'
const HOLY_WATER = 'srd_5_2_1:holy-water'
const ALCHEMISTS_FIRE = 'srd_5_2_1:alchemists-fire'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `flask-roll-${++id}`,
    now: () => '2026-08-02T12:00:00.000Z',
  })
}

function flask(catalogId, id = catalogId.split(':').at(-1)) {
  return materializeCatalogItem(catalogId, { id, quantity: 1 })
}

function campaignState({ inventory = [], creatureType = 'beast' } = {}) {
  return normalizeCampaignState({
    sessionCode: 'THROWN-FLASKS',
    campaign_id: 'THROWN-FLASKS',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero',
      character: 'Мира',
      characterClass: 'fighter',
      level: 3,
      proficiency: 2,
      hp: 30,
      maxHp: 30,
      armor: 15,
      speed: 30,
      abilities: { str: 12, dex: 16, con: 14, int: 10, wis: 10, cha: 10 },
      x: 0,
      y: 0,
      inventory,
    }],
    enemies: [{
      id: 'foe',
      name: 'Тварь',
      hp: 30,
      maxHp: 30,
      armor: 12,
      speed: 30,
      alive: true,
      creature_type: creatureType,
      abilities: { str: 12, dex: 10, con: 12, int: 6, wis: 10, cha: 6 },
      x: 2,
      y: 0,
    }],
    scene: {
      turn: 1,
      cells: Array.from({ length: 12 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true })),
    },
    mechanics: {
      positions: { hero: { x: 0, y: 0 }, foe: { x: 2, y: 0 } },
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'foe', total: 5 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function throwFlask(state, itemId, rolls, commandId = `throw-${itemId}`) {
  return resolveCommand({
    command_type: 'UseItem',
    command_id: commandId,
    actor_id: 'hero',
    item_id: itemId,
    target_id: 'foe',
  }, state, { diceService: dice(rolls), context: { isAdmin: true, serverAuthoritativeCombat: true } })
}

const typeOf = (result) => result.events.map((event) => event.event_type)
const payloadOf = (result, type) => result.events.find((event) => event.event_type === type)?.payload

test('каталог объявляет три склянки исполняемыми и честно называет ограничение импровизированного броска', () => {
  for (const catalogId of [ACID, HOLY_WATER, ALCHEMISTS_FIRE]) {
    const entry = ITEM_CATALOG[catalogId]
    assert.equal(entry.mechanics_status, 'verified', catalogId)
    assert.equal(entry.use.kind, 'thrown_flask', catalogId)
    assert.equal(entry.use.consumes, 1, catalogId)
    assert.equal(entry.use.combat_action, 'action', catalogId)
    assert.equal(entry.use.range_feet, 20, catalogId)
    assert.equal(entry.use.combat_only, true, catalogId)
    assert.match(entry.limitation, /импровизированн/iu, `${catalogId}: ограничение владения не названо`)
    assert.doesNotMatch(entry.limitation, /не реализован/iu, `${catalogId}: ограничение осталось прежним`)
  }
  assert.equal(ITEM_CATALOG[ACID].use.damage, '2d6')
  assert.equal(ITEM_CATALOG[ACID].use.damage_type, 'acid')
  assert.deepEqual(ITEM_CATALOG[HOLY_WATER].use.damage_creature_types, ['undead', 'fiend'])
  assert.equal(ITEM_CATALOG[HOLY_WATER].use.damage_type, 'radiant')
  assert.equal(ITEM_CATALOG[ALCHEMISTS_FIRE].use.damage, undefined)
  assert.equal(ITEM_CATALOG[ALCHEMISTS_FIRE].use.on_hit_condition.recurring_damage, '1d4')
  // Тушение без проверки — прочтение 5.2.1, и оно названо в карточке.
  assert.match(ITEM_CATALOG[ALCHEMISTS_FIRE].limitation, /без проверки характеристики/u)

  // Клиенту достаточно объявленной сервером доступности.
  assert.equal(itemViewerCapabilities(flask(ACID)).usable, true)
})

test('кислота попадает броском по КД, наносит 2к6 и тратит склянку', () => {
  const state = campaignState({ inventory: [flask(ACID)] })
  // Бросок 14 + 3 Ловкости против КД 12 — попадание; урон 4 + 5 = 9.
  const hit = throwFlask(state, 'acid', [14, 4, 5])
  assert.deepEqual(typeOf(hit), ['ItemUsed', 'AttackResolved', 'DieRolled', 'DamageApplied', 'ItemConsumed'])

  const attack = payloadOf(hit, 'AttackResolved')
  assert.equal(attack.improvised_thrown, true)
  assert.equal(attack.armor_class, 12)
  assert.equal(attack.modifier, 3, 'к броску идёт только модификатор Ловкости, без владения')
  assert.equal(attack.hit, true)
  assert.equal(attack.critical, false)

  const damage = payloadOf(hit, 'DamageApplied')
  assert.equal(damage.damage_type, 'acid')
  assert.equal(damage.raw_amount, 9)
  assert.equal(damage.applied_amount, 9)

  const after = hit.events.reduce(applyGameEvent, state)
  assert.equal(after.enemies[0].hp, 21)
  assert.equal((after.players[0].inventory ?? []).some((entry) => entry.id === 'acid'), false, 'склянка не потрачена')
  assert.equal(after.mechanics.combat.action_economy.hero.action, false, 'бросок обязан стоить действия')
})

test('промах не наносит урона, но склянку всё равно тратит', () => {
  const state = campaignState({ inventory: [flask(ACID)] })
  const miss = throwFlask(state, 'acid', [5], 'throw-miss')
  assert.deepEqual(typeOf(miss), ['ItemUsed', 'AttackResolved', 'ItemConsumed'])
  assert.equal(payloadOf(miss, 'AttackResolved').hit, false)
  const after = miss.events.reduce(applyGameEvent, state)
  assert.equal(after.enemies[0].hp, 30)
  assert.equal((after.players[0].inventory ?? []).length, 0)
})

test('натуральная 20 попадает мимо КД и удваивает кости урона', () => {
  const state = campaignState({ inventory: [flask(ACID)] })
  const crit = throwFlask(state, 'acid', [20, 3, 3, 3, 3], 'throw-crit')
  const attack = payloadOf(crit, 'AttackResolved')
  assert.equal(attack.critical, true)
  assert.equal(attack.hit, true)
  const die = crit.events.find((event) => event.event_type === 'DieRolled').payload
  assert.equal(die.expression, '4d6', 'критическое попадание удваивает кости')
  assert.equal(payloadOf(crit, 'DamageApplied').raw_amount, 12)
})

test('святая вода жжёт нежить и исчадий и не вредит остальным', () => {
  for (const creatureType of ['undead', 'fiend']) {
    const state = campaignState({ inventory: [flask(HOLY_WATER)], creatureType })
    const hit = throwFlask(state, 'holy-water', [14, 4, 5], `holy-${creatureType}`)
    assert.deepEqual(typeOf(hit), ['ItemUsed', 'AttackResolved', 'DieRolled', 'DamageApplied', 'ItemConsumed'])
    const damage = payloadOf(hit, 'DamageApplied')
    assert.equal(damage.damage_type, 'radiant')
    assert.equal(damage.applied_amount, 9)
  }

  const beast = campaignState({ inventory: [flask(HOLY_WATER)], creatureType: 'beast' })
  const splash = throwFlask(beast, 'holy-water', [14], 'holy-beast')
  assert.deepEqual(typeOf(splash), ['ItemUsed', 'AttackResolved', 'ItemEffectIneffective', 'ItemConsumed'])
  const ineffective = payloadOf(splash, 'ItemEffectIneffective')
  assert.equal(ineffective.reason, 'creature-type')
  assert.deepEqual(ineffective.applicable_creature_types, ['undead', 'fiend'])
  const after = splash.events.reduce(applyGameEvent, beast)
  assert.equal(after.enemies[0].hp, 30, 'зверю святая вода вреда не наносит')
  assert.equal((after.players[0].inventory ?? []).length, 0, 'но склянка разбита и потрачена')

  // Попадание видно за столом честной строкой, а не молчанием.
  assert.match(combatNarration(splash.events, beast), /вреда не причиняет/u)
})

test('алхимический огонь поджигает цель: 1к4 в начале её хода и тушение действием', () => {
  const state = campaignState({ inventory: [flask(ALCHEMISTS_FIRE)] })
  const hit = throwFlask(state, 'alchemists-fire', [14], 'fire-hit')
  assert.deepEqual(typeOf(hit), ['ItemUsed', 'AttackResolved', 'ConditionAdded', 'ItemConsumed'])
  const condition = payloadOf(hit, 'ConditionAdded')
  assert.equal(condition.condition, 'alchemists-fire-flames')
  assert.equal(condition.recurring_damage, '1d4')
  assert.equal(condition.recurring_damage_type, 'fire')

  let burning = hit.events.reduce(applyGameEvent, state)
  assert.equal(burning.enemies[0].hp, 30, 'сам бросок урона не наносит')

  // Ход героя кончается — начинается ход цели, и пламя тикает.
  const turn = resolveCommand({
    command_type: 'EndTurn', command_id: 'fire-turn', actor_id: 'hero', server_authoritative: true,
  }, burning, { diceService: dice([3]), context: { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true } })
  const tick = turn.events.find((event) => event.event_type === 'DamageApplied')
  assert.ok(tick, 'горение обязано тикнуть в начале хода цели')
  assert.equal(tick.payload.damage_type, 'fire')
  assert.equal(tick.payload.applied_amount, 3)
  burning = turn.events.reduce(applyGameEvent, burning)
  assert.equal(burning.enemies[0].hp, 27)

  // Пламя не гаснет само: следующий ход снова жжёт.
  const second = resolveCommand({
    command_type: 'EndTurn', command_id: 'fire-turn-2', actor_id: 'foe', server_authoritative: true,
  }, burning, { diceService: dice([]), context: { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true } })
  const afterSecond = second.events.reduce(applyGameEvent, burning)
  assert.ok((afterSecond.mechanics.conditions.foe ?? []).some((entry) => entry.id === 'alchemists-fire-flames'))
})

test('действие «Потушить пламя» гасит алхимический огонь без проверки характеристики', () => {
  // Пламя на самом герое: тушит его то же общее действие, что и «Пылающую
  // кару», — своей команды у алхимического огня не заводится.
  const onHero = applyGameEvent(campaignState(), {
    campaign_id: null, command_id: 'move-flames', event_type: 'ConditionAdded', actor_id: 'hero',
    target_ids: ['hero'], visibility: 'public', source_rule_ids: [],
    payload: { condition: 'alchemists-fire-flames', recurring_damage: '1d4', recurring_damage_type: 'fire' },
  })
  const doused = resolveCommand({
    command_type: 'UseCombatAction', command_id: 'douse', actor_id: 'hero', action_id: 'extinguish-self', server_authoritative: true,
  }, onHero, { diceService: dice(), context: { isAdmin: true, serverAuthoritativeCombat: true } })
  assert.equal(doused.events.some((event) => event.event_type === 'DieRolled'), false, 'тушение не требует броска')
  const removed = doused.events.find((event) => event.event_type === 'ConditionRemoved')
  assert.equal(removed.payload.condition, 'alchemists-fire-flames')
  const after = doused.events.reduce(applyGameEvent, onHero)
  assert.equal((after.mechanics.conditions.hero ?? []).some((entry) => entry.id === 'alchemists-fire-flames'), false)
})

test('replay воспроизводит бросок склянки, а проекция не выдаёт КД врага', () => {
  const initial = campaignState({ inventory: [flask(ACID)] })
  const result = throwFlask(initial, 'acid', [14, 4, 5], 'flask-replay')
  const applied = result.events.reduce(applyGameEvent, initial)
  assert.deepEqual(replayEvents(initial, result.events), applied)

  const visible = mechanicsForViewer(result.events, { role: 'player', heroIds: ['hero'] }, 'hero', initial)
  const attack = visible.find((event) => event.event_type === 'AttackResolved')
  assert.ok(attack)
  assert.equal(attack.payload.armor_class, undefined, 'точный КД врага игроку не показывают')
  assert.equal(attack.payload.hit, true)
})

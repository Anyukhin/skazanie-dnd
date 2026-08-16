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
const OIL = 'srd_5_2_1:oil-flask'
const POISON = 'srd_5_2_1:poison-basic'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `flask-roll-${++id}`,
    now: () => '2026-08-09T12:00:00.000Z',
  })
}

function item(catalogId, id = catalogId.split(':').at(-1), extra = {}) {
  return materializeCatalogItem(catalogId, { id, quantity: 1, ...extra })
}

function campaignState({ inventory = [], creatureType = 'beast', level = 3, enemyDex = 10, foeX = 2 } = {}) {
  return normalizeCampaignState({
    sessionCode: 'THROWN-FLASKS',
    campaign_id: 'THROWN-FLASKS',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero',
      character: 'Мира',
      characterClass: 'fighter',
      level,
      proficiency: level >= 5 ? 3 : 2,
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
      armor: 18,
      speed: 30,
      alive: true,
      creature_type: creatureType,
      abilities: { str: 12, dex: enemyDex, con: 12, int: 6, wis: 10, cha: 6 },
      x: foeX,
      y: 0,
    }],
    scene: {
      turn: 1,
      cells: Array.from({ length: 12 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true })),
    },
    mechanics: {
      positions: { hero: { x: 0, y: 0 }, foe: { x: foeX, y: 0 } },
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'foe', total: 5 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0, attacks_used: 0, attacks_allowed: 1 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0, attacks_used: 0, attacks_allowed: 1 },
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

test('каталог объявляет флаконы заменой атаки по SRD 5.2.1 и хранит ссылки dnd.su', () => {
  const expectedUrls = new Map([
    [ACID, 'https://next.dnd.su/equipment/201-acid'],
    [ALCHEMISTS_FIRE, 'https://next.dnd.su/equipment/202-alchemists-fire'],
    [HOLY_WATER, 'https://next.dnd.su/equipment/234-holy-water'],
    [OIL, 'https://next.dnd.su/equipment/249-oil'],
  ])
  for (const [catalogId, url] of expectedUrls) {
    const entry = ITEM_CATALOG[catalogId]
    assert.equal(entry.mechanics_status, 'verified', catalogId)
    assert.equal(entry.use.kind, 'thrown_flask', catalogId)
    assert.equal(entry.use.attack_replacement, true, catalogId)
    assert.deepEqual(entry.use.save, { ability: 'dex', dc: { base: 8, ability: 'dex', proficiency: true } }, catalogId)
    assert.equal(entry.use.consumes, 1, catalogId)
    assert.equal(entry.use.combat_action, 'action', catalogId)
    assert.equal(entry.use.range_feet, 20, catalogId)
    assert.equal(entry.dndsu_reference_url, url, catalogId)
    assert.doesNotMatch(entry.description, /импровизированн/iu, catalogId)
  }
  assert.equal(ITEM_CATALOG[ACID].use.damage, '2d6')
  assert.equal(ITEM_CATALOG[HOLY_WATER].use.damage, '2d8')
  assert.deepEqual(ITEM_CATALOG[HOLY_WATER].use.damage_creature_types, ['undead', 'fiend'])
  assert.equal(ITEM_CATALOG[ALCHEMISTS_FIRE].use.damage, '1d4')
  assert.equal(ITEM_CATALOG[ALCHEMISTS_FIRE].use.on_failed_save_condition.recurring_damage, '1d4')
  assert.equal(ITEM_CATALOG[OIL].use.spill_mode.house_rule, undefined)
  assert.equal(ITEM_CATALOG[POISON].use.combat_action, 'bonus_action')
  assert.equal(ITEM_CATALOG[POISON].dndsu_reference_url, 'https://next.dnd.su/equipment/253-basic-poison')
  assert.equal(itemViewerCapabilities(item(ACID)).usable, true)
})

test('кислота использует серверную СЛ 8 + Ловкость + мастерство, а не КЗ цели', () => {
  const state = campaignState({ inventory: [item(ACID)] })
  // СЛ героя 13. КЗ цели 18 не участвует: результат 10 проваливает спасбросок,
  // затем 4 + 5 = 9 урона кислотой.
  const failed = throwFlask(state, 'acid', [10, 4, 5])
  assert.deepEqual(typeOf(failed), ['ItemUsed', 'SavingThrowResolved', 'DieRolled', 'DamageApplied', 'ItemConsumed'])
  assert.equal(failed.events.some((event) => event.event_type === 'AttackResolved'), false)
  const save = payloadOf(failed, 'SavingThrowResolved')
  assert.equal(save.ability, 'dex')
  assert.equal(save.difficulty, 13)
  assert.equal(save.total, 10)
  assert.equal(save.saved, false)
  assert.equal(save.source, 'item-thrown')
  const damage = payloadOf(failed, 'DamageApplied')
  assert.equal(damage.damage_type, 'acid')
  assert.equal(damage.raw_amount, 9)
  assert.equal(damage.applied_amount, 9)

  const after = failed.events.reduce(applyGameEvent, state)
  assert.equal(after.enemies[0].hp, 21)
  assert.equal((after.players[0].inventory ?? []).some((entry) => entry.id === 'acid'), false)
  assert.equal(after.mechanics.combat.action_economy.hero.action, false)
  assert.equal(after.mechanics.combat.action_economy.hero.attacks_used, 1)
})

test('назначение броска у склянки героя называет каталожную запись', () => {
  // Подпись броска стала параметром ради противника: его склянка называет
  // тактику, чтобы каталожный ключ не уехал столу через `purpose`
  // (`test/npc-equipment.test.mjs`). У героя закрывать нечего — это его
  // собственная вещь, — и умолчание обязано остаться прежним.
  const failed = throwFlask(campaignState({ inventory: [item(ACID)] }), 'acid', [10, 4, 5])
  assert.equal(payloadOf(failed, 'SavingThrowResolved').purpose, `item_thrown_save:${ACID}:dex`)
  assert.equal(payloadOf(failed, 'DieRolled').purpose, `item_thrown_damage:${ACID}`)
})

test('успешный спасбросок отменяет урон, но расходует склянку и атаку', () => {
  const state = campaignState({ inventory: [item(ACID)] })
  const saved = throwFlask(state, 'acid', [15], 'acid-saved')
  assert.deepEqual(typeOf(saved), ['ItemUsed', 'SavingThrowResolved', 'ItemConsumed'])
  assert.equal(payloadOf(saved, 'SavingThrowResolved').saved, true)
  const after = saved.events.reduce(applyGameEvent, state)
  assert.equal(after.enemies[0].hp, 30)
  assert.equal(after.players[0].inventory.length, 0)
  assert.equal(after.mechanics.combat.action_economy.hero.attacks_used, 1)
})

test('святая вода наносит 2к8 только нежити и исчадиям', () => {
  for (const creatureType of ['undead', 'fiend']) {
    const state = campaignState({ inventory: [item(HOLY_WATER)], creatureType })
    const failed = throwFlask(state, 'holy-water', [10, 4, 5], `holy-${creatureType}`)
    assert.deepEqual(typeOf(failed), ['ItemUsed', 'SavingThrowResolved', 'DieRolled', 'DamageApplied', 'ItemConsumed'])
    assert.equal(failed.events.find((event) => event.event_type === 'DieRolled').payload.expression, '2d8')
    assert.equal(payloadOf(failed, 'DamageApplied').applied_amount, 9)
  }

  const beast = campaignState({ inventory: [item(HOLY_WATER)], creatureType: 'beast' })
  const ineffective = throwFlask(beast, 'holy-water', [10], 'holy-beast')
  assert.deepEqual(typeOf(ineffective), ['ItemUsed', 'SavingThrowResolved', 'ItemEffectIneffective', 'ItemConsumed'])
  assert.equal(payloadOf(ineffective, 'ItemEffectIneffective').reason, 'creature-type')
  assert.match(combatNarration(ineffective.events, beast), /вреда не причиняет/u)
})

test('алхимический огонь наносит 1к4 сразу и 1к4 в начале каждого хода', () => {
  const state = campaignState({ inventory: [item(ALCHEMISTS_FIRE)] })
  const failed = throwFlask(state, 'alchemists-fire', [10, 3], 'fire-failed')
  assert.deepEqual(typeOf(failed), ['ItemUsed', 'SavingThrowResolved', 'DieRolled', 'DamageApplied', 'ConditionAdded', 'ItemConsumed'])
  assert.equal(payloadOf(failed, 'DamageApplied').applied_amount, 3)
  const condition = payloadOf(failed, 'ConditionAdded')
  assert.equal(condition.condition, 'alchemists-fire-flames')
  assert.equal(condition.recurring_damage, '1d4')

  const burning = failed.events.reduce(applyGameEvent, state)
  assert.equal(burning.enemies[0].hp, 27)
  const nextTurn = resolveCommand({
    command_type: 'EndTurn', command_id: 'fire-turn', actor_id: 'hero', server_authoritative: true,
  }, burning, { diceService: dice([4]), context: { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true } })
  const tick = nextTurn.events.find((event) => event.event_type === 'DamageApplied')
  assert.ok(tick)
  assert.equal(tick.payload.damage_type, 'fire')
  assert.equal(tick.payload.applied_amount, 4)
})

test('самостоятельное тушение огня гасит его и опрокидывает существо', () => {
  const onHero = applyGameEvent(campaignState(), {
    campaign_id: null, command_id: 'ignite', event_type: 'ConditionAdded', actor_id: 'hero',
    target_ids: ['hero'], visibility: 'public', source_rule_ids: [],
    payload: { condition: 'alchemists-fire-flames', recurring_damage: '1d4', recurring_damage_type: 'fire' },
  })
  const doused = resolveCommand({
    command_type: 'UseCombatAction', command_id: 'douse', actor_id: 'hero', action_id: 'extinguish-self', server_authoritative: true,
  }, onHero, { diceService: dice(), context: { isAdmin: true, serverAuthoritativeCombat: true } })
  assert.deepEqual(typeOf(doused), ['ConditionRemoved', 'ConditionAdded', 'CombatActionUsed'])
  assert.equal(payloadOf(doused, 'ConditionAdded').condition, 'prone')
  const after = doused.events.reduce(applyGameEvent, onHero)
  assert.equal(after.mechanics.conditions.hero.some((entry) => entry.id === 'alchemists-fire-flames'), false)
  assert.equal(after.mechanics.conditions.hero.some((entry) => entry.id === 'prone'), true)
})

test('флакон заменяет одну атаку бойца с Extra Attack', () => {
  const sword = item('srd_5_2_1:longsword', 'sword', { equipped: true })
  const state = campaignState({ inventory: [item(ACID), sword], level: 5, foeX: 1 })
  const flask = throwFlask(state, 'acid', [15], 'flask-first')
  const afterFlask = flask.events.reduce(applyGameEvent, state)
  assert.equal(afterFlask.mechanics.combat.action_economy.hero.action, false)
  assert.equal(afterFlask.mechanics.combat.action_economy.hero.attacks_used, 1)

  const attack = resolveCommand({
    command_type: 'MakeAttack', command_id: 'sword-second', actor_id: 'hero', target_id: 'foe', item_id: 'sword', server_authoritative: true,
  }, afterFlask, { diceService: dice([20, 4, 4]), context: { isAdmin: true, serverAuthoritativeCombat: true } })
  assert.ok(attack.events.some((event) => event.event_type === 'AttackResolved'))
  const afterAttack = attack.events.reduce(applyGameEvent, afterFlask)
  assert.equal(afterAttack.mechanics.combat.action_economy.hero.attacks_used, 2)

  const reverseState = campaignState({ inventory: [item(ACID), sword], level: 5, foeX: 1 })
  const firstAttack = resolveCommand({
    command_type: 'MakeAttack', command_id: 'sword-first', actor_id: 'hero', target_id: 'foe', item_id: 'sword', server_authoritative: true,
  }, reverseState, { diceService: dice([20, 4, 4]), context: { isAdmin: true, serverAuthoritativeCombat: true } })
  const afterFirstAttack = firstAttack.events.reduce(applyGameEvent, reverseState)
  const secondFlask = throwFlask(afterFirstAttack, 'acid', [15], 'flask-second')
  assert.equal(payloadOf(secondFlask, 'SavingThrowResolved').saved, true)
  const afterSecondFlask = secondFlask.events.reduce(applyGameEvent, afterFirstAttack)
  assert.equal(afterSecondFlask.mechanics.combat.action_economy.hero.attacks_used, 2)
})

test('replay воспроизводит спасбросок флакона, а проекция скрывает модификатор врага', () => {
  const initial = campaignState({ inventory: [item(ACID)], enemyDex: 14 })
  const result = throwFlask(initial, 'acid', [10, 4, 5], 'flask-replay')
  const applied = result.events.reduce(applyGameEvent, initial)
  assert.deepEqual(replayEvents(initial, result.events), applied)

  const visible = mechanicsForViewer(result.events, { role: 'player', heroIds: ['hero'] }, 'hero', initial)
  const save = visible.find((event) => event.event_type === 'SavingThrowResolved')
  assert.ok(save)
  assert.equal(save.payload.modifier, undefined)
  assert.equal(save.payload.expression, undefined)
  assert.equal(save.payload.difficulty, 13)
  assert.equal(save.payload.saved, false)
})

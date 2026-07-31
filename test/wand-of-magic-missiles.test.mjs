import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { ITEM_DESTROYED_EVENT_SCHEMA_VERSION } from '../server/item-lifecycle.mjs'
import { itemViewerCapabilities, materializeCatalogItem } from '../server/item-catalog.mjs'
import {
  RulesValidationError,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
} from '../server/rules-engine.mjs'

const WAND_ID = 'srd_5_2_1:wand-of-magic-missiles'
const CONTEXT = { allowedActorIds: ['hero'], serverAuthoritativeCombat: true }

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `wand-roll-${++id}`,
    now: () => '2026-07-31T12:00:00.000Z',
  })
}

function cells(width = 25, wallAt = null) {
  return Array.from({ length: width }, (_, x) => ({
    x,
    y: 0,
    type: x === wallAt ? 'wall' : 'floor',
    revealed: true,
  }))
}

function fixture({
  charges = 7,
  equipped = true,
  combat = true,
  activeIndex = 0,
  action = true,
  enemyX = 3,
  enemyHp = 50,
  enemyAlive = true,
  wallAt = null,
  elapsedMinutes = 0,
} = {}) {
  const wand = materializeCatalogItem(WAND_ID, {
    id: 'wand',
    quantity: 1,
    equipped,
    charges: { current: charges, max: 7 },
  })
  return normalizeCampaignState({
    sessionCode: 'WAND-MISSILES',
    partyMemberIds: ['hero', 'ally'],
    players: [
      {
        id: 'hero',
        character: 'Воин с жезлом',
        characterClass: 'fighter',
        level: 3,
        hp: 30,
        maxHp: 30,
        armor: 16,
        proficiency: 2,
        abilities: { str: 16, dex: 12, con: 14, int: 8, wis: 10, cha: 10 },
        inventory: [wand],
        x: 0,
        y: 0,
      },
      {
        id: 'ally',
        character: 'Волшебница',
        characterClass: 'wizard',
        level: 3,
        hp: 20,
        maxHp: 20,
        armor: 12,
        proficiency: 2,
        abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 10, cha: 10 },
        inventory: [],
        x: 0,
        y: 1,
      },
    ],
    enemies: [{
      id: 'foe',
      name: 'Огр',
      hp: enemyHp,
      maxHp: 50,
      armor: 12,
      speed: 30,
      abilities: { str: 18, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
      alive: enemyAlive,
      x: enemyX,
      y: 0,
    }],
    scene: {
      turn: 1,
      cells: [
        ...cells(Math.max(25, enemyX + 1), wallAt),
        { x: 0, y: 1, type: 'floor', revealed: true },
      ],
    },
    mechanics: {
      world_time: { elapsed_minutes: elapsedMinutes },
      positions: {
        hero: { x: 0, y: 0 },
        ally: { x: 0, y: 1 },
        foe: { x: enemyX, y: 0 },
      },
      combat: {
        active: combat,
        round: 1,
        active_index: activeIndex,
        initiative: [
          { actor_id: 'hero', total: 18 },
          { actor_id: 'ally', total: 14 },
          { actor_id: 'foe', total: 8 },
        ],
        action_economy: {
          hero: { action, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          ally: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function useWand(state, {
  targetId = 'foe',
  chargesToSpend = 1,
  values = [3],
  extra = {},
} = {}) {
  return resolveCommand({
    command_type: 'UseItem',
    command_id: `wand-${targetId}-${chargesToSpend}`,
    actor_id: 'hero',
    item_id: 'wand',
    target_id: targetId,
    charges_to_spend: chargesToSpend,
    server_authoritative: true,
    ...extra,
  }, state, { diceService: dice(values), context: CONTEXT })
}

test('каталог и viewer дают только авторитетный variable-charge профиль жезла', () => {
  const item = materializeCatalogItem(WAND_ID, {
    id: 'forged-wand',
    equipped: true,
    charges: { current: 5, max: 999 },
    spell_id: 'fireball',
    formula: '99d99',
  })
  assert.equal(item.weight, 0)
  assert.equal(item.requires_attunement, undefined)
  assert.deepEqual(item.charges, { current: 5, max: 7 })
  assert.equal(item.spell_id, undefined)
  assert.equal(item.formula, undefined)
  assert.deepEqual(itemViewerCapabilities(item), {
    equippable: true,
    equip_slot: 'main_hand',
    usable: true,
    use: {
      kind: 'cast_spell',
      action_type: 'action',
      target: 'enemy',
      range_feet: 120,
      spell_id: 'magic-missile',
      min_charges_to_spend: 1,
      max_charges_to_spend: 3,
      default_charges_to_spend: 1,
      requires_equipped: true,
      combat_only: true,
    },
    charges: { current: 5, max: 7 },
    recharge: { schema_version: 1, trigger: 'dawn', formula: '1d6+1' },
    requires_attunement: false,
    mechanics_status: 'partial',
    limitation: 'Сервер исполняет Волшебную стрелу по одной вражеской цели, используя один бросок 1к4 + 1 для всех дротиков, заряды, разрушение и рассветную перезарядку. Counterspell для заклинания без компонентов из предмета не открывается; автоматический Shield NPC и доставание жезла в бою пока не моделируются.',
  })
})

test('три заряда создают Magic Missile 3-го круга без ячейки и метамагии', () => {
  const initial = fixture()
  initial.mechanics.conditions.hero = [{ id: 'metamagic-quickened' }]
  const result = useWand(initial, { chargesToSpend: 3, values: [3] })

  assert.deepEqual(result.events.map((event) => event.event_type), [
    'ItemUsed',
    'SpellCast',
    'DieRolled',
    'DamageApplied',
    'ItemChargesSpent',
  ])
  const used = result.events[0]
  const cast = result.events[1]
  const damage = result.events[3]
  assert.equal(used.payload.combat_action, null)
  assert.equal(used.payload.declared_combat_action, 'action')
  assert.equal(used.payload.charges_to_spend, 3)
  assert.equal(cast.payload.spell_id, 'magic-missile')
  assert.equal(cast.payload.slot_level, 3)
  assert.equal(cast.payload.action_type, 'action')
  assert.deepEqual(cast.payload.source, {
    kind: 'magic-item',
    item_id: 'wand',
    item_name: 'Жезл волшебных стрел',
    catalog_id: WAND_ID,
  })
  assert.equal(damage.payload.projectile_count, 5)
  assert.equal(damage.payload.damage_per_projectile, 4)
  assert.equal(damage.payload.raw_amount, 20)
  assert.equal(damage.payload.source_item_id, 'wand')
  assert.equal(result.events.some((event) => event.event_type === 'ResourceSpent'), false)
  assert.equal(result.events.some((event) => event.event_type === 'ConditionRemoved'), false)
  assert.equal(result.events.some((event) => event.event_type === 'ReactionWindowOpened'), false)

  const after = result.events.reduce(applyGameEvent, initial)
  assert.equal(after.enemies[0].hp, 30)
  assert.deepEqual(after.players[0].inventory[0].charges, { current: 4, max: 7 })
  assert.equal(after.mechanics.combat.action_economy.hero.action, false)
  assert.equal(after.mechanics.conditions.hero.some((condition) => condition.id === 'metamagic-quickened'), true)
  assert.deepEqual(replayEvents(initial, result.events), after)
})

test('жезл принимает только живую вражескую цель', () => {
  const initial = fixture()
  assert.throws(
    () => useWand(initial, { targetId: 'ally', values: [] }),
    (error) => error instanceof RulesValidationError && error.code === 'INVALID_ITEM_TARGET',
  )
})

test('натуральная 1 после последнего заряда уничтожает точный экземпляр payload-only событием', () => {
  const initial = fixture({ charges: 1 })
  const result = useWand(initial, { values: [2, 1] })
  assert.deepEqual(result.rolls.map((roll) => [roll.expression, roll.total]), [['1d4+1', 3], ['1d20', 1]])
  assert.deepEqual(result.events.map((event) => event.event_type), [
    'ItemUsed',
    'SpellCast',
    'DieRolled',
    'DamageApplied',
    'ItemChargesSpent',
    'DieRolled',
    'ItemDestroyed',
  ])
  const destroyed = result.events.at(-1)
  const lastChargeRoll = result.events.at(-2)
  assert.equal(lastChargeRoll.payload.last_charge, true)
  assert.equal(lastChargeRoll.payload.natural, 1)
  assert.equal(destroyed.event_schema_version, ITEM_DESTROYED_EVENT_SCHEMA_VERSION)
  assert.equal(destroyed.payload.schema_version, ITEM_DESTROYED_EVENT_SCHEMA_VERSION)
  assert.equal(destroyed.payload.owner_id, 'hero')
  assert.equal(destroyed.payload.item_id, 'wand')
  assert.equal(destroyed.payload.reason, 'last-charge-natural-1')
  assert.equal(destroyed.payload.trigger_roll_id, lastChargeRoll.payload.roll_id)
  assert.equal(destroyed.payload.natural, 1)

  const after = result.events.reduce(applyGameEvent, initial)
  assert.equal(after.players[0].inventory.some((item) => item.id === 'wand'), false)
  assert.deepEqual(replayEvents(initial, result.events), after)

  const futureVersion = applyGameEvent(initial, {
    ...destroyed,
    event_schema_version: 2,
  })
  const futurePayload = applyGameEvent(initial, {
    ...destroyed,
    payload: { ...destroyed.payload, schema_version: 2 },
  })
  assert.equal(futureVersion.players[0].inventory.some((item) => item.id === 'wand'), true)
  assert.equal(futurePayload.players[0].inventory.some((item) => item.id === 'wand'), true)
})

test('при последнем заряде без натуральной 1 жезл остаётся с нулём зарядов', () => {
  const initial = fixture({ charges: 1 })
  const result = useWand(initial, { values: [2, 2] })
  assert.equal(result.events.some((event) => event.event_type === 'ItemDestroyed'), false)
  const lastChargeRoll = result.events.at(-1)
  assert.equal(lastChargeRoll.event_type, 'DieRolled')
  assert.equal(lastChargeRoll.payload.last_charge, true)
  assert.equal(lastChargeRoll.payload.natural, 2)
  const after = result.events.reduce(applyGameEvent, initial)
  assert.deepEqual(after.players[0].inventory[0].charges, { current: 0, max: 7 })
})

test('рассвет восстанавливает заряды жезла через общий foundation', () => {
  const initial = fixture({ charges: 0, combat: false, elapsedMinutes: 1_439 })
  const result = resolveCommand(
    { command_type: 'AdvanceTime', amount: 1, unit: 'minute' },
    initial,
    { diceService: dice([6]) },
  )
  assert.deepEqual(result.events.map((event) => event.event_type), ['TimeAdvanced', 'ItemDawnRechargeResolved'])
  const recharge = result.events[1]
  assert.equal(recharge.event_schema_version, 1)
  assert.equal(recharge.payload.items[0].catalog_id, WAND_ID)
  assert.equal(recharge.payload.items[0].after, 7)
  const after = result.events.reduce(applyGameEvent, initial)
  assert.deepEqual(after.players[0].inventory[0].charges, { current: 7, max: 7 })
})

test('валидация закрывает экипировку, бой, ход, действие, цель, дальность, LOS и заряды до броска', () => {
  const cases = [
    { state: fixture({ equipped: false }), code: 'ITEM_NOT_EQUIPPED' },
    { state: fixture({ combat: false }), code: 'COMBAT_NOT_ACTIVE' },
    { state: fixture({ activeIndex: 1 }), code: 'OUT_OF_TURN' },
    { state: fixture({ action: false }), code: 'ACTION_SPENT' },
    { state: fixture({ charges: 0 }), code: 'ITEM_CHARGES_EXHAUSTED' },
    { state: fixture({ enemyAlive: false }), code: 'ITEM_TARGET_DEAD' },
    { state: fixture({ enemyX: 25 }), code: 'ITEM_TARGET_OUT_OF_RANGE' },
    { state: fixture({ wallAt: 1 }), code: 'TRAJECTORY_BLOCKED' },
  ]
  for (const scenario of cases) {
    const before = structuredClone(scenario.state)
    assert.throws(
      () => useWand(scenario.state, { values: [] }),
      (error) => error instanceof RulesValidationError && error.code === scenario.code,
      scenario.code,
    )
    assert.deepEqual(scenario.state, before)
  }
  for (const chargesToSpend of [0, 4, 1.5]) {
    assert.throws(
      () => useWand(fixture(), { chargesToSpend, values: [] }),
      (error) => error instanceof RulesValidationError && error.code === 'INVALID_ITEM_CHARGE_SPEND',
    )
  }
})

test('forged spell_id, formula и неизвестные поля не попадают в item path', () => {
  for (const extra of [
    { spell_id: 'fireball' },
    { formula: '99d99' },
    { projectile_count: 99 },
  ]) {
    assert.throws(
      () => useWand(fixture(), { values: [], extra }),
      (error) => error instanceof RulesValidationError && error.code === 'ITEM_COMMAND_UNKNOWN_FIELD',
    )
  }
})

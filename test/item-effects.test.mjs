import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import {
  RulesValidationError,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
} from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `item-effect-roll-${++id}`,
    now: () => '2026-07-31T12:00:00.000Z',
  })
}

function applyAll(state, events) {
  return events.reduce((current, event) => applyGameEvent(current, event), state)
}

function itemFixture({
  item,
  rulesetId = 'srd_5_2_1',
  targetHp = 4,
  targetX = 1,
  combat = true,
  tracker = null,
  dead = false,
  includePositions = true,
} = {}) {
  const positions = includePositions
    ? { medic: { x: 0, y: 0 }, ally: { x: targetX, y: 0 }, foe: { x: 2, y: 0 } }
    : {}
  return normalizeCampaignState({
    ruleset_id: rulesetId,
    sessionCode: 'ITEM-EFFECTS',
    partyMemberIds: ['medic', 'ally'],
    players: [
      {
        id: 'medic',
        character: 'Лекарь',
        hp: 18,
        maxHp: 18,
        armor: 15,
        proficiency: 2,
        abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 14, cha: 10 },
        ...(includePositions ? { x: 0, y: 0 } : {}),
        inventory: [item],
      },
      {
        id: 'ally',
        character: 'Союзник',
        hp: targetHp,
        maxHp: 20,
        armor: 14,
        abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
        ...(includePositions ? { x: targetX, y: 0 } : {}),
        inventory: [],
      },
    ],
    enemies: [{ id: 'foe', hp: 20, maxHp: 20, armor: 12, alive: true, x: 2, y: 0 }],
    scene: {
      turn: 1,
      cells: includePositions
        ? Array.from({ length: Math.max(3, targetX + 1) }, (_, x) => ({ x, y: 0, type: 'floor', revealed: true }))
        : [],
    },
    mechanics: {
      positions,
      conditions: targetHp === 0 && !dead ? { ally: [{ id: 'unconscious' }] } : {},
      death: {
        saving_throws: tracker ? { ally: tracker } : {},
        heroes: dead ? { ally: { status: 'dead' } } : {},
        campaign_status: 'active',
      },
      combat: {
        active: combat,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'medic', total: 18 }, { actor_id: 'ally', total: 12 }, { actor_id: 'foe', total: 8 }],
        action_economy: {
          medic: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          ally: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const serverContext = { allowedActorIds: ['medic'], serverAuthoritativeCombat: true }

test('healing potion uses a bonus action, heals a living nearby party target with server dice, and replays', () => {
  const initial = itemFixture({
    item: materializeCatalogItem('srd_5_2_1:potion-of-healing', { id: 'potion', quantity: 1 }),
  })
  const result = resolveCommand({
    command_type: 'UseItem',
    command_id: 'drink-potion',
    actor_id: 'medic',
    target_id: 'ally',
    item_id: 'potion',
    server_authoritative: true,
  }, initial, { diceService: dice([2, 4]), context: serverContext })

  assert.deepEqual(result.events.map((event) => event.event_type), [
    'ItemUsed',
    'DieRolled',
    'HealingApplied',
    'ItemConsumed',
  ])
  assert.equal(result.events[0].payload.combat_action, 'bonus_action')
  assert.equal(result.events[1].payload.expression, '2d4+2')
  assert.equal(result.events[1].payload.total, 8)
  const after = applyAll(initial, result.events)
  assert.equal(after.players.find((actor) => actor.id === 'ally').hp, 12)
  assert.equal(after.players.find((actor) => actor.id === 'medic').inventory.length, 0)
  assert.equal(after.mechanics.combat.action_economy.medic.action, true)
  assert.equal(after.mechanics.combat.action_economy.medic.bonus_action, false)
  assert.deepEqual(replayEvents(initial, result.events), after)

  initial.mechanics.combat.action_economy.medic.bonus_action = false
  assert.throws(
    () => resolveCommand({
      command_type: 'UseItem',
      actor_id: 'medic',
      target_id: 'ally',
      item_id: 'potion',
      server_authoritative: true,
    }, initial, { diceService: dice([]), context: serverContext }),
    (error) => error instanceof RulesValidationError && error.code === 'BONUS_ACTION_SPENT',
  )
})

test('healing potion uses an action in a D&D 5e 2014 campaign', () => {
  const initial = itemFixture({
    rulesetId: 'dnd_5e_2014',
    item: materializeCatalogItem('srd_5_2_1:potion-of-healing', { id: 'potion', quantity: 1 }),
  })
  const result = resolveCommand({
    command_type: 'UseItem',
    command_id: 'drink-potion-2014',
    actor_id: 'medic',
    target_id: 'ally',
    item_id: 'potion',
    server_authoritative: true,
  }, initial, { diceService: dice([2, 4]), context: serverContext })

  assert.equal(result.events[0].payload.combat_action, 'action')
  const after = applyAll(initial, result.events)
  assert.equal(after.mechanics.combat.action_economy.medic.action, false)
  assert.equal(after.mechanics.combat.action_economy.medic.bonus_action, true)
})

test('party-target item range fails closed outside combat when authoritative positions are unknown', () => {
  const initial = itemFixture({
    item: materializeCatalogItem('srd_5_2_1:potion-of-healing', { id: 'potion', quantity: 1 }),
    combat: false,
    includePositions: false,
  })
  assert.throws(
    () => resolveCommand({
      command_type: 'UseItem',
      actor_id: 'medic',
      target_id: 'ally',
      item_id: 'potion',
      server_authoritative: true,
    }, initial, { diceService: dice([]), context: serverContext }),
    (error) => error instanceof RulesValidationError && error.code === 'ITEM_TARGET_OUT_OF_RANGE',
  )
})

test('healer kit stabilizes without a roll, spends one of ten charges and one action, and replays', () => {
  const initial = itemFixture({
    item: {
      id: 'kit',
      catalog_id: 'srd_5_2_1:healers-kit',
      name: 'Набор лекаря',
      type: 'gear',
      quantity: 1,
    },
    targetHp: 0,
    tracker: { successes: 1, failures: 1, stable: false },
  })
  const result = resolveCommand({
    command_type: 'UseItem',
    command_id: 'stabilize-with-kit',
    actor_id: 'medic',
    target_id: 'ally',
    item_id: 'kit',
    server_authoritative: true,
  }, initial, { diceService: dice([]), context: serverContext })

  assert.deepEqual(result.events.map((event) => event.event_type), [
    'ItemUsed',
    'HeroStabilized',
    'ItemChargesSpent',
  ])
  assert.equal(result.events.some((event) => event.event_type === 'DieRolled'), false)
  assert.deepEqual(result.events.at(-1).payload, {
    item_id: 'kit',
    item_name: 'Набор лекаря',
    before: 10,
    spent: 1,
    after: 9,
    max: 10,
    reason: 'healers-kit-stabilization',
    request_fingerprint: null,
  })
  const after = applyAll(initial, result.events)
  assert.equal(after.mechanics.death.saving_throws.ally.stable, true)
  assert.deepEqual(after.players[0].inventory[0].charges, { current: 9, max: 10 })
  assert.equal(after.mechanics.combat.action_economy.medic.action, false)
  assert.equal(after.mechanics.combat.action_economy.medic.bonus_action, true)
  assert.deepEqual(replayEvents(initial, result.events), after)
})

test('healer kit rejects exhausted, stable, positive-HP, dead and distant targets before spending charges', () => {
  const command = {
    command_type: 'UseItem',
    actor_id: 'medic',
    target_id: 'ally',
    item_id: 'kit',
    server_authoritative: true,
  }
  const kit = (charges) => materializeCatalogItem('srd_5_2_1:healers-kit', {
    id: 'kit',
    quantity: 1,
    charges,
  })
  const cases = [
    {
      state: itemFixture({ item: kit({ current: 0, max: 10 }), targetHp: 0 }),
      code: 'ITEM_CHARGES_EXHAUSTED',
    },
    {
      state: itemFixture({
        item: kit({ current: 8, max: 10 }),
        targetHp: 0,
        tracker: { successes: 0, failures: 0, stable: true },
      }),
      code: 'ITEM_TARGET_STABLE',
    },
    {
      state: itemFixture({ item: kit({ current: 8, max: 10 }), targetHp: 1 }),
      code: 'ITEM_TARGET_NOT_DYING',
    },
    {
      state: itemFixture({ item: kit({ current: 8, max: 10 }), targetHp: 0, dead: true }),
      code: 'ITEM_TARGET_DEAD',
    },
    {
      state: itemFixture({ item: kit({ current: 8, max: 10 }), targetHp: 0, targetX: 2 }),
      code: 'ITEM_TARGET_OUT_OF_RANGE',
    },
  ]

  for (const scenario of cases) {
    const before = structuredClone(scenario.state)
    assert.throws(
      () => resolveCommand(command, scenario.state, { diceService: dice([]), context: serverContext }),
      (error) => error instanceof RulesValidationError && error.code === scenario.code,
      scenario.code,
    )
    assert.deepEqual(scenario.state, before)
  }
})

test('longsword +1 adds exactly one to the authoritative attack and damage profiles', () => {
  const stateFor = (catalogId, itemId) => normalizeCampaignState({
    players: [{
      id: 'hero',
      hp: 20,
      maxHp: 20,
      armor: 16,
      proficiency: 2,
      abilities: { str: 16, dex: 10, con: 14, int: 10, wis: 10, cha: 10 },
      x: 0,
      y: 0,
      inventory: [materializeCatalogItem(catalogId, { id: itemId, quantity: 1, equipped: true })],
    }],
    enemies: [{ id: 'target', hp: 30, maxHp: 30, armor: 12, alive: true, x: 1, y: 0 }],
    scene: {
      turn: 1,
      cells: [
        { x: 0, y: 0, type: 'floor', revealed: true },
        { x: 1, y: 0, type: 'floor', revealed: true },
      ],
    },
    mechanics: {
      positions: { hero: { x: 0, y: 0 }, target: { x: 1, y: 0 } },
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'hero' }, { actor_id: 'target' }],
        action_economy: { hero: { action: true, bonus_action: true } },
      },
    },
  })
  const resolveAttack = (state, itemId) => resolveCommand({
    command_type: 'MakeAttack',
    actor_id: 'hero',
    target_id: 'target',
    item_id: itemId,
    server_authoritative: true,
  }, state, {
    diceService: dice([15, 4]),
    context: { serverAuthoritativeCombat: true },
  })

  const ordinary = resolveAttack(stateFor('srd_5_2_1:longsword', 'ordinary'), 'ordinary')
  const magicalState = stateFor('srd_5_2_1:longsword-plus-1', 'magical')
  const magical = resolveAttack(magicalState, 'magical')
  const ordinaryAttack = ordinary.events.find((event) => event.event_type === 'AttackResolved')
  const magicalAttack = magical.events.find((event) => event.event_type === 'AttackResolved')
  const ordinaryDamage = ordinary.events.find((event) => event.event_type === 'DamageApplied')
  const magicalDamage = magical.events.find((event) => event.event_type === 'DamageApplied')

  assert.equal(magicalAttack.payload.modifier, ordinaryAttack.payload.modifier + 1)
  assert.equal(magicalAttack.payload.total, ordinaryAttack.payload.total + 1)
  assert.equal(magicalDamage.payload.raw_amount, ordinaryDamage.payload.raw_amount + 1)
  assert.deepEqual(replayEvents(magicalState, magical.events), applyAll(magicalState, magical.events))
})

test('GrantItem stamps known passive effects and ignores forged catalog mechanics', () => {
  const initial = normalizeCampaignState({
    players: [{
      id: 'hero',
      character: 'Страж',
      characterClass: 'fighter',
      level: 1,
      hp: 12,
      maxHp: 12,
      armor: 12,
      abilities: { str: 12, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
      inventory: [],
    }],
  })
  const result = resolveCommand({
    command_type: 'GrantItem',
    command_id: 'grant-ring',
    actor_id: 'hero',
    item: {
      id: 'ring',
      catalog_id: 'srd_5_2_1:ring-of-protection',
      equipped: true,
      attuned_to: 'hero',
      passive_effects: [{
        schema_version: 1,
        effect_id: 'forged',
        group: 'forged',
        armor_class_bonus: 99,
        saving_throw_bonus: 99,
      }],
    },
  }, initial, { diceService: dice([]), context: { isAdmin: true } })
  const grantedEvent = result.events.find((event) => event.event_type === 'ItemGranted')
  const granted = grantedEvent.payload.item
  assert.equal(grantedEvent.event_schema_version, 2)
  assert.deepEqual(granted.passive_effects, materializeCatalogItem('srd_5_2_1:ring-of-protection').passive_effects)
  assert.equal(granted.requires_attunement, true)
  assert.equal(granted.rarity, 'редкий')
  const after = applyAll(initial, result.events)
  assert.equal(after.players[0].inventory[0].equipped, true)
  assert.equal(after.players[0].inventory[0].attuned_to, 'hero')
  assert.equal(after.players[0].characterSheet.armor_class.item_effect_bonus, 1)
  assert.equal(after.players[0].armor, 13)
  assert.deepEqual(replayEvents(initial, result.events), after)

  const legacyItem = {
    id: 'legacy-ring',
    catalog_id: 'srd_5_2_1:ring-of-protection',
    name: 'Старое кольцо',
    type: 'other',
    quantity: 1,
    equipped: true,
    attuned_to: 'hero',
  }
  const legacyEvent = {
    event_type: 'ItemGranted',
    actor_id: 'hero',
    target_ids: ['hero'],
    payload: { item: legacyItem },
  }
  const legacyInitial = structuredClone(initial)
  legacyInitial.players[0].armor = 99
  const legacyAfter = applyGameEvent(legacyInitial, legacyEvent)
  assert.deepEqual(legacyAfter.players[0].inventory[0], legacyItem)
  assert.equal(legacyAfter.players[0].characterSheet.armor_class.item_effect_bonus, 0)
  assert.equal(legacyAfter.players[0].armor, 99)
  assert.deepEqual(replayEvents(legacyInitial, [legacyEvent]), legacyAfter)
})

test('Equip → Attune → normalize/replay applies Ring of Protection AC once for every base formula', () => {
  const ring = materializeCatalogItem('srd_5_2_1:ring-of-protection', { id: 'ring', quantity: 1 })
  const initial = normalizeCampaignState({
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero',
      character: 'Страж',
      characterClass: 'fighter',
      level: 1,
      hp: 20,
      maxHp: 20,
      armor: 99,
      proficiency: 2,
      abilities: { str: 12, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
      inventory: [
        { ...materializeCatalogItem('srd_5_2_1:leather-armor', { id: 'leather' }), equipped: true },
        ring,
      ],
    }],
    enemies: [{
      id: 'foe',
      name: 'Противник',
      hp: 20,
      maxHp: 20,
      armor: 12,
      alive: true,
      abilities: { str: 10, dex: 10 },
      action_profiles: [{ id: 'claw', kind: 'melee', attack_modifier: 0, damage_amount: 1, damage_type: 'slashing', range_feet: 5 }],
    }],
    mechanics: { combat: { active: false } },
  })
  const equip = resolveCommand({
    command_type: 'EquipItem',
    command_id: 'equip-ring',
    actor_id: 'hero',
    item_id: 'ring',
    equipped: true,
  }, initial, { diceService: dice([]), context: { allowedActorIds: ['hero'] } })
  const equipped = applyAll(initial, equip.events)
  assert.equal(equipped.players[0].armor, 13)
  assert.equal(equipped.players[0].characterSheet.armor_class.item_effect_bonus, 0)

  const attune = resolveCommand({
    command_type: 'AttuneItem',
    command_id: 'attune-ring',
    actor_id: 'hero',
    item_id: 'ring',
    attuned: true,
  }, equipped, { diceService: dice([]), context: { allowedActorIds: ['hero'] } })
  const lifecycleEvents = [...equip.events, ...attune.events]
  const attuned = applyAll(equipped, attune.events)
  assert.equal(attuned.players[0].armor, 14)
  assert.equal(attuned.players[0].characterSheet.armor_class.item_effect_bonus, 1)
  assert.deepEqual(replayEvents(initial, lifecycleEvents), attuned)

  const normalized = normalizeCampaignState(attuned)
  assert.deepEqual(normalized.players[0].inventory.find((item) => item.id === 'ring').passive_effects, ring.passive_effects)
  const targetArmorClass = (configure = () => {}) => {
    const combat = structuredClone(normalized)
    combat.players[0].x = 0
    combat.players[0].y = 0
    combat.enemies[0].x = 1
    combat.enemies[0].y = 0
    combat.scene = {
      turn: 1,
      cells: [
        { x: 0, y: 0, type: 'floor', revealed: true },
        { x: 1, y: 0, type: 'floor', revealed: true },
      ],
    }
    combat.mechanics.positions = { hero: { x: 0, y: 0 }, foe: { x: 1, y: 0 } }
    combat.mechanics.conditions = {}
    combat.mechanics.combat = {
      active: true,
      round: 1,
      active_index: 0,
      initiative: [{ actor_id: 'foe' }, { actor_id: 'hero' }],
      action_economy: { foe: { action: true, bonus_action: true } },
    }
    configure(combat)
    const result = resolveCommand({
      command_type: 'MakeAttack',
      actor_id: 'foe',
      target_id: 'hero',
      action_id: 'claw',
      server_authoritative: true,
    }, combat, {
      diceService: dice([10]),
      context: { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true },
    })
    return result.events.find((event) => event.event_type === 'AttackResolved').payload.armor_class
  }

  assert.equal(targetArmorClass(), 14, 'equipment base 13 + item 1')
  assert.equal(targetArmorClass((state) => {
    state.mechanics.conditions.hero = [{ id: 'mage-armor' }]
  }), 16, 'Mage Armor 15 + item 1')
  assert.equal(targetArmorClass((state) => {
    state.mechanics.conditions.hero = [{ id: 'barkskin' }]
  }), 17, 'floor 16 + item 1')
  assert.equal(targetArmorClass((state) => {
    state.players[0].armor = 18
    state.players[0].characterSheet = null
  }), 19, 'listed base 18 + item 1')
})

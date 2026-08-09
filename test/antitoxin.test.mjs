import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { ITEM_CATALOG, materializeCatalogItem } from '../server/item-catalog.mjs'
import {
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
} from '../server/rules-engine.mjs'

const ANTITOXIN = 'srd_5_2_1:antitoxin'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `antitoxin-roll-${++id}`,
    now: () => '2026-08-09T12:00:00.000Z',
  })
}

function stateWithAntitoxin({ quantity = 2, combat = true } = {}) {
  return normalizeCampaignState({
    sessionCode: 'ANTITOXIN-1',
    campaign_id: 'ANTITOXIN-1',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero',
      character: 'Мира',
      characterClass: 'fighter',
      level: 3,
      proficiency: 2,
      hp: 24,
      maxHp: 24,
      armor: 16,
      speed: 30,
      abilities: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
      inventory: [materializeCatalogItem(ANTITOXIN, { id: 'antitoxin-1', quantity })],
      x: 0,
      y: 0,
    }],
    enemies: [{ id: 'foe', name: 'Враг', hp: 20, maxHp: 20, armor: 12, alive: true, x: 1, y: 0 }],
    scene: { turn: 1, cells: [{ x: 0, y: 0, type: 'floor', revealed: true }, { x: 1, y: 0, type: 'floor', revealed: true }] },
    mechanics: {
      positions: { hero: { x: 0, y: 0 }, foe: { x: 1, y: 0 } },
      combat: {
        active: combat,
        round: combat ? 1 : 0,
        active_index: combat ? 0 : -1,
        initiative: combat ? [{ actor_id: 'hero', total: 18 }, { actor_id: 'foe', total: 10 }] : [],
        action_economy: combat ? {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        } : {},
      },
    },
  })
}

const options = (diceService) => ({
  diceService,
  context: { allowedActorIds: ['hero'], isAdmin: true, serverAuthoritativeCombat: true },
})

function drink(state, commandId = 'drink-antitoxin') {
  return resolveCommand({
    command_type: 'UseItem',
    command_id: commandId,
    actor_id: 'hero',
    item_id: 'antitoxin-1',
    target_id: 'hero',
  }, state, options(dice()))
}

test('catalog exposes the bounded SRD 5.2.1 antitoxin profile as partial', () => {
  const entry = ITEM_CATALOG[ANTITOXIN]
  assert.equal(entry.mechanics_status, 'partial')
  assert.deepEqual(entry.use, {
    kind: 'antitoxin',
    consumes: 1,
    combat_action: 'bonus_action',
    range_feet: 0,
    target: 'self',
    duration_minutes: 60,
    save_condition: 'poisoned',
  })
  assert.equal(entry.dndsu_reference_url, 'https://next.dnd.su/equipment/204-antitoxin')
  assert.match(entry.limitation, /обычные спасброски Телосложения не затрагиваются/iu)
})

test('drinking antitoxin spends a bonus action, consumes one flask and replays identically', () => {
  const initial = stateWithAntitoxin()
  const result = drink(initial)
  const after = replayEvents(initial, result.events)

  assert.deepEqual(result.events.map((event) => event.event_type), ['ItemUsed', 'ConditionAdded', 'ItemConsumed'])
  const applied = result.events[1].payload
  assert.equal(applied.condition, 'antitoxin')
  assert.equal(applied.save_condition, 'poisoned')
  assert.equal(applied.started_at_minutes, 0)
  assert.equal(applied.expires_at_minutes, 60)
  assert.equal(after.mechanics.combat.action_economy.hero.bonus_action, false)
  assert.equal(after.players[0].inventory[0].quantity, 1)
  assert.deepEqual(result.events.reduce(applyGameEvent, initial), after)

  assert.throws(
    () => drink(after, 'drink-antitoxin-again'),
    (error) => error.code === 'BONUS_ACTION_SPENT',
  )
  assert.equal(after.players[0].inventory[0].quantity, 1, 'отказ не расходует оставшийся флакон')
})

test('antitoxin is self-only and cannot be used without a remaining flask', () => {
  const initial = stateWithAntitoxin({ quantity: 1 })
  assert.throws(
    () => resolveCommand({ command_type: 'UseItem', actor_id: 'hero', item_id: 'antitoxin-1', target_id: 'foe' }, initial, options(dice())),
    (error) => error.code === 'INVALID_ITEM_TARGET',
  )

  const single = stateWithAntitoxin({ quantity: 1 })
  const consumed = replayEvents(single, drink(single).events)
  assert.equal(consumed.players[0].inventory.length, 0)
  assert.throws(
    () => resolveCommand({ command_type: 'UseItem', actor_id: 'hero', item_id: 'antitoxin-1', target_id: 'hero' }, consumed, options(dice())),
    (error) => error.code === 'ITEM_NOT_FOUND',
  )
})

test('the effect expires after exactly sixty world minutes through replayable time events', () => {
  const initial = stateWithAntitoxin({ quantity: 1, combat: false })
  const protectedState = replayEvents(initial, drink(initial).events)
  const after59 = applyGameEvent(protectedState, {
    event_type: 'TimeAdvanced', actor_id: null, target_ids: [], payload: { elapsed_minutes: 59 },
  })
  assert.ok(after59.mechanics.conditions.hero.some((condition) => condition.id === 'antitoxin'))

  const after60 = applyGameEvent(after59, {
    event_type: 'TimeAdvanced', actor_id: null, target_ids: [], payload: { elapsed_minutes: 1 },
  })
  assert.equal(after60.mechanics.world_time.elapsed_minutes, 60)
  assert.equal(after60.mechanics.conditions.hero.some((condition) => condition.id === 'antitoxin'), false)
})

function poisonAttackState(protectedState) {
  const state = normalizeCampaignState(protectedState)
  const poisonProfile = {
    id: 'venom-bite',
    name: 'Ядовитый укус',
    kind: 'melee',
    attack_modifier: 6,
    damage_expression: '1d4',
    damage_type: 'piercing',
    range_feet: 5,
    on_hit: { save_ability: 'con', save_dc: 15, condition: 'poisoned', duration: 'until-source-next-turn' },
  }
  state.enemies = [{
    id: 'venomous', name: 'Ядовитая тварь', hp: 20, maxHp: 20, armor: 12, speed: 30, alive: true,
    abilities: { str: 12, dex: 14, con: 12, int: 3, wis: 10, cha: 4 },
    action_profiles: [poisonProfile], attack_profile: poisonProfile, x: 1, y: 0,
  }]
  state.mechanics.positions = { hero: { x: 0, y: 0 }, venomous: { x: 1, y: 0 } }
  state.mechanics.encounter = { enemy_ids: ['venomous'] }
  state.mechanics.combat = {
    active: true,
    round: 1,
    active_index: 0,
    initiative: [{ actor_id: 'venomous', total: 20 }, { actor_id: 'hero', total: 10 }],
    action_economy: {
      venomous: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
      hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
    },
  }
  return state
}

test('only an authoritative Poisoned save gets advantage; an ordinary Constitution save stays normal', () => {
  const initial = stateWithAntitoxin({ quantity: 1, combat: false })
  const protectedState = replayEvents(initial, drink(initial).events)
  const attack = resolveCommand({
    command_type: 'MakeAttack',
    command_id: 'venom-bite',
    actor_id: 'venomous',
    target_id: 'hero',
    action_id: 'venom-bite',
    server_authoritative: true,
  }, poisonAttackState(protectedState), {
    diceService: dice([15, 2, 3, 17]),
    context: { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true },
  })
  const poisonSave = attack.events.find((event) => event.event_type === 'SavingThrowResolved')
  assert.equal(poisonSave.payload.mode, 'advantage')
  assert.equal(poisonSave.payload.antitoxin_advantage, true)
  assert.deepEqual(poisonSave.payload.dice, [3, 17])

  const ordinarySave = resolveCommand({
    command_type: 'MakeSavingThrow',
    command_id: 'ordinary-con-save',
    actor_id: 'hero',
    ability: 'con',
    difficulty: 15,
  }, protectedState, options(dice([3, 17])))
    .events.find((event) => event.event_type === 'SavingThrowResolved')
  assert.equal(ordinarySave.payload.mode, 'normal')
  assert.equal(ordinarySave.payload.antitoxin_advantage, undefined)
  assert.deepEqual(ordinarySave.payload.dice, [3])
})

test('the current ray-of-sickness path tags its Poisoned save for antitoxin', () => {
  const initial = stateWithAntitoxin({ quantity: 1, combat: false })
  const protectedState = replayEvents(initial, drink(initial).events)
  const protectedHero = protectedState.players[0]
  protectedState.partyMemberIds = ['caster']
  protectedState.players = [{
    id: 'caster', character: 'Маг', characterClass: 'wizard', level: 3, proficiency: 2,
    hp: 20, maxHp: 20, armor: 12, speed: 30,
    abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 12, cha: 10 }, inventory: [], x: 0, y: 0,
  }]
  protectedState.enemies = [{ ...protectedHero, id: 'hero', name: 'Защищённая цель', alive: true, x: 1, y: 0 }]
  protectedState.mechanics.positions = { caster: { x: 0, y: 0 }, hero: { x: 1, y: 0 } }
  protectedState.mechanics.combat = {
    active: true,
    round: 1,
    active_index: 0,
    initiative: [{ actor_id: 'caster', total: 18 }, { actor_id: 'hero', total: 10 }],
    action_economy: {
      caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
      hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
    },
  }

  const cast = resolveCommand({
    command_type: 'CastSpell',
    command_id: 'ray-of-sickness-antitoxin',
    actor_id: 'caster',
    spell_id: 'ray-of-sickness',
    target_id: 'hero',
    server_authoritative: true,
  }, normalizeCampaignState(protectedState), {
    diceService: dice([15, 4, 4, 3, 17]),
    context: { isAdmin: true, serverAuthoritativeCombat: true },
  })
  const save = cast.events.find((event) => event.event_type === 'SpellSavingThrowResolved' && event.payload.trigger === 'on-hit')
  assert.equal(save.payload.mode, 'advantage')
  assert.equal(save.payload.antitoxin_advantage, true)
  assert.deepEqual(save.payload.dice, [3, 17])
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `aura-protection-roll-${++id}`,
    now: () => '2026-07-18T18:00:00.000Z',
  })
}

function fixture({ dying = false, paladinConditions = [], includeWeakPaladin = true, allyRing = false } = {}) {
  const cells = Array.from({ length: 40 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'AURA-OF-PROTECTION',
    partyMemberIds: ['paladin', 'ally', 'far', ...(includeWeakPaladin ? ['weak-paladin'] : [])],
    players: [
      { id: 'paladin', character: 'Сиэль', characterClass: 'paladin', level: 6, hp: 38, maxHp: 38, armor: 18, speed: 30, proficiency: 3, abilities: { str: 16, dex: 10, con: 14, int: 10, wis: 12, cha: 18 }, x: 1, y: 1, inventory: [] },
      { id: 'ally', character: 'Торн', characterClass: 'fighter', level: 6, hp: dying ? 0 : 32, maxHp: 32, armor: 17, speed: 30, proficiency: 3, abilities: { str: 16, dex: 10, con: 14, int: 10, wis: 10, cha: 10 }, x: 1, y: 2, inventory: allyRing ? [{ ...materializeCatalogItem('srd_5_2_1:ring-of-protection', { id: 'ally-ring' }), equipped: true, attuned_to: 'ally' }] : [] },
      { id: 'far', character: 'Рин', characterClass: 'rogue', level: 6, hp: 28, maxHp: 28, armor: 15, speed: 30, proficiency: 3, abilities: { str: 10, dex: 18, con: 12, int: 12, wis: 10, cha: 12 }, x: 5, y: 1, inventory: [] },
      ...(includeWeakPaladin ? [{ id: 'weak-paladin', character: 'Эл', characterClass: 'paladin', level: 6, hp: 30, maxHp: 30, armor: 17, speed: 30, proficiency: 3, abilities: { str: 14, dex: 10, con: 14, int: 10, wis: 10, cha: 12 }, x: 2, y: 2, inventory: [] }] : []),
    ],
    enemies: [{ id: 'enemy', name: 'Культист', hp: 24, maxHp: 24, armor: 12, speed: 30, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, x: 2, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      positions: { paladin: { x: 1, y: 1 }, ally: { x: 1, y: 2 }, far: { x: 5, y: 1 }, 'weak-paladin': { x: 2, y: 2 }, enemy: { x: 2, y: 1 } },
      conditions: { paladin: paladinConditions, ...(dying ? { ally: [{ id: 'unconscious' }] } : {}) },
      death: { saving_throws: dying ? { ally: { successes: 0, failures: 0, stable: false } } : {}, heroes: {}, campaign_status: 'active' },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'paladin', total: 18 }, { actor_id: 'ally', total: 14 }, { actor_id: 'enemy', total: 10 }],
        action_economy: {
          paladin: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          ally: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          enemy: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const applyAll = (state, events) => events.reduce((current, event) => applyGameEvent(current, event), state)

test('Аура защиты добавляет лучший бонус Харизмы союзнику в 10 футах и не складывается', () => {
  const state = fixture()
  const near = resolveCommand({ command_type: 'MakeSavingThrow', actor_id: 'ally', ability: 'dex', difficulty: 12 }, state, { diceService: dice([8]), context: { isAdmin: true } })
  const event = near.events.find((candidate) => candidate.event_type === 'SavingThrowResolved')
  assert.equal(event.payload.modifier, 4)
  assert.equal(event.payload.total, 12)
  assert.equal(event.payload.success, true)
  assert.equal(event.payload.aura_of_protection_source, 'paladin')
  assert.equal(event.payload.aura_of_protection_bonus, 4)
  assert.ok(event.source_rule_ids.includes('srd_5_2_1:classes:paladin-aura-of-protection'))

  const withItem = resolveCommand({ command_type: 'MakeSavingThrow', actor_id: 'ally', ability: 'dex', difficulty: 12 }, fixture({ allyRing: true }), { diceService: dice([8]), context: { isAdmin: true } })
  const itemEvent = withItem.events.find((candidate) => candidate.event_type === 'SavingThrowResolved')
  assert.equal(itemEvent.payload.modifier, 5)
  assert.equal(itemEvent.payload.total, 13)
  assert.equal(itemEvent.payload.item_saving_throw_bonus, 1)
  assert.equal(itemEvent.payload.aura_of_protection_bonus, 4)

  const far = resolveCommand({ command_type: 'MakeSavingThrow', actor_id: 'far', ability: 'dex', difficulty: 12 }, state, { diceService: dice([8]), context: { isAdmin: true } })
  const farEvent = far.events.find((candidate) => candidate.event_type === 'SavingThrowResolved')
  assert.equal(farEvent.payload.modifier, 4)
  assert.equal(farEvent.payload.aura_of_protection_source, undefined)

  const hostile = resolveCommand({ command_type: 'MakeSavingThrow', actor_id: 'enemy', ability: 'dex', difficulty: 12 }, state, { diceService: dice([8]), context: { isAdmin: true } })
  assert.equal(hostile.events.find((candidate) => candidate.event_type === 'SavingThrowResolved').payload.modifier, 0)
})

test('Аура защиты отключается при недееспособности паладина и после выхода из радиуса', () => {
  const incapacitated = fixture({ paladinConditions: [{ id: 'incapacitated' }], includeWeakPaladin: false })
  const disabled = resolveCommand({ command_type: 'MakeSavingThrow', actor_id: 'ally', ability: 'wis', difficulty: 10 }, incapacitated, { diceService: dice([8]), context: { isAdmin: true } })
  assert.equal(disabled.events.find((event) => event.event_type === 'SavingThrowResolved').payload.total, 8)

  const active = fixture({ includeWeakPaladin: false })
  active.enemies = []
  delete active.mechanics.positions.enemy
  const movement = resolveCommand({ command_type: 'MoveActor', actor_id: 'paladin', to: { x: 4, y: 2 }, server_authoritative: true }, active, { diceService: dice(), context: { isAdmin: true, serverAuthoritativeCombat: true } })
  const moved = applyAll(active, movement.events)
  const outside = resolveCommand({ command_type: 'MakeSavingThrow', actor_id: 'ally', ability: 'wis', difficulty: 10 }, moved, { diceService: dice([8]), context: { isAdmin: true } })
  const outsideEvent = outside.events.find((event) => event.event_type === 'SavingThrowResolved')
  assert.equal(outsideEvent.payload.total, 8)
  assert.equal(outsideEvent.payload.aura_of_protection_source, undefined)
})

test('Аура защиты и предмет применяются к death save, но не отменяют особый эффект натуральной 1', () => {
  const state = fixture({ dying: true, includeWeakPaladin: false, allyRing: true })
  const saved = resolveCommand({ command_type: 'EndTurn', actor_id: 'paladin' }, state, { diceService: dice([6]), context: { isAdmin: true } })
  const saveEvent = saved.events.find((event) => event.event_type === 'DeathSavingThrowRolled')
  assert.equal(saveEvent.payload.total, 11)
  assert.equal(saveEvent.payload.success, true)
  assert.equal(saveEvent.payload.item_saving_throw_bonus, 1)
  assert.ok(saveEvent.payload.modifier_sources.includes('item-passive-effect'))
  assert.equal(saveEvent.payload.aura_of_protection_source, 'paladin')
  assert.ok(saveEvent.source_rule_ids.includes('srd_5_2_1:classes:paladin-aura-of-protection'))
  assert.deepEqual(replayEvents(state, saved.events), applyAll(state, saved.events))

  const naturalOne = resolveCommand({ command_type: 'EndTurn', actor_id: 'paladin' }, state, { diceService: dice([1]), context: { isAdmin: true } })
  const oneEvent = naturalOne.events.find((event) => event.event_type === 'DeathSavingThrowRolled')
  assert.equal(oneEvent.payload.total, 6)
  assert.equal(oneEvent.payload.failure_increment, 2)
})

test('Заклинательный save использует ауру союзного паладина цели', () => {
  const state = fixture({ includeWeakPaladin: false })
  state.players[0] = { ...state.players[0], characterClass: 'cleric', level: 5, proficiency: 3, abilities: { ...state.players[0].abilities, wis: 16 }, combatSpells: undefined }
  state.enemies = [
    { id: 'enemy', name: 'Страж', characterClass: 'fighter', level: 6, hp: 24, maxHp: 24, armor: 12, speed: 30, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, x: 2, y: 1, alive: true, inventory: [{ ...materializeCatalogItem('srd_5_2_1:ring-of-protection', { id: 'enemy-ring' }), equipped: true, attuned_to: 'enemy' }] },
    { id: 'enemy-paladin', name: 'Чёрный рыцарь', characterClass: 'paladin', level: 6, hp: 40, maxHp: 40, armor: 18, speed: 30, abilities: { str: 16, dex: 10, con: 14, int: 10, wis: 10, cha: 18 }, x: 3, y: 1, alive: true },
  ]
  state.mechanics.positions['enemy-paladin'] = { x: 3, y: 1 }
  const normalized = normalizeCampaignState(state)
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'paladin', spell_id: 'sacred-flame', target_id: 'enemy', target_ids: ['enemy'], server_authoritative: true }, normalized, { diceService: dice([6, 8, 10]), context: { serverAuthoritativeCombat: true } })
  const save = result.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(save.payload.modifier, 5)
  assert.equal(save.payload.total, 15)
  assert.equal(save.payload.saved, true)
  assert.equal(save.payload.item_saving_throw_bonus, 1)
  assert.equal(save.payload.aura_of_protection_source, 'enemy-paladin')
  assert.equal(result.events.some((event) => event.event_type === 'DamageApplied'), false)
})

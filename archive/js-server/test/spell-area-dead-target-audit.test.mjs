import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

test('area turn consequences continue on a dying hero and record a death-save failure', () => {
  const cells = Array.from({ length: 25 }, (_, index) => ({
    x: index % 5,
    y: Math.floor(index / 5),
    type: 'floor',
    revealed: true,
  }))
  const state = normalizeCampaignState({
    sessionCode: 'AREA-DEAD-AUDIT',
    partyMemberIds: ['caster', 'target'],
    players: [
      {
        id: 'caster', character: 'Маг', characterClass: 'wizard', level: 5,
        hp: 20, maxHp: 20, armor: 12, speed: 30, proficiency: 3,
        abilities: { int: 18, con: 14 }, inventory: [], x: 0, y: 0,
      },
      {
        id: 'target', character: 'Цель', characterClass: 'fighter', level: 5,
        hp: 5, maxHp: 20, armor: 12, speed: 30, proficiency: 3,
        abilities: { dex: 10, con: 10 }, inventory: [], x: 2, y: 2,
      },
    ],
    enemies: [],
    scene: { turn: 1, cells },
    mechanics: {
      active_effects: [
        { id: 'area-a', effect_id: 'area-a', spell_id: 'area-a', source_actor: 'caster', center: { x: 2, y: 2 }, radius_feet: 5, area_shape: 'sphere', trigger_on_turn_start: true, damage_amount: 5, damage_type: 'fire' },
        { id: 'area-b', effect_id: 'area-b', spell_id: 'area-b', source_actor: 'caster', center: { x: 2, y: 2 }, radius_feet: 5, area_shape: 'sphere', trigger_on_turn_start: true, damage_amount: 1, damage_type: 'fire' },
      ],
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'target', total: 10 }],
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          target: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
  let rollId = 0
  const result = resolveCommand({ command_type: 'EndTurn', command_id: 'dead-area', actor_id: 'caster', server_authoritative: true }, state, {
    diceService: new DiceService({
      rng: new SequenceDiceRng(Array(50).fill(1)),
      idFactory: () => `dead-area-${++rollId}`,
      now: () => '2026-09-19T12:00:00.000Z',
    }),
    context: { serverAuthoritativeCombat: true },
  })
  const damage = result.events.filter((event) => event.event_type === 'DamageApplied' && event.target_ids.includes('target'))
  assert.equal(damage.length, 2, 'вторая область обязана добить проверку смерти живого героя с 0 HP')
  assert.equal(result.events.filter((event) => event.event_type === 'HitPointsReducedToZero' && event.target_ids.includes('target')).length, 1)
  assert.equal(result.events.filter((event) => event.event_type === 'DeathSaveFailureRecorded' && event.target_ids.includes('target')).length, 1)
  assert.equal(result.events.some((event) => event.event_type === 'HeroDied'), false, 'одного провала недостаточно для смерти')
})

test('area turn consequences stop for a dead hero and an enemy already at 0 HP', () => {
  const cells = Array.from({ length: 25 }, (_, index) => ({ x: index % 5, y: Math.floor(index / 5), type: 'floor', revealed: true }))
  const state = normalizeCampaignState({
    sessionCode: 'AREA-DEAD-GUARDS',
    partyMemberIds: ['caster'],
    players: [
      { id: 'caster', character: 'Маг', characterClass: 'wizard', level: 5, hp: 20, maxHp: 20, armor: 12, speed: 30, proficiency: 3, abilities: { int: 18, con: 14 }, inventory: [], x: 0, y: 0 },
      { id: 'dead-hero', character: 'Мёртвый', characterClass: 'fighter', level: 5, hp: 0, maxHp: 20, armor: 12, speed: 30, proficiency: 3, abilities: { dex: 10, con: 10 }, inventory: [], x: 2, y: 2 },
    ],
    enemies: [{ id: 'zero-enemy', name: 'Павший враг', hp: 0, maxHp: 20, armor: 12, speed: 30, abilities: { dex: 10, con: 10 }, alive: true, x: 2, y: 2 }],
    scene: { turn: 1, cells },
    mechanics: {
      death: { heroes: { 'dead-hero': { status: 'dead' } } },
      active_effects: [
        { id: 'dead-area-a', effect_id: 'dead-area-a', spell_id: 'dead-area-a', source_actor: 'caster', center: { x: 2, y: 2 }, radius_feet: 5, area_shape: 'sphere', trigger_on_turn_start: true, damage_amount: 1, damage_type: 'fire' },
        { id: 'dead-area-b', effect_id: 'dead-area-b', spell_id: 'dead-area-b', source_actor: 'caster', center: { x: 2, y: 2 }, radius_feet: 5, area_shape: 'sphere', trigger_on_turn_start: true, damage_amount: 1, damage_type: 'fire' },
      ],
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'dead-hero', total: 10 }],
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          'dead-hero': { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
  let rollId = 0
  const result = resolveCommand({ command_type: 'EndTurn', command_id: 'dead-area-guards', actor_id: 'caster', server_authoritative: true }, state, {
    diceService: new DiceService({ rng: new SequenceDiceRng(Array(50).fill(1)), idFactory: () => `dead-guards-${++rollId}`, now: () => '2026-09-19T12:00:00.000Z' }),
    context: { serverAuthoritativeCombat: true },
  })
  assert.equal(result.events.filter((event) => event.event_type === 'DamageApplied').length, 0)

  const enemyState = structuredClone(state)
  enemyState.players = enemyState.players.filter((actor) => actor.id !== 'dead-hero')
  enemyState.partyMemberIds = ['caster']
  delete enemyState.mechanics.death.heroes['dead-hero']
  enemyState.mechanics.combat.initiative = [{ actor_id: 'caster', total: 20 }, { actor_id: 'zero-enemy', total: 10 }]
  enemyState.mechanics.combat.action_economy['zero-enemy'] = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const enemyResult = resolveCommand({ command_type: 'EndTurn', command_id: 'dead-area-enemy', actor_id: 'caster', server_authoritative: true }, enemyState, {
    diceService: new DiceService({ rng: new SequenceDiceRng(Array(50).fill(1)), idFactory: () => `dead-enemy-${++rollId}`, now: () => '2026-09-19T12:00:00.000Z' }),
    context: { serverAuthoritativeCombat: true },
  })
  assert.equal(enemyResult.events.filter((event) => event.event_type === 'DamageApplied').length, 0)

  const dyingState = structuredClone(state)
  delete dyingState.mechanics.death.heroes['dead-hero']
  dyingState.players.find((actor) => actor.id === 'dead-hero').maxHp = 1
  dyingState.mechanics.death.saving_throws['dead-hero'] = { successes: 0, failures: 0, stable: true }
  dyingState.enemies = []
  dyingState.mechanics.combat.initiative = [{ actor_id: 'caster', total: 20 }, { actor_id: 'dead-hero', total: 10 }]
  const dyingResult = resolveCommand({ command_type: 'EndTurn', command_id: 'dead-area-transition', actor_id: 'caster', server_authoritative: true }, dyingState, {
    diceService: new DiceService({ rng: new SequenceDiceRng(Array(50).fill(1)), idFactory: () => `dead-transition-${++rollId}`, now: () => '2026-09-19T12:00:00.000Z' }),
    context: { serverAuthoritativeCombat: true },
  })
  assert.equal(dyingResult.events.filter((event) => event.event_type === 'DamageApplied').length, 1)
  assert.equal(dyingResult.events.filter((event) => event.event_type === 'HeroDied').length, 1)
  assert.equal(dyingResult.events.filter((event) => event.event_type === 'DeathSaveFailureRecorded').length, 0, 'massive damage from 0 HP is an immediate death')
})

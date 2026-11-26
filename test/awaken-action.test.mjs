import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { applyAll } from './kit/engine.mjs'

const dice = () => new DiceService({ rng: { randint: (min) => min }, idFactory: (() => { let n = 0; return () => `awaken-${++n}` })(), now: () => '2026-11-22T00:00:00.000Z' })

function stateFor({ targetX = 1, conditions = [], concentration = {} } = {}) {
  return normalizeCampaignState({
    sessionCode: 'AWAKEN-ACTION', ruleset_id: 'dnd_5e_2014', partyMemberIds: ['hero', 'ally'],
    players: [
      { id: 'hero', characterClass: 'fighter', level: 7, hp: 30, maxHp: 30, armor: 15, speed: 30, proficiency: 3, abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], x: 0, y: 0 },
      { id: 'ally', characterClass: 'wizard', level: 7, hp: 20, maxHp: 20, armor: 12, speed: 30, proficiency: 3, abilities: { str: 8, dex: 14, con: 12, int: 18, wis: 14, cha: 10 }, inventory: [], x: targetX, y: 0 },
    ],
    enemies: [], scene: { turn: 1, cells: Array.from({ length: 40 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10), type: 'floor', revealed: true })) },
    mechanics: { conditions: { ally: conditions }, concentration,
      combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'ally', total: 10 }], action_economy: {
        hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }, ally: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
      } }, resources: {} },
  })
}

function run(state, extra = {}) {
  return resolveCommand({ command_type: 'UseCombatAction', command_id: 'awaken-1', actor_id: 'hero', action_id: 'awaken', target_id: 'ally', target_ids: ['ally'], server_authoritative: true, ...extra }, state, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
}

test('Разбудить снимает Усыпление рядом, тратит действие и сходится после replay', () => {
  const initial = stateFor({ conditions: [
    { id: 'magical-sleep', effect_id: 'sleep-1', spell_id: 'sleep', source_actor: 'enemy' },
    { id: 'unconscious', effect_id: 'sleep-1', spell_id: 'sleep', source_actor: 'enemy' },
    { id: 'helped', source_actor: 'other' },
  ] })
  const result = run(initial, { wake_spell_id: 'sleep' })
  const after = result.events.reduce(applyGameEvent, initial)
  assert.equal(after.mechanics.conditions.ally.some(c => ['magical-sleep', 'unconscious'].includes(c.id)), false)
  assert.equal(after.mechanics.conditions.ally.some(c => c.id === 'helped'), true)
  assert.equal(after.mechanics.combat.action_economy.hero.action, false)
  assert.equal(result.events.find(e => e.event_type === 'CombatActionUsed')?.payload?.awakened_spell_id, 'sleep')
  assert.deepEqual(replayEvents(initial, result.events), after)
})

test('Разбудить снимает только свой Гипнотический узор и завершает концентрацию последнего эффекта', () => {
  const initial = stateFor({ concentration: { enemy: { effect_id: 'pattern-1' } }, conditions: [
    { id: 'charmed', effect_id: 'pattern-1', source_actor: 'enemy' },
    { id: 'incapacitated', effect_id: 'pattern-1', source_actor: 'enemy' },
    { id: 'charmed', effect_id: 'other-charm', source_actor: 'enemy' },
  ] })
  const result = run(initial, { wake_spell_id: 'hypnotic-pattern' })
  const after = result.events.reduce(applyGameEvent, initial)
  assert.equal(after.mechanics.conditions.ally.some(c => c.effect_id === 'pattern-1'), false)
  assert.deepEqual(after.mechanics.conditions.ally.map(c => c.effect_id), ['other-charm'])
  assert.equal(after.mechanics.concentration.enemy, undefined)
  assert.equal(result.events.filter(e => e.event_type === 'ConcentrationEnded').length, 1)
  assert.deepEqual(replayEvents(initial, result.events), after)
})

test('Разбудить оставляет Гипнотический узор на второй цели', () => {
  const conditions = ['charmed', 'incapacitated', 'speed-zero'].map(id => ({
    id, effect_id: 'pattern-1', source_actor: 'enemy', spell_id: 'hypnotic-pattern',
  }))
  const initial = stateFor({ concentration: { enemy: { effect_id: 'pattern-1' } }, conditions })
  initial.players.push({ ...initial.players[1], id: 'other', x: 0, y: 1 })
  initial.partyMemberIds.push('other')
  initial.mechanics.conditions.other = structuredClone(initial.mechanics.conditions.ally)
  const { events } = run(initial, { wake_spell_id: 'hypnotic-pattern' })
  const after = applyAll(initial, events)
  assert.ok(!events.some(event => event.event_type === 'ConcentrationEnded'))
  assert.equal(after.mechanics.conditions.ally?.length ?? 0, 0)
  assert.deepEqual(after.mechanics.conditions.other, initial.mechanics.conditions.other)
  assert.equal(after.mechanics.concentration.enemy.effect_id, 'pattern-1')
  assert.deepEqual(replayEvents(initial, events), after)
})

test('Разбудить требует цель рядом и выбранный эффект', () => {
  assert.throws(() => run(stateFor({ targetX: 3, conditions: [{ id: 'magical-sleep', effect_id: 's', spell_id: 'sleep' }] }), { wake_spell_id: 'sleep' }), error => error.code === 'TARGET_OUT_OF_RANGE')
  assert.throws(() => run(stateFor({ conditions: [{ id: 'charmed', effect_id: 'x', spell_id: 'charm-person' }] })), error => error.code === 'AWAKEN_TARGET_INVALID')
})

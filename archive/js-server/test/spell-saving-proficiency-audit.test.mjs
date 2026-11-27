import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `save-proficiency-${++id}`, now: () => '2026-09-19T12:00:00.000Z' })
}

function state({ targetClass = 'rogue', targetAbilities = { dex: 16, con: 14, wis: 10 }, targetProficiency = 3 } = {}) {
  const cells = Array.from({ length: 36 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'SPELL-SAVE-PROFICIENCY-AUDIT', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
    partyMemberIds: ['caster', 'target'],
    players: [
      { id: 'caster', character: 'Маг', characterClass: 'wizard', level: 5, hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3, abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 12, cha: 10 }, inventory: [materializeCatalogItem('srd_5_2_1:component-pouch', { id: 'caster-component-pouch', quantity: 1 })], x: 0, y: 5 },
      { id: 'target', character: 'Цель', characterClass: targetClass, level: 5, hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: targetProficiency, abilities: { str: 10, dex: 10, con: 10, wis: 10, ...targetAbilities }, inventory: [], x: 2, y: 0 },
    ],
    enemies: [{ id: 'enemy', name: 'Враг', hp: 30, maxHp: 30, armor: 12, speed: 30, abilities: { str: 10, dex: 10, con: 10, wis: 10, cha: 10 }, x: 4, y: 0, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      resources: { caster: { spell_slots_3: { current: 2, max: 2 } } },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'target', total: 10 }, { actor_id: 'enemy', total: 5 }],
        action_economy: Object.fromEntries(['caster', 'target', 'enemy'].map((id) => [id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])),
      },
    },
  })
}

const applyAll = (current, events) => events.reduce((next, event) => applyGameEvent(next, event), current)

test('spell area save adds hero proficiency once and keeps spell DC independent', () => {
  const initial = state()
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'fireball', to: { x: 2, y: 0 }, server_authoritative: true }, initial, {
    diceService: dice(Array.from({ length: 30 }, () => 1)), context: { serverAuthoritativeCombat: true },
  })
  const save = result.events.find((event) => event.event_type === 'SpellSavingThrowResolved' && event.target_ids.includes('target'))
  assert.equal(save?.payload.modifier, 6, 'DEX 16 + rogue proficiency 3')
  assert.equal(save?.payload.difficulty, 15, 'caster DC does not use target proficiency')
})

test('hero without the save proficiency keeps only the ability modifier', () => {
  const initial = state({ targetClass: 'cleric' })
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'fireball', to: { x: 2, y: 0 }, server_authoritative: true }, initial, {
    diceService: dice(Array.from({ length: 30 }, () => 1)), context: { serverAuthoritativeCombat: true },
  })
  const save = result.events.find((event) => event.event_type === 'SpellSavingThrowResolved' && event.target_ids.includes('target'))
  assert.equal(save?.payload.modifier, 3)
})

test('caller-provided modifier that already contains proficiency is not doubled', () => {
  const initial = state()
  const result = resolveCommand({ command_type: 'MakeSavingThrow', actor_id: 'target', ability: 'dex', modifier: 6, difficulty: 7 }, initial, {
    diceService: dice([1]), context: { isAdmin: true, serverAuthoritativeCombat: true },
  })
  const save = result.events.find((event) => event.event_type === 'SavingThrowResolved')
  assert.equal(save?.payload.modifier, 6)
  assert.equal(save?.payload.total, 7)
})

test('server-owned NPC explicit saving throw total wins over inferred proficiency', () => {
  const initial = state({ targetClass: 'wizard' })
  const npc = {
    id: 'npc', name: 'Авторский NPC', creature_type: 'humanoid', hp: 30, maxHp: 30, armor: 12, speed: 30,
    abilities: { dex: 16, con: 14, wis: 10 }, x: 2, y: 1, alive: true,
    stat_block_id: 'dnd_5e_2014:monster:audit-npc',
    provenance: { kind: 'server-owned-dnd-2014-stat-block', ruleset_id: 'dnd_5e_2014', stat_block_id: 'dnd_5e_2014:monster:audit-npc' },
    saving_throws: { dex: 5 },
  }
  initial.enemies.push(npc)
  initial.mechanics.positions.npc = { x: 2, y: 1 }
  initial.players.find((player) => player.id === 'target').x = 5
  initial.players.find((player) => player.id === 'target').y = 5
  initial.mechanics.positions.target = { x: 5, y: 5 }
  initial.mechanics.combat.initiative.push({ actor_id: 'npc', total: 4 })
  initial.mechanics.combat.action_economy.npc = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'fireball', to: { x: 2, y: 0 }, server_authoritative: true }, initial, {
    diceService: dice(Array.from({ length: 30 }, () => 1)), context: { serverAuthoritativeCombat: true },
  })
  const save = result.events.find((event) => event.event_type === 'SpellSavingThrowResolved' && event.target_ids.includes('npc'))
  assert.equal(save?.payload.modifier, 5)
})

test('repeat spell save and concentration save use the same hero base modifier once', () => {
  const initial = state()
  initial.mechanics.conditions.target = [{ id: 'enfeebled', effect_id: 'ray-of-enfeeblement:repeat', source_actor: 'caster', repeat_save_timing: 'turn-end', save_ability: 'con', save_dc: 1, spell_id: 'ray-of-enfeeblement' }]
  initial.mechanics.concentration.caster = { effect_id: 'ray-of-enfeeblement:repeat' }
  const afterCaster = applyAll(initial, resolveCommand({ command_type: 'EndTurn', actor_id: 'caster', server_authoritative: true }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } }).events)
  const repeated = resolveCommand({ command_type: 'EndTurn', actor_id: 'target', server_authoritative: true }, afterCaster, { diceService: dice([1]), context: { serverAuthoritativeCombat: true } })
  const repeatSave = repeated.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(repeatSave?.payload.modifier, 2, 'CON 14 without proficiency')

  const concentrationState = state()
  concentrationState.mechanics.concentration.target = { effect_id: 'spell:web' }
  const damage = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'target', amount: 1, damage_type: 'fire', server_authoritative: true }, concentrationState, { diceService: dice([1]), context: { serverAuthoritativeCombat: true } })
  const concentrationSave = damage.events.find((event) => event.event_type === 'ConcentrationSavingThrowResolved')
  assert.equal(concentrationSave?.payload.modifier, 2)
  assert.deepEqual(replayEvents(concentrationState, damage.events), applyAll(concentrationState, damage.events))
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `automatic-save-${++id}`,
    now: () => '2026-09-19T12:00:00.000Z',
  })
}

const applyAll = (state, events) => events.reduce((current, event) => applyGameEvent(current, event), state)
const authoritative = (command) => ({ ...command, server_authoritative: true })

function fireballState({ targetClass = 'rogue', targetLevel = 5, targetConditions = [], targetResources = {} } = {}) {
  const cells = Array.from({ length: 40 }, (_, index) => ({
    x: index % 8,
    y: Math.floor(index / 8),
    type: 'floor',
    revealed: true,
  }))
  return normalizeCampaignState({
    sessionCode: 'AUTOMATIC-SAVE-BONUS-AUDIT',
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
    partyMemberIds: ['caster', 'target'],
    players: [
      {
        id: 'caster', character: 'Маг', characterClass: 'wizard', level: 5,
        hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3,
        abilities: { int: 18, dex: 14, con: 14 },
        knownSpellIds: ['fireball'], preparedSpellIds: ['fireball'],
        inventory: [materializeCatalogItem('srd_5_2_1:component-pouch', { id: 'caster-component-pouch', quantity: 1 })], x: 0, y: 0,
      },
      {
        id: 'target', character: 'Цель', characterClass: targetClass, level: targetLevel,
        hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: targetLevel >= 5 ? 3 : 2,
        abilities: { str: 16, dex: 16, con: 14, wis: 10 },
        knownSpellIds: [], preparedSpellIds: [], inventory: [], x: 2, y: 0,
      },
    ],
    enemies: [],
    scene: { turn: 1, cells },
    mechanics: {
      conditions: { target: targetConditions },
      resources: {
        caster: { spell_slots_3: { current: 1, max: 1 } },
        target: targetResources,
      },
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
}

function castFireball(state, commandId = 'automatic-save-fireball') {
  return resolveCommand(authoritative({
    command_type: 'CastSpell',
    command_id: commandId,
    actor_id: 'caster',
    spell_id: 'fireball',
    to: { x: 2, y: 0 },
    slot_level: 3,
  }), state, {
    diceService: dice([1, ...Array(30).fill(1)]),
    context: { serverAuthoritativeCombat: true },
  })
}

test('automatic failure does not offer Resistance, spend Mind Sliver, Silvery Fortune or Indomitable', () => {
  const initial = fireballState({
    targetClass: 'fighter',
    targetLevel: 9,
    targetConditions: [
      { id: 'paralyzed', effect_id: 'paralyzed:audit' },
      { id: 'resistance-d4', effect_id: 'resistance:audit', source_actor: 'target' },
      { id: 'next-save-minus-d4', source_actor: 'caster' },
      { id: 'silvery-fortune', effect_id: 'fortune:audit', source_actor: 'caster' },
    ],
    targetResources: { indomitable: { current: 1, max: 1 } },
  })
  const result = castFireball(initial)
  const save = result.events.find((event) => event.event_type === 'SpellSavingThrowResolved' && event.target_ids.includes('target'))
  assert.equal(save?.payload.auto_failed, true)
  assert.equal(result.events.some((event) => event.event_type === 'ReactionWindowOpened'), false)
  assert.equal(result.events.some((event) => event.event_type === 'DieRolled' && event.payload.modifier_source === 'resistance'), false)
  assert.equal(result.events.some((event) => event.event_type === 'ConditionRemoved' && event.target_ids.includes('target')
    && ['next-save-minus-d4', 'silvery-fortune'].includes(event.payload.condition)), false)
  const after = applyAll(initial, result.events)
  assert.ok(after.mechanics.conditions.target.some((condition) => condition.id === 'resistance-d4'))
  assert.ok(after.mechanics.conditions.target.some((condition) => condition.id === 'next-save-minus-d4'))
  assert.ok(after.mechanics.conditions.target.some((condition) => condition.id === 'silvery-fortune'))
  assert.equal(after.mechanics.resources.target.indomitable.current, 1)
})

function repeatSaveState({ trigger = 'turn-end' } = {}) {
  const cells = Array.from({ length: 24 }, (_, index) => ({
    x: index % 8,
    y: Math.floor(index / 8),
    type: 'floor',
    revealed: true,
  }))
  const condition = {
    id: 'blinded', effect_id: 'blindness:audit', source_actor: 'caster', duration: 'concentration',
    repeat_save_timing: 'turn-end', save_ability: 'con', save_dc: 1, spell_id: 'blindness-deafness',
  }
  if (trigger === 'turn-start') {
    condition.id = 'frightened'
    condition.repeat_save_timing = null
    condition.start_turn_save = 'wis'
    condition.save_ability = null
    condition.save_dc = 30
    condition.recurring_damage = '1d4'
    condition.recurring_damage_type = 'psychic'
    condition.spell_id = 'phantasmal-killer'
  }
  return normalizeCampaignState({
    sessionCode: `SILVERY-REPEAT-${trigger}`,
    partyMemberIds: ['target', 'caster'],
    players: [
      { id: 'target', character: 'Цель', characterClass: 'fighter', level: 5, hp: 20, maxHp: 20, armor: 12, speed: 30, proficiency: 3, abilities: { con: 14, wis: 10 }, inventory: [], x: 1, y: 1 },
      { id: 'caster', character: 'Маг', characterClass: 'wizard', level: 5, hp: 20, maxHp: 20, armor: 12, speed: 30, proficiency: 3, abilities: { int: 16, wis: 10 }, inventory: [], x: 2, y: 1 },
    ],
    enemies: [],
    scene: { turn: 1, cells },
    mechanics: {
      conditions: {
        target: [
          condition,
          { id: 'silvery-fortune', effect_id: 'fortune:repeat', source_actor: 'caster' },
          { id: 'silvery-fortune', source_actor: 'legacy' },
        ],
      },
      concentration: { caster: { effect_id: 'blindness:audit' } },
      combat: {
        active: true,
        round: 1,
        active_index: trigger === 'turn-end' ? 0 : 1,
        initiative: [{ actor_id: 'target', total: 20 }, { actor_id: 'caster', total: 10 }],
        action_economy: {
          target: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

test('turn-end repeat save consumes only the selected Silvery Fortune instance', () => {
  const initial = repeatSaveState()
  const result = resolveCommand(authoritative({ command_type: 'EndTurn', command_id: 'silvery-repeat-end', actor_id: 'target' }), initial, {
    diceService: dice([20, 20]),
    context: { serverAuthoritativeCombat: true },
  })
  const removed = result.events.filter((event) => event.event_type === 'ConditionRemoved' && event.payload.condition === 'silvery-fortune')
  assert.equal(removed.length, 1)
  assert.equal(removed[0].payload.effect_id, 'fortune:repeat')
  const after = applyAll(initial, result.events)
  assert.equal(after.mechanics.conditions.target.some((condition) => condition.effect_id === 'fortune:repeat'), false)
  assert.equal(after.mechanics.conditions.target.some((condition) => condition.source_actor === 'legacy'), true)
  assert.deepEqual(replayEvents(initial, result.events), after)
})

test('turn-start recurring save consumes Silvery Fortune once and keeps legacy instance', () => {
  const initial = repeatSaveState({ trigger: 'turn-start' })
  const result = resolveCommand(authoritative({ command_type: 'EndTurn', command_id: 'silvery-repeat-start', actor_id: 'caster' }), initial, {
    diceService: dice([1, 20, 1, 1]),
    context: { serverAuthoritativeCombat: true },
  })
  const save = result.events.find((event) => event.event_type === 'SpellSavingThrowResolved' && event.payload.trigger === 'turn-start')
  assert.ok(save)
  const removed = result.events.filter((event) => event.event_type === 'ConditionRemoved' && event.payload.condition === 'silvery-fortune')
  assert.equal(removed.length, 1)
  assert.equal(removed[0].payload.effect_id, 'fortune:repeat')
  const after = applyAll(initial, result.events)
  assert.equal(after.mechanics.conditions.target.some((condition) => condition.effect_id === 'fortune:repeat'), false)
  assert.equal(after.mechanics.conditions.target.some((condition) => condition.source_actor === 'legacy'), true)
  assert.deepEqual(replayEvents(initial, result.events), after)
})

function mindSliverSaveState(kind) {
  const cells = Array.from({ length: 36 }, (_, index) => ({
    x: index % 6,
    y: Math.floor(index / 6),
    type: 'floor',
    revealed: true,
  }))
  const nextSave = { id: 'next-save-minus-d4', effect_id: 'mind-sliver:audit', source_actor: 'caster' }
  const conditions = { target: [nextSave] }
  const activeEffects = []
  if (kind === 'entry' || kind === 'start') {
    activeEffects.push({
      id: `area:${kind}:audit`,
      effect_id: `area:${kind}:audit`,
      spell_id: 'area-audit',
      source_actor: 'caster',
      center: { x: 2, y: 2 },
      radius_feet: 5,
      area_shape: 'sphere',
      save_ability: 'con',
      save_dc: 5,
      trigger_on_enter: kind === 'entry',
      trigger_on_turn_start: kind === 'start',
    })
  } else {
    conditions.target.push({
      id: 'blinded', effect_id: 'repeat:audit', source_actor: 'caster', duration: 'concentration',
      repeat_save_timing: 'turn-end', save_ability: 'con', save_dc: 5, spell_id: 'blindness-deafness',
    })
  }
  return normalizeCampaignState({
    sessionCode: `MIND-SLIVER-${kind}`,
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
    partyMemberIds: ['caster', 'target'],
    players: [
      { id: 'caster', character: 'Маг', characterClass: 'wizard', level: 5, hp: 20, maxHp: 20, armor: 12, speed: 30, proficiency: 3, abilities: { int: 16, con: 14 }, inventory: [], x: 0, y: 0 },
      { id: 'target', character: 'Цель', characterClass: 'wizard', level: 1, hp: 20, maxHp: 20, armor: 12, speed: 30, proficiency: 2, abilities: { int: 10, con: 10 }, inventory: [], x: kind === 'entry' ? 0 : 2, y: 2 },
    ],
    enemies: [],
    scene: { turn: 1, cells },
    mechanics: {
      conditions,
      active_effects: activeEffects,
      combat: {
        active: true,
        round: 1,
        active_index: kind === 'start' ? 0 : 1,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'target', total: 10 }],
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          target: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function resolveMindSliverPath(kind) {
  const initial = mindSliverSaveState(kind)
  const command = kind === 'entry'
    ? authoritative({ command_type: 'MoveActor', command_id: 'mind-sliver-entry', actor_id: 'target', to: { x: 2, y: 2 } })
    : authoritative({ command_type: 'EndTurn', command_id: `mind-sliver-${kind}`, actor_id: kind === 'start' ? 'caster' : 'target' })
  const result = resolveCommand(command, initial, {
    diceService: dice([1, 5]),
    context: { serverAuthoritativeCombat: true },
  })
  const save = result.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  const removed = result.events.find((event) => event.event_type === 'ConditionRemoved' && event.payload.condition === 'next-save-minus-d4')
  return { initial, result, save, removed }
}

for (const kind of ['entry', 'start', 'repeat']) {
  test(`Mind Sliver modifier is applied once in ${kind} save and removes its exact effect`, () => {
    const { initial, result, save, removed } = resolveMindSliverPath(kind)
    assert.equal(save?.payload.modifier, -1)
    assert.equal(save?.payload.total, 4)
    assert.equal(save?.payload.saved, false)
    assert.equal(result.events.filter((event) => event.event_type === 'DieRolled' && event.payload.purpose === 'spell:mind-sliver').length, 1)
    assert.equal(removed?.payload.effect_id, 'mind-sliver:audit')
    const after = applyAll(initial, result.events)
    assert.equal(after.mechanics.conditions.target.some((condition) => condition.id === 'next-save-minus-d4'), false)
    assert.deepEqual(replayEvents(initial, result.events), after)
  })
}

test('Mind Sliver modifier transcript survives a Resistance choice before the area save', () => {
  const initial = mindSliverSaveState('start')
  initial.mechanics.conditions.target.push({ id: 'resistance-d4', effect_id: 'resistance:mind-sliver', source_actor: 'target' })
  const paused = resolveCommand(authoritative({ command_type: 'EndTurn', command_id: 'mind-sliver-resistance', actor_id: 'caster' }), initial, {
    diceService: dice([1, 5]),
    context: { serverAuthoritativeCombat: true },
  })
  const window = paused.events.find((event) => event.event_type === 'ReactionWindowOpened')
  assert.equal(window?.payload.trigger, 'saving-throw-bonus-choice')
  assert.ok(window?.payload.pending_dice_transcript?.some((entry) => entry.result?.purpose === 'spell:mind-sliver'))

  const waiting = applyAll(initial, paused.events)
  const resumed = resolveCommand(authoritative({
    command_type: 'UseCombatAction', command_id: 'mind-sliver-resistance-skip', actor_id: 'target', action_id: 'skip-resistance',
  }), waiting, {
    // The pending transcript already contains Mind Sliver's d4; the resumed
    // service only supplies the not-yet-rolled d20.
    diceService: dice([5]),
    context: { serverAuthoritativeCombat: true },
  })
  const save = resumed.events.find((event) => event.event_type === 'SpellSavingThrowResolved' && event.target_ids.includes('target'))
  assert.equal(save?.payload.modifier, -1)
  assert.equal(save?.payload.total, 4)
  assert.equal(resumed.events.filter((event) => event.event_type === 'DieRolled' && event.payload.purpose === 'spell:mind-sliver').length, 1)
  assert.equal(resumed.events.find((event) => event.event_type === 'ConditionRemoved' && event.payload.condition === 'next-save-minus-d4')?.payload.effect_id, 'mind-sliver:audit')
})

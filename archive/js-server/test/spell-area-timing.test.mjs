import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `spell-area-timing-${++id}`,
    now: () => '2026-09-19T12:00:00.000Z',
  })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

function stateFor({
  rulesetId,
  targetKind = 'enemy',
  targetId = 'target',
  target = {},
  targetConcentration = null,
  targetConditions = [],
} = {}) {
  const cells = Array.from({ length: 100 }, (_, index) => ({
    x: index % 10,
    y: Math.floor(index / 10),
    type: 'floor',
    revealed: true,
  }))
  const mage = {
    id: 'mage',
    character: 'Маг',
    characterClass: 'wizard',
    level: 9,
    hp: 50,
    maxHp: 50,
    armor: 13,
    speed: 30,
    proficiency: 4,
    abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 12, cha: 10 },
    inventory: rulesetId === 'dnd_5e_2014'
      ? [materializeCatalogItem('srd_5_2_1:component-pouch', { id: 'component-pouch', quantity: 1 })]
      : [],
    x: 1,
    y: 1,
  }
  const targetActor = {
    id: targetId,
    character: targetKind === 'player' ? 'Концентратор' : undefined,
    characterClass: targetKind === 'player' ? 'wizard' : undefined,
    level: 9,
    hp: 40,
    maxHp: 40,
    armor: 13,
    speed: 30,
    proficiency: 4,
    abilities: { str: 10, dex: 10, con: 10, int: 12, wis: 10, cha: 10 },
    inventory: [],
    x: 5,
    y: 1,
    alive: true,
    ...(targetKind === 'enemy' ? { name: 'Цель', creature_type: 'humanoid' } : {}),
    ...target,
  }
  const players = targetKind === 'player' ? [mage, targetActor] : [mage]
  const enemies = targetKind === 'player' ? [] : [targetActor]
  const ids = ['mage', targetId]
  const actionEconomy = Object.fromEntries(ids.map((id) => [id, {
    action: true,
    bonus_action: true,
    reaction: true,
    movement: true,
    movement_spent: 0,
  }]))
  return normalizeCampaignState({
    sessionCode: 'SPELL-AREA-TIMING',
    ...(rulesetId ? { ruleset_id: rulesetId } : {}),
    partyMemberIds: targetKind === 'player' ? ['mage', targetId] : ['mage'],
    players,
    enemies,
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: ids.map((actor_id, index) => ({ actor_id, total: 20 - index })),
        action_economy: actionEconomy,
      },
      conditions: targetConditions.length ? { [targetId]: targetConditions } : {},
      ...(targetConcentration ? { concentration: { [targetId]: targetConcentration } } : {}),
    },
  })
}

function cast(state, spellId, commandId = `${spellId}-cast`) {
  return resolveCommand(authoritative({
    command_type: 'CastSpell',
    command_id: commandId,
    actor_id: 'mage',
    spell_id: spellId,
    to: { x: 5, y: 1 },
  }), state, options(dice()))
}

function advanceToTarget(state, values) {
  return resolveCommand(authoritative({
    command_type: 'EndTurn',
    command_id: 'advance-to-target',
    actor_id: 'mage',
  }), state, options(dice(values)))
}

function applyAll(state, events) {
  return events.reduce((current, event) => applyGameEvent(current, event), state)
}

test('Зловонное облако проверяет начало хода, лишает действие и повторяется после спасения', () => {
  const state = stateFor({
    targetKind: 'player',
    targetConcentration: { effect_id: 'moonbeam:target' },
  })
  const castResult = cast(state, 'stinking-cloud', 'stinking-cast')
  assert.equal(castResult.events.some((event) => event.event_type === 'SpellSavingThrowResolved'), false)
  assert.equal(castResult.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'incapacitated'), false)
  const area = castResult.events.find((event) => event.event_type === 'SpellAreaCreated')
  assert.equal(area.payload.effect.trigger_on_turn_start, true)
  assert.equal(area.payload.effect.trigger_on_turn_end, false)
  assert.equal(area.payload.effect.requires_full_footprint, true)

  const castState = replayEvents(state, castResult.events)
  const first = advanceToTarget(castState, [1])
  const firstSave = first.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(firstSave.payload.trigger, 'turn-start')
  assert.equal(firstSave.payload.saved, false)
  const lostAction = first.events.find((event) => event.event_type === 'CombatActionUsed'
    && event.payload.normal_action_only === true
    && event.target_ids.includes('target'))
  assert.ok(lostAction)
  assert.equal(first.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'incapacitated'), false)
  const firstState = replayEvents(castState, first.events)
  assert.equal(firstState.mechanics.combat.action_economy.target.action, false)
  assert.equal(firstState.mechanics.combat.action_economy.target.bonus_action, true)
  assert.equal(firstState.mechanics.combat.action_economy.target.reaction, true)
  assert.equal(firstState.mechanics.concentration.target.effect_id, 'moonbeam:target')
  assert.throws(
    () => resolveCommand(authoritative({ command_type: 'MakeAttack', actor_id: 'target', target_id: 'mage', item_id: 'sword' }), firstState, options(dice())),
    { code: 'ACTION_SPENT' },
  )

  const moved = resolveCommand(authoritative({ command_type: 'MoveActor', actor_id: 'target', to: { x: 6, y: 1 } }), firstState, options(dice()))
  const movedState = replayEvents(firstState, moved.events)
  assert.ok(moved.events.some((event) => event.event_type === 'ActorMoved'))
  const bonus = resolveCommand(authoritative({ command_type: 'CastSpell', actor_id: 'target', spell_id: 'misty-step', to: { x: 7, y: 1 } }), movedState, options(dice()))
  const afterBonus = replayEvents(movedState, bonus.events)
  assert.ok(bonus.events.some((event) => event.event_type === 'ActorMoved' && event.payload.teleport === true))
  assert.equal(afterBonus.mechanics.combat.action_economy.target.action, false)
  assert.equal(afterBonus.mechanics.combat.action_economy.target.bonus_action, false)
  assert.equal(afterBonus.mechanics.combat.action_economy.target.reaction, true)
  assert.equal(afterBonus.mechanics.concentration.target.effect_id, 'moonbeam:target')

  const targetEnd = resolveCommand(authoritative({ command_type: 'EndTurn', command_id: 'target-end', actor_id: 'target' }), afterBonus, options(dice([20])))
  assert.equal(targetEnd.events.some((event) => event.event_type === 'SpellSavingThrowResolved'
    && event.payload.spell_id === 'stinking-cloud'
    && event.target_ids.includes('target')), false)
  const mageState = replayEvents(afterBonus, targetEnd.events)
  const second = advanceToTarget(mageState, [20])
  const secondSave = second.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(secondSave.payload.trigger, 'turn-start')
  assert.equal(secondSave.payload.saved, true)
  assert.equal(second.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'incapacitated'), false)
  assert.equal(replayEvents(mageState, second.events).mechanics.conditions.target?.some((condition) => condition.id === 'incapacitated'), false)
})

test('Зловонное облако автоматически пропускает яд для иммунного и не дышащего существа', () => {
  for (const [label, target, reason] of [
    ['poison immunity', { damage_immunities: ['poison'] }, 'poison'],
    ['no breathing', { cannot_breathe: true }, 'no-breathing'],
  ]) {
    const state = stateFor({ target })
    const castResult = cast(state, 'stinking-cloud', `stinking-${label}`)
    const castState = replayEvents(state, castResult.events)
    const started = advanceToTarget(castState, [1])
    const save = started.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
    assert.equal(save.payload.saved, true, label)
    assert.equal(save.payload.automatic_success, true, label)
    assert.equal(save.payload.immunity, reason, label)
    assert.equal(started.rolls.length, 0, `${label}: auto-success не должен бросать d20 или тратить Bless/Bane`)
    assert.equal(started.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'incapacitated'), false, label)
  }
})

test('провал Зловонного облака не удаляет уже существующую недееспособность', () => {
  const state = stateFor({
    targetKind: 'player',
    targetConditions: [{ id: 'incapacitated', effect_id: 'other-effect' }],
  })
  const castResult = cast(state, 'stinking-cloud', 'stinking-existing-condition')
  const started = advanceToTarget(replayEvents(state, castResult.events), [1])
  const after = replayEvents(replayEvents(state, castResult.events), started.events)
  assert.ok(after.mechanics.conditions.target.some((condition) => condition.id === 'incapacitated'
    && condition.effect_id === 'other-effect'))
  assert.equal(started.events.filter((event) => event.event_type === 'ConditionRemoved' && event.target_ids.includes('target')).length, 0)
})

test('Метель проверяет Ловкость в начале хода, а концентрацию только у концентрирующейся цели', () => {
  const noConcentration = stateFor({ targetKind: 'player' })
  const castResult = cast(noConcentration, 'sleet-storm', 'sleet-no-concentration')
  assert.equal(castResult.events.some((event) => event.event_type === 'SpellSavingThrowResolved'), false)
  const started = advanceToTarget(replayEvents(noConcentration, castResult.events), [1])
  assert.equal(started.events.filter((event) => event.event_type === 'SpellSavingThrowResolved').length, 1)
  assert.equal(started.events.some((event) => event.event_type === 'ConcentrationSavingThrowResolved'), false)
  assert.equal(started.events.some((event) => event.event_type === 'ConcentrationEnded'), false)

  const concentrationState = stateFor({
    targetKind: 'player',
    targetConcentration: { effect_id: 'moonbeam:old' },
  })
  concentrationState.mechanics.active_effects = [{
    id: 'moonbeam:old',
    effect_id: 'moonbeam:old',
    spell_id: 'moonbeam',
    source_actor: 'target',
  }]
  const sleet = cast(concentrationState, 'sleet-storm', 'sleet-concentration')
  const afterCast = replayEvents(concentrationState, sleet.events)
  const turn = advanceToTarget(afterCast, [1, 1])
  const concentrationSave = turn.events.find((event) => event.event_type === 'ConcentrationSavingThrowResolved')
  assert.ok(concentrationSave)
  assert.equal(concentrationSave.payload.trigger, 'turn-start')
  assert.equal(concentrationSave.payload.difficulty, 16)
  assert.equal(concentrationSave.payload.saved, false)
  const ended = turn.events.find((event) => event.event_type === 'ConcentrationEnded' && event.target_ids.includes('target'))
  assert.equal(ended.payload.reason, 'sleet-storm')
  const after = replayEvents(afterCast, turn.events)
  assert.equal(after.mechanics.concentration.target, undefined)
  assert.equal(after.mechanics.active_effects.some((effect) => effect.effect_id === 'moonbeam:old'), false)
})

test('Спасбросок концентрации Метели учитывает Боевого заклинателя, но не расходует Resistance', () => {
  const state = stateFor({
    targetKind: 'player',
    target: {
      creationBenefits: { static: { concentration_save_advantage: true } },
    },
    targetConditions: [{ id: 'resistance-d4' }],
    targetConcentration: { effect_id: 'moonbeam:old' },
  })
  state.mechanics.active_effects = [{ id: 'moonbeam:old', effect_id: 'moonbeam:old', spell_id: 'moonbeam', source_actor: 'target' }]
  const sleet = cast(state, 'sleet-storm', 'sleet-war-caster')
  const afterCast = replayEvents(state, sleet.events)
  const started = resolveCommand(authoritative({ command_type: 'EndTurn', command_id: 'war-caster-start', actor_id: 'mage' }), afterCast, options(dice([1, 1, 20])))
  const save = started.events.find((event) => event.event_type === 'ConcentrationSavingThrowResolved')
  assert.equal(save.payload.saved, true)
  assert.equal(save.payload.war_caster, true)
  assert.equal(started.rolls.some((roll) => String(roll.purpose).includes('resistance')), false)
  const after = replayEvents(afterCast, started.events)
  assert.ok(after.mechanics.conditions.target?.some((condition) => condition.id === 'resistance-d4'))
  assert.equal(started.events.some((event) => event.event_type === 'ConcentrationEnded'), false)
})

test('в редакции 2014 War Caster не даёт преимущество на особый спасбросок Метели', () => {
  // PHB 2014 формулирует War Caster как преимущество на спасброски для
  // концентрации после получения урона; сама Метель урона не наносит.
  const state = stateFor({
    rulesetId: 'dnd_5e_2014',
    targetKind: 'player',
    target: {
      creationBenefits: { static: { concentration_save_advantage: true } },
    },
    targetConcentration: { effect_id: 'moonbeam:2014' },
  })
  state.mechanics.active_effects = [{ id: 'moonbeam:2014', effect_id: 'moonbeam:2014', spell_id: 'moonbeam', source_actor: 'target' }]
  const sleet = cast(state, 'sleet-storm', 'sleet-war-caster-2014')
  const afterCast = replayEvents(state, sleet.events)
  const started = resolveCommand(authoritative({ command_type: 'EndTurn', command_id: 'war-caster-2014-start', actor_id: 'mage' }), afterCast, options(dice([1, 1])))
  const save = started.events.find((event) => event.event_type === 'ConcentrationSavingThrowResolved')
  assert.equal(save.payload.saved, false)
  assert.equal(save.payload.war_caster, undefined)
  assert.ok(started.events.some((event) => event.event_type === 'ConcentrationEnded'))
})

test('области начала хода сохраняют ресурсный commit и совпадают после повторного расчёта и replay', () => {
  const state = stateFor()
  const first = cast(state, 'stinking-cloud', 'idempotent-stinking')
  const second = cast(state, 'stinking-cloud', 'idempotent-stinking')
  assert.equal(first.events.filter((event) => event.event_type === 'ResourceSpent').length, 1)
  assert.deepEqual(second.events, first.events)
  const castState = replayEvents(state, first.events)
  const turn = advanceToTarget(castState, [1])
  const after = replayEvents(castState, turn.events)
  assert.deepEqual(after, applyAll(castState, turn.events))
  assert.equal(turn.events.some((event) => event.event_type === 'ResourceSpent'), false)
})

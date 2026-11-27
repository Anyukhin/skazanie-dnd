import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function state() {
  const cells = Array.from({ length: 64 }, (_, index) => ({
    x: index % 8,
    y: Math.floor(index / 8),
    type: 'floor',
    revealed: true,
  }))
  return normalizeCampaignState({
    sessionCode: 'ABSORB-AREA-AUDIT',
    partyMemberIds: ['caster', 'target'],
    players: [
      {
        id: 'caster', character: 'Маг', characterClass: 'wizard', level: 5,
        hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3,
        abilities: { int: 18, dex: 14, con: 14 }, inventory: [],
        knownSpellIds: ['fireball'], preparedSpellIds: ['fireball'], x: 1, y: 1,
      },
      {
        id: 'target', character: 'Цель', characterClass: 'wizard', level: 5,
        hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3,
        abilities: { int: 18, dex: 14, con: 14 }, inventory: [],
        knownSpellIds: ['absorb-elements'], preparedSpellIds: ['absorb-elements'], x: 3, y: 1,
      },
    ],
    enemies: [],
    scene: { turn: 1, cells },
    mechanics: {
      resources: {
        caster: { spell_slots_3: { current: 1, max: 1 } },
        target: { spell_slots_1: { current: 1, max: 1 } },
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

const applyAll = (stateValue, events) => events.reduce((current, event) => applyGameEvent(current, event), stateValue)

function fireballCommand(commandId = 'area-fireball') {
  return {
    command_type: 'CastSpell',
    command_id: commandId,
    actor_id: 'caster',
    spell_id: 'fireball',
    to: { x: 3, y: 1 },
    slot_level: 3,
    server_authoritative: true,
  }
}

function dice(values = Array(100).fill(1)) {
  let rollId = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `absorb-area-${++rollId}`,
    now: () => '2026-09-19T12:00:00.000Z',
  })
}

function wallState() {
  const cells = Array.from({ length: 96 }, (_, index) => ({ x: index % 12, y: Math.floor(index / 12), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'ABSORB-WALL-AUDIT',
    partyMemberIds: ['caster', 'target'],
    players: [
      { id: 'caster', character: 'Маг', characterClass: 'wizard', level: 9, hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 4, abilities: { dex: 14, con: 14, int: 18 }, inventory: [], knownSpellIds: ['wall-of-fire'], preparedSpellIds: ['wall-of-fire'], x: 1, y: 1 },
      { id: 'target', character: 'Цель', characterClass: 'wizard', level: 5, hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3, abilities: { dex: 14, con: 14, int: 18 }, inventory: [], knownSpellIds: ['absorb-elements'], preparedSpellIds: ['absorb-elements'], x: 4, y: 1 },
    ],
    enemies: [],
    scene: { turn: 1, cells },
    mechanics: {
      resources: { caster: { spell_slots_4: { current: 1, max: 1 } }, target: { spell_slots_1: { current: 1, max: 1 } } },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'target', total: 10 }],
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          target: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

test('Absorb Elements должен открывать реакцию после elemental area damage', () => {
  const initial = state()
  const result = resolveCommand(fireballCommand(), initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const after = replayEvents(initial, result.events)
  const window = after.mechanics.combat.reaction_window
  assert.ok(window, 'после elemental area damage должно открыться reaction window')
  assert.ok(window.action_ids.includes('cast:absorb-elements'))
})

test('Absorb Elements resumes lethal-preventing Fireball before zero HP and replay is stable', () => {
  const initial = state()
  initial.players.find((actor) => actor.id === 'target').hp = 6
  const first = resolveCommand(fireballCommand('area-fireball-lethal'), initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const waiting = applyAll(initial, first.events)
  assert.equal(waiting.players.find((actor) => actor.id === 'target').hp, 6)
  assert.ok(waiting.mechanics.combat.reaction_window.pending_command)
  const accepted = resolveCommand({ command_type: 'UseCombatAction', command_id: 'absorb-lethal', actor_id: 'target', action_id: 'cast:absorb-elements', server_authoritative: true }, waiting, {
    diceService: dice(), context: { serverAuthoritativeCombat: true },
  })
  const final = applyAll(waiting, accepted.events)
  const damage = accepted.events.find((event) => event.event_type === 'DamageApplied' && event.target_ids.includes('target'))
  assert.equal(damage.payload.absorb_elements_prevented, 4)
  assert.equal(damage.payload.hp_after, 2)
  assert.equal(accepted.events.some((event) => event.event_type === 'HitPointsReducedToZero'), false)
  assert.equal(final.players.find((actor) => actor.id === 'target').hp, 2)
  assert.equal(final.mechanics.combat.reaction_window, null)
  assert.deepEqual(replayEvents(waiting, accepted.events), final)
  const acceptedAgain = resolveCommand({ command_type: 'UseCombatAction', command_id: 'absorb-lethal', actor_id: 'target', action_id: 'cast:absorb-elements', server_authoritative: true }, waiting, {
    diceService: dice(), context: { serverAuthoritativeCombat: true },
  })
  assert.deepEqual(acceptedAgain.events, accepted.events)
  assert.throws(() => resolveCommand({ command_type: 'UseCombatAction', command_id: 'absorb-lethal', actor_id: 'target', action_id: 'cast:absorb-elements', server_authoritative: true }, final, {
    diceService: dice(), context: { serverAuthoritativeCombat: true },
  }), (error) => ['REACTION_NOT_AVAILABLE', 'OUT_OF_TURN'].includes(error?.code))
})

test('successful save and resistance still open Absorb Elements with actual reduced damage', () => {
  const initial = state()
  initial.mechanics.defenses = { target: { resistances: ['fire'] } }
  const values = [...Array(8).fill(1), 20, 20]
  const first = resolveCommand(fireballCommand('area-fireball-save'), initial, { diceService: dice(values), context: { serverAuthoritativeCombat: true } })
  const waiting = applyAll(initial, first.events)
  assert.ok(waiting.mechanics.combat.reaction_window.action_ids.includes('cast:absorb-elements'))
  const accepted = resolveCommand({ command_type: 'UseCombatAction', command_id: 'absorb-save', actor_id: 'target', action_id: 'cast:absorb-elements', server_authoritative: true }, waiting, {
    diceService: dice(values), context: { serverAuthoritativeCombat: true },
  })
  const damage = accepted.events.find((event) => event.event_type === 'DamageApplied' && event.target_ids.includes('target'))
  assert.equal(damage.payload.saved, true)
  assert.equal(damage.payload.resistant, true)
  assert.equal(damage.payload.applied_amount, 2, '8 урона: успешный save → 4, единственное сопротивление → 2')
  assert.equal(damage.payload.absorb_elements_prevented, 0, 'два сопротивления огню не складываются')
})

test('несколько владельцев получают последовательные окна без двойного расхода', () => {
  const initial = state()
  initial.mechanics.resources.target.spell_slots_1 = { current: 4, max: 4 }
  const second = {
    id: 'target-two', character: 'Вторая цель', characterClass: 'wizard', level: 5,
    hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3,
    abilities: { int: 18, dex: 14, con: 14 }, inventory: [], x: 4, y: 1,
    knownSpellIds: ['absorb-elements'], preparedSpellIds: ['absorb-elements'],
  }
  initial.players.push(second)
  initial.partyMemberIds.push('target-two')
  initial.mechanics.resources['target-two'] = { spell_slots_1: { current: 4, max: 4 } }
  initial.mechanics.combat.action_economy['target-two'] = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  initial.mechanics.combat.initiative.push({ actor_id: 'target-two', total: 5 })
  const first = resolveCommand(fireballCommand('area-fireball-two'), initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const waiting = applyAll(initial, first.events)
  assert.equal(waiting.mechanics.combat.reaction_window.actor_id, 'target')
  const firstAccepted = resolveCommand({ command_type: 'UseCombatAction', command_id: 'absorb-first', actor_id: 'target', action_id: 'cast:absorb-elements', server_authoritative: true }, waiting, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const secondWaiting = applyAll(waiting, firstAccepted.events)
  assert.equal(secondWaiting.mechanics.combat.reaction_window.actor_id, 'target-two')
  const secondAccepted = resolveCommand({ command_type: 'UseCombatAction', command_id: 'absorb-second', actor_id: 'target-two', action_id: 'cast:absorb-elements', server_authoritative: true }, secondWaiting, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const final = applyAll(secondWaiting, secondAccepted.events)
  assert.equal(final.mechanics.combat.reaction_window, null)
  assert.equal(final.mechanics.combat.action_economy.target.reaction, false)
  assert.equal(final.mechanics.combat.action_economy['target-two'].reaction, false)
  assert.equal(final.mechanics.resources.target.spell_slots_1.current, 3)
  assert.equal(final.mechanics.resources['target-two'].spell_slots_1.current, 3)
})

test('immunity/zero damage does not create an Absorb Elements window and decline resumes original damage', () => {
  const immune = state()
  immune.mechanics.defenses = { target: { immunities: ['fire'] } }
  const immuneResult = resolveCommand(fireballCommand('area-fireball-immune'), immune, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  assert.equal(applyAll(immune, immuneResult.events).mechanics.combat.reaction_window, null)
  const initial = state()
  const first = resolveCommand(fireballCommand('area-fireball-decline'), initial, { diceService: dice(), context: { serverAuthoritativeCombat: true } })
  const waiting = applyAll(initial, first.events)
  const declined = resolveCommand({ command_type: 'UseCombatAction', command_id: 'absorb-decline', actor_id: 'target', action_id: 'decline-reaction', auto_skip_reason: 'turn-timeout', server_authoritative: true }, waiting, {
    diceService: dice(), context: { serverAuthoritativeCombat: true },
  })
  const after = applyAll(waiting, declined.events)
  assert.equal(after.mechanics.combat.reaction_window, null)
  assert.equal(after.players.find((actor) => actor.id === 'target').hp, 22)
  assert.equal(after.mechanics.combat.action_economy.target.reaction, true)
})

test('Поглощение стихий недоступно парализованной и умирающей цели', () => {
  for (const downed of [false, true]) {
    const initial = state()
    initial.mechanics.conditions.target = [{ id: downed ? 'unconscious' : 'paralyzed' }]
    if (downed) initial.players.find((actor) => actor.id === 'target').hp = 0
    const result = resolveCommand(fireballCommand(`no-incapacitated-reaction-${downed}`), initial, {
      diceService: dice(Array(100).fill(1)), context: { serverAuthoritativeCombat: true },
    })
    assert.equal(result.events.some((event) => event.event_type === 'ReactionWindowOpened'), false)
    assert.ok(result.events.some((event) => event.event_type === 'DamageApplied' && event.target_ids.includes('target')))
    if (downed) assert.ok(result.events.some((event) => event.event_type === 'DeathSaveFailureRecorded' && event.target_ids.includes('target')))
  }
})

test('Wall of Fire area entry pauses before damage for Absorb Elements', () => {
  const initial = wallState()
  const wallCast = resolveCommand({ command_type: 'CastSpell', command_id: 'wall-entry', actor_id: 'caster', spell_id: 'wall-of-fire', to: { x: 5, y: 1 }, server_authoritative: true }, initial, { diceService: dice(Array(20).fill(4)), context: { serverAuthoritativeCombat: true } })
  const lit = applyAll(initial, wallCast.events)
  lit.mechanics.combat.active_index = 1
  const moved = resolveCommand({ command_type: 'MoveActor', command_id: 'wall-entry-move', actor_id: 'target', to: { x: 5, y: 1 }, server_authoritative: true }, lit, { diceService: dice([1, ...Array(10).fill(4)]), context: { serverAuthoritativeCombat: true } })
  const waiting = applyAll(lit, moved.events)
  assert.equal(waiting.mechanics.combat.reaction_window?.trigger, 'spell-area-damage')
  assert.equal(moved.events.some((event) => event.event_type === 'DamageApplied'), false)
  const accepted = resolveCommand({ command_type: 'UseCombatAction', command_id: 'wall-entry-absorb', actor_id: 'target', action_id: 'cast:absorb-elements', server_authoritative: true }, waiting, { diceService: dice([1, ...Array(10).fill(4)]), context: { serverAuthoritativeCombat: true } })
  const final = applyAll(waiting, accepted.events)
  assert.equal(final.mechanics.combat.reaction_window, null)
  assert.ok(accepted.events.some((event) => event.event_type === 'DamageApplied' && event.payload.spell_id === 'wall-of-fire'))
  assert.equal(final.players.find((actor) => actor.id === 'target').x, 5)
  assert.equal(final.mechanics.combat.action_economy.target.movement_spent, 5, 'вход с реакцией оплачивает одну клетку, не два перемещения')
  assert.equal(accepted.events.filter((event) => event.event_type === 'ActorMoved' && event.actor_id === 'target').length, 1)
})

test('Wall of Fire turn-end damage uses the same pre-damage reaction pause', () => {
  const initial = wallState()
  const wallCast = resolveCommand({ command_type: 'CastSpell', command_id: 'wall-turn', actor_id: 'caster', spell_id: 'wall-of-fire', to: { x: 5, y: 1 }, server_authoritative: true }, initial, { diceService: dice(Array(20).fill(4)), context: { serverAuthoritativeCombat: true } })
  const inside = applyAll(initial, wallCast.events)
  inside.players.find((actor) => actor.id === 'target').x = 5
  inside.mechanics.positions.target = { x: 5, y: 1 }
  inside.mechanics.combat.active_index = 1
  const ended = resolveCommand({ command_type: 'EndTurn', command_id: 'wall-turn-end', actor_id: 'target', server_authoritative: true }, inside, { diceService: dice([1, ...Array(10).fill(4)]), context: { serverAuthoritativeCombat: true } })
  const waiting = applyAll(inside, ended.events)
  assert.equal(waiting.mechanics.combat.reaction_window?.trigger, 'spell-area-damage')
  assert.equal(ended.events.some((event) => event.event_type === 'DamageApplied'), false)
  const accepted = resolveCommand({ command_type: 'UseCombatAction', command_id: 'wall-turn-absorb', actor_id: 'target', action_id: 'cast:absorb-elements', server_authoritative: true }, waiting, { diceService: dice([1, ...Array(10).fill(4)]), context: { serverAuthoritativeCombat: true } })
  const final = applyAll(waiting, accepted.events)
  assert.equal(final.mechanics.combat.reaction_window, null)
  assert.ok(accepted.events.some((event) => event.event_type === 'DamageApplied' && event.payload.trigger === 'turn-end'))
  assert.equal(accepted.events.filter((event) => event.event_type === 'TurnEnded').length, 1)
  assert.equal(final.mechanics.combat.active_index, 0, 'после ответа переход инициативы выполняется один раз')
})

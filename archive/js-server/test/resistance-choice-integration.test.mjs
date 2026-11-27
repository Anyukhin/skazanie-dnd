import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `resistance-compound-${++id}`, now: () => '2026-09-19T12:00:00.000Z' })
}

function stateWithResistance(resistedIds = ['target-two']) {
  const cells = Array.from({ length: 32 }, (_, index) => ({ x: index % 8, y: Math.floor(index / 8), type: 'floor', revealed: true }))
  const state = normalizeCampaignState({
    sessionCode: 'RESISTANCE-COMPOUND',
    ruleset_id: 'dnd_5e_2014',
    partyMemberIds: ['caster', 'target-one', 'target-two'],
    players: [
      { id: 'caster', character: 'Маг', characterClass: 'wizard', level: 5, hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3, abilities: { str: 8, dex: 12, con: 14, int: 18, wis: 10, cha: 10 }, knownSpellIds: ['fireball'], preparedSpellIds: ['fireball'], inventory: [materializeCatalogItem('srd_5_2_1:component-pouch', { id: 'component-pouch', quantity: 1 })], x: 1, y: 1 },
      { id: 'target-one', character: 'Первый', characterClass: 'fighter', level: 3, hp: 30, maxHp: 30, armor: 14, speed: 30, proficiency: 2, abilities: { str: 12, dex: 12, con: 12, int: 8, wis: 8, cha: 8 }, inventory: [], x: 2, y: 1 },
      { id: 'target-two', character: 'Второй', characterClass: 'fighter', level: 3, hp: 30, maxHp: 30, armor: 14, speed: 30, proficiency: 2, abilities: { str: 12, dex: 12, con: 12, int: 8, wis: 8, cha: 8 }, inventory: [], x: 3, y: 1 },
    ],
    enemies: [],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'target-one', total: 18 }, { actor_id: 'target-two', total: 16 }],
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          'target-one': { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          'target-two': { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
  for (const id of resistedIds) state.mechanics.conditions[id] = [{
    id: 'resistance-d4', effect_id: `resistance:${id}`, source_actor: id, spell_id: 'resistance',
  }]
  return state
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (values) => ({ diceService: dice(values), context: { serverAuthoritativeCombat: true } })
const applyAll = (state, events) => events.reduce((current, event) => applyGameEvent(current, event), state)

function fireball(stateValue, values = [1, 1, 1, 1, 1, 1, 1, 1]) {
  values = Array.isArray(values) && values.length >= 100 ? values : [...values, ...Array(100).fill(1)]
  return resolveCommand(authoritative({ command_type: 'CastSpell', command_id: 'compound-fireball', actor_id: 'caster', spell_id: 'fireball', to: { x: 2, y: 1 }, slot_level: 3 }), stateValue, options(values))
}

test('compound spell saves keep prior dice transcript and pause again for the next resistant target', () => {
  const initial = stateWithResistance(['target-one', 'target-two'])
  const paused = fireball(initial)
  const window = paused.events.find((event) => event.event_type === 'ReactionWindowOpened')
  assert.equal(window?.payload.trigger, 'saving-throw-bonus-choice')
  assert.ok(Array.isArray(window?.payload.pending_dice_transcript))
  const waiting = applyAll(initial, paused.events)
  const accepted = resolveCommand(authoritative({ command_type: 'UseCombatAction', actor_id: 'target-one', action_id: 'use-resistance' }), waiting, options([1, 1, 1, 1]))
  const secondWindow = accepted.events.find((event) => event.event_type === 'ReactionWindowOpened')
  assert.equal(secondWindow?.payload.target_id, 'target-two')
  const waitingSecond = applyAll(waiting, accepted.events)
  const acceptedSecond = resolveCommand(authoritative({ command_type: 'UseCombatAction', actor_id: 'target-two', action_id: 'skip-resistance' }), waitingSecond, options([1, 1, 1, 1]))
  assert.equal(acceptedSecond.events.some((event) => event.event_type === 'ReactionWindowOpened'), false)
  const final = applyAll(waitingSecond, acceptedSecond.events)
  assert.equal(final.mechanics.combat.reaction_window, null)
  assert.equal(acceptedSecond.events.filter((event) => event.event_type === 'SpellSavingThrowResolved' && ['target-one', 'target-two'].includes(event.target_ids[0])).length, 2)
})

test('pending transcript сохраняет уже сделанные saves до окна Resistance', () => {
  const initial = stateWithResistance(['target-two'])
  const paused = fireball(initial)
  const window = paused.events.find((event) => event.event_type === 'ReactionWindowOpened')
  assert.equal(window?.payload.target_id, 'target-two')
  assert.ok(window?.payload.pending_dice_transcript?.length > 0)
  const waiting = applyAll(initial, paused.events)
  const resumed = resolveCommand(authoritative({ command_type: 'UseCombatAction', actor_id: 'target-two', action_id: 'skip-resistance' }), waiting, options([1, 1, 1, 1]))
  assert.equal(resumed.events.some((event) => event.event_type === 'ReactionWindowOpened'), false)
  assert.ok(resumed.events.some((event) => event.event_type === 'SpellSavingThrowResolved' && event.target_ids.includes('target-one')))
})

test('resistance choice ownership is enforced and a resolved window cannot be approved twice', () => {
  const initial = stateWithResistance(['target-one'])
  const paused = fireball(initial)
  const waiting = applyAll(initial, paused.events)
  const ownershipState = { ...waiting, mechanics: { ...waiting.mechanics, combat: { ...waiting.mechanics.combat, active_index: 2 } } }
  assert.throws(
    () => resolveCommand(authoritative({ command_type: 'UseCombatAction', actor_id: 'target-two', action_id: 'use-resistance' }), ownershipState, options([1, 1, 1])),
    (error) => ['REACTION_NOT_AVAILABLE', 'OUT_OF_TURN'].includes(error?.code),
  )
  const accepted = resolveCommand(authoritative({ command_type: 'UseCombatAction', actor_id: 'target-one', action_id: 'use-resistance' }), waiting, options([1, 1, 1, 1]))
  const resolved = applyAll(waiting, accepted.events)
  assert.equal(resolved.mechanics.combat.reaction_window, null)
  const nextTurn = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'caster' }), resolved, options([1, 1]))
  const targetTurn = applyAll(resolved, nextTurn.events)
  assert.throws(
    () => resolveCommand(authoritative({ command_type: 'UseCombatAction', actor_id: 'target-one', action_id: 'decline-reaction' }), targetTurn, options([1, 1])),
    (error) => error?.code === 'REACTION_NOT_AVAILABLE',
  )
})

test('timeout автоматически выбирает skip, закрывает окно и возобновляет pending command', () => {
  const initial = stateWithResistance(['target-one'])
  const paused = fireball(initial)
  const waiting = applyAll(initial, paused.events)
  const timeout = resolveCommand(authoritative({
    command_type: 'UseCombatAction', actor_id: 'target-one', action_id: 'decline-reaction', auto_skip_reason: 'turn-timeout',
  }), waiting, options([1, 1, 1, 1]))
  assert.equal(timeout.events.find((event) => event.event_type === 'ReactionWindowClosed')?.payload.auto_declined, true)
  assert.equal(timeout.events.some((event) => event.event_type === 'ReactionWindowOpened'), false)
  assert.equal(timeout.events.some((event) => event.event_type === 'DieRolled' && event.payload.modifier_source === 'resistance'), false)
  assert.ok(timeout.events.some((event) => event.event_type === 'SpellSavingThrowResolved'))
  assert.equal(applyAll(waiting, timeout.events).mechanics.combat.reaction_window, null)
})

test('Resistance 2014 can roll first, then apply the bonus to the same d20 without rerolling', () => {
  const initial = stateWithResistance(['target-one'])
  const paused = fireball(initial)
  const waiting = applyAll(initial, paused.events)
  const rolledFirst = resolveCommand(authoritative({ command_type: 'UseCombatAction', actor_id: 'target-one', action_id: 'roll-first-resistance' }), waiting, options([1, 1, 1, 1]))
  const afterWindow = rolledFirst.events.find((event) => event.event_type === 'ReactionWindowOpened')
  assert.equal(afterWindow?.payload.trigger, 'saving-throw-bonus-choice')
  assert.equal(afterWindow?.payload.resistance_phase, 'after-roll')
  assert.ok(afterWindow?.payload.trigger_roll?.roll_id)
  assert.equal(rolledFirst.events.some((event) => event.event_type === 'DieRolled' && event.payload.modifier_source === 'resistance'), false)
  const waitingAfter = applyAll(waiting, rolledFirst.events)
  const applied = resolveCommand(authoritative({ command_type: 'UseCombatAction', actor_id: 'target-one', action_id: 'use-resistance' }), waitingAfter, options([1, 1, 1, 1]))
  assert.equal(applied.events.filter((event) => event.event_type === 'DieRolled' && event.payload.modifier_source === 'resistance').length, 1)
  assert.equal(applied.events.filter((event) => event.event_type === 'SpellSavingThrowResolved' && event.target_ids.includes('target-one')).length, 1)
  assert.equal(applied.events.some((event) => event.event_type === 'ReactionWindowOpened'), false)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { AuthoritativeExecutor } from '../server/authoritative-executor.mjs'
import {
  RulesEngine,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
} from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { dice as kitDice } from './kit/dice.mjs'
import { applyAll, createCampaignStore } from './kit/engine.mjs'

const authoritative = (command) => ({ ...command, server_authoritative: true })

function initialState({ targetHp = 100, casterHp = 30, defenses = {}, targetAt = { x: 3, y: 1 }, targetTemporaryHp = 0 } = {}) {
  const cells = Array.from({ length: 400 }, (_, index) => ({ x: index % 20, y: Math.floor(index / 20), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'ENERVATION-CONTINUATION', ruleset_id: 'dnd_5e_2014', partyMemberIds: ['caster'],
    players: [{ id: 'caster', character: 'Маг', characterClass: 'wizard', level: 12, hp: casterHp, maxHp: 50, armor: 14, proficiency: 4, abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 12, cha: 10 }, inventory: [], x: 1, y: 1 }],
    enemies: [{ id: 'target', name: 'Цель', creature_type: 'humanoid', hp: targetHp, maxHp: 100, armor: 12, speed: 30, abilities: { dex: 10, con: 14 }, x: targetAt.x, y: targetAt.y, alive: targetHp > 0 }],
    scene: { cells },
    mechanics: {
      defenses,
      temporary_hp: targetTemporaryHp > 0 ? { target: targetTemporaryHp } : {},
      resources: { caster: { spell_slots_6: { current: 1, max: 1 } } },
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

const dice = (values, prefix = 'enervation-continuation') => kitDice(values, { prefix, now: '2026-09-24T12:00:00.000Z' })

function castFailed(state) {
  return resolveCommand(authoritative({
    command_type: 'CastSpell', command_id: 'enervation-start', actor_id: 'caster', spell_id: 'enervation',
    target_id: 'target', target_ids: ['target'], slot_level: 6, casting_resource: 'spell_slots_6',
  }), state, { diceService: dice([1, 4, 4, 4, 4, 4]), context: { serverAuthoritativeCombat: true, isAdmin: true } })
}

test('первичный смертельный урон не оставляет новую связь Обессиливания', () => {
  const initial = initialState({ targetHp: 1 })
  const result = castFailed(initial)
  const ended = result.events.filter((event) => event.event_type === 'ConcentrationEnded'
    && event.actor_id === 'caster' && event.payload.spell_id === 'enervation')
  assert.equal(ended.length, 1)
  assert.equal(ended[0].payload.reason, 'target-defeated')
  const final = replayEvents(initial, result.events)
  assert.equal(final.mechanics.concentration.caster, undefined)
  assert.equal(final.players[0].combatActions.some((action) => action.id === 'enervation-repeat'), false)
})

function continuationState(options = {}) {
  const initial = initialState(options)
  const cast = castFailed(initial)
  const afterCast = applyAll(initial, cast.events)
  return {
    initial,
    cast,
    state: normalizeCampaignState({
      ...afterCast,
      mechanics: {
        ...afterCast.mechanics,
        combat: {
          ...afterCast.mechanics.combat,
          action_economy: {
            ...afterCast.mechanics.combat.action_economy,
            caster: { ...afterCast.mechanics.combat.action_economy.caster, action: true },
          },
        },
      },
    }),
  }
}

function continueSpell(state, values = [4, 4, 4, 4, 4], commandId = 'enervation-repeat', targetId = 'target') {
  return resolveCommand(authoritative({
    command_type: 'UseCombatAction', command_id: commandId, actor_id: 'caster', action_id: 'enervation-repeat',
    target_id: targetId, target_ids: [targetId],
  }), state, { diceService: dice(values), context: { serverAuthoritativeCombat: true, isAdmin: true } })
}

test('повторное действие использует тот же effect_id, upcast, подтверждённый урон и replay', () => {
  const { state } = continuationState({ casterHp: 30 })
  const continuationAction = state.players.find((actor) => actor.id === 'caster').combatActions.find((action) => action.id === 'enervation-repeat')
  assert.ok(continuationAction)
  assert.equal(continuationAction.iconId, 'enervation')
  assert.match(continuationAction.description, /Действием повторно нанести/u)
  const enervated = state.mechanics.conditions.target.find((condition) => condition.id === 'enervated')
  assert.equal(enervated.continuation_version, 1)
  assert.equal(enervated.continuation_range, 60)
  assert.equal(enervated.continuation_duration_seconds, 60)
  const result = continueSpell(state)
  const damage = result.events.find((event) => event.event_type === 'DamageApplied' && event.payload.continuation === true)
  const healing = result.events.find((event) => event.event_type === 'HealingApplied' && event.payload.continuation === true)
  const action = result.events.find((event) => event.event_type === 'CombatActionUsed' && event.payload.action_id === 'enervation-repeat')
  assert.ok(action)
  assert.equal(result.events.filter((event) => event.event_type === 'ResourceSpent').length, 0)
  assert.equal(result.rolls.find((roll) => roll.purpose === 'spell_continuation_damage:enervation').expression, '5d8')
  assert.equal(damage.payload.raw_amount, 20)
  assert.equal(damage.payload.applied_amount, 20)
  assert.equal(healing.payload.requested_amount, 10)
  assert.equal(healing.payload.applied_amount, 10)
  const after = applyAll(state, result.events)
  assert.equal(after.enemies.find((actor) => actor.id === 'target').hp, 60)
  assert.equal(after.players.find((actor) => actor.id === 'caster').hp, 50)
  assert.ok(after.players.find((actor) => actor.id === 'caster').combatActions.some((action) => action.id === 'enervation-repeat'))
  assert.deepEqual(replayEvents(state, result.events), after)
})

test('снятие новой версии enervated убирает продолжение, не меняя концентрацию', () => {
  const { state } = continuationState()
  const removed = applyGameEvent(state, {
    event_type: 'ConditionRemoved', reducer_version: 15, state_version_after: state.state_version + 1,
    actor_id: 'caster', target_ids: ['target'], source_rule_ids: [], visibility: 'public',
    payload: { condition: 'enervated', effect_id: 'enervation:enervation-start' },
  })
  assert.equal(removed.players.find((actor) => actor.id === 'caster').combatActions.some((action) => action.id === 'enervation-repeat'), false)
  assert.equal(removed.mechanics.concentration.caster.effect_id, 'enervation:enervation-start')
})

test('повторное действие лечит и за урон, поглощённый временными хитами', () => {
  const { state: castState } = continuationState({ casterHp: 20 })
  const state = normalizeCampaignState({
    ...castState,
    mechanics: { ...castState.mechanics, temporary_hp: { ...castState.mechanics.temporary_hp, target: 4 } },
  })
  const result = continueSpell(state)
  const damage = result.events.find((event) => event.event_type === 'DamageApplied' && event.payload.continuation === true)
  const healing = result.events.find((event) => event.event_type === 'HealingApplied' && event.payload.continuation === true)
  assert.equal(damage.payload.applied_amount, 16)
  assert.equal(damage.payload.temporary_hp_absorbed, 4)
  assert.equal(healing.payload.requested_amount, 10)
  assert.equal(healing.payload.damage_for_life_steal, 20)
  assert.equal(replayEvents(state, result.events).players.find((actor) => actor.id === 'caster').hp, 40)
})

test('сопротивление лечит от фактически прошедшего урона, иммунитет не лечит', () => {
  const resistant = continuationState({ defenses: { target: { resistances: ['necrotic'] } } })
  const reduced = continueSpell(resistant.state)
  const reducedDamage = reduced.events.find((event) => event.event_type === 'DamageApplied' && event.payload.continuation === true)
  const reducedHealing = reduced.events.find((event) => event.event_type === 'HealingApplied' && event.payload.continuation === true)
  assert.equal(reducedDamage.payload.raw_amount, 20)
  assert.equal(reducedDamage.payload.applied_amount, 10)
  assert.equal(reducedHealing.payload.requested_amount, 5)

  const immune = continuationState({ defenses: { target: { immunities: ['necrotic'] } } })
  const blocked = continueSpell(immune.state)
  const blockedDamage = blocked.events.find((event) => event.event_type === 'DamageApplied' && event.payload.continuation === true)
  assert.equal(blockedDamage.payload.immune, true)
  assert.equal(blockedDamage.payload.applied_amount, 0)
  assert.equal(blocked.events.some((event) => event.event_type === 'HealingApplied' && event.payload.continuation === true), false)
})

test('цель с 0 HP завершает связь без нового броска', () => {
  const { state } = continuationState()
  const defeated = normalizeCampaignState({
    ...state,
    enemies: state.enemies.map((enemy) => enemy.id === 'target' ? { ...enemy, hp: 0, alive: false } : enemy),
  })
  const result = continueSpell(defeated)
  assert.equal(result.rolls.some((roll) => roll.purpose === 'spell_continuation_damage:enervation'), false)
  assert.equal(result.events.some((event) => event.event_type === 'DamageApplied' && event.payload.continuation === true), false)
  assert.ok(result.events.some((event) => event.event_type === 'ConcentrationEnded' && event.payload.reason === 'target-defeated'))
  assert.equal(replayEvents(defeated, result.events).mechanics.concentration.caster, undefined)
})

test('дальность и visibility заканчивают связь, а другое действие прекращает её', () => {
  const far = continuationState()
  const farState = normalizeCampaignState({
    ...far.state,
    enemies: far.state.enemies.map((enemy) => enemy.id === 'target' ? { ...enemy, x: 20 } : enemy),
    mechanics: { ...far.state.mechanics, positions: { ...far.state.mechanics.positions, target: { x: 20, y: 1 } } },
  })
  const farResult = continueSpell(farState)
  assert.ok(farResult.events.some((event) => event.event_type === 'ConcentrationEnded' && event.payload.reason === 'out-of-range'))
  assert.equal(farResult.events.some((event) => event.event_type === 'DamageApplied' && event.payload.continuation === true), false)
  assert.equal(replayEvents(farState, farResult.events).players.find((actor) => actor.id === 'caster').combatActions.some((action) => action.id === 'enervation-repeat'), false)

  const hidden = continuationState()
  hidden.state.scene.cells = hidden.state.scene.cells.map((cell) => cell.x === 3 && cell.y === 1 ? { ...cell, revealed: false } : cell)
  const hiddenResult = continueSpell(hidden.state)
  assert.ok(hiddenResult.events.some((event) => event.event_type === 'DamageApplied' && event.payload.continuation === true))
  assert.equal(hiddenResult.events.some((event) => event.event_type === 'ConcentrationEnded' && event.payload.reason === 'target-not-visible'), false)

  const covered = continuationState()
  covered.state.scene.cells = covered.state.scene.cells.map((cell) => cell.x === 2 && cell.y === 1 ? { ...cell, type: 'wall' } : cell)
  const coveredResult = continueSpell(covered.state)
  assert.ok(coveredResult.events.some((event) => event.event_type === 'ConcentrationEnded' && event.payload.reason === 'full-cover'))

  const other = continuationState()
  const dash = resolveCommand(authoritative({ command_type: 'UseCombatAction', command_id: 'enervation-other-action', actor_id: 'caster', action_id: 'dash' }), other.state, { diceService: dice([]), context: { serverAuthoritativeCombat: true, isAdmin: true } })
  assert.ok(dash.events.some((event) => event.event_type === 'ConcentrationEnded' && event.payload.reason === 'action-other'))
  assert.equal(replayEvents(other.state, dash.events).mechanics.concentration.caster, undefined)
})

test('выход цели из дальности закрывает связь по самому перемещению', () => {
  const { state: castState } = continuationState()
  const state = normalizeCampaignState({
    ...castState,
    enemies: castState.enemies.map((enemy) => enemy.id === 'target' ? { ...enemy, speed: 100 } : enemy),
    mechanics: {
      ...castState.mechanics,
      combat: { ...castState.mechanics.combat, active_index: 1 },
    },
  })
  const moved = resolveCommand(authoritative({
    command_type: 'MoveActor', command_id: 'enervation-target-leaves', actor_id: 'target', to: { x: 19, y: 1 },
  }), state, { diceService: dice([]), context: { serverAuthoritativeCombat: true, isAdmin: true } })
  assert.ok(moved.events.some((event) => event.event_type === 'ActorMoved'))
  assert.ok(moved.events.some((event) => event.event_type === 'ConcentrationEnded' && event.payload.reason === 'out-of-range'))
  const after = replayEvents(state, moved.events)
  assert.equal(after.mechanics.concentration.caster, undefined)
  assert.equal(after.players.find((actor) => actor.id === 'caster').combatActions.some((action) => action.id === 'enervation-repeat'), false)
})

test('60 секунд концентрации закрывают связь без пропуска хода', () => {
  const { state } = continuationState()
  const advanced = resolveCommand(authoritative({
    command_type: 'AdvanceTime', command_id: 'enervation-expiry', actor_id: 'caster', amount: 60, unit: 'second',
  }), state, { diceService: dice([]), context: { serverAuthoritativeCombat: true, isAdmin: true } })
  assert.ok(advanced.events.some((event) => event.event_type === 'TimeAdvanced'))
  assert.ok(advanced.events.some((event) => event.event_type === 'ConcentrationEnded' && event.payload.reason === 'duration-expired'))
  assert.equal(advanced.events.some((event) => event.event_type === 'CombatActionUsed'), false)
  assert.equal(replayEvents(state, advanced.events).mechanics.concentration.caster, undefined)
})

test('продолжение привязано к исходной цели и владельцу связи', () => {
  const { state } = continuationState()
  const withOtherTarget = normalizeCampaignState({
    ...state,
    enemies: [...state.enemies, { ...state.enemies[0], id: 'other-target', x: 3, y: 2 }],
  })
  assert.throws(
    () => continueSpell(withOtherTarget, [4, 4, 4, 4, 4], 'enervation-wrong-target', 'other-target'),
    (error) => error?.code === 'ENERVATION_TARGET_MISMATCH',
  )
  assert.throws(
    () => resolveCommand(authoritative({
      command_type: 'UseCombatAction', command_id: 'enervation-foreign-caster', actor_id: 'target', action_id: 'enervation-repeat', target_id: 'target', target_ids: ['target'],
    }), normalizeCampaignState({
      ...state,
      mechanics: { ...state.mechanics, combat: { ...state.mechanics.combat, active_index: 1 } },
    }), { diceService: dice([]), context: { serverAuthoritativeCombat: true, isAdmin: true } }),
    (error) => error?.code === 'ENERVATION_NOT_ACTIVE',
  )
})

test('старое enervated-состояние без continuation marker не получает новое действие', () => {
  const { state } = continuationState()
  const legacy = normalizeCampaignState({
    ...state,
    mechanics: {
      ...state.mechanics,
      conditions: {
        ...state.mechanics.conditions,
        target: (state.mechanics.conditions.target ?? []).map((condition) => {
          if (condition.id !== 'enervated') return condition
          const copy = { ...condition }
          delete copy.continuation_version
          delete copy.continuation_damage
          delete copy.continuation_damage_type
          delete copy.continuation_range
          delete copy.continuation_upcast_dice_per_level
          delete copy.continuation_duration_seconds
          return copy
        }),
      },
    },
  })
  assert.equal(legacy.players.find((actor) => actor.id === 'caster').combatActions.some((action) => action.id === 'enervation-repeat'), false)
  assert.throws(
    () => continueSpell(legacy, [], 'legacy-enervation-repeat'),
    (error) => error?.code === 'ENERVATION_NOT_ACTIVE',
  )
})

test('будущий continuation version не получает действие текущего движка', () => {
  const { state } = continuationState()
  const future = normalizeCampaignState({
    ...state,
    mechanics: {
      ...state.mechanics,
      conditions: {
        ...state.mechanics.conditions,
        target: (state.mechanics.conditions.target ?? []).map((condition) => condition.id === 'enervated'
          ? { ...condition, continuation_version: 99 }
          : condition),
      },
    },
  })
  assert.equal(future.players.find((actor) => actor.id === 'caster').combatActions.some((action) => action.id === 'enervation-repeat'), false)
  assert.throws(
    () => continueSpell(future, [], 'future-enervation-repeat'),
    (error) => error?.code === 'ENERVATION_NOT_ACTIVE',
  )
})

test('продолжение Обессиливания видно владельцу и администратору, но не соседнему игроку', () => {
  const { state } = continuationState()
  const projectedState = normalizeCampaignState({
    ...state,
    partyMemberIds: ['caster', 'other'],
    players: [...state.players, {
      id: 'other', character: 'Другой герой', characterClass: 'fighter', level: 12,
      hp: 30, maxHp: 30, armor: 14, proficiency: 4,
      abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], x: 2, y: 1,
    }],
  })
  const owner = campaignStateForViewer(projectedState, { role: 'player' }, 'caster')
  const other = campaignStateForViewer(projectedState, { role: 'player' }, 'other')
  const admin = campaignStateForViewer(projectedState, { role: 'admin' }, '')
  assert.ok(owner.players.find((actor) => actor.id === 'caster').combatActions.some((action) => action.id === 'enervation-repeat'))
  assert.equal(other.players.find((actor) => actor.id === 'caster').combatActions.some((action) => action.id === 'enervation-repeat'), false)
  assert.ok(admin.players.find((actor) => actor.id === 'caster').combatActions.some((action) => action.id === 'enervation-repeat'))
})

test('сохранённое событие reducer 15 без continuation marker остаётся старым replay', () => {
  const legacyEffectId = 'legacy-enervation-effect'
  const replayed = replayEvents(initialState(), [
    {
      event_id: 'legacy-concentration', event_type: 'ConcentrationStarted', reducer_version: 15,
      state_version_after: 1, actor_id: 'caster', target_ids: ['caster'],
      payload: { effect_id: legacyEffectId },
    },
    {
      event_id: 'legacy-enervated', event_type: 'ConditionAdded', reducer_version: 15,
      state_version_after: 2, actor_id: 'caster', target_ids: ['target'],
      payload: {
        condition: 'enervated', duration: 'concentration', source_actor: 'caster',
        effect_id: legacyEffectId, spell_id: 'enervation',
      },
    },
  ])
  const condition = replayed.mechanics.conditions.target.find((entry) => entry.id === 'enervated')
  assert.ok(condition)
  assert.equal(Object.hasOwn(condition, 'continuation_version'), false)
  assert.equal(replayed.players.find((actor) => actor.id === 'caster').combatActions.some((action) => action.id === 'enervation-repeat'), false)
})

test('повторный idempotency key возвращает тот же commit', async (t) => {
  const initial = initialState()
  const cast = castFailed(initial)
  const casted = applyAll(initial, cast.events)
  const ready = normalizeCampaignState({
    ...casted,
    mechanics: {
      ...casted.mechanics,
      combat: {
        ...casted.mechanics.combat,
        action_economy: {
          ...casted.mechanics.combat.action_economy,
          caster: { ...casted.mechanics.combat.action_economy.caster, action: true },
        },
      },
    },
  })
  const store = await createCampaignStore(t, ready.sessionCode, ready, { prefix: 'skazanie-enervation-continuation-' })
  const executor = new AuthoritativeExecutor({ eventStore: store, rulesEngine: new RulesEngine({ diceService: dice([1, 4, 4, 4, 4, 4, 4, 4, 4, 4]) }) })
  const input = {
    campaignId: ready.sessionCode,
    idempotencyKey: 'enervation-repeat-once',
    context: { serverAuthoritativeCombat: true, isAdmin: true },
    commands: [authoritative({ command_type: 'UseCombatAction', command_id: 'enervation-idempotent-repeat', actor_id: 'caster', action_id: 'enervation-repeat', target_id: 'target', target_ids: ['target'] })],
  }
  const first = await executor.executeCommands(input)
  const second = await executor.executeCommands(input)
  assert.equal(first.replayed, false)
  assert.equal(second.replayed, true)
  assert.deepEqual(second.events, first.events)
})

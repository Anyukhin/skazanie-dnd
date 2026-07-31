import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `indomitable-roll-${++id}`,
    now: () => '2026-07-19T12:00:00.000Z',
  })
}

function fixture({ level = 9, resource = 1, concentration = false } = {}) {
  return normalizeCampaignState({
    sessionCode: 'INDOMITABLE',
    partyMemberIds: ['fighter'],
    players: [{
      id: 'fighter', character: 'Бранн', characterClass: 'fighter', level,
      hp: 40, maxHp: 40, armor: 18, speed: 30, proficiency: 4,
      abilities: { str: 18, dex: 10, con: 14, int: 8, wis: 10, cha: 10 },
      x: 1, y: 1, inventory: [],
    }],
    enemies: [{
      id: 'enemy', name: 'Маг', characterClass: 'wizard', level: 9,
      hp: 30, maxHp: 30, armor: 12, abilities: { str: 8, dex: 12, con: 12, int: 18, wis: 12, cha: 10 },
      x: 2, y: 1, alive: true,
    }],
    scene: { turn: 1, cells: [{ x: 1, y: 1, type: 'floor', revealed: true }, { x: 2, y: 1, type: 'floor', revealed: true }] },
    mechanics: {
      positions: { fighter: { x: 1, y: 1 }, enemy: { x: 2, y: 1 } },
      resources: { fighter: { indomitable: { current: resource, max: 1 } } },
      ...(concentration ? { concentration: { fighter: { effect_id: 'spell:web' } } } : {}),
    },
  })
}

const applyAll = (state, events) => events.reduce((current, event) => applyGameEvent(current, event), state)

function openWindow(state, service, command = { command_type: 'MakeSavingThrow', actor_id: 'fighter', ability: 'dex', difficulty: 15 }) {
  const result = resolveCommand(command, state, { diceService: service, context: { isAdmin: true, serverAuthoritativeCombat: true } })
  assert.deepEqual(result.events.map((event) => event.event_type), ['ReactionWindowOpened'])
  assert.equal(result.rolls.length, 0)
  return { result, waiting: applyAll(state, result.events) }
}

test('Несгибаемый атомарно перебрасывает провал с бонусом уровня и не расходует реакцию', () => {
  const state = fixture()
  const service = dice([2, 10])
  const { result, waiting } = openWindow(state, service)
  assert.equal(waiting.mechanics.resources.fighter.indomitable.current, 1)
  assert.equal(waiting.mechanics.combat.reaction_window.trigger_roll.total, 2)

  const accepted = resolveCommand({
    command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'indomitable', server_authoritative: true,
  }, waiting, { diceService: service, context: { serverAuthoritativeCombat: true } })
  const save = accepted.events.find((event) => event.event_type === 'SavingThrowResolved')
  assert.equal(save.payload.indomitable_original_total, 2)
  assert.equal(save.payload.indomitable_bonus, 9)
  assert.equal(save.payload.total, 19)
  assert.equal(save.payload.success, true)
  assert.ok(save.source_rule_ids.includes('srd_5_2_1:classes:fighter-indomitable'))
  const after = applyAll(waiting, accepted.events)
  assert.equal(after.mechanics.resources.fighter.indomitable.current, 0)
  assert.equal(after.mechanics.combat.reaction_window, null)
  assert.equal(after.mechanics.combat.action_economy.fighter?.reaction, undefined)
  const actionLog = after.battleLog.find((entry) => entry.type === 'action' && entry.actionId === 'indomitable')
  assert.equal(actionLog.indomitableBonus, 9)
  assert.equal(actionLog.indomitableOriginalTotal, 2)
  assert.deepEqual(replayEvents(waiting, accepted.events), after)
  assert.equal(result.events.some((event) => event.event_type === 'SavingThrowResolved'), false)
})

test('отказ сохраняет исходный провал и не расходует использование', () => {
  const state = fixture()
  const service = dice([2])
  const { waiting } = openWindow(state, service)
  const declined = resolveCommand({
    command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'decline-reaction', server_authoritative: true,
  }, waiting, { diceService: service, context: { serverAuthoritativeCombat: true } })
  const save = declined.events.find((event) => event.event_type === 'SavingThrowResolved')
  assert.equal(save.payload.kept, 2)
  assert.equal(save.payload.total, 2)
  assert.equal(save.payload.success, false)
  const after = applyAll(waiting, declined.events)
  assert.equal(after.mechanics.resources.fighter.indomitable.current, 1)
  assert.equal(after.mechanics.combat.reaction_window, null)
})

test('новый результат обязателен даже при повторном провале', () => {
  const state = fixture()
  const service = dice([2, 1])
  const { waiting } = openWindow(state, service)
  const accepted = resolveCommand({
    command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'indomitable', server_authoritative: true,
  }, waiting, { diceService: service, context: { serverAuthoritativeCombat: true } })
  const save = accepted.events.find((event) => event.event_type === 'SavingThrowResolved')
  assert.equal(save.payload.kept, 1)
  assert.equal(save.payload.total, 10)
  assert.equal(save.payload.success, false)
  assert.equal(applyAll(waiting, accepted.events).mechanics.resources.fighter.indomitable.current, 0)
})

test('особенность недоступна до 9 уровня, без ресурса и вне серверного окна', () => {
  for (const state of [fixture({ level: 8 }), fixture({ resource: 0 })]) {
    const result = resolveCommand(
      { command_type: 'MakeSavingThrow', actor_id: 'fighter', ability: 'dex', difficulty: 15 },
      state,
      { diceService: dice([2]), context: { isAdmin: true } },
    )
    assert.equal(result.events.some((event) => event.event_type === 'ReactionWindowOpened'), false)
    assert.equal(result.events.find((event) => event.event_type === 'SavingThrowResolved').payload.success, false)
  }
  assert.throws(
    () => resolveCommand(
      { command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'indomitable', server_authoritative: true },
      fixture(),
      { diceService: dice(), context: { serverAuthoritativeCombat: true } },
    ),
    (error) => error.code === 'INDOMITABLE_NOT_AVAILABLE',
  )
})

test('провал концентрации ставит весь урон на паузу, а успешный переброс сохраняет концентрацию', () => {
  const state = fixture({ concentration: true })
  const service = dice([1, 10])
  const { waiting } = openWindow(state, service, {
    command_type: 'ApplyDamage', actor_id: 'enemy', target_id: 'fighter', amount: 4, damage_type: 'slashing',
  })
  assert.equal(waiting.players[0].hp, 40)
  const accepted = resolveCommand({
    command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'indomitable', server_authoritative: true,
  }, waiting, { diceService: service, context: { serverAuthoritativeCombat: true } })
  const after = applyAll(waiting, accepted.events)
  assert.equal(after.players[0].hp, 36)
  assert.equal(after.mechanics.concentration.fighter.effect_id, 'spell:web')
  const save = accepted.events.find((event) => event.event_type === 'ConcentrationSavingThrowResolved')
  assert.equal(save.payload.saved, true)
  assert.equal(save.payload.indomitable_bonus, 9)
  assert.equal(after.battleLog.find((entry) => entry.type === 'concentration-save').indomitableBonus, 9)
})

test('публичная проекция скрывает pending command, dice transcript и failed roll id', () => {
  const state = fixture()
  const { result, waiting } = openWindow(state, dice([2]))
  const user = { role: 'player' }
  const publicState = campaignStateForViewer(waiting, user, 'fighter')
  const publicWindow = publicState.mechanics.combat.reaction_window
  assert.equal(publicWindow.trigger, 'failed-saving-throw')
  assert.equal(publicWindow.trigger_roll.total, 2)
  assert.equal('pending_command' in publicWindow, false)
  assert.equal('pending_dice_transcript' in publicWindow, false)
  assert.equal('failed_roll_id' in publicWindow, false)
  const publicEvent = mechanicsForViewer(result.events, user, 'fighter')[0]
  assert.equal('pending_command' in publicEvent.payload, false)
  assert.equal('pending_dice_transcript' in publicEvent.payload, false)
  assert.equal('failed_roll_id' in publicEvent.payload, false)
})

test('переброс спасброска от смерти заменяет исходный провал до изменения счётчиков', () => {
  const state = fixture()
  state.players[0].hp = 0
  state.mechanics.death.saving_throws.fighter = { successes: 0, failures: 0, stable: false }
  state.mechanics.conditions.fighter = [{ id: 'unconscious' }]
  state.players.push({
    id: 'ally', character: 'Лира', characterClass: 'rogue', level: 9,
    hp: 30, maxHp: 30, armor: 16, proficiency: 4,
    abilities: { str: 10, dex: 18, con: 12, int: 12, wis: 14, cha: 12 }, x: 0, y: 1, inventory: [],
  })
  state.partyMemberIds.push('ally')
  state.mechanics.positions.ally = { x: 0, y: 1 }
  state.mechanics.combat = {
    active: true, round: 1, active_index: 0,
    initiative: [{ actor_id: 'ally', total: 18 }, { actor_id: 'fighter', total: 10 }, { actor_id: 'enemy', total: 5 }],
    action_economy: {
      ally: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
      fighter: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
      enemy: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
    },
  }
  const normalized = normalizeCampaignState(state)
  const service = dice([2, 10])
  const { waiting } = openWindow(normalized, service, { command_type: 'EndTurn', actor_id: 'ally' })
  assert.deepEqual(waiting.mechanics.death.saving_throws.fighter, { successes: 0, failures: 0, stable: false })
  const accepted = resolveCommand({
    command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'indomitable', server_authoritative: true,
  }, waiting, { diceService: service, context: { serverAuthoritativeCombat: true } })
  const deathSave = accepted.events.find((event) => event.event_type === 'DeathSavingThrowRolled')
  assert.equal(deathSave.payload.success, true)
  assert.equal(deathSave.payload.total, 19)
  const after = applyAll(waiting, accepted.events)
  assert.equal(after.mechanics.death.saving_throws.fighter.successes, 1)
  assert.equal(after.mechanics.death.saving_throws.fighter.failures, 0)
  assert.equal(after.mechanics.combat.action_economy.fighter.reaction, true)
  assert.equal(after.battleLog.find((entry) => entry.type === 'death-save').indomitableBonus, 9)
})

test('заклинание фиксируется только после выбора, а успешный переброс отменяет его урон', () => {
  const state = fixture()
  state.enemies[0] = {
    ...state.enemies[0], characterClass: 'cleric', level: 9, proficiency: 4,
    abilities: { str: 8, dex: 12, con: 12, int: 10, wis: 18, cha: 10 },
  }
  state.mechanics.combat = {
    active: true, round: 1, active_index: 0,
    initiative: [{ actor_id: 'enemy', total: 18 }, { actor_id: 'fighter', total: 10 }],
    action_economy: {
      enemy: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
      fighter: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
    },
  }
  const normalized = normalizeCampaignState(state)
  const service = dice([4, 4, 2, 15])
  const { waiting } = openWindow(normalized, service, {
    command_type: 'CastSpell', actor_id: 'enemy', spell_id: 'sacred-flame',
    target_id: 'fighter', target_ids: ['fighter'], server_authoritative: true,
  })
  assert.equal(waiting.players[0].hp, 40)
  assert.equal(waiting.mechanics.combat.action_economy.enemy.action, true)
  const accepted = resolveCommand({
    command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'indomitable', server_authoritative: true,
  }, waiting, { diceService: service, context: { serverAuthoritativeCombat: true } })
  const save = accepted.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(save.payload.saved, true)
  assert.equal(save.payload.indomitable_bonus, 9)
  assert.equal(accepted.events.some((event) => event.event_type === 'DamageApplied'), false)
  const after = applyAll(waiting, accepted.events)
  assert.equal(after.players[0].hp, 40)
  assert.equal(after.mechanics.combat.action_economy.enemy.action, false)
})

test('area attack использует тот же спасбросок и не расходует предмет до решения', () => {
  const state = fixture()
  state.enemies[0].inventory = [{
    id: 'bomb', name: 'Алхимическая бомба', type: 'consumable', quantity: 1,
    combat: { kind: 'thrown-area', normalRange: 20, radius: 5, damage: '2d6', damageType: 'fire', saveAbility: 'dex', saveDc: 15, halfOnSave: false },
  }]
  state.mechanics.combat = {
    active: true, round: 1, active_index: 0,
    initiative: [{ actor_id: 'enemy', total: 18 }, { actor_id: 'fighter', total: 10 }],
    action_economy: {
      enemy: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
      fighter: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
    },
  }
  const normalized = normalizeCampaignState(state)
  const service = dice([3, 3, 2, 15])
  const { waiting } = openWindow(normalized, service, {
    command_type: 'MakeAreaAttack', actor_id: 'enemy', item_id: 'bomb', to: { x: 1, y: 1 }, server_authoritative: true,
  })
  assert.equal(waiting.players[0].hp, 40)
  assert.equal(waiting.enemies[0].inventory[0].quantity, 1)
  const accepted = resolveCommand({
    command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'indomitable', server_authoritative: true,
  }, waiting, { diceService: service, context: { serverAuthoritativeCombat: true } })
  const save = accepted.events.find((event) => event.event_type === 'SavingThrowResolved')
  assert.equal(save.payload.saved, true)
  assert.equal(save.payload.source, 'area-attack')
  assert.equal(applyAll(waiting, accepted.events).players[0].hp, 40)
})

test('короткий отдых не возвращает Несгибаемого, продолжительный возвращает', () => {
  let state = fixture({ resource: 0 })
  const startShort = resolveCommand({ command_type: 'StartRest', actor_id: 'fighter', kind: 'short' }, state, { diceService: dice() })
  state = applyAll(state, startShort.events)
  state = applyAll(state, resolveCommand({ command_type: 'AdvanceTime', amount: 60, unit: 'minute' }, state, { diceService: dice() }).events)
  const completeShort = resolveCommand({ command_type: 'CompleteRest', actor_id: 'fighter', kind: 'short' }, state, { diceService: dice() })
  state = applyAll(state, completeShort.events)
  assert.equal(state.mechanics.resources.fighter.indomitable.current, 0)
  const startLong = resolveCommand({ command_type: 'StartRest', actor_id: 'fighter', kind: 'long' }, state, { diceService: dice() })
  state = applyAll(state, startLong.events)
  state = applyAll(state, resolveCommand({ command_type: 'AdvanceTime', amount: 480, unit: 'minute' }, state, { diceService: dice() }).events)
  const completeLong = resolveCommand({ command_type: 'CompleteRest', actor_id: 'fighter', kind: 'long' }, state, { diceService: dice() })
  state = applyAll(state, completeLong.events)
  assert.equal(state.mechanics.resources.fighter.indomitable.current, 1)
})

test('несколько воинов отвечают последовательно, а массовая атака применяется один раз после последнего решения', () => {
  const state = fixture()
  state.players.push({
    id: 'fighter-2', character: 'Кара', characterClass: 'fighter', level: 9,
    hp: 36, maxHp: 36, armor: 17, speed: 30, proficiency: 4,
    abilities: { str: 16, dex: 10, con: 16, int: 10, wis: 10, cha: 10 },
    x: 1, y: 2, inventory: [],
  })
  state.partyMemberIds.push('fighter-2')
  state.scene.cells.push({ x: 1, y: 2, type: 'floor', revealed: true })
  state.mechanics.positions['fighter-2'] = { x: 1, y: 2 }
  state.mechanics.resources['fighter-2'] = { indomitable: { current: 1, max: 1 } }
  state.enemies[0].inventory = [{
    id: 'bomb', name: 'Алхимическая бомба', type: 'consumable', quantity: 1,
    combat: { kind: 'thrown-area', normalRange: 20, radius: 5, damage: '2d6', damageType: 'fire', saveAbility: 'dex', saveDc: 15, halfOnSave: false },
  }]
  state.mechanics.combat = {
    active: true, round: 1, active_index: 0,
    initiative: [{ actor_id: 'enemy', total: 18 }, { actor_id: 'fighter', total: 12 }, { actor_id: 'fighter-2', total: 10 }],
    action_economy: {
      enemy: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
      fighter: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
      'fighter-2': { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
    },
  }
  const normalized = normalizeCampaignState(state)
  const service = dice([3, 3, 2, 3, 15])
  const first = openWindow(normalized, service, {
    command_type: 'MakeAreaAttack', actor_id: 'enemy', item_id: 'bomb', to: { x: 1, y: 1 }, server_authoritative: true,
  })
  assert.equal(first.waiting.mechanics.combat.reaction_window.actor_id, 'fighter')

  const accepted = resolveCommand({
    command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'indomitable', server_authoritative: true,
  }, first.waiting, { diceService: service, context: { serverAuthoritativeCombat: true } })
  const secondWaiting = applyAll(first.waiting, accepted.events)
  assert.equal(secondWaiting.mechanics.combat.reaction_window.actor_id, 'fighter-2')
  assert.equal(secondWaiting.players.find((player) => player.id === 'fighter').hp, 40)
  assert.equal(secondWaiting.players.find((player) => player.id === 'fighter-2').hp, 36)
  assert.equal(secondWaiting.mechanics.resources.fighter.indomitable.current, 1)
  assert.equal(accepted.events.some((event) => event.event_type === 'DamageApplied'), false)
  const publicWindow = campaignStateForViewer(secondWaiting, { role: 'player' }, 'fighter-2').mechanics.combat.reaction_window
  assert.equal('pending_indomitable_queue' in publicWindow, false)
  assert.equal('indomitable_decisions' in publicWindow, false)
  const publicOpenedEvent = mechanicsForViewer(accepted.events, { role: 'player' }, 'fighter-2')
    .find((event) => event.event_type === 'ReactionWindowOpened')
  assert.equal('pending_indomitable_queue' in publicOpenedEvent.payload, false)
  assert.equal('indomitable_decisions' in publicOpenedEvent.payload, false)

  const declined = resolveCommand({
    command_type: 'UseCombatAction', actor_id: 'fighter-2', action_id: 'decline-reaction', server_authoritative: true,
  }, secondWaiting, { diceService: service, context: { serverAuthoritativeCombat: true } })
  const after = applyAll(secondWaiting, declined.events)
  assert.equal(after.mechanics.combat.reaction_window, null)
  assert.equal(after.players.find((player) => player.id === 'fighter').hp, 40)
  assert.equal(after.players.find((player) => player.id === 'fighter-2').hp, 30)
  assert.equal(after.mechanics.resources.fighter.indomitable.current, 0)
  assert.equal(after.mechanics.resources['fighter-2'].indomitable.current, 1)
  assert.equal(declined.events.filter((event) => event.event_type === 'AreaAttackResolved').length, 1)
  assert.equal(declined.events.filter((event) => event.event_type === 'ItemConsumed').length, 1)
  assert.equal(declined.events.filter((event) => event.event_type === 'DamageApplied').length, 2)
  assert.equal(declined.events.filter((event) => event.event_type === 'DamageApplied' && event.payload.applied_amount > 0).length, 1)
  assert.deepEqual(replayEvents(secondWaiting, declined.events), after)
})

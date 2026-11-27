import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

const sword = {
  id: 'sword', name: 'Длинный меч', type: 'weapon', equipped: true, quantity: 1,
  combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 },
}
const floor = Array.from({ length: 12 * 12 }, (_, index) => ({
  x: index % 12, y: Math.floor(index / 12), type: 'floor', revealed: true,
}))

let serial = 0
function dice(values = []) {
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `reaction-continuation-roll-${++serial}`,
    now: () => '2026-09-21T12:00:00.000Z',
  })
}

function resolve(state, command, values = [], context = {}) {
  return resolveCommand({
    command_id: `reaction-continuation-command-${++serial}`,
    server_authoritative: true,
    ...command,
  }, state, {
    diceService: dice(values),
    context: { serverAuthoritativeCombat: true, ...context },
  })
}

function apply(state, result) {
  return result.events.reduce(applyGameEvent, state)
}

function restart(state) {
  return normalizeCampaignState(JSON.parse(JSON.stringify(state)))
}

function reactionState({
  known = ['shield'],
  enemyInventory = [sword],
  enemyAttack = { name: 'Меч', attack_modifier: 5, damage_expression: '1d8', damage_type: 'slashing', range_feet: 5 },
  enemyAt = { x: 2, y: 1 },
  heroClass = 'wizard',
  heroSubclass = undefined,
} = {}) {
  return normalizeCampaignState({
    sessionCode: 'REACTION-CONTINUATION-TEST',
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{
      id: 'hero', character: 'Герой', characterClass: heroClass, subclass: heroSubclass,
      level: 5, hp: 20, maxHp: 20, armor: 16, speed: 30, proficiency: 2,
      abilities: { str: 16, dex: 14, con: 14, int: 16, wis: 10, cha: 10 },
      knownSpellIds: known, preparedSpellIds: known, inventory: [sword], x: 1, y: 1,
    }],
    enemies: [{
      id: 'enemy', name: 'Враг', characterClass: 'fighter', level: 5, hp: 20, maxHp: 20,
      armor: 12, speed: 30, proficiency: 2,
      abilities: { str: 16, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
      inventory: enemyInventory, attack_profile: enemyAttack, alive: true, x: enemyAt.x, y: enemyAt.y,
    }],
    scene: { cells: floor },
    mechanics: {
      resources: { hero: { spell_slots_1: { current: 1, max: 1 } } },
      combat: {
        active: true, round: 1,
        initiative: [{ actor_id: 'enemy', total: 20 }, { actor_id: 'hero', total: 10 }],
        active_index: 1,
        action_economy: {
          enemy: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function openOpportunity(state, values = [12]) {
  return resolve(state, { command_type: 'MoveActor', actor_id: 'hero', to: { x: 4, y: 1 } }, values)
}

for (const scenario of [
  { name: 'Shield', known: ['shield'], action_id: 'cast:shield', continuationDice: [], expectedHp: 20 },
  { name: 'отказ от Shield', known: ['shield'], action_id: 'decline-reaction', continuationDice: [8], expectedHp: 9 },
]) {
  test(`автоматическая атака по возможности продолжает перемещение после ${scenario.name} и restart`, () => {
    const initial = reactionState({ known: scenario.known })
    const opened = openOpportunity(initial)
    const waiting = apply(initial, opened)
    assert.equal(waiting.mechanics.combat.reaction_window?.trigger, 'attack-shield-choice')
    assert.equal(waiting.players[0].x, 1, 'перемещение ждёт решения защитной реакции')
    assert.equal(waiting.mechanics.combat.reaction_window?.pending_command?.command_type, 'MoveActor')

    const restarted = restart(waiting)
    const response = resolve(restarted, {
      command_type: 'UseCombatAction', actor_id: 'hero', action_id: scenario.action_id,
    }, scenario.continuationDice)
    const final = apply(restarted, response)

    assert.equal(final.players[0].x, 4, 'исходная команда MoveActor должна завершиться после реакции')
    assert.equal(final.players[0].y, 1)
    assert.equal(final.mechanics.combat.reaction_window, null)
    assert.equal(final.mechanics.combat.action_economy.enemy.reaction, false, 'реакция NPC списывается один раз')
    assert.equal(final.mechanics.combat.action_economy.enemy.action, true)
    assert.equal(final.players[0].hp, scenario.expectedHp)
    assert.ok(response.events.some(event => event.event_type === 'ActorMoved'))
    assert.equal(response.events.filter(event => event.event_type === 'AttackResolved').length, 1)
  })
}

test('Поглощение стихий после атаки по возможности тоже сохраняет перемещение', () => {
  const initial = reactionState({
    known: ['absorb-elements'],
    enemyInventory: [],
    enemyAttack: { name: 'Огненный удар', attack_modifier: 5, damage_expression: '1d8', damage_type: 'fire', range_feet: 5 },
  })
  const opened = openOpportunity(initial)
  const waiting = restart(apply(initial, opened))
  assert.equal(waiting.mechanics.combat.reaction_window?.trigger, 'attack-protective-choice')
  assert.deepEqual(waiting.mechanics.combat.reaction_window?.action_ids, ['cast:absorb-elements'])

  const response = resolve(waiting, {
    command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'cast:absorb-elements',
  }, [8])
  const final = apply(waiting, response)

  assert.equal(final.players[0].x, 4)
  assert.equal(final.mechanics.combat.action_economy.enemy.reaction, false)
  assert.equal(final.players[0].hp, 16)
  assert.ok(final.mechanics.conditions.hero.some((condition) => condition.id === 'absorbing-element:fire'))
})

test('NPC выпускает заготовленный оружейный удар после restart, снимает заготовку и расходует реакцию', () => {
  const initial = reactionState({ known: ['shield'], enemyAt: { x: 3, y: 1 } })
  initial.mechanics.combat.active_index = 0

  const prepared = apply(initial, resolve(initial, {
    command_type: 'UseCombatAction', actor_id: 'enemy', action_id: 'ready-action',
    readied_trigger: 'enemy-approaches',
  }))
  assert.equal(prepared.mechanics.combat.readied.enemy?.readied_action_id, 'readied-attack')
  assert.equal(prepared.mechanics.combat.action_economy.enemy.action, false)

  const afterEnemyTurn = apply(prepared, resolve(prepared, { command_type: 'EndTurn', actor_id: 'enemy' }))
  const triggered = apply(afterEnemyTurn, resolve(afterEnemyTurn, {
    command_type: 'MoveActor', actor_id: 'hero', to: { x: 2, y: 1 },
  }))
  assert.equal(triggered.mechanics.combat.reaction_window?.trigger, 'readied')

  const restarted = restart(triggered)
  const release = resolve(restarted, {
    command_type: 'UseCombatAction', actor_id: 'enemy', action_id: 'readied-attack',
  }, [12])
  const waiting = apply(restarted, release)
  assert.equal(waiting.mechanics.combat.reaction_window?.trigger, 'attack-shield-choice')
  const response = resolve(restart(waiting), {
    command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'cast:shield',
  })
  const final = apply(waiting, response)

  assert.equal(final.mechanics.combat.readied.enemy, undefined)
  assert.equal(final.mechanics.combat.reaction_window, null)
  assert.equal(final.mechanics.combat.action_economy.enemy.reaction, false)
  assert.equal(final.mechanics.combat.action_economy.enemy.action, false)
  assert.equal(final.players[0].hp, 20)
  assert.ok(release.events.some(event => event.event_type === 'CombatActionUsed' && event.payload?.action_id === 'readied-attack'))
  assert.ok(response.events.some(event => event.event_type === 'AttackResolved' && event.payload?.reaction_attack === true))
})

test('Ответный удар после restart расходует реакцию, но сохраняет действие', () => {
  const initial = reactionState({ heroClass: 'fighter', heroSubclass: 'Мастер боевых искусств', known: [] })
  initial.mechanics.combat.active_index = 0
  const miss = resolve(initial, { command_type: 'MakeAttack', actor_id: 'enemy', target_id: 'hero' }, [1])
  const waiting = restart(apply(initial, miss))
  assert.ok(waiting.mechanics.combat.reaction_window?.action_ids.includes('riposte'))

  const response = resolve(waiting, { command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'riposte' }, [12, 8])
  const final = apply(waiting, response)

  assert.equal(final.mechanics.combat.reaction_window, null)
  assert.equal(final.mechanics.combat.action_economy.hero.reaction, false)
  assert.equal(final.mechanics.combat.action_economy.hero.action, true)
  assert.equal(final.enemies[0].hp, 16)
  assert.equal(final.mechanics.resources.hero.superiority_dice.current, 3)
  assert.ok(response.events.some(event => event.event_type === 'AttackResolved' && event.payload?.reaction_attack === true))
})

test('бегущий NPC остаётся жив до промаха по возможности, затем завершается; старое закрытие окна не меняет смысл', () => {
  const state = reactionState({ known: [] })
  state.mechanics.conditions.enemy = [{ id: 'fled', duration: 'until-next-turn' }]
  state.mechanics.combat.reaction_window = {
    id: 'legacy-flee-window', trigger: 'enemy-left-reach', actor_id: 'hero',
    source_actor_id: 'enemy', target_id: 'enemy', source_previous_position: { x: 2, y: 1 },
    action_ids: ['opportunity-attack'],
    action_options: [{ id: 'opportunity-attack', name: 'Атака по возможности', action_type: 'reaction', cost: 1 }],
  }
  assert.equal(state.enemies[0].alive, true)

  const miss = resolve(state, {
    command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'opportunity-attack',
  }, [1])
  const final = apply(state, miss)

  assert.equal(final.enemies[0].alive, false)
  assert.ok(final.mechanics.conditions.enemy.some((condition) => condition.id === 'fled'))
  assert.equal(final.mechanics.combat.reaction_window, null)
  assert.equal(miss.events.some(event => event.event_type === 'DamageApplied'), false)
  assert.equal(restart(final).enemies[0].alive, false)

  const legacy = reactionState({ known: [] })
  legacy.mechanics.conditions.enemy = [{ id: 'fled' }]
  legacy.mechanics.combat.reaction_window = {
    id: 'old-flee-window', trigger: 'enemy-left-reach', actor_id: 'hero', source_actor_id: 'enemy', target_id: 'enemy',
  }
  const afterLegacyClose = applyGameEvent(legacy, {
    event_type: 'ReactionWindowClosed', actor_id: 'hero', target_ids: ['hero'], payload: { id: 'old-flee-window' },
  })
  assert.equal(afterLegacyClose.enemies[0].alive, false, 'старое событие без defer_flee сохраняет прежний reducer')
})

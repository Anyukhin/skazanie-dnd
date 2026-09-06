import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { IntentParser } from '../server/intent-parser.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState, previewLongJumpAttack, previewSwingAttack, replayEvents, swingPropForText } from '../server/rules-engine.mjs'
import { addProp, createTacticalMap, legacyCellsFromTacticalMap, serializeTacticalMap, setCell } from '../server/tactical-map.mjs'

function battle() {
  return normalizeCampaignState({
    sessionCode: 'COMPOUND-MANEUVER', activePlayerId: 'hero', partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Ада', hp: 30, maxHp: 30, armor: 15, speed: 30,
      abilities: { str: 20, dex: 14, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [], x: 0, y: 1,
    }],
    enemies: [{ id: 'ogre', name: 'Огр', hp: 40, maxHp: 40, armor: 12, alive: true, x: 3, y: 1 }],
    scene: {
      title: 'Боевая площадка', location: 'Боевая площадка',
      cells: Array.from({ length: 18 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true })),
    },
    mechanics: {
      positions: { hero: { x: 0, y: 1 }, ogre: { x: 3, y: 1 } },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero' }, { actor_id: 'ogre' }],
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

test('составной long jump и удар получают маршрут, подтверждение и replay', async (t) => {
  const initial = battle()
  const text = 'Прыгаю и бью огра'
  const parsed = await new IntentParser().parse({ message: text, playerId: 'hero', visibleState: initial })
  assert.equal(parsed.free_action_kind, 'compound_maneuver')
  assert.deepEqual(parsed.targets, ['ogre'])

  const root = mkdtempSync(join(tmpdir(), 'skazanie-compound-maneuver-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const eventStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaignId: 'COMPOUND-MANEUVER', initialState: initial })
  const orchestrator = new GameOrchestrator({
    eventStore,
    rulesEngine: new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([18, 18, 18, 18]) }) }),
    narrator: { render: async () => { throw new Error('составной манёвр должен использовать детерминированный путь') } },
  })

  const input = {
    campaignId: 'COMPOUND-MANEUVER', playerId: 'hero', allowedActorIds: ['hero'],
    state: initial, message: text, idempotencyKey: 'compound-offer',
  }
  await assert.rejects(orchestrator.handle({ ...input, idempotencyKey: 'compound-forbidden', allowedActorIds: ['other'] }))
  const offered = await orchestrator.handle(input)
  assert.ok(offered.action_proposal, offered.narration)
  assert.ok(offered.action_proposal.path.length > 0)
  assert.deepEqual(offered.mechanics, [])
  assert.equal((await eventStore.load('COMPOUND-MANEUVER')).state_version, 0)

  const accepted = await orchestrator.handle({
    ...input, idempotencyKey: 'compound-accept', confirmedProposalId: offered.action_proposal.id,
  })
  assert.ok(accepted.mechanics.some((event) => event.event_type === 'ActorMoved'))
  assert.ok(accepted.mechanics.some((event) => event.event_type === 'AttackResolved'))
  assert.deepEqual(accepted.authoritative_state.mechanics.positions.hero, offered.action_proposal.to)
  assert.deepEqual(
    (await eventStore.replay('COMPOUND-MANEUVER', { useSnapshots: false })).state,
    accepted.authoritative_state,
  )
})

test('long jump отклоняется до коммита при стене, занятой траектории и нехватке движения', () => {
  const blocked = battle()
  blocked.scene.cells.find((cell) => cell.x === 1 && cell.y === 1).type = 'wall'
  assert.throws(() => previewLongJumpAttack(blocked, 'hero', 'ogre'), { code: 'JUMP_UNREACHABLE' })

  const occupied = battle()
  occupied.players.push({ id: 'ally', character: 'Бор', hp: 10, maxHp: 10, armor: 14, speed: 30, abilities: { str: 10 }, inventory: [], x: 2, y: 1 })
  occupied.partyMemberIds.push('ally')
  occupied.mechanics.positions.ally = { x: 2, y: 1 }
  occupied.mechanics.combat.initiative.splice(1, 0, { actor_id: 'ally' })
  occupied.mechanics.combat.action_economy.ally = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  assert.throws(() => previewLongJumpAttack(occupied, 'hero', 'ogre'), { code: 'JUMP_UNREACHABLE' })

  const spent = battle()
  spent.mechanics.combat.action_economy.hero.movement_spent = 25
  assert.throws(() => previewLongJumpAttack(spent, 'hero', 'ogre'), { code: 'JUMP_UNREACHABLE' })
})

test('разбег даёт полную дальность только после серверно зафиксированных 10 футов прямого движения', () => {
  const running = battle()
  running.players[0].abilities.str = 12
  running.players[0].x = 2
  running.enemies[0].x = 5
  running.mechanics.positions.hero = { x: 2, y: 1 }
  running.mechanics.positions.ogre = { x: 5, y: 1 }
  running.mechanics.combat.action_economy.hero.movement_spent = 10
  running.mechanics.combat.action_economy.hero.movement_path = [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }]
  assert.throws(() => previewLongJumpAttack(running, 'hero', 'ogre'), { code: 'JUMP_UNREACHABLE' })
  const route = previewLongJumpAttack(running, 'hero', 'ogre', { runningStart: true })
  assert.equal(route.movement_feet, 10)
  assert.deepEqual(route.to, { x: 4, y: 1 })
})

test('PHB 2014 герой после пяти футов движения может прыгнуть ещё на пять футов', () => {
  const state = battle()
  state.sessionCode = 'PLAY-ARES-FIX'
  state.ruleset_id = 'dnd_5e_2014'
  state.ruleset_version = '2014.1.0'
  state.enabled_rule_packs = ['dnd_5e_2014']
  state.players[0].character = 'Борин Люстролаз'
  state.players[0].speed = 25
  state.players[0].abilities.str = 15
  state.players[0].x = 9
  state.players[0].y = 5
  state.players[0].inventory = [{
    id: 'longsword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true,
    combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 },
  }]
  state.enemies[0].name = 'Гоблин-воин 1'
  state.enemies[0].x = 11
  state.enemies[0].y = 5
  state.scene.cells = Array.from({ length: 256 }, (_, index) => ({ x: index % 16, y: Math.floor(index / 16), type: 'floor', revealed: true }))
  state.mechanics.positions.hero = { x: 9, y: 5 }
  state.mechanics.positions.ogre = { x: 11, y: 5 }
  state.mechanics.combat.action_economy.hero.movement_spent = 5
  state.mechanics.combat.action_economy.hero.movement_path = [{ x: 9, y: 4 }, { x: 9, y: 5 }]
  const route = previewLongJumpAttack(state, 'hero', 'ogre')
  assert.equal(route.movement_feet, 5)
  assert.deepEqual(route.to, { x: 10, y: 5 })
})

function swingBattle() {
  const state = battle()
  const map = createTacticalMap({
    width: 6, height: 3, seed: 'swing-room', locationId: 'swing-room',
    fill: { passable: true, revealed: true, material: 'wood' },
  })
  addProp(map, { id: 'prop-chandelier', assetId: 'chandelier', x: 0.5, y: 0.5, footprint: [] })
  state.scene = { ...state.scene, title: 'Зал', location: 'Зал', map: serializeTacticalMap(map) }
  return normalizeCampaignState(state)
}

test('реальная люстра даёт bounded ruling, swing preview и обычный удар', async (t) => {
  const initial = swingBattle()
  const root = mkdtempSync(join(tmpdir(), 'skazanie-swing-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const eventStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaignId: 'SWING-MANEUVER', initialState: initial })
  const orchestrator = new GameOrchestrator({
    eventStore,
    rulesEngine: new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([18, 18, 18, 18]) }) }),
    narrator: { render: async () => { throw new Error('swing uses committed deterministic mechanics') } },
  })
  const input = {
    campaignId: 'SWING-MANEUVER', playerId: 'hero', allowedActorIds: ['hero'], state: initial,
    message: 'Вспрыгиваю на люстру и бью огра', idempotencyKey: 'swing-offer',
  }
  const offered = await orchestrator.handle(input)
  assert.ok(offered.action_proposal)
  assert.equal(offered.action_proposal.ruling.difficulty, 12)
  assert.match(offered.action_proposal.consequence, /провал|ничком/u)
  assert.deepEqual(offered.mechanics, [])

  const accepted = await orchestrator.handle({ ...input, idempotencyKey: 'swing-accept', confirmedProposalId: offered.action_proposal.id })
  assert.ok(accepted.mechanics.some((event) => event.event_type === 'AbilityCheckResolved'))
  assert.ok(accepted.mechanics.some((event) => event.event_type === 'SwingResolved' && event.payload.success === true))
  assert.ok(accepted.mechanics.some((event) => event.event_type === 'ActorMoved'))
  assert.ok(accepted.mechanics.some((event) => event.event_type === 'AttackResolved'))
  assert.match(accepted.narration, /удерживается за люстру и продолжает манёвр/u)
  assert.match(accepted.narration, /перемещается на \d+ фт\./u)
  assert.match(accepted.narration, /атакует Огр: (?:попадание|промах)/u)
  assert.doesNotMatch(accepted.narration, /athletics|СЛ|КД|ОЗ/iu)
  assert.equal(accepted.mechanics.find((event) => event.event_type === 'SwingResolved').house_rule_id, 'skazanie:scene-swing-v1')
  assert.equal(accepted.mechanics.find((event) => event.event_type === 'DamageApplied')?.payload.item_damage_rider, undefined)
  assert.deepEqual((await eventStore.replay('SWING-MANEUVER', { useSnapshots: false })).state, accepted.authoritative_state)
  const replayed = await orchestrator.handle({ ...input, idempotencyKey: 'swing-accept', confirmedProposalId: offered.action_proposal.id })
  assert.equal(replayed.idempotent_replay, true)
  assert.equal(replayed.narration, accepted.narration)
})

test('провал swing — это committed prone без движения и без неподтверждённого удара', () => {
  const initial = swingBattle()
  const route = previewSwingAttack(initial, 'hero', 'ogre', 'prop-chandelier')
  const rulesEngine = new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([1]) }) })
  assert.throws(
    () => rulesEngine.resolve({ ...route.commands[0], house_rule_id: 'fake:swing-policy' }, initial, { allowedActorIds: ['hero'] }),
    { code: 'SWING_POLICY_REQUIRED' },
  )
  const result = rulesEngine.resolvePlan({ maneuver: 'swing_attack', proposed_commands: [
    { command_type: 'DeclareAction', actor_id: 'hero', action: 'Вспрыгиваю на люстру и бью огра' },
    ...route.commands,
  ] }, initial, { allowedActorIds: ['hero'] })
  assert.ok(result.events.some((event) => event.event_type === 'SwingResolved' && event.payload.success === false))
  assert.ok(result.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'prone'))
  assert.equal(result.events.some((event) => event.event_type === 'ActorMoved'), false)
  assert.equal(result.events.some((event) => event.event_type === 'AttackResolved'), false)
  const replayed = replayEvents(initial, result.events)
  assert.equal(replayed.mechanics.combat.action_economy.hero.action, false)
  assert.ok(replayed.mechanics.conditions.hero.some((condition) => condition.id === 'prone'))
})

test('прыжковые режимы не исполняются внутренней командой вне боя', () => {
  const state = battle()
  state.mechanics.combat.active = false
  const rulesEngine = new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([18]) }) })
  for (const movementMode of ['long_jump', 'swing']) {
    assert.throws(() => rulesEngine.resolve({
      command_type: 'MoveActor', actor_id: 'hero', to: { x: 1, y: 1 },
      movement_mode: movementMode, swing_prop_id: movementMode === 'swing' ? 'prop-chandelier' : undefined,
      house_rule_id: movementMode === 'swing' ? 'skazanie:scene-swing-v1' : undefined,
      server_authoritative: true,
    }, state, { allowedActorIds: ['hero'] }), { code: 'COMBAT_REQUIRED' })
  }
})

test('выбор люстры ограничен раскрытым текущим этажом и публичной опорой', () => {
  const state = swingBattle()
  const map = createTacticalMap({
    width: 6, height: 3, seed: 'swing-two', locationId: 'swing-two',
    fill: { passable: true, revealed: true, material: 'wood' },
  })
  addProp(map, { id: 'prop-visible-chandelier', assetId: 'chandelier', x: 0.5, y: 0.5, footprint: [] })
  addProp(map, { id: 'prop-hidden-chandelier', assetId: 'chandelier', x: 4.5, y: 0.5, footprint: [] })
  setCell(map, 4, 0, { revealed: false })
  state.scene.cells = legacyCellsFromTacticalMap(map)
  state.scene.map = serializeTacticalMap(map)
  const visibleOnly = swingPropForText(state, 'Вспрыгиваю на люстру и бью огра')
  assert.equal(visibleOnly.id, 'prop-visible-chandelier')

  setCell(map, 4, 0, { revealed: true })
  state.scene.cells = legacyCellsFromTacticalMap(map)
  state.scene.map = serializeTacticalMap(map)
  assert.throws(() => swingPropForText(state, 'Вспрыгиваю на люстру и бью огра'), (error) => {
    assert.equal(error.code, 'SWING_PROP_AMBIGUOUS')
    assert.match(error.message, /люстра у опоры/u)
    assert.doesNotMatch(error.message, /prop-visible|prop-hidden/u)
    return true
  })
  assert.equal(swingPropForText(state, 'Вспрыгиваю на люстру 4,0 и бью огра').id, 'prop-hidden-chandelier')
})

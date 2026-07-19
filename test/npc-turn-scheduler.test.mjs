import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { SRD_5_2_1_MONSTER_ALLOWLIST } from '../server/encounter-assembler.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { NpcControllerAgent, commandsForMoraleDecision } from '../server/npc-controller.mjs'
import { planNpcTurn, runNpcTurnScheduler } from '../server/npc-turn-scheduler.mjs'
import { RULE_IDS, RulesEngine, RulesValidationError, applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

function cells(width = 9, height = 3) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
    type: 'floor',
    revealed: true,
  }))
}

function fixture(overrides = {}) {
  const state = normalizeCampaignState({
    sessionCode: 'NPC-UNIT',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 2,
      abilities: { str: 16, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
      attackBonus: 7, damageDice: 6, damageBonus: 2, x: 0, y: 1,
    }],
    enemies: [{
      id: 'wolf', hp: 20, maxHp: 20, armor: 11, speed: 10, attackBonus: 4, damageDice: 4, damageBonus: 1,
      abilities: { str: 14, dex: 12, con: 12, int: 4, wis: 12, cha: 6 }, x: 3, y: 1, alive: true,
    }],
    scene: { turn: 1, cells: cells() },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'wolf', total: 10 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          wolf: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
  return normalizeCampaignState({ ...state, ...overrides })
}

function dice(values) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `roll-${++id}`, now: () => '2026-07-12T00:00:00.000Z' })
}

function boundedDice() {
  let id = 0
  return new DiceService({
    rng: { randint: (minimum, maximum) => maximum === 20 ? 15 : Math.min(maximum, 3) },
    idFactory: () => `bounded-roll-${++id}`,
    now: () => '2026-07-12T00:00:00.000Z',
  })
}

test('server-authoritative attack ignores client combat numbers and uses persisted profile', () => {
  const state = fixture()
  state.enemies[0].x = 1
  state.mechanics.positions.wolf = { x: 1, y: 1 }
  const result = resolveCommand({
    command_type: 'MakeAttack', actor_id: 'hero', target_id: 'wolf', server_authoritative: true,
    attack_modifier: 100, armor_class: 0, damage_expression: '100d100+10000', damage_type: 'force',
  }, state, { diceService: dice([10, 4]), context: { serverAuthoritativeCombat: true } })
  const attack = result.events.find((event) => event.event_type === 'AttackResolved')
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(attack.payload.modifier, 7)
  assert.equal(attack.payload.armor_class, 11)
  assert.equal(attack.payload.damage_expression, '1d6+2')
  assert.equal(attack.payload.damage_type, 'slashing')
  assert.equal(damage.payload.raw_amount, 6)
  assert.equal(result.command.attack_modifier, 7)
  assert.equal(result.command.damage_expression, '1d6+2')
  assert.ok(damage.source_rule_ids.includes(RULE_IDS.damage))
})

test('server-authoritative attack cannot bypass combat initiative', () => {
  const state = fixture({ mechanics: { combat: { active: false } } })
  state.enemies[0].x = 1
  state.mechanics.positions.wolf = { x: 1, y: 1 }
  assert.throws(() => resolveCommand({
    command_type: 'MakeAttack', actor_id: 'hero', target_id: 'wolf', server_authoritative: true,
  }, state, { diceService: dice([20, 6]), context: { serverAuthoritativeCombat: true } }),
  (error) => error instanceof RulesValidationError && error.code === 'COMBAT_NOT_ACTIVE')
})

test('movement path and cumulative speed are enforced from authoritative state', () => {
  let state = fixture()
  state.enemies[0].x = 8
  state.mechanics.positions.wolf = { x: 8, y: 1 }
  const first = resolveCommand({ command_type: 'MoveActor', actor_id: 'hero', to: { x: 6, y: 1 }, server_authoritative: true }, state, {
    diceService: dice([]), context: { serverAuthoritativeCombat: true },
  })
  state = first.events.reduce(applyGameEvent, state)
  assert.equal(state.mechanics.combat.action_economy.hero.movement_spent, 30)
  assert.deepEqual(state.mechanics.positions.hero, { x: 6, y: 1 })
  assert.throws(() => resolveCommand({ command_type: 'MoveActor', actor_id: 'hero', to: { x: 5, y: 1 }, server_authoritative: true }, state, {
    diceService: dice([]), context: { serverAuthoritativeCombat: true },
  }), (error) => error instanceof RulesValidationError && error.code === 'SPEED_EXCEEDED')
})

test('authoritative movement rejects unrevealed and unsupported terrain', () => {
  const state = fixture()
  state.scene.cells = state.scene.cells.map((cell) => cell.x === 1 && cell.y === 1 ? { ...cell, type: 'water' } : cell)
  assert.throws(() => resolveCommand({
    command_type: 'MoveActor', actor_id: 'hero', to: { x: 1, y: 1 }, server_authoritative: true,
  }, state, { diceService: dice([]), context: { serverAuthoritativeCombat: true } }),
  (error) => error instanceof RulesValidationError && error.code === 'INVALID_DESTINATION')
})

test('actor can leave unsupported terrain but cannot enter it again', () => {
  let state = fixture()
  state.scene.cells = state.scene.cells.map((cell) => cell.x === 0 && cell.y === 1 ? { ...cell, type: 'water' } : cell)
  const escaped = resolveCommand({
    command_type: 'MoveActor', actor_id: 'hero', to: { x: 0, y: 0 }, server_authoritative: true,
  }, state, { diceService: dice([]), context: { serverAuthoritativeCombat: true } })
  state = escaped.events.reduce(applyGameEvent, state)
  assert.equal(escaped.events[0].payload.movement_spent, 5)
  assert.deepEqual(state.mechanics.positions.hero, { x: 0, y: 0 })
  assert.throws(() => resolveCommand({
    command_type: 'MoveActor', actor_id: 'hero', to: { x: 0, y: 1 }, server_authoritative: true,
  }, state, { diceService: dice([]), context: { serverAuthoritativeCombat: true } }),
  (error) => error instanceof RulesValidationError && error.code === 'INVALID_DESTINATION')
})

test('NPC scheduler moves, attacks and ends turns until control returns to a living PC', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-npc-turn-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const state = fixture()
  state.mechanics.combat.active_index = 1
  const eventStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaign_id: 'NPC-UNIT', initial_state: state })
  let creativeCalls = 0
  const result = await runNpcTurnScheduler({
    campaignId: 'NPC-UNIT',
    eventStore,
    rulesEngine: new RulesEngine({ diceService: dice([15, 3]) }),
    npcController: { decide: async () => { creativeCalls += 1; return { disposition: 'surrender', provider: 'test' } } },
  })
  assert.equal(creativeCalls, 0)
  assert.equal(result.turns.length, 1)
  assert.deepEqual(result.turns[0].commands, ['MoveActor', 'MakeAttack', 'EndTurn'])
  assert.deepEqual([result.state.enemies[0].x, result.state.enemies[0].y], [1, 1])
  assert.equal(result.state.players[0].hp, 26)
  assert.equal(result.state.activePlayerId, 'hero')
  assert.equal(result.state.tacticalTurn.actorId, 'hero')
  assert.equal(result.state.tacticalTurn.movementSpent, 0)
  assert.deepEqual(result.events.filter((event) => event.actor_id === 'wolf').map((event) => event.event_type), [
    'ActorMoved', 'AttackResolved', 'DieRolled', 'DamageApplied', 'TurnEnded', 'TurnStarted',
  ])
})

test('NPC creative controller is called once at the morale threshold and the server applies surrender safely', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-npc-morale-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const state = fixture()
  state.mechanics.combat.active_index = 1
  state.enemies[0].hp = 5
  let creativeCalls = 0
  const eventStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaign_id: 'NPC-MORALE', initial_state: state })
  const result = await runNpcTurnScheduler({
    campaignId: 'NPC-MORALE', eventStore,
    rulesEngine: new RulesEngine({ diceService: dice([]) }),
    npcController: {
      async decide() {
        creativeCalls += 1
        return { disposition: 'surrender', reaction: 'Волк прижимается к земле.', provider: 'fake-agent' }
      },
    },
  })
  assert.equal(creativeCalls, 1)
  assert.deepEqual(result.turns[0].commands, ['AddCondition'])
  assert.equal(result.turns[0].creative_decision.disposition, 'surrender')
  assert.equal(result.state.enemies[0].alive, false)
  assert.equal(result.state.enemies[0].hp, 5)
  assert.ok(result.state.mechanics.conditions.wolf.some((condition) => condition.id === 'surrendered'))
  assert.equal(result.state.mechanics.combat.active, false)
  assert.ok(result.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'surrendered'))
})

test('deterministic NPC morale keeps undead fighting and makes beasts flee', async () => {
  const controller = new NpcControllerAgent()
  for (const [kind, expected] of [['волк', 'flee'], ['зомби', 'fight']]) {
    const state = fixture({ campaign_id: `NPC-MORALE-${expected}`, sessionCode: `NPC-MORALE-${expected}` })
    state.enemies[0] = { ...state.enemies[0], name: kind, kind, hp: 5, maxHp: 20 }
    const decision = await controller.decide({ state, enemyId: 'wolf' })
    assert.equal(decision.disposition, expected)
    assert.equal(decision.npc_id, 'wolf')
    assert.equal(decision.provider, 'deterministic-morale-fallback')
  }
})

test('NPC controller ignores forged identity and bounds creative output', async () => {
  const state = fixture({ campaign_id: 'NPC-UNTRUSTED', sessionCode: 'NPC-UNTRUSTED' })
  state.enemies[0] = { ...state.enemies[0], name: 'волк', kind: 'зверь', hp: 5, maxHp: 20 }
  const controller = new NpcControllerAgent({
    llmClient: {
      async completeJson() {
        return { npc_id: 'hero', disposition: 'surrender', reaction: `line one\n${'x'.repeat(400)}`, confidence: 4 }
      },
    },
  })
  const decision = await controller.decide({ state, enemyId: 'wolf' })
  assert.equal(decision.npc_id, 'wolf')
  assert.equal(decision.disposition, 'surrender')
  assert.equal(decision.reaction.includes('\n'), false)
  assert.equal(decision.reaction.length, 240)
  assert.equal(decision.confidence, 1)
})

test('fleeing NPC remains a valid opportunity-attack target until the reaction is resolved', () => {
  const state = fixture()
  state.enemies[0] = { ...state.enemies[0], hp: 5, maxHp: 20, speed: 30, x: 1, y: 1 }
  state.mechanics.positions.wolf = { x: 1, y: 1 }
  state.mechanics.combat.active_index = 1
  const commands = commandsForMoraleDecision(state, 'wolf', { disposition: 'flee' })
  const result = new RulesEngine({ diceService: boundedDice() }).resolvePlan({ commands }, state, {
    isAdmin: true,
    isNpcScheduler: true,
    serverAuthoritativeCombat: true,
  })
  const awaitingReaction = result.events.reduce(applyGameEvent, state)
  assert.ok(awaitingReaction.mechanics.conditions.wolf.some((condition) => condition.id === 'fled'))
  assert.equal(awaitingReaction.enemies[0].alive, true)
  assert.equal(awaitingReaction.mechanics.combat.reaction_window?.trigger, 'enemy-left-reach')

  const reaction = resolveCommand({
    command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'opportunity-attack', server_authoritative: true,
  }, awaitingReaction, { diceService: boundedDice(), context: { serverAuthoritativeCombat: true } })
  const afterReaction = reaction.events.reduce(applyGameEvent, awaitingReaction)
  assert.equal(afterReaction.mechanics.combat.reaction_window, null)
  assert.equal(afterReaction.enemies[0].alive, false)
})

test('every approved monster can plan and resolve a nearby and distant turn', () => {
  for (const [catalogId, block] of Object.entries(SRD_5_2_1_MONSTER_ALLOWLIST)) {
    for (const enemyX of [1, 6]) {
      const enemyId = `catalog-${catalogId.split(':').at(-1)}`
      const state = fixture()
      state.enemies = [{
        id: enemyId,
        name: block.name,
        hp: block.hp,
        maxHp: block.hp,
        armor: block.armor,
        speed: block.speed,
        abilities: block.abilities,
        traits: block.traits,
        action_profiles: block.action_profiles,
        attack_profile: block.action_profiles[0],
        x: enemyX,
        y: 1,
        alive: true,
      }]
      state.mechanics.positions = { hero: { x: 0, y: 1 }, [enemyId]: { x: enemyX, y: 1 } }
      state.mechanics.encounter = { enemy_ids: [enemyId] }
      state.mechanics.combat.initiative = [{ actor_id: enemyId, total: 20 }, { actor_id: 'hero', total: 10 }]
      state.mechanics.combat.active_index = 0
      state.mechanics.combat.action_economy = {
        [enemyId]: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
      }
      const commands = planNpcTurn(state, enemyId)
      assert.equal(commands.at(-1)?.command_type, 'EndTurn', `${catalogId} at x=${enemyX}`)
      assert.doesNotThrow(() => new RulesEngine({ diceService: boundedDice() }).resolvePlan({ commands }, state, {
        isAdmin: true,
        isNpcScheduler: true,
        serverAuthoritativeCombat: true,
      }), `${catalogId} at x=${enemyX}`)
    }
  }
})

test('NPC prefers a reachable target over a geometrically closer unreachable one', () => {
  const state = fixture()
  state.players.push({
    ...state.players[0], id: 'stranded', hp: 20, maxHp: 20, x: 2, y: 1,
  })
  state.partyMemberIds.push('stranded')
  state.mechanics.positions.stranded = { x: 2, y: 1 }
  state.scene.cells = state.scene.cells.map((cell) => cell.x === 2 && cell.y === 1 ? { ...cell, type: 'water' } : cell)
  state.enemies[0].x = 6
  state.enemies[0].y = 1
  state.mechanics.positions.wolf = { x: 6, y: 1 }
  const commands = planNpcTurn(state, 'wolf')
  assert.equal(commands[0].command_type, 'MoveActor')
  assert.equal(commands.at(-1).command_type, 'EndTurn')
})

test('giant spider opens with Web and cannot reuse its limited action', () => {
  const block = SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:giant-spider']
  let state = fixture()
  state.enemies = [{
    id: 'spider', name: block.name, hp: block.hp, maxHp: block.hp, armor: block.armor, speed: block.speed,
    abilities: block.abilities, traits: block.traits, action_profiles: block.action_profiles,
    attack_profile: block.action_profiles[0], x: 6, y: 1, alive: true,
  }]
  state.mechanics.positions = { ...state.mechanics.positions, spider: { x: 6, y: 1 } }
  delete state.mechanics.positions.wolf
  state.mechanics.encounter = { enemy_ids: ['spider'] }
  state.mechanics.combat.initiative = [{ actor_id: 'spider', total: 20 }, { actor_id: 'hero', total: 10 }]
  state.mechanics.combat.active_index = 0
  state.mechanics.combat.action_economy = { spider: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } }

  const plan = planNpcTurn(state, 'spider')
  assert.equal(plan[0].command_type, 'MakeAttack')
  assert.equal(plan[0].action_id, 'web')
  const result = resolveCommand({ ...plan[0], server_authoritative: true }, state, { diceService: dice([12]), context: { isNpcScheduler: true, serverAuthoritativeCombat: true } })
  state = result.events.reduce(applyGameEvent, state)
  assert.ok(state.mechanics.conditions.hero.some((condition) => condition.id === 'restrained'))
  assert.ok(state.mechanics.conditions.spider.some((condition) => condition.id === 'monster-action-used:web'))
  const laterPlan = planNpcTurn(state, 'spider')
  assert.notEqual(laterPlan.find((command) => command.command_type === 'MakeAttack')?.action_id, 'web')
})

test('pack tactics grants advantage and wolf bite can knock a hero prone', () => {
  const block = SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:wolf']
  const state = fixture()
  state.enemies = [
    { id: 'alpha', name: block.name, hp: 11, maxHp: 11, armor: 12, speed: 40, abilities: block.abilities, traits: block.traits, action_profiles: block.action_profiles, attack_profile: block.action_profiles[0], x: 1, y: 1, alive: true },
    { id: 'packmate', name: block.name, hp: 11, maxHp: 11, armor: 12, speed: 40, abilities: block.abilities, traits: block.traits, action_profiles: block.action_profiles, attack_profile: block.action_profiles[0], x: 0, y: 0, alive: true },
  ]
  state.mechanics.positions = { hero: { x: 0, y: 1 }, alpha: { x: 1, y: 1 }, packmate: { x: 0, y: 0 } }
  state.mechanics.encounter = { enemy_ids: ['alpha', 'packmate'] }
  state.mechanics.combat.initiative = [{ actor_id: 'alpha', total: 20 }, { actor_id: 'hero', total: 10 }, { actor_id: 'packmate', total: 5 }]
  state.mechanics.combat.active_index = 0
  state.mechanics.combat.action_economy = { alpha: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } }
  const result = resolveCommand({ command_type: 'MakeAttack', actor_id: 'alpha', target_id: 'hero', action_id: 'bite', server_authoritative: true }, state, { diceService: dice([5, 15, 3, 5]), context: { isNpcScheduler: true, serverAuthoritativeCombat: true } })
  const attack = result.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(attack.payload.mode, 'advantage')
  assert.equal(attack.payload.pack_tactics, true)
  const after = result.events.reduce(applyGameEvent, state)
  assert.ok(after.mechanics.conditions.hero.some((condition) => condition.id === 'prone'))
})

test('spider bite resolves its Constitution save and poison damage', () => {
  const block = SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:giant-wolf-spider']
  const state = fixture()
  state.enemies = [{ id: 'spider', name: block.name, hp: 11, maxHp: 11, armor: 13, speed: 40, abilities: block.abilities, traits: block.traits, action_profiles: block.action_profiles, attack_profile: block.action_profiles[0], x: 1, y: 1, alive: true }]
  state.mechanics.positions = { hero: { x: 0, y: 1 }, spider: { x: 1, y: 1 } }
  state.mechanics.encounter = { enemy_ids: ['spider'] }
  state.mechanics.combat.initiative = [{ actor_id: 'spider', total: 20 }, { actor_id: 'hero', total: 10 }]
  state.mechanics.combat.active_index = 0
  state.mechanics.combat.action_economy = { spider: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } }
  const result = resolveCommand({ command_type: 'MakeAttack', actor_id: 'spider', target_id: 'hero', action_id: 'bite', server_authoritative: true }, state, { diceService: dice([15, 3, 5, 2, 3]), context: { isNpcScheduler: true, serverAuthoritativeCombat: true } })
  const save = result.events.find((event) => event.event_type === 'SavingThrowResolved')
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(save.payload.ability, 'con')
  assert.equal(save.payload.success, false)
  assert.equal(damage.payload.raw_amount, 11)
})

test('undead fortitude can leave a zombie at one hit point', () => {
  const block = SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:zombie']
  const state = fixture()
  state.enemies = [{ id: 'zombie', name: block.name, hp: 5, maxHp: block.hp, armor: block.armor, speed: block.speed, abilities: block.abilities, traits: block.traits, action_profiles: block.action_profiles, attack_profile: block.action_profiles[0], x: 1, y: 1, alive: true }]
  state.mechanics.positions = { hero: { x: 0, y: 1 }, zombie: { x: 1, y: 1 } }
  state.mechanics.encounter = { enemy_ids: ['zombie'] }
  state.mechanics.combat.initiative = [{ actor_id: 'hero', total: 20 }, { actor_id: 'zombie', total: 10 }]
  state.mechanics.combat.active_index = 0
  const result = resolveCommand({ command_type: 'MakeAttack', actor_id: 'hero', target_id: 'zombie', server_authoritative: true }, state, { diceService: dice([15, 6, 20]), context: { serverAuthoritativeCombat: true } })
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(damage.payload.undead_fortitude, true)
  assert.equal(damage.payload.hp_after, 1)
  assert.equal(result.events.some((event) => event.event_type === 'HitPointsReducedToZero'), false)
})

test('scheduler closes combat automatically when the last enemy is defeated', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-npc-terminal-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const state = fixture()
  state.enemies[0].hp = 0
  state.enemies[0].alive = false
  const eventStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaign_id: 'NPC-TERMINAL', initial_state: state })
  const result = await runNpcTurnScheduler({
    campaignId: 'NPC-TERMINAL', eventStore,
    rulesEngine: new RulesEngine({ diceService: dice([]) }),
    advanceNpc: false,
  })
  assert.equal(result.state.mechanics.combat.active, false)
  assert.equal(result.turns[0].kind, 'combat-end')
  assert.equal(result.turns[0].reason, 'enemies_defeated')
  assert.equal(result.events.at(-1).event_type, 'CombatEnded')
})

test('scheduler treats a living enemy knocked unconscious at 1 HP as defeated in combat', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-npc-knockout-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const state = fixture()
  state.enemies[0].hp = 1
  state.enemies[0].alive = true
  state.mechanics.conditions.wolf = [{ id: 'unconscious' }]
  state.mechanics.resting.wolf = { kind: 'short', reason: 'knockout', recovery_minutes_remaining: 60 }
  const eventStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaign_id: 'NPC-KNOCKOUT', initial_state: state })
  const result = await runNpcTurnScheduler({
    campaignId: 'NPC-KNOCKOUT', eventStore,
    rulesEngine: new RulesEngine({ diceService: dice([]) }),
    advanceNpc: false,
  })
  assert.equal(result.state.mechanics.combat.active, false)
  assert.equal(result.turns[0].kind, 'combat-end')
  assert.equal(result.turns[0].reason, 'enemies_defeated')
  assert.equal(result.state.enemies[0].hp, 1)
  assert.equal(result.state.enemies[0].alive, true)
  assert.equal(result.state.mechanics.resting.wolf.reason, 'knockout')
})

test('scheduler closes combat as party defeated when every hero is already dead', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-npc-party-defeated-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const state = fixture()
  state.players[0].hp = 0
  state.players[0].alive = false
  state.mechanics.death.heroes.hero = { status: 'dead' }
  state.mechanics.death.campaign_status = 'party_defeated'
  const eventStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaign_id: 'NPC-PARTY-DEFEATED', initial_state: state })
  const result = await runNpcTurnScheduler({
    campaignId: 'NPC-PARTY-DEFEATED', eventStore,
    rulesEngine: new RulesEngine({ diceService: dice([]) }),
  })
  assert.equal(result.state.mechanics.combat.active, false)
  assert.equal(result.turns[0].kind, 'combat-end')
  assert.equal(result.turns[0].reason, 'party_defeated')
  assert.equal(result.events.at(-1).event_type, 'CombatEnded')
})

test('scheduler keeps initiative running for death saves, ends combat and wakes an incapacitated stable party after 1d4 hours', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-npc-death-saves-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const state = fixture()
  state.players[0].hp = 0
  state.enemies[0].hp = 0
  state.enemies[0].alive = false
  state.mechanics.conditions.hero = [{ id: 'unconscious' }]
  state.mechanics.death.saving_throws.hero = { successes: 0, failures: 0, stable: false }
  const eventStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaign_id: 'NPC-DEATH-SAVES', initial_state: state })
  const result = await runNpcTurnScheduler({
    campaignId: 'NPC-DEATH-SAVES', eventStore,
    rulesEngine: new RulesEngine({ diceService: dice([10, 10, 10, 3]) }),
  })
  assert.equal(result.state.mechanics.combat.active, false)
  assert.equal(result.turns.find((turn) => turn.kind === 'combat-end')?.reason, 'enemies_defeated')
  assert.equal(result.turns.filter((turn) => turn.kind === 'stable-recovery').length, 3)
  assert.equal(result.state.players[0].hp, 1)
  assert.equal(result.state.mechanics.death.saving_throws.hero, undefined)
  assert.equal(result.events.filter((event) => event.event_type === 'DeathSavingThrowRolled').length, 3)
  assert.equal(result.events.filter((event) => event.event_type === 'TimeAdvanced').length, 3)
  assert.equal(result.events.some((event) => event.event_type === 'HealingApplied' && event.payload.reason === 'stable-recovery-after-1d4-hours'), true)
  assert.equal(result.events.some((event) => event.event_type === 'HeroDied'), false)

  const reopened = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  const replayed = await reopened.load('NPC-DEATH-SAVES')
  assert.deepEqual(replayed.state.mechanics.death, result.state.mechanics.death)
  assert.equal(replayed.state.players[0].hp, 1)
  assert.equal(replayed.state.mechanics.combat.active, false)
})

test('scheduler does not fast-forward stable recovery while living enemies control the battlefield', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-npc-hostile-incapacitation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const state = fixture()
  state.players[0].hp = 0
  state.mechanics.conditions.hero = [{ id: 'unconscious' }]
  state.mechanics.death.saving_throws.hero = { successes: 0, failures: 0, stable: false }
  const eventStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaign_id: 'NPC-HOSTILE-INCAPACITATION', initial_state: state })
  const result = await runNpcTurnScheduler({
    campaignId: 'NPC-HOSTILE-INCAPACITATION', eventStore,
    rulesEngine: new RulesEngine({ diceService: dice([10, 10, 10]) }),
  })
  assert.equal(result.turns.find((turn) => turn.kind === 'combat-end')?.reason, 'party_incapacitated')
  assert.equal(result.turns.some((turn) => turn.kind === 'stable-recovery'), false)
  assert.equal(result.events.some((event) => event.event_type === 'TimeAdvanced'), false)
  assert.equal(result.state.players[0].hp, 0)
  assert.deepEqual(result.state.mechanics.death.saving_throws.hero, { successes: 0, failures: 0, stable: true })
})

test('scheduler pauses without committing while a player reaction is pending', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-npc-reaction-pause-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const state = fixture()
  state.mechanics.combat.active_index = 1
  state.mechanics.combat.reaction_window = {
    id: 'reaction:test', trigger: 'enemy-left-reach', actor_id: 'hero', source_actor_id: 'wolf',
    target_id: 'wolf', action_ids: ['opportunity-attack'], action_options: [],
  }
  const eventStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaign_id: 'NPC-REACTION-PAUSE', initial_state: state })
  const result = await runNpcTurnScheduler({
    campaignId: 'NPC-REACTION-PAUSE', eventStore,
    rulesEngine: new RulesEngine({ diceService: dice([]) }),
  })
  assert.deepEqual(result.turns, [])
  assert.deepEqual(result.events, [])
  assert.equal(result.state_version, 0)
  assert.equal(result.state.mechanics.combat.reaction_window.id, 'reaction:test')
})

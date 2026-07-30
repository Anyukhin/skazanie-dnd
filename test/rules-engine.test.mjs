import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  RULE_IDS, RulesEngine, RulesValidationError, abilityModifier, applyGameEvent,
  hasClearTrajectory, normalizeCampaignState, replayEvents, resolveCommand, resolveCommands, validateCommand,
} from '../server/rules-engine.mjs'
import { loadRulePack } from '../server/rule-pack.mjs'

function stateFixture() {
  return normalizeCampaignState({
    sessionCode: 'TEST-1',
    players: [
      { id: 'hero', hp: 12, maxHp: 20, armor: 14, proficiency: 2, abilities: { str: 16, dex: 14, con: 12, int: 10, wis: 10, cha: 8 }, inventory: [] },
      { id: 'goblin', hp: 9, maxHp: 9, armor: 13, abilities: { str: 8, dex: 14, con: 10, int: 8, wis: 8, cha: 8 }, inventory: [] },
    ],
    mechanics: {
      temporary_hp: { hero: 3 },
      resources: { hero: { spell_slots: { current: 2, max: 3 } } },
      defenses: { hero: { resistances: ['fire'], vulnerabilities: ['cold'], immunities: ['poison'] } },
    },
  })
}

function dice(values) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `roll-${++id}`, now: () => '2026-01-01T00:00:00.000Z' })
}

test('нормализация добавляет ruleset/state version без потери legacy-полей', () => {
  const state = normalizeCampaignState({ campaign: 'Старая кампания', players: [{ id: 'a', hp: 2, maxHp: 3 }] })
  assert.equal(state.campaign, 'Старая кампания')
  assert.equal(state.state_version, 0)
  assert.equal(state.ruleset_id, 'srd_5_2_1')
  assert.deepEqual(state.enabled_rule_packs, ['srd_5_2_1'])
})

test('все встроенные rule_id движка существуют в закреплённом Rule Pack', async () => {
  const pack = await loadRulePack('srd_5_2_1')
  const ids = new Set(pack.rules.map((rule) => rule.id))
  for (const id of Object.values(RULE_IDS)) assert.ok(ids.has(id), `В Rule Pack отсутствует ${id}`)
})

test('модификаторы и проверка характеристики вычисляются детерминированно', () => {
  assert.equal(abilityModifier(16), 3)
  assert.equal(abilityModifier(9), -1)
  const result = resolveCommand({ command_type: 'MakeAbilityCheck', actor_id: 'hero', ability: 'str', proficient: true, difficulty: 15 }, stateFixture(), { diceService: dice([10]) })
  assert.equal(result.rolls[0].modifier, 5)
  assert.equal(result.rolls[0].total, 15)
  assert.equal(result.events[0].event_type, 'AbilityCheckResolved')
  assert.deepEqual(result.events[0].source_rule_ids, [RULE_IDS.abilityCheck])
})

test('атака сравнивается с КД, а урон создаётся отдельным событием', () => {
  const result = resolveCommand({
    command_type: 'MakeAttack', actor_id: 'hero', target_id: 'goblin', attack_modifier: 4,
    damage_expression: '1d8+2', damage_type: 'slashing',
  }, stateFixture(), { diceService: dice([9, 6]) })
  assert.equal(result.events[0].event_type, 'AttackResolved')
  assert.equal(result.events[0].payload.total, 13)
  assert.equal(result.events[0].payload.hit, true)
  assert.equal(result.events.at(-1).event_type, 'DamageApplied')
  assert.equal(result.events.at(-1).payload.hp_after, 1)
})

test('критическая атака удваивает только кости урона и сохраняет rule_id', () => {
  const result = resolveCommand({
    command_type: 'MakeAttack', actor_id: 'hero', target_id: 'goblin', attack_modifier: 0,
    damage_expression: '1d8+2', damage_type: 'slashing',
  }, stateFixture(), { diceService: dice([20, 3, 4]) })
  assert.equal(result.events[0].payload.critical, true)
  assert.ok(result.events[0].source_rule_ids.includes(RULE_IDS.criticalHit))
  assert.equal(result.rolls[1].expression, '2d8+2')
  assert.equal(result.rolls[1].total, 9)
})

test('дальнее оружие берётся из инвентаря, строит траекторию и экипируется перед атакой', () => {
  const cells = Array.from({ length: 5 }, (_, x) => ({ x, y: 0, type: 'floor', revealed: true }))
  const state = normalizeCampaignState({
    players: [{ id: 'hero', hp: 12, maxHp: 12, armor: 14, proficiency: 2, abilities: { str: 10, dex: 16 }, x: 0, y: 0, inventory: [{ id: 'bow', name: 'Лук', type: 'weapon', quantity: 1, equipped: false, combat: { kind: 'ranged', ability: 'dex', damage: '1d8', damageType: 'piercing', normalRange: 20, longRange: 60 } }] }],
    enemies: [{ id: 'goblin', hp: 10, maxHp: 10, armor: 12, alive: true, x: 4, y: 0 }], scene: { cells, turn: 1 },
    mechanics: { combat: { active: true, round: 1, initiative: [{ actor_id: 'hero' }, { actor_id: 'goblin' }], active_index: 0, action_economy: { hero: { action: true } } } },
  })
  const result = resolveCommand({ command_type: 'MakeAttack', actor_id: 'hero', target_id: 'goblin', item_id: 'bow', server_authoritative: true }, state, { diceService: dice([15, 4]), context: { serverAuthoritativeCombat: true } })
  const attack = result.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(attack.payload.modifier, 5)
  assert.equal(attack.payload.distance_feet, 20)
  assert.equal(attack.payload.trajectory.length, 4)
  assert.ok(result.events.some((event) => event.event_type === 'EquipmentChanged' && event.payload.turns_spent === 0))
  const next = result.events.reduce(applyGameEvent, state)
  assert.equal(next.players[0].inventory[0].equipped, true)
})

test('метательный предмет поражает область, тратит действие и одну единицу', () => {
  const cells = Array.from({ length: 5 }, (_, x) => Array.from({ length: 3 }, (_, y) => ({ x, y, type: 'floor', revealed: true }))).flat()
  const state = normalizeCampaignState({
    players: [{ id: 'hero', hp: 12, maxHp: 12, armor: 14, abilities: { dex: 14 }, x: 0, y: 1, inventory: [{ id: 'bomb', name: 'Граната', type: 'consumable', quantity: 2, equipped: false, combat: { kind: 'thrown-area', damage: '2d6', damageType: 'fire', normalRange: 30, radius: 5, saveAbility: 'dex', saveDc: 12, halfOnSave: true } }] }],
    enemies: [{ id: 'goblin', hp: 12, maxHp: 12, armor: 12, alive: true, abilities: { dex: 10 }, x: 4, y: 1 }], scene: { cells, turn: 1 },
    mechanics: { combat: { active: true, round: 1, initiative: [{ actor_id: 'hero' }, { actor_id: 'goblin' }], active_index: 0, action_economy: { hero: { action: true } } } },
  })
  const result = resolveCommand({ command_type: 'MakeAreaAttack', actor_id: 'hero', item_id: 'bomb', to: { x: 4, y: 1 }, server_authoritative: true }, state, { diceService: dice([5, 3, 4]), context: { serverAuthoritativeCombat: true } })
  assert.ok(result.events.some((event) => event.event_type === 'AreaAttackResolved'))
  const next = result.events.reduce(applyGameEvent, state)
  assert.equal(next.enemies[0].hp, 4)
  assert.equal(next.players[0].inventory[0].quantity, 1)
  assert.equal(next.mechanics.combat.action_economy.hero.action, false)
})

test('временные HP, сопротивление, уязвимость и иммунитет применяются reducer-ом', () => {
  const base = stateFixture()
  const fire = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'goblin', target_id: 'hero', amount: 10, damage_type: 'fire' }, base, { diceService: dice([]) })
  const afterFire = fire.events.reduce(applyGameEvent, base)
  assert.equal(afterFire.mechanics.temporary_hp.hero, 0)
  assert.equal(afterFire.players[0].hp, 10) // 10 / 2 = 5, три поглощены временными HP.

  const cold = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'goblin', target_id: 'hero', amount: 4, damage_type: 'cold' }, stateFixture(), { diceService: dice([]) })
  assert.equal(cold.events[0].payload.applied_amount, 5) // 8 урона, три поглощены.

  const poison = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'goblin', target_id: 'hero', amount: 99, damage_type: 'poison' }, stateFixture(), { diceService: dice([]) })
  assert.equal(poison.events[0].payload.applied_amount, 0)
})

test('лечение ограничено максимумом, а временные HP не складываются', () => {
  const healed = resolveCommand({ command_type: 'ApplyHealing', actor_id: 'hero', amount: 30 }, stateFixture(), { diceService: dice([]) })
  assert.equal(healed.events[0].payload.hp_after, 20)
  const temporary = resolveCommand({ command_type: 'GrantTemporaryHitPoints', actor_id: 'hero', amount: 2 }, stateFixture(), { diceService: dice([]) })
  assert.equal(temporary.events[0].payload.temporary_hp_after, 3)
})

test('пустота за неровной границей карты блокирует линию атаки', () => {
  const state = normalizeCampaignState({
    players: [{
      id: 'hero', hp: 12, maxHp: 12, armor: 14, proficiency: 2, abilities: { dex: 16 }, x: 0, y: 0,
      inventory: [{ id: 'bow', name: 'Лук', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'ranged', ability: 'dex', damage: '1d8', damageType: 'piercing', normalRange: 30, longRange: 60 } }],
    }],
    enemies: [{ id: 'goblin', hp: 10, maxHp: 10, armor: 12, alive: true, x: 2, y: 0 }],
    scene: { cells: [{ x: 0, y: 0, type: 'floor', revealed: true }, { x: 2, y: 0, type: 'floor', revealed: true }], turn: 1 },
    mechanics: { combat: { active: true, round: 1, initiative: [{ actor_id: 'hero' }, { actor_id: 'goblin' }], active_index: 0, action_economy: { hero: { action: true } } } },
  })
  assert.equal(hasClearTrajectory(state, state.players[0], state.enemies[0]), false)
  assert.throws(
    () => resolveCommand({ command_type: 'MakeAttack', actor_id: 'hero', target_id: 'goblin', item_id: 'bow', server_authoritative: true }, state, { diceService: dice([15]), context: { serverAuthoritativeCombat: true } }),
    (error) => error instanceof RulesValidationError && error.code === 'TRAJECTORY_BLOCKED',
  )
})

test('смерть героя сохраняется и требует воскрешения или замены', () => {
  const mourning = normalizeCampaignState({
    partyMemberIds: ['fallen', 'survivor'],
    players: [
      { id: 'fallen', character: 'Лира', hp: 0, maxHp: 12, inventory: [] },
      { id: 'survivor', character: 'Торвальд', hp: 8, maxHp: 14, inventory: [] },
    ],
    mechanics: { death: { campaign_status: 'active', heroes: { fallen: { status: 'dead' } } }, conditions: { fallen: [{ id: 'dead' }] } },
  })
  assert.equal(mourning.mechanics.death.campaign_status, 'active')
  assert.equal(mourning.mechanics.death.heroes.fallen.status, 'dead')
  assert.ok(mourning.mechanics.conditions.fallen.some((condition) => condition.id === 'dead'))
  assert.throws(
    () => resolveCommand({ command_type: 'MoveActor', actor_id: 'fallen', to: { x: 0, y: 0 } }, mourning, { diceService: dice([]) }),
    (error) => error instanceof RulesValidationError && error.code === 'HERO_DEAD_UNRESOLVED',
  )

  const resurrection = resolveCommand({ command_type: 'ResolveHeroDeath', actor_id: 'fallen', resolution: 'resurrect' }, mourning, { diceService: dice([]) })
  const returned = resurrection.events.reduce(applyGameEvent, mourning)
  assert.equal(returned.players.find((hero) => hero.id === 'fallen').hp, 1)
  assert.equal(returned.mechanics.death.heroes.fallen.resolution, 'resurrected')
  assert.deepEqual(returned.mechanics.conditions.fallen, [])
})

test('новый герой заменяет погибшего, а гибель всей группы навсегда завершает мир', () => {
  const replaceable = normalizeCampaignState({
    partyMemberIds: ['fallen', 'survivor'],
    players: [
      { id: 'fallen', character: 'Старое имя', hp: 0, maxHp: 10, inventory: [] },
      { id: 'survivor', character: 'Свидетель', hp: 5, maxHp: 10, inventory: [] },
    ],
    mechanics: {
      death: { campaign_status: 'active', heroes: { fallen: { status: 'dead' } } },
      conditions: { fallen: [{ id: 'dead' }] },
      resources: { fallen: { spell_slots_1: { current: 0, max: 2 } } },
    },
  })
  const replacement = resolveCommand({ command_type: 'ResolveHeroDeath', actor_id: 'fallen', resolution: 'replace', replacement_name: 'Элара' }, replaceable, { diceService: dice([]) })
  const joined = replacement.events.reduce(applyGameEvent, replaceable)
  assert.equal(joined.players.find((hero) => hero.id === 'fallen').character, 'Элара')
  assert.equal(joined.players.find((hero) => hero.id === 'fallen').hp, 10)
  assert.equal(joined.mechanics.resources.fallen.spell_slots_1.current, 2)
  assert.equal(joined.mechanics.death.heroes.fallen.resolution, 'replaced')

  const doomed = normalizeCampaignState({
    partyMemberIds: ['last'],
    players: [{ id: 'last', character: 'Последний герой', hp: 0, maxHp: 10, inventory: [] }],
  })
  const ending = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'last', target_id: 'last', amount: 10, damage_type: 'force' }, doomed, { diceService: dice([]) })
  assert.deepEqual(
    ending.events.slice(-2).map((event) => event.event_type),
    ['HeroDied', 'CampaignFailed'],
  )
  assert.equal(ending.events.filter((event) => event.event_type === 'CampaignFailed').length, 1)
  assert.equal(ending.events.find((event) => event.event_type === 'HeroDied').event_schema_version, 2)
  assert.match(ending.events.at(-1).payload.epilogue, /поражен|погиб|пал/iu)
  const endedWorld = ending.events.reduce(applyGameEvent, doomed)
  assert.equal(endedWorld.mechanics.death.campaign_status, 'party_defeated')
  assert.equal(endedWorld.mechanics.campaign_lifecycle.status, 'failed')
  assert.equal(endedWorld.mechanics.campaign_lifecycle.reason, 'party_final_death')
  assert.throws(
    () => resolveCommand({ command_type: 'ResolveHeroDeath', actor_id: 'last', resolution: 'resurrect' }, endedWorld, { diceService: dice([]) }),
    (error) => error instanceof RulesValidationError && error.code === 'CAMPAIGN_READ_ONLY',
  )

  const setup = normalizeCampaignState({
    partyMemberIds: ['last'],
    players: [{ id: 'last', character: 'Последний герой', hp: 0, maxHp: 10, inventory: [] }],
    mechanics: { campaign_lifecycle: { status: 'setup' } },
  })
  const setupDeath = resolveCommand(
    { command_type: 'ApplyDamage', actor_id: 'last', target_id: 'last', amount: 10, damage_type: 'force' },
    setup,
    { diceService: dice([]) },
  )
  assert.ok(setupDeath.events.some((event) => event.event_type === 'HeroDied'))
  assert.equal(setupDeath.events.some((event) => event.event_type === 'CampaignFailed'), false)
})

test('ресурсы нельзя потратить дважды или уйти ниже нуля', () => {
  const result = resolveCommand({ command_type: 'SpendResource', actor_id: 'hero', resource: 'spell_slots', amount: 1 }, stateFixture(), { diceService: dice([]) })
  const after = applyGameEvent(stateFixture(), result.events[0])
  assert.equal(after.mechanics.resources.hero.spell_slots.current, 1)
  assert.throws(() => resolveCommand({ command_type: 'SpendResource', actor_id: 'hero', resource: 'spell_slots', amount: 3 }, stateFixture(), { diceService: dice([]) }), /Недостаточно/)
})

test('состояния и концентрация изменяются только событиями', () => {
  const result = resolveCommands([
    { command_type: 'AddCondition', actor_id: 'hero', condition: 'poisoned' },
    { command_type: 'StartConcentration', actor_id: 'hero', effect_id: 'spell:web' },
    { command_type: 'RemoveCondition', actor_id: 'hero', condition: 'poisoned' },
  ], stateFixture(), { diceService: dice([]) })
  assert.deepEqual(result.state.mechanics.conditions.hero, [])
  assert.equal(result.state.mechanics.concentration.hero.effect_id, 'spell:web')
  assert.ok(result.events.every((event) => event.source_rule_ids.length > 0))
})

test('инициатива, порядок хода и экономика действий проверяются кодом', () => {
  const started = resolveCommand({ command_type: 'StartCombat', participant_ids: ['hero', 'goblin'] }, stateFixture(), { diceService: dice([8, 16]) })
  const combatState = applyGameEvent(stateFixture(), started.events[0])
  assert.equal(combatState.mechanics.combat.initiative[0].actor_id, 'goblin')
  assert.deepEqual(
    combatState.mechanics.combat.initiative.map((entry) => ({ actor: entry.actor_id, roll: entry.roll, modifier: entry.modifier, total: entry.total })),
    [
      { actor: 'goblin', roll: 16, modifier: 2, total: 18 },
      { actor: 'hero', roll: 8, modifier: 2, total: 10 },
    ],
  )
  assert.throws(() => resolveCommand({ command_type: 'MakeAttack', actor_id: 'hero', target_id: 'goblin' }, combatState, { diceService: dice([20]) }), (error) => error instanceof RulesValidationError && error.code === 'OUT_OF_TURN')

  const ended = resolveCommand({ command_type: 'EndTurn', actor_id: 'goblin' }, combatState, { diceService: dice([]) })
  const heroTurn = ended.events.reduce(applyGameEvent, combatState)
  assert.equal(heroTurn.mechanics.combat.initiative[heroTurn.mechanics.combat.active_index].actor_id, 'hero')
  const attacked = resolveCommand({ command_type: 'MakeAttack', actor_id: 'hero', target_id: 'goblin', attack_modifier: 20 }, heroTurn, { diceService: dice([2]) })
  const spent = attacked.events.reduce(applyGameEvent, heroTurn)
  assert.equal(spent.mechanics.combat.action_economy.hero.action, false)

  const finished = resolveCommand({ command_type: 'EndCombat', actor_id: 'hero', reason: 'противник сдался' }, spent, { diceService: dice([]) })
  const peaceful = finished.events.reduce(applyGameEvent, spent)
  assert.equal(finished.events[0].event_type, 'CombatEnded')
  assert.equal(peaceful.mechanics.combat.active, false)
  assert.deepEqual(peaceful.mechanics.combat.initiative, [])
})

test('исследование не режется на боевые ходы, а в бою скорость ограничивает перемещение', () => {
  const cells = Array.from({ length: 10 }, (_, x) => ({ x, y: 0, type: 'floor', revealed: true }))
  const exploration = normalizeCampaignState({
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Адара', hp: 12, maxHp: 12, speed: 30, x: 0, y: 0, inventory: [] }],
    scene: { cells, turn: 1 },
  })
  const explored = resolveCommand(
    { command_type: 'MoveActor', actor_id: 'hero', to: { x: 9, y: 0 }, server_authoritative: true },
    exploration,
    { diceService: dice([]), context: { allowedActorIds: ['hero'], serverAuthoritativeCombat: true } },
  )
  const movement = explored.events.find((event) => event.event_type === 'ActorMoved')
  assert.equal(movement.payload.distance, 45)
  assert.equal(movement.payload.movement_spent, 0)
  assert.equal(movement.payload.phase, 'exploration')
  assert.deepEqual(explored.events.reduce(applyGameEvent, exploration).mechanics.positions.hero, { x: 9, y: 0 })

  const combat = normalizeCampaignState({
    ...exploration,
    mechanics: { combat: { active: true, round: 1, initiative: [{ actor_id: 'hero' }], active_index: 0, action_economy: { hero: { ...exploration.mechanics.combat.action_economy.hero, movement_spent: 0 } } } },
  })
  assert.throws(
    () => resolveCommand(
      { command_type: 'MoveActor', actor_id: 'hero', to: { x: 7, y: 0 }, server_authoritative: true },
      combat,
      { diceService: dice([]), context: { allowedActorIds: ['hero'], serverAuthoritativeCombat: true } },
    ),
    (error) => error instanceof RulesValidationError && error.code === 'SPEED_EXCEEDED',
  )
})

function opportunityState({ heroHp = 12, disengaged = false } = {}) {
  const cells = Array.from({ length: 5 }, (_, x) => ({ x, y: 0, type: 'floor', revealed: true }))
  return normalizeCampaignState({
    players: [{ id: 'hero', character: 'Адара', hp: heroHp, maxHp: 12, armor: 12, speed: 30, x: 1, y: 0, inventory: [] }],
    enemies: [{
      id: 'goblin', name: 'Гоблин', hp: 9, maxHp: 9, armor: 13, alive: true, x: 0, y: 0,
      attack_profile: { attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'slashing', range_feet: 5 },
    }],
    scene: { cells, turn: 1 },
    mechanics: {
      conditions: disengaged ? { hero: [{ id: 'disengaged', duration: 'until-next-turn' }] } : {},
      combat: {
        active: true,
        round: 1,
        initiative: [{ actor_id: 'hero', total: 15 }, { actor_id: 'goblin', total: 10 }],
        active_index: 0,
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          goblin: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

test('выход из ближнего боя вызывает серверную атаку по возможности и расходует реакцию', () => {
  const state = opportunityState()
  const result = resolveCommand(
    { command_type: 'MoveActor', actor_id: 'hero', to: { x: 3, y: 0 }, server_authoritative: true },
    state,
    { diceService: dice([12, 4]), context: { allowedActorIds: ['hero'], serverAuthoritativeCombat: true } },
  )
  const attack = result.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(attack?.actor_id, 'goblin')
  assert.equal(attack?.payload.reaction_attack, true)
  assert.ok(result.events.some((event) => event.event_type === 'CombatActionUsed' && event.payload.action_id === 'opportunity-attack'))
  assert.ok(result.events.some((event) => event.event_type === 'ActorMoved'))

  const next = result.events.reduce(applyGameEvent, state)
  assert.equal(next.players[0].hp, 6)
  assert.deepEqual({ x: next.players[0].x, y: next.players[0].y }, { x: 3, y: 0 })
  assert.equal(next.mechanics.combat.action_economy.goblin.reaction, false)
  assert.equal(next.mechanics.combat.action_economy.goblin.action, true)
})

test('Отход отменяет атаку по возможности, а смертельная реакция прерывает перемещение', () => {
  const disengaged = opportunityState({ disengaged: true })
  const safeMove = resolveCommand(
    { command_type: 'MoveActor', actor_id: 'hero', to: { x: 3, y: 0 }, server_authoritative: true },
    disengaged,
    { diceService: dice([]), context: { allowedActorIds: ['hero'], serverAuthoritativeCombat: true } },
  )
  assert.deepEqual(safeMove.events.map((event) => event.event_type), ['ActorMoved'])

  const fragile = opportunityState({ heroHp: 3 })
  const interrupted = resolveCommand(
    { command_type: 'MoveActor', actor_id: 'hero', to: { x: 3, y: 0 }, server_authoritative: true },
    fragile,
    { diceService: dice([12, 4]), context: { allowedActorIds: ['hero'], serverAuthoritativeCombat: true } },
  )
  assert.equal(interrupted.events.some((event) => event.event_type === 'ActorMoved'), false)
  const defeated = interrupted.events.reduce(applyGameEvent, fragile)
  assert.equal(defeated.players[0].hp, 0)
  assert.deepEqual({ x: defeated.players[0].x, y: defeated.players[0].y }, { x: 1, y: 0 })
})

test('боевое заклинание берётся из доверенного набора и расходует правильную часть хода', () => {
  const cells = Array.from({ length: 4 }, (_, x) => ({ x, y: 0, type: 'floor', revealed: true }))
  const state = normalizeCampaignState({
    partyMemberIds: ['cleric', 'ally'],
    players: [
      { id: 'cleric', character: 'Ада', role: 'Жрец · ур. 3', level: 3, hp: 15, maxHp: 15, armor: 15, proficiency: 2, abilities: { str: 10, dex: 10, con: 12, int: 10, wis: 16, cha: 10 }, inventory: [], x: 0, y: 0 },
      { id: 'ally', character: 'Бранн', role: 'Воин', level: 3, hp: 4, maxHp: 20, armor: 16, abilities: { str: 16, dex: 10 }, inventory: [], x: 2, y: 0 },
    ],
    enemies: [{ id: 'goblin', hp: 8, maxHp: 8, armor: 12, alive: true, x: 3, y: 0 }],
    scene: { cells, turn: 1 },
    mechanics: { combat: { active: true, round: 1, initiative: [{ actor_id: 'cleric' }, { actor_id: 'goblin' }], active_index: 0, action_economy: { cleric: { action: true, bonus_action: true, reaction: true, movement: true } } } },
  })
  const result = resolveCommand({
    command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'healing-word', target_id: 'ally',
    // These client fields must not alter the trusted spell profile.
    cost: -99, max: 999, healing: '99d99', action_type: 'action', server_authoritative: true,
  }, state, { diceService: dice([3]), context: { serverAuthoritativeCombat: true } })
  const after = result.events.reduce(applyGameEvent, state)
  assert.equal(after.players.find((player) => player.id === 'ally').hp, 10)
  assert.equal(after.mechanics.resources.cleric.spell_slots_1.current, 3)
  assert.equal(after.mechanics.combat.action_economy.cleric.action, true)
  assert.equal(after.mechanics.combat.action_economy.cleric.bonus_action, false)
  assert.equal(result.events.find((event) => event.event_type === 'SpellCast').payload.action_type, 'bonus_action')
})

test('призванный помощник получает отдельный ход сразу после владельца и наследует его права', () => {
  const cells = Array.from({ length: 5 }, (_, x) => Array.from({ length: 3 }, (_, y) => ({ x, y, type: 'floor', revealed: true }))).flat()
  const state = normalizeCampaignState({
    partyMemberIds: ['druid'],
    players: [{ id: 'druid', character: 'Эйла', role: 'Друид · ур. 3', level: 3, hp: 18, maxHp: 18, armor: 14, proficiency: 2, abilities: { str: 8, dex: 14, con: 14, int: 10, wis: 16, cha: 10 }, inventory: [], x: 0, y: 1 }],
    enemies: [{ id: 'goblin', hp: 12, maxHp: 12, armor: 12, alive: true, x: 4, y: 1 }],
    scene: { cells, turn: 1 },
    mechanics: { combat: { active: true, round: 1, initiative: [{ actor_id: 'druid', total: 15 }, { actor_id: 'goblin', total: 10 }], active_index: 0, action_economy: { druid: { action: true, bonus_action: true, reaction: true, movement: true } } } },
  })
  const result = resolveCommand({ command_type: 'CastSpell', actor_id: 'druid', spell_id: 'summon-beast', to: { x: 1, y: 1 }, server_authoritative: true }, state, { diceService: dice([]), context: { serverAuthoritativeCombat: true, allowedActorIds: ['druid'] } })
  const after = result.events.reduce(applyGameEvent, state)
  const summon = after.actors[0]
  assert.equal(summon.ownerId, 'druid')
  assert.equal(after.mechanics.combat.initiative[1].actor_id, summon.id)
  assert.equal(after.mechanics.resources.druid.spell_slots_2.current, 1)
  assert.equal(after.mechanics.concentration.druid.effect_id, `summon-beast:${result.command.command_id}`)
  const ended = resolveCommand({ command_type: 'EndTurn', actor_id: 'druid' }, after, { diceService: dice([]), context: { allowedActorIds: ['druid'] } })
  const summonTurn = ended.events.reduce(applyGameEvent, after)
  assert.equal(summonTurn.mechanics.combat.initiative[summonTurn.mechanics.combat.active_index].actor_id, summon.id)
  assert.doesNotThrow(() => validateCommand({ command_type: 'MoveActor', actor_id: summon.id, to: { x: 2, y: 1 }, server_authoritative: true }, summonTurn, { allowedActorIds: ['druid'], serverAuthoritativeCombat: true }))
  assert.deepEqual(replayEvents(state, result.events), after)
})

test('существующий призыв делит инициативу владельца и не бросает отдельный d20', () => {
  const state = normalizeCampaignState({
    partyMemberIds: ['druid'],
    players: [{ id: 'druid', role: 'Друид · ур. 3', level: 3, hp: 12, maxHp: 12, abilities: { dex: 14, wis: 16 }, inventory: [] }],
    actors: [{ id: 'beast', name: 'Звериный дух', kind: 'summon', faction: 'party', ownerId: 'druid', controllerId: 'druid', hp: 20, maxHp: 20, alive: true }],
    enemies: [{ id: 'goblin', hp: 8, maxHp: 8, alive: true, initiativeBonus: 0 }],
  })
  const result = resolveCommand({ command_type: 'StartCombat', actor_id: 'druid', server_authoritative: true }, state, { diceService: dice([12, 10]), context: { serverAuthoritativeCombat: true } })
  const after = result.events.reduce(applyGameEvent, state)
  assert.equal(result.rolls.length, 2)
  assert.deepEqual(after.mechanics.combat.initiative.map((entry) => entry.actor_id), ['druid', 'beast', 'goblin'])
  assert.equal(result.events.at(-1).event_type, 'TurnStarted')
})

test('падение до нуля HP автоматически завершает концентрацию из-за недееспособности', () => {
  let state = stateFixture()
  state.mechanics.concentration.hero = { effect_id: 'spell:web' }
  state.mechanics.temporary_hp.hero = 0
  const result = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'goblin', target_id: 'hero', amount: 8, damage_type: 'cold' }, state, { diceService: dice([]) })
  assert.deepEqual(result.events.map((event) => event.event_type), ['DamageApplied', 'HitPointsReducedToZero', 'ConcentrationEnded'])
  assert.equal(result.events.at(-1).payload.reason, 'incapacitated')
  const after = result.events.reduce(applyGameEvent, state)
  assert.equal(after.players[0].hp, 0)
  assert.equal(after.mechanics.conditions.hero[0].id, 'unconscious')
  assert.equal(after.mechanics.concentration.hero, undefined)
})

test('версия, права actor_id, allowlist и provenance валидируются до исполнения', () => {
  const state = stateFixture()
  assert.throws(() => validateCommand({ command_type: 'DeleteCampaign', actor_id: 'hero' }, state), /не разрешён/)
  assert.throws(() => validateCommand({ command_type: 'MakeAbilityCheck', actor_id: 'hero', expected_state_version: 2 }, state), (error) => error.code === 'STATE_VERSION_CONFLICT')
  assert.throws(() => validateCommand({ command_type: 'MakeAbilityCheck', actor_id: 'hero' }, state, { allowedActorIds: ['goblin'] }), (error) => error.code === 'ACTOR_FORBIDDEN')
  assert.throws(() => validateCommand({ command_type: 'MakeAbilityCheck', actor_id: 'missing' }, state), (error) => error.code === 'ACTOR_NOT_FOUND')
})

test('replay тех же событий воспроизводит текущее состояние', () => {
  const initial = stateFixture()
  const engine = new RulesEngine({ diceService: dice([]) })
  const plan = engine.resolvePlan({ proposed_commands: [
    { command_type: 'ApplyDamage', actor_id: 'goblin', target_id: 'hero', amount: 4, damage_type: 'slashing' },
    { command_type: 'ApplyHealing', actor_id: 'hero', amount: 2 },
  ] }, initial)
  assert.deepEqual(replayEvents(initial, plan.events), plan.state)
})

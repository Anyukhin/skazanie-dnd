import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

function dice() {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(Array.from({ length: 120 }, () => 2)),
    idFactory: () => `action-surge-spell-${++id}`,
    now: () => '2026-09-26T00:00:00.000Z',
  })
}

function battle({ rulesetId = 'dnd_5e_2014', hasted = false } = {}) {
  return normalizeCampaignState({
    sessionCode: `ACTION-SURGE-SPELLS-${rulesetId}`,
    ruleset_id: rulesetId,
    partyMemberIds: ['fighter', 'ally'],
    players: [
      {
        // Тестовый actor совмещает ресурс Fighter и spell profile Wizard;
        // runtime multiclass-модель этим не добавляется.
        id: 'fighter', role: 'Воин', characterClass: 'wizard', level: 5,
        hp: 30, maxHp: 30, armor: 15, speed: 30, proficiency: 3,
        abilities: { str: 10, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
        knownSpellIds: ['fire-bolt', 'magic-missile', 'expeditious-retreat'],
        preparedSpellIds: ['magic-missile', 'expeditious-retreat'],
        inventory: [
          materializeCatalogItem('srd_5_2_1:light-crossbow', { id: 'crossbow', quantity: 1, equipped: true }),
          materializeCatalogItem('srd_5_2_1:bolts-20', { id: 'bolts', quantity: 10 }),
        ], x: 0, y: 0, alive: true,
      },
      {
        id: 'ally', character: 'Союзник', characterClass: 'fighter', level: 5,
        hp: 10, maxHp: 20, armor: 15, speed: 30, proficiency: 3,
        abilities: { str: 10, dex: 10, con: 10 }, inventory: [], x: 1, y: 0, alive: true,
      },
    ],
    enemies: [{ id: 'target', name: 'Мишень', hp: 100, maxHp: 100, armor: 10, speed: 30,
      abilities: { dex: 10 }, x: 3, y: 0, alive: true }],
    scene: { turn: 1, cells: Array.from({ length: 40 }, (_, index) => ({
      x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true,
    })) },
    mechanics: {
      conditions: hasted ? { fighter: [{ id: 'hasted' }] } : {},
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'fighter', total: 20 }, { actor_id: 'target', total: 1 }],
        action_economy: {
          fighter: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          target: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
      resources: {
        fighter: { action_surge: { current: 1, max: 1 }, spell_slots_1: { current: 2, max: 2 } },
      },
    },
  })
}

function apply(state, result) {
  return result.events.reduce(applyGameEvent, state)
}

function command(state, input) {
  return resolveCommand({ ...input, server_authoritative: true }, state, {
    diceService: dice(), context: { serverAuthoritativeCombat: true, isAdmin: true },
  })
}

function cast(state, spellId, commandId, targetId = 'target') {
  return command(state, {
    command_type: 'CastSpell', command_id: commandId, actor_id: 'fighter', spell_id: spellId,
    target_id: targetId, target_ids: [targetId],
  })
}

function surge(state, commandId = 'surge') {
  return command(state, { command_type: 'UseCombatAction', command_id: commandId, actor_id: 'fighter', action_id: 'action-surge' })
}

test('2014: Action Surge разрешает два action cantrip за ход', () => {
  let state = battle()
  state = apply(state, surge(state, 'cantrip-surge-before'))
  state = apply(state, cast(state, 'fire-bolt', 'cantrip-extra'))
  const second = cast(state, 'fire-bolt', 'cantrip-normal')
  state = apply(state, second)
  assert.equal(second.events.filter((event) => event.event_type === 'SpellCast').length, 1)
  assert.equal(state.mechanics.resources.fighter.spell_slots_1.current, 2)
  assert.equal(state.mechanics.combat.action_economy.fighter.action, false)
})

test('2014: Action Surge разрешает два leveled spell и расходует общий пул ячеек', () => {
  let state = battle()
  state = apply(state, cast(state, 'magic-missile', 'leveled-normal'))
  assert.equal(state.mechanics.resources.fighter.spell_slots_1.current, 1)
  state = apply(state, surge(state, 'leveled-surge'))
  state = apply(state, cast(state, 'magic-missile', 'leveled-extra'))
  assert.equal(state.mechanics.resources.fighter.spell_slots_1.current, 0)
})

test('2014: после двух action spell не остаётся бесплатной атаки или третьего CastSpell', () => {
  let state = battle()
  state = apply(state, surge(state, 'exhaust-surge'))
  state = apply(state, cast(state, 'fire-bolt', 'exhaust-surge-spell'))
  state = apply(state, cast(state, 'fire-bolt', 'exhaust-normal-spell'))
  assert.equal(state.mechanics.combat.action_economy.fighter.action, false)
  assert.throws(() => cast(state, 'fire-bolt', 'exhaust-third-spell'), (error) => error.code === 'ACTION_SPENT')
  assert.throws(() => command(state, {
    command_type: 'MakeAttack', command_id: 'exhaust-attack', actor_id: 'fighter', target_id: 'target', item_id: 'crossbow',
  }), (error) => error.code === 'ACTION_SPENT')
})

test('2024: обычная action может творить магию до отдельного Surge, Surge сохраняет запрет', () => {
  let state = battle({ rulesetId: 'srd_5_2_1' })
  state = apply(state, surge(state, '2024-surge-before'))
  state = apply(state, cast(state, 'fire-bolt', '2024-normal-before'))
  const attack = command(state, { command_type: 'MakeAttack', command_id: '2024-surge-attack', actor_id: 'fighter', target_id: 'target', item_id: 'crossbow' })
  state = apply(state, attack)
  assert.equal(state.mechanics.combat.action_economy.fighter.attack_action_kind, 'surge')
  assert.equal(state.mechanics.combat.action_economy.fighter.action, true)
  state = battle({ rulesetId: 'srd_5_2_1' })
  state = apply(state, cast(state, 'fire-bolt', '2024-normal'))
  state = apply(state, surge(state, '2024-surge-after'))
  assert.throws(() => cast(state, 'fire-bolt', '2024-extra-after'), (error) => error.code === 'ACTION_SURGE_MAGIC_FORBIDDEN')
})

test('Haste выбирает normal action для CastSpell, затем сохраняет limited Haste action', () => {
  let state = battle({ hasted: true })
  state = applyGameEvent(state, {
    event_type: 'TurnStarted', event_id: 'haste-turn', command_id: 'haste-turn', actor_id: 'fighter', target_ids: ['fighter'],
    payload: { round: 1, active_index: 0, action_economy_version: 2 },
  })
  assert.equal(state.mechanics.combat.action_economy.fighter.attack_action_kind, 'haste')
  state = apply(state, cast(state, 'fire-bolt', 'haste-normal-spell'))
  assert.equal(state.mechanics.combat.action_economy.fighter.attack_action_kind, 'haste')
  assert.throws(() => cast(state, 'fire-bolt', 'haste-spell'), (error) => error.code === 'ACTION_SURGE_MAGIC_FORBIDDEN')
  state = apply(state, command(state, { command_type: 'UseCombatAction', command_id: 'haste-dash', actor_id: 'fighter', action_id: 'dash' }))
  const economy = state.mechanics.combat.action_economy.fighter
  assert.equal(economy.attack_action_kind, 'haste')
  assert.equal(economy.action, false)
  assert.deepEqual(economy.attack_action_stack, [])
})

test('Haste-only не разрешает Help после normal CastSpell', () => {
  let state = battle({ hasted: true })
  state = applyGameEvent(state, {
    event_type: 'TurnStarted', event_id: 'haste-help-refusal-turn', command_id: 'haste-help-refusal-turn', actor_id: 'fighter', target_ids: ['fighter'],
    payload: { round: 1, active_index: 0, action_economy_version: 2 },
  })
  state = apply(state, cast(state, 'fire-bolt', 'haste-help-normal-spell'))
  assert.throws(() => command(state, {
    command_type: 'UseCombatAction', command_id: 'haste-help-refused', actor_id: 'fighter', action_id: 'help', target_id: 'ally',
  }), (error) => error.code === 'HASTE_ACTION_LIMIT')
})

test('2014: CastSpell в Surge очереди потребляет Surge, затем Haste и normal по очереди', () => {
  let state = battle({ hasted: true })
  state = applyGameEvent(state, {
    event_type: 'TurnStarted', event_id: 'haste-surge-turn', command_id: 'haste-surge-turn', actor_id: 'fighter', target_ids: ['fighter'],
    payload: { round: 1, active_index: 0, action_economy_version: 2 },
  })
  state = apply(state, surge(state, 'haste-surge'))
  state = apply(state, cast(state, 'fire-bolt', 'haste-surge-spell'))
  assert.equal(state.mechanics.combat.action_economy.fighter.attack_action_kind, 'haste')
  state = apply(state, command(state, { command_type: 'UseCombatAction', command_id: 'haste-surge-dash', actor_id: 'fighter', action_id: 'dash' }))
  assert.equal(state.mechanics.combat.action_economy.fighter.attack_action_kind, 'normal')
  state = apply(state, cast(state, 'fire-bolt', 'haste-surge-normal-spell'))
  assert.equal(state.mechanics.combat.action_economy.fighter.action, false)
})

test('Haste: Help выбирает queued normal action, затем Haste attack остаётся доступной', () => {
  let state = battle({ hasted: true })
  state = applyGameEvent(state, {
    event_type: 'TurnStarted', event_id: 'haste-help-turn', command_id: 'haste-help-turn', actor_id: 'fighter', target_ids: ['fighter'],
    payload: { round: 1, active_index: 0, action_economy_version: 2 },
  })
  state = apply(state, command(state, {
    command_type: 'UseCombatAction', command_id: 'haste-help', actor_id: 'fighter', action_id: 'help', target_id: 'ally',
  }))
  assert.equal(state.mechanics.combat.action_economy.fighter.attack_action_kind, 'haste')
  assert.equal(state.mechanics.combat.action_economy.fighter.action, true)
  const attack = command(state, { command_type: 'MakeAttack', command_id: 'haste-help-attack', actor_id: 'fighter', target_id: 'target', item_id: 'crossbow' })
  state = apply(state, attack)
  assert.equal(state.mechanics.combat.action_economy.fighter.action, false)
})

test('Haste UseItem расходует Haste frame, не normal frame из очереди', () => {
  let state = battle({ hasted: true })
  state.players[0].inventory.push(materializeCatalogItem('srd_5_2_1:caltrops', { id: 'caltrops', quantity: 1 }))
  state = applyGameEvent(state, {
    event_type: 'TurnStarted', event_id: 'haste-item-turn', command_id: 'haste-item-turn', actor_id: 'fighter', target_ids: ['fighter'],
    payload: { round: 1, active_index: 0, action_economy_version: 2 },
  })
  const result = command(state, {
    command_type: 'UseItem', command_id: 'haste-caltrops', actor_id: 'fighter', item_id: 'caltrops', target_id: 'fighter', to: { x: 1, y: 0 },
  })
  state = apply(state, result)
  const economy = state.mechanics.combat.action_economy.fighter
  assert.equal(economy.attack_action_kind, 'normal')
  assert.equal(economy.action, true)
  assert.equal(economy.extra_actions, 0)
  assert.deepEqual(economy.attack_action_stack, [])
})

test('AreaAttack в Haste frame выбирает queued normal action', () => {
  let state = battle({ hasted: true })
  state.players[0].inventory.push({
    id: 'area-bomb', name: 'Бомба', type: 'consumable', quantity: 1,
    combat: { kind: 'thrown-area', damage: '1d4', damageType: 'fire', normalRange: 30, radius: 5, saveAbility: 'dex', saveDc: 12, halfOnSave: true },
  })
  state = applyGameEvent(state, {
    event_type: 'TurnStarted', event_id: 'haste-area-turn', command_id: 'haste-area-turn', actor_id: 'fighter', target_ids: ['fighter'],
    payload: { round: 1, active_index: 0, action_economy_version: 2 },
  })
  state = apply(state, command(state, {
    command_type: 'MakeAreaAttack', command_id: 'haste-area', actor_id: 'fighter', item_id: 'area-bomb', to: { x: 3, y: 0 },
  }))
  const economy = state.mechanics.combat.action_economy.fighter
  assert.equal(economy.attack_action_kind, 'haste')
  assert.equal(economy.action, true)
  assert.deepEqual(economy.attack_action_stack, [])
})

test('Haste-only AreaAttack отклоняется без расхода предмета или броска', () => {
  let state = battle({ hasted: true })
  state.players[0].inventory.push({
    id: 'area-bomb-only-haste', name: 'Бомба', type: 'consumable', quantity: 1,
    combat: { kind: 'thrown-area', damage: '1d4', damageType: 'fire', normalRange: 30, radius: 5, saveAbility: 'dex', saveDc: 12, halfOnSave: true },
  })
  state = applyGameEvent(state, {
    event_type: 'TurnStarted', event_id: 'haste-area-refusal-turn', command_id: 'haste-area-refusal-turn', actor_id: 'fighter', target_ids: ['fighter'],
    payload: { round: 1, active_index: 0, action_economy_version: 2 },
  })
  state = apply(state, cast(state, 'fire-bolt', 'haste-area-normal-spell'))
  const before = structuredClone(state)
  assert.throws(() => command(state, {
    command_type: 'MakeAreaAttack', command_id: 'haste-area-refused', actor_id: 'fighter', item_id: 'area-bomb-only-haste', to: { x: 3, y: 0 },
  }), (error) => error.code === 'HASTE_ACTION_LIMIT')
  assert.deepEqual(state, before)
})

test('partial normal after Surge keeps one attack and rejects extra CastSpell', () => {
  let state = battle()
  state.players[0].inventory = state.players[0].inventory.map((item) => ({ ...item, equipped: false }))
  state.players[0].inventory.push(materializeCatalogItem('srd_5_2_1:longsword', { id: 'sword-a', quantity: 1, equipped: false }))
  state.enemies[0].x = 1
  state.mechanics.positions.target = { x: 1, y: 0 }
  state.mechanics.combat.action_economy.fighter = {
    ...state.mechanics.combat.action_economy.fighter,
    action: false, action_economy_version: 2, attack_action_id: 'partial-normal', attack_action_kind: 'normal',
    attack_action_limit: 2, attacks_used: 1, attacks_allowed: 2,
  }
  state = apply(state, surge(state, 'partial-normal-surge'))
  state = apply(state, cast(state, 'fire-bolt', 'partial-normal-surge-spell'))
  assert.equal(state.mechanics.combat.action_economy.fighter.attack_action_kind, 'normal')
  assert.equal(state.mechanics.combat.action_economy.fighter.attacks_used, 1)
  assert.equal(state.mechanics.combat.action_economy.fighter.action, false)
  assert.throws(() => cast(state, 'fire-bolt', 'partial-normal-third-spell'), (error) => error.code === 'ACTION_SPENT')
  state = apply(state, command(state, { command_type: 'MakeAttack', command_id: 'partial-normal-last-attack', actor_id: 'fighter', target_id: 'target', item_id: 'sword-a' }))
  assert.equal(state.mechanics.combat.action_economy.fighter.attacks_used, 2)
  assert.throws(() => command(state, { command_type: 'MakeAttack', command_id: 'partial-normal-extra-attack', actor_id: 'fighter', target_id: 'target', item_id: 'sword-a' }), (error) => error.code === 'ACTION_SPENT')
})

test('частично потраченный normal frame не открывает Help из одного Haste кадра', () => {
  let state = battle({ hasted: true })
  state.mechanics.combat.action_economy.fighter = {
    ...state.mechanics.combat.action_economy.fighter,
    action: true,
    action_economy_version: 2,
    attack_action_id: 'haste-only-frame',
    attack_action_kind: 'haste',
    attack_action_limit: 1,
    attacks_used: 0,
    attacks_allowed: 1,
    attack_action_stack: [{
      id: 'partial-normal-frame', kind: 'normal', limit: 2, attacks_used: 1,
      loading_weapon_item_ids: { action: [], bonus_action: [], reaction: [] },
    }],
  }
  assert.throws(() => command(state, {
    command_type: 'UseCombatAction', command_id: 'partial-normal-help', actor_id: 'fighter', action_id: 'help', target_id: 'ally',
  }), (error) => error.code === 'HASTE_ACTION_LIMIT')
})

test('bonus-action spell сохраняет отдельный bonus_action budget', () => {
  let state = battle()
  state = apply(state, cast(state, 'expeditious-retreat', 'bonus-spell', 'fighter'))
  assert.equal(state.mechanics.combat.action_economy.fighter.bonus_action, false)
  assert.equal(state.mechanics.combat.action_economy.fighter.action, true)
})

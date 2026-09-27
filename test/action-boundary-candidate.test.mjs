import assert from 'node:assert/strict'
import test from 'node:test'

import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice() {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(Array.from({ length: 80 }, () => [15, 8]).flat()),
    idFactory: () => `action-boundary-${++id}`,
    now: () => '2026-09-24T00:00:00.000Z',
  })
}

function battle({ level = 5, hasted = false, extraAction = false, extraLimit = null } = {}) {
  const weapons = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => materializeCatalogItem(
    'srd_5_2_1:light-crossbow', { id: `crossbow-${id}`, quantity: 1, equipped: true },
  ))
  const bolts = materializeCatalogItem('srd_5_2_1:bolts-20', { id: 'bolts', quantity: 10 })
  return normalizeCampaignState({
    sessionCode: 'ACTION-BOUNDARY-CANDIDATE', ruleset_id: 'dnd_5e_2014',
    players: [{
      id: 'hero', character: 'Арбалетчик', characterClass: 'fighter', level,
      hp: 80, maxHp: 80, armor: 16, speed: 30, proficiency: 3,
      abilities: { str: 10, dex: 16, con: 14, int: 10, wis: 10, cha: 10 },
      x: 0, y: 0, alive: true,
      inventory: [...weapons, bolts],
    }],
    enemies: [{ id: 'target', name: 'Мишень', hp: 1_000, maxHp: 1_000, armor: 1, speed: 30, alive: true,
      abilities: { str: 10, dex: 10, con: 10 }, x: 3, y: 0 }],
    scene: { turn: 1, cells: Array.from({ length: 100 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true })) },
    mechanics: {
      conditions: hasted ? { hero: [{ id: 'hasted' }] } : {},
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'target', total: 1 }],
        action_economy: {
          hero: {
            action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0,
            ...(extraAction ? { extra_actions: 1, extra_action_kind: hasted ? 'haste' : 'surge', extra_action_limit: extraLimit ?? 1 } : {}),
          },
          target: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
      resources: { hero: { action_surge: { current: 1, max: 1 } } },
    },
  })
}

function apply(state, result) {
  return result.events.reduce(applyGameEvent, state)
}

function attack(state, id, itemId) {
  return resolveCommand({
    command_type: 'MakeAttack', command_id: `attack:${id}`, actor_id: 'hero', target_id: 'target', item_id: itemId,
    server_authoritative: true,
  }, state, { diceService: dice(), context: { serverAuthoritativeCombat: true, isAdmin: true } })
}

function attackWithDice(state, id, itemId, diceService) {
  return resolveCommand({
    command_type: 'MakeAttack', command_id: `attack:${id}`, actor_id: 'hero', target_id: 'target', item_id: itemId,
    server_authoritative: true,
  }, state, { diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
}

function surge(state) {
  return resolveCommand({
    command_type: 'UseCombatAction', command_id: 'surge:action', actor_id: 'hero', action_id: 'action-surge', server_authoritative: true,
  }, state, { diceService: dice(), context: { serverAuthoritativeCombat: true, isAdmin: true } })
}

function attacks(events) {
  return events.filter((event) => event.event_type === 'AttackResolved')
}

test('Fighter 5: A/B, Action Surge, C/D дают четыре атаки; пятая закрыта', () => {
  let state = battle()
  const all = []
  const sharedDice = dice()
  for (const item of ['crossbow-a', 'crossbow-b']) {
    const result = attackWithDice(state, `normal-${item}`, item, sharedDice)
    state = apply(state, result)
    all.push(...result.events)
  }
  const surgeResult = surge(state)
  state = apply(state, surgeResult)
  for (const item of ['crossbow-c', 'crossbow-d']) {
    const result = attackWithDice(state, `surged-${item}`, item, sharedDice)
    state = apply(state, result)
    all.push(...result.events)
  }
  assert.equal(attacks(all).length, 4)
  assert.equal(state.mechanics.combat.action_economy.hero.action, false)
  assert.throws(() => attack(state, 'fifth', 'crossbow-e'), (error) => error.code === 'ACTION_SPENT')
})

test('Fighter 5: Action Surge до атаки оставляет два Extra Attack в каждой из двух action', () => {
  let state = battle()
  state = apply(state, surge(state))
  const all = []
  const sharedDice = dice()
  for (const item of ['crossbow-a', 'crossbow-b', 'crossbow-c', 'crossbow-d']) {
    const result = attackWithDice(state, `before-${item}`, item, sharedDice)
    state = apply(state, result)
    all.push(...result.events)
  }
  assert.equal(attacks(all).length, 4)
  assert.throws(() => attack(state, 'before-fifth', 'crossbow-e'), (error) => error.code === 'ACTION_SPENT')
})

test('Fighter 5: Surge после первой атаки сохраняет незавершённую исходную action', () => {
  let state = battle()
  const first = attack(state, 'partial-a', 'crossbow-a')
  state = apply(state, first)
  state = apply(state, surge(state))
  const all = [...first.events]
  const sharedDice = dice()
  for (const item of ['crossbow-c', 'crossbow-d', 'crossbow-b']) {
    const result = attackWithDice(state, `partial-${item}`, item, sharedDice)
    state = apply(state, result)
    all.push(...result.events)
  }
  assert.equal(attacks(all).length, 4)
  assert.throws(() => attack(state, 'partial-fourth', 'crossbow-d'), (error) => error.code === 'ACTION_SPENT')
})

test('Action Surge очищает только action-loading: тот же A можно использовать в новой action, но не дважды в ней', () => {
  let state = battle()
  state = apply(state, attack(state, 'same-a-normal', 'crossbow-a'))
  state = apply(state, surge(state))
  const second = attack(state, 'same-a-surge', 'crossbow-a')
  state = apply(state, second)
  assert.equal(second.events.find((event) => event.event_type === 'AttackResolved').payload.attack_action_boundary, 'start')
  assert.throws(() => attack(state, 'same-a-surge-repeat', 'crossbow-a'), (error) => error.code === 'LOADING_WEAPON_LIMIT')
})

test('Fighter 11: три атаки в обычной action и три после Surge; седьмая закрыта', () => {
  let state = battle({ level: 11 })
  const all = []
  const sharedDice = dice()
  for (const item of ['crossbow-a', 'crossbow-b', 'crossbow-c']) {
    const result = attackWithDice(state, `level11-normal-${item}`, item, sharedDice)
    state = apply(state, result)
    all.push(...result.events)
  }
  state = apply(state, surge(state))
  for (const item of ['crossbow-d', 'crossbow-e', 'crossbow-f']) {
    const result = attackWithDice(state, `level11-surge-${item}`, item, sharedDice)
    state = apply(state, result)
    all.push(...result.events)
  }
  assert.equal(attacks(all).length, 6)
  assert.throws(() => attack(state, 'level11-seventh', 'crossbow-g'), (error) => error.code === 'ACTION_SPENT')
})

test('Haste: отдельная action даёт один удар, затем обычная action даёт Extra Attack', () => {
  let state = battle({ hasted: true })
  state = applyGameEvent(state, {
    event_type: 'TurnStarted', event_id: 'haste-turn-start', command_id: 'haste-turn-start', actor_id: 'hero', target_ids: ['hero'],
    payload: { round: 1, active_index: 0, action_economy_version: 2 },
  })
  assert.equal(state.mechanics.combat.action_economy.hero.attack_action_kind, 'haste')
  assert.equal(state.mechanics.combat.action_economy.hero.attack_action_limit, 1)
  assert.equal(state.mechanics.combat.action_economy.hero.attack_action_stack[0].kind, 'normal')
  const all = []
  const sharedDice = dice()
  for (const item of ['crossbow-a', 'crossbow-b', 'crossbow-c']) {
    const result = attackWithDice(state, `haste-${item}`, item, sharedDice)
    state = apply(state, result)
    all.push(...result.events)
  }
  assert.equal(attacks(all).length, 3)
  assert.equal(state.mechanics.combat.action_economy.hero.attacks_used, 2)
  assert.throws(() => attack(state, 'haste-fourth', 'crossbow-d'), (error) => error.code === 'ACTION_SPENT')
})

test('Haste loading: один и тот же арбалет может выстрелить в Haste action и ещё раз в обычной action', () => {
  let state = battle({ hasted: true })
  state = applyGameEvent(state, {
    event_type: 'TurnStarted', event_id: 'haste-loading-turn-start', command_id: 'haste-loading-turn-start', actor_id: 'hero', target_ids: ['hero'],
    payload: { round: 1, active_index: 0, action_economy_version: 2 },
  })
  const first = attack(state, 'haste-loading-first', 'crossbow-a')
  state = apply(state, first)
  const second = attack(state, 'haste-loading-second', 'crossbow-a')
  state = apply(state, second)
  assert.equal(attacks(first.events).length, 1)
  assert.equal(attacks(second.events).length, 1)
  assert.equal(second.events.find((event) => event.event_type === 'AttackResolved').payload.action_economy_version, 2)
  assert.throws(() => attack(state, 'haste-loading-third', 'crossbow-a'), (error) => error.code === 'LOADING_WEAPON_LIMIT')
})

test('Haste и Action Surge сохраняют обе дополнительные action в общей очереди', () => {
  let state = battle({ hasted: true })
  state = applyGameEvent(state, {
    event_type: 'TurnStarted', event_id: 'haste-surge-turn-start', command_id: 'haste-surge-turn-start', actor_id: 'hero', target_ids: ['hero'],
    payload: { round: 1, active_index: 0, action_economy_version: 2 },
  })
  state = apply(state, surge(state))
  const economyAfterSurge = state.mechanics.combat.action_economy.hero
  assert.equal(economyAfterSurge.attack_action_kind, 'surge')
  assert.deepEqual(economyAfterSurge.attack_action_stack.map((frame) => frame.kind), ['haste', 'normal'])
  const all = []
  const sharedDice = dice()
  for (const item of ['crossbow-a', 'crossbow-b', 'crossbow-c', 'crossbow-d', 'crossbow-e']) {
    const result = attackWithDice(state, `haste-surge-${item}`, item, sharedDice)
    state = apply(state, result)
    all.push(...result.events)
  }
  assert.equal(attacks(all).length, 5)
  assert.equal(state.mechanics.combat.action_economy.hero.action, false)
  assert.throws(() => attack(state, 'haste-surge-sixth', 'crossbow-f'), (error) => error.code === 'ACTION_SPENT')
})

test('новые события имеют версию action boundary, старый replay остаётся legacy', () => {
  const initial = battle()
  const first = attack(initial, 'versioned', 'crossbow-a')
  const attackEvent = first.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(attackEvent.payload.action_economy_version, 2)
  assert.ok(attackEvent.payload.attack_action_id)
  const surgeResult = surge(apply(initial, first))
  assert.equal(surgeResult.events.find((event) => event.event_type === 'CombatActionUsed').payload.action_economy_version, 2)
  assert.equal(replayEvents(initial, first.events).mechanics.combat.action_economy.hero.attacks_used, 1)

  const legacyEvent = {
    event_type: 'AttackResolved', event_id: 'legacy-attack', command_id: 'legacy-attack', actor_id: 'hero', target_ids: ['target'],
    payload: { kept: 1, modifier: 0, total: 1, armor_class: 20, hit: false, economy: { action: true, attack: true }, item_id: 'crossbow-a' },
  }
  const legacy = applyGameEvent(battle(), legacyEvent)
  assert.equal(legacy.mechanics.combat.action_economy.hero.attacks_used, 1)
  assert.equal(legacy.mechanics.combat.action_economy.hero.attack_action_id, undefined)

  const legacySurge = applyGameEvent(legacy, {
    event_type: 'CombatActionUsed', event_id: 'legacy-surge', command_id: 'legacy-surge', actor_id: 'hero', target_ids: ['hero'],
    payload: { action_id: 'action-surge', action_type: 'free', restore_action: true },
  })
  assert.equal(legacySurge.mechanics.combat.action_economy.hero.attacks_used, 1)
  assert.equal(legacySurge.mechanics.combat.action_economy.hero.attack_action_id, undefined)

  const legacyTurn = applyGameEvent(battle(), {
    event_type: 'TurnStarted', event_id: 'legacy-turn', command_id: 'legacy-turn', actor_id: 'hero', target_ids: ['hero'],
    payload: { round: 1, active_index: 0 },
  })
  assert.equal(legacyTurn.mechanics.combat.action_economy.hero.action_economy_version, undefined)
  assert.equal(legacyTurn.mechanics.combat.action_economy.hero.attack_action_id, undefined)
  assert.equal(legacyTurn.mechanics.combat.action_economy.hero.attack_action_stack, undefined)
})

test('полная последовательность Surge совпадает с replay событий', () => {
  const initial = battle()
  let state = initial
  const events = []
  const sharedDice = dice()
  for (const item of ['crossbow-a', 'crossbow-b']) {
    const result = attackWithDice(state, `replay-normal-${item}`, item, sharedDice)
    state = apply(state, result)
    events.push(...result.events)
  }
  const surgeResult = surge(state)
  state = apply(state, surgeResult)
  events.push(...surgeResult.events)
  for (const item of ['crossbow-c', 'crossbow-d']) {
    const result = attackWithDice(state, `replay-surge-${item}`, item, sharedDice)
    state = apply(state, result)
    events.push(...result.events)
  }
  assert.deepEqual(replayEvents(initial, events), state)
})

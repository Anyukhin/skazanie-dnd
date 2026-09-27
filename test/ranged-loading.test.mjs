import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

const cells = Array.from({ length: 100 }, (_, index) => ({
  x: index % 10,
  y: Math.floor(index / 10),
  type: 'floor',
  revealed: true,
}))

function dice(values = [15, 1, 15, 1]) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `ranged-loading-${++id}`,
    now: () => '2026-09-22T00:00:00.000Z',
  })
}

function state({ crossbowExpert = false, targetX = 3 } = {}) {
  const crossbow = materializeCatalogItem('srd_5_2_1:light-crossbow', { id: 'crossbow-1', quantity: 1, equipped: true })
  const crossbowTwo = materializeCatalogItem('srd_5_2_1:light-crossbow', { id: 'crossbow-2', quantity: 1, equipped: true })
  const sword = materializeCatalogItem('srd_5_2_1:longsword', { id: 'sword-1', quantity: 1, equipped: true })
  const longbow = materializeCatalogItem('srd_5_2_1:longbow', { id: 'longbow-1', quantity: 1, equipped: true })
  const bolts = materializeCatalogItem('srd_5_2_1:bolts-20', { id: 'bolts-1', quantity: 1 })
  const arrows = materializeCatalogItem('srd_5_2_1:arrows-20', { id: 'arrows-1', quantity: 1 })
  return normalizeCampaignState({
    sessionCode: 'RANGED-LOADING',
    ruleset_id: 'dnd_5e_2014',
    players: [{
      id: 'hero', character: 'Арбалетчик', characterClass: 'fighter', level: 5,
      hp: 40, maxHp: 40, armor: 16, speed: 30, proficiency: 3,
      abilities: { str: 10, dex: 16, con: 14, int: 10, wis: 10, cha: 10 },
      ...(crossbowExpert ? { creationBenefits: { static: { ignore_loading_property: true } } } : {}),
      x: 0, y: 0, alive: true, inventory: [crossbow, crossbowTwo, sword, longbow, bolts, arrows],
    }],
    enemies: [{ id: 'target', name: 'Мишень', hp: 100, maxHp: 100, armor: 1, speed: 30,
      abilities: { str: 10, dex: 10, con: 10 }, x: targetX, y: 0, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      combat: { active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'target', total: 1 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          target: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
      resources: { hero: { action_surge: { current: 1, max: 1 } } },
    },
  })
}

function attack(s, id, itemId = 'crossbow-1') {
  return resolveCommand({ command_type: 'MakeAttack', command_id: `loading:${id}`, actor_id: 'hero', target_id: 'target', item_id: itemId, server_authoritative: true }, s, {
    diceService: dice(),
    context: { serverAuthoritativeCombat: true, isAdmin: true },
  })
}

test('перезарядка не позволяет вторично выстрелить из того же оружия за действие', () => {
  const initial = state()
  const first = attack(initial, 'first')
  const afterFirst = first.events.reduce(applyGameEvent, initial)
  assert.throws(() => attack(afterFirst, 'second'), (error) => error.code === 'LOADING_WEAPON_LIMIT')
})

test('удар другим оружием оставляет первый выстрел из арбалета за тем же действием', () => {
  for (const [previousItem, targetX] of [['sword-1', 1], ['longbow-1', 3]]) {
    const initial = state({ targetX })
    const previous = attack(initial, `previous-${previousItem}`, previousItem)
    const afterPrevious = previous.events.reduce(applyGameEvent, initial)
    const firstCrossbow = attack(afterPrevious, `crossbow-first-${previousItem}`)
    const afterCrossbow = firstCrossbow.events.reduce(applyGameEvent, afterPrevious)
    assert.ok(firstCrossbow.events.some((event) => event.event_type === 'AttackResolved'), previousItem)
    assert.throws(() => attack(afterCrossbow, `crossbow-second-${previousItem}`), (error) => error.code === 'LOADING_WEAPON_LIMIT', previousItem)
  }
})

test('A→B→A не обходит loading: хранятся все экземпляры, а не только последний', () => {
  const initial = state()
  const first = attack(initial, 'instance-a-1', 'crossbow-1')
  const afterFirst = first.events.reduce(applyGameEvent, initial)
  const second = attack(afterFirst, 'instance-b', 'crossbow-2')
  const afterSecond = second.events.reduce(applyGameEvent, afterFirst)
  assert.deepEqual(afterSecond.mechanics.combat.action_economy.hero.loading_weapon_item_ids.action.sort(), ['crossbow-1', 'crossbow-2'])
  assert.throws(() => attack(afterSecond, 'instance-a-2', 'crossbow-1'), (error) => error.code === 'LOADING_WEAPON_LIMIT')
})

test('Всплеск действий открывает новый выстрел из того же экземпляра', () => {
  const initial = state()
  const first = attack(initial, 'first')
  const afterFirst = first.events.reduce(applyGameEvent, initial)
  const surge = resolveCommand({ command_type: 'UseCombatAction', command_id: 'loading:surge', actor_id: 'hero', action_id: 'action-surge', server_authoritative: true }, afterFirst, {
    diceService: dice(),
    context: { serverAuthoritativeCombat: true, isAdmin: true },
  })
  const afterSurge = surge.events.reduce(applyGameEvent, afterFirst)
  assert.deepEqual(afterSurge.mechanics.combat.action_economy.hero.loading_weapon_item_ids, { action: [], bonus_action: [], reaction: [] })
  const second = attack(afterSurge, 'surge-first')
  assert.ok(second.events.some((event) => event.event_type === 'AttackResolved'))
})

test('Всплеск до действия разделяет обычное действие и следующее действие для loading', () => {
  const initial = state()
  const surge = resolveCommand({ command_type: 'UseCombatAction', command_id: 'loading:surge-before', actor_id: 'hero', action_id: 'action-surge', server_authoritative: true }, initial, {
    diceService: dice(),
    context: { serverAuthoritativeCombat: true, isAdmin: true },
  })
  const afterSurge = surge.events.reduce(applyGameEvent, initial)
  const first = attack(afterSurge, 'surged-action-first')
  const afterFirst = first.events.reduce(applyGameEvent, afterSurge)
  assert.deepEqual(afterFirst.mechanics.combat.action_economy.hero.loading_weapon_item_ids.action, ['crossbow-1'])
  assert.throws(() => attack(afterFirst, 'surged-action-second-same'), (error) => error.code === 'LOADING_WEAPON_LIMIT')
  const second = attack(afterFirst, 'surged-action-second-other', 'crossbow-2')
  const afterSecond = second.events.reduce(applyGameEvent, afterFirst)
  assert.ok(second.events.some((event) => event.event_type === 'AttackResolved'))
  assert.deepEqual(afterSecond.mechanics.combat.action_economy.hero.loading_weapon_item_ids.action, [])
  const normal = attack(afterSecond, 'surged-action-normal-again')
  assert.ok(normal.events.some((event) => event.event_type === 'AttackResolved'))
})

test('A→Surge→A→A открывает новое action, затем закрывает loading в нём', () => {
  const initial = state()
  const first = attack(initial, 'before-surge')
  const afterFirst = first.events.reduce(applyGameEvent, initial)
  const surge = resolveCommand({ command_type: 'UseCombatAction', command_id: 'loading:surge-after', actor_id: 'hero', action_id: 'action-surge', server_authoritative: true }, afterFirst, {
    diceService: dice(),
    context: { serverAuthoritativeCombat: true, isAdmin: true },
  })
  const afterSurge = surge.events.reduce(applyGameEvent, afterFirst)
  const second = attack(afterSurge, 'after-surge-first')
  const afterSecond = second.events.reduce(applyGameEvent, afterSurge)
  assert.ok(second.events.some((event) => event.event_type === 'AttackResolved'))
  assert.throws(() => attack(afterSecond, 'after-surge-second'), (error) => error.code === 'LOADING_WEAPON_LIMIT')
})

test('Эксперт в арбалетах игнорирует ограничение перезарядки', () => {
  const initial = state({ crossbowExpert: true })
  const first = attack(initial, 'first')
  const afterFirst = first.events.reduce(applyGameEvent, initial)
  const second = attack(afterFirst, 'second')
  assert.equal(second.events.filter((event) => event.event_type === 'AttackResolved').length, 1)
})

test('Crossbow Expert игнорирует loading только у арбалета, но не у духовой трубки', () => {
  const initial = state({ crossbowExpert: true })
  const blowgun = materializeCatalogItem('srd_5_2_1:blowgun', { id: 'blowgun-1', name: 'Ручной арбалет', quantity: 1, equipped: true })
  const needles = materializeCatalogItem('srd_5_2_1:needles-50', { id: 'needles-1', quantity: 1 })
  const withBlowgun = normalizeCampaignState({
    ...initial,
    players: [{ ...initial.players[0], inventory: [...initial.players[0].inventory, blowgun, needles] }],
  })
  const first = attack(withBlowgun, 'blowgun-first', 'blowgun-1')
  const afterFirst = first.events.reduce(applyGameEvent, withBlowgun)
  assert.throws(() => attack(afterFirst, 'blowgun-second', 'blowgun-1'), (error) => error.code === 'LOADING_WEAPON_LIMIT')
})

test('пустой боезапас отказывает до броска и не расходует action или loading marker', () => {
  const initial = state({})
  const empty = normalizeCampaignState({
    ...initial,
    players: [{ ...initial.players[0], inventory: initial.players[0].inventory.filter((item) => item.id !== 'bolts-1') }],
  })
  const before = structuredClone(empty)
  assert.throws(() => attack(empty, 'no-ammo'), (error) => error.code === 'AMMUNITION_SPENT')
  assert.deepEqual(empty, before)
})

test('законный quick-toss с метательным кинжалом тратит только bonus_action', () => {
  const initial = state()
  const dagger = materializeCatalogItem('srd_5_2_1:dagger', { id: 'dagger-1', quantity: 1, equipped: true })
  const bonus = normalizeCampaignState({
    ...initial,
    players: [{ ...initial.players[0], subclass: 'Мастер боевых искусств', inventory: [...initial.players[0].inventory, dagger] }],
    mechanics: { ...initial.mechanics, resources: { hero: { superiority_dice: { current: 1, max: 1 } } } },
  })
  const result = resolveCommand({
    command_type: 'UseCombatAction', command_id: 'loading:quick-toss', actor_id: 'hero', action_id: 'quick-toss',
    target_id: 'target', item_id: 'dagger-1', attack_mode: 'thrown', server_authoritative: true,
  }, bonus, { diceService: dice([15, 1, 1]), context: { serverAuthoritativeCombat: true, isAdmin: true } })
  const after = result.events.reduce(applyGameEvent, bonus)
  assert.equal(after.mechanics.combat.action_economy.hero.action, true)
  assert.equal(after.mechanics.combat.action_economy.hero.bonus_action, false)
  assert.deepEqual(after.mechanics.combat.action_economy.hero.loading_weapon_item_ids.bonus_action, [])
})

test('серверный AttackResolved-контракт изолирует synthetic loading marker для bonus_action', () => {
  const initial = state()
  const after = applyGameEvent(initial, {
    event_type: 'AttackResolved', event_id: 'loading:synthetic-bonus', command_id: 'loading:synthetic-bonus',
    actor_id: 'hero', target_ids: ['target'], payload: {
      kept: 1, modifier: 0, total: 1, armor_class: 20, hit: false,
      item_id: 'crossbow-1', loading_weapon: true, loading_limit_applies: true,
      loading_action_type: 'bonus_action', economy: { action: false, attack: false },
    },
  })
  assert.equal(after.mechanics.combat.action_economy.hero.action, true)
  assert.deepEqual(after.mechanics.combat.action_economy.hero.loading_weapon_item_ids, { action: [], bonus_action: ['crossbow-1'], reaction: [] })
})

test('HTTP MakeAttack sanitizer отбрасывает spoof reaction_attack и loading_action_type', () => {
  const source = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('function normalizeMakeAttackCommand')
  const end = source.indexOf('\nasync function assertMakeAttackIdempotency', start)
  assert.ok(start >= 0 && end > start, 'HTTP sanitizer должен существовать в server/index.mjs')
  const sandbox = {
    commandType: (input) => String(input?.command_type ?? input?.type ?? ''),
    authoritativeCombatCommandBase: (input) => ({
      command_type: 'MakeAttack', actor_id: String(input?.actor_id ?? ''), server_authoritative: true,
    }),
    commandPolicyError: (message, code) => Object.assign(new Error(message), { code }),
    makeAttackCommandFingerprint: () => 'test-fingerprint',
  }
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.sanitize = normalizeMakeAttackCommand`, sandbox)
  const sanitized = sandbox.sanitize({
    command_type: 'MakeAttack', actor_id: 'hero', target_id: 'target', item_id: 'crossbow-1',
    attack_mode: 'ranged', attack_ability: 'dex', reaction_attack: true, loading_action_type: 'bonus_action',
  })
  assert.equal(sanitized.reaction_attack, undefined)
  assert.equal(sanitized.loading_action_type, undefined)
  assert.equal(sanitized.attack_mode, 'ranged')
  assert.equal(sanitized.attack_ability, 'dex')
})

test('заготовленная loading-атака расходует отдельную реакцию и сохраняет action', () => {
  const initial = state()
  initial.mechanics.combat.readied = { hero: { readied_action_id: 'readied-attack', item_id: 'crossbow-1', trigger: 'enemy-approaches' } }
  initial.mechanics.combat.reaction_window = {
    id: 'loading:reaction-window', trigger: 'enemy-approaches', actor_id: 'hero', source_actor_id: 'target', target_id: 'target',
    action_ids: ['readied-attack'], action_options: [{ id: 'readied-attack', action_type: 'reaction' }],
  }
  const result = resolveCommand({
    command_type: 'UseCombatAction', command_id: 'loading:readied', actor_id: 'hero', action_id: 'readied-attack', server_authoritative: true,
  }, initial, { diceService: dice(), context: { serverAuthoritativeCombat: true, isAdmin: true } })
  const attackEvent = result.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(attackEvent.payload.reaction_attack, true)
  assert.equal(attackEvent.payload.loading_action_type, 'reaction')
  const after = result.events.reduce(applyGameEvent, initial)
  assert.equal(after.mechanics.combat.action_economy.hero.action, true)
  assert.equal(after.mechanics.combat.action_economy.hero.reaction, false)
  assert.deepEqual(after.mechanics.combat.action_economy.hero.loading_weapon_item_ids.reaction, ['crossbow-1'])
})

test('маркер loading детерминирован, идемпотентен по command_id и совпадает после replay', () => {
  const initial = state()
  const first = attack(initial, 'stable')
  const repeated = attack(initial, 'stable')
  assert.deepEqual(first.events, repeated.events)
  const reduced = first.events.reduce(applyGameEvent, initial)
  assert.deepEqual(replayEvents(initial, first.events), reduced)
  assert.deepEqual(reduced.mechanics.combat.action_economy.hero.loading_weapon_item_ids.action, ['crossbow-1'])
})

test('начало следующего хода очищает loading для всех трёх ресурсов', () => {
  const initial = state()
  const after = attack(initial, 'turn-marker').events.reduce(applyGameEvent, initial)
  const nextTurn = applyGameEvent(after, {
    event_type: 'TurnStarted', event_id: 'loading:turn-start', command_id: 'loading:turn-start', actor_id: 'hero', target_ids: ['hero'],
    created_at: '2026-09-22T00:00:01.000Z', payload: { round: 2, active_index: 0 },
  })
  assert.deepEqual(nextTurn.mechanics.combat.action_economy.hero.loading_weapon_item_ids, { action: [], bonus_action: [], reaction: [] })
})

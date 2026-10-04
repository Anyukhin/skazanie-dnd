import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { lootContainersForViewer } from '../server/loot-containers.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

// Брошенное оружие героя падает у цели и подбирается (решение владельца
// 2026-10-04, исследование PR #136). До этого кинжал можно было метать каждый
// ход, не выпуская из руки: метательное оружие героя не тратилось вовсе.

let rollId = 0
function run(state, command, values = [], context = {}) {
  return resolveCommand({ ...command, server_authoritative: true }, state, {
    diceService: new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `thrown-roll-${++rollId}` }),
    context: { serverAuthoritativeCombat: true, isAdmin: true, ...context },
  })
}
const after = (state, result) => result.events.reduce(applyGameEvent, state)

function fixture({ inventory, combat = true, economy = {} } = {}) {
  const dagger = { ...materializeCatalogItem('srd_5_2_1:dagger', { id: 'dagger', quantity: 2 }), equipped: true }
  return normalizeCampaignState({
    sessionCode: 'THROWN-DROP',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Плут', characterClass: 'rogue', level: 3, hp: 20, maxHp: 20, armor: 14, speed: 30, proficiency: 2,
      abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 10, cha: 10 }, inventory: inventory ?? [dagger], x: 1, y: 1 }],
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 40, maxHp: 40, armor: 10, speed: 30, abilities: { str: 8, dex: 10 }, x: 4, y: 1, alive: true }],
    scene: { turn: 1, location: 'Двор', cells: Array.from({ length: 36 }, (_, i) => ({ x: i % 12, y: Math.floor(i / 12), type: 'floor', revealed: true })) },
    mechanics: combat ? { combat: { active: true, round: 1, active_index: 0,
      initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'goblin', total: 5 }],
      action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0, object_interaction: true, ...economy } } } } : {},
  })
}

const throwDagger = (state, values = [15, 3], itemId = 'dagger') =>
  run(state, { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'goblin', item_id: itemId, attack_mode: 'thrown' }, values)
const droppedIn = (state) => (state.loot_containers?.containers ?? []).filter((container) => container.kind === 'dropped')
const heroItem = (state, id) => state.players[0].inventory.find((item) => item.id === id)

test('брошенный кинжал уходит из руки и ложится у цели — тем же событием, replay совпадает', () => {
  const state = fixture()
  const result = throwDagger(state)
  const created = result.events.filter((event) => event.event_type === 'LootContainerCreated')
  assert.equal(created.length, 1)
  assert.equal(created[0].payload.thrown_weapon.item_id, 'dagger')
  const next = after(state, result)
  assert.equal(heroItem(next, 'dagger').quantity, 1, 'из стопки в два ушёл один')
  const [container] = droppedIn(next)
  assert.equal(container.name, 'Брошенное оружие: Кинжал')
  assert.deepEqual({ x: container.x, y: container.y }, { x: 4, y: 1 }, 'лежит у цели')
  assert.deepEqual(container.items.map((item) => [item.catalog_id, item.quantity]), [['srd_5_2_1:dagger', 1]])
  const replayed = replayEvents(state, result.events)
  assert.deepEqual(replayed.players[0].inventory, next.players[0].inventory)
  assert.deepEqual(replayed.loot_containers, next.loot_containers)
  // Повторное применение того же события не забирает второй кинжал.
  const twice = result.events.filter((event) => event.event_type === 'LootContainerCreated').reduce(applyGameEvent, next)
  assert.equal(heroItem(twice, 'dagger').quantity, 1)
})

test('на промахе кинжал тоже падает у цели', () => {
  const state = fixture()
  const result = throwDagger(state, [1, 3])
  assert.equal(result.events.find((event) => event.event_type === 'AttackResolved').payload.hit, false)
  assert.equal(droppedIn(after(state, result)).length, 1)
})

test('последний кинжал покидает инвентарь, и метнуть его снова нельзя', () => {
  const single = [{ ...materializeCatalogItem('srd_5_2_1:dagger', { id: 'dagger', quantity: 1 }), equipped: true }]
  const state = fixture({ inventory: single })
  const next = after(state, throwDagger(state))
  assert.equal(heroItem(next, 'dagger'), undefined)
  next.mechanics.combat.action_economy.hero = { ...next.mechanics.combat.action_economy.hero, action: true, attacks_used: 0 }
  assert.throws(() => throwDagger(next))
})

test('удар кинжалом в упор ничего не роняет', () => {
  const state = fixture()
  state.enemies[0].x = 2
  state.mechanics.positions = { ...(state.mechanics.positions ?? {}), goblin: { x: 2, y: 1 } }
  const result = run(state, { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'goblin', item_id: 'dagger' }, [15, 3])
  assert.equal(result.events.some((event) => event.event_type === 'LootContainerCreated'), false)
  assert.equal(heroItem(after(state, result), 'dagger').quantity, 2)
})

test('самодельное метательное оружие без записи каталога остаётся в руке, как раньше', () => {
  const homemade = [{ id: 'rock', name: 'Камень', type: 'weapon', quantity: 1, equipped: true,
    combat: { kind: 'melee', ability: 'str', damage: '1d4', damageType: 'bludgeoning', normalRange: 5,
      modes: [{ id: 'thrown', kind: 'ranged', thrown: true, ability: 'str', damage: '1d4', damageType: 'bludgeoning', normalRange: 20, longRange: 60 }] } }]
  const state = fixture({ inventory: homemade })
  const result = throwDagger(state, [15, 3], 'rock')
  assert.equal(result.events.some((event) => event.event_type === 'LootContainerCreated'), false)
  assert.equal(heroItem(after(state, result), 'rock').quantity, 1)
})

test('поднять своё оружие в бою — взаимодействие с предметом, второе уже стоит действия', () => {
  let state = after(fixture(), throwDagger(fixture()))
  state = after(state, run(state, { command_type: 'MoveActor', actor_id: 'hero', to: { x: 3, y: 1 } }))
  const [container] = droppedIn(state)
  const lines = [{ item_instance_id: container.items[0].item_instance_id, quantity: 1 }]
  // Действие уже ушло на бросок, а подобрать всё равно можно.
  assert.equal(state.mechanics.combat.action_economy.hero.action, false)
  const pick = run(state, { command_type: 'LootContainer', actor_id: 'hero', container_id: container.id, lines })
  assert.equal(pick.events[0].payload.combat_action, 'object_interaction')
  const picked = after(state, pick)
  assert.equal(picked.players[0].inventory.filter((item) => item.catalog_id === 'srd_5_2_1:dagger').reduce((sum, item) => sum + item.quantity, 0), 2)
  assert.equal(picked.mechanics.combat.action_economy.hero.object_interaction, false)
  assert.equal(droppedIn(picked)[0].status, 'emptied')

  // Взаимодействие потрачено и действия нет — поднять второй кинжал нельзя.
  let two = after(fixture(), throwDagger(fixture()))
  two.mechanics.combat.action_economy.hero = { ...two.mechanics.combat.action_economy.hero, action: true, attacks_used: 0, attack_action_limit: 2 }
  two = after(two, throwDagger(two))
  two = after(two, run(two, { command_type: 'MoveActor', actor_id: 'hero', to: { x: 3, y: 1 } }))
  const containers = droppedIn(two)
  assert.equal(containers.length, 2)
  two.mechanics.combat.action_economy.hero = { ...two.mechanics.combat.action_economy.hero, action: false, object_interaction: false }
  assert.throws(() => run(two, { command_type: 'LootContainer', actor_id: 'hero', container_id: containers[1].id,
    lines: [{ item_instance_id: containers[1].items[0].item_instance_id, quantity: 1 }] }), (error) => error.code === 'ACTION_SPENT')
})

test('поднять можно только вплотную; кинжал возвращается в ту же стопку и снова метается', () => {
  const thrown = after(fixture(), throwDagger(fixture()))
  const [container] = droppedIn(thrown)
  const lines = [{ item_instance_id: container.items[0].item_instance_id, quantity: 1 }]
  assert.throws(() => run(thrown, { command_type: 'LootContainer', actor_id: 'hero', container_id: container.id, lines }),
    (error) => error.code === 'LOOT_CONTAINER_OUT_OF_REACH')
  let state = after(thrown, run(thrown, { command_type: 'MoveActor', actor_id: 'hero', to: { x: 3, y: 1 } }))
  const pick = run(state, { command_type: 'LootContainer', actor_id: 'hero', container_id: container.id, lines })
  state = after(state, pick)
  assert.deepEqual(state.players[0].inventory.map((item) => [item.id, item.quantity, item.equipped]), [['dagger', 2, true]],
    'не новая строка, а та же экипированная стопка')
  assert.deepEqual(replayEvents(thrown, pick.events).players[0].inventory, after(thrown, pick).players[0].inventory)
  state.mechanics.combat.action_economy.hero = { ...state.mechanics.combat.action_economy.hero, action: true, attacks_used: 0 }
  assert.ok(throwDagger(state).events.some((event) => event.event_type === 'AttackResolved'))
})

test('последний брошенный кинжал возвращается под прежним идентификатором', () => {
  const single = [{ ...materializeCatalogItem('srd_5_2_1:dagger', { id: 'dagger', quantity: 1 }), equipped: true }]
  let state = after(fixture({ inventory: single }), throwDagger(fixture({ inventory: single })))
  assert.equal(heroItem(state, 'dagger'), undefined)
  state = after(state, run(state, { command_type: 'MoveActor', actor_id: 'hero', to: { x: 3, y: 1 } }))
  const [container] = droppedIn(state)
  state = after(state, run(state, { command_type: 'LootContainer', actor_id: 'hero', container_id: container.id,
    lines: [{ item_instance_id: container.items[0].item_instance_id, quantity: 1 }] }))
  const dagger = heroItem(state, 'dagger')
  assert.equal(dagger?.quantity, 1)
  assert.equal(dagger.catalog_id, 'srd_5_2_1:dagger')
  assert.equal(dagger.equipped, false, 'в руку сам не прыгает: руки могут быть заняты')
})

test('клиент не может сам назначить, в какую стопку вернуть вещь', () => {
  const state = after(fixture(), throwDagger(fixture()))
  const [container] = droppedIn(state)
  assert.throws(() => run(state, { command_type: 'LootContainer', actor_id: 'hero', container_id: container.id,
    lines: [{ item_instance_id: container.items[0].item_instance_id, quantity: 1 }], loot_returns: [{ item_id: 'x', to_item_id: 'dagger' }] }),
  (error) => error.code === 'LOOT_COMMAND_UNKNOWN_FIELD')
})

test('отряд видит брошенное оружие на доске', () => {
  const state = after(fixture(), throwDagger(fixture()))
  const visible = lootContainersForViewer(state, { actorId: 'hero' })
  const card = (Array.isArray(visible) ? visible : visible?.containers ?? []).find((entry) => entry.kind === 'dropped')
  assert.ok(card, JSON.stringify(visible).slice(0, 300))
  assert.equal(card.name, 'Брошенное оружие: Кинжал')
})

test('карточка называет цену подбора до нажатия: своё брошенное — взаимодействие', async () => {
  const { lootTakeButtonState } = await import('../src/loot-panel-rules.mjs')
  const state = after(fixture(), throwDagger(fixture()))
  const card = lootContainersForViewer(state, { actorId: 'hero' }).containers.find((entry) => entry.kind === 'dropped')
  assert.equal(card.action_cost, 'object_interaction')
  state.mechanics.combat.action_economy.hero = { ...state.mechanics.combat.action_economy.hero, object_interaction: false }
  assert.equal(lootContainersForViewer(state, { actorId: 'hero' }).containers.find((entry) => entry.kind === 'dropped').action_cost, 'action',
    'взаимодействие потрачено — подбор стоит действия, и карточка говорит это заранее')
  const button = lootTakeButtonState({ canAct: true, canInspect: true, reachFeet: 5, actionCost: 'object_interaction', actionSpent: true, chosenCount: 1 })
  assert.equal(button.disabled, false, 'потраченное действие не мешает поднять своё оружие')
  assert.match(button.label, /Поднять/u)
})

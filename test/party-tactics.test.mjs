import assert from 'node:assert/strict'
import test from 'node:test'

import { HEAL_THRESHOLD_RATIO, healingTargetFor, planHeroTurn } from '../server/party-tactics.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'

const POTION = { id: 'item-potion', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье лечения', quantity: 1, type: 'consumable' }
const SWORD = { id: 'item-sword', catalog_id: 'srd_5_2_1:longsword', name: 'Длинный меч', quantity: 1, type: 'weapon', equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', range: 5 } }

// Пустая сцена ломает поиск пути: без клеток герой не может дойти никуда, и
// любой план вырождается в EndTurn. Проверять тактику на такой карте бессмысленно.
const floor = (size = 12) => {
  const cells = []
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) cells.push({ x, y, type: 'floor', revealed: true })
  return cells
}

function battle({ heroes = [], enemies = [], positions = {} } = {}) {
  return normalizeCampaignState({
    sessionCode: 'TACTICS',
    partyMemberIds: heroes.map((hero) => hero.id),
    activePlayerId: heroes[0]?.id,
    scene: { title: 'Схватка', location: 'Ворота', cells: floor() },
    players: heroes,
    enemies,
    mechanics: {
      positions,
      combat: { active: true, round: 1, initiative: [], active_index: 0 },
    },
  })
}

const hero = (id, overrides = {}) => ({
  id, character: id, hp: 12, maxHp: 12, speed: 30,
  abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
  inventory: [SWORD], ...overrides,
})

const enemy = (id, overrides = {}) => ({
  id, name: id, hp: 10, maxHp: 10, armor: 12, speed: 30, attackBonus: 3, damageDice: 6, damageBonus: 1,
  action_profiles: [{ id: 'claw', name: 'Коготь', kind: 'melee', attack_modifier: 3, damage_expression: '1d6+1', damage_type: 'slashing', range_feet: 5 }],
  ...overrides,
})

test('упавший союзник лечится раньше, чем наносится ещё один удар', () => {
  const state = battle({
    heroes: [hero('medic', { inventory: [SWORD, POTION] }), hero('fallen', { hp: 0 })],
    enemies: [enemy('wolf', { hp: 1 })],
    positions: { medic: { x: 1, y: 1 }, fallen: { x: 2, y: 1 }, wolf: { x: 1, y: 2 } },
  })
  const plan = planHeroTurn(state, 'medic')

  assert.equal(plan.rule, 'heal-ally')
  const use = plan.commands.find((command) => command.command_type === 'UseItem')
  assert.ok(use, 'зелье обязано быть применено')
  assert.equal(use.target_id, 'fallen')
  assert.equal(use.item_id, 'item-potion')
  assert.equal(plan.commands.at(-1).command_type, 'EndTurn')
})

test('без зелья в сумке герой не пытается лечить и просто дерётся', () => {
  const state = battle({
    heroes: [hero('medic'), hero('fallen', { hp: 0 })],
    enemies: [enemy('wolf')],
    positions: { medic: { x: 1, y: 1 }, fallen: { x: 2, y: 1 }, wolf: { x: 1, y: 2 } },
  })
  const plan = planHeroTurn(state, 'medic')

  assert.equal(plan.commands.some((command) => command.command_type === 'UseItem'), false)
  assert.equal(plan.rule, 'attack-adjacent')
})

test('противник вплотную бьётся первым, а не тот, у кого меньше ОЗ на другом конце карты', () => {
  const state = battle({
    heroes: [hero('fighter')],
    enemies: [enemy('adjacent-orc', { hp: 9 }), enemy('far-wounded', { hp: 1 })],
    positions: { fighter: { x: 1, y: 1 }, 'adjacent-orc': { x: 1, y: 2 }, 'far-wounded': { x: 9, y: 9 } },
  })
  const plan = planHeroTurn(state, 'fighter')

  assert.equal(plan.rule, 'attack-adjacent')
  assert.equal(plan.commands.some((command) => command.command_type === 'MoveActor'), false)
  const attack = plan.commands.find((command) => command.command_type === 'MakeAttack')
  assert.equal(attack.target_id, 'adjacent-orc')
  assert.equal(attack.item_id, 'item-sword', 'автономный герой обязан бить экипированным оружием, а не базовым уроном')
})

test('сбитый с ног автономный герой встаёт до атаки и платит половиной скорости', () => {
  const state = battle({
    heroes: [hero('fighter')],
    enemies: [enemy('adjacent-wolf')],
    positions: { fighter: { x: 1, y: 1 }, 'adjacent-wolf': { x: 1, y: 2 } },
  })
  state.mechanics.conditions.fighter = [{ id: 'prone', source_actor: 'adjacent-wolf' }]

  const plan = planHeroTurn(state, 'fighter')
  assert.deepEqual(plan.commands.map((command) => command.command_type), ['UseCombatAction', 'MakeAttack', 'EndTurn'])
  assert.equal(plan.commands[0].action_id, 'stand-up')

  const distant = battle({
    heroes: [hero('fighter')],
    enemies: [enemy('distant-wolf')],
    positions: { fighter: { x: 1, y: 1 }, 'distant-wolf': { x: 6, y: 1 } },
  })
  distant.mechanics.conditions.fighter = [{ id: 'prone', source_actor: 'distant-wolf' }]
  const advance = planHeroTurn(distant, 'fighter')
  const move = advance.commands.find((command) => command.command_type === 'MoveActor')
  assert.deepEqual(move?.to, { x: 4, y: 1 }, 'после подъёма остаётся только 15 футов движения')
  assert.equal(advance.commands.some((command) => command.command_type === 'MakeAttack'), false)
})

test('когда рядом никого — прежнее сосредоточение огня на самом раненом', () => {
  const state = battle({
    heroes: [hero('fighter')],
    enemies: [enemy('healthy', { hp: 10 }), enemy('wounded', { hp: 2 })],
    positions: { fighter: { x: 1, y: 1 }, healthy: { x: 5, y: 1 }, wounded: { x: 4, y: 1 } },
  })
  const plan = planHeroTurn(state, 'fighter')

  const attack = plan.commands.find((command) => command.command_type === 'MakeAttack')
  assert.ok(plan.commands.some((command) => command.command_type === 'MoveActor'), 'до цели надо дойти')
  assert.equal(attack?.target_id, 'wounded')
})

test('герой лечит сам себя, когда упал ниже порога и рядом никого нет', () => {
  const state = battle({
    heroes: [hero('lonely', { hp: 3, inventory: [SWORD, POTION] })],
    enemies: [enemy('wolf')],
    positions: { lonely: { x: 1, y: 1 }, wolf: { x: 8, y: 8 } },
  })
  const plan = planHeroTurn(state, 'lonely')

  assert.equal(plan.rule, 'heal-self')
  const use = plan.commands.find((command) => command.command_type === 'UseItem')
  assert.equal(use.target_id, 'lonely')
})

test('здоровый отряд зелья не тратит', () => {
  const state = battle({
    heroes: [hero('fighter', { inventory: [SWORD, POTION] }), hero('ally', { hp: 12 })],
    enemies: [enemy('wolf')],
    positions: { fighter: { x: 1, y: 1 }, ally: { x: 2, y: 1 }, wolf: { x: 1, y: 2 } },
  })
  const plan = planHeroTurn(state, 'fighter')

  assert.equal(plan.commands.some((command) => command.command_type === 'UseItem'), false)
  assert.equal(plan.rule, 'attack-adjacent')
})

test('порог лечения объявлен и применяется к максимуму ОЗ, а не к абсолютному числу', () => {
  assert.ok(HEAL_THRESHOLD_RATIO > 0 && HEAL_THRESHOLD_RATIO < 1)
  const state = battle({
    heroes: [hero('tank', { hp: 30, maxHp: 100 }), hero('scout', { hp: 5, maxHp: 8 })],
    enemies: [enemy('wolf')],
    positions: { tank: { x: 1, y: 1 }, scout: { x: 2, y: 1 }, wolf: { x: 8, y: 8 } },
  })
  // 30/100 ниже порога, 5/8 выше — цель выбирается по доле, а не по числу ОЗ.
  assert.equal(healingTargetFor(state, 'tank')?.id, 'tank')
})

test('окончательно погибшего героя политика лечить не пытается', () => {
  const state = battle({
    heroes: [hero('medic', { inventory: [SWORD, POTION] }), hero('lost', { hp: 0 })],
    enemies: [enemy('wolf')],
    positions: { medic: { x: 1, y: 1 }, lost: { x: 2, y: 1 }, wolf: { x: 8, y: 8 } },
  })
  state.mechanics.death = { campaign_status: 'active', heroes: { lost: { status: 'dead' } } }
  assert.equal(healingTargetFor(state, 'medic'), null)
})

test('план детерминирован: то же состояние даёт тот же порядок команд', () => {
  const make = () => battle({
    heroes: [hero('a', { inventory: [SWORD, POTION] }), hero('b', { hp: 2 })],
    enemies: [enemy('x', { hp: 4 }), enemy('y', { hp: 4 })],
    positions: { a: { x: 1, y: 1 }, b: { x: 4, y: 4 }, x: { x: 6, y: 1 }, y: { x: 7, y: 1 } },
  })
  assert.deepEqual(planHeroTurn(make(), 'a'), planHeroTurn(make(), 'a'))
})

test('план всегда завершается EndTurn — иначе автономный бой зависнет', () => {
  const cases = [
    battle({ heroes: [hero('h')], enemies: [], positions: { h: { x: 1, y: 1 } } }),
    battle({ heroes: [hero('h')], enemies: [enemy('e')], positions: { h: { x: 1, y: 1 }, e: { x: 20, y: 20 } } }),
    battle({ heroes: [hero('h', { inventory: [] })], enemies: [enemy('e')], positions: { h: { x: 1, y: 1 }, e: { x: 1, y: 2 } } }),
  ]
  for (const state of cases) {
    assert.equal(planHeroTurn(state, 'h').commands.at(-1).command_type, 'EndTurn')
  }
})

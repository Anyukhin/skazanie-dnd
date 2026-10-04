import assert from 'node:assert/strict'
import test from 'node:test'
import { DiceService } from '../server/dice-service.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

// Боевой плейтест 2026-10-03: ветеран с чертой «Держит дистанцию» пятился от
// воина восемнадцать раундов, хотя его главный удар — двуручный меч, а враг
// вне досягаемости шёл по тридцать футов за ход вместо Рывка.

const VETERAN = {
  traits: [{ id: 'multiattack', name: 'Мультиатака', attacks: 2, same_action: true }, { id: 'keep-distance', name: 'Держит дистанцию' }],
  action_profiles: [
    { id: 'greatsword', name: 'Двуручный меч', kind: 'melee', attack_modifier: 5, damage_expression: '2d6+3', damage_type: 'slashing', range_feet: 5 },
    { id: 'heavy-crossbow', name: 'Тяжёлый арбалет', kind: 'ranged', attack_modifier: 3, damage_expression: '2d10+1', damage_type: 'piercing', range_feet: 400, normal_range_feet: 100 },
  ],
}
const CAPTAIN = {
  traits: [{ id: 'multiattack', name: 'Мультиатака', attacks: 2 }, { id: 'keep-distance', name: 'Держит дистанцию' }],
  action_profiles: [
    { id: 'scimitar', name: 'Скимитар', kind: 'melee', attack_modifier: 5, damage_expression: '1d6+3', damage_type: 'slashing', range_feet: 5 },
    { id: 'pistol', name: 'Пистоль', kind: 'ranged', attack_modifier: 5, damage_expression: '1d10+3', damage_type: 'piercing', range_feet: 90, normal_range_feet: 30 },
  ],
}

function arena({ enemyAt, heroAt, enemy = {}, width = 16, height = 3, corridor = false }) {
  const cells = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) cells.push({ x, y, type: corridor && y !== 1 ? 'wall' : 'floor', revealed: true })
  }
  return normalizeCampaignState({
    sessionCode: 'DASHTEST',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Герой', characterClass: 'fighter', level: 3, hp: 28, maxHp: 28, armor: 16, speed: 30, ...heroAt }],
    enemies: [{ id: 'foe', name: 'Противник', hp: 40, maxHp: 40, armor: 15, speed: 30, attackBonus: 5, damageDice: 6, damageBonus: 3, ...enemyAt, ...enemy }],
    scene: { cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'foe', total: 15 }, { actor_id: 'hero', total: 10 }],
        action_economy: { foe: { action: true, bonus_action: true, reaction: true, movement: true } },
      },
    },
  })
}

function execute(state, plan) {
  let live = state
  for (const command of plan) {
    const result = resolveCommand({ ...command, command_id: `plan-${command.command_type}`, server_authoritative: true }, live, {
      diceService: new DiceService({ rng: { randint: (min) => min } }),
      context: { serverAuthoritativeCombat: true, isAdmin: true, isNpcScheduler: true },
    })
    live = result.events.reduce(applyGameEvent, live)
  }
  return live
}

test('враг вне досягаемости бежит Рывком и не пытается бить', () => {
  const state = arena({ enemyAt: { x: 0, y: 1 }, heroAt: { x: 13, y: 1 }, corridor: true, enemy: { action_profiles: [VETERAN.action_profiles[0]] } })
  const plan = planNpcTurn(state, 'foe')
  assert.deepEqual(plan.map((command) => command.command_type), ['UseCombatAction', 'MoveActor', 'EndTurn'])
  assert.equal(plan[0].action_id, 'dash')
  assert.deepEqual(plan[1].to, { x: 12, y: 1 })
  const after = execute(state, plan)
  assert.deepEqual({ x: after.enemies[0].x, y: after.enemies[0].y }, { x: 12, y: 1 })
})

test('если скорости хватает до удара, Рывка нет', () => {
  const state = arena({ enemyAt: { x: 4, y: 1 }, heroAt: { x: 10, y: 1 }, corridor: true, enemy: { action_profiles: [VETERAN.action_profiles[0]] } })
  const plan = planNpcTurn(state, 'foe')
  assert.ok(!plan.some((command) => command.action_id === 'dash'))
  assert.ok(plan.some((command) => command.command_type === 'MakeAttack'))
})

test('ветеран с сильным ближним ударом не пятится от бойца', () => {
  const state = arena({ enemyAt: { x: 5, y: 1 }, heroAt: { x: 8, y: 1 }, height: 6, enemy: VETERAN })
  const plan = planNpcTurn(state, 'foe')
  assert.ok(!plan.some((command) => command.monster_ability === 'keep-distance'), JSON.stringify(plan))
  const adjacent = planNpcTurn(arena({ enemyAt: { x: 5, y: 1 }, heroAt: { x: 6, y: 1 }, height: 6, enemy: VETERAN }), 'foe')
  assert.equal(adjacent.find((command) => command.command_type === 'MakeAttack')?.action_id, 'greatsword')
})

test('капитан с пистолем по-прежнему держит дистанцию', () => {
  const state = arena({ enemyAt: { x: 5, y: 1 }, heroAt: { x: 8, y: 1 }, height: 6, enemy: CAPTAIN })
  const plan = planNpcTurn(state, 'foe')
  assert.ok(plan.some((command) => command.monster_ability === 'keep-distance'), JSON.stringify(plan))
})

test('раненого бойца вплотную ветеран рубит мечом, а не отходит ради выстрела', () => {
  // Плейтест 2026-10-03: у воина 12 ОЗ, средний урон арбалета 12 — бонус
  // «добить» уводил ветерана на клетку назад, под атаку по возможности.
  const state = arena({ enemyAt: { x: 5, y: 1 }, heroAt: { x: 6, y: 1, hp: 12 }, height: 6, enemy: VETERAN })
  const plan = planNpcTurn(state, 'foe')
  assert.ok(!plan.some((command) => command.command_type === 'MoveActor'), JSON.stringify(plan))
  assert.equal(plan.find((command) => command.command_type === 'MakeAttack')?.action_id, 'greatsword')
})

test('стрелок вплотную к герою не ищет огневую позицию за пределами его досягаемости', () => {
  const archer = { traits: [], action_profiles: [VETERAN.action_profiles[1]] }
  const state = arena({ enemyAt: { x: 5, y: 1 }, heroAt: { x: 6, y: 1 }, height: 6, enemy: archer })
  const plan = planNpcTurn(state, 'foe')
  const moves = plan.filter((command) => command.command_type === 'MoveActor')
  for (const move of moves) {
    assert.ok(Math.max(Math.abs(move.to.x - 6), Math.abs(move.to.y - 1)) <= 1, `шаг ${JSON.stringify(move.to)} выводит из досягаемости героя`)
  }
})

test('с десяти футов ветеран подходит рубить мечом, а не стреляет из арбалета', () => {
  // Плейтест 2026-10-03: арбалет (+3, 2к10+1) выигрывал у меча (+5, 2к6+3)
  // средним уроном и тем, что «в досягаемости» с места. Ожидаемый урон по КД 16
  // у меча выше, а два шага до него — своя скорость.
  const state = arena({ enemyAt: { x: 5, y: 1 }, heroAt: { x: 7, y: 1 }, height: 6, enemy: VETERAN })
  const plan = planNpcTurn(state, 'foe')
  assert.equal(plan[0].command_type, 'MoveActor', JSON.stringify(plan))
  assert.equal(plan.find((command) => command.command_type === 'MakeAttack')?.action_id, 'greatsword')
})

test('стрелок с равным ближним оружием стреляет с места, а не бежит в рукопашную', () => {
  const skirmisher = { traits: [], action_profiles: [
    { id: 'scimitar', name: 'Скимитар', kind: 'melee', attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'slashing', range_feet: 5 },
    { id: 'shortbow', name: 'Короткий лук', kind: 'ranged', attack_modifier: 4, damage_expression: '1d6+2', damage_type: 'piercing', range_feet: 320, normal_range_feet: 80 },
  ] }
  const plan = planNpcTurn(arena({ enemyAt: { x: 5, y: 1 }, heroAt: { x: 8, y: 1 }, height: 6, enemy: skirmisher }), 'foe')
  assert.ok(!plan.some((command) => command.command_type === 'MoveActor' && !command.monster_ability), JSON.stringify(plan))
  assert.equal(plan.find((command) => command.command_type === 'MakeAttack')?.action_id, 'shortbow')
})

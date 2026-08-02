import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { NPC_BEHAVIOR_POLICIES, planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { normalizeCampaignState, resolveCommands } from '../server/rules-engine.mjs'

/**
 * Задача 3.1 плана: укрытия, высота и отход раненого. Геометрия здесь не своя —
 * планировщик спрашивает `coverBetween` и `highGroundBetween` движка, поэтому
 * сторож проверяет решения плана, а не повторяет расчёт линии огня.
 */

const WIDTH = 13
const HEIGHT = 9

function grid({ walls = [], features = {}, elevations = {} } = {}) {
  const blocked = new Set(walls.map(([x, y]) => `${x}:${y}`))
  const cells = []
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const key = `${x}:${y}`
      cells.push({
        x, y, revealed: true,
        type: blocked.has(key) ? 'wall' : 'floor',
        ...(features[key] ? { feature: features[key] } : {}),
        ...(elevations[key] ? { elevation: elevations[key] } : {}),
      })
    }
  }
  return cells
}

const archer = (overrides = {}) => ({
  id: 'archer', name: 'Лучник', hp: 30, maxHp: 30, armor: 13, speed: 30, alive: true,
  abilities: { str: 10, dex: 16, con: 12, int: 8, wis: 12, cha: 8 },
  action_profiles: [{ id: 'bow', name: 'Лук', kind: 'ranged', range_feet: 80, normal_range_feet: 80, modifier: 5, damage_expression: '1d8', damage_amount: 2 }],
  x: 10, y: 4,
  ...overrides,
})

const brute = (overrides = {}) => ({
  id: 'brute', name: 'Громила', hp: 40, maxHp: 40, armor: 14, speed: 30, alive: true,
  abilities: { str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 8 },
  action_profiles: [{ id: 'club', name: 'Дубина', kind: 'melee', range_feet: 5, modifier: 5, damage_expression: '1d8', damage_amount: 3 }],
  x: 8, y: 4,
  ...overrides,
})

const swordsman = (overrides = {}) => ({
  id: 'hero', character: 'Герой', hp: 30, maxHp: 30, armor: 15, speed: 30, proficiency: 2,
  abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
  attackBonus: 6, damageDice: 8, damageBonus: 3, x: 2, y: 4, online: true,
  ...overrides,
})

function scene({ heroes = [swordsman()], enemies = [archer()], cells = grid() } = {}) {
  return normalizeCampaignState({
    sessionCode: 'TACTICS',
    partyMemberIds: heroes.map((hero) => hero.id),
    players: heroes,
    enemies,
    scene: { turn: 1, cells, grid: { width: WIDTH, height: HEIGHT } },
    mechanics: {
      combat: {
        active: true, round: 2, active_index: 0,
        initiative: [...enemies.map((enemy) => ({ actor_id: enemy.id, total: 15 })), ...heroes.map((hero) => ({ actor_id: hero.id, total: 10 }))],
        action_economy: Object.fromEntries([...enemies, ...heroes].map((actor) => [
          actor.id,
          { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        ])),
      },
    },
  })
}

const moves = (plan) => plan.filter((command) => command.command_type === 'MoveActor')
const attacks = (plan) => plan.filter((command) => command.command_type === 'MakeAttack')

test('стрелок не бьёт сквозь стену, а обходит её и стреляет с новой позиции', () => {
  // Столб ровно на линии выстрела: герой закрыт полностью, но шаг в сторону
  // открывает его снова.
  const state = scene({ cells: grid({ walls: [[6, 4]] }) })
  const plan = planNpcTurn(state, 'archer')

  const move = moves(plan)[0]
  assert.ok(move, 'стрелок обязан сменить позицию, а не стрелять в столб')
  assert.equal(move.monster_ability, 'firing-position')
  assert.notEqual(move.to.y, 4, `нужно сойти с перекрытой линии, получено ${JSON.stringify(move.to)}`)
  assert.ok(attacks(plan).length > 0, 'после смены позиции выстрел всё-таки происходит')
})

test('полностью закрытая цель не выбирается для выстрела с места', () => {
  // Сплошная стена и бюджета на обход не хватает: стрелять стрелок не будет.
  const walls = Array.from({ length: HEIGHT }, (_, y) => [6, y]).filter(([, y]) => y !== 0)
  const plan = planNpcTurn(scene({ cells: grid({ walls }) }), 'archer')
  assert.equal(attacks(plan).length, 0, 'сквозь полное укрытие выстрела быть не может')
})

test('при равном раскладе стрелок выбирает цель без укрытия', () => {
  // Оба героя одинаковы, но перед первым стоит ящик: движок даёт ему укрытие.
  const covered = swordsman({ id: 'covered', character: 'За ящиком', x: 2, y: 3 })
  const open = swordsman({ id: 'open', character: 'На виду', x: 2, y: 5 })
  const state = scene({
    heroes: [covered, open],
    cells: grid({ features: { '6:3': 'crate' } }),
  })
  const plan = planNpcTurn(state, 'archer')
  const attack = attacks(plan)[0]
  assert.ok(attack, 'выстрел запланирован')
  assert.equal(attack.target_id, 'open', 'цель без укрытия предпочтительнее')
})

test('стрелок занимает высоту, когда она в бюджете перемещения', () => {
  // Уступ рядом со стрелком даёт движковое преимущество с высоты.
  const state = scene({ cells: grid({ elevations: { '10:2': 10, '10:3': 10 } }) })
  const plan = planNpcTurn(state, 'archer')
  const move = moves(plan)[0]
  assert.ok(move, 'стрелок поднимается на уступ')
  assert.equal(move.monster_ability, 'firing-position')
  assert.ok([2, 3].includes(move.to.y) && move.to.x === 10, `ожидался подъём на уступ, получено ${JSON.stringify(move.to)}`)
  assert.ok(attacks(plan).length > 0)
})

test('высота не тянет мечника: движок не даёт преимущества в ближнем бою', () => {
  // Уступ рядом есть, но громила бьёт вплотную, и высота ему ничего не даёт —
  // он идёт к герою, а не карабкается.
  const state = scene({
    enemies: [brute({ x: 4, y: 4 })],
    cells: grid({ elevations: { '4:2': 10, '5:2': 10 } }),
  })
  const plan = planNpcTurn(state, 'brute')
  for (const move of moves(plan)) {
    assert.notEqual(move.monster_ability, 'firing-position')
  }
})

test('раненый NPC отходит под укрытие и разрывает соприкосновение Отходом', () => {
  const state = scene({
    enemies: [brute({ hp: 6, x: 3, y: 4 })],
    heroes: [swordsman({ x: 2, y: 4 })],
    cells: grid({ features: { '8:4': 'bookshelf' } }),
  })
  const plan = planNpcTurn(state, 'brute')

  const move = moves(plan)[0]
  assert.ok(move, 'раненый отступает, а не разменивается насмерть')
  assert.equal(move.monster_ability, 'bloodied-withdrawal')
  assert.ok(move.to.x > 3, 'отход идёт прочь от героя')
  // Отход — общее боевое действие, оно снимает атаки по возможности.
  const disengage = plan.find((command) => command.command_type === 'UseCombatAction')
  assert.equal(disengage?.action_id, 'disengage')
  assert.equal(attacks(plan).length, 0, 'отступая, существо не атакует')
})

test('план отхода исполним движком: Отход и перемещение проходят как есть', () => {
  // План, который движок отвергнет, хуже отсутствия плана: ход NPC упал бы
  // целиком. Поэтому команды отхода проверяются исполнением, а не только видом.
  const state = scene({ enemies: [brute({ hp: 6, x: 3, y: 4 })], heroes: [swordsman({ x: 2, y: 4 })] })
  const plan = planNpcTurn(state, 'brute').filter((command) => command.command_type !== 'EndTurn')
  const diceService = new DiceService({ rng: new SequenceDiceRng([10, 10, 10, 10]), idFactory: () => 'roll', now: () => '2026-08-02T00:00:00.000Z' })
  const result = resolveCommands(plan, state, {
    diceService,
    context: { isNpcScheduler: true, serverAuthoritativeCombat: true, isDirector: true },
  })
  assert.ok(result.events.some((event) => event.event_type === 'ActorMoved'), 'перемещение состоялось')
  const conditions = (result.state.mechanics.conditions.brute ?? []).map((entry) => entry.id)
  assert.ok(conditions.includes('disengaged'), 'Отход снял атаки по возможности')
})

test('черта ярости отменяет отход: раненый с ней дерётся до конца', () => {
  const base = { hp: 6, x: 3, y: 4 }
  const heroes = [swordsman({ x: 2, y: 4 })]
  for (const trait of [NPC_BEHAVIOR_POLICIES.bloodiedFrenzy, NPC_BEHAVIOR_POLICIES.relentlessPursuit]) {
    const plan = planNpcTurn(scene({ enemies: [brute({ ...base, traits: [{ id: trait }] })], heroes }), 'brute')
    assert.equal(
      moves(plan).some((move) => move.monster_ability === 'bloodied-withdrawal'),
      false,
      `${trait}: отход недопустим`,
    )
    assert.ok(attacks(plan).length > 0, `${trait}: существо атакует`)
  }
})

test('решение морали уважается: прошедший проверку не убегает следующим ходом', () => {
  const state = scene({ enemies: [brute({ hp: 6, x: 3, y: 4 })], heroes: [swordsman({ x: 2, y: 4 })] })
  state.mechanics.conditions.brute = [{ id: 'morale-tested' }]
  const plan = planNpcTurn(normalizeCampaignState(state), 'brute')
  assert.equal(moves(plan).some((move) => move.monster_ability === 'bloodied-withdrawal'), false)
  assert.ok(attacks(plan).length > 0)
})

test('раненый, до которого никто не достаёт, не тратит ход на бегство', () => {
  // Герой далеко и вооружён только вплотную: угрозы нет, отступать незачем.
  const state = scene({
    enemies: [brute({ hp: 6, x: 11, y: 8 })],
    heroes: [swordsman({ x: 0, y: 0 })],
  })
  const plan = planNpcTurn(state, 'brute')
  assert.equal(moves(plan).some((move) => move.monster_ability === 'bloodied-withdrawal'), false)
})

test('план детерминирован: одинаковый вход даёт одинаковые команды', () => {
  const build = () => scene({
    heroes: [swordsman({ id: 'covered', character: 'За ящиком', x: 2, y: 3 }), swordsman({ id: 'open', character: 'На виду', x: 2, y: 5 })],
    enemies: [archer(), brute({ hp: 7, x: 9, y: 6 })],
    cells: grid({ features: { '6:3': 'crate', '8:6': 'barrel' }, elevations: { '10:2': 10 } }),
  })
  for (const id of ['archer', 'brute']) {
    const first = planNpcTurn(build(), id)
    const second = planNpcTurn(build(), id)
    assert.deepEqual(second, first, `${id}: план обязан повторяться слово в слово`)
  }
})

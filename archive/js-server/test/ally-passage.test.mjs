import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService } from '../server/dice-service.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { applyGameEvent, normalizeCampaignState, previewApproachAttack, resolveCommand } from '../server/rules-engine.mjs'

// Прогон Асстохана с моделью, 2026-10-06: на узком Обсидиановом перевале воин
// пять раундов стоял за спинами своих — поиск пути не пускал сквозь союзника
// (находка №34 аудита правил). PHB 2014: сквозь пространство невраждебного
// существа пройти можно, оно — труднопроходимая местность, закончить там
// перемещение нельзя; сквозь враждебное — нельзя.

function corridor({ enemies, players, actors = [], first = null } = {}) {
  const cells = []
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 12; x += 1) cells.push({ x, y, type: y === 1 ? 'floor' : 'wall', revealed: true })
  const heroes = players ?? [
    { id: 'warrior', character: 'Торвальд', characterClass: 'fighter', level: 3, hp: 28, maxHp: 28, armor: 16, speed: 30, x: 0, y: 1 },
    { id: 'priest', character: 'Ильва', characterClass: 'cleric', level: 3, hp: 20, maxHp: 20, armor: 16, speed: 30, x: 1, y: 1 },
  ]
  const foes = enemies ?? [{ id: 'wolf', name: 'Волк', hp: 11, maxHp: 11, armor: 13, speed: 40, attackBonus: 4, damageDice: 4, damageBonus: 2, x: 5, y: 1 }]
  const order = [...heroes, ...foes, ...actors]
  if (first) order.unshift(...order.splice(order.findIndex((actor) => actor.id === first), 1))
  const initiative = order.map((actor, index) => ({ actor_id: actor.id, total: 20 - index }))
  return normalizeCampaignState({
    sessionCode: 'ALLY-PASSAGE',
    partyMemberIds: heroes.map((hero) => hero.id),
    players: heroes,
    enemies: foes,
    actors,
    scene: { cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0, initiative,
        action_economy: Object.fromEntries(initiative.map(({ actor_id }) => [actor_id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])),
      },
    },
  })
}

const context = { serverAuthoritativeCombat: true, isAdmin: true }
const run = (command, state, extra = {}) => resolveCommand(command, state, { diceService: new DiceService({ rng: { randint: (min) => min } }), context: { ...context, ...extra } })
const move = (actorId, to) => ({ command_type: 'MoveActor', actor_id: actorId, to, command_id: `move-${actorId}-${to.x}`, server_authoritative: true })

test('герой проходит сквозь союзника, и его клетка стоит как труднопроходимая местность', () => {
  const state = corridor()
  const result = run(move('warrior', { x: 3, y: 1 }), state)
  const moved = result.events.find((event) => event.event_type === 'ActorMoved')
  assert.deepEqual(moved.payload.path.map((step) => step.x), [1, 2, 3])
  // Состояние — только из событий (replay): 10 футов за клетку жрицы и по 5
  // за две свободные.
  const replayed = result.events.reduce((current, event) => applyGameEvent(current, event), state)
  assert.deepEqual(replayed.mechanics.positions.warrior, { x: 3, y: 1 })
  assert.equal(replayed.mechanics.combat.action_economy.warrior.movement_spent, 20)
  assert.deepEqual(replayed.mechanics.positions.priest, { x: 1, y: 1 }, 'союзник остался на месте')
})

test('на клетке союзника закончить перемещение нельзя, а плата за проход входит в скорость', () => {
  const state = corridor()
  assert.throws(() => run(move('warrior', { x: 1, y: 1 }), state), (error) => ['INVALID_DESTINATION', 'PATH_BLOCKED'].includes(error.code))
  // Шесть клеток до x=6 — 30 футов, но клетка жрицы стоит 10: 35 > 30.
  assert.throws(() => run(move('warrior', { x: 6, y: 1 }), state), (error) => error.code === 'SPEED_EXCEEDED' || error.code === 'PATH_BLOCKED')
})

test('сквозь врага пройти по-прежнему нельзя', () => {
  const state = corridor({
    enemies: [
      { id: 'wolf', name: 'Волк', hp: 11, maxHp: 11, armor: 13, speed: 40, attackBonus: 4, damageDice: 4, damageBonus: 2, x: 1, y: 1 },
    ],
    players: [
      { id: 'warrior', character: 'Торвальд', characterClass: 'fighter', level: 3, hp: 28, maxHp: 28, armor: 16, speed: 30, x: 0, y: 1 },
    ],
  })
  assert.throws(() => run(move('warrior', { x: 3, y: 1 }), state), (error) => error.code === 'PATH_BLOCKED')
})

test('воин за спиной жрицы подходит к врагу и бьёт: маршрут ближней атаки идёт сквозь союзника', () => {
  const state = corridor()
  const route = previewApproachAttack(state, 'warrior', 'wolf')
  const step = route.commands.find((command) => command.command_type === 'MoveActor')
  assert.deepEqual(step.to, { x: 4, y: 1 })
  assert.ok(route.commands.some((command) => command.command_type === 'MakeAttack' && command.target_id === 'wolf'))
})

test('враг проходит сквозь своего, но не сквозь призыв, враждебный всем', () => {
  const pack = corridor({
    players: [{ id: 'warrior', character: 'Торвальд', characterClass: 'fighter', level: 3, hp: 28, maxHp: 28, armor: 16, speed: 30, x: 8, y: 1 }],
    enemies: [
      { id: 'wolf', name: 'Волк', hp: 11, maxHp: 11, armor: 13, speed: 40, attackBonus: 4, damageDice: 4, damageBonus: 2, x: 2, y: 1 },
      { id: 'goblin', name: 'Гоблин', hp: 7, maxHp: 7, armor: 15, speed: 30, attackBonus: 4, damageDice: 6, damageBonus: 2, x: 3, y: 1 },
    ],
  })
  const plan = planNpcTurn(pack, 'wolf')
  assert.deepEqual(plan.find((command) => command.command_type === 'MoveActor')?.to, { x: 7, y: 1 }, JSON.stringify(plan))

  const demonBlocked = corridor({
    first: 'wolf',
    players: [{ id: 'warrior', character: 'Торвальд', characterClass: 'fighter', level: 3, hp: 28, maxHp: 28, armor: 16, speed: 30, x: 8, y: 1 }],
    enemies: [
      { id: 'wolf', name: 'Волк', hp: 11, maxHp: 11, armor: 13, speed: 40, attackBonus: 4, damageDice: 4, damageBonus: 2, x: 2, y: 1 },
      { id: 'demon', name: 'Демон', kind: 'summon', faction: 'hostile', ownerId: 'warrior', hp: 7, maxHp: 7, armor: 12, speed: 30, attackBonus: 3, damageDice: 6, damageBonus: 1, x: 3, y: 1 },
    ],
  })
  assert.throws(() => run(move('wolf', { x: 5, y: 1 }), demonBlocked, { isNpcScheduler: true }), (error) => error.code === 'PATH_BLOCKED')
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { DiceService } from '../server/dice-service.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

// Массовый прогон боевого стенда 2026-10-04 (сценарий «healing», сид 3): враг
// закончил ход на клетке лежащего без сознания героя, а поднятый лечением герой
// оказался с ним на одной клетке. Умирающий герой — всё ещё существо: встать на
// его клетку нельзя, пройти насквозь — можно (недееспособное существо).

function corridor({ deadHero = false } = {}) {
  const cells = []
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 12; x += 1) cells.push({ x, y, type: y === 1 ? 'floor' : 'wall', revealed: true })
  return normalizeCampaignState({
    sessionCode: 'DOWNED-CELL',
    partyMemberIds: ['fallen', 'standing'],
    players: [
      { id: 'fallen', character: 'Кел', characterClass: 'fighter', level: 3, hp: 0, maxHp: 28, armor: 16, speed: 30, x: 3, y: 1 },
      { id: 'standing', character: 'Ада', characterClass: 'fighter', level: 3, hp: 28, maxHp: 28, armor: 16, speed: 30, x: 6, y: 1 },
    ],
    enemies: [{ id: 'raider', name: 'Налётчик', hp: 30, maxHp: 30, armor: 13, speed: 30, attackBonus: 4, damageDice: 8, damageBonus: 2, x: 0, y: 1 }],
    scene: { cells },
    mechanics: {
      conditions: { fallen: [{ id: 'unconscious' }, { id: 'prone' }] },
      death: {
        saving_throws: { fallen: { successes: 0, failures: 0, stable: false } },
        heroes: deadHero ? { fallen: { status: 'dead' } } : {},
        campaign_status: 'active',
      },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'raider', total: 15 }, { actor_id: 'standing', total: 10 }, { actor_id: 'fallen', total: 5 }],
        action_economy: { raider: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

const move = (to) => ({ command_type: 'MoveActor', actor_id: 'raider', to, command_id: `move-${to.x}`, server_authoritative: true })
const context = { serverAuthoritativeCombat: true, isAdmin: true, isNpcScheduler: true }
const run = (command, state) => resolveCommand(command, state, { diceService: new DiceService({ rng: { randint: (min) => min } }), context })

test('на клетку умирающего героя встать нельзя, а пройти сквозь неё можно', () => {
  const state = corridor()
  assert.throws(() => run(move({ x: 3, y: 1 }), state), (error) => error.code === 'INVALID_DESTINATION')
  const passed = run(move({ x: 5, y: 1 }), state)
  assert.ok(passed.events.find((event) => event.event_type === 'ActorMoved').payload.path.some((step) => step.x === 3), 'путь через лежащего к стоящему герою открыт')
})

test('клетка погибшего героя свободна', () => {
  assert.doesNotThrow(() => run(move({ x: 3, y: 1 }), corridor({ deadHero: true })))
})

test('планировщик ведёт врага мимо лежащего к стоящему герою и бьёт', () => {
  const plan = planNpcTurn(corridor(), 'raider')
  const step = plan.find((command) => command.command_type === 'MoveActor')
  assert.deepEqual(step?.to, { x: 5, y: 1 }, JSON.stringify(plan))
  assert.ok(plan.some((command) => command.command_type === 'MakeAttack' && command.target_id === 'standing'))
})

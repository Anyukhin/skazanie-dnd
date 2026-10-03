import assert from 'node:assert/strict'
import test from 'node:test'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { normalizeCampaignState, validateCommand } from '../server/rules-engine.mjs'

// Боевой плейтест 2026-10-03: ветеран шёл к герою, скорость кончалась ровно в
// клетке жительницы деревни. Сквозь мирного NPC пройти можно, остановиться —
// нет; планировщик этого не знал, движок отвергал ход «Клетка назначения
// недоступна», и бой вставал навсегда.

function corridorState({ npcAt = { x: 6, y: 1 } } = {}) {
  // Коридор шириной в одну клетку: обойти NPC негде, путь идёт сквозь него.
  const cells = []
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 14; x += 1) cells.push({ x, y, type: y === 1 ? 'floor' : 'wall', revealed: true })
  }
  return normalizeCampaignState({
    sessionCode: 'STOPCELL',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Герой', characterClass: 'fighter', level: 3, hp: 28, maxHp: 28, armor: 16, speed: 30, x: 12, y: 1 }],
    enemies: [{ id: 'raider', name: 'Налётчик', hp: 30, maxHp: 30, armor: 13, speed: 30, attackBonus: 4, damageDice: 8, damageBonus: 2, x: 0, y: 1 }],
    scene: { cells },
    scene_npcs: npcAt ? [{ id: 'villager', name: 'Жительница', x: npcAt.x, y: npcAt.y, alive: true }] : [],
    mechanics: {
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'raider', total: 15 }, { actor_id: 'hero', total: 10 }],
        action_economy: { raider: { action: true, bonus_action: true, reaction: true, movement: true } },
      },
    },
  })
}

const moveOf = (plan) => plan.find((command) => command.command_type === 'MoveActor')

test('враг не заканчивает ход в клетке мирного NPC, а останавливается перед ней', () => {
  const state = corridorState()
  const move = moveOf(planNpcTurn(state, 'raider'))
  assert.ok(move, 'налётчик идёт к герою')
  assert.notDeepEqual(move.to, { x: 6, y: 1 })
  assert.deepEqual(move.to, { x: 5, y: 1 })
  // Тот же ход движок принимает: планировщик и MoveActor видят одни клетки.
  assert.doesNotThrow(() => validateCommand({ ...move, command_id: 'stop-cell', server_authoritative: true }, state, { serverAuthoritativeCombat: true, isAdmin: true }))
})

test('без NPC в коридоре враг проходит всю свою скорость', () => {
  const move = moveOf(planNpcTurn(corridorState({ npcAt: null }), 'raider'))
  assert.deepEqual(move.to, { x: 6, y: 1 })
})

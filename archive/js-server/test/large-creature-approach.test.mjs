// Бой не стоит, когда путь к цели 2×2 идёт сквозь лежащих героев. Прогон
// Асстохана 2026-10-13: совомед у края карты рядом с двумя упавшими, двое
// стоящих в двух клетках — и ни зверь, ни герои 30 раундов не делали ничего.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { enemyFrom2014 } from '../server/combat-lab-monsters.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { planHeroCombatCommand } from '../server/party-tactics.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { fixedDice } from './kit/dice.mjs'

const records = JSON.parse(readFileSync(new URL('../data/compendia/dnd_5e_2014/monsters.json', import.meta.url), 'utf8')).monsters
const sword = { id: 'sword', catalog_id: 'srd_5_2_1:longsword', type: 'weapon', quantity: 1, equipped: true }
const hero = (id, x, y, hp, extra = {}) => ({ id, character: id, characterClass: 'fighter', level: 7, hp, maxHp: 60, armor: 16, speed: 30, proficiency: 3,
  abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [sword], x, y, ...extra })

// Карта 10×6: совомед у нижнего края, лежащие — над ним и слева, стоящие — в
// двух клетках. Стены по бокам от лежащей сверху закрывают прямой обход.
function stalemate({ walls = [] } = {}) {
  const owl = { ...enemyFrom2014(records.find((record) => record.id.endsWith(':owlbear')), { x: 4, y: 4 }), id: 'owl', hp: 28 }
  const wall = new Set(walls.map(([x, y]) => `${x},${y}`))
  return normalizeCampaignState({
    sessionCode: 'LARGE-APPROACH', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
    partyMemberIds: ['fighter', 'cleric', 'wizard', 'rogue'],
    players: [hero('fighter', 4, 2, 45), hero('cleric', 4, 3, 0), hero('wizard', 3, 4, 0), hero('rogue', 2, 4, 37)],
    enemies: [owl],
    scene: { title: 'Опушка', location: 'Опушка', turn: 1, cells: Array.from({ length: 60 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10), type: wall.has(`${i % 10},${Math.floor(i / 10)}`) ? 'wall' : 'floor', revealed: true })) },
    mechanics: {
      combat: { active: true, round: 5, active_index: 0,
        initiative: ['owl', 'fighter', 'rogue', 'cleric', 'wizard'].map((id, index) => ({ actor_id: id, total: 20 - index })),
        action_economy: Object.fromEntries(['owl', 'fighter', 'rogue', 'cleric', 'wizard'].map((id) => [id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])) },
      death: { saving_throws: { cleric: { successes: 0, failures: 0, stable: true }, wizard: { successes: 0, failures: 0, stable: true } } },
      conditions: { cleric: [{ id: 'unconscious' }], wizard: [{ id: 'unconscious' }] },
    },
  })
}
const turnOf = (state, id) => normalizeCampaignState({ ...structuredClone(state), mechanics: { ...structuredClone(state.mechanics), combat: { ...structuredClone(state.mechanics.combat), active_index: state.mechanics.combat.initiative.findIndex((entry) => entry.actor_id === id) } } })

test('совомед 2×2 обходит лежащих и бьёт стоящего героя', () => {
  const state = stalemate()
  const plan = planNpcTurn(state, 'owl')
  assert.ok(plan.some((command) => command.command_type === 'MoveActor'), JSON.stringify(plan))
  assert.ok(plan.some((command) => command.command_type === 'MakeAttack'), JSON.stringify(plan))
  // И движок этот план принимает.
  for (const command of plan.filter((entry) => entry.command_type !== 'EndTurn').slice(0, 2)) {
    assert.doesNotThrow(() => resolveCommand({ command_id: `owl-${command.command_type}`, server_authoritative: true, ...command }, state,
      { diceService: fixedDice(10), context: { isNpcScheduler: true, serverAuthoritativeCombat: true } }), command.command_type)
    break
  }
})

test('герой подходит к совомеду в свободную клетку, а не упирается в лежащую жрицу', () => {
  // Стены по бокам от жрицы: прямой путь к опорной клетке зверя — только через неё.
  const state = turnOf(stalemate({ walls: [[3, 3], [5, 3]] }), 'fighter')
  const view = campaignStateForViewer(state, { id: 'user-fighter', role: 'player', heroIds: ['fighter'] }, 'fighter')
  const plan = planHeroCombatCommand(view, 'fighter')
  assert.equal(plan.command.command_type, 'MoveActor', JSON.stringify(plan))
  const to = plan.command.to
  assert.ok(!(to.x === 4 && to.y === 3), 'не в клетку лежащей')
  assert.doesNotThrow(() => resolveCommand({ command_id: 'fighter-approach', ...plan.command }, state,
    { diceService: fixedDice(10), context: { serverAuthoritativeCombat: true, allowedActorIds: ['fighter'] } }))
})

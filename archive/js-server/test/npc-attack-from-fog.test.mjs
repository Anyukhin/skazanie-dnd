// Прогон Асстохана 2026-10-13 (сид 3, Замок Забытых Скал): гигантский паук
// стоял целиком в ещё не открытой отрядом части карты. Планировщик выбрал
// «Паутину» по герою, а движок отказал «траектория перекрыта»: линию он
// считает только из открытых клеток. Ход врага падал, бой вставал. Туман
// войны — знание отряда, а не врага: ход планировщика им не ограничен.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { enemyFrom2014 } from '../server/combat-lab-monsters.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { normalizeCampaignState, resolveCommand, resolveCommands } from '../server/rules-engine.mjs'
import { diceThen } from './kit/dice.mjs'

const records = JSON.parse(readFileSync(new URL('../data/compendia/dnd_5e_2014/monsters.json', import.meta.url), 'utf8')).monsters

function arena() {
  const spider = { ...enemyFrom2014(records.find((entry) => entry.id.endsWith(':giant-spider')), { x: 8, y: 2 }), id: 'spider' }
  const hero = { id: 'hero', character: 'Мирт', characterClass: 'fighter', level: 7, hp: 60, maxHp: 60, armor: 16, speed: 30, proficiency: 3,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, x: 2, y: 2 }
  return normalizeCampaignState({
    sessionCode: 'FOG-ATTACK', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
    players: [hero], partyMemberIds: ['hero'], enemies: [spider],
    // Отряд видит только левую половину зала: паук — в неоткрытой.
    scene: { turn: 1, cells: Array.from({ length: 12 * 5 }, (_, i) => ({ x: i % 12, y: Math.floor(i / 12), type: 'floor', revealed: i % 12 < 6 })) },
    mechanics: {
      combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'spider', total: 20 }, { actor_id: 'hero', total: 5 }],
        action_economy: Object.fromEntries(['spider', 'hero'].map((id) => [id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])) },
    },
  })
}

test('враг из неоткрытой части карты атакует героя ходом планировщика', () => {
  const state = arena()
  const plan = planNpcTurn(state, 'spider')
  const attack = plan.find((command) => ['MakeAttack', 'UseMonsterAction'].includes(command.command_type))
  assert.ok(attack, JSON.stringify(plan))
  const result = resolveCommands(plan.map((command, index) => ({ command_id: `fog-${index}`, ...command })), state,
    { diceService: diceThen([], 15), context: { isNpcScheduler: true, serverAuthoritativeCombat: true } })
  assert.ok(result.events.some((event) => event.event_type === 'AttackResolved' && event.actor_id === 'spider'), result.events.map((event) => event.event_type).join(','))
})

test('игрок по-прежнему не целится в неоткрытую клетку', () => {
  const state = arena()
  state.mechanics.combat.active_index = 1
  const shot = { command_id: 'player-shot', command_type: 'MakeAttack', actor_id: 'hero', target_id: 'spider', server_authoritative: true }
  assert.throws(() => resolveCommand(shot, state, { diceService: diceThen([], 15), context: { serverAuthoritativeCombat: true } }),
    (error) => ['TARGET_NOT_VISIBLE', 'TARGET_OUT_OF_RANGE'].includes(error?.code))
})

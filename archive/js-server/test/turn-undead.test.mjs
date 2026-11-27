// Изгнание и Уничтожение нежити жреца 7-го уровня (PHB 2014). Аудит боя
// 2026-10-13: изгнание било одну цель, не проверяло, нежить ли она, а
// состояние «изгнан» ни на что не влияло. В Асстохане нежить — в Проклятом
// лесу и Замке Забытых Скал.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { enemyFrom2014 } from '../server/combat-lab-monsters.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { fixedDice, minDice } from './kit/dice.mjs'

const records = JSON.parse(readFileSync(new URL('../data/compendia/dnd_5e_2014/monsters.json', import.meta.url), 'utf8')).monsters
const monster = (suffix, id, at) => ({ ...enemyFrom2014(records.find((entry) => entry.id.endsWith(`:${suffix}`)), at), id })

function battle() {
  const enemies = [monster('skeleton', 'skeleton', { x: 3, y: 2 }), monster('ghoul', 'ghoul', { x: 4, y: 2 }), monster('wolf', 'wolf', { x: 2, y: 3 }), monster('ghoul', 'far-ghoul', { x: 12, y: 2 })]
  const cleric = { id: 'cleric', character: 'Ильва', characterClass: 'cleric', subclass: 'Домен жизни', level: 7, hp: 50, maxHp: 50, armor: 18, speed: 30, proficiency: 3,
    abilities: { str: 12, dex: 10, con: 14, int: 10, wis: 18, cha: 12 }, x: 2, y: 2 }
  return normalizeCampaignState({
    sessionCode: 'TURN-UNDEAD', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
    players: [cleric], partyMemberIds: ['cleric'], enemies,
    scene: { turn: 1, cells: Array.from({ length: 15 * 6 }, (_, i) => ({ x: i % 15, y: Math.floor(i / 15), type: 'floor', revealed: true })) },
    mechanics: {
      combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'cleric', total: 20 }, ...enemies.map((enemy, index) => ({ actor_id: enemy.id, total: 10 - index }))],
        action_economy: Object.fromEntries([cleric, ...enemies].map((actor) => [actor.id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])) },
      resources: { cleric: { channel_divinity: { current: 2, max: 2 } } },
    },
  })
}

const turn = (state, diceService = minDice()) => resolveCommand({ command_id: 'turn', command_type: 'UseCombatAction', actor_id: 'cleric', action_id: 'turn-undead' },
  state, { diceService, context: { serverAuthoritativeCombat: true } })
const conditions = (state, id) => (state.mechanics.conditions[id] ?? []).map((condition) => String(condition?.id ?? condition))

test('Изгнание нежити: вся нежить в 30 футах спасается; скелет (ПО ¼) уничтожен, гуль изгнан, волк и дальний гуль — нет', () => {
  const state = battle()
  const result = turn(state)
  const saves = result.events.filter((event) => event.event_type === 'SavingThrowResolved')
  assert.deepEqual(saves.map((event) => event.target_ids[0]).sort(), ['ghoul', 'skeleton'], 'только нежить в радиусе')
  assert.equal(saves[0].payload.difficulty, 8 + 3 + 4, '8 + мастерство + Мудрость')
  assert.ok(result.events.some((event) => event.event_type === 'DamageApplied' && event.payload.destroy_undead === true && event.target_ids[0] === 'skeleton'))
  assert.ok(result.events.some((event) => event.event_type === 'ResourceSpent' && event.payload.resource === 'channel_divinity'))
  const after = result.events.reduce(applyGameEvent, state)
  assert.equal(after.enemies.find((enemy) => enemy.id === 'skeleton').alive, false, 'Уничтожение нежити с 5-го уровня')
  assert.ok(conditions(after, 'ghoul').includes('turned'))
  assert.ok(!conditions(after, 'wolf').includes('turned'))
  assert.ok(!conditions(after, 'far-ghoul').includes('turned'))
  assert.deepEqual(conditions(replayEvents(state, result.events), 'ghoul'), conditions(after, 'ghoul'))
})

test('изгнанный гуль бежит прочь и не атакует; урон снимает изгнание', () => {
  const state = battle()
  const after = turn(state).events.reduce(applyGameEvent, state)
  const plan = planNpcTurn(after, 'ghoul')
  assert.ok(!plan.some((command) => ['MakeAttack', 'UseMonsterAction'].includes(command.command_type)), JSON.stringify(plan))
  const move = plan.find((command) => command.command_type === 'MoveActor')
  assert.ok(move, 'бежит')
  assert.ok(Math.abs(move.to.x - 2) + Math.abs(move.to.y - 2) > 2, 'прочь от жреца')
  const hit = resolveCommand({ command_id: 'hit', command_type: 'ApplyDamage', actor_id: 'cleric', target_id: 'ghoul', amount: 3, damage_type: 'bludgeoning', ruling_id: 'test-turned-damage' },
    after, { diceService: fixedDice(10), context: { isAdmin: true } })
  const hurt = hit.events.reduce(applyGameEvent, after)
  assert.ok(!conditions(hurt, 'ghoul').includes('turned'), 'урон снимает изгнание')
})

test('у успешно спасшейся нежити изгнания нет', () => {
  const state = battle()
  const result = turn(state, fixedDice(20))
  const after = result.events.reduce(applyGameEvent, state)
  assert.ok(!conditions(after, 'ghoul').includes('turned'))
  assert.equal(after.enemies.find((enemy) => enemy.id === 'skeleton').alive, true)
})

test('автономный жрец рядом с нежитью выбирает Изгнание', async () => {
  const { planHeroCombatCommand } = await import('../server/party-tactics.mjs')
  const plan = planHeroCombatCommand(battle(), 'cleric')
  assert.equal(plan.command.action_id, 'turn-undead', JSON.stringify(plan.command))
})

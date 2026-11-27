// Вдохновение барда как в BG3: кость сама прибавляется к проваленной атаке,
// проверке или спасброску и тратится. Аудит боя 2026-10-13: действие вешало
// метку, которую не читал ни один бросок.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { enemyFrom2014 } from '../server/combat-lab-monsters.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { diceThen } from './kit/dice.mjs'

const records = JSON.parse(readFileSync(new URL('../data/compendia/dnd_5e_2014/monsters.json', import.meta.url), 'utf8')).monsters
const SWORD = { id: 'sword', catalog_id: 'srd_5_2_1:longsword', type: 'weapon', quantity: 1, equipped: true }

function battle({ inspired = true, bardLevel = 7 } = {}) {
  const dragon = { ...enemyFrom2014(records.find((entry) => entry.id.endsWith(':young-red-dragon')), { x: 0, y: 2 }), id: 'dragon', armor: 15 }
  const fighter = { id: 'hero', character: 'Мирт', characterClass: 'fighter', level: 7, hp: 200, maxHp: 200, armor: 18, speed: 30, proficiency: 3,
    abilities: { str: 16, dex: 10, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [SWORD], x: 4, y: 2, classSkillProficiencies: ['athletics', 'perception'] }
  const bard = { id: 'bard', character: 'Лиса', characterClass: 'bard', level: bardLevel, hp: 40, maxHp: 40, armor: 14, speed: 30, proficiency: 3,
    abilities: { str: 8, dex: 14, con: 12, int: 10, wis: 10, cha: 18 }, x: 6, y: 2 }
  return normalizeCampaignState({
    sessionCode: 'INSPIRATION', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
    players: [fighter, bard], partyMemberIds: ['hero', 'bard'], enemies: [dragon],
    scene: { turn: 1, cells: Array.from({ length: 75 }, (_, i) => ({ x: i % 15, y: Math.floor(i / 15), type: 'floor', revealed: true })) },
    mechanics: {
      combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'dragon', total: 15 }, { actor_id: 'bard', total: 5 }],
        action_economy: Object.fromEntries(['hero', 'dragon', 'bard'].map((id) => [id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])) },
      conditions: inspired ? { hero: [{ id: 'bardic-inspiration', duration: 'rounds:100', source_actor: 'bard' }] } : {},
    },
  })
}
const inspiredStill = (state, result) => (result.events.reduce(applyGameEvent, state).mechanics.conditions.hero ?? []).some((entry) => String(entry?.id ?? entry) === 'bardic-inspiration')

test('проваленная атака: кость вдохновения (к8 у барда 7-го уровня) превращает промах в попадание и тратится', () => {
  const state = battle()
  state.mechanics.positions.dragon = { x: 2, y: 2 }
  Object.assign(state.enemies[0], { x: 2, y: 2 })
  // d20 = 8: 8 + 6 = 14 против КД 15 — промах; к8 = 8 — 22, попадание.
  const result = resolveCommand({ command_id: 'swing', command_type: 'MakeAttack', actor_id: 'hero', target_id: 'dragon', item_id: 'sword', server_authoritative: true },
    state, { diceService: diceThen([8, 8], 4), context: { serverAuthoritativeCombat: true } })
  const attack = result.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(attack.payload.hit, true)
  assert.equal(attack.payload.bardic_inspiration, 8)
  assert.equal(inspiredStill(state, result), false)
  assert.equal(inspiredStill(state, result), (replayEvents(state, result.events).mechanics.conditions.hero ?? []).some((entry) => entry.id === 'bardic-inspiration'))
})

test('удачная атака кость не тратит', () => {
  const state = battle()
  state.mechanics.positions.dragon = { x: 2, y: 2 }
  Object.assign(state.enemies[0], { x: 2, y: 2 })
  const result = resolveCommand({ command_id: 'swing', command_type: 'MakeAttack', actor_id: 'hero', target_id: 'dragon', item_id: 'sword', server_authoritative: true },
    state, { diceService: diceThen([18], 4), context: { serverAuthoritativeCombat: true } })
  assert.equal(result.events.find((event) => event.event_type === 'AttackResolved').payload.bardic_inspiration, undefined)
  assert.equal(inspiredStill(state, result), true)
})

test('проваленный спасбросок от дыхания дракона спасает кость вдохновения', () => {
  const state = battle()
  state.mechanics.combat.active_index = 1
  // 16к6 на единицах — 16; спасбросок Ловкости d20 = 12 против СЛ 17 — провал; к8 = 8 — 20, успех.
  const result = resolveCommand({ command_id: 'breath', command_type: 'UseMonsterAction', actor_id: 'dragon', action_id: 'fire-breath', to: { x: 4, y: 2 }, server_authoritative: true },
    state, { diceService: diceThen([...Array(16).fill(1), 12, 8], 1), context: { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true } })
  const save = result.events.find((event) => event.event_type === 'SavingThrowResolved' && event.target_ids[0] === 'hero')
  assert.equal(save.payload.saved, true)
  assert.equal(save.payload.bardic_inspiration, 8)
  assert.equal(result.events.find((event) => event.event_type === 'DamageApplied' && event.target_ids[0] === 'hero').payload.applied_amount, 8, 'успех — половина урона')
})

test('проваленная проверка навыка — тоже с костью; у барда 4-го уровня кость к6', () => {
  const state = battle({ bardLevel: 4 })
  state.mechanics.combat = { active: false }
  const result = resolveCommand({ command_id: 'check', command_type: 'MakeAbilityCheck', actor_id: 'hero', skill: 'perception', difficulty: 15 },
    state, { diceService: diceThen([7, 6], 4), context: { isAdmin: true } })
  const check = result.events.find((event) => event.event_type === 'AbilityCheckResolved')
  assert.equal(check.payload.bardic_inspiration, 6)
  assert.equal(check.payload.success, true, '7 + 3 + 6 = 16 против 15')
})

// Источник магии чародея (PHB 2014): ячейка из чародейских очков по цене круга
// и ячейка в очки. Аудит боя 2026-10-13: действие всегда давало ячейку 1-го
// круга за одно очко, а перевести ячейку в очки было нельзя.
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { fixedDice } from './kit/dice.mjs'

function sorcerer({ points = 7, slots = { 1: 4, 2: 3, 3: 3, 4: 1 }, max = { 1: 4, 2: 3, 3: 3, 4: 1 } } = {}) {
  const cells = Array.from({ length: 30 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10), type: 'floor', revealed: true }))
  const resources = { sorcery_points: { current: points, max: 7 } }
  for (const [level, current] of Object.entries(slots)) resources[`spell_slots_${level}`] = { current, max: max[level] }
  return normalizeCampaignState({
    sessionCode: 'FONT-OF-MAGIC', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', partyMemberIds: ['sorc'],
    players: [{ id: 'sorc', character: 'Лира', characterClass: 'sorcerer', level: 7, hp: 40, maxHp: 40, armor: 13, speed: 30, proficiency: 3,
      abilities: { str: 8, dex: 14, con: 14, int: 10, wis: 10, cha: 18 }, x: 0, y: 1 }],
    enemies: [{ id: 'ogre', name: 'Огр', hp: 60, maxHp: 60, armor: 11, speed: 30, abilities: { str: 18 }, x: 6, y: 1, alive: true }],
    scene: { title: 'Зал', location: 'Зал', turn: 1, cells },
    mechanics: {
      combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'sorc', total: 15 }, { actor_id: 'ogre', total: 5 }],
        action_economy: { sorc: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } },
      resources: { sorc: resources },
    },
  })
}
const font = (state, extra = {}) => {
  const result = resolveCommand({ command_id: `font-${JSON.stringify(extra)}`, command_type: 'UseCombatAction', actor_id: 'sorc', action_id: 'font-of-magic', ...extra }, state,
    { diceService: fixedDice(10), context: { serverAuthoritativeCombat: true, allowedActorIds: ['sorc'] } })
  return { result, state: result.events.reduce(applyGameEvent, state) }
}
const pool = (state, name) => state.mechanics.resources.sorc[name].current

test('ячейка 3-го круга стоит 5 очков; бонусное действие потрачено; replay сходится', () => {
  const start = sorcerer({ slots: { 1: 4, 2: 3, 3: 1, 4: 1 } })
  const { result, state } = font(start, { slot_level: 3, font_mode: 'create' })
  assert.equal(pool(state, 'spell_slots_3'), 2)
  assert.equal(pool(state, 'sorcery_points'), 2)
  assert.equal(state.mechanics.combat.action_economy.sorc.bonus_action, false)
  assert.equal(pool(replayEvents(start, result.events), 'sorcery_points'), 2)
})

test('без выбора — младшая недостающая ячейка, которую хватает очков создать', () => {
  const { state } = font(sorcerer({ points: 3, slots: { 1: 4, 2: 1, 3: 0, 4: 1 } }))
  assert.equal(pool(state, 'spell_slots_2'), 2, '3-й круг стоит 5 очков, их нет — создана ячейка 2-го за 3')
  assert.equal(pool(state, 'sorcery_points'), 0)
})

test('ячейка в очки по её кругу, очки не растут выше уровня', () => {
  const { state } = font(sorcerer({ points: 2 }), { slot_level: 3, font_mode: 'convert' })
  assert.equal(pool(state, 'spell_slots_3'), 2)
  assert.equal(pool(state, 'sorcery_points'), 5)
  // Все ячейки полны — без выбора действие переводит младшую в очки.
  const auto = font(sorcerer({ points: 2 })).state
  assert.equal(pool(auto, 'spell_slots_1'), 3)
  assert.equal(pool(auto, 'sorcery_points'), 3)
})

test('отказы: полный запас ячейки, нехватка очков, полные очки', () => {
  assert.throws(() => font(sorcerer(), { slot_level: 2, font_mode: 'create' }), { code: 'FONT_OF_MAGIC_NOTHING_TO_CREATE' })
  assert.throws(() => font(sorcerer({ points: 4, slots: { 1: 4, 2: 3, 3: 0, 4: 1 } }), { slot_level: 3, font_mode: 'create' }), { code: 'FONT_OF_MAGIC_NOTHING_TO_CREATE' })
  assert.throws(() => font(sorcerer({ points: 7 }), { slot_level: 1, font_mode: 'convert' }), { code: 'FONT_OF_MAGIC_NOTHING_TO_CONVERT' })
  assert.throws(() => font(sorcerer({ points: 7 })), { code: 'FONT_OF_MAGIC_NOTHING_TO_CONVERT' }, 'всё полно — делать нечего')
})

// «Добыча охотника» следопыта-Охотника, вариант «Убийца колоссов» (PHB 2014,
// в BG3 — выбор по умолчанию). Аудит боя 2026-10-13: умение из каталога
// собралось реакцией, лечащей противника на 1к8, и было заблокировано.
import assert from 'node:assert/strict'
import test from 'node:test'

import { combatActionsFor } from '../server/combat-actions.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { fixedDice } from './kit/dice.mjs'

function hunt({ subclass = 'Охотник', ogreHp = 250 } = {}) {
  const cells = Array.from({ length: 30 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'HUNTERS-PREY', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', partyMemberIds: ['ranger'],
    players: [{ id: 'ranger', character: 'Вейла', characterClass: 'ranger', subclass, level: 7, hp: 50, maxHp: 50, armor: 15, speed: 30, proficiency: 3,
      abilities: { str: 10, dex: 18, con: 12, int: 10, wis: 14, cha: 10 },
      inventory: [{ id: 'sword', catalog_id: 'srd_5_2_1:shortsword', type: 'weapon', quantity: 1, equipped: true }], x: 0, y: 1 }],
    enemies: [{ id: 'ogre', name: 'Огр', hp: ogreHp, maxHp: 300, armor: 10, speed: 30, abilities: { str: 18, dex: 8, con: 16 }, x: 1, y: 1, alive: true }],
    scene: { title: 'Опушка', location: 'Опушка', turn: 1, cells },
    mechanics: { combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'ranger', total: 15 }, { actor_id: 'ogre', total: 5 }],
      action_economy: { ranger: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } } },
  })
}
let counter = 0
const strike = (state) => {
  const result = resolveCommand({ command_id: `prey-${counter += 1}`, command_type: 'MakeAttack', actor_id: 'ranger', target_id: 'ogre', item_id: 'sword', server_authoritative: true }, state,
    { diceService: fixedDice(15), context: { serverAuthoritativeCombat: true, allowedActorIds: ['ranger'] } })
  const damage = result.events.find((event) => event.event_type === 'DamageApplied')?.payload.applied_amount
  return { result, damage, state: result.events.reduce(applyGameEvent, state) }
}

test('раненая цель: первое попадание за ход — ещё 1к8, второе — без неё', () => {
  const start = hunt()
  const first = strike(start)
  assert.equal(first.damage, 6 + 4 + 8)
  assert.ok(first.result.events.some((event) => event.event_type === 'DieRolled' && event.payload.colossus_slayer === true))
  const second = strike(first.state)
  assert.equal(second.damage, 6 + 4, 'раз в ход')
  const replayed = replayEvents(start, [...first.result.events, ...second.result.events])
  assert.equal(replayed.enemies[0].hp, second.state.enemies[0].hp)
  assert.equal(replayed.mechanics.combat.action_economy.ranger.colossus_slayer_turn_key, first.state.mechanics.combat.action_economy.ranger.colossus_slayer_turn_key)
})

test('цель с полными хитами — без добавки; после первой раны добавка срабатывает', () => {
  const first = strike(hunt({ ogreHp: 300 }))
  assert.equal(first.damage, 6 + 4)
  assert.equal(strike(first.state).damage, 6 + 4 + 8)
})

test('следующий ход — добавка снова доступна; у другого подкласса её нет', () => {
  const first = strike(hunt())
  const nextTurn = structuredClone(first.state)
  nextTurn.mechanics.combat.round = 2
  assert.equal(strike(normalizeCampaignState(nextTurn)).damage, 6 + 4 + 8)
  assert.equal(strike(hunt({ subclass: 'Повелитель зверей' })).damage, 6 + 4)
})

test('плитки «Добычи охотника» нет: умение пассивное', () => {
  assert.ok(!combatActionsFor(hunt().players[0]).some((entry) => entry.id === 'ranger-ohotnik-dobycha-ohotnika'))
})

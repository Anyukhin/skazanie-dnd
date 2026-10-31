// Автотактика стабилизирует только того, кто ещё бросает спасброски от
// смерти. Стенд боёв 7-го уровня 2026-10-13: план «Стабилизация» по уже
// стабильному или погибшему союзнику движок отклонял STABILIZATION_NOT_REQUIRED,
// и бой вставал.
import assert from 'node:assert/strict'
import test from 'node:test'

import { planHeroCombatCommand } from '../server/party-tactics.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { fixedDice } from './kit/dice.mjs'

function battle(fallenDeath = {}) {
  const cells = Array.from({ length: 60 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'STABILIZE', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', partyMemberIds: ['medic', 'fallen'],
    players: [
      { id: 'medic', character: 'Брат', characterClass: 'fighter', level: 7, hp: 40, maxHp: 40, armor: 16, speed: 30, proficiency: 3,
        abilities: { str: 16, dex: 10, con: 14, int: 10, wis: 12, cha: 10 }, inventory: [], x: 1, y: 1 },
      { id: 'fallen', character: 'Сестра', characterClass: 'fighter', level: 7, hp: 0, maxHp: 40, armor: 16, speed: 30, proficiency: 3,
        abilities: { str: 16, dex: 10, con: 14, int: 10, wis: 12, cha: 10 }, inventory: [], x: 2, y: 1 },
    ],
    enemies: [{ id: 'wolf', name: 'Волк', hp: 11, maxHp: 11, armor: 13, speed: 40, abilities: { str: 12, dex: 15, con: 12 }, x: 8, y: 5, alive: true }],
    scene: { title: 'Поляна', location: 'Поляна', turn: 1, cells },
    mechanics: {
      combat: { active: true, round: 2, active_index: 0, initiative: [{ actor_id: 'medic', total: 15 }, { actor_id: 'fallen', total: 12 }, { actor_id: 'wolf', total: 5 }],
        action_economy: { medic: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } },
      death: fallenDeath,
    },
  })
}

test('лежащего без стабильности — стабилизировать', () => {
  const state = battle({ saving_throws: { fallen: { successes: 0, failures: 1 } } })
  const plan = planHeroCombatCommand(state, 'medic')
  assert.equal(plan.command.action_id, 'stabilize', JSON.stringify(plan.command))
  // И движок такую команду принимает.
  assert.doesNotThrow(() => resolveCommand({ command_id: 'stab', ...plan.command }, state, { diceService: fixedDice(15), context: { serverAuthoritativeCombat: true } }))
})

test('стабильного и погибшего — не стабилизировать', () => {
  for (const death of [
    { saving_throws: { fallen: { successes: 0, failures: 0, stable: true } } },
    { heroes: { fallen: { status: 'dead' } } },
  ]) {
    const plan = planHeroCombatCommand(battle(death), 'medic')
    assert.notEqual(plan.command?.action_id, 'stabilize', JSON.stringify(death))
  }
})

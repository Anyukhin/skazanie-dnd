import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

test('area saving throw applies Bless modifier before resolving the effect', () => {
  const cells = Array.from({ length: 25 }, (_, index) => ({ x: index % 5, y: Math.floor(index / 5), type: 'floor', revealed: true }))
  const state = normalizeCampaignState({
    sessionCode: 'AREA-SAVE-MODIFIER-AUDIT',
    partyMemberIds: ['caster', 'target'],
    players: [
      { id: 'caster', character: 'Маг', characterClass: 'wizard', level: 5, hp: 20, maxHp: 20, armor: 12, speed: 30, proficiency: 3, abilities: { int: 18, con: 14 }, inventory: [], x: 0, y: 0 },
      { id: 'target', character: 'Цель', characterClass: 'fighter', level: 5, hp: 20, maxHp: 20, armor: 12, speed: 30, proficiency: 3, abilities: { dex: 10, con: 10 }, inventory: [], x: 2, y: 2 },
    ],
    enemies: [],
    scene: { turn: 1, cells },
    mechanics: {
      conditions: { target: [{ id: 'bless-d4', source_actor: 'caster' }] },
      active_effects: [{
        id: 'stinking-cloud:modifier-audit', effect_id: 'stinking-cloud:modifier-audit', spell_id: 'stinking-cloud', source_actor: 'caster',
        center: { x: 2, y: 2 }, radius_feet: 20, area_shape: 'sphere', trigger_on_turn_start: true,
        save_ability: 'con', save_dc: 5, save_damage_type: 'poison', requires_breathing: true, spend_action_on_fail: true,
      }],
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'target', total: 10 }],
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          target: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
  let rollId = 0
  const result = resolveCommand({ command_type: 'EndTurn', command_id: 'area-save-modifier', actor_id: 'caster', server_authoritative: true }, state, {
    diceService: new DiceService({
      rng: new SequenceDiceRng([1, 4, 1, 4]),
      idFactory: () => `area-save-modifier-${++rollId}`,
      now: () => '2026-09-19T12:00:00.000Z',
    }),
    context: { serverAuthoritativeCombat: true },
  })
  const save = result.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(save?.payload.saved, true, '1 на d20 плюс 4 от Bless должен пройти СЛ 5')
  assert.ok(result.events.some((event) => event.event_type === 'DieRolled' && event.payload.purpose === 'spell:bless:saving-throw'))

  const baneState = structuredClone(state)
  baneState.mechanics.conditions.target = [{ id: 'bane-d4', source_actor: 'caster' }]
  const baneResult = resolveCommand({ command_type: 'EndTurn', command_id: 'area-save-modifier-bane', actor_id: 'caster', server_authoritative: true }, baneState, {
    diceService: new DiceService({ rng: new SequenceDiceRng([4, 5]), idFactory: () => `area-save-modifier-bane-${++rollId}`, now: () => '2026-09-19T12:00:00.000Z' }),
    context: { serverAuthoritativeCombat: true },
  })
  const baneSave = baneResult.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(baneSave?.payload.saved, false, '5 на d20 минус 4 от Bane должен провалить СЛ 5')
  assert.ok(baneResult.events.some((event) => event.event_type === 'DieRolled' && event.payload.purpose === 'spell:bane:saving-throw'))
})

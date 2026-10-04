import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { heroSpellcastingSummaryFor } from '../server/combat-spells.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { createTacticalMap, legacyCellsFromTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

// СЛ и бонус атаки заклинаниями у портрета героя на панели стола приходят из
// проекции. Числа обязаны совпадать с теми, что движок применит в CastSpell, —
// иначе панель обещала бы игроку одну сложность, а бой бросал против другой.

function dice(values) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `spellcasting-summary-${++id}`, now: () => '2026-10-04T12:00:00.000Z' })
}

function wizardState() {
  const map = createTacticalMap({ width: 10, height: 10, fill: { passable: true, revealed: true, material: 'stone' } })
  return normalizeCampaignState({
    sessionCode: 'SPELLCASTING-SUMMARY',
    partyMemberIds: ['caster', 'fighter'],
    activePlayerId: 'caster',
    players: [{
      id: 'caster', character: 'Волшебница', characterClass: 'wizard', level: 5,
      hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3,
      abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 12, cha: 10 },
      knownSpellIds: ['fireball'], preparedSpellIds: ['fireball'], inventory: [], x: 0, y: 9,
    }, {
      id: 'fighter', character: 'Воин', characterClass: 'fighter', level: 5,
      hp: 44, maxHp: 44, armor: 18, speed: 30, proficiency: 3,
      abilities: { str: 17, dex: 12, con: 15, int: 10, wis: 10, cha: 10 }, inventory: [], x: 1, y: 9,
    }],
    enemies: [{
      id: 'ogre', name: 'Огр', creature_type: 'giant', hp: 100, maxHp: 100, armor: 11, speed: 30, level: 7,
      abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 }, alive: true, x: 5, y: 3,
    }],
    scene: { title: 'Зал', location: 'Зал', turn: 1, map: serializeTacticalMap(map), cells: legacyCellsFromTacticalMap(map) },
    mechanics: {
      positions: { caster: { x: 0, y: 9 }, fighter: { x: 1, y: 9 }, ogre: { x: 5, y: 3 } },
      resources: { caster: { spell_slots_3: { current: 1, max: 1 } } },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'ogre', total: 10 }, { actor_id: 'fighter', total: 5 }],
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          ogre: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          fighter: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

test('сводка заклинателя: характеристика класса, мастерство и СЛ = 8 + бонус атаки', () => {
  assert.deepEqual(heroSpellcastingSummaryFor({ characterClass: 'wizard', proficiency: 3, abilities: { int: 18 } }), { ability: 'int', attack_bonus: 7, save_dc: 15 })
  assert.deepEqual(heroSpellcastingSummaryFor({ characterClass: 'cleric', proficiency: 2, abilities: { wis: 15 } }), { ability: 'wis', attack_bonus: 4, save_dc: 12 })
  assert.equal(heroSpellcastingSummaryFor({ characterClass: 'fighter', proficiency: 3, abilities: { int: 18 } }), null, 'у воина без заклинаний сводки нет')
})

test('проекция отдаёт сводку только своему заклинателю', () => {
  const state = wizardState()
  const own = campaignStateForViewer(state, { role: 'player', heroIds: ['caster'] }, 'caster')
  const caster = own.players.find((player) => player.id === 'caster')
  assert.deepEqual(caster.characterSheet.spellcasting, { ability: 'int', attack_bonus: 7, save_dc: 15 })
  const fighter = own.players.find((player) => player.id === 'fighter')
  assert.equal(fighter.characterSheet?.spellcasting, undefined, 'чужой лист без сводки')
  const asFighter = campaignStateForViewer(state, { role: 'player', heroIds: ['fighter'] }, 'fighter')
  assert.equal(asFighter.players.find((player) => player.id === 'caster').characterSheet?.spellcasting, undefined)
  assert.equal(asFighter.players.find((player) => player.id === 'fighter').characterSheet?.spellcasting, undefined, 'воину сводка не нужна')
})

test('СЛ в проекции совпадает со СЛ спасброска, которую применяет CastSpell', () => {
  const state = wizardState()
  const projected = campaignStateForViewer(state, { role: 'player', heroIds: ['caster'] }, 'caster')
  const shown = projected.players.find((player) => player.id === 'caster').characterSheet.spellcasting.save_dc
  const result = resolveCommand({
    command_type: 'CastSpell', command_id: 'summary-fireball', actor_id: 'caster', spell_id: 'fireball',
    to: { x: 5, y: 3 }, slot_level: 3, server_authoritative: true,
  }, state, { diceService: dice([4, 4, 4, 4, 4, 4, 4, 4, 1]), context: { serverAuthoritativeCombat: true, isAdmin: true } })
  const save = result.events.find((event) => event.event_type === 'SpellSavingThrowResolved' && event.target_ids.includes('ogre'))
  assert.ok(save, 'Огненный шар должен вызвать спасбросок огра')
  assert.equal(save.payload.difficulty, shown)
})

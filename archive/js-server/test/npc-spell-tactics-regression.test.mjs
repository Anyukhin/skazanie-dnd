import assert from 'node:assert/strict'
import test from 'node:test'

import { MONSTER_SPELL_AT_WILL } from '../server/combat-spells.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'

function cells(width = 14, height = 8) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
    type: 'floor',
    revealed: true,
  }))
}

function mage(spells, extra = {}) {
  return {
    id: 'mage',
    name: 'Маг',
    hp: 40,
    maxHp: 40,
    armor: 12,
    speed: 30,
    proficiency: 3,
    creature_type: 'humanoid',
    abilities: { str: 9, dex: 14, con: 11, int: 17, wis: 12, cha: 11 },
    action_profiles: [{
      id: 'dagger',
      name: 'Кинжал',
      kind: 'melee',
      attack_modifier: 5,
      damage_expression: '1d4+2',
      damage_type: 'piercing',
      range_feet: 5,
    }],
    spellcasting: {
      ability: 'int',
      save_dc: 14,
      attack_bonus: 6,
      caster_level: 9,
      spells: spells.map((id) => ({ id, uses: MONSTER_SPELL_AT_WILL })),
    },
    x: 6,
    y: 2,
    alive: true,
    ...extra,
  }
}

function hero(id, x, y, extra = {}) {
  return {
    id,
    name: id,
    hp: 40,
    maxHp: 40,
    armor: 12,
    speed: 30,
    proficiency: 3,
    abilities: { str: 10, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
    creature_type: 'humanoid',
    x,
    y,
    alive: true,
    ...extra,
  }
}

function state({ spells, heroes = [hero('hero-1', 4, 2)], allies = [], concentration = {}, casterExtra = {} }) {
  const caster = mage(spells, casterExtra)
  const initiative = [
    ...heroes.map((actor, index) => ({ actor_id: actor.id, total: 20 - index })),
    { actor_id: caster.id, total: 10 },
  ]
  return normalizeCampaignState({
    sessionCode: 'NPC-SPELL-TACTICS',
    ruleset_id: 'dnd_5e_2014',
    partyMemberIds: heroes.map((actor) => actor.id),
    players: heroes,
    enemies: [caster, ...allies],
    scene: { turn: 1, cells: cells() },
    mechanics: {
      concentration,
      combat: {
        active: true,
        round: 1,
        active_index: initiative.length - 1,
        initiative,
        action_economy: Object.fromEntries(initiative.map(({ actor_id }) => [actor_id, {
          action: true,
          bonus_action: true,
          reaction: true,
          movement: true,
          movement_spent: 0,
        }])),
      },
    },
  })
}

test('планировщик оценивает все снаряды Волшебной стрелы', () => {
  const slowed = state({ spells: ['magic-missile', 'ray-of-frost'] })
  slowed.mechanics.conditions['hero-1'] = [{ id: 'speed-reduced-10' }]
  const plan = planNpcTurn(slowed, 'mage')
  assert.deepEqual(planNpcTurn(slowed, 'mage'), plan)
  assert.equal(plan.find((command) => command.command_type === 'CastSpell')?.spell_id, 'magic-missile')
})

test('планировщик возвращает фактическую старшую ячейку', () => {
  const plan = planNpcTurn(state({
    spells: ['magic-missile'],
    casterExtra: {
      spellcasting: {
        ability: 'int',
        save_dc: 14,
        attack_bonus: 6,
        caster_level: 9,
        spells: [{ id: 'magic-missile' }],
        spell_slots: [
          { level: 1, slots: 0, spells: [{ key: 'magic-missile' }] },
          { level: 2, slots: 1, spells: [{ key: 'magic-missile' }] },
        ],
      },
    },
  }), 'mage')
  const command = plan.find((candidate) => candidate.command_type === 'CastSpell')
  assert.equal(command?.spell_id, 'magic-missile')
  assert.equal(command?.slot_level, 2)
  assert.equal(command?.spell_slot_resource, 'spell_slots_2')
})

for (const [spellId, label] of [['burning-hands', 'конус'], ['lightning-bolt', 'линия']]) {
  test(`планировщик не направляет ${label} на своих`, () => {
    const plan = planNpcTurn(state({
      spells: [spellId, 'fire-bolt'],
      heroes: [hero('hero-1', 4, 2), hero('hero-2', 3, 2)],
      allies: [{
        id: 'ally',
        name: 'Союзник мага',
        hp: 40,
        maxHp: 40,
        armor: 12,
        speed: 30,
        creature_type: 'humanoid',
        abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
        x: 5,
        y: 2,
        alive: true,
        action_profiles: [{ id: 'claw', kind: 'melee', attack_modifier: 3, damage_expression: '1d4', damage_type: 'slashing', range_feet: 5 }],
      }],
    }), 'mage')
    assert.equal(plan.find((command) => command.command_type === 'CastSpell')?.spell_id, 'fire-bolt')
  })
}

test('планировщик не тратит повторно концентрационный контроль', () => {
  const plan = planNpcTurn(state({
    spells: ['hold-person', 'fire-bolt'],
    concentration: { mage: { effect_id: 'hold-person:previous' } },
  }), 'mage')
  assert.equal(plan.find((command) => command.command_type === 'CastSpell')?.spell_id, 'fire-bolt')
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

const WIDTH = 24
const HEIGHT = 24
const CELL_FEET = 5
const CASTER = { x: 12, y: 12 }
const POINT = { x: 17, y: 12 }

// Независимый эталон: длина стен в D&D 2014 указана в футах;
// одна клетка занимает 5 футов. Источники: https://dnd.su/spells/399-wall_of_sand/,
// https://5e14.dnd.su/spells/202-wall-of-fire/,
// https://www.dnd.su/spells/337-wind-wall/.
const WALL_LENGTHS = [
  { spellId: 'wall-of-sand', characterClass: 'wizard', level: 5, maxLengthFeet: 30 },
  { spellId: 'wall-of-fire', characterClass: 'wizard', level: 9, maxLengthFeet: 60 },
  { spellId: 'wind-wall', characterClass: 'druid', level: 5, maxLengthFeet: 50 },
]

function floorCells() {
  return Array.from({ length: WIDTH * HEIGHT }, (_, index) => ({
    x: index % WIDTH,
    y: Math.floor(index / WIDTH),
    type: 'floor',
    revealed: true,
  }))
}

function stateFor(characterClass, level) {
  return normalizeCampaignState({
    sessionCode: 'WALL-CELL-ORACLE',
    partyMemberIds: ['mage'],
    players: [{
      id: 'mage', character: 'Маг', characterClass, level,
      hp: 60, maxHp: 60, armor: 13, speed: 30, proficiency: 4,
      abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 18, cha: 12 },
      inventory: [], ...CASTER,
    }],
    enemies: [],
    scene: { turn: 1, cells: floorCells() },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'mage', total: 20 }],
        action_economy: {
          mage: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function castWall({ spellId, characterClass, level }) {
  const diceService = new DiceService({
    rng: new SequenceDiceRng(Array.from({ length: 32 }, () => 6)),
    idFactory: () => `wall-oracle-${spellId}`,
    now: () => '2026-09-22T00:00:00.000Z',
  })
  const result = resolveCommand({
    command_type: 'CastSpell',
    command_id: `wall-oracle:${spellId}`,
    actor_id: 'mage',
    spell_id: spellId,
    to: POINT,
    server_authoritative: true,
  }, stateFor(characterClass, level), { diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
  return result.events.find((event) => event.event_type === 'SpellAreaCreated')?.payload.effect
}

test('прямая стена занимает ровно указанную в правилах длину без лишней клетки', () => {
  for (const profile of WALL_LENGTHS) {
    const effect = castWall(profile)
    assert.ok(effect, `${profile.spellId}: SpellAreaCreated is required`)
    const expectedCells = profile.maxLengthFeet / CELL_FEET
    assert.equal(effect.cells.length, expectedCells, `${profile.spellId}: ${profile.maxLengthFeet} ft is ${expectedCells} cells`)
    assert.equal(new Set(effect.cells.map(({ x, y }) => `${x},${y}`)).size, expectedCells, `${profile.spellId}: no duplicate cells`)
    assert.equal(new Set(effect.cells.map(({ x }) => x)).size, 1, `${profile.spellId}: fixture points east, wall remains perpendicular`)
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'

const diceService = new DiceService({ rng: new SequenceDiceRng([]) })

function campaign(actor) {
  return normalizeCampaignState({
    sessionCode: 'CHAR-LIFECYCLE',
    partyMemberIds: [actor.id],
    players: [actor],
  })
}

function wizard(overrides = {}) {
  return {
    id: 'wizard',
    character: 'Мира',
    characterClass: 'wizard',
    level: 4,
    experience: 6_500,
    abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 10, cha: 10 },
    hp: 20,
    maxHp: 22,
    baseSpeed: 30,
    hitPointIncreases: [4, 4, 4],
    classSkillProficiencies: ['arcana', 'history'],
    selectedFeatureIds: [],
    knownSpellIds: ['fire-bolt', 'mage-hand', 'light'],
    preparedSpellIds: [],
    inventory: [],
    ...overrides,
  }
}

test('Rules Engine resolves LevelUp as one replayable event and expands server-owned resources', () => {
  const initial = campaign(wizard())
  const result = resolveCommands([{
    command_type: 'LevelUp',
    actor_id: 'wizard',
    expected_level: 4,
  }], initial, { diceService, context: { allowedActorIds: ['wizard'] } })

  assert.deepEqual(result.events.map((event) => event.event_type), ['CharacterLeveledUp'])
  assert.equal(result.state.players[0].level, 5)
  assert.equal(result.state.players[0].proficiency, 3)
  assert.equal(result.state.mechanics.resources.wizard.spell_slots_3.max, 2)
  assert.deepEqual(replayEvents(initial, result.events), result.state)
})

test('versioned ImportCharacter cannot forge inventory, money, HP, AC or proficiency and replays exactly', () => {
  const initial = campaign(wizard({
    level: 1,
    experience: 0,
    hitPointIncreases: [],
    inventory: [{ id: 'kept', name: 'Kept', type: 'other', quantity: 1, weight: 0, equipped: false }],
    currency: { gold: 7 },
  }))
  const document = {
    schema: 'skazanie.character',
    schema_version: 1,
    character: {
      character: 'Мира',
      characterClass: 'wizard',
      species: 'Человек',
      level: 1,
      experience: 0,
      abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.standard-array',
        policyVersion: 1,
        method: 'standard_array',
        baseScores: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
        originBonusProfileId: 'none',
        originBonuses: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
        speciesOptionId: 'human',
      },
      baseSpeed: 30,
      classSkillProficiencies: ['arcana', 'history'],
      selectedFeatureIds: [],
      knownSpellIds: ['fire-bolt', 'mage-hand', 'light'],
      preparedSpellIds: [],
      notes: 'Проверено сервером',
    },
  }
  const result = resolveCommands([{
    command_type: 'ImportCharacter',
    actor_id: 'wizard',
    document,
  }], initial, { diceService, context: { allowedActorIds: ['wizard'] } })

  assert.deepEqual(result.events.map((event) => event.event_type), ['CharacterImported'])
  assert.equal(result.state.players[0].inventory[0].id, 'kept')
  assert.equal(result.state.players[0].currency.gold, 7)
  assert.equal(result.state.players[0].proficiency, 2)
  assert.equal(result.state.players[0].armor, 12)
  assert.deepEqual(replayEvents(initial, result.events), result.state)

  assert.throws(() => resolveCommands([{
    command_type: 'ImportCharacter',
    actor_id: 'wizard',
    document: { ...document, character: { ...document.character, hp: 999, inventory: [] } },
  }], initial, { diceService, context: { allowedActorIds: ['wizard'] } }), (error) => error.code === 'IMPORT_UNKNOWN_FIELD')
})

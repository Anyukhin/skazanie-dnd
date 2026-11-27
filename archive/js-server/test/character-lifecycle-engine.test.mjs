import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { createCharacterSlot } from '../server/character-lifecycle.mjs'
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

test('ячейка, полученная с уровнем, доступна сразу; старое событие без версии — по прежнему правилу', () => {
  const initial = campaign(wizard())
  // Волшебник 4-го уровня потратил все ячейки 1-го круга (их четыре).
  initial.mechanics.resources.wizard = { ...initial.mechanics.resources.wizard, spell_slots_1: { current: 0, max: 4 }, spell_slots_2: { current: 1, max: 3 } }
  const result = resolveCommands([{ command_type: 'LevelUp', actor_id: 'wizard', expected_level: 4 }], initial, { diceService, context: { allowedActorIds: ['wizard'] } })
  const pools = result.state.mechanics.resources.wizard
  assert.deepEqual(pools.spell_slots_1, { current: 0, max: 4 }, 'максимум не вырос — ничего не прибавилось')
  assert.deepEqual(pools.spell_slots_2, { current: 1, max: 3 })
  assert.deepEqual(pools.spell_slots_3, { current: 2, max: 2 }, 'новые ячейки 3-го круга доступны сразу')
  assert.deepEqual(replayEvents(initial, result.events), result.state)

  const fourth = campaign(wizard({ level: 3, experience: 2_700, hitPointIncreases: [4, 4] }))
  fourth.mechanics.resources.wizard = { ...fourth.mechanics.resources.wizard, spell_slots_2: { current: 0, max: 2 } }
  const grown = resolveCommands([{ command_type: 'LevelUp', actor_id: 'wizard', expected_level: 3 }], fourth, { diceService, context: { allowedActorIds: ['wizard'] } })
  assert.deepEqual(grown.state.mechanics.resources.wizard.spell_slots_2, { current: 1, max: 3 }, 'третья ячейка 2-го круга прибавилась к пустому запасу')

  const legacyEvents = grown.events.map((event) => ({ ...event, payload: { ...event.payload, resource_grant_version: undefined } }))
  assert.deepEqual(replayEvents(fourth, legacyEvents).mechanics.resources.wizard.spell_slots_2, { current: 0, max: 3 }, 'старое событие не переписывается')
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
  // Готового героя лист целиком заменяет только ведущий.
  const admin = { isAdmin: true, allowedActorIds: ['wizard'] }
  const result = resolveCommands([{
    command_type: 'ImportCharacter',
    actor_id: 'wizard',
    document,
  }], initial, { diceService, context: admin })

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
  }], initial, { diceService, context: admin }), (error) => error.code === 'IMPORT_UNKNOWN_FIELD')
})

test('игрок не переписывает импортом готового героя: ни уровень, ни опыт, ни хиты, ни класс', () => {
  const initial = campaign(wizard({ level: 1, experience: 0, hitPointIncreases: [] }))
  const document = {
    schema: 'skazanie.character',
    schema_version: 1,
    character: {
      character: 'Мира',
      characterClass: 'fighter',
      species: 'Человек',
      level: 12,
      experience: 100_000,
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.standard-array',
        policyVersion: 1,
        method: 'standard_array',
        baseScores: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
        originBonusProfileId: 'none',
        originBonuses: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
        speciesOptionId: 'human',
      },
      baseSpeed: 30,
      hitPointIncreases: Array(11).fill(10),
      classSkillProficiencies: ['athletics', 'perception'],
      selectedFeatureIds: ['fighting-style-defense'],
      knownSpellIds: [],
      preparedSpellIds: [],
    },
  }
  assert.throws(() => resolveCommands([{ command_type: 'ImportCharacter', actor_id: 'wizard', document }], initial, {
    diceService, context: { allowedActorIds: ['wizard'] },
  }), (error) => error.code === 'CHARACTER_ALREADY_CREATED')
  // Чужой герой отказывает раньше, и текст говорит об импорте, а не об уровне.
  assert.throws(() => resolveCommands([{ command_type: 'ImportCharacter', actor_id: 'wizard', document }], initial, {
    diceService, context: { allowedActorIds: ['someone-else'] },
  }), (error) => error.code === 'ACTOR_FORBIDDEN' && /Импортировать лист/u.test(error.message))
})

function slotCampaign(extra = {}) {
  return normalizeCampaignState({
    sessionCode: 'CHAR-SLOT', ruleset_id: 'srd_5_2_1', partyMemberIds: ['hero-slot-1'],
    players: [createCharacterSlot({ id: 'hero-slot-1' })], ...extra,
  })
}

function slotDocument(overrides = {}) {
  const baseScores = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }
  return {
    schema: 'skazanie.character',
    schema_version: 1,
    character: {
      character: 'Бранн', characterClass: 'fighter', species: 'Человек', level: 1, experience: 0,
      abilities: baseScores,
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.standard-array', policyVersion: 1, method: 'standard_array', baseScores,
        originBonusProfileId: 'none', originBonuses: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 }, speciesOptionId: 'human',
      },
      baseSpeed: 30, hitPointIncreases: [],
      classSkillProficiencies: ['athletics', 'perception'], selectedFeatureIds: ['fighting-style-defense'],
      knownSpellIds: [], preparedSpellIds: [],
      ...overrides,
    },
  }
}

const importInto = (state, document) => resolveCommands([{ command_type: 'ImportCharacter', actor_id: 'hero-slot-1', document }], state, {
  diceService, context: { allowedActorIds: ['hero-slot-1'] },
})

test('новый герой без обязательных выборов первого уровня не создаётся', () => {
  assert.equal(importInto(slotCampaign(), slotDocument()).state.players[0].characterSetupRequired, false)
  for (const [label, overrides, reason] of [
    ['без навыков', { classSkillProficiencies: [] }, /классовые навыки/u],
    ['без боевого стиля', { selectedFeatureIds: [] }, /выберите 1/u],
    ['волшебник без заклинаний', { characterClass: 'wizard', classSkillProficiencies: ['arcana', 'history'], selectedFeatureIds: [] }, /заговоры/u],
  ]) {
    assert.throws(() => importInto(slotCampaign(), slotDocument(overrides)), (error) => error.code === 'IMPORT_CHOICES_INCOMPLETE' && reason.test(error.message), label)
  }
  // При стартовом уровне выше первого выборы досдаются командами подготовки:
  // импорт оставляет героя в подготовке, а LevelUp не пустит дальше без них.
  const staged = importInto(slotCampaign({ character_start_level: 3 }), slotDocument({ classSkillProficiencies: [] }))
  assert.equal(staged.state.players[0].characterSetupRequired, true)
  assert.throws(() => resolveCommands([{ command_type: 'LevelUp', actor_id: 'hero-slot-1', expected_level: 1 }], staged.state, {
    diceService, context: { allowedActorIds: ['hero-slot-1'] },
  }), (error) => error.code === 'CHARACTER_CREATION_CHOICES_REQUIRED')
})

test('2024: без предыстории прибавок к характеристикам нет', () => {
  const baseScores = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }
  const forged = slotDocument({
    abilities: { ...baseScores, str: 17, con: 14 },
    abilityGeneration: {
      policyId: 'skazanie.character-abilities.standard-array', policyVersion: 1, method: 'standard_array', baseScores,
      originBonusProfileId: 'two_one', originBonuses: { str: 2, dex: 0, con: 1, int: 0, wis: 0, cha: 0 }, speciesOptionId: 'human',
    },
  })
  assert.throws(() => importInto(slotCampaign(), forged), (error) => error.code === 'IMPORT_BACKGROUND_REQUIRED')
})

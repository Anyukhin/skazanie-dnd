import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHARACTER_IMPORT_SCHEMA,
  CHARACTER_IMPORT_SCHEMA_VERSION,
  CharacterLifecycleValidationError,
  abilityModifier,
  applyCharacterLifecycleEvent,
  classResourcePlan,
  deriveCharacterSheet,
  experienceForLevel,
  levelForExperience,
  levelUpEvent,
  migrateCharacterImport,
  parseCharacterImport,
  proficiencyBonusForLevel,
  resourcesAfterRest,
  resolveLevelUp,
  validateLevelUpCommand,
} from '../server/character-lifecycle.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'

function fighter(overrides = {}) {
  return {
    id: 'fighter', character: 'Бранн', characterClass: 'fighter', level: 4, experience: 6_500,
    abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 },
    baseSpeed: 30, hp: 22, maxHp: 32,
    hitPointIncreases: [6, 6, 6],
    classSkillProficiencies: ['athletics', 'perception'],
    selectedFeatureIds: ['fighting-style-defense'], inventory: [],
    ...overrides,
  }
}

test('derived sheet computes ability modifiers, class saves, skill proficiency, AC, speed and HP without trusting flat fields', () => {
  const actor = fighter({
    armor: 99, speed: 99, proficiency: 99,
    inventory: [
      { id: 'leather', catalog_id: 'srd_5_2_1:leather-armor', type: 'armor', equipped: true },
      { id: 'shield', catalog_id: 'srd_5_2_1:shield', type: 'armor', equipped: true },
    ],
  })
  const sheet = deriveCharacterSheet(actor)
  assert.equal(abilityModifier(16), 3)
  assert.equal(sheet.proficiency_bonus, 2)
  assert.deepEqual(sheet.saving_throw_proficiencies, ['str', 'con'])
  assert.equal(sheet.saving_throws.str.total, 5)
  assert.equal(sheet.skills.athletics.total, 5)
  assert.equal(sheet.skills.stealth.total, 2)
  assert.equal(sheet.armor_class.value, 16, '11 + DEX + shield + Defense, not client armor=99')
  assert.equal(sheet.speed.value, 30, 'not client speed=99')
  assert.equal(sheet.hit_points.value, 36)
})

test('Защита даёт +1 КД только с надетым доспехом и допустимым классовым выбором', () => {
  const armor = { id: 'chain', catalog_id: 'srd_5_2_1:chain-mail', equipped: true }
  const shield = { id: 'shield', catalog_id: 'srd_5_2_1:shield', equipped: true }
  assert.equal(deriveCharacterSheet(fighter({ inventory: [armor, shield] })).armor_class.value, 19)
  assert.equal(deriveCharacterSheet(fighter({ inventory: [shield] })).armor_class.value, 14)
  assert.equal(deriveCharacterSheet(fighter({ inventory: [{ ...armor, equipped: false }] })).armor_class.value, 12)
  assert.equal(deriveCharacterSheet(fighter({ inventory: [armor], selectedFeatureIds: [] })).armor_class.value, 16)
  assert.equal(deriveCharacterSheet(fighter({ characterClass: 'wizard', inventory: [armor] })).armor_class.value, 16)
})

test('derived sheet exposes one stamped item bonus in AC and every saving throw', () => {
  const ring = {
    ...materializeCatalogItem('srd_5_2_1:ring-of-protection', { id: 'ring' }),
    equipped: true,
    attuned_to: 'fighter',
  }
  const active = deriveCharacterSheet(fighter({ inventory: [ring] }))
  assert.equal(active.armor_class.value, 13)
  assert.equal(active.armor_class.item_effect_bonus, 1)
  for (const save of Object.values(active.saving_throws)) {
    assert.equal(save.item_effect_bonus, 1)
  }
  assert.equal(active.saving_throws.str.total, 6)
  assert.equal(active.saving_throws.wis.total, 2)

  const inactive = deriveCharacterSheet(fighter({ inventory: [{ ...ring, attuned_to: null }] }))
  assert.equal(inactive.armor_class.value, 12)
  assert.equal(inactive.armor_class.item_effect_bonus, 0)
  assert.equal(inactive.saving_throws.str.total, 5)
})

test('barbarian and monk use their class unarmored AC formulas', () => {
  const barbarian = deriveCharacterSheet(fighter({ characterClass: 'barbarian', abilities: { str: 16, dex: 14, con: 16, int: 8, wis: 10, cha: 8 }, inventory: [] }))
  const monk = deriveCharacterSheet(fighter({ characterClass: 'monk', abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 16, cha: 8 }, inventory: [] }))
  assert.equal(barbarian.armor_class.value, 15)
  assert.equal(monk.armor_class.value, 16)
})

test('experience thresholds and proficiency progression are deterministic through level 12', () => {
  assert.equal(experienceForLevel(1), 0)
  assert.equal(experienceForLevel(5), 6_500)
  assert.equal(experienceForLevel(12), 100_000)
  assert.equal(levelForExperience(84_999), 10)
  assert.equal(levelForExperience(85_000), 11)
  assert.equal(levelForExperience(999_999), 12)
  assert.equal(proficiencyBonusForLevel(1), 2)
  assert.equal(proficiencyBonusForLevel(5), 3)
  assert.equal(proficiencyBonusForLevel(12), 4)
})

test('LevelUp is one server-authoritative level with XP, ownership and hit-die validation', () => {
  const state = { players: [fighter()], mechanics: { combat: { active: false } } }
  const command = validateLevelUpCommand({ command_type: 'LevelUp', actor_id: 'fighter', hit_point_roll: 9 }, state, { allowedActorIds: ['fighter'] })
  assert.equal(command.level_before, 4)
  assert.equal(command.level_after, 5)
  assert.equal(command.max_hp_before, 36)
  assert.equal(command.max_hp_after, 47)
  const event = levelUpEvent(command)
  const after = applyCharacterLifecycleEvent(state, event)
  assert.equal(after.players[0].level, 5)
  assert.equal(after.players[0].maxHp, 47)
  assert.deepEqual(after.players[0].hitPointIncreases, [6, 6, 6, 9])
  assert.deepEqual(applyCharacterLifecycleEvent(state, event), after, 'pure reducer replay is stable')
  assert.throws(
    () => validateLevelUpCommand({ command_type: 'LevelUp', actor_id: 'fighter' }, state, { allowedActorIds: [] }),
    (error) => error instanceof CharacterLifecycleValidationError && error.code === 'ACTOR_FORBIDDEN',
  )
  assert.throws(
    () => validateLevelUpCommand({ command_type: 'LevelUp', actor_id: 'fighter', hit_point_roll: 11 }, state, { allowedActorIds: ['fighter'] }),
    (error) => error.code === 'INVALID_CHARACTER_VALUE',
  )
})

test('LevelUp rejects insufficient progression, combat and attempts to skip a level', () => {
  const noXp = { players: [fighter({ experience: 6_499 })], mechanics: { combat: { active: false } } }
  assert.throws(
    // Код переименован 2026-07-28: уровень заслуживают опытом **или** вехой,
    // и отказ теперь называет оба пути, а не только опыт.
    () => validateLevelUpCommand({ command_type: 'LevelUp', actor_id: 'fighter' }, noXp, { allowedActorIds: ['fighter'] }),
    (error) => error.code === 'LEVEL_UP_PROGRESSION_REQUIRED',
  )
  const combat = { players: [fighter()], mechanics: { combat: { active: true } } }
  assert.throws(
    () => validateLevelUpCommand({ command_type: 'LevelUp', actor_id: 'fighter' }, combat, { allowedActorIds: ['fighter'] }),
    (error) => error.code === 'LEVEL_UP_DURING_COMBAT',
  )
  assert.throws(
    () => validateLevelUpCommand({ command_type: 'LevelUp', actor_id: 'fighter', next_level: 6 }, noXp, { allowedActorIds: ['fighter'] }),
    (error) => error.code === 'LEVEL_UP_STEP_INVALID',
  )
})

test('resource plan delegates maxima and recovery to existing spell and class catalogs', () => {
  const wizard = { id: 'wizard', characterClass: 'wizard', level: 5, abilities: { int: 16, dex: 14, con: 12, str: 8, wis: 10, cha: 10 } }
  const warlock = { id: 'warlock', characterClass: 'warlock', level: 5, abilities: { cha: 16, dex: 14, con: 12, str: 8, int: 10, wis: 10 } }
  const wizardPlan = classResourcePlan(wizard)
  assert.equal(wizardPlan.maximums.spell_slots_1, 4)
  assert.equal(wizardPlan.maximums.spell_slots_2, 3)
  assert.equal(wizardPlan.maximums.spell_slots_3, 2)
  assert.equal(wizardPlan.maximums.arcane_recovery, 1)
  assert.equal(wizardPlan.maximums['feature_wizard-magicheskoe-vosstanovlenie'], 1)
  assert.equal(wizardPlan.recovery.spell_slots_1, 'long')
  assert.equal(wizardPlan.recovery.arcane_recovery, 'long')
  const warlockPlan = classResourcePlan(warlock)
  assert.equal(warlockPlan.maximums.pact_slots, 2)
  assert.ok(Object.keys(warlockPlan.maximums).some((resource) => resource.startsWith('feature_warlock-')))
  assert.equal(warlockPlan.recovery.pact_slots, 'short_or_long')
  assert.equal(resourcesAfterRest(warlock, { pact_slots: { current: 0 } }, 'short').pact_slots.current, 2)
})

function importDocument(character) {
  const baseScores = { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 }
  return {
    schema: CHARACTER_IMPORT_SCHEMA,
    schema_version: CHARACTER_IMPORT_SCHEMA_VERSION,
    character: {
      character: 'Мира', characterClass: 'wizard', level: 1, experience: 0,
      species: 'Человек',
      abilities: baseScores,
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.standard-array',
        policyVersion: 1,
        method: 'standard_array',
        baseScores,
        originBonusProfileId: 'none',
        originBonuses: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
        speciesOptionId: 'human',
      },
      baseSpeed: 30, classSkillProficiencies: ['arcana', 'history'], selectedFeatureIds: [],
      knownSpellIds: ['fire-bolt', 'mage-hand', 'light'], preparedSpellIds: [],
      ...character,
    },
  }
}

test('strict v1 importer returns only safe canonical sheet fields', () => {
  const result = parseCharacterImport(importDocument({
    name: 'Игрок', species: 'Человек',
  }))
  assert.equal(result.patch.characterClass, 'wizard')
  assert.equal(result.patch.baseSpeed, 30)
  assert.equal(result.patch.hp, undefined)
  assert.equal(result.patch.maxHp, undefined)
  assert.equal(result.patch.inventory, undefined)
  assert.equal(result.sheet.proficiency_bonus, 2)
  assert.throws(
    () => parseCharacterImport(importDocument({ hp: 999 })),
    (error) => error.code === 'IMPORT_UNKNOWN_FIELD',
  )
  assert.throws(
    () => parseCharacterImport(importDocument({ level: 2, experience: 0 })),
    (error) => error.code === 'IMPORT_LEVEL_EXPERIENCE_MISMATCH',
  )
  assert.throws(
    () => parseCharacterImport(importDocument({ knownSpellIds: ['fireball'] })),
    (error) => error.code === 'IMPORT_CHARACTER_CHOICE_INVALID',
  )
  assert.throws(
    () => parseCharacterImport(importDocument({ hitPointIncreases: 'not-an-array' })),
    (error) => error.code === 'IMPORT_INVALID_FIELD',
  )
  assert.throws(
    () => parseCharacterImport(importDocument({
      abilities: { str: 30, dex: 30, con: 30, int: 30, wis: 30, cha: 30 },
    })),
    (error) => error.code === 'IMPORT_ABILITY_BUDGET_INVALID',
  )
})

test('v0 importer migration accepts only documented aliases and rejects conflicts or unknown fields', () => {
  const migrated = migrateCharacterImport({
    schema: CHARACTER_IMPORT_SCHEMA,
    schema_version: 0,
    character: {
      character: 'Мира', character_class: 'wizard', level: 1, experience: 0,
      abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 10, cha: 10 },
      base_speed: 30, class_skill_proficiencies: ['arcana', 'history'],
      selected_feature_ids: [], known_spell_ids: ['fire-bolt', 'mage-hand', 'light'], prepared_spell_ids: [],
    },
  })
  assert.equal(migrated.schema_version, 1)
  assert.equal(migrated.character.characterClass, 'wizard')
  assert.equal(migrated.character.baseSpeed, 30)
  assert.throws(
    () => migrateCharacterImport({ schema: CHARACTER_IMPORT_SCHEMA, schema_version: 0, character: { ...migrated.character, character_class: 'fighter' } }),
    (error) => error.code === 'IMPORT_MIGRATION_CONFLICT',
  )
  assert.throws(
    () => migrateCharacterImport({ schema: CHARACTER_IMPORT_SCHEMA, schema_version: 0, character: { ...migrated.character, gold: 999 } }),
    (error) => error.code === 'IMPORT_UNKNOWN_FIELD',
  )
})

test('legacy CharacterImported events with pre-policy ability scores remain replayable', () => {
  const state = { players: [fighter({ level: 1, experience: 0, hitPointIncreases: [] })], mechanics: { combat: { active: false } } }
  const legacyEvent = {
    event_type: 'CharacterImported',
    actor_id: 'fighter',
    target_ids: ['fighter'],
    payload: {
      schema: CHARACTER_IMPORT_SCHEMA,
      schema_version: CHARACTER_IMPORT_SCHEMA_VERSION,
      patch: {
        character: 'Старый герой',
        characterClass: 'fighter',
        level: 1,
        experience: 0,
        abilities: { str: 18, dex: 11, con: 15, int: 9, wis: 13, cha: 7 },
        baseSpeed: 30,
        classSkillProficiencies: ['athletics', 'perception'],
        selectedFeatureIds: ['fighting-style-defense'],
        knownSpellIds: [],
        preparedSpellIds: [],
      },
    },
  }
  const replayed = applyCharacterLifecycleEvent(state, legacyEvent)
  assert.equal(replayed.players[0].character, 'Старый герой')
  assert.equal(replayed.players[0].abilities.str, 18)
})

test('resolveLevelUp combines validation, event construction, pure reduction and new derived stats', () => {
  const state = { players: [fighter()], mechanics: { combat: { active: false } } }
  const result = resolveLevelUp({ command_type: 'LevelUp', actor_id: 'fighter' }, state, { allowedActorIds: ['fighter'] })
  assert.equal(result.event.event_type, 'CharacterLeveledUp')
  assert.equal(result.state.players[0].level, 5)
  assert.equal(result.sheet.proficiency_bonus, 3)
})

test('вид персонажа выводится сервером из speciesOptionId, метка клиенту не обязательна', () => {
  // Источник истины — идентификатор вида. Раньше клиент был обязан прислать ещё и точную
  // метку («Человек»), и любая правка policy ломала бы контракт.
  const withoutLabel = importDocument({})
  delete withoutLabel.character.species
  assert.equal(parseCharacterImport(withoutLabel).patch.species, 'Человек')

  // Метка, записанная в уже существующие события, по-прежнему принимается.
  assert.equal(parseCharacterImport(importDocument({ species: 'Человек' })).patch.species, 'Человек')

  // Но подменить вид меткой нельзя.
  assert.throws(
    () => parseCharacterImport(importDocument({ species: 'Эльф' })),
    (error) => error.code === 'IMPORT_SPECIES_UNSUPPORTED',
  )
})

test('авторский вид требует явного названия', () => {
  const custom = (species) => {
    const document = importDocument(species === undefined ? {} : { species })
    document.character.abilityGeneration.speciesOptionId = 'custom'
    if (species === undefined) delete document.character.species
    return document
  }

  assert.throws(() => parseCharacterImport(custom()), (error) => error.code === 'IMPORT_SPECIES_UNSUPPORTED')
  assert.equal(parseCharacterImport(custom('Полудракон')).patch.species, 'Полудракон')
})

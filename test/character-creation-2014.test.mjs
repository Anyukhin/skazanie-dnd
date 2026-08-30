import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyCharacterLifecycleEvent,
  characterCreationCatalog,
  characterImportEvent,
  parseCharacterImport,
  validateCharacterImportCommand,
} from '../server/character-lifecycle.mjs'
import { backgroundBenefits } from '../server/backgrounds.mjs'
import { withStarterKit } from '../server/starter-kit.mjs'

const RULESET_ID = 'dnd_5e_2014'

function classicFighter(overrides = {}) {
  const baseScores = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }
  const originBonuses = { str: 0, dex: 0, con: 2, int: 0, wis: 1, cha: 0 }
  return {
    schema: 'skazanie.character',
    schema_version: 1,
    character: {
      character: 'Торин',
      name: 'Игрок',
      role: 'Воин · ур. 1',
      characterClass: 'fighter',
      species: 'Холмовой дварф',
      background: 'Солдат',
      backgroundId: 'soldier',
      backgroundChoices: { tools: ['dice_set'], languages: [] },
      level: 1,
      experience: 0,
      abilities: { str: 15, dex: 14, con: 15, int: 12, wis: 11, cha: 8 },
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.dnd-5e-2014',
        policyVersion: 1,
        method: 'standard_array',
        baseScores,
        originBonusProfileId: 'dwarf-hill',
        originBonuses,
        speciesOptionId: 'dwarf-hill',
      },
      baseSpeed: 25,
      hitPointIncreases: [],
      classSkillProficiencies: ['athletics', 'perception'],
      selectedFeatureIds: ['fighting-style-defense'],
      knownSpellIds: [],
      preparedSpellIds: [],
      ...overrides,
    },
  }
}

test('каталог создания 2014 отделён по ruleset_id и содержит PHB расы, подрасы и предыстории', () => {
  const catalog = characterCreationCatalog(RULESET_ID)
  assert.equal(catalog.ruleset_id, RULESET_ID)
  assert.equal(catalog.edition_family, '5e_2014')
  assert.equal(catalog.ability_policy.bonus_source, 'species')
  assert.equal(catalog.ability_policy.species_options.length, 14)
  assert.equal(new Set(catalog.ability_policy.species_options.map((entry) => entry.race_id)).size, 9)
  assert.equal(catalog.backgrounds.options.length, 13)
  assert.deepEqual(catalog.backgrounds.ability_modes, [])
  assert.ok(catalog.ability_policy.species_options.some((entry) => entry.id === 'elf-drow' && entry.subrace_id === 'drow'))
  assert.ok(catalog.backgrounds.options.some((entry) => entry.id === 'guild-artisan' && entry.toolChoice.options.length > 0))

  const current = characterCreationCatalog('srd_5_2_1')
  assert.equal(current.ability_policy.bonus_source, 'background')
  assert.notEqual(current.ability_policy.policy_id, catalog.ability_policy.policy_id)
  assert.notEqual(current.backgrounds.policy_id, catalog.backgrounds.policy_id)
})

test('сервер принимает расовые бонусы 2014 и отвергает бонусы от предыстории или чужой подрасы', () => {
  const parsed = parseCharacterImport(classicFighter(), { rulesetId: RULESET_ID })
  assert.equal(parsed.patch.abilities.con, 15)
  assert.equal(parsed.patch.abilities.wis, 11)
  assert.equal(parsed.patch.backgroundAbilityChoice, undefined)
  const benefits = backgroundBenefits('soldier', null, parsed.patch.backgroundChoices, RULESET_ID)
  assert.deepEqual(benefits.ability_bonuses, {})
  assert.deepEqual(benefits.skill_proficiencies, ['athletics', 'intimidation'])

  assert.throws(
    () => parseCharacterImport(classicFighter({
      backgroundAbilityChoice: { mode: 'two_one', abilities: ['str', 'con'] },
    }), { rulesetId: RULESET_ID }),
    (error) => error.code === 'IMPORT_BACKGROUND_ABILITY_INVALID',
  )
  assert.throws(
    () => parseCharacterImport(classicFighter({
      abilityGeneration: {
        ...classicFighter().character.abilityGeneration,
        originBonusProfileId: 'dwarf-mountain',
      },
    }), { rulesetId: RULESET_ID }),
    (error) => error.code === 'IMPORT_ABILITY_BUDGET_INVALID' || error.code === 'IMPORT_SPECIES_ABILITY_INVALID',
  )
})

test('полуэльф получает +2 Харизма и выбирает две другие характеристики', () => {
  const baseScores = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }
  const document = classicFighter({
    species: 'Полуэльф',
    baseSpeed: 30,
    abilities: { str: 16, dex: 15, con: 13, int: 12, wis: 10, cha: 10 },
    abilityGeneration: {
      policyId: 'skazanie.character-abilities.dnd-5e-2014',
      policyVersion: 1,
      method: 'standard_array',
      baseScores,
      originBonusProfileId: 'half-elf',
      originBonuses: { str: 1, dex: 1, con: 0, int: 0, wis: 0, cha: 2 },
      speciesOptionId: 'half-elf',
    },
  })
  assert.equal(parseCharacterImport(document, { rulesetId: RULESET_ID }).patch.abilities.cha, 10)

  document.character.abilityGeneration.originBonuses.cha = 3
  document.character.abilities.cha = 11
  assert.throws(
    () => parseCharacterImport(document, { rulesetId: RULESET_ID }),
    (error) => error.code === 'IMPORT_ABILITY_BUDGET_INVALID' || error.code === 'IMPORT_SPECIES_ABILITY_INVALID',
  )
})

test('импорт героя 2014 выдаёт классовое и фоновое снаряжение и стабилен при replay', () => {
  const state = {
    ruleset_id: RULESET_ID,
    players: [{
      id: 'hero-slot-1', character: 'Место героя', characterSetupRequired: true,
      inventory: [], currency: { copper: 0, silver: 0, gold: 0, platinum: 0 },
    }],
    mechanics: { combat: { active: false } },
  }
  const command = validateCharacterImportCommand({
    command_type: 'ImportCharacter', actor_id: 'hero-slot-1', document: classicFighter(),
  }, state, { allowedActorIds: ['hero-slot-1'] })
  assert.equal(command.ruleset_id, RULESET_ID)
  assert.deepEqual(command.source_rule_ids, [`${RULESET_ID}:resources:spending`])
  const event = characterImportEvent(command)
  const after = applyCharacterLifecycleEvent(state, event)
  const hero = after.players[0]
  assert.equal(hero.speciesBenefits.species_option_id, 'dwarf-hill')
  assert.equal(hero.backgroundBenefits.background_id, 'soldier')
  assert.equal(hero.currency.gold, 10)
  assert.equal(hero.starterEquipmentPolicyId, 'skazanie.starter-equipment.dnd-5e-2014')
  assert.ok(hero.inventory.some((item) => item.catalog_id === 'srd_5_2_1:chain-mail'))
  assert.ok(hero.inventory.some((item) => item.name === 'Солдат: личные вещи'))
  assert.deepEqual(applyCharacterLifecycleEvent(state, event), after)
})

test('каждый класс 2014 получает непустой детерминированный стартовый набор', () => {
  const classes = characterCreationCatalog(RULESET_ID).classes
  assert.equal(classes.length, 12)
  for (const entry of classes) {
    const hero = withStarterKit({
      id: `starter-${entry.id}`,
      characterClass: entry.id,
      backgroundId: 'soldier',
      backgroundChoices: { tools: ['dice_set'], languages: [] },
      inventory: [],
      currency: { copper: 0, silver: 0, gold: 0, platinum: 0 },
    }, { rulesetId: RULESET_ID })
    assert.ok(hero.inventory.length >= 2, entry.id)
    assert.equal(hero.currency.gold, 10, entry.id)
    assert.equal(hero.starterEquipmentPolicyId, 'skazanie.starter-equipment.dnd-5e-2014')
  }
})

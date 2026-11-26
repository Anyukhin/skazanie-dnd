import { pilotCreationChoicesFor } from '../../src/pilot-build-choices.mjs'

// Лист первого уровня для того же импорта, который отправляет мастер героя.
export function pilotImportDocument(catalog, recipe, name) {
  const species = catalog.ability_policy.species_options.find((entry) => entry.id === recipe.species)
  const profile = catalog.ability_policy.origin_bonus_profiles.find((entry) => entry.id === species.bonus_profile_id)
  const entry = catalog.classes.find((entry) => entry.id === recipe.class)
  const background = catalog.backgrounds.options.find((entry) => entry.id === recipe.background)
  const equipment = catalog.starter_equipment.backgrounds.find((entry) => entry.background_id === recipe.background)
  const choices = pilotCreationChoicesFor(catalog, recipe)
  const order = {
    fighter: ['str', 'con', 'dex', 'wis', 'int', 'cha'],
    barbarian: ['str', 'con', 'dex', 'wis', 'cha', 'int'],
    monk: ['dex', 'wis', 'con', 'str', 'int', 'cha'],
    paladin: ['str', 'cha', 'con', 'wis', 'dex', 'int'],
  }[recipe.class]
  const baseScores = Object.fromEntries(order.map((ability, index) => [ability, catalog.ability_policy.standard_array[index]]))
  const abilities = Object.fromEntries(order.map((ability) => [ability, baseScores[ability] + (profile.fixed_bonuses[ability] ?? 0)]))
  return {
    schema: catalog.import_schema,
    schema_version: catalog.import_schema_version,
    character: {
      character: name, name, role: `${entry.label} · ур. 1`, characterClass: recipe.class,
      species: species.label, background: background.name, backgroundId: background.id,
      level: 1, experience: 0, abilities, baseSpeed: species.base_speed, hitPointIncreases: [],
      abilityGeneration: {
        policyId: catalog.ability_policy.policy_id, policyVersion: catalog.ability_policy.policy_version,
        method: 'standard_array', baseScores, originBonusProfileId: profile.id,
        originBonuses: profile.fixed_bonuses, speciesOptionId: species.id,
      },
      classSkillProficiencies: recipe.class_skills,
      selectedFeatureIds: recipe.class === 'fighter' ? recipe.features : [],
      knownSpellIds: [], preparedSpellIds: [], speciesChoices: choices.speciesChoices,
      backgroundChoices: {
        tools: choices.backgroundTools, languages: choices.backgroundLanguages,
        replacementSkills: choices.backgroundReplacementSkills, replacementTools: choices.backgroundReplacementTools,
      },
      phbCreation: {
        schema_version: 1, classChoices: choices.classChoices,
        backgroundEquipmentChoices: Object.fromEntries((equipment?.choice_groups ?? []).map((group) => [group.id, group.options.slice(0, group.count).map((option) => option.id)])),
      },
      starterEquipmentChoices: Object.fromEntries(entry.starter_equipment.choice_groups.map((group) => [group.id, [recipe.starter_equipment[group.id]]])),
    },
  }
}

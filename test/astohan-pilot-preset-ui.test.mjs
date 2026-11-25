import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { pilotCreationChoicesFor } from '../src/pilot-build-choices.mjs'
import { pilotImportAlreadyStarted } from '../src/pilot-import-state.mjs'
import { astohanPilotBuildCatalog } from '../server/astohan-pilot-builds.mjs'
import { applyCharacterLifecycleEvent, characterCreationCatalog, characterImportEvent, createCharacterSlot, validateCharacterImportCommand } from '../server/character-lifecycle.mjs'
const wizard = readFileSync(new URL('../src/CharacterCreationWizard.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const session = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
test('готовый пилотный лист доступен только для свежего Асстохана уровня 7', () => {
  assert.match(app, /world_template_id.*astohan-plains/u)
  assert.match(app, /character_start_level === 7/u)
  assert.match(app, /characterSetupRequired === true/u)
  assert.match(wizard, /Готовый лист для первой партии/u)
  assert.match(wizard, /onApplyPilotBuild/u)
  assert.match(wizard, /pilotCreationChoicesFor/u)
})
test('выбор пилотного листа проходит через staged character build commands', () => {
  assert.match(session, /stagedCommandsForPilotBuild/u)
  assert.match(session, /executeCharacterBuild\(commands\)/u)
  assert.match(wizard, /deferDevelopment/u)
  assert.doesNotMatch(wizard, /ImportCharacter|admin/u, 'пилотная кнопка не добавляет обходной импорт')
})
test('fresh fighter slot is not mistaken for an imported pilot on retry', () => {
  const build = { class: 'fighter' }
  assert.equal(pilotImportAlreadyStarted({ character: 'Место героя 1', characterClass: 'fighter', characterSetupRequired: true, species: 'Не выбран', background: 'Не выбрано' }, build), false)
  assert.equal(pilotImportAlreadyStarted({ character: 'Борен', characterClass: 'fighter', characterSetupRequired: true, species: 'Человек', background: 'Солдат' }, build), true)
  assert.equal(pilotImportAlreadyStarted({ character: 'Борен', characterClass: 'barbarian', characterSetupRequired: true, species: 'Человек', background: 'Солдат' }, build), false)
})
test('catalog-driven choices make all four pilot imports valid', () => {
  const catalog = characterCreationCatalog('dnd_5e_2014')
  const species = catalog.ability_policy.species_options.find((entry) => entry.id === 'human')
  const profile = catalog.ability_policy.origin_bonus_profiles.find((entry) => entry.id === species.bonus_profile_id)
  const abilities = { str: 16, dex: 15, con: 14, int: 13, wis: 11, cha: 9 }
  const baseScores = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }
  for (const recipe of astohanPilotBuildCatalog().builds) {
    const choices = pilotCreationChoicesFor(catalog, recipe)
    const classEntry = catalog.classes.find((entry) => entry.id === recipe.class)
    const background = catalog.backgrounds.options.find((entry) => entry.id === recipe.background)
    const backgroundEquipment = catalog.starter_equipment.backgrounds.find((entry) => entry.background_id === recipe.background)
    const document = {
      schema: catalog.import_schema,
      schema_version: catalog.import_schema_version,
      character: {
        character: `Проверка ${recipe.id}`,
        name: 'Проверка',
        role: `${classEntry.label} · ур. 1`,
        characterClass: recipe.class,
        species: species.label,
        background: background.name,
        level: 1,
        experience: 0,
        abilities,
        abilityGeneration: {
          policyId: catalog.ability_policy.policy_id,
          policyVersion: catalog.ability_policy.policy_version,
          method: 'standard_array',
          baseScores,
          originBonusProfileId: profile.id,
          originBonuses: profile.fixed_bonuses,
          speciesOptionId: species.id,
        },
        baseSpeed: species.base_speed,
        hitPointIncreases: [],
        classSkillProficiencies: recipe.class_skills,
        selectedFeatureIds: recipe.class === 'fighter' ? recipe.features : [],
        knownSpellIds: [],
        preparedSpellIds: [],
        backgroundId: recipe.background,
        speciesChoices: choices.speciesChoices,
        backgroundChoices: {
          tools: choices.backgroundTools,
          languages: choices.backgroundLanguages,
          replacementSkills: choices.backgroundReplacementSkills,
          replacementTools: choices.backgroundReplacementTools,
        },
        phbCreation: {
          schema_version: 1,
          classChoices: choices.classChoices,
          backgroundEquipmentChoices: Object.fromEntries((backgroundEquipment?.choice_groups ?? []).map((group) => [group.id, group.options.slice(0, group.count).map((option) => option.id)])),
        },
        starterEquipmentChoices: Object.fromEntries((classEntry.starter_equipment?.choice_groups ?? []).map((group) => [group.id, [recipe.starter_equipment[group.id]].filter(Boolean)])),
      },
    }
    const actorId = `${recipe.id}-import-check`
    const state = { ruleset_id: 'dnd_5e_2014', character_start_level: 7, players: [createCharacterSlot({ id: actorId })], mechanics: { combat: { active: false } } }
    const command = validateCharacterImportCommand({ command_type: 'ImportCharacter', actor_id: actorId, document }, state, { allowedActorIds: [actorId] })
    const afterImport = applyCharacterLifecycleEvent(state, characterImportEvent(command))
    assert.equal(afterImport.players[0].characterSetupRequired, true, recipe.id)
    assert.equal(afterImport.players[0].characterSetupStage, 'leveling', recipe.id)
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { combatSpellFor } from '../server/combat-spells.mjs'
import { characterCreationCatalog } from '../server/character-lifecycle.mjs'
import { defaultSpeciesChoices, speciesBenefitsFor } from '../server/character-creation-catalog.mjs'
import { resolvePhbCreation } from '../server/character-creation-phb.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { normalizeCampaignState, spellComponentAvailabilityFor } from '../server/rules-engine.mjs'

function magicInitiateDocument() {
  const rulesetId = 'dnd_5e_2014'
  const catalog = characterCreationCatalog(rulesetId)
  const fighter = catalog.classes.find((entry) => entry.id === 'fighter')
  const speciesId = 'human-variant'
  const speciesChoices = defaultSpeciesChoices(speciesId, rulesetId)
  const species = speciesBenefitsFor(speciesId, rulesetId, speciesChoices)
  const classSkillProficiencies = fighter.class_skills.options.slice(0, fighter.class_skills.choice_count).map((entry) => entry.id)
  return {
    characterClass: 'fighter',
    level: 1,
    abilities: { str: 16, dex: 15, con: 14, int: 13, wis: 12, cha: 10 },
    abilityGeneration: {
      policyId: catalog.ability_policy.policy_id,
      policyVersion: catalog.ability_policy.policy_version,
      method: 'standard_array',
      baseScores: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
      originBonuses: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 },
      originBonusProfileId: speciesId,
      speciesOptionId: speciesId,
    },
    speciesChoices,
    classSkillProficiencies,
    selectedFeatureIds: ['fighting-style-defense'],
    backgroundId: 'sage',
    backgroundChoices: {
      tools: [], languages: ['giant', 'gnomish'],
      replacementSkills: ['investigation'], replacementTools: [],
    },
    phbCreation: {
      schema_version: 1,
      classChoices: { skills: classSkillProficiencies },
      feat: {
        id: 'magic-initiate',
        choices: { class: 'wizard', cantrips: ['minor-illusion', 'message'], spell: 'shield' },
      },
    },
    species,
  }
}

function stateForGrants(grants, characterClass, inventory) {
  return normalizeCampaignState({
    sessionCode: 'MAGIC-INITIATE-COMPONENTS',
    ruleset_id: 'dnd_5e_2014',
    partyMemberIds: ['fighter'],
    players: [{
      id: 'fighter', characterClass, level: 4,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      creationSpellGrants: grants,
      inventory,
      currency: {}, hp: 10, maxHp: 10,
    }],
    mechanics: { combat: { active: false } },
  })
}

test('Magic Initiate сохраняет список класса, но фокус требует реальную class capability', () => {
  const grants = resolvePhbCreation(magicInitiateDocument()).benefits.spell_grants
  assert.equal(grants.find((entry) => entry.id === 'minor-illusion')?.class_key, 'wizard')

  const pouchState = stateForGrants(grants, 'fighter', [
    materializeCatalogItem('srd_5_2_1:component-pouch', { id: 'pouch' }),
  ])
  const pouchSpell = combatSpellFor(pouchState.players[0], 'minor-illusion', { rulesetId: pouchState.ruleset_id })
  assert.equal(pouchSpell.innateSpellcastingClass, 'wizard')
  assert.equal(pouchSpell.spellcastingClass, undefined)
  assert.equal(spellComponentAvailabilityFor(pouchState, pouchState.players[0], pouchSpell).available, true)

  const fighterState = stateForGrants(grants, 'fighter', [
    materializeCatalogItem('srd_5_2_1:arcane-focus-wand', { id: 'focus', equipped: true }),
  ])
  const fighterSpell = combatSpellFor(fighterState.players[0], 'minor-illusion', { rulesetId: fighterState.ruleset_id })
  assert.equal(fighterSpell.spellcastingClass, undefined)
  assert.equal(spellComponentAvailabilityFor(fighterState, fighterState.players[0], fighterSpell).code, 'SPELL_MATERIAL_COMPONENT_REQUIRED')

  const wizardState = stateForGrants(grants, 'wizard', [
    materializeCatalogItem('srd_5_2_1:arcane-focus-wand', { id: 'focus', equipped: true }),
  ])
  const wizardSpell = combatSpellFor(wizardState.players[0], 'minor-illusion', { rulesetId: wizardState.ruleset_id })
  assert.equal(wizardSpell.spellcastingClass, 'wizard')
  assert.equal(spellComponentAvailabilityFor(wizardState, wizardState.players[0], wizardSpell).available, true)
})

test('пользовательская подпись роли не даёт воину магический класс или право на фокус', () => {
  const grants = resolvePhbCreation(magicInitiateDocument()).benefits.spell_grants
  const state = stateForGrants(grants, 'fighter', [
    materializeCatalogItem('srd_5_2_1:arcane-focus-wand', { id: 'focus', equipped: true }),
  ])
  const actor = state.players[0]
  actor.role = 'Волшебник · ур. 20'
  const spell = combatSpellFor(actor, 'minor-illusion', { rulesetId: state.ruleset_id })
  assert.equal(spell.spellcastingClass, undefined)
  assert.equal(spellComponentAvailabilityFor(state, actor, spell).available, false)
  assert.equal(combatSpellFor(actor, 'fire-bolt', { rulesetId: state.ruleset_id }), null)
})

test('неизвестный исторический класс сохраняет распознавание заклинателя по роли', () => {
  const actor = { characterClass: 'legacy-role', role: 'Волшебник · ур. 5', level: 5 }
  assert.ok(combatSpellFor(actor, 'fire-bolt', { rulesetId: 'dnd_5e_2014' }))
})

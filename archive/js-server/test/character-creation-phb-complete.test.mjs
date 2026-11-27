import assert from 'node:assert/strict'
import test from 'node:test'
import { characterCreationCatalog, parseCharacterImport, createCharacterSlot, deriveCharacterSheet, normalizeCharacterSheet } from '../server/character-lifecycle.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { defaultSpeciesChoices, speciesBenefitsFor } from '../server/character-creation-catalog.mjs'
import { defaultStarterEquipmentChoices } from '../server/starter-kit.mjs'
import { resolveCommands, normalizeCampaignState, replayEvents } from '../server/rules-engine.mjs'

const catalog = characterCreationCatalog('dnd_5e_2014')
function makeCharacter(classId, { speciesId = 'human', feat, extraChoices = {}, subclass } = {}) {
  const klass = catalog.classes.find((entry) => entry.id === classId)
  const baseScores = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }
  const originBonuses = speciesId === 'human-variant' ? { str: 1, dex: 1, con: 0, int: 0, wis: 0, cha: 0 } : { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 }
  const speciesChoices = defaultSpeciesChoices(speciesId, 'dnd_5e_2014')
  const species = speciesBenefitsFor(speciesId, 'dnd_5e_2014', speciesChoices)
  const skills = klass.class_skills.options.slice(0, klass.class_skills.choice_count).map((entry) => entry.id)
  const granted = [...skills, ...species.skill_proficiencies, 'arcana', 'history']
  const known = new Set(granted)
  const replacementSkills = catalog.phb.skills.filter((skill) => !known.has(skill.id)).slice(0, granted.length - known.size).map((skill) => skill.id)
  const choices = classId === 'bard' ? { instruments: ['lute', 'drum', 'flute'] } : classId === 'monk' ? { tool_or_instrument: { kind: 'artisan_tool', id: 'smiths_tools' } }
    : classId === 'rogue' ? { expertise: skills.slice(0, 2) } : classId === 'ranger' ? { favored_enemy: { type: 'undead', language: null }, natural_explorer: 'forest' }
      : classId === 'sorcerer' ? { draconic_ancestry: 'red' } : {}
  const selectedSubclass = subclass ?? (classId === 'cleric' ? 'Домен жизни' : classId === 'sorcerer' ? 'Наследие драконьей крови' : classId === 'warlock' ? 'Исчадие' : undefined)
  const spells = klass.spell_selection
  const firstCount = spells?.mode === 'known' ? spells.spellsKnown : spells?.mode === 'spellbook' ? 6 : 0
  const knownSpellIds = [...(spells?.spells.filter((entry) => entry.level === 0).slice(0, spells.cantrips).map((entry) => entry.id) ?? []), ...(spells?.spells.filter((entry) => entry.level === 1).slice(0, firstCount).map((entry) => entry.id) ?? [])]
  return { schema: 'skazanie.character', schema_version: 1, character: {
    character: 'Проверка PHB', characterClass: classId, level: 1, experience: 0,
    abilities: Object.fromEntries(Object.entries(baseScores).map(([id, score]) => [id, score + originBonuses[id]])),
    abilityGeneration: { policyId: catalog.ability_policy.policy_id, policyVersion: catalog.ability_policy.policy_version, method: 'standard_array', baseScores, originBonuses, originBonusProfileId: speciesId, speciesOptionId: speciesId },
    baseSpeed: 30, speciesChoices, classSkillProficiencies: skills, selectedFeatureIds: classId === 'fighter' ? ['fighting-style-defense'] : [],
    knownSpellIds, preparedSpellIds: [], ...(selectedSubclass ? { subclass: selectedSubclass } : {}),
    backgroundId: 'sage', backgroundChoices: { tools: [], languages: ['giant', 'gnomish'], replacementSkills, replacementTools: [] },
    starterEquipmentChoices: defaultStarterEquipmentChoices(classId, 'dnd_5e_2014', { complete: true }),
    phbCreation: { schema_version: 1, classChoices: { ...choices, ...extraChoices }, ...(feat ? { feat } : {}) },
  } }
}

test('полное создание всех двенадцати PHB-классов проходит через Rules Engine и replay', () => {
  for (const klass of catalog.classes) {
    const document = makeCharacter(klass.id)
    const initial = normalizeCampaignState({ sessionCode: 'PHB-FULL', ruleset_id: 'dnd_5e_2014', partyMemberIds: ['hero'], players: [createCharacterSlot({ id: 'hero' })] })
    const result = resolveCommands([{ command_type: 'ImportCharacter', actor_id: 'hero', document }], initial, { diceService: new DiceService({ rng: new SequenceDiceRng([]) }), context: { allowedActorIds: ['hero'] } })
    const hero = result.state.players[0]
    assert.equal(hero.creationBenefits.class.class_key, klass.id)
    assert.ok(hero.inventory.length > 1, klass.id)
    assert.deepEqual(replayEvents(initial, result.events), result.state, klass.id)
    if (klass.id === 'cleric') {
      assert.ok(hero.combatSpells.some((spell) => spell.id === 'bless' && spell.prepared))
      assert.ok(hero.combatSpells.some((spell) => spell.id === 'cure-wounds' && spell.prepared))
    }
    if (klass.id === 'sorcerer') assert.equal(hero.characterSheet.armor_class.value, 15)
    if (klass.id === 'rogue') assert.ok(Object.values(hero.characterSheet.skills).some((skill) => skill.expertise))
  }
})

test('вариантный человек получает выбранную черту, её ОЗ и ограничения', () => {
  const tough = parseCharacterImport(makeCharacter('fighter', { speciesId: 'human-variant', feat: { id: 'tough', choices: {} } }), { rulesetId: 'dnd_5e_2014' })
  assert.equal(tough.sheet.hit_points.value, 13)
  assert.equal(tough.creation.benefits.feat.id, 'tough')
  assert.throws(() => parseCharacterImport(makeCharacter('fighter', { speciesId: 'human-variant' }), { rulesetId: 'dnd_5e_2014' }), /должен выбрать/)
  assert.throws(() => parseCharacterImport(makeCharacter('fighter', { speciesId: 'human-variant', feat: { id: 'war-caster', choices: {} } }), { rulesetId: 'dnd_5e_2014' }), /требования/)
})

test('PHB-модель отвергает неполный выбор магии и классовых инструментов', () => {
  const bard = makeCharacter('bard'); bard.character.phbCreation.classChoices.instruments = ['lute']
  assert.throws(() => parseCharacterImport(bard, { rulesetId: 'dnd_5e_2014' }), /инструмент/)
  const wizard = makeCharacter('wizard'); wizard.character.knownSpellIds = []
  assert.throws(() => parseCharacterImport(wizard, { rulesetId: 'dnd_5e_2014' }), /заговоров/)
  const fighter = makeCharacter('fighter'); fighter.character.selectedFeatureIds = ['fighter-perehvat']
  assert.throws(() => parseCharacterImport(fighter, { rulesetId: 'dnd_5e_2014' }), /шести/)
})

test('лист учитывает тяжёлый доспех при низкой Силе и не удваивает Подвижного при нормализации', () => {
  const actor = { characterClass: 'fighter', level: 1, experience: 0, baseSpeed: 30,
    abilities: { str: 8, dex: 8, con: 14, int: 10, wis: 12, cha: 10 },
    creationBenefits: { speed_bonus: 10 }, inventory: [{ id: 'chain', catalog_id: 'srd_5_2_1:chain-mail', equipped: true }],
  }
  const sheet = deriveCharacterSheet(actor)
  assert.equal(sheet.armor_class.value, 16, 'Отрицательная Ловкость не уменьшает КД тяжёлого доспеха')
  assert.equal(sheet.speed.value, 30, '30 базовой + 10 Подвижный − 10 за недостаточную Силу')
  const normalized = normalizeCharacterSheet(actor).actor
  assert.equal(normalized.baseSpeed, 30)
  assert.equal(deriveCharacterSheet(normalized).speed.value, 30)
  assert.equal(deriveCharacterSheet({ ...actor, speciesBenefits: { mechanics: { ignore_armor_speed_penalty: true } } }).speed.value, 40)
})

test('Посвящённый в магию сохраняет заговоры и отдельное применение заклинания у немагического класса', () => {
  const document = makeCharacter('fighter', { speciesId: 'human-variant', feat: { id: 'magic-initiate', choices: { class: 'wizard', cantrips: ['mage-hand', 'light'], spell: 'shield' } } })
  const initial = normalizeCampaignState({ sessionCode: 'PHB-FEAT', ruleset_id: 'dnd_5e_2014', partyMemberIds: ['hero'], players: [createCharacterSlot({ id: 'hero' })] })
  const result = resolveCommands([{ command_type: 'ImportCharacter', actor_id: 'hero', document }], initial, { diceService: new DiceService({ rng: new SequenceDiceRng([]) }), context: { allowedActorIds: ['hero'] } })
  assert.ok(result.state.players[0].combatSpells.some((spell) => spell.id === 'mage-hand' && spell.prepared))
  assert.equal(result.state.mechanics.resources.hero.species_spell_shield.max, 1)
  assert.deepEqual(replayEvents(initial, result.events), result.state)
})

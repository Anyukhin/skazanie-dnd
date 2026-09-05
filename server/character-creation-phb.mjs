import { classOptionsCatalog, classOptionFor, validateClassChoices, PHB_2014_TOOL_IDS } from './character-creation-class-options.mjs'
import { PHB_2014_FEATS, PHB_CANTRIPS, PHB_FIRST_LEVEL_SPELLS, resolveCharacterCreationFeat } from './character-creation-feats.mjs'
import { speciesBenefitsFor, defaultSpeciesChoices } from './character-creation-catalog.mjs'
import { backgroundById, backgroundBenefits, phbToolOptions, backgroundCatalogFor } from './backgrounds.mjs'
import { canonicalCombatSpellFor } from './combat-spells.mjs'

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha']
const CASTERS = ['bard', 'cleric', 'druid', 'sorcerer', 'warlock', 'wizard']
export const PHB_FIGHTING_STYLES = Object.freeze({
  'fighting-style-defense': 'defense', 'fighting-style-dueling': 'dueling',
  'fighting-style-great-weapon': 'great_weapon_fighting', 'fighting-style-protection': 'protection',
  'fighting-style-two-weapon': 'two_weapon_fighting', 'fighting-style-archery': 'archery',
})
export const phbSpellId = (id) => ({ tashas_hideous_laughter: 'tasha-s-hideous-laughter', tensers_floating_disk: 'tenser-s-floating-disk' }[id] ?? String(id).replaceAll('_', '-'))
export const phbToolId = (id) => ({ dragonchess_set: 'dragonchess', three_dragon_ante_set: 'three_dragon_ante', playing_card_set: 'playing_cards', land_vehicles: 'vehicles_land', water_vehicles: 'vehicles_water' }[id] ?? String(id).replaceAll('-', '_'))
const languageId = (id) => String(id).replaceAll('_', '-')
const unique = (values) => [...new Set(values)]
const fail = (reason) => { throw new TypeError(reason) }

export function phbFirstLevelSpells() {
  const ids = unique([...Object.values(PHB_CANTRIPS).flat(), ...Object.values(PHB_FIRST_LEVEL_SPELLS).flat()])
  return ids.map((id) => {
    const spell = canonicalCombatSpellFor(id)
    if (!spell) throw new TypeError(`В локальном каталоге отсутствует заклинание PHB: ${id}`)
    return { ...spell, classes: Object.keys(PHB_CANTRIPS).filter((classId) => (spell.level === 0 ? PHB_CANTRIPS[classId] : PHB_FIRST_LEVEL_SPELLS[classId]).includes(id)) }
  })
}

export function phbCreationCatalog() {
  return {
    schema_version: 1, classes: classOptionsCatalog(), feats: structuredClone(PHB_2014_FEATS),
    tools: phbToolOptions().map((entry) => ({ id: entry.id, label: entry.name })),
    languages: backgroundCatalogFor('dnd_5e_2014').language_options.map((entry) => ({ id: entry.id, label: entry.name })),
    spells: phbFirstLevelSpells().map((spell) => ({ id: spell.id, name: spell.name, classes: spell.classes, level: spell.level, ritual: spell.ritual, description: spell.description, casting_time: spell.castingTime, range_text: spell.rangeText, mechanics_support: spell.mechanicsSupport })),
  }
}

/** Единственный переход от выбора PHB к преимуществам при создании листа. */
export function resolvePhbCreation(source) {
  const raw = source.phbCreation
  if (raw == null) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema_version !== 1) fail('Неизвестный формат создания PHB 2014')
  if (Object.keys(raw).some((key) => !['schema_version', 'classChoices', 'feat', 'backgroundEquipmentChoices', 'equipmentMode', 'wealthRollId', 'purchases'].includes(key))) fail('Неизвестное поле создания PHB 2014')
  if (raw.equipmentMode && !['standard', 'wealth'].includes(raw.equipmentMode)) fail('Неизвестный способ стартового снаряжения')
  if (Number(source.level) !== 1) fail('Мастер PHB создаёт героя первого уровня; развитие выполняется после создания')
  const definition = classOptionFor(source.characterClass)
  if (!definition) fail('Неизвестный класс PHB')
  const speciesId = source.abilityGeneration?.speciesOptionId
  const species = speciesBenefitsFor(speciesId, 'dnd_5e_2014', source.speciesChoices ?? defaultSpeciesChoices(speciesId, 'dnd_5e_2014'))
  if (!species) fail('Нужно завершить выбор расы')
  const background = backgroundById(source.backgroundId, 'dnd_5e_2014', source.backgroundChoices?.customization)
  if (!background) fail('Нужно выбрать предысторию')
  const backgroundGrants = backgroundBenefits(source.backgroundId, null, source.backgroundChoices, 'dnd_5e_2014')
  if (!backgroundGrants) fail('Нужно завершить выборы предыстории')
  const subclass = definition.subclass_options.find((entry) => [entry.id, entry.label, ...(entry.aliases ?? [])].includes(source.subclass))
  const preFeatAbilities = Object.fromEntries(ABILITIES.map((ability) => [ability, Number(source.abilityGeneration?.baseScores?.[ability]) + Number(source.abilityGeneration?.originBonuses?.[ability] ?? 0)]))
  const knownSkills = [...(source.classSkillProficiencies ?? []), ...species.skill_proficiencies, ...background.skillProficiencies, ...(source.backgroundChoices?.replacementSkills ?? [])]
  const knownTools = [...definition.tool_proficiencies, ...species.tool_proficiencies, ...backgroundGrants.tool_proficiencies].map(phbToolId)
  const armor = [...definition.armor_proficiencies, ...(species.mechanics?.armor_proficiencies ?? []), ...(subclass?.additional_armor_proficiencies ?? [])]
  const weapons = [...definition.weapon_proficiencies, ...(species.mechanics?.weapon_proficiencies ?? []), ...(subclass?.additional_weapon_proficiencies ?? [])]
  let feat = null
  if (speciesId === 'human-variant') {
    if (!raw.feat?.id) fail('Вариантный человек должен выбрать одну черту PHB 2014')
    feat = resolveCharacterCreationFeat(raw.feat.id, raw.feat.choices ?? {}, {
      abilities: preFeatAbilities, armor, weapons, skills: knownSkills, tools: knownTools,
      languages: [...species.languages, ...backgroundGrants.languages], canCastSpells: CASTERS.includes(source.characterClass),
    })
    if (!feat.ok) fail(feat.reason)
  } else if (raw.feat) fail('Черта при создании доступна только вариантному человеку')
  const choices = { ...(raw.classChoices ?? {}), skills: source.classSkillProficiencies ?? [], ...(source.subclass ? { subclass: source.subclass } : {}) }
  if (source.characterClass === 'fighter') {
    const selected = source.selectedFeatureIds ?? []
    if (selected.length !== 1 || !PHB_FIGHTING_STYLES[selected[0]]) fail('Воин выбирает один из шести боевых стилей PHB 2014')
    choices.fighting_style = PHB_FIGHTING_STYLES[selected[0]]
  }
  const classResult = validateClassChoices(source.characterClass, choices, {
    skill_proficiencies: [...knownSkills, ...(feat?.benefits.skill_proficiencies ?? [])], tool_proficiencies: knownTools,
  })
  if (!classResult.ok) fail(classResult.errors.join('; '))
  const classGrants = classResult.benefits
  const additionalSkills = [...(classResult.choices.knowledge_skills ?? []), ...(classResult.choices.nature_skill ? [classResult.choices.nature_skill] : []), ...(feat?.benefits.skill_proficiencies ?? [])]
  const additionalTools = [...classGrants.tool_proficiencies, ...(feat?.benefits.tool_proficiencies ?? [])].map(phbToolId)
  const allTools = [...species.tool_proficiencies, ...backgroundGrants.tool_proficiencies, ...additionalTools].map(phbToolId)
  const duplicateTools = allTools.length - new Set(allTools).size
  const replacementTools = (source.backgroundChoices?.replacementTools ?? []).map(phbToolId)
  if (replacementTools.length !== duplicateTools || new Set(replacementTools).size !== duplicateTools
    || replacementTools.some((id) => !PHB_2014_TOOL_IDS.includes(id) || allTools.includes(id))) fail(`Выберите ${duplicateTools} новых инструментальных владений взамен повторов`)
  const additionalLanguages = [...(classGrants.languages ?? []), ...(source.characterClass === 'druid' ? ['druidic'] : []), ...(source.characterClass === 'rogue' ? ['thieves-cant'] : []), ...(feat?.benefits.language_proficiencies ?? [])].map(languageId)
  const languageOptions = new Set([...backgroundCatalogFor('dnd_5e_2014').language_options.map((entry) => entry.id), 'common', 'druidic', 'thieves-cant'])
  if (additionalLanguages.some((id) => !languageOptions.has(id))) fail('Выберите язык из каталога PHB 2014')
  const fixedLanguages = new Set([...species.languages, ...backgroundGrants.languages])
  if (classResult.choices.favored_enemy?.language) fixedLanguages.add(languageId(classResult.choices.favored_enemy.language))
  const chosenLanguages = [...(classResult.choices.knowledge_languages ?? []), ...(feat?.benefits.language_proficiencies ?? [])].map(languageId)
  if (chosenLanguages.some((id) => fixedLanguages.has(id)) || new Set(chosenLanguages).size !== chosenLanguages.length) fail('Выбранный дополнительный язык уже известен: выберите другой')
  const domainSpells = (classGrants.domain_spell_ids ?? []).map(phbSpellId)
  const expandedSpells = (classGrants.expanded_spell_list?.[1] ?? []).map(phbSpellId)
  const grants = []
  if (classGrants.extra_druid_cantrip) grants.push({ id: phbSpellId(classGrants.extra_druid_cantrip), ability: 'wis', uses: 'at-will', source: 'nature-domain' })
  if (classGrants.subclass?.id === 'light') grants.push({ id: 'light', ability: 'wis', uses: 'at-will', source: 'light-domain' })
  const magic = feat?.benefits.spellcasting
  if (magic) {
    grants.push(...(magic.cantrips ?? []).map((id) => ({ id: phbSpellId(id), ability: magic.ability, uses: 'at-will', source: magic.source })))
    if (magic.first_level_spell) grants.push({ id: phbSpellId(magic.first_level_spell), ability: magic.ability, uses: 1, source: magic.source })
  }
  return {
    value: { schema_version: 1, classChoices: classResult.choices, ...(feat ? { feat: { id: feat.feat.id, choices: feat.choices } } : {}), ...(raw.backgroundEquipmentChoices ? { backgroundEquipmentChoices: structuredClone(raw.backgroundEquipmentChoices) } : {}) },
    abilityBonuses: feat?.benefits.ability_increases ?? {},
    additionalSkills, additionalTools: [...additionalTools, ...replacementTools], additionalLanguages,
    benefits: {
      schema_version: 1, class: classGrants, feat: feat ? { id: feat.feat.id, name: feat.feat.name, ...feat.benefits } : null,
      armor_proficiencies: unique([...armor, ...(feat?.benefits.armor_proficiencies ?? [])]),
      weapon_proficiencies: unique([...weapons, ...(feat?.benefits.weapon_proficiencies ?? [])]),
      tool_proficiencies: unique([...allTools, ...replacementTools]),
      tool_proficiency_labels: unique([...allTools, ...replacementTools]).map((id) => phbToolOptions().find((entry) => entry.id === id)?.name ?? id),
      languages: unique([...fixedLanguages, ...additionalLanguages]),
      language_labels: unique([...fixedLanguages, ...additionalLanguages]).map((id) => ({ common: 'Общий', druidic: 'Друидический', 'thieves-cant': 'Воровской жаргон' }[id] ?? backgroundCatalogFor('dnd_5e_2014').language_options.find((entry) => entry.id === id)?.name ?? id)),
      expertise: classGrants.expertise ?? [],
      domain_spells: domainSpells, expanded_spells: expandedSpells,
      domain_spell_names: domainSpells.map((id) => canonicalCombatSpellFor(id)?.name ?? id),
      spell_grants: grants, ritual_book: magic?.source === 'ritual-caster' ? magic : null,
      extra_hit_points_per_level: Number(classGrants.max_hit_points_bonus_per_class_level ?? 0) + Number(feat?.benefits.hit_point_maximum_bonus_per_level ?? 0),
      speed_bonus: Number(feat?.benefits.speed_bonus ?? 0),
      initiative_bonus: Number(feat?.benefits.initiative_bonus ?? 0),
      passive_skill_bonuses: feat?.benefits.passive_skill_bonuses ?? {},
      unarmored_armor_class: classGrants.unarmored_armor_class ?? null,
      saving_throw_proficiencies: unique([...classGrants.saving_throw_proficiencies, ...(feat?.benefits.saving_throw_proficiencies ?? [])]),
    },
  }
}
